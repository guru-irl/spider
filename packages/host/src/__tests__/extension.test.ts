// packages/host/src/__tests__/extension.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { setGlobalDbPathForTests, openDbAt, type Db } from "@spider/db-core";
import spiderExtension, { buildActionCtx, sessionIdOf, cwdOf } from "../extension";
import { getAction, type SpiderArgs } from "../dispatch";
import { HOOK_NAMES } from "../hooks";
import { assertPostOpenIsolation, assertPreflightIsolation, type ExpectedRoots } from "./fixture-safety";

const scratch = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".spider", "scratch", `ext-${process.pid}`);
const probeHandles: Db[] = [];
afterEach(() => {
  for (const db of probeHandles.splice(0)) { try { db.close(); } catch { /* best-effort */ } }
  setGlobalDbPathForTests(null);
  rmSync(scratch, { recursive: true, force: true });
});

// `gitInitScratch()` inits the WHOLE fixture root, so every proj-*/cwd-*/todo-* dir a
// test creates resolves worktree AND repo tier to `scratch` itself (not a narrower
// subdirectory) — both expected roots below are `scratch`, matching that layout.
const EXPECTED: ExpectedRoots = { worktree: scratch, repo: scratch, global: scratch };

/** Permanent isolation guard (do not remove; shared with organism-wiring.test.ts via
 *  fixture-safety.ts). The 'skill' test below drives the real organism runtime with a
 *  valid session id + real SessionManager, which INSERTs a `sessions` row into
 *  whatever worktree DB `resolveProject` resolves to. Two layers:
 *  1. DB-free preflight, BEFORE any DB is opened (a missing `git init` on `dir`/`
 *     scratch` must fail HERE, not migrate the real checkout's DB).
 *  2. Post-open: builds ONE probe ActionCtx (the global-db override is already
 *     installed by every call site before this runs), tracks its handles for cleanup
 *     BEFORE asserting, then checks the REAL projectKey/repoKey and the actual
 *     on-disk file of all three SQLite handles — no invented properties. */
function assertFixtureIsolation(dir: string): void {
  assertPreflightIsolation(dir, scratch);
  const probe = buildActionCtx({} as never, { action: "control", cwd: dir } as never, "s-isolation-probe", dir);
  probeHandles.push(probe.db, probe.repoDb, probe.globalDb);
  assertPostOpenIsolation(probe, EXPECTED, { requireRepoKey: true });
}

/** Create (or reuse) the fixture root and `git init` it BEFORE any project resolver
 *  ever runs against a subdirectory of it. Protecting the whole root (rather than each
 *  test's own `proj-*` subdir individually) covers every test in this file with one
 *  line each: resolveProject's `git rev-parse --show-toplevel` walk now terminates at
 *  `scratch` and can never climb out into this real checkout. */
function gitInitScratch(): void {
  mkdirSync(scratch, { recursive: true });
  execFileSync("git", ["init", "-q", scratch]);
  // DB-free: safe to run here regardless of setGlobalDbPathForTests ordering (unlike
  // the post-open guard, which opens DBs and would hit the real global db if run
  // before the override is installed). Covers every fixture-building call site in
  // this file with one line, not just the one test that also runs the post-open
  // guard below.
  assertPreflightIsolation(scratch, scratch);
}

/** Pre-action probe for the tool.execute/command.handler call sites below that do NOT
 *  already hold a real ActionCtx (control doctor/migrate, the /todos command). Builds
 *  ONE probe ActionCtx using the EXACT SAME resolution inputs (args.cwd presence —
 *  which drives explicitCwd — sessionId, and the ctx cwd hint) the real call just
 *  below it will use, so the probe follows the SAME explicit-cwd-vs-binding path the
 *  action follows. An explicit-cwd shortcut (like assertFixtureIsolation's probe,
 *  correct for sites where the real call also passes an explicit args.cwd) would
 *  bypass session-binding resolution entirely for a site that doesn't use one —
 *  exactly the gap I1 flagged. Caller must install setGlobalDbPathForTests BEFORE
 *  calling this (every call site below already does, ahead of `dir`'s creation). */
function assertPreActionIsolation(args: SpiderArgs, sessionId: string, ctxCwd?: string): void {
  const probe = buildActionCtx({} as never, args, sessionId, ctxCwd);
  probeHandles.push(probe.db, probe.repoDb, probe.globalDb);
  assertPostOpenIsolation(probe, EXPECTED, { requireRepoKey: true });
}

