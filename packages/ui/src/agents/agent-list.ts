import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "../component";
import { Spinner } from "../components/spinner";
import { formatAgentLine } from "./footer";
import { STATUS_GLYPH } from "./types";
import type { AgentSnapshot, ThemeAdapter } from "./types";
import type { AgentStore } from "./store";

/** Frame-less, focusable footer-format selector: one row per agent, arrow keys + Enter/Esc. */
export class AgentList implements Component {
  private focus = 0;
  private spinner: Spinner;
  private now: () => number;
  private drill?: (runId: string) => void;
  private close?: () => void;

  constructor(private store: AgentStore, private theme: ThemeAdapter,
    opts?: { now?: () => number; spinner?: Spinner }) {
    this.now = opts?.now ?? Date.now;
    this.spinner = opts?.spinner ?? new Spinner();
  }

  onDrill(fn: (runId: string) => void): void { this.drill = fn; }
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
    return false;
  }

  render(width: number): string[] {
    const all = this.agents();
    const t = this.theme;
    if (all.length === 0) return [t.fg("muted", "no active agents")];
    this.clampFocus(all.length);
    const body: string[] = [];
    all.forEach((a, i) => {
      const lead = a.status === "running" ? this.spinner.frame(this.now()) : STATUS_GLYPH[a.status];
      const marker = i === this.focus ? "▸ " : "  ";
      const pin = this.store.isPinned(a.runId) ? " 📌" : "";
      const lineW = Math.max(4, width - visibleWidth(marker) - visibleWidth(pin));
      const line = formatAgentLine(t, a, lineW, this.now(), lead);
      body.push(truncateToWidth(`${t.fg("accent", marker)}${line}${pin ? t.fg("warning", pin) : ""}`, width, "…"));
    });
    body.push(t.fg("dim", "↑↓ focus · enter · esc"));
    return body;
  }

  invalidate(): void { /* stateless render; nothing cached */ }
}
