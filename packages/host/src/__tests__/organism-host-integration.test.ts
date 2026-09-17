import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader, ExtensionRunner, ModelRegistry, ModelRuntime,
  SessionManager, SettingsManager, type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { openGlobal, openProject, openRepo, resolveProject, setGlobalDbPathForTests, type Db } from "@spider/db-core";
import { listPending } from "@spider/memory";
import spiderExtension, { SPIDER_PARAMETERS, buildActionCtx } from "../extension";
import { dispatch } from "../dispatch";
import { controlConfig } from "../control";
import { controlBind } from "../control-bind";
import { renderSpiderResult } from "../render-result";

// Embeddings and completion are external IO boundaries. DBs, routing, models,
// pi's loader and event dispatch all stay REAL in this integration test.
vi.mock("@spider/memory", async (original) => ({
  ...await original<typeof import("@spider/memory")>(),
  resolveEmbedder: async () => null,
}));
const scratch = resolve(".spider/scratch/organism-host-integration");
const roots: string[] = [];
const handles: Db[] = [];
const cleanups: Array<() => Promise<void>> = [];

// INCIDENT-premature-run-finalization.md, defence in depth: a subagent runs `npm
// test` as its own verification gate, so THIS vitest worker can inherit a REAL, live
// parent subagent's PI_SUBAGENT_CHILD/PI_SPIDER_DB_PATH/PI_SUBAGENT_RUN_ID/
// PI_SPIDER_SESSION_ID from its ambient environment. Both fixture builders below
// (`setup`, `freshHost`) load the real spiderExtension, which wires
// @spider/subagents' registerSubagentActions — exactly the function that reads
// those four vars. Stub all four to inert, scratch-scoped values — never inherited
// real ones — the same isolation child-terminal-message.test.ts already applies for
// its own (intentional) attach. PI_SUBAGENT_CHILD is stubbed OFF (empty, not "1"):
// this suite is not testing the child reporter and must not change which actions
// registerSubagentActions mounts. The production ownership guard in
// child-reporter.ts is the real fix; this is only a second layer that keeps this
// harness from ever being able to reach the real DB at all.
const CHILD_ENV_KEYS = ["PI_SUBAGENT_CHILD", "PI_SPIDER_DB_PATH", "PI_SUBAGENT_RUN_ID", "PI_SPIDER_SESSION_ID"] as const;
function stubChildEnv(root: string): void {
  const fixtureValues: Record<(typeof CHILD_ENV_KEYS)[number], string> = {
    PI_SUBAGENT_CHILD: "",
    PI_SPIDER_DB_PATH: join(root, "unused-child-fixture.db"),
    PI_SUBAGENT_RUN_ID: "not-a-real-run-id",
    PI_SPIDER_SESSION_ID: "not-a-real-session-id",
  };
  for (const key of CHILD_ENV_KEYS) vi.stubEnv(key, fixtureValues[key]);
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const db of handles.splice(0)) db.close();
  setGlobalDbPathForTests(null);
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(opts?: { noParentModel?: boolean }) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "fixture-"));
  roots.push(root);
  stubChildEnv(root);
  const cwd = join(root, "selected");
  const unrelated = join(root, "unrelated");
  for (const dir of [cwd, unrelated]) {
    mkdirSync(dir);
    execFileSync("git", ["init", "-q", dir]);
  }
  setGlobalDbPathForTests(join(root, "global.db"));
  vi.spyOn(process, "cwd").mockReturnValue(unrelated);
  controlConfig("set", cwd, "organism.passes.reflection", false);
  controlConfig("set", cwd, "organism.passes.insights", false);
  const session = SessionManager.inMemory(cwd);
  session.appendMessage({ role: "user", content: "Use deterministic tests and record the failing assertion before a fix.", timestamp: 1 });
  const project = resolveProject(cwd, { sessionId: session.getSessionId(), explicitCwd: false });
  const db = openProject(project.projectKey);
  const repoDb = openRepo(project.repoKey!);
  const globalDb = openGlobal();
  handles.push(db, repoDb, globalDb);
  const models = await ModelRuntime.create({
    authPath: join(root, "auth.json"), modelsPath: null,
    modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false,
  });
  models.registerProvider("fixture-provider", {
    api: "anthropic-messages", baseUrl: "https://fixture.invalid", apiKey: "fixture-only",
    models: [{ id: "fixture-model", name: "Fixture", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
  });
  await models.getAvailable("fixture-provider");
  const model = models.getModel("fixture-provider", "fixture-model")!;
  expect(model).toBeDefined();
  const registry = new ModelRegistry(models);
  const answer: AssistantMessage = {
    role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 2,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    content: [{ type: "text", text: JSON.stringify({
      memory: [{ category: "convention", content: "Record the failing assertion before implementing a fix." }],
      skills: [{ name: "deterministic-tests", body: "# Deterministic tests\nVerify the regression with an isolated fixture." }],
      summary: "Verified deterministic regression tests.", selfName: "deterministic-tests",
    }) }],
  };
  const complete = vi.spyOn(models, "complete").mockResolvedValue(answer);
  let shutDown = false;
  const loader = new DefaultResourceLoader({
    cwd, agentDir: join(root, "agent"), settingsManager: SettingsManager.inMemory({}),
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [
      { name: "spider-contract", factory: pi => spiderExtension(pi as never) },
      { name: "cleanup-observer", factory: pi => { pi.on("session_shutdown", () => { shutDown = true; }); } },
    ],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  expect(loaded.errors).toEqual([]);
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, session, registry);
  runner.bindCore({
    ...loaded.runtime,
    getThinkingLevel: () => "low",
    sendMessage: () => {},
    appendEntry: (type, data) => { session.appendCustomEntry(type, data); },
    getSessionName: () => session.getSessionName(),
    setSessionName: name => { session.appendSessionInfo(name); },
  }, {
    getModel: () => (opts?.noParentModel ? undefined : model), getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => true,
    getSignal: () => undefined, abort: () => {}, hasPendingMessages: () => false,
    shutdown: () => {}, getContextUsage: () => undefined, compact: () => {}, getSystemPrompt: () => "Base prompt",
  });
  const errors: string[] = [];
  runner.onError(e => errors.push(e.error));
  cleanups.push(async () => {
    if (!shutDown) await runner.emit({ type: "session_shutdown", reason: "quit" });
    runner.invalidate();
  });
  await runner.emit({ type: "session_start", reason: "startup" });
  return { root, cwd, unrelated, db, repoDb, globalDb, session, runner, registry, complete, models, answer, errors };
}

function compactEvent(session: SessionManager): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact", reason: "manual", willRetry: false,
    signal: new AbortController().signal, branchEntries: session.getBranch(),
    preparation: {
      firstKeptEntryId: session.getLeafId()!, messagesToSummarize: [], turnPrefixMessages: [],
      isSplitTurn: false, tokensBefore: 1000,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    },
  };
}

