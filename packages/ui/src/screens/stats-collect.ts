export interface StatsInput {
  contentChunks: number; avgChunkTokens: number;
  rowCounts: Record<string, number>;
  modelStats: { model: string; ms: number; ok: number; tokens: number }[];
}
export interface ModelStatRow { model: string; calls: number; okRate: number; avgMs: number; tokens: number; }
export interface StatsSummary {
  tokenSavings: { indexedChunks: number; estTokensSaved: number };
  rowCounts: Record<string, number>;
  models: ModelStatRow[];
}

/** Pure: fold raw stats input into a token-savings estimate + per-model aggregates. */
export function summarizeStats(input: StatsInput): StatsSummary {
  const byModel = new Map<string, { ms: number; ok: number; tokens: number; calls: number }>();
  for (const s of input.modelStats) {
    const cur = byModel.get(s.model) ?? { ms: 0, ok: 0, tokens: 0, calls: 0 };
    cur.ms += s.ms; cur.ok += s.ok; cur.tokens += s.tokens; cur.calls += 1;
    byModel.set(s.model, cur);
  }
  const models: ModelStatRow[] = [...byModel.entries()].map(([model, v]) => ({
    model, calls: v.calls, okRate: v.calls ? v.ok / v.calls : 0,
    avgMs: v.calls ? Math.round(v.ms / v.calls) : 0, tokens: v.tokens,
  })).sort((a, b) => b.calls - a.calls);
  return {
    tokenSavings: { indexedChunks: input.contentChunks, estTokensSaved: input.contentChunks * input.avgChunkTokens },
    rowCounts: input.rowCounts,
    models,
  };
}
