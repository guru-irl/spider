// packages/db-core/src/__tests__/registry.test.ts
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveProject, registerProject, openGlobal, openProject, openDbAt, openProjectByPath, setGlobalDbPathForTests } from "../registry";
import { scratchDbPath, cleanupScratch } from "../testutil";

beforeEach(() => setGlobalDbPathForTests(scratchDbPath("global-registry")));
afterEach(() => { setGlobalDbPathForTests(null); cleanupScratch(); });

describe("projects registry", () => {
  it("keys a git repo on worktree root and upserts the registry", () => {
    const repo = join(scratchDbPath("repo").replace(/\.db$/, ""), "wt");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const info = resolveProject(repo);
    expect(info.gitCommonDir).toBeTruthy();
    expect(info.projectKey).toBe(info.realPath); // Now keys on worktree root, not git common dir
    expect(info.repoKey).toBe(info.gitCommonDir); // But repo_key stores the git common dir
    expect(info.dbPath).toMatch(/\.spider[/\\]project\.db$/);

    const g = openGlobal();
    const row = g.prepare("SELECT project_key, db_path FROM projects WHERE project_key = ?").get(info.projectKey);
    g.close();
    expect(row).toBeTruthy();
  });

  it("keys a non-git dir on its real path", () => {
    const dir = join(scratchDbPath("plain").replace(/\.db$/, ""), "plain");
    mkdirSync(dir, { recursive: true });
    const prev = process.env.GIT_CEILING_DIRECTORIES;
    try {
      process.env.GIT_CEILING_DIRECTORIES = join(dir, "..");
      const info = resolveProject(dir);
      expect(info.gitCommonDir).toBeUndefined();
      expect(info.projectKey).toBe(info.realPath);
    } finally {
      if (prev === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = prev;
    }
  });

  it("openProject resolves the registered db_path and migrates it", () => {
    const dir = join(scratchDbPath("open").replace(/\.db$/, ""), "p");
    mkdirSync(dir, { recursive: true });
    const info = resolveProject(dir);
    const db = openProject(info.projectKey);
    const t = db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory'").get();
    db.close();
    expect(t).toBeTruthy();
  });

  it("openDbAt opens + migrates a DB at an explicit path (A3)", () => {
    const db = openDbAt(scratchDbPath("explicit"), "worktree");
    const t = db.prepare("SELECT name FROM sqlite_master WHERE name = 'sessions'").get();
    db.close();
    expect(t).toBeTruthy();
  });

  it("openProjectByPath opens the project DB for a real path (A3)", () => {
    const dir = join(scratchDbPath("bypath").replace(/\.db$/, ""), "p");
    mkdirSync(dir, { recursive: true });
    const db = openProjectByPath(dir);
    const t = db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory'").get();
    db.close();
    expect(t).toBeTruthy();
  });

  // Mutation: restore `const projectKey = gcd ?? realPath;` → this test MUST fail.
  it("registering worktree A then B of same repo yields TWO rows, openProject(A) returns A's DB", () => {
    const base = join(scratchDbPath("wt-collision").replace(/\.db$/, ""), "main");
    mkdirSync(base, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: base });
    execFileSync("git", ["config", "user.name", "test"], { cwd: base });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: base });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: base });

    const wtB = join(base, "..", "wt-b");
    execFileSync("git", ["worktree", "add", wtB], { cwd: base });

    try {
      const infoA = resolveProject(base);
      const infoB = resolveProject(wtB);

      // Both worktrees of the same repo must have DISTINCT project keys
      expect(infoA.projectKey).not.toBe(infoB.projectKey);
      expect(infoA.dbPath).not.toBe(infoB.dbPath);

      // Registry must contain TWO rows, not one
      const g = openGlobal();
      const rows = g.prepare("SELECT project_key, db_path FROM projects ORDER BY project_key").all() as
        Array<{ project_key: string; db_path: string }>;
      g.close();
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const keysForThisRepo = rows.filter(r => r.project_key === infoA.projectKey || r.project_key === infoB.projectKey);
      expect(keysForThisRepo).toHaveLength(2);

      // Opening A's project by key must still return A's DB, not B's
      // Verify by writing a marker to A, then confirming B doesn't see it
      const dbA = openProject(infoA.projectKey);
      dbA.prepare("INSERT INTO sessions (id, started_at) VALUES (?, ?)").run("test-a", Date.now());
      dbA.close();

      const dbB = openProject(infoB.projectKey);
      const sessionInB = dbB.prepare("SELECT id FROM sessions WHERE id = ?").get("test-a");
      dbB.close();
      expect(sessionInB).toBeUndefined(); // B must not see A's session
    } finally {
      // Cleanup: remove worktree B and its directory
      try {
        execFileSync("git", ["worktree", "remove", "--force", wtB], { cwd: base });
      } catch { /* best effort */ }
    }
  });

  // Mutation: merge worktrees from different repos → this test fails.
  it("two distinct repos get distinct project keys (no over-merging)", () => {
    const repoA = join(scratchDbPath("repo-a").replace(/\.db$/, ""), "a");
    const repoB = join(scratchDbPath("repo-b").replace(/\.db$/, ""), "b");
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repoA });
    execFileSync("git", ["init", "-q"], { cwd: repoB });

    const infoA = resolveProject(repoA);
    const infoB = resolveProject(repoB);

    expect(infoA.projectKey).not.toBe(infoB.projectKey);
    expect(infoA.gitCommonDir).not.toBe(infoB.gitCommonDir);

    const g = openGlobal();
    const countA = (g.prepare("SELECT COUNT(*) as c FROM projects WHERE project_key = ?").get(infoA.projectKey) as { c: number }).c;
    const countB = (g.prepare("SELECT COUNT(*) as c FROM projects WHERE project_key = ?").get(infoB.projectKey) as { c: number }).c;
    g.close();

    expect(countA).toBe(1);
    expect(countB).toBe(1);
  });

  // Mutation: throw when not in a git repo → this test fails.
  it("a non-git directory resolves and registers (fallback path intact)", () => {
    const dir = join(scratchDbPath("no-git").replace(/\.db$/, ""), "plain");
    mkdirSync(dir, { recursive: true });
    const prev = process.env.GIT_CEILING_DIRECTORIES;
    try {
      process.env.GIT_CEILING_DIRECTORIES = join(dir, "..");
      expect(() => resolveProject(dir)).not.toThrow();
      const info = resolveProject(dir);
      expect(info.gitCommonDir).toBeUndefined();
      expect(info.repoKey).toBeUndefined();
      expect(info.projectKey).toBe(info.realPath);

      const g = openGlobal();
      const row = g.prepare("SELECT project_key FROM projects WHERE project_key = ?").get(info.projectKey);
      g.close();
      expect(row).toBeTruthy();
    } finally {
      if (prev === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = prev;
    }
  });

  // Mutation: duplicate rows on re-register → this test fails.
  it("re-registering the same worktree updates last_seen_at but does not duplicate rows", async () => {
    const dir = join(scratchDbPath("rere").replace(/\.db$/, ""), "wt");
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });

    const info1 = resolveProject(dir);
    const g1 = openGlobal();
    const row1 = g1.prepare("SELECT last_seen_at FROM projects WHERE project_key = ?").get(info1.projectKey) as { last_seen_at: number };
    g1.close();

    // Wait a moment to ensure timestamp changes
    await new Promise((res) => setTimeout(res, 10));

    const info2 = resolveProject(dir);
    expect(info2.projectKey).toBe(info1.projectKey);

    const g2 = openGlobal();
    const row2 = g2.prepare("SELECT last_seen_at FROM projects WHERE project_key = ?").get(info2.projectKey) as { last_seen_at: number };
    const count = (g2.prepare("SELECT COUNT(*) as c FROM projects WHERE project_key = ?").get(info2.projectKey) as { c: number }).c;
    g2.close();

    expect(count).toBe(1); // Only one row, not duplicated
    expect(row2.last_seen_at).toBeGreaterThan(row1.last_seen_at);
  });

  // Mutation: repo_key not populated or differs → this test fails.
  it("repo_key is populated and identical for both worktrees of one repo", () => {
    const base = join(scratchDbPath("repo-key").replace(/\.db$/, ""), "main");
    mkdirSync(base, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: base });
    execFileSync("git", ["config", "user.name", "test"], { cwd: base });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: base });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: base });

    const wtB = join(base, "..", "wt-b2");
    execFileSync("git", ["worktree", "add", wtB], { cwd: base });

    try {
      const infoA = resolveProject(base);
      const infoB = resolveProject(wtB);

      expect(infoA.repoKey).toBeTruthy();
      expect(infoB.repoKey).toBeTruthy();
      expect(infoA.repoKey).toBe(infoB.repoKey);
      expect(infoA.repoKey).toBe(infoA.gitCommonDir);

      const g = openGlobal();
      const rowA = g.prepare("SELECT repo_key FROM projects WHERE project_key = ?").get(infoA.projectKey) as { repo_key: string };
      const rowB = g.prepare("SELECT repo_key FROM projects WHERE project_key = ?").get(infoB.projectKey) as { repo_key: string };
      g.close();

      expect(rowA.repo_key).toBe(rowB.repo_key);
      expect(rowA.repo_key).toBe(infoA.gitCommonDir);
    } finally {
      try {
        execFileSync("git", ["worktree", "remove", "--force", wtB], { cwd: base });
      } catch { /* best effort */ }
    }
  });
});
