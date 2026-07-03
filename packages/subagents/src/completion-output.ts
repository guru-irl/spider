import type { Db } from "@spider/db-core";

/** The child's final assistant prose for a run (newest `message` run_event), else the
 *  fallback result string, else "". Used to push real output to the parent on completion. */
export function latestRunOutput(db: Db, runId: string, fallback?: string): string {
  const row = db
    .prepare(`SELECT summary FROM run_events WHERE run_id = ? AND type = 'message' ORDER BY ts DESC, id DESC LIMIT 1`)
    .get(runId) as { summary?: string } | undefined;
  const out = row?.summary?.trim();
  if (out) return out;
  return (fallback ?? "").trim();
}
