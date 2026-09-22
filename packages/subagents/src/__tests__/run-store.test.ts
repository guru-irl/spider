import { describe, it, expect } from "vitest";
import { bus, type Db } from "@spider/db-core";
import { AgentStore, type RunEvent, type RunRow as UiRunRow, type RunSource } from "@spider/ui";
import { RunStore, deriveRunName } from "../run-store";
import { freshDb } from "./helpers/testutil";

function runSource(db: Db, sessionId: string): RunSource {
  return {
    listActive: () => db
      .prepare(`SELECT * FROM runs WHERE session_id = ? AND status IN ('queued','running','paused')`)
      .all(sessionId) as UiRunRow[],
    getRun: (id: string) => db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as UiRunRow | undefined,
    subscribe: (fn: (event: RunEvent) => void) => bus.on((event) => {
      if (event.sessionId === sessionId) fn(event);
    }),
  };
}

describe("deriveRunName", () => {
  it("is deterministic for the same input", () => {
    const input = { agent: "spider", role: "worker", task: "Implement Phase 4 Task 2 of the plan" };
    expect(deriveRunName(input)).toBe(deriveRunName(input));
  });

  it("slugifies the task into the name", () => {
    const name = deriveRunName({ agent: "spider", role: "worker", task: "Implement Phase 4 Task 2" });
    expect(name).toBe("worker:implement-phase-4-task");
  });

  it("never exceeds 48 characters", () => {
    const name = deriveRunName({
      agent: "spider",
      role: "worker",
      task: "This is a very long task description that keeps going and going and going",
    });
    expect(name.length).toBeLessThanOrEqual(48);
  });
});

describe("RunStore", () => {
  it("create() inserts a queued run that can be read back", () => {
    const store = new RunStore(freshDb());
    const { id, name } = store.create({ sessionId: "s1", agent: "spider", role: "worker", task: "do the thing" });
    const row = store.get(id);
    expect(row).toBeDefined();
    expect(row!.status).toBe("queued");
    expect(row!.name).toBe(name);
    expect(row!.session_id).toBe("s1");
  });

  it("start() then finish() transitions queued -> running -> done and sets timestamps", () => {
    const store = new RunStore(freshDb());
    const { id } = store.create({ sessionId: "s1", agent: "spider", task: "do the thing" });

    let row = store.get(id)!;
    expect(row.status).toBe("queued");
    expect(row.started_at).toBeFalsy();

    store.start(id);
    row = store.get(id)!;
    expect(row.status).toBe("running");
    expect(row.started_at).toBeTruthy();

    store.finish(id, { status: "done", result: "all good" });
    row = store.get(id)!;
    expect(row.status).toBe("done");
    expect(row.ended_at).toBeTruthy();
    expect(row.result).toBe("all good");
  });

  it("listActive() only returns non-terminal runs for the given session", () => {
    const store = new RunStore(freshDb());
    const { id: a } = store.create({ sessionId: "s1", agent: "spider", task: "a" });
    const { id: b } = store.create({ sessionId: "s1", agent: "spider", task: "b" });
    const { id: c } = store.create({ sessionId: "s2", agent: "spider", task: "c" });
    store.start(a);
    store.start(b);
    store.finish(b, { status: "done" });

    const active = store.listActive("s1");
    expect(active.map((r) => r.id)).toEqual([a]);
    expect(active.some((r) => r.id === c)).toBe(false);
  });

  it("linkChild() sets parent_run_id on the child run", () => {
    const store = new RunStore(freshDb());
    const { id: parentId } = store.create({ sessionId: "s1", agent: "spider", task: "parent" });
    const { id: childId } = store.create({ sessionId: "s1", agent: "spider", task: "child" });

    store.linkChild(childId, parentId);

    const child = store.get(childId)!;
    expect(child.parent_run_id).toBe(parentId);
  });

  it("persists and updates the thinking level on a run", () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id } = store.create({ sessionId: "s", agent: "worker", thinking: "medium" });
    expect(store.get(id)!.thinking).toBe("medium");
    store.updateProgress(id, { thinking: "high" });
    expect(store.get(id)!.thinking).toBe("high");
  });

  it("setPid() records the child pid and owning host pid", () => {
    const store = new RunStore(freshDb());
    const { id } = store.create({ sessionId: "s1", agent: "worker", task: "t" });
    store.setPid(id, 4242, 99);
    const row = store.get(id)!;
    expect(row.pid).toBe(4242);
    expect(row.host_pid).toBe(99);
  });

  it("cancel() emits a terminal status event that finishes the live UI projection", () => {
    const db = freshDb();
    const runs = new RunStore(db);
    const { id } = runs.create({ sessionId: "s1", agent: "worker", task: "t" });
    runs.start(id);
    const agents = new AgentStore(runSource(db, "s1"));
    agents.start();

    try {
      expect(agents.snapshot()[0]).toMatchObject({ runId: id, status: "running", endedAt: undefined });

      runs.cancel(id, "killed by orchestrator");

      const event = db.prepare(
        `SELECT type, payload FROM run_events WHERE run_id = ? AND type = 'status' ORDER BY id DESC LIMIT 1`
      ).get(id) as { type: string; payload: string } | undefined;
      expect(event).toBeDefined();
      expect(JSON.parse(event!.payload)).toEqual({ status: "cancelled" });
      expect(agents.snapshot()[0]).toMatchObject({ runId: id, status: "cancelled" });
      expect(agents.snapshot()[0].endedAt).toEqual(expect.any(Number));
    } finally {
      agents.stop();
    }
  });

  it("cancel() emits nothing and preserves the row when the run is already terminal", () => {
    const db = freshDb();
    const store = new RunStore(db);
    const { id } = store.create({ sessionId: "s1", agent: "worker", task: "t" });
    store.start(id);
    store.finish(id, { status: "done", result: "ok" });
    const before = store.get(id)!;

    store.cancel(id, "too late");

    expect(store.get(id)).toEqual(before);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM run_events WHERE run_id = ?`).get(id)).toEqual({ count: 0 });
  });
});

  it("CRITICAL: finish() does not overwrite a cancelled status (C2 regression)", () => {
    const store = new RunStore(freshDb());
    const { id } = store.create({ sessionId: "s1", agent: "worker", task: "t" });
    store.start(id);
    
    // Simulate the race: killRun calls cancel, then the dying child's shutdown handler calls finish
    store.cancel(id, "killed (was: edit src/a.ts)");
    store.finish(id, { status: "done" });
    
    // After fix: cancel wins, finish is no-op on terminal status
    const row = store.get(id)!;
    expect(row.status).toBe("cancelled");
    expect(row.result).toBe("killed (was: edit src/a.ts)");
  });
