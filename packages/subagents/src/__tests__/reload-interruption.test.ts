import { afterEach, expect, it, vi } from "vitest";
import { RunStore } from "../run-store.js";
import { PipelineCoordinator } from "../pipeline.js";
import { makeRunHandler } from "../actions/run.js";
import * as coordinators from "../coordinators.js";
import {
  CHILD_REGISTRY_KEY, parkSession, registerShared, resetSharedRegistryForTests, setSink, sharedRegistry,
} from "../child-registry.js";
import { freshDb } from "./helpers/testutil.js";

const wouldInterrupt = coordinators.reloadWouldInterrupt;
const databases: ReturnType<typeof freshDb>[] = [];
const dbFixture = () => { const db = freshDb(); databases.push(db); return db; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

afterEach(async () => {
  await coordinators.teardownAllAsync({ graceMs: 1 });
  resetSharedRegistryForTests();
  for (const db of databases.splice(0)) db.close();
});

function child(sessionId: string, runId: string, survivable: boolean, durable: boolean) {
  const kill = vi.fn();
  const unbindEvents = vi.fn();
  const handle = { durable, wait: () => new Promise<{ exitCode: number }>(() => {}), kill, unbindEvents };
  const entry = registerShared({ sessionId, runId, survivable, handle, mode: "rpc", dbPath: "" });
  const sink = vi.fn();
  setSink(runId, sink);
  return { entry, kill, unbindEvents, sink };
}

it.each([
  ["foreground", false, false, true],
  ["non-survivable durable", false, true, true],
  ["background", true, false, false],
  ["durable background", true, true, false],
] as const)("reports whether a %s child would be removed by reload", (_label, survivable, durable, expected) => {
  const f = child("query-session", "run-1", survivable, durable);
  const registry = sharedRegistry();
  const before = { state: f.entry.state, timer: f.entry.timer, sink: f.entry.sink,
    detachedAt: f.entry.detachedAt, claimed: f.entry.claimed, keys: [...registry.entries.keys()] };
  expect(wouldInterrupt("query-session")).toBe(expected);
  expect(wouldInterrupt("another-session")).toBe(false);
  expect({ state: f.entry.state, timer: f.entry.timer, sink: f.entry.sink,
    detachedAt: f.entry.detachedAt, claimed: f.entry.claimed, keys: [...registry.entries.keys()] }).toEqual(before);
  expect(f.kill).not.toHaveBeenCalled();
  expect(f.unbindEvents).not.toHaveBeenCalled();
  expect(f.sink).not.toHaveBeenCalled();
  // Check reload's real selection separately, after proving the query left the registry untouched.
  expect(parkSession("query-session").map(entry => entry.runId)).toEqual(expected ? ["run-1"] : []);
});

it("does not block multiple ordinary background runs", () => {
  const first = child("background-session", "first", true, false);
  const second = child("background-session", "second", true, true);
  expect(wouldInterrupt("background-session")).toBe(false);
  expect(first.entry.state).toBe("attached");
  expect(second.entry.state).toBe("attached");
  expect(first.kill).not.toHaveBeenCalled();
  expect(second.kill).not.toHaveBeenCalled();
});

it("does not create a registry when queried before any child exists", () => {
  resetSharedRegistryForTests();
  expect((globalThis as Record<symbol, unknown>)[CHILD_REGISTRY_KEY]).toBeUndefined();
  expect(wouldInterrupt("empty-session")).toBe(false);
  expect((globalThis as Record<symbol, unknown>)[CHILD_REGISTRY_KEY]).toBeUndefined();
});

it("tracks a chain across its steps without blocking an earlier background run after completion", async () => {
  const db = dbFixture();
  const sessionId = "chain-session";
  const background = child(sessionId, "background", true, false);
  const finishes: Array<(row: { status: "done"; result: string }) => void> = [];
  const duringHandoff: Array<boolean | undefined> = [];
  const runner = {
    runForeground() {
      if (finishes.length) duringHandoff.push(wouldInterrupt(sessionId));
      return new Promise<{ status: "done"; result: string }>(resolve => finishes.push(resolve));
    },
  };
  const handler = makeRunHandler({ makeRunner: () => runner });
  const ctx = { db, sessionId, cwd: process.cwd(), runDbPath: db.raw.name, pi: {}, ui: { notify() {} } };
  expect(wouldInterrupt(sessionId)).toBe(false);
  await handler({ chain: [{ agent: "worker", task: "first" }, { agent: "worker", task: "second" }] }, ctx);
  expect(finishes).toHaveLength(1);
  expect(wouldInterrupt(sessionId)).toBe(true);
  finishes[0]({ status: "done", result: "first" });
  await flush();
  expect(finishes).toHaveLength(2);
  expect(duringHandoff).toEqual([true]);
  expect(wouldInterrupt(sessionId)).toBe(true);
  finishes[1]({ status: "done", result: "second" });
  await flush();
  expect(wouldInterrupt(sessionId)).toBe(false);
  expect(background.entry.state).toBe("attached");
  expect(background.kill).not.toHaveBeenCalled();
});

it("blocks until every concurrent chain completes", async () => {
  const db = dbFixture();
  const sessionId = "concurrent-chains";
  const finishes: Array<(row: { status: "done"; result: string }) => void> = [];
  const runner = { runForeground: () => new Promise<{ status: "done"; result: string }>(resolve => finishes.push(resolve)) };
  const handler = makeRunHandler({ makeRunner: () => runner });
  const ctx = { db, sessionId, cwd: process.cwd(), runDbPath: db.raw.name, pi: {}, ui: { notify() {} } };
  await handler({ chain: [{ agent: "worker" }] }, ctx);
  await handler({ chain: [{ agent: "worker" }] }, ctx);
  expect(finishes).toHaveLength(2);
  expect(wouldInterrupt(sessionId)).toBe(true);
  finishes[0]({ status: "done", result: "first" });
  await flush();
  expect(wouldInterrupt(sessionId)).toBe(true);
  finishes[1]({ status: "done", result: "second" });
  await flush();
  expect(wouldInterrupt(sessionId)).toBe(false);
});

it("unblocks reload when a chain step rejects", async () => {
  const db = dbFixture();
  const sessionId = "chain-failure";
  let rejectStep!: (error: Error) => void;
  const runForeground = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectStep = reject; }));
  const handler = makeRunHandler({ makeRunner: () => ({ runForeground }) });
  const ctx = { db, sessionId, cwd: process.cwd(), runDbPath: db.raw.name, pi: {}, ui: { notify() {} } };
  await handler({ chain: [{ agent: "worker" }, { agent: "worker" }] }, ctx);
  expect(wouldInterrupt(sessionId)).toBe(true);
  rejectStep(new Error("step failed"));
  await flush();
  expect(wouldInterrupt(sessionId)).toBe(false);
  expect(runForeground).toHaveBeenCalledOnce();
});

