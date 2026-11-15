import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { startTestBroker, stopTestBroker, testBrokerEnv, testTmpDir } from "../test-support.js";
import type { MessageReceipt } from "../types.js";
import { IntercomClient } from "./client.js";

let broker: ChildProcess | undefined, root: string | undefined, clock: string, now: number;
const clients: IntercomClient[] = [];
beforeEach(async () => {
  root = mkdtempSync(join(testTmpDir(), "queue-"));
  clock = join(root, "clock");
  const preload = join(root, "clock.mjs");
  now = Date.now();
  writeFileSync(clock, String(now));
  writeFileSync(preload, `import { readFileSync } from 'node:fs'; Date.now = () => Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));`);
  broker = startTestBroker(process.execPath, ["--import", preload, "dist/intercom/broker.mjs"], { env: testBrokerEnv(), stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("broker startup timeout")), 3000);
    broker!.once("exit", code => { clearTimeout(timer); reject(new Error(`broker exit ${code}`)); });
    broker!.stdout!.on("data", chunk => { if (String(chunk).includes("Intercom broker started")) { clearTimeout(timer); resolve(); } });
  });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(now);
}, 5000);
afterEach(async () => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) await client.disconnect();
  if (broker) await stopTestBroker(broker);
  if (root) rmSync(root, { recursive: true, force: true });
});
async function connect(id: string): Promise<IntercomClient> {
  const client = new IntercomClient();
  clients.push(client);
  client.on("error", () => {});
  await client.connect({ cwd: "/workspace", model: "fixture", pid: process.pid, startedAt: 1, lastActivity: 1, activationEpoch: `${id}-activation` }, id);
  return client;
}
async function advance(ms: number, receiver: IntercomClient): Promise<void> {
  now += ms;
  writeFileSync(clock, String(now));
  await vi.advanceTimersByTimeAsync(ms);
  await receiver.listSessions();
}

it("delivers queued injection evidence rather than a later cancellation status", async () => {
  const sender = await connect("sender"), receiver = await connect("receiver");
  const received: MessageReceipt[] = [], acknowledgements: Array<{ messageId: string; status: string }> = [];
  sender.onMessageReceipt((_from, receipt) => received.push(receipt));
  receiver.onBrokerMessage(frame => { if (frame.type === "receipt_ack") acknowledgements.push(frame); });
  expect((await sender.send("receiver", { messageId: "target", text: "synthetic" })).delivered).toBe(true);
  for (let i = 0; i < 20; i++) receiver.sendMessageReceipt({ messageId: `sent-${i}`, status: "unknown", timestamp: now });
  for (let i = 0; i < 25; i++) receiver.sendMessageReceipt({ messageId: `waiting-${i}`, status: "unknown", timestamp: now });
  const injected: MessageReceipt = { messageId: "target", status: "injected", timestamp: now,
    evidence: { kind: "entry", entryId: "entry", sessionId: "receiver", activationEpoch: "receiver-activation" } };
  receiver.sendMessageReceipt(injected);
  receiver.sendMessageReceipt({ messageId: "target", status: "cancellation_requested", timestamp: now + 1 });
  await advance(250, receiver);
  await advance(250, receiver);
  await sender.listSessions();
  expect(received).toEqual([injected]);
  expect(acknowledgements).toContainEqual(expect.objectContaining({ messageId: "target", status: "injected" }));
  expect(receiver.isConnected()).toBe(true);
}, 5000);

it.each([
  { status: "unknown" },
  { status: "not_injected", evidence: { kind: "absence", complete: true, sessionId: "receiver", activationEpoch: "receiver-activation", excludedGeneration: "receiver-activation" } },
  { status: "matched_waiter", evidence: { kind: "waiter", entryId: "entry", askId: "ask", sessionId: "receiver", activationEpoch: "receiver-activation" } },
  { status: "expired" },
] as const)("keeps queued $status over a later transient acknowledgement", async partial => {
  const sender = await connect("sender"), receiver = await connect("receiver");
  const received: MessageReceipt[] = [];
  sender.onMessageReceipt((_from, receipt) => received.push(receipt));
  expect((await sender.send("receiver", { messageId: "target", text: "synthetic" })).delivered).toBe(true);
  for (let i = 0; i < 20; i++) receiver.sendMessageReceipt({ messageId: `sent-${i}`, status: "acknowledged", timestamp: now });
  const durable: MessageReceipt = { messageId: "target", timestamp: now, ...partial };
  receiver.sendMessageReceipt(durable);
  receiver.sendMessageReceipt({ messageId: "target", status: "acknowledged", timestamp: now + 1 });
  await advance(250, receiver);
  await sender.listSessions();
  expect(received).toEqual([durable]);
}, 5000);

