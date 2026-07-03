import { describe, it, expect, vi } from "vitest";
import { AgentStore, projectRow } from "../agents/store.js";
import type { RunRow, RunSource, RunEvent } from "../agents/types.js";

function row(over: Partial<RunRow>): RunRow {
  return { id: "r1", session_id: "s", agent: "worker", status: "running",
    step_count: 0, token_count: 0, ...over };
}

class FakeSource implements RunSource {
  rows = new Map<string, RunRow>();
  private fn?: (e: RunEvent) => void;
  listActive() { return [...this.rows.values()]; }
  getRun(id: string) { return this.rows.get(id); }
  subscribe(fn: (e: RunEvent) => void) { this.fn = fn; return () => { this.fn = undefined; }; }
  emit(e: RunEvent) { this.fn?.(e); }
}

describe("projectRow", () => {
  it("prefers self-name then role then agent", () => {
    expect(projectRow(row({ name: "scribe" })).name).toBe("scribe");
    expect(projectRow(row({ name: null, role: "reviewer" })).name).toBe("reviewer");
    expect(projectRow(row({ name: null, role: null, agent: "worker" })).name).toBe("worker");
  });
});

describe("AgentStore", () => {
  it("seeds from listActive on start", () => {
    const src = new FakeSource();
    src.rows.set("r1", row({ id: "r1" }));
    const store = new AgentStore(src);
    store.start();
    expect(store.snapshot().map(a => a.runId)).toEqual(["r1"]);
    store.stop();
  });

  it("updates activity + counts on a bus event and notifies once", () => {
    const src = new FakeSource();
    src.rows.set("r1", row({ id: "r1", step_count: 1, token_count: 10 }));
    const store = new AgentStore(src);
    const spy = vi.fn();
    store.onChange(spy);
    store.start();
    src.rows.set("r1", row({ id: "r1", step_count: 2, token_count: 25 }));
    src.emit({ runId: "r1", sessionId: "s", ts: 1, type: "tool_intent", tool: "bash", summary: "ls" });
    const a = store.snapshot()[0];
    expect(a.activityTool).toBe("bash");
    expect(a.stepCount).toBe(2);
    expect(a.tokenCount).toBe(25);
    expect(spy).toHaveBeenCalled();
    store.stop();
  });

  it("records handoff edges (pipeline-aware)", () => {
    const src = new FakeSource();
    src.rows.set("r1", row({ id: "r1" }));
    const store = new AgentStore(src);
    store.start();
    src.emit({ runId: "r1", sessionId: "s", ts: 2, type: "handoff",
      payload: { from: "r1", to: "r2", phase: "review" } });
    expect(store.edges()).toEqual([{ from: "r1", to: "r2", phase: "review", ts: 2 }]);
    store.stop();
  });

  it("hasRunning reflects any running agent", () => {
    const src = new FakeSource();
    src.rows.set("r1", row({ id: "r1", status: "done", ended_at: Date.now() }));
    const store = new AgentStore(src);
    store.start();
    expect(store.hasRunning()).toBe(false);
    store.stop();
  });
});
