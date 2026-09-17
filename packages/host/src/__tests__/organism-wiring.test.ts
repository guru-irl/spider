// packages/host/src/__tests__/organism-wiring.test.ts
//
// Regression guard for the Phase 6 whole-branch review gap: the organism MANUAL
// action surface (`skill`, `control skill curate`, `control insights`) is fully
// built + unit-tested in @spider/organism but was NEVER mounted in the host, so
// `/learn`, curation, and the learning-graph view had no user-reachable surface.
//
// This test builds the real extension against a fake pi, then drives the actual
// dispatch registry + handleControl. It MUST fail against an unwired host (skill
// falls through to the Phase-0 stub; control insights/skill hit the "not yet
// implemented" default) and PASS once the actions are routed.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setGlobalDbPathForTests } from "@spider/db-core";
import spiderExtension, { buildActionCtx } from "../extension";
import { getAction, type ActionCtx, type SpiderArgs } from "../dispatch";
import { assertPostOpenIsolation, assertPreflightIsolation, gitInit, type ExpectedRoots } from "./fixture-safety";

const scratch = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".spider", "scratch", `org-wire-${process.pid}`);

// INCIDENT-premature-run-finalization.md, defence in depth: a subagent runs `npm
// test` as its own verification gate, so THIS vitest worker can inherit a REAL, live
// parent subagent's PI_SUBAGENT_CHILD/PI_SPIDER_DB_PATH/PI_SUBAGENT_RUN_ID/
// PI_SPIDER_SESSION_ID from its ambient environment. This suite builds the real
// extension (spiderExtension wires @spider/subagents' registerSubagentActions,
// which reads those exact four vars), so every test stubs all four to inert,
// scratch-scoped values — never inherited real ones — the same isolation
// child-terminal-message.test.ts already applies for its own (intentional) attach.
// PI_SUBAGENT_CHILD is stubbed OFF (empty, not "1"): this suite is not testing the
// child reporter and must not change which of the five session_shutdown handlers
// registerSubagentActions wires (see the afterEach comment below) — the production
// ownership guard in child-reporter.ts is the real fix; this is only a second layer
// that keeps this harness from ever being able to reach the real DB at all.
const CHILD_ENV_KEYS = ["PI_SUBAGENT_CHILD", "PI_SPIDER_DB_PATH", "PI_SUBAGENT_RUN_ID", "PI_SPIDER_SESSION_ID"] as const;
function stubChildEnv(dir: string): void {
  const fixtureValues: Record<(typeof CHILD_ENV_KEYS)[number], string> = {
    PI_SUBAGENT_CHILD: "",
    PI_SPIDER_DB_PATH: join(dir, "unused-child-fixture.db"),
    PI_SUBAGENT_RUN_ID: "not-a-real-run-id",
    PI_SPIDER_SESSION_ID: "not-a-real-session-id",
  };
  for (const key of CHILD_ENV_KEYS) vi.stubEnv(key, fixtureValues[key]);
}

type Fixture = { pi: ReturnType<typeof fakePi>; ctx: ActionCtx; dir: string };
const liveFixtures: Fixture[] = [];

afterEach(() => {
  // Close everything this suite opened. Also invoke every captured session_shutdown
  // handler (subagents teardown; hooks.ts's own no-op; agents-UI dispose; organism
  // drain+curate; organism dispose + routing-DB close — FIVE handlers, see fakePi()
  // below) before dropping the connections, instead of just calling ctx.db.close()
  // piecemeal. IMPORTANT: this harness calls each handler with NO (event, ctx)
  // arguments — it exercises RESOURCE DISPOSAL only, not the full real shutdown
  // lifecycle. The one ctx-dependent handler (organism drain+curate, which reads
  // ctx?.sessionManager?.getSessionId?.()) early-returns argument-less and MUST stay
  // that way here: passing a real ctx would enable a genuine drain/curate pass
  // (aux-model + embedder calls) inside afterEach. Real lifecycle behavior —
  // including what happens when session_shutdown actually fires with a live ctx —
  // is covered by organism-host-integration.test.ts, not this suite. fakePi.on()
  // below captures EVERY handler registered per event name (not just the last one),
  // so all five registered handlers actually run here as no-ops/resource disposal,
  // not just whichever one happened to register last.
  for (const f of liveFixtures.splice(0)) {
    const shutdownHandlers = (f.pi._hooks["session_shutdown"] ?? []) as Array<() => unknown>;
    for (const shutdown of shutdownHandlers) {
      try { shutdown(); } catch { /* best-effort teardown, mirrors a real host shutdown */ }
    }
    f.ctx.db.close();
    f.ctx.repoDb.close();
    f.ctx.globalDb.close();
  }
  vi.unstubAllEnvs();
  setGlobalDbPathForTests(null);
  rmSync(scratch, { recursive: true, force: true });
});

