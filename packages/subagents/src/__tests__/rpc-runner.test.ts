import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { ownRpcChild } from "../rpc-child";
import { makeMessageHandler } from "../actions/message";
import { makeRunHandler, makeAsyncNotifier } from "../actions/run";
import { teardownAllAsync } from "../coordinators";
import { Runner, type ChildHandle } from "../runner";
import { RunStore } from "../run-store";
import { RunEventTailer } from "../event-tailer";
import { killRun } from "../kill";
import { getChild, teardownAll } from "../coordinators";
import { freshDb, testScratchPath } from "./helpers/testutil";
import { appendRunEvent, openDbAt, type Db } from "@spider/db-core";
const dbs: Db[] = [];
afterEach(() => { vi.useRealTimers(); teardownAll(); for (const db of dbs.splice(0)) db.close(); });
it("persists later non-delivery without rewriting the successful steer tool result", async () => {
  vi.useFakeTimers(); const db = freshDb(); dbs.push(db); const store = new RunStore(db);
  const child = Object.assign(new EventEmitter(), {stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
  const commands: any[] = []; child.stdin.on("data",chunk=>commands.push(JSON.parse(String(chunk))));
  let finish!:(v:any)=>void; const exit = new Promise<{exitCode:number,result:string}>(r=>{finish=r});
  const notifications: any[] = [];
  const onComplete = makeAsyncNotifier({ db, pi: { sendMessage(message: any) { notifications.push(message); } } });
  const runner = new Runner(db,"owner",testScratchPath("cwd"),{store,tailer:new RunEventTailer(db),scratchRoot:testScratchPath("steer-events"),dbPath:testScratchPath("fixture.db"),childMode:"rpc",onComplete,spawn:spec=>{
    const rpc = ownRpcChild(child as unknown as ChildProcess,spec.prompt!,spec.onRpcEvent);
    return {wait:()=>exit,steer:rpc.steer,detach(){},kill(){finish({exitCode:143})}};
  }});
  const row=runner.runAsync({agent:"worker",task:"work",context:"fresh"});
  try {
  const out=(e:any)=>child.stdout.write(JSON.stringify(e)+"\n");
  out({type:"response",id:commands[0].id,success:true}); out({type:"agent_start"});
  const message = makeMessageHandler()({to:row.id,message:"correction"},{db,sessionId:"owner"});
  const steer=commands.find(c=>c.type==="steer");
  out({type:"queue_update",steering:["correction"],followUp:[]}); out({type:"response",id:steer.id,success:true});
  const result=await message; expect(result.isError).toBe(false); expect(result.details.accepted).toBe(true);
  expect(result.content).toMatch(/accepted but not confirmed/);
  await vi.advanceTimersByTimeAsync(120_000); out({type:"agent_settled"});
  const event=db.prepare("SELECT payload FROM run_events WHERE run_id=? AND type='steer_delivery'").get(row.id) as {payload:string};
  expect(event).toBeTruthy();
  expect(JSON.parse(event.payload)).toMatchObject({delivered:false,steer:"correction"});
  expect(result.details.accepted).toBe(true); expect(child.stdin.writableEnded).toBe(true);
  } finally {
    finish({exitCode:0,result:"report"}); await exit; await Promise.resolve();
  }
  expect(store.get(row.id)?.result).toMatch(/1 steer.*accepted but not confirmed/i);
  expect(notifications).toHaveLength(1);
  expect(notifications[0].content).toMatch(/1 steer.*accepted but not confirmed/i);
  expect(notifications[0].details.output).toMatch(/1 steer.*accepted but not confirmed/i);
});
it.each(["rpc", "print"] as const)("persists actual %s launch and intercom capability before spawning", async childMode => {
  const db = freshDb(); dbs.push(db); const store = new RunStore(db); let spec: any;
  const globalDb = openDbAt(testScratchPath(`rpc-global-${childMode}.db`), "global"); dbs.push(globalDb);
  const runner = new Runner(db, "owner", testScratchPath("cwd"), { store, tailer: new RunEventTailer(db), scratchRoot: testScratchPath("rpc-runner"), dbPath: testScratchPath("fixture.db"), childMode, globalDb, intercomExtensions: ["intercom.ts"], spawn: (s: import("../pi-args").ChildSpawnSpec) => {
    spec = s;
    const runId = s.env.PI_SUBAGENT_RUN_ID;
    expect(globalDb.prepare("SELECT session_id,db_path FROM run_routes WHERE run_id=?").get(runId)).toEqual({ session_id: "owner", db_path: testScratchPath("fixture.db") });
    expect(store.get(runId)).toMatchObject({ child_mode: childMode, intercom_session: childMode === "rpc" ? expect.stringMatching(/^job-/) : null });
    appendRunEvent(db, { sessionId: "owner", runId, ts: Date.now(), type: "message", payload: { text: "finished report", stopReason: "stop" }, summary: "finished report" });
    return { pid: 4242, kill() {}, detach() {}, wait: async () => ({ exitCode: 0 }) };
  } } as any);
  const run = await runner.runForeground({ agent: "worker", name: "job", task: "work", context: "fresh" });
  expect(run.status).toBe("done"); expect(run.result).toBe("finished report"); expect(spec.childMode).toBe(childMode);
});
it.each(["rpc", "print"] as const)("a background %s run survives a later parent-turn abort", async childMode => {
  const db = freshDb(); dbs.push(db); const store = new RunStore(db); const abort = new AbortController(); let kills = 0;
  const handler = makeRunHandler({ spawner: () => ({ kill() { kills++; }, detach() {}, wait: () => new Promise(() => {}) }) });
  const result = await handler({ agent: "worker", task: "work" }, {db, sessionId: "owner", cwd: testScratchPath("cwd"), runDbPath: testScratchPath("fixture.db"), childMode, signal: abort.signal});
  const run = result.details.run;
  abort.abort();
  expect(kills).toBe(0); expect(store.get(run.id)?.status).toBe("running");
});
it("registers a foreground child for steering and shutdown while it is running", async () => {
  const db = freshDb(); dbs.push(db); const store = new RunStore(db); let finish!: (v: any) => void;
  const exit = new Promise<{ exitCode: number; result: string }>(resolve => { finish = resolve; });
  const handle: ChildHandle = { pid: 4242, kill() {}, detach() {}, wait: () => exit };
  const runner = new Runner(db, "owner", testScratchPath("cwd"), { store, tailer: new RunEventTailer(db), scratchRoot: testScratchPath("rpc-runner"), dbPath: testScratchPath("fixture.db"), spawn: () => handle });
  const pending = runner.runForeground({ agent: "worker", task: "work", context: "fresh" });
  const run = store.listActive("owner")[0];
  expect(getChild("owner", run.id)).toBe(handle);
  finish({ exitCode: 0, result: "report" }); await pending;
  expect(getChild("owner", run.id)).toBeUndefined();
});

it.each(["chain", "pipeline"])("shutdown cancels the live %s child, stops later stages and notifies the real cause", async mode => {
  const db = freshDb(); dbs.push(db); const globalDb = openDbAt(testScratchPath(`shutdown-global-${mode}.db`), "global"); dbs.push(globalDb);
  const sent: any[] = []; let spawned = 0; const abort = new AbortController();
  const handler = makeRunHandler({ spawner: () => {
    spawned++; let finish!: (v: any) => void;
    const exit = new Promise<{ exitCode: number }>(resolve => { finish = resolve; });
    return { wait: () => exit, detach() {}, kill() { finish({ exitCode: 143 }); } };
  } });
  const ctx = { db, globalDb, sessionId: mode, cwd: testScratchPath("cwd"), runDbPath: testScratchPath("fixture.db"), signal: abort.signal, pi: { sendMessage(m: any) { sent.push(m); } } };
  await handler({ [mode]: [{ agent: "worker", task: "first" }, { agent: "worker", task: "second" }] }, ctx);
  abort.abort(); // The returned tool's signal cannot own either background mode.
  expect(new RunStore(db).listActive(mode)).toHaveLength(1);
  await teardownAllAsync();
  await vi.waitFor(() => expect(sent.some(m => m.details?.status === "cancelled")).toBe(true));
  expect(spawned).toBe(1);
  expect(sent.find(m => m.details?.status === "cancelled").details.output).toMatch(/session.*shutdown/i);
  expect(new RunStore(db).listActive(mode)).toHaveLength(0);
});

it("continues launch with a run-detail warning when optional intercom resolution fails", async () => {
  const db = freshDb(); dbs.push(db); const globalDb = openDbAt(testScratchPath("resolver-failure.db"), "global"); dbs.push(globalDb);
  const handler = makeRunHandler({ resolveIntercom: async () => { throw new Error("ELOCKED fixture settings"); }, spawner: () => ({ wait: async () => ({ exitCode: 0, result: "report" }), kill() {}, detach() {} }) });
  const result = await handler({ agent: "worker", task: "work" }, { db, globalDb, sessionId: "resolver", cwd: testScratchPath("cwd"), runDbPath: testScratchPath("fixture.db") });
  expect(result.details.warning).toMatch(/cross-session steering unavailable/i);
  expect(result.details.run.child_mode).toBe("rpc");
});

it.each(["foreground", "background"])("a %s launch-time pid write failure kills the spawned child and finalizes failed", async mode => {
  const db = freshDb(); dbs.push(db); const store = new RunStore(db); let killed = false;
  vi.spyOn(store, "setPid").mockImplementation(() => { throw new Error("fixture launch write failure"); });
  const runner = new Runner(db, "launch-failure", testScratchPath("cwd"), { store, tailer: new RunEventTailer(db), scratchRoot: testScratchPath("launch-failure"), dbPath: testScratchPath("fixture.db"), spawn: () => ({ pid: 4242, kill() { killed = true; }, detach() {}, wait: () => new Promise(() => {}) }) });
  const opts = { agent: "worker", task: "work", context: "fresh" as const };
  const run = mode === "foreground" ? await runner.runForeground(opts) : runner.runAsync(opts);
  expect(killed).toBe(true);
  expect(store.get(run.id)).toMatchObject({ status: "failed", result: expect.stringMatching(/fixture launch write failure/) });
  expect(getChild("launch-failure", run.id)).toBeUndefined();
});
it("deletes cross-worktree route metadata on child finalization", async () => {
  const db = freshDb(); dbs.push(db); const globalDb = openDbAt(testScratchPath("route-cleanup.db"), "global"); dbs.push(globalDb);
  const store = new RunStore(db);
  const runner = new Runner(db, "routes", testScratchPath("cwd"), { store, globalDb, tailer: new RunEventTailer(db), scratchRoot: testScratchPath("routes"), dbPath: testScratchPath("fixture.db"), spawn: () => ({ kill() {}, detach() {}, wait: async () => ({ exitCode: 0, result: "report" }) }) });
  const run = await runner.runForeground({ agent: "worker", task: "work", context: "fresh" });
  expect(globalDb.prepare("SELECT run_id FROM run_routes WHERE run_id=?").all(run.id)).toEqual([]);
});
it.each(["setLaunch", "route"])("a pre-spawn %s write failure finalizes failed without leaking an active row", async write => {
  const db = freshDb(); dbs.push(db); const globalDb = openDbAt(testScratchPath(`prelaunch-${write}.db`), "global"); dbs.push(globalDb);
  const store = new RunStore(db); let spawned = false;
  if (write === "setLaunch") vi.spyOn(store, "setLaunch").mockImplementation(() => { throw new Error("prelaunch write failure"); });
  else globalDb.exec("DROP TABLE run_routes");
  const runner = new Runner(db, "prelaunch", testScratchPath("cwd"), { store, globalDb, tailer: new RunEventTailer(db), scratchRoot: testScratchPath("prelaunch"), dbPath: testScratchPath("fixture.db"), spawn: () => { spawned = true; throw new Error("unexpected spawn"); } });
  const run = runner.runAsync({ agent: "worker", task: "work", context: "fresh" });
  expect(spawned).toBe(false); expect(run.status).toBe("failed"); expect(store.listActive("prelaunch")).toHaveLength(0);
});

it("print dispatch does not add RPC-only orchestrator metadata", async () => {
  const db = freshDb(); dbs.push(db); const globalDb = openDbAt(testScratchPath("print-metadata.db"), "global"); dbs.push(globalDb);
  let env: Record<string, string> = {};
  const handler = makeRunHandler({ spawner: spec => { env = spec.env; return { wait: async () => ({ exitCode: 0, result: "report" }), kill() {}, detach() {} }; } });
  await handler({ agent: "worker", task: "work" }, { db, globalDb, childMode: "print", sessionId: "print", cwd: testScratchPath("cwd"), runDbPath: testScratchPath("fixture.db") });
  expect(env.PI_SUBAGENT_ORCHESTRATOR_TARGET).toBeUndefined();
});

it.each(["done", "cancelled"] as const)("terminal %s store transitions also delete the global run route", status => {
  const db = freshDb(); dbs.push(db); const globalDb = openDbAt(testScratchPath(`terminal-route-${status}.db`), "global"); dbs.push(globalDb);
  const store = new (RunStore as any)(db, globalDb) as RunStore;
  const { id } = store.create({ sessionId: "routes", agent: "worker" }); store.start(id);
  globalDb.prepare("INSERT INTO run_routes VALUES (?,?,?)").run(id, "routes", "fixture.db");
  if (status === "done") store.finish(id, { status }); else store.cancel(id, "stopped");
  expect(globalDb.prepare("SELECT run_id FROM run_routes WHERE run_id=?").all(id)).toEqual([]);
});

it.each([false, true])("shutdown still kills a child and reports cancellation when its cancellation write fails (async=%s)", async asynchronousKill => {
  const db = freshDb(); dbs.push(db); const store = new RunStore(db); let killed = false;
  vi.spyOn(store, "cancel").mockImplementation(() => { throw new Error("fixture cancellation write failed"); });
  let finish!: (v: any) => void; const exit = new Promise<{ exitCode: number }>(resolve => { finish = resolve; });
  const stop = () => { killed = true; finish({ exitCode: 143 }); };
  const handle: ChildHandle = { kill: stop, ...(asynchronousKill ? { killAsync: async () => stop() } : {}), detach() {}, wait: () => exit };
  const onComplete = vi.fn();
  const runner = new Runner(db, "cancel-write", testScratchPath("cwd"), { store, tailer: new RunEventTailer(db), scratchRoot: testScratchPath("cancel-write"), dbPath: testScratchPath("fixture.db"), spawn: () => handle, onComplete });
  const run = runner.runAsync({ agent: "worker", task: "work", context: "fresh" });
  await teardownAllAsync();
  expect(killed).toBe(true);
  await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  expect(store.get(run.id)).toMatchObject({ status: "cancelled", result: expect.stringMatching(/session.*shutdown/i) });
});

it.each([false, true])("failed owned kill keeps the run active and records failure (async=%s)", async asynchronousKill => {
  const db = freshDb(); dbs.push(db);
  const globalDb = openDbAt(testScratchPath(`failed-kill-global-${asynchronousKill}.db`), "global"); dbs.push(globalDb);
  const store = new RunStore(db, globalDb);
  let finish!: (v: any) => void; const exit = new Promise<{ exitCode: number; result: string }>(resolve => { finish = resolve; });
  const fail = () => { throw new Error("fixture permission denied"); };
  const handle: ChildHandle = { wait: () => exit, detach() {}, kill: fail, ...(asynchronousKill ? { killAsync: async () => fail() } : {}) };
  const runner = new Runner(db, "failed-kill", testScratchPath("cwd"), { store, globalDb, tailer: new RunEventTailer(db), scratchRoot: testScratchPath("failed-kill"), dbPath: "fixture.db", spawn: () => handle });
  const row = runner.runAsync({ agent: "worker", task: "work", context: "fresh" });
  try {
    expect(await killRun({ store, db }, "failed-kill", row)).toMatchObject({ outcome: "failed", via: "handle", error: expect.stringMatching(/permission denied/) });
    expect(store.get(row.id)).toMatchObject({ status: "running", ended_at: null, result: null });
    expect(globalDb.prepare("SELECT session_id,db_path FROM run_routes WHERE run_id=?").get(row.id)).toEqual({ session_id: "failed-kill", db_path: "fixture.db" });
    expect(getChild("failed-kill", row.id)).toBe(handle);
    const statusEvents = db.prepare("SELECT payload FROM run_events WHERE run_id=? AND type='status' ORDER BY id").all(row.id) as Array<{ payload: string }>;
    expect(statusEvents.map(e => JSON.parse(e.payload).status)).toEqual(["running", "cancelled", "running"]);
    const warnings = db.prepare("SELECT summary FROM run_events WHERE run_id=? AND type='warning'").all(row.id);
    expect(warnings).toContainEqual({ summary: expect.stringMatching(/kill.*failed.*permission denied/i) });
  } finally { finish({ exitCode: 0, result: "report after failed kill" }); await exit; await Promise.resolve(); }
  expect(store.get(row.id)).toMatchObject({ status: "done", result: "report after failed kill" });
});

it("completion includes non-delivery even when the child finalized its row first", async () => {
  const db = freshDb(); dbs.push(db); const store = new RunStore(db); const sent: any[] = [];
  let finish!: (v: any) => void; const exit = new Promise<{ exitCode: number }>(resolve => { finish = resolve; });
  const runner = new Runner(db, "self-finalized", testScratchPath("cwd"), { store, tailer: new RunEventTailer(db), scratchRoot: testScratchPath("self-finalized"), dbPath: "fixture.db", spawn: () => ({ wait: () => exit, detach() {}, kill() { finish({ exitCode: 143 }); } }), onComplete: makeAsyncNotifier({ db, pi: { sendMessage(m: any) { sent.push(m); } } }) });
  const row = runner.runAsync({ agent: "worker", task: "work", context: "fresh" });
  appendRunEvent(db, { runId: row.id, sessionId: "self-finalized", ts: Date.now(), type: "steer_delivery", payload: { requestId: "accepted-steer", delivered: false }, summary: "Accepted steer was not delivered." });
  store.finish(row.id, { status: "done", result: "child terminal report" });
  finish({ exitCode: 0 }); await exit; await Promise.resolve();
  expect(store.get(row.id)).toMatchObject({ status: "done", result: expect.stringMatching(/child terminal report[\s\S]*1 steer.*accepted but not confirmed/i) });
  expect(sent).toHaveLength(1); expect(sent[0].details.output).toMatch(/1 steer.*accepted but not confirmed/i);
});

// Real pi runs session_shutdown and tries to write failed before killAsync returns.
it.each(["kill", "shutdown"] as const)("%s wins over the child's own aborted report while termination is in progress", async cause => {
  const db = freshDb(); dbs.push(db); const store = new RunStore(db);
  const sent: any[] = []; let finish!: (v: any) => void;
  const exit = new Promise<{ exitCode: number }>(resolve => { finish = resolve; });
  let id: string;
  const handle: ChildHandle = { wait: () => exit, detach() {}, kill() {}, async killAsync() {
    store.finish(id, { status: "failed", result: "This operation was aborted" });
    finish({ exitCode: 143 });
    await exit; await Promise.resolve();
  } };
  const runner = new Runner(db, "aborted-child", testScratchPath("cwd"), { store, tailer: new RunEventTailer(db), scratchRoot: testScratchPath("aborted-child"), dbPath: "fixture.db", spawn: () => handle,
    onComplete: makeAsyncNotifier({ db, pi: { sendMessage(m: any, o: any) { sent.push({ message: m, options: o }); } } }) });
  id = runner.runAsync({ agent: "worker", task: "work", context: "fresh" }).id;
  if (cause === "kill") expect(await killRun({ store, db }, "aborted-child", store.get(id)!)).toMatchObject({ outcome: "killed" });
  else await teardownAllAsync();
  await exit; await Promise.resolve();
  expect(store.get(id)).toMatchObject({ status: "cancelled", result: cause === "kill" ? "killed by spider kill from this session" : "Session shutdown cancelled this run." });
  if (cause === "kill") expect(sent).toEqual([]);
  else {
    expect(sent).toHaveLength(1);
    expect(sent[0].message.details.status).toBe("cancelled");
    expect(sent[0].options).toEqual({ triggerTurn: false, deliverAs: "nextTurn" });
  }
});

it("failed kill restores a paused row's prior result and cancellation cause", async () => {
  const db = freshDb(); dbs.push(db); const store = new RunStore(db);
  let finish!: (v: any) => void; const exit = new Promise<{ exitCode: number; result: string }>(resolve => { finish = resolve; });
  const handle: ChildHandle = { wait: () => exit, detach() {}, kill() { throw new Error("permission denied"); } };
  const runner = new Runner(db, "paused-kill", testScratchPath("cwd"), { store, tailer: new RunEventTailer(db), scratchRoot: testScratchPath("paused-kill"), dbPath: "fixture.db", spawn: () => handle });
  const row = runner.runAsync({ agent: "worker", task: "work", context: "fresh" });
  db.prepare("UPDATE runs SET status='paused', result='checkpoint' WHERE id=?").run(row.id);
  try {
    expect(await killRun({ store, db }, "paused-kill", store.get(row.id)!)).toMatchObject({ outcome: "failed" });
    expect(store.get(row.id)).toMatchObject({ status: "paused", result: "checkpoint", ended_at: null });
    expect(handle.cancellationReason).toBeUndefined();
  } finally { finish({ exitCode: 0, result: "continued report" }); await exit; await Promise.resolve(); }
  expect(store.get(row.id)).toMatchObject({ status: "done", result: "continued report" });
});

it("a delivered steer never appears in the undelivered summary", async () => {
  const db = freshDb(); dbs.push(db); const store = new RunStore(db); const sent: any[] = [];
  const runner = new Runner(db, "delivered", testScratchPath("cwd"), { store, tailer: new RunEventTailer(db), scratchRoot: testScratchPath("delivered"), dbPath: "fixture.db",
    spawn: spec => { appendRunEvent(db, { runId: spec.env.PI_SUBAGENT_RUN_ID, sessionId: "delivered", ts: Date.now(), type: "steer_delivery", payload: { requestId: "delivered-steer", delivered: true }, summary: "Accepted steer delivered." });
      return { wait: async () => ({ exitCode: 0, result: "unchanged report" }), kill() {}, detach() {} }; },
    onComplete: makeAsyncNotifier({ db, pi: { sendMessage(m: any) { sent.push(m); } } }) });
  const row = runner.runAsync({ agent: "worker", task: "work", context: "fresh" });
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(store.get(row.id)?.result).toBe("unchanged report\n\n1 steer(s) delivered.");
  expect(sent[0].details.output).toBe("unchanged report\n\n1 steer(s) delivered.");
  expect(sent[0].content).not.toMatch(/not delivered/);
});

it.each(["accepted but not confirmed", "no reply yet, delivery unknown"])("own kill reports a %s steer rather than suppressing its completion notification", async delivery => {
  const db = freshDb(); dbs.push(db); const store = new RunStore(db); const sent: any[] = [];
  let finish!: (v: any) => void; const exit = new Promise<{ exitCode: number }>(resolve => { finish = resolve; });
  const runner = new Runner(db, "steer-kill", testScratchPath("cwd"), { store, tailer: new RunEventTailer(db), scratchRoot: testScratchPath("steer-kill"), dbPath: "fixture.db",
    spawn: () => ({ wait: () => exit, detach() {}, kill() { finish({ exitCode: 143 }); } }),
    onComplete: makeAsyncNotifier({ db, pi: { sendMessage(m: any) { sent.push(m); } } }) });
  const row = runner.runAsync({ agent: "worker", task: "work", context: "fresh" });
  appendRunEvent(db, { runId: row.id, sessionId: "steer-kill", ts: Date.now(), type: "steer_delivery", payload: { requestId: "undelivered-steer", delivered: false, delivery }, summary: "Accepted steer was not delivered." });
  expect(await killRun({ store, db }, "steer-kill", store.get(row.id)!)).toMatchObject({ outcome: "killed" });
  await exit; await Promise.resolve();
  expect(store.get(row.id)).toMatchObject({ status: "cancelled", result: expect.stringContaining(`1 steer(s) ${delivery}.`) });
  expect(sent).toHaveLength(1);
  expect(sent[0].details.output).toContain(`1 steer(s) ${delivery}.`);
});

// Reproduces review-r6-late-fail: the leader exits during grace, then group termination fails.
it("failed kill after exit and finalization does not resurrect a dead run or route", async () => {
  const db = freshDb(); dbs.push(db);
  const globalDb = openDbAt(testScratchPath("late-fail-global.db"), "global"); dbs.push(globalDb);
  const store = new RunStore(db, globalDb); const sent: any[] = [];
  let finish!: (v: { exitCode: number }) => void;
  const exit = new Promise<{ exitCode: number }>(resolve => { finish = resolve; });
  let finalized!: () => void; const completion = new Promise<void>(resolve => { finalized = resolve; });
  const handle: ChildHandle = { wait: () => exit, detach() {}, kill() {}, async killAsync() {
    finish({ exitCode: 143 });
    await completion; // parent already finalized and sent/suppressed its notification
    throw new Error("Process identity unconfirmed; no signal sent.");
  } };
  const notify = makeAsyncNotifier({ db, pi: { sendMessage(m: any) { sent.push(m); } } });
  const runner = new Runner(db, "late-fail", testScratchPath("cwd"), { store, globalDb, tailer: new RunEventTailer(db), scratchRoot: testScratchPath("late-fail"), dbPath: "fixture.db", spawn: () => handle,
    onComplete: (row, status, result) => { notify(row, status, result); finalized(); } });
  const row = runner.runAsync({ agent: "worker", task: "work", context: "fresh" });
  try {
    expect(await killRun({ store, db }, "late-fail", row)).toMatchObject({ outcome: "failed", error: expect.stringMatching(/identity unconfirmed/) });
    expect(store.get(row.id)).toMatchObject({ status: "cancelled", result: "killed by spider kill from this session", ended_at: expect.any(Number) });
    expect(globalDb.prepare("SELECT run_id FROM run_routes WHERE run_id=?").all(row.id)).toEqual([]);
    expect(getChild("late-fail", row.id)).toBeUndefined();
    expect(sent).toEqual([]);
    const warnings = db.prepare("SELECT summary FROM run_events WHERE run_id=? AND type='warning'").all(row.id) as Array<{summary: string}>;
    expect(warnings.find(e => /kill failed/i.test(e.summary))?.summary).not.toMatch(/remains active/i);
  } finally { finish({ exitCode: 143 }); await exit; await Promise.resolve(); }
});

it.each([
  { status: "failed", result: "killed by spider kill from this session" },
  { status: "cancelled", result: "cancelled by a different owner" },
])("failed kill preserves another terminal outcome ($status, $result)", async terminal => {
  const db = freshDb(); dbs.push(db);
  const globalDb = openDbAt(testScratchPath(`other-terminal-${terminal.status}.db`), "global"); dbs.push(globalDb);
  const store = new RunStore(db, globalDb);
  let finish!: (v: { exitCode: number }) => void;
  const exit = new Promise<{ exitCode: number }>(resolve => { finish = resolve; });
  let id: string;
  const handle: ChildHandle = { wait: () => exit, detach() {}, kill() {
    db.prepare("UPDATE runs SET status=?, result=?, ended_at=123 WHERE id=?").run(terminal.status, terminal.result, id);
    throw new Error("fixture kill failed after another outcome");
  } };
  const runner = new Runner(db, "other-terminal", testScratchPath("cwd"), { store, globalDb, tailer: new RunEventTailer(db), scratchRoot: testScratchPath("other-terminal"), dbPath: "fixture.db", spawn: () => handle });
  id = runner.runAsync({ agent: "worker", task: "work", context: "fresh" }).id;
  try {
    expect(await killRun({ store, db }, "other-terminal", store.get(id)!)).toMatchObject({ outcome: "failed" });
    expect(store.get(id)).toMatchObject({ ...terminal, ended_at: 123 });
    expect(globalDb.prepare("SELECT run_id FROM run_routes WHERE run_id=?").all(id)).toEqual([]);
  } finally { finish({ exitCode: 143 }); await exit; await Promise.resolve(); }
});

it("later tool acceptance cannot overwrite observed delivery in completion", async () => {
  const db = freshDb(); dbs.push(db); const store = new RunStore(db);
  const runner = new Runner(db, "ordering", testScratchPath("cwd"), { store, tailer: new RunEventTailer(db), scratchRoot: testScratchPath("ordering"), dbPath: "fixture.db",
    spawn: spec => {
      for (const [type, payload] of [["steer_delivery", { requestId: "ordered", delivery: "delivered", delivered: true }], ["steer", { requestId: "ordered", delivery: "accepted but not confirmed", accepted: true, delivered: false }]] as const)
        appendRunEvent(db, { runId: spec.env.PI_SUBAGENT_RUN_ID, sessionId: "ordering", ts: Date.now(), type, payload, summary: type });
      return { wait: async () => ({ exitCode: 0, result: "report" }), kill() {}, detach() {} };
    } });
  const row = await runner.runForeground({ agent: "worker", task: "work", context: "fresh" });
  expect(row.result).toBe("report\n\n1 steer(s) delivered.");
});
it("completion counts no-reply uncertainty separately from refusals", async () => {
  const db = freshDb(); dbs.push(db); const store = new RunStore(db);
  const runner = new Runner(db, "unknown", testScratchPath("cwd"), { store, tailer: new RunEventTailer(db), scratchRoot: testScratchPath("unknown"), dbPath: "fixture.db",
    spawn: spec => {
      appendRunEvent(db, { runId: spec.env.PI_SUBAGENT_RUN_ID, sessionId: "unknown", ts: Date.now(), type: "steer_delivery", payload: { requestId: "slow", delivery: "no reply yet, delivery unknown", accepted: false, delivered: false }, summary: "No reply yet." });
      return { wait: async () => ({ exitCode: 0, result: "report" }), kill() {}, detach() {} };
    } });
  const row = await runner.runForeground({ agent: "worker", task: "work", context: "fresh" });
  expect(row.result).toBe("report\n\n1 steer(s) no reply yet, delivery unknown.");
});

it("mixed-version broker acceptance is counted as unconfirmed, not conversation delivery", async () => {
  const db = freshDb(); dbs.push(db); const store = new RunStore(db);
  const runner = new Runner(db, "mixed-version", testScratchPath("cwd"), { store, tailer: new RunEventTailer(db), scratchRoot: testScratchPath("mixed-version"), dbPath: "fixture.db",
    spawn: spec => {
      for (const [type, payload] of [
        ["steer", { transport: "intercom", delivery: "broker-accepted", delivered: true }],
        ["steer", { delivery: "broker-accepted", delivered: true }],
        ["steer_delivery", { requestId: "old-entry", delivered: true }],
        ["steer_delivery", { requestId: "old-acceptance", delivered: false }],
      ] as const) appendRunEvent(db, { runId: spec.env.PI_SUBAGENT_RUN_ID, sessionId: "mixed-version", ts: Date.now(), type, payload, summary: type });
      return { wait: async () => ({ exitCode: 0, result: "report" }), kill() {}, detach() {} };
    } });
  const row = await runner.runForeground({ agent: "worker", task: "work", context: "fresh" });
  expect(row.result).toBe("report\n\n1 steer(s) delivered.\n3 steer(s) accepted but not confirmed.");
});
