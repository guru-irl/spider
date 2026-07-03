import { describe, it, expect, vi, afterEach } from "vitest";
import { AgentStore, projectRow } from "../agents/store";
import type { RunRow, RunSource, RunEvent } from "../agents/types";
import { openDb, migrate, appendRunEvent } from "@spider/db-core";
import { scratchDbPath, cleanupScratch } from "@spider/db-core/testutil";
import type { Db } from "@spider/db-core";

const opened: { close(): void }[] = [];
afterEach(() => { for (const d of opened) d.close(); opened.length = 0; cleanupScratch(); });

function createRunSource(db: Db, sessionId: string): RunSource {
  return {
    listActive: () => {
      const stmt = db.prepare(`SELECT * FROM runs WHERE session_id = ? AND status IN ('queued','running','paused')`);
      return stmt.all(sessionId) as RunRow[];
    },
    getRun: (id: string) => {
      const stmt = db.prepare(`SELECT * FROM runs WHERE id = ?`);
      return stmt.get(id) as RunRow | undefined;
    },
    subscribe: (fn: (e: RunEvent) => void) => {
      // Simplified: no real event bus subscription for this test
      return () => {};
    },
  };
}

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
  it("maps the task/instructions onto the snapshot", () => {
    expect(projectRow(row({ task: "summarize packages/ui" })).task).toBe("summarize packages/ui");
    expect(projectRow(row({ task: null })).task).toBeUndefined();
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

  it("pins exempt a finished run from eviction, float it to the top, and toggle", () => {
    let now = 1000;
    const src = new FakeSource();
    src.rows.set("r1", row({ id: "r1", name: "keep", status: "done", started_at: 0, ended_at: 0 }));
    src.rows.set("r2", row({ id: "r2", name: "drop", status: "done", started_at: 0, ended_at: 0 }));
    const store = new AgentStore(src, () => now);
    store.start();
    expect(store.snapshot().map(a => a.runId).sort()).toEqual(["r1", "r2"]);

    expect(store.togglePin("r1")).toBe(true);
    expect(store.isPinned("r1")).toBe(true);
    expect(store.pinnedIds()).toEqual(["r1"]);

    now = 1_000_000; // far past RETENTION_MS
    const ids = store.snapshot().map(a => a.runId);
    expect(ids).toContain("r1");     // pinned → retained after completion
    expect(ids).not.toContain("r2"); // unpinned → evicted
    expect(ids[0]).toBe("r1");       // pinned floats to the top

    expect(store.togglePin("r1")).toBe(false); // unpin
    expect(store.isPinned("r1")).toBe(false);
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

  it("retains first-event activity in recentActivity", () => {
    // This test uses a real DB to ensure events are properly folded even on first sight
    const db = openDb(scratchDbPath("store-first-event")); opened.push(db); migrate(db, "project");
    
    // Insert a run
    db.prepare(`INSERT INTO runs (id, session_id, agent, status, step_count, token_count, started_at)
                VALUES ('r1','s1','worker','running',0,0,?)`).run(Date.now());
    
    const src = createRunSource(db, "s1");
    const store = new AgentStore(src);
    store.start();
    
    // Verify the run is in the store but has no activity yet
    expect(store.snapshot().length).toBe(1);
    expect(store.snapshot()[0].recentActivity).toEqual([]);
    
    // Emit a summary-bearing activity event (first event for this run).
    // tool_result/log/message feed the activity tail (status/handoff intentionally do not).
    const event: RunEvent = {
      runId: "r1",
      sessionId: "s1",
      ts: Date.now(),
      type: "tool_result",
      summary: "analyzing context",
    };
    appendRunEvent(db, event);
    
    // Manually trigger ingest (simulate what would happen via subscribe)
    (store as any).ingest(event);
    
    // The first event's summary should be retained in recentActivity
    const snap = store.snapshot()[0];
    expect(snap.recentActivity).toContain("analyzing context");
    expect(snap.activity).toBe("analyzing context");
    
    store.stop();
  });

  it("caps handoffs history to a bounded window", () => {
    const src = new FakeSource();
    const store = new AgentStore(src);
    store.start();
    
    // Emit more than 64 handoff events
    for (let i = 0; i < 100; i++) {
      src.emit({
        runId: `r${i}`,
        sessionId: "s",
        ts: Date.now() + i,
        type: "handoff",
        payload: { from: `r${i}`, to: `r${i + 1}`, phase: "review" },
      });
    }
    
    const edges = store.edges();
    // Should be capped at 64
    expect(edges.length).toBe(64);
    // Should contain the most recent handoffs (last 64)
    expect(edges[edges.length - 1].from).toBe("r99");
    expect(edges[0].from).toBe("r36"); // 100 - 64 = 36
    
    store.stop();
  });
});

  it("projectRow maps the thinking level", () => {
    const snap = projectRow(row({ id: "r", session_id: "s", agent: "worker", name: "n", role: null, status: "running", phase: null, model: "m", task: null, thinking: "medium", step_count: 0, token_count: 0, started_at: 0, ended_at: null, result: null }));
    expect(snap.thinking).toBe("medium");
  });

import { AgentStore as _AS } from "../agents/store";
describe("AgentStore footer selection", () => {
  function mk(rows: any[]) {
    const src: any = { listActive: () => rows, getRun: (id: string) => rows.find((r) => r.id === id), subscribe: () => () => {} };
    const s = new _AS(src); s.start(); return s;
  }
  it("begin/move/selectedRunId/end run over snapshot order", () => {
    const s = mk([
      { id: "a", session_id: "x", agent: "worker", name: "a", status: "running", step_count: 0, token_count: 0, started_at: 0 },
      { id: "b", session_id: "x", agent: "worker", name: "b", status: "running", step_count: 0, token_count: 0, started_at: 0 },
    ]);
    expect(s.isSelecting()).toBe(false);
    expect(s.selectedRunId()).toBeUndefined();
    s.beginSelect();
    expect(s.isSelecting()).toBe(true);
    expect(s.selectedRunId()).toBe("a");
    s.moveSelect(1); expect(s.selectedRunId()).toBe("b");
    s.moveSelect(5); expect(s.selectedRunId()).toBe("b"); // clamped
    s.moveSelect(-10); expect(s.selectedRunId()).toBe("a"); // clamped
    s.endSelect(); expect(s.isSelecting()).toBe(false);
  });
});
