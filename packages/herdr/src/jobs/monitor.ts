// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createCleanupSweep, MAX_FAILED_TERMINAL_CLEANUP_ATTEMPTS, needsFailedCleanup, type CleanupSweep } from './cleanup.js';
import { noticeRecoveryCandidates, recoverJobNotices } from './notices.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PayloadReleaseError, releaseRemoteJob } from './observer.js';
import { observeJobIdentity } from './identity.js';
import { compactFailedPhase } from './diagnostics.js';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { createJobStore, ensurePrivateDirectory, MAX_BYTES, type JournalJob, type JobJournal } from './store.js';
import { jobPruneCandidates } from './prune.js';
import { HerdrError } from '../client/parse.js';
import { createJobHandoff, prepareJobRecovery, reconcileJobRecovery, type ChildJobWriter, type JobHandoff, type CloseAgentConsoles } from './handoff.js';
import { HERDR_LABELS, HERDR_KINDS } from '../contracts.js';
import type { AppClient, HcCallOptions, HcClient, JobHandle, JobFinish, JobId, JobPort, JobRecord, MachineName, Owner, PreparedProgram, RunId, TerminalAddress, TerminalFinish, TerminalSummary } from '../contracts.js';

/** C verifies receipt digests before returning this port value. D checks the nonce binding and original event. */
export interface JobOutput {
  complete: boolean;
  /** Bounded, secret-scrubbed summary supplied by the host collector, not raw command output. */
  summary: string;
  receipt: { jobId: JobId; nonce: string; finish: TerminalFinish } | null;
}
export interface JobLaunch {
  program: PreparedProgram;
  nonce: string;
}
export interface JobNotice {
  customType: 'spider.job_done';
  content: string;
  display: true;
  details: { jobId: JobId; nonce: string; generation: Owner['generation']; runId?: RunId; machine: string; address: TerminalAddress; exitCode: number | null; reason: string; signal: number | null; complete: boolean; localDirectory: string; remoteDirectory: string };
}
export interface JobSlot { id: string }
export interface JobObserver { viewer: TerminalAddress; release(): Promise<void> }
export interface JobMonitorOptions {
  hc: HcClient;
  app?: AppClient;
  panes?: {
    reserve(id: JobId, owner: Owner, options: { signal?: AbortSignal; timeoutMs: number }): Promise<JobSlot>;
    observe(job: JobRecord, slot: JobSlot, options: { signal?: AbortSignal; nonce: string; releaseDeadlineAt: number; cancelOriginal(): Promise<void> }): Promise<JobObserver>;
    abandon(slot: JobSlot): Promise<void>;
  };
  outputCollector: {
    prepare(program: PreparedProgram, job: JobRecord): Promise<JobLaunch>;
    collect(job: JobRecord): Promise<JobOutput>;
  };
  journalRoot: string;
  child?: ChildJobWriter;
  /** Set only by the parent handoff after the child journal writer has ended. */
  adoptedRunId?: RunId;
  /** Supplied only by handoff after proving an unclean child writer is gone. */
  callerCrashed?: boolean;
  closeAgentConsoles?: CloseAgentConsoles;
  observedJobMessages(owner: Owner): Promise<readonly JobId[]>;
  notifier(notice: JobNotice): void | Promise<void>;
  clock(): number;
  reportError?(error: unknown): void;
  recordCleanupError?(error: unknown): void;
  reportConsoleError?(error: unknown): void;
}
export interface JobMonitor extends JobPort {
  activate(owner: Owner, signal?: AbortSignal): Promise<void>;
  reconcile(): Promise<void>;
  finishCleanup(): Promise<void>;
  consoleIdle(owner: Owner, on: MachineName, runId?: RunId): Promise<boolean>;
  consoleError(error: unknown): void;
  shutdown(reason: 'reload' | 'quit'): Promise<void>;
}
function terminalMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'not_found');
}
/** One writer and one event subscription per owning pi activation. Only unreleased attempts may retry. */
export function createJobMonitor(options: JobMonitorOptions, sharedCleanup?: CleanupSweep): JobMonitor {
  let owner: Owner | null = null;
  let store: ReturnType<typeof createJobStore>;
  let journal: JobJournal;
  let persistedState: string | undefined;
  let handoff: JobHandoff | undefined;
  let stream: ReturnType<HcClient['events']> | undefined;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let activated = false;
  let closed = false;
  let stopping = false;
  let queue: Promise<unknown> = Promise.resolve();
  const lifetime = new AbortController();
  let shutdownPromise: Promise<void> | undefined;
  // Event readiness is quick; a collection can require many sequential SSH reads.
  const outputBudgetMs = 60000;
  const collections = new Map<JobId, { task: Promise<void>; firstIncomplete: Promise<void>; readSettled(): boolean; done: Promise<void> }>();
  const outputWarnings = new Set<JobId>();
  const recoveringNotices = new Set<JobId>();
  const unreturned = new Set<JobId>();
  let noticeRecoveryRead: Promise<() => void> | undefined;
  let noticesApplied = false;
  let reconciliation: Promise<void> | undefined;
  function waitForEvents<T>(promise: Promise<T>, signal?: AbortSignal, unavailable = 'Herdr events are unavailable', deferStop = false, timeoutMs = 2000, timeoutCode = 'core-unavailable'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const finish = (error?: Error, value?: T) => {
        clearTimeout(deadline);
        lifetime.signal.removeEventListener('abort', stopped);
        signal?.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve(value as T);
      };
      const stopped = () => { const stop = () => finish(new HerdrError('disposed', 'Job monitor is stopping')); if (deferStop) setImmediate(stop); else stop(); };
      const aborted = () => finish(new HerdrError('aborted', 'Job launch aborted'));
      const deadline = setTimeout(() => finish(new HerdrError(timeoutCode, unavailable)), timeoutMs);
      void promise.then(value => finish(undefined, value), error => finish(error));
      lifetime.signal.addEventListener('abort', stopped, { once: true });
      signal?.addEventListener('abort', aborted, { once: true });
      if (lifetime.signal.aborted) stopped(); else if (signal?.aborted) aborted();
    });
  }
  const waiters = new Map<JobId, { promise: Promise<JobFinish>; resolve(value: JobFinish): void }>();
  const observers = new Map<JobId, JobObserver>();
  const discovered = new Map<JobId, TerminalAddress>();
  const lostOriginals = new Set<TerminalAddress>(), finishedOriginals = new Set<TerminalAddress>();
  const holds = new Map<JobId, ReturnType<typeof setTimeout>>();
  const report = (error: unknown) => {
    // The owning host announces core loss and turns routing inactive once.
    if (error instanceof HerdrError && (error.code === 'core-unavailable' || lifetime.signal.aborted && ['disposed', 'aborted'].includes(error.code))) return;
    options.reportError?.(error);
  };
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(() => operation()); queue = result.catch(() => {}); return result;
  }
  function tracked(id: JobId): JournalJob {
    const job = journal.jobs.find(j => j.id === id);
    if (!job) throw new HerdrError('job-not-owned', 'No tracked job belongs to this activation'); return job;
  }
  async function persist(): Promise<void> {
    if (options.child && journal.jobs.length === 0) return;
    const state = JSON.stringify({ ...journal, revision: 0, updatedAt: 0 });
    if (state === persistedState) { queueCompaction(); return; }
    journal.revision++; journal.updatedAt = options.clock();
    if (Buffer.byteLength(JSON.stringify(journal)) > MAX_BYTES) {
      for (const job of pruneCandidates(true)) {
        try { if (await removePrunedLogs(job)) forgetPrunedJob(job); }
        catch (error) { if (!pruneFailures.has(job.id)) { pruneFailures.add(job.id); report(error); } }
        if (Buffer.byteLength(JSON.stringify(journal)) <= MAX_BYTES) break;
      }
    }
    const savedState = JSON.stringify({ ...journal, revision: 0, updatedAt: 0 });
    await store.write(journal);
    persistedState = savedState;
    queueCompaction();
  }
  function waiter(id: JobId) {
    let value = waiters.get(id);
    if (!value) { let resolve!: (value: JobFinish) => void; const promise = new Promise<JobFinish>(r => { resolve = r; }); value = { promise, resolve }; waiters.set(id, value); }
    return value;
  }
  const sameOwner = (other: Owner) => owner !== null && other.sessionId === owner.sessionId && other.generation === owner.generation && other.terminal.coreId === owner.terminal.coreId && other.terminal.terminalId === owner.terminal.terminalId && other.terminal.socket === owner.terminal.socket;
  const hasExitData = (finish: TerminalFinish) => finish.exitCode !== null || finish.signal !== null;
  const addressOf = (job: JobRecord): TerminalAddress | null => 'address' in job.phase ? job.phase.address : null;
  const liveOriginal = (job: JournalJob): TerminalAddress | null => { const address = addressOf(job); return address && !job.uncertain && !job.originalFinish && job.phase.kind !== 'finished' && !lostOriginals.has(address) && !finishedOriginals.has(address) ? address : null; };
  async function release(job: JournalJob): Promise<void> {
    const hold = holds.get(job.id); if (hold) { clearTimeout(hold); holds.delete(job.id); }
    const observer = observers.get(job.id);
    if (observer) { try { await observer.release(); } finally { observers.delete(job.id); } }
  }
  function holdFinal(job: JournalJob): void {
    if (holds.has(job.id)) return;
    holds.set(job.id, setTimeout(() => { holds.delete(job.id); queueRelease(job); }, 2000));
  }
  const cleanup = sharedCleanup ?? createCleanupSweep(options.clock, error => { if (!lifetime.signal.aborted) options.recordCleanupError?.(error); });
  const cleanupKeys = new Set<string>();
  function enqueueCleanup(key: string, operation: () => Promise<void>): boolean {
    if (stopping || closed) return false;
    cleanupKeys.add(key); return cleanup.enqueue(key, operation);
  }
  const releaseSkipped = new Set<JobId>();
  const cleanupOptions = () => ({ signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(1000)]), timeoutMs: 1000 });
  const cleanupCall = <T>(operation: () => Promise<T>) => {
    if (lifetime.signal.aborted) return Promise.reject(new HerdrError('disposed', 'Job monitor is stopping'));
    return waitForEvents(operation(), undefined, 'Job terminal cleanup timed out', false, 5000, 'cleanup-timeout');
  };
  async function boundedHc<T>(operation: (options: HcCallOptions) => Promise<T>, timeoutMs = 1000, abortSignal?: AbortSignal): Promise<T> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = abortSignal ? AbortSignal.any([deadline, abortSignal]) : deadline;
    const failure = () => abortSignal?.aborted ? new HerdrError('disposed', 'Job monitor is stopping') : new HerdrError('cleanup-timeout', 'Job terminal cleanup timed out');
    let interrupted!: () => void;
    const timeout = new Promise<never>((_resolve, reject) => {
      interrupted = () => reject(failure());
      signal.addEventListener('abort', interrupted, { once: true });
      if (signal.aborted) interrupted();
    });
    try { return await Promise.race([Promise.resolve().then(() => { if (signal.aborted) throw failure(); return operation({ signal, timeoutMs }); }), timeout]); }
    finally { signal.removeEventListener('abort', interrupted); }
  }
  async function verifiedTerminal(job: JournalJob, address: TerminalAddress, timeoutMs = 1000, signal?: AbortSignal) {
    let terminal;
    try { terminal = await boundedHc(callOptions => options.hc.get(address, callOptions), timeoutMs, signal); }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'caller-mismatch') throw new HerdrError('job-outcome-unknown', 'Terminal identity does not match this job'); throw error; }
    if (observeJobIdentity(job, address, terminal).kind !== 'matched' || lostOriginals.has(address)) throw new HerdrError('job-outcome-unknown', 'Terminal identity does not match this job');
    return terminal;
  }
  async function signalOriginal(job: JournalJob, address: TerminalAddress, beforeSignal?: () => Promise<void>, timeoutMs = 15000, signal?: AbortSignal): Promise<void> {
    if (job.uncertain || lostOriginals.has(address)) throw new HerdrError('job-outcome-unknown', 'Original incarnation is no longer known; not signaling a recovery shell');
    const terminal = await verifiedTerminal(job, address, timeoutMs, signal);
    if (terminal.state === 'finished') return;
    if (beforeSignal) await beforeSignal();
    // hc cannot bind this identity check atomically to the signal; the terminal may change between them.
    const current = await verifiedTerminal(job, address, timeoutMs, signal);
    if (current.state === 'finished') return;
    if (job.uncertain || lostOriginals.has(address)) throw new HerdrError('job-outcome-unknown', 'Original incarnation is no longer known; not signaling a recovery shell');
    await boundedHc(callOptions => options.hc.kill(address, callOptions), timeoutMs, signal);
  }
  async function confirmMissing(address: TerminalAddress, bounded = false, expectedMachine?: MachineName, timeoutMs = 1000, signal?: AbortSignal): Promise<void> {
    if (!address.includes('/')) throw new HerdrError('machine-unavailable', 'Job terminal cleanup requires a qualified remote address');
    const name = address.slice(0, address.lastIndexOf('/'));
    const machines = bounded ? await boundedHc(callOptions => options.hc.machines(callOptions), timeoutMs, signal) : await cleanupCall(() => options.hc.machines(cleanupOptions()));
    if (!machines.some(machine => {
      const matches = (value: string) => machine.name === value || machine.aliases.some(alias => alias === value);
      return machine.state === 'connected' && matches(name) && (!expectedMachine || matches(expectedMachine));
    })) throw new HerdrError('machine-unavailable', 'Job terminal cleanup requires the connected destination');
    try {
      if (bounded) await boundedHc(callOptions => options.hc.get(address, callOptions), timeoutMs, signal);
      else await cleanupCall(() => options.hc.get(address, cleanupOptions()));
    } catch (error) { if (terminalMissing(error)) return; throw error; }
    throw new HerdrError('job-outcome-unknown', 'Job terminal is still present');
  }
  async function releaseSettledTerminal(job: JournalJob, save: () => Promise<void>): Promise<void> {
    if (job.terminalReleased || releaseSkipped.has(job.id) || job.phase.kind !== 'finished' || !job.output?.complete || job.evidenceConflict) return;
    if (!job.settledMarked) {
      const marker = Buffer.from(JSON.stringify({ version: 1, jobId: job.id, nonce: job.nonce, finishedAt: job.phase.result.finishedAt }));
      await cleanupCall(() => options.hc.fileWrite(job.machine, join(job.remoteDirectory, '.spider-settled'), marker, cleanupOptions()));
      if (lifetime.signal.aborted) return;
      job.settledMarked = true; await save();
    }
    if (job.notice !== 'observed' || holds.has(job.id)) return;
    const address = job.phase.address;
    const matches = (terminal: TerminalSummary) => terminal.state === 'finished' && !lostOriginals.has(address) && observeJobIdentity(job, address, terminal).kind === 'matched';
    const skip = async () => { releaseSkipped.add(job.id); if (job.cleanupFailure) { delete job.cleanupFailure; await save(); } };
    try {
      const terminal = await cleanupCall(() => options.hc.get(address, cleanupOptions()));
      if (!matches(terminal)) { await skip(); return; }
      if (lifetime.signal.aborted) return;
      await cleanupCall(() => release(job));
      if (lifetime.signal.aborted) return;
      // hc cannot bind this identity check atomically to removal; the terminal may change between them.
      const current = await cleanupCall(() => options.hc.get(address, cleanupOptions()));
      if (!matches(current)) { await skip(); return; }
      await cleanupCall(() => options.hc.rm(address, cleanupOptions()));
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'not_found')) throw error;
      await confirmMissing(address, false, job.machine);
    }
    if (!lifetime.signal.aborted) { job.terminalReleased = true; job.updatedAt = options.clock(); delete job.cleanupFailure; await save(); }
  }
  const releaseKey = (job: JournalJob) => `${job.owner.sessionId}/${job.runId ?? ''}/${job.id}`;
  const failedCleanupKey = (job: JournalJob) => `${releaseKey(job)}/failed`;
  const failedTerminalKey = (job: JournalJob) => `${releaseKey(job)}/failed-terminal`;
  const failedCleanupDelay = (attempts: number) => 30000 * 2 ** attempts;
  async function markFailedProgram(job: JournalJob, background = false): Promise<void> {
    const marker = Buffer.from(JSON.stringify({ version: 1, jobId: job.id, nonce: job.nonce, finishedAt: options.clock() }));
    const write = (callOptions: HcCallOptions) => options.hc.fileWrite(job.machine, join(job.remoteDirectory, '.spider-settled'), marker, callOptions);
    if (background) await boundedHc(write, 15000, lifetime.signal);
    else await cleanupCall(() => write(cleanupOptions()));
  }
  async function removeFailedTerminal(job: JournalJob, address: TerminalAddress): Promise<'removed' | 'mismatch'> {
    try {
      await signalOriginal(job, address, undefined, 15000, lifetime.signal);
      await verifiedTerminal(job, address, 15000, lifetime.signal);
      if (job.uncertain || lostOriginals.has(address)) return 'mismatch';
      await boundedHc(callOptions => options.hc.rm(address, callOptions), 15000, lifetime.signal);
    } catch (error) {
      if (error instanceof HerdrError && error.code === 'job-outcome-unknown') return 'mismatch';
      if (!terminalMissing(error)) throw error;
    }
    await confirmMissing(address, true, job.machine, 15000, lifetime.signal);
    return 'removed';
  }
  function queueFailedCleanup(job: JournalJob): void {
    if (!needsFailedCleanup(job)) return;
    if (!job.terminalReleased) {
      const pending = job.failedTerminalCleanup;
      if (!pending || pending.nextAt > options.clock()) return;
      if (enqueueCleanup(failedTerminalKey(job), async () => {
        const started = await serial(async () => {
          if (stopping || closed || !journal.jobs.includes(job) || !needsFailedCleanup(job) || job.failedTerminalCleanup !== pending || pending.nextAt > options.clock()) return null;
          // Count an attempt before contacting the core.
          // An interrupted final attempt only checks for absence after restart.
          const verifyOnly = pending.attempts >= MAX_FAILED_TERMINAL_CLEANUP_ATTEMPTS;
          if (!verifyOnly) pending.attempts++;
          pending.nextAt = options.clock() + failedCleanupDelay(pending.attempts - 1);
          await persist(); return { verifyOnly };
        });
        if (!started) return;
        let result: 'removed' | 'mismatch';
        try {
          if (started.verifyOnly) { await confirmMissing(pending.address, true, job.machine, 15000, lifetime.signal); result = 'removed'; }
          else result = await removeFailedTerminal(job, pending.address);
        } catch (error) {
          if (lifetime.signal.aborted) return;
          await serial(async () => {
            if (stopping || closed || !journal.jobs.includes(job) || job.failedTerminalCleanup !== pending) return;
            if (pending.attempts >= MAX_FAILED_TERMINAL_CLEANUP_ATTEMPTS) pending.exhausted = true;
            pending.nextAt = options.clock() + failedCleanupDelay(pending.attempts - 1);
            await persist();
          });
          options.recordCleanupError?.(error); return;
        }
        if (lifetime.signal.aborted) return;
        await serial(async () => {
          if (stopping || closed || !journal.jobs.includes(job) || job.failedTerminalCleanup !== pending || job.phase.kind !== 'launch-failed') return;
          if (result === 'mismatch') job.uncertain = true;
          else if (!job.uncertain) { job.terminalReleased = true; delete job.failedTerminalCleanup; job.updatedAt = options.clock(); }
          await persist(); queueFailedCleanup(job);
        });
      })) scheduleMaintenance();
      return;
    }
    if (enqueueCleanup(failedCleanupKey(job), async () => {
      await markFailedProgram(job, true);
      await serial(async () => {
        if (!journal.jobs.includes(job) || job.phase.kind !== 'launch-failed') return;
        job.settledMarked = true; job.updatedAt = options.clock(); await persist();
      });
    })) scheduleMaintenance();
  }
  function queueRelease(job: JournalJob, save: () => Promise<void> = () => serial(persist)): void {
    if (recoveringNotices.has(job.id) || job.terminalReleased || releaseSkipped.has(job.id) || job.settledMarked && (holds.has(job.id) || job.notice !== 'observed') || job.phase.kind !== 'finished' || !job.output?.complete || job.evidenceConflict || !job.noticeDelivered && !job.terminalExpired || !job.originalFinish && !job.terminalExpired) return;
    const enqueued = enqueueCleanup(releaseKey(job), async () => {
      try { await releaseSettledTerminal(job, save); }
      catch (error) {
        if (lifetime.signal.aborted) throw error;
        const previous = job.cleanupFailure, now = options.clock();
        const code = error instanceof HerdrError ? error.code.replace(/[^a-zA-Z0-9_.-]/g, '?').slice(0, 100) : 'cleanup-failed';
        job.cleanupFailure = { code, attempts: (previous?.attempts ?? 0) + 1, firstAt: previous?.firstAt ?? now, lastAt: now };
        await save();
        throw error;
      }
    });
    if (enqueued) scheduleMaintenance();
  }
  const prunedLogs = new Map<JobId, Promise<boolean>>();
  const pruneFailures = new Set<JobId>();
  const pruneCandidates = (pressure = false) => jobPruneCandidates(journal, { directory: store.directory, now: options.clock(), recoveringNotices, holds, unreturned }, pressure);
  function removePrunedLogs(job: JournalJob): Promise<boolean> {
    const existing = prunedLogs.get(job.id); if (existing) return existing;
    const task = (async () => {
      if (stopping || closed) return false;
      await cleanupCall(() => release(job)); await ensurePrivateDirectory(job.localDirectory);
      if (stopping || closed) return false;
      await rm(job.localDirectory, { recursive: true });
      return true;
    })().catch(error => { prunedLogs.delete(job.id); throw error; });
    prunedLogs.set(job.id, task); return task;
  }
  function forgetPrunedJob(job: JournalJob): void {
    journal.jobs = journal.jobs.filter(value => value.id !== job.id);
    cleanup.cancel(releaseKey(job)); cleanup.cancel(`${releaseKey(job)}/prune`); cleanup.cancel(failedCleanupKey(job)); cleanup.cancel(failedTerminalKey(job));
    cleanupKeys.delete(releaseKey(job)); cleanupKeys.delete(`${releaseKey(job)}/prune`); cleanupKeys.delete(failedCleanupKey(job)); cleanupKeys.delete(failedTerminalKey(job));
    prunedLogs.delete(job.id); pruneFailures.delete(job.id);
    waiters.delete(job.id); discovered.delete(job.id); outputWarnings.delete(job.id); releaseSkipped.delete(job.id); unreturned.delete(job.id);
  }
  function queueCompaction(): void {
    if (stopping || closed) return;
    for (const job of pruneCandidates()) {
      enqueueCleanup(`${releaseKey(job)}/prune`, async () => {
        if (!await serial(async () => !stopping && !closed && pruneCandidates().includes(job))) return;
        if (!await removePrunedLogs(job)) return;
        await serial(async () => {
          if (stopping || closed || !journal.jobs.includes(job)) return;
          forgetPrunedJob(job); await persist();
        });
      });
    }
  }
  async function markSettled(job: JournalJob): Promise<void> { queueRelease(job); }
  function observeNotice(job: JournalJob): void {
    if (job.notice !== 'observed' || job.noticeObservedGeneration !== owner!.generation) job.updatedAt = options.clock();
    job.notice = 'observed'; job.noticeDelivered = true; job.noticeObservedGeneration = owner!.generation;
  }
  async function deliver(job: JournalJob): Promise<void> {
    if (stopping || closed || job.noticeMode !== 'async' || job.notice !== 'pending' || job.phase.kind !== 'finished' || !job.output) return;
    const result = job.phase.result;
    const summary = Buffer.from(job.output.summary.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')).subarray(0, 2048).toString('utf8');
    const notice: JobNotice = { customType: 'spider.job_done', display: true,
      content: `Job ${job.id}${job.runId ? ` (run ${job.runId})` : ''} on ${job.machine} (${job.phase.address}): ${result.reason}; exit=${result.exitCode ?? 'unknown'}, signal=${result.signal ?? 'none'}.\n${summary}\nLogs: ${job.localDirectory}; remote receipt: ${job.remoteDirectory}/receipt.json`,
      details: { jobId: job.id, nonce: job.nonce, generation: owner!.generation, ...(job.runId ? { runId: job.runId } : {}), machine: job.machine, address: job.phase.address, exitCode: result.exitCode, reason: result.reason, signal: result.signal, complete: job.output.complete, localDirectory: job.localDirectory, remoteDirectory: job.remoteDirectory } };
    // Persist eligibility/outcome before calling pi. Mark submission before the call so an uncertain call is not retried blindly.
    job.notice = 'submitted'; await persist();
    await options.notifier(notice);
    job.noticeDelivered = true; await persist(); await markSettled(job);
  }
  async function collect(job: JournalJob, signal?: AbortSignal): Promise<void> {
    if (journal.writer?.crashJobs?.includes(job.id)) return;
    if (job.evidenceConflict && job.output?.complete) return;
    if (job.settledMarked && job.phase.kind === 'finished' && job.output?.complete) { await deliver(job); return; }
    const address = addressOf(job); if (!address || !job.nonce) return;
    if (stopping || closed) return;
    if (collections.has(job.id)) { if (outputWarnings.has(job.id)) await settleUnavailableOutput(job, address); return; }
    let expired = false, markIncomplete!: () => void;
    const firstIncomplete = new Promise<void>(resolve => { markIncomplete = resolve; });
    const read = (async () => {
      while (true) {
        const output = await options.outputCollector.collect(job);
        if (expired || output.receipt || output.complete || job.phase.kind === 'finished' || !job.originalFinish && !job.terminalExpired) return output;
        markIncomplete();
        await delay(100, undefined, { signal: lifetime.signal });
      }
    })();
    let readDone = false;
    void read.then(() => { readDone = true; }, () => { readDone = true; });
    const observable = async () => {
      if (liveOriginal(job) !== address) return false;
      const terminal = await waitForEvents(stream!.lookup(address), signal);
      return terminal?.state === 'live' && terminal.labels[HERDR_LABELS.job] === job.id && terminal.labels[HERDR_LABELS.session] === job.owner.sessionId;
    };
    const boundedRead = async () => {
      let running = observable().catch(() => false);
      for (;;) {
        try { return await waitForEvents(read, signal, 'Remote job output is unavailable', true, outputBudgetMs, 'output-unavailable'); }
        catch (error) {
          if (readDone) return read;
          if (!(error instanceof HerdrError) || error.code !== 'output-unavailable') throw error;
          const wasRunning = await running;
          running = observable().catch(() => false);
          if (!wasRunning && !await running) throw error;
          markIncomplete();
        }
      }
    };
    const task = Promise.race([read, boundedRead()])
      .then(output => serial(() => applyOutput(job, output)), error => serial(async () => {
        if (signal?.aborted || lifetime.signal.aborted) return;
        expired = true;
        if (!outputWarnings.has(job.id)) {
          outputWarnings.add(job.id);
          report(error instanceof HerdrError && error.code === 'output-unavailable' ? new HerdrError(error.code, error.message, { jobId: job.id, machine: job.machine }) : error);
        }
        await settleUnavailableOutput(job, address);
        if (job.phase.kind === 'finished' && job.output && !job.evidenceConflict) { await deliver(job); await markSettled(job); }
      }));
    // A timed-out read still owns this job's collection slot. Do not queue a
    // second read behind it in the host collector; accept its eventual result.
    const done = read.then(async output => { await task; if (expired && !stopping && !closed) await serial(() => applyOutput(job, output)); }, () => task)
      .catch(report).finally(() => { if (collections.get(job.id)?.task === task) collections.delete(job.id); });
    collections.set(job.id, { task, firstIncomplete, readSettled: () => readDone, done });
  }
  async function settleUnavailableOutput(job: JournalJob, address: TerminalAddress): Promise<void> {
    if (job.phase.kind === 'finished') return;
    job.phase = { kind: 'disconnected', address, lastSeq: 0 };
    waiter(job.id).resolve({ exitCode: null, reason: 'unknown', signal: null, finishedAt: options.clock() });
    await persist();
  }
  async function applyOutput(job: JournalJob, output: JobOutput): Promise<void> {
    if (closed) return;
    const address = addressOf(job); if (!address) return;
    const receipt = output.receipt;
    if (job.phase.kind === 'finished' && !receipt) { await deliver(job); await markSettled(job); return; }
    job.output = { complete: output.complete, summary: job.handoffCancelled && job.phase.kind === 'finished' && job.phase.result.reason === 'cancelled' ? `Cancelled because caller crashed.\n${output.summary}` : output.summary };
    if (!receipt || receipt.jobId !== job.id || receipt.nonce !== job.nonce) {
      if (!receipt && !output.complete) { await persist(); return; }
      if (job.originalFinish) { job.phase = { kind: 'disconnected', address, lastSeq: 0 }; waiter(job.id).resolve({ exitCode: null, reason: 'unknown', signal: null, finishedAt: options.clock() }); }
      await persist(); return;
    }
    if (!job.originalFinish && !job.terminalExpired && !job.uncertain) { await persist(); return; }
    // Preparation failures have wrapper exit codes; no payload exit exists yet.
    const nativeExitCode = receipt.finish.reason === 'spawn-error' ? 127 : receipt.finish.reason === 'release-timeout' ? 124 : receipt.finish.exitCode;
    if (job.evidenceConflict || (job.originalFinish && !job.uncertain && hasExitData(job.originalFinish) && (job.originalFinish.exitCode !== nativeExitCode || job.originalFinish.signal !== receipt.finish.signal))) {
      job.phase = { kind: 'disconnected', address, lastSeq: 0 }; job.evidenceConflict = true;
      if (job.originalFinish) job.exitEvidence ??= { native: { ...job.originalFinish }, receipt: { ...receipt.finish } };
      await persist();
      waiter(job.id).resolve({ exitCode: null, reason: 'unknown', signal: null, finishedAt: options.clock(), evidenceConflict: true, ...(job.exitEvidence ? { exitEvidence: job.exitEvidence } : {}) }); return;
    }
    if (job.phase.kind !== 'finished') { job.phase = { kind: 'finished', address, result: receipt.finish }; job.updatedAt = options.clock(); }
    await persist(); waiter(job.id).resolve(receipt.finish); holdFinal(job); await deliver(job); await markSettled(job);
  }
  async function reconcileJob(job: JournalJob, signal?: AbortSignal): Promise<void> {
    if (job.phase.kind === 'launch-failed') { queueFailedCleanup(job); return; }
    const awaitingNativeFinish = job.handoffCancelled && !job.uncertain && !job.originalFinish && !job.terminalExpired;
    if (job.settledMarked || job.phase.kind === 'finished' && job.output?.complete && !awaitingNativeFinish) { await deliver(job); queueRelease(job); return; }
    let address = addressOf(job);
    if (!address && discovered.has(job.id)) { address = discovered.get(job.id)!; job.phase = { kind: 'disconnected', address, lastSeq: 0 }; await persist(); }
    if (address) {
      if (lostOriginals.has(address)) job.uncertain = true;
      let terminal = await waitForEvents(stream!.lookup(address), signal);
      job.terminalExpired = false;
      if (!terminal) {
        try { terminal = await waitForEvents(options.hc.get(address), signal, 'Remote job terminal is unavailable'); }
        catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'not_found') job.terminalExpired = true; else { report(error); } }
      }
      if (terminal && terminal.labels[HERDR_LABELS.job] === job.id && terminal.labels[HERDR_LABELS.session] === job.owner.sessionId) {
        if (terminal.state === 'finished' && !job.uncertain && (job.phase.kind !== 'finished' || job.handoffCancelled && job.phase.result.reason === 'cancelled') && !job.originalFinish) job.originalFinish = { exitCode: terminal.exitCode, reason: terminal.reason ?? 'unknown', signal: terminal.signal, finishedAt: terminal.finishedAt ?? options.clock() };
      }
    }
    if (options.adoptedRunId && !job.callerOwned && !job.detached && !job.handoffCancelled) {
      const original = liveOriginal(job);
      if (original) await signalOriginal(job, original, async () => { job.handoffCancelled = true; job.notice = 'observed'; job.noticeDelivered = true; await persist(); });
    }
    await collect(job, signal);
  }
  async function reconcileAll(signal?: AbortSignal): Promise<void> {
    if (!owner || closed || stopping) return;
    await waitForEvents(stream!.ready, signal);
    await reconcileJobRecovery(journal, { hc: options.hc, discovered, clock: options.clock, persist, reportError: report });
    const observed = new Set(await options.observedJobMessages(owner));
    for (const job of journal.jobs) {
      if (observed.has(job.id)) observeNotice(job);
      await reconcileJob(job, signal);
    }
    await persist();
    queueCompaction();
  }
  async function activate(nextOwner: Owner, signal?: AbortSignal): Promise<void> {
    if (closed) throw new HerdrError('disposed', 'Job monitor is closed');
    if (owner) { if (!sameOwner(nextOwner)) throw new HerdrError('job-owner-mismatch', 'Activation already belongs to another owner'); return; }
    owner = nextOwner; store = createJobStore(options.journalRoot, nextOwner.sessionId, options.child?.id ?? options.adoptedRunId);
    journal = await store.read();
    persistedState = !options.child && !options.adoptedRunId ? undefined : JSON.stringify({ ...journal, revision: 0, updatedAt: 0 });
    for (const job of journal.jobs) {
      if (job.evidenceConflict && job.exitEvidence && !hasExitData(job.exitEvidence.native)) {
        job.evidenceConflict = false; delete job.exitEvidence;
      }
    }
    const previousWriterStopped = await prepareJobRecovery(journal, Boolean(options.adoptedRunId), options.callerCrashed);
    const noticeCandidates = noticeRecoveryCandidates(journal, nextOwner, previousWriterStopped);
    for (const job of noticeCandidates) recoveringNotices.add(job.id);
    if (noticeCandidates.length) enqueueCleanup(`${nextOwner.sessionId}/notices`, async () => {
      const apply = await (noticeRecoveryRead ??= recoverJobNotices(noticeCandidates, nextOwner, lifetime.signal).catch(error => { noticeRecoveryRead = undefined; throw error; }));
      await serial(async () => {
        if (stopping || closed) return;
        if (!noticesApplied) { noticesApplied = true; apply(); recoveringNotices.clear(); }
        await persist();
        for (const job of noticeCandidates) { await deliver(job); queueRelease(job); }
      });
    });
    await persist();
    if (options.child) journal.child = { ...options.child, ended: false };
    if (!options.child && !options.adoptedRunId) handoff = createJobHandoff({ root: options.journalRoot, owner: nextOwner, hc: options.hc, closeAgentConsoles: options.closeAgentConsoles, reportError: report,
      releaseSettled: async childJournal => {
        const childStore = createJobStore(options.journalRoot, nextOwner.sessionId, childJournal.child!.id);
        for (const job of childJournal.jobs) {
          if (job.phase.kind !== 'finished' || !job.output?.complete) continue;
          // A settled child cannot consume another notice or write its journal again.
          job.notice = 'observed'; job.noticeDelivered = true;
          queueRelease(job, () => serial(async () => {
            const latest = await childStore.read(), target = latest.jobs.find(value => value.id === job.id);
            if (!target) return;
            target.notice = 'observed'; target.noticeDelivered = true; target.settledMarked = job.settledMarked; target.terminalReleased = job.terminalReleased; target.cleanupFailure = job.cleanupFailure; target.updatedAt = job.updatedAt;
            latest.revision++; await childStore.write(latest);
          }));
        }
        await cleanup.flush(childJournal.jobs.map(releaseKey));
      },
      adopt: async (runId, signal, callerCrashed) => { const monitor = createJobMonitor({ ...options, adoptedRunId: runId, callerCrashed }, cleanup); try { await monitor.activate(nextOwner, signal); return monitor; } catch (error) { await monitor.shutdown('reload'); throw error; } },
    });
    const identity = await options.hc.identity();
    if (identity.coreId !== nextOwner.terminal.coreId || identity.socket !== nextOwner.terminal.socket || identity.sessionNamespace !== nextOwner.terminal.sessionNamespace) throw new HerdrError('job-owner-mismatch', 'Owning terminal is on another core');
    stream = options.hc.events();
    unsubscribe = stream.subscribe(event => {
      // Capture identity immediately; a created/finished pair can arrive while run() is still awaiting its reply.
      const terminals = event.type === 'snapshot' || event.type === 'missed' ? event.terminals : event.type === 'created' ? [event.data] : [];
      for (const terminal of terminals) {
        const job = journal.jobs.find(j => terminal.labels[HERDR_LABELS.job] === j.id && terminal.labels[HERDR_LABELS.session] === j.owner.sessionId && terminal.labels[HERDR_LABELS.ownerCore] === j.owner.terminal.coreId && terminal.labels[HERDR_LABELS.ownerTerminal] === j.owner.terminal.terminalId && terminal.labels[HERDR_LABELS.kind] === j.kind);
        if (job) discovered.set(job.id, terminal.address);
      }
      if ('terminal' in event && (event.type === 'finished' || event.type === 'lost' || event.type === 'restarted')) {
        const original = journal.jobs.find(j => addressOf(j) === event.terminal || discovered.get(j.id) === event.terminal);
        if (original) { if (event.type === 'finished') finishedOriginals.add(event.terminal); else lostOriginals.add(event.terminal); }
      }
      void serial(async () => {
        if (closed) return;
        if (event.type === 'created') {
          const job = journal.jobs.find(j => event.data.labels[HERDR_LABELS.job] === j.id && event.data.labels[HERDR_LABELS.session] === j.owner.sessionId && event.data.labels[HERDR_LABELS.kind] !== HERDR_KINDS.remoteObserver);
          if (job && job.phase.kind === 'preparing') { job.phase = { kind: 'waiting-for-pane', address: event.terminal }; await persist(); }
        } else if (event.type === 'finished' || event.type === 'lost' || event.type === 'restarted' || event.type === 'removed') {
          const job = journal.jobs.find(j => addressOf(j) === event.terminal);
          if (job) {
            if (event.type === 'finished' && !job.uncertain && job.phase.kind !== 'finished') job.originalFinish = event.data;
            else if (event.type === 'lost' || event.type === 'restarted') { job.uncertain = true; if (job.phase.kind !== 'finished') job.phase = { kind: 'disconnected', address: event.terminal, lastSeq: event.seq }; }
            await collect(job);
          }
        } else if (event.type === 'snapshot' || event.type === 'missed') await reconcileAll();
      }).catch(report);
    });
    await waitForEvents(stream.ready, signal);
    if (options.adoptedRunId) for (const job of journal.jobs) { if (job.callerOwned) job.detached = true; if (job.notice === 'submitted') { job.notice = 'observed'; job.noticeDelivered = true; } }
    // A resumed activation has no surviving tool waiters. Tool-consumed results were already marked observed.
    for (const job of journal.jobs) if (job.noticeMode === 'tool' && job.notice !== 'observed') job.noticeMode = 'async';
    await reconcileAll(signal);
    if (!options.adoptedRunId) { timer = setInterval(() => { void reconcile().catch(report); }, 2000); timer.unref(); }
  }
  let maintenance: ReturnType<typeof setTimeout> | undefined;
  function scheduleMaintenance(): void {
    if (!activated || sharedCleanup || stopping || closed || maintenance || !handoff && journal.jobs.length === 0) return;
    maintenance = setTimeout(() => { maintenance = undefined; if (stopping || closed) return; cleanup.start(); void handoff?.reconcile().catch(report); }, 0);
    maintenance.unref();
  }
  async function drainCollections(): Promise<void> { await Promise.all([...collections.values()].map(({ task, firstIncomplete }) => Promise.race([task, firstIncomplete]))); }
  function reconcile(): Promise<void> {
    return reconciliation ??= (async () => { await serial(() => reconcileAll()); await drainCollections(); scheduleMaintenance(); })()
      .finally(() => { reconciliation = undefined; });
  }
  function shutdown(reason: 'reload' | 'quit'): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    stopping = true; lifetime.abort(); if (maintenance) clearTimeout(maintenance);
    if (sharedCleanup) for (const key of cleanupKeys) cleanup.cancel(key);
    cleanupKeys.clear();
    const handoffShutdown = handoff?.shutdown(reason);
    if (timer) clearInterval(timer); for (const hold of holds.values()) clearTimeout(hold); holds.clear(); unsubscribe?.();
    return shutdownPromise = (async () => {
      // Abort event waits before draining the writer, rather than queue shutdown
      // behind a reconcile waiting for a core that nobody is allowed to start.
      if (!sharedCleanup) await cleanup.dispose();
      await queue;
      await drainCollections().catch(report);
      await queue;
      if (closed) return;
      const attempt = async (operation: () => unknown | Promise<unknown>) => {
        try { await operation(); }
        catch (error) { if (!(error instanceof HerdrError && ['core-unavailable', 'disposed'].includes(error.code))) report(error); }
      };
      try {
        if (reason !== 'reload') for (const job of journal?.jobs ?? []) {
          const address = liveOriginal(job);
          if (address && !job.detached && !(options.child && job.callerOwned) && !job.handoffCancelled) await attempt(() => signalOriginal(job, address));
        }
        for (const job of journal?.jobs ?? []) await attempt(() => release(job));
        await attempt(() => handoffShutdown);
        if (journal?.child && options.child && reason !== 'reload') journal.child.ended = true;
        if (journal?.writer && !options.adoptedRunId) journal.writer.shutdown = reason;
        if (owner) await attempt(persist);
      } finally { closed = true; await attempt(() => stream?.dispose()); }
    })();
  }
  return {
    activate: async (nextOwner, signal) => { await serial(() => activate(nextOwner, signal)); await drainCollections(); activated = true; scheduleMaintenance(); },
    reconcile,
    consoleIdle: (nextOwner, on, runId) => serial(async () => {
      if (!activated || stopping || closed || !sameOwner(nextOwner) || (options.child?.id ?? options.adoptedRunId) !== runId) return false;
      return !journal.jobs.some(job => job.machine === on && (job.uncertain || job.evidenceConflict ||
        job.phase.kind !== 'finished' && job.phase.kind !== 'launch-failed' || job.phase.kind === 'finished' && job.phase.result.reason === 'unknown'));
    }),
    consoleError: options.reportConsoleError ?? report,
    finishCleanup: async () => {
      for (const job of journal.jobs) { const hold = holds.get(job.id); if (hold) clearTimeout(hold); holds.delete(job.id); queueRelease(job); }
      await cleanup.flush(journal.jobs.flatMap(job => [releaseKey(job), failedCleanupKey(job), failedTerminalKey(job)]));
    },
    start: async (prepareProgram, nextOwner, on, startOptions) => {
      let requestedAt = options.clock();
      let queueWaitMs = 0, previousDirectory: string | undefined, previousAttempt: JournalJob | undefined;
      const attempts: JobId[] = [];
      const queued = <T>(operation: () => Promise<T>): Promise<T> => {
        const queuedAt = options.clock();
        return serial(() => { queueWaitMs += Math.max(0, options.clock() - queuedAt); return operation(); });
      };
      try {
      for (let attempt = 0; ; attempt++) {
        if (attempt > 0) { requestedAt = options.clock(); queueWaitMs = 0; }
        let retrySafe = false;
        try {
          if (!owner) { await queued(() => activate(nextOwner, startOptions.signal)); activated = true; scheduleMaintenance(); }
          const { job, program } = await queued(async () => {
            if (closed || stopping) throw new HerdrError('disposed', 'Job monitor is stopping');
            if (!sameOwner(nextOwner)) throw new HerdrError('job-owner-mismatch', 'Cannot launch for a foreign owner');
            if (startOptions.signal?.aborted) throw new HerdrError('aborted', 'Job launch aborted');
            await waitForEvents(stream!.ready, startOptions.signal);
            const program = await prepareProgram();
            if (startOptions.signal?.aborted) throw new HerdrError('aborted', 'Job launch aborted');
            if (program.directory === previousDirectory) throw new HerdrError('program-directory-reused', 'A retry needs a fresh program directory');
            previousDirectory = program.directory;
            const id = randomUUID() as JobId;
            const localDirectory = join(store.directory, 'logs', id);
            const job: JournalJob = { version: 1, id, ...(options.child ? { runId: options.child.id } : {}), owner: nextOwner, machine: on, commandPreview: program.commandPreview, kind: startOptions.kind ?? 'exec', phase: { kind: 'preparing' }, viewer: null, remoteDirectory: program.directory, localDirectory, detached: false, noticeMode: 'tool', notice: 'pending', nonce: '', releaseDeadlineAt: 0, originalFinish: null, output: null, callerOwned: startOptions.background === true, uncertain: false, evidenceConflict: false, noticeDelivered: false, settledMarked: false, terminalExpired: false, updatedAt: options.clock() };
            if (previousAttempt?.phase.kind === 'launch-failed') previousAttempt.supersededBy = id;
            unreturned.add(id); attempts.push(id); journal.jobs.push(job); await persist(); await ensurePrivateDirectory(localDirectory); return { job, program };
          });
          const id = job.id, localDirectory = job.localDirectory;
          return await queued(async () => {
            let released = false, runIssued = false;
            const handle = (address: TerminalAddress): JobHandle => {
              const cancel: JobHandle['cancel'] = () => serial(async () => { if (job.uncertain || lostOriginals.has(address)) throw new HerdrError('job-outcome-unknown', 'Original incarnation is no longer known; not signaling a recovery shell'); const original = liveOriginal(job); if (original) await signalOriginal(job, original).catch(error => { if (!terminalMissing(error)) throw error; }); await reconcileJob(job); });
              return { id, address, localDirectory, remoteDirectory: job.remoteDirectory, finished: waiter(id).promise, cancel };
            };
            try {
              if (closed || stopping) throw new HerdrError('disposed', 'Job monitor is stopping');
              if (startOptions.signal?.aborted) throw new HerdrError('aborted', 'Job launch aborted');
              const launch = await options.outputCollector.prepare(program, job);
              job.remoteDirectory = launch.program.directory; job.nonce = launch.nonce; await persist();
              let address: TerminalAddress;
              try {
                job.releaseDeadlineAt = options.clock() + 10000;
                runIssued = true;
                const terminal = await options.hc.run({ argv: launch.program.argv, cwd: launch.program.cwd, on, parent: null, labels: { [HERDR_LABELS.session]: nextOwner.sessionId, [HERDR_LABELS.ownerCore]: nextOwner.terminal.coreId, [HERDR_LABELS.ownerTerminal]: nextOwner.terminal.terminalId, [HERDR_LABELS.kind]: job.kind, [HERDR_LABELS.job]: id, [HERDR_LABELS.machine]: on, ...(options.child ? { [HERDR_LABELS.run]: options.child.id } : {}) }, outliveParent: true, background: true, noNotify: true });
                address = terminal.address;
              } catch (error) {
                // Reconcile the preassigned identity, never rerun the payload after an uncertain reply.
                await waitForEvents(stream!.ready, startOptions.signal);
                // A created event can precede its reply; it is handled after this serialized operation.
                // Query the original core snapshot for the labelled identity.
                const matching = discovered.get(id);
                if (matching) address = matching;
                else throw new HerdrError('launch-uncertain', 'Launch reply was lost; reconciliation will recover the preassigned job ID', { jobId: id, cause: String(error) });
              }
              job.phase = { kind: 'waiting-for-pane', address }; await persist();
              await releaseRemoteJob(job, { hc: options.hc, signal: startOptions.signal, nonce: job.nonce, releaseDeadlineAt: job.releaseDeadlineAt, requestedAt, queueWaitMs, clock: options.clock,
                releaseFileWriter: (record, bytes) => options.hc.fileWrite(record.machine, join(record.remoteDirectory, 'release.json'), bytes) });
              released = true;
              job.phase = { kind: 'running', address, releasedAt: options.clock() }; await persist();
              await reconcileJob(job, startOptions.signal);
              return handle(address);
            } catch (error) {
              const address = addressOf(job);
              if (address && lostOriginals.has(address)) { job.uncertain = true; job.phase = { kind: 'disconnected', address, lastSeq: 0 }; }
              const failure = error instanceof PayloadReleaseError ? error : null;
              if (address && (released || failure?.releaseWriteStarted)) {
                if (job.phase.kind !== 'finished') job.phase = { kind: 'disconnected', address, lastSeq: 0 };
                job.detached = true; job.noticeMode = 'async'; job.updatedAt = options.clock();
                try { await persist(); }
                catch (cause) { throw new HerdrError('launch-uncertain', `Release may have reached ${address}; job ${id} may be running`, { jobId: id, address, cause: String(cause) }); }
                waiter(id).resolve({ exitCode: null, reason: 'release-uncertain', signal: null, finishedAt: options.clock() });
                await collect(job);
                return handle(address);
              }
              const last = failure?.releaseFailure.confirmation?.last;
              let identityMismatch = last?.kind === 'address' || last?.kind === 'labels', removed = false;
              if (address && identityMismatch) { job.uncertain = true; job.phase = { kind: 'disconnected', address, lastSeq: 0 }; }
              const retryCandidate = failure !== null && failure.code !== 'aborted' && !failure.releaseWriteStarted;
              if (!runIssued) {
                job.terminalReleased = true;
                try { await markFailedProgram(job); job.settledMarked = true; }
                catch (cleanupError) { options.recordCleanupError?.(cleanupError); }
              }
              if (address && !job.uncertain && !(error instanceof HerdrError && error.code === 'launch-uncertain')) {
                try {
                  await signalOriginal(job, address, undefined, 1000);
                  await verifiedTerminal(job, address);
                  if (lostOriginals.has(address)) throw new HerdrError('job-outcome-unknown', 'Original terminal was replaced');
                  await boundedHc(callOptions => options.hc.rm(address, callOptions));
                  try {
                    const remaining = await boundedHc(callOptions => options.hc.get(address, callOptions));
                    if (observeJobIdentity(job, address, remaining).kind !== 'matched') throw new HerdrError('job-outcome-unknown', 'Original terminal was replaced');
                  } catch (absence) { if (terminalMissing(absence)) removed = true; else throw absence; }
                } catch (cleanupError) {
                  if (terminalMissing(cleanupError)) removed = true;
                  else if (cleanupError instanceof HerdrError && cleanupError.code === 'job-outcome-unknown') {
                    identityMismatch = true; job.uncertain = true; job.phase = { kind: 'disconnected', address, lastSeq: 0 };
                  } else options.recordCleanupError?.(cleanupError);
                }
                if (removed) {
                  try { await confirmMissing(address, true, job.machine); }
                  catch (cleanupError) { removed = false; options.recordCleanupError?.(cleanupError); }
                }
                if (removed) {
                  job.terminalReleased = true; retrySafe = retryCandidate;
                  try { await markFailedProgram(job); job.settledMarked = true; }
                  catch (cleanupError) { options.recordCleanupError?.(cleanupError); }
                }
              }
              if (failure) {
                if (identityMismatch) failure.message += ' The payload did not start. Not retried automatically because terminal identity did not match.';
                else if (failure.code === 'aborted' || startOptions.signal?.aborted) failure.message += ' The payload did not start. Not retried automatically because launch was cancelled.';
                else if (!retrySafe) failure.message += ' The payload did not start. Not retried automatically because terminal removal was not confirmed.';
                else if (attempt > 0) failure.message += ' The payload did not start; the automatic retry also failed.';
              }
              if (job.uncertain) { observeNotice(job); unreturned.delete(id); }
              if (!job.uncertain && !(error instanceof HerdrError && error.code === 'launch-uncertain')) {
                job.phase = compactFailedPhase({ kind: 'launch-failed', error: String(error), ...(failure ? { releaseFailure: failure.releaseFailure } : {}) });
                if (address && !job.terminalReleased) job.failedTerminalCleanup = { address, attempts: 0, nextAt: options.clock() };
              }
              if (retrySafe && attempt === 0) previousAttempt = job;
              await persist(); queueFailedCleanup(job); throw error;
            }
          });
        } catch (error) {
          if (retrySafe && attempt === 0 && !startOptions.signal?.aborted) continue;
          throw error;
        }
      }
      } finally {
        if (attempts.length) setImmediate(() => { void serial(async () => {
          if (stopping || closed) return;
          let changed = false;
          for (const id of attempts) {
            const job = journal.jobs.find(value => value.id === id);
            if (job?.phase.kind === 'launch-failed' && unreturned.delete(id)) { job.updatedAt = options.clock(); changed = true; }
          }
          if (changed) await persist();
        }).catch(report); });
      }
    },
    detach: async id => { await serial(async () => { const job = tracked(id); job.detached = true; job.noticeMode = 'async'; await persist(); await collect(job); }); const collection = collections.get(id); if (collection?.readSettled()) { await collection.task; await collection.done; } },
    toolReturned: (id: JobId) => serial(async () => {
      const job = journal.jobs.find(value => value.id === id); if (!job) return;
      if (unreturned.delete(id)) { job.updatedAt = options.clock(); await persist(); }
      if (job.detached) await release(job);
    }),
    consumeNotice: id => serial(async () => {
      const job = journal.jobs.find(value => value.id === id); if (!job) return;
      observeNotice(job); await persist(); await markSettled(job);
    }),
    shutdown,
    dispose: () => shutdown('quit'),
  };
}
