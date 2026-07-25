// packages/host/src/__tests__/control-migrate.test.ts
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { openDbAt, paths } from "@spider/db-core";
import type { Db } from "@spider/db-core";
import { setGlobalDbPathForTests } from "@spider/db-core";
import { controlMigrate } from "../control/migrate-cmd";

const scratch = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".spider", "scratch", `migrate-${process.pid}`);

beforeEach(() => {
  mkdirSync(scratch, { recursive: true });
  setGlobalDbPathForTests(join(scratch, `g-${Date.now()}.db`));
});

afterEach(() => {
  setGlobalDbPathForTests(null);
  rmSync(scratch, { recursive: true, force: true });
});

/** Create a git repo with worktrees simulating the old collapsed layout */
function setupCollapsedRepo(): { repoDir: string; worktrees: string[] } {
  const repoDir = join(scratch, "repo");
  mkdirSync(repoDir, { recursive: true });
  
  // Init main repo
  execFileSync("git", ["init"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@test"], { cwd: repoDir });
  writeFileSync(join(repoDir, "README.md"), "# Test\n");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });
  
  // Create worktrees
  const wt1 = join(scratch, "wt1");
  const wt2 = join(scratch, "wt2");
  execFileSync("git", ["worktree", "add", wt1, "-b", "feat-a"], { cwd: repoDir });
  execFileSync("git", ["worktree", "add", wt2, "-b", "feat-b"], { cwd: repoDir });
  
  // Create old-style DBs that would have collapsed (both pointing to .git common dir as project_key)
  const gitCommonDir = join(repoDir, ".git");
  
  // Create worktree DBs with data
  for (const wt of [wt1, wt2]) {
    const spiderDir = join(wt, ".spider");
    mkdirSync(spiderDir, { recursive: true });
    const db = openDbAt(join(spiderDir, "project.db"));
    
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
      
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, parent_session_id TEXT, name TEXT, reason TEXT,
        started_at INTEGER NOT NULL, ended_at INTEGER,
        summary TEXT, imported_from TEXT
      );
      
      CREATE TABLE IF NOT EXISTS content (
        id INTEGER PRIMARY KEY, source TEXT NOT NULL, path TEXT, hash TEXT,
        heading TEXT, chunk TEXT NOT NULL, is_code INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
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
      
      CREATE TABLE IF NOT EXISTS todos (
        id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
        text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER
      );
      
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent_run_id TEXT,
        agent TEXT NOT NULL, role TEXT, name TEXT,
        status TEXT NOT NULL, phase TEXT, model TEXT, task TEXT, thinking TEXT,
        started_at INTEGER, ended_at INTEGER,
        step_count INTEGER DEFAULT 0, token_count INTEGER DEFAULT 0,
        result TEXT, pid INTEGER, host_pid INTEGER
      );
    `);
    
    const now = Date.now();
    const wtName = wt === wt1 ? "wt1" : "wt2";
    
    // Insert repo-tier data (memory, skills, curator_state)
    db.prepare(`INSERT INTO memory (uuid, category, content, created_at, updated_at) 
                VALUES (?, ?, ?, ?, ?)`).run(
      `mem-${wtName}`, "convention", `memory from ${wtName}`, now, now
    );
    
    db.prepare(`INSERT INTO skills (name, category, path, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)`).run(
      `skill-${wtName}`, "test", `/path/to/${wtName}`, now, now
    );
    
    db.prepare(`INSERT INTO curator_state (scope, last_run_at) VALUES (?, ?)`).run(
      wtName, now
    );
    
    // Insert worktree-tier data (sessions, content, todos, runs)
    db.prepare(`INSERT INTO sessions (id, name, started_at) VALUES (?, ?, ?)`).run(
      `sess-${wtName}`, `Session in ${wtName}`, now
    );
    
    db.prepare(`INSERT INTO content (source, chunk, created_at) VALUES (?, ?, ?)`).run(
      `source-${wtName}`, `content from ${wtName}`, now
    );
    
    db.prepare(`INSERT INTO todos (session_id, seq, text, created_at, updated_at) 
                VALUES (?, ?, ?, ?, ?)`).run(
      `sess-${wtName}`, 1, `todo in ${wtName}`, now, now
    );
    
    db.prepare(`INSERT INTO runs (id, session_id, agent, status, started_at) 
                VALUES (?, ?, ?, ?, ?)`).run(
      `run-${wtName}`, `sess-${wtName}`, "worker", "done", now
    );
    
    db.close();
  }
  
  return { repoDir, worktrees: [wt1, wt2] };
}

describe("control migrate", () => {
  it("dry-run mutates NOTHING - byte-identical DBs afterwards (mutation: make dry-run apply → must fail)", () => {
    const { worktrees } = setupCollapsedRepo();
    
    // Read DB file contents before
    const before = worktrees.map(wt => {
      const dbPath = join(wt, ".spider", "project.db");
      return { wt, content: readFileSync(dbPath) };
    });
    
    // Run dry-run
    const result = controlMigrate({ dryRun: true, cwd: worktrees[0] });
    
    // Verify DBs are byte-identical
    for (let i = 0; i < worktrees.length; i++) {
      const dbPath = join(worktrees[i], ".spider", "project.db");
      const after = readFileSync(dbPath);
      expect(after.equals(before[i].content)).toBe(true);
    }
    
    expect(result.dryRun).toBe(true);
  });
  
  it("apply creates backup BEFORE writing (mutation: skip backup → must fail)", () => {
    const { repoDir, worktrees } = setupCollapsedRepo();
    
    // Run apply
    const result = controlMigrate({ apply: true, cwd: worktrees[0] });
    
    // Verify backup was created
    expect(result.backupDir).toBeDefined();
    expect(existsSync(result.backupDir!)).toBe(true);
    
    // Verify backup contains the DB from the worktree we ran migrate from
    const wt1DbPath = join(worktrees[0], ".spider", "project.db");
    const backupName = wt1DbPath.replace(/\//g, "_").replace(/^_+/, "");
    const backupPath = join(result.backupDir!, backupName);
    expect(existsSync(backupPath)).toBe(true);
  });
  
  it("second apply is no-op - no duplicate rows (mutation: remove idempotency guard → must fail)", () => {
    const { worktrees } = setupCollapsedRepo();
    
    // First apply
    const result1 = controlMigrate({ apply: true, cwd: worktrees[0] });
    expect(result1.applied).toBe(true);
    
    // Count rows in repo DB after first apply
    const repoDir = join(scratch, "repo");
    const gitCommonDir = join(repoDir, ".git");
    const repoDb = openDbAt(join(gitCommonDir, "spider", "repo.db"));
    const memoryCount1 = (repoDb.prepare("SELECT count(*) as n FROM memory").get() as { n: number }).n;
    const skillsCount1 = (repoDb.prepare("SELECT count(*) as n FROM skills").get() as { n: number }).n;
    repoDb.close();
    
    // Second apply
    const result2 = controlMigrate({ apply: true, cwd: worktrees[0] });
    console.log("Second result:", JSON.stringify(result2, null, 2));
    
    // Count rows again - should be identical (no duplicates)
    const repoDb2 = openDbAt(join(gitCommonDir, "spider", "repo.db"));
    const memoryCount2 = (repoDb2.prepare("SELECT count(*) as n FROM memory").get() as { n: number }).n;
    const skillsCount2 = (repoDb2.prepare("SELECT count(*) as n FROM skills").get() as { n: number }).n;
    repoDb2.close();
    
    expect(memoryCount2).toBe(memoryCount1);
    expect(skillsCount2).toBe(skillsCount1);
    expect(result2.message).toMatch(/already migrated|no changes|up to date/i);
  });
  
  it("ambiguous rows REPORTED not dropped (mutation: drop them → must fail)", () => {
    const { repoDir, worktrees } = setupCollapsedRepo();
    
    // Add ambiguous data - same UUID in both worktrees (genuinely unclear which is canonical)
    const ambiguousUuid = "mem-ambiguous";
    for (const wt of worktrees) {
      const db = openDbAt(join(wt, ".spider", "project.db"));
      db.prepare(`INSERT INTO memory (uuid, category, content, created_at, updated_at) 
                  VALUES (?, ?, ?, ?, ?)`).run(
        ambiguousUuid, "convention", `different content in ${wt}`, Date.now(), Date.now()
      );
      db.close();
    }
    
    // Run migrate on wt1 - this will process ALL worktrees and detect conflicts
    const result1 = controlMigrate({ apply: true, cwd: worktrees[0] });
    expect(result1.applied).toBe(true);
    
    // Verify the ambiguous row is reported in the first call
    expect(result1.ambiguous).toBeDefined();
    expect(result1.ambiguous!.length).toBeGreaterThan(0);
    expect(result1.ambiguous!.some((a: { uuid: string }) => a.uuid === ambiguousUuid)).toBe(true);
    
    // Verify the row was NOT dropped - it should exist in the repo DB
    const gitCommonDir = join(repoDir, ".git");
    const repoDb = openDbAt(join(gitCommonDir, "spider", "repo.db"));
    const row = repoDb.prepare("SELECT * FROM memory WHERE uuid = ?").get(ambiguousUuid);
    expect(row).toBeDefined();
    repoDb.close();
  });
});
