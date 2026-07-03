import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "../component";
import { Spinner } from "../components/spinner";
import { layoutGrid } from "./grid-layout";
import { renderGridCell } from "./grid-cell";
import type { AgentActions, AgentSnapshot, ThemeAdapter } from "./types";
import type { AgentStore } from "./store";

const CELL_HEIGHT = 6;
const CELL_HEIGHT_EXPANDED = 10;

export class Grid implements Component {
  private focus = 0;
  private page = 0;
  private pinned = new Set<string>();
  private expanded = false;
  private spinner: Spinner;
  private now: () => number;
  private drill?: (runId: string) => void;
  private close?: () => void;

  constructor(private store: AgentStore, private actions: AgentActions, private theme: ThemeAdapter,
    opts: { now?: () => number; spinner?: Spinner } = {}) {
    this.now = opts.now ?? Date.now;
    this.spinner = opts.spinner ?? new Spinner();
  }

  setDrillHandler(fn: (runId: string) => void): void { this.drill = fn; }
  onClose(fn: () => void): void { this.close = fn; }

  private pageAgents(): AgentSnapshot[] {
    const all = this.store.snapshot();
    const l = layoutGrid(all.length, this.page);
    this.page = l.page;
    const start = l.page * l.perPage;
    return all.slice(start, start + l.perPage);
  }

  private focusedRunId(): string | undefined { return this.pageAgents()[this.focus]?.runId; }

  handleInput(data: string): boolean {
    const all = this.store.snapshot();
    const l = layoutGrid(all.length, this.page);
    const onPage = this.pageAgents().length;
    if (matchesKey(data, Key.escape)) { this.close?.(); return true; }
    if (matchesKey(data, Key.enter)) { const id = this.focusedRunId(); if (id) this.drill?.(id); return true; }
    if (matchesKey(data, Key.right)) { this.focus = Math.min(onPage - 1, this.focus + 1); return true; }
    if (matchesKey(data, Key.left)) { this.focus = Math.max(0, this.focus - 1); return true; }
    if (matchesKey(data, Key.down)) { this.focus = Math.min(onPage - 1, this.focus + l.cols); return true; }
    if (matchesKey(data, Key.up)) { this.focus = Math.max(0, this.focus - l.cols); return true; }
    if (data === "]" || matchesKey(data, "pageDown")) { this.page = Math.min(l.pages - 1, this.page + 1); this.focus = 0; return true; }
    if (data === "[" || matchesKey(data, "pageUp")) { this.page = Math.max(0, this.page - 1); this.focus = 0; return true; }
    // Ctrl+O — expand/collapse each cell's instructions (task). \x0f = Ctrl+O control code.
    if (data === "\x0f") { this.expanded = !this.expanded; return true; }
    const id = this.focusedRunId();
    if (!id) return false;
    if (data === "m") { void this.actions.message(id); return true; }
    if (data === "i") { void this.actions.interrupt(id); return true; }
    if (data === "r") { void this.actions.resume(id); return true; }
    if (data === "f") { if (this.pinned.has(id)) this.pinned.delete(id); else this.pinned.add(id); this.actions.follow(id); return true; }
    return false;
  }

  render(width: number): string[] {
    const all = this.store.snapshot();
    const l = layoutGrid(all.length, this.page);
    const cells = this.pageAgents();
    if (cells.length === 0) {
      return [truncateToWidth(this.theme.fg("muted", `${this.theme.glyph} no active agents`), width, "…")];
    }
    const cols = Math.max(1, l.cols);
    const cellH = this.expanded ? CELL_HEIGHT_EXPANDED : CELL_HEIGHT;
    const cellW = Math.max(3, Math.floor((width - (cols - 1)) / cols));
    const lines: string[] = [];
    for (let r = 0; r < l.rows; r++) {
      const rowCells = cells.slice(r * cols, r * cols + cols);
      if (rowCells.length === 0) break;
      const rendered = rowCells.map((a, ci) =>
        renderGridCell(this.theme, {
          agent: a, width: cellW, height: cellH,
          focused: r * cols + ci === this.focus, pinned: this.pinned.has(a.runId),
          now: this.now(), spinner: this.spinner, expanded: this.expanded,
        }),
      );
      for (let li = 0; li < cellH; li++) {
        const joined = rendered.map((c) => padTo(c[li] ?? "", cellW)).join(" ");
        lines.push(truncateToWidth(joined, width, ""));
      }
      lines.push("");
    }
    // Pipeline handoff edges (pipeline-aware).
    const edges = this.store.edges();
    if (edges.length) {
      const e = edges[edges.length - 1];
      lines.push(truncateToWidth(this.theme.fg("accent", `${this.theme.glyph} ${e.from} →${e.phase ? e.phase : ""}→ ${e.to}`), width, "…"));
    }
    const hint = `↑↓←→ focus · enter drill · ${this.expanded ? "ctrl+o collapse" : "ctrl+o instructions"} · m msg · i interrupt · r resume · f pin${l.pages > 1 ? " · [ ] page" : ""} · esc close`;
    lines.push(truncateToWidth(this.theme.fg("dim", hint), width, "…"));
    return lines;

    function padTo(s: string, w: number): string {
      const fill = w - visibleWidth(s);
      return fill > 0 ? s + " ".repeat(fill) : s;
    }
  }

  invalidate(): void { /* stateless render; nothing cached */ }
}
