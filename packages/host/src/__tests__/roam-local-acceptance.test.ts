import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createReplica, type ReplicaFixture } from "@spider/db-core/testutil";
import { applyBatch } from "@spider/db-core/roam/apply";
import { validateBatch } from "@spider/db-core/roam/codec";
import { appendRunEvent, bus, openDbAt } from "@spider/db-core";
import { catalogReplica, replicaPath, resolveSessionReplica } from "@spider/db-core/roam/catalog";
import { createReplicaEffects } from "@spider/db-core/roam/effects";
import { repoIdentity } from "@spider/db-core/roam/identity";
import { createExportPolicy } from "@spider/db-core/roam/event-policy";
import { exportBatch } from "@spider/db-core/roam/export";
import { enableMemoryCapture, seedSession } from "@spider/db-core/roam/seed";
import type { Scope } from "@spider/db-core/roam/types";
import { recordRunUsage, reportRunUsage, RunStore } from "@spider/subagents";
import { makeAsyncNotifier } from "../../../subagents/src/actions/run";
import { killRun } from "../../../subagents/src/kill";
import { reapOrphanRuns } from "../../../subagents/src/reaper";
import { UsageAccounting } from "../usage-accounting";
import { BASELINE_SQL } from "../../../db-core/src/__tests__/roam-baseline-writers";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const SESSION = "session-a";
const roots: ReplicaFixture[] = [];
afterEach(() => { for (const root of roots.splice(0)) root.close(); });
function replica(machine: string, scope: Scope = "worktree") {
  const root = createReplica(scope, machine);
  roots.push(root);
  return root;
}
const policy = createExportPolicy((_path, origin) => ({ machineId: origin, reference: "fixture" }));
async function transfer(source: ReplicaFixture, dest: ReplicaFixture, id = "batch-a") {
  const artifact = await exportBatch(source.db, { after: 0, targetBytes: 4 * 1024 * 1024, batchId: id }, policy);
  const validated = await validateBatch(artifact, { storeKey: dest.storeKey, senderMachine: artifact.header.senderMachine, senderStream: artifact.header.senderStream, now: Date.now() });
  return applyBatch(dest.db, validated, { hubMachine: A, now: Date.now(), effects: createReplicaEffects(() => {}), sessionHome: () => null });
}
function cli(root: ReplicaFixture, recursive: number, sql: string) {
  return spawnSync("sqlite3", ["-batch", "-bail", join(root.root, "store.db")], { input: `PRAGMA recursive_triggers=${recursive};\n${sql}`, encoding: "utf8" });
}

