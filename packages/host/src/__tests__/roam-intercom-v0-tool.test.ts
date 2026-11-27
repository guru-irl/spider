import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import net from "node:net";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { IntercomClient } from "../../../intercom/src/broker/client.js";
import { getAgentDirPath, getBrokerSocketPath, getIntercomDirPath } from "../../../intercom/src/broker/paths.js";
import { createMessageReader, writeMessage } from "../../../intercom/src/broker/framing.js";
import { requestV0Broker } from "../../../intercom/src/broker/roam-v0-client.js";
import type { RemoteSessionInfo } from "../../../intercom/src/types.js";
import { INTERCOM_HOST_EVENT } from "../../../intercom/src/host-api.js";
import { registerIntercomOnce } from "../../../intercom/src/single-instance.js";
import { startTestBroker, stopTestBroker, testBrokerEnv, testTmpDir } from "../../../intercom/src/test-support.js";
import { createHostSessionFixture } from "./fixtures/pi-events.js";
import { SessionManager, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { openDbAt, paths } from "@spider/db-core";
import { V0_ASK_MAX_MS, type V0Code, type V0Delivery, type V0Prepare, type V0Text, type V0ToolOptions } from "../../../intercom/src/roam-v0.js";

let broker: ChildProcessWithoutNullStreams;
let observer: IntercomClient;

beforeAll(async () => {
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  broker = startTestBroker(process.execPath, [join(process.cwd(), "dist/intercom/broker.mjs")], {
    cwd: process.cwd(), env: testBrokerEnv(), stdio: ["pipe", "pipe", "pipe"],
  }, "suite");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("Fixture broker did not start")); }, 2000);
    const onData = (chunk: Buffer) => { if (chunk.toString().includes("Intercom broker started")) { cleanup(); resolve(); } };
    const onExit = () => { cleanup(); reject(new Error("Fixture broker exited before startup")); };
    const cleanup = () => { clearTimeout(timer); broker.stdout.off("data", onData); broker.off("exit", onExit); };
    broker.stdout.on("data", onData);
    broker.once("exit", onExit);
  });
  observer = new IntercomClient();
  await observer.connect({ name: "observer", cwd: process.cwd(), model: "fixture", pid: process.pid, startedAt: 1, lastActivity: 1 }, "observer");
});

afterAll(async () => {
  await observer?.disconnect();
  if (broker) await stopTestBroker(broker);
  vi.unstubAllEnvs();
});

async function fixture(v0?: V0ToolOptions, options: { confirm?: () => Promise<boolean>; homeUnavailable?: boolean; failAppend?: (type: string) => boolean } = {}) {
  const configPath = join(getIntercomDirPath(), "config.json");
  if (options.confirm) writeFileSync(configPath, JSON.stringify({ confirmSend: true }), { mode: 0o600 });
  let sessionId = "sender-session";
  const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
  const entries: Array<{ type: string; data: unknown }> = [], physicalEntries: any[] = [], inbound: any[] = [];
  const renderers = new Map<string, (...args: any[]) => any>();
  const bus = new EventEmitter();
  if (options.homeUnavailable) bus.on(INTERCOM_HOST_EVENT, request => { request.home = () => "unknown"; });
  const pi = {
    events: { on(name: string, handler: (value: unknown) => void) { bus.on(name, handler); return () => { bus.off(name, handler); }; },
      emit(name: string, value: unknown) { bus.emit(name, value); } },
    on(name: string, handler: (event: any, ctx: any) => unknown) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
    getSessionName: () => "alice", setSessionName() {},
    registerMessageRenderer(name: string, renderer: (...args: any[]) => any) { renderers.set(name, renderer); },
    registerShortcut() {}, registerCommand() {},
    appendEntry(type: string, data: unknown) {
      if (options.failAppend?.(type)) throw new Error("private transcript write failure");
      entries.push({ type, data });
    },
    sendMessage(message: any) { inbound.push(message); physicalEntries.push({ ...message, type: "custom_message", id: `entry-${physicalEntries.length}` }); },
    registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) { tools.push(tool); },
    getAllTools: () => tools, getActiveTools: () => tools.map(tool => tool.name), setActiveTools() {},
  };
  const ctx = {
    cwd: process.cwd(), mode: "tui" as const, model: { id: "fixture" }, hasUI: true,
    sessionManager: { getSessionId: () => sessionId, getEntries: () => physicalEntries },
    isIdle: () => true, hasPendingMessages: () => false, abort() {},
    ui: { notify() {}, getEditorText: () => "", confirm: options.confirm ?? (async () => true) },
  };
  registerIntercomOnce(pi as never, undefined, undefined, v0);
  const emit = async (name: string, event: unknown = {}) => { for (const handler of hooks.get(name) ?? []) await handler(event, ctx); };
  await emit("session_start", { reason: "startup" });
  await vi.waitFor(async () => {
    expect((await observer.listSessions()).some(session => session.id === "sender-session")).toBe(true);
  }, { timeout: 2000, interval: 20 });
  return {
    ctx, entries, inbound, renderers, emit, tools,
    switchSession(id: string) { sessionId = id; },
    tool: tools.find(tool => tool.name === "intercom")!,
    async cleanup() { await emit("session_shutdown", { reason: "quit" }); rmSync(configPath, { force: true }); },
  };
}

const boxMachineId = "22222222-2222-4222-8222-222222222222";
const hubMachineId = "11111111-1111-4111-8111-111111111111";
const hubSessionId = "hub-session";

type RunBoxTool = (action: "send" | "ask", to: string, message: string) => ReturnType<ToolDefinition["execute"]>;

async function withConfiguredBoxHost(run: (execute: RunBoxTool, sessionId: string) => Promise<void>, admitted = true) {
  const admissionModule = await import("../roam/admission.js");
  const { default: spiderExtension } = await import("../extension.js");
  const cwd = mkdtempSync(join(testTmpDir(), "host-box-"));
  const root = paths.globalRoot; // Vitest provides a separate global root for this file.
  const roam = join(root, "roam"), herdr = join(root, "herdr"), dbPath = join(root, "spider.db");
  const ownedDirs = [cwd];
  let previousIdentity: { machine_id: string; store_key: string | null } | undefined;
  const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = testTmpDir();
  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  manager.appendMessage({ role: "user", content: "fixture", timestamp: 0 });
  const sessionId = manager.getSessionId();
  const host = createHostSessionFixture({ cwd, sessionId, sessionName: "host-box", sessionManager: manager });
  const pi = host.pi as typeof host.pi & { getAllTools(): ToolDefinition[] };
  try {
    for (const dir of [roam, herdr]) {
      mkdirSync(dir, { mode: 0o700 });
      ownedDirs.push(dir);
    }
    const config = { enabled: true, role: "box", machineId: boxMachineId, hubMachineId,
      peers: [], discoveryRoots: [], coreUnit: "core.service" };
    writeFileSync(join(roam, "config.json"), JSON.stringify(config), { mode: 0o600 });
    writeFileSync(join(roam, "machine.json"), JSON.stringify({ machineId: boxMachineId }), { mode: 0o600 });
    writeFileSync(join(roam, "intercom-v0.json"), JSON.stringify({ version: 1, sendTo: [],
      acceptFrom: [{ machineId: hubMachineId, alias: "mac" }] }), { mode: 0o600 });
    writeFileSync(join(herdr, "config.json"), JSON.stringify({ mode: "core-only", globalRoot: root,
      core: { binary: process.execPath, config: join(root, "core.toml") }, agentDirectory: getAgentDirPath(),
      shellRc: join(root, "shell.rc"), machines: [] }), { mode: 0o600 });
    const home = { sessionId, machineId: boxMachineId, epoch: 7, state: "running", destination: null, moveId: null, updatedAt: 1 };
    const db = openDbAt(dbPath, "global");
    try {
      previousIdentity = db.prepare("SELECT machine_id, store_key FROM roam_meta WHERE id=1").get() as typeof previousIdentity;
      expect(previousIdentity).toBeDefined();
      db.prepare("UPDATE roam_meta SET machine_id=?, store_key='global' WHERE id=1").run(boxMachineId);
      const insert = db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,updated_at,state) VALUES (?,?,?,1,'running')");
      insert.run(hubSessionId, hubMachineId, 3);
      if (admitted) insert.run(sessionId, boxMachineId, 7);
    } finally { db.close(); }
    // Supply the admission result without starting the host's unrelated services.
    const admission = { kind: "ordinary", home: admitted ? home : null, blockers: [] };
    vi.spyOn(admissionModule, "createAdmissionPorts").mockReturnValue({ setContext() {}, lock: async () => async () => {} } as never);
    vi.spyOn(admissionModule, "registerAdmission").mockReturnValue({ inspect: () => admission,
      refreshInitialHome: async () => admission, whenSettled: async () => admission,
      close: async () => {}, freeze: async () => {}, unfreeze: async () => {} } as never);
    spiderExtension(pi as never, { piVersion: "1.2.0" });
    // Invoke the real startup hooks up to and including intercom registration.
    for (const handler of host.hooks.get("session_start") ?? []) {
      await handler({ reason: "startup" }, host.ctx);
      if (pi.getAllTools().some(tool => tool.name === "intercom")) break;
    }
    const tool = pi.getAllTools().find(tool => tool.name === "intercom");
    expect(tool).toBeDefined();
    await vi.waitFor(async () => expect((await observer.listSessions()).some(session => session.id === sessionId)).toBe(true));
    await run((action, to, message) => tool!.execute(`host-${action}`, { action, to, message },
      new AbortController().signal, undefined, host.ctx as unknown as ExtensionContext), sessionId);
  } finally {
    try {
      for (const handler of host.hooks.get("session_shutdown") ?? []) await handler({ reason: "quit" }, host.ctx);
    } finally {
      vi.restoreAllMocks();
      if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
      for (const dir of ownedDirs) rmSync(dir, { recursive: true, force: true });
      if (previousIdentity) {
        const db = openDbAt(dbPath, "global");
        try {
          db.prepare("DELETE FROM session_homes WHERE session_id IN (?,?)").run(sessionId, hubSessionId);
          db.prepare("UPDATE roam_meta SET machine_id=?, store_key=? WHERE id=1").run(previousIdentity.machine_id, previousIdentity.store_key);
        } finally { db.close(); }
      }
    }
  }
}

