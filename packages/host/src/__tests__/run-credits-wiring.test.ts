import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { setGlobalDbPathForTests, type Db } from "@spider/db-core";
import { RunStore, recordRunUsage } from "@spider/subagents";
import spiderExtension, { buildActionCtx } from "../extension";
import { mountAgentsUI } from "../agents/mount";
import { makeAsyncNotifier } from "../../../subagents/src/actions/run";
import { assertPreflightIsolation, assertPostOpenIsolation, gitInit } from "./fixture-safety";
const state = vi.hoisted(() => ({ factor: 2 }));
// The external worker boundary is replaced, not the host conversion or renderers.
vi.mock("../usage/mount", () => ({ registerUsage: () => ({ reload() {}, doctor: async () => ({ ok: true, lines: [] }),
  snapshot: () => ({ calibration: { status: "calibrated", factor: state.factor } }) }) }));
const handles: Db[] = [], roots: string[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) { try { db.close(); } catch {} }
  setGlobalDbPathForTests(null); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s, italic: (s: string) => s };
const usage = { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 1200,
  cost: { input: 0.2, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.3 } };
function fixture() {
  const scratch = resolve(".spider/scratch/credits-tui"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "wiring-")); roots.push(root); gitInit(root); assertPreflightIsolation(root, root);
  setGlobalDbPathForTests(join(root, "global.db"));
  const tools: any[] = [], hooks = new Map<string, Function[]>(), commands = new Map<string, any>();
  const pi = { on: (name: string, callback: Function) => { const list = hooks.get(name) ?? []; list.push(callback); hooks.set(name, list); },
    registerTool: (tool: any) => tools.push(tool), registerCommand: (name: string, def: any) => commands.set(name, def) };
  vi.stubEnv("PI_SUBAGENT_CHILD", "1"); spiderExtension(pi); vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  const ctx = buildActionCtx(pi, { action: "run" }, "owner", root); handles.push(ctx.db, ctx.repoDb, ctx.globalDb);
  assertPostOpenIsolation(ctx, { worktree: root, repo: root, global: root });
  const runs = new RunStore(ctx.db), { id } = runs.create({ sessionId: "owner", agent: "worker" });
  recordRunUsage(ctx.db, id, { provider: "github-copilot", model: "fixture", usage });
  return { root, pi, tools, ctx, runs, id, hooks, commands };
}
// Break: buildActionCtx fails to supply the host conversion or freezes a factor at dispatch time.
it("injects latest snapshot credits into async completions from production action contexts", () => {
  state.factor = 2; const f = fixture(), messages: any[] = [];
  const notify = makeAsyncNotifier({ ...f.ctx, pi: { sendMessage: (message: any) => messages.push(message) } });
  state.factor = 3;
  notify(f.runs.get(f.id), "done", "fixture output");
  expect(messages[0].content.split("\n")[1]).toBe("1,200 tokens · 90 credits");
});
// Break: the actual registered tool renderer does not receive the live host converter.
it("injects snapshot calibration into the registered run-card renderer", () => {
  state.factor = 2; const f = fixture();
  const result = { details: { run: { status: "done", token_count: 1200, cost: 0.3,
    usageCosts: [{ provider: "github-copilot", cost: 0.3 }] } } };
  const rendered = f.tools.find(tool => tool.name === "spider").renderResult(result, { expanded: true }, theme, { args: { action: "run" } });
  expect(rendered.render(120).join("\n")).toContain("1.2k tokens · 60 credits");
  state.factor = 3;
  expect(rendered.render(120).join("\n")).toContain("1.2k tokens · 90 credits");
});
// Break: mountAgentsUI or installAgentsUI drops the injected formatter before AgentStore.
it("threads the host formatter through production agents mounting to the drilled detail", () => {
  const f = fixture(); let widget: any, selector: any, finish!: () => void;
  const ui = { setWidget: (_key: string, value: any) => { if (value) widget = value; }, notify() {},
    custom: <T>(factory: any) => new Promise<T>(resolve => { finish = () => resolve(undefined as T); selector = factory({ requestRender() {} }, theme, {}, resolve); }) };
  let open!: () => void;
  const pi = { registerCommand: (_name: string, def: any) => { open = def.handler; }, registerShortcut() {} };
  const dispose = mountAgentsUI(pi, { ui }, { db: f.ctx.db, sessionId: "owner", cwd: f.root, formatRunCost: () => "60 credits" });
  const component = widget({ requestRender() {} }, theme);
  try {
    open(); selector.handleInput("\r");
    expect(component.render(120).join("\n")).toContain("1.2k tokens · 60 credits");
  } finally { finish?.(); component.dispose?.(); dispose(); }
});

// Break: the extension's real session mount forgets the formatter, even though a manual mount works.
it("calibrates the agents detail through the extension session-start mount", async () => {
  state.factor = 2; const f = fixture(); let widget: any, selector: any, finish!: () => void;
  const ui = { setWidget: (_key: string, value: any) => { if (value) widget = value; }, notify() {},
    custom: <T>(factory: any) => new Promise<T>(resolve => { finish = () => resolve(undefined as T); selector = factory({ requestRender() {} }, theme, {}, resolve); }) };
  const ctx = { cwd: f.root, mode: "rpc", hasUI: true, ui, sessionManager: { getSessionId: () => "owner" } };
  let component: any;
  try {
    for (const hook of f.hooks.get("session_start") ?? []) await hook({}, ctx);
    component = widget({ requestRender() {} }, theme);
    f.commands.get("agents").handler(); selector.handleInput("\r");
    expect(component.render(120).join("\n")).toContain("1.2k tokens · 60 credits");
    state.factor = 3;
    expect(component.render(120).join("\n")).toContain("1.2k tokens · 90 credits");
  } finally {
    finish?.(); component?.dispose?.();
    for (const hook of f.hooks.get("session_shutdown") ?? []) await hook({}, ctx);
  }
});
