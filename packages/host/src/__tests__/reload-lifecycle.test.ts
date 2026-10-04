import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDbAt, type Db } from "@spider/db-core";
import spiderExtension from "../extension";
import { getAction, registerAction, clearActions } from "../dispatch";
import * as context from "@spider/context";
import { loadEmbedder, isEmbedderLoaded } from "../embeddings";
import { consumeToolCallError } from "../result";
import { startEmbedderSession } from "@spider/memory";

// Replace only model initialization. Real factories, registrations, recall, DBs,
// and shutdown handlers run unchanged. No downloads, inference, or model calls.
const models = vi.hoisted(() => ({ inits: 0 }));
vi.mock("fastembed", () => ({
  EmbeddingModel: { BGESmallENV15: "fixture" },
  FlagEmbedding: { init: async () => {
    models.inits++;
    return { async *embed(texts: string[]) { yield texts.map(() => new Float32Array(384)); } };
  } },
}));

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { providerWorker } = await import("../../../memory/src/__tests__/helpers/provider-worker");
  const Base = providerWorker(() => import("fastembed"));
  return { ...actual, spawn: () => new Base() };
});

function fakePi() {
  const commands = new Map<string, { handler: (...args: any[]) => unknown }>();
  const hooks = new Map<string, ((...args: any[]) => unknown)[]>();
  const tools = new Map<string, { name: string; execute: (...args: any[]) => Promise<any> }>();
  const shortcuts = new Map<string, { handler: (...args: any[]) => unknown }>();
  const renderers = new Set<string>();
  return {
    commands, hooks, tools, shortcuts, renderers,
    registerTool: (t: any) => { tools.set(t.name, t); },
    registerCommand: (name: string, def: any) => { expect(commands.has(name)).toBe(false); commands.set(name, def); },
    registerShortcut: (name: string, def: any) => { expect(shortcuts.has(name)).toBe(false); shortcuts.set(name, def); },
    registerMessageRenderer: (name: string) => { renderers.add(name); },
    registerEntryRenderer: (name: string) => { renderers.add(name); },
    on: (name: string, fn: (...args: any[]) => unknown) => { hooks.set(name, [...hooks.get(name) ?? [], fn]); },
    async emit(name: string, ctx?: unknown) { for (const fn of hooks.get(name) ?? []) await fn({}, ctx); },
  };
}
let scratch: string;
const dbs: Db[] = [];
const hosts: ReturnType<typeof fakePi>[] = [];
const globalCache = globalThis as typeof globalThis & Record<symbol, unknown>;
const embedderKey = Symbol.for("spider.embedder.v3:BGE-small-en-v1.5");
beforeEach(() => {
  startEmbedderSession();
  delete globalCache[embedderKey];
  models.inits = 0;
  const base = resolve(".spider/scratch/build-id");
  mkdirSync(base, { recursive: true });
  scratch = mkdtempSync(join(base, "lifecycle-"));
  vi.stubEnv("GIT_CEILING_DIRECTORIES", base);
  vi.stubEnv("PI_SUBAGENT_CHILD", "1"); // No organism work during lifecycle probes.
});
afterEach(async () => {
  for (const pi of hosts.splice(0)) await pi.emit("session_shutdown");
  clearActions();
  for (const db of dbs.splice(0)) db.close();
  delete globalCache[embedderKey];
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(scratch, { recursive: true, force: true });
});
const host = () => { const pi = fakePi(); hosts.push(pi); spiderExtension(pi as never); return pi; };
const toolCtx = (id: string) => ({ cwd: scratch, sessionManager: { getSessionId: () => `${scratch}:${id}` } });

it("registers every command, shortcut, tool, renderer and handler on both factory calls in the same module", async () => {
  const first = host();
  await first.emit("session_shutdown");
  const second = host();
  const expectedCommands = ["agents", "bind", "doctor", "exec-enforce", "insights", "learn", "memory", "search", "spider", "stats", "todos"];
  for (const pi of [first, second]) {
    expect([...pi.commands.keys()].sort()).toEqual(expectedCommands);
    expect([...pi.shortcuts.keys()]).toEqual(["alt+shift+up"]);
  }
  expect([...second.tools.keys()]).toEqual([...first.tools.keys()]);
  expect(second.renderers).toEqual(first.renderers);
  expect([...second.hooks].map(([name, fns]) => [name, fns.length])).toEqual([...first.hooks].map(([name, fns]) => [name, fns.length]));
});

