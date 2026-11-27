import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import net from "node:net";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { V0_ASK_MAX_MS, type V0Code, type V0Prepare, type V0Text, type V0ToolOptions } from "../../../intercom/src/roam-v0.js";

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

async function fixture(v0?: V0ToolOptions, options: { confirm?: () => Promise<boolean>; homeUnavailable?: boolean } = {}) {
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
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
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
    ctx, entries, inbound, renderers,
    switchSession(id: string) { sessionId = id; },
    tool: tools.find(tool => tool.name === "intercom")!,
    async cleanup() { await emit("session_shutdown", { reason: "quit" }); rmSync(configPath, { force: true }); },
  };
}

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

it("keeps opt-out and unhomed sends on the local broker", async () => {
  const received: string[] = [];
  const onMessage = (_from: unknown, message: any) => received.push(message.content.text);
  observer.on("message", onMessage);
  try {
    for (const v0 of [undefined, { homeEpoch: () => undefined, prepare: async () => { throw new Error("unhomed routing must not run"); } } satisfies V0ToolOptions]) {
      const f = await fixture(v0);
      try {
        const result = await f.tool.execute("local-send", { action: "send", to: "observer", message: "local message" }, new AbortController().signal, undefined, f.ctx);
        expect(result.details).toMatchObject({ delivered: true, delivery: "socket_delivered" });
        await vi.waitFor(() => expect(received.length).toBeGreaterThan(0));
        expect(received.shift()).toBe("local message");
      } finally { await f.cleanup(); }
    }
  } finally { observer.off("message", onMessage); }
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
      { replyTo: "question" }, { supersedes: "old" }, { retryOf: "old" },
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
      { replyTo: "question" }, { supersedes: "old" }, { retryOf: "old" },
      { openProjectPaneIfMissing: true }, { focus: true },
    ];
    for (const flags of unsupported) {
      const result = await f.tool.execute("ask", { action: "ask", to: "ben", message: "private text", ...flags }, new AbortController().signal, undefined, f.ctx);
      expect(result.details).toMatchObject({ error: true });
      expect(questions).toEqual([]);
    }
  } finally { await f.cleanup(); }
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
