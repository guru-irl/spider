import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createReplica, scratchDbPath, type ReplicaFixture } from "../testutil";
import { openDb } from "../db";
import { migrate } from "../migrate";
import { openDbAt } from "../registry";
import { captureSql } from "../roam/generate";
import { GENERATED_CAPTURE_SQL } from "../roam/generated";
import type { Scope } from "../roam/types";
import { BASELINE_SQL } from "./roam-baseline-writers";
import { V13 } from "./fixtures/historical-schemas";

const MACHINE = "11111111-1111-4111-8111-111111111111";
const OTHER_MACHINE = "22222222-2222-4222-8222-222222222222";
const SESSION = "session-a";
const WRITERS = ["wrapper", "raw", "cli"] as const;
type Writer = typeof WRITERS[number];
const MODES = WRITERS.flatMap(writer => [0, 1].map(recursive => ({ writer, recursive })));
const FROZEN_MODES = (["frozen", "retired"] as const).flatMap(state => MODES.map(mode => ({ state, ...mode })));
const SCOPES = ["global", "repo", "worktree"] as const;

interface LogRow {
  seq: number;
  change_id: string;
  entity: string;
  row_key: string;
  op: string;
  hlc_ms: number;
  hlc_count: number;
  origin_machine: string;
  origin_stream: string;
  writer_session: string | null;
  writer_epoch: number | null;
  schema_version: number;
  body_json: string | null;
}

function writerExec(fixture: ReplicaFixture, writer: Writer, recursive: number, sql: string): void {
  const script = `PRAGMA recursive_triggers = ${recursive};\n${sql}`;
  if (writer === "wrapper") {
    fixture.db.exec(script);
  } else if (writer === "raw") {
    const db = new Database(join(fixture.root, "store.db"));
    try { db.exec(script); } finally { db.close(); }
  } else {
    const result = spawnSync("sqlite3", ["-batch", "-bail", join(fixture.root, "store.db")], {
      input: script, encoding: "utf8",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || `sqlite3 exited ${result.status}`);
  }
}

function changes(fixture: ReplicaFixture, entity?: string): LogRow[] {
  return (entity
    ? fixture.db.prepare("SELECT * FROM roam_changes WHERE entity = ? ORDER BY seq").all(entity)
    : fixture.db.prepare("SELECT * FROM roam_changes ORDER BY seq").all()) as LogRow[];
}

function createMigratedWorktree(): ReplicaFixture {
  const root = mkdtempSync(join(dirname(scratchDbPath("legacy-writer")), "legacy-writer-"));
  const db = openDb(join(root, "store.db"));
  const storeKey = "worktree:fixture-repo:fixture-workspace" as const;
  try {
    db.exec(V13.worktree);
    db.raw.pragma("user_version = 13");
    migrate(db, "worktree", { machineId: MACHINE, globalRoot: root });
    db.prepare("UPDATE roam_meta SET store_key = ? WHERE id = 1").run(storeKey);
  } catch (error) {
    db.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root, db, storeKey, machineId: MACHINE,
    close() { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } },
  };
}

function enable(fixture: ReplicaFixture, member = true): void {
  if (member && fixture.storeKey.startsWith("worktree:")) {
    fixture.db.prepare("INSERT INTO roam_sessions (session_id, epoch, state) VALUES (?, 7, 'active')").run(SESSION);
  }
  fixture.db.exec("UPDATE roam_meta SET capture_enabled = 1 WHERE id = 1");
}

const entities: ReadonlyArray<{
  scope: Scope; table: string; key: string; insert: string; update: string; remove: string;
  initial: Record<string, unknown>; updatedField: string; updatedValue: unknown;
}> = [
  {
    scope: "global", table: "global_memory", key: "uuid",
    insert: `INSERT INTO global_memory (uuid, category, content, link, scope, status, source, confidence, created_at, updated_at, justification, evidence, machine_id)
      VALUES ('global-1', 'insight', 'original', 'link-a', 'global', 'active', 'agent', 0.75, 1, 2, 'reason-a', 'evidence-a', '${OTHER_MACHINE}')`,
    update: "UPDATE global_memory SET content = 'changed' WHERE uuid = 'global-1'",
    remove: "DELETE FROM global_memory WHERE uuid = 'global-1'",
    initial: { uuid: "global-1", category: "insight", content: "original", link: "link-a", scope: "global", status: "active", source: "agent", confidence: 0.75, created_at: 1, updated_at: 2, justification: "reason-a", evidence: "evidence-a", machine_id: OTHER_MACHINE }, updatedField: "content", updatedValue: "changed",
  },
  {
    scope: "repo", table: "memory", key: "uuid",
    insert: `INSERT INTO memory (uuid, category, content, link, status, source, confidence, session_id, created_at, updated_at, justification, evidence, machine_id)
      VALUES ('memory-1', 'insight', 'original', 'link-b', 'active', 'agent', 0.5, 'memory-session', 3, 4, 'reason-b', 'evidence-b', '${OTHER_MACHINE}')`,
    update: "UPDATE memory SET content = 'changed' WHERE uuid = 'memory-1'",
    remove: "DELETE FROM memory WHERE uuid = 'memory-1'",
    initial: { uuid: "memory-1", category: "insight", content: "original", link: "link-b", status: "active", source: "agent", confidence: 0.5, session_id: "memory-session", created_at: 3, updated_at: 4, justification: "reason-b", evidence: "evidence-b", machine_id: OTHER_MACHINE }, updatedField: "content", updatedValue: "changed",
  },
  {
    scope: "global", table: "session_homes", key: "session_id",
    insert: `INSERT INTO session_homes (session_id, machine_id, epoch, move_id, updated_at) VALUES ('${SESSION}', '${MACHINE}', 1, 'move-a', 1)`,
    update: `UPDATE session_homes SET epoch = 2 WHERE session_id = '${SESSION}'`,
    remove: `DELETE FROM session_homes WHERE session_id = '${SESSION}'`,
    initial: { session_id: SESSION, machine_id: MACHINE, epoch: 1, move_id: "move-a", updated_at: 1 }, updatedField: "epoch", updatedValue: 2,
  },
  {
    scope: "worktree", table: "sessions", key: "id",
    insert: `INSERT INTO sessions (id, parent_session_id, name, reason, started_at, ended_at, summary, imported_from)
      VALUES ('${SESSION}', 'parent-a', 'name-a', 'reason-a', 1, 2, 'original', 'local-only')`,
    update: `UPDATE sessions SET summary = 'changed' WHERE id = '${SESSION}'`,
    remove: `DELETE FROM sessions WHERE id = '${SESSION}'`,
    initial: { id: SESSION, parent_session_id: "parent-a", name: "name-a", reason: "reason-a", started_at: 1, ended_at: 2, summary: "original", origin_machine: MACHINE }, updatedField: "summary", updatedValue: "changed",
  },
  {
    scope: "worktree", table: "todos", key: "uuid",
    insert: `INSERT INTO todos (session_id, seq, text, done, created_at, updated_at) VALUES ('${SESSION}', 1, 'original', 1, 3, 4)`,
    update: `UPDATE todos SET text = 'changed' WHERE session_id = '${SESSION}'`,
    remove: `DELETE FROM todos WHERE session_id = '${SESSION}'`,
    initial: { session_id: SESSION, seq: 1, text: "original", done: 1, created_at: 3, updated_at: 4 }, updatedField: "text", updatedValue: "changed",
  },
  {
    scope: "worktree", table: "runs", key: "id",
    insert: `INSERT INTO runs (id, session_id, parent_run_id, agent, role, name, status, phase, model, task, thinking, started_at, ended_at, step_count, token_count, result, pid, host_pid, child_mode, intercom_session, pid_start_time)
      VALUES ('run-a', '${SESSION}', 'parent-run', 'worker', 'role-a', 'name-a', 'queued', 'phase-a', 'fixture-model', 'task-a', 'high', 5, 6, 7, 8, 'result-a', 41, 42, 'rpc', 'local-intercom', 'local-start')`,
    update: "UPDATE runs SET status = 'running' WHERE id = 'run-a'",
    remove: "DELETE FROM runs WHERE id = 'run-a'",
    initial: { id: "run-a", session_id: SESSION, parent_run_id: "parent-run", agent: "worker", role: "role-a", name: "name-a", status: "queued", phase: "phase-a", model: "fixture-model", task: "task-a", thinking: "high", started_at: 5, ended_at: 6, step_count: 7, token_count: 8, result: "result-a", child_mode: "rpc", origin_machine: MACHINE }, updatedField: "status", updatedValue: "running",
  },
  {
    scope: "worktree", table: "run_events", key: "uuid",
    insert: `INSERT INTO run_events (run_id, session_id, ts, type, tool, summary, payload) VALUES ('run-a', '${SESSION}', 9, 'created', 'tool-a', 'original', '{"kind":"sample"}')`,
    update: "UPDATE run_events SET summary = 'changed' WHERE run_id = 'run-a'",
    remove: "DELETE FROM run_events WHERE run_id = 'run-a'",
    initial: { run_id: "run-a", session_id: SESSION, ts: 9, type: "created", tool: "tool-a", summary: "original", payload: '{"kind":"sample"}' }, updatedField: "summary", updatedValue: "changed",
  },
];

