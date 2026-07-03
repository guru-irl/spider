import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "../component";
import { formatDuration, shortModel } from "./footer";
import { wrapText } from "./grid-cell";
import { STATUS_GLYPH, statusToken } from "./types";
import type { ThemeAdapter } from "./types";
import type { AgentStore } from "./store";

export class AgentDetail implements Component {
  private now: () => number;
  private back?: () => void;
  constructor(private store: AgentStore, private runId: string, private theme: ThemeAdapter,
    opts: { now?: () => number } = {}) { this.now = opts.now ?? Date.now; }

  onBack(fn: () => void): void { this.back = fn; }

  handleInput(data: string): boolean {
    if (matchesKey(data, Key.escape)) { this.back?.(); return true; }
    return false;
  }

  render(width: number): string[] {
    const a = this.store.snapshot().find((x) => x.runId === this.runId);
    const t = this.theme;
    if (!a) return [truncateToWidth(t.fg("muted", `${t.glyph} run ${this.runId} not found`), width, "…")];
    const fit = (s: string) => truncateToWidth(s, width, "…");
    const elapsedMs = a.startedAt === undefined ? 0 : (a.endedAt ?? this.now()) - a.startedAt;
    const turns = a.stepCount === 1 ? "1 turn" : `${a.stepCount} turns`;

    // Header: status glyph, spider, NAME, status word.
    const head = fit(`${t.fg(statusToken(a.status), STATUS_GLYPH[a.status])} ${t.glyph} ${t.bold(a.name)}  ${t.fg(statusToken(a.status), a.status)}`);
    const meta = fit("  " + t.fg("dim", `${a.role ?? a.agent} · ${shortModel(a.model)} · ${turns} · ${formatDuration(elapsedMs)}`));
    const idLine = fit("  " + t.fg("dim", `#${a.runId}`));

    const instructions = (a.task ?? "").trim()
      ? wrapText(a.task!.trim(), Math.max(1, width - 2), 8).map((l) => "  " + t.fg("muted", l))
      : ["  " + t.fg("dim", "(no instructions)")];

    // Live activity feed — the current tool prominently, then recent history (newest last).
    const cur = a.activity ? [fit("  " + t.fg("accent", "▸ " + a.activity))] : [];
    const feed = a.recentActivity.length
      ? a.recentActivity.map((s) => fit("  " + t.fg("muted", "· " + s)))
      : ["  " + t.fg("dim", "(waiting for activity…)")];

    const lines = [
      head, meta, idLine, "",
      t.fg("dim", `${t.glyph} instructions`), ...instructions, "",
      t.fg("dim", `${t.glyph} activity`), ...cur, ...feed,
      "", fit(t.fg("dim", "esc back to grid")),
    ];
    return lines;
  }

  invalidate(): void { /* stateless render */ }
}
