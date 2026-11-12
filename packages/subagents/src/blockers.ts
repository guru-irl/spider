import type { Db } from "@spider/db-core";
import type { Blocker } from "@spider/db-core/roam/types";

export interface BlockerOptions {
  pendingPipelines?: () => readonly { pipelineId: string; sessionId: string }[];
}

/** The live process may supply its registry; dormant sessions have no pipeline coordinator. */
export function listSessionBlockers(db: Db, sessionId: string, options: BlockerOptions = {}): readonly Blocker[] {
  const rows = db.prepare(`SELECT r.id, r.status FROM runs r
    WHERE r.session_id=? AND r.origin_machine=(SELECT machine_id FROM roam_meta WHERE id=1) AND r.origin_machine!=''
    AND (r.status IN ('queued','running','paused') OR (
      r.status IN ('done','failed') AND EXISTS (SELECT 1 FROM run_events e WHERE e.run_id=r.id AND e.type='child_supervisor')
      AND NOT EXISTS (SELECT 1 FROM run_events e WHERE e.run_id=r.id AND e.type='completion_delivered')
    )) ORDER BY r.id`).all(sessionId) as { id: string; status: string }[];
  const blockers: Blocker[] = rows.map(row => ({ kind: "run", id: row.id,
    detail: ["done", "failed"].includes(row.status) ? "Completion has not been delivered." : `Child is ${row.status}.` }));
  for (const pipeline of options.pendingPipelines?.() ?? []) {
    if (pipeline.sessionId === sessionId) blockers.push({ kind: "pipeline", id: pipeline.pipelineId, detail: "Pipeline has a pending stage." });
  }
  return blockers;
}
