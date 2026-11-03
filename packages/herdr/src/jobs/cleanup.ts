// SPDX-License-Identifier: MIT
export interface CleanupSweep {
  enqueue(key: string, operation: () => Promise<void>): void;
  cancel(key: string): void;
  start(): void;
  flush(keys: readonly string[]): Promise<void>;
  dispose(): Promise<void>;
}
/** Cleanup never owns the monitor's foreground queue while waiting on a core. */
export function createCleanupSweep(clock: () => number, report: (error: unknown) => void): CleanupSweep {
  const pending = new Map<string, { operation: () => Promise<void>; failures: number; nextAt: number; reported: boolean; running: boolean }>();
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
        entry.failures++; entry.nextAt = clock() + Math.min(3600000, 30000 * 2 ** Math.min(entry.failures - 1, 7));
        if (!closed && !entry.reported) { entry.reported = true; report(error); }
      }).finally(() => { entry.running = false; active.delete(task); if (running.get(key) === task) running.delete(key); schedule(); });
      active.add(task); running.set(key, task);
    }
    schedule();
  }
  return {
    enqueue(key, operation) { if (closed) return; if (!pending.has(key)) pending.set(key, { operation, failures: 0, nextAt: 0, reported: false, running: false }); schedule(); },
    cancel(key) { pending.delete(key); schedule(); },
    start() { started = true; schedule(); },
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
