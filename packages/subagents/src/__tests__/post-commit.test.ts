import { afterEach, expect, it, vi } from "vitest";
import { bus, openDbAt, type Db } from "@spider/db-core";
import { AgentStore, type RunEvent, type RunRow as UiRunRow, type RunSource } from "@spider/ui";
import { RunStore } from "../run-store";
import { Runner } from "../runner";
import { RunEventTailer } from "../event-tailer";
import { PipelineCoordinator } from "../pipeline";
import { makeChildReporter } from "../child-reporter";
import { teardownAll } from "../coordinators";
import { testScratchPath } from "./helpers/testutil";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";

const require = createRequire(import.meta.url);
const lockHolders: ChildProcess[] = [];

const dbs: Db[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  teardownAll();
  for (const child of lockHolders.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
    }
  }
  for (const db of dbs.splice(0)) db.close();
});

function twoConnections() {
  const path = testScratchPath(`probe-${randomUUID()}.db`);
  const a = openDbAt(path, "project");
  const b = openDbAt(path, "project");
  dbs.push(a, b);
  return { a, b, path };
}
function runSource(db: Db, sessionId: string): RunSource {
  return {
    listActive: () => db.prepare(`SELECT * FROM runs WHERE session_id = ? AND status IN ('queued','running','paused')`).all(sessionId) as UiRunRow[],
    getRun: (id: string) => db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as UiRunRow | undefined,
    subscribe: (fn: (event: RunEvent) => void) => bus.on((event) => { if (event.sessionId === sessionId) fn(event); }),
  };
}

it("cancel: cancel on connection A is projected as cancelled by a UI reading connection B", () => {
  const { a, b } = twoConnections();
  const store = new RunStore(a);
  const { id } = store.create({ sessionId: "p1", agent: "worker" });
  store.start(id);
  const agents = new AgentStore(runSource(b, "p1"));
  agents.start();
  try {
    expect(agents.snapshot()[0]).toMatchObject({ runId: id, status: "running" });
    store.cancel(id, "stop");
    expect(store.get(id)!.status).toBe("cancelled");
    expect(agents.snapshot()[0]).toMatchObject({ runId: id, status: "cancelled" });
  } finally { agents.stop(); }
});

it("finalize: parent finalize on connection A is projected as done by a UI reading connection B", async () => {
  const { a, b } = twoConnections();
  const store = new RunStore(a);
  const agents = new AgentStore(runSource(b, "p2"));
  agents.start();
  let finish!: (v: { exitCode: number; result: string }) => void;
  const exit = new Promise<{ exitCode: number; result: string }>(r => { finish = r; });
  const runner = new Runner(a, "p2", testScratchPath("cwd"), {
    store, spawn: () => ({ wait: () => exit, kill() {}, detach() {} }), tailer: new RunEventTailer(a),
    scratchRoot: testScratchPath("p2"), dbPath: "fixture.db",
  });
  try {
    const pending = runner.runForeground({ agent: "worker", task: "t", context: "fresh" });
    finish({ exitCode: 0, result: "report" });
    const row = await pending;
    expect(row.status).toBe("done");
    expect(agents.snapshot()[0]).toMatchObject({ runId: row.id, status: "done" });
  } finally { agents.stop(); }
});

it("pipeline: pipeline next-stage spawn runs outside any open write transaction", async () => {
  const { a, b } = twoConnections();
  const globalDb = openDbAt(testScratchPath(`probe-global-${randomUUID()}.db`), "global");
  dbs.push(globalDb);
  const store = new RunStore(a, globalDb);
  const exits: Array<(v: { exitCode: number; result: string }) => void> = [];
  const spawnInTx: boolean[] = [];
  const otherWriterBusy: boolean[] = [];
  b.raw.pragma("busy_timeout = 0");
  const runner = new Runner(a, "p3", testScratchPath("cwd"), {
    store, globalDb, tailer: new RunEventTailer(a), scratchRoot: testScratchPath("p3"), dbPath: "fixture.db",
    spawn: () => {
      spawnInTx.push(a.raw.inTransaction);
      let busy = false;
      try { b.prepare("UPDATE runs SET phase = phase WHERE 0").run(); b.prepare("INSERT INTO run_events (run_id, session_id, ts, type) VALUES ('x','p3',0,'probe')").run(); } catch (e) { busy = /locked|BUSY/i.test(String(e)); }
      otherWriterBusy.push(busy);
      const exit = new Promise<{ exitCode: number; result: string }>(r => { exits.push(r); });
      return { wait: () => exit, kill() {}, detach() {} };
    },
  });
  const coord = new PipelineCoordinator({ db: a, globalDb, store, runner, pi: {}, sessionId: "p3" });
  coord.start({ pipeline: [{ agent: "worker", task: "one" }, { agent: "reviewer", task: "{previous}" }], handoff: "intercom", async: true } as any);
  exits[0]({ exitCode: 0, result: "stage one output" });
  await new Promise<void>(r => setImmediate(r));
  coord.dispose();
  expect(exits.length).toBe(2);
  expect(spawnInTx).toEqual([false, false]);
  expect(otherWriterBusy).toEqual([false, false]);
  exits[1]({ exitCode: 0, result: "two" });
  await new Promise<void>(r => setImmediate(r));
});


