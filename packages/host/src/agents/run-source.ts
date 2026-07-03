// packages/host/src/agents/run-source.ts
import { bus, type Db } from "@spider/db-core";
import type { RunEvent, RunRow, RunSource } from "@spider/ui";

const RETENTION_MS = 10_000;

export function createRunSource(db: Db, sessionId: string): RunSource {
  const listStmt = db.prepare(
    `SELECT * FROM runs WHERE session_id = ? AND (ended_at IS NULL OR ended_at > ?) ORDER BY started_at ASC`);
  const getStmt = db.prepare(`SELECT * FROM runs WHERE id = ?`);
  const eventsStmt = db.prepare(
    `SELECT run_id, session_id, ts, type, tool, summary, payload FROM run_events WHERE run_id = ? ORDER BY ts ASC, id ASC`);
  const safeParse = (s: unknown): unknown => { if (typeof s !== "string") return undefined; try { return JSON.parse(s); } catch { return undefined; } };
  return {
    listActive(): RunRow[] {
      return listStmt.all(sessionId, Date.now() - RETENTION_MS) as RunRow[];
    },
    getRun(runId: string): RunRow | undefined {
      return (getStmt.get(runId) as RunRow | undefined) ?? undefined;
    },
    listEvents(runId: string): RunEvent[] {
      return (eventsStmt.all(runId) as any[]).map((r) => ({
        runId: r.run_id ?? undefined,
        sessionId: r.session_id,
        ts: r.ts,
        type: r.type,
        tool: r.tool ?? undefined,
        summary: r.summary ?? undefined,
        payload: safeParse(r.payload),
      }));
    },
    subscribe(fn: (e: RunEvent) => void): () => void {
      return bus.on((e) => { if (e.sessionId === sessionId) fn(e); });
    },
  };
}