it("retains every durable receipt when the waiting queue exceeds its limit", async () => {
  const receiver = await connect("receiver"), acknowledgements = new Map<string, string>();
  receiver.onBrokerMessage(frame => { if (frame.type === "receipt_ack") acknowledgements.set(frame.messageId, frame.status); });
  for (let i = 0; i < 20; i++) receiver.sendMessageReceipt({ messageId: `sent-${i}`, status: "acknowledged", timestamp: now });
  receiver.sendMessageReceipt({ messageId: "transient", status: "receiver_received", timestamp: now });
  for (let i = 0; i < 4097; i++) receiver.sendMessageReceipt({ messageId: `durable-${i}`, status: "expired", timestamp: now });
  for (let tick = 0; tick < 206; tick++) await advance(250, receiver);
  const missing = Array.from({ length: 4097 }, (_, i) => `durable-${i}`).filter(id => acknowledgements.get(id) !== "expired");
  expect(missing).toEqual([]);
  expect(receiver.isConnected()).toBe(true);
}, 5000);

it("preserves a waiting message's position when its receipt becomes durable", async () => {
  const receiver = await connect("receiver"), acknowledgements: Array<{ messageId: string; status: string }> = [];
  receiver.onBrokerMessage(frame => { if (frame.type === "receipt_ack") acknowledgements.push(frame); });
  for (let i = 0; i < 20; i++) receiver.sendMessageReceipt({ messageId: `sent-${i}`, status: "acknowledged", timestamp: now });
  receiver.sendMessageReceipt({ messageId: "target", status: "receiver_received", timestamp: now });
  for (let i = 0; i < 20; i++) receiver.sendMessageReceipt({ messageId: `later-${i}`, status: "unknown", timestamp: now });
  receiver.sendMessageReceipt({ messageId: "target", status: "injected", timestamp: now,
    evidence: { kind: "entry", entryId: "entry", sessionId: "receiver", activationEpoch: "receiver-activation" } });
  await advance(250, receiver);
  expect(acknowledgements).toContainEqual(expect.objectContaining({ messageId: "target", status: "injected" }));
  expect(acknowledgements.some(receipt => receipt.messageId === "later-19")).toBe(false);
}, 5000);

it.each([
  { earlier: "unknown", later: "not_injected" },
  { earlier: "not_injected", later: "unknown" },
] as const)("keeps the later equally durable $later outcome", async ({ earlier, later }) => {
  const sender = await connect("sender"), receiver = await connect("receiver"), received: MessageReceipt[] = [];
  sender.onMessageReceipt((_from, receipt) => received.push(receipt));
  expect((await sender.send("receiver", { messageId: "target", text: "synthetic" })).delivered).toBe(true);
  for (let i = 0; i < 20; i++) receiver.sendMessageReceipt({ messageId: `sent-${i}`, status: "acknowledged", timestamp: now });
  const receipt = (status: "unknown" | "not_injected", timestamp: number): MessageReceipt => ({
    messageId: "target", status, timestamp,
    ...(status === "not_injected" ? { evidence: { kind: "absence" as const, complete: true as const, sessionId: "receiver", activationEpoch: "receiver-activation", excludedGeneration: "receiver-activation" } } : {}),
  });
  receiver.sendMessageReceipt(receipt(earlier, now));
  const latest = receipt(later, now + 1);
  receiver.sendMessageReceipt(latest);
  await advance(250, receiver);
  await sender.listSessions();
  expect(received).toEqual([latest]);
}, 5000);

it("retains observed injection evidence over a later uncertain outcome", async () => {
  const sender = await connect("sender"), receiver = await connect("receiver"), received: MessageReceipt[] = [];
  sender.onMessageReceipt((_from, receipt) => received.push(receipt));
  expect((await sender.send("receiver", { messageId: "target", text: "synthetic" })).delivered).toBe(true);
  for (let i = 0; i < 20; i++) receiver.sendMessageReceipt({ messageId: `sent-${i}`, status: "acknowledged", timestamp: now });
  const injected: MessageReceipt = { messageId: "target", status: "injected", timestamp: now,
    evidence: { kind: "entry", entryId: "entry", sessionId: "receiver", activationEpoch: "receiver-activation" } };
  receiver.sendMessageReceipt(injected);
  receiver.sendMessageReceipt({ messageId: "target", status: "unknown", timestamp: now + 1 });
  await advance(250, receiver);
  await sender.listSessions();
  expect(received).toEqual([injected]);
}, 5000);
