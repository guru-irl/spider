import { afterEach, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { parseConfig } from "../config";
import { runHub } from "../hub";
import { requestHubControl } from "../control-socket";
import { createMachineIntercom, type MachineIntercomOptions } from "../intercom-runtime";
import { openIntercomStore } from "../intercom-store";
import { recordIntercomGeneration } from "../intercom-exclusion";
import type { FederationBridge, RemoteSessionInfo, SessionAddress } from "@spider/intercom/protocol";
import type { Clock, Journal, Transport } from "../contracts";

const HUB = "00000000-0000-4000-8000-000000000001";
const BOX = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000003";
const peer = (machineId: string, alias: string) => ({ machineId, alias, node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/core", globalRoot: "/fixture/global" });
const resources: Array<{ stop(): Promise<void> }> = [];
const roots: string[] = [];
const replicas: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) await resource.stop();
  for (const replica of replicas.splice(0).reverse()) replica.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
function fixture() {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "icr-")); roots.push(root);
  const global = createReplica("global", HUB); replicas.push(global);
  const config = parseConfig({ enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, coreUnit: "fixture.service",
    intercom: { enabled: true, mode: "peers", machineAlias: "hub.invalid" } });
  const order: string[] = [];
  const clock: Clock = { now: () => 1000, later: () => () => {} };
  const bridge = { async start() { order.push("bridge-start"); }, async stop() { order.push("bridge-stop"); }, diagnostics() { return []; } };
  const unit = join(root, "core.service"), terminals = join(root, "terminals.json");
  writeFileSync(unit, "unchanged core unit", { mode: 0o600 }); writeFileSync(terminals, "unrelated terminal", { mode: 0o600 });
  const ports = { config, globalDb: global.db, journal: {} as Journal, clock,
    sync: { start() { order.push("sync-start"); }, stop() { order.push("sync-stop"); }, async sync() { return []; }, async barriers() { return false; } },
    placement: { async reconcile() { return { pending: [] }; } }, runtimeRoot: root, socketPath: join(root, "hub.sock"),
    identity: { pid: 12345, startIdentity: "fixture-process" }, async probe() { return { kind: "live" as const, startIdentity: "fixture-process" }; },
    async observe() { return { reachability: "unknown" as const, readiness: null, suspensions: null }; },
    notices: { async publish() {}, async clear() {} }, async homeChangeInProgress() { return false; },
    async prepare() { order.push("prepare"); }, async drain() { order.push("drain"); }, closeStores() { order.push("close"); },
    intercom: bridge };
  return { ports, bridge, order, unit, terminals };
}

it("one bridge outlives all clients and stops once with the locked hub", async () => {
  const f = fixture(), service = await runHub(f.ports); resources.push(service);
  expect(f.order).toEqual(["prepare", "bridge-start", "sync-start"]);
  await Promise.all([service.stop(), service.stop()]);
  expect(f.order).toEqual(["prepare", "bridge-start", "sync-start", "sync-stop", "drain", "bridge-stop", "close"]);
  expect(readFileSync(f.unit, "utf8")).toBe("unchanged core unit");
  expect(readFileSync(f.terminals, "utf8")).toBe("unrelated terminal");
}, 5000);

it("hub status reports only intercom readiness and link metadata", async () => {
  const f = fixture(), service = await runHub({ ...f.ports, intercom: { ...f.bridge,
    readiness: () => ({ state: "pending" as const, reason: "unsupported-broker" }),
    diagnostics: () => [{ peer: BOX, status: "down", since: 10, reason: "link-down" }] } }); resources.push(service);
  const status = await requestHubControl(f.ports.socketPath, { op: "status" });
  expect(status.value).toMatchObject({ intercom: { state: "pending", reason: "unsupported-broker", links: [{ peer: BOX, status: "down", since: 10, reason: "link-down" }] } });
  expect(JSON.stringify(status.value)).not.toMatch(/message|content|queue\.db|token/i);
}, 5000);

it("a competing hub cannot start another bridge writer", async () => {
  const f = fixture(), first = await runHub(f.ports); resources.push(first);
  await expect(runHub(f.ports).then(service => { resources.push(service); return service; })).rejects.toThrow(/lock/i);
  expect(f.order.filter(event => event === "bridge-start")).toEqual(["bridge-start"]);
  await first.stop();
}, 5000);

