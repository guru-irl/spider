import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@spider/db-core";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activeChildCount, registerChild, registerShared, releaseShared, reloadWouldInterrupt, unregisterChild } from "@spider/subagents";
import { withPiEvents, hostUnitPorts } from "./fixtures/pi-events.js";
import { agentsHostFixture } from "./fixtures/agents-host.js";
import { clearActions } from "../dispatch.js";
import { registerAutoReload } from "../auto-reload.js";
import * as reloadModule from "../auto-reload.js";
import * as slashModule from "../slash.js";
import * as intercomModule from "@spider/intercom";
import * as loopModule from "../loop/index.js";
import * as admissionModule from "../roam/admission.js";
import { HostOrganismRuntime } from "../organism-runtime.js";
import { openSessionRunDb } from "../session-run-db.js";
import { setup as setupScheduler } from "../loop/__tests__/harness.js";
import spiderExtension from "../extension.js";

const shutdowns: Array<() => Promise<void>> = [];
const hostDirectories: string[] = [];
function hostDirectory(): string {
  const root = join(paths.scratch("worktree", process.cwd()), "reload-host-tests");
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "session-"));
  hostDirectories.push(directory);
  execFileSync("git", ["init", "-q"], { cwd: directory });
  return directory;
}
afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
  for (const directory of hostDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  clearActions();
  vi.unstubAllEnvs();
});

function hostForCommand(options: { sendUserMessage?: (text: string) => void; onRegistration?: (name: string, handler: (...args: unknown[]) => unknown) => void; piVersion?: string } = {}) {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const pi = withPiEvents({
    registerTool() {},
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, command); },
    registerShortcut() {},
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    sendUserMessage(text: string) { options.sendUserMessage?.(text); },
    on(name: string, handler: (...args: unknown[]) => unknown) {
      options.onRegistration?.(name, handler);
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      return () => { hooks.set(name, (hooks.get(name) ?? []).filter(current => current !== handler)); };
    },
  });
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  spiderExtension(pi as never, { ...hostUnitPorts, piVersion: options.piVersion });
  shutdowns.push(async () => { for (const handler of [...(hooks.get("session_shutdown") ?? [])]) await handler({ reason: "quit" }); });
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

it("retries quietly when admission closes after an automatic reload is queued", async () => {
  vi.useFakeTimers();
  let admitted = true;
  const gate = { inspect: () => ({ kind: admitted ? "ordinary" : "blocked", home: null,
    blockers: admitted ? [] : [{ kind: "admission", id: "test", detail: "blocked" }] }),
    whenSettled: async () => gate.inspect(), close: async () => {}, freeze: async () => {}, unfreeze: async () => {} };
  const admission = vi.spyOn(admissionModule, "registerAdmission").mockReturnValue(gate as never);
  let recording = false;
  let start!: (...args: unknown[]) => unknown;
  const actual = reloadModule.registerAutoReload;
  const directory = hostDirectory();
  const file = join(directory, "extension.js");
  installReadyBuild(file, updated);
  const registration = vi.spyOn(reloadModule, "registerAutoReload").mockImplementation((...args) => {
    args[1] = { identity: initial, url: `${pathToFileURL(file).href}?build=fixture` };
    recording = true;
    try { return actual(...args); } finally { recording = false; }
  });
  const sent: string[] = [];
  try {
    const { commands } = hostForCommand({
      sendUserMessage: text => sent.push(text),
      onRegistration: (name, handler) => { if (recording && name === "session_start") start = handler; },
    });
    const notify = vi.fn();
    const reload = vi.fn(async () => {});
    const context = { mode: "tui", hasUI: true, cwd: directory, isIdle: () => true, hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "admission-race", getEntries: () => [] },
      ui: { getEditorText: () => "", notify, onTerminalInput: () => () => {} }, reload };
    await start({ reason: "startup" }, context);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(1);
    admitted = false;
    await commands.get("spider-reload")!.handler("", context);
    expect(reload).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledExactlyOnceWith("blocked", "warning");
    notify.mockClear();
    await commands.get("spider-reload")!.handler("--spider-auto=forged", context);
    expect(reload).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    await commands.get("spider-reload")!.handler(sent[0].slice("/spider-reload".length).trim(), context);
    expect(reload).not.toHaveBeenCalled();
    admitted = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toHaveLength(2);
    expect(notify).not.toHaveBeenCalled();
    await commands.get("spider-reload")!.handler(sent[1].slice("/spider-reload".length).trim(), context);
    expect(reload).toHaveBeenCalledOnce();
  } finally { admission.mockRestore(); registration.mockRestore(); vi.useRealTimers(); }
});

