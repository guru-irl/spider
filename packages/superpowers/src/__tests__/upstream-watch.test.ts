import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { openGlobal, openDbAt, migrate, setGlobalDbPathForTests } from "@spider/db-core";
import { diffUpstream, runUpstreamWatch, seedUpstreamRefs, markReviewed, type GitRunner } from "../upstream-watch.js";
import { testScratchPath } from "./testutil.js";

type TestGitOptions = Parameters<GitRunner>[2];

function execGit(
  repo: string,
  args: string[],
  options: TestGitOptions,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd: repo,
      encoding: "utf8",
      timeout: options.timeoutMs,
      env: { ...process.env, ...extraEnv, ...options.env },
    }, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stderr });
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

const realGit: GitRunner = (repo, args, options) => execGit(repo, args, options);

function tempRepo(): { dir: string; commit: (msg: string) => string; tag: (name: string) => void } {
  const dir = testScratchPath(`uw-repo-${process.pid}-${Math.random().toString(36).slice(2)}`);
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
    tag(name: string) {
      run("tag", "-a", name, "-m", name);
    },
  };
}

describe("diffUpstream", () => {
  it("first run (no last-reviewed) records head with zero candidates", async () => {
    const r = tempRepo();
    const head = r.commit("initial");
    const res = await diffUpstream({ package: "superpowers", upstreamRepo: "obra/superpowers" }, r.dir, realGit);
    expect(res.head).toBe(head);
    expect(res.candidates).toEqual([]);
  });

  it("surfaces one candidate per new upstream commit since last-reviewed", async () => {
    const r = tempRepo();
    const base = r.commit("base");
    const c1 = r.commit("feat: one");
    const c2 = r.commit("fix: two");
    const res = await diffUpstream({ package: "superpowers", upstreamRepo: "obra/superpowers", lastReviewedCommit: base }, r.dir, realGit);
    expect(res.head).toBe(c2);
    expect(res.candidates.map((c) => c.subject)).toEqual(["feat: one", "fix: two"]);
    expect(res.candidates.map((c) => c.commit)).toEqual([c1, c2]);
    expect(res.candidates.every((c) => c.package === "superpowers")).toBe(true);
  });
});

// Hermetic: point openGlobal() at a scratch DB so tests never touch the real
// ~/.pi/agent/spider/spider.db. Reset after.
const scratchGlobalDb = testScratchPath(`uw-global-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
beforeAll(() => { setGlobalDbPathForTests(scratchGlobalDb); });
afterAll(() => { setGlobalDbPathForTests(null); });

function scratchProject(): { cwd: string; sessionId: string } {
  const cwd = testScratchPath(`uw-proj-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(cwd, { recursive: true });
  return { cwd, sessionId: "s-uw" };
}

function configureUpstream(
  upstreamRepo: string,
  lastReviewedCommit: string | null,
  upstreamRef = "main",
): ReturnType<typeof openGlobal> {
  const gdb = openGlobal();
  migrate(gdb, "global");
  seedUpstreamRefs(gdb);
  gdb.prepare(
    `UPDATE upstream_refs
     SET upstream_repo=@repo, upstream_ref=@ref, last_reviewed_commit=@baseline,
         last_checked_at=0, notes=NULL
     WHERE package='superpowers'`,
  ).run({ repo: upstreamRepo, ref: upstreamRef, baseline: lastReviewedCommit });
  return gdb;
}

function watchProject(): { projectDb: ReturnType<typeof openDbAt>; sessionId: string } {
  const { cwd, sessionId } = scratchProject();
  const projectDb = openDbAt(path.join(cwd, "project.db"), "project");
  migrate(projectDb, "project");
  return { projectDb, sessionId };
}

function mirrorRoot(name: string): string {
  return testScratchPath(`uw-mirrors-${name}-${process.pid}-${Math.random().toString(36).slice(2)}`);
}