it("the supervisor owns exactly one bridge and drains it before releasing its lock", async () => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "ics-")); roots.push(root);
  const api = await import("../production-supervisor") as unknown as { runLockedSupervisor?: (input: unknown) => Promise<{ stop(): Promise<void> }> };
  expect(api.runLockedSupervisor).toBeTypeOf("function");
  const order: string[] = [], intercom = { async start() { order.push("bridge-start"); }, async stop() { order.push("bridge-stop"); }, diagnostics() { return []; } };
  const supervisor = { start() { order.push("supervisor-start"); }, async stop() { order.push("supervisor-stop"); } };
  const input = { root, identity: { pid: 12345, startIdentity: "fixture-process" },
    async probe() { return { kind: "live" as const, startIdentity: "fixture-process" }; }, intercom, supervisor };
  const first = await api.runLockedSupervisor!(input); resources.push(first);
  await expect(api.runLockedSupervisor!(input).then(service => { resources.push(service); return service; })).rejects.toThrow(/lock/i);
  expect(order).toEqual(["bridge-start", "supervisor-start"]);
  await Promise.all([first.stop(), first.stop()]);
  expect(order).toEqual(["bridge-start", "supervisor-start", "supervisor-stop", "bridge-stop"]);
}, 5000);

it("settles local queued expiry without either session in the roster", async () => {
  const f = machineFixture(); let now = 1000;
  const timers: Array<{ at: number; fn(): void; cancelled: boolean }> = [];
  const clock: Clock = { now: () => now, later(ms, fn) { const timer = { at: now + ms, fn, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; } };
  const service = await makeMachine({ ...f.options, clock }); await service.start();
  const from = { sessionId: "sender-gone", scopeId: "scope" }, to = { sessionId: "recipient-gone", scopeId: "scope" };
  const accepted = await f.broker.bridge!.dispatch({ from, to: destination(to), message: { id: "local-expiry", timestamp: 1, content: { text: "synthetic" } } });
  expect(accepted).toMatchObject({ delivery: "queued", acceptance: { durable: true } });
  now += 24 * 60 * 60 * 1000;
  for (const timer of timers.filter(timer => !timer.cancelled && timer.at <= now)) { timer.cancelled = true; timer.fn(); }
  expect(f.broker.receipts).toMatchObject([{ to: from, receipt: { messageId: "local-expiry", status: "expired" } }]);
}, 5000);

it("does not replay a locally observed receipt after the bridge restarts", async () => {
  const f = machineFixture(), from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
  const first = await makeMachine(f.options); await first.start();
  f.broker.emit("presence", [localPresence(to, "recipient-generation")]);
  await f.broker.bridge!.dispatch({ from, to: destination(to), message: { id: "local-observed", timestamp: 1, content: { text: "synthetic" } } });
  expect(f.broker.deliveries).toHaveLength(1);
  f.broker.bridge!.receipt(to, { messageId: "local-observed", status: "injected", timestamp: 1000,
    evidence: { kind: "entry", entryId: "entry-1", sessionId: to.sessionId, activationEpoch: "recipient-generation" } });
  expect(f.broker.receipts).toHaveLength(1);
  await first.stop(); const second = await makeMachine(f.options); await second.start();
  expect(f.broker.receipts).toHaveLength(1);
}, 5000);

it("redelivers a reconciled local message when a new recipient generation is already ready", async () => {
  const f = machineFixture(), from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
  const service = await makeMachine(f.options); await service.start();
  f.broker.emit("presence", [localPresence(to, "recipient-generation")]);
  await f.broker.bridge!.dispatch({ from, to: destination(to), message: { id: "local-rebind", timestamp: 1, content: { text: "synthetic" } } });
  expect(f.broker.deliveries).toHaveLength(1);
  f.broker.emit("presence", [localPresence(to, "new-generation")]);
  f.broker.bridge!.receipt(to, { messageId: "local-rebind", status: "not_injected", timestamp: 1000,
    evidence: { kind: "absence", sessionId: to.sessionId, activationEpoch: "recipient-generation", excludedGeneration: "recipient-generation", complete: true } });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(f.broker.deliveries).toMatchObject([{ message: { id: "local-rebind" } }, { message: { id: "local-rebind" }, to: { activationEpoch: "new-generation" } }]);
}, 5000);

it("does not deliver to a session until its process generation is durably recorded", async () => {
  const f = machineFixture(), from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
  const service = await makeMachine({ ...f.options, generationKnown: undefined }); await service.start();
  f.broker.emit("presence", [localPresence(to, "recipient-generation")]);
  await f.broker.bridge!.dispatch({ from, to: destination(to), message: { id: "record-first", timestamp: 1, content: { text: "synthetic" } } });
  expect(f.broker.deliveries).toEqual([]);
  recordIntercomGeneration(f.global.db, { sessionId: to.sessionId, generation: "recipient-generation", pid: process.pid });
  f.broker.emit("presence", [localPresence(to, "recipient-generation")]);
  expect(f.broker.deliveries).toMatchObject([{ message: { id: "record-first" } }]);
}, 5000);

it("a bridge startup failure drains and releases the hub lock", async () => {
  const f = fixture();
  const broken = { ...f.ports, intercom: { ...f.bridge, async start() { f.order.push("bridge-start"); throw new Error("fixture bridge failure"); } } };
  await expect(runHub(broken).then(service => { resources.push(service); return service; })).rejects.toThrow("fixture bridge failure");
  expect(f.order).toEqual(["prepare", "bridge-start", "sync-stop", "drain", "bridge-stop", "close"]);
  const replacement = await runHub(f.ports); resources.push(replacement);
  expect(f.order.filter(event => event === "bridge-start")).toHaveLength(2);
}, 5000);

class FakeBroker extends EventEmitter {
  registrations: Array<{ agentDir: string; machineId: string }> = [];
  bridge: FederationBridge | null = null;
  deliveries: Array<{ from: RemoteSessionInfo; to: unknown; message: unknown }> = [];
  receipts: Array<{ from: RemoteSessionInfo; to: SessionAddress; receipt: unknown }> = [];
  published: RemoteSessionInfo[][] = [];
  closed = 0;
  helper: ((input: unknown, signal: AbortSignal) => Promise<unknown>) | null = null;
  async connect(registration: { agentDir: string; machineId: string }, bridge: FederationBridge) {
    this.registrations.push(registration); this.bridge = bridge;
    this.emit("presence", []);
  }
  async enableHelpers(_token: string, handler: (input: unknown, signal: AbortSignal) => Promise<unknown>) { this.helper = handler; }
  publishPresence(sessions: RemoteSessionInfo[]) { this.published.push(sessions); }
  async deliver(from: RemoteSessionInfo, to: unknown, message: unknown) {
    this.deliveries.push({ from, to, message });
    return { delivery: "socket_delivered" as const, retryable: false, outcomeKnown: true,
      acceptance: { accepted: true as const, durable: false as const } };
  }
  deliverReceipt(from: RemoteSessionInfo, to: SessionAddress, receipt: unknown) { this.receipts.push({ from, to, receipt }); }
  deliverControl() {}
  async inspectBlockers() { return { asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] }; }
  async close() { this.closed++; this.bridge = null; this.emit("closed"); }
}
function machineFixture(machineId = HUB) {
  const global = createReplica("global", machineId); replicas.push(global);
  const agentDir = mkdtempSync(join(resolve(".spider/scratch"), "ia-")); roots.push(agentDir);
  const config = parseConfig({ enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, coreUnit: "fixture.service",
    intercom: { enabled: true, mode: "peers", machineAlias: "hub.invalid" } });
  const broker = new FakeBroker(), calls: string[] = [], timers: Array<{ fn(): void; cancelled: boolean }> = [];
  const clock: Clock = { now: () => 1000, later(_ms, fn) { const timer = { fn, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; } };
  const transport: Transport = {
    async resolve() { throw new Error("unexpected remote call"); }, async exec() { throw new Error("unexpected remote call"); },
    async bootstrapProbe() { throw new Error("unexpected remote call"); }, async run() { throw new Error("unexpected remote call"); },
    async read() { throw new Error("unexpected remote call"); }, async write() { throw new Error("unexpected remote call"); },
  };
  const options: MachineIntercomOptions = { root: global.root, globalDb: global.db, config, agentDir, broker, clock, generationKnown: () => true,
    env: { ...process.env, PI_SUBAGENT_CHILD: "0" }, transport,
    async ensureBroker(input) { calls.push(input.agentDir); } };
  return { global, agentDir, broker, calls, timers, options, clock };
}
async function makeMachine(options: MachineIntercomOptions) {
  const service = createMachineIntercom(options); resources.push(service); return service;
}
const destination = (address: SessionAddress): RemoteSessionInfo => ({ remote: true, id: address.sessionId, address, machineId: HUB,
  machineAlias: "hub.invalid", homeEpoch: null, activationEpoch: "recipient-generation", endpointEpoch: "recipient-generation",
  cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1 });

it("runtime uses the configured agent directory and private queue", async () => {
  const f = machineFixture(), service = await makeMachine(f.options);
  await service.start();
  expect(f.calls).toEqual([f.agentDir]);
  expect(f.broker.registrations).toMatchObject([{ agentDir: f.agentDir, machineId: HUB }]);
  const directory = join(f.global.root, "roam", "intercom"), file = join(directory, "queue.db");
  expect(lstatSync(directory).mode & 0o777).toBe(0o700);
  expect(lstatSync(file).mode & 0o777).toBe(0o600);
  expect(lstatSync(join(directory, "helper.json")).mode & 0o777).toBe(0o600);
  f.broker.emit("presence", []);
  expect(f.broker.closed).toBe(0);
  expect(service.readiness()).toEqual({ state: "ready", reason: null });
  await service.stop(); await service.stop();
  expect(f.broker.closed).toBe(1);
}, 5000);

it("restart opens the same private queue after all clients disconnect", async () => {
  const f = machineFixture(), first = await makeMachine(f.options); await first.start();
  const from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
  const result = await f.broker.bridge!.dispatch({ from, to: destination(to), message: { id: "queued-id", timestamp: 1, content: { text: "synthetic" } } });
  expect(result).toMatchObject({ delivery: "queued", acceptance: { accepted: true, durable: true } });
  f.broker.emit("presence", []); await first.stop();
  const secondBroker = new FakeBroker(), second = await makeMachine({ ...f.options, broker: secondBroker }); await second.start();
  await second.stop();
  const reopened = openIntercomStore({ file: join(f.global.root, "roam", "intercom", "queue.db"), machineId: HUB, clock: f.clock });
  try { expect(reopened.retained("outbound", "queued-id")).toMatchObject({ state: "queued", payloadRetained: true }); }
  finally { reopened.close(); }
}, 5000);

function localPresence(address: SessionAddress, activationEpoch: string, status = "idle") {
  return { address, activationEpoch, homeEpoch: null, cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1, status };
}

it("binds broker presence, delivery and physical-entry receipts to the durable queue", async () => {
  const f = machineFixture(), service = await makeMachine(f.options); await service.start();
  const from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
  f.broker.emit("presence", [localPresence(from, "sender-generation"), localPresence(to, "recipient-generation")]);
  await f.broker.bridge!.dispatch({ from, to: destination(to), message: { id: "delivered-id", timestamp: 1, content: { text: "synthetic" } } });
  expect(f.broker.deliveries).toMatchObject([{ from: { address: from }, to: { address: to, activationEpoch: "recipient-generation" }, message: { id: "delivered-id" } }]);
  f.broker.bridge!.receipt(to, { messageId: "delivered-id", status: "injected", timestamp: 2,
    evidence: { kind: "entry", entryId: "physical-entry", sessionId: "recipient", activationEpoch: "recipient-generation" } });
  expect(f.broker.receipts).toMatchObject([{ from: { address: to }, to: from, receipt: { status: "injected" } }]);
  await service.stop();
  const reopened = openIntercomStore({ file: join(f.global.root, "roam", "intercom", "queue.db"), machineId: HUB, clock: f.clock });
  try { expect(reopened.retained("inbound", "delivered-id")).toMatchObject({ state: "injected", payloadRetained: false }); }
  finally { reopened.close(); }
}, 5000);

it("ignores unrelated or stale receipt evidence while preserving the bridge", async () => {
  const f = machineFixture(), service = await makeMachine(f.options); await service.start();
  const from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
  f.broker.emit("presence", [localPresence(from, "sender-generation"), localPresence(to, "recipient-generation")]);
  await f.broker.bridge!.dispatch({ from, to: destination(to), message: { id: "fenced-receipt", timestamp: 1, content: { text: "synthetic" } } });
  const receipt = { messageId: "fenced-receipt", status: "injected" as const, timestamp: 2,
    evidence: { kind: "entry" as const, entryId: "fixture-entry", sessionId: "recipient", activationEpoch: "wrong-generation" } };
  expect(() => f.broker.bridge!.receipt({ sessionId: "other", scopeId: "scope" }, receipt)).not.toThrow();
  expect(() => f.broker.bridge!.receipt(to, receipt)).not.toThrow();
  expect(f.broker.receipts).toEqual([]);
  expect(service.readiness().state).toBe("ready");
  await service.stop();
  const reopened = openIntercomStore({ file: join(f.global.root, "roam", "intercom", "queue.db"), machineId: HUB, clock: f.clock });
  try { expect(reopened.retained("inbound", "fenced-receipt")).toMatchObject({ state: "unknown", payloadRetained: true }); }
  finally { reopened.close(); }
}, 5000);

it("delivers accepted mail even when its remote sender has left the roster", async () => {
  const f = machineFixture(), target = peer(BOX, "box.invalid");
  const config = parseConfig({ role: "hub", machineId: HUB, hubMachineId: HUB, coreUnit: "fixture",
    intercom: { enabled: true, mode: "peers", machineAlias: "hub.invalid", routes: [{ kind: "direct", peer: target, edgeEpoch: "edge-1" }] } });
  const service = await makeMachine({ ...f.options, config }); await service.start();
  const from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
  const sourceRoot = mkdtempSync(join(resolve(".spider/scratch"), "source-")); roots.push(sourceRoot);
  const source = openIntercomStore({ file: join(sourceRoot, "queue.db"), machineId: BOX, clock: f.clock });
  try {
    const endpoint = { address: to, machineId: HUB, homeEpoch: null, activationEpoch: "recipient-generation" };
    source.acceptOutbound({ from, endpoint, nextHop: HUB, message: { id: "departed-id", timestamp: 1, content: { text: "synthetic" } } });
    const frame = source.pending({ kind: "outbound", peer: HUB, hopBudgetMs: 1000 })[0];
    const request = helperRequest(BOX, HUB, "edge-1", 1, [remote(BOX, "box.invalid", from)]);
    const reply = await f.broker.helper!({ ...request, exchange: { ...request.exchange, frames: [frame] } }, new AbortController().signal);
    expect(reply).toMatchObject({ exchange: { acknowledgements: [{ identity: { id: "departed-id" } }] } });
    expect(f.broker.deliveries).toEqual([]);
    await f.broker.helper!(helperRequest(BOX, HUB, "edge-1", 2), new AbortController().signal);
    expect(f.broker.published.at(-1)).toEqual([]);
    f.broker.emit("presence", [localPresence(to, "recipient-generation")]);
    expect(f.broker.deliveries).toMatchObject([{ from: { address: from, machineId: BOX }, message: { id: "departed-id" } }]);
    f.broker.bridge!.receipt(to, { messageId: "departed-id", status: "injected", timestamp: 1000,
      evidence: { kind: "entry", entryId: "entry-1", sessionId: to.sessionId, activationEpoch: "recipient-generation" } });
    const poll = helperRequest(BOX, HUB, "edge-1", 1); poll.exchange.generation.channel = "poll";
    const result = await f.broker.helper!(poll, new AbortController().signal) as { exchange: { receipts: Array<Parameters<typeof source.settleReceipt>[0]["frame"]> } };
    expect(result.exchange.receipts).toHaveLength(1);
    source.settleReceipt({ queue: "outbound", peer: HUB, frame: result.exchange.receipts[0] });
    expect(source.retained("outbound", "departed-id")?.state).toBe("injected");
  } finally { source.close(); }
}, 5000);

it("rejects an origin claim a direct peer is not authorized to relay", async () => {
  const f = machineFixture(), target = peer(BOX, "box.invalid");
  const config = parseConfig({ role: "hub", machineId: HUB, hubMachineId: HUB, coreUnit: "fixture",
    intercom: { enabled: true, mode: "peers", machineAlias: "hub.invalid", routes: [{ kind: "direct", peer: target, edgeEpoch: "edge-1" }] } });
  const service = await makeMachine({ ...f.options, config }); await service.start();
  const sourceRoot = mkdtempSync(join(resolve(".spider/scratch"), "source-")); roots.push(sourceRoot);
  const source = openIntercomStore({ file: join(sourceRoot, "queue.db"), machineId: BOX, clock: f.clock });
  try {
    const from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
    source.acceptOutbound({ from, endpoint: { address: to, machineId: HUB, homeEpoch: null, activationEpoch: "recipient-generation" }, nextHop: HUB,
      message: { id: "forged-origin", timestamp: 1, content: { text: "synthetic" } } });
    const frame = source.pending({ kind: "outbound", peer: HUB, hopBudgetMs: 1000 })[0], request = helperRequest(BOX, HUB, "edge-1", 1);
    await expect(f.broker.helper!({ ...request, exchange: { ...request.exchange, frames: [{ ...frame, originMachineId: OTHER }] } }, new AbortController().signal))
      .rejects.toMatchObject({ code: "machine-not-enrolled" });
    expect(f.broker.deliveries).toEqual([]);
  } finally { source.close(); }
}, 5000);

it("reload alone leaves an unobserved handoff unknown and never redispatches it", async () => {
  const f = machineFixture(), first = await makeMachine(f.options); await first.start();
  const from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
  f.broker.emit("presence", [localPresence(from, "sender-generation"), localPresence(to, "recipient-generation")]);
  await f.broker.bridge!.dispatch({ from, to: destination(to), message: { id: "unknown-id", timestamp: 1, content: { text: "synthetic" } } });
  expect(f.broker.deliveries).toHaveLength(1);
  await first.stop();
  const secondBroker = new FakeBroker(), second = await makeMachine({ ...f.options, broker: secondBroker }); await second.start();
  secondBroker.emit("presence", [localPresence(from, "sender-generation"), localPresence(to, "new-generation")]);
  expect(secondBroker.deliveries).toEqual([]);
  await second.stop();
  const reopened = openIntercomStore({ file: join(f.global.root, "roam", "intercom", "queue.db"), machineId: HUB, clock: f.clock });
  try { expect(reopened.retained("inbound", "unknown-id")).toMatchObject({ state: "unknown", payloadRetained: true }); }
  finally { reopened.close(); }
}, 5000);

it("configured peer edges preserve their full enrollment and shared epoch", async () => {
  const f = machineFixture(), target = peer(BOX, "box.invalid");
  const config = parseConfig({ enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, coreUnit: "fixture",
    intercom: { enabled: true, mode: "peers", machineAlias: "hub.invalid", routes: [{ kind: "direct", peer: target, edgeEpoch: "edge-1" }] } });
  const resolved: string[] = [];
  const service = await makeMachine({ ...f.options, config, transport: { ...f.options.transport,
    async resolve(value) { resolved.push(value.machineId); throw Object.assign(new Error("unavailable"), { code: "unavailable" }); } } });
  await service.start();
  expect(service.readiness()).toEqual({ state: "ready", reason: null });
  const signal = new AbortController().signal;
  const reply = await f.broker.helper!({ version: 1, holdMs: 0, deadlineMs: 5000, exchange: { protocol: 2, senderMachine: BOX, recipientMachine: HUB,
    generation: { edgeEpoch: "edge-1", channel: "push", generation: 1 }, frames: [], acknowledgements: [], receipts: [], controls: [], presence: [] } }, signal);
  expect(reply).toMatchObject({ version: 1, exchange: { senderMachine: HUB, recipientMachine: BOX } });
  expect(resolved).toEqual([BOX]);
}, 5000);

function helperRequest(from: string, to: string, edgeEpoch: string, generation: number, presence: RemoteSessionInfo[] = []) {
  return { version: 1, holdMs: 0, deadlineMs: 5000, exchange: { protocol: 2, senderMachine: from, recipientMachine: to,
    generation: { edgeEpoch, channel: "push", generation }, frames: [], acknowledgements: [], receipts: [], controls: [], presence } };
}
function remote(machineId: string, alias: string, address: SessionAddress): RemoteSessionInfo {
  return { ...destination(address), machineId, machineAlias: alias };
}

it("hub-only mode advertises and queues an enrolled box through the hub", async () => {
  const f = machineFixture(BOX), config = parseConfig({ role: "box", machineId: BOX, hubMachineId: HUB, coreUnit: "fixture",
    intercom: { enabled: true, mode: "hub-only", machineAlias: "box.invalid", routes: [
      { kind: "direct", peer: peer(HUB, "hub.invalid"), edgeEpoch: "hub-box" },
      { kind: "relay", peer: peer(OTHER, "other.invalid"), via: HUB },
    ] } });
  const service = await makeMachine({ ...f.options, config }); await service.start();
  const target = { sessionId: "remote-recipient", scopeId: "scope" }, from = { sessionId: "sender", scopeId: "scope" };
  const entry = remote(OTHER, "other.invalid", target), signal = new AbortController().signal;
  await f.broker.helper!(helperRequest(HUB, BOX, "hub-box", 1, [entry]), signal);
  expect(f.broker.published.at(-1)).toMatchObject([{ address: target, machineId: OTHER }]);
  const accepted = await f.broker.bridge!.dispatch({ from, to: entry, message: { id: "relayed-id", timestamp: 1, content: { text: "synthetic" } } });
  expect(accepted).toMatchObject({ delivery: "queued", acceptance: { durable: true } });
  await expect(f.broker.helper!(helperRequest(HUB, BOX, "hub-box", 2, [{ ...entry, machineAlias: "spoof.invalid" }]), signal)).rejects.toThrow(/invalid-presence/);
  await service.stop();
  const reopened = openIntercomStore({ file: join(f.global.root, "roam", "intercom", "queue.db"), machineId: BOX, clock: f.clock });
  try { expect(reopened.retained("outbound", "relayed-id")).toMatchObject({ state: "queued", peer: HUB, payloadRetained: true }); }
  finally { reopened.close(); }
}, 5000);

it("peer mode starts direct box links even when the hub is offline", async () => {
  const f = machineFixture(BOX), config = parseConfig({ role: "box", machineId: BOX, hubMachineId: HUB, coreUnit: "fixture",
    intercom: { enabled: true, mode: "peers", machineAlias: "box.invalid", routes: [
      { kind: "direct", peer: peer(HUB, "hub.invalid"), edgeEpoch: "hub-box" },
      { kind: "direct", peer: peer(OTHER, "other.invalid"), edgeEpoch: "box-other" },
    ] } });
  const resolved: string[] = [];
  const service = await makeMachine({ ...f.options, config, transport: { ...f.options.transport,
    async resolve(value) { resolved.push(value.machineId); throw Object.assign(new Error("unavailable"), { code: "unavailable" }); } } });
  await service.start();
  expect(service.readiness().state).toBe("ready");
  expect(resolved).toContain(OTHER);
  const target = { sessionId: "remote-recipient", scopeId: "scope" }, from = { sessionId: "sender", scopeId: "scope" };
  const result = await f.broker.bridge!.dispatch({ from, to: remote(OTHER, "other.invalid", target), message: { id: "direct-id", timestamp: 1, content: { text: "synthetic" } } });
  expect(result).toMatchObject({ delivery: "queued", acceptance: { durable: true } });
  await service.stop();
  const reopened = openIntercomStore({ file: join(f.global.root, "roam", "intercom", "queue.db"), machineId: BOX, clock: f.clock });
  try { expect(reopened.retained("outbound", "direct-id")).toMatchObject({ peer: OTHER, state: "queued" }); }
  finally { reopened.close(); }
}, 5000);

it("hub-only mode advertises one enrolled box to another, but not a spoofed peer", async () => {
  const f = machineFixture(), config = parseConfig({ role: "hub", machineId: HUB, hubMachineId: HUB, coreUnit: "fixture",
    intercom: { enabled: true, mode: "hub-only", machineAlias: "hub.invalid", routes: [
      { kind: "direct", peer: peer(BOX, "box.invalid"), edgeEpoch: "hub-box" },
      { kind: "direct", peer: peer(OTHER, "other.invalid"), edgeEpoch: "hub-other" },
    ] } });
  const service = await makeMachine({ ...f.options, config }); await service.start();
  const address = { sessionId: "box-session", scopeId: "scope" }, signal = new AbortController().signal;
  await f.broker.helper!(helperRequest(BOX, HUB, "hub-box", 1, [remote(BOX, "box.invalid", address)]), signal);
  const reply = await f.broker.helper!(helperRequest(OTHER, HUB, "hub-other", 1), signal);
  expect(reply).toMatchObject({ exchange: { presence: [{ address, machineId: BOX }] } });
  await expect(f.broker.helper!(helperRequest(BOX, HUB, "hub-box", 2, [remote(OTHER, "other.invalid", address)]), signal)).rejects.toThrow(/invalid-presence/);
}, 5000);

it("persists one link outage, updates its reason, and clears it on a valid exchange", async () => {
  const f = machineFixture(), target = peer(BOX, "box.invalid");
  const config = parseConfig({ role: "hub", machineId: HUB, hubMachineId: HUB, coreUnit: "fixture",
    intercom: { enabled: true, mode: "peers", machineAlias: "hub.invalid", routes: [{ kind: "direct", peer: target, edgeEpoch: "edge-1" }] } });
  let attempts = 0;
  const transport: Transport = { ...f.options.transport, async resolve() {
    const code = attempts++ === 0 ? "unavailable" : "needs_login";
    throw Object.assign(new Error(code), { code });
  } };
  const first = await makeMachine({ ...f.options, config, transport }); await first.start();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(first.diagnostics()).toEqual([{ peer: BOX, status: "recovering", since: 1000, reason: "unavailable" }]);
  const retry = f.timers.find(timer => !timer.cancelled); expect(retry).toBeDefined(); retry!.cancelled = true; retry!.fn();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(first.diagnostics()).toEqual([{ peer: BOX, status: "down", since: 1000, reason: "needs_login" }]);
  await first.stop();
  const nextBroker = new FakeBroker(), second = await makeMachine({ ...f.options, config, transport, broker: nextBroker }); await second.start();
  expect(second.diagnostics()).toEqual([{ peer: BOX, status: "down", since: 1000, reason: "needs_login" }]);
  await nextBroker.helper!(helperRequest(BOX, HUB, "edge-1", 1), new AbortController().signal);
  expect(second.diagnostics()).toEqual([]);
}, 5000);

it("rejects dispatch against a stale authoritative home epoch", async () => {
  const f = machineFixture();
  f.global.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES (?,?,1,NULL,1)").run("recipient", BOX);
  const service = await makeMachine(f.options); await service.start();
  const from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
  const result = await f.broker.bridge!.dispatch({ from, to: destination(to), message: { id: "fenced-id", timestamp: 1, content: { text: "synthetic" } } });
  expect(result).toMatchObject({ delivery: "failed", reason: "stale-home-epoch", acceptance: { accepted: false } });
}, 5000);

it("stopping during broker discovery cancels startup before any registration", async () => {
  const f = machineFixture();
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const service = await makeMachine({ ...f.options, async ensureBroker({ signal }) {
    entered(); await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
  } });
  const starting = service.start(); await waiting;
  await service.stop(); await starting;
  expect(f.broker.registrations).toEqual([]);
  expect(f.timers.filter(timer => !timer.cancelled)).toEqual([]);
  expect(existsSync(join(f.global.root, "roam", "intercom", "helper.json"))).toBe(false);
}, 5000);

it("waits for an in-flight local delivery before closing its queue", async () => {
  const f = machineFixture();
  let finish!: (value: Awaited<ReturnType<FakeBroker["deliver"]>>) => void;
  f.broker.deliver = (from, to, message) => { f.broker.deliveries.push({ from, to, message });
    return new Promise(resolve => { finish = resolve; }); };
  const service = await makeMachine(f.options); await service.start();
  const from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
  f.broker.emit("presence", [localPresence(from, "sender-generation"), localPresence(to, "recipient-generation")]);
  await f.broker.bridge!.dispatch({ from, to: destination(to), message: { id: "pending-id", timestamp: 1, content: { text: "synthetic" } } });
  expect(f.broker.deliveries).toHaveLength(1);
  let stopped = false;
  const stopping = service.stop().then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  try { expect(stopped).toBe(false); }
  finally {
    finish({ delivery: "socket_delivered", retryable: false, outcomeKnown: true, acceptance: { accepted: true, durable: false } });
    await stopping;
  }
  expect(stopped).toBe(true);
}, 5000);

it("legacy broker blocks federation without forced replacement", async () => {
  const f = machineFixture(), directory = join(f.agentDir, "intercom"); mkdirSync(directory, { mode: 0o700 });
  const pid = join(directory, "broker.pid"); writeFileSync(pid, "legacy-owner", { mode: 0o600 });
  const service = await makeMachine({ ...f.options, async ensureBroker() { throw new Error("unsupported-broker"); } });
  await service.start();
  expect(service.readiness()).toEqual({ state: "pending", reason: "unsupported-broker" });
  expect(f.broker.registrations).toEqual([]);
  expect(readFileSync(pid, "utf8")).toBe("legacy-owner");
  await service.stop();
}, 5000);

it("inherited child mode and disabled federation start no machine bridge", async () => {
  const f = machineFixture();
  const child = await makeMachine({ ...f.options, env: { ...f.options.env, PI_SUBAGENT_CHILD: "1" } });
  await child.start();
  const disabled = await makeMachine({ ...f.options, config: parseConfig({ role: "hub", machineId: HUB, hubMachineId: HUB, coreUnit: "fixture" }) });
  await disabled.start();
  expect(child.readiness()).toEqual({ state: "disabled", reason: null });
  expect(disabled.readiness()).toEqual({ state: "disabled", reason: null });
  expect(f.calls).toEqual([]);
  expect(f.broker.registrations).toEqual([]);
  expect(existsSync(join(f.global.root, "roam", "intercom"))).toBe(false);
}, 5000);

it("refuses a symlinked broker directory before creating a queue", async () => {
  const f = machineFixture(), target = mkdtempSync(join(resolve(".spider/scratch"), "broker-target-")); roots.push(target);
  writeFileSync(join(target, "sentinel"), "untouched", { mode: 0o600 });
  symlinkSync(target, join(f.agentDir, "intercom"));
  const service = await makeMachine(f.options);
  await expect(service.start()).rejects.toThrow(/unsafe/i);
  expect(f.calls).toEqual([]);
  expect(readFileSync(join(target, "sentinel"), "utf8")).toBe("untouched");
  expect(existsSync(join(f.global.root, "roam", "intercom"))).toBe(false);
}, 5000);

it("refuses symlinked broker metadata before touching it", async () => {
  const f = machineFixture(), dir = join(f.agentDir, "intercom"); mkdirSync(dir, { mode: 0o700 });
  const sentinel = join(f.agentDir, "sentinel"); writeFileSync(sentinel, "untouched", { mode: 0o600 });
  symlinkSync(sentinel, join(dir, "broker.pid"));
  const service = await makeMachine(f.options);
  await expect(service.start()).rejects.toThrow(/unsafe/i);
  expect(f.calls).toEqual([]);
  expect(readFileSync(sentinel, "utf8")).toBe("untouched");
  expect(existsSync(join(f.global.root, "roam", "intercom"))).toBe(false);
}, 5000);

it("refuses an overlong broker socket path before starting a broker", async () => {
  const f = machineFixture(), longDir = join(f.agentDir, "a".repeat(80)); mkdirSync(longDir, { mode: 0o700 });
  const service = await makeMachine({ ...f.options, agentDir: longDir });
  await expect(service.start()).rejects.toThrow(/socket.*long/i);
  expect(f.calls).toEqual([]);
  expect(f.broker.registrations).toEqual([]);
  expect(existsSync(join(f.global.root, "roam", "intercom"))).toBe(false);
}, 5000);
