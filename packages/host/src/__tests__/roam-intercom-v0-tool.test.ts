import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { IntercomClient } from "../../../intercom/src/broker/client.js";
import { registerIntercomOnce } from "../../../intercom/src/single-instance.js";
import { startTestBroker, stopTestBroker, testBrokerEnv } from "../../../intercom/src/test-support.js";
import type { V0Prepare, V0Text, V0ToolOptions } from "../../../intercom/src/roam-v0.js";

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

async function fixture(v0?: V0ToolOptions) {
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
    sessionManager: { getSessionId: () => "sender-session", getEntries: () => [] },
    isIdle: () => true, hasPendingMessages: () => false, abort() {},
    ui: { notify() {}, getEditorText: () => "", confirm: async () => true },
  };
  registerIntercomOnce(pi as never, undefined, undefined, v0);
  const emit = async (name: string, event: unknown = {}) => { for (const handler of hooks.get(name) ?? []) await handler(event, ctx); };
  await emit("session_start", { reason: "startup" });
  await vi.waitFor(async () => {
    expect((await observer.listSessions()).some(session => session.id === "sender-session")).toBe(true);
  }, { timeout: 2000, interval: 20 });
  return {
    ctx, entries,
    tool: tools.find(tool => tool.name === "intercom")!,
    async cleanup() { await emit("session_shutdown", { reason: "quit" }); },
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
