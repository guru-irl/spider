import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { IntercomClient } from "../../../intercom/src/broker/client.js";
import { getIntercomDirPath } from "../../../intercom/src/broker/paths.js";
import { registerIntercomOnce } from "../../../intercom/src/single-instance.js";
import { startTestBroker, stopTestBroker, testBrokerEnv } from "../../../intercom/src/test-support.js";
import type { V0Code, V0Prepare, V0Text, V0ToolOptions } from "../../../intercom/src/roam-v0.js";

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

async function fixture(v0?: V0ToolOptions, options: { confirm?: () => Promise<boolean> } = {}) {
  const configPath = join(getIntercomDirPath(), "config.json");
  if (options.confirm) writeFileSync(configPath, JSON.stringify({ confirmSend: true }), { mode: 0o600 });
  let sessionId = "sender-session";
  const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  const bus = new EventEmitter();
  const pi = {
    events: { on(name: string, handler: (value: unknown) => void) { bus.on(name, handler); return () => { bus.off(name, handler); }; },
      emit(name: string, value: unknown) { bus.emit(name, value); } },
    on(name: string, handler: (event: any, ctx: any) => unknown) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
    getSessionName: () => "alice", setSessionName() {}, registerMessageRenderer() {}, registerShortcut() {}, registerCommand() {},
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); }, sendMessage() {},
    registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) { tools.push(tool); },
    getAllTools: () => tools, getActiveTools: () => tools.map(tool => tool.name), setActiveTools() {},
  };
  const ctx = {
    cwd: process.cwd(), mode: "tui" as const, model: { id: "fixture" }, hasUI: true,
    sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
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
    ctx, entries,
    switchSession(id: string) { sessionId = id; },
    tool: tools.find(tool => tool.name === "intercom")!,
    async cleanup() { await emit("session_shutdown", { reason: "quit" }); rmSync(configPath, { force: true }); },
  };
}

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