it.each([0, 1])("A3 composes baseline writers, import and CLI fences (recursive=%s)", async recursive => {
  const version = spawnSync("sqlite3", ["-version"], { encoding: "utf8" });
  if (version.error) throw version.error;
  const parts = version.stdout.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  if (version.status !== 0 || !parts || parts[0] < 3 || (parts[0] === 3 && parts[1] < 42)) throw new Error("sqlite3 3.42 or newer is required");
  const source = replica(A), dest = replica(B), db = source.db;
  db.prepare(BASELINE_SQL.sessionUpsert).run(SESSION, "first", "open", 1);
  expect(seedSession(db, SESSION, 1, source.storeKey, 4 * 1024 * 1024).complete).toBe(true);
  db.prepare(BASELINE_SQL.sessionUpsert).run(SESSION, "second", "resume", 2);
  const add = (text: string) => {
    const next = db.prepare(BASELINE_SQL.todoNext).get(SESSION) as { maxSeq: number };
    const id = Number(db.prepare(BASELINE_SQL.todoInsert).run(SESSION, next.maxSeq + 1, text, 1, 1).lastInsertRowid);
    db.prepare(BASELINE_SQL.todoFtsInsert).run(id, text);
    return id;
  };
  const first = add("first todo");
  db.prepare(BASELINE_SQL.todoToggle).run(1, 2, first);
  const second = add("second todo");
  const selected = db.prepare(BASELINE_SQL.todoFind).get(SESSION, 1) as { id: number; text: string };
  db.raw.transaction(() => {
    db.prepare(BASELINE_SQL.todoFtsDelete).run(selected.id, selected.text);
    db.prepare(BASELINE_SQL.todoRemove).run(selected.id);
  }).immediate();
  db.prepare(BASELINE_SQL.todoToggle).run(1, 3, second);
  db.raw.transaction(() => {
    const rows = db.prepare(BASELINE_SQL.todoClearRows).all(SESSION, 0) as Array<{ id: number; text: string }>;
    for (const row of rows) db.prepare(BASELINE_SQL.todoFtsDelete).run(row.id, row.text);
    db.prepare(BASELINE_SQL.todoClear).run(SESSION, 0);
  }).immediate();
  add("surviving todo");
  db.prepare(BASELINE_SQL.runInsert).run({ id: "run-a", session_id: SESSION, parent_run_id: null, agent: "worker", role: null, name: "run", status: "queued", phase: null, model: null, task: null, thinking: null, host_pid: 123 });
  db.prepare(BASELINE_SQL.runStart).run({ id: "run-a", now: 2 });
  db.prepare(BASELINE_SQL.runProgress).run({ id: "run-a", stepCount: 1, tokenCount: null, phase: null, model: null, thinking: null });
  db.prepare(BASELINE_SQL.runPid).run({ id: "run-a", pid: 321, hostPid: 123, startTime: "456" });
  db.prepare(BASELINE_SQL.runFinish).run({ id: "run-a", status: "done", now: 3, result: "complete" });
  db.prepare(BASELINE_SQL.eventAppend).run({ runId: "run-a", sessionId: SESSION, ts: 3, type: "done", tool: null, summary: null, payload: null });
  await transfer(source, dest);
  const replicaState = {
    session: dest.db.prepare("SELECT name, reason, origin_machine FROM sessions WHERE id=?").get(SESSION),
    todos: dest.db.prepare("SELECT seq, text, done FROM todos ORDER BY seq").all(),
    run: dest.db.prepare("SELECT status, pid, host_pid, origin_machine FROM runs WHERE id='run-a'").get(),
    state: dest.db.prepare("SELECT state FROM roam_sessions WHERE session_id=?").get(SESSION),
  };
  const expectedState = { session: { name: "second", reason: "resume", origin_machine: A }, todos: [{ seq: 1, text: "surviving todo", done: 0 }], run: { status: "done", pid: null, host_pid: null, origin_machine: A }, state: { state: "retired" } };
  expect(replicaState).toEqual(expectedState);
  const before = dest.db.prepare("SELECT * FROM roam_changes ORDER BY seq").all();
  for (const statement of [
    "INSERT INTO todos(session_id,seq,text,created_at) VALUES ('session-a',2,'bad',1);",
    "INSERT INTO todos(uuid,session_id,seq,text,created_at) VALUES ('explicit','session-a',2,'bad',1);",
    "UPDATE todos SET text='bad' WHERE session_id='session-a';",
    "DELETE FROM todos WHERE session_id='session-a';",
  ]) {
    const result = cli(dest, recursive, statement);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/session is frozen/);
  }
  expect(dest.db.prepare("SELECT seq,text,done FROM todos").all()).toEqual(expectedState.todos);
  expect(dest.db.prepare("SELECT * FROM roam_changes ORDER BY seq").all()).toEqual(before);
}, 5000);


it("A2 composes equivalent repository identities with migrated stores", async () => {
  const origins = [
    "https://org.legacy.example/DefaultCollection/team/_git/repo",
    "https://code.example/org/team/repo",
    "git@ssh.code.example:v3/org/team/repo",
  ];
  const keys = origins.map(origin => repoIdentity({ origin, roots: [] }));
  expect(new Set(keys).size).toBe(1);
  const source = replica(A, "repo"), dest = replica(B, "repo");
  for (const [index, root] of [source, dest].entries()) {
    root.db.prepare("UPDATE roam_meta SET store_key=?").run(`repo:${keys[index]}`);
    root.storeKey = `repo:${keys[index]}`;
    expect(root.db.pragma("user_version")).toBe(14);
  }
  enableMemoryCapture(source.db, source.storeKey);
  source.db.prepare("INSERT INTO memory(uuid,category,content,status,source,created_at) VALUES ('m1','insight','portable','active','user',1)").run();
  await transfer(source, dest);
  expect(dest.db.prepare("SELECT uuid,content FROM memory").all()).toEqual([{ uuid: "m1", content: "portable" }]);
}, 5000);

