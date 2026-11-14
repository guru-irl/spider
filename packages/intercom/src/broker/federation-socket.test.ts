import { afterAll, beforeAll, expect, it } from "vitest";
import { startTestBroker } from "../test-support.js";
import { type ChildProcess } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { getBrokerSocketPath, getAgentDirPath } from "./paths.js";
import { writeMessage, createMessageReader } from "./framing.js";
import { IntercomClient, IntercomFederationClient } from "./client.js";
import { FEDERATION_FEATURE, type FederationBridge, type RemoteSessionInfo } from "../protocol.js";

let broker: ChildProcess;
const clients: IntercomClient[] = [];
let bridge: IntercomFederationClient;
const frames: any[] = [], receipts: any[] = [], controls: any[] = [];
const remote: RemoteSessionInfo = { remote: true, id: "remote", address: { sessionId: "remote", scopeId: null }, machineId: "machine-2", machineAlias: "box-1.invalid", homeEpoch: 1, activationEpoch: "remote-activation", endpointEpoch: "remote-activation", name: "helper", cwd: "/workspace", model: "fixture", startedAt: 1, lastActivity: 1 };
const adapter: FederationBridge = {
  dispatch: async frame => { frames.push(frame); return { delivery: "queued", retryable: false, outcomeKnown: true, acceptance: { accepted: true, durable: true, location: "source" } }; },
  receipt: (from, receipt) => { receipts.push({ from, receipt }); },
  control: (from, to, control) => { controls.push({ from, to, control }); },
};
beforeAll(async () => {
  broker = startTestBroker(process.execPath, ["dist/intercom/broker.mjs"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] }, "suite");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture broker startup timed out")), 4000);
    broker.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture broker exit ${code}`)); });
    broker.stdout!.on("data", chunk => { if (String(chunk).includes("Intercom broker started")) { clearTimeout(timer); resolve(); } });
  });
  bridge = new IntercomFederationClient();
  await bridge.connect({ feature: FEDERATION_FEATURE, agentDir: getAgentDirPath(), machineId: "machine-1", machineAlias: "local.invalid" }, adapter);
  bridge.publishPresence([remote]);
}, 5000);
afterAll(async () => {
  for (const client of clients) await client.disconnect();
  await bridge?.close();
  if (broker?.exitCode === null) { const exited = once(broker, "exit"); broker.kill(); await exited; }
}, 5000);
async function session(id: string, name = id, homeEpoch?: number) {
  const client = new IntercomClient(); clients.push(client);
  await client.connect({ cwd: "/workspace", model: "fixture", pid: process.pid, name, startedAt: 1, lastActivity: 1, activationEpoch: `${id}-activation`, ...(homeEpoch !== undefined ? { homeEpoch } : {}) }, id);
  return client;
}

it("broker derives the sender and every client producer reaches one bridge", async () => {
  const client = await session("sender");
  expect(client.supportsFeature(FEDERATION_FEATURE)).toBe(true);
  expect((await client.listSessions()).find(s => s.id === "remote")).toEqual(remote);
  for (const messageId of ["tool-send", "relay-send", "outbox-send"]) {
    expect(await client.send("box-1.invalid/helper", { messageId, text: "synthetic", attachments: [{ type: "snippet", name: "fixture", content: "synthetic attachment" }] })).toMatchObject({ delivered: true, delivery: "queued", acceptance: { durable: true, location: "source" } });
  }
  expect(frames.slice(-3).map(frame => frame.from)).toEqual(Array(3).fill({ sessionId: "sender", scopeId: null }));
  expect(frames.at(-1).message.content.attachments[0].content).toBe("synthetic attachment");
}, 5000);

it("local presence includes portable epochs and activity but no local handles", async () => {
  const snapshots: any[][] = [], handler = (rows: any[]) => snapshots.push(rows);
  bridge.on("presence", handler);
  try {
    await session("presence-source", "presence-source", 7);
    await bridge.inspectBlockers({ sessionId: "presence-source", scopeId: null });
    const row = snapshots.at(-1)?.find(value => value.address.sessionId === "presence-source");
    expect(row).toMatchObject({ homeEpoch: 7, activationEpoch: "presence-source-activation", startedAt: 1, lastActivity: 1 });
    expect(row).not.toHaveProperty("pid"); expect(row).not.toHaveProperty("tmuxPane");
  } finally { bridge.off("presence", handler); }
}, 5000);

it("legacy-client local compatibility hides remote entries", async () => {
  const socket = net.connect(getBrokerSocketPath());
  try {
    const messages: any[] = [];
    socket.on("data", createMessageReader(message => messages.push(message), error => socket.destroy(error)));
    writeMessage(socket, { type: "register", sessionId: "legacy", session: { cwd: "/workspace", model: "fixture", pid: process.pid, startedAt: 1, lastActivity: 1 } });
    await new Promise<void>(resolve => { const check = () => { if (messages.some(m => m.type === "registered")) resolve(); else setImmediate(check); }; check(); });
    writeMessage(socket, { type: "list", requestId: "legacy-list" });
    await new Promise<void>(resolve => { const check = () => { if (messages.some(m => m.type === "sessions")) resolve(); else setImmediate(check); }; check(); });
    expect(messages.find(m => m.type === "sessions").sessions.some((s: any) => s.remote)).toBe(false);
  } finally { const closed = once(socket, "close"); socket.destroy(); await closed; }
}, 5000);

it("remote receipts and cancellation use the single bridge", async () => {
  const client = await session("recipient");
  const received = once(client, "message");
  const delivered = await bridge.deliver(remote, { address: { sessionId: "recipient", scopeId: null }, machineId: "machine-1", homeEpoch: null, activationEpoch: "recipient-activation" }, { id: "incoming", timestamp: 1, content: { text: "synthetic" } });
  expect(delivered.delivery).toBe("socket_delivered");
  expect((await received)[0]).toEqual(remote);
  client.sendMessageReceipt({ messageId: "incoming", status: "injected", timestamp: 2, evidence: { kind: "entry", entryId: "physical", sessionId: "recipient", activationEpoch: "recipient-activation" } });
  await client.listSessions();
  expect(receipts.at(-1)).toMatchObject({ from: { sessionId: "recipient", scopeId: null }, receipt: { messageId: "incoming", status: "injected" } });
  await client.send("remote", { messageId: "cancel-me", text: "synthetic" });
  await client.cancelMessage("cancel-me");
  expect(controls.at(-1)).toMatchObject({ from: { sessionId: "recipient", scopeId: null }, to: remote.address, control: { action: "cancel", messageId: "cancel-me" } });
}, 5000);

it("a foreign socket cannot clear another recipient's blocker", async () => {
  const sender = await session("local-source"), target = await session("local-target"), foreign = await session("foreign");
  await sender.send("local-target", { messageId: "local-pending", text: "synthetic" });
  foreign.sendMessageReceipt({ messageId: "local-pending", status: "injected", timestamp: 2, evidence: { kind: "entry", entryId: "forged", sessionId: "local-target", activationEpoch: "local-target-activation" } });
  await foreign.listSessions();
  expect((await bridge.inspectBlockers({ sessionId: "local-source", scopeId: null })).unobservedReceipts).toContain("local-pending");
  await target.disconnect();
  expect((await bridge.inspectBlockers({ sessionId: "local-source", scopeId: null })).unobservedReceipts).toContain("local-pending");
}, 5000);

it("bridge-delivered receipts are not reflected and survive source disconnect", async () => {
  const source = await session("receipt-source");
  await source.send("remote", { messageId: "receipt-outbound", text: "synthetic", expectsReply: true, remainingMs: 1000 });
  await source.disconnect(); const count = receipts.length;
  bridge.deliverReceipt(remote, { sessionId: "receipt-source", scopeId: null }, { messageId: "receipt-outbound", timestamp: 3, status: "expired" });
  expect((await bridge.inspectBlockers({ sessionId: "receipt-source", scopeId: null })).asks).toEqual([]);
  expect(receipts).toHaveLength(count);
}, 5000);

it("an exact-target retry keeps the original id and diminishes ask duration", async () => {
  const client = await session("retry-source"), original = adapter.dispatch, seen: any[] = [];
  adapter.dispatch = async frame => {
    seen.push(frame.message);
    if (seen.length === 1) {
      await new Promise(resolve => setTimeout(resolve, 25));
      return { delivery: "failed", code: "E_TARGET_REBOUND", retryable: true, outcomeKnown: true, acceptance: { accepted: false, durable: false } };
    }
    return { delivery: "queued", retryable: false, outcomeKnown: true, acceptance: { accepted: true, durable: true, location: "source" } };
  };
  try {
    expect(await client.send("remote", { messageId: "retry-id", text: "synthetic", expectsReply: true, remainingMs: 1000 })).toMatchObject({ delivered: true, delivery: "queued" });
    expect(seen).toHaveLength(2); expect(seen[0].id).toBe(seen[1].id);
    expect(seen[1].remainingMs).toBeLessThan(seen[0].remainingMs);
  } finally { adapter.dispatch = original; client.cancelAsk("retry-id"); }
}, 5000);

it("durable completions after broker restart do not disconnect the bridge", async () => {
  const client = await session("restored-recipient"), controls: any[] = [];
  client.onMessageControl((from, control) => controls.push({ from, control }));
  bridge.deliverReceipt(remote, { sessionId: "restored-recipient", scopeId: null }, { messageId: "before-broker-restart", status: "expired", timestamp: 3 });
  bridge.deliverControl(remote, { sessionId: "restored-recipient", scopeId: null }, { messageId: "before-broker-restart", action: "cancel", timestamp: 3 });
  await bridge.inspectBlockers({ sessionId: "restored-recipient", scopeId: null });
  await client.listSessions();
  expect(controls).toEqual([{ from: remote, control: { messageId: "before-broker-restart", action: "cancel", timestamp: 3 } }]);
}, 5000);

it("a stale home epoch cannot deliver", async () => {
  const client = await session("home-fenced"); let calls = 0; client.on("message", () => { calls++; });
  expect(await bridge.deliver(remote, { address: { sessionId: "home-fenced", scopeId: null }, machineId: "machine-1", homeEpoch: 4, activationEpoch: "home-fenced-activation" }, { id: "old-home", timestamp: 1, content: { text: "synthetic" } })).toMatchObject({ delivery: "failed", code: "E_TARGET_REBOUND" });
  expect(calls).toBe(0);
}, 5000);

it("a stale endpoint has no socket delivery and blockers expose no payloads", async () => {
  const client = await session("fenced"); let calls = 0; client.on("message", () => { calls++; });
  expect(await bridge.deliver(remote, { address: { sessionId: "fenced", scopeId: null }, machineId: "machine-1", homeEpoch: null, activationEpoch: "old" }, { id: "stale", timestamp: 1, content: { text: "private-synthetic" } })).toMatchObject({ delivery: "failed", code: "E_TARGET_REBOUND" });
  expect(calls).toBe(0);
  await client.send("remote", { messageId: "waiting", text: "private-synthetic", expectsReply: true, remainingMs: 2000 });
  const blockers = await bridge.inspectBlockers({ sessionId: "fenced", scopeId: null });
  expect(blockers).toMatchObject({ asks: [{ id: "waiting", from: { sessionId: "fenced", scopeId: null }, to: remote.address }], unobservedReceipts: ["waiting"] });
  expect(JSON.stringify(blockers)).not.toContain("private-synthetic");
}, 5000);