describe("the installed pi contract through the full spider extension", () => {
  it("makes proposals visible and activates real artifacts only after explicit approval", async () => {
    const f = await setup();
    await f.runner.emit(compactEvent(f.session));
    await vi.waitFor(() => expect(listPending(f.repoDb, "repo")).toHaveLength(1));
    const tool = f.runner.getToolDefinition("spider")!;
    const ctx = f.runner.createContext();
    const listArgs = { action: "skill", op: "list" };
    const listed = await tool.execute("list", listArgs, undefined, undefined, ctx);
    const text = renderSpiderResult(listed, { expanded: true }, {}, { args: listArgs }).render(140).join("\n");
    expect(text).toContain("deterministic-tests");
    expect(text).toContain("staged");
    expect(text).not.toMatch(/\{|"candidateBody"/);

    const before = await f.runner.emitBeforeAgentStart("next", undefined, "Base prompt", { cwd: f.cwd });
    expect(before?.systemPrompt ?? "").not.toContain("Record the failing assertion");
    const pending = listPending(f.repoDb, "repo")[0];
    await tool.execute("approve-memory", { action: "control", command: "memory", sub: "approve", uuid: pending.uuid }, undefined, undefined, ctx);
    const after = await f.runner.emitBeforeAgentStart("next", undefined, "Base prompt", { cwd: f.cwd });
    expect(after?.systemPrompt).toContain("Record the failing assertion");

    const approveArgs = { action: "skill", op: "approve", name: "deterministic-tests" };
    const approved = await tool.execute("approve-skill", approveArgs, undefined, undefined, ctx);
    const details = approved.details as { ok: boolean; row: { path: string; status: string } };
    expect(details.ok).toBe(true);
    expect(details.row.status).toBe("active");
    expect(basename(details.row.path)).toBe("SKILL.md");
    expect(readFileSync(details.row.path, "utf8")).toContain("Verify the regression with an isolated fixture.");
    const card = renderSpiderResult(approved, { expanded: true }, {}, { args: approveArgs }).render(140).join("\n");
    expect(card).not.toMatch(/\{|"candidateBody"/);
  });

  it("honors the real dotted disable switch without a model call or automatic proposal", async () => {
    const f = await setup();
    controlConfig("set", f.cwd, "organism.enabled", false);
    await f.runner.emit({ type: "session_shutdown", reason: "quit" });
    expect(f.complete).not.toHaveBeenCalled();
    expect(listPending(f.repoDb, "repo")).toEqual([]);
    expect(f.db.prepare("SELECT COUNT(*) n FROM run_events WHERE summary LIKE 'organism %'").get()).toEqual({ n: 0 });
  });

  it("does not silently fall back when the configured auxiliary model is unavailable", async () => {
    const f = await setup();
    controlConfig("set", f.cwd, "auxiliary.background_review.provider", "fixture-provider");
    controlConfig("set", f.cwd, "auxiliary.background_review.model", "not-an-available-model");
    await f.runner.emit({ type: "session_shutdown", reason: "quit" });
    expect(f.complete).not.toHaveBeenCalled();
    const row = f.db.prepare("SELECT payload FROM run_events WHERE summary LIKE 'organism drain%' ORDER BY id DESC LIMIT 1").get() as { payload: string };
    expect(JSON.parse(row.payload)).toMatchObject({ status: "failed", errors: [{ phase: "model", message: expect.stringContaining("unavailable") }] });
  });

  it("fails honestly with zero model calls when there is no parent model to mirror and no auxiliary override is configured (G3b)", async () => {
    const f = await setup({ noParentModel: true });
    await f.runner.emit({ type: "session_shutdown", reason: "quit" });
    expect(f.complete).not.toHaveBeenCalled();
    const row = f.db.prepare("SELECT payload FROM run_events WHERE summary LIKE 'organism drain%' ORDER BY id DESC LIMIT 1").get() as { payload: string };
    expect(JSON.parse(row.payload)).toMatchObject({ status: "failed", errors: [{ phase: "model", message: expect.stringContaining("no active model to mirror") }] });
  });

  it("follows a new session binding and records its summary in that worktree", async () => {
    const f = await setup();
    expect(controlBind(f.globalDb, f.session.getSessionId(), f.unrelated).ok).toBe(true);
    const bound = buildActionCtx({} as never, { action: "run" }, f.session.getSessionId(), f.cwd);
    handles.push(bound.db, bound.repoDb, bound.globalDb);
    expect(bound.cwd).toBe(f.unrelated);
    controlConfig("set", f.unrelated, "organism.passes.reflection", false);
    controlConfig("set", f.unrelated, "organism.passes.insights", false);
    await f.runner.emit({ type: "session_shutdown", reason: "quit" });
    const project = resolveProject(f.cwd, { sessionId: f.session.getSessionId(), explicitCwd: false });
    const boundDb = openProject(project.projectKey); handles.push(boundDb);
    const boundRepo = openRepo(project.repoKey!); handles.push(boundRepo);
    expect(listPending(boundRepo, "repo")).toHaveLength(1);
    expect(listPending(f.repoDb, "repo")).toHaveLength(0);
    expect(boundDb.prepare("SELECT summary FROM sessions WHERE id=?").get(f.session.getSessionId()))
      .toEqual({ summary: "Verified deterministic regression tests." });
  });

  it("cancels the in-flight provider request at the shared drain deadline, not a per-pass deadline", async () => {
    const f = await setup();
    vi.useFakeTimers();
    f.complete.mockImplementationOnce(async () => {
      await new Promise<void>(done => setTimeout(done, 20_000));
      return f.answer;
    }).mockImplementationOnce(() => new Promise<AssistantMessage>(() => {}));
    const draining = f.runner.emit({ type: "session_shutdown", reason: "quit" });
    try {
      await vi.advanceTimersByTimeAsync(20_100);
      expect(f.complete).toHaveBeenCalledTimes(2);
      const secondSignal = f.complete.mock.calls[1][2]?.signal;
      await vi.advanceTimersByTimeAsync(10_000);
      await draining;
      expect(secondSignal?.aborted).toBe(true);
    } finally {
      await vi.advanceTimersByTimeAsync(60_000);
      await draining;
      vi.useRealTimers();
    }
  });

  it("shows failed background work in a durable UI entry and doctor instead of a silent zero", async () => {
    const f = await setup();
    f.complete.mockRejectedValue(new Error("Fixture provider unavailable"));
    const event = compactEvent(f.session);
    const originalEntries = event.branchEntries.slice();
    expect(await f.runner.emit(event)).toBeUndefined();
    expect(event.branchEntries).toEqual(originalEntries);
    await vi.waitFor(() => {
      const row = f.db.prepare("SELECT COUNT(*) n FROM run_events WHERE summary LIKE 'organism drain%'").get() as { n: number };
      expect(row.n).toBe(1);
    });
    const entries = f.session.getEntries().filter(e => e.type === "custom" && e.customType === "spider.organism");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ data: { status: "failed", modelCalls: 2 } });
    const renderer = f.runner.getEntryRenderer("spider.organism");
    expect(renderer).toBeTypeOf("function");
    const backgrounds: string[] = [];
    const theme = {
      fg: (_token: string, text: string) => text,
      bg: (token: string, text: string) => { backgrounds.push(token); return text; },
      bold: (text: string) => text,
    };
    const card = renderer!(entries[0] as never, { expanded: true }, theme as never);
    expect(card).toBeDefined();
    const rendered = card!.render(100).join("\n");
    expect(rendered).toContain("failed");
    expect(rendered).toContain("Fixture provider unavailable");
    expect(rendered).not.toContain('"modelCalls"');
    expect(backgrounds).toContain("toolErrorBg");
    const tool = f.runner.getToolDefinition("spider")!;
    expect(tool).toBeDefined();
    const doctor = await tool.execute("doctor", { action: "control", command: "doctor" }, undefined, undefined, f.runner.createContext());
    const text = JSON.stringify(doctor.content);
    expect(text).toContain("organism: failed");
    expect(text).not.toContain("/unrelated/");
    expect(doctor.details).toMatchObject({ ok: false });
    expect(text).toContain("Fixture provider unavailable");
  });

  it("exposes the supported skill review operations in the actual tool schema", () => {
    expect(SPIDER_PARAMETERS.properties.op.enum).toContain("approve");
    expect(SPIDER_PARAMETERS.properties.op.enum).toContain("reject");
    expect(SPIDER_PARAMETERS.properties.op.enum).toContain("distill");
  });

  it("bounds the background request while preserving the most recent conversation", async () => {
    const f = await setup();
    f.session.appendMessage({ role: "user", content: "Earlier context. ".repeat(8000) + "LATEST INSTRUCTION MARKER", timestamp: 3 });
    await f.runner.emit({ type: "session_shutdown", reason: "quit" });
    expect(f.complete).toHaveBeenCalled();
    const text = f.complete.mock.calls[0][1].messages[0].content;
    expect(typeof text).toBe("string");
    expect((text as string).length).toBeLessThanOrEqual(65_000);
    expect(text).toContain("LATEST INSTRUCTION MARKER");
  });

  it("routes actual tool events to the context's session and worktree, not activation cwd", async () => {
    const f = await setup();
    await f.runner.emitToolCall({ type: "tool_call", toolCallId: "call", toolName: "read", input: { path: "README.md" } });
    await f.runner.emitToolResult({ type: "tool_result", toolCallId: "call", toolName: "read", input: { path: "README.md" }, content: [{ type: "text", text: "Fixture read." }], isError: false, details: {} });
    expect(f.errors).toEqual([]);
    expect(f.db.prepare("SELECT session_id, phase FROM events WHERE tool='read' ORDER BY id").all()).toEqual([
      { session_id: f.session.getSessionId(), phase: "before" },
      { session_id: f.session.getSessionId(), phase: "after" },
    ]);
  });

  it("uses the authenticated registry for the active model and stages the learned proposal in the bound repo", async () => {
    const f = await setup();
    await f.runner.emit({ type: "session_shutdown", reason: "quit" });
    expect(f.errors).toEqual([]);
    expect(f.complete).toHaveBeenCalled();
    const [model, context] = f.complete.mock.calls[0];
    expect(model).toMatchObject({ provider: "fixture-provider", id: "fixture-model" });
    expect(context.systemPrompt).toBeTruthy();
    expect(JSON.stringify(context.messages)).toContain("record the failing assertion");
    expect(listPending(f.repoDb, "repo")).toHaveLength(1);
    expect(f.db.prepare("SELECT summary FROM sessions WHERE id=?").get(f.session.getSessionId()))
      .toEqual({ summary: "Verified deterministic regression tests." });
  });
});

