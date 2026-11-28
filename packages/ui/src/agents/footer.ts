import { truncateToWidth, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { icon } from "../icons.js";
import type { Component } from "../component";
import { buildFooterModel, orderFooterAgents } from "./footer-model";
import { diffLines, hasChanges } from "./diff";
import { agentGlyph, renderAgentStatus, renderRoleAccent } from "./types";
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
export function shortModel(m?: string | null, modelName?: ThemeAdapter["modelName"]): string {
  if (!m) return "—";
  return modelName?.(m)?.trim() || (m.split("/").pop() ?? m).replace(/^claude-/, "");
}

/** Shared one-line summary with a single leading activity or status mark. */
export function formatAgentLine(t: ThemeAdapter, a: AgentSnapshot, width: number, now: number): string {
  const ital = (s: string) => (t.italic ? t.italic(s) : s);
  const elapsedMs = a.startedAt === undefined ? 0 : (a.endedAt ?? now) - a.startedAt;
  const turns = a.stepCount === 1 ? "1 turn" : `${a.stepCount} turns`;
  const model = shortModel(a.model, t.modelName);
  const sep = t.fg("dim", "·");
  const parts = [
    ital(renderRoleAccent(t, a.role ?? a.agent, a.role ?? a.agent)),
    t.fg("toolTitle", t.bold(a.name)),
  ];
  if (model !== "—") parts.push(sep, t.fg("muted", model));
  if (a.thinking) parts.push(sep, t.fg("dim", a.thinking));
  parts.push(sep, t.fg("dim", turns), sep, t.fg("muted", formatDuration(elapsedMs)));
  return truncateToWidth(`${renderAgentStatus(t, a, now)} ${parts.join(" ")}`, width, "…");
}

export class AgentFooter implements Component {
  private theme: ThemeAdapter;
  private maxVisible: number;
  private now: () => number;
  private cachedWidth?: number;
  private cachedLines: string[] = [];
  private offset = 0;
  private lastSelectedRunId?: string;

  constructor(private store: AgentStore, theme: ThemeAdapter,
    opts: { maxVisible?: number; now?: () => number } = {}) {
    this.theme = theme;
    this.maxVisible = Math.max(2, Math.min(3, opts.maxVisible ?? 3));
    this.now = opts.now ?? Date.now;
  }

  private agentLine(a: AgentSnapshot, width: number, selecting: boolean, selected?: string): string {
    const cursor = selecting ? (a.runId === selected ? this.theme.fg("accent", `${icon(this.theme.iconStyle, "select")} `) : "  ") : "";
    const cw = visibleWidth(cursor);
    const pin = this.store.isPinned(a.runId) ? ` ${icon(this.theme.iconStyle, "pin")}` : "";
    const line = formatAgentLine(this.theme, a, Math.max(4, width - visibleWidth(pin) - cw), this.now());
    return cursor + (pin ? line + this.theme.fg("warning", pin) : line);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "wheel" || !event.wheelDelta || event.x < 0 || event.y < 0 ||
        event.x >= event.width || event.y >= event.height) return undefined;
    const count = this.store.snapshot().length;
    if (count <= this.maxVisible) return undefined;
    const limit = count - (this.maxVisible - 1);
    const previous = this.offset;
    this.offset = Math.max(0, Math.min(limit, this.offset + event.wheelDelta));
    return { handled: true, render: this.offset !== previous };
  }

  private build(width: number): string[] {
    const agents = this.store.snapshot();
    if (agents.length === 0) { this.offset = 0; this.lastSelectedRunId = undefined; return []; }
    const visibleCount = agents.length > this.maxVisible ? this.maxVisible - 1 : this.maxVisible;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, agents.length - visibleCount)));
    const selected = this.store.selectedRunId();
    if (selected !== this.lastSelectedRunId && selected) {
      const index = orderFooterAgents(agents).findIndex(a => a.runId === selected);
      if (index >= 0 && index < this.offset) this.offset = index;
      else if (index >= this.offset + visibleCount) this.offset = index - visibleCount + 1;
    }
    this.lastSelectedRunId = selected;
    const model = buildFooterModel(agents, visibleCount, this.offset);
    const selecting = this.store.isSelecting();
    const lines = model.visible.map((a) => this.agentLine(a, width, selecting, selected));
    if (model.overflow && selecting) {
      const direction = this.offset + visibleCount < agents.length ? "arrowDown" : "arrowUp";
      const left = `${icon(this.theme.iconStyle, direction)} view more`;
      const right = `${agents.length} subagents`;
      const padding = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
      lines.push(truncateToWidth(this.theme.fg("muted", left + padding + right), width, "…"));
    } else if (model.overflow) {
      const o = model.overflow;
      const seg: string[] = [];
      if (o.running) seg.push(`${o.running} running`);
      if (o.queued) seg.push(`${o.queued} queued`);
      if (o.paused) seg.push(`${o.paused} paused`);
      if (o.done) seg.push(`${o.done} done`);
      if (o.failed) seg.push(`${o.failed} failed`);
      if (o.cancelled) seg.push(`${o.cancelled} cancelled`);
      seg.push(`+${o.hidden} more`);
      lines.push(truncateToWidth(this.theme.fg("muted", `${agentGlyph(this.theme)} ${icon(this.theme.iconStyle, "select")} ` + seg.join(" · ")), width, "…"));
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
    // Always rebuild: the activity mark and elapsed time are time-derived, and pi may re-create the
    // widget instance (e.g. after an overlay closes) — a cached short-circuit would
    // then freeze the animation permanently. Rebuilding a few lines each paint is cheap.
    this.cachedLines = this.build(width);
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void { this.cachedWidth = undefined; this.cachedLines = []; }
}
