import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ThemeAdapter } from "../agents/types.js";
import type { StatsSummary } from "./stats-collect.js";
import { renderTable } from "../components/table.js";
import { card } from "../renderers/types.js";

/** Pure: token-savings + row-counts + per-model table, framed as a 🕸 stats card. */
export function renderStats(s: StatsSummary, theme: ThemeAdapter, width: number): string[] {
  const body: string[] = [];
  body.push(truncateToWidth(theme.fg("accent", "── token savings ──"), width, ""));
  body.push(truncateToWidth(
    `${theme.fg("muted", "indexed chunks")} ${theme.fg("text", String(s.tokenSavings.indexedChunks))}  ` +
    `${theme.fg("muted", "est tokens saved")} ${theme.fg("success", String(s.tokenSavings.estTokensSaved))}`,
    width, ""));
  body.push(truncateToWidth(theme.fg("accent", "── rows ──"), width, ""));
  for (const [k, v] of Object.entries(s.rowCounts)) {
    body.push(truncateToWidth(`${theme.fg("muted", k)} ${theme.fg("text", String(v))}`, width, ""));
  }
  if (s.models.length) {
    body.push(truncateToWidth(theme.fg("accent", "── models ──"), width, ""));
    body.push(...renderTable(theme, {
      columns: [
        { header: "model" }, { header: "calls", align: "right" }, { header: "ok%", align: "right" },
        { header: "avgms", align: "right" }, { header: "tok", align: "right" },
      ],
      rows: s.models.map((m) => [m.model, String(m.calls), `${Math.round(m.okRate * 100)}`, String(m.avgMs), String(m.tokens)]),
      width,
    }));
  }
  return card(theme, "stats", body, width);
}

/** Component wrapper (cached by width) for mounting via ctx.ui.custom. */
export class StatsView {
  private cachedWidth = -1;
  private cachedLines: string[] = [];
  constructor(private summary: StatsSummary, private theme: ThemeAdapter) {}
  invalidate(): void { this.cachedWidth = -1; }
  render(width: number): string[] {
    if (width === this.cachedWidth) return this.cachedLines;
    this.cachedLines = renderStats(this.summary, this.theme, width);
    this.cachedWidth = width;
    return this.cachedLines;
  }
}