it("a shutdown stops the worker and a new activation reloads from the model cache", async () => {
  const pi = host();
  const db = openDbAt(join(scratch, "repo.db"), "repo"); dbs.push(db);
  const ctx = { repoDb: db, globalDb: db } as never;
  await getAction("recall")!({ action: "recall", query: "fixture" }, ctx);
  await getAction("recall")!({ action: "recall", query: "fixture" }, ctx);
  await loadEmbedder();
  expect(models.inits).toBe(1);
  await pi.emit("session_shutdown");
  const next = host();
  await next.emit("session_start", toolCtx("next"));
  await getAction("recall")!({ action: "recall", query: "fixture" }, ctx);
  await loadEmbedder();
  expect(models.inits).toBe(2);
});

it("the legacy embedding entry point shares recall's worker until shutdown", async () => {
  const pi = host();
  const first = await loadEmbedder();
  expect(isEmbedderLoaded()).toBe(true);
  const db = openDbAt(join(scratch, "repo.db"), "repo"); dbs.push(db);
  await getAction("recall")!({ action: "recall", query: "fixture" }, { repoDb: db, globalDb: db } as never);
  await pi.emit("session_shutdown");
  expect(isEmbedderLoaded()).toBe(false);
  expect(await loadEmbedder()).toBeNull();
  expect(models.inits).toBe(1);
  const next = host(); await next.emit("session_start", toolCtx("next"));
  expect(await loadEmbedder()).not.toBe(first);
  expect(models.inits).toBe(2);
});

it("clears cached action closures owned by the shutting-down activation", async () => {
  const pi = host();
  expect(getAction("recall")).toBeTypeOf("function");
  await pi.emit("session_shutdown");
  expect(getAction("recall")).toBeUndefined();
});

it("A's shutdown preserves B's todo handler in two overlapping activations", async () => {
  const a = host(); const b = host();
  const contextActions = ["exec", "exec_file", "batch", "index", "fetch", "search", "import"];
  const bHandlers = contextActions.map(name => getAction(name));
  await a.emit("session_shutdown");
  for (const [i, name] of contextActions.entries()) {
    expect(getAction(name), `B's ${name} handler must survive A's shutdown`).toBe(bHandlers[i]);
  }
  const result = await b.tools.get("spider")!.execute("b-todo", { action: "todo", op: "list" }, undefined, undefined, toolCtx("b"));
  expect(result.isError).toBe(false);
  expect(result.details).toEqual([]);
  await b.emit("session_shutdown");
  expect(getAction("todo")).toBeUndefined();
});

it.each(["A", "B"])("overlapping activations dispatch their own closures when %s shuts down first", async firstShutdown => {
  let registrations = 0;
  // Replace the network action at registration, retaining real activation,
  // dispatcher, tool, slash-command and shutdown paths. Each closure has state.
  vi.spyOn(context, "registerContextActions").mockImplementation(register => {
    const activation = ++registrations === 1 ? "A" : "B";
    let calls = 0;
    register("search", () => ({ content: `${activation}:${++calls}`, details: { activation, calls } }));
  });
  const a = host(); const b = host();
  const call = (pi: ReturnType<typeof fakePi>, id: string) => pi.tools.get("spider")!.execute(
    id + "-search", { action: "search", query: "fixture" }, undefined, undefined, toolCtx(id));
  expect((await call(a, "a")).details).toEqual({ activation: "A", calls: 1 });
  expect((await call(b, "b")).details).toEqual({ activation: "B", calls: 1 });
  // An external replacement must not hijack either activation's own action.
  registerAction("search", () => ({ content: "external search", details: "wrong handler" }));
  expect((await call(a, "a")).details).toEqual({ activation: "A", calls: 2 });
  expect((await call(b, "b")).details).toEqual({ activation: "B", calls: 2 });
  const slash = async (pi: ReturnType<typeof fakePi>, id: string, expected: string) => {
    const notify = vi.fn();
    await pi.commands.get("search")!.handler("fixture", { ...toolCtx(id), ui: { notify } });
    expect(notify).toHaveBeenCalledWith(expected, "info");
  };
  await slash(a, "a", "A:3");
  await slash(b, "b", "B:3");
  const survivor = firstShutdown === "A" ? b : a;
  const stopped = firstShutdown === "A" ? a : b;
  const remaining = firstShutdown === "A" ? "B" : "A";
  await stopped.emit("session_shutdown");
  expect((await call(survivor, "survivor")).details).toEqual({ activation: remaining, calls: 4 });
  await slash(survivor, "survivor", `${remaining}:5`);
  const todo = await survivor.tools.get("spider")!.execute("survivor-todo", { action: "todo", op: "list" }, undefined, undefined, toolCtx("survivor"));
  expect(todo.isError).toBe(false);
  expect(todo.details).toEqual([]);
});

