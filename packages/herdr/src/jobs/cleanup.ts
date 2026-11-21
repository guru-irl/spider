// SPDX-License-Identifier: MIT
import type { JournalJob } from './store.js';
import { HerdrError } from '../client/parse.js';
import { isHerdrConnectivityFailure } from '../client/availability.js';

export function isCleanupConnectivityFailure(error: unknown): boolean {
  if (isHerdrConnectivityFailure(error)) return true;
  if (!(error instanceof HerdrError)) return false;
  if (error.code === 'core-unavailable' || error.code === 'cleanup-timeout') return true;
  return error.code === 'machine-unavailable' && (error.details as { reason?: unknown } | undefined)?.reason === 'disconnected';
}

export const MAX_FAILED_TERMINAL_CLEANUP_ATTEMPTS = 3;
export const MAX_CLEANUP_CONNECTIVITY_FAILURES = 8;
export function cleanupConnectivityDelay(failures: number): number {
  return Math.min(3_600_000, 30_000 * 2 ** (failures - 1));
}
export function needsFailedCleanup(job: JournalJob): boolean {
  return job.phase.kind === 'launch-failed' && !job.settledMarked && !job.uncertain && !job.evidenceConflict && !job.handoffCancelled
    && (Boolean(job.terminalReleased) || Boolean(job.failedTerminalCleanup && !job.failedTerminalCleanup.exhausted));
}

export interface CleanupSweep {
  enqueue(key: string, operation: () => Promise<void>, options?: { afterFailure?: boolean }): boolean;
  cancel(key: string): void;
  start(): void;
  retry(keys: readonly string[]): void;
  flush(keys: readonly string[]): Promise<void>;
  dispose(): Promise<void>;
}
/** Cleanup never owns the monitor's foreground queue while waiting on a core. */
export function createCleanupSweep(clock: () => number, report: (error: unknown) => void): CleanupSweep {
  const pending = new Map<string, { operation: () => Promise<void>; failures: number; nextAt: number; reported: boolean; running: boolean; wakeOnFailure: boolean }>();
  const active = new Set<Promise<void>>();
  const running = new Map<string, Promise<void>>();
  let started = false, closed = false, timer: ReturnType<typeof setTimeout> | undefined;
  function schedule(): void {
    if (!started || closed) return;
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (active.size >= 4) return;
    let nextAt = Infinity;
    for (const entry of pending.values()) if (!entry.running) nextAt = Math.min(nextAt, entry.nextAt);
    if (!Number.isFinite(nextAt)) return;
    timer = setTimeout(() => { timer = undefined; pump(); }, Math.max(0, nextAt - clock()));
    timer.unref();
  }
  function pump(): void {
    for (const [key, entry] of pending) {
      if (closed || active.size >= 4) break;
      if (entry.running || entry.nextAt > clock()) continue;
      entry.running = true;
      const task = entry.operation().then(() => { if (pending.get(key) === entry) pending.delete(key); }, error => {
        if (pending.get(key) !== entry) return;
        entry.failures++;
        entry.nextAt = entry.wakeOnFailure ? clock() : clock() + Math.min(3600000, 30000 * 2 ** Math.min(entry.failures - 1, 7));
        entry.wakeOnFailure = false;
        if (!closed && !entry.reported) { entry.reported = true; report(error); }
      }).finally(() => { entry.running = false; active.delete(task); if (running.get(key) === task) running.delete(key); schedule(); });
      active.add(task); running.set(key, task);
    }
    schedule();
  }
  return {
    enqueue(key, operation, options) {
      if (closed || pending.has(key)) return false;
      const failed = options?.afterFailure === true;
      pending.set(key, { operation, failures: failed ? 1 : 0, nextAt: failed ? clock() + 30000 : 0, reported: failed, running: false, wakeOnFailure: false });
      schedule(); return true;
    },
    cancel(key) { pending.delete(key); schedule(); },
    start() { started = true; schedule(); },
    retry(keys) {
      for (const key of keys) {
        const entry = pending.get(key); if (!entry) continue;
        if (entry.running) entry.wakeOnFailure = true; else entry.nextAt = clock();
      }
      schedule();
    },
    async flush(keys) {
      const remaining = new Set(keys);
      while (!closed && remaining.size) {
        pump();
        const tasks: Promise<void>[] = [];
        for (const key of remaining) {
          const task = running.get(key), entry = pending.get(key);
          if (task) { tasks.push(task); remaining.delete(key); }
          else if (!entry || entry.failures > 0) remaining.delete(key);
        }
        if (tasks.length) await Promise.all(tasks);
        else if (active.size) await Promise.race(active);
        else break;
      }
    },
    async dispose() { closed = true; if (timer) clearTimeout(timer); await Promise.all(active); pending.clear(); },
  };
}
