// packages/db-core/src/__tests__/migrate.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "../db";
import { migrate, SCHEMA_VERSION } from "../migrate";
import { scratchDbPath, cleanupScratch } from "../testutil";

const opened: { close(): void }[] = [];
afterEach(() => { for (const d of opened) d.close(); opened.length = 0; cleanupScratch(); });

function tables(db: { prepare(sql: string): { all(): unknown[] } }): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name").all() as { name: string }[]).map(r => r.name);
}

describe("migrate", () => {
  it("creates all global tables and stamps user_version", () => {
    const db = openDb(scratchDbPath("global")); opened.push(db);
    migrate(db, "global");
    const t = tables(db);
    for (const name of ["projects", "global_memory", "upstream_refs", "message_mirror", "insights"]) {
      expect(t).toContain(name);
    }
    expect(Number(db.pragma("user_version"))).toBe(SCHEMA_VERSION);
  });

  it("creates all project tables including fts + runs/run_events/events", () => {
    const db = openDb(scratchDbPath("project")); opened.push(db);
    migrate(db, "project");
    const t = tables(db);
    for (const name of ["sessions", "memory", "content", "todos", "runs", "run_events", "events", "vector_map", "embed_queue"]) {
      expect(t).toContain(name);
    }
    // fts5 virtual tables register as tables too
    expect(t).toContain("memory_fts");
    expect(t).toContain("content_fts");
  });

  it("is idempotent (second run is a no-op)", () => {
    const db = openDb(scratchDbPath("idem")); opened.push(db);
    migrate(db, "project");
    expect(() => migrate(db, "project")).not.toThrow();
    expect(Number(db.pragma("user_version"))).toBe(SCHEMA_VERSION);
  });

  it("project memory row round-trips with default status/source", () => {
    const db = openDb(scratchDbPath("mem")); opened.push(db);
    migrate(db, "project");
    db.prepare("INSERT INTO memory (uuid, category, content, created_at) VALUES (?,?,?,?)").run("u1", "insight", "hi", Date.now());
    const row = db.prepare("SELECT status, source FROM memory WHERE uuid = ?").get("u1") as { status: string; source: string };
    expect(row).toEqual({ status: "active", source: "user" });
  });
});

