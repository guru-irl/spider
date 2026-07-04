// Task 15 regression: `control upstream-watch` must route through handleControl to
// @spider/superpowers (runUpstreamWatch / markReviewed), NOT fall through to the
// "not yet implemented" default. Uses a scratch global DB + a real temp git repo
// under .spider/scratch (never /tmp), and injects the repo via args.repos.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setGlobalDbPathForTests } from "@spider/db-core";
import spiderExtension, { buildActionCtx } from "../extension";
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

beforeAll(() => {
  mkdirSync(scratch, { recursive: true });
  setGlobalDbPathForTests(join(scratch, "global.db"));
  const pi: unknown = { on: () => undefined, registerTool: () => undefined, registerCommand: () => undefined, registerMessageRenderer: () => undefined };
  spiderExtension(pi as never);
  const proj = join(scratch, "proj");
  mkdirSync(proj, { recursive: true });
  ctx = buildActionCtx(pi as never, { action: "control", cwd: proj } as SpiderArgs, "s-uw", proj);
});

afterAll(() => {
  setGlobalDbPathForTests(null);
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("control upstream-watch", () => {
  it("routes the command to the superpowers handler and returns a report with packages", async () => {
    const r = tempRepo();
    const base = r.commit("base");
    r.commit("feat: one");
    r.commit("fix: two");

    const control = getAction("control");
    expect(control).toBeTypeOf("function");

    // First run auto-seeds upstream_refs (baseline: records head, zero candidates
    // because last_reviewed is unset — a first run never floods todos).
    const first = await control!(
      { action: "control", command: "upstream-watch", repos: { superpowers: r.dir } } as never,
      ctx,
    ) as { error?: string; details: { todosAdded: number } };
    expect(first.error).toBeUndefined();
    expect(first.details.todosAdded).toBe(0);

    // --mark records the reviewed baseline (now the seeded row exists).
    const marked = await control!(
      { action: "control", command: "upstream-watch", mark: `superpowers ${base}` } as never,
      ctx,
    ) as { error?: string; details: { ok?: boolean; marked?: { package: string; sha: string } } };
    expect(marked.error).toBeUndefined();
    expect(marked.details.ok).toBe(true);
    expect(marked.details.marked?.package).toBe("superpowers");

    // Next run: inject the temp repo; expect the 2 commits since base surfaced.
    const res = await control!(
      { action: "control", command: "upstream-watch", repos: { superpowers: r.dir } } as never,
      ctx,
    ) as { error?: string; display?: string; details: { packages: Array<{ package: string; candidates: unknown[] }>; todosAdded: number } };
    expect(res.error).toBeUndefined();
    expect(res.details).toHaveProperty("packages");
    const sp = res.details.packages.find((p) => p.package === "superpowers")!;
    expect(sp.candidates.length).toBe(2);
    expect(res.details.todosAdded).toBe(2);
    expect(typeof res.display).toBe("string");
  });
});
