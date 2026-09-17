import type { Db } from "@spider/db-core";

export interface CompletionSignal {
  done: boolean;
  result: string;
  reason?: string;
}
export const NO_DELIVERABLE_RESULT = "No result was finalized: the child exited without a terminal report. Progress and intermediate artifacts are not a completion report.";

/**
 * New reporters persist stopReason on every assistant message, including empty/error
 * responses. A tool-call preamble cannot resolve a blocker or stand in for a final
 * report. Legacy message events without stopReason remain readable as best-effort output.
 */
export function genuineCompletion(db: Db, runId: string): CompletionSignal {
  const rows = db.prepare(
    "SELECT type,summary,payload FROM run_events WHERE run_id=? AND type IN ('message','escalation') ORDER BY id DESC",
  ).all(runId) as Array<{ type: string; summary: string | null; payload: string | null }>;
  let unfinished = false;
  for (const row of rows) {
    let payload: { severity?: string; stopReason?: string; errorMessage?: string; escalationOnly?: boolean } = {};
    try { payload = row.payload ? JSON.parse(row.payload) : {}; } catch { /* legacy/corrupt metadata */ }
    if (row.type === "escalation") {
      if (payload?.severity === "blocked" || payload?.severity === "question") {
        return { done: false, result: "", reason: `${payload.severity}: ${row.summary ?? "parent input required"}` };
      }
      continue;
    }
    if (payload?.escalationOnly === true) continue;
    const stop = payload?.stopReason;
    if (stop === "toolUse" || stop === "pending") { unfinished = true; continue; }
    if (stop !== undefined && stop !== "stop") {
      return { done: false, result: "", reason: payload.errorMessage || `Child response ended with ${stop}, not a terminal report.` };
    }
    const text = (row.summary ?? "").trim();
    if (unfinished || !text) return { done: false, result: "", reason: NO_DELIVERABLE_RESULT };
    return { done: true, result: text };
  }
  return unfinished ? { done: false, result: "", reason: NO_DELIVERABLE_RESULT } : { done: false, result: "" };
}

/** Canonical finalized result wins over progress events, including for failed runs. */
export function latestRunOutput(db: Db, runId: string, fallback?: string): string {
  const row = db.prepare("SELECT result FROM runs WHERE id=?").get(runId) as { result: string | null } | undefined;
  const canonical = row?.result?.trim();
  if (canonical) return canonical;
  const completion = genuineCompletion(db, runId);
  if (completion.done) return completion.result;
  return (fallback ?? completion.reason ?? "").trim();
}