it("does not borrow another activation's handler for an action absent from its own map", async () => {
  let registrations = 0;
  vi.spyOn(context, "registerContextActions").mockImplementation(register => {
    if (++registrations === 1) register("search", () => ({ details: "A-only closure" }));
  });
  const a = host(); const b = host();
  const call = (pi: ReturnType<typeof fakePi>, id: string) => pi.tools.get("spider")!.execute(
    id + "-search", { action: "search", query: "fixture" }, undefined, undefined, toolCtx(id));
  expect((await call(a, "a-only")).details).toBe("A-only closure");
  const result = await call(b, "b-missing");
  expect(result.isError).toBe(true);
  expect(result.details.error).toContain("no registered handler");
});

it("falls back to externally registered actions absent from the activation's own map", async () => {
  const pi = host(); // Child mode does not register run, message or kill.
  registerAction("run", () => ({ details: "external fixture action" }));
  const result = await pi.tools.get("spider")!.execute("external-run", { action: "run" }, undefined, undefined, toolCtx("external"));
  expect(result.isError).toBe(false);
  expect(result.details).toBe("external fixture action");
});

it("shutdown clears only the activation's pending tool error marks, including edit/write", async () => {
  const a = host(); const b = host();
  for (const pi of [a, b]) {
    const id = pi === a ? "a" : "b";
    await pi.tools.get("spider")!.execute(id + "-spider", { action: "recall", scope: "project", cwd: scratch }, undefined, undefined, toolCtx(id));
    await pi.tools.get("edit")!.execute(id + "-edit", {}, undefined, undefined, toolCtx(id));
    await pi.tools.get("write")!.execute(id + "-write", {}, undefined, undefined, toolCtx(id));
  }
  await a.emit("session_shutdown");
  for (const tool of ["spider", "edit", "write"]) {
    expect(consumeToolCallError("a-" + tool)).toBe(false);
    expect(consumeToolCallError("b-" + tool)).toBe(true);
  }
});

it("cleanup runs in finally when a routing db.close throws", async () => {
  const pi = host();
  await pi.emit("session_start", toolCtx("throw-close"));
  // A tracked call opens the real per-activation routing DB. Substitute only
  // its close operation, not registration, action dispatch or cleanup.
  const dbCore = await import("@spider/db-core");
  const open = vi.spyOn(dbCore, "openProject");
  for (const fn of pi.hooks.get("tool_call") ?? []) await fn({ toolName: "read", input: {} });
  const routingDb = open.mock.results.find(r => r.type === "return")!.value as Db;
  open.mockRestore();
  const close = vi.spyOn(routingDb, "close").mockImplementation(() => { throw new Error("fixture db close failed"); });
  await pi.tools.get("edit")!.execute("throw-close-mark", {}, undefined, undefined, toolCtx("throw-close"));
  try {
    await expect(pi.emit("session_shutdown")).rejects.toThrow("fixture db close failed");
    expect(getAction("todo")).toBeUndefined();
    expect(consumeToolCallError("throw-close-mark")).toBe(false);
  } finally { close.mockRestore(); routingDb.close(); }
});

it("keeps agents command handlers local to each pi activation across UI remounts", async () => {
  const first = host();
  const second = host();
  // Factories were registered in child mode, so no organism hooks can make model
  // calls. UI mounting itself is parent-only and must be tested in parent mode.
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  const ui = () => ({ setWidget() {}, custom: async () => {}, notify: vi.fn() });
  const ctx = (id: string, view: ReturnType<typeof ui>) => ({ cwd: scratch, hasUI: true,
    sessionManager: { getSessionId: () => id, getEntries: () => [], getBranch: () => [] }, ui: view });
  const oldView = ui(); const newView = ui(); const otherView = ui();
  await first.emit("session_start", ctx("first-old", oldView));
  await first.emit("session_start", ctx("first-new", newView));
  await second.emit("session_start", ctx("second", otherView));
  first.commands.get("agents")?.handler("", {});
  second.commands.get("agents")?.handler("", {});
  expect(oldView.notify).not.toHaveBeenCalled();
  expect(newView.notify).toHaveBeenCalledWith("No active spider agents", "info");
  expect(otherView.notify).toHaveBeenCalledWith("No active spider agents", "info");
});
