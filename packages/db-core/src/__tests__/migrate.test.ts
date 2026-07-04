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
