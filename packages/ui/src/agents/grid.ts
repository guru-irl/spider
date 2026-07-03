import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "../component";
import { Spinner } from "../components/spinner";
import { formatAgentLine } from "./footer";
import { STATUS_GLYPH } from "./types";
import type { AgentActions, AgentSnapshot, ThemeAdapter } from "./types";
import type { AgentStore } from "./store";

function padTo(s: string, w: number): string {
  const fill = w - visibleWidth(s);
  return fill > 0 ? s + " ".repeat(fill) : truncateToWidth(s, w, "");
}

/** The Ctrl+Shift+G overlay: a vertical LIST of one-line agent rows (same format as the
 *  footer) inside a rounded frame. One line per agent → dense, readable, no tall boxes. */
export class Grid implements Component {
  private focus = 0;
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

  private agents(): AgentSnapshot[] { return this.store.snapshot(); }
  private clampFocus(n: number): void { this.focus = Math.max(0, Math.min(Math.max(0, n - 1), this.focus)); }
  private focusedRunId(): string | undefined { return this.agents()[this.focus]?.runId; }

  handleInput(data: string): boolean {
    const all = this.agents();
    const n = all.length;
    this.clampFocus(n);
    if (matchesKey(data, Key.escape)) { this.close?.(); return true; }
    if (matchesKey(data, Key.enter)) { const id = this.focusedRunId(); if (id) this.drill?.(id); return true; }
    if (matchesKey(data, Key.down)) { this.focus = Math.min(n - 1, this.focus + 1); return true; }
    if (matchesKey(data, Key.up)) { this.focus = Math.max(0, this.focus - 1); return true; }
    const id = this.focusedRunId();
    if (!id) return false;
    if (data === "m") { void this.actions.message(id); return true; }
    if (data === "i") { void this.actions.interrupt(id); return true; }
    if (data === "r") { void this.actions.resume(id); return true; }
    if (data === "f") { this.store.togglePin(id); this.actions.follow(id); return true; }
    return false;
  }

  /** Draw a rounded box around `body`, with an accented title in the top rule. */
  private frame(title: string, body: string[], width: number): string[] {
    const t = this.theme;
    const inner = Math.max(4, width - 2);
    const bar = t.fg("muted", "│");
    const ttl = truncateToWidth(title, Math.max(1, inner - 4), "…");
    const k = Math.max(0, width - 5 - visibleWidth(ttl));
    const top = t.fg("muted", "╭─ ") + t.fg("accent", ttl) + t.fg("muted", " " + "─".repeat(k) + "╮");
    const bottom = t.fg("muted", "╰" + "─".repeat(inner) + "╯");
    return [top, ...body.map((l) => bar + padTo(l, inner) + bar), bottom];
  }

  render(width: number): string[] {
    const all = this.agents();
    const t = this.theme;
    const title = `${t.glyph} agents · ${all.length}`;
    if (all.length === 0) return this.frame(title, [t.fg("muted", "  no active agents")], width);
    this.clampFocus(all.length);
    const inner = Math.max(4, width - 2);
    const body: string[] = [];
    all.forEach((a, i) => {
      const lead = a.status === "running" ? this.spinner.frame(this.now()) : STATUS_GLYPH[a.status];
      const marker = i === this.focus ? "▸ " : "  ";
      const pin = this.store.isPinned(a.runId) ? " 📌" : "";
      const lineW = Math.max(4, inner - visibleWidth(marker) - visibleWidth(pin));
      const line = formatAgentLine(t, a, lineW, this.now(), lead);
      body.push(truncateToWidth(`${t.fg("accent", marker)}${line}${pin ? t.fg("warning", pin) : ""}`, inner, "…"));
    });
    // Pipeline handoff edge (latest), if any.
    const edges = this.store.edges();
    if (edges.length) {
      const e = edges[edges.length - 1];
      body.push(truncateToWidth(t.fg("accent", `${t.glyph} ${e.from} →${e.phase ? e.phase : ""}→ ${e.to}`), inner, "…"));
    }
    body.push("");
    const hint = "↑↓ focus · enter drill · m msg · i interrupt · r resume · f pin · esc close";
    body.push(truncateToWidth(t.fg("dim", hint), inner, "…"));
    return this.frame(title, body, width);
  }

  invalidate(): void { /* stateless render; nothing cached */ }
}
