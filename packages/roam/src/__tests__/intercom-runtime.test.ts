import { withHopRequest } from "./intercom-hop-fixture";
import { withHopExchange } from "./intercom-hop-fixture";
import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter, once } from "node:events";
import { createServer, type Socket } from "node:net";
import { createMessageReader, writeMessage } from "../../../intercom/src/broker/framing";
import { HELPER_EXCHANGE_FEATURE } from "@spider/intercom/protocol";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { writeLocal } from "@spider/db-core/roam/local-state";
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
  const evidence = { messageId: "local-observed", status: "injected" as const, timestamp: 1000,
    evidence: { kind: "entry" as const, entryId: "entry-1", sessionId: to.sessionId, activationEpoch: "recipient-generation" } };
  f.broker.bridge!.receipt(to, evidence);
  expect(f.broker.receipts).toHaveLength(1);
  await first.stop(); const second = await makeMachine(f.options); await second.start();
  expect(f.broker.receipts).toHaveLength(1);
  f.broker.bridge!.receipt(to, evidence);
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

it("a restarted bridge delivers pre-adoption mail using durable adoption and preserves its receipt owner", async () => {
  const { recordFirstHomeAdoption } = await import("../intercom-first-home");
  const { openDbReadOnly } = await import("@spider/db-core");
  const f = machineFixture(), from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
  const old = { address: to, machineId: HUB, homeEpoch: null, activationEpoch: "recipient-generation" };
  const first = await makeMachine(f.options); await first.start();
  await f.broker.bridge!.dispatch({ from, to: destination(to), message: { id: "local-first-home", timestamp: 1, content: { text: "synthetic" } } });
  expect(f.broker.deliveries).toEqual([]);
  recordIntercomGeneration(f.global.db, { sessionId: to.sessionId, generation: old.activationEpoch, pid: process.pid });
  recordFirstHomeAdoption(f.global.db, old, { ...old, homeEpoch: 1 }, 1000);
  await first.stop();
  const second = await makeMachine(f.options); await second.start();
  f.broker.emit("presence", [{ ...localPresence(to, old.activationEpoch), homeEpoch: 1 }]);
  await vi.waitFor(() => expect(f.broker.deliveries).toHaveLength(1), { timeout: 1000, interval: 10 });
  expect(f.broker.deliveries[0]).toMatchObject({ to: { ...old, homeEpoch: 1 }, message: { id: "local-first-home" } });
  f.broker.bridge!.receipt(to, { messageId: "local-first-home", status: "injected", timestamp: 1000,
    evidence: { kind: "entry", entryId: "first-home-entry", sessionId: to.sessionId, activationEpoch: old.activationEpoch } });
  expect(f.broker.receipts).toMatchObject([{ to: from, receipt: { messageId: "local-first-home", status: "injected" } }]);
  f.broker.emit("presence", [{ ...localPresence(to, old.activationEpoch), homeEpoch: 1 }]);
  expect(f.broker.deliveries).toHaveLength(1);
  const db = openDbReadOnly(join(f.global.root, "roam", "intercom", "queue.db"))!;
  try {
    const rows = db.prepare("SELECT endpoint_json,state,payload_json FROM intercom_copies WHERE id=?").all("local-first-home") as Array<{ endpoint_json: string; state: string; payload_json: string | null }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) { expect(JSON.parse(row.endpoint_json)).toEqual(old); expect(row.state).toBe("injected"); expect(row.payload_json).toBeNull(); }
  } finally { db.close(); }
}, 5000);

it("rebuilds first-home presence attestations from durable adoption after a bridge restart", async () => {
  const { recordFirstHomeAdoption } = await import("../intercom-first-home");
  const f = machineFixture(), target = peer(BOX, "box.invalid");
  const config = parseConfig({ ...f.options.config, peers: [target], intercom: { enabled: true, mode: "peers", machineAlias: "hub.invalid",
    routes: [{ kind: "direct", peer: target, edgeEpoch: "edge-1" }] } });
  const address = { sessionId: "adopting-origin", scopeId: "scope" }, activation = "original-adopting-process";
  const old = { address, machineId: HUB, homeEpoch: null, activationEpoch: activation };
  const first = await makeMachine({ ...f.options, config }); await first.start();
  f.broker.emit("presence", [{ ...localPresence(address, activation), homeEpoch: 1 }]);
  const before = await f.broker.helper!(withHopRequest(helperRequest(BOX, HUB, "edge-1", 1)), new AbortController().signal) as { exchange: { presence: RemoteSessionInfo[] } };
  expect(before.exchange.presence[0].firstHome).toBeUndefined();
  recordIntercomGeneration(f.global.db, { sessionId: address.sessionId, generation: activation, pid: process.pid });
  recordFirstHomeAdoption(f.global.db, old, { ...old, homeEpoch: 1 }, 1000);
  await first.stop();
  const second = await makeMachine({ ...f.options, config }); await second.start();
  f.broker.emit("presence", [{ ...localPresence(address, activation), homeEpoch: 1 }]);
  const after = await f.broker.helper!(withHopRequest(helperRequest(BOX, HUB, "edge-1", 2)), new AbortController().signal) as { exchange: { presence: RemoteSessionInfo[] } };
  expect(after.exchange.presence).toMatchObject([{ address, activationEpoch: activation, homeEpoch: 1,
    firstHome: { activation, fromEpoch: null, toEpoch: 1 } }]);
}, 5000);