it.each([[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]])("A4 composes disconnected edits and tombstones across three roots in order %i %i %i", async (...order) => {
  const replicas = [replica(A, "repo"), replica(B, "repo"), replica(C, "repo")];
  for (const [index, root] of replicas.entries()) {
    enableMemoryCapture(root.db, root.storeKey);
    root.db.prepare("INSERT INTO memory(uuid,category,content,status,source,created_at) VALUES (?,'insight',?,'active','user',1)")
      .run(`m${index}`, `word${index}`);
    if (index === 2) root.db.prepare("DELETE FROM memory WHERE uuid='m2'").run();
  }
  for (const source of order) {
    for (let dest = 0; dest < replicas.length; dest++) {
      if (source !== dest) await transfer(replicas[source], replicas[dest], `from-${source}-to-${dest}`);
    }
  }
  const replicaState = replicas.map(root => ({
    rows: root.db.prepare("SELECT uuid,content FROM memory ORDER BY uuid").all(),
    tombstone: root.db.prepare("SELECT deleted FROM roam_versions WHERE entity='memory' AND row_key='m2'").get(),
  }));
  const expectedState = { rows: [{ uuid: "m0", content: "word0" }, { uuid: "m1", content: "word1" }], tombstone: { deleted: 1 } };
  expect(replicaState).toEqual([expectedState, expectedState, expectedState]);
}, 5000);

it("A5 replays a real import receipt without duplicate events or invalidation", async () => {
  const source = replica(A), dest = replica(B);
  seedSession(source.db, SESSION, 1, source.storeKey, 4096);
  source.db.prepare("INSERT INTO run_events(uuid,session_id,ts,type) VALUES ('event-a',?,1,'history')").run(SESSION);
  const artifact = await exportBatch(source.db, { after: 0, targetBytes: 4096, batchId: "replay" }, policy);
  const batch = await validateBatch(artifact, { storeKey: dest.storeKey, senderMachine: artifact.header.senderMachine, senderStream: artifact.header.senderStream, now: Date.now() });
  const notices: string[] = [], foreignOperationalCalls: string[] = [];
  const off = bus.on(event => foreignOperationalCalls.push(event.type));
  try {
    const options = { hubMachine: A, now: Date.now(), effects: createReplicaEffects(key => notices.push(key)), sessionHome: () => null };
    const first = applyBatch(dest.db, batch, options);
    const replay = applyBatch(dest.db, batch, options);
    expect(replay).toEqual({ batchId: first.batchId, stream: first.stream, through: first.through, sha256: first.sha256, applyMs: null });
    expect(dest.db.prepare("SELECT uuid,type FROM run_events").all()).toEqual([{ uuid: "event-a", type: "history" }]);
    expect(dest.db.prepare("SELECT count(*) AS n FROM roam_receipts").get()).toEqual({ n: 1 });
    expect(notices).toEqual([dest.storeKey]);
    expect(foreignOperationalCalls).toEqual([]);
  } finally { off(); }
}, 5000);

it("A6 imports real winning memory into search and embedding state", async () => {
  const source = replica(A, "repo"), dest = replica(B, "repo");
  enableMemoryCapture(source.db, source.storeKey);
  source.db.prepare("INSERT INTO memory(uuid,category,content,status,source,created_at) VALUES ('memory-a','insight','searchable phrase','active','user',1)").run();
  await transfer(source, dest);
  expect(dest.db.prepare("SELECT uuid FROM memory_fts WHERE memory_fts MATCH 'searchable'").all()).toEqual([{ uuid: "memory-a" }]);
  expect(dest.db.prepare("SELECT owner_id,text FROM embed_queue").all()).toEqual([{ owner_id: "memory-a", text: "searchable phrase" }]);
}, 5000);

it("A6 resolves imported session data read-only without a checkout", async () => {
  const source = replica(A), global = replica(B, "global");
  seedSession(source.db, SESSION, 1, source.storeKey, 4096);
  source.db.prepare("INSERT INTO sessions(id,name,started_at) VALUES (?, 'remote title', 1)").run(SESSION);
  source.db.prepare("INSERT INTO todos(uuid,session_id,seq,text,created_at) VALUES ('todo-a',?,1,'remote todo',1)").run(SESSION);
  const run = new RunStore(source.db).create({ sessionId: SESSION, agent: "worker", task: "remote history" });
  mkdirSync(join(global.root, "roam", "stores"), { recursive: true, mode: 0o700 });
  const db = openDbAt(replicaPath(global.db, source.storeKey), "worktree");
  try {
    db.prepare("UPDATE roam_meta SET machine_id=?,store_key=?").run(B, source.storeKey);
    await transfer(source, { root: global.root, db, storeKey: source.storeKey, machineId: B, close() {} });
    catalogReplica(global.db, source.storeKey, db);
    const projects = global.db.prepare("SELECT * FROM projects").all();
    const resolved = resolveSessionReplica(global.db, SESSION);
    expect(resolved).not.toBeNull();
    try {
      expect(resolved!.db.raw.readonly).toBe(true);
      expect(resolved!.db.prepare("SELECT text FROM todos WHERE session_id=?").all(SESSION)).toEqual([{ text: "remote todo" }]);
      expect(new RunStore(resolved!.db).get(run.id)?.task).toBe("remote history");
      expect(global.db.prepare("SELECT * FROM projects").all()).toEqual(projects);
    } finally { resolved?.db.close(); }
  } finally { db.close(); }
}, 5000);

