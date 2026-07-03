import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "../component.js";
import { buildFooterModel } from "./footer-model.js";
import { diffLines, hasChanges } from "./diff.js";
import { Spinner } from "../components/spinner.js";
import { STATUS_GLYPH, statusToken } from "./types.js";
import type { AgentSnapshot, ThemeAdapter } from "./types.js";
import type { AgentStore } from "./store.js";

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

export class AgentFooter implements Component {
  private theme: ThemeAdapter;
  private maxVisible: number;
  private now: () => number;
  private spinner: Spinner;
  private cachedWidth?: number;
  private cachedLines: string[] = [];

  constructor(private store: AgentStore, theme: ThemeAdapter,
    opts: { maxVisible?: number; now?: () => number; spinner?: Spinner } = {}) {
    this.theme = theme;
    this.maxVisible = opts.maxVisible ?? 4;
    this.now = opts.now ?? Date.now;
    this.spinner = opts.spinner ?? new Spinner();
  }

  private glyphFor(a: AgentSnapshot): string {
    const g = a.status === "running" ? this.spinner.frame(this.now()) : STATUS_GLYPH[a.status];
    return this.theme.fg(statusToken(a.status), g);
  }

  private agentLine(a: AgentSnapshot, width: number): string {
    const t = this.theme;
    const elapsedMs = a.startedAt === undefined ? 0
      : (a.endedAt ?? this.now()) - a.startedAt;
    const parts = [
      this.glyphFor(a),
      `${t.glyph} ${t.bold(a.name)}`,
      t.fg("muted", formatDuration(elapsedMs)),
    ];
    if (a.activity) parts.push(t.fg("muted", "· " + a.activity));
    parts.push(t.fg("dim", `· ${a.stepCount}⋯${a.tokenCount}t`));
    return truncateToWidth(parts.join(" "), width, "…");
  }

  private build(width: number): string[] {
    const agents = this.store.snapshot();
    if (agents.length === 0) return [];
    const model = buildFooterModel(agents, this.maxVisible);
    const lines = model.visible.map((a) => this.agentLine(a, width));
    if (model.overflow) {
      const o = model.overflow;
      const seg: string[] = [];
      if (o.running) seg.push(`${o.running} running`);
      if (o.queued) seg.push(`${o.queued} queued`);
      if (o.paused) seg.push(`${o.paused} paused`);
      if (o.done) seg.push(`${o.done} done`);
      if (o.failed) seg.push(`${o.failed} failed`);
      if (o.cancelled) seg.push(`${o.cancelled} cancelled`);
      seg.push(`+${o.hidden} more`);
      lines.push(truncateToWidth(this.theme.fg("muted", `${this.theme.glyph} ▸ ` + seg.join(" · ")), width, "…"));
    }
    return lines.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width, "…") : l));
  }

  hasVisibleChange(width: number): boolean {
    const next = this.build(width);
    const d = diffLines(this.cachedLines, next);
    const changed = this.cachedWidth !== width || hasChanges(d);
    this.cachedLines = next;
    this.cachedWidth = width;
    return changed;
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines.length) return this.cachedLines;
    this.cachedLines = this.build(width);
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void { this.cachedWidth = undefined; this.cachedLines = []; }
}
