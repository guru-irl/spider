import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { openDbAt, bus, type Db } from "@spider/db-core";
import { RunStore } from "../run-store";
import { Runner } from "../runner";
import { RunEventTailer } from "../event-tailer";
import { ownRpcChild, createEventGate, MAX_BUFFERED_PERSISTED } from "../rpc-child";
import { makeRunHandler, makeAsyncNotifier, adoptReloadedChildren } from "../actions/run";
import { makeMessageHandler } from "../actions/message";
import { detachForReload, teardownAll } from "../coordinators";
import { adoptShared, detachShared, disposeSessionRegistries, registerShared, resetSharedRegistryForTests, sweepDetachedOnExit } from "../child-registry";
import { testScratchPath } from "./helpers/testutil";
import { randomUUID } from "node:crypto";

const dbs: Db[] = [];
interface RpcFixture {
  child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };
  commands: any[];
  rpc: ReturnType<typeof ownRpcChild>;
  out(event: any): boolean;
  reply(command: any): boolean;
}
const streams: RpcFixture[] = [];
const offs: Array<() => void> = [];
beforeEach(() => resetSharedRegistryForTests());
afterEach(() => {
  for (const off of offs.splice(0)) off();
  for (const f of streams.splice(0)) {
    f.child.emit("exit", 0);
    f.child.stdin.destroy(); f.child.stdout.destroy(); f.child.stderr.destroy();
  }
  teardownAll(); resetSharedRegistryForTests(); vi.useRealTimers(); vi.restoreAllMocks();
  for (const db of dbs.splice(0)) if (db.raw.open) db.close();
});
const tick = async () => { await new Promise<void>(r => setImmediate(r)); };
function database() {
  const path = testScratchPath(`reload-merge-${randomUUID()}.db`);
  const db = openDbAt(path, "project"); dbs.push(db);
  return { db, path, store: new RunStore(db) };
}
function rpcFixture(sink?: (event: Record<string, any>) => void): RpcFixture {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const commands: any[] = [];
  child.stdin.on("data", chunk => commands.push(JSON.parse(String(chunk))));
  const rpc = ownRpcChild(child as unknown as ChildProcess, "initial task", sink);
  const out = (event: any) => child.stdout.write(JSON.stringify(event) + "\n");
  const reply = (command: any) => out({ type: "response", id: command.id, success: true });
  reply(commands[0]); out({ type: "agent_start" });
  const f = { child, commands, rpc, out, reply }; streams.push(f); return f;
}
const queue = (text: string[]) => ({ type: "queue_update", steering: text, followUp: [] });
const user = (text: string) => ({ type: "message_start", message: { role: "user", content: text } });

// Break: capturing the first activation's sink in any steer callback loses its gap event.
it.each(["deadline", "late reply", "message_start", "settle", "waiter deadline", "exit", "abort"])("replays %s steer evidence through the rebound gate, never the old sink", async boundary => {
  vi.useFakeTimers();
  const old: any[] = [], next: any[] = [];
  const f = rpcFixture(e => old.push(e));
  const ack = f.rpc.steer("original"), command = f.commands.at(-1);
  old.length = 0; f.rpc.unbindEvents();
  if (boundary === "deadline" || boundary === "late reply") {
    await vi.advanceTimersByTimeAsync(10_000); await ack;
    if (boundary === "late reply") f.reply(command);
  } else if (boundary === "message_start") {
    f.out(queue(["original"])); f.reply(command); await ack;
    f.out(queue([])); f.out(user("original"));
  } else if (boundary === "settle") {
    const waiter = f.rpc.steer("waiter"); f.out({ type: "agent_settled" });
    expect(await waiter).toMatchObject({ delivery: "refused" }); await ack;
    expect(f.child.stdin.writableEnded).toBe(true);
  } else if (boundary === "waiter deadline") {
    const waiter = f.rpc.steer("waiter"); await vi.advanceTimersByTimeAsync(10_000);
    expect(await waiter).toMatchObject({ delivery: "refused" }); await ack;
  } else if (boundary === "exit") {
    f.child.emit("exit", 1); await ack;
  } else {
    f.out(queue(["original"])); f.out(queue([])); f.out(user("original"));
    const stop = f.rpc.abort(); f.reply(f.commands.at(-1)); await stop;
    expect(await ack).toMatchObject({ delivery: "delivered" });
  }
  expect(old).toEqual([]);
  f.rpc.bindEvents(e => next.push(e));
  const deliveries = next.filter(e => e.type === "steer_delivery");
  expect(deliveries.length).toBeGreaterThan(0);
  const expected = boundary === "message_start" || boundary === "abort" ? "delivered"
    : boundary === "late reply" ? "accepted but not confirmed" : "no reply yet, delivery unknown";
  expect(deliveries.findLast(e => e.steer === "original").delivery).toBe(expected);
  if (boundary === "deadline") {
    f.out(queue(["original"])); f.reply(command); f.out(queue([])); f.out(user("original"));
    expect(next.filter(e => e.type === "steer_delivery").at(-1).delivery).toBe("delivered");
    expect(old).toEqual([]);
  }
});

