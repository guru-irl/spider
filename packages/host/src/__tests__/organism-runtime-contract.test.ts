import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  createExtensionRuntime,
  ExtensionRunner,
  SessionManager,
  type Extension,
  type ModelRegistry,
  type SessionShutdownEvent,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
  openGlobal, openProject, openRepo, resolveProject, setGlobalDbPathForTests,
  type Db,
} from "@spider/db-core";
import { addMemory, listPending } from "@spider/memory";
import { CURATOR_DEFAULTS, ORGANISM_DEFAULTS, registerOrganism, SkillStore } from "@spider/organism";
import { registerHooks, type PiLikeAPI } from "../hooks";
import { HostOrganismRuntime } from "../organism-runtime";

const scratch = resolve(".spider/scratch/organism-contract");
const roots: string[] = [];
const handles: Db[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of handles.splice(0)) db.close();
  setGlobalDbPathForTests(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "run-"));
  roots.push(root);
  const cwd = join(root, "project");
  const unrelatedCwd = join(root, "other-project");
  for (const dir of [cwd, unrelatedCwd]) {
    mkdirSync(dir);
    execFileSync("git", ["init", "-q", dir]);
  }
  setGlobalDbPathForTests(join(root, "global.db"));
  // Old code falls back to process.cwd(). Keep even its BROKEN writes isolated.
  vi.spyOn(process, "cwd").mockReturnValue(unrelatedCwd);
  const session = SessionManager.inMemory(cwd);
  const project = resolveProject(cwd, { sessionId: session.getSessionId(), explicitCwd: false });
  const worktreeDb = openProject(project.projectKey);
  const repoDb = openRepo(project.repoKey!);
  const globalDb = openGlobal();
  handles.push(worktreeDb, repoDb, globalDb);
  const extension: Extension = {
    path: "<organism-contract>",
    resolvedPath: "<organism-contract>",
    sourceInfo: { path: "<organism-contract>", source: "sdk", scope: "temporary", origin: "top-level" },
    handlers: new Map(), tools: new Map(), commands: new Map(), flags: new Map(),
    shortcuts: new Map(), messageRenderers: new Map(),
  };
  const pi: PiLikeAPI = {
    on(name, fn) {
      const existing = extension.handlers.get(name) ?? [];
      existing.push(async (...args) => await fn(...args));
      extension.handlers.set(name, existing);
    },
  };
  // No completion is needed by these hooks. Model transport is tested separately.
  const runner = new ExtensionRunner(
    [extension], createExtensionRuntime(), cwd, session, {} as ModelRegistry,
  );
  return { root, cwd, session, project, worktreeDb, repoDb, globalDb, pi, runner };
}

const start = { type: "session_start", reason: "startup" } satisfies SessionStartEvent;
const shutdown = { type: "session_shutdown", reason: "quit" } satisfies SessionShutdownEvent;