function fakePi() {
  const tools: Record<string, unknown> = {};
  const hooks: Record<string, unknown> = {};
  const commands: Record<string, unknown> = {};
  return {
    registerTool: (t: { name: string }) => { tools[t.name] = t; },
    registerCommand: (name: string, def: unknown) => { commands[name] = def; },
    on: (name: string, fn: unknown) => { hooks[name] = fn; },
    _tools: tools, _hooks: hooks, _commands: commands,
  };
}

describe("spider extension entry", () => {
  it("advertises run/query params in the tool schema so the model passes them (regression: empty tasks/0 tool calls)", () => {
    const pi = fakePi();
    spiderExtension(pi as never);
    const props = (pi._tools.spider as { parameters: { properties: Record<string, any> } }).parameters.properties;
    for (const k of ["agent", "task", "tasks", "chain", "query", "content"]) {
      expect(props[k], `schema must advertise '${k}'`).toBeTruthy();
    }
    // async-only: there is NO synchronous option, so the schema must NOT advertise `async`.
    expect(props.async).toBeUndefined();
    expect(props.tasks.items.required).toEqual(expect.arrayContaining(["agent", "task"]));
  });

  it("registers the 'spider' tool (with the 🕸 description) alongside the edit/write overrides", () => {
    const pi = fakePi();
    spiderExtension(pi as never);
    // Routing wires edit/write overrides at load, so there are now three tools.
    expect(new Set(Object.keys(pi._tools))).toEqual(new Set(["spider", "edit", "write"]));
    const spider = pi._tools["spider"] as { description: string };
    expect(spider.description).toContain("🕸");
  });

  it("registers a handler for every contract hook", () => {
    const pi = fakePi();
    spiderExtension(pi as never);
    // tool_call is now in HOOK_NAMES for exec enforcement.
    // tool_result remains routing-only.
    expect(HOOK_NAMES).toContain("tool_call");
    expect(HOOK_NAMES).not.toContain("tool_result");
    for (const name of HOOK_NAMES) expect(pi._hooks[name]).toBeTypeOf("function");
  });

  it("wires routing at load: tool_call/tool_result hooks + edit/write tool overrides", () => {
    const pi = fakePi();
    spiderExtension(pi as never);
    expect(pi._hooks["tool_call"]).toBeTypeOf("function");
    expect(pi._hooks["tool_result"]).toBeTypeOf("function");
    expect(pi._tools["edit"]).toBeTruthy();
    expect(pi._tools["write"]).toBeTruthy();
  });

  it("the spider tool routes control doctor", async () => {
    gitInitScratch();
    setGlobalDbPathForTests(join(scratch, `g-${Date.now()}.db`));
    const dir = join(scratch, "proj"); mkdirSync(dir, { recursive: true });
    // Pre-action probe mirrors the real call's resolution shape EXACTLY: args.cwd is
    // set below (`cwd: dir`), so the production buildActionCtx sees explicitCwd=true
    // regardless of session — sessionId="" matches sessionIdOf({}) for the bare `{}`
    // ctx object passed to tool.execute two lines down.
    assertPreActionIsolation({ action: "control", command: "doctor", cwd: dir } as SpiderArgs, "", undefined);
    const pi = fakePi();
    spiderExtension(pi as never);
    const tool = pi._tools["spider"] as {
      execute(id: string, args: unknown, ctx: unknown): Promise<unknown>;
    };
    const res = await tool.execute("c1", { action: "control", command: "doctor", cwd: dir }, {}) as { content: { text: string }[]; details: { lines?: string[] } };
    // execute() now normalizes to pi's AgentToolResult: model-facing text in content[0].text.
    expect(res.content[0].text).toMatch(/spider doctor/);
  });

  // A-M3 (branch-review A-architecture.md): `registerRouting`'s failure used to be
  // fully swallowed ("routing registration must not break extension load") with NOTHING
  // anywhere reporting it — markToolCallError kept adding to result.ts's erroredCalls Set
  // with no consumer ever draining it, and `spider control doctor` said nothing at all.
  // Mirrors the EXISTING, already-correct pattern for `registerOrganism`'s own setup
  // failures (`- organism: NOT WIRED (registration failed)`).
  it("A-M3: a registerRouting failure is surfaced by doctor (NOT WIRED) instead of being fully swallowed", async () => {
    gitInitScratch();
    setGlobalDbPathForTests(join(scratch, `g-am3-${Date.now()}.db`));
    const dir = join(scratch, "proj-am3"); mkdirSync(dir, { recursive: true });
    assertPreActionIsolation({ action: "control", command: "doctor", cwd: dir } as SpiderArgs, "", undefined);

    const base = fakePi();
    // registerEditWriteOverrides (the FIRST thing registerRouting does) registers "edit"
    // before "write" — throwing there makes registerRouting itself throw, exactly like a
    // real pi.registerTool failure would, WITHOUT touching any other wiring in
    // spiderExtension (nothing else registers a tool named "edit").
    const pi = { ...base, registerTool: (t: { name: string }) => {
      if (t.name === "edit") throw new Error("boom: edit tool registration failed");
      return base.registerTool(t);
    } };
    spiderExtension(pi as never);

    // Extension load itself must not throw, and the spider tool must still be usable.
    expect(pi._tools["spider"]).toBeTruthy();
    expect(pi._tools["edit"]).toBeUndefined();
    expect(pi._tools["write"]).toBeUndefined();

    const tool = pi._tools["spider"] as { execute(id: string, args: unknown, ctx: unknown): Promise<unknown> };
    const res = await tool.execute("c-am3", { action: "control", command: "doctor", cwd: dir }, {}) as { details: { ok?: boolean; lines?: string[] } };
    expect(res.details.ok).toBe(false);
    expect(res.details.lines?.some((l) => /routing/i.test(l) && /NOT WIRED/i.test(l))).toBe(true);
  });

  it("control migrate performs DB tiering migration", async () => {
    gitInitScratch();
    setGlobalDbPathForTests(join(scratch, `g-mig-${Date.now()}.db`));
    const dir = join(scratch, "proj-mig"); mkdirSync(dir, { recursive: true });
    // Same shape as the doctor test above: args.cwd is explicit, so the probe mirrors
    // that (sessionId="" for the bare `{}` ctx tool.execute receives below).
    assertPreActionIsolation({ action: "control", command: "migrate", cwd: dir } as SpiderArgs, "", undefined);
    const pi = fakePi();
    spiderExtension(pi as never);
    const tool = pi._tools["spider"] as { execute(id: string, args: unknown, ctx: unknown): Promise<unknown> };
    const res = await tool.execute("cm", { action: "control", command: "migrate", cwd: dir }, {}) as { content: { text: string }[]; details: { dryRun?: boolean; applied?: boolean } };
    // Should return dry-run result by default
    expect(res.details.dryRun).toBe(true);
    expect(res.details.applied).toBe(false);
  });

  it("builds an ActionCtx that carries the models router", () => {
    gitInitScratch();
    setGlobalDbPathForTests(join(scratch, `g-ctx-${Date.now()}.db`));
    const dir = join(scratch, "proj-ctx"); mkdirSync(dir, { recursive: true });
    const pi = fakePi();
    spiderExtension(pi as never);
    const ctx = buildActionCtx(pi as never, { action: "recall", cwd: dir }, "s-1");
    // Track BEFORE asserting so a thrown assertion still leaves all three handles
    // registered for afterEach cleanup, then verify this real ctx's projectKey/repoKey
    // and the actual on-disk file of all three SQLite handles (I1: this site already
    // holds a real ActionCtx, so the post-open guard costs zero extra DB opens/probes).
    probeHandles.push(ctx.db, ctx.repoDb, ctx.globalDb);
    assertPostOpenIsolation(ctx, EXPECTED, { requireRepoKey: true });
    expect(typeof ctx.models.catalog).toBe("function");
    expect(typeof ctx.models.pick).toBe("function");
    expect(typeof ctx.models.complete).toBe("function");
    expect(ctx.sessionId).toBe("s-1");
  });

  it("sessionIdOf reads ExtensionContext.sessionManager.getSessionId() (real pi tool-ctx shape)", () => {
    expect(sessionIdOf({ sessionManager: { getSessionId: () => "sess-42" } })).toBe("sess-42");
    expect(sessionIdOf(undefined)).toBe("");
    expect(sessionIdOf({})).toBe("");
  });

  it("cwdOf reads ExtensionContext.cwd (string only)", () => {
    expect(cwdOf({ cwd: "/x" })).toBe("/x");
    expect(cwdOf(undefined)).toBeUndefined();
    expect(cwdOf({})).toBeUndefined();
  });

  it("buildActionCtx prefers args.cwd, else the ExtensionContext cwd hint", () => {
    gitInitScratch();
    setGlobalDbPathForTests(join(scratch, `g-cwd-${Date.now()}.db`));
    const dirA = join(scratch, "cwd-a"); mkdirSync(dirA, { recursive: true });
    const dirB = join(scratch, "cwd-b"); mkdirSync(dirB, { recursive: true });
    const pi = fakePi(); spiderExtension(pi as never);
    const c1 = buildActionCtx(pi as never, { action: "recall", cwd: dirA }, "s", dirB);
    probeHandles.push(c1.db, c1.repoDb, c1.globalDb);
    assertPostOpenIsolation(c1, EXPECTED, { requireRepoKey: true });
    expect(c1.cwd).toBe(dirA);
    const c2 = buildActionCtx(pi as never, { action: "recall" }, "s", dirB);
    probeHandles.push(c2.db, c2.repoDb, c2.globalDb);
    assertPostOpenIsolation(c2, EXPECTED, { requireRepoKey: true });
    expect(c2.cwd).toBe(dirB);
  });

  it("registers a ctx-native 'todo' action that round-trips add\u2192list against ctx.db", async () => {
    gitInitScratch();
    setGlobalDbPathForTests(join(scratch, `g-todo-${Date.now()}.db`));
    const pi = fakePi();
    spiderExtension(pi as never);
    const todo = getAction("todo");
    expect(todo).toBeTypeOf("function");
    const dbPath = join(scratch, `todo-${Date.now()}.db`);
    const db = openDbAt(dbPath, "project");
    await todo!({ action: "todo", op: "add", text: "write plan" } as never, { db, sessionId: "s1" } as never);
    const res = await todo!({ action: "todo", op: "list" } as never, { db, sessionId: "s1" } as never) as { details: unknown };
    expect(JSON.stringify(res.details)).toContain("write plan");
    db.close();
  });

  it("registers a real-contract '/todos' command that notifies via ctx.ui.notify", async () => {
    gitInitScratch();
    setGlobalDbPathForTests(join(scratch, `g-cmd-${Date.now()}.db`));
    const dir = join(scratch, "proj-cmd"); mkdirSync(dir, { recursive: true });
    // The real /todos handler's getDb resolves via resolveProject(cwd, { sessionId,
    // explicitCwd: false }) directly (extension.ts) — NOT an explicit args.cwd. The
    // probe below mirrors that exactly: no `cwd` field on args (so buildActionCtx
    // computes explicitCwd=false itself), the SAME session id the real ctx.sessionManager
    // below reports, and dir as the ctx cwd hint — so it actually follows the binding
    // path the action follows, not an explicit-cwd shortcut that would bypass it.
    assertPreActionIsolation({ action: "todo" } as SpiderArgs, "s-fresh", dir);
    const pi = fakePi();
    spiderExtension(pi as never);
    const cmd = pi._commands["todos"] as { description: string; handler: (a: string, c: unknown) => Promise<void> };
    expect(cmd).toBeTruthy();
    expect(cmd.description).toBeTypeOf("string");
    expect(cmd.handler).toBeTypeOf("function");
    const notified: string[] = [];
    await cmd.handler("", { cwd: dir, sessionManager: { getSessionId: () => "s-fresh" }, hasUI: true, ui: { notify: (m: string) => notified.push(m) } });
    expect(notified.join("\n")).toContain("(no todos)");
  });

  it("routes the now-wired 'skill' action at the tool boundary (no Phase-0 stub)", async () => {
    gitInitScratch();
    setGlobalDbPathForTests(join(scratch, `g-skill-${Date.now()}.db`));
    const dir = join(scratch, "proj-skill"); mkdirSync(dir, { recursive: true });
    assertFixtureIsolation(dir);
    const pi = fakePi();
    spiderExtension(pi as never);
    const tool = pi._tools["spider"] as {
      execute(id: string, args: unknown, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<unknown>;
    };
    // The production execute contract is FIVE positional args (toolCallId, args, signal,
    // onUpdate, ctx) — calling it with a bare `{}` in place of `ctx` (the 5th arg) starves
    // sessionIdOf(ctx), which is a real requirement (organism needs an active session), not
    // a bug to paper over. Supply a structurally accurate ExtensionContext instead: a real
    // pi SessionManager, isolated to this test's own in-memory session.
    const session = SessionManager.inMemory(dir);
    const ctx = { cwd: dir, sessionManager: session };
    const res = await tool.execute("c2", { action: "skill", op: "list", cwd: dir }, undefined, undefined, ctx) as { content: { text: string }[]; details: unknown };
    // The organism skill action is mounted now: `list` returns a rendered panel
    // + an array of skill rows, NOT the "not yet implemented (Phase 0 stub)".
    expect(res.content[0].text).not.toMatch(/not.*implemented/i);
    expect(Array.isArray(res.details)).toBe(true);
  });
});