describe("real upstream resolution", () => {
  it("resolves upstream main in its mirror rather than the consumer repository main", async () => {
    const upstream = tempRepo();
    const baseline = upstream.commit("upstream baseline");
    const upstreamHead = upstream.commit("upstream head");
    const consumer = tempRepo();
    const consumerHead = consumer.commit("consumer main");
    const gdb = configureUpstream(upstream.dir, baseline);
    const { projectDb, sessionId } = watchProject();

    const report = await runUpstreamWatch(gdb, projectDb, sessionId, {
      git: realGit,
      // This reproduces the old host wiring: resolving `main` here returns the
      // consumer's own head. Correct code ignores it and resolves in the mirror.
      localRepos: { superpowers: consumer.dir },
      mirrorRoot: mirrorRoot("upstream-not-consumer"),
      packages: ["superpowers"],
    } as never);

    const result = report.packages[0];
    expect(result.head).toBe(upstreamHead);
    expect(result.head).not.toBe(consumerHead);
    expect(result.state).toBe("candidates");
    expect(result.candidates.map((candidate) => candidate.subject)).toEqual(["upstream head"]);
  });

  it("reports no-baseline with the exact command for establishing one", async () => {
    const upstream = tempRepo();
    upstream.commit("initial");
    const gdb = configureUpstream(upstream.dir, null);
    const { projectDb, sessionId } = watchProject();

    const report = await runUpstreamWatch(gdb, projectDb, sessionId, {
      git: realGit,
      mirrorRoot: mirrorRoot("no-baseline"),
      packages: ["superpowers"],
    } as never);

    const result = report.packages[0];
    expect(result.state).toBe("no-baseline");
    expect(result.reason).toContain("spider control upstream-watch --mark superpowers <ref>");
    expect(result.candidates).toEqual([]);
  });

  it("reports fetch-failed with a reason and does not throw", async () => {
    const missing = testScratchPath(`uw-missing-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const gdb = configureUpstream(missing, null);
    const { projectDb, sessionId } = watchProject();

    const report = await runUpstreamWatch(gdb, projectDb, sessionId, {
      git: realGit,
      mirrorRoot: mirrorRoot("fetch-failed"),
      packages: ["superpowers"],
    } as never);

    const result = report.packages[0];
    expect(result.state).toBe("fetch-failed");
    expect(result.reason).toBeTruthy();
    expect(result.candidates).toEqual([]);
  });

  it("resolves a mark tag to its full commit SHA before storing it", async () => {
    const upstream = tempRepo();
    const tagged = upstream.commit("release");
    upstream.tag("v1.0.0");
    const root = mirrorRoot("mark-tag");
    const gdb = configureUpstream(upstream.dir, null);
    const { projectDb, sessionId } = watchProject();
    await runUpstreamWatch(gdb, projectDb, sessionId, { git: realGit, mirrorRoot: root, packages: ["superpowers"] } as never);

    const resolved = await markReviewed(gdb, "superpowers", "v1.0.0", { git: realGit, mirrorRoot: root } as never);

    expect(resolved).toBe(tagged);
    const row = gdb.prepare("SELECT last_reviewed_commit FROM upstream_refs WHERE package='superpowers'").get() as { last_reviewed_commit: string };
    expect(row.last_reviewed_commit).toBe(tagged);
  });

  it("rejects an unknown mark ref without changing the baseline", async () => {
    const upstream = tempRepo();
    const head = upstream.commit("release");
    const root = mirrorRoot("mark-unknown");
    const gdb = configureUpstream(upstream.dir, head);
    const { projectDb, sessionId } = watchProject();
    await runUpstreamWatch(gdb, projectDb, sessionId, { git: realGit, mirrorRoot: root, packages: ["superpowers"] } as never);

    await expect(markReviewed(gdb, "superpowers", "not-a-ref", { git: realGit, mirrorRoot: root } as never)).rejects.toThrow(/not-a-ref/);
    const row = gdb.prepare("SELECT last_reviewed_commit FROM upstream_refs WHERE package='superpowers'").get() as { last_reviewed_commit: string };
    expect(row.last_reviewed_commit).toBe(head);
  });

  it("reports up-to-date only when a baseline exists and the range is empty", async () => {
    const upstream = tempRepo();
    const head = upstream.commit("release");
    const gdb = configureUpstream(upstream.dir, head);
    const { projectDb, sessionId } = watchProject();

    const report = await runUpstreamWatch(gdb, projectDb, sessionId, {
      git: realGit,
      mirrorRoot: mirrorRoot("up-to-date"),
      packages: ["superpowers"],
    } as never);

    expect(report.packages[0].state).toBe("up-to-date");
    expect(report.packages[0].head).toBe(head);
    expect(report.packages[0].candidates).toEqual([]);
  });
});

describe("seedUpstreamRefs", () => {
  it("repairs only todo's legacy main ref, preserves changed refs and remains idempotent", () => {
    const dbPath = testScratchPath(`uw-seed-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    const db = openDbAt(dbPath, "global");
    try {
      migrate(db, "global");
      seedUpstreamRefs(db);
      const ref = (pkg: string) => (db.prepare("SELECT upstream_ref FROM upstream_refs WHERE package=?").get(pkg) as { upstream_ref: string }).upstream_ref;
      expect(ref("todo")).toBe("master");
      db.prepare("UPDATE upstream_refs SET upstream_ref='main', last_reviewed_commit='reviewed', upstream_repo='local-source' WHERE package='todo'").run();
      db.prepare("UPDATE upstream_refs SET upstream_ref='custom' WHERE package='memory'").run();
      seedUpstreamRefs(db);
      seedUpstreamRefs(db);
      expect(ref("todo")).toBe("master");
      expect(db.prepare("SELECT upstream_repo, last_reviewed_commit FROM upstream_refs WHERE package='todo'").get()).toEqual({ upstream_repo: "local-source", last_reviewed_commit: "reviewed" });
      expect(ref("memory")).toBe("custom");
      db.prepare("UPDATE upstream_refs SET upstream_ref='release' WHERE package='todo'").run();
      seedUpstreamRefs(db);
      expect(ref("todo")).toBe("release");
    } finally {
      db.close();
    }
  });
});

describe("runUpstreamWatch", () => {
  it("seeds refs, records candidates as todos, updates last_checked_at, and de-dupes on re-run", async () => {
    const r = tempRepo();
    const base = r.commit("base");
    r.commit("feat: alpha");
    r.commit("fix: beta");

    const gdb = configureUpstream(r.dir, base);
    const { cwd, sessionId } = scratchProject();
    const pdb = openDbAt(path.join(cwd, "project.db"), "project");
    migrate(pdb, "project");

    const deps = { git: realGit, mirrorRoot: mirrorRoot("todos"), packages: ["superpowers"] };
    const rep1 = await runUpstreamWatch(gdb, pdb, sessionId, deps);
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

    const rep2 = await runUpstreamWatch(gdb, pdb, sessionId, deps);
    expect(rep2.todosAdded).toBe(0);
    expect(todoCount()).toBe(2);
  });
});

describe("runUpstreamWatch resilience", () => {
  it("reports an unreachable baseline and never throws", async () => {
    const upstream = tempRepo();
    upstream.commit("head");
    const gdb = configureUpstream(upstream.dir, "deadbeef");
    const { projectDb, sessionId } = watchProject();

    const report = await runUpstreamWatch(gdb, projectDb, sessionId, {
      git: realGit,
      mirrorRoot: mirrorRoot("unreachable-baseline"),
      packages: ["superpowers"],
    });
    const result = report.packages[0];
    expect(result.state).toBe("unreachable");
    expect(result.reason).toBeTruthy();
    expect(result.candidates).toEqual([]);
    expect(report.todosAdded).toBe(0);
  });

  it("supplies bounded non-interactive options when a local remote requests credentials", async () => {
    const helperDir = testScratchPath(`uw-credential-helper-${process.pid}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(helperDir, { recursive: true });
    const helper = path.join(helperDir, "git-remote-credentialfixture");
    fs.writeFileSync(helper, [
      "#!/bin/sh",
      ": \"${GIT_TERMINAL_PROMPT:?missing GIT_TERMINAL_PROMPT}\"",
      ": \"${GIT_ASKPASS:?missing GIT_ASKPASS}\"",
      "\"$GIT_ASKPASS\" 'Username for credential fixture' >/dev/null",
      "exit 1",
      "",
    ].join("\n"));
    fs.chmodSync(helper, 0o755);

    const invocations: Array<{ args: string[]; options: TestGitOptions }> = [];
    const git: GitRunner = (repo, args, options) => {
      invocations.push({ args, options });
      return execGit(repo, args, options, {
        PATH: `${helperDir}${path.delimiter}${process.env.PATH ?? ""}`,
      });
    };
    const gdb = configureUpstream("credentialfixture::credential-required", null);
    const { projectDb, sessionId } = watchProject();

    const started = Date.now();
    const report = await runUpstreamWatch(gdb, projectDb, sessionId, {
      git,
      mirrorRoot: mirrorRoot("credential-failure"),
      packages: ["superpowers"],
    });

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(report.packages[0].state).toBe("fetch-failed");
    expect(report.packages[0].reason).toBeTruthy();
    expect(invocations.length).toBeGreaterThan(0);
    expect(invocations.every(({ options }) => options.timeoutMs > 0)).toBe(true);
    expect(invocations.every(({ options }) => options.env.GIT_TERMINAL_PROMPT === "0")).toBe(true);
    expect(invocations.every(({ options }) => options.env.GIT_ASKPASS === "true")).toBe(true);
    expect(invocations.every(({ options }) => options.env.SSH_ASKPASS === "true")).toBe(true);
    expect(invocations.every(({ options }) => options.env.GIT_SSH_COMMAND === "ssh -oBatchMode=yes")).toBe(true);
  });

  it("reports a simulated fetch timeout and continues checking other packages", async () => {
    const superpowers = tempRepo();
    superpowers.commit("superpowers head");
    const memory = tempRepo();
    memory.commit("memory head");
    const gdb = configureUpstream(superpowers.dir, null);
    gdb.prepare(
      `UPDATE upstream_refs
       SET upstream_repo=@repo, upstream_ref='main', last_reviewed_commit=NULL,
           last_checked_at=0, notes=NULL
       WHERE package='memory'`,
    ).run({ repo: memory.dir });
    const { projectDb, sessionId } = watchProject();
    const git: GitRunner = async (repo, args, options) => {
      if (repo.endsWith(encodeURIComponent("superpowers")) && args[0] === "fetch") {
        throw Object.assign(new Error("git process was terminated"), { code: "ETIMEDOUT", killed: true });
      }
      return realGit(repo, args, options);
    };

    const report = await runUpstreamWatch(gdb, projectDb, sessionId, {
      git,
      mirrorRoot: mirrorRoot("timeout-continues"),
      packages: ["superpowers", "memory"],
    });

    expect(report.packages).toHaveLength(2);
    expect(report.packages[0].state).toBe("fetch-failed");
    expect(report.packages[0].reason).toMatch(/timed out/i);
    expect(report.packages[1].package).toBe("memory");
    expect(report.packages[1].state).toBe("no-baseline");
  });
});
