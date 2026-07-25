import type { Db } from "@spider/db-core";
import { summarizeStats, type StatsSummary } from "@spider/ui";

/** Count rows in a table, degrading to 0 if the table is absent. */
function count(db: Db, table: string): number {
  try {
    const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Gather DB-backed stats into a `StatsSummary`. Takes the project + global Db
 * handles (from the ActionCtx) so it stays unit-testable against scratch DBs.
 * Token-savings is a heuristic: `indexedChunks × (avg chunk chars / 4)`.
 */
interface StatsCtx {
  worktreeDb: Db;  // content, sessions, runs, todos
  repoDb: Db;      // memory
}

export function collectStats(ctx: StatsCtx, globalDb: Db): StatsSummary {
  const contentChunks = count(ctx.worktreeDb, "content");

  let avgChunkTokens = 0;
  try {
    const rows = ctx.worktreeDb.prepare("SELECT chunk FROM content LIMIT 200").all() as { chunk?: string }[];
    if (rows.length) {
      const avgChars = rows.reduce((s, r) => s + (r.chunk?.length ?? 0), 0) / rows.length;
      avgChunkTokens = Math.round(avgChars / 4);
    }
  } catch {
    /* content may be empty */
  }

  const rowCounts: Record<string, number> = {
    content: contentChunks,
    memory: count(ctx.repoDb, "memory"),
    todos: count(ctx.worktreeDb, "todos"),
    runs: count(ctx.worktreeDb, "runs"),
    sessions: count(ctx.worktreeDb, "sessions"),
  };

  let modelStats: { model: string; ms: number; ok: number; tokens: number }[] = [];
  try {
    modelStats = (globalDb.prepare("SELECT model, ms, ok, tokens FROM model_stats").all() as Array<{
      model: string; ms: number | null; ok: number | null; tokens: number | null;
    }>).map((r) => ({ model: String(r.model), ms: Number(r.ms ?? 0), ok: Number(r.ok ?? 0), tokens: Number(r.tokens ?? 0) }));
  } catch {
    /* global may lack model_stats rows */
  }

  return summarizeStats({ contentChunks, avgChunkTokens, rowCounts, modelStats });
}
