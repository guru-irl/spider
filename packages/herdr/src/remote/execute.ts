// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { join } from 'node:path';
import { constants } from 'node:os';
import type { HcClient, JobPort, JobHandle, RemoteSource, RuntimeTarget, PreparedProgram, Owner, MachineName, ExecutionEnvironmentPolicy, RemoteExecuteRequest, RemoteResult, RemoteExecutionPort, TerminalFinish, JobFinish } from '../contracts.js';
import type { CollectedLogs } from './transfer.js';
import { atomicRuntimeFile, sha256, RemoteRuntimeError, type RuntimeReceipt } from './runtime.js';
import { startWithAgentConsole } from './console.js';
export interface RemoteLogReader { collect(): Promise<CollectedLogs>; dispose(): void | Promise<void> }
export interface RemoteExecutionPorts {
  hc: HcClient; jobs: JobPort;
  prepare(source: RemoteSource, target: RuntimeTarget): Promise<PreparedProgram>;
  target(on: MachineName, owner: Owner): Promise<RuntimeTarget>;
  environmentPolicy: ExecutionEnvironmentPolicy;
  /** Read through the job monitor's single collector; do not open a second write sink for this job. */
  logSink(job: JobHandle, options: { maxCaptureBytes: number; onData?: (text: string) => void }): Promise<RemoteLogReader>;
  clock(): number;
  hardCapBytes?: number;
}
function waitForChange(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout>;
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    timer = setTimeout(done, ms); signal?.addEventListener('abort', done, { once: true });
    if (signal?.aborted) done();
  });
}
const verifiedRuntimes = new WeakMap<HcClient, Map<string, Promise<void>>>();
function isMissingFile(error: unknown): boolean {
  const e = error as { code?: string; message?: string };
  return e?.code === 'not_found' || e?.code === 'ENOENT' || e?.code === 'file-not-found'
    || e?.code === 'invalid_params' && !!e.message?.startsWith('ENOENT:');
}
function agrees(receipt: RuntimeReceipt, finish: TerminalFinish): boolean {
  if (receipt.outcome === 'exited') return finish.exitCode === receipt.exitCode && finish.signal === null;
  if (receipt.outcome === 'signal') return finish.exitCode === null && finish.signal === constants.signals[receipt.signal as NodeJS.Signals];
  return true; // Preparation failures have wrapper codes, not payload numeric exits.
}
export async function executeRemote(request: RemoteExecuteRequest, ports: RemoteExecutionPorts): Promise<RemoteResult> {
  if (request.signal?.aborted) throw Object.assign(new Error('Remote execution was aborted before launch'), { code: 'aborted-before-launch' });
  const startedAt = ports.clock();
  const target = await ports.target(request.on, request.owner);
  let checks = verifiedRuntimes.get(ports.hc);
  if (!checks) { checks = new Map(); verifiedRuntimes.set(ports.hc, checks); }
  const identity = request.owner.terminal;
  const checkKey = JSON.stringify([identity.coreId, identity.socket, identity.sessionNamespace, request.on, target.runtimePath, target.runtimeSha256]);
  let check = checks.get(checkKey);
  if (!check) {
    check = (async () => {
      let bytes: Buffer;
      try { bytes = await ports.hc.fileRead(request.on, target.runtimePath); }
      catch (error) {
        if (!isMissingFile(error)) throw error;
        throw new RemoteRuntimeError('runtime-not-installed', `Remote runtime on ${request.on} is missing; rerun spider herdr setup`);
      }
      if (sha256(bytes) !== target.runtimeSha256) throw new RemoteRuntimeError('runtime-not-installed', `Remote runtime on ${request.on} is outdated; rerun spider herdr setup`);
    })();
    checks.set(checkKey, check);
  }
  try { await check; }
  catch (error) { if (checks.get(checkKey) === check) checks.delete(checkKey); throw error; }
  const prepared = await ports.prepare(request.source, target);
  const env = { ...ports.environmentPolicy(Object.freeze({ ...prepared.env })) };
  delete env.PATH; delete env.Path; // The runtime inherits its destination PATH, never the local ssh shim.
  const job = await startWithAgentConsole({ ...request, target, program: { ...prepared, env }, jobs: ports.jobs, hc: ports.hc, options: { background: request.background, signal: request.signal, kind: request.kind ?? (request.source.kind === 'file' ? 'exec-file' : 'exec') }, startedAt });
  const remote = { jobId: job.id, machine: request.on, address: job.address };
  const logs = { stdout: join(job.localDirectory, 'stdout.log'), stderr: join(job.localDirectory, 'stderr.log') };
  const backgroundJob = { id: job.id, dir: job.localDirectory, manifest: join(job.localDirectory, 'job.json'), receipt: join(job.localDirectory, 'receipt.json'), logs };
  await atomicRuntimeFile(backgroundJob.manifest, JSON.stringify({ version: 1, id: job.id, machine: request.on, address: job.address, remoteDirectory: job.remoteDirectory, receipt: backgroundJob.receipt, logs }));
  let latest: CollectedLogs = { stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, complete: false, capped: false, receipt: null };
  let timedOut = false; let aborted = false;
  let finish: JobFinish | undefined; let finishedAt: number | undefined;
  let finishLost = false;
  let releaseCollection: (() => void) | undefined;
  void job.finished.then(value => { finish = value; finishedAt = ports.clock(); if (value.reason === 'unknown' || value.evidenceConflict) releaseCollection?.(); }, () => { finishLost = true; });
  const result = (outcome: RemoteResult['outcome'], exitCode: number | null, signal?: string): RemoteResult => ({
    stdout: latest.stdout, stderr: latest.stderr, exitCode, outcome, timedOut, remote,
    ...(signal ? { signal } : {}), ...(aborted ? { aborted: true } : {}),
    backgroundLogs: logs,
    ...(request.background || outcome === 'unknown' || outcome === 'timeout' ? { backgroundJob } : {}),
  });
  const uncertainResult = (): RemoteResult => {
    const value = result('unknown', null);
    if (finish?.evidenceConflict) {
      value.evidenceConflict = true; value.exitEvidence = finish.exitEvidence;
      const evidence = finish.exitEvidence;
      value.stderr += `${value.stderr ? '\n' : ''}Exit uncertain: native exit ${evidence?.native.exitCode ?? 'unknown'}, signal ${evidence?.native.signal ?? 'none'}; receipt exit ${evidence?.receipt.exitCode ?? 'unknown'}, signal ${evidence?.receipt.signal ?? 'none'}.`;
    }
    return value;
  };
  const acknowledge = async (value: RemoteResult) => {
    if (value.outcome === 'unknown' && !latest.receipt && checks.get(checkKey) === check) checks.delete(checkKey);
    await ports.jobs.consumeNotice(job.id); return value;
  };
  let reader: RemoteLogReader | undefined; let outputUnreadable = false;
  const outputFailed = () => { outputUnreadable = true; if (checks.get(checkKey) === check) checks.delete(checkKey); };
  const unreadableResult = (resolution: JobFinish): RemoteResult => {
    const outcome: RemoteResult['outcome'] = resolution.reason === 'signal' ? 'signal'
      : resolution.reason === 'exited' || resolution.reason === 'cancelled' ? 'exited'
      : resolution.reason === 'spawn-error' || resolution.reason === 'release-timeout' ? 'spawn-error' : 'unknown';
    const signal = outcome === 'signal' ? Object.entries(constants.signals).find(([, number]) => number === resolution.signal)?.[0] : undefined;
    const value = outcome === 'unknown' || resolution.evidenceConflict ? uncertainResult() : result(outcome, resolution.reason === 'cancelled' ? 137 : resolution.exitCode, signal);
    value.stderr += `${value.stderr ? '\n' : ''}Output could not be read. Exact output is in the job logs: stdout ${logs.stdout}; stderr ${logs.stderr}.`;
    return value;
  };
  try { reader = await ports.logSink(job, { maxCaptureBytes: ports.hardCapBytes ?? 100 * 1024 * 1024, onData: request.onData }); }
  catch { outputFailed(); }
  try {
    while (true) {
      const collectStartedAt = ports.clock(), activeReader = reader;
      if (activeReader && !outputUnreadable) try { latest = await new Promise<CollectedLogs>((resolve, reject) => {
        releaseCollection = () => resolve(latest);
        void activeReader.collect().then(resolve, reject);
        if (finish?.reason === 'unknown' || finish?.evidenceConflict) releaseCollection();
      }).finally(() => { releaseCollection = undefined; }); }
      catch { outputFailed(); }
      if (request.signal?.aborted && !aborted) {
        await job.cancel('abort'); aborted = true; timedOut = false;
        if (reader && !outputUnreadable) try { latest = await reader.collect(); } catch { /* cancellation is confirmed; keep collected payload bytes */ }
        return acknowledge(result('aborted', 137));
      }
      if (latest.capped && !request.background) {
        await job.cancel('abort'); await ports.jobs.consumeNotice(job.id);
        throw Object.assign(new Error('Foreground remote output exceeded its capture budget; exact bytes remain in the logs'), { code: 'output-cap-exceeded', remote, logs });
      }
      if (outputUnreadable && finish) return acknowledge(unreadableResult(finish));
      if (finish?.reason === 'unknown' || finish?.evidenceConflict) return acknowledge(uncertainResult());
      if (latest.complete && latest.receipt && finish) {
        const receipt = latest.receipt;
        if (!agrees(receipt, finish)) return acknowledge(result('unknown', null));
        if (receipt.outcome === 'exited') return acknowledge(result('exited', receipt.exitCode));
        if (receipt.outcome === 'signal') return acknowledge(result('signal', null, receipt.signal!));
        if (receipt.outcome === 'cancelled') return acknowledge(result('exited', 137));
        const value = result('spawn-error', null);
        value.stderr ||= receipt.error ?? (receipt.outcome === 'release-timeout' ? 'Payload release deadline expired' : 'Payload could not start');
        return acknowledge(value);
      }
      if (!timedOut && request.timeout !== undefined && ports.clock() - startedAt >= request.timeout) {
        timedOut = true;
        if (request.background) {
          await ports.jobs.detach(job.id);
          return { ...result('timeout', null), backgrounded: true };
        }
        await job.cancel('timeout');
        continue; // Recollect the receipt and preserve the actual exit or signal, including a trapped HUP exit-zero.
      }
      if (finishLost || (finishedAt !== undefined && collectStartedAt - finishedAt >= 1000)) return acknowledge(result('unknown', null));
      await waitForChange(timedOut ? 25 : 100, request.signal);
    }
  } finally { await reader?.dispose(); }
}
export function createRemoteExecutor(ports: RemoteExecutionPorts): RemoteExecutionPort {
  return { execute: request => executeRemote(request, ports) };
}