// Break: resetting pending steers at detach, losing the raw handle, or dropping diagnostics on adoption.
it("an unanswered pre-reload steer resolves after adoption and the new message tool steers the same child", async () => {
  const r = database(), oldPi = { sendMessage: vi.fn() }, newPi = { sendMessage: vi.fn() };
  let finish!: (exit: { exitCode: number; result?: string }) => void;
  const exit = new Promise<{ exitCode: number; result?: string }>(resolve => { finish = resolve; });
  let f!: ReturnType<typeof rpcFixture>;
  const runner = new Runner(r.db, "merge", process.cwd(), { store: r.store, tailer: new RunEventTailer(r.db), dbPath: r.path,
    scratchRoot: testScratchPath("merge-runs"), childMode: "rpc", modelRegistry: { find: () => ({ reasoning: true, thinkingLevelMap: { xhigh: "extra", max: null } }) },
    spawn: spec => {
      f = rpcFixture(spec.onRpcEvent);
      return { wait: () => exit, kill() {}, detach() {}, steer: f.rpc.steer, bindEvents: f.rpc.bindEvents, unbindEvents: f.rpc.unbindEvents };
    }, onComplete: makeAsyncNotifier({ db: r.db, pi: oldPi }) });
  const row = runner.runAsync({ agent: "worker", task: "fixture", model: "acme/model", thinking: "max", context: "fresh" });
  const first = makeMessageHandler()({ to: row.id, message: "before reload" }, { db: r.db, sessionId: "merge" });
  const command = f.commands.at(-1);
  await detachForReload("merge");
  r.db.close();
  // Exact conversation entry during the gap is proof even before the RPC reply.
  f.out(queue(["before reload"])); f.out(queue([])); f.out(user("before reload"));
  expect(oldPi.sendMessage).not.toHaveBeenCalled();
  const nextDb = openDbAt(r.path, "project"); dbs.push(nextDb);
  const ctx = { db: nextDb, runDbPath: r.path, sessionId: "merge", cwd: process.cwd(), pi: newPi };
  expect(adoptReloadedChildren(ctx).adopted).toEqual([row.id]);
  f.reply(command);
  expect((await first).details.delivery).toBe("delivered");
  const second = makeMessageHandler()({ to: row.id, message: "after reload" }, ctx);
  f.out(queue(["after reload"])); f.reply(f.commands.at(-1));
  expect((await second).details.delivery).toBe("accepted but not confirmed");
  f.out(queue([])); f.out(user("after reload")); f.out({ type: "agent_settled" });
  finish({ exitCode: 0, result: "report" }); await tick();
  expect(newPi.sendMessage).toHaveBeenCalledTimes(1);
  const notice = newPi.sendMessage.mock.calls[0][0];
  expect(notice.content).toContain("2 steer(s) delivered.");
  expect(notice.content).toContain("thinking capped: requested max");
  expect(oldPi.sendMessage).not.toHaveBeenCalled();
  expect(new RunStore(nextDb).get(row.id)).toMatchObject({ status: "done", thinking: "xhigh" });
  expect(adoptReloadedChildren(ctx).adopted).toEqual([]);
  expect(newPi.sendMessage).toHaveBeenCalledTimes(1);
});