it("A7 imported foreign runs cannot operate or charge while local runs still do", async () => {
  const source = replica(A), dest = replica(B);
  seedSession(source.db, SESSION, 1, source.storeKey, 4096);
  const sourceStore = new RunStore(source.db);
  const done = sourceStore.create({ sessionId: SESSION, agent: "worker", name: "foreign" });
  const running = sourceStore.create({ sessionId: SESSION, agent: "worker", name: "foreign-running" });
  const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  recordRunUsage(source.db, done.id, { provider: "fixture", model: "foreign", usage });
  sourceStore.finish(done.id, { status: "done", result: "complete" });
  sourceStore.start(running.id);
  sourceStore.setPid(running.id, 4321, 9876);
  await transfer(source, dest);
  const store = new RunStore(dest.db);
  expect(store.get(running.id)).toMatchObject({ pid: null, host_pid: null, origin_machine: A });
  // Simulate a stale local process-identity collision after the sanitized import.
  dest.db.raw.transaction(() => {
    dest.db.prepare("UPDATE roam_meta SET importing=1").run();
    dest.db.prepare("UPDATE runs SET pid=4321,host_pid=9876 WHERE id=?").run(running.id);
    dest.db.prepare("UPDATE roam_meta SET importing=0").run();
  })();
  const foreignOperationalCalls: string[] = [], foreignCharges: string[] = [], localCharges: string[] = [];
  const notify = makeAsyncNotifier({ db: dest.db, pi: { sendMessage: () => foreignOperationalCalls.push("delivery") } });
  notify(store.get(done.id), "done", "complete");
  const killed = await killRun({ db: dest.db, store, getChild: () => ({ kill: () => foreignOperationalCalls.push("kill") }) }, SESSION, store.get(running.id)!);
  const reaped = await reapOrphanRuns({ db: dest.db, alive: pid => pid === 4321, probeCommand: () => "pi --mode json -p --session fixture Task: work", kill: async () => { foreignOperationalCalls.push("reap"); } });
  const accounting = new UsageAccounting();
  accounting.activate({ sessionManager: { getSessionId: () => SESSION, getEntries: () => [], appendUsage: (_kind: string, _provider: string, model: string) => foreignCharges.push(model) } });
  try {
    accounting.restore(dest.db, SESSION);
    accounting.reportRun(dest.db, store.get(done.id)!);
    expect(killed.outcome).toBe("failed");
    expect(reaped.reaped).toEqual([]);
    expect(foreignOperationalCalls).toEqual([]);
    expect(foreignCharges).toEqual([]);
    expect(dest.db.prepare("SELECT type FROM run_events WHERE run_id=? AND type='spider_usage_reported'").all(done.id)).toEqual([]);
    // An active destination still holds runs executed on the previous machine.
    dest.db.prepare("UPDATE roam_sessions SET state='active',epoch=2 WHERE session_id=?").run(SESSION);
    reportRunUsage(dest.db, store.get(done.id)!, () => { foreignCharges.push("direct"); return true; });
    accounting.restore(dest.db, SESSION);
    expect(foreignCharges).toEqual([]);
    expect(dest.db.prepare("SELECT type FROM run_events WHERE run_id=? AND type='spider_usage_reported'").all(done.id)).toEqual([]);
    const local = store.create({ sessionId: "local-session", agent: "worker", name: "local" });
    recordRunUsage(dest.db, local.id, { provider: "fixture", model: "local", usage });
    store.finish(local.id, { status: "done", result: "complete" });
    appendRunEvent(dest.db, { runId: local.id, sessionId: "local-session", ts: 1, type: "child_supervisor", payload: { version: 1, directory: "fixture" } });
    const localDeliveries: string[] = [];
    const localNotify = makeAsyncNotifier({ db: dest.db, pi: { sendMessage: (message: { details: { runId: string } }) => localDeliveries.push(message.details.runId) } });
    localNotify(store.get(local.id), "done", "complete");
    localNotify(store.get(local.id), "done", "complete");
    expect(localDeliveries).toEqual([local.id]);
    accounting.activate({ sessionManager: { getSessionId: () => "local-session", getEntries: () => [], appendUsage: (_kind: string, _provider: string, model: string) => localCharges.push(model) } });
    accounting.restore(dest.db, "local-session");
    accounting.restore(dest.db, "local-session");
    expect(localCharges).toEqual(["local"]);
  } finally { accounting.shutdown(); }
}, 5000);