it("pipeline: a failing finalize COMMIT never launches the next stage", async () => {
  const { a, b } = twoConnections();
  const globalDb = openDbAt(testScratchPath(`commit-global-${randomUUID()}.db`), "global");
  dbs.push(globalDb);
  const store = new RunStore(a, globalDb);
  const exits: Array<(v: { exitCode: number; result: string }) => void> = [];
  let completed = 0;
  const runner = new Runner(a, "commit", testScratchPath("cwd"), {
    store, globalDb, tailer: new RunEventTailer(a), scratchRoot: testScratchPath("commit"), dbPath: "fixture.db",
    onComplete: () => { completed++; },
    spawn: () => {
      const exit = new Promise<{ exitCode: number; result: string }>(r => { exits.push(r); });
      return { wait: () => exit, kill() {}, detach() {} };
    },
  });
  // Deferred FK violations fail COMMIT, not the event insert or transaction body.
  a.exec(`CREATE TABLE commit_parent (id INTEGER PRIMARY KEY);
    CREATE TABLE commit_child (id INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER fail_commit AFTER INSERT ON run_events
    WHEN NEW.type='status' AND json_extract(NEW.payload, '$.status') IN ('done','failed')
    BEGIN INSERT INTO commit_child VALUES (1); END;`);
  const coord = new PipelineCoordinator({ db: a, globalDb, store, runner, pi: {}, sessionId: "commit" });
  const { firstRunId } = coord.start({ pipeline: [{ agent: "worker", task: "one" }, { agent: "reviewer", task: "{previous}" }], handoff: "intercom", async: true } as any);
  try {
    exits[0]({ exitCode: 0, result: "stage one output" });
    await new Promise<void>(r => setImmediate(r));
    expect(exits).toHaveLength(1);
    expect(b.prepare("SELECT status FROM runs WHERE id=?").get(firstRunId)).toEqual({ status: "running" });
    expect(b.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 1 });
    expect(completed).toBe(0);
    expect(b.prepare("SELECT COUNT(*) AS n FROM run_events WHERE type='warning'").get()).toEqual({ n: 1 });
  } finally {
    coord.dispose();
    a.exec("DROP TRIGGER fail_commit");
    for (const finish of exits.slice(1)) finish({ exitCode: 0, result: "cleanup" });
    await new Promise<void>(r => setImmediate(r));
  }
});

it.each(["cancel", "finish"] as const)("%s route cleanup waits for the outermost commit and is discarded on rollback", method => {
  const { a, b } = twoConnections();
  const globalDb = openDbAt(testScratchPath(`route-global-${randomUUID()}.db`), "global");
  dbs.push(globalDb);
  const store = new RunStore(a, globalDb);
  const { id } = store.create({ sessionId: "route", agent: "worker" });
  store.start(id);
  globalDb.prepare("INSERT INTO run_routes VALUES (?,?,?)").run(id, "route", "fixture.db");
  const route = () => globalDb.prepare("SELECT run_id FROM run_routes WHERE run_id=?").get(id);
  const finish = () => method === "cancel" ? store.cancel(id, "stop") : store.finish(id, { status: "done" });
  expect(() => a.transaction(() => {
    finish();
    expect(route()).toEqual({ run_id: id });
    throw new Error("outer rollback");
  })()).toThrow("outer rollback");
  expect(route()).toEqual({ run_id: id });
  expect(b.prepare("SELECT status FROM runs WHERE id=?").get(id)).toEqual({ status: "running" });
  a.transaction(() => {
    finish();
    expect(route()).toEqual({ run_id: id });
  })();
  expect(route()).toBeUndefined();
});

it.each([false, true])("finalize deletes its route only after the project transaction closes (store owns routes=%s)", async storeOwnsRoutes => {
  const { a, b } = twoConnections();
  const globalDb = openDbAt(testScratchPath(`finalize-global-${randomUUID()}.db`), "global");
  dbs.push(globalDb);
  const store = new RunStore(a, storeOwnsRoutes ? globalDb : undefined);
  const inTransaction: boolean[] = [];
  const prepare = globalDb.prepare.bind(globalDb);
  vi.spyOn(globalDb, "prepare").mockImplementation(sql => {
    if (/DELETE FROM run_routes/.test(sql)) inTransaction.push(a.raw.inTransaction);
    return prepare(sql);
  });
  let finish!: (v: { exitCode: number; result: string }) => void;
  const exit = new Promise<{ exitCode: number; result: string }>(resolve => { finish = resolve; });
  const runner = new Runner(a, "finalize-route", testScratchPath("cwd"), {
    store, globalDb, spawn: () => ({ wait: () => exit, kill() {}, detach() {} }), tailer: new RunEventTailer(a),
    scratchRoot: testScratchPath("finalize-route"), dbPath: "fixture.db",
  });
  const pending = runner.runForeground({ agent: "worker", task: "work", context: "fresh" });
  const id = store.listActive("finalize-route")[0].id;
  expect(globalDb.prepare("SELECT run_id FROM run_routes WHERE run_id=?").get(id)).toEqual({ run_id: id });
  finish({ exitCode: 0, result: "report" });
  await pending;
  expect(inTransaction).toEqual([false]);
  expect(b.prepare("SELECT status FROM runs WHERE id=?").get(id)).toEqual({ status: "done" });
  expect(globalDb.prepare("SELECT run_id FROM run_routes WHERE run_id=?").get(id)).toBeUndefined();
});

