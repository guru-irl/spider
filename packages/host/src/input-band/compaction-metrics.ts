import type { Theme } from "@earendil-works/pi-coding-agent";

export interface CompactionBill {
  tokens: string;
  cost?: string;
}

export function compactionTokenCount(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return String(value);
}

const PARTIAL_BLOCKS = " ▏▎▍▌▋▊▉";

/** These bars compare the context before compaction with the summary alone. */
export function renderCompactionBars(before: number, summary: number, width: number, theme: Theme): string[] {
  const counts = [`${compactionTokenCount(before)} tokens`, `~${compactionTokenCount(summary)} tokens`];
  const cells = Math.min(17, width - 11 - Math.max(counts[0].length, counts[1].length));
  const scale = Math.max(before, summary);
  return [before, summary].map((tokens, i) => {
    const label = i === 0 ? "before" : "summary";
    if (cells <= 0) return `${theme.fg("muted", label)}  ${counts[i]}`;
    // Round to the nearest eighth, but never round a nonempty summary to zero.
    const eighths = tokens > 0 ? Math.max(1, Math.round((tokens / scale) * cells * 8)) : 0;
    const remainder = eighths % 8;
    const bar = "█".repeat(Math.floor(eighths / 8)) + (remainder ? PARTIAL_BLOCKS[remainder] : "");
    return `${theme.fg("muted", label.padEnd(7))}  ${theme.fg(i === 0 ? "dim" : "accent", bar)}${" ".repeat(cells - bar.length + 2)}${counts[i]}`;
  });
}