it("advertises the admitted session to private lookup with the production host factory", async () => {
  await withConfiguredBoxHost(async (_execute, sessionId) => {
    const found = await requestV0Broker(getAgentDirPath(), { kind: "lookup", scopeId: null, selector: { by: "id", value: sessionId } });
    expect(found).toEqual({ kind: "matches", targets: [{ address: { sessionId, scopeId: null },
      name: "host-box", homeEpoch: 7, endpointEpoch: expect.any(String) }] });
  });
});

it.each(["send", "ask"] as const)("explains why a box cannot initiate %s to a Mac session", async action => {
  await withConfiguredBoxHost(async execute => {
    const result = await execute(action, hubSessionId, "reply-only fixture");
    expect(result.content[0]).toEqual({ type: "text",
      text: "Sessions on the Mac accept messages from other machines only as replies to their own asks." });
    expect(result.details).toMatchObject({ error: true, code: "reply-only" });
  });
});

it("wires an injected roaming factory for an admitted running home", async () => {
  const admissionModule = await import("../roam/admission.js");
  const runtimeModule = await import("@spider/roam/runtime");
  const { default: spiderExtension } = await import("../extension.js");
  const root = mkdtempSync(join(testTmpDir(), "host-"));
  const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = testTmpDir();
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "fixture", timestamp: 0 });
  const sessionId = manager.getSessionId();
  const home = { sessionId, machineId: "local-machine", epoch: 7, state: "running", destination: null, moveId: null, updatedAt: 1 };
  const gate = { inspect: () => ({ kind: "ordinary", home, blockers: [] }), refreshInitialHome: async () => ({ kind: "ordinary", home, blockers: [] }),
    whenSettled: async () => ({ kind: "ordinary", home, blockers: [] }), close: async () => {}, freeze: async () => {}, unfreeze: async () => {} };
  vi.spyOn(admissionModule, "createAdmissionPorts").mockReturnValue({ setContext() {}, lock: async () => async () => {} } as never);
  vi.spyOn(admissionModule, "registerAdmission").mockReturnValue(gate as never);
  vi.spyOn(runtimeModule, "readLocalIdentity").mockReturnValue({ enabled: true, intercom: { enabled: false } } as never);
  const prepare: V0Prepare = async () => ({
    kind: "remote", label: "b/ben",
    async send(message) { return { kind: "socket_delivered", id: message.id }; },
    async ask(message) { return { kind: "no_reply", id: message.id }; },
  });
  const factory = { hasConfig: () => true, create: () => ({ prepare }) };
  const host = createHostSessionFixture({ cwd: root, sessionId, sessionName: "host-alice", sessionManager: manager });
  try {
    spiderExtension(host.pi as never, { v0Intercom: factory, piVersion: "1.2.0" } as never);
    for (const handler of host.hooks.get("session_start") ?? []) {
      await handler({}, host.ctx);
      if ((host.pi as any).getAllTools().some((item: any) => item.name === "intercom")) break;
    }
    const registered = await vi.waitFor(async () => {
      const found = (await observer.listSessions()).find(session => session.id === sessionId);
      expect(found).toBeDefined();
      return found!;
    });
    expect(registered).toMatchObject({ v0HomeEpoch: 7 });
    expect(registered.homeEpoch).toBeUndefined();
    const tool = (host.pi as any).getAllTools().find((item: any) => item.name === "intercom");
    const result = await tool.execute("host-send", { action: "send", to: "ben", message: "hello" }, new AbortController().signal, undefined, host.ctx);
    expect(result.content[0].text).toBe("Sent to b/ben (broker accepted the message).");
  } finally {
    for (const handler of host.hooks.get("session_shutdown") ?? []) await handler({ reason: "quit" }, host.ctx);
    vi.restoreAllMocks();
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  { name: "unhomed", home: "none", kind: "ordinary", enabled: true, legacy: false, configured: true, child: false, create: true, skipLegacy: true },
  { name: "blocked", home: "running", kind: "blocked", enabled: true, legacy: false, configured: true, child: false, create: true, skipLegacy: true },
  { name: "non-running home", home: "moving", kind: "ordinary", enabled: true, legacy: false, configured: true, child: false, create: true, skipLegacy: true },
  { name: "home for another session", home: "other", kind: "ordinary", enabled: true, legacy: false, configured: true, child: false, create: true, skipLegacy: true },
  { name: "child session", home: "running", kind: "ordinary", enabled: true, legacy: false, configured: true, child: true, create: true, skipLegacy: true },
  { name: "roaming disabled", home: "running", kind: "ordinary", enabled: false, legacy: false, configured: true, child: false, create: false, skipLegacy: true },
  { name: "no v0 file", home: "running", kind: "ordinary", enabled: true, legacy: false, configured: false, child: false, create: false, skipLegacy: false },
  { name: "legacy federation enabled", home: "running", kind: "ordinary", enabled: true, legacy: true, configured: true, child: false, create: false, skipLegacy: false },
])("does not advertise v0 for $name", async scenario => {
  const admissionModule = await import("../roam/admission.js");
  const runtimeModule = await import("@spider/roam/runtime");
  const hostIntercom = await import("../roam/intercom.js");
  const { default: spiderExtension } = await import("../extension.js");
  const root = mkdtempSync(join(testTmpDir(), "host-gate-"));
  const previousCeiling = process.env.GIT_CEILING_DIRECTORIES, previousChild = process.env.PI_SUBAGENT_CHILD;
  process.env.GIT_CEILING_DIRECTORIES = testTmpDir();
  process.env.PI_SUBAGENT_CHILD = scenario.child ? "1" : "0";
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "fixture", timestamp: 0 });
  const sessionId = manager.getSessionId();
  const home = scenario.home === "none" ? null : { sessionId: scenario.home === "other" ? "another-session" : sessionId,
    machineId: "local-machine", epoch: 7, state: scenario.home === "moving" ? "moving" : "running", destination: null, moveId: null, updatedAt: 1 };
  const admission = { kind: scenario.kind, home, blockers: [] };
  const gate = { inspect: () => admission, refreshInitialHome: async () => admission, whenSettled: async () => admission,
    close: async () => {}, freeze: async () => {}, unfreeze: async () => {} };
  vi.spyOn(admissionModule, "createAdmissionPorts").mockReturnValue({ setContext() {}, lock: async () => async () => {} } as never);
  vi.spyOn(admissionModule, "registerAdmission").mockReturnValue(gate as never);
  vi.spyOn(runtimeModule, "readLocalIdentity").mockReturnValue({ enabled: scenario.enabled, intercom: { enabled: scenario.legacy } } as never);
  const legacyAdapter = vi.spyOn(hostIntercom, "registerRoamIntercom");
  const prepare = vi.fn<V0Prepare>(async () => ({ kind: "legacy" }));
  const factory = { hasConfig: vi.fn(() => scenario.configured), create: vi.fn(() => ({ prepare })) };
  const host = createHostSessionFixture({ cwd: root, sessionId, sessionName: "host-gate", sessionManager: manager });
  if (scenario.child) host.ctx.mode = "rpc";
  try {
    spiderExtension(host.pi as never, { v0Intercom: factory, piVersion: "1.2.0" } as never);
    for (const handler of host.hooks.get("session_start") ?? []) {
      await handler({}, host.ctx);
      if ((host.pi as any).getAllTools().some((item: any) => item.name === "intercom")) break;
    }
    const registered = await vi.waitFor(async () => {
      const found = (await observer.listSessions()).find(session => session.id === sessionId);
      expect(found).toBeDefined();
      return found!;
    });
    if (registered.remote) throw new Error("Host registration must be local");
    expect(registered.v0HomeEpoch).toBeUndefined();
    expect(factory.create).toHaveBeenCalledTimes(scenario.create ? 1 : 0);
    expect(legacyAdapter).toHaveBeenCalledTimes(scenario.skipLegacy ? 0 : 1);
    if (scenario.kind === "ordinary" && scenario.home !== "moving") {
      const tool = (host.pi as any).getAllTools().find((item: any) => item.name === "intercom");
      const result = await tool.execute("host-local-send", { action: "send", to: "observer", message: "local only" }, new AbortController().signal, undefined, host.ctx);
      expect(result.details).toMatchObject({ delivered: true, delivery: "socket_delivered" });
    }
    expect(prepare).toHaveBeenCalledTimes(scenario.create && scenario.kind === "ordinary" && scenario.home !== "moving" ? 1 : 0);
  } finally {
    for (const handler of host.hooks.get("session_shutdown") ?? []) await handler({ reason: "quit" }, host.ctx);
    vi.restoreAllMocks();
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = previousChild;
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([true, false])("lists remote federation sessions only when v0 is disabled (%s)", async v0Enabled => {
  const f = await fixture(v0Enabled ? { homeEpoch: () => 7, prepare: async () => ({ kind: "legacy" }) } : undefined);
  const remote: RemoteSessionInfo = { remote: true, id: "legacy-remote", address: { sessionId: "legacy-remote", scopeId: null },
    machineId: "peer-machine", machineAlias: "peer", homeEpoch: 3, activationEpoch: "peer-connection", endpointEpoch: "peer-connection",
    name: "legacy-remote-name", cwd: process.cwd(), model: "fixture", startedAt: 0, lastActivity: 0 };
  const originalList = IntercomClient.prototype.listSessions;
  const list = vi.spyOn(IntercomClient.prototype, "listSessions").mockImplementation(async function (this: IntercomClient, options) {
    return [...await originalList.call(this, options), remote];
  });
  try {
    for (const action of ["list", "list-cwd"] as const) {
      const result = await f.tool.execute(action, { action }, new AbortController().signal, undefined, f.ctx);
      if (v0Enabled) expect(result.content[0].text).not.toContain("legacy-remote-name");
      else expect(result.content[0].text).toContain("legacy-remote-name");
      expect(result.content[0].text).toContain("observer");
    }
    const status = await f.tool.execute("status", { action: "status" }, new AbortController().signal, undefined, f.ctx);
    expect(status.details.activeSessions).toBe(v0Enabled ? 2 : 3);
  } finally { list.mockRestore(); await f.cleanup(); }
});

it("advertises configured roaming targets and their text-only limits in the tool help", async () => {
  const f = await fixture({ homeEpoch: () => 7, prepare: async () => ({ kind: "legacy" }) });
  try {
    const tool = f.tool as any;
    expect(tool.description).toContain("configured roaming peer");
    expect(tool.description).toContain("text only");
    expect(tool.description).toContain("list is local only");
    expect(tool.promptSnippet).toContain("roaming");
  } finally { await f.cleanup(); }
  const local = await fixture();
  try {
    expect((local.tool as any).description).not.toContain("configured roaming peer");
    expect((local.tool as any).promptSnippet).not.toContain("roaming");
  } finally { await local.cleanup(); }
});

it("sends by name and reports socket dispatch, not consumption", async () => {
  const sent: V0Text[] = [];
  const prepare: V0Prepare = async () => ({
    kind: "remote", label: "b/ben",
    async send(message) { sent.push(message); return { kind: "socket_delivered", id: message.id }; },
    async ask(message) { return { kind: "no_reply", id: message.id }; },
  });
  const f = await fixture({ homeEpoch: id => id === "sender-session" ? 7 : undefined, prepare });
  try {
    const result = await f.tool.execute("send", { action: "send", to: "ben", message: "i5:fixture" }, new AbortController().signal, undefined, f.ctx);
    expect(result.content[0].text).toBe("Sent to b/ben (broker accepted the message).");
    expect(result.details).toMatchObject({ delivery: "socket_delivered", messageId: expect.any(String) });
    expect(sent).toEqual([{ id: result.details.messageId, timestamp: expect.any(Number), text: "i5:fixture" }]);
    expect(f.entries).toContainEqual(expect.objectContaining({ type: "intercom_sent", data: expect.objectContaining({ messageId: result.details.messageId }) }));
  } finally { await f.cleanup(); }
});

it("reports a confirmed remote send when its transcript entry cannot be saved", async () => {
  const peer = new IntercomClient(), inbox: any[] = [];
  peer.on("message", (_from, incoming) => inbox.push(incoming));
  await peer.connect({ name: "ben", address: { sessionId: "remote-peer", scopeId: null }, v0HomeEpoch: 5,
    cwd: process.cwd(), model: "fixture", pid: process.pid, startedAt: 1, lastActivity: 1 }, "remote-peer");
  const recipient = (await observer.listSessions()).find(session => session.id === "remote-peer")!;
  const from: RemoteSessionInfo = { remote: true, id: "sender-session", address: { sessionId: "sender-session", scopeId: null },
    machineId: "origin-machine", machineAlias: "origin", homeEpoch: 7, activationEpoch: "origin-connection", endpointEpoch: "origin-connection",
    name: "alice", cwd: "", model: "", startedAt: 0, lastActivity: 0 };
  const target = { address: { sessionId: "remote-peer", scopeId: null }, name: "ben", homeEpoch: 5, endpointEpoch: recipient.endpointEpoch! };
  const prepare: V0Prepare = async () => ({
    kind: "remote", label: "b/ben",
    async send(message, signal) {
      const result = await requestV0Broker(getAgentDirPath(), { kind: "deliver", from, target, message }, signal);
      if (result.kind === "matches") throw new Error("unexpected lookup result");
      return result;
    },
    async ask(message) { return { kind: "no_reply", id: message.id }; },
  });
  const f = await fixture({ homeEpoch: () => 7, prepare }, { failAppend: type => type === "intercom_sent" });
  try {
    const result = await f.tool.execute("send", { action: "send", to: "ben", message: "broker accepted" }, new AbortController().signal, undefined, f.ctx);
    await vi.waitFor(() => expect(inbox.map(item => item.content.text)).toEqual(["broker accepted"]));
    expect(result.content[0].text).toBe("Sent to b/ben (broker accepted the message).\nThe transcript entry could not be saved.");
    expect(result.details).toMatchObject({ delivered: true, delivery: "socket_delivered", messageId: expect.any(String) });
  } finally { await f.cleanup(); await peer.disconnect(); }
});

it.each(["intercom_sent", "intercom_received", "both"] as const)("reports the arrived reply when %s transcript recording fails", async failure => {
  const peer = new IntercomClient(), inbox: any[] = [], errors: unknown[] = [];
  peer.on("message", (origin, incoming) => {
    inbox.push(incoming);
    if (incoming.expectsReply) void peer.send(origin.id, { text: "confirmed reply", replyTo: incoming.id })
      .then(result => { if (!result.delivered) errors.push(result); }).catch(error => errors.push(error));
  });
  await peer.connect({ name: "ben", address: { sessionId: "remote-peer", scopeId: null }, v0HomeEpoch: 5,
    cwd: process.cwd(), model: "fixture", pid: process.pid, startedAt: 1, lastActivity: 1 }, "remote-peer");
  const recipient = (await observer.listSessions()).find(session => session.id === "remote-peer")!;
  const from: RemoteSessionInfo = { remote: true, id: "sender-session", address: { sessionId: "sender-session", scopeId: null },
    machineId: "origin-machine", machineAlias: "origin", homeEpoch: 7, activationEpoch: "origin-connection", endpointEpoch: "origin-connection",
    name: "alice", cwd: "", model: "", startedAt: 0, lastActivity: 0 };
  const target = { address: { sessionId: "remote-peer", scopeId: null }, name: "ben", homeEpoch: 5, endpointEpoch: recipient.endpointEpoch! };
  const prepare: V0Prepare = async () => ({
    kind: "remote", label: "b/ben",
    async send(message) { return { kind: "socket_delivered", id: message.id }; },
    async ask(message, timeoutMs, signal) {
      const result = await requestV0Broker(getAgentDirPath(), { kind: "ask", from, target, message, timeoutMs }, signal);
      if (result.kind === "matches") throw new Error("unexpected lookup result");
      return result;
    },
  });
  const f = await fixture({ homeEpoch: () => 7, prepare }, { failAppend: type => failure === "both"
    ? type === "intercom_sent" || type === "intercom_received" : type === failure });
  const abort = new AbortController();
  let settled: any;
  const pending = f.tool.execute("ask", { action: "ask", to: "ben", message: "broker question" }, abort.signal, undefined, f.ctx)
    .then((result: any) => { settled = result; return result; });
  try {
    await vi.waitFor(() => expect(Boolean(settled) || errors.length > 0).toBe(true));
    expect(inbox.map(item => item.content.text)).toEqual(["broker question"]);
    expect(errors).toEqual([]);
    expect(settled.content[0].text).toBe("**Reply from b/ben:**\nconfirmed reply\nThe transcript entry could not be saved.");
    expect(settled.details).toMatchObject({ delivery: "replied", messageId: expect.any(String), replyId: expect.any(String) });
    expect(f.entries.some(entry => entry.type === "intercom_sent")).toBe(failure === "intercom_received");
    expect(f.entries.some(entry => entry.type === "intercom_received")).toBe(failure === "intercom_sent");
  } finally { abort.abort(); await pending; await f.cleanup(); await peer.disconnect(); }
});

it("keeps opt-out sends on the local broker", async () => {
  const received: string[] = [];
  const onMessage = (_from: unknown, message: any) => received.push(message.content.text);
  observer.on("message", onMessage);
  const f = await fixture();
  try {
    const result = await f.tool.execute("local-send", { action: "send", to: "observer", message: "local message" }, new AbortController().signal, undefined, f.ctx);
    expect(result.details).toMatchObject({ delivered: true, delivery: "socket_delivered" });
    await vi.waitFor(() => expect(received).toEqual(["local message"]));
  } finally { observer.off("message", onMessage); await f.cleanup(); }
});

it("keeps unhomed sends local and refuses explicit remote targets", async () => {
  const received: string[] = [];
  const onMessage = (_from: unknown, message: any) => received.push(message.content.text);
  observer.on("message", onMessage);
  const prepare = vi.fn<V0Prepare>(async ({ to, from }) => {
    expect(from.v0HomeEpoch).toBeUndefined();
    return to === "b/ben" ? { kind: "refused", code: "not-configured" } : { kind: "legacy" };
  });
  const f = await fixture({ homeEpoch: () => undefined, prepare });
  try {
    const local = await f.tool.execute("local-send", { action: "send", to: "observer", message: "local message" }, new AbortController().signal, undefined, f.ctx);
    expect(local.details).toMatchObject({ delivered: true, delivery: "socket_delivered" });
    await vi.waitFor(() => expect(received).toEqual(["local message"]));
    const remote = await f.tool.execute("remote-send", { action: "send", to: "b/ben", message: "do not queue" }, new AbortController().signal, undefined, f.ctx);
    expect(remote.details).toMatchObject({ error: true, code: "not-configured" });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(received).toEqual(["local message"]);
  } finally { observer.off("message", onMessage); await f.cleanup(); }
});

it.each(["send", "ask"] as const)("refuses an unhomed remote %s even if the resolver offers dispatch", async action => {
  const attempted: V0Text[] = [];
  const prepare: V0Prepare = async () => ({
    kind: "remote", label: "b/ben",
    async send(message) { attempted.push(message); return { kind: "socket_delivered", id: message.id }; },
    async ask(message) { attempted.push(message); return { kind: "no_reply", id: message.id }; },
  });
  const f = await fixture({ homeEpoch: () => undefined, prepare });
  try {
    const result = await f.tool.execute(action, { action, to: "b/ben", message: "private text" }, new AbortController().signal, undefined, f.ctx);
    expect(result.details).toMatchObject({ error: true, code: "not-configured" });
    expect(attempted).toEqual([]);
  } finally { await f.cleanup(); }
});

it("returns the reply to a named remote ask", async () => {
  const questions: V0Text[] = [];
  const prepare: V0Prepare = async () => ({
    kind: "remote", label: "b/ben",
    async send(message) { return { kind: "socket_delivered", id: message.id }; },
    async ask(message) {
      questions.push(message);
      return { kind: "replied", id: message.id, replyId: "reply-fixture", text: "ack i5:fixture" };
    },
  });
  const f = await fixture({ homeEpoch: () => 7, prepare });
  try {
    const result = await f.tool.execute("ask", { action: "ask", to: "ben", message: "i5:fixture" }, new AbortController().signal, undefined, f.ctx);
    expect(result.content[0].text).toBe("**Reply from b/ben:**\nack i5:fixture");
    expect(result.details).toMatchObject({ delivery: "replied", messageId: questions[0].id, replyId: "reply-fixture" });
    expect(questions).toEqual([{ id: result.details.messageId, timestamp: expect.any(Number), text: "i5:fixture" }]);
    expect(f.entries).toContainEqual(expect.objectContaining({ type: "intercom_sent", data: expect.objectContaining({ messageId: questions[0].id }) }));
    expect(f.entries).toContainEqual(expect.objectContaining({ type: "intercom_received", data: expect.objectContaining({ messageId: "reply-fixture" }) }));
  } finally { await f.cleanup(); }
});

it("reports a remote ask timeout or lost call without resending", async () => {
  const oldTimeout = process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
  process.env.PI_INTERCOM_ASK_TIMEOUT_MS = String(V0_ASK_MAX_MS + 1);
  const questions: V0Text[] = [], budgets: number[] = [];
  let outcome: "no_reply" | "unknown" = "no_reply";
  const prepare: V0Prepare = async () => ({
    kind: "remote", label: "b/ben",
    async send(message) { return { kind: "socket_delivered", id: message.id }; },
    async ask(message, timeoutMs) { questions.push(message); budgets.push(timeoutMs); return { kind: outcome, id: message.id }; },
  });
  const f = await fixture({ homeEpoch: () => 7, prepare });
  try {
    const args = { action: "ask", to: "ben", message: "question" };
    const timedOut = await f.tool.execute("ask-1", args, new AbortController().signal, undefined, f.ctx);
    expect(timedOut.content[0].text).toBe(`No reply was received (ID ${questions[0].id}).`);
    expect(timedOut.details).toMatchObject({ error: true, delivery: "no_reply", messageId: questions[0].id });
    expect(f.entries.some(entry => entry.type === "intercom_sent")).toBe(false);
    outcome = "unknown";
    const unknown = await f.tool.execute("ask-2", args, new AbortController().signal, undefined, f.ctx);
    expect(unknown.content[0].text).toBe(`Delivery could not be confirmed (ID ${questions[1].id}). Check the recipient before sending again.`);
    expect(unknown.details).toMatchObject({ error: true, delivery: "unknown", messageId: questions[1].id });
    expect(questions).toHaveLength(2);
    expect(budgets).toEqual([V0_ASK_MAX_MS, V0_ASK_MAX_MS]);
  } finally {
    await f.cleanup();
    if (oldTimeout === undefined) delete process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
    else process.env.PI_INTERCOM_ASK_TIMEOUT_MS = oldTimeout;
  }
});

it("preserves a configured remote ask timeout below the cap", async () => {
  const previous = process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
  const configured = V0_ASK_MAX_MS - 1;
  process.env.PI_INTERCOM_ASK_TIMEOUT_MS = String(configured);
  let receivedTimeout = 0;
  const prepare: V0Prepare = async () => ({
    kind: "remote", label: "b/ben",
    async send(message) { return { kind: "socket_delivered", id: message.id }; },
    async ask(message, timeout) { receivedTimeout = timeout; return { kind: "no_reply", id: message.id }; },
  });
  const f = await fixture({ homeEpoch: () => 7, prepare });
  try {
    const result = await f.tool.execute("ask", { action: "ask", to: "ben", message: "question" }, new AbortController().signal, undefined, f.ctx);
    expect(result.details).toMatchObject({ delivery: "no_reply" });
    expect(receivedTimeout).toBe(configured);
  } finally {
    await f.cleanup();
    if (previous === undefined) delete process.env.PI_INTERCOM_ASK_TIMEOUT_MS; else process.env.PI_INTERCOM_ASK_TIMEOUT_MS = previous;
  }
});

it("allows only one outstanding remote ask", async () => {
  const questions: V0Text[] = [];
  let finish!: (value: { kind: "no_reply"; id: string }) => void;
  const prepare: V0Prepare = async () => ({
    kind: "remote", label: "b/ben",
    async send(message) { return { kind: "socket_delivered", id: message.id }; },
    async ask(message) {
      questions.push(message);
      if (questions.length === 1) return new Promise(resolve => { finish = resolve; });
      return { kind: "no_reply", id: message.id };
    },
  });
  const f = await fixture({ homeEpoch: () => 7, prepare });
  try {
    const args = { action: "ask", to: "ben", message: "question" };
    const first = f.tool.execute("ask-1", args, new AbortController().signal, undefined, f.ctx);
    await vi.waitFor(() => expect(questions).toHaveLength(1));
    const second = await f.tool.execute("ask-2", args, new AbortController().signal, undefined, f.ctx);
    expect(second.content[0].text).toBe("Already waiting for a reply");
    expect(questions).toHaveLength(1);
    finish({ kind: "no_reply", id: questions[0].id });
    await first;
  } finally { if (questions[0]) finish?.({ kind: "no_reply", id: questions[0].id }); await f.cleanup(); }
});

it("does not start a supervisor ask while a roaming ask is pending", async () => {
  const values = { PI_SUBAGENT_ORCHESTRATOR_TARGET: "observer", PI_SUBAGENT_RUN_ID: "fixture-run",
    PI_SUBAGENT_CHILD_AGENT: "worker", PI_SUBAGENT_CHILD_INDEX: "1" };
  const prior = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  let finish!: (result: V0Delivery) => void, question: V0Text | undefined;
  const prepare: V0Prepare = async () => ({
    kind: "remote", label: "b/ben",
    async send(message) { return { kind: "socket_delivered", id: message.id }; },
    async ask(message) { question = message; return new Promise(resolve => { finish = resolve; }); },
  });
  const inbox: unknown[] = [];
  const onMessage = (...args: unknown[]) => inbox.push(args);
  observer.on("message", onMessage);
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  const abort = new AbortController();
  let first: Promise<any> | undefined, second: Promise<any> | undefined, result: any;
  try {
    f = await fixture({ homeEpoch: () => 7, prepare });
    const supervisor = f.tools.find(tool => tool.name === "contact_supervisor")!;
    expect(supervisor).toBeDefined();
    first = f.tool.execute("remote-ask", { action: "ask", to: "ben", message: "first" }, new AbortController().signal, undefined, f.ctx);
    await vi.waitFor(() => expect(question).toBeDefined());
    second = supervisor.execute("supervisor-ask", { reason: "need_decision", message: "second" }, abort.signal, undefined, f.ctx)
      .then((value: any) => { result = value; return value; });
    await vi.waitFor(() => expect(Boolean(result) || inbox.length > 0).toBe(true));
    expect(inbox).toEqual([]);
    expect(result.content[0].text).toBe("Already waiting for a reply");
  } finally {
    abort.abort(); await second;
    if (question) finish?.({ kind: "no_reply", id: question.id });
    await first; if (f) await f.cleanup();
    observer.off("message", onMessage);
    for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

it("renders and replies to a peer ask through the private broker", async () => {
  const f = await fixture({ homeEpoch: () => 7, prepare: async () => ({ kind: "legacy" }) });
  const from: RemoteSessionInfo = {
    remote: true, id: "peer-session", address: { sessionId: "peer-session", scopeId: null },
    machineId: "peer-machine", machineAlias: "peer", homeEpoch: 3,
    activationEpoch: "peer-connection", endpointEpoch: "peer-connection", name: "ben",
    cwd: "", model: "", startedAt: 0, lastActivity: 0,
  };
  try {
    const own = (await observer.listSessions()).find(session => session.id === "sender-session")!;
    const pending = requestV0Broker(getAgentDirPath(), {
      kind: "ask", from,
      target: { address: { sessionId: "sender-session", scopeId: null }, name: "alice", homeEpoch: 7, endpointEpoch: own.endpointEpoch! },
      message: { id: "peer-question", timestamp: 123, text: "i5:fixture" }, timeoutMs: 2000,
    });
    await vi.waitFor(() => expect(f.inbound.some(message => message.customType === "intercom_message")).toBe(true));
    const incoming = f.inbound.find(message => message.customType === "intercom_message");
    expect(incoming.content).toContain("**From peer/ben**");
    expect(incoming.content).toContain("i5:fixture");
    expect(incoming.content).not.toContain("**From peer/ben** ()");
    const renderer = f.renderers.get("intercom_message")!;
    const component = renderer(incoming, { expanded: true }, { fg: (_: string, text: string) => text });
    const rendered = component.render(100).join("\n");
    expect(rendered).toContain("From: peer/ben");
    expect(rendered).toContain("i5:fixture");
    expect(rendered).not.toContain("peer/ben ()");
    const reply = await f.tool.execute("reply", { action: "reply", replyTo: "peer-question", message: "ack i5:fixture" }, new AbortController().signal, undefined, f.ctx);
    expect(reply.details).toMatchObject({ delivered: true, replyTo: "peer-question" });
    expect(await pending).toMatchObject({ kind: "replied", id: "peer-question", replyId: reply.details.messageId, text: "ack i5:fixture" });
  } finally { await f.cleanup(); }
});

it("reports a confirmed peer reply when its transcript entry cannot be saved", async () => {
  const f = await fixture({ homeEpoch: () => 7, prepare: async () => ({ kind: "legacy" }) }, { failAppend: type => type === "intercom_sent" });
  const from: RemoteSessionInfo = {
    remote: true, id: "peer-session", address: { sessionId: "peer-session", scopeId: null },
    machineId: "peer-machine", machineAlias: "peer", homeEpoch: 3,
    activationEpoch: "peer-connection", endpointEpoch: "peer-connection", name: "ben",
    cwd: "", model: "", startedAt: 0, lastActivity: 0,
  };
  const abort = new AbortController();
  let pending: ReturnType<typeof requestV0Broker> | undefined;
  try {
    const own = (await observer.listSessions()).find(session => session.id === "sender-session")!;
    pending = requestV0Broker(getAgentDirPath(), {
      kind: "ask", from,
      target: { address: { sessionId: "sender-session", scopeId: null }, name: "alice", homeEpoch: 7, endpointEpoch: own.endpointEpoch! },
      message: { id: "unsaved-reply-question", timestamp: 123, text: "hello" }, timeoutMs: 2000,
    }, abort.signal);
    await vi.waitFor(() => expect(f.inbound.some(message => message.customType === "intercom_message")).toBe(true));
    const result = await f.tool.execute("reply", { action: "reply", replyTo: "unsaved-reply-question", message: "confirmed answer" }, new AbortController().signal, undefined, f.ctx);
    expect(await pending).toMatchObject({ kind: "replied", id: "unsaved-reply-question", text: "confirmed answer" });
    expect(result.content[0].text).toBe("Reply sent to ben\nThe transcript entry could not be saved.");
    expect(result.details).toMatchObject({ delivered: true, delivery: "socket_delivered", replyTo: "unsaved-reply-question" });
  } finally { abort.abort(); await pending; await f.cleanup(); }
});

it("refuses unsupported remote reply options and leaves the ask pending", async () => {
  const f = await fixture({ homeEpoch: () => 7, prepare: async () => ({ kind: "legacy" }) });
  const from: RemoteSessionInfo = {
    remote: true, id: "peer-session", address: { sessionId: "peer-session", scopeId: null },
    machineId: "peer-machine", machineAlias: "peer", homeEpoch: 3,
    activationEpoch: "peer-connection", endpointEpoch: "peer-connection", name: "ben",
    cwd: "", model: "", startedAt: 0, lastActivity: 0,
  };
  const abort = new AbortController();
  let pending: ReturnType<typeof requestV0Broker> | undefined;
  try {
    const own = (await observer.listSessions()).find(session => session.id === "sender-session")!;
    pending = requestV0Broker(getAgentDirPath(), {
      kind: "ask", from,
      target: { address: { sessionId: "sender-session", scopeId: null }, name: "alice", homeEpoch: 7, endpointEpoch: own.endpointEpoch! },
      message: { id: "reply-options-question", timestamp: 123, text: "hello" }, timeoutMs: 2000,
    }, abort.signal);
    await vi.waitFor(() => expect(f.inbound.some(message => message.customType === "intercom_message")).toBe(true));
    const unsupported = [
      { cwd: "/fixture" }, { attachments: [{ type: "snippet", name: "x", content: "x" }] },
      { supersedes: "old" }, { retryOf: "old" }, { messageId: "old" },
      { supersedes: " " }, { retryOf: " " }, { messageId: " " },
      { openProjectPaneIfMissing: true }, { focus: true },
    ];
    for (const flags of unsupported) {
      const result = await f.tool.execute("reply", { action: "reply", replyTo: "reply-options-question", message: "answer", ...flags }, new AbortController().signal, undefined, f.ctx);
      expect(result.details).toMatchObject({ error: true, code: "unsupported" });
    }
    const reply = await f.tool.execute("reply", { action: "reply", replyTo: "reply-options-question", message: "plain answer" }, new AbortController().signal, undefined, f.ctx);
    expect(reply.details).toMatchObject({ delivered: true, replyTo: "reply-options-question" });
    expect(await pending).toMatchObject({ kind: "replied", id: "reply-options-question", text: "plain answer" });
  } finally { abort.abort(); await pending; await f.cleanup(); }
});

it("does not answer a remote ask after the replier's home epoch changes", async () => {
  let epoch = 7;
  const f = await fixture({ homeEpoch: () => epoch, prepare: async () => ({ kind: "legacy" }) });
  const from: RemoteSessionInfo = {
    remote: true, id: "peer-session", address: { sessionId: "peer-session", scopeId: null },
    machineId: "peer-machine", machineAlias: "peer", homeEpoch: 3,
    activationEpoch: "peer-connection", endpointEpoch: "peer-connection", name: "ben",
    cwd: "", model: "", startedAt: 0, lastActivity: 0,
  };
  const abort = new AbortController();
  let pending: ReturnType<typeof requestV0Broker> | undefined;
  try {
    const own = (await observer.listSessions()).find(session => session.id === "sender-session")!;
    pending = requestV0Broker(getAgentDirPath(), {
      kind: "ask", from,
      target: { address: { sessionId: "sender-session", scopeId: null }, name: "alice", homeEpoch: 7, endpointEpoch: own.endpointEpoch! },
      message: { id: "reply-epoch-question", timestamp: 123, text: "hello" }, timeoutMs: 2000,
    }, abort.signal);
    await vi.waitFor(() => expect(f.inbound.some(message => message.customType === "intercom_message")).toBe(true));
    epoch = 8;
    const stale = await f.tool.execute("reply", { action: "reply", replyTo: "reply-epoch-question", message: "stale answer" }, new AbortController().signal, undefined, f.ctx);
    expect(stale.details).toMatchObject({ error: true, code: "changed" });
    epoch = 7;
    const reply = await f.tool.execute("reply", { action: "reply", replyTo: "reply-epoch-question", message: "current answer" }, new AbortController().signal, undefined, f.ctx);
    expect(reply.details).toMatchObject({ delivered: true, replyTo: "reply-epoch-question" });
    expect(await pending).toMatchObject({ kind: "replied", id: "reply-epoch-question", text: "current answer" });
  } finally { abort.abort(); await pending; await f.cleanup(); }
});

it("does not record a completed remote reply in a replacement session", async () => {
  const f = await fixture({ homeEpoch: () => 7, prepare: async () => ({ kind: "legacy" }) });
  const from: RemoteSessionInfo = {
    remote: true, id: "peer-session", address: { sessionId: "peer-session", scopeId: null },
    machineId: "peer-machine", machineAlias: "peer", homeEpoch: 3,
    activationEpoch: "peer-connection", endpointEpoch: "peer-connection", name: "ben",
    cwd: "", model: "", startedAt: 0, lastActivity: 0,
  };
  const abort = new AbortController();
  let pendingAsk: ReturnType<typeof requestV0Broker> | undefined, reply: Promise<any> | undefined;
  let finish!: () => void, delivered = false;
  const originalSend = IntercomClient.prototype.send;
  const send = vi.spyOn(IntercomClient.prototype, "send").mockImplementation(async function (this: IntercomClient, to, options) {
    const result = await originalSend.call(this, to, options);
    if (options.replyTo === "reply-switch-question") {
      await new Promise<void>(resolve => { delivered = true; finish = resolve; });
    }
    return result;
  });
  try {
    const own = (await observer.listSessions()).find(session => session.id === "sender-session")!;
    pendingAsk = requestV0Broker(getAgentDirPath(), {
      kind: "ask", from,
      target: { address: { sessionId: "sender-session", scopeId: null }, name: "alice", homeEpoch: 7, endpointEpoch: own.endpointEpoch! },
      message: { id: "reply-switch-question", timestamp: 123, text: "hello" }, timeoutMs: 2000,
    }, abort.signal);
    await vi.waitFor(() => expect(f.inbound.some(message => message.customType === "intercom_message")).toBe(true));
    reply = f.tool.execute("reply", { action: "reply", replyTo: "reply-switch-question", message: "answer" }, new AbortController().signal, undefined, f.ctx);
    await vi.waitFor(() => expect(delivered).toBe(true));
    f.switchSession("replacement-session");
    await f.emit("turn_start");
    finish();
    const result = await reply;
    expect(result.details).toMatchObject({ delivery: "unknown", outcomeKnown: false });
    expect(f.entries.some(entry => entry.type === "intercom_sent")).toBe(false);
    expect(await pendingAsk).toMatchObject({ kind: "replied", id: "reply-switch-question", text: "answer" });
  } finally { finish?.(); abort.abort(); await reply; await pendingAsk; send.mockRestore(); await f.cleanup(); }
});

it("replies to a peer ask without consulting legacy home routing", async () => {
  const f = await fixture({ homeEpoch: () => 7, prepare: async () => ({ kind: "legacy" }) }, { homeUnavailable: true });
  const from: RemoteSessionInfo = {
    remote: true, id: "peer-session", address: { sessionId: "peer-session", scopeId: null },
    machineId: "peer-machine", machineAlias: "peer", homeEpoch: 3,
    activationEpoch: "peer-connection", endpointEpoch: "peer-connection", name: "ben",
    cwd: "", model: "", startedAt: 0, lastActivity: 0,
  };
  try {
    const own = (await observer.listSessions()).find(session => session.id === "sender-session")!;
    const pending = requestV0Broker(getAgentDirPath(), {
      kind: "ask", from,
      target: { address: { sessionId: "sender-session", scopeId: null }, name: "alice", homeEpoch: 7, endpointEpoch: own.endpointEpoch! },
      message: { id: "bound-question", timestamp: 123, text: "hello" }, timeoutMs: 2000,
    });
    await vi.waitFor(() => expect(f.inbound.some(message => message.customType === "intercom_message")).toBe(true));
    const reply = await f.tool.execute("reply", { action: "reply", replyTo: "bound-question", message: "answer" }, new AbortController().signal, undefined, f.ctx);
    expect(reply.content[0].text).toBe("Reply sent to ben");
    expect(reply.details).toMatchObject({ delivered: true, replyTo: "bound-question" });
    expect(await pending).toMatchObject({ kind: "replied", id: "bound-question", text: "answer" });
  } finally { await f.cleanup(); }
});

it("shows the broker's exact refusal for a late peer reply", async () => {
  const f = await fixture({ homeEpoch: () => 7, prepare: async () => ({ kind: "legacy" }) });
  const from: RemoteSessionInfo = {
    remote: true, id: "peer-session", address: { sessionId: "peer-session", scopeId: null },
    machineId: "peer-machine", machineAlias: "peer", homeEpoch: 3,
    activationEpoch: "peer-connection", endpointEpoch: "peer-connection", name: "ben",
    cwd: "", model: "", startedAt: 0, lastActivity: 0,
  };
  let socket: net.Socket | undefined;
  try {
    const own = (await observer.listSessions()).find(session => session.id === "sender-session")!;
    socket = net.connect(getBrokerSocketPath());
    const askSocket = socket;
    const completed = new Promise<any>((resolve, reject) => {
      askSocket.on("error", reject);
      askSocket.on("data", createMessageReader(value => {
        const frame = value as any;
        if (frame.type === "health_ok") writeMessage(askSocket, {
          type: "roam_v0", requestId: "late-request", kind: "ask", from,
          target: { address: { sessionId: "sender-session", scopeId: null }, name: "alice", homeEpoch: 7, endpointEpoch: own.endpointEpoch! },
          message: { id: "late-question", timestamp: 123, text: "hello" }, timeoutMs: 100,
        });
        if (frame.type === "roam_v0_result") resolve(frame);
      }, reject));
      askSocket.on("connect", () => writeMessage(askSocket, { type: "health", requestId: "late-health" }));
    });
    await vi.waitFor(() => expect(f.inbound.some(message => message.customType === "intercom_message")).toBe(true));
    expect(await completed).toMatchObject({ kind: "no_reply", id: "late-question" });
    const reply = await f.tool.execute("reply", { action: "reply", replyTo: "late-question", message: "too late" }, new AbortController().signal, undefined, f.ctx);
    expect(reply.content[0].text).toBe("The asker is no longer waiting.");
    expect(reply.details).toMatchObject({ delivered: false });
  } finally { socket?.destroy(); await f.cleanup(); }
});

it("closes an outstanding remote ask when the session is replaced", async () => {
  let receivedSignal: AbortSignal | undefined, questionId = "";
  const prepare: V0Prepare = async () => ({
    kind: "remote", label: "b/ben",
    async send(message) { return { kind: "socket_delivered", id: message.id }; },
    async ask(message, _timeout, signal) {
      receivedSignal = signal;
      questionId = message.id;
      return new Promise(resolve => signal!.addEventListener("abort", () => resolve({ kind: "unknown", id: message.id }), { once: true }));
    },
  });
  const f = await fixture({ homeEpoch: () => 7, prepare });
  const outer = new AbortController();
  const pending = f.tool.execute("ask", { action: "ask", to: "ben", message: "hello" }, outer.signal, undefined, f.ctx);
  try {
    await vi.waitFor(() => expect(receivedSignal).toBeDefined());
    f.switchSession("replacement-session");
    await f.emit("turn_start");
    expect(receivedSignal!.aborted).toBe(true);
    const result = await pending;
    expect(result.details).toMatchObject({ delivery: "unknown", messageId: questionId });
    expect(f.entries.some(entry => entry.type === "intercom_received" || entry.type === "intercom_sent")).toBe(false);
  } finally { outer.abort(); await pending; await f.cleanup(); }
});

it("does not dispatch a remote ask when confirmation is refused", async () => {
  const questions: V0Text[] = [];
  const prepare: V0Prepare = async () => ({
    kind: "remote", label: "b/ben",
    async send(message) { return { kind: "socket_delivered", id: message.id }; },
    async ask(message) { questions.push(message); return { kind: "no_reply", id: message.id }; },
  });
  const f = await fixture({ homeEpoch: () => 7, prepare }, { confirm: async () => false });
  try {
    const result = await f.tool.execute("ask", { action: "ask", to: "ben", message: "private text" }, new AbortController().signal, undefined, f.ctx);
    expect(result.content[0].text).toBe("Message cancelled by user");
    expect(questions).toEqual([]);
  } finally { await f.cleanup(); }
});

it("does not dispatch a remote ask after a session change during confirmation", async () => {
  const questions: V0Text[] = [];
  let finish!: (value: boolean) => void, confirmationOpened = false;
  const confirm = () => new Promise<boolean>(resolve => { finish = resolve; confirmationOpened = true; });
  const prepare: V0Prepare = async () => ({
    kind: "remote", label: "b/ben",
    async send(message) { return { kind: "socket_delivered", id: message.id }; },
    async ask(message) { questions.push(message); return { kind: "no_reply", id: message.id }; },
  });
  const f = await fixture({ homeEpoch: () => 7, prepare }, { confirm });
  try {
    const pending = f.tool.execute("ask", { action: "ask", to: "ben", message: "private text" }, new AbortController().signal, undefined, f.ctx);
    await vi.waitFor(() => expect(confirmationOpened).toBe(true));
    f.switchSession("different-session");
    finish(true);
    const result = await pending;
    expect(result.details).toMatchObject({ error: true, code: "changed" });
    expect(questions).toEqual([]);
  } finally { finish?.(false); await f.cleanup(); }
});

it.each(["send", "ask"] as const)("does not dispatch a cancelled remote %s after confirmation", async action => {
  const attempted: V0Text[] = [];
  let finish!: (value: boolean) => void, confirmationOpened = false;
  const confirm = () => new Promise<boolean>(resolve => { finish = resolve; confirmationOpened = true; });
  const prepare: V0Prepare = async () => ({
    kind: "remote", label: "b/ben",
    async send(message) { attempted.push(message); return { kind: "socket_delivered", id: message.id }; },
    async ask(message) { attempted.push(message); return { kind: "no_reply", id: message.id }; },
  });
  const f = await fixture({ homeEpoch: () => 7, prepare }, { confirm });
  const abort = new AbortController();
  try {
    const pending = f.tool.execute(action, { action, to: "ben", message: "private text" }, abort.signal, undefined, f.ctx);
    await vi.waitFor(() => expect(confirmationOpened).toBe(true));
    abort.abort();
    finish(true);
    const result = await pending;
    expect(result.content[0].text).toBe("Cancelled");
    expect(result.details).toMatchObject({ error: true });
    expect(attempted).toEqual([]);
  } finally { finish?.(false); await f.cleanup(); }
});

it("does not send when confirmation finishes in a different session", async () => {
  const sent: V0Text[] = [];
  let finish!: (value: boolean) => void;
  let confirmationOpened = false;
  const confirm = () => new Promise<boolean>(resolve => { finish = resolve; confirmationOpened = true; });
  const prepare: V0Prepare = async () => ({
    kind: "remote", label: "b/ben",
    async send(message) { sent.push(message); return { kind: "socket_delivered", id: message.id }; },
    async ask(message) { return { kind: "no_reply", id: message.id }; },
  });
  const f = await fixture({ homeEpoch: () => 7, prepare }, { confirm });
  try {
    const pending = f.tool.execute("send", { action: "send", to: "ben", message: "private text" }, new AbortController().signal, undefined, f.ctx);
    await vi.waitFor(() => expect(confirmationOpened).toBe(true));
    expect(sent).toEqual([]);
    f.switchSession("different-session");
    finish(true);
    const result = await pending;
    expect(result.details).toMatchObject({ error: true });
    expect(sent).toEqual([]);
  } finally { finish?.(false); await f.cleanup(); }
});

it("does not record a completed remote send in a replacement session", async () => {
  let finish!: (result: { kind: "socket_delivered"; id: string }) => void, sent: V0Text | undefined;
  const prepare: V0Prepare = async () => ({
    kind: "remote", label: "b/ben",
    async send(message) { sent = message; return new Promise(resolve => { finish = resolve; }); },
    async ask(message) { return { kind: "no_reply", id: message.id }; },
  });
  const f = await fixture({ homeEpoch: () => 7, prepare });
  try {
    const pending = f.tool.execute("send", { action: "send", to: "ben", message: "old session" }, new AbortController().signal, undefined, f.ctx);
    await vi.waitFor(() => expect(sent).toBeDefined());
    f.switchSession("replacement-session");
    await f.emit("turn_start");
    finish({ kind: "socket_delivered", id: sent!.id });
    const result = await pending;
    expect(result.details).toMatchObject({ delivery: "unknown", messageId: sent!.id, outcomeKnown: false });
    expect(f.entries.some(entry => entry.type === "intercom_sent")).toBe(false);
  } finally { if (sent) finish?.({ kind: "socket_delivered", id: sent.id }); await f.cleanup(); }
});

it.each(["send", "ask"] as const)("does not record a remote %s after source admission changes in flight", async action => {
  let finish!: (result: V0Delivery) => void, sent: V0Text | undefined, epoch = 7;
  const prepare: V0Prepare = async () => ({
    kind: "remote", label: "b/ben",
    async send(message) { sent = message; return new Promise(resolve => { finish = resolve; }); },
    async ask(message) { sent = message; return new Promise(resolve => { finish = resolve; }); },
  });
  const f = await fixture({ homeEpoch: () => epoch, prepare });
  try {
    const pending = f.tool.execute(action, { action, to: "ben", message: "old home" }, new AbortController().signal, undefined, f.ctx);
    await vi.waitFor(() => expect(sent).toBeDefined());
    epoch = 8;
    finish(action === "send" ? { kind: "socket_delivered", id: sent!.id } : { kind: "replied", id: sent!.id, replyId: "reply", text: "answer" });
    const result = await pending;
    expect(result.details).toMatchObject({ delivery: "unknown", messageId: sent!.id, outcomeKnown: false });
    expect(f.entries.some(entry => entry.type === "intercom_sent" || entry.type === "intercom_received")).toBe(false);
  } finally { if (sent) finish?.({ kind: "unknown", id: sent.id }); await f.cleanup(); }
});

it("does not send after the source home epoch changes during confirmation", async () => {
  const sent: V0Text[] = [];
  let epoch = 7, finish!: (value: boolean) => void, confirmationOpened = false;
  const confirm = () => new Promise<boolean>(resolve => { finish = resolve; confirmationOpened = true; });
  const prepare: V0Prepare = async () => ({
    kind: "remote", label: "b/ben",
    async send(message) { sent.push(message); return { kind: "socket_delivered", id: message.id }; },
    async ask(message) { return { kind: "no_reply", id: message.id }; },
  });
  const f = await fixture({ homeEpoch: () => epoch, prepare }, { confirm });
  try {
    const pending = f.tool.execute("send", { action: "send", to: "ben", message: "private text" }, new AbortController().signal, undefined, f.ctx);
    await vi.waitFor(() => expect(confirmationOpened).toBe(true));
    epoch = 8;
    finish(true);
    const result = await pending;
    expect(result.details).toMatchObject({ error: true, code: "changed" });
    expect(sent).toEqual([]);
  } finally { finish?.(false); await f.cleanup(); }
});

it("refuses remote-only unsupported options without dispatching", async () => {
  const sent: V0Text[] = [];
  const prepare: V0Prepare = async () => ({
    kind: "remote", label: "b/ben",
    async send(message) { sent.push(message); return { kind: "socket_delivered", id: message.id }; },
    async ask(message) { sent.push(message); return { kind: "no_reply", id: message.id }; },
  });
  const f = await fixture({ homeEpoch: () => 7, prepare });
  try {
    const unsupported = [
      { cwd: "/fixture" }, { attachments: [{ type: "snippet", name: "x", content: "x" }] },
      { replyTo: "question" }, { supersedes: "old" }, { retryOf: "old" }, { messageId: "old" },
      { replyTo: " " }, { supersedes: " " }, { retryOf: " " }, { messageId: " " },
      { openProjectPaneIfMissing: true }, { focus: true },
    ];
    for (const flags of unsupported) {
      const result = await f.tool.execute("send", { action: "send", to: "ben", message: "private text", ...flags }, new AbortController().signal, undefined, f.ctx);
      expect(result.details).toMatchObject({ error: true });
      expect(sent).toEqual([]);
    }
  } finally { await f.cleanup(); }
});

it("refuses unsupported remote ask options without dispatching", async () => {
  const questions: V0Text[] = [];
  const prepare: V0Prepare = async () => ({
    kind: "remote", label: "b/ben",
    async send(message) { return { kind: "socket_delivered", id: message.id }; },
    async ask(message) { questions.push(message); return { kind: "no_reply", id: message.id }; },
  });
  const f = await fixture({ homeEpoch: () => 7, prepare });
  try {
    const unsupported = [
      { cwd: "/fixture" }, { attachments: [{ type: "snippet", name: "x", content: "x" }] },
      { replyTo: "question" }, { supersedes: "old" }, { retryOf: "old" }, { messageId: "old" },
      { replyTo: " " }, { supersedes: " " }, { retryOf: " " }, { messageId: " " },
      { openProjectPaneIfMissing: true }, { focus: true },
    ];
    for (const flags of unsupported) {
      const result = await f.tool.execute("ask", { action: "ask", to: "ben", message: "private text", ...flags }, new AbortController().signal, undefined, f.ctx);
      expect(result.details).toMatchObject({ error: true });
      expect(questions).toEqual([]);
    }
  } finally { await f.cleanup(); }
});

it("delivers pinned local roaming sends and asks to the live endpoint", async () => {
  const received: any[] = [], errors: unknown[] = [];
  const onMessage = (from: any, incoming: any) => {
    received.push(incoming);
    if (incoming.expectsReply) void observer.send(from.id, { text: "local answer", replyTo: incoming.id }).catch(error => errors.push(error));
  };
  observer.on("message", onMessage);
  const prepare: V0Prepare = async ({ locals }) => {
    const target = locals.find(session => session.id === "observer")!;
    return { kind: "local", target: { id: target.id, endpointEpoch: target.endpointEpoch! } };
  };
  const f = await fixture({ homeEpoch: () => 7, prepare });
  const abort = new AbortController();
  let pending: Promise<any> | undefined, settled: any;
  try {
    const send = await f.tool.execute("send", { action: "send", to: "observer", message: "local update" }, new AbortController().signal, undefined, f.ctx);
    expect(send.details).toMatchObject({ delivered: true, delivery: "socket_delivered" });
    pending = f.tool.execute("ask", { action: "ask", to: "observer", message: "local question" }, abort.signal, undefined, f.ctx)
      .then((result: any) => { settled = result; return result; });
    await vi.waitFor(() => expect(Boolean(settled) || errors.length > 0).toBe(true));
    expect(settled.content[0].text).toContain("local answer");
    expect(received.map(message => message.content.text)).toEqual(["local update", "local question"]);
    expect(errors).toEqual([]);
  } finally { abort.abort(); await pending; observer.off("message", onMessage); await f.cleanup(); }
});

it("does not retarget a local roaming send after the recipient reconnects", async () => {
  const inbox: unknown[] = [];
  const prepare: V0Prepare = async ({ locals }) => {
    const target = locals.find(session => session.id === "observer")!;
    const exactTarget = { id: target.id, endpointEpoch: target.endpointEpoch! };
    await observer.disconnect();
    observer = new IntercomClient();
    observer.on("message", (...args: unknown[]) => inbox.push(args));
    await observer.connect({ name: "observer", cwd: process.cwd(), model: "fixture", pid: process.pid, startedAt: 1, lastActivity: 1 }, "observer");
    return { kind: "local", target: exactTarget };
  };
  const f = await fixture({ homeEpoch: () => 7, prepare });
  try {
    const result = await f.tool.execute("send", { action: "send", to: "observer", message: "old endpoint only" }, new AbortController().signal, undefined, f.ctx);
    expect(result.details).toMatchObject({ delivered: false });
    expect(inbox).toEqual([]);
  } finally { await f.cleanup(); }
});

it("refuses a local roaming send when the source admission epoch changed", async () => {
  const inbox: unknown[] = [];
  const onMessage = (...args: unknown[]) => inbox.push(args);
  observer.on("message", onMessage);
  let epoch = 7;
  const prepare: V0Prepare = async ({ locals }) => {
    const target = locals.find(session => session.id === "observer")!;
    return { kind: "local", target: { id: target.id, endpointEpoch: target.endpointEpoch! } };
  };
  const f = await fixture({ homeEpoch: () => epoch, prepare });
  try {
    epoch = 8;
    const result = await f.tool.execute("send", { action: "send", to: "observer", message: "stale source" }, new AbortController().signal, undefined, f.ctx);
    expect(result.details).toMatchObject({ error: true, code: "changed" });
    expect(inbox).toEqual([]);
  } finally { observer.off("message", onMessage); await f.cleanup(); }
});

it.each(["send", "ask"] as const)("refuses a roaming %s when its source registration is missing", async action => {
  const inbox: unknown[] = [];
  const onMessage = (...args: unknown[]) => inbox.push(args);
  observer.on("message", onMessage);
  const prepare = vi.fn<V0Prepare>(async () => ({ kind: "legacy" }));
  const f = await fixture({ homeEpoch: () => 7, prepare });
  const originalList = IntercomClient.prototype.listSessions;
  const list = vi.spyOn(IntercomClient.prototype, "listSessions").mockImplementation(async function (this: IntercomClient, options) {
    const sessions = await originalList.call(this, options);
    return this.sessionId === "sender-session" ? sessions.filter(session => session.id !== "sender-session") : sessions;
  });
  const abort = new AbortController();
  let settled: any;
  const pending = f.tool.execute(action, { action, to: "observer", message: "unregistered source" }, abort.signal, undefined, f.ctx)
    .then((result: any) => { settled = result; return result; });
  try {
    await vi.waitFor(() => expect(Boolean(settled) || inbox.length > 0).toBe(true));
    expect(inbox).toEqual([]);
    expect(settled.details).toMatchObject({ error: true, code: "changed" });
    expect(prepare).not.toHaveBeenCalled();
  } finally { abort.abort(); await pending; list.mockRestore(); observer.off("message", onMessage); await f.cleanup(); }
});

it.each(["send", "ask"] as const)("does not fall back after the unhomed %s session changes", async action => {
  const inbox: unknown[] = [];
  const onMessage = (...args: unknown[]) => inbox.push(args);
  observer.on("message", onMessage);
  let finish!: (plan: { kind: "legacy" }) => void, preparing = false;
  const prepare: V0Prepare = async () => new Promise(resolve => { preparing = true; finish = resolve; });
  const f = await fixture({ homeEpoch: () => undefined, prepare });
  const abort = new AbortController();
  let settled: any;
  const pending = f.tool.execute(action, { action, to: "observer", message: "old session" }, abort.signal, undefined, f.ctx)
    .then((result: any) => { settled = result; return result; });
  try {
    await vi.waitFor(() => expect(preparing).toBe(true));
    f.switchSession("replacement-session");
    finish({ kind: "legacy" });
    await vi.waitFor(() => expect(Boolean(settled) || inbox.length > 0).toBe(true));
    expect(inbox).toEqual([]);
    expect(settled.details).toMatchObject({ error: true, code: "changed" });
  } finally { finish?.({ kind: "legacy" }); abort.abort(); await pending; observer.off("message", onMessage); await f.cleanup(); }
});

it("does not send an unhomed local fallback after its session changes during confirmation", async () => {
  const inbox: unknown[] = [];
  const onMessage = (...args: unknown[]) => inbox.push(args);
  observer.on("message", onMessage);
  let finish!: (value: boolean) => void, confirmationOpened = false;
  const confirm = () => new Promise<boolean>(resolve => { finish = resolve; confirmationOpened = true; });
  const f = await fixture({ homeEpoch: () => undefined, prepare: async () => ({ kind: "legacy" }) }, { confirm });
  try {
    const pending = f.tool.execute("send", { action: "send", to: "observer", message: "old session" }, new AbortController().signal, undefined, f.ctx);
    await vi.waitFor(() => expect(confirmationOpened).toBe(true));
    f.switchSession("replacement-session");
    finish(true);
    const result = await pending;
    expect(result.details).toMatchObject({ error: true, code: "changed" });
    expect(inbox).toEqual([]);
  } finally { finish?.(false); observer.off("message", onMessage); await f.cleanup(); }
});

it("does not ask through an unhomed fallback after the session changes during lookup", async () => {
  const inbox: unknown[] = [];
  const onMessage = (...args: unknown[]) => inbox.push(args);
  observer.on("message", onMessage);
  const f = await fixture({ homeEpoch: () => undefined, prepare: async () => ({ kind: "legacy" }) });
  const originalList = IntercomClient.prototype.listSessions;
  let calls = 0, lookupBlocked = false, finish!: () => void;
  const list = vi.spyOn(IntercomClient.prototype, "listSessions").mockImplementation(async function (this: IntercomClient, options) {
    if (this.sessionId === "sender-session" && ++calls === 2) await new Promise<void>(resolve => { lookupBlocked = true; finish = resolve; });
    return originalList.call(this, options);
  });
  const abort = new AbortController();
  let settled: any;
  const pending = f.tool.execute("ask", { action: "ask", to: "observer", message: "old session" }, abort.signal, undefined, f.ctx)
    .then((result: any) => { settled = result; return result; });
  try {
    await vi.waitFor(() => expect(lookupBlocked).toBe(true));
    f.switchSession("replacement-session");
    finish();
    await vi.waitFor(() => expect(Boolean(settled) || inbox.length > 0).toBe(true));
    expect(inbox).toEqual([]);
    expect(settled.details).toMatchObject({ error: true, code: "changed" });
  } finally { finish?.(); abort.abort(); await pending; list.mockRestore(); observer.off("message", onMessage); await f.cleanup(); }
});

it("does not retarget a local roaming ask after the recipient reconnects", async () => {
  const inbox: unknown[] = [];
  const prepare: V0Prepare = async ({ locals }) => {
    const target = locals.find(session => session.id === "observer")!;
    const exactTarget = { id: target.id, endpointEpoch: target.endpointEpoch! };
    await observer.disconnect();
    observer = new IntercomClient();
    observer.on("message", (...args: unknown[]) => inbox.push(args));
    await observer.connect({ name: "observer", cwd: process.cwd(), model: "fixture", pid: process.pid, startedAt: 1, lastActivity: 1 }, "observer");
    return { kind: "local", target: exactTarget };
  };
  const f = await fixture({ homeEpoch: () => 7, prepare });
  const abort = new AbortController();
  let settled: any;
  const pending = f.tool.execute("ask", { action: "ask", to: "observer", message: "old endpoint only" }, abort.signal, undefined, f.ctx)
    .then((result: any) => { settled = result; return result; });
  try {
    await vi.waitFor(() => expect(Boolean(settled) || inbox.length > 0).toBe(true));
    expect(inbox).toEqual([]);
    expect(settled.details).toMatchObject({ delivered: false });
  } finally { abort.abort(); await pending; await f.cleanup(); }
});

it("reports routing refusals without sending to a local mailbox", async () => {
  const legacyInbox: unknown[] = [];
  const onMessage = (...args: unknown[]) => legacyInbox.push(args);
  observer.on("message", onMessage);
  let code: V0Code = "moving";
  const prepare: V0Prepare = async () => ({ kind: "refused", code });
  const f = await fixture({ homeEpoch: () => 7, prepare });
  try {
    const cases: Array<[V0Code, string]> = [
      ["moving", "Session is moving. Retry after it settles."],
      ["offline", "Session is not connected. No message was queued."],
      ["no-match", "No live session matches that name or ID."],
      ["not-configured", "No route is configured to that session."],
    ];
    for (const [next, text] of cases) {
      code = next;
      const result = await f.tool.execute("send", { action: "send", to: "observer", message: "private text" }, new AbortController().signal, undefined, f.ctx);
      expect(result.content[0].text).toBe(text);
      expect(result.details).toMatchObject({ error: true, code });
      expect(legacyInbox).toEqual([]);
    }
  } finally { observer.off("message", onMessage); await f.cleanup(); }
});

it("reports a remote ask's route refusal without a local fallback", async () => {
  const prepare: V0Prepare = async () => ({ kind: "refused", code: "not-configured" });
  const f = await fixture({ homeEpoch: () => 7, prepare });
  try {
    const result = await f.tool.execute("ask", { action: "ask", to: "ben", message: "hello" }, new AbortController().signal, undefined, f.ctx);
    expect(result.content[0].text).toBe("No route is configured to that session.");
    expect(result.details).toMatchObject({ error: true, code: "not-configured" });
    expect(f.entries.some(entry => entry.type === "intercom_sent")).toBe(false);
  } finally { await f.cleanup(); }
});

it("reports a receiver's refusal of a remote ask", async () => {
  const prepare: V0Prepare = async () => ({
    kind: "remote", label: "b/ben",
    async send(message) { return { kind: "socket_delivered", id: message.id }; },
    async ask() { return { kind: "refused", code: "offline" }; },
  });
  const f = await fixture({ homeEpoch: () => 7, prepare });
  try {
    const result = await f.tool.execute("ask", { action: "ask", to: "ben", message: "hello" }, new AbortController().signal, undefined, f.ctx);
    expect(result.content[0].text).toBe("Session is not connected. No message was queued.");
    expect(result.details).toMatchObject({ error: true, code: "offline" });
    expect(f.entries.some(entry => entry.type === "intercom_sent")).toBe(false);
  } finally { await f.cleanup(); }
});

it("reports a receiver's moving refusal without claiming a send", async () => {
  const prepare: V0Prepare = async () => ({
    kind: "remote", label: "b/ben",
    async send() { return { kind: "refused", code: "moving" }; },
    async ask(message) { return { kind: "no_reply", id: message.id }; },
  });
  const f = await fixture({ homeEpoch: () => 7, prepare });
  try {
    const result = await f.tool.execute("send", { action: "send", to: "ben", message: "hello" }, new AbortController().signal, undefined, f.ctx);
    expect(result.content[0].text).toBe("Session is moving. Retry after it settles.");
    expect(result.details).toMatchObject({ error: true, code: "moving" });
    expect(f.entries.some(entry => entry.type === "intercom_sent")).toBe(false);
  } finally { await f.cleanup(); }
});

it("reports a dropped remote send or ask as unknown without retrying", async () => {
  const attempted: V0Text[] = [];
  const prepare: V0Prepare = async () => ({
    kind: "remote", label: "b/ben",
    async send(message) { attempted.push(message); throw new Error("connection dropped"); },
    async ask(message) { attempted.push(message); throw new Error("connection dropped"); },
  });
  const f = await fixture({ homeEpoch: () => 7, prepare });
  try {
    for (const action of ["send", "ask"] as const) {
      const result = await f.tool.execute(action, { action, to: "ben", message: "hello" }, new AbortController().signal, undefined, f.ctx);
      const message = attempted[attempted.length - 1];
      expect(result.content[0].text).toBe(`Delivery could not be confirmed (ID ${message.id}). Check the recipient before sending again.`);
      expect(result.details).toMatchObject({ delivery: "unknown", messageId: message.id, delivered: false });
    }
    expect(attempted).toHaveLength(2);
  } finally { await f.cleanup(); }
});

it("reports uncertainty without a legacy send", async () => {
  const sent: V0Text[] = [], legacyInbox: unknown[] = [];
  const onMessage = (...args: unknown[]) => legacyInbox.push(args);
  observer.on("message", onMessage);
  const prepare: V0Prepare = async () => ({
    kind: "remote", label: "b/ben",
    async send(message) { sent.push(message); return { kind: "unknown", id: message.id }; },
    async ask(message) { return { kind: "no_reply", id: message.id }; },
  });
  const f = await fixture({ homeEpoch: () => 7, prepare });
  try {
    const result = await f.tool.execute("send", { action: "send", to: "observer", message: "uncertain" }, new AbortController().signal, undefined, f.ctx);
    expect(sent).toHaveLength(1);
    expect(result.content[0].text).toBe(`Delivery could not be confirmed (ID ${sent[0].id}). Check the recipient before sending again.`);
    expect(result.details).toMatchObject({ delivery: "unknown", messageId: sent[0].id, delivered: false });
    expect(legacyInbox).toEqual([]);
  } finally { observer.off("message", onMessage); await f.cleanup(); }
});
