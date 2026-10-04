export function formatRunUsage(tokens: number, cost?: number): string {
  const count = tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M`
    : tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1)}k` : String(tokens);
  return `${count} tokens${cost === undefined ? "" : ` · $${cost.toFixed(2)}`}`;
}