it.each([
  { role: "hub" as const, local: OTHER, hub: OTHER, remote: BOX, opens: true },
  { role: "box" as const, local: HUB, hub: OTHER, remote: OTHER, opens: false },
  { role: "box" as const, local: BOX, hub: HUB, remote: OTHER, opens: true },
  { role: "box" as const, local: OTHER, hub: HUB, remote: BOX, opens: false },
])("opens exchanges only on the enrolled initiating side for $role $local to $remote", async ({ role, local, hub, remote, opens }) => {
  const f = machineFixture(local), target = peer(remote, "peer.invalid"), attempted: string[] = [];
  const config = parseConfig({ ...f.options.config, role, machineId: local, hubMachineId: hub, peers: role === "hub" ? [target] : [],
    intercom: { enabled: true, mode: "peers", machineAlias: "local.invalid", routes: [{ kind: "direct", peer: target, edgeEpoch: "edge-1" }] } });
  const service = await makeMachine({ ...f.options, config, transport: { ...f.options.transport,
    async resolve(peer) { attempted.push(peer.machineId); throw new Error("synthetic transport outage"); } } });
  await service.start();
  expect(attempted).toEqual(opens ? [remote] : []);
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
  noticeConfirmed = true;
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
  async deliverRevocationNotice(from: RemoteSessionInfo, to: SessionAddress, receipt: unknown) { this.receipts.push({ from, to, receipt }); return this.noticeConfirmed; }
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

it("a live local presence can close its move intake without leaking roster fields into its endpoint", async () => {
  const f = machineFixture(), address = { sessionId: "moving-session", scopeId: null };
  f.global.db.prepare("INSERT INTO session_homes VALUES(?,?,2,NULL,1)").run(address.sessionId, HUB);
  let owns = true;
  f.options.moveOwns = async () => owns;
  Object.assign(f.broker, { async intake(_action: string, fence: { generation: string }) { return fence.generation; } });
  const service = await makeMachine(f.options); await service.start();
  f.broker.emit("presence", [{ ...localPresence(address, "source-generation"), homeEpoch: 2 }]);
  const fence = await service.move.intake.close(address, "move-a", 2, "closure-generation");
  expect(fence).toEqual({ address, moveId: "move-a", expectedEpoch: 2, generation: "closure-generation" });
  expect(await service.move.endpoint(address)).toEqual({ address, machineId: HUB, homeEpoch: 2, activationEpoch: "source-generation" });
  owns = false;
  await expect(service.move.intake.close(address, "move-a", 2, "closure-generation")).rejects.toMatchObject({
    blockers: [{ kind: "intercom-owner-unknown", id: address.sessionId }] });
}, 5000);

it.each([null, 1])("delivers for a never-moved local session at initial epoch %s without a home row", async homeEpoch => {
  const f = machineFixture(), from = { sessionId: "never-moved-sender", scopeId: "scope" }, to = { sessionId: "never-moved-recipient", scopeId: "scope" };
  const service = await makeMachine(f.options); await service.start();
  expect(f.global.db.prepare("SELECT 1 FROM session_homes WHERE session_id=?").get(to.sessionId)).toBeUndefined();
  f.broker.emit("presence", [{ ...localPresence(to, "recipient-generation"), homeEpoch }, localPresence(from, "sender-generation")]);
  expect(await f.broker.bridge!.dispatch({ from, to: { ...destination(to), homeEpoch },
    message: { id: "never-moved-mail", timestamp: 1000, content: { text: "synthetic" } } })).toMatchObject({ delivery: "queued" });
  await vi.waitFor(() => expect(f.broker.deliveries).toMatchObject([{ to: { address: to, machineId: HUB, homeEpoch }, message: { id: "never-moved-mail" } }]));
}, 5000);

it("selects the committed remote home without waking the stale local recipient", async () => {
  const f = machineFixture(), address = { sessionId: "moving-recipient", scopeId: "scope" }, from = { sessionId: "sender", scopeId: "scope" };
  const target = peer(BOX, "destination.invalid"), config = parseConfig({ ...f.options.config, peers: [target],
    intercom: { ...f.options.config.intercom, routes: [{ kind: "direct", peer: target, edgeEpoch: "edge-1" }] } });
  f.global.db.prepare("INSERT INTO session_homes VALUES(?,?,1,NULL,1)").run(address.sessionId, HUB);
  const service = await makeMachine({ ...f.options, config }); await service.start();
  const stale = { ...localPresence(address, "source-generation"), homeEpoch: 1 };
  f.broker.emit("presence", [stale, localPresence(from, "sender-generation")]);
  const queue = openIntercomStore({ file: join(f.global.root, "roam", "intercom", "queue.db"), machineId: HUB, clock: f.clock }); replicas.push(queue);
  queue.acceptLocal({ from, endpoint: { address, machineId: HUB, homeEpoch: 1, activationEpoch: "source-generation" },
    message: { id: "old-local-mail", timestamp: 1000, content: { text: "synthetic" } } });
  f.global.db.prepare("UPDATE session_homes SET machine_id=?,epoch=2 WHERE session_id=?").run(BOX, address.sessionId);
  f.broker.emit("presence", [{ ...stale, status: "working" }, localPresence(from, "sender-generation")]);
  f.broker.emit("presence", [stale, localPresence(from, "sender-generation")]);
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  expect(f.broker.deliveries).toEqual([]);
  const current = { ...destination(address), machineId: BOX, machineAlias: "destination.invalid", homeEpoch: 2,
    activationEpoch: "destination-generation", endpointEpoch: "destination-generation" };
  await f.broker.helper!(withHopRequest(helperRequest(BOX, HUB, "edge-1", 1, [current])), new AbortController().signal);
  expect(await service.move.endpoint(address)).toEqual({ address, machineId: BOX, homeEpoch: 2, activationEpoch: "destination-generation" });
  expect(f.broker.published.at(-1)).toEqual([expect.objectContaining({ machineId: BOX, homeEpoch: 2 })]);
  expect(await f.broker.bridge!.dispatch({ from: { ...from, sessionId: "fresh-sender" }, to: current, message: { id: "new-remote-mail", timestamp: 1000, content: { text: "synthetic" } } }))
    .toMatchObject({ delivery: "queued" });
  expect(queue.retained("outbound", "new-remote-mail")).toMatchObject({ endpoint: { machineId: BOX, homeEpoch: 2, activationEpoch: "destination-generation" } });
  expect(f.broker.deliveries).toEqual([]);
}, 5000);

it.each(["unknown", "conflict"])("does not activate a local endpoint with %s committed ownership", async kind => {
  const f = machineFixture(), address = { sessionId: "unproved-recipient", scopeId: null };
  if (kind === "conflict") f.global.db.prepare("INSERT INTO session_homes VALUES(?,?,2,NULL,1)").run(address.sessionId, BOX);
  const service = await makeMachine(f.options); await service.start();
  f.broker.emit("presence", [{ ...localPresence(address, "source-generation"), homeEpoch: 2 }]);
  await expect(service.move.endpoint(address)).rejects.toThrow("intercom-endpoint-unproved");
  expect(f.broker.deliveries).toEqual([]);
}, 5000);

it("a ready roaming bridge exposes strict move blocker snapshots", async () => {
  const f = machineFixture(), service = await makeMachine(f.options);
  await service.start();
  expect(service.readiness()).toEqual({ state: "ready", reason: null });
  expect(await service.move.bridge({ sessionId: "clean-session", scopeId: null })).toEqual({ asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] });
  await service.stop();
  await expect(service.move.bridge({ sessionId: "clean-session", scopeId: null })).rejects.toThrow("intercom-move-unavailable");
}, 5000);

it("the service retries revocations periodically without overlapping sweeps and joins recovery on stop", async () => {
  const f = machineFixture(), timers: Array<{ ms: number; fn(): void; cancelled: boolean }> = [];
  let calls = 0, release: (() => void) | undefined, scheduled!: () => void;
  const scheduleReady = new Promise<void>(resolve => { scheduled = resolve; });
  const clock: Clock = { now: () => 1000, later(ms, fn) { const timer = { ms, fn, cancelled: false }; timers.push(timer); if (ms === 10_000) scheduled(); return () => { timer.cancelled = true; }; } };
  const service = await makeMachine({ ...f.options, clock, async recoverRevocations(store) {
    expect(store.pairFence(BOX)).toBeNull(); calls++;
    if (calls === 2) await new Promise<void>(resolve => { release = resolve; });
  } } as MachineIntercomOptions);
  await service.start(); await scheduleReady;
  expect(calls).toBe(1);
  const timer = timers.find(row => row.ms === 10_000)!; expect(timer).toBeDefined();
  timer.fn(); timer.fn(); await Promise.resolve(); expect(calls).toBe(2);
  let closed = false; const stop = service.stop().then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false);
  release!(); await stop; expect(closed).toBe(true); expect(timer.cancelled).toBe(true);
  timer.fn(); await Promise.resolve(); expect(calls).toBe(2);
}, 5000);

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

