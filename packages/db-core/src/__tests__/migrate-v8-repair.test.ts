// packages/db-core/src/__tests__/migrate-v8-repair.test.ts
// IMPORTANT 5: Pre-fix repo.db files are unrepairable
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../db";
import { migrate, SCHEMA_VERSION } from "../migrate";
import { REPO_SCHEMA } from "../schema";
import DatabaseConstructor from "better-sqlite3";

const scratch = join(dirname(fileURLToPath(import.meta.url)), "..", ".spider", "scratch", `migrate-v8-${process.pid}`);

beforeEach(() => {
  mkdirSync(scratch, { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("IMPORTANT 5: v8 repair migration", () => {
  it("poisoned repo.db (v7 with worktree schema, no memory_fts) must be repaired", () => {
    // Simulate a pre-fix build that created repo.db with wrong schema
    const repoDbPath = join(scratch, "poisoned-repo.db");
    const db = new DatabaseConstructor(repoDbPath);
    
    // Create the WRONG schema (worktree tables instead of repo tables)
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, parent_session_id TEXT, name TEXT, reason TEXT,
        started_at INTEGER NOT NULL, ended_at INTEGER,
        summary TEXT, imported_from TEXT
      );
      CREATE TABLE IF NOT EXISTS memory (
        id INTEGER PRIMARY KEY, uuid TEXT UNIQUE NOT NULL,
        category TEXT NOT NULL, content TEXT NOT NULL, link TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        source TEXT NOT NULL DEFAULT 'user',
        confidence REAL, session_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS skills (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
        tier TEXT NOT NULL DEFAULT 'project',
        category TEXT, path TEXT,
        state TEXT NOT NULL DEFAULT 'active',
        status TEXT NOT NULL DEFAULT 'active',
        source TEXT NOT NULL DEFAULT 'user',
        pinned INTEGER NOT NULL DEFAULT 0, protected INTEGER NOT NULL DEFAULT 0,
        use_count INTEGER NOT NULL DEFAULT 0, view_count INTEGER NOT NULL DEFAULT 0, patch_count INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER, last_viewed_at INTEGER, last_patched_at INTEGER,
        candidate_body TEXT, related TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER
      );
    `);
    
    // Add some memory data
    const now = Date.now();
    db.prepare(`INSERT INTO memory (uuid, category, content, created_at, updated_at) 
                VALUES (?, ?, ?, ?, ?)`).run("mem-1", "convention", "test memory", now, now);
    
    // Stamp as v7 (pre-fix version)
    db.pragma("user_version = 7");
    
    // NO memory_fts exists (this is the poison)
    const tablesBefore = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const tableNamesBefore = tablesBefore.map(t => t.name);
    expect(tableNamesBefore).toContain("memory");
    expect(tableNamesBefore).not.toContain("memory_fts");
    
    db.close();
    
    // Now run the migration with the new code
    const repoDb = openDb(repoDbPath);
    migrate(repoDb, "repo");
    
    // Should now have memory_fts
    const tablesAfter = repoDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const tableNamesAfter = tablesAfter.map(t => t.name);
    expect(tableNamesAfter).toContain("memory_fts");
    
    // memory_fts should be populated from memory
    const memoryCount = (repoDb.prepare("SELECT COUNT(*) as n FROM memory").get() as { n: number }).n;
    const ftsCount = (repoDb.prepare("SELECT COUNT(*) as n FROM memory_fts").get() as { n: number }).n;
    expect(memoryCount).toBe(1);
    expect(ftsCount).toBe(1);
    
    // Version should be bumped to 8
    const version = repoDb.pragma("user_version");
    expect(version).toBe(SCHEMA_VERSION);
    
    repoDb.close();
  });
  
  it("v8 migration is idempotent (running twice doesn't break)", () => {
    // Create a poisoned repo.db
    const repoDbPath = join(scratch, "repo.db");
    const db = new DatabaseConstructor(repoDbPath);
    
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        id INTEGER PRIMARY KEY, uuid TEXT UNIQUE NOT NULL,
        category TEXT NOT NULL, content TEXT NOT NULL, link TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        source TEXT NOT NULL DEFAULT 'user',
        confidence REAL, session_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER
      );
    `);
    
    const now = Date.now();
    db.prepare(`INSERT INTO memory (uuid, category, content, created_at, updated_at) 
                VALUES (?, ?, ?, ?, ?)`).run("mem-1", "convention", "test", now, now);
    
    db.pragma("user_version = 7");
    db.close();
    
    // Run migration first time
    const repoDb1 = openDb(repoDbPath);
    migrate(repoDb1, "repo");
    const ftsCount1 = (repoDb1.prepare("SELECT COUNT(*) as n FROM memory_fts").get() as { n: number }).n;
    expect(ftsCount1).toBe(1);
    repoDb1.close();
    
    // Run migration again (reopening should apply migrations again)
    const repoDb2 = openDb(repoDbPath);
    migrate(repoDb2, "repo");
    const ftsCount2 = (repoDb2.prepare("SELECT COUNT(*) as n FROM memory_fts").get() as { n: number }).n;
    
    // Should still be 1 (not duplicated)
    expect(ftsCount2).toBe(1);
    repoDb2.close();
  });
  
  it("v8 migration handles empty memory table", () => {
    // Create a poisoned repo.db with no memory rows
    const repoDbPath = join(scratch, "repo-empty.db");
    const db = new DatabaseConstructor(repoDbPath);
    
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        id INTEGER PRIMARY KEY, uuid TEXT UNIQUE NOT NULL,
        category TEXT NOT NULL, content TEXT NOT NULL, link TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        source TEXT NOT NULL DEFAULT 'user',
        confidence REAL, session_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER
      );
    `);
    
    db.pragma("user_version = 7");
    db.close();
    
    // Run migration
    const repoDb = openDb(repoDbPath);
    migrate(repoDb, "repo");
    
    // Should have memory_fts even though memory is empty
    const tables = repoDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const tableNames = tables.map(t => t.name);
    expect(tableNames).toContain("memory_fts");
    
    // FTS count should be 0
    const ftsCount = (repoDb.prepare("SELECT COUNT(*) as n FROM memory_fts").get() as { n: number }).n;
    expect(ftsCount).toBe(0);
    
    repoDb.close();
  });
});
