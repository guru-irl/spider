import { describe, it, expect } from "vitest";
import { AgentList } from "../agents/agent-list";
import { AgentStore } from "../agents/store";
import type { RunRow, RunSource } from "../agents/types";

const th = { fg: (_t: string, s: string) => s, bg: (_t: string, s: string) => s, bold: (s: string) => s, italic: (s: string) => s, glyph: "🕸" };
function storeOf(rows: RunRow[]): AgentStore {
  const src: RunSource = { listActive: () => rows, getRun: (id) => rows.find(r => r.id === id), subscribe: () => () => {} };
  const s = new AgentStore(src); s.start(); return s;
}
const rows = [
  { id: "a1", session_id: "s", agent: "scout", name: "one", status: "running", step_count: 1, token_count: 0, started_at: 0 },
  { id: "a2", session_id: "s", agent: "worker", name: "two", status: "running", step_count: 1, token_count: 0, started_at: 0 },
] as RunRow[];

describe("AgentList", () => {
  it("focuses row 0, moves with arrows, and drills the focused run on enter", () => {
    const store = storeOf(rows);
    const list = new AgentList(store, th as never, { now: () => 0 });
    let drilled = "";
    list.onDrill((id) => { drilled = id; });
    expect(list.render(80)[0].startsWith("▸")).toBe(true);
    list.handleInput("\x1b[B"); // Down
    expect(list.render(80)[1].startsWith("▸")).toBe(true);
    list.handleInput("\r");     // Enter
    expect(drilled).toBe("a2");
  });
  it("esc closes", () => {
    const store = storeOf(rows);
    const list = new AgentList(store, th as never);
    let closed = false;
    list.onClose(() => { closed = true; });
    expect(list.handleInput("\u001b")).toBe(true); // Esc
    expect(closed).toBe(true);
  });
});
