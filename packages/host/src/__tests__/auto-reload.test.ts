import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@spider/db-core";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activeChildCount, registerChild, registerShared, releaseShared, reloadWouldInterrupt, unregisterChild } from "@spider/subagents";
import { withPiEvents, hostUnitPorts } from "./fixtures/pi-events.js";
import { clearActions } from "../dispatch.js";
import { registerAutoReload } from "../auto-reload.js";
import * as reloadModule from "../auto-reload.js";
import spiderExtension from "../extension.js";

const shutdowns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
  clearActions();
  vi.unstubAllEnvs();
});

function hostForCommand() {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const pi = withPiEvents({
    registerTool() {},
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, command); },
    registerShortcut() {},
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    on(name: string, handler: (...args: unknown[]) => unknown) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
  });
  vi.stubEnv("PI_SUBAGENT_CHILD", "1");
  spiderExtension(pi as never, hostUnitPorts);
  shutdowns.push(async () => { for (const handler of hooks.get("session_shutdown") ?? []) await handler({ reason: "quit" }); });
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  return { commands, hooks };
}

it("refuses the reload command while a response is streaming", async () => {
  const { commands } = hostForCommand();
  const notify = vi.fn();
  const reload = vi.fn();
  const context = { mode: "tui", hasUI: true, isIdle: () => false, ui: { notify }, reload };

  await commands.get("spider-reload")?.handler("", context);

  expect(notify).toHaveBeenCalledOnce();
  expect(reload).not.toHaveBeenCalled();
});

it("host consults the session's reload interruption query", () => {
  const registration = vi.spyOn(reloadModule, "registerAutoReload");
  const handle = { wait: () => new Promise<{ exitCode: number }>(() => {}), kill() {} };
  registerShared({ sessionId: "host-session", runId: "host-foreground", mode: "rpc", dbPath: "", handle, survivable: false });
  try {
    hostForCommand();
    const query = registration.mock.calls[0]?.[4];
    expect(query).toBeTypeOf("function");
    expect(query("host-session")).toBe(true);
    expect(query("different-session")).toBe(false);
    releaseShared("host-foreground");
    expect(query("host-session")).toBe(false);
  } finally {
    releaseShared("host-foreground");
    registration.mockRestore();
  }
});

const initial = { sha: "aaaaaaa", dirty: false, builtAt: "2026-01-01T00:00:00.000Z", version: "0.1.0" };
const updated = { sha: "bbbbbbb", dirty: false, builtAt: "2026-01-02T00:00:00.000Z", version: "0.1.0" };
const newer = { sha: "ccccccc", dirty: false, builtAt: "2026-01-03T00:00:00.000Z", version: "0.1.0" };
const banner = (identity: typeof initial) => `// SPIDER_BUILD_ID=${identity.sha}${identity.dirty ? "-dirty" : ""}@${identity.builtAt} v${identity.version}\n`;

type ExtensionMode = ExtensionContext["mode"];
type Command = { handler: (args: string, context: ExtensionCommandContext) => Promise<void> };
type Hook = (event: unknown, context: ExtensionContext) => unknown;

function fixtureHarness(directory: string, loaded: typeof initial = initial) {
  const file = join(directory, "extension.js");
  writeFileSync(file, banner(loaded));
  const hooks = new Map<string, Hook[]>();
  const commands = new Map<string, Command>();
  const listeners = new Set<(data: string) => unknown>();
  const sent: Array<{ text: string; options: unknown }> = [];
  const errors: unknown[] = [];
  const state = { mode: "tui" as ExtensionMode, hasUI: true, streaming: false, compacting: false,
    pending: false, editor: "", enabled: true, admitted: true, dispatch: true };
  const notify = vi.fn();
  const reload = vi.fn(async () => {});
  const context = {
    get mode() { return state.mode; }, get hasUI() { return state.hasUI; }, cwd: directory,
    isIdle: () => !state.streaming && !state.compacting,
    hasPendingMessages: () => state.pending,
    sessionManager: { getSessionId: () => "auto-reload-test" },
    ui: { notify, getEditorText: () => state.editor,
      onTerminalInput(listener: (data: string) => unknown) { listeners.add(listener); return () => listeners.delete(listener); } },
    reload,
  } as unknown as ExtensionCommandContext;
  const pi = {
    on(name: string, handler: Hook) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
    registerCommand(name: string, command: Command) { commands.set(name, command); },
    sendUserMessage(text: string, options: unknown) {
      sent.push({ text, options });
      if (state.dispatch) void commands.get(text.slice(1))?.handler("", context).catch(error => errors.push(error));
    },
  } as unknown as ExtensionAPI;
  const bundle = { identity: loaded, url: `${pathToFileURL(file).href}?build=fixture` };
  registerAutoReload(pi, bundle, () => state.enabled, () => state.admitted, reloadWouldInterrupt);
  const emit = async (name: string, event: unknown = { type: name }) => {
    for (const handler of hooks.get(name) ?? []) await handler(event, context);
  };
  return { file, hooks, commands, context, state, sent, errors, listeners, notify, reload, emit };
}

