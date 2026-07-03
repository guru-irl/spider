import { bus } from "@spider/db-core";
import type { Db, RunEvent } from "@spider/db-core";
import { RunStore, type RunRow } from "./run-store";

const TERMINAL = new Set(["done", "failed", "cancelled"]);
export interface WaitResult { finished: RunRow[]; stillActive: RunRow[]; timedOut: boolean; }

/**
 * Wait for subagent runs, event-driven over the shared `runs` table + `bus`.
 *  - `id`  → wait for that one run (id or unique prefix).
 *  - `all` → wait until ALL currently-active runs finish.
 *  - default (no id, all falsey) → resolve as soon as the FIRST active run finishes.
 * Already-terminal targets resolve immediately. `timeoutMs` default 30min.
 */
export function waitForRuns(deps: { db: Db; store: RunStore; sessionId: string }, opts: { id?: string; all?: boolean; timeoutMs?: number }): Promise<WaitResult> {
  const { store, sessionId } = deps;
  const targetIds = opts.id
    ? store.listForSession(sessionId).filter((r) => r.id === opts.id || r.id.startsWith(opts.id!)).map((r) => r.id)
    : store.listActive(sessionId).map((r) => r.id);

  const done = (): RunRow[] => targetIds.map((id) => store.get(id)!).filter((r) => r && TERMINAL.has(r.status));
  const wantAll = opts.all || !!opts.id;
  const satisfied = () => (wantAll ? done().length === targetIds.length : done().length >= 1);

  if (targetIds.length === 0 || satisfied()) {
    return Promise.resolve({ finished: done(), stillActive: store.listActive(sessionId), timedOut: false });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (timedOut: boolean) => {
      if (settled) return;
      settled = true;
      off();
      clearTimeout(timer);
      resolve({ finished: done(), stillActive: store.listActive(sessionId), timedOut });
    };
    const off = bus.on((e: RunEvent) => {
      if (e.type !== "status" || !e.runId || !targetIds.includes(e.runId)) return;
      if (satisfied()) finish(false);
    });
    const timer = setTimeout(() => finish(true), opts.timeoutMs ?? 1_800_000);
    if (typeof (timer as any).unref === "function") (timer as any).unref();
    if (satisfied()) finish(false);
  });
}