it("does not activate a live edge without pair-scoped connector readiness", async () => {
  const f = machineFixture(), service = await makeMachine(f.options); await service.start();
  await expect(f.broker.helper!({ version: 1, action: "enroll-pair", machineId: HUB, peer: BOX, pairId: "pair-live", edgeEpoch: "edge-new",
    operationId: "op-live", graphDigest: "a".repeat(64), expectedFenceId: null }, new AbortController().signal)).rejects.toThrow("connector-not-pair-scoped");
  expect(f.broker.closed).toBe(0);
}, 5000);

it("activates only a registered approved edge through the live authenticated helper", async () => {
  const f = machineFixture(), directory = join(f.global.root, "roam"), direct: ReturnType<typeof peer>[] = [];
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "config.json"), JSON.stringify(f.options.config), { mode: 0o600 });
  writeFileSync(join(directory, "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  const source = { ...peer(HUB, "hub.invalid"), globalRoot: f.global.root }, target = peer(BOX, "box.invalid");
  const key = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]);
  const pair = { pairId: "pair-live", source, target, connector: { tunnelId: "tunnel", remotePort: 22, session: "session" }, edgeEpoch: "edge-new", sshUser: "fixture",
    hostKey: { type: "ssh-ed25519", base64: key.toString("base64") }, hostKeyAlias: `spider-${"a".repeat(32)}` };
  const { createIntercomRegistry } = await import("../intercom-registry");
  const { persistIntercomPairRoute } = await import("../provision-config");
  const registry = createIntercomRegistry(f.global.root), digest = "a".repeat(64);
  await registry.register(pair, "op-live", digest); await registry.bind(pair, "op-live");
  const service = await makeMachine({ ...f.options, directPeers: direct, async pairScopedHostReady() { return true; } }); await service.start();
  const request = { version: 1, action: "enroll-pair", machineId: HUB, peer: BOX, pairId: pair.pairId, edgeEpoch: pair.edgeEpoch,
    operationId: "op-live", graphDigest: digest, expectedFenceId: null };
  await expect(f.broker.helper!(request, new AbortController().signal)).rejects.toThrow();
  await persistIntercomPairRoute(f.global.root, pair, "op-live", digest);
  await expect(f.broker.helper!(withHopRequest({ ...request, graphDigest: "b".repeat(64) }), new AbortController().signal)).rejects.toThrow();
  expect(await f.broker.helper!(request, new AbortController().signal)).toEqual({ machineId: HUB, peer: BOX, edgeEpoch: "edge-new", applied: true });
  expect(direct).toMatchObject([{ machineId: BOX }]);
  expect(await f.broker.helper!({ version: 1, action: "inspect-pair", machineId: HUB, peer: BOX, edgeEpoch: "edge-new" }, new AbortController().signal))
    .toMatchObject({ machineId: HUB, peer: BOX, edgeEpoch: "edge-new", status: expect.not.stringMatching(/^live$/) });
  expect(await f.broker.helper!(request, new AbortController().signal)).toMatchObject({ applied: true });
  await f.broker.helper!({ version: 1, action: "revoke-pair", machineId: HUB, peer: BOX, edgeEpoch: "edge-new" }, new AbortController().signal);
  expect(await registry.get("pair-live")).toMatchObject({ state: "revoked", cleanupReason: "intercom-revocation-unconfirmed" });
  expect(f.broker.closed).toBe(0);
}, 5000);

