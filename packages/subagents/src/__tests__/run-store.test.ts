import { describe, it, expect } from "vitest";
import { RunStore, deriveRunName } from "../run-store";
import { freshDb } from "./helpers/testutil";

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
});