it("child shutdown succeeds after a sibling commits before its first transaction write", () => {
  const { a, b } = twoConnections();
  const store = new RunStore(a);
  const { id } = store.create({ sessionId: "sibling", agent: "worker" });
  store.start(id);
  const reporter = makeChildReporter(a, { runId: id, sessionId: "sibling" });
  const prepare = a.prepare.bind(a);
  let committed = false;
  vi.spyOn(a, "prepare").mockImplementation(sql => {
    if (a.raw.inTransaction && /^UPDATE runs/.test(sql) && !committed) {
      // If shutdown read first, this sibling commit invalidates that snapshot.
      // Pass through the real statements so SQLite detects the failed upgrade.
      b.prepare("INSERT INTO run_events (run_id,session_id,ts,type) VALUES ('sibling','sibling',0,'tool_intent')").run();
      committed = true;
    }
    return prepare(sql);
  });
  expect(() => reporter.onShutdown("done", "child report")).not.toThrow();
  expect(committed).toBe(true);
  expect(b.prepare("SELECT status, result FROM runs WHERE id=?").get(id)).toEqual({ status: "done", result: "child report" });
  expect(b.prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id=? AND type='status'").get(id)).toEqual({ n: 1 });
});

async function holdWriteLock(path: string, ms: number): Promise<void> {
  const script = `const Database = require(${JSON.stringify(require.resolve("better-sqlite3"))});
    const db = new Database(${JSON.stringify(path)});
    db.exec('BEGIN IMMEDIATE');
    db.prepare("INSERT INTO run_events (run_id,session_id,ts,type) VALUES ('sibling','lock',0,'tool_intent')").run();
    process.stdout.write('locked\\n');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, ${ms});`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  lockHolders.push(child);
  await new Promise<void>((resolve, reject) => {
    let output = "";
    let stderr = "";
    child.stderr!.on("data", data => { stderr += String(data); });
    child.stdout!.on("data", data => {
      output += String(data);
      if (output.includes("locked\n")) resolve();
    });
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`lock holder exited before readiness: ${code}: ${stderr}`)));
  });
}

it("child shutdown waits for a sibling's 400 ms write lock and persists its terminal report", async () => {
  const { a, b, path } = twoConnections();
  const store = new RunStore(a);
  const { id } = store.create({ sessionId: "lock", agent: "worker" });
  store.start(id);
  const reporter = makeChildReporter(a, { runId: id, sessionId: "lock" });
  await holdWriteLock(path, 400);
  expect(() => reporter.onShutdown("done", "child report")).not.toThrow();
  expect(b.prepare("SELECT status, result FROM runs WHERE id=?").get(id)).toEqual({ status: "done", result: "child report" });
  expect(b.prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id=? AND type='status'").get(id)).toEqual({ n: 1 });
});

it("child shutdown cannot finish a row whose ownership changed after preflight", () => {
  const { a, b } = twoConnections();
  const store = new RunStore(a);
  const { id } = store.create({ sessionId: "ownership", agent: "worker" });
  store.start(id);
  const reporter = makeChildReporter(a, { runId: id, sessionId: "ownership" });
  const transaction = a.transaction.bind(a);
  vi.spyOn(a, "transaction").mockImplementationOnce(fn => {
    b.prepare("UPDATE runs SET pid=? WHERE id=?").run(process.pid + 1, id);
    return transaction(fn);
  });
  reporter.onShutdown("done", "child report");
  expect(store.get(id)!.status).toBe("running");
  expect(b.prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id=? AND type='status'").get(id)).toEqual({ n: 0 });
});

it("child shutdown does not duplicate a cancellation committed before its transaction starts", () => {
  const { a, b } = twoConnections();
  const store = new RunStore(a);
  const { id } = store.create({ sessionId: "race", agent: "worker" });
  store.start(id);
  const reporter = makeChildReporter(a, { runId: id, sessionId: "race" });
  const transaction = a.transaction.bind(a);
  vi.spyOn(a, "transaction").mockImplementationOnce(fn => {
    // Simulate the parent winning after the child's preflight read but before BEGIN.
    new RunStore(b).cancel(id, "parent stop");
    return transaction(fn);
  });
  reporter.onShutdown("done", "child report");
  expect(store.get(id)).toMatchObject({ status: "cancelled", result: "parent stop" });
  expect(b.prepare("SELECT COUNT(*) AS n FROM run_events WHERE type='status'").get()).toEqual({ n: 1 });
});
