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
  it("shows known response and individual concurrent tool times without summing elapsed time", () => {
    const src = new Src();
    const events: RunEvent[] = [
      { runId: "r1", sessionId: "s", ts: 0, type: "message", summary: "Report", payload: { durationMs: 1250 } },
      { runId: "r1", sessionId: "s", ts: 1, type: "message", summary: "", payload: { durationMs: 250 } },
      { runId: "r1", sessionId: "s", ts: 2, type: "tool_result", tool: "read", summary: "read a", payload: { id: "a", durationMs: 800 } },
      { runId: "r1", sessionId: "s", ts: 2, type: "tool_result", tool: "read", summary: "read b", payload: { id: "b", durationMs: 800 } },
      { runId: "r1", sessionId: "s", ts: 3, type: "tool_result", tool: "read", summary: "read empty", payload: { id: "c", durationMs: 0 } },
    ];
    const store = new AgentStore({ listActive: () => src.listActive(), getRun: id => src.getRun(id), subscribe: () => () => {}, listEvents: () => events });
    store.start();
    try {
      const d = new AgentDetail(store, "r1", id, { now: () => 1000 });
      const lines = d.render(100), text = lines.join("\n");
      expect(text).toContain("response time 1.3s");
      expect(text).toContain("response time 250ms");
      expect(lines.filter(line => line.includes("tool time 800ms"))).toHaveLength(2);
      expect(text).toContain("tool time 0ms");
      expect(text).not.toContain("1.6s");
      expect(lines.find(line => line.includes("4 turns"))).toContain("1s");
      for (const width of [30, 60, 100]) for (const line of d.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    } finally { store.stop(); }
  });

  it("keeps known tool timing visible when its result summary is truncated", () => {
    const src = new Src();
    const events: RunEvent[] = [{ runId: "r1", sessionId: "s", ts: 0, type: "tool_result", tool: "read",
      summary: "A long tool result ".repeat(20), payload: { durationMs: 750 } }];
    const store = new AgentStore({ listActive: () => src.listActive(), getRun: id => src.getRun(id), subscribe: () => () => {}, listEvents: () => events });
    store.start();
    try {
      const d = new AgentDetail(store, "r1", id, { now: () => 1000 });
      for (const width of [30, 60, 100]) expect(d.render(width).join("\n")).toContain("tool time 750ms");
    } finally { store.stop(); }
  });

  it("does not show timing for legacy or invalid event payloads", () => {
    const src = new Src();
    const events: RunEvent[] = [
      { runId: "r1", sessionId: "s", ts: 0, type: "message", summary: "Legacy" },
      ...[undefined, -1, Infinity, "5"].map((durationMs, i) => ({ runId: "r1", sessionId: "s", ts: i + 1,
        type: "tool_result", summary: "Legacy tool", payload: { durationMs } })),
    ];
    const store = new AgentStore({ listActive: () => src.listActive(), getRun: id => src.getRun(id), subscribe: () => () => {}, listEvents: () => events });
    store.start();
    try {
      const text = new AgentDetail(store, "r1", id).render(100).join("\n");
      expect(text).toContain("Legacy tool");
      expect(text).not.toContain("response time"); expect(text).not.toContain("tool time");
    } finally { store.stop(); }
  });

  it("Esc returns to grid", () => {
    const store = new AgentStore(new Src()); store.start();
    const d = new AgentDetail(store, "r1", id); const back = vi.fn(); d.onBack(back);
    expect(d.handleInput("\u001b")).toBe(true); // actual escape key
    expect(back).toHaveBeenCalled();
  });
});

describe("AgentDetail kill affordance", () => {
  // Reuses `Src` and `id` already defined at the TOP of this file. Do not
  // redefine them — the seeded run is keyed "r1".
  const mkDetail = (now: () => number) => {
    const store = new AgentStore(new Src());
    store.start();
    return new AgentDetail(store, "r1", id, { now });
  };

  it("first k arms and shows a confirmation prompt", () => {
    const d = mkDetail(() => 1000);
    const killed: string[] = [];
    d.onKill((runId) => killed.push(runId));
    expect(d.handleInput("k")).toBe(true);
    expect(d.render(60).join("\n")).toMatch(/press k again/i);
    expect(killed).toHaveLength(0);
  });

  it("second k within the window fires the kill", () => {
    let t = 1000;
    const d = mkDetail(() => t);
    const killed: string[] = [];
    d.onKill((runId) => killed.push(runId));
    d.handleInput("k");
    t = 2000;
    d.handleInput("k");
    expect(killed).toEqual(["r1"]);
  });

  it("an intervening key disarms", () => {
    const d = mkDetail(() => 1000);
    const killed: string[] = [];
    d.onKill((runId) => killed.push(runId));
    d.handleInput("k");
    d.handleInput("j");
    d.handleInput("k");
    expect(killed).toHaveLength(0);
    expect(d.render(60).join("\n")).toMatch(/press k again/i);
  });

  it("the arm expires after the timeout", () => {
    let t = 1000;
    const d = mkDetail(() => t);
    const killed: string[] = [];
    d.onKill((runId) => killed.push(runId));
    d.handleInput("k");
    t = 9999;
    d.handleInput("k");
    expect(killed).toHaveLength(0);
  });
});


it("run details retain a thinking cap above the conversation tail", () => {
  const notice = "thinking capped: requested max, model supports up to xhigh; using xhigh";
  const src = new Src();
  const events: RunEvent[] = [{ runId: "r1", sessionId: "s", ts: 0, type: "warning", summary: notice, payload: { thinkingNotice: true } },
    ...Array.from({ length: 130 }, (_, i) => ({ runId: "r1", sessionId: "s", ts: i + 1, type: "message", summary: "fixture conversation" }))];
  const store = new AgentStore({ listActive: () => src.listActive(), getRun: id => src.getRun(id), subscribe: () => () => {}, listEvents: () => events });
  store.start();
  try { expect(new AgentDetail(store, "r1", id).render(140).join("\n")).toContain(notice); }
  finally { store.stop(); }
});
