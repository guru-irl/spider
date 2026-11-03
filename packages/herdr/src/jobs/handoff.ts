// SPDX-License-Identifier: MIT
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HERDR_LABELS } from '../contracts.js';
import type { HcClient, JobId, Owner, RunId, TerminalAddress } from '../contracts.js';
import { closeAgentConsoles as closeRunConsoles } from '../remote/console.js';
import { HerdrError } from '../client/parse.js';
import { createJobStore, type JobJournal } from './store.js';

export interface ChildJobWriter { id: RunId; pid: number; startIdentity: string }
/** Missing/zombie processes return null; an unreadable live identity fails closed. */
export function processStartIdentity(pid: number): string | null {
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return null; throw error; }
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z') return null;
      if (fields[19]) return `linux:${fields[19]}`;
    } else if (process.platform !== 'win32') {
      const state = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', timeout: 1000 }).trim();
      if (state.startsWith('Z')) return null;
      const start = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).trim();
      if (start) return `posix:${start}`;
    }
  } catch (error) {
    try { process.kill(pid, 0); } catch (gone) { if ((gone as NodeJS.ErrnoException).code === 'ESRCH') return null; }
    throw error;
  }
  throw new HerdrError('child-identity-unavailable', 'Cannot establish the child job writer identity');
}
const runPs = promisify(execFile);
async function asyncProcessStartIdentity(pid: number): Promise<string | null> {
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return null; throw error; }
  try {
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z') return null;
      if (fields[19]) return `linux:${fields[19]}`;
    } else if (process.platform !== 'win32') {
      const { stdout } = await runPs('ps', ['-p', String(pid), '-o', 'stat=', '-o', 'lstart='], { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
      const line = stdout.trim(), boundary = line.search(/\s/);
      if (line.startsWith('Z')) return null;
      if (boundary >= 0 && line.slice(boundary).trim()) return `posix:${line.slice(boundary).trim()}`;
    }
  } catch (error) {
    try { process.kill(pid, 0); } catch (gone) { if ((gone as NodeJS.ErrnoException).code === 'ESRCH') return null; }
    throw error;
  }
  throw new HerdrError('child-identity-unavailable', 'Cannot establish the child job writer identity');
}
// Settled writers never write again. Keep their completed rows without reopening
// every job file on each handoff tick and feed snapshot. Bound process-local use.
const settledJournals = new Map<string, JobJournal>();
function cacheSettled(path: string, journal: JobJournal): void {
  if (!journal.child?.settled) return;
  if (settledJournals.size >= 256) settledJournals.delete(settledJournals.keys().next().value!);
  settledJournals.set(path, journal);
}
export async function readChildJobJournals(root: string, owner: Owner, reportError?: (error: unknown, runId: RunId) => void): Promise<JobJournal[]> {
  const directory = join(root, 'sessions', owner.sessionId, 'runs');
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const journals: JobJournal[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,160}$/.test(entry.name)) continue;
    const runId = entry.name as RunId, store = createJobStore(root, owner.sessionId, runId);
    try {
      const journal = settledJournals.get(store.path) ?? await store.read();
      if (journal.child?.id !== entry.name) continue;
      cacheSettled(store.path, journal); journals.push(journal);
    } catch (error) { reportError?.(error, runId); }
  }
  return journals;
}
const MISSING_WRITER: unique symbol = Symbol('missing-writer');
type WriterIdentityReader = (pid: number) => Promise<string | null | typeof MISSING_WRITER>;
const readWriterIdentity: WriterIdentityReader = async pid => {
  try { return await asyncProcessStartIdentity(pid) ?? MISSING_WRITER; }
  catch { return null; } // Unreadable is unknown, unlike a confirmed missing/zombie process.
};
const pendingRecovery = new WeakMap<JobJournal, { pid: number; startIdentity: string; jobs: Set<JobId>; readIdentity: WriterIdentityReader }>();
function markCrashJobs(journal: JobJournal, candidates: ReadonlySet<JobId>): void {
  const crashJobs = new Set(journal.writer?.crashJobs ?? []);
  for (const job of journal.jobs) {
    if (!candidates.has(job.id)) continue;
    if (job.callerOwned) job.detached = true;
    else if (!job.settledMarked && job.phase.kind !== 'finished' && job.phase.kind !== 'launch-failed') crashJobs.add(job.id);
  }
  if (crashJobs.size) journal.writer!.crashJobs = [...crashJobs];
}
/** A graceful shutdown is evidence, not an inference from a changed generation. */
export async function prepareJobRecovery(journal: JobJournal, adopted: boolean, callerCrashed = false, readIdentity: WriterIdentityReader = readWriterIdentity): Promise<void> {
  const previous = journal.writer, candidates = new Set(journal.jobs.map(job => job.id));
  if (!adopted && previous?.shutdown === null) {
    const identity = await readIdentity(previous.pid);
    if (identity === null) {
      callerCrashed = false;
      pendingRecovery.set(journal, { pid: previous.pid, startIdentity: previous.startIdentity, jobs: candidates, readIdentity });
    } else callerCrashed = identity !== previous.startIdentity;
  }
  journal.writer = adopted && previous ? { ...previous } : { pid: process.pid, startIdentity: await asyncProcessStartIdentity(process.pid) ?? processStartIdentity(process.pid)!, shutdown: null, ...(previous?.crashJobs?.length ? { crashJobs: [...previous.crashJobs] } : {}) };
  if (callerCrashed) markCrashJobs(journal, candidates);
}
/** Called before ordinary result reconciliation. Failed kills keep their durable intent. */
export async function reconcileJobRecovery(journal: JobJournal, options: {
  hc: HcClient; discovered: ReadonlyMap<JobId, TerminalAddress>; clock(): number; persist(): Promise<void>; reportError(error: unknown): void;
}): Promise<void> {
  const pending = pendingRecovery.get(journal);
  if (pending) {
    const identity = await pending.readIdentity(pending.pid);
    if (identity !== null) {
      pendingRecovery.delete(journal);
      if (identity !== pending.startIdentity) { markCrashJobs(journal, pending.jobs); await options.persist(); }
    }
  }
  for (const id of [...journal.writer?.crashJobs ?? []]) {
    try {
      const job = journal.jobs.find(job => job.id === id);
      const forget = () => { journal.writer!.crashJobs = journal.writer!.crashJobs!.filter(value => value !== id); if (!journal.writer!.crashJobs.length) delete journal.writer!.crashJobs; };
      if (!job || job.callerOwned || job.settledMarked || job.phase.kind === 'launch-failed' || job.phase.kind === 'finished') { forget(); await options.persist(); continue; }
      const address = 'address' in job.phase ? job.phase.address : options.discovered.get(id);
      if (!address) continue; // A launch reply may have been lost; the labelled snapshot can still arrive.
      let expired = false;
      try {
        const terminal = await options.hc.get(address);
        const labels = terminal.labels;
        if (labels[HERDR_LABELS.job] !== job.id || labels[HERDR_LABELS.session] !== job.owner.sessionId || labels[HERDR_LABELS.ownerCore] !== job.owner.terminal.coreId || labels[HERDR_LABELS.ownerTerminal] !== job.owner.terminal.terminalId || labels[HERDR_LABELS.kind] !== job.kind)
          throw new HerdrError('job-owner-mismatch', 'Crash recovery refuses a terminal with a different job owner');
        if (terminal.state === 'finished') {
          if (!job.handoffCancelled) { forget(); await options.persist(); continue; }
          job.originalFinish = { exitCode: terminal.exitCode, signal: terminal.signal, reason: terminal.reason ?? 'unknown', finishedAt: terminal.finishedAt ?? options.clock() };
        } else {
          job.handoffCancelled = true; await options.persist();
          await options.hc.kill(address);
        }
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'not_found')) throw error;
        expired = true;
      }
      // This is an owner cancellation, not the payload's exit result. Leave log/receipt collection to the monitor.
      job.handoffCancelled = true; job.notice = 'observed'; job.noticeDelivered = true;
      job.phase = { kind: 'finished', address, result: { exitCode: null, signal: null, reason: 'cancelled', finishedAt: options.clock() } };
      job.terminalExpired = expired; job.updatedAt = options.clock();
      forget(); await options.persist();
    } catch (error) { options.reportError(error); }
  }
}

