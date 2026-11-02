// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { constants } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AppClient, HcClient, JobRecord, PaneReservation, RunId, TerminalAddress } from '../contracts.js';
import { HERDR_LABELS, HERDR_KINDS } from '../contracts.js';
import type { JobSlot } from './monitor.js';
import type { AuxiliaryPaneActor } from './placement.js';
import { ensurePrivateDirectory } from './store.js';
import { HerdrError, parseTerminal } from '../client/parse.js';
import { invokeCli } from '../client/hc.js';
import { requireCoreAvailable } from '../client/liveness.js';
import { createChildTerminator } from '../client/child-termination.js';
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
  const terminal = () => invokeCli(options.hcBinary, ['get', options.address, '--json'], env).then(parseTerminal);
  const readSavedOutput = async () => {
    const reply = await invokeCli(options.hcBinary, ['read', options.address, '--lines', '100', '--json'], env);
    if (!reply || typeof reply !== 'object' || !('text' in reply) || typeof reply.text !== 'string') throw new HerdrError('invalid-observer-output', 'Saved terminal output is unavailable');
    process.stdout.write(reply.text);
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
  signal?: AbortSignal;
  releaseFileWriter(job: JobRecord, bytes: Buffer): Promise<void>;
  clock(): number;
}
/** Confirm the sidebar identity before release. No app, pane or observer is involved. */
export async function releaseRemoteJob(job: JobRecord & { runId?: RunId }, ports: PayloadReleasePorts): Promise<void> {
  if (!('address' in job.phase)) throw new HerdrError('job-not-launched', 'Payload release requires the original job terminal');
  const address = job.phase.address;
  const deadline = Math.min(ports.releaseDeadlineAt, ports.clock() + 10000);
  const check = () => {
    if (ports.signal?.aborted) throw new HerdrError('aborted', 'Payload release aborted');
    if (ports.clock() >= deadline) throw new HerdrError('release-timeout', 'Job labels were not confirmed before the release deadline');
  };
  async function withinDeadline<T>(request: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let aborted: (() => void) | undefined;
    try {
      return await Promise.race([
        request,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new HerdrError('release-timeout', 'Payload release did not complete before the deadline')), Math.max(1, deadline - ports.clock()));
          aborted = () => reject(new HerdrError('aborted', 'Payload release aborted'));
          ports.signal?.addEventListener('abort', aborted, { once: true });
          if (ports.signal?.aborted) aborted();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (aborted) ports.signal?.removeEventListener('abort', aborted);
    }
  }
  while (true) {
    check();
    try {
      const terminal = await withinDeadline(ports.hc.get(address));
      check();
      const labels = terminal.labels;
      if (terminal.address === address && labels[HERDR_LABELS.job] === job.id
        && labels[HERDR_LABELS.session] === job.owner.sessionId && labels[HERDR_LABELS.kind] === job.kind && labels[HERDR_LABELS.machine] === job.machine
        && labels[HERDR_LABELS.ownerCore] === job.owner.terminal.coreId
        && labels[HERDR_LABELS.ownerTerminal] === job.owner.terminal.terminalId
        && (!job.runId || labels[HERDR_LABELS.run] === job.runId)) break;
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'not_found')) throw error;
    }
    await delay(Math.min(25, Math.max(1, deadline - ports.clock())), undefined, { signal: ports.signal });
  }
  check();
  const requestSha256 = (await withinDeadline(ports.hc.fileRead(job.machine, join(job.remoteDirectory, 'request.json.sha256')))).toString().trim();
  check();
  await ports.releaseFileWriter(job, Buffer.from(JSON.stringify({ version: 1, jobId: job.id, nonce: ports.nonce, requestSha256, releasedAt: ports.clock() })));
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
