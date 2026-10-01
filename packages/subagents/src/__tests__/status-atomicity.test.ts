import { afterEach, expect, it } from "vitest";
import { openDbAt, type Db } from "@spider/db-core";
import { RunStore } from "../run-store";
import { Runner, type ChildHandle } from "../runner";
import { RunEventTailer } from "../event-tailer";
import { makeChildReporter } from "../child-reporter";
import { teardownAll } from "../coordinators";
import { reapOrphanRuns } from "../reaper";
import { freshDb, testScratchPath } from "./helpers/testutil";

const dbs: Db[] = [];
afterEach(() => {
  teardownAll();
  for (const db of dbs.splice(0)) db.close();
});
function fixture() {
  const db = freshDb();
  dbs.push(db);
  return { db, store: new RunStore(db) };
}
function failStatusInsert(db: Db, statuses: string[]) {
  db.exec(`CREATE TRIGGER fail_status BEFORE INSERT ON run_events
    WHEN NEW.type = 'status' AND json_extract(NEW.payload, '$.status') IN (${statuses.map(s => `'${s}'`).join(",")})
    BEGIN SELECT RAISE(ABORT, 'fixture status insert failure'); END`);
}
function runner(db: Db, store: RunStore, spawn: () => ChildHandle, globalDb?: Db) {
  return new Runner(db, "atomic", testScratchPath("cwd"), {
    store, globalDb, spawn, tailer: new RunEventTailer(db),
    scratchRoot: testScratchPath("atomic"), dbPath: "fixture.db",
  });
}
function statuses(db: Db, id: string) {
  return (db.prepare("SELECT payload FROM run_events WHERE run_id=? AND type='status' ORDER BY id").all(id) as Array<{ payload: string }>).map(e => JSON.parse(e.payload).status);
}

it.each(["queued", "running", "paused"] as const)("cancel rolls back the entire %s row when the status insert fails", status => {
  const { db } = fixture();
  const globalDb = openDbAt(testScratchPath(`cancel-route-${status}.db`), "global");
  dbs.push(globalDb);
  const store = new RunStore(db, globalDb);
  const { id } = store.create({ sessionId: "atomic", agent: "worker" });
  db.prepare("UPDATE runs SET status=?, result='checkpoint' WHERE id=?").run(status, id);
  globalDb.prepare("INSERT INTO run_routes VALUES (?,?,?)").run(id, "atomic", "fixture.db");
  const before = store.get(id);
  failStatusInsert(db, ["cancelled"]);

  expect(() => store.cancel(id, "stop")).toThrow("fixture status insert failure");
  expect(store.get(id)).toEqual(before);
  expect(statuses(db, id)).toEqual([]);
  expect(globalDb.prepare("SELECT run_id FROM run_routes WHERE run_id=?").get(id)).toEqual({ run_id: id });
});

it.each([false, true])("failed kill restore rolls back when its status insert fails (async=%s)", async asynchronous => {
  const { db } = fixture();
  const globalDb = openDbAt(testScratchPath(`restore-route-${asynchronous}.db`), "global");
  dbs.push(globalDb);
  const store = new RunStore(db, globalDb);
  let finish!: (v: { exitCode: number; result: string }) => void;
  const exit = new Promise<{ exitCode: number; result: string }>(resolve => { finish = resolve; });
  let cancelled: ReturnType<RunStore["get"]>;
  const fail = () => { cancelled = store.get(id); throw new Error("fixture kill failed"); };
  const handle: ChildHandle = { wait: () => exit, detach() {}, kill: fail, ...(asynchronous ? { killAsync: async () => fail() } : {}) };
  const pending = runner(db, store, () => handle, globalDb).runForeground({ agent: "worker", task: "work", context: "fresh" });
  const id = store.listActive("atomic")[0].id;
  db.prepare("UPDATE runs SET status='paused', result='checkpoint' WHERE id=?").run(id);
  failStatusInsert(db, ["paused"]);
  try {
    let error: unknown;
    try {
      if (asynchronous) await handle.killAsync!(1, "stop");
      else handle.kill("stop");
    } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map(e => e.message)).toEqual(["fixture kill failed", "fixture status insert failure"]);
    expect(store.get(id)).toEqual(cancelled);
    expect(store.get(id)).toMatchObject({ status: "cancelled", result: "stop" });
    expect(statuses(db, id)).toEqual(["running", "cancelled"]);
    expect(globalDb.prepare("SELECT run_id FROM run_routes WHERE run_id=?").get(id)).toBeUndefined();
  } finally {
    db.exec("DROP TRIGGER fail_status");
    finish({ exitCode: 0, result: "report" });
    await pending;
  }
});

it("launch rolls back both transitions but remains reapable after its host exits", async () => {
  const { db, store } = fixture();
  failStatusInsert(db, ["running", "failed"]);
  expect(() => runner(db, store, () => { throw new Error("unexpected spawn"); }).runAsync({ agent: "worker", task: "work", context: "fresh" })).toThrow("fixture status insert failure");
  const row = store.listForSession("atomic")[0];
  expect(row).toMatchObject({ status: "queued", started_at: null, ended_at: null, result: null, host_pid: process.pid, pid: null });
  expect(statuses(db, row.id)).toEqual([]);
  db.exec("DROP TRIGGER fail_status");
  const reaped = await reapOrphanRuns({ db, store, selfPid: -1, alive: () => false, kill: async () => { throw new Error("unexpected signal"); } });
  expect(reaped.reaped).toEqual([row.id]);
  expect(store.listActive("atomic")).toEqual([]);
});

it("parent finalization rolls back when terminal status inserts fail", async () => {
  const { db, store } = fixture();
  let finish!: (v: { exitCode: number; result: string }) => void;
  const exit = new Promise<{ exitCode: number; result: string }>(resolve => { finish = resolve; });
  const pending = runner(db, store, () => ({ wait: () => exit, kill() {}, detach() {} })).runForeground({ agent: "worker", task: "work", context: "fresh" });
  const before = store.listActive("atomic")[0];
  failStatusInsert(db, ["done", "failed"]);
  finish({ exitCode: 0, result: "report" });
  await expect(pending).rejects.toThrow("fixture status insert failure");
  expect(store.get(before.id)).toEqual(before);
  expect(statuses(db, before.id)).toEqual(["running"]);
  db.exec("DROP TRIGGER fail_status");
  const reaped = await reapOrphanRuns({ db, store, selfPid: -1, alive: () => false });
  expect(reaped.reaped).toEqual([before.id]);
  expect(store.listActive("atomic")).toEqual([]);
});

it("child shutdown rolls back when the terminal status insert fails", () => {
  const { db, store } = fixture();
  const { id } = store.create({ sessionId: "atomic", agent: "worker" });
  store.start(id);
  const reporter = makeChildReporter(db, { runId: id, sessionId: "atomic" });
  const before = store.get(id);
  failStatusInsert(db, ["done"]);
  expect(() => reporter.onShutdown("done", "report")).toThrow("fixture status insert failure");
  expect(store.get(id)).toEqual(before);
  expect(statuses(db, id)).toEqual([]);
});
