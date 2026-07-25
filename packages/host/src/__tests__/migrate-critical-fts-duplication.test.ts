// packages/host/src/__tests__/migrate-critical-fts-duplication.test.ts
// CRITICAL 1: Unbounded memory_fts duplication during migration
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { openDbAt } from "@spider/db-core";
import { setGlobalDbPathForTests } from "@spider/db-core";
import { controlMigrate } from "../control/migrate-cmd";

const scratch = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".spider", "scratch", `fts-dup-${process.pid}`);

beforeEach(() => {
  mkdirSync(scratch, { recursive: true });
  setGlobalDbPathForTests(join(scratch, `g-${Date.now()}.db`));
});

afterEach(() => {
  setGlobalDbPathForTests(null);
  rmSync(scratch, { recursive: true, force: true });
});

describe("CRITICAL 1: FTS duplication", () => {
  it("running migration TWICE must not duplicate memory_fts rows", () => {
    // Create repo with old-style DB
    const repoDir = join(scratch, "repo");
    mkdirSync(repoDir, { recursive: true });
    
    execFileSync("git", ["init"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# Test\n");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });
    
    const spiderDir = join(repoDir, ".spider");
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
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY);
    `);
    
    const now = Date.now();
    // Insert 3 memory rows
    db.prepare(`INSERT INTO memory (uuid, category, content, created_at, updated_at) 
                VALUES (?, ?, ?, ?, ?)`).run("mem-1", "convention", "test 1", now, now);
    db.prepare(`INSERT INTO memory (uuid, category, content, created_at, updated_at) 
                VALUES (?, ?, ?, ?, ?)`).run("mem-2", "convention", "test 2", now, now);
    db.prepare(`INSERT INTO memory (uuid, category, content, created_at, updated_at) 
                VALUES (?, ?, ?, ?, ?)`).run("mem-3", "preference", "test 3", now, now);
    
    db.close();
    
    // Run migration first time
    const result1 = controlMigrate({ apply: true, cwd: repoDir });
    expect(result1.applied).toBe(true);
    
    const gitCommonDir = join(repoDir, ".git");
    const repoDbPath = join(gitCommonDir, "spider", "repo.db");
    
    // Check FTS count after first run
    const repoDb1 = openDbAt(repoDbPath, "repo");
    const memoryCount = (repoDb1.prepare("SELECT COUNT(*) as n FROM memory").get() as { n: number }).n;
    const ftsCount1 = (repoDb1.prepare("SELECT COUNT(*) as n FROM memory_fts").get() as { n: number }).n;
    repoDb1.close();
    
    expect(memoryCount).toBe(3);
    expect(ftsCount1).toBe(3);
    
    // Run migration AGAIN
    const result2 = controlMigrate({ apply: true, cwd: repoDir });
    
    // Check FTS count after second run
    const repoDb2 = openDbAt(repoDbPath, "repo");
    const ftsCount2 = (repoDb2.prepare("SELECT COUNT(*) as n FROM memory_fts").get() as { n: number }).n;
    repoDb2.close();
    
    // MUST NOT duplicate - should still be 3
    expect(ftsCount2).toBe(3);
  });
  
  it("migrating multiple worktrees must not duplicate memory_fts rows in shared repo.db", () => {
    // Create repo with two worktrees
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
    
    // Create old-style DBs with DIFFERENT memories in each worktree
    for (const [wt, uuid] of [[wt1, "mem-wt1"], [wt2, "mem-wt2"]]) {
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
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY);
      `);
      
      const now = Date.now();
      db.prepare(`INSERT INTO memory (uuid, category, content, created_at, updated_at) 
                  VALUES (?, ?, ?, ?, ?)`).run(uuid, "convention", `from ${wt}`, now, now);
      
      db.close();
    }
    
    // Migrate from wt1 - with I2 fix this processes BOTH worktrees
    const result = controlMigrate({ apply: true, cwd: wt1 });
    expect(result.applied).toBe(true);
    
    const gitCommonDir = join(repoDir, ".git");
    const repoDbPath = join(gitCommonDir, "spider", "repo.db");
    
    // Check FTS count
    const repoDb = openDbAt(repoDbPath, "repo");
    const memoryCount = (repoDb.prepare("SELECT COUNT(*) as n FROM memory").get() as { n: number }).n;
    const ftsCount = (repoDb.prepare("SELECT COUNT(*) as n FROM memory_fts").get() as { n: number }).n;
    repoDb.close();
    
    // Should have 2 memories and 2 FTS rows, not duplicates
    expect(memoryCount).toBe(2);
    expect(ftsCount).toBe(2);
  });
  
  it("isAlreadyMigrated must be row-count-based, not table-existence-based", () => {
    // Create repo with empty repo-tier tables (like PROJECT_MIGRATIONS[3] creates)
    const repoDir = join(scratch, "repo");
    mkdirSync(repoDir, { recursive: true });
    
    execFileSync("git", ["init"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# Test\n");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });
    
    const spiderDir = join(repoDir, ".spider");
    mkdirSync(spiderDir, { recursive: true });
    const db = openDbAt(join(spiderDir, "project.db"), "worktree");
    
    // Old DB with EMPTY skills/curator_state (just like PROJECT_MIGRATIONS[3] creates)
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
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY);
    `);
    
    const now = Date.now();
    db.prepare(`INSERT INTO memory (uuid, category, content, created_at, updated_at) 
                VALUES (?, ?, ?, ?, ?)`).run("mem-1", "convention", "test", now, now);
    // skills and curator_state are EMPTY but EXIST
    
    db.close();
    
    // Run migration first time
    const result1 = controlMigrate({ apply: true, cwd: repoDir });
    expect(result1.applied).toBe(true);
    
    // Run migration AGAIN - with table-existence check it would re-enter
    // (because skills/curator_state tables exist), causing FTS duplication
    const result2 = controlMigrate({ apply: true, cwd: repoDir });
    
    // If isAlreadyMigrated is row-count-based, result2 should report no changes
    expect(result2.message).toContain("already migrated");
    
    // Verify FTS count didn't duplicate
    const gitCommonDir = join(repoDir, ".git");
    const repoDbPath = join(gitCommonDir, "spider", "repo.db");
    const repoDb = openDbAt(repoDbPath, "repo");
    const ftsCount = (repoDb.prepare("SELECT COUNT(*) as n FROM memory_fts").get() as { n: number }).n;
    repoDb.close();
    
    expect(ftsCount).toBe(1);
  });
});
