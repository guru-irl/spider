import { withHopRequest } from "./intercom-hop-fixture";
import { withHopExchange } from "./intercom-hop-fixture";
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { scratchDbPath } from "@spider/db-core/testutil";
import type { RemoteSessionInfo, SessionAddress } from "@spider/intercom/protocol";
import { createIntercomBridge, type BridgePorts } from "../intercom-bridge";
import { openIntercomStore } from "../intercom-store";
import { makeMessageFrame } from "../intercom-codec";
import type { IntercomExchange } from "../intercom-contracts";

const B = "00000000-0000-4000-8000-000000000001", H = "00000000-0000-4000-8000-000000000002", C = "00000000-0000-4000-8000-000000000003";
const address = { sessionId: "new-session", scopeId: "scope" }, target = { sessionId: "recipient", scopeId: "scope" };
const peer = (machineId: string) => ({ machineId, alias: `peer-${machineId.slice(-1)}.invalid`, node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/core", globalRoot: "/fixture/global" });
const presence: RemoteSessionInfo = { remote: true, id: address.sessionId, address, machineId: B, machineAlias: peer(B).alias,
  homeEpoch: null, activationEpoch: "activation", endpointEpoch: "activation", cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1 };
const resources: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of resources.splice(0).reverse()) await cleanup(); });

async function fixture(machineId = H) {
  const root = mkdtempSync(join(dirname(scratchDbPath("roam-intercom")), "homeless-presence-"));
  resources.push(() => rmSync(root, { force: true, recursive: true }));
  const clock = { now: () => 1000, later: () => () => {} }, file = join(root, "queue.db");
  let store = openIntercomStore({ file, machineId, clock });
  const origins = new Map<string, string>(), inbound: string[] = [];
  let published: readonly RemoteSessionInfo[] = [];
  const ports = (): BridgePorts => ({ machineId, machineAlias: "receiver.invalid", store, clock,
    edges: [B, H, C].filter(id => id !== machineId).map(id => ({ peer: peer(id), edgeEpoch: "edge", initiator: false })),
    transport: { resolve: async () => { throw new Error("offline"); }, exec: async () => { throw new Error("offline"); } } as never,
    localPresence: () => [], authoritativeHome: () => null,
    sessionOrigin: (address: SessionAddress) => origins.get(address.sessionId) ?? null,
    publishPresence: entries => { published = entries; }, onInbound: entry => inbound.push(entry.id) });
  let bridge = createIntercomBridge(ports()); resources.push(async () => { await bridge.stop(); store.close(); }); await bridge.start();
  let generation = 0;
  const send = (entries: RemoteSessionInfo[] = [presence], frames: IntercomExchange["frames"] = [], channel: "push" | "poll" = "push") => bridge.exchange(withHopRequest({ version: 1, holdMs: 0, deadlineMs: 5000,
    exchange: withHopExchange({ protocol: 5, senderMachine: B, recipientMachine: machineId, generation: { edgeEpoch: "edge", channel, generation: ++generation },
      presence: entries, frames, acknowledgements: [], receipts: [], controls: [] }) }));
  const frame = (id: string, sequence: number) => makeMessageFrame({ from: address,
    endpoint: { address: target, machineId, homeEpoch: null, activationEpoch: "recipient" }, sequence, originMachineId: B,
    message: { id, timestamp: 1, content: { text: "synthetic" } } });
  return { origins, send, frame, inbound, get store() { return store; }, get bridge() { return bridge; }, get published() { return published; },
    async restart() { await bridge.stop(); store.close(); store = openIntercomStore({ file, machineId, clock }); bridge = createIntercomBridge(ports()); await bridge.start(); } };
}

it.each([H, C])("refuses an unknown homeless claim at %s until its origin syncs", async machineId => {
  const f = await fixture(machineId), first = f.frame("before-sync", 1);
  const refused = await f.send([presence], [first]);
  expect(f.published).toEqual([]);
  expect(f.store.presenceOwner(address)).toBeNull();
  expect(f.bridge.diagnostics()).toContainEqual(expect.objectContaining({ reason: "intercom-presence-origin-unknown" }));
  expect(refused.exchange.refusals).toContainEqual({ identity: first.identity, reason: "sender-unauthorized" , hopSequence: first.identity.sequence });
  f.origins.set(address.sessionId, B);
  expect((await f.send([presence], [f.frame("after-sync", 2)])).exchange.refusals ?? []).toEqual([]);
  expect(f.published).toMatchObject([{ address, machineId: B }]);
  expect(f.inbound).toEqual(["after-sync"]);
}, 5000);

it("refuses a homeless claim whose synced origin names another machine", async () => {
  const f = await fixture(C); f.origins.set(address.sessionId, H);
  await f.send();
  expect(f.published).toEqual([]);
  expect(f.store.presenceOwner(address)).toBeNull();
  expect(f.bridge.diagnostics()).toContainEqual(expect.objectContaining({ reason: "intercom-presence-origin-mismatch" }));
}, 5000);

it("keeps unknown homeless claims unreachable while the hub link is down", async () => {
  const f = await fixture(C);
  f.store.updateEdgeState(H, "edge", state => ({ ...state, status: "down", reason: "cli-timeout", outageSince: 1000 }));
  await f.send();
  expect(f.store.edgeState(H, "edge").status).toBe("down");
  expect(f.published).toEqual([]);
  expect(f.store.presenceOwner(address)).toBeNull();
  f.origins.set(address.sessionId, B); await f.send();
  expect(f.published).toMatchObject([{ address, machineId: B }]);
  expect(f.store.edgeState(H, "edge").status).toBe("down");
}, 5000);

it("rechecks the synced origin of cached homeless presence after restart", async () => {
  const f = await fixture(); f.origins.set(address.sessionId, B); await f.send();
  expect(f.published).toHaveLength(1);
  f.origins.clear(); await f.restart();
  expect(f.published).toEqual([]);
  expect(f.bridge.diagnostics()).toContainEqual(expect.objectContaining({ reason: "intercom-presence-origin-unknown" }));
}, 5000);

it("admits a known sender from a poll without publishing its roster", async () => {
  const f = await fixture(); f.origins.set(address.sessionId, B);
  const other = { ...presence, id: "other-session", address: { sessionId: "other-session", scopeId: "scope" } };
  f.origins.set(other.id, B);
  const message = f.frame("first-from-poll", 1);
  const reply = await f.send([presence, other], [message], "poll");
  expect(reply.exchange.refusals ?? []).toEqual([]);
  expect(f.inbound).toEqual(["first-from-poll"]);
  expect(f.store.retained("inbound", "first-from-poll")).toMatchObject({ state: "queued", payloadRetained: true });
  expect(f.store.presenceOwner(other.address)).toBeNull();
  expect(f.published).toEqual([]);
});

it("refuses an unknown sender in a poll", async () => {
  const f = await fixture(), message = f.frame("unknown-from-poll", 1);
  const reply = await f.send([presence], [message], "poll");
  expect(reply.exchange.refusals).toContainEqual({ identity: message.identity, reason: "sender-unauthorized", hopSequence: message.identity.sequence });
  expect(f.inbound).toEqual([]);
  expect(f.store.presenceOwner(address)).toBeNull();
});
