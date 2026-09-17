import type { Db } from "@spider/db-core";
import type { DrainReport } from "./types.js";

function validateDrainReport(report: unknown): DrainReport | undefined {
  const r = report as DrainReport;
  if (!r || r.kind !== "organism-drain" ||
    !["completed", "partial", "failed", "skipped"].includes(r.status)) return undefined;
  for (const key of ["memoryStaged", "skillsStaged", "todosAdded", "dropped", "rejected", "modelCalls", "startedAt", "finishedAt"] as const) {
    if (typeof r[key] !== "number" || !Number.isFinite(r[key]) || r[key] < 0) return undefined;
  }
  if (!Array.isArray(r.errors) || r.errors.some(e => typeof e?.phase !== "string" || typeof e?.message !== "string")) return undefined;
  return r;
}

/** Older count-only logs are not evidence of a verified successful drain. */
export function readLastDrainReport(db: Db, sessionId: string): DrainReport | undefined {
  try {
    const row = db.prepare(
      "SELECT payload FROM run_events WHERE session_id=? AND type='log' " +
      "AND summary LIKE 'organism drain (%' ORDER BY id DESC LIMIT 1",
    ).get(sessionId) as { payload: string | null } | undefined;
    if (!row?.payload) return undefined;
    const report = JSON.parse(row.payload) as DrainReport;
    const validated = validateDrainReport(report);
    if (validated === undefined || validated.sessionId !== sessionId) return undefined;
    return validated;
  } catch {
    return undefined; // Diagnostics remain usable if this particular receipt is corrupt.
  }
}

/**
 * Worktree-wide fallback: the most recent verified drain receipt in this
 * worktree DB, regardless of which session produced it. Used when the
 * CURRENT session has no drain of its own yet (a fresh runtime/new session
 * after a prior session's failure or shutdown) so the evidence is not lost —
 * but callers MUST label it with its own `sessionId`/timestamp and never
 * present it as the current session's own drain (see `extension.ts` doctor).
 */
export function readLastDrainReportForWorktree(db: Db): DrainReport | undefined {
  try {
    const row = db.prepare(
      "SELECT payload FROM run_events WHERE type='log' " +
      "AND summary LIKE 'organism drain (%' ORDER BY id DESC LIMIT 1",
    ).get() as { payload: string | null } | undefined;
    if (!row?.payload) return undefined;
    const report = JSON.parse(row.payload) as DrainReport;
    return validateDrainReport(report);
  } catch {
    return undefined;
  }
}
