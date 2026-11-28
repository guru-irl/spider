import { describe, it, expect, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { AgentFooter } from "../agents/footer";
import { AgentStore } from "../agents/store";
import type { RunRow, RunSource, RunEvent, ThemeAdapter } from "../agents/types";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };
function row(o: Partial<RunRow>): RunRow {
  return { id: "r1", session_id: "s", agent: "worker", status: "running", step_count: 3, token_count: 120,
    started_at: 0, ...o };
}
class Src implements RunSource {
  rows = new Map<string, RunRow>(); private fn?: (e: RunEvent) => void;
  listActive() { return [...this.rows.values()]; }
  getRun(id: string) { return this.rows.get(id); }
  subscribe(fn: (e: RunEvent) => void) { this.fn = fn; return () => {}; }
  emit(e: RunEvent) { this.fn?.(e); }
}

describe("AgentFooter", () => {
  it("renders empty when no agents", () => {
    const src = new Src(); const store = new AgentStore(src); store.start();
    const f = new AgentFooter(store, id, { now: () => 1000 });
    expect(f.render(40)).toEqual([]);
  });
  it("renders one agent line with the activity marker, name, turns, within width", () => {
    const src = new Src(); src.rows.set("r1", row({ name: "scribe" }));
    const store = new AgentStore(src); store.start();
    const f = new AgentFooter(store, id, { now: () => 5000 });
    const lines = f.render(60);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.join("\n")).toContain("◇"); // the agent marker leads the footer line
    expect(lines.join("\n")).toContain("scribe");
    expect(lines.join("\n")).toContain("3 turns");
    expect(lines.join("\n")).not.toContain("#"); // the useless run-id hash is gone
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
  });
  it("right-aligns model and thinking while progressively dropping lower-priority fields", () => {
    const src = new Src();
    src.rows.set("r1", row({ name: "pimo", model: "github-copilot/gpt-6.1-terra", thinking: "high", step_count: 8 }));
    const theme: ThemeAdapter = { ...id, modelName: () => "GPT-6.1 Terra" };
    const store = new AgentStore(src); store.start();
    const f = new AgentFooter(store, theme, { now: () => 60_000 });
    const wide = f.render(80)[0]!;
    expect(wide).toMatch(/^◇ worker pimo · 8 turns · 1m0s +GPT-6\.1 Terra · high$/);
    expect(visibleWidth(wide)).toBe(80);
    const noTurns = f.render(48)[0]!;
    expect(noTurns).not.toContain("turns");
    expect(noTurns).toContain("1m0s");
    expect(noTurns).toMatch(/GPT-6\.1 Terra · high$/);
    const noElapsed = f.render(38)[0]!;
    expect(noElapsed).not.toContain("turns");
    expect(noElapsed).not.toContain("1m0s");
    expect(noElapsed).toMatch(/GPT-6\.1 Terra · high$/);
    const noThinking = f.render(30)[0]!;
    expect(noThinking).toMatch(/GPT-6\.1 Terra$/);
    expect(noThinking).not.toContain("high");
    const short = f.render(24)[0]!;
    expect(stripTerminalSequences(short)).toMatch(/^◇ worker pimo +GPT-6\.1 T…$/);
    for (const width of [24, 30, 38, 48, 80]) expect(visibleWidth(f.render(width)[0]!)).toBe(width);
    store.stop();
  });
  it("keeps pinned and selected models right-aligned without losing the summary", () => {
    const src = new Src();
    for (let i = 1; i <= 4; i++) src.rows.set(`r${i}`, row({ id: `r${i}`, name: `agent-${i}`, model: "p/model", thinking: "high" }));
    const store = new AgentStore(src); store.start(); store.togglePin("r4");
    const footer = new AgentFooter(store, id, { now: () => 5000 });
    const normal = footer.render(72);
    expect(normal[0]).toMatch(/agent-4 † · 3 turns · 5s +model · high$/);
    expect(normal[2]).toContain("4 running · +2 more");
    expect(normal.slice(0, 2).every(line => visibleWidth(line) === 72 && line.endsWith("model · high"))).toBe(true);
    store.beginSelect();
    const selected = footer.render(72);
    expect(selected[0]).toMatch(/^▸ .*agent-4/);
    expect(selected.slice(0, 2).every(line => visibleWidth(line) === 72 && line.endsWith("model · high"))).toBe(true);
    expect(selected[2]).toMatch(/view more +4 subagents$/);
    store.stop();
  });
  it("hasVisibleChange is false when nothing changed between frames", () => {
    const src = new Src(); src.rows.set("r1", row({ name: "scribe" }));
    const store = new AgentStore(src); store.start();
    const f = new AgentFooter(store, id, { now: () => 5000 });
    expect(f.hasVisibleChange(60)).toBe(true);   // first paint
    expect(f.hasVisibleChange(60)).toBe(false);  // no change
  });

  it("includes queued and paused in footer overflow counts", () => {
    // Create more than maxVisible agents with various statuses including queued and paused
    const src = new Src();
    src.rows.set("r1", row({ id: "r1", status: "running", name: "runner" }));
    src.rows.set("r2", row({ id: "r2", status: "queued", name: "queued1" }));
    src.rows.set("r3", row({ id: "r3", status: "paused", name: "paused1" }));
    src.rows.set("r4", row({ id: "r4", status: "done", name: "done1" }));
    src.rows.set("r5", row({ id: "r5", status: "failed", name: "failed1" }));
    src.rows.set("r6", row({ id: "r6", status: "cancelled", name: "cancelled1" }));
    const store = new AgentStore(src); store.start();
    const f = new AgentFooter(store, id, { maxVisible: 2, now: () => 5000 });
    const lines = f.render(100);
    const overflowLine = lines[lines.length - 1];
    // The overflow line should mention queued and paused
    expect(overflowLine).toContain("queued");
    expect(overflowLine).toContain("paused");
    // And the traditional statuses
    expect(overflowLine).toContain("running");
    expect(overflowLine).toContain("done");
    expect(overflowLine).toContain("failed");
    expect(overflowLine).toContain("cancelled");
  });
});

  it("footer line includes the thinking level when set and omits it when absent", () => {
    const src = new Src();
    const th: ThemeAdapter = { fg: (t, s) => s, bg: (t, s) => s, bold: (s) => s, glyph: "◆" };
    src.rows.set("a1", row({ id: "a1", model: "openai/gpt-5", thinking: "high" }));
    const store1 = new AgentStore(src); store1.start();
    const f1 = new AgentFooter(store1, th, { now: () => 200 });
    const withT = f1.render(200).join("\n");
    expect(withT).toContain("high");
    store1.stop();

    src.rows.clear();
    src.rows.set("a1", row({ id: "a1", model: "openai/gpt-5" }));
    const store2 = new AgentStore(src); store2.start();
    const f2 = new AgentFooter(store2, th, { now: () => 200 });
    const noT = f2.render(200).join("\n");
    expect(noT).not.toContain("high");
    store2.stop();
  });

