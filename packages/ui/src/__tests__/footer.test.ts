import { describe, it, expect } from "vitest";
import { AgentFooter } from "../agents/footer";
import { AgentStore } from "../agents/store";
import type { RunRow, RunSource, RunEvent, ThemeAdapter } from "../agents/types";
import { visibleWidth } from "@earendil-works/pi-tui";

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
  it("renders one agent line with the spider glyph, name, turns, within width", () => {
    const src = new Src(); src.rows.set("r1", row({ name: "scribe" }));
    const store = new AgentStore(src); store.start();
    const f = new AgentFooter(store, id, { now: () => 5000 });
    const lines = f.render(60);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.join("\n")).toContain("🕸"); // spider glyph leads the footer line
    expect(lines.join("\n")).toContain("scribe");
    expect(lines.join("\n")).toContain("3 turns");
    expect(lines.join("\n")).not.toContain("#"); // the useless run-id hash is gone
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
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
