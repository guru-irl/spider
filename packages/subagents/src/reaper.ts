import type { Db } from "@spider/db-core";
import { RunStore, type RunRow } from "./run-store";
import { isProcessAlive, killProcessGroup } from "./kill-process";
import { looksLikeSubagent } from "./process-identity";

export interface ReapDeps {
  db: Db;
  store?: RunStore;
  alive?: (pid: number) => boolean;
  kill?: (pid: number) => Promise<unknown>;
  selfPid?: number;
  probeCommand?: (pid: number) => string | null;
}

/**
 * Reconcile runs abandoned by a host that died without firing session_shutdown
 * (uncaughtCrash, emergencyTerminalExit, SIGKILL). A run is an ORPHAN only when
 * its owning host_pid is gone — a live host_pid means a concurrently running
 * session still owns that child, and touching it would kill another session's
 * work.
 */
export async function reapOrphanRuns(deps: ReapDeps): Promise<{ reaped: string[]; error?: string }> {
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
  } catch (err) {
    return { reaped, error: String((err as Error)?.message ?? err) };
  }

  // Document pid-reuse limitation. isProcessAlive answers "some process has this pid",
  // not "the original host/child". No start-time/generation counter disambiguates today.
  // Signalling a reused row.pid would SIGTERM/SIGKILL an unrelated process group, so we
  // confirm the command line still looks like a spawned subagent before kill(). If the
  // probe returns null (win32, ps unavailable, EPERM), we reconcile the row but do NOT
  // signal — reaping the row is safe; signalling an unidentified pid is not.
  const work = rows.map(async (row) => {
    const hostPid = row.host_pid;
    if (hostPid === null || hostPid === selfPid) return null; // ours, or unknown owner
    if (alive(hostPid)) return null;                          // another live session owns it

    if (row.pid !== null && alive(row.pid)) {
      // Before signalling, confirm the pid still looks like our spawned subagent.
      // Fail-safe: if probe returns null (unknown), reconcile the row but do NOT signal.
      const identityConfirmed = deps.probeCommand
        ? looksLikeSubagent(row.pid, deps.probeCommand)
        : looksLikeSubagent(row.pid);
      if (identityConfirmed) {
        try { await kill(row.pid); } catch { /* best-effort */ }
      }
    }
    try {
      store.cancel(row.id, "cancelled — orphaned by a host that exited without shutdown");
      // Only report reaped if the cancel actually changed the row
      const updated = store.get(row.id);
      if (updated?.status === "cancelled") return row.id;
    } catch { /* best-effort */ }
    return null;
  });

  // Parallelize per-orphan work; keep ordering deterministic
  const results = await Promise.all(work);
  reaped.push(...results.filter((id): id is string => id !== null));

  return { reaped };
}
