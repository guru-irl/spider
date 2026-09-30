// Task 15 regression: `control upstream-watch` must route through handleControl to
// @spider/superpowers (runUpstreamWatch / markReviewed), NOT fall through to the
// "not yet implemented" default. Uses a scratch global DB + a real temp git repo
// under .spider/scratch, and injects local sources through a host-only dependency.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setGlobalDbPathForTests, paths } from "@spider/db-core";
import spiderExtension, { buildActionCtx, UPSTREAM_REPOS_FOR_TESTS } from "../extension";
import { getAction, type ActionCtx, type SpiderArgs } from "../dispatch";

const scratch = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".spider", "scratch", `uw-ctl-${process.pid}`);

function tempRepo(): { dir: string; commit: (m: string) => string } {
  const dir = join(scratch, `repo-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const run = (...a: string[]): string => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  run("init", "-q");
  run("symbolic-ref", "HEAD", "refs/heads/main");
  run("config", "user.email", "t@t"); run("config", "user.name", "t");
  return {
    dir,
    commit(m: string): string {
      writeFileSync(join(dir, "f.txt"), m);
      run("add", "."); run("commit", "-q", "-m", m);
      return run("rev-parse", "HEAD").trim();
    },
  };
}

let ctx: ActionCtx;
let tool: { parameters: { properties: Record<string, { type: string }> }; execute: (id: string, args: SpiderArgs, signal?: unknown, onUpdate?: unknown, context?: unknown) => Promise<any> };
let previousCeiling: string | undefined;
let testPi: Record<PropertyKey, unknown>;
function localSource(dir: string): void { testPi[UPSTREAM_REPOS_FOR_TESTS] = { superpowers: dir }; }

beforeAll(() => {
  mkdirSync(scratch, { recursive: true });
  previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = scratch;
  setGlobalDbPathForTests(join(scratch, "global.db"));
  const pi: unknown = { on: () => undefined, registerTool: (t: typeof tool & { name: string }) => { if (t.name === "spider") tool = t; }, registerCommand: () => undefined, registerMessageRenderer: () => undefined };
  testPi = pi as Record<PropertyKey, unknown>;
  spiderExtension(pi as never);
  const proj = join(scratch, "proj");
  mkdirSync(proj, { recursive: true });
  ctx = buildActionCtx(pi as never, { action: "control", cwd: proj } as SpiderArgs, "s-uw", proj);
});

afterAll(() => {
  ctx?.db.close(); ctx?.repoDb.close(); ctx?.globalDb.close();
  setGlobalDbPathForTests(null);
  if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("control upstream-watch", () => {
  it("routes the command to the superpowers handler and returns a report with packages", async () => {
    const r = tempRepo();
    const base = r.commit("base");
    r.commit("feat: one");
    r.commit("fix: two");
    localSource(r.dir);

    const control = getAction("control");
    expect(control).toBeTypeOf("function");

    // First run auto-seeds upstream_refs (baseline: records head, zero candidates
    // because last_reviewed is unset — a first run never floods todos).
    const first = await control!(
      { action: "control", command: "upstream-watch" } as never,
      ctx,
    ) as { error?: string; details: { todosAdded: number } };
    expect(first.error).toBeUndefined();
    expect(first.details.todosAdded).toBe(0);

    // --mark records the reviewed baseline (now the seeded row exists).
    expect(tool.parameters.properties.mark?.type).toBe("string");
    const marked = await tool.execute("mark-baseline", {
      action: "control", command: "upstream-watch", mark: `superpowers ${base}`, cwd: ctx.cwd,
    }, undefined, undefined, { cwd: ctx.cwd, sessionManager: { getSessionId: () => ctx.sessionId } });
    expect(marked.details.ok).toBe(true);
    expect(marked.details.marked).toEqual({ package: "superpowers", ref: base, sha: base });
    expect((ctx.globalDb.prepare("SELECT last_reviewed_commit AS sha FROM upstream_refs WHERE package='superpowers'").get() as { sha: string }).sha).toBe(base);

    // Next run: inject the temp repo; expect the 2 commits since base surfaced.
    const res = await control!(
      { action: "control", command: "upstream-watch" } as never,
      ctx,
    ) as { error?: string; display?: string; details: { packages: Array<{ package: string; candidates: unknown[] }>; todosAdded: number } };
    expect(res.error).toBeUndefined();
    expect(res.details).toHaveProperty("packages");
    const sp = res.details.packages.find((p) => p.package === "superpowers")!;
    expect(sp.candidates.length).toBe(2);
    expect(res.details.todosAdded).toBe(2);
    expect(typeof res.display).toBe("string");
  });

  it("treats absent and empty marks as watch requests, not baseline updates", async () => {
    const r = tempRepo();
    r.commit("head");
    localSource(r.dir);
    for (const mark of [undefined, "", "  ", []]) {
      const result = await getAction("control")!(
        { action: "control", command: "upstream-watch", mark } as never,
        ctx,
      ) as { details?: { packages?: Array<{ package: string }> }; error?: string };
      expect(result.error).toBeUndefined();
      expect(result.details?.packages?.map(p => p.package)).toEqual(["superpowers"]);
    }
  });

  it("does not let a tool-supplied repos override redirect watched sources", async () => {
    const trusted = tempRepo();
    const head = trusted.commit("trusted head");
    const hostile = tempRepo();
    hostile.commit("untrusted head");
    localSource(trusted.dir);
    const call = (extra: Record<string, unknown> = {}) => tool.execute("watch-source", {
      action: "control", command: "upstream-watch", cwd: ctx.cwd, ...extra,
    }, undefined, undefined, { cwd: ctx.cwd, sessionManager: { getSessionId: () => ctx.sessionId } });
    await call();
    const injected = await call({ repos: { superpowers: hostile.dir } });
    expect(injected.details.packages.find((p: { package: string }) => p.package === "superpowers")?.head).toBe(head);
    expect(execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: join(paths.globalRoot, "upstream", "superpowers"), encoding: "utf8",
    }).trim()).toBe(trusted.dir);
  });

  it("rejects extra mark tokens with a usage error", async () => {
    const result = await getAction("control")!({ action: "control", command: "upstream-watch", mark: "superpowers main ignored" }, ctx) as { error?: string };
    expect(result.error).toMatch(/needs <package> <ref>/);
  });
});
