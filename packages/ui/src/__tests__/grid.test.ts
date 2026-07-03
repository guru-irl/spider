import { describe, it, expect, vi } from "vitest";
import { Grid } from "../agents/grid";
import { AgentStore } from "../agents/store";
import type { RunRow, RunSource, RunEvent, ThemeAdapter, AgentActions } from "../agents/types";
import { Key } from "@earendil-works/pi-tui";

const id: ThemeAdapter = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, glyph: "🕸" };
function row(i: number): RunRow {
  return { id: `r${i}`, session_id: "s", agent: "worker", name: `r${i}`, status: "running", step_count: 0, token_count: 0, started_at: 0 };
}
class Src implements RunSource {
  rows = new Map<string, RunRow>(); listActive() { return [...this.rows.values()]; }
  getRun(id: string) { return this.rows.get(id); } subscribe(_: (e: RunEvent) => void) { return () => {}; }
}
function makeStore(n: number) {
  const src = new Src(); for (let i = 0; i < n; i++) src.rows.set(`r${i}`, row(i));
  const store = new AgentStore(src); store.start(); return store;
}
const actions: AgentActions = { message: vi.fn(), interrupt: vi.fn(), resume: vi.fn(), follow: vi.fn() };

describe("Grid", () => {
  it("renders cells for all agents on the page", () => {
    const g = new Grid(makeStore(4), actions, id, { now: () => 1 });
    const out = g.render(80).join("\n");
    for (let i = 0; i < 4; i++) expect(out).toContain(`r${i}`);
  });
  it("Enter drills the focused run", () => {
    const g = new Grid(makeStore(4), actions, id, { now: () => 1 });
    const drill = vi.fn(); g.setDrillHandler(drill);
    g.render(80);
    expect(g.handleInput("\r")).toBe(true); // actual enter key is \r
    expect(drill).toHaveBeenCalledWith("r0");
  });
  it("i interrupts the focused run", () => {
    const g = new Grid(makeStore(2), actions, id, { now: () => 1 });
    g.render(80);
    expect(g.handleInput("i")).toBe(true);
    expect(actions.interrupt).toHaveBeenCalledWith("r0");
  });
  it("Esc closes", () => {
    const g = new Grid(makeStore(2), actions, id, { now: () => 1 });    const close = vi.fn(); g.onClose(close);
    expect(g.handleInput("\u001b")).toBe(true); // actual escape key is \u001b
    expect(close).toHaveBeenCalled();
  });

  it("Ctrl+O toggles instructions expansion (hint reflects state)", () => {
    const g = new Grid(makeStore(2), actions, id, { now: () => 1 });
    expect(g.render(80).join("\n")).toContain("ctrl+o instructions");
    expect(g.handleInput("\x0f")).toBe(true); // Ctrl+O control code
    expect(g.render(80).join("\n")).toContain("ctrl+o collapse");
  });
});
