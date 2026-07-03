// packages/host/src/agents/run-source.ts
import { bus, type Db } from "@spider/db-core";
import type { RunEvent, RunRow, RunSource } from "@spider/ui";

const RETENTION_MS = 10_000;

export function createRunSource(db: Db, sessionId: string): RunSource {
  const listStmt = db.prepare(
    `SELECT * FROM runs WHERE session_id = ? AND (ended_at IS NULL OR ended_at > ?) ORDER BY started_at ASC`);
  const getStmt = db.prepare(`SELECT * FROM runs WHERE id = ?`);
  return {
    listActive(): RunRow[] {
      return listStmt.all(sessionId, Date.now() - RETENTION_MS) as RunRow[];
    },
    getRun(runId: string): RunRow | undefined {
      return (getStmt.get(runId) as RunRow | undefined) ?? undefined;
    },
    subscribe(fn: (e: RunEvent) => void): () => void {
      return bus.on((e) => { if (e.sessionId === sessionId) fn(e); });
    },
  };
}
