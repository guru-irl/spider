// packages/host/src/__tests__/migrate-critical-tests.test.ts
// Tests for CRITICAL data-loss defects in migrate command
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { openDbAt, paths } from "@spider/db-core";
import type { Db } from "@spider/db-core";
import { setGlobalDbPathForTests } from "@spider/db-core";
import { controlMigrate } from "../control/migrate-cmd";
import DatabaseConstructor from "better-sqlite3";

const scratch = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".spider", "scratch", `migrate-critical-${process.pid}`);

beforeEach(() => {
  mkdirSync(scratch, { recursive: true });
  setGlobalDbPathForTests(join(scratch, `g-${Date.now()}.db`));
});

afterEach(() => {
  setGlobalDbPathForTests(null);
  rmSync(scratch, { recursive: true, force: true });
});

/** Create a git repo with old-style DB */
function setupOldStyleRepo(useRawDb = false): { repoDir: string; worktree: string } {
  const repoDir = join(scratch, "repo");
  mkdirSync(repoDir, { recursive: true });
  
  // Init main repo
  execFileSync("git", ["init"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@test"], { cwd: repoDir });
  writeFileSync(join(repoDir, "README.md"), "# Test\n");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });
  
  // Create old-style DB with mixed tables
  const spiderDir = join(repoDir, ".spider");
  mkdirSync(spiderDir, { recursive: true });
  
  // For I4 test, use raw DB to avoid WAL files; otherwise use openDbAt
  const dbPath = join(spiderDir, "project.db");
  const db = useRawDb 
    ? new DatabaseConstructor(dbPath)
    : openDbAt(dbPath, "worktree");
  
  // Old schema had everything in one DB
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory (
      id INTEGER PRIMARY KEY, uuid TEXT UNIQUE NOT NULL,
      category TEXT NOT NULL, content TEXT NOT NULL, link TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      source TEXT NOT NULL DEFAULT 'user',
      confidence REAL, session_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(uuid UNINDEXED, category, content, link);
    
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, parent_session_id TEXT, name TEXT, reason TEXT,
      started_at INTEGER NOT NULL, ended_at INTEGER,
      summary TEXT, imported_from TEXT
    );
    
    CREATE TABLE IF NOT EXISTS vector_map (
      rowid INTEGER PRIMARY KEY, owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL, model TEXT NOT NULL, dim INTEGER NOT NULL,
      embedding BLOB
    );
    CREATE TABLE IF NOT EXISTS embed_queue (
      id INTEGER PRIMARY KEY, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
      text TEXT NOT NULL, enqueued_at INTEGER NOT NULL, tries INTEGER DEFAULT 0
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
    
    CREATE TABLE IF NOT EXISTS curator_state (
      scope TEXT PRIMARY KEY,
      last_run_at INTEGER, paused INTEGER NOT NULL DEFAULT 0
    );
  `);
  
  const now = Date.now();
  
  // Insert repo-tier data
  db.prepare(`INSERT INTO memory (uuid, category, content, created_at, updated_at) 
              VALUES (?, ?, ?, ?, ?)`).run("mem-1", "convention", "test memory", now, now);
  db.prepare(`INSERT INTO memory_fts (uuid, category, content) VALUES (?, ?, ?)`).run("mem-1", "convention", "test memory");
  
  db.prepare(`INSERT INTO skills (name, category, path, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?)`).run("skill-1", "test", "/path/to/skill", now, now);
  
  db.prepare(`INSERT INTO curator_state (scope, last_run_at) VALUES (?, ?)`).run("test", now);
  
  // Insert worktree-tier data
  db.prepare(`INSERT INTO sessions (id, name, started_at) VALUES (?, ?, ?)`).run("sess-1", "Test Session", now);
  
  // Insert vector data (worktree-tier)
  db.prepare(`INSERT INTO vector_map (owner_kind, owner_id, model, dim, embedding) 
              VALUES (?, ?, ?, ?, ?)`).run("session", "sess-1", "test-model", 3, Buffer.from([1, 2, 3, 4]));
  db.prepare(`INSERT INTO embed_queue (owner_kind, owner_id, text, enqueued_at) 
              VALUES (?, ?, ?, ?)`).run("session", "sess-1", "test text", now);
  
  if (useRawDb) {
    // Set user_version to old schema version (4)
    (db as any).pragma("user_version = 4");
  }
  
  db.close();
  
  return { repoDir, worktree: repoDir };
}

describe("C2: repo.db created with WRONG SCHEMA", () => {
  it("repo.db must have REPO_SCHEMA (includes memory_fts, excludes worktree tables)", () => {
    const { repoDir, worktree } = setupOldStyleRepo();
    
    // Apply migration
    const result = controlMigrate({ apply: true, cwd: worktree });
    expect(result.applied).toBe(true);
    
    // Check the created repo.db
    const gitCommonDir = join(repoDir, ".git");
    const repoDbPath = join(gitCommonDir, "spider", "repo.db");
    expect(existsSync(repoDbPath)).toBe(true);
    
    const repoDb = openDbAt(repoDbPath, "repo");
    const tables = repoDb.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const tableNames = tables.map(t => t.name);
    repoDb.close();
    
    // Must have repo-tier tables (including memory_fts!)
    expect(tableNames).toContain("memory");
    expect(tableNames).toContain("memory_fts");
    expect(tableNames).toContain("skills");
    expect(tableNames).toContain("curator_state");
    expect(tableNames).toContain("vector_map");
    expect(tableNames).toContain("embed_queue");
    
    // Must NOT have worktree-tier tables
    expect(tableNames).not.toContain("sessions");
    expect(tableNames).not.toContain("sessions_fts");
    expect(tableNames).not.toContain("content");
    expect(tableNames).not.toContain("content_fts");
    expect(tableNames).not.toContain("todos");
    expect(tableNames).not.toContain("todos_fts");
    expect(tableNames).not.toContain("runs");
    expect(tableNames).not.toContain("run_events");
    expect(tableNames).not.toContain("events");
  });
  
  it("memory_fts is functional in repo.db after migration", () => {
    const { repoDir, worktree } = setupOldStyleRepo();
    
    // Apply migration
    controlMigrate({ apply: true, cwd: worktree });
    
    // Check that memory_fts works
    const gitCommonDir = join(repoDir, ".git");
    const repoDbPath = join(gitCommonDir, "spider", "repo.db");
    const repoDb = openDbAt(repoDbPath, "repo");
    
    // Should be able to search in memory_fts
    const result = repoDb.prepare("SELECT * FROM memory_fts WHERE content MATCH 'memory'").all();
    expect(result.length).toBeGreaterThan(0);
    
    repoDb.close();
  });
});

describe("C3: worktree vectors DROPPED without copying", () => {
  it("dry-run report matches what apply actually moves", () => {
    const { worktree } = setupOldStyleRepo();
    
    // Dry-run
    const dryResult = controlMigrate({ dryRun: true, cwd: worktree });
    const dryTables = Object.keys(dryResult.wouldMove || {});
    
    // Apply
    const applyResult = controlMigrate({ apply: true, cwd: worktree });
    const applyTables = Object.keys(applyResult.moved || {});
    
    // The sets must be identical
    expect(new Set(dryTables)).toEqual(new Set(applyTables));
  });
  
  it("worktree-tier vector_map and embed_queue NOT dropped or moved", () => {
    const { repoDir, worktree } = setupOldStyleRepo();
    
    const wtDbPath = join(worktree, ".spider", "project.db");
    
    // Count vectors before
    const dbBefore = openDbAt(wtDbPath, "worktree");
    const vectorsBefore = (dbBefore.prepare("SELECT COUNT(*) as n FROM vector_map").get() as { n: number }).n;
    const queueBefore = (dbBefore.prepare("SELECT COUNT(*) as n FROM embed_queue").get() as { n: number }).n;
    dbBefore.close();
    
    expect(vectorsBefore).toBeGreaterThan(0);
    expect(queueBefore).toBeGreaterThan(0);
    
    // Apply migration
    controlMigrate({ apply: true, cwd: worktree });
    
    // Vectors should still exist in worktree DB
    const dbAfter = openDbAt(wtDbPath, "worktree");
    const vectorsAfter = (dbAfter.prepare("SELECT COUNT(*) as n FROM vector_map").get() as { n: number }).n;
    const queueAfter = (dbAfter.prepare("SELECT COUNT(*) as n FROM embed_queue").get() as { n: number }).n;
    dbAfter.close();
    
    expect(vectorsAfter).toBe(vectorsBefore);
    expect(queueAfter).toBe(queueBefore);
  });
  
  it("memory_fts content correctly populated in repo.db", () => {
    const { repoDir, worktree } = setupOldStyleRepo();
    
    // Apply migration
    controlMigrate({ apply: true, cwd: worktree });
    
    // Check memory_fts in repo.db has the same content as memory
    const gitCommonDir = join(repoDir, ".git");
    const repoDbPath = join(gitCommonDir, "spider", "repo.db");
    const repoDb = openDbAt(repoDbPath, "repo");
    
    const memoryCount = (repoDb.prepare("SELECT COUNT(*) as n FROM memory").get() as { n: number }).n;
    const ftsCount = (repoDb.prepare("SELECT COUNT(*) as n FROM memory_fts").get() as { n: number }).n;
    
    expect(ftsCount).toBe(memoryCount);
    expect(memoryCount).toBeGreaterThan(0);
    
    repoDb.close();
  });
});

describe("I4: dry-run is not read-only", () => {
  it("dry-run does not modify source DB (no WAL files, no version stamp)", async () => {
    const { worktree } = setupOldStyleRepo(true); // Use raw DB to avoid WAL files
    
    const dbPath = join(worktree, ".spider", "project.db");
    
    // Get original state (before opening with openDbAt)
    const originalContent = readFileSync(dbPath);
    const originalMtime = statSync(dbPath).mtimeMs;
    
    // WAL files should not exist before
    expect(existsSync(dbPath + "-wal")).toBe(false);
    expect(existsSync(dbPath + "-shm")).toBe(false);
    
    // Wait a bit to ensure mtime would change if file is modified
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // Run dry-run
    const result = controlMigrate({ dryRun: true, cwd: worktree });
    expect(result.dryRun).toBe(true);
    
    // DB should not be modified
    const afterContent = readFileSync(dbPath);
    const afterMtime = statSync(dbPath).mtimeMs;
    
    // Content should be identical
    expect(afterContent.equals(originalContent)).toBe(true);
    
    // No WAL files should be created
    expect(existsSync(dbPath + "-wal")).toBe(false);
    expect(existsSync(dbPath + "-shm")).toBe(false);
  });
});

describe("I5: conflicts and atomicity", () => {
  it("ALL conflicts (memory, skills, curator_state) are reported", () => {
    // Create two worktrees with conflicting data
    const repoDir = join(scratch, "repo");
    mkdirSync(repoDir, { recursive: true });
    
    execFileSync("git", ["init"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# Test\n");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });
    
    const wt1 = join(scratch, "wt1");
    const wt2 = join(scratch, "wt2");
    execFileSync("git", ["worktree", "add", wt1, "-b", "feat-a"], { cwd: repoDir });
    execFileSync("git", ["worktree", "add", wt2, "-b", "feat-b"], { cwd: repoDir });
    
    // Create old-style DBs with SAME keys
    for (const wt of [wt1, wt2]) {
      const spiderDir = join(wt, ".spider");
      mkdirSync(spiderDir, { recursive: true });
      const db = openDbAt(join(spiderDir, "project.db"), "worktree");
      
      db.exec(`
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
        CREATE TABLE IF NOT EXISTS curator_state (
          scope TEXT PRIMARY KEY,
          last_run_at INTEGER, paused INTEGER NOT NULL DEFAULT 0
        );
      `);
      
      const now = Date.now();
      db.prepare(`INSERT INTO memory (uuid, category, content, created_at, updated_at) 
                  VALUES (?, ?, ?, ?, ?)`).run("same-uuid", "convention", `from ${wt}`, now, now);
      db.prepare(`INSERT INTO skills (name, category, path, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?)`).run("same-skill", "test", `/path/${wt}`, now, now);
      db.prepare(`INSERT INTO curator_state (scope, last_run_at) VALUES (?, ?)`).run("same-scope", now);
      
      db.close();
    }
    
    // Migrate from wt1 - this will now process ALL worktrees (I2 fix)
    const result = controlMigrate({ apply: true, cwd: wt1 });
    
    // Should report ALL conflicts from both worktrees
    expect(result.ambiguous).toBeDefined();
    expect(result.ambiguous!.length).toBeGreaterThanOrEqual(3); // memory, skills, curator_state
    
    const tables = result.ambiguous!.map((a: { table: string }) => a.table);
    expect(tables).toContain("memory");
    expect(tables).toContain("skills");
    expect(tables).toContain("curator_state");
  });
});