/**
 * F2/F3 (organism-review.md) — promoted from organism-review-probe/b-doctor-fresh-runtime.probe.test.ts.
 * A genuinely FRESH pi instance (=> a fresh, independent HostOrganismRuntime, since
 * `organismRuntimes` is keyed by the pi object) is required here, not just a new
 * reader over a synthetic payload — that is exactly the surface `setup()`'s single
 * long-lived runner cannot exercise (its one in-process runtime always short-circuits
 * through `getLastDrain()`).
 */
async function freshHost(root: string, cwd: string, sessionSeed: string) {
  const session = SessionManager.inMemory(cwd);
  session.appendMessage({ role: "user", content: sessionSeed, timestamp: 1 });
  const models = await ModelRuntime.create({
    authPath: join(root, "auth.json"), modelsPath: null,
    modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false,
  });
  models.registerProvider("fixture-provider", {
    api: "anthropic-messages", baseUrl: "https://fixture.invalid", apiKey: "fixture-only",
    models: [{ id: "fixture-model", name: "Fixture", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
  });
  await models.getAvailable("fixture-provider");
  const model = models.getModel("fixture-provider", "fixture-model")!;
  const registry = new ModelRegistry(models);
  const answer: AssistantMessage = {
    role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 2,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    content: [{ type: "text", text: "not json at all \u2014 forces a failed drain" }],
  };
  const complete = vi.spyOn(models, "complete").mockResolvedValue(answer);
  let shutDown = false;
  let piApi: unknown;
  const loader = new DefaultResourceLoader({
    cwd, agentDir: join(root, "agent"), settingsManager: SettingsManager.inMemory({}),
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [
      { name: "spider-fresh", factory: pi => { piApi = pi; spiderExtension(pi as never); } },
      { name: "fresh-observer", factory: pi => { pi.on("session_shutdown", () => { shutDown = true; }); } },
    ],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  expect(loaded.errors).toEqual([]);
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, session, registry);
  runner.bindCore({
    ...loaded.runtime, getThinkingLevel: () => "low", sendMessage: () => {},
    appendEntry: (type, data) => { session.appendCustomEntry(type, data); },
    getSessionName: () => session.getSessionName(),
    setSessionName: name => { session.appendSessionInfo(name); },
  }, {
    getModel: () => model, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => true,
    getSignal: () => undefined, abort: () => {}, hasPendingMessages: () => false,
    shutdown: () => {}, getContextUsage: () => undefined, compact: () => {}, getSystemPrompt: () => "Base",
  });
  cleanups.push(async () => {
    if (!shutDown) await runner.emit({ type: "session_shutdown", reason: "quit" });
    runner.invalidate();
  });
  await runner.emit({ type: "session_start", reason: "startup" });
  return { session, runner, complete, piApi };
}

// Verified non-vacuous by mutation (production already passes this coverage; this is a
// regression guard, NOT a tests-first defect fix): the previously-missing assertions
// pass on the shipped code, and each was individually re-confirmed to FAIL when its
// underlying mechanism (the worktree-wide fallback query / the doctor provenance label)
// was mutated, then restored GREEN — see organism-fix-report.md for the mutation log.
describe("F3 \u2014 a FRESH runtime + the REAL doctor reads a prior real receipt, with explicit provenance (promoted from organism-review-probe)", () => {
  it("a NEW session's real doctor surfaces the prior session's persisted receipt with session+time provenance, never as current, and a different worktree never sees it", async () => {
    mkdirSync(scratch, { recursive: true });
    const root = mkdtempSync(join(scratch, "f3-"));
    roots.push(root);
    stubChildEnv(root);
    const cwd = join(root, "wt-a");
    const other = join(root, "wt-b");
    for (const d of [cwd, other]) { mkdirSync(d); execFileSync("git", ["init", "-q", d]); }
    setGlobalDbPathForTests(join(root, "global.db"));
    vi.spyOn(process, "cwd").mockReturnValue(other);
    controlConfig("set", cwd, "organism.passes.reflection", false);
    controlConfig("set", cwd, "organism.passes.insights", false);

    // Session A: a real drain that fails and persists a real receipt.
    const a = await freshHost(root, cwd, "F3 probe session A seed message");
    const sessionA = a.session.getSessionId();
    await a.runner.emit({ type: "session_shutdown", reason: "quit" });

    // Session B: a genuinely FRESH pi instance + FRESH HostOrganismRuntime (new pi
    // object => new organismRuntimes entry), new session id, SAME worktree DB.
    const b = await freshHost(root, cwd, "F3 probe session B seed message");
    const sessionB = b.session.getSessionId();
    expect(sessionB).not.toBe(sessionA);
    const tool = b.runner.getToolDefinition("spider")!;
    const res = await tool.execute("doctor", { action: "control", command: "doctor" }, undefined, undefined, b.runner.createContext()) as
      { content: unknown; details: { ok?: boolean; lines?: string[] } };
    const text = JSON.stringify(res.content) + "\n" + JSON.stringify(res.details);

    expect(text).toContain("last drain in this worktree");
    expect(text).toContain(sessionA);
    expect(text).not.toMatch(/- organism: failed/); // never rendered as the CURRENT session's own drain
    expect(res.details?.ok).toBe(false);

    // A DIFFERENT worktree must not see it at all.
    const ctxOther = buildActionCtx(b.piApi as never, { action: "control", command: "doctor", cwd: other } as never, sessionB, other);
    handles.push(ctxOther.db, ctxOther.repoDb, ctxOther.globalDb);
    const otherRes = await dispatch({ action: "control", command: "doctor", cwd: other } as never, ctxOther) as { ok: boolean; lines: string[] };
    const otherText = otherRes.lines.join("\n");
    expect(otherText).not.toContain(sessionA);
    expect(otherText).not.toContain("last drain in this worktree");
    expect(otherText).toContain("waiting for compaction or shutdown");
  });
});

// F2 (organism-review.md): genuine RED-first defect fix, not a promotion. Before the
// fix, `buildOrganismDeps(ctx).worker.getLastDrain()` was the first statement inside
// the SAME try block as everything below it, so a throwing resolve() (no active
// session id) skipped readLastDrainReport/getSetupFailure/readLastDrainReportForWorktree
// AND the pending-proposal counts, landing only in the generic "diagnostics unavailable"
// catch-all. P12 required these to remain reachable independently.
describe("F2 \u2014 doctor's receipt fallback and pending counts survive a resolve() failure", () => {
  it("with no active session id, pending-proposal counts and the worktree receipt fallback still run even though buildOrganismDeps(ctx).resolve() throws", async () => {
    mkdirSync(scratch, { recursive: true });
    const root = mkdtempSync(join(scratch, "f2-"));
    roots.push(root);
    stubChildEnv(root);
    const cwd = join(root, "wt");
    mkdirSync(cwd); execFileSync("git", ["init", "-q", cwd]);
    setGlobalDbPathForTests(join(root, "global.db"));
    vi.spyOn(process, "cwd").mockReturnValue(cwd);

    const a = await freshHost(root, cwd, "F2 probe seed message");
    await a.runner.emit({ type: "session_shutdown", reason: "quit" });

    // A doctor invocation with NO active session id: HostOrganismRuntime.resolve()
    // throws ("Organism needs an active pi session") \u2014 the P12/F2 scenario.
    const ctx = buildActionCtx(a.piApi as never, { action: "control", command: "doctor" } as never, "", cwd);
    handles.push(ctx.db, ctx.repoDb, ctx.globalDb);
    const res = await dispatch({ action: "control", command: "doctor" } as never, ctx) as { ok: boolean; lines: string[] };
    const text = res.lines.join("\n");

    expect(text).toContain("organism proposals awaiting review"); // pending counts reachable
    expect(text).toMatch(/last drain in this worktree|- organism: (failed|partial|completed|skipped)/); // receipt fallback reachable
    expect(res.ok).toBe(false); // the failure IS surfaced (not silent)
  });
});
