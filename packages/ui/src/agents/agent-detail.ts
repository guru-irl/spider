import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
    const a = this.store.getById(this.runId);
    const t = this.theme;
    const title = `${t.glyph} ${a ? a.name : "agent"}`;
    if (!a) return this.frame(title, [t.fg("muted", `  run ${this.runId} not found`)], width);
    const inner = Math.max(4, width - 2);
    const fit = (s: string) => truncateToWidth(s, inner, "…");
    const elapsedMs = a.startedAt === undefined ? 0 : (a.endedAt ?? this.now()) - a.startedAt;
    const turns = a.stepCount === 1 ? "1 turn" : `${a.stepCount} turns`;

    const head = fit(`${t.fg(statusToken(a.status), STATUS_GLYPH[a.status])} ${t.bold(a.name)}  ${t.fg(statusToken(a.status), a.status)}`);
    const meta = fit("  " + t.fg("dim", `${a.role ?? a.agent} · ${shortModel(a.model)} · ${turns} · ${formatDuration(elapsedMs)}`));
    const idLine = fit("  " + t.fg("dim", `#${a.runId}`));

    const instructions = (a.task ?? "").trim()
      ? wrapText(a.task!.trim(), Math.max(1, inner - 2), 8).map((l) => "  " + t.fg("muted", l))
      : ["  " + t.fg("dim", "(no instructions)")];

    // Full live conversation: assistant prose + tool calls + results, chronological.
    const convo: string[] = [];
    for (const e of this.store.events(this.runId)) {
      if (e.type === "message" && e.summary) {
        for (const l of wrapText(e.summary, Math.max(1, inner - 2), 60)) convo.push(fit("  " + t.fg("text", l)));
        convo.push("");
      } else if (e.type === "tool_intent") {
        convo.push(fit("  " + t.fg("accent", "→ " + (e.summary ?? e.tool ?? "tool"))));
      } else if (e.type === "tool_result" && e.summary) {
        convo.push(fit("    " + t.fg("muted", e.summary)));
      } else if (e.type === "handoff" && e.summary) {
        convo.push(fit("  " + t.fg("accent", "⇢ " + e.summary)));
      }
    }
    if (a.status === "running" && a.activity) convo.push(fit("  " + t.fg("accent", "▸ " + a.activity)));
    // Tail to the most recent lines (the overlay is scroll-free; keep it bounded).
    const convoTail = convo.length ? convo.slice(-120) : ["  " + t.fg("dim", "(waiting for the agent…)")];

    const body = [
      head, meta, idLine, "",
      t.fg("dim", `${t.glyph} instructions`), ...instructions, "",
      t.fg("dim", `${t.glyph} conversation`), ...convoTail,
      "", fit(t.fg("dim", "esc back to grid")),
    ];
    return this.frame(title, body, width);
  }

  /** Rounded, width-exact panel so the detail reads as a bounded view (never a blank overlay). */
  private frame(title: string, body: string[], width: number): string[] {
    const t = this.theme;
    const inner = Math.max(4, width - 2);
    const bar = t.fg("muted", "│");
    const ttl = truncateToWidth(title, Math.max(1, inner - 4), "…");
    const k = Math.max(0, width - 5 - visibleWidth(ttl));
    const top = t.fg("muted", "╭─ ") + t.fg("toolTitle", ttl) + t.fg("muted", " " + "─".repeat(k) + "╮");
    const bottom = t.fg("muted", "╰" + "─".repeat(inner) + "╯");
    const pad = (l: string) => { const d = inner - visibleWidth(l); return bar + (d > 0 ? l + " ".repeat(d) : truncateToWidth(l, inner, "")) + bar; };
    return [top, ...body.map(pad), bottom];
  }

  invalidate(): void { /* stateless render */ }
}
