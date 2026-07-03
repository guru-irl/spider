import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "../component";
import { buildFooterModel } from "./footer-model";
import { diffLines, hasChanges } from "./diff";
import { statusToken } from "./types";
import type { AgentSnapshot, ThemeAdapter } from "./types";
import type { AgentStore } from "./store";

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

/** Short model label (drop provider prefix + redundant 'claude-'). */
export function shortModel(m?: string | null): string { if (!m) return "—"; return (m.split("/").pop() ?? m).replace(/^claude-/, ""); }

export class AgentFooter implements Component {
  private theme: ThemeAdapter;
  private maxVisible: number;
  private now: () => number;
  private cachedWidth?: number;
  private cachedLines: string[] = [];

  constructor(private store: AgentStore, theme: ThemeAdapter,
    opts: { maxVisible?: number; now?: () => number } = {}) {
    this.theme = theme;
    this.maxVisible = opts.maxVisible ?? 4;
    this.now = opts.now ?? Date.now;
  }

  private agentLine(a: AgentSnapshot, width: number): string {
    const t = this.theme;
    const elapsedMs = a.startedAt === undefined ? 0 : (a.endedAt ?? this.now()) - a.startedAt;
    const turns = a.stepCount === 1 ? "1 turn" : `${a.stepCount} turns`;
    const model = shortModel(a.model);
    const sep = t.fg("dim", "·");
    // Compact, colour-coded: 🕸  name (status) · type (accent) · model · turns · dur · activity.
    const parts = [
      t.fg(statusToken(a.status), t.bold(a.name)),
      sep, t.fg("accent", a.role ?? a.agent),
    ];
    if (model !== "—") parts.push(sep, t.fg("muted", model));
    parts.push(sep, t.fg("dim", turns), sep, t.fg("muted", formatDuration(elapsedMs)));
    if (a.activity) parts.push(sep, t.fg("dim", a.activity));
    return truncateToWidth(`${t.fg("accent", t.glyph)}  ${parts.join(" ")}`, width, "…");
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
    // Always rebuild: the spinner/elapsed are time-derived, and pi may re-create the
    // widget instance (e.g. after an overlay closes) — a cached short-circuit would
    // then freeze the animation permanently. Rebuilding a few lines each paint is cheap.
    this.cachedLines = this.build(width);
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void { this.cachedWidth = undefined; this.cachedLines = []; }
}