describe("roaming SQL capture", () => {
  it.each(MODES)("function-free writers capture one normalized change ($writer recursive=$recursive)", ({ writer, recursive }) => {
    const stores = {
      global: createReplica("global", MACHINE),
      repo: createReplica("repo", MACHINE),
      worktree: createReplica("worktree", MACHINE),
    };
    try {
      for (const fixture of Object.values(stores)) enable(fixture);
      for (const entity of entities) {
        const fixture = stores[entity.scope];
        writerExec(fixture, writer, recursive, entity.insert);
        const persisted = fixture.db.prepare(`SELECT ${entity.key} AS row_key FROM ${entity.table}`).get() as { row_key: string };
        const changesForInsert = changes(fixture, entity.table);
        expect(changesForInsert, entity.table).toHaveLength(1);
        const inserted = changesForInsert[0];
        const expectVersion = (change: LogRow, deleted: number) => expect(fixture.db.prepare("SELECT change_id, hlc_ms, hlc_count, origin_machine, origin_stream, deleted FROM roam_versions WHERE entity = ? AND row_key = ?")
          .get(entity.table, persisted.row_key)).toEqual({
            change_id: change.change_id, hlc_ms: change.hlc_ms, hlc_count: change.hlc_count,
            origin_machine: change.origin_machine, origin_stream: change.origin_stream, deleted,
          });
        expectVersion(inserted, 0);
        expect(inserted).toMatchObject({
          entity: entity.table, row_key: persisted.row_key, op: "put", origin_machine: MACHINE,
          writer_session: entity.scope === "worktree" ? SESSION : null,
          writer_epoch: entity.scope === "worktree" ? 7 : null, schema_version: 14,
        });
        expect(inserted.origin_stream).toEqual(expect.any(String));
        expect(inserted.hlc_ms).toBeGreaterThan(0);
        const body = JSON.parse(inserted.body_json!) as Record<string, unknown>;
        const expectedBody = entity.key === "uuid" ? { ...entity.initial, uuid: persisted.row_key } : entity.initial;
        expect(body).toEqual(expectedBody);
        if (entity.key === "uuid") expect(body.uuid).toBe(persisted.row_key);
        if (entity.table === "todos" || entity.table === "run_events") expect(persisted.row_key).toMatch(/^[a-f0-9]{32}$/);
        if (entity.table === "global_memory" || entity.table === "memory" || entity.table === "todos" || entity.table === "run_events") {
          expect(body).not.toHaveProperty("id");
        }
        if (entity.table === "runs") {
          for (const local of ["pid", "host_pid", "pid_start_time", "intercom_session"]) expect(body).not.toHaveProperty(local);
        }

        writerExec(fixture, writer, recursive, entity.update);
        const afterUpdate = changes(fixture, entity.table);
        expect(afterUpdate, entity.table).toHaveLength(2);
        expect(afterUpdate[1]).toMatchObject({ row_key: persisted.row_key, op: "put" });
        expectVersion(afterUpdate[1], 0);
        expect(JSON.parse(afterUpdate[1].body_json!)).toEqual({ ...expectedBody, [entity.updatedField]: entity.updatedValue });
        writerExec(fixture, writer, recursive, entity.remove);
        const afterDelete = changes(fixture, entity.table);
        expect(afterDelete, entity.table).toHaveLength(3);
        const deleted = afterDelete[2];
        expect(deleted).toMatchObject({ row_key: persisted.row_key, op: "delete", body_json: null });
        expectVersion(deleted, 1);
      }
    } finally { for (const fixture of Object.values(stores)) fixture.close(); }
  }, 5000);

  it.each(FROZEN_MODES)("$state fences reject writes from $writer (recursive=$recursive) and leave other sessions writable", ({ state, writer, recursive }) => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      enable(fixture);
      for (const entity of entities.filter(item => item.scope === "worktree")) fixture.db.exec(entity.insert);
      fixture.db.prepare("UPDATE roam_sessions SET state = ? WHERE session_id = ?").run(state, SESSION);
      const logBefore = changes(fixture);
      const frozenWrites = [
        "INSERT INTO sessions(id, started_at) VALUES ('session-a', 2)",
        "UPDATE sessions SET name = 'blocked' WHERE id = 'session-a'",
        "DELETE FROM sessions WHERE id = 'session-a'",
        "INSERT INTO todos(session_id, seq, text, created_at) VALUES ('session-a', 2, 'blocked', 2)",
        "UPDATE todos SET text = 'blocked' WHERE session_id = 'session-a'",
        "DELETE FROM todos WHERE session_id = 'session-a'",
        "INSERT INTO runs(id, session_id, agent, status) VALUES ('run-b', 'session-a', 'worker', 'queued')",
        "UPDATE runs SET pid = 123 WHERE id = 'run-a'",
        "DELETE FROM runs WHERE id = 'run-a'",
        "INSERT INTO run_events(session_id, ts, type) VALUES ('session-a', 2, 'blocked')",
        "UPDATE run_events SET summary = 'blocked' WHERE session_id = 'session-a'",
        "DELETE FROM run_events WHERE session_id = 'session-a'",
      ];
      const frozenError = writer === "cli" ? /:\s+session is frozen(?:\s|\()/ : /^session is frozen$/;
      for (const sql of frozenWrites) expect(() => writerExec(fixture, writer, recursive, sql), sql).toThrow(frozenError);
      expect(changes(fixture)).toEqual(logBefore);
      expect(() => writerExec(fixture, writer, recursive, "INSERT INTO todos(session_id, seq, text, created_at) VALUES ('other', 1, 'allowed', 1)")).not.toThrow();
      expect(changes(fixture)).toEqual(logBefore);
      expect(() => writerExec(fixture, writer, recursive, "UPDATE todos SET session_id = 'session-a' WHERE session_id = 'other'")).toThrow(frozenError);
      expect(fixture.db.prepare("SELECT session_id, text FROM todos WHERE text = 'allowed'").get()).toEqual({ session_id: "other", text: "allowed" });
    } finally { fixture.close(); }
  }, 5000);

  it("freeze fences check the old and new session identities", () => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      enable(fixture);
      fixture.db.exec(`
        INSERT INTO sessions(id, started_at) VALUES ('session-a', 1), ('other', 1);
        INSERT INTO todos(session_id, seq, text, created_at) VALUES ('session-a', 1, 'first', 1), ('other', 1, 'second', 1);
        INSERT INTO runs(id, session_id, agent, status) VALUES ('run-a', 'session-a', 'worker', 'queued'), ('run-b', 'other', 'worker', 'queued');
        INSERT INTO run_events(run_id, session_id, ts, type) VALUES ('run-a', 'session-a', 1, 'created'), ('run-b', 'other', 1, 'created');
        UPDATE roam_sessions SET state = 'frozen';
      `);
      const tables = ["sessions", "todos", "runs", "run_events"];
      const rowsBefore = tables.map(table => fixture.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
      const logBefore = changes(fixture);
      const writes = [
        "UPDATE sessions SET id = 'other-new' WHERE id = 'session-a'",
        "UPDATE sessions SET id = 'session-a' WHERE id = 'other'",
        "UPDATE todos SET session_id = 'other' WHERE session_id = 'session-a'",
        "UPDATE todos SET session_id = 'session-a' WHERE session_id = 'other'",
        "UPDATE runs SET session_id = 'other' WHERE id = 'run-a'",
        "UPDATE runs SET session_id = 'session-a' WHERE id = 'run-b'",
        "UPDATE run_events SET session_id = 'other' WHERE run_id = 'run-a'",
        "UPDATE run_events SET session_id = 'session-a' WHERE run_id = 'run-b'",
      ];
      for (const sql of writes) expect(() => fixture.db.exec(sql), sql).toThrow(/^session is frozen$/);
      expect(tables.map(table => fixture.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(rowsBefore);
      expect(changes(fixture)).toEqual(logBefore);
    } finally { fixture.close(); }
  }, 5000);

  it("normalizes identities without capture and importing bypasses capture and fences", () => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      fixture.db.exec(`
        INSERT INTO roam_sessions(session_id, epoch, state) VALUES ('session-a', 7, 'active');
        INSERT INTO sessions(id, started_at) VALUES ('session-a', 1);
        INSERT INTO todos(session_id, seq, text, created_at) VALUES ('session-a', 1, 'first', 1);
        INSERT INTO runs(id, session_id, agent, status) VALUES ('run-a', 'session-a', 'worker', 'queued');
        INSERT INTO run_events(session_id, ts, type) VALUES ('session-a', 1, 'created');
      `);
      expect(changes(fixture)).toEqual([]);
      expect(fixture.db.prepare("SELECT origin_machine FROM sessions").get()).toEqual({ origin_machine: MACHINE });
      expect(fixture.db.prepare("SELECT origin_machine FROM runs").get()).toEqual({ origin_machine: MACHINE });
      expect((fixture.db.prepare("SELECT uuid FROM todos").get() as { uuid: string }).uuid).toMatch(/^[a-f0-9]{32}$/);
      expect((fixture.db.prepare("SELECT uuid FROM run_events").get() as { uuid: string }).uuid).toMatch(/^[a-f0-9]{32}$/);
      fixture.db.exec("UPDATE roam_sessions SET state = 'frozen'; UPDATE roam_meta SET capture_enabled = 0");
      expect(() => fixture.db.exec("UPDATE todos SET text = 'blocked'")).toThrow("session is frozen");
      expect(() => fixture.db.exec("UPDATE roam_meta SET capture_enabled = 1, importing = 1; UPDATE todos SET text = 'imported'; UPDATE roam_meta SET importing = 0")).not.toThrow();
      expect(fixture.db.prepare("SELECT text FROM todos").get()).toEqual({ text: "imported" });
      expect(changes(fixture)).toEqual([]);
    } finally { fixture.close(); }
  }, 5000);

  it("rolls back imported rows, source rows, clocks, and log changes together", () => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      enable(fixture);
      const metaBefore = fixture.db.prepare("SELECT hlc_ms, hlc_count, importing FROM roam_meta").get();
      const versionsBefore = fixture.db.prepare("SELECT * FROM roam_versions ORDER BY entity, row_key").all();
      const logBefore = changes(fixture);
      expect(() => fixture.db.raw.transaction(() => {
        fixture.db.exec("UPDATE roam_meta SET importing = 1; INSERT INTO todos(session_id, seq, text, created_at) VALUES ('session-a', 1, 'imported', 1)");
        throw new Error("rollback import");
      })()).toThrow("rollback import");
      expect(fixture.db.prepare("SELECT * FROM todos").all()).toEqual([]);
      expect(fixture.db.prepare("SELECT hlc_ms, hlc_count, importing FROM roam_meta").get()).toEqual(metaBefore);
      expect(changes(fixture)).toEqual(logBefore);
      expect(() => fixture.db.raw.transaction(() => {
        fixture.db.exec("INSERT INTO todos(session_id, seq, text, created_at) VALUES ('session-a', 1, 'local', 1)");
        throw new Error("rollback source");
      })()).toThrow("rollback source");
      expect(fixture.db.prepare("SELECT * FROM todos").all()).toEqual([]);
      expect(fixture.db.prepare("SELECT hlc_ms, hlc_count, importing FROM roam_meta").get()).toEqual(metaBefore);
      expect(changes(fixture)).toEqual(logBefore);
      expect(fixture.db.prepare("SELECT * FROM roam_versions ORDER BY entity, row_key").all()).toEqual(versionsBefore);
      fixture.db.exec("CREATE TRIGGER reject_log BEFORE INSERT ON roam_changes BEGIN SELECT RAISE(ABORT, 'log failed'); END");
      expect(() => fixture.db.exec("INSERT INTO todos(session_id, seq, text, created_at) VALUES ('session-a', 1, 'local', 1)")).toThrow("log failed");
      expect(fixture.db.prepare("SELECT * FROM todos").all()).toEqual([]);
      expect(fixture.db.prepare("SELECT hlc_ms, hlc_count, importing FROM roam_meta").get()).toEqual(metaBefore);
      expect(changes(fixture)).toEqual(logBefore);
      expect(fixture.db.prepare("SELECT * FROM roam_versions ORDER BY entity, row_key").all()).toEqual(versionsBefore);
    } finally { fixture.close(); }
  }, 5000);

  it("does not capture PID-only or unchanged projected updates", () => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      enable(fixture);
      fixture.db.exec("INSERT INTO runs(id, session_id, agent, status) VALUES ('run-a', 'session-a', 'worker', 'queued')");
      const before = changes(fixture);
      expect(before).toHaveLength(1);
      fixture.db.exec("UPDATE runs SET pid = 123, host_pid = 456, pid_start_time = '7', intercom_session = 'local' WHERE id = 'run-a'");
      fixture.db.exec("UPDATE runs SET status = status WHERE id = 'run-a'");
      expect(changes(fixture)).toEqual(before);
      expect(fixture.db.prepare("SELECT pid, host_pid FROM runs WHERE id = 'run-a'").get()).toEqual({ pid: 123, host_pid: 456 });
      fixture.db.exec("UPDATE runs SET status = 'running' WHERE id = 'run-a'");
      expect(changes(fixture)).toHaveLength(2);
    } finally { fixture.close(); }
  }, 5000);

  it("rejects changes to portable identities and creation origins", () => {
    const stores = {
      global: createReplica("global", MACHINE), repo: createReplica("repo", MACHINE), worktree: createReplica("worktree", MACHINE),
    };
    try {
      for (const fixture of Object.values(stores)) enable(fixture);
      for (const entity of entities) stores[entity.scope].db.exec(entity.insert);
      const attempts: Array<[Scope, string]> = [
        ["global", "UPDATE global_memory SET uuid = 'other'"],
        ["repo", "UPDATE memory SET uuid = 'other'"],
        ["global", "UPDATE session_homes SET session_id = 'other'"],
        ["worktree", "UPDATE sessions SET id = 'other'"],
        ["worktree", "UPDATE sessions SET origin_machine = 'other'"],
        ["worktree", "UPDATE todos SET uuid = 'other'"],
        ["worktree", "UPDATE todos SET session_id = 'other'"],
        ["worktree", "UPDATE runs SET id = 'other'"],
        ["worktree", "UPDATE runs SET session_id = 'other'"],
        ["worktree", "UPDATE runs SET origin_machine = 'other'"],
        ["worktree", "UPDATE run_events SET uuid = 'other'"],
        ["worktree", "UPDATE run_events SET session_id = 'other'"],
      ];
      const before = Object.values(stores).map(fixture => changes(fixture));
      for (const [scope, sql] of attempts) expect(() => stores[scope].db.exec(sql), sql).toThrow(/roaming .* cannot change/);
      expect(Object.values(stores).map(fixture => changes(fixture))).toEqual(before);
    } finally { for (const fixture of Object.values(stores)) fixture.close(); }
  }, 5000);

  it("rejects invalid metadata clocks on insert and update", () => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      enable(fixture);
      for (const assignment of ["hlc_ms = -1", "hlc_count = -1", "hlc_ms = 9007199254740992", "hlc_count = 9007199254740992", "hlc_count = 1.5"]) {
        expect(() => fixture.db.exec(`UPDATE roam_meta SET ${assignment}`), assignment).toThrow(/clock/i);
      }
      fixture.db.exec("DELETE FROM roam_meta");
      expect(() => fixture.db.exec("INSERT INTO roam_meta(id, machine_id, stream_id, hlc_ms) VALUES (1, 'machine', 'stream', -1)")).toThrow(/clock/i);
      expect(fixture.db.prepare("SELECT * FROM roam_meta").all()).toEqual([]);
    } finally { fixture.close(); }
  }, 5000);

  it("capture clock overflow aborts without partial writes", () => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      enable(fixture);
      fixture.db.exec("UPDATE roam_meta SET hlc_ms = 9007199254740991, hlc_count = 9007199254740991");
      const metaBefore = fixture.db.prepare("SELECT hlc_ms, hlc_count FROM roam_meta").get();
      const logBefore = changes(fixture);
      expect(() => fixture.db.exec("INSERT INTO todos(session_id, seq, text, created_at) VALUES ('session-a', 1, 'overflow', 1)")).toThrow(/clock/i);
      expect(fixture.db.prepare("SELECT * FROM todos").all()).toEqual([]);
      expect(fixture.db.prepare("SELECT hlc_ms, hlc_count FROM roam_meta").get()).toEqual(metaBefore);
      expect(changes(fixture)).toEqual(logBefore);
      expect(fixture.db.prepare("SELECT * FROM roam_versions").all()).toEqual([]);
    } finally { fixture.close(); }
  }, 5000);

  it.each(MODES)("explicit identities capture once ($writer recursive=$recursive)", ({ writer, recursive }) => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      enable(fixture);
      writerExec(fixture, writer, recursive, `
        INSERT INTO sessions(id, started_at, origin_machine) VALUES ('session-a', 1, '${OTHER_MACHINE}');
        INSERT INTO todos(uuid, session_id, seq, text, created_at) VALUES ('todo-a', 'session-a', 1, 'task', 1);
        INSERT INTO runs(id, session_id, agent, status, origin_machine) VALUES ('run-a', 'session-a', 'worker', 'queued', '${OTHER_MACHINE}');
        INSERT INTO run_events(uuid, session_id, ts, type) VALUES ('event-a', 'session-a', 1, 'created');
      `);
      const log = changes(fixture);
      expect(log.map(row => [row.entity, row.row_key])).toEqual([
        ["sessions", "session-a"], ["todos", "todo-a"], ["runs", "run-a"], ["run_events", "event-a"],
      ]);
      expect(JSON.parse(log[0].body_json!).origin_machine).toBe(OTHER_MACHINE);
      expect(JSON.parse(log[1].body_json!).uuid).toBe("todo-a");
      expect(JSON.parse(log[2].body_json!).origin_machine).toBe(OTHER_MACHINE);
      expect(JSON.parse(log[3].body_json!).uuid).toBe("event-a");
    } finally { fixture.close(); }
  }, 5000);

  it.each([
    { table: "sessions", fill: "origin", column: "origin_machine", key: "id", insert: entities[3].insert },
    { table: "todos", fill: "uuid", column: "uuid", key: "uuid", insert: entities[4].insert },
    { table: "runs", fill: "origin", column: "origin_machine", key: "id", insert: entities[5].insert },
    { table: "run_events", fill: "uuid", column: "uuid", key: "uuid", insert: entities[6].insert },
  ].flatMap(item => [false, true].flatMap(fillLast => [0, 1].map(recursive => ({ ...item, fillLast, recursive })))))
  ("$table normalization captures once in either trigger order (fill last=$fillLast recursive=$recursive)", ({ table, fill, column, key, insert, fillLast, recursive }) => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      enable(fixture);
      fixture.db.exec(`PRAGMA recursive_triggers = ${recursive}`);
      const fillName = `roam_${table}_${fill}_fill`;
      const captureName = `roam_${table}_capture_ai`;
      const lookup = fixture.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?");
      const fillSql = (lookup.get(fillName) as { sql: string }).sql;
      const captureSql = (lookup.get(captureName) as { sql: string }).sql;
      fixture.db.exec(`DROP TRIGGER ${fillName}; DROP TRIGGER ${captureName}`);
      fixture.db.exec(fillLast ? `${captureSql};\n${fillSql};` : `${fillSql};\n${captureSql};`);
      fixture.db.exec(insert);
      const persisted = fixture.db.prepare(`SELECT ${column} AS value, ${key} AS row_key FROM ${table}`).get() as { value: string; row_key: string };
      const log = changes(fixture, table);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ op: "put", row_key: persisted.row_key, writer_session: SESSION, writer_epoch: 7 });
      expect(JSON.parse(log[0].body_json!)[column]).toBe(persisted.value);
      if (fill === "uuid") expect(persisted.value).toMatch(/^[a-f0-9]{32}$/);
      else expect(persisted.value).toBe(MACHINE);
    } finally { fixture.close(); }
  }, 5000);

  it.each(MODES)("empty legacy identities normalize without capture ($writer recursive=$recursive)", ({ writer, recursive }) => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      writerExec(fixture, writer, recursive, `
        INSERT INTO sessions(id, started_at, origin_machine) VALUES ('session-a', 1, '');
        INSERT INTO todos(uuid, session_id, seq, text, created_at) VALUES ('', 'session-a', 1, 'task', 1);
        INSERT INTO runs(id, session_id, agent, status, origin_machine) VALUES ('run-a', 'session-a', 'worker', 'queued', '');
        INSERT INTO run_events(uuid, session_id, ts, type) VALUES ('', 'session-a', 1, 'created');
      `);
      expect(fixture.db.prepare("SELECT origin_machine FROM sessions").get()).toEqual({ origin_machine: MACHINE });
      expect(fixture.db.prepare("SELECT origin_machine FROM runs").get()).toEqual({ origin_machine: MACHINE });
      expect((fixture.db.prepare("SELECT uuid FROM todos").get() as { uuid: string }).uuid).toMatch(/^[a-f0-9]{32}$/);
      expect((fixture.db.prepare("SELECT uuid FROM run_events").get() as { uuid: string }).uuid).toMatch(/^[a-f0-9]{32}$/);
      expect(changes(fixture)).toEqual([]);
    } finally { fixture.close(); }
  }, 5000);

  it.each([true, false])("baseline SQL replay preserves actual v13 writers (member=%s)", member => {
    const fixture = createMigratedWorktree();
    try {
      enable(fixture, member);
      const db = fixture.db;
      db.prepare(BASELINE_SQL.sessionUpsert).run(SESSION, "first", "open", 1);
      db.prepare(BASELINE_SQL.sessionUpsert).run(SESSION, "second", "resume", 2);
      const add = (text: string): number => {
        const next = db.prepare(BASELINE_SQL.todoNext).get(SESSION) as { maxSeq: number };
        const result = db.prepare(BASELINE_SQL.todoInsert).run(SESSION, next.maxSeq + 1, text, 1, 1);
        const id = Number(result.lastInsertRowid);
        db.prepare(BASELINE_SQL.todoFtsInsert).run(id, text);
        return id;
      };
      const first = add("first todo");
      db.prepare(BASELINE_SQL.todoToggle).run(1, 2, first);
      const second = add("second todo");
      const selected = db.prepare(BASELINE_SQL.todoFind).get(SESSION, 1) as { id: number; text: string };
      expect(selected.id).toBe(first);
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
      const run = {
        id: "run-a", session_id: SESSION, parent_run_id: null, agent: "worker", role: null, name: "run",
        status: "queued", phase: null, model: null, task: null, thinking: null, host_pid: 123,
      };
      db.prepare(BASELINE_SQL.runInsert).run(run);
      db.prepare(BASELINE_SQL.runStart).run({ id: "run-a", now: 2 });
      db.prepare(BASELINE_SQL.runProgress).run({ id: "run-a", stepCount: 1, tokenCount: null, phase: null, model: null, thinking: null });
      db.prepare(BASELINE_SQL.runPid).run({ id: "run-a", pid: 321, hostPid: 123, startTime: "456" });
      db.prepare(BASELINE_SQL.runFinish).run({ id: "run-a", status: "done", now: 3, result: "complete" });
      db.prepare(BASELINE_SQL.eventAppend).run({ runId: "run-a", sessionId: SESSION, ts: 3, type: "done", tool: null, summary: null, payload: null });
      expect(db.prepare("SELECT name, reason, origin_machine FROM sessions WHERE id = ?").get(SESSION))
        .toEqual({ name: "second", reason: "resume", origin_machine: MACHINE });
      expect(db.prepare("SELECT * FROM todos").all()).toEqual([]);
      expect(db.prepare("SELECT status, pid, origin_machine FROM runs WHERE id = 'run-a'").get())
        .toEqual({ status: "done", pid: 321, origin_machine: MACHINE });
      const log = changes(fixture);
      expect(log.map(row => `${row.entity}:${row.op}`)).toEqual(member ? [
        "sessions:put", "sessions:put", "todos:put", "todos:put", "todos:put", "todos:delete", "todos:put", "todos:delete",
        "runs:put", "runs:put", "runs:put", "runs:put", "run_events:put",
      ] : []);
      if (member) expect(log.every(row => row.writer_session === SESSION && row.writer_epoch === 7)).toBe(true);
    } finally { fixture.close(); }
  }, 5000);

  it("baseline SQL writers cannot mutate a frozen member", () => {
    const fixture = createMigratedWorktree();
    try {
      enable(fixture);
      const db = fixture.db;
      db.prepare(BASELINE_SQL.sessionUpsert).run(SESSION, "first", "open", 1);
      const todo = db.prepare(BASELINE_SQL.todoInsert).run(SESSION, 1, "visible", 1, 1);
      const id = Number(todo.lastInsertRowid);
      db.prepare(BASELINE_SQL.todoFtsInsert).run(id, "visible");
      const run = {
        id: "run-a", session_id: SESSION, parent_run_id: null, agent: "worker", role: null, name: "run",
        status: "queued", phase: null, model: null, task: null, thinking: null, host_pid: 123,
      };
      db.prepare(BASELINE_SQL.runInsert).run(run);
      db.exec("UPDATE roam_sessions SET state = 'frozen'");
      const before = changes(fixture);
      const writes: Array<() => unknown> = [
        () => db.prepare(BASELINE_SQL.sessionUpsert).run(SESSION, "blocked", "resume", 2),
        () => db.prepare(BASELINE_SQL.todoInsert).run(SESSION, 2, "blocked", 2, 2),
        () => db.prepare(BASELINE_SQL.todoToggle).run(1, 2, id),
        () => db.raw.transaction(() => {
          db.prepare(BASELINE_SQL.todoFtsDelete).run(id, "visible");
          db.prepare(BASELINE_SQL.todoRemove).run(id);
        }).immediate(),
        () => db.raw.transaction(() => {
          db.prepare(BASELINE_SQL.todoFtsDelete).run(id, "visible");
          db.prepare(BASELINE_SQL.todoClear).run(SESSION, 1);
        }).immediate(),
        () => db.prepare(BASELINE_SQL.runInsert).run({ ...run, id: "run-b" }),
        () => db.prepare(BASELINE_SQL.runStart).run({ id: "run-a", now: 2 }),
        () => db.prepare(BASELINE_SQL.runPid).run({ id: "run-a", pid: 1, hostPid: 2, startTime: "3" }),
        () => db.prepare(BASELINE_SQL.eventAppend).run({ runId: "run-a", sessionId: SESSION, ts: 2, type: "blocked", tool: null, summary: null, payload: null }),
      ];
      for (const frozenWrite of writes) expect(() => frozenWrite()).toThrow("session is frozen");
      expect(changes(fixture)).toEqual(before);
      expect(db.prepare("SELECT rowid FROM todos_fts WHERE todos_fts MATCH 'visible'").all()).toEqual([{ rowid: id }]);
      expect(db.prepare("SELECT text FROM todos").get()).toEqual({ text: "visible" });
    } finally { fixture.close(); }
  }, 5000);

  it("racing v13 todo sequence allocations reject the duplicate insert", () => {
    const fixture = createMigratedWorktree();
    const other = new Database(join(fixture.root, "store.db"));
    try {
      enable(fixture);
      const a = fixture.db.prepare(BASELINE_SQL.todoNext).get(SESSION) as { maxSeq: number };
      const b = other.prepare(BASELINE_SQL.todoNext).get(SESSION) as { maxSeq: number };
      expect(a).toEqual({ maxSeq: 0 });
      expect(b).toEqual({ maxSeq: 0 });
      fixture.db.prepare(BASELINE_SQL.todoInsert).run(SESSION, a.maxSeq + 1, "first", 1, 1);
      expect(() => other.prepare(BASELINE_SQL.todoInsert).run(SESSION, b.maxSeq + 1, "second", 1, 1)).toThrow(/unique/i);
      expect(fixture.db.prepare("SELECT seq, text FROM todos").all()).toEqual([{ seq: 1, text: "first" }]);
      expect(changes(fixture, "todos")).toHaveLength(1);
    } finally { other.close(); fixture.close(); }
  }, 5000);

  it("advances a durable clock when wall time goes backwards", () => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      enable(fixture);
      fixture.db.exec("UPDATE roam_meta SET hlc_ms = 9007199254740000, hlc_count = 9");
      fixture.db.exec("INSERT INTO todos(session_id, seq, text, created_at) VALUES ('session-a', 1, 'first', 1)");
      fixture.db.exec("INSERT INTO todos(session_id, seq, text, created_at) VALUES ('session-a', 2, 'second', 1)");
      expect(changes(fixture).map(row => [row.hlc_ms, row.hlc_count])).toEqual([
        [9007199254740000, 10], [9007199254740000, 11],
      ]);
      fixture.db.exec("UPDATE roam_meta SET hlc_ms = 0, hlc_count = 5");
      fixture.db.exec("UPDATE todos SET text = 'changed' WHERE seq = 1");
      expect(changes(fixture).at(-1)?.hlc_count).toBe(0);
    } finally { fixture.close(); }
  }, 5000);

  it.each(SCOPES.flatMap(scope => ["missing", "modified", "unexpected"].map(mode => ({ scope, mode }))))
  ("trigger drift disables $scope capture without refusing open ($mode)", ({ scope, mode }) => {
    const fixture = createReplica(scope, MACHINE);
    let reopened: ReturnType<typeof openDbAt> | undefined;
    try {
      enable(fixture);
      const table = scope === "global" ? "global_memory" : scope === "repo" ? "memory" : "todos";
      const trigger = `roam_${table}_capture_ai`;
      if (mode === "missing") fixture.db.exec(`DROP TRIGGER ${trigger}`);
      if (mode === "modified") fixture.db.exec(`DROP TRIGGER ${trigger}; CREATE TRIGGER ${trigger} AFTER INSERT ON ${table} BEGIN SELECT 1; END`);
      if (mode === "unexpected") fixture.db.exec(`CREATE TRIGGER roam_unexpected AFTER INSERT ON ${table} BEGIN SELECT 1; END`);
      const schemaBefore = fixture.db.pragma("schema_version");
      expect(() => { reopened = openDbAt(join(fixture.root, "store.db"), scope); }).not.toThrow();
      expect(fixture.db.pragma("schema_version")).toBe(schemaBefore);
      expect(fixture.db.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 0 });
      expect((fixture.db.prepare("SELECT problem FROM roam_meta").get() as { problem: string }).problem).toMatch(/trigger.*drift/i);
      if (mode === "missing") expect(fixture.db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(trigger)).toBeUndefined();
      if (mode === "modified") expect((fixture.db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(trigger) as { sql: string }).sql).toContain("SELECT 1");
      if (mode === "unexpected") expect(fixture.db.prepare("SELECT name FROM sqlite_master WHERE name = 'roam_unexpected'").get()).toEqual({ name: "roam_unexpected" });
      expect(() => fixture.db.exec(scope === "worktree"
        ? "INSERT INTO todos(session_id, seq, text, created_at) VALUES ('other', 1, 'usable', 1)"
        : `INSERT INTO ${table}(uuid, category, content, created_at) VALUES ('ordinary', 'insight', 'usable', 1)`)).not.toThrow();
      expect(changes(fixture)).toEqual([]);
    } finally { reopened?.close(); fixture.close(); }
  }, 5000);

  it.each(SCOPES.flatMap(scope => [false, true].map(uppercase => ({ scope, uppercase }))))
  ("a legacy $scope store preserves and reports a colliding foreign trigger (uppercase=$uppercase)", ({ scope, uppercase }) => {
    const root = mkdtempSync(join(dirname(scratchDbPath("legacy-drift")), "legacy-drift-"));
    const db = openDb(join(root, "store.db"));
    let reopened: ReturnType<typeof openDbAt> | undefined;
    try {
      db.exec(V13[scope]);
      db.raw.pragma("user_version = 13");
      const table = scope === "global" ? "global_memory" : scope === "repo" ? "memory" : "todos";
      const expectedName = `roam_${table}_capture_ai`;
      const name = uppercase ? expectedName.toUpperCase() : expectedName;
      db.exec(`CREATE TRIGGER ${name} AFTER INSERT ON ${table} BEGIN SELECT 1; END`);
      const triggerBefore = db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name);
      expect(() => migrate(db, scope, { machineId: MACHINE, globalRoot: root })).not.toThrow();
      expect(db.pragma("user_version")).toBe(14);
      expect(() => { reopened = openDbAt(join(root, "store.db"), scope); }).not.toThrow();
      const meta = db.prepare("SELECT capture_enabled, problem FROM roam_meta").get() as { capture_enabled: number; problem: string };
      expect(meta.capture_enabled).toBe(0);
      expect(meta.problem).toContain(name);
      expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name)).toEqual(triggerBefore);
      expect(() => db.exec(scope === "worktree"
        ? "INSERT INTO todos(session_id, seq, text, created_at) VALUES ('other', 1, 'ordinary', 1)"
        : `INSERT INTO ${table}(uuid, category, content, created_at) VALUES ('ordinary', 'insight', 'ordinary', 1)`)).not.toThrow();
      expect(db.prepare("SELECT * FROM roam_changes").all()).toEqual([]);
    } finally { reopened?.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
  }, 5000);

  it("a raising unexpected trigger is preserved and reported", () => {
    const fixture = createReplica("worktree", MACHINE);
    let reopened: ReturnType<typeof openDbAt> | undefined;
    try {
      enable(fixture);
      fixture.db.exec("CREATE TRIGGER roam_unexpected BEFORE INSERT ON todos BEGIN SELECT RAISE(ABORT, 'unexpected trigger blocked write'); END");
      const triggerBefore = fixture.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'roam_unexpected'").get();
      const schemaBefore = fixture.db.pragma("schema_version");
      expect(() => { reopened = openDbAt(join(fixture.root, "store.db"), "worktree"); }).not.toThrow();
      expect(fixture.db.pragma("schema_version")).toBe(schemaBefore);
      const meta = fixture.db.prepare("SELECT capture_enabled, problem FROM roam_meta").get() as { capture_enabled: number; problem: string };
      expect(meta.capture_enabled).toBe(0);
      expect(meta.problem).toContain("roam_unexpected");
      expect(fixture.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'roam_unexpected'").get()).toEqual(triggerBefore);
      expect(() => fixture.db.exec("INSERT INTO todos(session_id, seq, text, created_at) VALUES ('other', 1, 'blocked', 1)")).toThrow("unexpected trigger blocked write");
      expect(fixture.db.prepare("SELECT text FROM todos WHERE session_id = 'other'").get()).toBeUndefined();
    } finally { reopened?.close(); fixture.close(); }
  }, 5000);

  it.each(SCOPES.flatMap(scope => [false, true].map(raises => ({ scope, raises }))))
  ("$scope preserves and reports an unprefixed foreign trigger (raises=$raises)", ({ scope, raises }) => {
    const fixture = createReplica(scope, MACHINE);
    let reopened: ReturnType<typeof openDbAt> | undefined;
    try {
      enable(fixture);
      const table = scope === "global" ? "global_memory" : scope === "repo" ? "memory" : "todos";
      const action = raises ? "SELECT RAISE(ABORT, 'foreign trigger refused');" : "SELECT 1;";
      fixture.db.exec(`CREATE TRIGGER foreign_guard BEFORE INSERT ON ${table} BEGIN ${action} END`);
      const triggerBefore = fixture.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'foreign_guard'").get();
      const schemaBefore = fixture.db.pragma("schema_version");
      expect(() => { reopened = openDbAt(join(fixture.root, "store.db"), scope); }).not.toThrow();
      expect(fixture.db.pragma("schema_version")).toBe(schemaBefore);
      const meta = fixture.db.prepare("SELECT capture_enabled, problem FROM roam_meta").get() as { capture_enabled: number; problem: string };
      expect(meta.capture_enabled).toBe(0);
      expect(meta.problem).toContain("foreign_guard");
      expect(fixture.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'foreign_guard'").get()).toEqual(triggerBefore);
      const write = () => fixture.db.exec(scope === "worktree"
        ? "INSERT INTO todos(session_id, seq, text, created_at) VALUES ('other', 1, 'ordinary', 1)"
        : `INSERT INTO ${table}(uuid, category, content, created_at) VALUES ('ordinary', 'insight', 'ordinary', 1)`);
      if (raises) expect(write).toThrow("foreign trigger refused");
      else expect(write).not.toThrow();
      expect(changes(fixture)).toEqual([]);
    } finally { reopened?.close(); fixture.close(); }
  }, 5000);

  it.each(SCOPES.flatMap(scope => [
    { scope, behavior: "abort", name: "roam_unexpected", timing: "BEFORE", body: "SELECT RAISE(ABORT, 'drift blocked update');" },
    { scope, behavior: "ignore", name: "foreign_meta_guard", timing: "BEFORE", body: "SELECT RAISE(IGNORE);" },
    { scope, behavior: "restore", name: "foreign_meta_guard", timing: "AFTER", body: "UPDATE roam_meta SET capture_enabled = 1 WHERE id = NEW.id;" },
  ]))("$scope refuses open when a foreign metadata trigger blocks capture shutdown ($behavior)", ({ scope, name, timing, body }) => {
    const fixture = createReplica(scope, MACHINE);
    let reopened: ReturnType<typeof openDbAt> | undefined;
    try {
      enable(fixture);
      fixture.db.exec(`CREATE TRIGGER ${name} ${timing} UPDATE ON roam_meta BEGIN ${body} END`);
      const triggerBefore = fixture.db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name);
      const schemaBefore = fixture.db.pragma("schema_version");
      expect(() => { reopened = openDbAt(join(fixture.root, "store.db"), scope); })
        .toThrow(new RegExp(`trigger.*drift.*${name}.*capture could not be disabled`, "i"));
      expect(fixture.db.pragma("schema_version")).toBe(schemaBefore);
      expect(fixture.db.prepare("SELECT capture_enabled, problem FROM roam_meta").get()).toEqual({ capture_enabled: 1, problem: null });
      expect(fixture.db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name)).toEqual(triggerBefore);
    } finally { reopened?.close(); fixture.close(); }
  }, 5000);

  it.each([false, true])("replaying an old version stamp preserves triggers and diagnoses drift (missing=%s)", missing => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      enable(fixture);
      fixture.db.exec("INSERT INTO todos(session_id, seq, text, created_at) VALUES ('session-a', 1, 'kept', 1)");
      if (missing) fixture.db.exec("DROP TRIGGER roam_todos_capture_ai");
      const triggers = fixture.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all();
      const rows = fixture.db.prepare("SELECT * FROM todos").all();
      const log = changes(fixture);
      fixture.db.raw.pragma("user_version = 13");
      expect(() => migrate(fixture.db, "worktree", { machineId: MACHINE, globalRoot: fixture.root })).not.toThrow();
      expect(fixture.db.pragma("user_version")).toBe(14);
      expect(fixture.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all()).toEqual(triggers);
      expect(fixture.db.prepare("SELECT * FROM todos").all()).toEqual(rows);
      expect(changes(fixture)).toEqual(log);
      const meta = fixture.db.prepare("SELECT capture_enabled, problem FROM roam_meta").get();
      expect(meta).toEqual(missing ? { capture_enabled: 0, problem: expect.stringMatching(/trigger.*drift/i) } : { capture_enabled: 1, problem: null });
    } finally { fixture.close(); }
  }, 5000);

  it("reopening a current store preserves triggers and data", () => {
    const fixture = createReplica("worktree", MACHINE);
    try {
      enable(fixture);
      fixture.db.exec("INSERT INTO todos(session_id, seq, text, created_at) VALUES ('session-a', 1, 'kept', 1)");
      const triggers = fixture.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all();
      const schema = fixture.db.pragma("schema_version");
      const total = fixture.db.prepare("SELECT total_changes() AS count").get();
      const log = changes(fixture);
      migrate(fixture.db, "worktree", { machineId: MACHINE, globalRoot: fixture.root });
      expect(fixture.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all()).toEqual(triggers);
      expect(fixture.db.pragma("schema_version")).toBe(schema);
      expect(fixture.db.prepare("SELECT total_changes() AS count").get()).toEqual(total);
      expect(changes(fixture)).toEqual(log);
    } finally { fixture.close(); }
  }, 5000);

  it("frozen uuid change is refused by either guard", () => {
    const cases = [
      { table: "todos", insert: "INSERT INTO todos(uuid, session_id, seq, text, created_at) VALUES ('old', 'session-a', 1, 'kept', 1)", field: "text" },
      { table: "run_events", insert: "INSERT INTO run_events(uuid, session_id, ts, type, summary) VALUES ('old', 'session-a', 1, 'created', 'kept')", field: "summary" },
    ];
    for (const { table, insert, field } of cases) for (const fixedLast of [false, true]) {
      const fixture = createReplica("worktree", MACHINE);
      try {
        enable(fixture);
        fixture.db.exec(insert);
        fixture.db.exec("UPDATE roam_sessions SET state = 'frozen'");
        const fixedName = `roam_${table}_uuid_fixed`;
        const fenceName = `roam_${table}_frozen_bu`;
        const triggers = fixture.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?)").all(fixedName, fenceName) as Array<{ name: string; sql: string }>;
        expect(triggers).toHaveLength(2);
        const fixed = triggers.find(trigger => trigger.name === fixedName)!.sql;
        const fence = triggers.find(trigger => trigger.name === fenceName)!.sql;
        fixture.db.exec(`DROP TRIGGER ${fixedName}; DROP TRIGGER ${fenceName}`);
        fixture.db.exec(fixedLast ? `${fence};\n${fixed};` : `${fixed};\n${fence};`);
        migrate(fixture.db, "worktree", { machineId: MACHINE, globalRoot: fixture.root });
        expect(fixture.db.prepare("SELECT capture_enabled, problem FROM roam_meta").get()).toEqual({ capture_enabled: 1, problem: null });
        const rowBefore = fixture.db.prepare(`SELECT * FROM ${table} WHERE uuid = 'old'`).get();
        const logBefore = changes(fixture);
        expect(() => fixture.db.exec(`UPDATE ${table} SET uuid = 'new' WHERE uuid = 'old'`))
          .toThrow(/session is frozen|roaming UUID cannot change/);
        expect(fixture.db.prepare(`SELECT * FROM ${table}`).all()).toEqual([rowBefore]);
        expect(changes(fixture)).toEqual(logBefore);
        expect(() => fixture.db.exec(`UPDATE ${table} SET ${field} = 'blocked' WHERE uuid = 'old'`)).toThrow(/^session is frozen$/);
      } finally { fixture.close(); }
    }
  }, 5000);

  it("generated SQL digest is pinned to schema fourteen", () => {
    for (const scope of SCOPES) expect(GENERATED_CAPTURE_SQL[scope]).toBe(captureSql(scope));
    const digest = createHash("sha256");
    for (const scope of SCOPES) digest.update(scope).update("\0").update(GENERATED_CAPTURE_SQL[scope]).update("\0");
    expect(digest.digest("hex")).toBe("525dffcd13a4c65376f6aafc5a243df785552412167356bf81397f10aa62b692");
    const spec = readFileSync(join(process.cwd(), "docs/superpowers/specs/2026-11-11-roaming-agents-design.md"), "utf8");
    const sample = /```sql\n(CREATE TRIGGER roam_todos_uuid_fill[\s\S]*?)\n```/.exec(spec)?.[1];
    expect(sample).toBeDefined();
    expect(GENERATED_CAPTURE_SQL.worktree).toContain(sample);
  }, 5000);

  it("fails loudly when either SQLite writer is older than 3.42", () => {
    const fixture = createReplica("global", MACHINE);
    try {
      const bundled = (fixture.db.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version;
      const cli = spawnSync("sqlite3", ["-version"], { encoding: "utf8" });
      expect(cli.error).toBeUndefined();
      expect(cli.status).toBe(0);
      for (const version of [bundled, cli.stdout.trim().split(/\s/)[0]]) {
        const [major, minor] = version.split(".").map(Number);
        expect(major > 3 || (major === 3 && minor >= 42), `SQLite ${version}`).toBe(true);
      }
    } finally { fixture.close(); }
  }, 5000);
});
