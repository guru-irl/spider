import type { Db } from "@spider/db-core";
import { RunStore, type RunRow } from "./run-store";
import { isProcessAlive, killProcessGroup } from "./kill-process";
import { checkProcessIdentity } from "./process-identity";

export interface ReapDeps {
  db: Db;
  globalDb?: Db;
  store?: RunStore;
  alive?: (pid: number) => boolean;
  kill?: (pid: number) => Promise<unknown>;
  selfPid?: number;
  probeCommand?: (pid: number) => string | null;
  probeStartTime?: (pid: number) => string | null;
}

/**
 * Reconcile runs abandoned by a host that died without firing session_shutdown
 * (uncaughtCrash, emergencyTerminalExit, SIGKILL). A run is an ORPHAN only when
 * its owning host_pid is gone — a live host_pid means a concurrently running
 * session still owns that child, and touching it would kill another session's
 * work.
 */
export async function reapOrphanRuns(deps: ReapDeps): Promise<{ reaped: string[]; error?: string }> {
  const store = deps.store ?? new RunStore(deps.db, deps.globalDb);
  const alive = deps.alive ?? isProcessAlive;
  const identity = (row: RunRow) => checkProcessIdentity(row.pid!, row.pid_start_time, { start: deps.probeStartTime, command: deps.probeCommand });
  const selfPid = deps.selfPid ?? process.pid;
  const reaped: string[] = [];

  let rows: RunRow[];
  try {
    rows = deps.db
      .prepare(`SELECT * FROM runs WHERE status IN ('queued','running','paused') AND host_pid IS NOT NULL`)
      .all() as RunRow[];
  } catch (err) {
    return { reaped, error: String((err as Error)?.message ?? err) };
  }

  // Child identity is pid plus spawn start time. Legacy rows use the old command
  // signature and fail closed when title replacement hides it.
  const work = rows.map(async (row) => {
    const hostPid = row.host_pid;
    if (hostPid === null || hostPid === selfPid) return null; // ours, or unknown owner
    if (alive(hostPid)) return null;                          // another live session owns it

    let reason = "Child process is missing; no signal sent.";
    if (row.pid !== null && alive(row.pid)) {
      const checked = identity(row);
      reason = checked.reason;
      if (checked.matches) {
        try {
          if (deps.kill) await deps.kill(row.pid);
          else await killProcessGroup(row.pid, { canSignal: () => identity(row).matches });
          reason = "Matching child was terminated.";
        } catch (error) { reason = `Termination failed: ${String(error)}`; }
      }
    }
    try {
      // cancel() emits the terminal status event and returns false if a natural
      // completion won the race, so neither the event nor this result is fabricated.
      if (store.cancel(row.id, `Run orphaned by a host that exited without shutdown. ${reason}`)) return row.id;
    } catch { /* best-effort */ }
    return null;
  });

  // Parallelize per-orphan work; keep ordering deterministic
  const results = await Promise.all(work);
  reaped.push(...results.filter((id): id is string => id !== null));

  return { reaped };
}
