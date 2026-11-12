import { afterEach, expect, it, vi } from "vitest";
import { appendRunEvent, bus, openDb, openDbReadOnly, type Db } from "@spider/db-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { V13 } from "../../../db-core/src/__tests__/fixtures/historical-schemas";
import { createReplica } from "@spider/db-core/testutil";
import { RunStore } from "../run-store";
import { reapOrphanRuns } from "../reaper";
import { killRun, matchKillTargets } from "../kill";
import { diagnoseDurableChildren, discoverDurableChildren } from "../durable-adoption";
import { isLocalRun } from "../roam-origin";
import { getShared, releaseShared } from "../child-registry";
import { makeChildReporter } from "../child-reporter";
import { makeMessageHandler } from "../actions/message";
import { adoptReloadedChildren, makeAsyncNotifier, makeRunHandler } from "../actions/run";
import { freshDb, testScratchPath } from "./helpers/testutil";
import { reportRunUsage } from "../usage";
import { RunEventTailer } from "../event-tailer";
import { PipelineCoordinator } from "../pipeline";
import * as coordinators from "../coordinators";
import * as intercom from "../intercom";

const local = "11111111-1111-4111-8111-111111111111";
const foreign = "22222222-2222-4222-8222-222222222222";
const replicas: ReturnType<typeof createReplica>[] = [];
afterEach(() => { vi.restoreAllMocks(); coordinators.teardownAll(); for (const replica of replicas.splice(0)) replica.close(); });
function fixture() {
  const replica = createReplica("worktree", local); replicas.push(replica);
  return { ...replica, store: new RunStore(replica.db) };
}
function insert(db: Db, id: string, origin: string, status = "running", session = "owner") {
  db.prepare("INSERT INTO runs (id,session_id,agent,status,origin_machine,pid,host_pid,child_mode,intercom_session) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, session, "worker", status, origin, 4321, 9876, "rpc", "colliding-name");
}
function event(db: Db, id: string, type: string, payload: unknown) {
  appendRunEvent(db, { runId: id, sessionId: "owner", ts: Date.now(), type, payload });
}

it("discovers and diagnoses a routed schema-13 store after an unreadable route", () => {
  const current = fixture();
  const global = createReplica("global", local); replicas.push(global);
  const legacyPath = join(current.root, "legacy.db");
  const legacy = openDb(legacyPath);
  const legacyDirectory = join(current.root, "legacy-supervisor");
  const currentDirectory = join(current.root, "current-supervisor");
  for (const dir of [legacyDirectory, currentDirectory]) {
    mkdirSync(dir);
    writeFileSync(join(dir, "exit.json"), JSON.stringify({ exitCode: 0, result: "complete" }));
  }
  legacy.exec(V13.worktree);
  legacy.raw.pragma("user_version = 13");
  legacy.prepare("INSERT INTO runs (id, session_id, agent, status, child_mode) VALUES ('legacy-routed', 'owner', 'worker', 'running', 'rpc')").run();
  legacy.prepare("INSERT INTO run_events (run_id, session_id, ts, type, payload) VALUES ('legacy-routed', 'owner', 1, 'child_supervisor', ?)")
    .run(JSON.stringify({ version: 1, directory: legacyDirectory }));
  legacy.close();
  const { id } = current.store.create({ sessionId: "owner", agent: "worker" });
  current.store.start(id);
  event(current.db, id, "child_supervisor", { version: 1, directory: currentDirectory });
  const corrupt = join(current.root, "unreadable.db");
  writeFileSync(corrupt, "not a database");
  global.db.prepare("INSERT INTO run_routes(run_id, session_id, db_path) VALUES (?, 'owner', ?)").run("bad-route", corrupt);
  global.db.prepare("INSERT INTO run_routes(run_id, session_id, db_path) VALUES (?, 'owner', ?)").run("legacy-routed", legacyPath);
  const ctx = { db: current.db, globalDb: global.db, sessionId: "owner", runDbPath: current.db.raw.name };
  try {
    const diagnosed = diagnoseDurableChildren(ctx);
    expect(diagnosed.map(row => row.runId).sort()).toEqual([id, "legacy-routed"].sort());
    expect(() => discoverDurableChildren(ctx)).not.toThrow();
    expect(getShared(id)?.dbPath).toBe(current.db.raw.name);
    expect(getShared("legacy-routed")?.dbPath).toBe(legacyPath);
    const untouched = openDbReadOnly(legacyPath)!;
    try { expect(untouched.pragma("user_version")).toBe(13); }
    finally { untouched.close(); }
  } finally { releaseShared(id); releaseShared("legacy-routed"); }
}, 5000);

it("adopts and delivers a schema-13 routed child without migrating its store", async () => {
  const current = fixture(), global = createReplica("global", local); replicas.push(global);
  const legacyPath = join(current.root, "legacy-adoption.db"), dir = join(current.root, "completed-supervisor");
  mkdirSync(dir);
  writeFileSync(join(dir, "exit.json"), JSON.stringify({ exitCode: 0, result: "legacy result" }));
  const legacy = openDb(legacyPath);
  legacy.exec(V13.worktree); legacy.raw.pragma("user_version = 13");
  legacy.prepare("INSERT INTO runs (id, session_id, agent, status, child_mode) VALUES ('legacy-adopted', 'owner', 'worker', 'running', 'rpc')").run();
  legacy.prepare("INSERT INTO run_events (run_id, session_id, ts, type, payload) VALUES ('legacy-adopted', 'owner', 1, 'child_supervisor', ?)")
    .run(JSON.stringify({ version: 1, directory: dir }));
  legacy.close();
  global.db.prepare("INSERT INTO run_routes(run_id, session_id, db_path) VALUES ('legacy-adopted', 'owner', ?)").run(legacyPath);
  let delivered!: (value: any) => void;
  const completion = new Promise<any>(resolve => { delivered = resolve; });
  const ctx = { db: current.db, globalDb: global.db, sessionId: "owner", cwd: current.root,
    runDbPath: current.db.raw.name, pi: { sendMessage: (value: any) => delivered(value) } };
  try {
    const result = adoptReloadedChildren(ctx);
    expect(result).toEqual({ adopted: ["legacy-adopted"], refused: [] });
    expect((await completion).content).toContain("legacy result");
    const untouched = openDbReadOnly(legacyPath)!;
    try {
      expect(untouched.pragma("user_version")).toBe(13);
      expect(untouched.prepare("SELECT status FROM runs WHERE id='legacy-adopted'").get()).toEqual({ status: "done" });
      expect(untouched.prepare("SELECT count(*) AS n FROM run_events WHERE type='completion_delivered'").get()).toEqual({ n: 1 });
    } finally { untouched.close(); }
  } finally { releaseShared("legacy-adopted"); }
}, 5000);

it("uses local origin for legacy, empty-origin, and foreign runs across schema changes", async () => {
  const { root } = fixture();
  const db = openDb(join(root, "origins-v13.db"));
  try {
    db.exec(V13.worktree);
    db.raw.pragma("user_version = 13");
    db.prepare("INSERT INTO runs(id,session_id,agent,status,host_pid) VALUES ('old','owner','worker','running',10)").run();
    expect(isLocalRun(db, "old")).toBe(true);
    expect(isLocalRun(db, "missing")).toBe(false);
    expect((await reapOrphanRuns({ db, selfPid: 1, alive: () => false })).reaped).toEqual(["old"]);
    expect(new RunStore(db).get("old")?.status).toBe("cancelled");
    db.exec("CREATE TABLE roam_meta(id INTEGER PRIMARY KEY, machine_id TEXT NOT NULL)");
    db.prepare("INSERT INTO roam_meta VALUES (1, ?)").run(local);
    expect(isLocalRun(db, "old")).toBe(true); // Metadata exists but the origin column does not.
    db.exec("DROP TABLE roam_meta");
    db.exec("ALTER TABLE runs ADD COLUMN origin_machine TEXT DEFAULT ''");
    db.prepare("INSERT INTO runs(id,session_id,agent,status,origin_machine) VALUES ('orphan-meta','owner','worker','queued',?)").run(foreign);
    expect(isLocalRun(db, "orphan-meta")).toBe(true);
    db.exec("CREATE TABLE roam_meta(id INTEGER PRIMARY KEY, machine_id TEXT NOT NULL)");
    db.prepare("INSERT INTO roam_meta VALUES (1, ?)").run(local);
    db.prepare("INSERT INTO runs(id,session_id,agent,status,origin_machine) VALUES ('empty-origin','owner','worker','queued','')").run();
    db.prepare("INSERT INTO runs(id,session_id,agent,status,origin_machine) VALUES ('null-origin','owner','worker','queued',NULL)").run();
    expect(isLocalRun(db, "empty-origin")).toBe(true);
    expect(isLocalRun(db, "null-origin")).toBe(true);
    expect(isLocalRun(db, "orphan-meta")).toBe(false);
    const store = new RunStore(db);
    store.start("empty-origin"); store.start("orphan-meta");
    expect(store.get("empty-origin")?.status).toBe("running");
    expect(store.get("orphan-meta")?.status).toBe("queued");
  } finally { db.close(); }
}, 5000);

it("disables a child reporter when its local-origin lookup fails", () => {
  const { db, store } = fixture();
  const { id } = store.create({ sessionId: "owner", agent: "worker" });
  const broken = new Proxy(db, { get(target, key) {
    if (key === "prepare") return () => { throw new Error("fixture lookup failed"); };
    return Reflect.get(target, key);
  } });
  expect(() => makeChildReporter(broken, { runId: id, sessionId: "owner" })).not.toThrow();
  expect(store.get(id)?.pid).toBeNull();
}, 5000);

it("foreign PID and directory collisions cause no operational action", async () => {
  const { db, store, root } = fixture();
  insert(db, "foreign-run", foreign);
  event(db, "foreign-run", "child_supervisor", { version: 1, directory: root });
  const signals: number[] = [];
  const reaped = await reapOrphanRuns({ db, selfPid: 1, alive: pid => pid === 4321,
    probeCommand: () => "pi --mode json -p --session /fixture Task: work", kill: async pid => { signals.push(pid); } });
  const run = store.get("foreign-run")!;
  await killRun({ db, store, getChild: () => ({ kill: () => signals.push(4321) }), kill: async pid => { signals.push(pid); return "terminated"; } }, "owner", run);
  discoverDurableChildren({ db, sessionId: "owner" });
  const child = makeChildReporter(db, { runId: run.id, sessionId: "owner" });
  child.onMessage("must not persist"); child.onShutdown("done", "must not persist");
  const sent = vi.fn();
  const broker = vi.spyOn(intercom, "sendIntercom").mockRejectedValue(new Error("unexpected broker call"));
  const result = await makeMessageHandler()({ to: run.id, message: "hello" }, { db, sessionId: "other", pi: { sendMessage: sent } });
  expect(signals).toEqual([]);
  expect(reaped.reaped).toEqual([]);
  expect(getShared(run.id)).toBeUndefined();
  expect(result.isError).toBe(true);
  expect(result.content).toContain("history from another machine");
  expect(broker).not.toHaveBeenCalled();
  expect(sent).not.toHaveBeenCalled();
  expect(store.get(run.id)?.status).toBe("running");
  expect(db.prepare("SELECT COUNT(*) n FROM run_events WHERE run_id=? AND type='message'").get(run.id)).toEqual({ n: 0 });
  expect(matchKillTargets(store, "owner", "all")).toEqual([]);
}, 5000);

it("foreign rows cannot be mutated through direct run-store paths", () => {
  const { db, store } = fixture(); insert(db, "foreign-run", foreign, "queued");
  store.start("foreign-run"); store.updateProgress("foreign-run", { stepCount: 9 });
  store.setPid("foreign-run", 8, 9); store.setLaunch("foreign-run", { childMode: "print" });
  store.linkChild("foreign-run", "other");
  expect(store.finish("foreign-run", { status: "done" })).toBe(false);
  expect(store.cancel("foreign-run")).toBe(false);
  expect(store.get("foreign-run")).toMatchObject({ status: "queued", step_count: 0, pid: 4321, child_mode: "rpc", parent_run_id: null });
}, 5000);

it("origin rebuild cannot adopt sanitized history", () => {
  const { db } = fixture(); insert(db, "rebuilt-run", local);
  db.prepare("UPDATE runs SET pid=NULL,host_pid=NULL,intercom_session=NULL WHERE id=?").run("rebuilt-run");
  event(db, "rebuilt-run", "child_supervisor", { version: 1, history: { machineId: local, reference: "history" } });
  discoverDurableChildren({ db, sessionId: "owner" });
  expect(getShared("rebuilt-run")).toBeUndefined();
}, 5000);

it("foreign completion and usage sentinels are history only", () => {
  const { db, store } = fixture(); insert(db, "foreign-run", foreign, "done");
  event(db, "foreign-run", "child_supervisor", { version: 1, directory: "unused" });
  event(db, "foreign-run", "completion_delivered", {}); event(db, "foreign-run", "spider_usage_reported", {});
  insert(db, "foreign-unmarked", foreign, "done");
  event(db, "foreign-unmarked", "child_supervisor", { version: 1, directory: "unused" });
  const deliveries: string[] = [], charges: string[] = [];
  const notify = makeAsyncNotifier({ db, pi: { sendMessage: (message: any) => deliveries.push(message.details.runId) } });
  notify(store.get("foreign-run"), "done", "result");
  reportRunUsage(db, store.get("foreign-run")!, run => { charges.push(run.id); return true; });
  notify(store.get("foreign-unmarked"), "done", "result");
  reportRunUsage(db, store.get("foreign-unmarked")!, run => { charges.push(run.id); return true; });
  expect(deliveries).toEqual([]); expect(charges).toEqual([]);
  const tailer = new RunEventTailer(db, { sinceId: 0 }), received: string[] = [];
  const off = bus.on(e => { if (e.runId) received.push(e.runId); });
  try { tailer.track("foreign-run"); tailer.poll(); } finally { off(); }
  expect(received).toEqual([]);
}, 5000);

it("local completion still delivers once", () => {
  const { db, store } = fixture(); const { id } = store.create({ sessionId: "owner", agent: "worker" });
  store.finish(id, { status: "done", result: "result" }); event(db, id, "child_supervisor", { version: 1, directory: "unused" });
  const deliveries: string[] = [], charges: string[] = [];
  const notify = makeAsyncNotifier({ db, pi: { sendMessage: (message: any) => deliveries.push(message.details.runId) } });
  notify(store.get(id), "done", "result"); notify(store.get(id), "done", "result");
  const sink = (run: { id: string }) => { charges.push(run.id); return true; };
  reportRunUsage(db, store.get(id)!, sink); reportRunUsage(db, store.get(id)!, sink);
  expect(deliveries).toEqual([id]); expect(charges).toEqual([id]);
}, 5000);

it("blocker inventory includes pending pipelines and detached children", async () => {
  const blockersModule = await import("../blockers");
  const { db, store } = fixture();
  const paused = store.create({ sessionId: "owner", agent: "worker" }).id;
  db.prepare("UPDATE runs SET status='paused' WHERE id=?").run(paused);
  const detached = store.create({ sessionId: "owner", agent: "worker" }).id;
  store.start(detached); event(db, detached, "child_supervisor", { version: 1, directory: "unused" });
  const unobserved = store.create({ sessionId: "owner", agent: "worker" }).id;
  store.finish(unobserved, { status: "done" }); event(db, unobserved, "child_supervisor", { version: 1, directory: "unused" });
  insert(db, "foreign-run", foreign);
  const runner = { runAsync: () => { const { id } = store.create({ sessionId: "owner", agent: "worker" }); store.start(id); return store.get(id); } };
  const coord = new PipelineCoordinator({ db, globalDb: db, store, runner, pi: {}, sessionId: "owner" });
  coordinators.getCoordinators("owner", () => ({ tailer: new RunEventTailer(db), pipelines: [coord], children: new Map() }));
  const { pipelineId, firstRunId } = coord.start({ pipeline: [{ agent: "worker" }, { agent: "worker" }], handoff: "intercom" });
  const reader = (coordinators as any).listPendingPipelines;
  expect(reader("owner")).toEqual([]);
  store.finish(firstRunId, { status: "done" });
  expect(reader("other")).toEqual([]);
  expect(reader("owner")).toEqual([{ pipelineId, sessionId: "owner" }]);
  const blockers = (blockersModule as any).listSessionBlockers(db, "owner", { pendingPipelines: () => reader("owner") });
  expect(blockers.map((b: { id: string }) => b.id)).toEqual(expect.arrayContaining([paused, detached, pipelineId, unobserved]));
  expect(blockers.map((b: { id: string }) => b.id)).not.toContain("foreign-run");
  expect(store.get(detached)?.status).toBe("running");
  coord.dispose();
  expect(reader("owner")).toEqual([]);
}, 5000);

it("dormant inventory reports no pipelines without a live registry", async () => {
  const blockersModule = await import("../blockers");
  const { db } = fixture();
  expect((blockersModule as any).listSessionBlockers(db, "owner").filter((b: { kind: string }) => b.kind === "pipeline")).toEqual([]);
}, 5000);

it("shutdown notice for a foreign history run is never delivered", () => {
  const db = freshDb(), store = new RunStore(db);
  insert(db, "foreign-shutdown", foreign, "cancelled");
  const history = store.get("foreign-shutdown")!;
  const sendMessage = vi.fn();
  const notify = makeAsyncNotifier({ db, pi: { sendMessage } });
  notify(history, "cancelled", "Session shutdown cancelled this run.");
  db.close();
  expect(() => notify(history, "cancelled", "Session shutdown cancelled this run.")).not.toThrow();
  expect(sendMessage).not.toHaveBeenCalled();
}, 5000);

it("shutdown notice after db close delivers for a locally spawned run", async () => {
  const db = freshDb(), sendMessage = vi.fn();
  const sessionId = "spawned-owner";
  const ctx = { db, sessionId, cwd: testScratchPath("cwd"), runDbPath: db.raw.name, pi: { sendMessage } };
  const action = makeRunHandler({ spawner: () => ({ wait: () => new Promise(() => {}), kill() {}, detach() {} }) });
  const result = await action({ agent: "worker", task: "work" }, ctx);
  const run = result.details.run;
  coordinators.unregisterChild(sessionId, run.id); releaseShared(run.id);
  coordinators.teardownAll();
  db.close();
  makeAsyncNotifier(ctx)(run, "cancelled", "Session shutdown cancelled this run.");
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(sendMessage.mock.calls[0][0].details.runId).toBe(run.id);
  expect(sendMessage.mock.calls[0][1]).toEqual({ triggerTurn: false, deliverAs: "nextTurn" });
}, 5000);

it("chain stage failing before spawn still notifies after db close", async () => {
  const db = freshDb(), sendMessage = vi.fn();
  const ctx = { db, sessionId: "failed-chain", cwd: testScratchPath("cwd"), runDbPath: db.raw.name, pi: { sendMessage } };
  const action = makeRunHandler({ spawner: () => { throw new Error("launch unavailable"); } });
  const started = action({ chain: [{ agent: "worker", task: "work" }] }, ctx);
  expect(sendMessage).toHaveBeenCalledTimes(1);
  coordinators.teardownAll();
  db.close();
  await started;
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2), { timeout: 500 });
  expect(sendMessage.mock.calls[1][0].details.output).toContain("launch unavailable");
}, 5000);
