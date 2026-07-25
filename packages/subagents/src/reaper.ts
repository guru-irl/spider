import type { Db } from "@spider/db-core";
import { RunStore, type RunRow } from "./run-store";
import { isProcessAlive, killProcessGroup } from "./kill-process";

export interface ReapDeps {
  db: Db;
  store?: RunStore;
  alive?: (pid: number) => boolean;
  kill?: (pid: number) => Promise<unknown>;
  selfPid?: number;
}

/**
 * Reconcile runs abandoned by a host that died without firing session_shutdown
 * (uncaughtCrash, emergencyTerminalExit, SIGKILL). A run is an ORPHAN only when
 * its owning host_pid is gone — a live host_pid means a concurrently running
 * session still owns that child, and touching it would kill another session's
 * work.
 */
export async function reapOrphanRuns(deps: ReapDeps): Promise<{ reaped: string[] }> {
  const store = deps.store ?? new RunStore(deps.db);
  const alive = deps.alive ?? isProcessAlive;
  const kill = deps.kill ?? ((pid: number) => killProcessGroup(pid));
  const selfPid = deps.selfPid ?? process.pid;
  const reaped: string[] = [];

  let rows: RunRow[];
  try {
    rows = deps.db
      .prepare(`SELECT * FROM runs WHERE status IN ('queued','running','paused') AND host_pid IS NOT NULL`)
      .all() as RunRow[];
  } catch {
    return { reaped }; // pre-v4 DB or read failure — never block session start
  }

  for (const row of rows) {
    const hostPid = row.host_pid;
    if (hostPid === null || hostPid === selfPid) continue; // ours, or unknown owner
    if (alive(hostPid)) continue;                          // another live session owns it

    if (row.pid !== null && alive(row.pid)) {
      try { await kill(row.pid); } catch { /* best-effort */ }
    }
    try {
      store.cancel(row.id, "cancelled — orphaned by a host that exited without shutdown");
      reaped.push(row.id);
    } catch { /* best-effort */ }
  }
  return { reaped };
}
