import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { authorizeTestBridge, startTestBroker, stopTestBroker, testTmpDir } from "../test-support.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { type ChildProcess } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { getBrokerSocketPath, getAgentDirPath } from "./paths.js";
import { writeMessage, createMessageReader } from "./framing.js";
import { IntercomClient, IntercomFederationClient } from "./client.js";
import { FEDERATION_FEATURE, type FederationBridge, type RemoteSessionInfo } from "../protocol.js";

let broker: ChildProcess;
let fixtureHome: string, clockFile: string;
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
  fixtureHome = mkdtempSync(join(testTmpDir(), "h-"));
  const clock = clockFile = join(fixtureHome, "clock"), preload = join(fixtureHome, "clock.mjs");
  writeFileSync(clock, String(Date.now()));
  writeFileSync(preload, `import { readFileSync } from 'node:fs'; Date.now = () => Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));`);
  broker = startTestBroker(process.execPath, ["--import", preload, "dist/intercom/broker.mjs"], { env: { ...process.env, HOME: fixtureHome }, stdio: ["ignore", "pipe", "pipe"] }, "suite");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture broker startup timed out")), 4000);
    broker.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture broker exit ${code}`)); });
    broker.stdout!.on("data", chunk => { if (String(chunk).includes("Intercom broker started")) { clearTimeout(timer); resolve(); } });
  });
  bridge = new IntercomFederationClient();
  await bridge.connect({ feature: FEDERATION_FEATURE, agentDir: getAgentDirPath(), credential: authorizeTestBridge(getAgentDirPath(), "machine-1"), machineId: "machine-1", machineAlias: "local.invalid" }, adapter);
  bridge.publishPresence([remote]);
}, 5000);
afterAll(async () => {
  try {
    for (const client of clients) await client.disconnect();
    await bridge?.close();
  } finally {
    if (broker) await stopTestBroker(broker);
    if (fixtureHome) rmSync(fixtureHome, { recursive: true, force: true });
  }
}, 5000);
async function session(id: string, name = id, homeEpoch?: number, logicalId = id) {
  const client = new IntercomClient(); clients.push(client);
  await client.connect({ address: { sessionId: logicalId, scopeId: null }, cwd: "/workspace", model: "fixture", pid: process.pid, name, startedAt: 1, lastActivity: 1, activationEpoch: `${id}-activation`, ...(homeEpoch !== undefined ? { homeEpoch } : {}) }, id);
  return client;
}

function trackSocket(socket: net.Socket) {
  const errors: NodeJS.ErrnoException[] = [];
  socket.on("error", error => errors.push(error));
  const closed = new Promise<boolean>(resolve => socket.once("close", resolve));
  return { errors, closed };
}

function expectRefused(socket: net.Socket, messages: any[], errors: NodeJS.ErrnoException[], hadError: boolean) {
  expect(socket.destroyed).toBe(true);
  expect(messages.some(message => message.type === "federation_registered")).toBe(false);
  expect(messages.some(message => message.requestId === 'must-refuse')).toBe(false);
  expect(hadError).toBe(errors.length > 0);
  expect(errors.filter(error => error.code !== "ECONNRESET" && error.code !== 'EPIPE')).toEqual([]);
}

it.each(['ECONNRESET', 'EPIPE'])('recognizes peer closure %s without accepting a must-refuse reply', code => {
  const socket = new net.Socket(); socket.destroy();
  const error: NodeJS.ErrnoException = Object.assign(new Error('peer closed'), { code });
  expectRefused(socket, [], [error], true);
  expect(() => expectRefused(socket, [{ type: 'error', requestId: 'must-refuse' }], [error], true)).toThrow();
}, 5000);

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

it("blocker inspection does not expire a pending local ask", async () => {
  const sender = await session("inspect-expiry-source"), target = await session("inspect-expiry-target");
  const now = Number(readFileSync(clockFile, "utf8"));
  const record = join(getAgentDirPath(), "intercom", "pending-asks", "inspect-no-expire.json");
  try {
    await sender.send("inspect-expiry-target", { messageId: "inspect-no-expire", text: "fixture", expectsReply: true, remainingMs: 2000 });
    expect(existsSync(record)).toBe(true);
    writeFileSync(clockFile, String(now + 2 * 60 * 60 * 1000));
    const blockers = await bridge.inspectFreezeBlockers({ sessionId: "inspect-expiry-source", scopeId: null });
    expect(blockers.asks).toContainEqual(expect.objectContaining({ id: "inspect-no-expire" }));
    expect(existsSync(record)).toBe(true);
  } finally { writeFileSync(clockFile, String(now)); await sender.disconnect(); await target.disconnect(); }
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
  const { errors, closed } = trackSocket(socket);
  try {
    const messages: any[] = [];
    socket.on("data", createMessageReader(message => messages.push(message), error => socket.destroy(error)));
    writeMessage(socket, { type: "register", sessionId: "legacy", session: { cwd: "/workspace", model: "fixture", pid: process.pid, startedAt: 1, lastActivity: 1 } });
    await new Promise<void>(resolve => { const check = () => { if (messages.some(m => m.type === "registered")) resolve(); else setImmediate(check); }; check(); });
    writeMessage(socket, { type: "list", requestId: "legacy-list" });
    await new Promise<void>(resolve => { const check = () => { if (messages.some(m => m.type === "sessions")) resolve(); else setImmediate(check); }; check(); });
    expect(messages.find(m => m.type === "sessions").sessions.some((s: any) => s.remote)).toBe(false);
  } finally { socket.destroy(); await closed; }
  expect(errors).toEqual([]);
}, 5000);

it("remote receipts and cancellation use the single bridge", async () => {
  const client = await session("recipient");
  const received = once(client, "message");
  const delivered = await bridge.deliver(remote, { address: { sessionId: "recipient", scopeId: null }, machineId: "machine-1", homeEpoch: null, activationEpoch: "recipient-activation" }, { id: "incoming", timestamp: 1, content: { text: "synthetic" } });
  expect(delivered.delivery).toBe("socket_delivered");
  expect((await received)[0]).toEqual(remote);
  client.sendMessageReceipt({ messageId: "incoming", status: "injected", timestamp: 2, evidence: { kind: "entry", entryId: "physical", sessionId: "recipient", activationEpoch: "recipient-activation" } });
  // The broker forwards to the bridge on the bridge's own socket, so a reply on this socket doesn't order it.
  await vi.waitFor(() => expect(receipts.at(-1)).toMatchObject({ from: { sessionId: "recipient", scopeId: null }, receipt: { messageId: "incoming", status: "injected" } }), { timeout: 2000 });
  await client.send("remote", { messageId: "cancel-me", text: "synthetic" });
  await client.cancelMessage("cancel-me");
  await vi.waitFor(() => expect(controls.at(-1)).toMatchObject({ from: { sessionId: "recipient", scopeId: null }, to: remote.address, control: { action: "cancel", messageId: "cancel-me" } }), { timeout: 2000 });
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


it("a locally homed target uses durable federation instead of a second mailbox", async () => {
  const sender = await session("homed-sender"), target = await session("homed-target", "homed-target", 8);
  let received = 0; target.on("message", () => received++);
  const result = await sender.send("homed-target", { messageId: "homed-mail", text: "synthetic" });
  expect(result, JSON.stringify(result)).toMatchObject({ delivery: "queued", acceptance: { accepted: true, durable: true } });
  expect(frames.at(-1)).toMatchObject({ from: { sessionId: "homed-sender", scopeId: null }, to: { machineId: "machine-1", homeEpoch: 8 } });
  expect(received).toBe(0);
}, 5000);

it("durable receipts reach a surviving waiter without transient broker route metadata", async () => {
  const client = await session("receipt-after-restart"), observed: any[] = [];
  client.onMessageReceipt((_from, receipt) => observed.push(receipt));
  bridge.deliverReceipt(remote, { sessionId: "receipt-after-restart", scopeId: null }, { messageId: "ask-before-restart", status: "unknown", timestamp: 2, detail: "link-down" });
  await bridge.inspectBlockers({ sessionId: "receipt-after-restart", scopeId: null }); await client.listSessions();
  expect(observed).toEqual([{ messageId: "ask-before-restart", status: "unknown", timestamp: 2, detail: "link-down" }]);
}, 5000);

it.each(["runtime", "logical"])("local home dispatch preserves logical identity when addressed by %s id", async selector => {
  const runtimeId = `runtime-${selector}`, logicalId = `logical-${selector}`;
  const sender = await session(`alias-sender-${selector}`), target = await session(runtimeId, runtimeId, 9, logicalId); let received = 0;
  target.on("message", () => received++);
  const result = await sender.send(selector === "runtime" ? runtimeId : logicalId, { messageId: `alias-mail-${selector}`, text: "synthetic" });
  expect(result).toMatchObject({ delivery: "queued", acceptance: { accepted: true, durable: true } });
  expect(frames.at(-1)).toMatchObject({ to: { id: logicalId, address: { sessionId: logicalId, scopeId: null } }, message: { id: `alias-mail-${selector}` } });
  expect(received).toBe(0);
}, 5000);

it("an ordinary local peer cannot claim the bridge before or after the service", async () => {
  const attempt = async (id: string) => {
    const socket = net.connect(getBrokerSocketPath()), messages: any[] = [];
    const { errors, closed } = trackSocket(socket);
    socket.on("data", createMessageReader(message => messages.push(message), error => socket.destroy(error)));
    writeMessage(socket, { type: "federation_register", feature: FEDERATION_FEATURE, agentDir: getAgentDirPath(), machineId: "squatter", machineAlias: "fake.invalid" });
    writeMessage(socket, { type: "list", requestId: "still-ordinary" });
    expectRefused(socket, messages, errors, await closed);
    expect(await (await session(id)).listSessions()).toBeInstanceOf(Array);
  };
  await bridge.close();
  await attempt("before-service");
  bridge = new IntercomFederationClient();
  await bridge.connect({ feature: FEDERATION_FEATURE, agentDir: getAgentDirPath(), credential: authorizeTestBridge(getAgentDirPath(), "machine-1"), machineId: "machine-1", machineAlias: "local.invalid" }, adapter);
  await attempt("after-service");
  expect(await bridge.inspectBlockers({ sessionId: "before-service", scopeId: null })).toBeDefined();
}, 5000);

it("a reset during a refused bridge claim still proves the claim was refused", async () => {
  const socket = net.connect(getBrokerSocketPath()), messages: any[] = [];
  const { errors, closed } = trackSocket(socket);
  socket.on("data", createMessageReader(message => messages.push(message), error => socket.destroy(error)));
  socket.once("end", () => socket.destroy(Object.assign(new Error("synthetic read ECONNRESET"), { code: "ECONNRESET" })));
  writeMessage(socket, { type: "federation_register", feature: FEDERATION_FEATURE, agentDir: getAgentDirPath(), machineId: "squatter", machineAlias: "fake.invalid" });
  expectRefused(socket, messages, errors, await closed);
  expect(errors.map(error => error.code)).toEqual(["ECONNRESET"]);
}, 5000);

it("does not mistake an unexpected error or registration for a refused claim", async () => {
  const socket = net.connect(getBrokerSocketPath()), messages: any[] = [];
  const { errors, closed } = trackSocket(socket);
  socket.on("data", createMessageReader(message => messages.push(message), error => socket.destroy(error)));
  socket.once("end", () => socket.destroy(Object.assign(new Error("synthetic read ETIMEDOUT"), { code: "ETIMEDOUT" })));
  writeMessage(socket, { type: "federation_register", feature: FEDERATION_FEATURE, agentDir: getAgentDirPath(), machineId: "squatter", machineAlias: "fake.invalid" });
  const hadError = await closed;
  expect(errors.map(error => error.code)).toEqual(["ETIMEDOUT"]);
  expect(() => expectRefused(socket, messages, errors, hadError)).toThrow();
  expect(() => expectRefused(socket, [...messages, { type: "federation_registered" }], [], false)).toThrow();
}, 5000);

it("unobserved local receipts become bounded unknown markers and expire", async () => {
  const source = await session("retained-source"), target = await session("retained-target");
  await source.send("retained-target", { messageId: "retained-receipt", text: "synthetic" });
  expect((await bridge.inspectBlockers({ sessionId: "retained-source", scopeId: null })).unobservedReceipts).toContain("retained-receipt");
  await target.disconnect();
  expect((await bridge.inspectBlockers({ sessionId: "retained-source", scopeId: null })).unknownOutcomes).toContain("retained-receipt");
  const clock = join(fixtureHome, "clock"), now = readFileSync(clock, "utf8");
  try {
    writeFileSync(clock, String(Number(now) + 60 * 60 * 1000 + 1));
    const result = await bridge.inspectBlockers({ sessionId: "retained-source", scopeId: null });
    expect(result.unobservedReceipts).not.toContain("retained-receipt");
    expect(result.unknownOutcomes).not.toContain("retained-receipt");
  } finally { writeFileSync(clock, now); }
}, 5000);
it("even a valid bridge credential is refused when federation is disabled", async () => {
  const file = join(getAgentDirPath(), "roam", "config.json"), config = readFileSync(file, "utf8");
  const credential = JSON.parse(readFileSync(join(getAgentDirPath(), "intercom", "bridge-authority.json"), "utf8")).credential;
  await bridge.close();
  const socket = net.connect(getBrokerSocketPath()), messages: any[] = [];
  const { errors, closed } = trackSocket(socket);
  socket.on("data", createMessageReader(message => messages.push(message), error => socket.destroy(error)));
  try {
    writeFileSync(file, JSON.stringify({ machineId: "machine-1", intercom: { enabled: false } }));
    writeMessage(socket, { type: "federation_register", feature: FEDERATION_FEATURE, credential, agentDir: getAgentDirPath(), machineId: "machine-1", machineAlias: "local.invalid" });
    writeMessage(socket, { type: "list", requestId: "must-refuse" });
    expectRefused(socket, messages, errors, await closed);
  } finally {
    socket.destroy(); writeFileSync(file, config); bridge = new IntercomFederationClient();
    await bridge.connect({ feature: FEDERATION_FEATURE, credential, agentDir: getAgentDirPath(), machineId: "machine-1", machineAlias: "local.invalid" }, adapter);
  }
}, 5000);
it("unsafe bridge credential permissions do not authorize a claim", async () => {
  const file = join(getAgentDirPath(), "intercom", "bridge-authority.json"), authority = JSON.parse(readFileSync(file, "utf8"));
  await bridge.close();
  const socket = net.connect(getBrokerSocketPath()), messages: any[] = [];
  const { errors, closed } = trackSocket(socket);
  socket.on("data", createMessageReader(message => messages.push(message), error => socket.destroy(error)));
  try {
    chmodSync(file, 0o644);
    writeMessage(socket, { type: "federation_register", feature: FEDERATION_FEATURE, credential: authority.credential, agentDir: getAgentDirPath(), machineId: "machine-1", machineAlias: "local.invalid" });
    writeMessage(socket, { type: "list", requestId: "must-refuse" });
    expectRefused(socket, messages, errors, await closed);
  } finally {
    socket.destroy(); chmodSync(file, 0o600); bridge = new IntercomFederationClient();
    await bridge.connect({ feature: FEDERATION_FEATURE, credential: authority.credential, agentDir: getAgentDirPath(), machineId: "machine-1", machineAlias: "local.invalid" }, adapter);
  }
}, 5000);

it("a reloaded local recipient can prove a queued entry from its old activation", async () => {
  const sender = await session("reload-proof-source"), old = await session("reload-proof-old", "old", undefined, "reload-proof-recipient"), receipts: any[] = [];
  sender.onMessageReceipt((_from, receipt) => receipts.push(receipt));
  await sender.send("reload-proof-old", { messageId: "reload-proof", text: "synthetic" });
  await old.disconnect();
  const current = await session("reload-proof-new", "new", undefined, "reload-proof-recipient");
  current.sendMessageReceipt({ messageId: "reload-proof", status: "injected", timestamp: Date.now(), evidence: { kind: "entry", entryId: "physical-old-queue", sessionId: "reload-proof-recipient", activationEpoch: "reload-proof-old-activation" } });
  await current.listSessions(); await sender.listSessions();
  expect(receipts).toMatchObject([{ messageId: "reload-proof", status: "injected", evidence: { entryId: "physical-old-queue" } }]);
}, 5000);
