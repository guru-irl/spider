// packages/host/src/__tests__/migrate-critical-ambiguous-loss.test.ts
// CRITICAL 2: Ambiguous rows are destroyed from source
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { openDbAt } from "@spider/db-core";
import { setGlobalDbPathForTests } from "@spider/db-core";
import { controlMigrate } from "../control/migrate-cmd";
import DatabaseConstructor from "better-sqlite3";

const scratch = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".spider", "scratch", `ambiguous-${process.pid}`);

beforeEach(() => {
  mkdirSync(scratch, { recursive: true });
  setGlobalDbPathForTests(join(scratch, `g-${Date.now()}.db`));
});

afterEach(() => {
  setGlobalDbPathForTests(null);
  rmSync(scratch, { recursive: true, force: true });
});

describe("CRITICAL 2: Ambiguous row destruction", () => {
  // MIXED fixture: wt2 has one row that COPIES cleanly and one that CONFLICTS.
  // This matters because the source-delete block is gated on `moved[table] > 0`.
  // The all-conflict fixture below leaves moved === 0, so the per-row delete loop
  // never executes and its correctness is never exercised — a wholesale
  // `DELETE FROM <table>` there passes that test. This case forces the loop to run
  // with a conflict present.
  // Mutation it catches: replace the per-row
  //   `DELETE FROM ${table} WHERE ${keyCol} = ?`
  // with `DELETE FROM ${table}` → the conflicting row is destroyed → this fails.
  it("deletes only copied rows, preserving conflicts, when the same table has both", () => {
    const repoDir = join(scratch, "mixed-repo");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# Test\n");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });

    const wtA = join(scratch, "mixed-wtA");
    const wtB = join(scratch, "mixed-wtB");
    execFileSync("git", ["worktree", "add", wtA, "-b", "mixed-a"], { cwd: repoDir });
    execFileSync("git", ["worktree", "add", wtB, "-b", "mixed-b"], { cwd: repoDir });

    const seed = (wt: string, rows: Array<[string, string]>) => {
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
      for (const [uuid, content] of rows) {
        db.prepare(
          `INSERT INTO memory (uuid, category, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
        ).run(uuid, "convention", content, now, now);
      }
      db.close();
    };

    // A migrates first and wins "shared". B brings "shared" (conflict) + "b-only" (copies).
    seed(wtA, [["shared", "from A"]]);
    seed(wtB, [["shared", "from B"], ["b-only", "unique to B"]]);

    const result = controlMigrate({ apply: true, cwd: wtA });
    expect(result.applied).toBe(true);

    const conflict = result.ambiguous!.find((a) => a.table === "memory" && a.uuid === "shared");
    expect(conflict).toBeDefined();

    const bDb = new DatabaseConstructor(join(wtB, ".spider", "project.db"));
    const rows = bDb.prepare("SELECT uuid, content FROM memory ORDER BY uuid").all() as any[];
    bDb.close();

    const byUuid = new Map(rows.map((r) => [r.uuid, r.content]));
    // The conflicting row was NOT copied, so it must survive in the source.
    expect(byUuid.get("shared")).toBe("from B");
    // The cleanly-copied row was moved, so it must be gone from the source.
    expect(byUuid.has("b-only")).toBe(false);
  });

  it("conflicting source rows must NOT be deleted", () => {
    // Create repo with two worktrees that have conflicting memories
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
    
    // Create old-style DBs with SAME uuid (conflict)
    for (const [wt, content] of [[wt1, "content from wt1"], [wt2, "content from wt2"]]) {
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
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY);
      `);
      
      const now = Date.now();
      // Same UUID in both worktrees - this will conflict
      db.prepare(`INSERT INTO memory (uuid, category, content, created_at, updated_at) 
                  VALUES (?, ?, ?, ?, ?)`).run("conflict-uuid", "convention", content, now, now);
      // Also same skill name
      db.prepare(`INSERT INTO skills (name, category, path, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?)`).run("conflict-skill", "test", `/path/${wt}`, now, now);
      
      db.close();
    }
    
    // Migrate - wt1's data will be copied first, wt2's will conflict
    const result = controlMigrate({ apply: true, cwd: wt1 });
    expect(result.applied).toBe(true);
    expect(result.ambiguous).toBeDefined();
    expect(result.ambiguous!.length).toBeGreaterThan(0);
    
    // The conflicting rows from wt2 should be reported as ambiguous
    const memConflict = result.ambiguous!.find(a => a.table === "memory" && a.uuid === "conflict-uuid");
    const skillConflict = result.ambiguous!.find(a => a.table === "skills" && a.uuid === "conflict-skill");
    expect(memConflict).toBeDefined();
    expect(skillConflict).toBeDefined();
    
    // CRITICAL: The conflicting source row from wt2 must STILL EXIST after migration
    const wt2DbPath = join(wt2, ".spider", "project.db");
    const wt2Db = new DatabaseConstructor(wt2DbPath);
    
    const memRow = wt2Db.prepare("SELECT * FROM memory WHERE uuid = ?").get("conflict-uuid");
    expect(memRow).toBeDefined();
    expect((memRow as any).content).toBe("content from wt2");
    
    const skillRow = wt2Db.prepare("SELECT * FROM skills WHERE name = ?").get("conflict-skill");
    expect(skillRow).toBeDefined();
    
    wt2Db.close();
  });
  
  it("moved counts must reflect only rows actually copied, not skipped conflicts", () => {
    // Create repo with conflicting data
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
    
    // wt1: 2 unique memories
    // wt2: 1 conflicting memory + 1 unique memory
    for (const [wt, mems] of [[wt1, ["mem-1", "mem-2"]], [wt2, ["mem-1", "mem-3"]]] as const) {
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
      for (const uuid of mems) {
        db.prepare(`INSERT INTO memory (uuid, category, content, created_at, updated_at) 
                    VALUES (?, ?, ?, ?, ?)`).run(uuid, "convention", `${wt}-${uuid}`, now, now);
      }
      
      db.close();
    }
    
    // Migrate
    const result = controlMigrate({ apply: true, cwd: wt1 });
    expect(result.applied).toBe(true);
    
    // Should report 3 memories moved (mem-1 and mem-2 from wt1, mem-3 from wt2)
    // NOT 4 (which would include the conflicting mem-1 from wt2)
    expect(result.moved?.memory).toBe(3);
    
    // Should have 1 ambiguous
    expect(result.ambiguous?.length).toBe(1);
    expect(result.ambiguous![0].uuid).toBe("mem-1");
  });
});
