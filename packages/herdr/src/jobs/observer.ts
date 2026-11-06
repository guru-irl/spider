// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { constants } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { open, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AppClient, HcClient, JobRecord, PaneReservation, ReleaseFailure, ReleaseObservation, RunId, TerminalAddress } from '../contracts.js';
import { HERDR_LABELS, HERDR_KINDS } from '../contracts.js';
import type { JobSlot } from './monitor.js';
import type { AuxiliaryPaneActor } from './placement.js';
import { ensurePrivateDirectory } from './store.js';
import { HerdrError, parseTerminal, object, nullableInteger } from '../client/parse.js';
import { invokeCli } from '../client/hc.js';
import { requireCoreAvailable } from '../client/liveness.js';
import { createChildTerminator } from '../client/child-termination.js';
import { observeJobIdentity } from './identity.js';
export interface ObserverPorts {
  hc: HcClient;
  app: AppClient;
  panes: AuxiliaryPaneActor;
  viewerExecutable: readonly string[];
  hcBinary: string;
  nonce: string;
  deadlineAt: number;
  slot?: JobSlot;
  signal?: AbortSignal;
  clock(): number;
}
async function observerName(job: JobRecord, hc: HcClient): Promise<string> {
  let name = `${job.owner.name || 'Agent'} @ ${job.machine}`;
  if (!job.id.startsWith('console:')) {
    let command: string = job.kind, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const bytes = await Promise.race([hc.fileRead(job.machine, join(job.remoteDirectory, 'request.json')), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 250); })]);
      const request: unknown = bytes ? JSON.parse(bytes.toString()) : null;
      if (request && typeof request === 'object' && 'argv' in request && Array.isArray(request.argv) && request.argv.every(arg => typeof arg === 'string')) {
        command = request.argv.slice(0, 2).map(arg => arg.split('/').pop()).join(' ') || command;
      }
    } catch { /* A missing or slow optional command label must not fail the observer. */ }
    finally { clearTimeout(timer); }
    name = `${job.machine} · ${command}`;
  }
  return name.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 160);
}
export interface ObserverHandle { viewer: TerminalAddress; reservation: PaneReservation; release(): Promise<void> }
export interface ObserverProgramOptions { hcBinary: string; address: TerminalAddress; nonce: string; exitFile: string; env: Readonly<NodeJS.ProcessEnv>; signal?: AbortSignal; holdOpen?: boolean }
export async function runRemoteObserver(options: ObserverProgramOptions): Promise<number | null> {
  const closed = () => options.holdOpen && options.signal?.aborted;
  if (closed()) return 0;
  if (options.signal?.aborted) throw new HerdrError('aborted', 'Observer program aborted');
  const env = Object.freeze({ ...options.env });
  try { await requireCoreAvailable(env, options.signal); }
  catch (error) { if (closed()) return 0; throw error; }
  if (closed()) return 0;
  if (options.signal?.aborted) throw new HerdrError('aborted', 'Observer program aborted');
  const missing = (error: unknown) => error instanceof HerdrError && error.code === 'not_found';
  const localFile = async (name: string, tail = false) => {
    const file = await open(join(dirname(options.exitFile), name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || !tail && info.size > 65536) throw new HerdrError('invalid-observer-output', 'Saved output is not a bounded regular file');
      const bytes = Buffer.alloc(Math.min(info.size, 65536));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, tail ? Math.max(0, info.size - bytes.length) : 0);
      return bytes.subarray(0, bytesRead);
    } finally { await file.close(); }
  };
  const terminal = async () => {
    try { return await invokeCli(options.hcBinary, ['get', options.address, '--json'], env).then(parseTerminal); }
    catch (error) {
      if (!missing(error)) throw error;
      const receipt = object(JSON.parse((await localFile('receipt.json')).toString('utf8')));
      if (receipt.version !== 1) throw new HerdrError('invalid-observer-output', 'Saved receipt version is unavailable');
      return { state: 'finished' as const, exitCode: nullableInteger(receipt.exitCode) };
    }
  };
  const readSavedOutput = async () => {
    try {
      const reply = await invokeCli(options.hcBinary, ['read', options.address, '--lines', '100', '--json'], env);
      if (!reply || typeof reply !== 'object' || !('text' in reply) || typeof reply.text !== 'string') throw new HerdrError('invalid-observer-output', 'Saved terminal output is unavailable');
      process.stdout.write(reply.text);
    } catch (error) {
      if (!missing(error)) throw error;
      process.stdout.write(await localFile('stdout.log', true));
      process.stdout.write(await localFile('stderr.log', true));
    }
  };
  let finishedBeforeAttach = false;
  if (options.holdOpen) { try { finishedBeforeAttach = (await terminal()).state === 'finished'; } catch { /* Attach still reports a transport failure. */ } }
  let exitCode: number | null = 0;
  if (finishedBeforeAttach) await readSavedOutput();
  else {
    try { await requireCoreAvailable(env, options.signal); }
    catch (error) { if (closed()) return 0; throw error; }
    if (closed()) return 0;
    // Inherit the local TTY immediately after the probe: hc can auto-start a missing core.
    const child = spawn(options.hcBinary, ['attach', '--observe', '--history', '100', options.address], { env: { ...env }, stdio: 'inherit', shell: false });
    const stopChild = createChildTerminator(child);
    const aborted = () => { void stopChild(); };
    options.signal?.addEventListener('abort', aborted, { once: true });
    if (options.signal?.aborted) aborted();
    try { exitCode = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); }); }
    finally { options.signal?.removeEventListener('abort', aborted); await stopChild(); }
  }
  if (options.signal?.aborted) {
    if (options.holdOpen) return 0;
    throw new HerdrError('aborted', 'Observer program aborted');
  }
  if (!options.holdOpen) return exitCode;
  let jobExitCode: number | null = null, disconnected = false;
  try {
    const ended = await terminal(); jobExitCode = ended.exitCode; disconnected = ended.state !== 'finished';
    if (!finishedBeforeAttach && exitCode !== 0 && ended.state === 'finished') await readSavedOutput();
  }
  catch { disconnected = true; }
  if (options.signal?.aborted) return 0;
  process.stdout.write(disconnected ? '\nDisconnected. Close this pane when done.\n' : `\nFinished, exit ${jobExitCode ?? 'unknown'}. Close this pane when done.\n`);
  while (true) {
    if (options.signal?.aborted) return 0;
    let file;
    try {
      file = await open(options.exitFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      if ((await file.stat()).size > 4096) throw new HerdrError('invalid-observer-gate', 'Observer removal gate is oversized');
      const gate: unknown = JSON.parse(await file.readFile('utf8'));
      if (gate && typeof gate === 'object' && 'version' in gate && gate.version === 1 && 'nonce' in gate && gate.nonce === options.nonce) return 0;
    } catch (error) { if (!(error instanceof SyntaxError) && !(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
    finally { await file?.close(); }
    try { await delay(250, undefined, { signal: options.signal }); }
    catch (error) { if (options.signal?.aborted) return 0; throw error; }
  }
}
export function observerMarker(nonce: string): string { return `SPIDER_HERDR_READY:${nonce}`; }

export interface PayloadReleasePorts {
  hc: Pick<HcClient, 'get' | 'fileRead'>;
  nonce: string;
  releaseDeadlineAt: number;
  requestedAt?: number;
  queueWaitMs?: number;
  signal?: AbortSignal;
  releaseFileWriter(job: JobRecord, bytes: Buffer): Promise<void>;
  clock(): number;
}
export class PayloadReleaseError extends HerdrError {
  constructor(code: string, machine: string, public readonly releaseFailure: ReleaseFailure, public readonly releaseWriteStarted: boolean, cause: unknown) {
    const { step, elapsedMs, beforeReleaseMs, queueWaitMs, timerDriftMs } = releaseFailure;
    const reason = (cause instanceof Error ? cause.message : String(cause)).replace(/[\r\n]+/g, ' ').slice(0, 200);
    const confirmation = releaseFailure.confirmation;
    const last = confirmation?.last;
    const seen = !last ? '' : last.kind === 'not_found' ? `not_found on ${confirmation!.notFound} of ${confirmation!.checks} reads`
      : last.kind === 'matched' ? 'matching labels'
      : last.kind === 'address' ? `address ${JSON.stringify(last.actual)} instead of ${JSON.stringify(last.expected)}`
      : last.differences.map(d => `${d.label}=${JSON.stringify(d.actual)} instead of ${JSON.stringify(d.expected)}`).join(', ');
    const causeCode = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined;
    const before = beforeReleaseMs ? `${beforeReleaseMs} ms before release${queueWaitMs ? `, including ${queueWaitMs} ms queued` : ''}` : queueWaitMs ? `${queueWaitMs} ms queued` : '';
    const timing = [before, timerDriftMs ? `deadline timer ${timerDriftMs} ms late` : ''].filter(Boolean).map(value => `; ${value}`).join('');
    super(code, `Release on ${machine} failed at ${step} after ${elapsedMs} ms${timing}.${seen ? ` Last hc get saw ${seen.slice(0, 160)}.` : ''} ${reason}`, { releaseNotStarted: !releaseWriteStarted, ...(causeCode && causeCode !== code ? { causeCode } : {}) });
  }
}
/** Confirm the sidebar identity before release. No app, pane or observer is involved. */
export async function releaseRemoteJob(job: JobRecord & { runId?: RunId }, ports: PayloadReleasePorts): Promise<void> {
  if (!('address' in job.phase)) throw new HerdrError('job-not-launched', 'Payload release requires the original job terminal');
  const address = job.phase.address, startedAt = ports.clock();
  const deadline = Math.min(ports.releaseDeadlineAt, startedAt + 10000);
  const beforeReleaseMs = Math.max(0, startedAt - (ports.requestedAt ?? startedAt));
  let checks = 0, notFound = 0, first: ReleaseObservation | undefined, last: ReleaseObservation | undefined;
  const observe = (value: ReleaseObservation) => { first ??= value; last = value; };
  let step: ReleaseFailure['step'] = 'overall check', stepStartedAt = startedAt, timerDriftMs = 0, releaseWriteStarted = false;
  const check = () => {
    if (ports.signal?.aborted) throw new HerdrError('aborted', 'Payload release aborted');
    if (ports.clock() >= deadline) {
      step = 'overall check'; stepStartedAt = startedAt;
      throw new HerdrError('release-timeout', 'Job labels were not confirmed before the release deadline');
    }
  };
  async function withinDeadline<T>(name: ReleaseFailure['step'], operation: () => Promise<T>): Promise<T> {
    step = name; stepStartedAt = ports.clock();
    let timer: ReturnType<typeof setTimeout> | undefined, grace: ReturnType<typeof setTimeout> | undefined;
    let aborted: (() => void) | undefined;
    try {
      const request = Promise.resolve(operation());
      return await Promise.race([
        request,
        new Promise<never>((_resolve, reject) => {
          const expire = () => reject(new HerdrError('release-timeout', 'Payload release did not complete before the deadline'));
          timer = setTimeout(() => {
            timerDriftMs = Math.max(0, ports.clock() - deadline);
            // Child close and reply parsing can take several event-loop turns.
            if (timerDriftMs > 0) grace = setTimeout(expire, 150);
            else expire();
          }, Math.max(1, deadline - ports.clock()));
          aborted = () => reject(new HerdrError('aborted', 'Payload release aborted'));
          ports.signal?.addEventListener('abort', aborted, { once: true });
          if (ports.signal?.aborted) aborted();
        }),
      ]);
    } finally {
      clearTimeout(timer); clearTimeout(grace);
      if (aborted) ports.signal?.removeEventListener('abort', aborted);
    }
  }
  try {
    while (true) {
      check();
      try {
        checks++;
        const terminal = await withinDeadline('hc get', () => ports.hc.get(address));
        const observation = observeJobIdentity(job, address, terminal);
        observe(observation);
        check();
        if (observation.kind === 'matched') break;
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'not_found') { notFound++; observe({ kind: 'not_found' }); }
        else {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'caller-mismatch' && 'details' in error) {
            const details = error.details;
            if (details && typeof details === 'object' && 'actualAddress' in details && typeof details.actualAddress === 'string')
              observe({ kind: 'address', expected: address.slice(0, 256), actual: details.actualAddress.slice(0, 256) });
          }
          throw error;
        }
      }
      await delay(Math.min(25, Math.max(1, deadline - ports.clock())), undefined, { signal: ports.signal });
    }
    check();
    const requestSha256 = (await withinDeadline('fileRead', () => ports.hc.fileRead(job.machine, join(job.remoteDirectory, 'request.json.sha256')))).toString().trim();
    check();
    step = 'release write'; stepStartedAt = ports.clock();
    releaseWriteStarted = true;
    await ports.releaseFileWriter(job, Buffer.from(JSON.stringify({ version: 1, jobId: job.id, nonce: ports.nonce, requestSha256, releasedAt: ports.clock() })));
  } catch (error) {
    const causeCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'release-failed';
    const code = ports.signal?.aborted ? 'aborted' : causeCode === 'caller-mismatch' ? 'release-failed' : causeCode;
    throw new PayloadReleaseError(code, job.machine, { step, elapsedMs: Math.max(0, ports.clock() - stepStartedAt), beforeReleaseMs, queueWaitMs: ports.queueWaitMs ?? 0, timerDriftMs, ...(first && last ? { confirmation: { checks, notFound, first, last } } : {}) }, releaseWriteStarted, error);
  }
}
export async function openRemoteObserver(job: JobRecord, ports: ObserverPorts): Promise<ObserverHandle> {
  if (!('address' in job.phase)) throw new HerdrError('observer-job-not-launched', 'Observer requires the original returned remote address');
  const address = job.phase.address;
  const deadline = Math.min(ports.deadlineAt, ports.clock() + 10000);
  const check = () => { if (ports.signal?.aborted) throw new HerdrError('aborted', 'Observer acknowledgement aborted'); if (ports.clock() >= deadline) throw new HerdrError('observer-timeout', 'Observer was not ready before its display deadline'); };
  check();
  const slot = ports.slot ?? await ports.panes.reserveRemote(job.id, job.owner, { signal: ports.signal, timeoutMs: 30000 });
  const placement = ports.panes.placement(slot);
  let viewer: TerminalAddress | null = null;
  const ownsView = (terminal: { address: TerminalAddress; labels: Readonly<Record<string, string>> }, expected: TerminalAddress) => terminal.address === expected
    && terminal.labels[HERDR_LABELS.kind] === HERDR_KINDS.remoteObserver && terminal.labels[HERDR_LABELS.job] === job.id
    && terminal.labels[HERDR_LABELS.session] === job.owner.sessionId && terminal.labels[HERDR_LABELS.ownerCore] === job.owner.terminal.coreId
    && terminal.labels[HERDR_LABELS.ownerTerminal] === job.owner.terminal.terminalId;
  try {
    check();
    await ensurePrivateDirectory(job.localDirectory);
    const exitFile = join(job.localDirectory, `observer-exit-${randomUUID()}.json`);
    const terminal = await ports.hc.run({ name: `obs-${createHash('sha256').update(JSON.stringify([job.owner.sessionId, job.owner.terminal.coreId, job.owner.terminal.terminalId, job.id, ports.nonce])).digest('hex').slice(0, 28)}`, argv: [...ports.viewerExecutable, '--observe', address, '--hc', ports.hcBinary, '--nonce', ports.nonce, '--exit-file', exitFile], cwd: job.localDirectory, parent: null, labels: { [HERDR_LABELS.session]: job.owner.sessionId, [HERDR_LABELS.ownerCore]: job.owner.terminal.coreId, [HERDR_LABELS.ownerTerminal]: job.owner.terminal.terminalId, [HERDR_LABELS.kind]: HERDR_KINDS.remoteObserver, [HERDR_LABELS.job]: job.id, [HERDR_LABELS.machine]: job.machine, [HERDR_LABELS.displayName]: await observerName(job, ports.hc), ...(job.runId ? { [HERDR_LABELS.run]: job.runId } : {}) }, outliveParent: true, background: true, noNotify: true });
    if (terminal.address.includes('/') || terminal.address === job.owner.terminal.address || terminal.address === address
      || !ownsView(await ports.hc.get(terminal.address), terminal.address)) throw new HerdrError('observer-address-invalid', 'Observer launch did not return a new owned local terminal');
    viewer = terminal.address;
    const reservation = await ports.panes.display(slot, viewer, { signal: ports.signal, timeoutMs: Math.max(1, deadline - ports.clock()) });
    while (true) {
      check();
      const screen = await ports.hc.read(viewer, { lines: 100 });
      if (screen.split(/\r?\n/).some(line => line.trim() === observerMarker(ports.nonce))) break;
      await delay(Math.min(25, Math.max(1, deadline - ports.clock())), undefined, { signal: ports.signal });
    }
    const acknowledged = ports.panes.placement(slot);
    if (acknowledged.space === placement.space && acknowledged.tab === placement.tab) {
      const current = await ports.app.ownerPlacement(job.owner.terminal.address);
      if (current.space !== placement.space || current.tab !== placement.tab) throw new HerdrError('owner-tab-changed', 'Owner moved before observer display');
    }
    // Re-read the observer's membership too: it may have closed during the screen read.
    const observed = await ports.app.ownerPlacement(viewer);
    if (observed.space !== acknowledged.space || observed.tab !== acknowledged.tab || observed.pane !== reservation.pane) throw new HerdrError('observer-unplaced', 'Observer no longer belongs to the acknowledged owner tab');
    check();
    await writeFile(exitFile + '.ready', JSON.stringify({ version: 1, jobId: job.id, nonce: ports.nonce, acknowledgedAt: ports.clock() }), { mode: 0o600, flag: 'wx' });
    check();
    let releasing: Promise<void> | undefined;
    return { viewer, reservation, release: () => releasing ??= (async () => {
      // The wrapper cannot exit (or turn into a kept recovery shell) before the app acknowledges removal.
      await ports.panes.release(reservation);
      await ensurePrivateDirectory(job.localDirectory);
      const file = await open(exitFile, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(JSON.stringify({ version: 1, nonce: ports.nonce, removedAt: ports.clock() })); await file.sync(); } finally { await file.close(); }
    })() };
  } catch (error) {
    if (viewer) {
      const current = await ports.hc.get(viewer).catch(error => { if (error instanceof HerdrError && error.code === 'not_found') return null; throw error; });
      if (current && ownsView(current, viewer)) { await ports.hc.kill(viewer); await ports.hc.rm(viewer); }
    }
    await ports.panes.abandon(slot);
    throw error;
  }
}
