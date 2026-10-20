// Ported from https://github.com/michael-denyer/pstack-claude,
// tests/pi/sleep-wait.test.mjs at 046341e. MIT licensed.
// Copyright (c) 2026 Lauren Tan
// Copyright (c) 2026 Michael Denyer
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openDbAt, type Db } from "@spider/db-core";
import { Runner, RunStore, RunEventTailer, emitStatus, teardownAll, type ChildHandle } from "@spider/subagents";
import { resetSharedRegistryForTests } from "../../../subagents/src/child-registry";
import { registerRouting, DEFAULT_ROUTING_CONFIG } from "../routing";

const task = { agent: "worker", task: "fixture task", context: "fresh" as const };
const sleep = { action: "exec", language: "shell", code: "sleep 30" };

describe("session foreground sleep guard", () => {
  let root: string;
  let db: Db;
  let tailer: RunEventTailer;
  let toolCall: (event: any, ctx?: any) => any;
  let currentSession: string;

  beforeEach(() => {
    const scratch = resolve(".spider/scratch/sleep-guard/fixtures");
    mkdirSync(scratch, { recursive: true });
    root = mkdtempSync(join(scratch, "routing-"));
    db = openDbAt(join(root, "project.db"), "project");
    tailer = new RunEventTailer(db);
    currentSession = "parent";
    const pi = {
      on(name: string, handler: typeof toolCall) { if (name === "tool_call") toolCall = handler; },
      registerTool() {},
    };
    registerRouting(pi as unknown as ExtensionAPI, {
      db, getSessionId: () => currentSession, getCwd: () => root,
      // This is a safety check, not activity tracking.
      config: { ...DEFAULT_ROUTING_CONFIG, tracking: false },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    teardownAll();
    resetSharedRegistryForTests();
    tailer.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function child(sessionId = "parent") {
    let settle!: (result: { exitCode: number; result: string }) => void;
    const wait = new Promise<{ exitCode: number; result: string }>(resolve => { settle = resolve; });
    const handle: ChildHandle = { wait: () => wait, kill() {}, detach() {} };
    const runner = new Runner(db, sessionId, root, {
      store: new RunStore(db), tailer, dbPath: join(root, "project.db"), scratchRoot: root,
      spawn: () => handle,
    });
    const row = runner.runAsync(task);
    return { handle, row, settle };
  }

  function call(input: any = sleep, sessionId?: string, toolName = "spider") {
    return toolCall({ toolName, toolCallId: "sleep-fixture", input },
      sessionId === undefined ? undefined : { sessionManager: { getSessionId: () => sessionId } });
  }

  it("blocks a foreground sleep only while a child runs, then allows it after completion", async () => {
    expect(call()).toBeUndefined();
    const running = child();
    expect(call()).toMatchObject({ block: true, reason: expect.stringContaining("Do not sleep or poll") });
    expect(call({ ...sleep, code: "sleep 1" })).toBeUndefined();
    running.settle({ exitCode: 0, result: "done" });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(call()).toBeUndefined();
  });

  it("directs external waits to spider schedule", () => {
    child();
    expect(call()).toMatchObject({ block: true, reason: expect.stringContaining("use spider schedule") });
  });

  it("does not block for another session's running child", () => {
    child("other");
    expect(call()).toBeUndefined();
    expect(call(sleep, "other")).toMatchObject({ block: true });
  });

  it("uses the tool event's session rather than the currently selected session", () => {
    child();
    currentSession = "other";
    expect(call(sleep, "parent")).toMatchObject({ block: true });
    expect(call()).toBeUndefined();
    currentSession = "parent";
    expect(call(sleep, "other")).toBeUndefined();
  });

  it("keeps blocking until the last running child ends", () => {
    const first = child();
    const second = child();
    emitStatus(db, { runId: first.row.id, sessionId: "parent", status: "done" });
    expect(call()).toMatchObject({ block: true });
    emitStatus(db, { runId: second.row.id, sessionId: "parent", status: "done" });
    expect(call()).toBeUndefined();
  });

  it.each(["done", "failed", "cancelled", "paused"] as const)("allows sleeps for a %s child before its process exits", status => {
    const running = child();
    expect(call()).toMatchObject({ block: true });
    emitStatus(db, { runId: running.row.id, sessionId: "parent", status });
    expect(call()).toBeUndefined();
  });

  it("ignores cancelled handles while they shut down", () => {
    const running = child();
    expect(call()).toMatchObject({ block: true });
    running.handle.kill("fixture cancellation");
    expect(call()).toBeUndefined();
  });

  it("does not confuse the cache warming silence cutoff with child completion", () => {
    const running = child();
    running.handle.lastEventAt = Date.now() - 2 * 60 * 60_000;
    expect(call()).toMatchObject({ block: true });
  });

  it("blocks a mixed batch before any shell sleep can run", () => {
    child();
    expect(call({ action: "batch", commands: [
      { language: "python", code: "print('sleep 30')" },
      { language: "shell", code: "echo ready" },
      { language: "shell", code: "sleep 30" },
    ] })).toMatchObject({ block: true });
  });

  it("allows a batch with only non-waits and non-shell sleep text", () => {
    child();
    expect(call({ action: "batch", commands: [
      { language: "python", code: "print('sleep 30')" },
      { language: "shell", code: "sleep 1" },
      { language: "shell", code: "sleep 30 &" },
    ] })).toBeUndefined();
  });

  it.each([
    { background: true },
    { background: true, timeout: 1 },
    { background: true, timeout: 60_000 },
    { background: false, timeout: 1 },
  ])("blocks foreground-shaped sleeps with execution options %j", options => {
    child();
    expect(call({ ...sleep, ...options })).toMatchObject({ block: true });
  });

  it("does not treat batch background options as a detach request", () => {
    child();
    expect(call({ action: "batch", background: true, timeout: 1,
      commands: [{ language: "shell", code: "sleep 30", background: true, timeout: 1 }],
    })).toMatchObject({ block: true });
  });

  it.each([
    { ...sleep, code: "sleep 30 &" },
    { ...sleep, code: "echo 'sleep 30'" },
    { ...sleep, language: "python" },
    { ...sleep, action: "exec_file", path: "fixture.sh" },
    { action: "schedule", delaySeconds: 60, prompt: "check external work" },
    { action: "batch", commands: [] },
  ])("leaves unrelated or non-wait calls alone: %j", input => {
    child();
    expect(call(input)).toBeUndefined();
  });

  it("does not apply this guard to another tool", () => {
    child();
    expect(call(sleep, undefined, "different-tool")).toBeUndefined();
  });

  it("skips command inspection and database access when no children run", () => {
    vi.spyOn(db, "prepare").mockImplementation(() => { throw new Error("guard must not query the database"); });
    const input = { action: "exec", get language(): string { throw new Error("guard must not inspect idle commands"); } };
    expect(call(input)).toBeUndefined();
  });

  it("checks running handles without reading the database", () => {
    child();
    vi.spyOn(db, "prepare").mockImplementation(() => { throw new Error("guard must not query the database"); });
    expect(call()).toMatchObject({ block: true });
  });
});
