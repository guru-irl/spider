import type { Db } from "@spider/db-core";
import { localRunPredicate } from "@spider/db-core/roam/run-origin";
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
  const identity = (row: RunRow) => checkProcessIdentity(row.pid!, row.pid_start_time, { start: deps.probeStartTime, command: deps.probeCommand, runId: row.id });
  const selfPid = deps.selfPid ?? process.pid;
  const reaped: string[] = [];

  let rows: RunRow[];
  try {
    rows = deps.db
      .prepare(`SELECT r.* FROM runs r WHERE status IN ('queued','running','paused') AND host_pid IS NOT NULL AND ${localRunPredicate(deps.db)}`)
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

/** Unlike started_at, the end of a terminal run bounds when its child must already have started. */
export function birthlessTerminalEnd(row: Readonly<RunRow>): number | null {
  if (typeof row.pid_start_time === "string" && row.pid_start_time.trim()) return null;
  if (row.status !== "done" && row.status !== "failed" && row.status !== "cancelled") return null;
  return row.ended_at !== null && Number.isSafeInteger(row.ended_at) && row.ended_at > 0 ? row.ended_at : null;
}

function sameRunIdentity(before: Readonly<RunRow>, current: Readonly<RunRow>): boolean {
  const end = birthlessTerminalEnd(before);
  return before.session_id === current.session_id && before.origin_machine === current.origin_machine &&
    before.host_pid === current.host_pid && before.pid === current.pid && before.pid_start_time === current.pid_start_time &&
    before.started_at === current.started_at && before.parent_run_id === current.parent_run_id &&
    (end === null || end === birthlessTerminalEnd(current));
}

/** Stop owns the session fence and the absence proof. This path never signals. */
export async function reapStoppedSessionRuns(deps: {
  db: Db;
  globalDb?: Db;
  sessionId: string;
  proveAbsent(row: Readonly<RunRow>): Promise<boolean>;
}): Promise<{ reaped: readonly string[]; blockers: readonly string[] }> {
  const { db, sessionId } = deps;
  const store = new RunStore(db, deps.globalDb);
  const scoped = `SELECT r.* FROM runs r WHERE r.session_id = ? AND ${localRunPredicate(db)}`;
  // Startup or a manual cancellation may already have marked a surviving
  // child terminal. Keep probing its recorded identity until it is gone.
  const candidates = db.prepare(`${scoped} AND (r.pid IS NOT NULL OR r.status IN ('queued','running','paused')) ORDER BY r.id`);
  const reread = db.prepare(`${scoped} AND r.id = ?`);
  const rows = candidates.all(sessionId) as RunRow[];
  const absent = new Map<string, Readonly<RunRow>>();
  const reaped: string[] = [], blockers = new Set<string>();
  for (const row of rows) {
    try {
      if (await deps.proveAbsent(Object.freeze(row)) !== true) { blockers.add(row.id); continue; }
      const settled = db.transaction(() => {
        const current = reread.get(sessionId, row.id) as RunRow | undefined;
        if (!current || !sameRunIdentity(row, current)) return null;
        return store.cancel(row.id, "Stopped session: child absence verified.");
      })();
      if (settled === null) blockers.add(row.id);
      else {
        absent.set(row.id, row);
        if (settled) reaped.push(row.id);
      }
    } catch { blockers.add(row.id); }
  }
  // A row published or changed while another proof was in flight had no
  // matching probe in this pass. It must not be hidden by that earlier proof.
  for (const current of candidates.all(sessionId) as RunRow[]) {
    const proved = absent.get(current.id);
    if (!proved || !sameRunIdentity(proved, current)) blockers.add(current.id);
  }
  return { reaped, blockers: [...blockers] };
}
