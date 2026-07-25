// packages/db-core/src/__tests__/tier-split.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { openDb } from "../db";
import { migrate, SCHEMA_VERSION } from "../migrate";
import { scratchDbPath, cleanupScratch } from "../testutil";
import { paths } from "../paths";
import { resolveProject, openRepo, repoRoot, openProject } from "../registry";

const opened: { close(): void }[] = [];
afterEach(() => { for (const d of opened) d.close(); opened.length = 0; cleanupScratch(); });

function tables(db: { prepare(sql: string): { all(): unknown[] } }): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name").all() as { name: string }[]).map(r => r.name);
}

function tableColumns(db: { raw: { prepare(sql: string): { all(): unknown[] } } }, tableName: string): string[] {
  return (db.raw.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[]).map((c) => c.name);
}

describe("tier split — repo tier", () => {
  // Mutation: move memory to WORKTREE_SCHEMA → this test fails
  it("fresh repo db contains EXACTLY repo-tier tables (memory, memory_fts, skills, curator_state, vector_map, embed_queue)", () => {
    const db = openDb(scratchDbPath("repo-fresh")); opened.push(db);
    migrate(db, "repo");
    const t = tables(db);
    
    // Must have repo-tier tables
    expect(t).toContain("memory");
    expect(t).toContain("memory_fts");
    expect(t).toContain("skills");
    expect(t).toContain("curator_state");
    expect(t).toContain("vector_map");
    expect(t).toContain("embed_queue");
    
    // Must NOT have worktree-tier tables
    expect(t).not.toContain("sessions");
    expect(t).not.toContain("runs");
    expect(t).not.toContain("run_events");
    expect(t).not.toContain("events");
    expect(t).not.toContain("content");
    expect(t).not.toContain("todos");
    
    // Must NOT have global-tier tables
    expect(t).not.toContain("projects");
    expect(t).not.toContain("global_memory");
    expect(t).not.toContain("upstream_refs");
    expect(t).not.toContain("message_mirror");
    expect(t).not.toContain("insights");
    expect(t).not.toContain("model_stats");
    
    expect(Number(db.pragma("user_version"))).toBe(SCHEMA_VERSION);
  });
});

describe("tier split — worktree tier", () => {
  // Mutation: move sessions to REPO_SCHEMA → this test fails
  it("fresh worktree db contains EXACTLY worktree-tier tables (sessions, content, todos, runs, run_events, events, vector_map, embed_queue)", () => {
    const db = openDb(scratchDbPath("worktree-fresh")); opened.push(db);
    migrate(db, "worktree");
    const t = tables(db);
    
    // Must have worktree-tier tables
    expect(t).toContain("sessions");
    expect(t).toContain("content");
    expect(t).toContain("todos");
    expect(t).toContain("runs");
    expect(t).toContain("run_events");
    expect(t).toContain("events");
    expect(t).toContain("vector_map");
    expect(t).toContain("embed_queue");
    
    // Must NOT have repo-tier tables
    expect(t).not.toContain("memory");
    expect(t).not.toContain("memory_fts");
    expect(t).not.toContain("skills");
    expect(t).not.toContain("curator_state");
    
    // Must NOT have global-tier tables
    expect(t).not.toContain("projects");
    expect(t).not.toContain("global_memory");
    
    expect(Number(db.pragma("user_version"))).toBe(SCHEMA_VERSION);
  });
  
  // Mutation: map "project" to repo → this test fails
  it("deprecated 'project' alias opens a WORKTREE db", () => {
    const db = openDb(scratchDbPath("project-alias")); opened.push(db);
    migrate(db, "project");
    const t = tables(db);
    
    // Should have worktree tables (sessions, runs, etc)
    expect(t).toContain("sessions");
    expect(t).toContain("runs");
    
    // Should NOT have repo-only tables
    expect(t).not.toContain("memory");
  });
});

describe("tier split — fresh vs migrated parity", () => {
  // Mutation: add a column only to fresh schema, not migration → parity test fails
  it("fresh repo db has same memory columns as migrated v6 repo db", () => {
    const fresh = openDb(scratchDbPath("repo-fresh-parity")); opened.push(fresh);
    migrate(fresh, "repo");
    const freshCols = tableColumns(fresh, "memory").sort();
    
    const migrated = openDb(scratchDbPath("repo-migrated-parity")); opened.push(migrated);
    // Simulate v6 project schema with memory table
    migrated.exec(`CREATE TABLE memory (
      id INTEGER PRIMARY KEY, uuid TEXT UNIQUE NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL, link TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      source TEXT NOT NULL DEFAULT 'user',
      confidence REAL, session_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER
    )`);
    migrated.exec(`CREATE VIRTUAL TABLE memory_fts USING fts5(uuid UNINDEXED, category, content, link)`);
    migrated.raw.pragma("user_version = 6");
    migrate(migrated, "repo");
    const migratedCols = tableColumns(migrated, "memory").sort();
    
    expect(freshCols).toEqual(migratedCols);
  });
  
  it("fresh worktree db has same runs columns as migrated v6 worktree db", () => {
    const fresh = openDb(scratchDbPath("worktree-fresh-parity")); opened.push(fresh);
    migrate(fresh, "worktree");
    const freshCols = tableColumns(fresh, "runs").sort();
    
    const migrated = openDb(scratchDbPath("worktree-migrated-parity")); opened.push(migrated);
    // Simulate v6 project schema with runs table
    migrated.exec(`CREATE TABLE runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent_run_id TEXT,
      agent TEXT NOT NULL, role TEXT, name TEXT,
      status TEXT NOT NULL,
      phase TEXT, model TEXT, task TEXT, thinking TEXT,
      started_at INTEGER, ended_at INTEGER,
      step_count INTEGER DEFAULT 0, token_count INTEGER DEFAULT 0,
      result TEXT,
      pid INTEGER, host_pid INTEGER
    )`);
    migrated.raw.pragma("user_version = 6");
    migrate(migrated, "worktree");
    const migratedCols = tableColumns(migrated, "runs").sort();
    
    expect(freshCols).toEqual(migratedCols);
  });
});

