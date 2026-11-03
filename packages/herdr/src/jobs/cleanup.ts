// SPDX-License-Identifier: MIT
export interface CleanupSweep {
  enqueue(key: string, operation: () => Promise<void>): void;
  cancel(key: string): void;
  start(): void;
  dispose(): Promise<void>;
}
/** Cleanup never owns the monitor's foreground queue while waiting on a core. */
export function createCleanupSweep(clock: () => number, report: (error: unknown) => void): CleanupSweep {
  const pending = new Map<string, { operation: () => Promise<void>; failures: number; nextAt: number; reported: boolean; running: boolean }>();
  const active = new Set<Promise<void>>();
  let started = false, closed = false, timer: ReturnType<typeof setTimeout> | undefined;
  function schedule(): void {
    if (!started || closed || timer) return;
    timer = setTimeout(() => { timer = undefined; pump(); }, 0);
    timer.unref();
  }
  function pump(): void {
    for (const [key, entry] of pending) {
      if (closed || active.size >= 4) break;
      if (entry.running || entry.nextAt > clock()) continue;
      entry.running = true;
      const task = entry.operation().then(() => { pending.delete(key); }, error => {
        entry.failures++; entry.nextAt = clock() + Math.min(3600000, 30000 * 2 ** Math.min(entry.failures - 1, 7));
        if (!closed && !entry.reported) { entry.reported = true; report(error); }
      }).finally(() => { entry.running = false; active.delete(task); schedule(); });
      active.add(task);
    }
  }
  return {
    enqueue(key, operation) { if (closed) return; if (!pending.has(key)) pending.set(key, { operation, failures: 0, nextAt: 0, reported: false, running: false }); schedule(); },
    cancel(key) { pending.delete(key); },
    start() { started = true; schedule(); },
    async dispose() { closed = true; if (timer) clearTimeout(timer); await Promise.all(active); pending.clear(); },
  };
}
