export function formatCompactionCount(compactionCount?: number): string {
  return (compactionCount ?? 0) > 0 ? ` · ${compactionCount} compaction${compactionCount === 1 ? "" : "s"}` : "";
}

export function formatRunUsage(tokens: number, cost?: number, compactionCount?: number, costText?: string): string {
  const count = tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M`
    : tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1)}k` : String(tokens);
  return `${count} tokens${costText !== undefined ? ` · ${costText}` : cost === undefined ? "" : ` · $${cost.toFixed(2)}`}${formatCompactionCount(compactionCount)}`;
}
