// packages/host/src/agents/run-source.ts
import { bus, type Db } from "@spider/db-core";
import type { RunEvent, RunRow, RunSource, RunUsageCosts } from "@spider/ui";
import { runUsageSummary, sumUsage } from "@spider/subagents";

const RETENTION_MS = 10_000;

export function createRunSource(db: Db, sessionId: string): RunSource {
  const listStmt = db.prepare(
    `SELECT * FROM runs WHERE session_id = ? AND (ended_at IS NULL OR ended_at > ?) ORDER BY started_at ASC`);
  const getStmt = db.prepare(`SELECT * FROM runs WHERE id = ?`);
  const eventsStmt = db.prepare(
    `SELECT run_id, session_id, ts, type, tool, summary, payload FROM run_events WHERE run_id = ? ORDER BY ts ASC, id ASC`);
  const safeParse = (s: unknown): unknown => { if (typeof s !== "string") return undefined; try { return JSON.parse(s); } catch { return undefined; } };
  const costs = new Map<string, { tokens: number | undefined; cost: number; usageCosts: RunUsageCosts; compactionCount?: number }>();
  const withCost = (row: RunRow): RunRow => {
    let cached = costs.get(row.id);
    if (!cached || cached.tokens !== row.token_count) {
      const summary = runUsageSummary(db, row.id);
      cached = { tokens: row.token_count, cost: sumUsage(summary.usage.map(r => r.usage)).cost.total, usageCosts: summary.usage.map(r => ({ provider: r.provider, cost: r.usage.cost.total })), compactionCount: summary.compactionCount };
      costs.set(row.id, cached);
    }
    return { ...row, cost: cached.cost, usageCosts: cached.usageCosts, compactionCount: cached.compactionCount };
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
      return bus.on((e) => {
        if (e.sessionId !== sessionId) return;
        // Successful unpriced compactions leave token_count unchanged. Invalidate
        // before the store reads the row, without adding any render-time DB query.
        if (e.runId && (e.type === "spider_usage" || e.type === "spider_compaction")) costs.delete(e.runId);
        fn(e);
      });
    },
  };
}
