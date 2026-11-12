import { describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "../testutil";
import { enableMemoryCapture, seedSession } from "../roam/seed";
import { readSessionState } from "../roam/state";
import { Runner, type ChildHandle } from "../../../subagents/src/runner";
import { RunStore } from "../../../subagents/src/run-store";
import { RunEventTailer } from "../../../subagents/src/event-tailer";
import { discoverDurableChildren } from "../../../subagents/src/durable-adoption";
import { getShared, releaseShared } from "../../../subagents/src/child-registry";
import { reportRunUsage } from "../../../subagents/src/usage";
import { openDb, type Db } from "../db";
import type { StoreKey } from "../roam/types";

const MACHINE = "11111111-1111-4111-8111-111111111111";
const SESSION = "session-a";

function finishSeed(db: Db, key: StoreKey, limit: number) {
  let result = seedSession(db, SESSION, 1, key, limit);
  for (let i = 0; !result.complete && i < 100; i++) result = seedSession(db, SESSION, 1, key, limit);
  if (!result.complete) throw new Error("fixture seed did not finish");
  return result;
}

describe("roaming seeding", () => {
  it("active runs and their events seed atomically with activation", () => {
    const { db, storeKey, close } = createReplica("worktree", MACHINE);
    try {
      db.exec("UPDATE roam_meta SET store_key = NULL");
      db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, 1)").run(SESSION);
      db.prepare("INSERT INTO todos (uuid, session_id, seq, text, created_at) VALUES ('todo-a', ?, 1, 'first', 1)").run(SESSION);
      const addRun = db.prepare("INSERT INTO runs (id, session_id, agent, status) VALUES (?, ?, 'worker', ?)");
      addRun.run("queued", SESSION, "queued");
      addRun.run("running", SESSION, "running");
      addRun.run("paused", SESSION, "paused");
      addRun.run("finished", SESSION, "done");
      const addEvent = db.prepare("INSERT INTO run_events (uuid, run_id, session_id, ts, type) VALUES (?, ?, ?, ?, 'progress')");
      addEvent.run("old-z", "running", SESSION, 1);
      addEvent.run("old-a", "running", SESSION, 2);
      addEvent.run("queued-event", "queued", SESSION, 3);
      addEvent.run("paused-event", "paused", SESSION, 4);
      addEvent.run("finished-event", "finished", SESSION, 5);
      db.exec(`CREATE TEMP TRIGGER fail_seed BEFORE INSERT ON main.roam_changes
        WHEN NEW.entity = 'run_events' BEGIN SELECT RAISE(ABORT, 'fixture seed failure'); END`);
      expect(() => seedSession(db, SESSION, 1, storeKey, 1)).toThrow(/fixture seed failure/);
      expect(db.prepare("SELECT store_key, capture_enabled FROM roam_meta").get()).toEqual({ store_key: null, capture_enabled: 0 });
      expect(readSessionState(db, SESSION)).toBeNull();
      expect(db.prepare("SELECT count(*) AS n FROM roam_changes").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM roam_versions").get()).toEqual({ n: 0 });
      db.exec("DROP TRIGGER temp.fail_seed");
      const result = seedSession(db, SESSION, 1, storeKey, 1);
      expect(result.complete).toBe(false);
      expect(readSessionState(db, SESSION)).toMatchObject({ epoch: 1, state: "active" });
      expect(db.prepare("SELECT row_key FROM roam_changes WHERE entity = 'runs' ORDER BY row_key").all()).toEqual([
        { row_key: "paused" }, { row_key: "queued" }, { row_key: "running" },
      ]);
      expect(db.prepare("SELECT row_key FROM roam_changes WHERE entity = 'todos'").all()).toEqual([{ row_key: "todo-a" }]);
      addEvent.run("new", "running", SESSION, 6);
      expect(db.prepare("SELECT row_key FROM roam_changes WHERE entity = 'run_events' AND json_extract(body_json, '$.run_id') = 'running' ORDER BY seq").all())
        .toEqual([{ row_key: "old-z" }, { row_key: "old-a" }, { row_key: "new" }]);
      expect(db.prepare("SELECT row_key FROM roam_changes WHERE entity = 'run_events' AND row_key = 'finished-event'").all()).toEqual([]);
    } finally { close(); }
  }, 5000);

  it("recently cancelled run restored after activation keeps its order", async () => {
    const fixture = createReplica("worktree", MACHINE);
    const { db, storeKey } = fixture;
    let finish!: (value: { exitCode: number; result: string }) => void;
    let rejectKill!: (reason: Error) => void;
    const exit = new Promise<{ exitCode: number; result: string }>(resolve => { finish = resolve; });
    const failedKill = new Promise<never>((_resolve, reject) => { rejectKill = reject; });
    const handle: ChildHandle = { wait: () => exit, detach() {}, kill() {}, killAsync: () => failedKill };
    let kill: Promise<void> | undefined;
    try {
      db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, 1)").run(SESSION);
      const store = new RunStore(db);
      const runner = new Runner(db, SESSION, fixture.root, {
        store, tailer: new RunEventTailer(db), scratchRoot: fixture.root,
        dbPath: db.raw.name, spawn: () => handle,
      });
      const run = runner.runAsync({ agent: "worker", task: "fixture", context: "fresh" });
      kill = handle.killAsync!(0, "fixture refusal");
      expect(store.get(run.id)?.status).toBe("cancelled");
      const initial = db.prepare("SELECT uuid AS row_key FROM run_events WHERE run_id = ? ORDER BY id").all(run.id);
      expect(initial.length).toBeGreaterThanOrEqual(2);
      seedSession(db, SESSION, 1, storeKey, 1);
      expect(db.prepare("SELECT row_key FROM roam_changes WHERE entity = 'run_events' ORDER BY seq").all()).toEqual(initial);
      rejectKill(new Error("fixture refusal"));
      await expect(kill).rejects.toThrow("fixture refusal");
      expect(store.get(run.id)?.status).toBe("running");
      const source = db.prepare("SELECT uuid AS row_key FROM run_events WHERE run_id = ? ORDER BY id").all(run.id);
      expect(source).toHaveLength(initial.length + 1);
      expect(db.prepare("SELECT row_key FROM roam_changes WHERE entity = 'run_events' ORDER BY seq").all()).toEqual(source);
    } finally {
      rejectKill(new Error("fixture cleanup"));
      await kill?.catch(() => undefined);
      finish({ exitCode: 0, result: "fixture finished" });
      await exit;
      await Promise.resolve();
      fixture.close();
    }
  }, 5000);

  it("activation includes recent and undated cancellations but defers older ones", () => {
    const { db, storeKey, close } = createReplica("worktree", MACHINE);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, 1)").run(SESSION);
      const addRun = db.prepare("INSERT INTO runs (id, session_id, agent, status, ended_at) VALUES (?, ?, 'worker', 'cancelled', ?)");
      addRun.run("recent", SESSION, now - 60_000);
      addRun.run("boundary", SESSION, now - 600_000);
      addRun.run("undated", SESSION, null);
      addRun.run("old", SESSION, now - 600_001);
      const addEvent = db.prepare("INSERT INTO run_events (uuid, run_id, session_id, ts, type) VALUES (?, ?, ?, 1, 'progress')");
      for (const id of ["recent", "boundary", "undated", "old"]) addEvent.run(`${id}-event`, id, SESSION);
      expect(seedSession(db, SESSION, 1, storeKey, 1).complete).toBe(false);
      expect(db.prepare("SELECT row_key FROM roam_changes WHERE entity = 'runs' ORDER BY row_key").all()).toEqual([
        { row_key: "boundary" }, { row_key: "recent" }, { row_key: "undated" },
      ]);
      expect(db.prepare("SELECT row_key FROM roam_changes WHERE entity = 'run_events' ORDER BY row_key").all()).toEqual([
        { row_key: "boundary-event" }, { row_key: "recent-event" }, { row_key: "undated-event" },
      ]);
    } finally { clock.mockRestore(); close(); }
  }, 5000);

  it("busy session refuses activation without partial state", () => {
    const { db, storeKey, close } = createReplica("worktree", MACHINE);
    try {
      db.exec("UPDATE roam_meta SET store_key = NULL");
      db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, 1)").run(SESSION);
      db.prepare("INSERT INTO todos (uuid, session_id, seq, text, created_at) VALUES ('large', ?, 1, ?, 1)")
        .run(SESSION, "x".repeat(16 * 1024 * 1024));
      const before = db.prepare("SELECT store_key, capture_enabled, hlc_ms, hlc_count FROM roam_meta").get();
      expect(seedSession(db, SESSION, 1, storeKey, 4 * 1024 * 1024)).toMatchObject({
        complete: false, through: 0, retryable: true, reason: "session too busy to seed",
      });
      expect(db.prepare("SELECT store_key, capture_enabled, hlc_ms, hlc_count FROM roam_meta").get()).toEqual(before);
      expect(readSessionState(db, SESSION)).toBeNull();
      for (const table of ["roam_changes", "roam_versions", "roam_seed_progress"]) {
        expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      }
      db.prepare("UPDATE todos SET text = 'smaller' WHERE uuid = 'large'").run();
      expect(seedSession(db, SESSION, 1, storeKey, 4 * 1024 * 1024).complete).toBe(true);
      expect(readSessionState(db, SESSION)).toMatchObject({ state: "active", epoch: 1 });
    } finally { close(); }
  }, 5000);

  it("busy activation leaves other participants and capture intact", () => {
    const { db, storeKey, close } = createReplica("worktree", MACHINE);
    try {
      db.prepare("INSERT INTO sessions (id, started_at) VALUES ('already', 1), ('busy', 1)").run();
      const existing = seedSession(db, "already", 1, storeKey, 1024);
      expect(existing.complete).toBe(true);
      db.prepare("INSERT INTO todos (uuid, session_id, seq, text, created_at) VALUES ('large-busy', 'busy', 1, ?, 1)")
        .run("x".repeat(16 * 1024 * 1024));
      expect(seedSession(db, "busy", 1, storeKey, 1024)).toMatchObject({
        complete: false, through: existing.through, retryable: true, reason: "session too busy to seed",
      });
      expect(readSessionState(db, "busy")).toBeNull();
      expect(readSessionState(db, "already")).toMatchObject({ state: "active", epoch: 1 });
      expect(db.prepare("SELECT store_key, capture_enabled FROM roam_meta").get()).toEqual({ store_key: storeKey, capture_enabled: 1 });
      db.prepare("UPDATE sessions SET name = 'still captured' WHERE id = 'already'").run();
      expect(db.prepare("SELECT json_extract(body_json, '$.name') AS name FROM roam_changes WHERE entity = 'sessions' ORDER BY seq DESC LIMIT 1").get())
        .toEqual({ name: "still captured" });
    } finally { close(); }
  }, 5000);

  it("activation accepts exactly the hard body limit and rejects one byte more", () => {
    const { db, storeKey, close } = createReplica("worktree", MACHINE);
    const hard = 16 * 1024 * 1024;
    try {
      db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, 1)").run(SESSION);
      const sessionBody = { id: SESSION, parent_session_id: null, name: null, reason: null,
        started_at: 1, ended_at: null, summary: null, origin_machine: MACHINE };
      const todoBody = { uuid: "edge", session_id: SESSION, seq: 1, text: "", done: 0, created_at: 1, updated_at: null };
      const fill = hard - Buffer.byteLength(JSON.stringify(sessionBody)) - Buffer.byteLength(JSON.stringify(todoBody));
      db.prepare("INSERT INTO todos (uuid, session_id, seq, text, created_at) VALUES ('edge', ?, 1, ?, 1)")
        .run(SESSION, "x".repeat(fill + 1));
      expect(seedSession(db, SESSION, 1, storeKey, hard)).toMatchObject({ complete: false, retryable: true });
      expect(readSessionState(db, SESSION)).toBeNull();
      db.prepare("UPDATE todos SET text = ? WHERE uuid = 'edge'").run("x".repeat(fill));
      expect(seedSession(db, SESSION, 1, storeKey, hard).complete).toBe(true);
      expect(db.prepare("SELECT sum(length(CAST(body_json AS BLOB))) AS bytes FROM roam_changes").get()).toEqual({ bytes: hard });
    } finally { close(); }
  }, 5000);

  it("live update during bulk seed is not overwritten by the seed", () => {
    const { db, storeKey, close } = createReplica("worktree", MACHINE);
    try {
      db.prepare("INSERT INTO sessions (id, name, started_at) VALUES (?, 'before', 1)").run(SESSION);
      db.prepare("INSERT INTO runs (id, session_id, agent, status, result) VALUES ('finished', ?, 'worker', 'done', 'before')").run(SESSION);
      expect(seedSession(db, SESSION, 1, storeKey, 1).complete).toBe(false);
      db.prepare("UPDATE sessions SET name = 'after' WHERE id = ?").run(SESSION);
      db.prepare("UPDATE runs SET result = 'after' WHERE id = 'finished'").run();
      const liveVersion = db.prepare("SELECT change_id FROM roam_versions WHERE entity = 'runs' AND row_key = 'finished'").get();
      finishSeed(db, storeKey, 1);
      expect(db.prepare("SELECT json_extract(body_json, '$.name') AS name FROM roam_changes WHERE entity = 'sessions' ORDER BY seq").all())
        .toEqual([{ name: "before" }, { name: "after" }]);
      expect(db.prepare("SELECT json_extract(body_json, '$.result') AS result FROM roam_changes WHERE entity = 'runs' AND row_key = 'finished'").all())
        .toEqual([{ result: "after" }]);
      expect(db.prepare("SELECT change_id FROM roam_versions WHERE entity = 'runs' AND row_key = 'finished'").get()).toEqual(liveVersion);
      expect(db.prepare("SELECT name FROM sessions WHERE id = ?").get(SESSION)).toEqual({ name: "after" });
    } finally { close(); }
  }, 5000);

  it("bulk seeding resumes after the store is reopened", () => {
    const fixture = createReplica("worktree", MACHINE);
    const { db, storeKey } = fixture;
    let reopened: Db | undefined;
    try {
      db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, 1)").run(SESSION);
      const addRun = db.prepare("INSERT INTO runs (id, session_id, agent, status) VALUES (?, ?, 'worker', 'done')");
      for (const id of ["r1", "r2", "r3"]) addRun.run(id, SESSION);
      expect(seedSession(db, SESSION, 1, storeKey, 1).complete).toBe(false);
      expect(seedSession(db, SESSION, 1, storeKey, 1).complete).toBe(false);
      db.close();
      reopened = openDb(join(fixture.root, "store.db"), { fileMustExist: true });
      expect(readSessionState(reopened, SESSION)).toMatchObject({ state: "active", epoch: 1 });
      reopened.prepare("UPDATE runs SET result = 'updated after reopen' WHERE id = 'r3'").run();
      expect(finishSeed(reopened, storeKey, 1).complete).toBe(true);
      expect(reopened.prepare("SELECT row_key FROM roam_changes WHERE entity = 'runs' ORDER BY row_key").all()).toEqual([
        { row_key: "r1" }, { row_key: "r2" }, { row_key: "r3" },
      ]);
      expect(reopened.prepare("SELECT json_extract(body_json, '$.result') AS result FROM roam_changes WHERE entity = 'runs' AND row_key = 'r3'").get())
        .toEqual({ result: "updated after reopen" });
    } finally {
      try { reopened?.close(); } finally {
        if (db.raw.open) fixture.close();
        else rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  }, 5000);

  it("reused rowid during bulk seed is captured exactly once", () => {
    const { db, storeKey, close } = createReplica("worktree", MACHINE);
    try {
      db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, 1)").run(SESSION);
      db.prepare("INSERT INTO runs (id, session_id, agent, status) VALUES ('finished', ?, 'worker', 'done')").run(SESSION);
      const add = db.prepare("INSERT INTO run_events (uuid, run_id, session_id, ts, type) VALUES (?, 'finished', ?, ?, 'progress')");
      add.run("old-first", SESSION, 1);
      add.run("old-max", SESSION, 2);
      expect(seedSession(db, SESSION, 1, storeKey, 1).complete).toBe(false);
      for (let i = 0; i < 20 && !db.prepare("SELECT 1 FROM roam_versions WHERE entity = 'run_events' AND row_key = 'old-first'").get(); i++) {
        seedSession(db, SESSION, 1, storeKey, 1);
      }
      expect(db.prepare("SELECT 1 FROM roam_versions WHERE entity = 'run_events' AND row_key = 'old-first'").get()).toBeTruthy();
      const previous = db.prepare("SELECT rowid AS id FROM run_events WHERE uuid = 'old-max'").get();
      db.prepare("DELETE FROM run_events WHERE uuid = 'old-max'").run();
      add.run("new-reused", SESSION, 3);
      expect(db.prepare("SELECT rowid AS id FROM run_events WHERE uuid = 'new-reused'").get()).toEqual(previous);
      expect(db.prepare("SELECT row_key, op FROM roam_changes WHERE entity = 'run_events' AND row_key = 'new-reused'").all())
        .toEqual([{ row_key: "new-reused", op: "put" }]);
      finishSeed(db, storeKey, 1);
      expect(db.prepare("SELECT row_key, op FROM roam_changes WHERE entity = 'run_events' AND row_key IN ('old-max', 'new-reused') ORDER BY seq").all())
        .toEqual([{ row_key: "old-max", op: "delete" }, { row_key: "new-reused", op: "put" }]);
      expect(db.prepare("SELECT row_key, deleted FROM roam_versions WHERE entity = 'run_events' AND row_key IN ('old-max', 'new-reused') ORDER BY row_key").all())
        .toEqual([{ row_key: "new-reused", deleted: 0 }, { row_key: "old-max", deleted: 1 }]);
    } finally { close(); }
  }, 5000);

  it("seed completes only after a zero unversioned sweep", () => {
    const { db, storeKey, close } = createReplica("worktree", MACHINE);
    try {
      db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, 1)").run(SESSION);
      db.prepare("INSERT INTO runs (id, session_id, agent, status) VALUES ('finished', ?, 'worker', 'done')").run(SESSION);
      db.prepare("INSERT INTO run_events (uuid, run_id, session_id, ts, type) VALUES ('history', 'finished', ?, 1, 'progress')").run(SESSION);
      expect(seedSession(db, SESSION, 1, storeKey, 1).complete).toBe(false);
      db.prepare("UPDATE roam_seed_progress SET last_key = 'z', complete = 1 WHERE session_id = ?").run(SESSION);
      expect(seedSession(db, SESSION, 1, storeKey, 1).complete).toBe(false);
      expect(db.prepare("SELECT count(*) AS n FROM roam_versions WHERE entity = 'run_events' AND row_key = 'history'").get()).toEqual({ n: 0 });
      expect(finishSeed(db, storeKey, 1).complete).toBe(true);
      expect(db.prepare("SELECT entity, row_key FROM roam_versions WHERE (entity = 'runs' AND row_key = 'finished') OR (entity = 'run_events' AND row_key = 'history') ORDER BY entity").all())
        .toEqual([{ entity: "run_events", row_key: "history" }, { entity: "runs", row_key: "finished" }]);
      expect(db.prepare("SELECT count(*) AS n FROM roam_seed_progress WHERE session_id = ? AND complete = 0").get(SESSION)).toEqual({ n: 0 });
    } finally { close(); }
  }, 5000);

  it("finished runs and events seed in source rowid order", () => {
    const { db, storeKey, close } = createReplica("worktree", MACHINE);
    try {
      db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, 1)").run(SESSION);
      const addRun = db.prepare("INSERT INTO runs (id, session_id, agent, status) VALUES (?, ?, 'worker', 'done')");
      addRun.run("z-run", SESSION);
      addRun.run("a-run", SESSION);
      const addEvent = db.prepare("INSERT INTO run_events (uuid, run_id, session_id, ts, type) VALUES (?, 'z-run', ?, ?, 'progress')");
      addEvent.run("z-event", SESSION, 1);
      addEvent.run("a-event", SESSION, 2);
      seedSession(db, SESSION, 1, storeKey, 1);
      finishSeed(db, storeKey, 1);
      expect(db.prepare("SELECT row_key FROM roam_changes WHERE entity = 'runs' ORDER BY seq").all()).toEqual([
        { row_key: "z-run" }, { row_key: "a-run" },
      ]);
      expect(db.prepare("SELECT row_key FROM roam_changes WHERE entity = 'run_events' ORDER BY seq").all()).toEqual([
        { row_key: "z-event" }, { row_key: "a-event" },
      ]);
    } finally { close(); }
  }, 5000);

  it("last bulk batch and completion roll back together", () => {
    const { db, storeKey, close } = createReplica("worktree", MACHINE);
    try {
      db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, 1)").run(SESSION);
      db.prepare("INSERT INTO runs (id, session_id, agent, status) VALUES ('finished', ?, 'worker', 'done')").run(SESSION);
      expect(seedSession(db, SESSION, 1, storeKey, 1024).complete).toBe(false);
      const changes = db.prepare("SELECT seq, entity, row_key FROM roam_changes ORDER BY seq").all();
      const versions = db.prepare("SELECT entity, row_key FROM roam_versions ORDER BY entity, row_key").all();
      db.exec(`CREATE TEMP TRIGGER fail_completion BEFORE UPDATE ON main.roam_seed_progress
        WHEN NEW.complete = 1 AND EXISTS (SELECT 1 FROM roam_versions WHERE entity = 'runs' AND row_key = 'finished')
        BEGIN SELECT RAISE(ABORT, 'fixture completion failure'); END`);
      expect(() => seedSession(db, SESSION, 1, storeKey, 1024)).toThrow(/fixture completion failure/);
      expect(db.prepare("SELECT seq, entity, row_key FROM roam_changes ORDER BY seq").all()).toEqual(changes);
      expect(db.prepare("SELECT entity, row_key FROM roam_versions ORDER BY entity, row_key").all()).toEqual(versions);
      expect(db.prepare("SELECT count(*) AS n FROM roam_seed_progress WHERE complete = 1").get()).toEqual({ n: 0 });
      db.exec("DROP TRIGGER temp.fail_completion");
      expect(seedSession(db, SESSION, 1, storeKey, 1024).complete).toBe(true);
      expect(db.prepare("SELECT row_key FROM roam_changes WHERE entity = 'runs'").all()).toEqual([{ row_key: "finished" }]);
    } finally { close(); }
  }, 5000);

  it("oversized finished row stops seeding with its key", () => {
    const { db, storeKey, close } = createReplica("worktree", MACHINE);
    try {
      db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, 1)").run(SESSION);
      db.prepare("INSERT INTO runs (id, session_id, agent, status, task) VALUES ('large-run', ?, 'worker', 'done', ?)")
        .run(SESSION, "x".repeat(16 * 1024 * 1024));
      expect(seedSession(db, SESSION, 1, storeKey, 4096).complete).toBe(false);
      const before = db.prepare("SELECT seq, entity, row_key FROM roam_changes ORDER BY seq").all();
      expect(() => seedSession(db, SESSION, 1, storeKey, 4096)).toThrow(/large-run.*(large|limit)/i);
      expect(db.prepare("SELECT seq, entity, row_key FROM roam_changes ORDER BY seq").all()).toEqual(before);
      expect(readSessionState(db, SESSION)).toMatchObject({ state: "active" });
      expect(db.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 1 });
    } finally { close(); }
  }, 5000);

  it("seeding batches stay within the bound", () => {
    const { db, storeKey, close } = createReplica("worktree", MACHINE);
    const limit = 512;
    try {
      db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, 1)").run(SESSION);
      const add = db.prepare("INSERT INTO runs (id, session_id, agent, status, task) VALUES (?, ?, 'worker', 'done', ?)");
      for (let i = 0; i < 6; i++) add.run(`run-${i}`, SESSION, i === 3 ? '🙂"'.repeat(90) : "a".repeat(220));
      let result = seedSession(db, SESSION, 1, storeKey, limit);
      expect(result.complete).toBe(false);
      let batches = 0;
      let largerSingleton = false;
      while (!result.complete && batches < 20) {
        const before = result.through;
        result = seedSession(db, SESSION, 1, storeKey, limit);
        const size = db.prepare(`SELECT count(*) AS n, coalesce(sum(length(CAST(body_json AS BLOB))), 0) AS bytes
          FROM roam_changes WHERE seq > ? AND seq <= ?`).get(before, result.through) as { n: number; bytes: number };
        expect(size.bytes <= limit || (size.n === 1 && size.bytes <= 16 * 1024 * 1024)).toBe(true);
        if (size.bytes > limit && size.n === 1) largerSingleton = true;
        batches++;
      }
      expect(result.complete).toBe(true);
      expect(batches).toBeGreaterThan(1);
      expect(largerSingleton).toBe(true);
      expect(db.prepare("SELECT count(*) AS n FROM roam_versions WHERE entity = 'runs'").get()).toEqual({ n: 6 });
    } finally { close(); }
  }, 5000);

  it("finished run markers appended during seeding are found by existence readers", () => {
    const source = createReplica("worktree", MACHINE);
    const target = createReplica("worktree", "22222222-2222-4222-8222-222222222222");
    const runId = "marker-run";
    try {
      const directory = join(target.root, "supervisor");
      mkdirSync(directory);
      writeFileSync(join(directory, "exit.json"), JSON.stringify({ exitCode: 0 }));
      source.db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, 1)").run(SESSION);
      source.db.prepare("INSERT INTO runs (id, session_id, agent, status) VALUES (?, ?, 'worker', 'done')").run(runId, SESSION);
      const add = source.db.prepare("INSERT INTO run_events (uuid, run_id, session_id, ts, type, payload) VALUES (?, ?, ?, ?, ?, ?)");
      add.run("history-z", runId, SESSION, 1, "child_supervisor", JSON.stringify({ version: 1, directory }));
      add.run("history-a", runId, SESSION, 2, "spider_usage", JSON.stringify({ provider: "fixture", model: "fixture", usage: {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      } }));
      expect(seedSession(source.db, SESSION, 1, source.storeKey, 1).complete).toBe(false);
      add.run("marker-completion", runId, SESSION, 3, "completion_delivered", null);
      add.run("marker-usage", runId, SESSION, 4, "spider_usage_reported", null);
      finishSeed(source.db, source.storeKey, 1);
      const changes = source.db.prepare("SELECT body_json FROM roam_changes WHERE entity = 'run_events' ORDER BY seq").all() as Array<{ body_json: string }>;
      const events = changes.map(change => JSON.parse(change.body_json) as {
        uuid: string; run_id: string; session_id: string; ts: number; type: string;
        tool: string | null; summary: string | null; payload: string | null;
      });
      expect(events.map(event => event.type)).toEqual(["completion_delivered", "spider_usage_reported", "child_supervisor", "spider_usage"]);
      target.db.prepare("INSERT INTO runs (id, session_id, agent, status) VALUES (?, ?, 'worker', 'done')").run(runId, SESSION);
      const insert = target.db.prepare("INSERT INTO run_events (uuid, run_id, session_id, ts, type, tool, summary, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const event of events) insert.run(event.uuid, event.run_id, event.session_id, event.ts, event.type, event.tool, event.summary, event.payload);
      const run = new RunStore(target.db).get(runId)!;
      let reports = 0;
      const sink = () => { reports++; return true; };
      expect(reportRunUsage(target.db, run, sink)).toBe(false);
      expect(reports).toBe(0);
      discoverDurableChildren({ db: target.db, sessionId: SESSION });
      expect(getShared(runId)).toBeUndefined();
      target.db.prepare("DELETE FROM run_events WHERE type = 'completion_delivered'").run();
      discoverDurableChildren({ db: target.db, sessionId: SESSION });
      expect(getShared(runId)).toBeDefined();
      releaseShared(runId);
      target.db.prepare("DELETE FROM run_events WHERE type = 'spider_usage_reported'").run();
      expect(reportRunUsage(target.db, run, sink)).toBe(true);
      expect(reports).toBe(1);
    } finally { releaseShared(runId); target.close(); source.close(); }
  }, 5000);

  it("first seed chunk installs store key and capture", () => {
    const { db, storeKey, close } = createReplica("worktree", MACHINE);
    try {
      db.exec("UPDATE roam_meta SET store_key = NULL");
      db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, 1)").run(SESSION);
      const result = seedSession(db, SESSION, 1, storeKey, 1);
      expect(db.prepare("SELECT store_key, capture_enabled FROM roam_meta").get()).toMatchObject({ store_key: storeKey, capture_enabled: 1 });
      expect(readSessionState(db, SESSION)).toEqual({ sessionId: SESSION, epoch: 1, state: "active", moveId: null, freezeSeq: null });
      expect(db.prepare("SELECT entity, row_key, writer_session, writer_epoch FROM roam_changes").all()).toEqual([
        { entity: "sessions", row_key: SESSION, writer_session: SESSION, writer_epoch: 1 },
      ]);
      expect(result.through).toBe(1);
    } finally { close(); }
  }, 5000);

  it("seed resumes while normal capture continues", () => {
    const { db, storeKey, close } = createReplica("worktree", MACHINE);
    try {
      db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, 1)").run(SESSION);
      const insert = db.prepare("INSERT INTO todos (uuid, session_id, seq, text, created_at) VALUES (?, ?, ?, ?, 1)");
      insert.run("a", SESSION, 1, "first");
      insert.run("b", SESSION, 2, "second");
      insert.run("c", SESSION, 3, "third");
      db.prepare("INSERT INTO runs (id, session_id, agent, status) VALUES ('finished', ?, 'worker', 'done')").run(SESSION);
      expect(seedSession(db, SESSION, 1, storeKey, 1).complete).toBe(false);
      db.prepare("UPDATE todos SET text = 'changed' WHERE uuid = 'b'").run();
      db.prepare("DELETE FROM todos WHERE uuid = 'c'").run();
      let result = seedSession(db, SESSION, 1, storeKey, 1);
      for (let i = 0; !result.complete && i < 10; i++) result = seedSession(db, SESSION, 1, storeKey, 1);
      expect(result.complete).toBe(true);
      expect(db.prepare("SELECT row_key, op FROM roam_changes WHERE entity = 'todos' ORDER BY seq").all()).toEqual([
        { row_key: "a", op: "put" }, { row_key: "b", op: "put" }, { row_key: "c", op: "put" },
        { row_key: "b", op: "put" }, { row_key: "c", op: "delete" },
      ]);
      expect(db.prepare("SELECT json_extract(body_json, '$.text') AS text FROM roam_changes WHERE entity = 'todos' AND row_key = 'b' ORDER BY seq DESC LIMIT 1").get()).toEqual({ text: "changed" });
      expect(db.prepare("SELECT row_key, deleted FROM roam_versions WHERE entity = 'todos' ORDER BY row_key").all()).toEqual([
        { row_key: "a", deleted: 0 }, { row_key: "b", deleted: 0 }, { row_key: "c", deleted: 1 },
      ]);
      expect(seedSession(db, SESSION, 1, storeKey, 1)).toEqual(result);
    } finally { close(); }
  }, 5000);

  it("seeded and live changes advance the durable clock when time goes backwards", () => {
    const { db, storeKey, close } = createReplica("worktree", MACHINE);
    try {
      db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, 1)").run(SESSION);
      db.exec("UPDATE roam_meta SET hlc_ms = 9007199254740990, hlc_count = 7");
      expect(seedSession(db, SESSION, 1, storeKey, 1024).complete).toBe(true);
      db.prepare("INSERT INTO todos (uuid, session_id, seq, text, created_at) VALUES ('live', ?, 1, 'text', 1)").run(SESSION);
      expect(db.prepare("SELECT hlc_ms, hlc_count FROM roam_changes ORDER BY seq").all()).toEqual([
        { hlc_ms: 9007199254740990, hlc_count: 8 }, { hlc_ms: 9007199254740990, hlc_count: 9 },
      ]);
    } finally { close(); }
  }, 5000);

  it("sequence overflow rolls back activation", () => {
    const { db, storeKey, close } = createReplica("worktree", MACHINE);
    try {
      db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, 1)").run(SESSION);
      db.exec(`INSERT INTO roam_changes
        (seq, change_id, entity, row_key, op, hlc_ms, hlc_count, origin_machine, origin_stream, schema_version, body_json)
        SELECT 9007199254740991, 'existing', 'sessions', 'earlier', 'put', 1, 0, machine_id, stream_id, 14, '{}'
        FROM roam_meta WHERE id = 1`);
      expect(() => seedSession(db, SESSION, 1, storeKey, 1024)).toThrow(/sequence.*range/i);
      expect(readSessionState(db, SESSION)).toBeNull();
      expect(db.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 0 });
      expect(db.prepare("SELECT row_key FROM roam_changes").all()).toEqual([{ row_key: "earlier" }]);
      expect(db.prepare("SELECT count(*) AS n FROM roam_versions").get()).toEqual({ n: 0 });
    } finally { close(); }
  }, 5000);

  it("invalid worktree store keys never enable capture", () => {
    const { db, close } = createReplica("worktree", MACHINE);
    try {
      db.exec("UPDATE roam_meta SET store_key = NULL");
      db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, 1)").run(SESSION);
      for (const key of ["worktree:", "worktree:repo", "worktree::workspace", "worktree:repo:"] as StoreKey[]) {
        expect(() => seedSession(db, SESSION, 1, key, 1024)).toThrow(/store key/i);
      }
      expect(db.prepare("SELECT store_key, capture_enabled FROM roam_meta").get()).toEqual({ store_key: null, capture_enabled: 0 });
      expect(readSessionState(db, SESSION)).toBeNull();
      expect(db.prepare("SELECT count(*) AS n FROM roam_changes").get()).toEqual({ n: 0 });
    } finally { close(); }
  }, 5000);

  it.each(["frozen", "retired"] as const)("seed refuses %s membership without reactivating it", state => {
    const { db, storeKey, close } = createReplica("worktree", MACHINE);
    try {
      expect(readSessionState(db, SESSION)).toBeNull();
      db.prepare("INSERT INTO roam_sessions (session_id, epoch, state, move_id, freeze_seq) VALUES (?, 2, ?, 'move-a', 42)").run(SESSION, state);
      expect(readSessionState(db, SESSION)).toEqual({ sessionId: SESSION, epoch: 2, state, moveId: "move-a", freezeSeq: 42 });
      expect(() => seedSession(db, SESSION, 2, storeKey, 1024)).toThrow(/active/i);
      expect(db.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 0 });
      expect(readSessionState(db, SESSION)).toMatchObject({ epoch: 2, state, freezeSeq: 42 });
      expect(db.prepare("SELECT count(*) AS n FROM roam_changes").get()).toEqual({ n: 0 });
    } finally { close(); }
  }, 5000);

  it("seed refuses a stale membership epoch", () => {
    const { db, storeKey, close } = createReplica("worktree", MACHINE);
    try {
      db.prepare("INSERT INTO roam_sessions (session_id, epoch, state) VALUES (?, 2, 'active')").run(SESSION);
      expect(() => seedSession(db, SESSION, 1, storeKey, 1024)).toThrow(/epoch/i);
      expect(readSessionState(db, SESSION)).toMatchObject({ epoch: 2, state: "active" });
      expect(db.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 0 });
    } finally { close(); }
  }, 5000);

  it("abort retains membership", () => {
    const { db, storeKey, close } = createReplica("worktree", MACHINE);
    try {
      db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, 1)").run(SESSION);
      seedSession(db, SESSION, 1, storeKey, 1);
      expect(() => seedSession(db, SESSION, 1, "worktree:other:other", 1)).toThrow(/store key/i);
      expect(readSessionState(db, SESSION)).toMatchObject({ epoch: 1, state: "active" });
      db.prepare("INSERT INTO todos (session_id, seq, text, created_at) VALUES (?, 1, 'after abort', 1)").run(SESSION);
      expect(db.prepare("SELECT count(*) AS n FROM roam_changes WHERE entity = 'todos'").get()).toEqual({ n: 1 });
    } finally { close(); }
  }, 5000);

  it("seed preserves run-event order while a new event is captured", () => {
    const { db, storeKey, close } = createReplica("worktree", MACHINE);
    try {
      db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, 1)").run(SESSION);
      db.prepare("INSERT INTO runs (id, session_id, agent, status) VALUES ('run-a', ?, 'worker', 'running'), ('finished', ?, 'worker', 'done')").run(SESSION, SESSION);
      const addEvent = db.prepare("INSERT INTO run_events (uuid, run_id, session_id, ts, type, summary) VALUES (?, 'run-a', ?, ?, 'progress', ?)");
      addEvent.run("old-z", SESSION, 1, "old first");
      addEvent.run("old-a", SESSION, 2, "old second");
      seedSession(db, SESSION, 1, storeKey, 1);
      addEvent.run("new", SESSION, 3, "new third");
      let result = seedSession(db, SESSION, 1, storeKey, 1);
      for (let i = 0; !result.complete && i < 20; i++) result = seedSession(db, SESSION, 1, storeKey, 1);
      const events = db.prepare("SELECT json_extract(body_json, '$.summary') AS summary FROM roam_changes WHERE entity = 'run_events' ORDER BY seq").all();
      expect(events).toEqual([{ summary: "old first" }, { summary: "old second" }, { summary: "new third" }]);
    } finally { close(); }
  }, 5000);

  it("bulk skips already versioned rows without duplicate changes", () => {
    const { db, storeKey, close } = createReplica("worktree", MACHINE);
    try {
      db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, 1)").run(SESSION);
      const insert = db.prepare("INSERT INTO runs (id, session_id, agent, status) VALUES (?, ?, 'worker', 'done')");
      for (let i = 1; i <= 4; i++) insert.run(`r${i}`, SESSION);
      expect(seedSession(db, SESSION, 1, storeKey, 1).complete).toBe(false);
      db.prepare("UPDATE runs SET task = 'changed' WHERE id IN ('r1', 'r2', 'r3')").run();
      expect(seedSession(db, SESSION, 1, storeKey, 1).complete).toBe(true);
      expect(db.prepare("SELECT row_key FROM roam_changes WHERE entity = 'runs' ORDER BY row_key").all()).toEqual([
        { row_key: "r1" }, { row_key: "r2" }, { row_key: "r3" }, { row_key: "r4" },
      ]);
    } finally { close(); }
  }, 5000);

  it("deliberate duplicate repair is required before seed enables capture", () => {
    const { db, storeKey, close } = createReplica("worktree", MACHINE);
    try {
      db.exec("DROP INDEX idx_todos_session_seq");
      db.prepare("INSERT INTO todos (uuid, session_id, seq, text, created_at) VALUES ('a', ?, 1, 'a', 1), ('b', ?, 1, 'b', 1)").run(SESSION, SESSION);
      db.exec("UPDATE roam_meta SET roamable = 0, problem = 'Duplicate todo sequence for row IDs 1,2'");
      expect(() => seedSession(db, SESSION, 1, storeKey, 1)).toThrow(/unique/i);
      expect(db.prepare("SELECT roamable, capture_enabled FROM roam_meta").get()).toEqual({ roamable: 0, capture_enabled: 0 });
      db.prepare("DELETE FROM todos WHERE uuid = 'b'").run();
      seedSession(db, SESSION, 1, storeKey, 1);
      expect(db.prepare("SELECT roamable, problem, capture_enabled FROM roam_meta").get()).toEqual({ roamable: 1, problem: null, capture_enabled: 1 });
      expect(() => db.prepare("INSERT INTO todos (uuid, session_id, seq, text, created_at) VALUES ('c', ?, 1, 'c', 1)").run(SESSION)).toThrow(/unique/i);
    } finally { close(); }
  }, 5000);

  it.each(["global", "repo", "worktree"] as const)("capture enable refuses an active import (%s)", scope => {
    const { db, storeKey, close } = createReplica(scope, MACHINE);
    try {
      db.exec("UPDATE roam_meta SET store_key = NULL, importing = 1");
      expect(() => scope === "worktree" ? seedSession(db, SESSION, 1, storeKey, 1024) : enableMemoryCapture(db, storeKey)).toThrow(/import/i);
      expect(db.prepare("SELECT store_key, capture_enabled, importing FROM roam_meta").get()).toEqual({ store_key: null, capture_enabled: 0, importing: 1 });
      expect(db.prepare("SELECT count(*) AS n FROM roam_changes").get()).toEqual({ n: 0 });
      if (scope === "worktree") expect(readSessionState(db, SESSION)).toBeNull();
    } finally { close(); }
  }, 5000);

  it.each(["global", "repo", "worktree"] as const)("trigger drift prevents enable and persists its diagnosis (%s)", scope => {
    const { db, storeKey, close } = createReplica(scope, MACHINE);
    try {
      db.exec("UPDATE roam_meta SET capture_enabled = 1");
      db.exec("DROP TRIGGER roam_meta_clock_bu");
      expect(() => scope === "worktree" ? seedSession(db, SESSION, 1, storeKey, 1) : enableMemoryCapture(db, storeKey)).toThrow(/drift/i);
      expect(db.prepare("SELECT capture_enabled, problem FROM roam_meta").get()).toEqual({ capture_enabled: 0, problem: expect.stringContaining("roam_meta_clock_bu") });
      expect(db.prepare("SELECT count(*) AS n FROM roam_changes").get()).toEqual({ n: 0 });
    } finally { close(); }
  }, 5000);

  it.each(["global", "repo"] as const)("memory enable rolls back sequence overflow (%s)", scope => {
    const { db, storeKey, close } = createReplica(scope, MACHINE);
    const table = scope === "global" ? "global_memory" : "memory";
    try {
      db.prepare(`INSERT INTO ${table} (uuid, category, content, created_at) VALUES ('m1', 'insight', 'first', 1)`).run();
      db.exec(`INSERT INTO roam_changes
        (seq, change_id, entity, row_key, op, hlc_ms, hlc_count, origin_machine, origin_stream, schema_version, body_json)
        SELECT 9007199254740991, 'existing', '${table}', 'earlier', 'put', 1, 0, machine_id, stream_id, 14, '{}'
        FROM roam_meta WHERE id = 1`);
      expect(() => enableMemoryCapture(db, storeKey)).toThrow(/sequence.*range/i);
      expect(db.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 0 });
      expect(db.prepare("SELECT row_key FROM roam_changes").all()).toEqual([{ row_key: "earlier" }]);
      expect(db.prepare("SELECT count(*) AS n FROM roam_versions").get()).toEqual({ n: 0 });
    } finally { close(); }
  }, 5000);

  it.each(["global", "repo"] as const)("memory enable seeds atomically once (%s)", scope => {
    const { db, storeKey, close } = createReplica(scope, MACHINE);
    const table = scope === "global" ? "global_memory" : "memory";
    try {
      db.exec("UPDATE roam_meta SET store_key = NULL");
      db.prepare(`INSERT INTO ${table} (uuid, category, content, created_at) VALUES ('m1', 'insight', 'first', 1), ('m2', 'insight', 'second', 1)`).run();
      db.exec("UPDATE roam_meta SET hlc_ms = 9007199254740991, hlc_count = 9007199254740991");
      expect(() => enableMemoryCapture(db, storeKey)).toThrow();
      expect(db.prepare("SELECT store_key, capture_enabled FROM roam_meta").get()).toEqual({ store_key: null, capture_enabled: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM roam_changes").get()).toEqual({ n: 0 });
      db.exec("UPDATE roam_meta SET hlc_ms = 0, hlc_count = 0");
      enableMemoryCapture(db, storeKey);
      expect(db.prepare("SELECT store_key, capture_enabled FROM roam_meta").get()).toMatchObject({ store_key: storeKey, capture_enabled: 1 });
      expect(db.prepare("SELECT row_key FROM roam_changes WHERE entity = ? ORDER BY row_key").all(table)).toEqual([{ row_key: "m1" }, { row_key: "m2" }]);
      enableMemoryCapture(db, storeKey);
      expect(db.prepare("SELECT count(*) AS n FROM roam_changes").get()).toEqual({ n: 2 });
      db.prepare(`UPDATE ${table} SET content = 'new' WHERE uuid = 'm1'`).run();
      expect(db.prepare("SELECT count(*) AS n FROM roam_changes").get()).toEqual({ n: 3 });
    } finally { close(); }
  }, 5000);
});
