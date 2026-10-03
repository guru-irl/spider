// packages/host/src/agents/run-source.ts
import { bus, type Db } from "@spider/db-core";
import type { RunEvent, RunRow, RunSource } from "@spider/ui";
import { runUsage, sumUsage } from "@spider/subagents";

const RETENTION_MS = 10_000;

export function createRunSource(db: Db, sessionId: string): RunSource {
  const listStmt = db.prepare(
    `SELECT * FROM runs WHERE session_id = ? AND (ended_at IS NULL OR ended_at > ?) ORDER BY started_at ASC`);
  const getStmt = db.prepare(`SELECT * FROM runs WHERE id = ?`);
  const eventsStmt = db.prepare(
    `SELECT run_id, session_id, ts, type, tool, summary, payload FROM run_events WHERE run_id = ? ORDER BY ts ASC, id ASC`);
  const safeParse = (s: unknown): unknown => { if (typeof s !== "string") return undefined; try { return JSON.parse(s); } catch { return undefined; } };
  const costs = new Map<string, { tokens: number | undefined; cost: number }>();
  const withCost = (row: RunRow): RunRow => {
    let cached = costs.get(row.id);
    if (!cached || cached.tokens !== row.token_count) {
      cached = { tokens: row.token_count, cost: sumUsage(runUsage(db, row.id).map(r => r.usage)).cost.total };
      costs.set(row.id, cached);
    }
    return { ...row, cost: cached.cost };
  };
  return {
    listActive(): RunRow[] {
      return (listStmt.all(sessionId, Date.now() - RETENTION_MS) as RunRow[]).map(withCost);
    },
    getRun(runId: string): RunRow | undefined {
      const row = getStmt.get(runId) as RunRow | undefined;
      return row ? withCost(row) : undefined;
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