describe("migrate — thinking column (v1\u2192v2)", () => {
  it("adds runs.thinking to an existing v1 db without the column", () => {
    const db = openDb(scratchDbPath("mig-v1")); opened.push(db);
    // Simulate an OLD v1 db: runs table WITHOUT thinking, user_version=1.
    db.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent TEXT NOT NULL,
             status TEXT NOT NULL, phase TEXT, model TEXT, task TEXT, step_count INTEGER DEFAULT 0,
             token_count INTEGER DEFAULT 0)`);
    db.raw.pragma("user_version = 1");
    migrate(db, "project");
    const cols = (db.raw.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("thinking");
    expect(Number(db.pragma("user_version"))).toBe(SCHEMA_VERSION);
  });

  it("a fresh db gets thinking via the full schema", () => {
    const db = openDb(scratchDbPath("mig-fresh")); opened.push(db);
    migrate(db, "project");
    const cols = (db.raw.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("thinking");
  });
});

describe("migrate — schema v5 global/project", () => {
  // Mutation: revert scope selection to `scope === "project" ? ... : []` — global steps never run.
  it("v4 global db migrates to v5, gains delivered_at and read_at columns, preserves existing rows", () => {
    const db = openDb(scratchDbPath("mig-v4-global")); opened.push(db);
    // Simulate v4 global schema: complete v4 schema including projects table
    db.exec(`CREATE TABLE projects (
      project_key TEXT PRIMARY KEY,
      real_path TEXT NOT NULL,
      git_common_dir TEXT,
      db_path TEXT NOT NULL,
      name TEXT,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      session_count INTEGER NOT NULL DEFAULT 0,
      memory_count INTEGER NOT NULL DEFAULT 0
    )`);
    db.exec(`CREATE TABLE message_mirror (
      id INTEGER PRIMARY KEY, from_session TEXT, to_session TEXT,
      kind TEXT, body TEXT, created_at INTEGER NOT NULL
    )`);
    db.prepare("INSERT INTO message_mirror (from_session, to_session, kind, body, created_at) VALUES (?, ?, ?, ?, ?)").run(
      "s1", "s2", "request", "test", Date.now()
    );
    db.raw.pragma("user_version = 4");
    migrate(db, "global");
    const cols = (db.raw.prepare("PRAGMA table_info(message_mirror)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("delivered_at");
    expect(cols).toContain("read_at");
    const count = (db.prepare("SELECT COUNT(*) as c FROM message_mirror").get() as { c: number }).c;
    expect(count).toBe(1);
    expect(Number(db.pragma("user_version"))).toBe(SCHEMA_VERSION);
  });

  // Mutation: drop the v5 step in PROJECT_MIGRATIONS — project v4→v5 fails.
  it("v4 project db migrates to v5 without error", () => {
    const db = openDb(scratchDbPath("mig-v4-project")); opened.push(db);
    // Simulate v4 project schema: runs with pid/host_pid
    db.exec(`CREATE TABLE runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent TEXT NOT NULL,
      status TEXT NOT NULL, phase TEXT, model TEXT, task TEXT, thinking TEXT,
      step_count INTEGER DEFAULT 0, token_count INTEGER DEFAULT 0,
      pid INTEGER, host_pid INTEGER
    )`);
    db.raw.pragma("user_version = 4");
    expect(() => migrate(db, "project")).not.toThrow();
    expect(Number(db.pragma("user_version"))).toBe(SCHEMA_VERSION);
  });

  // Mutation: change fresh schema to NOT include delivered_at/read_at → fresh != migrated.
  it("fresh global db has same message_mirror columns as migrated v4 global db", () => {
    const fresh = openDb(scratchDbPath("mig-fresh-global")); opened.push(fresh);
    migrate(fresh, "global");
    const freshCols = (fresh.raw.prepare("PRAGMA table_info(message_mirror)").all() as { name: string }[]).map((c) => c.name).sort();

    const migrated = openDb(scratchDbPath("mig-v4-parity")); opened.push(migrated);
    // Complete v4 global schema
    migrated.exec(`CREATE TABLE projects (
      project_key TEXT PRIMARY KEY,
      real_path TEXT NOT NULL,
      git_common_dir TEXT,
      db_path TEXT NOT NULL,
      name TEXT,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      session_count INTEGER NOT NULL DEFAULT 0,
      memory_count INTEGER NOT NULL DEFAULT 0
    )`);
    migrated.exec(`CREATE TABLE message_mirror (
      id INTEGER PRIMARY KEY, from_session TEXT, to_session TEXT,
      kind TEXT, body TEXT, created_at INTEGER NOT NULL
    )`);
    migrated.raw.pragma("user_version = 4");
    migrate(migrated, "global");
    const migratedCols = (migrated.raw.prepare("PRAGMA table_info(message_mirror)").all() as { name: string }[]).map((c) => c.name).sort();

    expect(freshCols).toEqual(migratedCols);
  });

  // Mutation: make migration throw on repeat → idempotency test fails.
  it("global migration is idempotent (opening twice is a no-op)", () => {
    const db = openDb(scratchDbPath("mig-idem-global")); opened.push(db);
    migrate(db, "global");
    expect(() => migrate(db, "global")).not.toThrow();
    expect(Number(db.pragma("user_version"))).toBe(SCHEMA_VERSION);
  });
});

describe("migrate — schema v6 global repo_key", () => {
  // Mutation: remove v6 step from GLOBAL_MIGRATIONS → this test fails.
  it("v5 global db migrates to v6, gains repo_key column, preserves existing rows", () => {
    const db = openDb(scratchDbPath("mig-v5-global")); opened.push(db);
    // Simulate v5 global schema: projects without repo_key
    db.exec(`CREATE TABLE projects (
      project_key TEXT PRIMARY KEY,
      real_path TEXT NOT NULL,
      git_common_dir TEXT,
      db_path TEXT NOT NULL,
      name TEXT,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      session_count INTEGER NOT NULL DEFAULT 0,
      memory_count INTEGER NOT NULL DEFAULT 0
    )`);
    db.prepare(`INSERT INTO projects (project_key, real_path, db_path, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)`).run(
      "/test/key", "/test/path", "/test/path/.spider/project.db", Date.now(), Date.now()
    );
    db.raw.pragma("user_version = 5");
    migrate(db, "global");
    const cols = (db.raw.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("repo_key");
    const count = (db.prepare("SELECT COUNT(*) as c FROM projects").get() as { c: number }).c;
    expect(count).toBe(1);
    expect(Number(db.pragma("user_version"))).toBe(SCHEMA_VERSION);
  });

  // Mutation: change fresh schema to NOT include repo_key → fresh != migrated.
  it("fresh global db has same projects columns as migrated v5 global db", () => {
    const fresh = openDb(scratchDbPath("mig-fresh-v6-global")); opened.push(fresh);
    migrate(fresh, "global");
    const freshCols = (fresh.raw.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).map((c) => c.name).sort();

    const migrated = openDb(scratchDbPath("mig-v5-parity")); opened.push(migrated);
    migrated.exec(`CREATE TABLE projects (
      project_key TEXT PRIMARY KEY,
      real_path TEXT NOT NULL,
      git_common_dir TEXT,
      db_path TEXT NOT NULL,
      name TEXT,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      session_count INTEGER NOT NULL DEFAULT 0,
      memory_count INTEGER NOT NULL DEFAULT 0
    )`);
    migrated.raw.pragma("user_version = 5");
    migrate(migrated, "global");
    const migratedCols = (migrated.raw.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).map((c) => c.name).sort();

    expect(freshCols).toEqual(migratedCols);
  });

  // Mutation: drop v6 from PROJECT_MIGRATIONS → project v5→v6 fails.
  it("v5 project db migrates to v6 without error", () => {
    const db = openDb(scratchDbPath("mig-v5-project")); opened.push(db);
    db.exec(`CREATE TABLE runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent TEXT NOT NULL,
      status TEXT NOT NULL, phase TEXT, model TEXT, task TEXT, thinking TEXT,
      step_count INTEGER DEFAULT 0, token_count INTEGER DEFAULT 0,
      pid INTEGER, host_pid INTEGER
    )`);
    db.raw.pragma("user_version = 5");
    expect(() => migrate(db, "project")).not.toThrow();
    expect(Number(db.pragma("user_version"))).toBe(SCHEMA_VERSION);
  });
});
