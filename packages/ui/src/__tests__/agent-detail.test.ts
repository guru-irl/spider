import { describe, it, expect, vi } from "vitest";
import { AgentDetail } from "../agents/agent-detail";
import { AgentStore } from "../agents/store";
import type { RunRow, RunSource, RunEvent, ThemeAdapter } from "../agents/types";
import { visibleWidth } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };
class Src implements RunSource {
  rows = new Map<string, RunRow>([["r1", { id: "r1", session_id: "s", agent: "worker", role: "reviewer",
    name: "critic", status: "running", model: "gpt", phase: "review", step_count: 4, token_count: 88, started_at: 0 }]]);
  listActive() { return [...this.rows.values()]; }
  getRun(id: string) { return this.rows.get(id); } subscribe(_: (e: RunEvent) => void) { return () => {}; }
}

describe("AgentDetail", () => {
  it("renders the agent name, model and phase within width", () => {
    const store = new AgentStore(new Src()); store.start();
    const d = new AgentDetail(store, "r1", id, { now: () => 1000 });
    const out = d.render(70);
    const joined = out.join("\n");
    expect(joined).toContain("critic");
    expect(joined).toContain("gpt");
    expect(joined).toContain("review");
    for (const l of out) expect(visibleWidth(l)).toBeLessThanOrEqual(70);
  });
  it("Esc returns to grid", () => {
    const store = new AgentStore(new Src()); store.start();
    const d = new AgentDetail(store, "r1", id); const back = vi.fn(); d.onBack(back);
    expect(d.handleInput("\u001b")).toBe(true); // actual escape key
    expect(back).toHaveBeenCalled();
  });
});