describe("organism's actual pi runtime contract", () => {
  it("persists the real context session ID, even when process.cwd is another repo", async () => {
    const f = setup();
    registerHooks(f.pi);
    await f.runner.emit(start);
    expect(f.worktreeDb.prepare("SELECT id FROM sessions").all()).toEqual([
      { id: f.session.getSessionId() },
    ]);
  });

  it("returns the approved memory snapshot through the real before_agent_start result protocol", async () => {
    const f = setup();
    addMemory(f.repoDb, "repo", { category: "convention", content: "Use docs/architecture.md for module boundaries." });
    addMemory(f.repoDb, "repo", { category: "insight", content: "Unreviewed candidate must not be injected.", status: "staged" });
    registerHooks(f.pi);
    const result = await f.runner.emitBeforeAgentStart("continue", undefined, "Base system prompt", { cwd: f.cwd });
    expect(result).toEqual(expect.objectContaining({
      systemPrompt: expect.stringContaining("Base system prompt"),
    }));
    expect(result?.systemPrompt).toContain("Use docs/architecture.md for module boundaries.");
    expect(result?.systemPrompt).not.toContain("Unreviewed candidate");
  });

  it("shutdown learns from real in-memory branch messages and persists pending proposals", async () => {
    const f = setup();
    f.session.appendMessage({ role: "user", content: "Use class-level skills and keep regression fixtures deterministic.", timestamp: 1 });
    f.session.appendMessage({
      role: "assistant", content: [{ type: "text", text: "I added a reusable fixture helper and verified the failing test before fixing the bug." }],
      api: "anthropic-messages", provider: "test", model: "fixture", stopReason: "stop", timestamp: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    const requests: string[] = [];
    registerHooks(f.pi);
    registerOrganism(f.pi, f.pi, {
      db: f.repoDb, worktreeDb: f.worktreeDb, globalDb: f.globalDb, project: f.project,
      getEmbedder: async () => null,
      makeModel: () => ({ complete: async (system, messages) => {
        requests.push(messages.map(m => m.content).join("\n"));
        return system.includes("selfName")
          ? JSON.stringify({ summary: "Verified reusable regression fixtures.", selfName: "regression-fixtures" })
          : JSON.stringify({
            memory: [{ category: "convention", content: "Use deterministic regression fixtures in tests." }],
            skills: [{ name: "regression-fixtures", body: "# Regression fixtures\nUse an isolated fixture and verify RED before GREEN." }],
          });
      } }),
      org: { ...ORGANISM_DEFAULTS, passes: { runMemoryTodo: false, todoMemory: false, learning: true, consolidation: true, reflection: false, insights: false } },
      curator: CURATOR_DEFAULTS,
    });
    await f.runner.emit(start);
    await f.runner.emit(shutdown);

    expect(requests.join("\n")).toContain("keep regression fixtures deterministic");
    expect(listPending(f.repoDb, "repo")).toHaveLength(1);
    expect(new SkillStore(f.repoDb).list({ status: "staged" })).toHaveLength(1);
    expect(f.worktreeDb.prepare("SELECT summary FROM sessions WHERE id = ?").get(f.session.getSessionId()))
      .toEqual({ summary: "Verified reusable regression fixtures." });
    expect(f.worktreeDb.prepare("SELECT COUNT(*) AS n FROM run_events WHERE session_id = ? AND summary LIKE 'organism %'").get(f.session.getSessionId()))
      .toEqual({ n: 1 });
  });

  it("HostOrganismRuntime.recordSetupFailure persists a real failed setup receipt without recursing into resolve(); isWired reflects registration failures (G1a/G1b)", async () => {
    const f = setup();
    const runtimeA = new HostOrganismRuntime(async () => null);
    const runtimeB = new HostOrganismRuntime(async () => null);
    expect(runtimeA.isWired()).toBe(true);

    runtimeA.recordSetupFailure("register", new Error("pi.on threw"));
    expect(runtimeA.isWired()).toBe(false);
    // Instance-scoped: a second runtime instance is unaffected.
    expect(runtimeB.isWired()).toBe(true);

    const ctx = { sessionManager: { getSessionId: () => f.session.getSessionId() }, cwd: f.cwd } as any;
    runtimeA.recordSetupFailure("resolve", new Error("resolver boom"), ctx);
    const failure = runtimeA.getSetupFailure(f.session.getSessionId());
    expect(failure).toMatchObject({
      kind: "organism-drain",
      status: "failed",
      errors: [{ phase: "setup", message: expect.stringContaining("resolver boom") }],
    });

    // Persisted independently of resolve()/fromContext() — real row in the real worktree DB.
    const persisted = f.worktreeDb.prepare(
      "SELECT payload FROM run_events WHERE session_id=? AND type='log' ORDER BY id DESC LIMIT 1",
    ).get(f.session.getSessionId()) as { payload: string } | undefined;
    expect(persisted).toBeDefined();
    const payload = JSON.parse(persisted!.payload);
    expect(payload).toMatchObject({ kind: "organism-drain", status: "failed", errors: [{ phase: "setup" }] });
  });

  it("recordSetupFailure never invents a session id — a missing context stays honestly in-memory-only", () => {
    const runtime = new HostOrganismRuntime(async () => null);
    runtime.recordSetupFailure("context", new Error("no session id available"));
    // Nothing to key an in-memory lookup by; this must not throw or fabricate an id.
    expect(runtime.getSetupFailure("")).toBeUndefined();
  });

  // F4 (organism-review.md): register-organism-failures.test.ts only proves the
  // onSetupError CONTRACT with a hand-built double; organism-runtime-contract.test.ts
  // only calls recordSetupFailure directly. Neither exercises the actual ONE-LINE join
  // extension.ts:813 makes between them: `registerOrganism(pi, pi, resolve, (phase,
  // error, ctx) => organism.recordSetupFailure(phase, error, ctx))`. A signature or
  // phase-string drift on either side would leave every other test green.
  // Verified non-vacuous by mutation: renaming the callback's 2nd/3rd params, or
  // dropping the `ctx` argument in the join expression below, makes this test fail.
  it("wires registerOrganism's onSetupError to HostOrganismRuntime.recordSetupFailure exactly as extension.ts joins them (F4)", async () => {
    const f = setup();
    const runtime = new HostOrganismRuntime(async () => null);
    const handlers: Record<string, (event: unknown, ctx?: unknown) => unknown> = {};
    const pi = { on: (name: string, fn: (event: unknown, ctx?: unknown) => unknown) => { handlers[name] = fn; } };

    // EXACTLY the expression extension.ts:813 uses (resolver arg unused by this join shape).
    registerOrganism(pi, pi, () => { throw new Error("resolver boom via the real join"); },
      (phase, error, ctx) => runtime.recordSetupFailure(phase, error, ctx as any));

    const ctx = { sessionManager: { getSessionId: () => f.session.getSessionId(), getBranch: () => [], getSessionFile: () => undefined }, cwd: f.cwd };
    await expect((handlers.session_shutdown as (e: unknown, c?: unknown) => Promise<unknown>)(
      { type: "session_shutdown" }, ctx,
    )).resolves.toBeUndefined(); // lifecycle must not block or crash

    expect(runtime.isWired()).toBe(true); // a resolve-phase failure must NOT claim a registration failure
    const failure = runtime.getSetupFailure(f.session.getSessionId());
    expect(failure).toMatchObject({ status: "failed", errors: [{ phase: "setup", message: expect.stringContaining("resolver boom via the real join") }] });

    // And it is really persisted through the SAME join, feeding doctor's NOT WIRED line honestly.
    const persisted = f.worktreeDb.prepare(
      "SELECT payload FROM run_events WHERE session_id=? AND type='log' ORDER BY id DESC LIMIT 1",
    ).get(f.session.getSessionId()) as { payload: string } | undefined;
    expect(persisted).toBeDefined();
    expect(JSON.parse(persisted!.payload)).toMatchObject({ status: "failed", errors: [{ phase: "setup" }] });

    // Registration failure (a DIFFERENT phase) still reports NOT WIRED through the same join.
    const throwingPi = { on: () => { throw new Error("pi.on boom via the real join"); } };
    registerOrganism(throwingPi, throwingPi, () => { throw new Error("unused"); },
      (phase, error, c) => runtime.recordSetupFailure(phase, error, c as any));
    expect(runtime.isWired()).toBe(false);
  });

  // F1 (organism-review.md): recordSetupFailure formatted errors with a weaker
  // private duplicate (`String(error).slice(0,500)`) instead of the drain
  // path's `safeError`, so a credential embedded in a resolver/capture error
  // survived verbatim into the persisted receipt and into doctor's output.
  it("recordSetupFailure redacts credentials the same way the drain path's safeError does, both in-memory and in the persisted receipt (F1)", () => {
    const f = setup();
    const runtime = new HostOrganismRuntime(async () => null);
    const ctx = { sessionManager: { getSessionId: () => f.session.getSessionId() }, cwd: f.cwd } as any;
    runtime.recordSetupFailure("resolve", new Error("Bearer sk-test-abcdefghijklmnop failed to open store"), ctx);

    const inMemory = runtime.getSetupFailure(f.session.getSessionId())!;
    expect(inMemory.errors[0].message).not.toContain("sk-test-abcdefghijklmnop");
    expect(inMemory.errors[0].message).toMatch(/\[redacted( credential)?\]/);

    const persisted = f.worktreeDb.prepare(
      "SELECT payload FROM run_events WHERE session_id=? AND type='log' ORDER BY id DESC LIMIT 1",
    ).get(f.session.getSessionId()) as { payload: string };
    const payload = JSON.parse(persisted.payload) as { errors: Array<{ message: string }> };
    expect(payload.errors[0].message).not.toContain("sk-test-abcdefghijklmnop");
    expect(payload.errors[0].message).toMatch(/\[redacted( credential)?\]/);
  });
});
