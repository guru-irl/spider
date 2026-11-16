import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createReplica } from "@spider/db-core/testutil";
import { registerAutoReload } from "../../auto-reload.js";
import { trackReloadActivity } from "../../reload-activity.js";
import { inspectBlockers, type BlockerPorts } from "../blockers.js";

afterEach(() => vi.unstubAllEnvs());

function activation(sessionId: string) {
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  const replica = createReplica("worktree", "11111111-1111-4111-8111-111111111111");
  const hooks = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const commands = new Map<string, { handler: (...args: any[]) => unknown }>();
  const entries: any[] = [];
  let closeOverlay!: () => void;
  const ctx = {
    mode: "tui", hasUI: true, cwd: replica.root, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => sessionId, getEntries: () => structuredClone(entries) },
    ui: { getEditorText: () => "", notify() {}, custom: () => new Promise<void>(resolve => { closeOverlay = resolve; }) },
  } as unknown as ExtensionContext;
  const api = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    registerCommand(name: string, command: { handler: (...args: any[]) => unknown }) { commands.set(name, command); },
    registerShortcut() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI;
  const tracker = trackReloadActivity(api);
  const reload = registerAutoReload(tracker.pi, { identity: { sha: "aaaaaaa", dirty: false, builtAt: "2026-01-01T00:00:00.000Z", version: "0.1.0" }, url: "file:///fixture.js" },
    () => true, () => true, () => false, tracker.busy, tracker);
  const empty = { asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] };
  const ports: BlockerPorts = {
    sessionId, address: { sessionId, scopeId: null }, activity: reload.activity,
    broker: async () => empty, bridge: () => empty, localRoutes: async () => [],
    topLevelJobs: async () => [], childJobs: async () => [], localJobs: async () => [],
  };
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of hooks.get(name) ?? []) await handler(event, ctx);
  };
  const blockers = async () => (await inspectBlockers(ctx, [replica.db], ports)).map(({ kind, id }) => [kind, id]);
  return { replica, ctx, tracker, reload, commands, entries, emit, blockers, closeOverlay: () => closeOverlay() };
}

it("inspects a direct shell without consuming its completion evidence", async () => {
  const a = activation("owner");
  try {
    await a.emit("session_start", { reason: "startup" });
    await a.emit("user_bash", { command: "echo fixture", excludeFromContext: false });
    expect(await a.blockers()).toEqual([["direct-shell", "owner"]]);
    const result = { type: "message", id: "bash-result", message: { role: "bashExecution", command: "echo fixture", excludeFromContext: false } };
    a.entries.push(result);
    expect(await a.blockers()).toEqual([]);
    a.entries.pop();
    expect(await a.blockers()).toEqual([["direct-shell", "owner"]]);
    a.entries.push(result);
    expect(await a.blockers()).toEqual([]);
  } finally { await a.emit("session_shutdown"); a.replica.close(); }
}, 5000);

it("reads nested prompt depth without changing the reload tracker", async () => {
  const a = activation("owner");
  try {
    await a.emit("session_start", { reason: "startup" });
    await a.emit("ui_prompt_start"); await a.emit("ui_prompt_start");
    expect(a.reload.activity).toBeDefined();
    expect(a.reload.activity.promptDepth()).toBe(2);
    expect(await a.blockers()).toEqual([["ui-prompt", "owner"]]);
    await a.emit("ui_prompt_end");
    expect(a.reload.activity.promptDepth()).toBe(1);
    expect(await a.blockers()).toEqual([["ui-prompt", "owner"]]);
    await a.emit("ui_prompt_end");
    expect(await a.blockers()).toEqual([]);
  } finally { await a.emit("session_shutdown"); a.replica.close(); }
}, 5000);

it("tracks commands and detached overlays in their own activation", async () => {
  const a = activation("owner"), b = activation("other");
  let finishCommand!: () => void;
  const pendingCommand = new Promise<void>(resolve => { finishCommand = resolve; });
  let overlay: Promise<void> | undefined;
  try {
    await a.emit("session_start", { reason: "startup" });
    await b.emit("session_start", { reason: "startup" });
    a.tracker.pi.registerCommand("held", { description: "fixture", handler: () => pendingCommand });
    a.tracker.pi.registerCommand("overlay", { description: "fixture", handler: async (_args, ctx) => { overlay = ctx.ui.custom(() => null as never); } });
    const running = a.commands.get("held")!.handler("", a.ctx);
    expect(a.reload.activity).toBeDefined();
    expect(a.reload.activity.commandActive()).toBe(true);
    expect(await a.blockers()).toEqual([["interactive-activity", "owner"]]);
    expect(await b.blockers()).toEqual([]);
    finishCommand(); await running;
    await a.commands.get("overlay")!.handler("", a.ctx);
    expect(a.reload.activity.commandActive()).toBe(false);
    expect(a.reload.activity.overlayActive()).toBe(true);
    expect(await a.blockers()).toEqual([["interactive-activity", "owner"]]);
    a.closeOverlay(); await overlay;
    expect(await a.blockers()).toEqual([]);
  } finally { await a.emit("session_shutdown"); await b.emit("session_shutdown"); a.replica.close(); b.replica.close(); }
}, 5000);