describe("tier split — shared repo memory", () => {
  // Mutation: point repo-tier opener at worktree DB → this test fails
  it("two worktrees of the SAME repo SHARE repo-tier memory and do NOT share worktree-tier sessions/runs", () => {
    const scratchDir = join(paths.scratch("global"), "tier-split-shared-repo");
    if (existsSync(scratchDir)) rmSync(scratchDir, { recursive: true, force: true });
    mkdirSync(scratchDir, { recursive: true });
    
    // Create a real git repo
    const repoDir = join(scratchDir, "test-repo");
    mkdirSync(repoDir);
    execFileSync("git", ["init"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# Test");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "Initial"], { cwd: repoDir });
    
    // Create two worktrees
    const wt1 = join(scratchDir, "wt1");
    const wt2 = join(scratchDir, "wt2");
    execFileSync("git", ["worktree", "add", wt1, "-b", "branch1"], { cwd: repoDir });
    execFileSync("git", ["worktree", "add", wt2, "-b", "branch2"], { cwd: repoDir });
    
    try {
      // Open both worktrees' DBs via the registry
      const proj1 = resolveProject(wt1);
      const proj2 = resolveProject(wt2);
      
      // Both should have the same repo_key (git common dir)
      expect(proj1.repoKey).toBeTruthy();
      expect(proj1.repoKey).toBe(proj2.repoKey);
      
      // But different project_key (worktree roots)
      expect(proj1.projectKey).not.toBe(proj2.projectKey);
      
      // Open repo and worktree DBs for wt1
      const repo1 = openRepo(proj1.repoKey!); opened.push(repo1);
      const worktree1 = openProject(proj1.projectKey); opened.push(worktree1);
      
      // Open repo and worktree DBs for wt2 (should be SAME repo, different worktree)
      const repo2 = openRepo(proj2.repoKey!); opened.push(repo2);
      const worktree2 = openProject(proj2.projectKey); opened.push(worktree2);
      
      // Write memory to repo (via wt1's repo db)
      repo1.prepare("INSERT INTO memory (uuid, category, content, created_at) VALUES (?, ?, ?, ?)").run(
        "repo-mem-uuid", "convention", "shared repo memory", Date.now()
      );
      
      // Write session to wt1
      worktree1.prepare("INSERT INTO sessions (id, started_at) VALUES (?, ?)").run("wt1-session", Date.now());
      
      // Write session to wt2
      worktree2.prepare("INSERT INTO sessions (id, started_at) VALUES (?, ?)").run("wt2-session", Date.now());
      
      // SHARED repo-tier memory: both repo DBs should see the same memory
      const mem1 = repo1.prepare("SELECT content FROM memory WHERE uuid = ?").get("repo-mem-uuid") as { content: string } | undefined;
      const mem2 = repo2.prepare("SELECT content FROM memory WHERE uuid = ?").get("repo-mem-uuid") as { content: string } | undefined;
      expect(mem1?.content).toBe("shared repo memory");
      expect(mem2?.content).toBe("shared repo memory");
      
      // ISOLATED worktree-tier sessions: wt1 should NOT see wt2's session
      const wt1Sessions = (worktree1.prepare("SELECT id FROM sessions").all() as { id: string }[]).map(r => r.id);
      expect(wt1Sessions).toContain("wt1-session");
      expect(wt1Sessions).not.toContain("wt2-session");
      
      const wt2Sessions = (worktree2.prepare("SELECT id FROM sessions").all() as { id: string }[]).map(r => r.id);
      expect(wt2Sessions).toContain("wt2-session");
      expect(wt2Sessions).not.toContain("wt1-session");
    } finally {
      // Clean up worktrees
      try {
        execFileSync("git", ["worktree", "remove", wt1, "--force"], { cwd: repoDir });
      } catch {}
      try {
        execFileSync("git", ["worktree", "remove", wt2, "--force"], { cwd: repoDir });
      } catch {}
      if (existsSync(scratchDir)) rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});

describe("tier split — non-git fallback", () => {
  // Mutation: make non-git directories throw → this test fails
  it("non-git directory falls back to worktree tier without error", () => {
    const scratchDir = join(paths.scratch("global"), "tier-split-non-git");
    if (existsSync(scratchDir)) rmSync(scratchDir, { recursive: true, force: true });
    mkdirSync(scratchDir, { recursive: true });
    
    try {
      // resolveProject should not throw
      const proj = resolveProject(scratchDir);
      expect(proj.projectKey).toBeTruthy();
      expect(proj.repoKey).toBeUndefined(); // No git repo, so no repo key
      
      // repoRoot should return undefined for non-git directories
      const rr = repoRoot(scratchDir);
      expect(rr).toBeUndefined();
    } finally {
      if (existsSync(scratchDir)) rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