function fakePi() {
  const tools: Record<string, unknown> = {};
  // Every hook name collects ALL registered handlers (array), not last-write-wins:
  // the real host registers FIVE session_shutdown handlers — (1) subagents teardown
  // (subagents/src/index.ts), (2) hooks.ts's own unconditional no-op (registerHooks
  // loop), (3) agents-UI dispose, (4) organism drain+curate (ctx-dependent; no-ops
  // when invoked argument-less, see afterEach above), (5) organism dispose +
  // routing-DB close — and a fakePi that only ever kept the last one would silently
  // stop proving the other four run at all.
  const hooks: Record<string, Array<(...args: unknown[]) => unknown>> = {};
  const commands: Record<string, unknown> = {};
  return {
    registerTool: (t: { name: string }) => { tools[t.name] = t; },
    registerCommand: (name: string, def: unknown) => { commands[name] = def; },
    registerMessageRenderer: () => {},
    on: (name: string, fn: (...args: unknown[]) => unknown) => {
      (hooks[name] ??= []).push(fn);
    },
    listModels: () => [],
    _tools: tools, _hooks: hooks, _commands: commands,
  };
}

/** Wire the extension against a fresh scratch DB and hand back an ActionCtx.
 *  Isolation is enforced in two layers (fixture-safety.ts, shared with
 *  extension.test.ts): a DB-free preflight BEFORE buildActionCtx ever resolves or
 *  opens anything (a missing `git init` must fail HERE, not migrate the real
 *  checkout's DB), and a post-open guard against the REAL ActionCtx once resolved. */
function setup(sub: string): { pi: ReturnType<typeof fakePi>; ctx: ActionCtx; dir: string } {
  mkdirSync(scratch, { recursive: true });
  // Global override installed BEFORE anything opens a DB (including the preflight,
  // which in fact opens none at all — pure path resolution only).
  setGlobalDbPathForTests(join(scratch, `g-${sub}-${Date.now()}.db`));
  const dir = join(scratch, `proj-${sub}`);
  stubChildEnv(dir);
  // Isolate the fixture from this real checkout's git toplevel BEFORE any resolver
  // runs: without this, resolveProject's git walk climbs straight past `dir` and out
  // to the real repo root, and every DB open below would silently target real repo
  // state.
  gitInit(dir);
  // DB-free preflight: pure worktree/repo-root resolution must stay inside `dir`
  // itself (both tiers, since this fixture is its own git repo) before buildActionCtx
  // ever calls resolveProject/openProject/openRepo/migrate.
  assertPreflightIsolation(dir, dir);

  const pi = fakePi();
  spiderExtension(pi as never);
  const ctx = buildActionCtx(pi as never, { action: "control", cwd: dir } as SpiderArgs, "s-org", dir);
  const fixture = { pi, ctx, dir };
  // Track BEFORE the post-open assertion so a thrown assertion still leaves every
  // handle registered for afterEach cleanup (nothing leaks on the failure path).
  liveFixtures.push(fixture);
  // Worktree and repo tiers must live inside `dir` (its own git repo); the global DB
  // is a scratch-scoped override that is legitimately OUTSIDE `dir` — it sits as a
  // sibling under `scratch`, one level above the project subdirectory.
  const expected: ExpectedRoots = { worktree: dir, repo: dir, global: scratch };
  assertPostOpenIsolation(ctx, expected, { requireRepoKey: true });
  return fixture;
}

describe("host mounts the organism manual action surface", () => {
  it("routes the `skill` action (list → array details; distill → /learn prompt)", async () => {
    const { ctx } = setup("skill");
    const skill = getAction("skill");
    expect(skill, "skill action must be registered (not the Phase-0 stub)").toBeTypeOf("function");

    const listed = await skill!({ action: "skill", op: "list" } as never, ctx) as { display: string; details: unknown };
    expect(listed.display).toBeTypeOf("string");
    expect(Array.isArray(listed.details)).toBe(true);

    const distilled = await skill!({ action: "skill", op: "distill", text: "x" } as never, ctx) as { details: { prompt: string } };
    expect(distilled.details.prompt).toContain("spider skill");
  });

  it("routes `control insights` to the learning graph (nodes/edges/stats), not the stub", async () => {
    const { ctx } = setup("insights");
    const control = getAction("control");
    expect(control).toBeTypeOf("function");
    const res = await control!({ action: "control", command: "insights" } as never, ctx) as { error?: string; details: { nodes?: unknown; edges?: unknown; stats?: unknown } };
    expect(res.error).toBeUndefined();
    expect(res.details).toBeTruthy();
    expect(res.details).toHaveProperty("nodes");
    expect(res.details).toHaveProperty("edges");
    expect(res.details).toHaveProperty("stats");
  });

  it("routes `control skill curate` to the curator decay pass, not an error", async () => {
    const { ctx } = setup("curate");
    const control = getAction("control");
    const res = await control!({ action: "control", command: "skill", sub: "curate", force: true } as never, ctx) as { error?: string; display?: string; details: { toStale?: unknown; toArchived?: unknown; skipped?: unknown } };
    expect(res.error).toBeUndefined();
    expect(res.display).toBeTypeOf("string");
    expect(res.details).toHaveProperty("toStale");
    expect(res.details).toHaveProperty("toArchived");
    expect(res.details).toHaveProperty("skipped");
  });
});
