import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { startTestBroker, stopTestBroker, testBrokerEnv, testTmpDir } from "./test-support.js";
import extension from "./local.js";
import { IntercomClient } from "./broker/client.js";
import { INTERCOM_EXTENSION_REGISTER_EVENT, type IntercomExtensionChannel } from "./extension-api.js";

let broker: ChildProcess | undefined, root: string | undefined;
const sessions: Array<{ shutdown(): Promise<void> }> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const session of sessions.splice(0).reverse()) await session.shutdown();
  if (broker) await stopTestBroker(broker);
  if (root) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function history(count: number, prefix: string, observed: boolean, acknowledged = false): any[] {
  const entries: any[] = [], timestamp = new Date().toISOString();
  for (let i = 0; i < count; i++) {
    const messageId = `${prefix}-${i}`;
    entries.push({ id: `pending-${messageId}`, timestamp, type: "custom", customType: "intercom_pending", data: { messageId, sessionId: "own", activationEpoch: "old" } });
    if (observed) entries.push({ id: `entry-${messageId}`, timestamp, type: "custom_message", customType: "intercom_message", details: { from: { id: "peer" }, message: { id: messageId }, intercom: { sessionId: "own", activationEpoch: "old" } } });
    if (acknowledged) entries.push({ id: `ack-${messageId}`, timestamp, type: "custom", customType: "intercom_receipt_ack", data: { messageId, status: "injected" } });
  }
  return entries;
}

function session(entries: any[]) {
  const events = new EventEmitter(), handlers = new Map<string, Array<(...args: any[]) => any>>();
  let channel!: IntercomExtensionChannel, stopped = false;
  const sessionFile = join(root!, "session.jsonl");
  writeFileSync(sessionFile, entries.map(entry => JSON.stringify(entry)).join("\n"));
  const pi = {
    events: { on(name: string, handler: (...args: any[]) => void) { events.on(name, handler); return () => events.off(name, handler); }, emit: events.emit.bind(events) },
    on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    getSessionName: () => "own", registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    appendEntry(customType: string, data: unknown) { entries.push({ id: `record-${entries.length}`, timestamp: new Date().toISOString(), type: "custom", customType, data }); },
    sendMessage() {}, getActiveTools: () => ["intercom"], setActiveTools() {},
  };
  const context = { cwd: process.cwd(), mode: "rpc", model: { id: "fixture" }, hasUI: false, isIdle: () => true, ui: {},
    sessionManager: { getSessionId: () => "own", getSessionFile: () => sessionFile, getEntries: () => entries } };
  extension(pi as never);
  events.emit(INTERCOM_EXTENSION_REGISTER_EVENT, { namespace: "replay", ownerEligible: false, onEvent() {}, onReady(value: IntercomExtensionChannel) { channel = value; } });
  const emit = async (name: string, event: unknown = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, context); };
  const instance = {
    start: () => emit("session_start"),
    connected: () => channel.snapshot().connected,
    async shutdown() { if (!stopped) { stopped = true; await emit("session_shutdown", { reason: "reload" }); } },
  };
  sessions.push(instance);
  return instance;
}

it("acknowledges restored receipts once and never replays them after reconnect or reload", async () => {
  root = mkdtempSync(join(testTmpDir(), "replay-"));
  const clock = join(root, "clock"), preload = join(root, "clock.mjs"), start = Date.now();
  writeFileSync(clock, String(start));
  writeFileSync(preload, `import { readFileSync } from 'node:fs'; Date.now = () => Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));`);
  broker = startTestBroker(process.execPath, ["--import", preload, "dist/intercom/broker.mjs"], { env: testBrokerEnv(), stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("broker startup timeout")), 3000);
    broker!.once("exit", code => { clearTimeout(timer); reject(new Error(`broker exit ${code}`)); });
    broker!.stdout!.on("data", chunk => { if (String(chunk).includes("Intercom broker started")) { clearTimeout(timer); resolve(); } });
  });

  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(start);
  const entries = [...history(150, "unseen", false), ...history(150, "seen", true), ...history(60, "done", true, true)];
  const connections: IntercomClient[] = [], sends: Array<{ messageId: string; status: string }> = [], connected = new EventEmitter();
  const connect = IntercomClient.prototype.connect, send = IntercomClient.prototype.sendMessageReceipt;
  vi.spyOn(IntercomClient.prototype, "connect").mockImplementation(function (this: IntercomClient, ...args) {
    connections.push(this);
    const result = connect.apply(this, args);
    void result.then(() => connected.emit("connected", this), () => {});
    return result;
  });
  vi.spyOn(IntercomClient.prototype, "sendMessageReceipt").mockImplementation(function (this: IntercomClient, receipt) {
    sends.push({ messageId: receipt.messageId, status: receipt.status });
    send.call(this, receipt);
  });
  const nextConnection = () => new Promise<IntercomClient>(resolve => connected.once("connected", resolve));
  const acks = () => entries.filter(entry => entry.customType === "intercom_receipt_ack" && !String(entry.data.messageId).startsWith("done-"));
  const expected = [
    ...Array.from({ length: 150 }, (_, i) => `unseen-${i}:unknown`),
    ...Array.from({ length: 150 }, (_, i) => `seen-${i}:injected`),
  ].sort();

  const first = session(entries), started = nextConnection();
  await first.start();
  await vi.advanceTimersByTimeAsync(0);
  const initial = await started;
  await initial.listSessions();
  for (let tick = 1; tick <= 15; tick++) {
    writeFileSync(clock, String(start + tick * 250));
    await vi.advanceTimersByTimeAsync(250);
    await initial.listSessions();
  }
  expect(first.connected()).toBe(true);
  expect(connections).toHaveLength(1);
  expect(acks()).toHaveLength(300);
  expect(new Set(acks().map(entry => `${entry.data.messageId}:${entry.data.status}`)).size).toBe(300);
  expect(acks().map(entry => `${entry.data.messageId}:${entry.data.status}`).sort()).toEqual(expected);
  expect(sends.filter(receipt => receipt.messageId.startsWith("done-"))).toEqual([]);
  expect(new Set(sends.map(receipt => `${receipt.messageId}:${receipt.status}`)).size).toBe(300);
  expect(sends.map(receipt => `${receipt.messageId}:${receipt.status}`).sort()).toEqual(expected);

  sends.length = 0;
  const disconnected = new Promise<void>(resolve => initial.once("disconnected", resolve));
  const replacement = new IntercomClient();
  replacement.on("error", () => {});
  await replacement.connect({ cwd: process.cwd(), model: "fixture", pid: process.pid, startedAt: 1, lastActivity: 1 }, "own");
  await replacement.disconnect();
  await disconnected;
  const reconnected = nextConnection();
  writeFileSync(clock, String(start + 4750));
  await vi.advanceTimersByTimeAsync(1000);
  const afterReconnect = await reconnected;
  await afterReconnect.listSessions();
  expect(first.connected()).toBe(true);
  expect(connections).toHaveLength(3);
  expect(sends).toEqual([]);
  expect(acks()).toHaveLength(300);

  await first.shutdown();
  const reloaded = session(entries), restarted = nextConnection();
  await reloaded.start();
  await vi.advanceTimersByTimeAsync(0);
  const afterReload = await restarted;
  await afterReload.listSessions();
  expect(reloaded.connected()).toBe(true);
  expect(connections).toHaveLength(4);
  expect(sends).toEqual([]);
  expect(acks()).toHaveLength(300);
}, 5000);