async function parkedRun(finished: boolean) {
  const r = database();
  const { id } = r.store.create({ sessionId: "atomic-gap", agent: "worker" }); r.store.start(id);
  let finish!: (exit: { exitCode: number; result?: string }) => void;
  const exit = new Promise<{ exitCode: number; result?: string }>(resolve => { finish = resolve; });
  const gate = createEventGate();
  registerShared({ runId: id, sessionId: "atomic-gap", dbPath: r.path, mode: "rpc", survivable: true,
    handle: { wait: () => exit, kill() {}, killAsync: async () => {}, bindEvents: gate.bind, unbindEvents: gate.unbind } });
  await detachShared("atomic-gap", { ttlMs: 100 });
  if (finished) { finish({ exitCode: 0, result: "report" }); await Promise.resolve(); }
  return { ...r, id };
}
async function dispose(mode: string) {
  if (mode === "quit") await disposeSessionRegistries("atomic-gap", "Session shutdown cancelled this run.");
  else if (mode === "exit") sweepDetachedOnExit();
  else {
    if (mode === "failed adoption") adoptShared("atomic-gap", () => { throw new Error("fixture rebind failure"); });
    await vi.advanceTimersByTimeAsync(101);
  }
}

// Break: a detached finish uses two autocommit writes, or publishes before the transaction commits.
it.each(["ttl", "quit", "exit", "failed adoption"])("%s rolls back a gap completion when the terminal event insert fails", async mode => {
  vi.useFakeTimers(); const r = await parkedRun(true);
  r.db.exec(`CREATE TRIGGER reject_terminal BEFORE INSERT ON run_events WHEN NEW.type='status'
    BEGIN SELECT RAISE(ABORT, 'fixture terminal insert failed'); END`);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  await dispose(mode);
  expect(r.store.get(r.id)?.status).toBe("running");
  expect(r.db.prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id=? AND type='status'").get(r.id)).toEqual({ n: 0 });
  expect(warning.mock.calls.flat().join(" ")).toContain("fixture terminal insert failed");
});
it.each([true, false])("detached finalization publishes only committed status on a separate connection (finished=%s)", async finished => {
  const r = await parkedRun(finished);
  const reader = openDbAt(r.path, "project"); dbs.push(reader);
  const seen: any[] = [];
  offs.push(bus.on(e => {
    if (e.runId === r.id && e.type === "status") seen.push({ payload: e.payload,
      row: reader.prepare("SELECT status FROM runs WHERE id=?").get(r.id) });
  }));
  await disposeSessionRegistries("atomic-gap", "Session shutdown cancelled this run.");
  expect(seen).toEqual([{ payload: { status: finished ? "done" : "cancelled" }, row: { status: finished ? "done" : "cancelled" } }]);
});

// Break: adopting a gap completion without replaying steers or reading thinking/reload warnings.
it("a pipeline stage finished in the gap notifies once with steer, thinking and reload diagnostics", async () => {
  const r = database(), oldPi = { sendMessage: vi.fn() }, pi = { sendMessage: vi.fn() };
  let f!: ReturnType<typeof rpcFixture>, finish!: (exit: { exitCode: number; result?: string }) => void;
  const exit = new Promise<{ exitCode: number; result?: string }>(resolve => { finish = resolve; });
  let spawned = 0;
  const handler = makeRunHandler({ spawner: spec => {
    spawned++; f = rpcFixture(spec.onRpcEvent);
    return { wait: () => exit, kill() {}, detach() {}, steer: f.rpc.steer, bindEvents: f.rpc.bindEvents, unbindEvents: f.rpc.unbindEvents };
  } });
  const ctx = { db: r.db, runDbPath: r.path, sessionId: "pipeline-gap", cwd: process.cwd(), pi: oldPi,
    modelRegistry: { find: () => ({ reasoning: true, thinkingLevelMap: { xhigh: "extra", max: null } }) } };
  const result = await handler({ pipeline: [
    { agent: "worker", task: "one", model: "acme/model", thinking: "max" },
    { agent: "reviewer", task: "two", model: "acme/model", thinking: "high" },
  ] }, ctx);
  const first = f.rpc.steer("swallowed");
  await detachForReload("pipeline-gap");
  f.reply(f.commands.at(-1)); expect((await first).delivery).toBe("accepted but not confirmed");
  f.out({ type: "agent_settled" }); finish({ exitCode: 0, result: "stage report" }); await tick();
  expect(oldPi.sendMessage).not.toHaveBeenCalled();
  const next = { ...ctx, pi };
  adoptReloadedChildren(next); await tick(); adoptReloadedChildren(next); await tick();
  expect(spawned).toBe(1); expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  expect(pi.sendMessage.mock.calls[0][0].content).toContain("1 steer(s) accepted but not confirmed.");
  expect(pi.sendMessage.mock.calls[0][0].content).toContain("thinking capped: requested max");
  expect(pi.sendMessage.mock.calls[0][0].content).toContain("remaining stages were not started");
  expect(r.store.get(result.details.firstRunId)?.status).toBe("done");
});

// Break: an unconditional event after a guarded finish fabricates a second terminal outcome.
it("detached finalization does not emit a terminal event when a sibling won the guarded finish", async () => {
  const r = await parkedRun(true), reader = openDbAt(r.path, "project"); dbs.push(reader);
  const finish = RunStore.prototype.finish;
  let raced = false;
  vi.spyOn(RunStore.prototype, "finish").mockImplementation(function (this: RunStore, id, patch, opts) {
    if (!raced && id === r.id) {
      raced = true;
      finish.call(new RunStore(reader), id, { status: "done", result: "sibling report" });
    }
    return finish.call(this, id, patch, opts);
  });
  await disposeSessionRegistries("atomic-gap", "shutdown");
  expect(raced).toBe(true);
  expect(r.store.get(r.id)).toMatchObject({ status: "done", result: "sibling report" });
  expect(r.db.prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id=? AND type='status'").get(r.id)).toEqual({ n: 0 });
});

// Break: counting every non-delivered steer as accepted, or retaining uncertainty after delivery.
it("never-adopted finalization distinguishes unknown and refused steers and retains observed delivery", async () => {
  const r = database(); const { id } = r.store.create({ sessionId: "counts", agent: "worker" }); r.store.start(id);
  const gate = createEventGate();
  registerShared({ runId: id, sessionId: "counts", dbPath: r.path, mode: "rpc", survivable: true,
    handle: { wait: () => new Promise(() => {}), kill() {}, bindEvents: gate.bind, unbindEvents: gate.unbind } });
  await detachShared("counts");
  for (const payload of [
    { requestId: "late", delivery: "no reply yet, delivery unknown", delivered: false },
    { requestId: "late", delivery: "delivered", delivered: true },
    { requestId: "late", delivery: "accepted but not confirmed", delivered: false },
    { requestId: "hung", delivery: "no reply yet, delivery unknown", delivered: false },
    { requestId: "waiter", delivery: "refused", delivered: false },
    { requestId: "swallowed", delivery: "accepted but not confirmed", delivered: false },
  ]) gate.report({ type: "steer_delivery", ...payload, steer: "private instruction" });
  await disposeSessionRegistries("counts", "shutdown");
  expect(r.store.get(id)?.result).toBe("shutdown\n\n1 steer(s) delivered.\n1 steer(s) accepted but not confirmed.\n1 steer(s) no reply yet, delivery unknown.\n1 steer(s) refused.\n\n6 buffered child event(s) were not recorded because this run was never re-adopted.");
  expect(r.db.prepare("SELECT * FROM run_events WHERE type='steer_delivery'").all()).toEqual([]);
});

// Break: losing reload overflow when the truthful steer summary replaces the old summary.
it("a gap completion retains both truthful steer counts and persisted overflow loss", async () => {
  const r = database(), pi = { sendMessage: vi.fn() };
  let f!: ReturnType<typeof rpcFixture>, finish!: (exit: { exitCode: number; result?: string }) => void;
  const exit = new Promise<{ exitCode: number; result?: string }>(resolve => { finish = resolve; });
  const runner = new Runner(r.db, "overflow", process.cwd(), { store: r.store, tailer: new RunEventTailer(r.db), dbPath: r.path, scratchRoot: testScratchPath("overflow"),
    spawn: spec => { f = rpcFixture(spec.onRpcEvent); return { wait: () => exit, kill() {}, detach() {}, bindEvents: f.rpc.bindEvents, unbindEvents: f.rpc.unbindEvents }; } });
  const row = runner.runAsync({ agent: "worker", task: "fixture", context: "fresh" });
  await detachForReload("overflow");
  for (let i = 0; i < MAX_BUFFERED_PERSISTED + 1; i++) f.rpc.report({ type: "warning", message: "gap warning" });
  f.rpc.report({ type: "steer_delivery", requestId: "kept", delivery: "no reply yet, delivery unknown", delivered: false });
  finish({ exitCode: 0, result: "report" }); await tick();
  adoptReloadedChildren({ db: r.db, runDbPath: r.path, sessionId: "overflow", cwd: process.cwd(), pi }); await tick();
  expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  expect(pi.sendMessage.mock.calls[0][0].content).toContain("1 steer(s) no reply yet, delivery unknown.");
  expect(pi.sendMessage.mock.calls[0][0].content).toContain("2 child event(s) were lost during reload");
});

// Break: dropping earlier chain thinking notices or treating a reload cancellation as a live turn.
it("a chain killed on reload keeps each completed step's thinking notice without triggering the old pi", async () => {
  const r = database(), pi = { sendMessage: vi.fn() };
  let spawned = 0, finish!: (exit: { exitCode: number; result?: string }) => void;
  const exit = new Promise<{ exitCode: number; result?: string }>(resolve => { finish = resolve; });
  const handler = makeRunHandler({ spawner: () => {
    if (++spawned === 1) return { wait: async () => ({ exitCode: 0, result: "first report" }), kill() {}, detach() {} };
    return { wait: () => exit, kill() { finish({ exitCode: 143 }); }, killAsync: async () => { finish({ exitCode: 143 }); }, detach() {} };
  } });
  const result = await handler({ chain: [
    { task: "one", model: "acme/model", thinking: "max" },
    { task: "two", model: "acme/model", thinking: "low" },
    { task: "three", model: "acme/model", thinking: "high" },
  ] }, { db: r.db, runDbPath: r.path, sessionId: "chain", cwd: process.cwd(), childMode: "print", pi,
    modelRegistry: { find: () => ({ reasoning: true, thinkingLevelMap: { xhigh: "extra", max: null, low: null } }) } });
  expect(result.content).toContain("step 1: thinking capped");
  expect(result.content).toContain("step 2: thinking adjusted");
  await tick(); await detachForReload("chain"); await tick();
  expect(spawned).toBe(2);
  expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  expect(pi.sendMessage.mock.calls[0][0].content).toContain("step 1: thinking capped");
  expect(pi.sendMessage.mock.calls[0][0].content).toContain("step 2: thinking adjusted");
  expect(pi.sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: false, deliverAs: "nextTurn" });
});