it("waits for in-flight organism work before reloading", async () => {
  const proto = HostOrganismRuntime.prototype as unknown as { blocksReload?: () => boolean };
  const original = proto.blocksReload;
  let busy = true;
  proto.blocksReload = () => busy;
  try {
    const { commands } = hostForCommand();
    const reload = vi.fn(async () => {});
    const context = { mode: "tui", hasUI: true, cwd: hostDirectory(), isIdle: () => true, hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "organism-test", getEntries: () => [] },
      ui: { getEditorText: () => "", notify: vi.fn() }, reload };
    await commands.get("spider-reload")!.handler("", context);
    expect(reload).not.toHaveBeenCalled();
    busy = false;
    await commands.get("spider-reload")!.handler("", context);
    expect(reload).toHaveBeenCalledOnce();
  } finally {
    if (original) proto.blocksReload = original;
    else delete proto.blocksReload;
  }
});

it("waits for the real /todos overlay until the user closes it", async () => {
  const { commands } = hostForCommand();
  const reload = vi.fn(async () => {});
  let overlay!: { render(width: number): string[]; handleInput(key: string): void };
  const custom = vi.fn((factory: (...args: any[]) => typeof overlay) => new Promise<void>(resolve => {
    overlay = factory({ requestRender() {}, terminal: { rows: 24 } }, { fg: (_name: string, value: string) => value }, {}, resolve);
  }));
  const context = { mode: "tui", hasUI: true, cwd: hostDirectory(), isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => "todos-overlay", getEntries: () => [] },
    ui: { getEditorText: () => "", notify: vi.fn(), custom }, reload };
  const open = commands.get("todos")!.handler("", context);
  expect(custom).toHaveBeenCalledOnce();
  expect(overlay.render(80).join("\n")).toContain("Todos");
  await commands.get("spider-reload")!.handler("", context);
  expect(reload).not.toHaveBeenCalled();
  overlay.handleInput("q");
  await open;
  await commands.get("spider-reload")!.handler("", context);
  expect(reload).toHaveBeenCalledOnce();
});

it("waits for the real /agents selector until escape closes it", async () => {
  const { commands, hooks } = hostForCommand({ piVersion: "1.2.0" });
  const cwd = hostDirectory();
  const { db } = openSessionRunDb(cwd, "agents-overlay");
  try {
    db.prepare(`INSERT INTO runs (id, session_id, agent, status, step_count, token_count, started_at)
                VALUES ('agents-run','agents-overlay','worker','running',1,0,0)`).run();
  } finally { db.close(); }
  const reload = vi.fn(async () => {});
  const terminal = agentsHostFixture();
  const context = { mode: "tui", hasUI: true, cwd, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => "agents-overlay", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] },
    getContextUsage: () => null,
    ui: { ...terminal.ui, getEditorText: () => "", setFooter: vi.fn() }, reload };
  try {
    for (const handler of [...(hooks.get("session_start") ?? [])]) await handler({ reason: "startup" }, context);
    const open = commands.get("agents")!.handler("", context);
    await terminal.settle();
    expect(terminal.ui.custom).toHaveBeenCalledOnce();
    await commands.get("spider-reload")!.handler("", context);
    expect(reload).not.toHaveBeenCalled();
    await terminal.send(String.fromCharCode(27));
    await open;
    await commands.get("spider-reload")!.handler("", context);
    expect(reload).toHaveBeenCalledOnce();
  } finally { terminal.close(); }
});

it("releases reload after the real /todos overlay throws", async () => {
  const { commands } = hostForCommand();
  const reload = vi.fn(async () => {});
  const context = { mode: "tui", hasUI: true, cwd: hostDirectory(), isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => "todos-error", getEntries: () => [] },
    ui: { getEditorText: () => "", notify: vi.fn(), custom: async () => { throw new Error("overlay failed"); } }, reload };
  await expect(commands.get("todos")!.handler("", context)).rejects.toThrow("overlay failed");
  await commands.get("spider-reload")!.handler("", context);
  expect(reload).toHaveBeenCalledOnce();
});

