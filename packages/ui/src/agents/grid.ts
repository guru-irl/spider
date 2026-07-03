import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "../component";
import { Spinner } from "../components/spinner";
import { layoutGrid } from "./grid-layout";
import { renderGridCell } from "./grid-cell";
import type { AgentActions, AgentSnapshot, ThemeAdapter } from "./types";
import type { AgentStore } from "./store";

const CELL_HEIGHT = 6;

function padTo(s: string, w: number): string {
  const fill = w - visibleWidth(s);
  return fill > 0 ? s + " ".repeat(fill) : truncateToWidth(s, w, "");
}

export class Grid implements Component {
  private focus = 0;
  private page = 0;
  private pinned = new Set<string>();
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
    const id = this.focusedRunId();
    if (!id) return false;
    if (data === "m") { void this.actions.message(id); return true; }
    if (data === "i") { void this.actions.interrupt(id); return true; }
    if (data === "r") { void this.actions.resume(id); return true; }
    if (data === "f") { if (this.pinned.has(id)) this.pinned.delete(id); else this.pinned.add(id); this.actions.follow(id); return true; }
    return false;
  }

  /** Draw a rounded box around `body`, with an accented title in the top rule. */
  private frame(title: string, body: string[], width: number): string[] {
    const t = this.theme;
    const inner = Math.max(4, width - 2);
    const bar = t.fg("muted", "│");
    const dashes = Math.max(0, inner - visibleWidth(title) - 3); // "─ " + title + " "
    const top = t.fg("muted", "╭─ ") + t.fg("accent", title) + t.fg("muted", " " + "─".repeat(dashes) + "╮");
    const bottom = t.fg("muted", "╰" + "─".repeat(inner) + "╯");
    return [top, ...body.map((l) => bar + padTo(l, inner) + bar), bottom];
  }

  render(width: number): string[] {
    const all = this.store.snapshot();
    const l = layoutGrid(all.length, this.page);
    const cells = this.pageAgents();
    const title = `${this.theme.glyph} agents · ${all.length}${l.pages > 1 ? ` · pg ${l.page + 1}/${l.pages}` : ""}`;
    if (cells.length === 0) {
      return this.frame(title, [this.theme.fg("muted", "  no active agents")], width);
    }
    const inner = Math.max(4, width - 2);
    const cols = Math.max(1, l.cols);
    const cellW = Math.max(3, Math.floor((inner - (cols - 1)) / cols));
    const body: string[] = [];
    for (let r = 0; r < l.rows; r++) {
      const rowCells = cells.slice(r * cols, r * cols + cols);
      if (rowCells.length === 0) break;
      const rendered = rowCells.map((a, ci) =>
        renderGridCell(this.theme, {
          agent: a, width: cellW, height: CELL_HEIGHT,
          focused: r * cols + ci === this.focus, pinned: this.pinned.has(a.runId),
          now: this.now(), spinner: this.spinner,
        }),
      );
      for (let li = 0; li < CELL_HEIGHT; li++) {
        body.push(truncateToWidth(rendered.map((c) => padTo(c[li] ?? "", cellW)).join(" "), inner, ""));
      }
      if (r < l.rows - 1) body.push("");
    }
    // Pipeline handoff edges (pipeline-aware).
    const edges = this.store.edges();
    if (edges.length) {
      const e = edges[edges.length - 1];
      body.push(truncateToWidth(this.theme.fg("accent", `${this.theme.glyph} ${e.from} →${e.phase ? e.phase : ""}→ ${e.to}`), inner, "…"));
    }
    const hint = `↑↓←→ focus · enter drill · m msg · i interrupt · r resume · f pin${l.pages > 1 ? " · [ ] page" : ""} · esc close`;
    body.push(truncateToWidth(this.theme.fg("dim", hint), inner, "…"));
    return this.frame(title, body, width);
  }

  invalidate(): void { /* stateless render; nothing cached */ }
}
