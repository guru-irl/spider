// packages/db-core/src/__tests__/registry.test.ts
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveProject, registerProject, openGlobal, openProject, openDbAt, openProjectByPath, setGlobalDbPathForTests } from "../registry.js";
import { scratchDbPath, cleanupScratch } from "../testutil.js";

beforeEach(() => setGlobalDbPathForTests(scratchDbPath("global-registry")));
afterEach(() => { setGlobalDbPathForTests(null); cleanupScratch(); });

describe("projects registry", () => {
  it("keys a git repo on git-common-dir and upserts the registry", () => {
    const repo = join(scratchDbPath("repo").replace(/\.db$/, ""), "wt");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const info = resolveProject(repo);
    expect(info.gitCommonDir).toBeTruthy();
    expect(info.projectKey).toBe(info.gitCommonDir);
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
    const db = openDbAt(scratchDbPath("explicit"), "project");
    const t = db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory'").get();
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
});
