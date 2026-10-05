import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDbAt, type Db } from "@spider/db-core";
import * as coordinators from "../coordinators";
import { adoptShared, resetSharedRegistryForTests } from "../child-registry";
import { Runner, type ChildHandle } from "../runner";
import { RunStore } from "../run-store";
import { RunEventTailer } from "../event-tailer";
import { emitIntent, emitMessage, emitStatus, emitToolResult } from "../run-events";

const task = { agent: "worker", task: "fixture task", context: "fresh" as const };

describe("active children in the session registry", () => {
  let root: string;
  let db: Db;
  let tailer: RunEventTailer;
  beforeEach(() => {
    const scratch = resolve(".spider/scratch/warm-while-subagents/fixtures");
    mkdirSync(scratch, { recursive: true });
    root = mkdtempSync(join(scratch, "children-"));
    db = openDbAt(join(root, "project.db"), "project");
    tailer = new RunEventTailer(db);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    coordinators.teardownAll();
    resetSharedRegistryForTests();
    vi.useRealTimers();
    tailer.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function fixture(sessionId = "parent", kill: () => void = () => {}) {
    let settle!: (exit: { exitCode: number; result?: string }) => void;
    const wait = new Promise<{ exitCode: number; result?: string }>(resolve => { settle = resolve; });
    let rpcEvent!: (event: Record<PropertyKey, unknown>) => void;
    const handle: ChildHandle = { wait: () => wait, kill, detach() {} };
    const store = new RunStore(db);
    const runner = new Runner(db, sessionId, root, {
      store, tailer, dbPath: join(root, "project.db"), scratchRoot: root,
      spawn: spec => { rpcEvent = spec.onRpcEvent!; return handle; },
    });
    return { runner, store, handle, settle, rpcEvent: (event: Record<PropertyKey, unknown>) => rpcEvent(event) };
  }

  function count(sessionId = "parent") {
    expect(coordinators.activeChildCount).toBeTypeOf("function");
    return coordinators.activeChildCount(sessionId);
  }

  it("counts only the current session's handles without reading a database", () => {
    fixture().runner.runAsync(task);
    fixture("other").runner.runAsync(task);
    vi.spyOn(db, "prepare").mockImplementation(() => { throw new Error("no DB reads allowed during cache decisions"); });
    expect(count()).toBe(1);
    expect(count("other")).toBe(1);
    expect(count("absent")).toBe(0);
    expect(count("")).toBe(0);
  });

  it("counts multiple active runs", () => {
    fixture().runner.runAsync(task);
    fixture().runner.runAsync(task);
    expect(count()).toBe(2);
  });

  it.each([0, 1])("does not count a finished child after exit code %s", async exitCode => {
    const f = fixture();
    f.runner.runAsync(task);
    expect(count()).toBe(1);
    f.settle({ exitCode, result: "fixture result" });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(count()).toBe(0);
  });

  it("does not count cancellation while the child is still shutting down", () => {
    const f = fixture();
    const row = f.runner.runAsync(task);
    vi.spyOn(f.store, "cancel").mockImplementation(() => { throw new Error("fixture DB cancel failed"); });
    f.handle.kill("cancel fixture");
    expect(f.store.get(row.id)?.status).toBe("running");
    expect(f.handle.runStatus).toBe("running");
    expect(count()).toBe(0);
  });

  it("counts a reload-adopted child until it exits", async () => {
    const f = fixture();
    const row = f.runner.runAsync(task);
    expect(count()).toBe(1);
    await coordinators.detachForReload("parent");
    expect(count()).toBe(0);
    const reloaded = fixture();
    expect(adoptShared("parent", entry => reloaded.runner.adopt(entry)).adopted).toEqual([row.id]);
    expect(count()).toBe(1);
    f.settle({ exitCode: 0, result: "fixture result" });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(count()).toBe(0);
    expect(reloaded.store.get(row.id)?.status).toBe("done");
  });

  it("stops counting a silent child after 60 minutes without changing its run status", () => {
    vi.useFakeTimers();
    const f = fixture();
    const row = f.runner.runAsync(task);
    vi.advanceTimersByTime(60 * 60_000 - 1);
    expect(count()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(count()).toBe(0);
    expect(f.store.get(row.id)?.status).toBe("running");
    expect(f.handle.runStatus).toBe("running");
    expect(coordinators.getChild("parent", row.id)).toBe(f.handle);
  });

  it.each(["status", "tool_intent", "tool_result", "message"] as const)("resets the silence clock on a child's %s event", type => {
    vi.useFakeTimers();
    const f = fixture();
    const row = f.runner.runAsync(task);
    vi.advanceTimersByTime(60 * 60_000 + 1);
    expect(count()).toBe(0);
    const event = { runId: row.id, sessionId: "parent", tool: "fixture", status: "running" };
    if (type === "status") emitStatus(db, event);
    else if (type === "tool_intent") emitIntent(db, event);
    else if (type === "tool_result") emitToolResult(db, event);
    else emitMessage(db, event);
    expect(count()).toBe(1);
    vi.advanceTimersByTime(60 * 60_000 - 1);
    expect(count()).toBe(1);
    vi.advanceTimersByTime(2);
    expect(count()).toBe(0);
  });

  it("keeps a child active if cancellation fails and the row is restored", () => {
    const f = fixture("parent", () => { throw new Error("kill failed"); });
    f.runner.runAsync(task);
    expect(() => f.handle.kill("cancel fixture")).toThrow("kill failed");
    expect(count()).toBe(1);
  });

  it("does not count a failed launch", () => {
    const runner = new Runner(db, "parent", root, {
      store: new RunStore(db), tailer, dbPath: join(root, "project.db"), scratchRoot: root,
      spawn: () => { throw new Error("fixture launch failure"); },
    });
    expect(runner.runAsync(task).status).toBe("failed");
    expect(count()).toBe(0);
  });

  it.each(["done", "cancelled", "failed", "paused"] as const)("honors a child's %s status event before process exit", status => {
    const f = fixture();
    const row = f.runner.runAsync(task);
    emitStatus(db, { runId: row.id, sessionId: "parent", status });
    expect(count()).toBe(0);
  });

  it("ignores other-session and malformed status events", () => {
    const row = fixture().runner.runAsync(task);
    emitStatus(db, { runId: row.id, sessionId: "other", status: "done" });
    emitStatus(db, { runId: row.id, sessionId: "parent", status: "invalid" });
    expect(count()).toBe(1);
  });

  it("releases status tracking for unregistered handles and reinstalls it for new children", () => {
    const f = fixture();
    const row = f.runner.runAsync(task);
    coordinators.unregisterChild("parent", row.id);
    emitStatus(db, { runId: row.id, sessionId: "parent", status: "done" });
    expect(f.handle.runStatus).toBe("running");
    const next = fixture().runner.runAsync(task);
    emitStatus(db, { runId: next.id, sessionId: "parent", status: "done" });
    expect(count()).toBe(0);
  });

  it("seeds terminal status when startup finalizes before handle registration", () => {
    const handle: ChildHandle = { wait: () => new Promise(() => {}), kill() {}, detach() {} };
    const runner = new Runner(db, "parent", root, {
      store: new RunStore(db), tailer, dbPath: join(root, "project.db"), scratchRoot: root,
      spawn: spec => {
        spec.onRpcEvent!({ type: "warning", message: "fixture prompt consumed during startup", [Symbol.for("spider.handledPrompt.v1")]: true });
        return handle;
      },
    });
    expect(runner.runAsync(task).status).toBe("failed");
    expect(count()).toBe(0);
  });

  it("does not count a failed handled prompt while the process has not exited", () => {
    const f = fixture();
    const row = f.runner.runAsync(task);
    f.rpcEvent({ type: "warning", message: "fixture prompt consumed", [Symbol.for("spider.handledPrompt.v1")]: true });
    expect(f.store.get(row.id)?.status).toBe("failed");
    // The handle stays owned for shutdown, but must no longer hold warming.
    expect(coordinators.getChild("parent", row.id)).toBeDefined();
    expect(count()).toBe(0);
  });
});