it.each(["resolve", "reject"] as const)("waits for a running spider command and releases it on %s", async outcome => {
  const original = slashModule.registerSlashCommands;
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const pending = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  const registration = vi.spyOn(slashModule, "registerSlashCommands").mockImplementation((pi, deps) => {
    original(pi, deps);
    pi.registerCommand("test-held", { description: "Test command", handler: () => pending });
  });
  try {
    const { commands } = hostForCommand();
    const reload = vi.fn(async () => {});
    const context = { mode: "tui", hasUI: true, cwd: hostDirectory(), isIdle: () => true, hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "command-test", getEntries: () => [] },
      ui: { getEditorText: () => "", notify: vi.fn() }, reload };
    await commands.get("spider-reload")!.handler("", context);
    expect(reload).toHaveBeenCalledOnce();
    reload.mockClear();
    const running = commands.get("test-held")!.handler("", context);
    await commands.get("spider-reload")!.handler("", context);
    expect(reload).not.toHaveBeenCalled();
    if (outcome === "reject") { fail(new Error("command failed")); await expect(running).rejects.toThrow("command failed"); }
    else { finish(); await running; }
    await commands.get("spider-reload")!.handler("", context);
    expect(reload).toHaveBeenCalledOnce();
  } finally { registration.mockRestore(); }
});

it.each(["resolve", "reject"] as const)("waits for a spider custom overlay after its command ends and releases it on %s", async outcome => {
  const original = slashModule.registerSlashCommands;
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const pending = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  let overlay: Promise<void> | undefined;
  const registration = vi.spyOn(slashModule, "registerSlashCommands").mockImplementation((pi, deps) => {
    original(pi, deps);
    pi.registerCommand("test-overlay", { description: "Test overlay", handler: (_args, ctx) => {
      overlay = (ctx as { ui: { custom: () => Promise<void> } }).ui.custom();
    } });
  });
  try {
    const { commands } = hostForCommand();
    const reload = vi.fn(async () => {});
    const context = { mode: "tui", hasUI: true, cwd: hostDirectory(), isIdle: () => true, hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "overlay-test", getEntries: () => [] },
      ui: { getEditorText: () => "", notify: vi.fn(), custom: () => pending }, reload };
    await commands.get("spider-reload")!.handler("", context);
    expect(reload).toHaveBeenCalledOnce();
    reload.mockClear();
    await commands.get("test-overlay")!.handler("", context);
    await commands.get("spider-reload")!.handler("", context);
    expect(reload).not.toHaveBeenCalled();
    if (outcome === "reject") { fail(new Error("overlay failed")); await expect(overlay).rejects.toThrow("overlay failed"); }
    else { finish(); await overlay; }
    await commands.get("spider-reload")!.handler("", context);
    expect(reload).toHaveBeenCalledOnce();
  } finally { registration.mockRestore(); }
});

it("waits for unanswered intercom asks in the host activation", async () => {
  let pendingAsk = false;
  const intercom = vi.spyOn(intercomModule, "registerIntercomOnce").mockImplementation(() => ({
    hasPendingInboundAsks: () => pendingAsk,
  }) as never);
  try {
    const { commands } = hostForCommand();
    const reload = vi.fn(async () => {});
    const context = { mode: "tui", hasUI: true, cwd: hostDirectory(), isIdle: () => true, hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "intercom-host-test", getEntries: () => [] },
      ui: { getEditorText: () => "", notify: vi.fn() }, reload };
    await commands.get("spider-reload")!.handler("", context);
    expect(reload).toHaveBeenCalledOnce();
    reload.mockClear();
    pendingAsk = true;
    await commands.get("spider-reload")!.handler("", context);
    expect(reload).not.toHaveBeenCalled();
    pendingAsk = false;
    await commands.get("spider-reload")!.handler("", context);
    expect(reload).toHaveBeenCalledOnce();
  } finally { intercom.mockRestore(); }
});