import { AgentFooter as _AF } from "../agents/footer";
import { AgentStore as _Store } from "../agents/store";
describe("AgentFooter selection cursor", () => {
  it.each(["text", "nerd"] as const)("shows the view direction and right-aligned total in %s mode", (iconStyle) => {
    const src = new Src();
    for (let i = 1; i <= 4; i++) src.rows.set(`r${i}`, row({ id: `r${i}`, name: `agent-${i}`, started_at: i }));
    const store = new AgentStore(src); store.start();
    const footer = new AgentFooter(store, { ...id, iconStyle }, { now: () => 5000 });
    expect(footer.render(40)[2]).toContain("4 running · +2 more");
    store.beginSelect();
    let lines = footer.render(40);
    expect(lines[0]).toContain("agent-4");
    expect(lines[2]).toBe(`↓ view more · 1/4${" ".repeat(12)}4 subagents`);
    store.moveSelect(1);
    lines = footer.render(40);
    expect(lines[1]).toContain("agent-3");
    expect(lines[2]).toBe(`↓ view more · 2/4${" ".repeat(12)}4 subagents`);
    store.moveSelect(1);
    lines = footer.render(40);
    expect(lines[1]).toContain("agent-2");
    expect(lines[2]).toBe(`↓ view more · 3/4${" ".repeat(12)}4 subagents`);
    store.moveSelect(1);
    lines = footer.render(40);
    expect(lines[1]).toContain("agent-1");
    expect(lines[2]).toBe(`↑ view more · 4/4${" ".repeat(12)}4 subagents`);
    expect(stripVTControlCharacters(footer.render(16)[2])).toBe("↑ view more · 4…");
    for (let width = 1; width <= 30; width++) {
      expect(footer.render(width).every(line => visibleWidth(line) <= width), `${width} columns`).toBe(true);
    }
    store.endSelect();
    expect(footer.render(40)[2]).toContain("4 running · +2 more");
  });

  it("changes the summary direction when the wheel scrolls the window to the end", () => {
    const src = new Src();
    for (let i = 1; i <= 4; i++) src.rows.set(`r${i}`, row({ id: `r${i}`, started_at: i }));
    const store = new AgentStore(src); store.start(); store.beginSelect();
    const footer = new AgentFooter(store, id, { now: () => 5000 });
    expect(footer.render(40)[2]).toMatch(/^↓ view more/);
    footer.handleMouse({ type: "wheel", button: "none", wheelDelta: 2, x: 0, y: 2, width: 40, height: 3,
      screenX: 0, screenY: 2, shift: false, alt: false, ctrl: false });
    expect(footer.render(40)[2]).toMatch(/^↑ view more · 1\/4 +4 subagents$/);
  });

  it("updates the total when another agent joins", () => {
    const src = new Src();
    for (let i = 1; i <= 4; i++) src.rows.set(`r${i}`, row({ id: `r${i}`, started_at: i }));
    const store = new AgentStore(src); store.start(); store.beginSelect(); store.moveSelect(1);
    const footer = new AgentFooter(store, id, { now: () => 5000 });
    expect(footer.render(40)[2]).toMatch(/^↓ view more · 2\/4 +4 subagents$/);
    src.rows.set("r5", row({ id: "r5", started_at: 0 }));
    src.emit({ runId: "r5", sessionId: "s", ts: 1, type: "log" });
    expect(footer.render(40)[2]).toMatch(/^↓ view more · 2\/5 +5 subagents$/);
  });

  it.each([undefined, "missing"])("omits the position when the selected run is %s", (selected) => {
    const src = new Src();
    for (let i = 1; i <= 4; i++) src.rows.set(`r${i}`, row({ id: `r${i}`, started_at: i }));
    const store = new AgentStore(src); store.start(); store.beginSelect();
    const selection = vi.spyOn(store, "selectedRunId").mockReturnValue(selected);
    try {
      const footer = new AgentFooter(store, id, { now: () => 5000 });
      expect(footer.render(40)[2]).toBe(`↓ view more${" ".repeat(18)}4 subagents`);
    } finally { selection.mockRestore(); }
  });

  it("renders the separator dim and the remaining summary muted", () => {
    const src = new Src();
    for (let i = 1; i <= 4; i++) src.rows.set(`r${i}`, row({ id: `r${i}`, started_at: i }));
    const store = new AgentStore(src); store.start(); store.beginSelect();
    const theme: ThemeAdapter = { ...id, fg: (token, text) =>
      token === "muted" ? `\x1b[37m${text}\x1b[39m` : token === "dim" ? `\x1b[90m${text}\x1b[39m` : text };
    const footer = new AgentFooter(store, theme, { now: () => 5000 });
    const summary = footer.render(40)[2];
    expect(summary).toContain("\x1b[37m↓ view more");
    expect(summary).toContain("\x1b[90m·\x1b[39m");
    expect(summary).toContain("\x1b[37m 1/4");
    expect(visibleWidth(summary)).toBe(40);
    const narrow = footer.render(16)[2];
    expect(stripVTControlCharacters(narrow)).toBe("↓ view more · 1…");
    expect(visibleWidth(narrow)).toBe(16);
  });

  it("renders a ▸ cursor on the selected row while the store is selecting", () => {
    const rows = [
      { id: "a", session_id: "x", agent: "worker", name: "alpha", status: "running", step_count: 0, token_count: 0, started_at: 0 },
      { id: "b", session_id: "x", agent: "worker", name: "beta", status: "running", step_count: 0, token_count: 0, started_at: 0 },
    ];
    const src: any = { listActive: () => rows, getRun: (id: string) => rows.find((r) => r.id === id), subscribe: () => () => {} };
    const store = new _Store(src); store.start();
    const theme = { fg: (_t: string, s: string) => s, bg: (_t: string, s: string) => s, bold: (s: string) => s, italic: (s: string) => s, glyph: "🕸" };
    const footer = new _AF(store, theme as never, { now: () => 0 });
    expect(footer.render(200).join("\n")).not.toContain("▸"); // no cursor when not selecting
    store.beginSelect();
    const out = footer.render(200);
    expect(out.join("\n")).toContain("▸"); // cursor appears on the selected row
    expect(out[0].startsWith("▸")).toBe(true); // row 0 is selected first
  });
});
