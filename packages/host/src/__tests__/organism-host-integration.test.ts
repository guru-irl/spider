import { finalSkillBody } from "../../../organism/src/__tests__/helpers/skill.js";
import { SkillStore } from "@spider/organism";
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
import { HostOrganismRuntime } from "../organism-runtime";

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

// vitest.setup.ts clears inherited child identity before this file loads.

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const db of handles.splice(0)) db.close();
  setGlobalDbPathForTests(null);
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(opts?: { noParentModel?: boolean; child?: boolean; noLuna?: boolean; scratchRoot?: string }) {
  const scratchRoot = opts?.scratchRoot ?? scratch;
  mkdirSync(scratchRoot, { recursive: true });
  const root = mkdtempSync(join(scratchRoot, "fixture-"));
  roots.push(root);
  if (opts?.child) vi.stubEnv("PI_SUBAGENT_CHILD", "1");
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
  controlConfig("set", cwd, "skills.reviewer.model", "fixture-provider/fixture-model");
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
  if (!opts?.noLuna) {
    models.registerProvider("github-copilot", {
      api: "openai-responses", baseUrl: "https://fixture.invalid", apiKey: "fixture-only",
      models: [{ id: "gpt-6-luna", name: "Learner fixture", reasoning: true, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    });
    await models.getAvailable("github-copilot");
  }
  await models.getAvailable("fixture-provider");
  const model = models.getModel("fixture-provider", "fixture-model")!;
  expect(model).toBeDefined();
  const registry = new ModelRegistry(models);
  const answer: AssistantMessage = {
    role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 2,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    content: [{ type: "text", text: JSON.stringify({
      memory: [{ category: "convention", content: "Record the failing assertion before implementing a fix.", scope: "repo", justification: "A durable project convention useful to future agents working in this repo.", evidence: "packages/organism/src/passes/learning.ts:1" }],
      skills: [{ name: "deterministic-tests", body: finalSkillBody("deterministic-tests", "Verify the regression with an isolated fixture.") }],
      summary: "Verified deterministic regression tests.", selfName: "deterministic-tests",
    }) }],
  };
  const complete = vi.spyOn(models, "complete").mockImplementation(async (_model, context) =>
    context.systemPrompt?.startsWith("Review a skill candidate.")
      ? { ...answer, content: [{ type: "text", text: '{"verdict":"new","reason":"a reusable testing technique"}' }] }
      : answer);
  // The completion facade now uses the authenticated provider-neutral boundary.
  vi.spyOn(models, "streamSimple").mockImplementation((model, context, options) =>
    ({ result: () => complete(model, context, options as any) }) as any);
  let shutDown = false;
  let piApi: any;
  const loader = new DefaultResourceLoader({
    cwd, agentDir: join(root, "agent"), settingsManager: SettingsManager.inMemory({}),
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [
      { name: "spider-contract", factory: pi => { piApi = pi; spiderExtension(pi as never); } },
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
  return { root, cwd, unrelated, db, repoDb, globalDb, session, runner, registry, complete, models, answer, errors, piApi };
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
  // Break: invalidating the accounting sink before the shutdown drain loses the ending session's calls.
  it("counts the shutdown learner drain and curator before invalidating the ending session", async () => {
    const f = await setup();
    controlConfig("set", f.cwd, "curator.consolidate", true);
    for (const name of ["shutdown-one", "shutdown-two"]) new SkillStore(f.repoDb).upsert({ name, source: "agent", path: "fixture.md" });
    const usage = { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } };
    f.complete.mockResolvedValue({ ...f.answer, usage, content: [{ type: "text", text: "{}" }] });
    await f.runner.emit({ type: "session_shutdown", reason: "quit" });
    expect(f.session.getEntries().filter(e => e.type === "usage").map(e => ({ kind: e.kind, note: e.note, usage: e.usage }))).toEqual([
      { kind: "spider-aux", note: "learner", usage },
      { kind: "spider-aux", note: "learner", usage },
      { kind: "spider-aux", note: "skill-curate", usage },
    ]);
  });

  it("counts learner completions as spider-aux and keeps the captured session on a late response", async () => {
    const f = await setup({ scratchRoot: scratch });
    const usage = { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } };
    f.complete.mockResolvedValueOnce({ ...f.answer, usage, responseModel: "learner-actual", content: [{ type: "text", text: "{}" }] });
    await f.runner.emit(compactEvent(f.session));
    await vi.waitFor(() => expect(f.session.getEntries().filter(e => e.type === "usage")).toContainEqual(expect.objectContaining({ kind: "spider-aux", note: "learner", model: "learner-actual", usage })));
    let finish!: (answer: AssistantMessage) => void;
    f.complete.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.runner.emit(compactEvent(f.session));
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    f.session.newSession();
    finish({ ...f.answer, usage, content: [{ type: "text", text: "{}" }] });
    await pending;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.session.getEntries().filter(e => e.type === "usage")).toEqual([]);
  });

  it("counts asynchronous skill review queue completions as skill-review", async () => {
    const f = await setup({ scratchRoot: scratch });
    const usage = { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } };
    f.complete.mockImplementation(async (_model, context) => context.systemPrompt?.startsWith("Review a skill candidate.")
      ? { ...f.answer, usage, content: [{ type: "text", text: '{"verdict":"new","reason":"reusable"}' }] }
      : { ...f.answer, usage });
    await f.runner.emit(compactEvent(f.session));
    await vi.waitFor(() => expect(new SkillStore(f.repoDb).list({ status: "staged" })).toHaveLength(1));
    expect(f.session.getEntries().filter(e => e.type === "usage")).toContainEqual(expect.objectContaining({ kind: "spider-aux", note: "skill-review", usage }));
  });

  it("labels the curator's model completion as skill-curate rather than learner", async () => {
    const f = await setup({ scratchRoot: scratch }), skills = new SkillStore(f.repoDb);
    for (const name of ["fixture-one", "fixture-two"]) {
      skills.upsert({ name, source: "agent", path: "fixture.md" });
    }
    const usage = { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } };
    f.complete.mockResolvedValueOnce({ ...f.answer, usage, content: [{ type: "text", text: "[]" }] });
    const tool = f.runner.getToolDefinition("spider")!;
    await tool.execute("curate", { action: "control", command: "skill", sub: "curate", force: true, consolidate: true }, undefined, undefined, f.runner.createContext());
    expect(f.session.getEntries().filter(e => e.type === "usage")).toContainEqual(expect.objectContaining({ kind: "spider-aux", note: "skill-curate", usage }));
  });
  it("makes proposals visible and activates real artifacts only after explicit approval", async () => {
    const f = await setup();
    await f.runner.emit(compactEvent(f.session));
    await vi.waitFor(() => expect(listPending(f.repoDb, "repo")).toHaveLength(1));
    await vi.waitFor(() => expect(new SkillStore(f.repoDb).list({ status: "staged" })).toHaveLength(1));
    const tool = f.runner.getToolDefinition("spider")!;
    const ctx = f.runner.createContext();
    const listArgs = { action: "skill", op: "list" };
    const listed = await tool.execute("list", listArgs, undefined, undefined, ctx);
    const text = renderSpiderResult(listed, { expanded: true }, {}, { args: listArgs }).render(140).join("\n");
    expect(text).toContain("deterministic-tests");
    expect(text).toContain("staged");
    expect(text).not.toMatch(/\{|"candidateBody"/);

    const before = await f.runner.emitBeforeAgentStart("next", undefined, { customPrompt: "Base prompt", cwd: f.cwd });
    expect(before.systemPromptOptions.forceSystemPrompt).toBeUndefined();
    expect(before.systemPromptOptions.customPrompt).toBe("Base prompt");
    const pending = listPending(f.repoDb, "repo")[0];
    await tool.execute("approve-memory", { action: "control", command: "memory", sub: "approve", uuid: pending.uuid }, undefined, undefined, ctx);
    const after = await f.runner.emitBeforeAgentStart("next", undefined, { customPrompt: "Base prompt", cwd: f.cwd });
    expect(after.systemPromptOptions.forceSystemPrompt).toContain("Record the failing assertion");

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

  it("uses luna even without a parent model", async () => {
    const f = await setup({ noParentModel: true });
    await f.runner.emit({ type: "session_shutdown", reason: "quit" });
    expect(f.complete).toHaveBeenCalled();
    expect(f.complete.mock.calls[0][0]).toMatchObject({ provider: "github-copilot", id: "gpt-6-luna" });
  });

  it("records unavailable luna as a failed drain instead of falling back to the available parent", async () => {
    const f = await setup({ noLuna: true });
    await f.runner.emit({ type: "session_shutdown", reason: "quit" });
    expect(f.complete).not.toHaveBeenCalled();
    const row = f.db.prepare("SELECT payload FROM run_events WHERE summary LIKE 'organism drain%' ORDER BY id DESC LIMIT 1").get() as { payload: string };
    expect(JSON.parse(row.payload)).toMatchObject({ status: "failed", modelCalls: 0,
      errors: [{ phase: "model", message: expect.stringContaining("github-copilot/gpt-6-luna") }] });
  });

  it.each([
    ["auxiliary.background_review.model", "fixture-provider/fixture-model"],
    ["auxiliary.background_review", { provider: "fixture-provider", model: "fixture-model" }],
    ["auxiliary", { background_review: { provider: "fixture-provider", model: "fixture-model" } }],
  ])("honors an explicit override at %s", async (key, value) => {
    const f = await setup();
    controlConfig("set", f.cwd, key, value);
    await f.runner.emit({ type: "session_shutdown", reason: "quit" });
    expect(f.complete).toHaveBeenCalled();
    expect(f.complete.mock.calls[0][0]).toMatchObject({ provider: "fixture-provider", id: "fixture-model" });
  });

  it("does not resolve a worker, call a model, or write a drain receipt for either child lifecycle event", async () => {
    const resolveWorker = vi.spyOn(HostOrganismRuntime.prototype, "resolve");
    const f = await setup({ child: true });
    await f.runner.emit(compactEvent(f.session));
    await f.runner.emit({ type: "session_shutdown", reason: "quit" });
    expect(resolveWorker).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.db.prepare("SELECT COUNT(*) n FROM run_events WHERE summary LIKE 'organism %'").get()).toEqual({ n: 0 });
    expect(f.session.getEntries().filter(e => e.type === "custom" && e.customType === "spider.organism")).toEqual([]);
  });

  it.each([
    { action: "control", command: "skill", sub: "curate", force: true, consolidate: true },
    { action: "control", command: "insights" },
    { action: "skill", op: "distill", text: "fixture" },
    { action: "skill", op: "approve", name: "fixture" },
    { action: "skill", op: "reject", name: "fixture" },
  ])("refuses manual organism work in a child: $action $command $op", async (args) => {
    const resolveWorker = vi.spyOn(HostOrganismRuntime.prototype, "resolve");
    const f = await setup({ child: true });
    const tool = f.runner.getToolDefinition("spider")!;
    const result = await tool.execute("child-manual", args, undefined, undefined, f.runner.createContext());
    expect(JSON.stringify(result)).toContain("organism is disabled in subagent sessions");
    expect(resolveWorker).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.db.prepare("SELECT COUNT(*) n FROM run_events WHERE summary LIKE 'organism %'").get()).toEqual({ n: 0 });
  });

  it("reviews child skill add with only the reviewer model, without resolving an organism", async () => {
    const resolveWorker = vi.spyOn(HostOrganismRuntime.prototype, "resolve");
    const f = await setup({ child: true });
    // Any attempt to inspect the registry for skill access is a regression.
    const catalog = vi.spyOn(f.registry, "getAvailable").mockImplementation(() => { throw new Error("unexpected model construction"); });
    const tool = f.runner.getToolDefinition("spider")!;
    const ctx = f.runner.createContext();
    const staged = await tool.execute("add", { action: "skill", op: "add", name: "child-fixture", text: finalSkillBody("child-fixture", "Use deterministic fixtures.") }, undefined, undefined, ctx);
    expect(staged.details).toMatchObject({ ok: true, outcome: "staged" });
    const listed = await tool.execute("list", { action: "skill", op: "list" }, undefined, undefined, ctx);
    expect(listed.details).toEqual(expect.arrayContaining([expect.objectContaining({ name: "child-fixture", status: "staged" })]));
    const viewed = await tool.execute("view", { action: "skill", op: "view", name: "child-fixture" }, undefined, undefined, ctx);
    expect(viewed.details).toMatchObject({ name: "child-fixture", status: "staged", candidateBody: finalSkillBody("child-fixture", "Use deterministic fixtures.") });
    expect(f.repoDb.prepare("SELECT name FROM skills WHERE name='child-fixture'").get()).toEqual({ name: "child-fixture" });
    expect(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skills'").get()).toBeUndefined();
    expect(resolveWorker).not.toHaveBeenCalled();
    expect(catalog).not.toHaveBeenCalled();
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.complete.mock.calls[0][0]).toMatchObject({ provider: "fixture-provider", id: "fixture-model" });
    const invalid = await tool.execute("invalid", { action: "skill", op: "add", name: "bad/child", text: "no metadata" }, undefined, undefined, ctx);
    expect(invalid.details).toMatchObject({ outcome: "rejected", verdict: "deterministic_failure" });
    expect(f.complete).toHaveBeenCalledTimes(1);
  });

  it("reports the organism as disabled in a child without reading a parent's failed drain", async () => {
    const f = await setup({ child: true });
    f.db.prepare("INSERT INTO run_events(session_id, ts, type, summary, payload) VALUES (?,1,'log','organism drain (shutdown): failed',?)").run("parent-session", JSON.stringify({ kind: "organism-drain", sessionId: "parent-session", reason: "shutdown", status: "failed", startedAt: 1, finishedAt: 1, modelCalls: 0, memoryStaged: 0, skillsStaged: 0, todosAdded: 0, dropped: 0, rejected: 0, inputs: { messages: 0, runs: 0, runEvents: 0, events: 0, completedTodos: 0 }, errors: [{ phase: "model", message: "parent failure" }] }));
    const tool = f.runner.getToolDefinition("spider")!;
    const doctor = await tool.execute("doctor", { action: "control", command: "doctor" }, undefined, undefined, f.runner.createContext());
    const text = JSON.stringify(doctor.content);
    expect(text).toContain("organism: disabled in subagent sessions");
    expect(text).not.toContain("waiting for compaction");
    expect(text).not.toContain("parent failure");
    expect(text).not.toContain("last drain in this worktree");
    expect(doctor.details).toMatchObject({ ok: true });
  });

  it("resolves a bare override only by exact catalog id, not the session provider", async () => {
    const f = await setup();
    controlConfig("set", f.cwd, "auxiliary.background_review.model", "gpt-6-luna");
    await f.runner.emit({ type: "session_shutdown", reason: "quit" });
    expect(f.complete.mock.calls[0][0]).toMatchObject({ provider: "github-copilot", id: "gpt-6-luna" });
  });

  it("refuses an ambiguous bare override instead of choosing the session provider", async () => {
    const f = await setup();
    f.models.registerProvider("fixture-provider", {
      api: "anthropic-messages", baseUrl: "https://fixture.invalid", apiKey: "fixture-only",
      models: [{ id: "gpt-6-luna", name: "Ambiguous learner", reasoning: true, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    });
    await f.models.getAvailable("fixture-provider");
    controlConfig("set", f.cwd, "auxiliary.background_review.model", "gpt-6-luna");
    await f.runner.emit({ type: "session_shutdown", reason: "quit" });
    expect(f.complete).not.toHaveBeenCalled();
    const row = f.db.prepare("SELECT payload FROM run_events WHERE summary LIKE 'organism drain%' ORDER BY id DESC LIMIT 1").get() as { payload: string };
    expect(JSON.parse(row.payload)).toMatchObject({ status: "failed", modelCalls: 0, errors: [{ phase: "model", message: expect.stringContaining("unavailable or ambiguous") }] });
  });

  it.each(["gpt-6", "luna"])("does not resolve a partial bare override %s", async (model) => {
    const f = await setup();
    controlConfig("set", f.cwd, "auxiliary.background_review.model", model);
    await f.runner.emit({ type: "session_shutdown", reason: "quit" });
    expect(f.complete).not.toHaveBeenCalled();
    const row = f.db.prepare("SELECT payload FROM run_events WHERE summary LIKE 'organism drain%' ORDER BY id DESC LIMIT 1").get() as { payload: string };
    expect(JSON.parse(row.payload)).toMatchObject({ status: "failed", modelCalls: 0, errors: [{ phase: "model", message: expect.stringContaining("unavailable or ambiguous") }] });
  });

  it.each(["github-copilot", "fixture-provider"])("keeps luna for a provider-only override %s", async (provider) => {
    const f = await setup();
    controlConfig("set", f.cwd, "auxiliary.background_review.provider", provider);
    await f.runner.emit({ type: "session_shutdown", reason: "quit" });
    if (provider === "github-copilot") {
      expect(f.complete.mock.calls[0][0]).toMatchObject({ provider: "github-copilot", id: "gpt-6-luna" });
    } else {
      expect(f.complete).not.toHaveBeenCalled();
      const row = f.db.prepare("SELECT payload FROM run_events WHERE summary LIKE 'organism drain%' ORDER BY id DESC LIMIT 1").get() as { payload: string };
      expect(JSON.parse(row.payload)).toMatchObject({ status: "failed", modelCalls: 0, errors: [{ phase: "model", message: expect.stringContaining("fixture-provider/gpt-6-luna") }] });
    }
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

  it("uses authenticated streamSimple without requiring raw complete, with low thinking and staged proposals", async () => {
    const f = await setup();
    Object.defineProperty(f.registry, "complete", { value: undefined });
    await f.runner.emit({ type: "session_shutdown", reason: "quit" });
    expect(f.errors).toEqual([]);
    expect(f.complete).toHaveBeenCalled();
    const [model, context] = f.complete.mock.calls[0];
    expect(model).toMatchObject({ provider: "github-copilot", id: "gpt-6-luna" });
    expect(f.complete.mock.calls[0][2]).toMatchObject({ reasoning: "low" });
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
  controlConfig("set", cwd, "auxiliary.background_review.model", "fixture-provider/fixture-model");
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
      const cwd = join(root, "wt-a");
    const other = join(root, "wt-b");
    for (const d of [cwd, other]) { mkdirSync(d); execFileSync("git", ["init", "-q", d]); }
    setGlobalDbPathForTests(join(root, "global.db"));
    vi.spyOn(process, "cwd").mockReturnValue(other);
    controlConfig("set", cwd, "organism.passes.reflection", false);
    controlConfig("set", cwd, "organism.passes.insights", false);
  controlConfig("set", cwd, "skills.reviewer.model", "fixture-provider/fixture-model");

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
      const cwd = join(root, "wt");
    mkdirSync(cwd); execFileSync("git", ["init", "-q", cwd]);
    setGlobalDbPathForTests(join(root, "global.db"));
    vi.spyOn(process, "cwd").mockReturnValue(cwd);

    const a = await freshHost(root, cwd, "F2 probe seed message");
    await a.runner.emit({ type: "session_shutdown", reason: "quit" });

    // Shutdown clears action closures. Use a fresh activation for this doctor
    // invocation, but still supply NO active session id: the P12/F2 scenario.
    const b = await freshHost(root, cwd, "F2 post-shutdown probe");
    const ctx = buildActionCtx(b.piApi as never, { action: "control", command: "doctor" } as never, "", cwd);
    handles.push(ctx.db, ctx.repoDb, ctx.globalDb);
    const res = await dispatch({ action: "control", command: "doctor" } as never, ctx) as { ok: boolean; lines: string[] };
    const text = res.lines.join("\n");

    expect(text).toContain("organism proposals awaiting review"); // pending counts reachable
    expect(text).toMatch(/last drain in this worktree|- organism: (failed|partial|completed|skipped)/); // receipt fallback reachable
    expect(res.ok).toBe(false); // the failure IS surfaced (not silent)
  });
});

it("organism queued reviewer includes pi-loaded catalog and doctor shows queue and recent results", async () => {
  const f = await setup();
  controlConfig("set", f.cwd, "skills.reviewer.thinking", "medium");
  vi.spyOn(f.piApi, "getCommands").mockReturnValue([{ name: "skill:external-reference", source: "skill", description: "Use when tracing external writers" }]);
  f.complete.mockImplementation(async (_m, context) => context.systemPrompt?.startsWith("Review a skill candidate.")
    ? { ...f.answer, content: [{ type: "text", text: '{"verdict":"duplicate","existing_name":"external-reference","reason":"same method"}' }] } : f.answer);
  // Drain independently to inspect durable queued work before the live hook starts its runner.
  const runtime = new HostOrganismRuntime(async () => null, undefined, () => [{ name: "external-reference", description: "Use when tracing external writers" }]);
  const deps = runtime.fromContext(f.runner.createContext());
  try {
    await deps.worker.runDrain(f.session.getSessionId(), "before_compact", { transcript: [{ role: "user", content: "Trace writer ownership" }] });
    const tool = f.runner.getToolDefinition("spider")!;
    const doctor = await tool.execute("queue", { action: "control", command: "doctor" }, undefined, undefined, f.runner.createContext());
    expect(JSON.stringify(doctor.content)).toContain("skill review queue: 1");
    deps.worker.startSkillReviews();
    await vi.waitFor(() => expect(f.repoDb.prepare("SELECT count(*) n FROM skill_review_queue").get()).toEqual({ n: 0 }));
    const call = f.complete.mock.calls.find(call => call[1].systemPrompt?.startsWith("Review a skill candidate."))!;
    expect(call[2]).toMatchObject({ reasoning: "medium" });
    expect(JSON.parse(call[1].messages[0].content as string).existing_skills).toEqual(expect.arrayContaining([{ name: "external-reference", description: "Use when tracing external writers" }]));
    const result = await tool.execute("recent", { action: "control", command: "doctor" }, undefined, undefined, f.runner.createContext());
    expect(JSON.stringify(result.content)).toContain("duplicate: same method");
  } finally { await deps.worker.stopSkillReviews(); runtime.dispose(); }
});

it("shutdown cancels queue reviewers from every previously bound repo before closing their DBs", async () => {
  const f = await setup();
  const registry = { find: () => ({ provider: "fixture-provider", id: "fixture-model" }), complete: async () => new Promise<never>(() => {}), streamSimple: () => ({ result: () => new Promise<never>(() => {}) }) };
  const runtime = new HostOrganismRuntime(async () => null);
  const old = runtime.resolve({ sessionId: f.session.getSessionId(), cwd: f.cwd, modelRegistry: registry });
  old.db.prepare("INSERT INTO skill_review_queue(name,body,origin,created_at) VALUES (?,?,?,1)").run("queued-example", finalSkillBody("queued-example", "Trace ownership."), "learner");
  old.worker.startSkillReviews();
  runtime.resolve({ sessionId: f.session.getSessionId(), cwd: f.unrelated, modelRegistry: registry });
  await runtime.stopSkillReviews();
  expect(old.db.prepare("SELECT attempts,last_error FROM skill_review_queue").get()).toEqual({ attempts: 0, last_error: null });
  runtime.dispose();
});

it("real shutdown aborts a previous binding's review before starting the current binding's learner", async () => {
  const resolveRuntime = vi.spyOn(HostOrganismRuntime.prototype, "resolve");
  const f = await setup();
  const old = resolveRuntime.mock.results.find(result => result.type === "return")!.value as ReturnType<HostOrganismRuntime["resolve"]>;
  old.db.prepare("INSERT INTO skill_review_queue(name,body,origin,created_at) VALUES (?,?,?,1)").run("queued-example", finalSkillBody("queued-example", "Trace ownership."), "learner");
  f.complete.mockImplementation(async (_m, context) => {
    if (context.systemPrompt?.startsWith("Review a skill candidate.")) return new Promise<AssistantMessage>(() => {});
    expect(old.db.prepare("SELECT attempts,last_error FROM skill_review_queue WHERE name='queued-example'").get()).toEqual({ attempts: 0, last_error: null });
    return f.answer;
  });
  old.worker.startSkillReviews();
  await vi.waitFor(() => expect(f.complete).toHaveBeenCalledTimes(1));
  controlBind(f.globalDb, f.session.getSessionId(), f.unrelated);
  await f.runner.emit({ type: "session_shutdown", reason: "quit" });
  expect(f.errors).toEqual([]);
  const bound = resolveProject(f.unrelated, { sessionId: f.session.getSessionId() });
  const boundDb = openRepo(bound.repoKey!); handles.push(boundDb);
  expect(listPending(boundDb, "repo")).toHaveLength(1);
});

it("a skill-only drain emits a UI receipt that counts queued, not staged, skills", async () => {
  const f = await setup();
  f.complete.mockImplementation(async (_m, context) => context.systemPrompt?.startsWith("Review a skill candidate.")
    ? { ...f.answer, content: [{ type: "text", text: '{"verdict":"new","reason":"reusable"}' }] }
    : { ...f.answer, content: [{ type: "text", text: JSON.stringify({ memory: [], todos: [], skills: [{ name: "queued-technique", body: finalSkillBody("queued-technique", "Trace writer ownership.") }] }) }] });
  await f.runner.emit(compactEvent(f.session));
  await vi.waitFor(() => expect(f.db.prepare("SELECT count(*) n FROM run_events WHERE summary LIKE 'organism drain%'").get()).toEqual({ n: 1 }));
  const entry = f.session.getEntries().find(e => e.type === "custom" && e.customType === "spider.organism");
  expect(entry).toMatchObject({ data: { skillsQueued: 1, skillsStaged: 0 } });
  const renderer = f.runner.getEntryRenderer("spider.organism")!;
  const theme = { fg: (_t: string, text: string) => text, bg: (_t: string, text: string) => text, bold: (text: string) => text };
  const text = renderer(entry as never, { expanded: true }, theme as never)!.render(140).join("\n");
  expect(text).toContain("1 skills queued"); expect(text).not.toContain("0 skills staged");
});