it("tracks an active pipeline across the handoff between stages", () => {
  const db = dbFixture();
  const sessionId = "pipeline-session";
  const store = new RunStore(db);
  const duringHandoff: Array<boolean | undefined> = [];
  const ids: string[] = [];
  const runner = { runAsync(options: { agent: string; task: string }) {
    if (ids.length) duringHandoff.push(wouldInterrupt(sessionId));
    const { id } = store.create({ sessionId, agent: options.agent, task: options.task });
    store.start(id); ids.push(id);
    return store.get(id);
  } };
  const pipeline = new PipelineCoordinator({ db, globalDb: db, store, runner, pi: {}, sessionId });
  const owned = coordinators.getCoordinators(sessionId, () => ({ tailer: { stop() {} } as never, pipelines: [], children: new Map() }));
  owned.pipelines.push(pipeline);
  pipeline.start({ pipeline: [{ agent: "worker", task: "first" }, { agent: "worker", task: "second" }], handoff: "intercom" });
  expect(wouldInterrupt(sessionId)).toBe(true);
  expect(wouldInterrupt("another-session")).toBe(false);
  store.finish(ids[0], { status: "done", result: "first" });
  pipeline.onRunTerminal(ids[0]);
  expect(duringHandoff).toEqual([true]);
  expect(wouldInterrupt(sessionId)).toBe(true);
  store.finish(ids[1], { status: "done", result: "second" });
  pipeline.onRunTerminal(ids[1]);
  expect(wouldInterrupt(sessionId)).toBe(false);
});

it("blocks until every concurrent pipeline completes", () => {
  const db = dbFixture();
  const sessionId = "concurrent-pipelines";
  const store = new RunStore(db);
  const ids: string[] = [];
  const runner = { runAsync(options: { agent: string; task: string }) {
    const { id } = store.create({ sessionId, agent: options.agent, task: options.task });
    store.start(id); ids.push(id);
    return store.get(id);
  } };
  const first = new PipelineCoordinator({ db, globalDb: db, store, runner, pi: {}, sessionId });
  const second = new PipelineCoordinator({ db, globalDb: db, store, runner, pi: {}, sessionId });
  const owned = coordinators.getCoordinators(sessionId, () => ({ tailer: { stop() {} } as never, pipelines: [], children: new Map() }));
  owned.pipelines.push(first, second);
  first.start({ pipeline: [{ agent: "worker" }], handoff: "intercom" });
  second.start({ pipeline: [{ agent: "worker" }], handoff: "intercom" });
  expect(wouldInterrupt(sessionId)).toBe(true);
  store.finish(ids[0], { status: "done", result: "first" });
  first.onRunTerminal(ids[0]);
  expect(wouldInterrupt(sessionId)).toBe(true);
  store.finish(ids[1], { status: "done", result: "second" });
  second.onRunTerminal(ids[1]);
  expect(wouldInterrupt(sessionId)).toBe(false);
});
