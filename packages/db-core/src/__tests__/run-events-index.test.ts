import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb, type Db } from "../db";
import { migrate, SCHEMA_VERSION } from "../migrate";
import { paths } from "../paths";
import { validateRoamLayout } from "../roam/layout";
import { openDbAt } from "../registry";
import { V13 } from "./fixtures/historical-schemas";

const roots: string[] = [];
function root(): string {
  const scratch = join(process.cwd(), ".spider", "scratch");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "run-events-index-"));
  roots.push(dir);
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function indexShape(db: Db): { columns: string[]; unique: number | undefined; partial: number | undefined } {
  const columns = (db.prepare("SELECT name FROM pragma_index_info('idx_run_events_run_id') ORDER BY seqno").all() as { name: string }[]).map(row => row.name);
  const index = db.prepare("SELECT \"unique\", partial FROM pragma_index_list('run_events') WHERE name = 'idx_run_events_run_id'").get() as { unique: number; partial: number } | undefined;
  return { columns, unique: index?.unique, partial: index?.partial };
}
function backups(): string[] {
  const dir = join(paths.globalRoot, "roam", "backups");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe("run event query index", () => {
  it("creates the index on a fresh project open", () => {
    const db = openDbAt(join(root(), "fresh.db"), "worktree");
    try {
      expect(db.pragma("user_version")).toBe(14);
      expect(SCHEMA_VERSION).toBe(14);
      expect(indexShape(db)).toEqual({ columns: ["run_id", "id"], unique: 0, partial: 0 });
    } finally { db.close(); }
  });

  it("adds the missing index to a current project without a version bump or backup", () => {
    const file = join(root(), "current.db");
    const original = openDbAt(file, "worktree");
    let version: unknown;
    try {
      original.exec("DROP INDEX IF EXISTS idx_run_events_run_id");
      version = original.pragma("user_version");
      expect(validateRoamLayout(original, "worktree", "inspect").needsWrite).toBe(false);
    } finally { original.close(); }
    const before = backups();
    const reopened = openDbAt(file, "worktree");
    try {
      expect(reopened.pragma("user_version")).toBe(version);
      expect(indexShape(reopened)).toEqual({ columns: ["run_id", "id"], unique: 0, partial: 0 });
      expect(backups()).toEqual(before);
    } finally { reopened.close(); }
  });

  it("opens an indexed current project without entering the write transaction or backing up", () => {
    const dir = root(), file = join(dir, "indexed.db");
    const initial = openDbAt(file, "worktree");
    initial.exec("CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id, id)");
    initial.close();
    const before = backups();
    const writer = new Database(file);
    writer.exec("BEGIN IMMEDIATE");
    let db: Db | undefined;
    try {
      db = openDb(file, { busyTimeoutMs: 25, checkpointOnClose: false });
      const noRetry = new Proxy(db, { get(target, key) { return key === "withRetry" ? (fn: () => unknown) => fn() : Reflect.get(target, key); } });
      expect(() => migrate(noRetry, "worktree", { machineId: "11111111-1111-4111-8111-111111111111", globalRoot: dir })).not.toThrow();
      expect(db.prepare("SELECT total_changes() AS n").get()).toEqual({ n: 0 });
      expect(db.pragma("user_version")).toBe(SCHEMA_VERSION);
      expect(backups()).toEqual(before);
    } finally { db?.close(); writer.exec("ROLLBACK"); writer.close(); }
  });

  it("opens a read-only current project without the index", () => {
    const file = join(root(), "readonly.db");
    const original = openDbAt(file, "worktree");
    original.exec("DROP INDEX idx_run_events_run_id");
    original.close();
    chmodSync(file, 0o444);
    try {
      const reopened = openDbAt(file, "worktree");
      try {
        expect(reopened.prepare("SELECT COUNT(*) AS n FROM run_events").get()).toEqual({ n: 0 });
        expect(indexShape(reopened).columns).toEqual([]);
      } finally { reopened.close(); }
    } finally { chmodSync(file, 0o600); }
  });

  it("opens promptly under a write lock, restores the timeout and retries next open", () => {
    const dir = root(), file = join(dir, "locked.db");
    const initial = openDbAt(file, "worktree");
    initial.exec("DROP INDEX idx_run_events_run_id");
    initial.close();
    const writer = new Database(file);
    writer.exec("BEGIN IMMEDIATE");
    const db = openDb(file, { busyTimeoutMs: 25, checkpointOnClose: false });
    try {
      const start = Date.now();
      expect(() => migrate(db, "worktree", { machineId: "11111111-1111-4111-8111-111111111111", globalRoot: dir })).not.toThrow();
      expect(Date.now() - start).toBeLessThan(1500);
      expect(db.pragma("busy_timeout")).toBe(25);
      expect(indexShape(db).columns).toEqual([]);
    } finally { db.close(); writer.exec("ROLLBACK"); writer.close(); }
    const reopened = openDbAt(file, "worktree");
    try { expect(indexShape(reopened).columns).toEqual(["run_id", "id"]); }
    finally { reopened.close(); }
  });

  it("opens and reports a deterministic index failure, then retries later", () => {
    const file = join(root(), "conflict.db");
    const initial = openDbAt(file, "worktree");
    initial.exec("DROP INDEX idx_run_events_run_id; CREATE VIEW idx_run_events_run_id AS SELECT 1");
    initial.close();
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const reopened = openDbAt(file, "worktree");
      try {
        expect(reopened.prepare("SELECT COUNT(*) AS n FROM run_events").get()).toEqual({ n: 0 });
        expect(indexShape(reopened).columns).toEqual([]);
        expect(diagnostic).toHaveBeenCalledTimes(1);
        expect(diagnostic.mock.calls[0]).toEqual([expect.stringMatching(/^Could not create run events index: [^\r\n]+$/)]);
        reopened.exec("DROP VIEW idx_run_events_run_id");
      } finally { reopened.close(); }
      const retried = openDbAt(file, "worktree");
      try { expect(indexShape(retried).columns).toEqual(["run_id", "id"]); }
      finally { retried.close(); }
    } finally { diagnostic.mockRestore(); }
  });

  it.each([0, 13])("rolls back a failed index build without aborting schema version %s", version => {
    const dir = root(), file = join(dir, `failure-${version}.db`);
    const db = openDb(file);
    if (version === 13) { db.exec(V13.worktree); db.raw.pragma("user_version = 13"); }
    const failing = new Proxy(db, { get(target, key) {
      if (key === "exec") return (sql: string) => {
        if (sql.startsWith("CREATE INDEX IF NOT EXISTS idx_run_events_run_id")) {
          target.raw.exec("CREATE TABLE index_failure_probe (id INTEGER)");
          throw new Error("injected index failure");
        }
        return target.exec(sql);
      };
      return Reflect.get(target, key);
    } });
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => migrate(failing, "worktree", { machineId: "11111111-1111-4111-8111-111111111111", globalRoot: dir })).not.toThrow();
      expect(db.pragma("user_version")).toBe(SCHEMA_VERSION);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='index_failure_probe'").get()).toBeUndefined();
      expect(db.prepare("SELECT COUNT(*) AS n FROM run_events").get()).toEqual({ n: 0 });
      expect(diagnostic).toHaveBeenCalledTimes(1);
    } finally { diagnostic.mockRestore(); db.close(); }
  });

  it("adds the index when migrating a v13 project", () => {
    const dir = root(), file = join(dir, "old.db");
    const old = openDb(file);
    old.exec(V13.worktree);
    old.raw.pragma("user_version = 13");
    old.close();
    const migrated = openDbAt(file, "worktree");
    try {
      expect(migrated.pragma("user_version")).toBe(SCHEMA_VERSION);
      expect(indexShape(migrated)).toEqual({ columns: ["run_id", "id"], unique: 0, partial: 0 });
    } finally { migrated.close(); }
  });

  it.each(["global", "repo"] as const)("does not add the worktree index to %s", scope => {
    const file = join(root(), `${scope}.db`);
    const db = openDbAt(file, scope);
    try { expect(db.prepare("SELECT name FROM sqlite_master WHERE name='idx_run_events_run_id'").get()).toBeUndefined(); }
    finally { db.close(); }
    const reopened = openDbAt(file, scope);
    try { expect(reopened.prepare("SELECT name FROM sqlite_master WHERE name='idx_run_events_run_id'").get()).toBeUndefined(); }
    finally { reopened.close(); }
  });
});
