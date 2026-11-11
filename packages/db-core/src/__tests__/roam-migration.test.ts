import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb, type Db } from "../db";
import { migrate } from "../migrate";
import { openDbAt } from "../registry";
import { V13 } from "./fixtures/historical-schemas";
import type { Scope } from "../roam/types";

const roots: string[] = [];
const MACHINE = "11111111-1111-4111-8111-111111111111";
const schemas: Record<Scope, string> = V13;

function fixtureRoot(): string {
  const scratch = join(process.cwd(), ".spider", "scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "roam-migration-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function layout(db: Db): unknown {
  const objects = db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger') ORDER BY type, name")
    .all() as Array<{ type: string; name: string }>;
  return objects.map(({ type, name }) => ({
    type,
    name,
    shape: type === "table" ? db.prepare(`PRAGMA table_xinfo('${name}')`).all()
      : type === "index" ? db.prepare(`PRAGMA index_xinfo('${name}')`).all() : null,
  }));
}

function oldDb(root: string, scope: Scope): Db {
  const db = openDb(join(root, `${scope}-old.db`));
  db.exec(schemas[scope]);
  db.raw.pragma("user_version = 13");
  return db;
}

describe("roaming schema migration", () => {
  it("fresh and v13 layouts match in every scope", () => {
    const root = fixtureRoot();
    for (const scope of ["global", "repo", "worktree"] as const) {
      const fresh = openDb(join(root, `${scope}-fresh.db`));
      const old = oldDb(root, scope);
      try {
        migrate(fresh, scope, { machineId: MACHINE, globalRoot: root });
        migrate(old, scope, { machineId: MACHINE, globalRoot: root });
        expect(fresh.pragma("user_version")).toBe(14);
        expect(old.pragma("user_version")).toBe(14);
        expect(layout(old)).toEqual(layout(fresh));
        const tables = (fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name);
        for (const name of ["roam_meta", "roam_changes", "roam_versions", "roam_cursors", "roam_receipts"]) expect(tables).toContain(name);
        if (scope === "global") {
          for (const name of ["session_homes", "roam_repo_maps", "roam_workspace_maps", "roam_locations", "roam_home_actions"]) expect(tables).toContain(name);
          expect(tables).not.toContain("roam_sessions");
        }
        if (scope === "worktree") {
          expect(tables).toContain("roam_sessions");
          expect(tables).toContain("roam_seed_progress");
          expect(tables).not.toContain("session_homes");
        }
        if (scope === "repo") {
          expect(tables).not.toContain("session_homes");
          expect(tables).not.toContain("roam_sessions");
        }
        const freshMeta = fresh.prepare("SELECT machine_id, stream_id, store_key, capture_enabled, roamable FROM roam_meta").get();
        const oldMeta = old.prepare("SELECT machine_id, stream_id, store_key, capture_enabled, roamable FROM roam_meta").get();
        expect(freshMeta).toMatchObject({ machine_id: MACHINE, store_key: null, capture_enabled: 0, roamable: 1 });
        expect(oldMeta).toMatchObject({ machine_id: MACHINE, store_key: null, capture_enabled: 0, roamable: 1 });
        expect((freshMeta as { stream_id: string }).stream_id).not.toBe((oldMeta as { stream_id: string }).stream_id);
      } finally {
        old.close();
        fresh.close();
      }
    }
  }, 5000);

  it("replica fixtures use separate roots and deterministic store keys", async () => {
    const testutil = await import("../testutil");
    expect(typeof testutil.createReplica).toBe("function");
    const first = testutil.createReplica("global", MACHINE);
    const second = testutil.createReplica("global", "22222222-2222-4222-8222-222222222222");
    const repo = testutil.createReplica("repo", MACHINE);
    const worktree = testutil.createReplica("worktree", MACHINE);
    const root = first.root;
    try {
      expect(first.root).not.toBe(second.root);
      expect(first.storeKey).toBe("global");
      expect(second.storeKey).toBe("global");
      expect(repo.storeKey).toBe("repo:fixture-repo");
      expect(worktree.storeKey).toBe("worktree:fixture-repo:fixture-workspace");
      expect(first.db.pragma("user_version")).toBe(14);
      expect(first.db.prepare("SELECT machine_id, store_key, capture_enabled FROM roam_meta").get()).toEqual({ machine_id: MACHINE, store_key: "global", capture_enabled: 0 });
      expect(second.db.prepare("SELECT machine_id FROM roam_meta").get()).toEqual({ machine_id: "22222222-2222-4222-8222-222222222222" });
      expect(first.db.prepare("SELECT stream_id FROM roam_meta").get()).not.toEqual(second.db.prepare("SELECT stream_id FROM roam_meta").get());
    } finally {
      first.close(); second.close(); repo.close(); worktree.close();
    }
    expect(existsSync(root)).toBe(false);
  }, 5000);

  it("backfill preserves integer IDs and FTS rowids", () => {
    const root = fixtureRoot();
    const db = oldDb(root, "worktree");
    try {
      db.exec(`
        INSERT INTO sessions (id, started_at) VALUES ('session-a', 1);
        INSERT INTO runs (id, session_id, agent, status) VALUES ('run-a', 'session-a', 'worker', 'done');
        INSERT INTO todos (id, session_id, seq, text, created_at) VALUES (37, 'session-a', 1, 'visible sentinel', 1);
        INSERT INTO todos_fts (rowid, text) VALUES (37, 'visible sentinel');
        INSERT INTO run_events (id, run_id, session_id, ts, type) VALUES (91, 'run-a', 'session-a', 1, 'created');
      `);
      const beforeIds = {
        todo: db.prepare("SELECT id FROM todos").all(),
        event: db.prepare("SELECT id FROM run_events").all(),
      };
      const beforeFtsRowids = db.prepare("SELECT rowid FROM todos_fts WHERE todos_fts MATCH 'sentinel'").all();
      migrate(db, "worktree", { machineId: MACHINE, globalRoot: root });
      const afterIds = {
        todo: db.prepare("SELECT id FROM todos").all(),
        event: db.prepare("SELECT id FROM run_events").all(),
      };
      const afterFtsRowids = db.prepare("SELECT rowid FROM todos_fts WHERE todos_fts MATCH 'sentinel'").all();
      expect(beforeIds).toEqual({ todo: [{ id: 37 }], event: [{ id: 91 }] });
      expect(afterIds).toEqual(beforeIds);
      expect(afterFtsRowids).toEqual(beforeFtsRowids);
      expect(afterFtsRowids).toEqual([{ rowid: 37 }]);
      expect(db.prepare("SELECT origin_machine FROM sessions WHERE id = 'session-a'").get()).toEqual({ origin_machine: MACHINE });
      expect(db.prepare("SELECT origin_machine FROM runs WHERE id = 'run-a'").get()).toEqual({ origin_machine: MACHINE });
      expect((db.prepare("SELECT uuid FROM todos WHERE id = 37").get() as { uuid: string }).uuid).toEqual(expect.stringMatching(/^[0-9a-f]{32}$/));
      expect((db.prepare("SELECT uuid FROM run_events WHERE id = 91").get() as { uuid: string }).uuid).toEqual(expect.stringMatching(/^[0-9a-f]{32}$/));
    } finally { db.close(); }
  }, 5000);

  it("duplicate sequences disable only roaming", () => {
    const root = fixtureRoot();
    const db = oldDb(root, "worktree");
    try {
      db.exec(`
        INSERT INTO todos (id, session_id, seq, text, created_at) VALUES (17, 'session-a', 1, 'first', 1);
        INSERT INTO todos (id, session_id, seq, text, created_at) VALUES (29, 'session-a', 1, 'second', 1);
        INSERT INTO todos (id, session_id, seq, text, created_at) VALUES (41, 'session-b', 2, 'third', 1);
        INSERT INTO todos (id, session_id, seq, text, created_at) VALUES (43, 'session-b', 2, 'fourth', 1);
      `);
      expect(() => migrate(db, "worktree", { machineId: MACHINE, globalRoot: root })).not.toThrow();
      const meta = db.prepare("SELECT roamable, problem FROM roam_meta").get() as { roamable: number; problem: string };
      expect(meta).toMatchObject({ roamable: 0 });
      expect(meta.problem).toContain("17");
      expect(meta.problem).toContain("29");
      expect(meta.problem).toContain("41");
      expect(meta.problem).toContain("43");
      expect(meta.problem).not.toContain("session-a");
      expect(meta.problem).not.toContain("session-b");
      expect(meta.problem).not.toContain("first");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_todos_session_seq'").get()).toBeUndefined();
      expect(() => db.prepare("INSERT INTO todos (session_id, seq, text, created_at) VALUES ('session-a', 2, 'still writable', 2)").run()).not.toThrow();
      expect(db.prepare("SELECT id, seq, text FROM todos ORDER BY id").all()).toEqual([
        { id: 17, seq: 1, text: "first" },
        { id: 29, seq: 1, text: "second" },
        { id: 41, seq: 2, text: "third" },
        { id: 43, seq: 2, text: "fourth" },
        { id: 44, seq: 2, text: "still writable" },
      ]);
    } finally { db.close(); }
  }, 5000);

  it("concurrent writable opens reread version under IMMEDIATE", async () => {
    const root = fixtureRoot();
    const db = oldDb(root, "worktree");
    const path = join(root, "worktree-old.db");
    const script = `
      import { registerHooks } from 'node:module';
      import { readSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      registerHooks({ resolve(specifier, context, next) {
        try { return next(specifier, context); }
        catch (error) {
          if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return next(specifier + '.ts', context);
          throw error;
        }
      }});
      const { openDb } = await import(pathToFileURL(process.argv[1] + '/packages/db-core/src/db.ts').href);
      const { migrate } = await import(pathToFileURL(process.argv[1] + '/packages/db-core/src/migrate.ts').href);
      const db = openDb(process.argv[2]);
      const wrapped = new Proxy(db, { get(target, key) {
        if (key !== 'pragma') return Reflect.get(target, key);
        return source => {
          const value = target.pragma(source);
          if (source === 'user_version') {
            process.stdout.write('read:' + value + '\\n');
            readSync(0, Buffer.alloc(1), 0, 1, null);
          }
          return value;
        };
      }});
      try { migrate(wrapped, 'worktree', { machineId: process.argv[4], globalRoot: process.argv[3] }); }
      finally { db.close(); }
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, process.cwd(), path, root, MACHINE], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "", errors = "";
    child.stdout.on("data", chunk => { output += String(chunk); });
    child.stderr.on("data", chunk => { errors += String(chunk); });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`child did not read version: ${errors}`)), 3000);
        child.stdout.on("data", () => {
          if (output.includes("read:13\n")) { clearTimeout(timeout); resolve(); }
        });
        child.on("error", error => { clearTimeout(timeout); reject(error); });
      });
      migrate(db, "worktree", { machineId: MACHINE, globalRoot: root });
      db.exec("INSERT INTO todos (session_id, seq, text, created_at) VALUES ('ordinary', 1, 'after migration', 1)");
      child.stdin.end("x");
      expect(await closed, errors).toEqual({ code: 0, signal: null });
      expect(db.prepare("SELECT uuid FROM todos WHERE session_id = 'ordinary'").get()).toEqual({ uuid: null });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      db.close();
    }
  }, 5000);

  it("simultaneous migrations publish one verified backup", async () => {
    const root = fixtureRoot();
    const db = oldDb(root, "global");
    const path = join(root, "global-old.db");
    const script = `
      import { registerHooks } from 'node:module';
      import { readSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      registerHooks({ resolve(specifier, context, next) {
        try { return next(specifier, context); }
        catch (error) {
          if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return next(specifier + '.ts', context);
          throw error;
        }
      }});
      const { openDb } = await import(pathToFileURL(process.argv[1] + '/packages/db-core/src/db.ts').href);
      const { migrate } = await import(pathToFileURL(process.argv[1] + '/packages/db-core/src/migrate.ts').href);
      const db = openDb(process.argv[2]);
      const wrapped = new Proxy(db, { get(target, key) {
        if (key !== 'pragma') return Reflect.get(target, key);
        return source => {
          const value = target.pragma(source);
          if (source === 'user_version') {
            process.stdout.write('read:' + value + '\\n');
            readSync(0, Buffer.alloc(1), 0, 1, null);
          }
          return value;
        };
      }});
      try {
        migrate(wrapped, 'global', { machineId: process.argv[4], globalRoot: process.argv[3] });
        console.log(JSON.stringify(db.prepare('SELECT machine_id, stream_id FROM roam_meta').get()));
      } finally { db.close(); }
    `;
    const children = Array.from({ length: 2 }, () => spawn(process.execPath,
      ["--input-type=module", "-e", script, process.cwd(), path, root, MACHINE], { stdio: ["pipe", "pipe", "pipe"] }));
    try {
      const ready = children.map(child => new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("migration did not read its starting version")), 3000);
        child.stdout.on("data", chunk => {
          if (String(chunk).includes("read:13\n")) { clearTimeout(timeout); resolve(); }
        });
        child.on("error", error => { clearTimeout(timeout); reject(error); });
      }));
      const finished = children.map(child => new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
        let out = "", err = "";
        child.stdout.on("data", chunk => { out += String(chunk); });
        child.stderr.on("data", chunk => { err += String(chunk); });
        child.on("error", reject);
        child.on("close", code => resolve({ code, out, err }));
      }));
      await Promise.all(ready);
      for (const child of children) child.stdin.end("x");
      const results = await Promise.all(finished);
      expect(results.map(result => result.code), results.map(result => result.err).join("\n")).toEqual([0, 0]);
      expect(JSON.parse(results[0].out.trim().split("\n").at(-1)!)).toEqual(JSON.parse(results[1].out.trim().split("\n").at(-1)!));
      expect(db.pragma("user_version")).toBe(14);
      expect(db.prepare("SELECT count(*) AS n FROM roam_meta").get()).toEqual({ n: 1 });
      const directory = join(root, "roam", "backups");
      const backups = readdirSync(directory).filter(name => name.endsWith(".db"));
      expect(backups).toHaveLength(1);
      const backup = new Database(join(directory, backups[0]), { readonly: true });
      try { expect(backup.pragma("user_version", { simple: true })).toBe(13); }
      finally { backup.close(); }
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      db.close();
    }
  }, 5000);

  it("trigger drift disables capture but open succeeds", async () => {
    const root = fixtureRoot();
    const db = oldDb(root, "worktree");
    try {
      migrate(db, "worktree", { machineId: MACHINE, globalRoot: root });
      db.exec(`
        UPDATE roam_meta SET capture_enabled = 1;
        CREATE TRIGGER roam_unexpected AFTER INSERT ON todos BEGIN SELECT 1; END;
      `);
    } finally { db.close(); }
    let reopened: Db | undefined;
    try {
      expect(() => { reopened = openDbAt(join(root, "worktree-old.db"), "worktree"); }).not.toThrow();
      const store = reopened!;
      const meta = store.prepare("SELECT capture_enabled, problem FROM roam_meta").get() as { capture_enabled: number; problem: string };
      expect(meta.capture_enabled).toBe(0);
      expect(meta.problem).toMatch(/trigger/i);
      const { validateRoamLayout } = await import("../roam/layout");
      expect(validateRoamLayout(store, "worktree")).toEqual({ captureSafe: false, diagnostic: expect.stringMatching(/trigger/i) });
      expect(store.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'roam_unexpected'").get()).toEqual({ name: "roam_unexpected" });
      expect(() => store.prepare("INSERT INTO todos (session_id, seq, text, created_at) VALUES ('ordinary', 1, 'usable', 1)").run()).not.toThrow();
    } finally { reopened?.close(); }
  }, 5000);

  it("missing data column refuses open", () => {
    const root = fixtureRoot();
    const db = oldDb(root, "worktree");
    try {
      migrate(db, "worktree", { machineId: MACHINE, globalRoot: root });
      db.exec("ALTER TABLE sessions DROP COLUMN name");
      expect(() => migrate(db, "worktree", { machineId: MACHINE, globalRoot: root })).toThrow(/sessions.*name|name.*sessions/i);
      expect(db.pragma("user_version")).toBe(14);
    } finally { db.close(); }
    expect(() => openDbAt(join(root, "worktree-old.db"), "worktree")).toThrow(/sessions.*name|name.*sessions/i);
  }, 5000);

  it("missing roaming primary keys refuse open", () => {
    const root = fixtureRoot();
    const db = oldDb(root, "worktree");
    try {
      migrate(db, "worktree", { machineId: MACHINE, globalRoot: root });
      db.exec(`
        ALTER TABLE roam_versions RENAME TO old_versions;
        CREATE TABLE roam_versions AS SELECT * FROM old_versions;
        DROP TABLE old_versions;
      `);
      expect(() => migrate(db, "worktree", { machineId: MACHINE, globalRoot: root })).toThrow(/primary.*roam_versions|roam_versions.*primary/i);
    } finally { db.close(); }
    expect(() => openDbAt(join(root, "worktree-old.db"), "worktree")).toThrow(/primary.*roam_versions|roam_versions.*primary/i);
  }, 5000);

  it("missing roaming uniqueness constraints refuse open", () => {
    const root = fixtureRoot();
    const db = oldDb(root, "worktree");
    try {
      migrate(db, "worktree", { machineId: MACHINE, globalRoot: root });
      db.exec(`
        ALTER TABLE roam_meta RENAME TO old_meta;
        CREATE TABLE roam_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1), machine_id TEXT NOT NULL, stream_id TEXT NOT NULL,
          store_key TEXT, hlc_ms INTEGER NOT NULL DEFAULT 0, hlc_count INTEGER NOT NULL DEFAULT 0,
          capture_enabled INTEGER NOT NULL DEFAULT 0, importing INTEGER NOT NULL DEFAULT 0,
          roamable INTEGER NOT NULL DEFAULT 1, problem TEXT
        );
        INSERT INTO roam_meta SELECT * FROM old_meta;
        DROP TABLE old_meta;
      `);
      expect(() => migrate(db, "worktree", { machineId: MACHINE, globalRoot: root })).toThrow(/unique.*roam_meta|roam_meta.*unique/i);
    } finally { db.close(); }
  }, 5000);

  it("wrong UUID index collation refuses open", () => {
    const root = fixtureRoot();
    const db = oldDb(root, "worktree");
    try {
      migrate(db, "worktree", { machineId: MACHINE, globalRoot: root });
      db.exec("DROP INDEX idx_todos_uuid; CREATE UNIQUE INDEX idx_todos_uuid ON todos(uuid COLLATE NOCASE)");
      expect(() => migrate(db, "worktree", { machineId: MACHINE, globalRoot: root })).toThrow(/idx_todos_uuid/);
    } finally { db.close(); }
  }, 5000);

  it.each([
    "capture_enabled = 2", "importing = -1", "roamable = 2", "hlc_ms = -1", "hlc_count = -1",
    "hlc_ms = 9007199254740992", "machine_id = ''", "stream_id = ''",
  ])("invalid roaming metadata %s refuses open", assignment => {
    const root = fixtureRoot();
    const db = oldDb(root, "worktree");
    try {
      migrate(db, "worktree", { machineId: MACHINE, globalRoot: root });
      db.exec(`UPDATE roam_meta SET ${assignment}`);
      expect(() => migrate(db, "worktree", { machineId: MACHINE, globalRoot: root })).toThrow(/invalid.*roam|roam.*invalid/i);
    } finally { db.close(); }
  }, 5000);

  it("requires explicit repair after a diagnosed duplicate sequence", async () => {
    const root = fixtureRoot();
    const db = oldDb(root, "worktree");
    try {
      db.exec(`
        INSERT INTO todos (id, session_id, seq, text, created_at) VALUES (17, 'session-a', 1, 'first', 1);
        INSERT INTO todos (id, session_id, seq, text, created_at) VALUES (29, 'session-a', 1, 'second', 1);
      `);
      migrate(db, "worktree", { machineId: MACHINE, globalRoot: root });
      const core = await import("../index");
      expect(typeof core.validateRoamLayout).toBe("function");
      expect(typeof core.repairTodoSequenceIndex).toBe("function");
      expect(() => core.repairTodoSequenceIndex(db)).toThrow();
      expect(db.prepare("SELECT roamable FROM roam_meta").get()).toEqual({ roamable: 0 });
      db.exec("DELETE FROM todos WHERE id = 29");
      core.validateRoamLayout(db, "worktree");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_todos_session_seq'").get()).toBeUndefined();
      expect(db.prepare("SELECT roamable FROM roam_meta").get()).toEqual({ roamable: 0 });
      core.repairTodoSequenceIndex(db);
      expect(db.prepare("SELECT roamable, problem FROM roam_meta").get()).toEqual({ roamable: 1, problem: null });
      expect(() => db.prepare("INSERT INTO todos (session_id, seq, text, created_at) VALUES ('session-a', 1, 'duplicate', 1)").run()).toThrow(/unique/i);
    } finally { db.close(); }
  }, 5000);

  it("a missing sequence index without a diagnosis is corruption", () => {
    const root = fixtureRoot();
    const db = oldDb(root, "worktree");
    try {
      migrate(db, "worktree", { machineId: MACHINE, globalRoot: root });
      db.exec("DROP INDEX idx_todos_session_seq");
      expect(() => migrate(db, "worktree", { machineId: MACHINE, globalRoot: root })).toThrow(/idx_todos_session_seq/);
    } finally { db.close(); }
  }, 5000);

  it("a wrong todo uniqueness index refuses open", () => {
    const root = fixtureRoot();
    const db = oldDb(root, "worktree");
    try {
      migrate(db, "worktree", { machineId: MACHINE, globalRoot: root });
      db.exec("DROP INDEX idx_todos_session_seq; CREATE INDEX idx_todos_session_seq ON todos(seq, session_id)");
      expect(() => migrate(db, "worktree", { machineId: MACHINE, globalRoot: root })).toThrow(/idx_todos_session_seq/);
    } finally { db.close(); }
  }, 5000);

  it("backup failure refuses migration before mutation", () => {
    const root = fixtureRoot();
    const db = oldDb(root, "global");
    try {
      db.exec("INSERT INTO global_memory (uuid, category, content, created_at) VALUES ('m1', 'insight', 'retained', 1)");
      const before = db.prepare("SELECT * FROM global_memory").all();
      mkdirSync(join(root, "roam"), { mode: 0o700 });
      writeFileSync(join(root, "roam", "backups"), "not a directory", { mode: 0o600 });
      expect(() => migrate(db, "global", { machineId: MACHINE, globalRoot: root })).toThrow();
      expect(db.pragma("user_version")).toBe(13);
      expect(db.prepare("SELECT * FROM global_memory").all()).toEqual(before);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'roam_meta'").get()).toBeUndefined();
      expect((db.prepare("PRAGMA table_info(global_memory)").all() as Array<{ name: string }>).map(column => column.name)).not.toContain("machine_id");
    } finally { db.close(); }
  }, 5000);

  it("creates a private backup tree for a new explicit global root", () => {
    const root = fixtureRoot();
    const db = oldDb(root, "global");
    const globalRoot = join(root, "new-root");
    try {
      expect(() => migrate(db, "global", { machineId: MACHINE, globalRoot })).not.toThrow();
      expect(db.pragma("user_version")).toBe(14);
      expect(lstatSync(globalRoot).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(globalRoot, "roam", "backups")).mode & 0o777).toBe(0o700);
      expect(readdirSync(join(globalRoot, "roam", "backups")).filter(name => name.endsWith(".db"))).toHaveLength(1);
    } finally { db.close(); }
  }, 5000);

  it("requires space for the main database, WAL, and reserve before migration", async () => {
    const root = fixtureRoot();
    const db = oldDb(root, "global");
    try {
      db.raw.pragma("wal_autocheckpoint = 0");
      db.exec("INSERT INTO global_memory (uuid, category, content, created_at) VALUES ('m1', 'insight', 'retained', 1)");
      const file = join(root, "global-old.db");
      const required = statSync(file, { bigint: true }).size + statSync(`${file}-wal`, { bigint: true }).size + 16n * 1024n * 1024n;
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      vi.doMock("node:fs", () => ({ ...actual, statfsSync: () => ({ bavail: required - 1n, bsize: 1n }) }));
      vi.resetModules();
      const first = await import("../migrate");
      expect(() => first.migrate(db, "global", { machineId: MACHINE, globalRoot: root })).toThrow(/space/i);
      expect(db.pragma("user_version")).toBe(13);
      expect(db.prepare("SELECT uuid, content FROM global_memory").all()).toEqual([{ uuid: "m1", content: "retained" }]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'roam_meta'").get()).toBeUndefined();
      vi.doMock("node:fs", () => ({ ...actual, statfsSync: () => ({ bavail: required, bsize: 1n }) }));
      vi.resetModules();
      const second = await import("../migrate");
      expect(() => second.migrate(db, "global", { machineId: MACHINE, globalRoot: root })).not.toThrow();
      expect(db.pragma("user_version")).toBe(14);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
      db.close();
    }
  }, 5000);

  it("compares backup space without rounding large filesystem sizes", async () => {
    const root = fixtureRoot();
    const db = oldDb(root, "global");
    try {
      const file = join(root, "global-old.db");
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      const source = actual.realpathSync(file);
      const size = 9007199254740993n;
      const required = size + 16n * 1024n * 1024n;
      vi.doMock("node:fs", () => ({
        ...actual,
        statSync: (path: string, options?: { bigint?: boolean }) => {
          const stat = options?.bigint ? actual.statSync(path, { bigint: true }) : actual.statSync(path);
          if (path === source) return Object.assign(Object.create(stat), { size: options?.bigint ? size : Number(size) });
          if (path === `${source}-wal`) return Object.assign(Object.create(stat), { size: options?.bigint ? 0n : 0 });
          return stat;
        },
        statfsSync: () => ({ bavail: required - 1n, bsize: 1n }),
      }));
      vi.resetModules();
      const { migrate: isolatedMigrate } = await import("../migrate");
      expect(() => isolatedMigrate(db, "global", { machineId: MACHINE, globalRoot: root })).toThrow(/space/i);
      expect(db.pragma("user_version")).toBe(13);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
      db.close();
    }
  }, 5000);

  it("refuses a symlinked backup directory without changing the source", () => {
    const root = fixtureRoot();
    const db = oldDb(root, "global");
    try {
      db.exec("INSERT INTO global_memory (uuid, category, content, created_at) VALUES ('m1', 'insight', 'retained', 1)");
      mkdirSync(join(root, "roam"), { mode: 0o700 });
      mkdirSync(join(root, "target"), { mode: 0o700 });
      symlinkSync(join(root, "target"), join(root, "roam", "backups"), "dir");
      expect(() => migrate(db, "global", { machineId: MACHINE, globalRoot: root })).toThrow(/unsafe/i);
      expect(db.pragma("user_version")).toBe(13);
      expect(db.prepare("SELECT uuid, content FROM global_memory").all()).toEqual([{ uuid: "m1", content: "retained" }]);
      expect(readdirSync(join(root, "target"))).toEqual([]);
    } finally { db.close(); }
  }, 5000);

  it("migration rollback preserves original and backup", () => {
    const root = fixtureRoot();
    const db = oldDb(root, "worktree");
    let closed = false;
    try {
      db.exec(`
        INSERT INTO sessions (id, started_at) VALUES ('session-a', 1);
        CREATE TRIGGER reject_update BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;
      `);
      expect(() => migrate(db, "worktree", { machineId: MACHINE, globalRoot: root })).toThrow("fixture failure");
      expect(db.pragma("user_version")).toBe(13);
      expect(db.prepare("SELECT id, started_at FROM sessions").all()).toEqual([{ id: "session-a", started_at: 1 }]);
      expect((db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map(column => column.name)).not.toContain("origin_machine");
      const directory = join(root, "roam", "backups");
      expect(existsSync(directory)).toBe(true);
      const files = readdirSync(directory).filter(name => name.endsWith(".db"));
      expect(files).toHaveLength(1);
      const backup = new Database(join(directory, files[0]), { readonly: true });
      try {
        expect(backup.pragma("user_version", { simple: true })).toBe(13);
        expect(backup.prepare("SELECT id, started_at FROM sessions").all()).toEqual([{ id: "session-a", started_at: 1 }]);
      } finally { backup.close(); }
      db.close();
      closed = true;
      const reopened = new Database(join(root, "worktree-old.db"), { readonly: true });
      try {
        expect(reopened.pragma("user_version", { simple: true })).toBe(13);
        expect(reopened.prepare("SELECT id, started_at FROM sessions").all()).toEqual([{ id: "session-a", started_at: 1 }]);
      } finally { reopened.close(); }
    } finally { if (!closed) db.close(); }
  }, 5000);

  it("VACUUM backup includes committed WAL data", () => {
    const root = fixtureRoot();
    const db = oldDb(root, "global");
    try {
      db.raw.pragma("wal_autocheckpoint = 0");
      db.exec("INSERT INTO global_memory (uuid, category, content, created_at) VALUES ('wal-row', 'insight', 'committed', 1)");
      migrate(db, "global", { machineId: MACHINE, globalRoot: root });
      const directory = join(root, "roam", "backups");
      expect(existsSync(directory)).toBe(true);
      const files = readdirSync(directory).filter(name => name.endsWith(".db"));
      expect(files).toHaveLength(1);
      const backupPath = join(directory, files[0]);
      expect(lstatSync(directory).mode & 0o777).toBe(0o700);
      expect(lstatSync(backupPath).mode & 0o777).toBe(0o600);
      const backup = new Database(backupPath, { readonly: true });
      try {
        expect(backup.pragma("user_version", { simple: true })).toBe(13);
        expect(backup.prepare("SELECT uuid, content FROM global_memory").all()).toEqual([{ uuid: "wal-row", content: "committed" }]);
        expect(backup.pragma("integrity_check", { simple: true })).toBe("ok");
      } finally { backup.close(); }
    } finally { db.close(); }
  }, 5000);

  it("reuses only a verified backup for the same store and version", async () => {
    const root = fixtureRoot();
    const db = oldDb(root, "global");
    const core = await import("../db");
    expect(typeof core.backupBeforeMigration).toBe("function");
    let backupPath: string;
    try {
      db.exec("INSERT INTO global_memory (uuid, category, content, created_at) VALUES ('first', 'insight', 'original', 1)");
      backupPath = core.backupBeforeMigration(db, "global", root);
      const digest = createHash("sha256").update(readFileSync(backupPath)).digest("hex");
      db.exec("INSERT INTO global_memory (uuid, category, content, created_at) VALUES ('second', 'insight', 'later', 2)");
      expect(core.backupBeforeMigration(db, "global", root)).toBe(backupPath);
      expect(createHash("sha256").update(readFileSync(backupPath)).digest("hex")).toBe(digest);
      const backup = new Database(backupPath, { readonly: true });
      try { expect(backup.prepare("SELECT uuid FROM global_memory ORDER BY uuid").all()).toEqual([{ uuid: "first" }]); }
      finally { backup.close(); }
    } finally { db.close(); }
    const original = join(root, "global-old.db");
    renameSync(original, join(root, "global-replaced.db"));
    const replacement = oldDb(root, "global");
    try {
      expect(() => core.backupBeforeMigration(replacement, "global", root)).toThrow(/identity|store/i);
      expect(replacement.pragma("user_version")).toBe(13);
      expect(existsSync(backupPath!)).toBe(true);
    } finally { replacement.close(); }
  }, 5000);

  it("refuses a corrupted existing backup", async () => {
    const root = fixtureRoot();
    const db = oldDb(root, "global");
    try {
      const core = await import("../db");
      expect(typeof core.backupBeforeMigration).toBe("function");
      const backupPath = core.backupBeforeMigration(db, "global", root);
      const backup = new Database(backupPath);
      backup.pragma("user_version = 12");
      backup.close();
      expect(() => core.backupBeforeMigration(db, "global", root)).toThrow(/backup|version/i);
      const manifestPath = `${backupPath}.json`;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { sha256: string };
      manifest.sha256 = createHash("sha256").update(readFileSync(backupPath)).digest("hex");
      writeFileSync(manifestPath, JSON.stringify(manifest));
      expect(() => core.backupBeforeMigration(db, "global", root)).toThrow(/version/i);
      expect(db.pragma("user_version")).toBe(13);
    } finally { db.close(); }
  }, 5000);

  it("snapshotCoreDb exports committed WAL data independently", async () => {
    const root = fixtureRoot();
    const db = oldDb(root, "global");
    try {
      const core = await import("../db");
      expect(typeof core.snapshotCoreDb).toBe("function");
      db.raw.pragma("wal_autocheckpoint = 0");
      db.exec("INSERT INTO global_memory (uuid, category, content, created_at) VALUES ('snapshot', 'insight', 'committed', 1)");
      const destination = join(root, "snapshot.db");
      await core.snapshotCoreDb(db, destination);
      db.exec("INSERT INTO global_memory (uuid, category, content, created_at) VALUES ('later', 'insight', 'later', 2)");
      const snapshot = new Database(destination, { readonly: true });
      try { expect(snapshot.prepare("SELECT uuid FROM global_memory ORDER BY uuid").all()).toEqual([{ uuid: "snapshot" }]); }
      finally { snapshot.close(); }
      expect(lstatSync(destination).mode & 0o777).toBe(0o600);
    } finally { db.close(); }
  }, 5000);

  it("snapshotCoreDb does not overwrite an existing destination", async () => {
    const root = fixtureRoot();
    const db = oldDb(root, "global");
    try {
      const { snapshotCoreDb } = await import("../db");
      const destination = join(root, "existing.db");
      writeFileSync(destination, "retained", { mode: 0o600 });
      await expect(snapshotCoreDb(db, destination)).rejects.toThrow();
      expect(readFileSync(destination, "utf8")).toBe("retained");
    } finally { db.close(); }
  }, 5000);

  it("future schema open leaves the database file unchanged", () => {
    const root = fixtureRoot();
    const path = join(root, "future.db");
    const raw = new Database(path);
    raw.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('unchanged')");
    raw.pragma("user_version = 15");
    raw.close();
    const before = createHash("sha256").update(readFileSync(path)).digest("hex");
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(() => openDbAt(path, "global")).toThrow(/future/i);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(before);
  }, 5000);

  it("the generic database opener has no core schema ceiling", () => {
    const root = fixtureRoot();
    const path = join(root, "other.db");
    const raw = new Database(path);
    raw.pragma("user_version = 15");
    raw.close();
    const db = openDb(path);
    try { expect(db.pragma("user_version")).toBe(15); }
    finally { db.close(); }
  }, 5000);

  it("future schema in a committed WAL is refused", () => {
    const root = fixtureRoot();
    const path = join(root, "future-wal.db");
    const writer = new Database(path);
    try {
      writer.pragma("user_version = 13");
      writer.pragma("journal_mode = WAL");
      writer.pragma("wal_autocheckpoint = 0");
      writer.pragma("user_version = 15");
      expect(existsSync(`${path}-wal`)).toBe(true);
      expect(existsSync(`${path}-shm`)).toBe(true);
      const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
      const before = [digest(path), digest(`${path}-wal`)];
      expect(() => openDbAt(path, "global")).toThrow(/future/i);
      expect([digest(path), digest(`${path}-wal`)]).toEqual(before);
    } finally { writer.close(); }
  }, 5000);

  it("future schema refuses before application queries", () => {
    const root = fixtureRoot();
    const db = oldDb(root, "global");
    try {
      db.exec("INSERT INTO global_memory (uuid, category, content, created_at) VALUES ('m1', 'insight', 'retained', 1)");
      db.raw.pragma("user_version = 15");
      const before = db.prepare("SELECT * FROM global_memory").all();
      expect(() => migrate(db, "global", { machineId: MACHINE, globalRoot: root })).toThrow(/future/i);
      expect(db.pragma("user_version")).toBe(15);
      expect(db.prepare("SELECT * FROM global_memory").all()).toEqual(before);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'roam_meta'").get()).toBeUndefined();
    } finally { db.close(); }
  }, 5000);
});