/** A signal acknowledgement alone is not evidence that foreground effects have stopped. */
export async function foregroundJobsStopped(journal: JobJournal, hc: HcClient): Promise<boolean> {
  if (journal.writer?.crashJobs?.length) return false;
  for (const job of journal.jobs) {
    if (job.callerOwned || job.settledMarked || job.phase.kind === 'launch-failed') continue;
    if (!('address' in job.phase)) return false;
    try { if ((await hc.get(job.phase.address)).state !== 'finished') return false; }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'not_found')) throw error; }
  }
  return true;
}

export interface AdoptedJobMonitor { reconcile(): Promise<void>; shutdown(reason: 'reload' | 'quit'): Promise<void> }
export type AgentConsoleOwner = Owner & { runId: RunId };
export type CloseAgentConsoles = (owner: AgentConsoleOwner) => Promise<void>;
export interface JobHandoff {
  reconcile(): Promise<void>;
  shutdown(reason: 'reload' | 'quit'): Promise<void>;
}
/** The parent never writes a live child's journal. Only one monitor owns each abandoned run. */
export function createJobHandoff(options: {
  root: string; owner: Owner; hc: HcClient;
  adopt(runId: RunId, signal?: AbortSignal, callerCrashed?: boolean): Promise<AdoptedJobMonitor>;
  processIdentity?(pid: number): string | null | Promise<string | null>;
  closeAgentConsoles?: CloseAgentConsoles;
  reportError?(error: unknown): void;
}): JobHandoff {
  const adopted = new Map<RunId, AdoptedJobMonitor>();
  const closedConsoles = new Set<RunId>();
  const closeConsoles = async (id: RunId) => {
    if (closedConsoles.has(id)) return;
    const consoleOwner = { ...options.owner, runId: id };
    if (options.closeAgentConsoles) await options.closeAgentConsoles(consoleOwner);
    else await closeRunConsoles(consoleOwner, options.hc);
    closedConsoles.add(id);
  };
  const settled = (journal: JobJournal) => journal.jobs.every(job => job.settledMarked && job.terminalReleased || job.phase.kind === 'launch-failed');
  const markSettled = async (journal: JobJournal) => {
    journal.child = { ...journal.child!, ended: true, settled: true };
    journal.revision++;
    const store = createJobStore(options.root, options.owner.sessionId, journal.child.id);
    await store.write(journal); cacheSettled(store.path, journal);
  };
  const lifetime = new AbortController();
  let reconciliation: Promise<void> | undefined;
  const reportedRuns = new Set<RunId>();
  const reportRun = (error: unknown, id: RunId) => { if (!lifetime.signal.aborted && !reportedRuns.has(id)) { reportedRuns.add(id); options.reportError?.(error); } };
  const reconcile = async () => {
    const journals = await readChildJobJournals(options.root, options.owner, reportRun);
    await Promise.all(journals.map(async journal => {
      try {
      const child = journal.child!;
      if (lifetime.signal.aborted || child.settled && settled(journal)) return;
      let monitor = adopted.get(child.id);
      if (!monitor) {
        if (!child.ended && await (options.processIdentity ?? asyncProcessStartIdentity)(child.pid) === child.startIdentity) return;
        if (child.ended || settled(journal)) await closeConsoles(child.id);
        if (lifetime.signal.aborted) return;
        if (settled(journal)) { await markSettled(journal); closedConsoles.delete(child.id); return; }
        monitor = await options.adopt(child.id, lifetime.signal, !child.ended);
        adopted.set(child.id, monitor);
      }
      await monitor.reconcile();
      const latest = await createJobStore(options.root, options.owner.sessionId, child.id).read();
      if (!closedConsoles.has(child.id)) {
        if (!await foregroundJobsStopped(latest, options.hc) || lifetime.signal.aborted) return;
        await closeConsoles(child.id);
      }
      if (!settled(latest)) return;
      await monitor.shutdown('reload');
      await markSettled(latest);
      adopted.delete(child.id);
      closedConsoles.delete(child.id);
      reportedRuns.delete(child.id);
      } catch (error) { reportRun(error, journal.child!.id); }
    }));
  };
  return {
    reconcile() {
      if (lifetime.signal.aborted) return Promise.resolve();
      return reconciliation ??= reconcile().finally(() => { reconciliation = undefined; });
    },
    async shutdown(reason) {
      lifetime.abort();
      const existing = new Set(adopted.values()), stopping = [...existing].map(monitor => monitor.shutdown(reason));
      await reconciliation?.catch(() => {});
      const results = await Promise.allSettled([...stopping, ...[...adopted.values()].filter(monitor => !existing.has(monitor)).map(monitor => monitor.shutdown(reason))]);
      for (const result of results) if (result.status === 'rejected') options.reportError?.(result.reason);
      adopted.clear(); closedConsoles.clear();
    },
  };
}