it("private setup and authenticated revocation serialize across the machine boundary", async () => {
  const { main } = await import("../cli"), { requestHelperRevoke } = await import("../intercom-helper");
  const { scenario, cleanupPairScenarios } = await import("./intercom-pair-fixture");
  const registryApi = await import("../intercom-registry"), { createIntercomRegistry } = registryApi;
  const pair = await scenario(), f = machineFixture(BOX), local = pair.locals.get(BOX)!;
  const clients = new Set<Socket>(), broker = new FakeBroker();
  const config = parseConfig(JSON.parse(readFileSync(join(local.root, "roam", "config.json"), "utf8")));
  const service = await makeMachine({ ...f.options, root: local.root, config, broker });
  let release!: () => void, entered!: () => void, arrived!: () => void;
  const gate = new Promise<void>(resolveGate => { release = resolveGate; }), ready = new Promise<void>(resolveReady => { entered = resolveReady; });
  const received = new Promise<void>(resolveReceived => { arrived = resolveReceived; }), events: string[] = [];
  const server = createServer(socket => {
    clients.add(socket); socket.on("error", () => {}); socket.once("close", () => clients.delete(socket));
    socket.on("data", createMessageReader(value => {
      const message = value as Record<string, unknown>;
      if (message.type === "health") writeMessage(socket, { type: "health_ok", requestId: message.requestId, protocol: "pi-intercom", version: 1, features: [HELPER_EXCHANGE_FEATURE] });
      else if (message.type === "helper_register") {
        const route = JSON.parse(readFileSync(join(local.root, "roam", "intercom", "helper.json"), "utf8"));
        expect(message.token).toBe(route.token);
        writeMessage(socket, { type: "helper_registered", requestId: message.requestId });
      } else if (message.type === "helper_exchange") {
        const task = broker.helper!(withHopRequest(message.input), new AbortController().signal);
        void task.then(output => { events.push("fenced"); writeMessage(socket, { type: "helper_result", requestId: message.requestId, output }); }, () => socket.destroy());
      }
    }, () => socket.destroy()));
  });
  let setup: Promise<number> | undefined, revoke: ReturnType<typeof requestHelperRevoke> | undefined;
  let restoreLockProbe: (() => void) | undefined;
  try {
    const provisioned = await provisionPair();
    expect(provisioned.code, JSON.stringify(provisioned)).toBe(0);
    mkdirSync(join(f.agentDir, "intercom"), { mode: 0o700 });
    server.listen(join(f.agentDir, "intercom", "broker.sock")); await once(server, "listening"); chmodSync(join(f.agentDir, "intercom", "broker.sock"), 0o600);
    await service.start();
    const record = (await createIntercomRegistry(local.root).get("pair-1"))!;
    const approval = { approved: true, actor: "fixture", at: 1000, operationId: record.operationId, graphDigest: record.graphDigest, pairs: pair.request.pairs };
    const lock = registryApi.withIntercomPeerLock; let attempts = 0;
    const lockProbe = vi.spyOn(registryApi, "withIntercomPeerLock").mockImplementation(<T>(root: string, first: string, second: string, work: () => Promise<T>) => {
      const revoking = ++attempts === 2;
      const task = lock(root, first, second, async () => { if (revoking) events.push("revocation-started"); return work(); });
      if (revoking) arrived();
      return task;
    });
    restoreLockProbe = () => lockProbe.mockRestore();
    const run = local.run;
    local.run = async (argv, options) => {
      if (argv[0] === "/fixture/connector") { entered(); await gate; events.push("enrolled"); }
      return run(argv, options);
    };
    let output = "";
    setup = main(["--global-root", local.root, "roam", "intercom", "setup-local"], { out: text => { output += text; }, err: () => {} },
      { stdin: Buffer.from(JSON.stringify({ action: "check-connector", pair: record.pair, approval })), pairPorts: local });
    await ready;
    revoke = requestHelperRevoke(local.root, { version: 1, action: "revoke-pair", machineId: BOX, peer: OTHER, edgeEpoch: "edge-1" });
    await received;
    expect(events).toEqual([]); expect(pair.queues.get(BOX)!.pairFence(OTHER)).toBeNull();
    release(); expect(await setup).toBe(0); expect(JSON.parse(output)).toMatchObject({ ok: true });
    expect(await revoke).toMatchObject({ edgeEpoch: "edge-1", exchanges: "closed", inFlight: 0 });
    expect(events).toEqual(["enrolled", "revocation-started", "fenced"]);
    expect(await createIntercomRegistry(local.root).get("pair-1")).toMatchObject({ state: "revoked", cleanupReason: "intercom-revocation-unconfirmed" });
    output = "";
    await main(["--global-root", local.root, "roam", "intercom", "setup-local"], { out: text => { output += text; }, err: () => {} },
      { stdin: Buffer.from(JSON.stringify({ action: "check-connector", pair: record.pair, approval })), pairPorts: local });
    expect(JSON.parse(output)).toMatchObject({ ok: false, reason: "revocation-pending" }); expect(events).toEqual(["enrolled", "revocation-started", "fenced"]);
  } finally {
    release?.(); await Promise.allSettled([setup, revoke]); restoreLockProbe?.(); await service.stop();
    for (const socket of clients) socket.destroy(); if (server.listening) await new Promise<void>(done => server.close(() => done()));
    cleanupPairScenarios();
  }
  async function provisionPair() { const { provisionIntercomEnrollment } = await import("../intercom-enrollment"); return provisionIntercomEnrollment(pair.request, pair.enrollment); }
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
    writeLocal(f.global.db, "observed-origin", JSON.stringify([from.sessionId, BOX]), { id: from.sessionId, origin: BOX });
    const request = helperRequest(BOX, HUB, "edge-1", 1, [remote(BOX, "box.invalid", from)]);
    const reply = await f.broker.helper!(withHopRequest({ ...request, exchange: { ...request.exchange, frames: [frame] } }), new AbortController().signal);
    expect(reply).toMatchObject({ exchange: { acknowledgements: [{ identity: { id: "departed-id" } }] } });
    expect(f.broker.deliveries).toEqual([]);
    await f.broker.helper!(withHopRequest(helperRequest(BOX, HUB, "edge-1", 2)), new AbortController().signal);
    expect(f.broker.published.at(-1)).toEqual([]);
    f.broker.emit("presence", [localPresence(to, "recipient-generation")]);
    expect(f.broker.deliveries).toMatchObject([{ from: { address: from, machineId: BOX }, message: { id: "departed-id" } }]);
    f.broker.bridge!.receipt(to, { messageId: "departed-id", status: "injected", timestamp: 1000,
      evidence: { kind: "entry", entryId: "entry-1", sessionId: to.sessionId, activationEpoch: "recipient-generation" } });
    const poll = helperRequest(BOX, HUB, "edge-1", 1); poll.exchange.generation.channel = "poll";
    const result = await f.broker.helper!(withHopRequest(poll), new AbortController().signal) as { exchange: { receipts: Array<Parameters<typeof source.settleReceipt>[0]["frame"]> } };
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
    const rejected = await f.broker.helper!(withHopRequest({ ...request, exchange: { ...request.exchange, frames: [{ ...frame, originMachineId: OTHER }] } }), new AbortController().signal);
    expect(rejected).toMatchObject({ exchange: { refusals: [{ identity: frame.identity, reason: "sender-unauthorized" }],
      acknowledgements: [{ identity: frame.identity, kind: "message" }] } });
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

it("the service-owned helper fences one live pair without restarting or affecting another", async () => {
  const f = machineFixture(), first = peer(BOX, "box-1.invalid"), second = peer(OTHER, "box-2.invalid");
  const config = parseConfig({ enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, coreUnit: "fixture",
    intercom: { enabled: true, mode: "peers", machineAlias: "hub.invalid", routes: [
      { kind: "direct", peer: first, edgeEpoch: "edge-1" }, { kind: "direct", peer: second, edgeEpoch: "edge-2" },
    ] } });
  const service = await makeMachine({ ...f.options, config }); await service.start();
  const signal = new AbortController().signal;
  await expect(f.broker.helper!({ version: 1, action: "revoke-pair", machineId: OTHER, peer: BOX, edgeEpoch: "edge-1" }, signal)).rejects.toMatchObject({ code: "machine-mismatch" });
  await expect(f.broker.helper!({ version: 1, action: "revoke-pair", machineId: HUB, peer: BOX, edgeEpoch: "edge-1", extra: true }, signal)).rejects.toMatchObject({ code: "invalid-request" });
  expect(await f.broker.helper!(withHopRequest(helperRequest(BOX, HUB, "edge-1", 1)), signal)).toMatchObject({ exchange: { senderMachine: HUB } });
  const fenceId = "00000000-0000-4000-8000-000000000004";
  const proof = await f.broker.helper!({ version: 1, action: "revoke-pair", machineId: HUB, peer: BOX, edgeEpoch: "edge-1", fenceId }, signal);
  expect(proof).toMatchObject({ machineId: HUB, peer: BOX, edgeEpoch: "edge-1", fenceId, exchanges: "closed", inFlight: 0 });
  expect(await f.broker.helper!({ version: 1, action: "inspect-fence", machineId: HUB, peer: BOX }, signal))
    .toEqual({ machineId: HUB, peer: BOX, fence: { edgeEpoch: "edge-1", fenceId } });
  expect(await f.broker.helper!({ version: 1, action: "inspect-fence", machineId: HUB, peer: OTHER }, signal))
    .toEqual({ machineId: HUB, peer: OTHER, fence: null });
  await expect(f.broker.helper!(withHopRequest(helperRequest(BOX, HUB, "edge-1", 1)), signal)).rejects.toMatchObject({ code: "peer-revoked" });
  expect(await f.broker.helper!(withHopRequest(helperRequest(OTHER, HUB, "edge-2", 1)), signal)).toMatchObject({ exchange: { senderMachine: HUB } });
  expect(service.readiness().state).toBe("ready"); expect(f.broker.closed).toBe(0);
}, 5000);

it("the runtime keeps a revocation notice queued when broker delivery is unconfirmed", async () => {
  const f = machineFixture(), target = peer(BOX, "box.invalid"); f.broker.noticeConfirmed = false;
  const config = parseConfig({ enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, coreUnit: "fixture",
    intercom: { enabled: true, mode: "peers", machineAlias: "hub.invalid", routes: [{ kind: "direct", peer: target, edgeEpoch: "edge-1" }] } });
  const service = await makeMachine({ ...f.options, config }); await service.start();
  const address = { sessionId: "remote-recipient", scopeId: "scope" }, origin = { sessionId: "origin", scopeId: "scope" };
  const remoteInfo = remote(BOX, "box.invalid", address), signal = new AbortController().signal;
  await f.broker.helper!(withHopRequest(helperRequest(BOX, HUB, "edge-1", 1, [remoteInfo])), signal);
  expect(await f.broker.bridge!.dispatch({ from: origin, to: remoteInfo, message: { id: "notice-unconfirmed", timestamp: 1, content: { text: "test" } } })).toMatchObject({ acceptance: { durable: true } });
  await f.broker.helper!({ version: 1, action: "revoke-pair", machineId: HUB, peer: BOX, edgeEpoch: "edge-1" }, signal);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(f.broker.receipts).toMatchObject([{ receipt: { messageId: "notice-unconfirmed", detail: "peer-revoked" } }]);
  await service.stop();
  const reopened = openIntercomStore({ file: join(f.global.root, "roam", "intercom", "queue.db"), machineId: HUB, clock: f.clock });
  try { expect(reopened.pendingRevocationNotices()).toMatchObject([{ receipt: { messageId: "notice-unconfirmed" } }]); }
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
  const reply = await f.broker.helper!(withHopRequest({ version: 1, holdMs: 0, deadlineMs: 5000, exchange: withHopExchange({ protocol: 5, senderMachine: BOX, recipientMachine: HUB,
    generation: { edgeEpoch: "edge-1", channel: "push", generation: 1 }, frames: [], acknowledgements: [], receipts: [], controls: [], presence: [] }) }), signal);
  expect(reply).toMatchObject({ version: 1, exchange: { senderMachine: HUB, recipientMachine: BOX } });
  expect(resolved).toEqual([BOX]);
}, 5000);

function helperRequest(from: string, to: string, edgeEpoch: string, generation: number, presence: RemoteSessionInfo[] = []) {
  return { version: 1, holdMs: 0, deadlineMs: 5000, exchange: withHopExchange({ protocol: 5, senderMachine: from, recipientMachine: to,
    generation: { edgeEpoch, channel: "push", generation }, frames: [], acknowledgements: [], receipts: [], controls: [], presence }) };
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
  writeLocal(f.global.db, "observed-origin", JSON.stringify([target.sessionId, OTHER]), { id: target.sessionId, origin: OTHER });
  await f.broker.helper!(withHopRequest(helperRequest(HUB, BOX, "hub-box", 1, [entry])), signal);
  expect(f.broker.published.at(-1)).toMatchObject([{ address: target, machineId: OTHER }]);
  const accepted = await f.broker.bridge!.dispatch({ from, to: entry, message: { id: "relayed-id", timestamp: 1, content: { text: "synthetic" } } });
  expect(accepted).toMatchObject({ delivery: "queued", acceptance: { durable: true } });
  await expect(f.broker.helper!(withHopRequest(helperRequest(HUB, BOX, "hub-box", 2, [{ ...entry, machineAlias: "spoof.invalid" }])), signal)).rejects.toThrow(/invalid-presence/);
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
  writeLocal(f.global.db, "observed-origin", JSON.stringify([address.sessionId, BOX]), { id: address.sessionId, origin: BOX });
  await f.broker.helper!(withHopRequest(helperRequest(BOX, HUB, "hub-box", 1, [remote(BOX, "box.invalid", address)])), signal);
  const reply = await f.broker.helper!(withHopRequest(helperRequest(OTHER, HUB, "hub-other", 1)), signal);
  expect(reply).toMatchObject({ exchange: { presence: [{ address, machineId: BOX }] } });
  await expect(f.broker.helper!(withHopRequest(helperRequest(BOX, HUB, "hub-box", 2, [remote(OTHER, "other.invalid", address)])), signal)).rejects.toThrow(/invalid-presence/);
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
  await nextBroker.helper!(withHopRequest(helperRequest(BOX, HUB, "edge-1", 1)), new AbortController().signal);
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


it("resumes a hub switch, reports an unreachable box, and advertises only its own presence", async () => {
  const f = machineFixture(), config = parseConfig({ role: "hub", machineId: HUB, hubMachineId: HUB, coreUnit: "fixture",
    intercom: { enabled: true, mode: "hub-only", machineAlias: "hub.invalid", routes: [
      { kind: "direct", peer: peer(BOX, "box.invalid"), edgeEpoch: "hub-box" },
      { kind: "direct", peer: peer(OTHER, "other.invalid"), edgeEpoch: "hub-other" },
    ] } });
  const id = "00000000-0000-4000-8000-000000000004", signal = new AbortController().signal;
  const queue = () => openIntercomStore({ file: join(f.global.root, "roam", "intercom", "queue.db"), machineId: HUB, clock: f.clock });
  const initial = queue(); initial.startTopologyTransition({ transitionId: id, from: "hub-only", to: "peers", boxes: [BOX, OTHER] }); initial.close();
  let service = await makeMachine({ ...f.options, config }); await service.start();
  const address = { sessionId: "box-session", scopeId: "scope" };
  const first = await f.broker.helper!(withHopRequest(helperRequest(BOX, HUB, "hub-box", 1, [remote(BOX, "box.invalid", address)])), signal);
  expect(first).toMatchObject({ exchange: { topology: { transitionId: id, action: "switch" }, presence: [] } });
  const ack = { ...helperRequest(BOX, HUB, "hub-box", 2), exchange: { ...helperRequest(BOX, HUB, "hub-box", 2).exchange,
    topology: { transitionId: id, action: "switched" } } };
  await f.broker.helper!(withHopRequest(ack), signal);
  expect(service.diagnostics().some(item => item.reason === `intercom-transition-pending ${OTHER}`)).toBe(true);
  await service.stop();
  const resumedBroker = new FakeBroker(); service = await makeMachine({ ...f.options, config, broker: resumedBroker }); await service.start();
  const second = await resumedBroker.helper!(withHopRequest(helperRequest(OTHER, HUB, "hub-other", 1)), signal);
  expect(second).toMatchObject({ exchange: { topology: { transitionId: id, action: "switch" }, presence: [] } });
  const otherAck = { ...helperRequest(OTHER, HUB, "hub-other", 2), exchange: { ...helperRequest(OTHER, HUB, "hub-other", 2).exchange,
    topology: { transitionId: id, action: "switched" } } };
  await resumedBroker.helper!(withHopRequest(otherAck), signal);
  const final = await resumedBroker.helper!(withHopRequest(helperRequest(BOX, HUB, "hub-box", 3, [remote(BOX, "box.invalid", address)])), signal);
  expect(final).toMatchObject({ exchange: { presence: [] } });
  expect(service.diagnostics().some(item => item.reason.startsWith("intercom-transition-pending"))).toBe(false);
  await service.stop(); const stored = queue();
  try { expect(stored.topology()).toMatchObject({ mode: "peers", transition: { state: "complete", boxes: { [BOX]: "switched", [OTHER]: "switched" } } }); }
  finally { stored.close(); }
}, 5000);

it("applies only the enrolled hub's switch and keeps relay presence and origins fail-closed afterwards", async () => {
  const f = machineFixture(BOX), config = parseConfig({ role: "box", machineId: BOX, hubMachineId: HUB, coreUnit: "fixture",
    intercom: { enabled: true, mode: "hub-only", machineAlias: "box.invalid", routes: [
      { kind: "direct", peer: peer(HUB, "hub.invalid"), edgeEpoch: "hub-box" },
      { kind: "relay", peer: peer(OTHER, "other.invalid"), via: HUB },
    ] } });
  const service = await makeMachine({ ...f.options, config }); await service.start();
  const id = "00000000-0000-4000-8000-000000000004", signal = new AbortController().signal;
  const request = { ...helperRequest(HUB, BOX, "hub-box", 1), exchange: { ...helperRequest(HUB, BOX, "hub-box", 1).exchange,
    topology: { transitionId: id, action: "switch" } } };
  expect(await f.broker.helper!(request, signal)).toMatchObject({ exchange: { topology: { transitionId: id, action: "switched" } } });
  const target = { sessionId: "remote-recipient", scopeId: "scope" };
  await expect(f.broker.helper!(withHopRequest(helperRequest(HUB, BOX, "hub-box", 2, [remote(OTHER, "other.invalid", target)])), signal)).rejects.toThrow("invalid-presence");
  await service.stop();
  const stored = openIntercomStore({ file: join(f.global.root, "roam", "intercom", "queue.db"), machineId: BOX, clock: f.clock });
  try { expect(stored.topology()).toMatchObject({ mode: "peers", switched: id }); } finally { stored.close(); }
}, 5000);


it("refuses an unapproved local request to activate the topology transition", async () => {
  const f = machineFixture(), config = parseConfig({ ...f.options.config, intercom: { ...f.options.config.intercom, mode: "hub-only" } });
  const service = await makeMachine({ ...f.options, config }); await service.start();
  await expect(f.broker.helper!({ version: 1, action: "transition-topology", machineId: HUB,
    transitionId: "00000000-0000-4000-8000-000000000004", operationId: "unapproved", graphDigest: "a".repeat(64), from: "hub-only", to: "peers" }, new AbortController().signal))
    .rejects.toThrow("peer-consent-required");
}, 5000);


it("the original running sessions send and receive after first-home presence is refreshed", async () => {
  const f = machineFixture(), service = await makeMachine(f.options); await service.start();
  const addresses = [{ sessionId: "first-origin", scopeId: null }, { sessionId: "second-origin", scopeId: null }];
  const presence = (homeEpoch: number | null) => addresses.map((address, i) => ({ address, homeEpoch, activationEpoch: `original-generation-${i}`,
    cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1, status: "idle" }));
  f.broker.emit("presence", presence(null));
  for (const address of addresses) f.global.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES(?,?,1,NULL,1)").run(address.sessionId, HUB);
  f.broker.emit("presence", presence(1));
  for (const [i, j] of [[0, 1], [1, 0]]) {
    const result = await f.broker.bridge!.dispatch({ from: addresses[i], to: { ...destination(addresses[j]), homeEpoch: 1, activationEpoch: `original-generation-${j}` },
      message: { id: `after-first-home-${i}`, timestamp: 1, content: { text: "synthetic" } } });
    expect(result.acceptance).toMatchObject({ accepted: true, durable: true });
  }
  await vi.waitFor(() => expect(f.broker.deliveries).toHaveLength(2));
  expect(f.broker.deliveries.map(row => row.to)).toMatchObject([
    { address: addresses[1], homeEpoch: 1, activationEpoch: "original-generation-1" },
    { address: addresses[0], homeEpoch: 1, activationEpoch: "original-generation-0" },
  ]);
}, 5000);

it.each(["different-machine", "epoch-bump"] as const)("keeps stale-home-epoch for %s on an original registration", async mode => {
  const f = machineFixture(), service = await makeMachine(f.options); await service.start();
  const to = { sessionId: "original-before-home-change", scopeId: null };
  f.global.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES(?,?,?,NULL,1)")
    .run(to.sessionId, mode === "different-machine" ? BOX : HUB, mode === "epoch-bump" ? 2 : 1);
  const result = await f.broker.bridge!.dispatch({ from: { sessionId: "sender", scopeId: null }, to: { ...destination(to), homeEpoch: 1 },
    message: { id: `must-refuse-${mode}`, timestamp: 1, content: { text: "synthetic" } } });
  expect(result).toMatchObject({ reason: "stale-home-epoch", acceptance: { accepted: false, durable: false } });
  expect(f.broker.deliveries).toEqual([]);
}, 5000);

it.each(["session", "origin", "adoption", "generation", "box-origin", "version", "location-home", "past-home"])("keeps an offline session's durable %s ownership from being claimed by another box", async kind => {
  const { writeLocal } = await import("@spider/db-core/roam/local-state");
  const f = machineFixture(), target = peer(BOX, "box.invalid"), address = { sessionId: "offline-owner", scopeId: "scope" };
  if (kind === "session") {
    const project = createReplica("worktree", HUB); replicas.push(project);
    project.db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES(?,1,?)").run(address.sessionId, HUB);
    f.global.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES (?,?,?,1,1)").run("offline-project", project.root, project.db.raw.name);
  } else if (kind === "origin") writeLocal(f.global.db, "observed-origin", JSON.stringify([address.sessionId,HUB]), { id: address.sessionId, origin: HUB });
  else if (kind === "adoption") writeLocal(f.global.db, "intercom-first-home", JSON.stringify([address.sessionId,"old",HUB]),
    { sessionId: address.sessionId, activation: "old", machine: HUB, fromEpoch: null, toEpoch: 1, adoptedAt: 1 });
  else if (kind === "generation") recordIntercomGeneration(f.global.db, { sessionId: address.sessionId, generation: "offline", pid: 12345 }, () => ({ kind: "live", startIdentity: "offline-process" }));
  else if (kind === "box-origin") writeLocal(f.global.db, "participant-origin", address.sessionId, { kind: "box-local", machineId: OTHER });
  else if (kind === "version") f.global.db.prepare("INSERT INTO roam_versions(entity,row_key,change_id,hlc_ms,hlc_count,origin_machine,origin_stream,deleted) VALUES('sessions',?,'change',1,0,?,'stream',1)").run(address.sessionId, HUB);
  else if (kind === "location-home") f.global.db.prepare("INSERT INTO roam_locations(session_id,stores_json,home_json) VALUES(?,'[]',?)").run(address.sessionId, JSON.stringify({ machineId: HUB, epoch: 1 }));
  else f.global.db.prepare("INSERT INTO roam_home_actions(move_id,session_id,expected_epoch,args_digest,committed_home_json) VALUES('move',?,1,'digest',?)").run(address.sessionId, JSON.stringify({ machineId: HUB, epoch: 1 }));
  const config = parseConfig({ ...f.options.config, peers: [target], intercom: { enabled: true, mode: "peers", machineAlias: "hub.invalid", routes: [{ kind: "direct", peer: target, edgeEpoch: "edge-1" }] } });
  const service = await makeMachine({ ...f.options, config }); await service.start();
  const entry = { ...remote(BOX, "box.invalid", address), homeEpoch: null };
  await f.broker.helper!(withHopRequest(helperRequest(BOX, HUB, "edge-1", 1, [entry])), new AbortController().signal);
  expect(f.broker.published.at(-1)).toEqual([]);
  expect(service.diagnostics()).toContainEqual(expect.objectContaining({ reason: kind === 'session' || kind === 'origin'
    ? "intercom-presence-origin-mismatch" : "intercom-presence-ambiguous" }));
}, 5000);

it("repairs a switched source copy when its approved direct pair is enrolled later", async () => {
  const f = machineFixture(BOX), target = peer(OTHER, "other.invalid"), source = { ...peer(BOX, "box.invalid"), globalRoot: f.global.root };
  const config = parseConfig({ role: "box", machineId: BOX, hubMachineId: HUB, coreUnit: "fixture", intercom: { enabled: true, mode: "hub-only", machineAlias: source.alias,
    routes: [{ kind: "direct", peer: peer(HUB, "hub.invalid"), edgeEpoch: "hub-box" }, { kind: "relay", peer: target, via: HUB }] } });
  const file = join(f.global.root, "roam", "intercom", "queue.db"), queue = openIntercomStore({ file, machineId: BOX, mode: "hub-only", clock: f.clock });
  const transitionId = "00000000-0000-4000-8000-000000000004", from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
  queue.acceptOutbound({ from, endpoint: { address: to, machineId: OTHER, homeEpoch: null, activationEpoch: "recipient" }, nextHop: HUB,
    message: { id: "waiting-for-route", timestamp: 1, content: { text: "x" } } });
  queue.switchTopology({ transitionId, hubMachineId: HUB, directPeers: [] }); queue.close();
  mkdirSync(join(f.global.root, "roam"), { recursive: true, mode: 0o700 });
  writeFileSync(join(f.global.root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(f.global.root, "roam", "machine.json"), JSON.stringify({ machineId: BOX }), { mode: 0o600 });
  const key = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]);
  const pair = { pairId: "pair-later", source, target, connector: { tunnelId: "tunnel", remotePort: 22, session: "session" }, edgeEpoch: "new-edge", sshUser: "fixture",
    hostKey: { type: "ssh-ed25519", base64: key.toString("base64") }, hostKeyAlias: `spider-${"a".repeat(32)}` };
  const { createIntercomRegistry } = await import("../intercom-registry"), { persistIntercomPairRoute } = await import("../provision-config");
  const registry = createIntercomRegistry(f.global.root), digest = "a".repeat(64);
  await registry.register(pair, "approval", digest); await registry.bind(pair, "approval"); await persistIntercomPairRoute(f.global.root, pair, "approval", digest);
  const service = await makeMachine({ ...f.options, config, async pairScopedHostReady() { return true; } }); await service.start();
  await f.broker.helper!({ version: 1, action: "enroll-pair", machineId: BOX, peer: OTHER, pairId: pair.pairId, edgeEpoch: pair.edgeEpoch,
    operationId: "approval", graphDigest: digest, expectedFenceId: null }, new AbortController().signal);
  const stored = openIntercomStore({ file, machineId: BOX, clock: f.clock });
  try {
    expect(stored.retained("outbound", "waiting-for-route")).toMatchObject({ peer: OTHER, originMachineId: BOX, identity: { sequence: 1 } });
    expect(stored.topologyAudit()).toMatchObject([{ id: "waiting-for-route", transitionId, oldNextHop: HUB, newNextHop: OTHER }]);
    expect(stored.hasPending(HUB)).toBe(false);
  } finally { stored.close(); }
}, 5000);


it.each([[HUB, false], [HUB, true], [OTHER, false], [OTHER, true]] as const)(
  'refuses non-origin homeless claims without poisoning production discovery (%s, disconnected %s)', async (receiver, disconnected) => {
    const f = machineFixture(receiver), owner = receiver === HUB ? BOX : HUB, attacker = receiver === HUB ? OTHER : BOX;
    const aliases = new Map([[HUB, 'hub.invalid'], [BOX, 'box.invalid'], [OTHER, 'other.invalid']]);
    const address = { sessionId: 'homeless-owner', scopeId: 'scope' };
    const config = parseConfig({ role: receiver === HUB ? 'hub' : 'box', machineId: receiver, hubMachineId: HUB, coreUnit: 'fixture.service',
      intercom: { enabled: true, mode: 'peers', machineAlias: aliases.get(receiver)!,
        routes: [owner, attacker].map(id => ({ kind: 'direct', peer: peer(id, aliases.get(id)!), edgeEpoch: 'edge-1' })) } });
    writeLocal(f.global.db, 'observed-origin', JSON.stringify([address.sessionId, owner]), { id: address.sessionId, origin: owner });
    const service = await makeMachine({ ...f.options, config }); await service.start();
    const signal = new AbortController().signal;
    if (!disconnected) await f.broker.helper!(withHopRequest(helperRequest(owner, receiver, 'edge-1', 1, [remote(owner, aliases.get(owner)!, address)])), signal);
    await f.broker.helper!(withHopRequest(helperRequest(attacker, receiver, 'edge-1', 1, [remote(attacker, aliases.get(attacker)!, address)])), signal);
    const stored = openIntercomStore({ file: join(f.global.root, 'roam', 'intercom', 'queue.db'), machineId: receiver, clock: f.clock });
    try {
      expect(stored.presenceOwner(address)).toEqual(disconnected ? null : { machineId: owner, activation: 'recipient-generation', ambiguous: false });
    } finally { stored.close(); }
    expect(service.diagnostics()).toContainEqual(expect.objectContaining({ reason: 'intercom-presence-origin-mismatch' }));
    await f.broker.helper!(withHopRequest(helperRequest(owner, receiver, 'edge-1', 2, [remote(owner, aliases.get(owner)!, address)])), signal);
    expect(f.broker.published.at(-1)).toMatchObject([{ address, machineId: owner }]);
  }, 5000);

it.each(["observed-origin", "session-row"])("requires a synced %s before publishing homeless remote presence", async kind => {
  const { writeLocal } = await import("@spider/db-core/roam/local-state");
  const f = machineFixture(), target = peer(BOX, "box.invalid"), address = { sessionId: "synced-origin", scopeId: "scope" };
  const config = parseConfig({ ...f.options.config, peers: [target], intercom: { enabled: true, mode: "peers", machineAlias: "hub.invalid",
    routes: [{ kind: "direct", peer: target, edgeEpoch: "edge-1" }] } });
  const service = await makeMachine({ ...f.options, config }); await service.start();
  const signal = new AbortController().signal;
  await f.broker.helper!(withHopRequest(helperRequest(BOX, HUB, "edge-1", 1, [remote(BOX, "box.invalid", address)])), signal);
  expect(f.broker.published.at(-1)).toEqual([]);
  expect(service.diagnostics()).toContainEqual(expect.objectContaining({ reason: "intercom-presence-origin-unknown" }));
  if (kind === "observed-origin") {
    writeLocal(f.global.db, "observed-origin", JSON.stringify([address.sessionId, BOX]), { id: address.sessionId, origin: BOX });
  } else {
    const replica = createReplica("worktree", BOX); replicas.push(replica);
    replica.db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES(?,1,?)").run(address.sessionId, BOX);
    f.global.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES (?,?,?,1,1)")
      .run("synced-project", replica.root, replica.db.raw.name);
  }
  await f.broker.helper!(withHopRequest(helperRequest(BOX, HUB, "edge-1", 2, [remote(BOX, "box.invalid", address)])), signal);
  expect(f.broker.published.at(-1)).toMatchObject([{ address, machineId: BOX }]);
}, 5000);

it("settlement refuses an injected-looking retained row with no dispatch attempt", async () => {
  const f = machineFixture(); let store: ReturnType<typeof openIntercomStore> | undefined;
  const service = await makeMachine({ ...f.options, recoverRevocations: async value => { store = value; } }); await service.start();
  const address = { sessionId: "recipient", scopeId: "scope" }, from = { sessionId: "sender", scopeId: "scope" };
  f.global.db.prepare("INSERT INTO session_homes VALUES (?,?,2,?,1)").run("recipient", HUB, "move-a");
  f.broker.emit("presence", [{ ...localPresence(address, "recipient-generation"), homeEpoch: 2 }]);
  const endpoint = { address, machineId: HUB, homeEpoch: 2, activationEpoch: "recipient-generation" };
  store!.acceptOutbound({ from, endpoint, nextHop: HUB, message: { id: "settlement-a", timestamp: 1000, content: { text: "synthetic" } } });
  const retained = store!.retained("outbound", "settlement-a")!;
  vi.spyOn(store!, "retained").mockImplementation((direction, id) => direction === "outbound" && id === "settlement-a" ? { ...retained, payloadRetained: false, state: "injected", latestAttempt: 0 } : null);
  expect(await service.move.settlement({ messageId: "settlement-a", fromSessionId: "sender", toSessionId: "recipient", scopeId: "scope" })).toBeNull();
}, 5000);