it("consults the host's session scheduler before reloading", async () => {
  const original = loopModule.registerLoopSchedule;
  let blocked = false;
  const registration = vi.spyOn(loopModule, "registerLoopSchedule").mockImplementation((...args) => {
    const result = original(...args);
    (result.scheduler as unknown as { blocksReload: () => boolean }).blocksReload = () => blocked;
    return result;
  });
  try {
    const { commands } = hostForCommand();
    const reload = vi.fn(async () => {});
    const context = { mode: "tui", hasUI: true, cwd: hostDirectory(), isIdle: () => true, hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "scheduled-host-test", getEntries: () => [] },
      ui: { getEditorText: () => "", notify: vi.fn() }, reload };
    await commands.get("spider-reload")!.handler("", context);
    expect(reload).toHaveBeenCalledOnce();
    reload.mockClear();
    blocked = true;
    await commands.get("spider-reload")!.handler("", context);
    expect(reload).not.toHaveBeenCalled();
    blocked = false;
    await commands.get("spider-reload")!.handler("", context);
    expect(reload).toHaveBeenCalledOnce();
  } finally { registration.mockRestore(); }
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
const installReadyBuild = (file: string, identity: typeof initial) => {
  writeFileSync(file, banner(identity));
  writeFileSync(`${file}.ready`, banner(identity));
};

type ExtensionMode = ExtensionContext["mode"];
type Command = { handler: (args: string, context: ExtensionCommandContext) => Promise<void> };
type Hook = (event: unknown, context: ExtensionContext) => unknown;

function fixtureHarness(directory: string, loaded: typeof initial = initial, query = "?build=fixture", busy: () => boolean = () => false) {
  const file = join(directory, "extension.js");
  installReadyBuild(file, loaded);
  const hooks = new Map<string, Hook[]>();
  const commands = new Map<string, Command>();
  const listeners = new Set<(data: string) => unknown>();
  const entries: Array<{ type: string; id: string; parentId: string | null; timestamp: string; message: { role: string; command: string; output: string; exitCode: number; cancelled: boolean; truncated: boolean; timestamp: number; excludeFromContext: boolean } }> = [];
  const finishBash = (command: string, excludeFromContext = false) => {
    entries.push({ type: "message", id: `bash-${entries.length}`, parentId: null, timestamp: new Date().toISOString(),
      message: { role: "bashExecution", command, output: "", exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now(), excludeFromContext } });
  };
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
    sessionManager: { getSessionId: () => "auto-reload-test", getEntries: () => structuredClone(entries) },
    ui: { notify, getEditorText: () => state.editor,
      onTerminalInput(listener: (data: string) => unknown) { listeners.add(listener); return () => listeners.delete(listener); } },
    reload,
  } as unknown as ExtensionCommandContext;
  const pi = {
    on(name: string, handler: Hook) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
    registerCommand(name: string, command: Command) { commands.set(name, command); },
    sendUserMessage(text: string, options: unknown) {
      sent.push({ text, options });
      const [name, ...args] = text.slice(1).split(" ");
      if (state.dispatch) void commands.get(name)?.handler(args.join(" "), context).catch(error => errors.push(error));
    },
  } as unknown as ExtensionAPI;
  const bundle = { identity: loaded, url: `${pathToFileURL(file).href}${query}` };
  const registration = registerAutoReload(pi, bundle, () => state.enabled, () => state.admitted, reloadWouldInterrupt, busy) as unknown as
    { isAutomaticReload?: () => boolean } | undefined;
  const emit = async (name: string, event: unknown = { type: name }) => {
    for (const handler of hooks.get(name) ?? []) await handler(event, context);
  };
  const dispatchQueued = (index = sent.length - 1) => commands.get("spider-reload")!.handler(sent[index].text.slice("/spider-reload".length).trim(), context);
  return { file, hooks, commands, context, state, sent, errors, listeners, notify, reload, emit, finishBash, registration, dispatchQueued };
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

  it.each(["missing", "malformed", "mismatched"] as const)("waits for a %s ready stamp and restarts the two-read confirmation", async state => {
    installReadyBuild(harness.file, updated);
    const stamp = `${harness.file}.ready`;
    if (state === "missing") unlinkSync(stamp);
    if (state === "malformed") writeFileSync(stamp, "not ready");
    if (state === "mismatched") writeFileSync(stamp, banner(initial));
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.sent).toEqual([]);
    writeFileSync(stamp, banner(updated));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("rechecks the ready stamp after queuing the reload", async () => {
    harness.state.dispatch = false;
    installReadyBuild(harness.file, updated);
    writeFileSync(`${harness.file}.ready`, banner(updated));
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.sent).toHaveLength(1);
    writeFileSync(`${harness.file}.ready`, banner(newer));
    await harness.dispatchQueued();
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("reloads only after the installed build is observed twice", async () => {
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.sent).toEqual([]);
    expect(harness.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.sent).toEqual([{ text: expect.stringMatching(/^\/spider-reload --spider-auto=[0-9a-f-]+$/), options: { expandPromptTemplates: true } }]);
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
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(30_000);
    unlinkSync(harness.file);
    await vi.advanceTimersByTimeAsync(30_000);
    installReadyBuild(harness.file, updated);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).not.toHaveBeenCalled();
    writeFileSync(harness.file, "// invalid\n");
    await vi.advanceTimersByTimeAsync(30_000);
    installReadyBuild(harness.file, updated);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).toHaveBeenCalledOnce();
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it("requires two consecutive reads of the same new identity", async () => {
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(30_000);
    installReadyBuild(harness.file, newer);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it.each(["missing", "malformed"] as const)("does not reload when the queued bundle becomes %s", async failure => {
    harness.state.dispatch = false;
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    if (failure === "missing") unlinkSync(harness.file); else writeFileSync(harness.file, "partial write");
    await harness.dispatchQueued();
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it.each([
    ["build time", { ...initial, builtAt: "2026-01-02T00:00:00.000Z" }],
    ["dirty state", { ...initial, dirty: true }],
    ["version", { ...initial, version: "0.2.0" }],
  ])("detects a changed %s even when the commit matches", async (_name, identity) => {
    installReadyBuild(harness.file, identity);
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
        installReadyBuild(harness.file, updated);
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
      installReadyBuild(harness.file, updated);
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
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.sent).toHaveLength(1);
    const handle = { wait: () => new Promise<{ exitCode: number }>(() => {}), kill() {} };
    registerShared({ sessionId: "auto-reload-test", runId: "foreground", mode: "rpc", dbPath: "", handle, survivable: false });
    try {
      await harness.dispatchQueued();
      expect(harness.reload).not.toHaveBeenCalled();
      releaseShared("foreground");
      harness.state.dispatch = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(harness.reload).toHaveBeenCalledOnce();
    } finally { releaseShared("foreground"); }
  });

  it.each(["", "?other=fixture", "?build="])("does not automatically reload without a build query value (%s)", async query => {
    harness = fixtureHarness(directory, initial, query);
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.sent).toEqual([]);
    expect(harness.reload).not.toHaveBeenCalled();
    await harness.commands.get("spider-reload")!.handler("", harness.context);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it.each(["rpc", "json", "print"] as const)("never reloads in %s mode", async mode => {
    harness.state.mode = mode;
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(harness.sent).toEqual([]);
    await harness.commands.get("spider-reload")!.handler("", harness.context);
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("registers no reload command or lifecycle hooks in a child process", () => {
    vi.stubEnv("PI_SUBAGENT_CHILD", "1");
    const child = fixtureHarness(directory);
    expect(child.commands.size).toBe(0);
    expect(child.hooks.size).toBe(0);
  });

  it("never reloads a child session", async () => {
    vi.stubEnv("PI_SUBAGENT_CHILD", "1");
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(harness.sent).toEqual([]);
    await harness.commands.get("spider-reload")!.handler("", harness.context);
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("never reloads without a UI", async () => {
    harness.state.hasUI = false;
    installReadyBuild(harness.file, updated);
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
      installReadyBuild(harness.file, updated);
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

  it("waits for all open pi prompts and ignores an unmatched prompt end", async () => {
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    const start = { type: "ui_prompt_start", reason: "ui_prompt", kind: "select" };
    const end = { type: "ui_prompt_end", reason: "ui_prompt", kind: "select" };
    await harness.emit("ui_prompt_end", end);
    await harness.emit("ui_prompt_start", start);
    await harness.emit("ui_prompt_start", { ...start, kind: "custom" });
    installReadyBuild(harness.file, updated);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.reload).not.toHaveBeenCalled();
    await harness.commands.get("spider-reload")!.handler("", harness.context);
    expect(harness.reload).not.toHaveBeenCalled();
    await harness.emit("ui_prompt_end", end);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).not.toHaveBeenCalled();
    await harness.emit("ui_prompt_end", { ...end, kind: "custom" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it.each([false, true])("waits for a matching new user bash result, excluded=%s", async excluded => {
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    harness.finishBash("npm test", excluded);
    await harness.emit("user_bash", { type: "user_bash", command: "npm test", excludeFromContext: excluded, cwd: directory });
    harness.finishBash("other command", excluded);
    harness.finishBash("npm test", !excluded);
    installReadyBuild(harness.file, updated);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(harness.reload).not.toHaveBeenCalled();
    await harness.commands.get("spider-reload")!.handler("", harness.context);
    expect(harness.reload).not.toHaveBeenCalled();
    harness.finishBash("npm test", excluded);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("waits until each concurrent user bash command has a distinct result", async () => {
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    const event = { type: "user_bash", command: "echo same", excludeFromContext: false, cwd: directory };
    await harness.emit("user_bash", event);
    await harness.emit("user_bash", event);
    installReadyBuild(harness.file, updated);
    harness.finishBash("echo same");
    await vi.advanceTimersByTimeAsync(90_000);
    expect(harness.reload).not.toHaveBeenCalled();
    harness.finishBash("echo same");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("waits for a due trigger and its in-flight delivery to settle", async () => {
    const scheduler = setupScheduler();
    harness = fixtureHarness(directory, initial, "?build=fixture", () =>
      (scheduler.runtime as unknown as { blocksReload?: () => boolean }).blocksReload?.() ?? false);
    await scheduler.runtime.schedule({ delaySeconds: 120, prompt: "check" }, scheduler.ctx);
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scheduler.prompts()).toEqual(["check"]);
    expect(harness.reload).not.toHaveBeenCalled();
    await harness.commands.get("spider-reload")!.handler("", harness.context);
    expect(harness.reload).not.toHaveBeenCalled();
    await scheduler.emit("agent_start");
    await scheduler.emit("agent_settled");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("reloads when the next trigger is more than 60 seconds away", async () => {
    const scheduler = setupScheduler();
    harness = fixtureHarness(directory, initial, "?build=fixture", () =>
      (scheduler.runtime as unknown as { blocksReload?: () => boolean }).blocksReload?.() ?? false);
    await scheduler.runtime.schedule({ delaySeconds: 121, prompt: "later" }, scheduler.ctx);
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("waits 20 seconds after a turn ends", async () => {
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(55_000);
    await harness.emit("turn_end");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("waits 20 seconds after a message finishes", async () => {
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(55_000);
    await harness.emit("message_end");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("waits 20 seconds after terminal activity even if the editor is empty", async () => {
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(55_000);
    for (const listener of harness.listeners) listener("x");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("allows a manually typed reload without waiting for silence", async () => {
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    for (const key of "/spider-reload\r") for (const listener of harness.listeners) listener(key);
    await harness.commands.get("spider-reload")!.handler("", harness.context);
    expect(harness.reload).toHaveBeenCalledOnce();
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it.each(["streaming", "compacting", "pending", "editor", "enabled", "admitted"] as const)(
    "still blocks a manual reload while %s blocks the session", async blocked => {
      await harness.emit("session_start", { type: "session_start", reason: "startup" });
      if (blocked === "editor") harness.state.editor = "draft";
      else if (blocked === "enabled" || blocked === "admitted") harness.state[blocked] = false;
      else harness.state[blocked] = true;
      await harness.commands.get("spider-reload")!.handler("", harness.context);
      expect(harness.reload).not.toHaveBeenCalled();
      expect(harness.notify).toHaveBeenCalledOnce();
    },
  );

  it("rechecks a live disablement after dispatch", async () => {
    harness.state.dispatch = false;
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.sent).toHaveLength(1);
    harness.state.enabled = false;
    await harness.dispatchQueued();
    expect(harness.reload).not.toHaveBeenCalled();
    harness.state.enabled = true;
    harness.state.dispatch = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("does not let a queued automatic command bypass the quiet period after a manual refusal", async () => {
    harness.state.dispatch = false;
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.sent).toHaveLength(1);
    harness.state.streaming = true;
    await harness.commands.get("spider-reload")!.handler("", harness.context);
    harness.state.streaming = false;
    for (const listener of harness.listeners) listener("x");
    const queuedArgs = harness.sent[0].text.slice('/spider-reload'.length).trim();
    await harness.commands.get("spider-reload")!.handler(queuedArgs, harness.context);
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("lets a manual reload skip the quiet period even when an automatic attempt is queued", async () => {
    harness.state.dispatch = false;
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    for (const listener of harness.listeners) listener("x");
    const observed: boolean[] = [];
    harness.reload.mockImplementationOnce(async () => { observed.push(harness.registration?.isAutomaticReload?.() ?? false); });
    await harness.commands.get("spider-reload")!.handler("", harness.context);
    expect(harness.reload).toHaveBeenCalledOnce();
    expect(observed).toEqual([false]);
  });

  it("ignores a queued automatic command after a successful manual reload", async () => {
    harness.state.dispatch = false;
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    const queuedArgs = harness.sent[0].text.slice('/spider-reload'.length).trim();
    harness.reload.mockImplementationOnce(async () => { await harness.emit("session_shutdown", { reason: "reload" }); });
    await harness.commands.get("spider-reload")!.handler("", harness.context);
    expect(harness.reload).toHaveBeenCalledOnce();
    await harness.commands.get("spider-reload")!.handler(queuedArgs, harness.context);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("ignores a stale automatic token without consuming a newer attempt", async () => {
    harness.state.dispatch = false;
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    const stale = harness.sent[0].text.slice('/spider-reload'.length).trim();
    installReadyBuild(harness.file, newer);
    await harness.dispatchQueued();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.sent).toHaveLength(2);
    await harness.commands.get("spider-reload")!.handler(stale, harness.context);
    expect(harness.reload).not.toHaveBeenCalled();
    await harness.dispatchQueued();
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("rechecks the gate in the command handler after dispatch", async () => {
    harness.state.dispatch = false;
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.sent).toHaveLength(1);
    harness.state.pending = true;
    await harness.dispatchQueued();
    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
    harness.state.pending = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.sent).toHaveLength(2);
    await harness.dispatchQueued();
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("attempts one reload for a build even when the reload fails", async () => {
    harness.reload.mockRejectedValueOnce(new Error("reload failed"));
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.reload).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.reload).toHaveBeenCalledOnce();

    installReadyBuild(harness.file, newer);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.reload).toHaveBeenCalledTimes(2);
  });

  it("does not try the same target again when the next activation still has the old build", async () => {
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.reload).toHaveBeenCalledOnce();
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });

    harness = fixtureHarness(directory);
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "reload" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.sent).toEqual([]);
    expect(harness.reload).not.toHaveBeenCalled();

    installReadyBuild(harness.file, newer);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("marks only the automatic shutdown as automatic", async () => {
    const observed: boolean[] = [];
    harness.reload.mockImplementation(async () => { observed.push(harness.registration?.isAutomaticReload?.() ?? false); });
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(observed).toEqual([true]);
    expect(harness.registration?.isAutomaticReload?.()).toBe(false);
    await harness.commands.get("spider-reload")!.handler("", harness.context);
    expect(observed).toEqual([true, false]);
  });

  it("notifies once in the new runtime after an automatic reload", async () => {
    const old = harness;
    old.reload.mockImplementationOnce(async () => {
      await old.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
      harness = fixtureHarness(directory, updated);
      await harness.emit("session_start", { type: "session_start", reason: "reload" });
    });
    installReadyBuild(old.file, updated);
    await old.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(old.reload).toHaveBeenCalledOnce();
    expect(harness.notify).toHaveBeenCalledExactlyOnceWith("Spider updated to bbbbbbb.", "info");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.notify).toHaveBeenCalledOnce();
  });

  it.each([initial, newer])("does not announce success when the reloaded identity is not the target", async loaded => {
    const old = harness;
    old.reload.mockImplementationOnce(async () => {
      await old.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
      harness = fixtureHarness(directory, loaded);
      await harness.emit("session_start", { type: "session_start", reason: "reload" });
    });
    installReadyBuild(old.file, updated);
    await old.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(old.reload).toHaveBeenCalledOnce();
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it("does not show an update notification after a manual reload", async () => {
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
    harness = fixtureHarness(directory, updated);
    await harness.emit("session_start", { type: "session_start", reason: "reload" });
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it("does not mistake a later manual reload for a failed automatic reload", async () => {
    installReadyBuild(harness.file, updated);
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
    installReadyBuild(harness.file, updated);
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
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.sent).toHaveLength(1);
    installReadyBuild(harness.file, newer);
    await harness.dispatchQueued();
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
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "reload" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(old.sent).toEqual([]);
    expect(old.listeners.size).toBe(0);
    expect(harness.reload).toHaveBeenCalledOnce();
    await old.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
    installReadyBuild(harness.file, newer);
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
    installReadyBuild(harness.file, updated);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    expect(harness.listeners.size).toBe(1);
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    expect(harness.listeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(harness.sent).toEqual([]);
  });
});
