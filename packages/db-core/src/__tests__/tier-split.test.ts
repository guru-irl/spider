// packages/db-core/src/__tests__/tier-split.test.ts
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { join, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { openDb } from "../db";
import { migrate, SCHEMA_VERSION } from "../migrate";
import { scratchDbPath, cleanupScratch } from "../testutil";
import { resolveProject, openRepo, repoRoot, openProject, openGlobal, setGlobalDbPathForTests } from "../registry";

const opened: { close(): void }[] = [];
afterEach(() => { for (const d of opened) d.close(); opened.length = 0; cleanupScratch(); });

// Package-owned scratch (packages/db-core/.spider/scratch/tier-split-<pid>), NEVER the
// REAL global scratch (paths.scratch("global") === ~/.pi/agent/spider/scratch) the two
// tests below used to build their fixture trees under — without a global-DB override,
// resolveProject/registerProject then wrote real rows into the user's actual global
// registry (~/.pi/agent/spider/spider.db). Same layout convention as testutil.ts's
// PROC_SCRATCH, one dir level further to avoid colliding with scratchDbPath()'s own
// per-pid file namespace.
const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".spider", "scratch", `tier-split-${process.pid}`);

// Each test's own `finally` removes its `scratchDir` subtree, but the override-db
// files created directly under FIXTURE_ROOT (global-shared-repo.db, global-non-git.db)
// are siblings of that subtree, not inside it — remove the whole fixture root once,
// after every test in this file is done.
afterAll(() => {
  try { rmSync(FIXTURE_ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** True when `target` is `root` itself or nested anywhere underneath it. Path-aware so
 *  a shared string prefix can't spoof containment (mirrors host's fixture-safety.ts;
 *  kept local here since db-core doesn't depend on the host package). */
function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Verify the CURRENTLY live global DB (whatever setGlobalDbPathForTests override is
 *  active right now) actually resolved its on-disk file inside `root` — i.e. the
 *  override really took effect, rather than silently falling back to the real
 *  ~/.pi/agent/spider/spider.db. Reads the REAL database_list, never an assumption. */
function assertGlobalDbInside(root: string): void {
  const g = openGlobal();
  try {
    const rows = g.raw.pragma("database_list") as Array<{ name: string; file: string }>;
    const file = rows.find(r => r.name === "main")?.file;
    expect(file, "global db connection must be an on-disk main database").toBeTruthy();
    expect(isPathInside(root, file!), `global db file ${file} must live under the fixture root ${root}, not the real registry`).toBe(true);
  } finally {
    g.close();
  }
}

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
    // Controlled temporary global-DB override BEFORE any resolver runs
    // (resolveProject below both RESOLVES and REGISTERS into whatever global DB is
    // currently live) — this is the leak fix: previously this test used the REAL
    // global scratch dir with no override, so every run wrote real rows into the
    // user's actual ~/.pi/agent/spider/spider.db. Reset in `finally` below.
    setGlobalDbPathForTests(join(FIXTURE_ROOT, "global-shared-repo.db"));
    const scratchDir = join(FIXTURE_ROOT, "tier-split-shared-repo");
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

      // Linked worktrees of this FAKE repo must share only the FAKE repo tier: repoKey
      // must resolve inside this test's own disposable fixture, never the monorepo's
      // actual .git (this file's own package sits inside a real git checkout).
      expect(isPathInside(scratchDir, proj1.repoKey!)).toBe(true);

      // Verify the override above actually took effect — the ACTUAL on-disk file
      // openGlobal() opened, not just the override variable — before any more writes.
      assertGlobalDbInside(FIXTURE_ROOT);
      
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
      setGlobalDbPathForTests(null);
    }
  });
});

describe("tier split — non-git fallback", () => {
  // Mutation: make non-git directories throw → this test fails
  it("non-git directory falls back to worktree tier without error", () => {
    const scratchDir = join(FIXTURE_ROOT, "tier-split-non-git");
    if (existsSync(scratchDir)) rmSync(scratchDir, { recursive: true, force: true });
    mkdirSync(scratchDir, { recursive: true });

    // Controlled temporary global-DB override BEFORE resolveProject — same leak this
    // fixture previously had via the real global scratch dir with no override.
    setGlobalDbPathForTests(join(FIXTURE_ROOT, "global-non-git.db"));

    // This fixture now lives under packages/db-core/.spider/scratch/ — itself nested
    // inside THIS repo's own git checkout. Without a ceiling, `git rev-parse
    // --show-toplevel` from scratchDir would climb straight past it and find the
    // monorepo's real .git, silently turning this NON-GIT test into a git fixture
    // (repoKey would then be defined, contradicting the assertions below). Scope the
    // ceiling to this fixture's own parent and restore it unconditionally after,
    // exactly like registry.test.ts's "keys a non-git dir" test does.
    const prevCeiling = process.env.GIT_CEILING_DIRECTORIES;
    try {
      process.env.GIT_CEILING_DIRECTORIES = dirname(scratchDir);

      // resolveProject should not throw
      const proj = resolveProject(scratchDir);
      expect(proj.projectKey).toBeTruthy();
      expect(proj.repoKey).toBeUndefined(); // No git repo, so no repo key
      
      // repoRoot should return undefined for non-git directories
      const rr = repoRoot(scratchDir);
      expect(rr).toBeUndefined();

      // Verify the override above actually took effect (registerProject, called
      // inside resolveProject, must not have fallen back to the real registry).
      assertGlobalDbInside(FIXTURE_ROOT);
    } finally {
      if (prevCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = prevCeiling;
      setGlobalDbPathForTests(null);
      if (existsSync(scratchDir)) rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
