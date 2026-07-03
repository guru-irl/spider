import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "../component";
import { buildFooterModel } from "./footer-model";
import { diffLines, hasChanges } from "./diff";
import { Spinner } from "../components/spinner";
import { STATUS_GLYPH, statusToken } from "./types";
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

/** Width-aware right/left pad + model shortening for aligned footer columns. */
function padEndVis(s: string, w: number): string { const d = w - visibleWidth(s); return d > 0 ? s + " ".repeat(d) : truncateToWidth(s, w, "…"); }
function padStartVis(s: string, w: number): string { const d = w - visibleWidth(s); return d > 0 ? " ".repeat(d) + s : truncateToWidth(s, w, "…"); }
export function shortModel(m?: string | null): string { if (!m) return "—"; return (m.split("/").pop() ?? m).replace(/^claude-/, ""); }
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }

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

  private agentLine(a: AgentSnapshot, width: number, w: { name: number; type: number; model: number }): string {
    const t = this.theme;
    const elapsedMs = a.startedAt === undefined ? 0 : (a.endedAt ?? this.now()) - a.startedAt;
    const statusGlyph = a.status === "running" ? this.spinner.frame(this.now()) : STATUS_GLYPH[a.status];
    const turns = a.stepCount === 1 ? "1 turn" : `${a.stepCount} turns`;
    const cols = [
      t.glyph,
      t.bold(padEndVis(a.name, w.name)),
      t.fg("muted", padEndVis(a.role ?? a.agent, w.type)),
      t.fg("dim", padEndVis(shortModel(a.model), w.model)),
      t.fg("dim", padStartVis(turns, 8)),
      t.fg("muted", padStartVis(formatDuration(elapsedMs), 6)),
      t.fg(statusToken(a.status), statusGlyph),
    ];
    const head = cols.join("  ");
    if (a.activity) {
      const rem = width - visibleWidth(head) - 1;
      if (rem > 4) return head + " " + t.fg("muted", truncateToWidth("· " + a.activity, rem, "…"));
    }
    return truncateToWidth(head, width, "…");
  }

  private build(width: number): string[] {
    const agents = this.store.snapshot();
    if (agents.length === 0) return [];
    const model = buildFooterModel(agents, this.maxVisible);
    const w = {
      name: clamp(Math.max(...model.visible.map((a) => visibleWidth(a.name))), 6, 22),
      type: clamp(Math.max(...model.visible.map((a) => visibleWidth(a.role ?? a.agent))), 4, 10),
      model: clamp(Math.max(...model.visible.map((a) => visibleWidth(shortModel(a.model)))), 3, 18),
    };
    const lines = model.visible.map((a) => this.agentLine(a, width, w));
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
