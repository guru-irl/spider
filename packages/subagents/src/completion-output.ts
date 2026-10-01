import type { Db } from "@spider/db-core";
import type { RunStatus } from "./run-store";

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

/** A missing/blank result: no deliverable, not even an empty-but-intentional string. */
function isBlankResult(result: string | null | undefined): boolean {
  return result == null || result.trim().length === 0;
}

/**
 * Decide a child's terminal status + result from its raw exit outcome.
 *
 * The production spawner (`spawn-default.ts`) NEVER resolves `wait()` with a `result` —
 * only test/fake spawners do. So the real deliverable must come from `run_events`
 * (`genuineCompletion`, sourced from the child's own `message`/`escalation` events), not
 * from `waitResult`. A clean exit code is necessary but NOT sufficient for success: a
 * child that escalates/blocks and then exits 0 without ever producing a deliverable must
 * not be recorded "done" — that hides the escalation from anything keying on status alone.
 *
 * `waitResult`, when a spawner does supply one (tests, or a future spawner), is honored
 * as-is — it is an explicit, non-blank claim of a result and takes precedence.
 *
 * A single function so BOTH call sites (the sync runForeground path and the async
 * runAsync parent-finalizes path) apply the same rule via `Runner.finalize` — fixing
 * only one is a half-fix.
 */
export function decideOutcome(db: Db, runId: string, exitCode: number, waitResult: string | null | undefined): { status: RunStatus; result?: string } {
  if (!isBlankResult(waitResult)) {
    return { status: exitCode === 0 ? "done" : "failed", result: waitResult ?? undefined };
  }
  const completion = genuineCompletion(db, runId);
  if (exitCode !== 0) {
    const detail = completion.done ? completion.result : completion.reason;
    return { status: "failed", result: `Child process exited with code ${exitCode}.${detail ? `\n\n${detail}` : ""}` };
  }
  return completion.done
    ? { status: "done", result: completion.result }
    : { status: "failed", result: completion.reason ?? NO_DELIVERABLE_RESULT };
}
