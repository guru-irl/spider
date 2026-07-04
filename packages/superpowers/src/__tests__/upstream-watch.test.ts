import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { paths, openGlobal, openProject, migrate, resolveProject, setGlobalDbPathForTests } from "@spider/db-core";
import { diffUpstream, runUpstreamWatch, seedUpstreamRefs, markReviewed, type GitRunner } from "../upstream-watch.js";

const realGit: GitRunner = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

function tempRepo(): { dir: string; commit: (msg: string) => string } {
  const dir = path.join(paths.scratch("project", process.cwd()), `uw-repo-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const run = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  run("init", "-q");
  run("symbolic-ref", "HEAD", "refs/heads/main");
  run("config", "user.email", "t@t"); run("config", "user.name", "t");
  return {
    dir,
    commit(msg: string) {
      fs.writeFileSync(path.join(dir, "f.txt"), msg);
      run("add", "."); run("commit", "-q", "-m", msg);
      return run("rev-parse", "HEAD").trim();
    },
  };
}

describe("diffUpstream", () => {
  it("first run (no last-reviewed) records head with zero candidates", () => {
    const r = tempRepo();
    const head = r.commit("initial");
    const res = diffUpstream({ package: "superpowers", upstreamRepo: "obra/superpowers" }, r.dir, realGit);
    expect(res.head).toBe(head);
    expect(res.candidates).toEqual([]);
  });

  it("surfaces one candidate per new upstream commit since last-reviewed", () => {
    const r = tempRepo();
    const base = r.commit("base");
    const c1 = r.commit("feat: one");
    const c2 = r.commit("fix: two");
    const res = diffUpstream({ package: "superpowers", upstreamRepo: "obra/superpowers", lastReviewedCommit: base }, r.dir, realGit);
    expect(res.head).toBe(c2);
    expect(res.candidates.map((c) => c.subject)).toEqual(["feat: one", "fix: two"]);
    expect(res.candidates.map((c) => c.commit)).toEqual([c1, c2]);
    expect(res.candidates.every((c) => c.package === "superpowers")).toBe(true);
  });
});

// Hermetic: point openGlobal() at a scratch DB so tests never touch the real
// ~/.pi/agent/spider/spider.db. Reset after.
const scratchGlobalDb = path.join(
  paths.scratch("project", process.cwd()),
  `uw-global-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
);
beforeAll(() => { setGlobalDbPathForTests(scratchGlobalDb); });
afterAll(() => { setGlobalDbPathForTests(null); });

function scratchProject(): { cwd: string; sessionId: string } {
  const cwd = path.join(paths.scratch("project", process.cwd()), `uw-proj-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(cwd, { recursive: true });
  return { cwd, sessionId: "s-uw" };
}

describe("runUpstreamWatch", () => {
  it("seeds refs, records candidates as todos, updates last_checked_at, and de-dupes on re-run", () => {
    const r = tempRepo();
    const base = r.commit("base");
    r.commit("feat: alpha");
    r.commit("fix: beta");

    const gdb = openGlobal();
    migrate(gdb, "global");
    seedUpstreamRefs(gdb);
    markReviewed(gdb, "superpowers", base);

    const { cwd, sessionId } = scratchProject();
    const info = resolveProject(cwd);
    const pdb = openProject(info.projectKey);
    migrate(pdb, "project");

    const deps = { git: realGit, localRepos: { superpowers: r.dir } };
    const rep1 = runUpstreamWatch(gdb, pdb, sessionId, deps);
    const sp = rep1.packages.find((p) => p.package === "superpowers")!;
    expect(sp.candidates.map((c) => c.subject)).toEqual(["feat: alpha", "fix: beta"]);
    expect(rep1.todosAdded).toBe(2);

    const todoCount = (): number =>
      (pdb.prepare("SELECT COUNT(*) AS c FROM todos WHERE text LIKE 'upstream-watch(superpowers):%'").get() as { c: number }).c;
    expect(todoCount()).toBe(2);

    // FTS was synced too (upstream-watch todos are searchable).
    const ftsCount = (pdb.prepare("SELECT COUNT(*) AS c FROM todos_fts WHERE text LIKE 'upstream-watch(superpowers):%'").get() as { c: number }).c;
    expect(ftsCount).toBe(2);

    const checked = (gdb.prepare("SELECT last_checked_at FROM upstream_refs WHERE package='superpowers'").get() as { last_checked_at: number }).last_checked_at;
    expect(checked).toBeGreaterThan(0);

    const rep2 = runUpstreamWatch(gdb, pdb, sessionId, deps);
    expect(rep2.todosAdded).toBe(0);
    expect(todoCount()).toBe(2);
  });
});

describe("runUpstreamWatch resilience", () => {
  it("records a package with a non-git localRepo as an error and never throws", () => {
    const gdb = openGlobal();
    migrate(gdb, "global");
    seedUpstreamRefs(gdb);
    markReviewed(gdb, "superpowers", "deadbeef");

    const notARepo = path.join(paths.scratch("project", process.cwd()), `uw-notgit-${process.pid}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(notARepo, { recursive: true });

    const { cwd, sessionId } = scratchProject();
    const info = resolveProject(cwd);
    const pdb = openProject(info.projectKey);
    migrate(pdb, "project");

    const rep = runUpstreamWatch(gdb, pdb, sessionId, { git: realGit, localRepos: { superpowers: notARepo } });
    const sp = rep.packages.find((p) => p.package === "superpowers")!;
    expect(sp.error).toBeTruthy();
    expect(sp.candidates).toEqual([]);
    expect(rep.todosAdded).toBe(0);
  });
});