describe("automatic reload", () => {
  let directory: string;
  let harness: ReturnType<typeof fixtureHarness>;

  beforeEach(() => {
    vi.stubEnv("PI_SUBAGENT_CHILD", "0");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
    const root = join(paths.scratch("worktree", process.cwd()), "auto-reload-tests");
    mkdirSync(root, { recursive: true });
    directory = mkdtempSync(join(root, "session-"));
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("spider.auto-reload.v1")];
    harness = fixtureHarness(directory);
  });
  afterEach(async () => {
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("spider.auto-reload.v1")];
  });

  it("reloads only after the installed build is observed twice", async () => {
    writeFileSync(harness.file, banner(updated));
    await harness.emit("session_start", { type: "session_start", reason: "startup" });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.sent).toEqual([]);
    expect(harness.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.sent).toEqual([{ text: "/spider-reload", options: { expandPromptTemplates: true } }]);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it.each([
    ["the loaded build", banner(initial)],
    ["a malformed marker", "// SPIDER_BUILD_ID=broken\n"],
    ["a valid marker on the second line", `// no marker\n${banner(updated)}`],
  ])("ignores %s", async (_name, content) => {
    writeFileSync(harness.file, content);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it("starts the two-read count again after an unreadable or malformed header", async () => {
    writeFileSync(harness.file, banner(updated));
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(30_000);
    unlinkSync(harness.file);
    await vi.advanceTimersByTimeAsync(30_000);
    writeFileSync(harness.file, banner(updated));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).not.toHaveBeenCalled();
    writeFileSync(harness.file, "// invalid\n");
    await vi.advanceTimersByTimeAsync(30_000);
    writeFileSync(harness.file, banner(updated));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).toHaveBeenCalledOnce();
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it("requires two consecutive reads of the same new identity", async () => {
    writeFileSync(harness.file, banner(updated));
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(30_000);
    writeFileSync(harness.file, banner(newer));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it.each(["missing", "malformed"] as const)("does not reload when the queued bundle becomes %s", async failure => {
    harness.state.dispatch = false;
    writeFileSync(harness.file, banner(updated));
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    if (failure === "missing") unlinkSync(harness.file); else writeFileSync(harness.file, "partial write");
    await harness.commands.get("spider-reload")!.handler("", harness.context);
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it.each([
    ["build time", { ...initial, builtAt: "2026-01-02T00:00:00.000Z" }],
    ["dirty state", { ...initial, dirty: true }],
    ["version", { ...initial, version: "0.2.0" }],
  ])("detects a changed %s even when the commit matches", async (_name, identity) => {
    writeFileSync(harness.file, banner(identity));
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it.each([["starting", undefined], ["queued", "queued"], ["running", "running"]] as const)(
    "does not block a %s subagent", async (_name, runStatus) => {
      const handle = { runStatus, wait: () => new Promise<{ exitCode: number }>(() => {}), kill() {}, detach() {} };
      registerChild("auto-reload-test", "child-1", handle);
      registerShared({ sessionId: "auto-reload-test", runId: "child-1", mode: "rpc", dbPath: "", handle, survivable: true });
      try {
        expect(activeChildCount("auto-reload-test")).toBe(1);
        writeFileSync(harness.file, banner(updated));
        await harness.emit("session_start", { type: "session_start", reason: "startup" });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(harness.reload).toHaveBeenCalledOnce();
      } finally { unregisterChild("auto-reload-test", "child-1"); releaseShared("child-1"); }
    },
  );

  it("waits for a child that reload would stop", async () => {
    const handle = { wait: () => new Promise<{ exitCode: number }>(() => {}), kill() {} };
    registerShared({ sessionId: "auto-reload-test", runId: "foreground", mode: "rpc", dbPath: "", handle, survivable: false });
    try {
      writeFileSync(harness.file, banner(updated));
      await harness.emit("session_start", { type: "session_start", reason: "startup" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(harness.reload).not.toHaveBeenCalled();
      releaseShared("foreground");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(harness.reload).toHaveBeenCalledOnce();
    } finally { releaseShared("foreground"); }
  });

  it("rechecks for an interruptible child in the command handler", async () => {
    harness.state.dispatch = false;
    writeFileSync(harness.file, banner(updated));
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.sent).toHaveLength(1);
    const handle = { wait: () => new Promise<{ exitCode: number }>(() => {}), kill() {} };
    registerShared({ sessionId: "auto-reload-test", runId: "foreground", mode: "rpc", dbPath: "", handle, survivable: false });
    try {
      await harness.commands.get("spider-reload")!.handler("", harness.context);
      expect(harness.reload).not.toHaveBeenCalled();
      releaseShared("foreground");
      harness.state.dispatch = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(harness.reload).toHaveBeenCalledOnce();
    } finally { releaseShared("foreground"); }
  });

  it.each(["rpc", "json", "print"] as const)("never reloads in %s mode", async mode => {
    harness.state.mode = mode;
    writeFileSync(harness.file, banner(updated));
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(harness.sent).toEqual([]);
    await harness.commands.get("spider-reload")!.handler("", harness.context);
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("never reloads a child session", async () => {
    vi.stubEnv("PI_SUBAGENT_CHILD", "1");
    writeFileSync(harness.file, banner(updated));
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(harness.sent).toEqual([]);
    await harness.commands.get("spider-reload")!.handler("", harness.context);
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("never reloads without a UI", async () => {
    harness.state.hasUI = false;
    writeFileSync(harness.file, banner(updated));
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(harness.sent).toEqual([]);
    await harness.commands.get("spider-reload")!.handler("", harness.context);
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it.each(["streaming", "compacting", "pending", "editor", "enabled", "admitted"] as const)(
    "waits while %s blocks reload, then tries when the session is ready", async blocked => {
      if (blocked === "editor") harness.state.editor = " draft ";
      else if (blocked === "enabled" || blocked === "admitted") harness.state[blocked] = false;
      else harness.state[blocked] = true;
      writeFileSync(harness.file, banner(updated));
      await harness.emit("session_start", { type: "session_start", reason: "startup" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(harness.sent).toEqual([]);
      expect(harness.reload).not.toHaveBeenCalled();
      if (blocked === "editor") harness.state.editor = "  ";
      else if (blocked === "enabled" || blocked === "admitted") harness.state[blocked] = true;
      else harness.state[blocked] = false;
      await vi.advanceTimersByTimeAsync(blocked === "enabled" || blocked === "admitted" ? 60_000 : 30_000);
      expect(harness.reload).toHaveBeenCalledOnce();
    },
  );

  it("waits 20 seconds after a turn ends", async () => {
    writeFileSync(harness.file, banner(updated));
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(55_000);
    await harness.emit("turn_end");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("waits 20 seconds after a message finishes", async () => {
    writeFileSync(harness.file, banner(updated));
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(55_000);
    await harness.emit("message_end");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("waits 20 seconds after terminal activity even if the editor is empty", async () => {
    writeFileSync(harness.file, banner(updated));
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(55_000);
    for (const listener of harness.listeners) listener("x");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("lets the command reload only after the full quiet period", async () => {
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(19_999);
    await harness.commands.get("spider-reload")!.handler("", harness.context);
    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.notify).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await harness.commands.get("spider-reload")!.handler("", harness.context);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("rechecks a live disablement after dispatch", async () => {
    harness.state.dispatch = false;
    writeFileSync(harness.file, banner(updated));
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.sent).toHaveLength(1);
    harness.state.enabled = false;
    await harness.commands.get("spider-reload")!.handler("", harness.context);
    expect(harness.reload).not.toHaveBeenCalled();
    harness.state.enabled = true;
    harness.state.dispatch = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("rechecks the gate in the command handler after dispatch", async () => {
    harness.state.dispatch = false;
    writeFileSync(harness.file, banner(updated));
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.sent).toHaveLength(1);
    harness.state.pending = true;
    await harness.commands.get("spider-reload")!.handler("", harness.context);
    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
    harness.state.pending = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.sent).toHaveLength(2);
    await harness.commands.get("spider-reload")!.handler("", harness.context);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("attempts one reload for a build even when the reload fails", async () => {
    harness.reload.mockRejectedValueOnce(new Error("reload failed"));
    writeFileSync(harness.file, banner(updated));
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.reload).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.reload).toHaveBeenCalledOnce();

    writeFileSync(harness.file, banner(newer));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.reload).toHaveBeenCalledTimes(2);
  });

  it("does not try the same target again when the next activation still has the old build", async () => {
    writeFileSync(harness.file, banner(updated));
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.reload).toHaveBeenCalledOnce();
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });

    harness = fixtureHarness(directory);
    writeFileSync(harness.file, banner(updated));
    await harness.emit("session_start", { type: "session_start", reason: "reload" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.sent).toEqual([]);
    expect(harness.reload).not.toHaveBeenCalled();

    writeFileSync(harness.file, banner(newer));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("notifies once in the new runtime after an automatic reload", async () => {
    const old = harness;
    old.reload.mockImplementationOnce(async () => {
      await old.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
      harness = fixtureHarness(directory, updated);
      await harness.emit("session_start", { type: "session_start", reason: "reload" });
    });
    writeFileSync(old.file, banner(updated));
    await old.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(old.reload).toHaveBeenCalledOnce();
    expect(harness.notify).toHaveBeenCalledExactlyOnceWith("Spider updated to bbbbbbb.", "info");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.notify).toHaveBeenCalledOnce();
  });

  it("does not show an update notification after a manual reload", async () => {
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
    harness = fixtureHarness(directory, updated);
    await harness.emit("session_start", { type: "session_start", reason: "reload" });
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it("does not mistake a later manual reload for a failed automatic reload", async () => {
    writeFileSync(harness.file, banner(updated));
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.reload).toHaveBeenCalledOnce();
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
    harness = fixtureHarness(directory, updated);
    await harness.emit("session_start", { type: "session_start", reason: "reload" });
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it("does not show an update after a synchronous reload error and a later manual reload", async () => {
    harness.reload.mockImplementationOnce(() => { throw new Error("reload failed"); });
    writeFileSync(harness.file, banner(updated));
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.reload).toHaveBeenCalledOnce();
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
    harness = fixtureHarness(directory, updated);
    await harness.emit("session_start", { type: "session_start", reason: "reload" });
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it("requires two reads of a replacement that arrives after dispatch", async () => {
    harness.state.dispatch = false;
    writeFileSync(harness.file, banner(updated));
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.sent).toHaveLength(1);
    writeFileSync(harness.file, banner(newer));
    await harness.commands.get("spider-reload")!.handler("", harness.context);
    expect(harness.reload).not.toHaveBeenCalled();
    harness.state.dispatch = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.sent).toHaveLength(1);
    expect(harness.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.sent).toHaveLength(2);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("stops the previous activation's timer and input listener on a second load", async () => {
    const old = harness;
    await old.emit("session_start", { type: "session_start", reason: "startup" });
    expect(old.listeners.size).toBe(1);
    harness = fixtureHarness(directory);
    writeFileSync(harness.file, banner(updated));
    await harness.emit("session_start", { type: "session_start", reason: "reload" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(old.sent).toEqual([]);
    expect(old.listeners.size).toBe(0);
    expect(harness.reload).toHaveBeenCalledOnce();
    await old.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
    writeFileSync(harness.file, banner(newer));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.reload).toHaveBeenCalledTimes(2);
  });

  it("does not keep the process alive for the polling timer", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    try {
      await harness.emit("session_start", { type: "session_start", reason: "startup" });
      const timer = intervals.mock.results[0].value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
    } finally { intervals.mockRestore(); }
  });

  it("stops its timer and input listener on shutdown", async () => {
    writeFileSync(harness.file, banner(updated));
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    expect(harness.listeners.size).toBe(1);
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    expect(harness.listeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(harness.sent).toEqual([]);
  });
});
