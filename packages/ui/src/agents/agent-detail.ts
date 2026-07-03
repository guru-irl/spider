import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "../component";
import { renderTable } from "../components/table";
import { formatDuration } from "./footer";
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
    const elapsedMs = a.startedAt === undefined ? 0 : (a.endedAt ?? this.now()) - a.startedAt;
    const rule = truncateToWidth(
      `${t.fg(statusToken(a.status), STATUS_GLYPH[a.status])} ${t.glyph} ${t.bold(a.name)} ` +
        t.fg("muted", `${a.role ?? a.status}`), width, "…");
    const table = renderTable(t, {
      columns: [{ header: "field" }, { header: "value" }],
      rows: [
        ["status", a.status],
        ["model", a.model ?? "—"],
        ["phase", a.phase ?? "—"],
        ["steps", String(a.stepCount)],
        ["tokens", String(a.tokenCount)],
        ["elapsed", formatDuration(elapsedMs)],
      ],
      width,
    });
    const activity = a.recentActivity.map((s) => truncateToWidth("  " + t.fg("muted", s), width, "…"));
    const lines = [rule, "", ...table, "", t.fg("dim", `${t.glyph} recent activity`), ...activity];
    lines.push("", truncateToWidth(t.fg("dim", "esc back to grid"), width, "…"));
    return lines;
  }

  invalidate(): void { /* stateless render */ }
}
