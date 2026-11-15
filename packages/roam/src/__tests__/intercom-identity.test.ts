import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { scratchDbPath } from "@spider/db-core/testutil";
import type { Home } from "@spider/db-core/roam/types";
import type { RemoteSessionInfo, SessionAddress } from "@spider/intercom/protocol";
import { createIntercomBridge, type BridgePorts } from "../intercom-bridge";
import { openIntercomStore } from "../intercom-store";
import { makeMessageFrame } from "../intercom-codec";
import type { IntercomExchange, IntercomReceiptFrame } from "../intercom-contracts";

const B = "00000000-0000-4000-8000-000000000001", H = "00000000-0000-4000-8000-000000000002", C = "00000000-0000-4000-8000-000000000003";
const victim = { sessionId: "owner", scopeId: "scope" }, target = { sessionId: "recipient", scopeId: "scope" };
const peer = (machineId: string) => ({ machineId, alias: `peer-${machineId.slice(-1)}.invalid`, node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/core", globalRoot: "/fixture/global" });
const info = (machineId: string, address = victim, homeEpoch: number | null = null): RemoteSessionInfo => ({ remote: true, id: address.sessionId, address, machineId,
  machineAlias: peer(machineId).alias, homeEpoch, activationEpoch: "activation", endpointEpoch: "activation", cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1 });
const resources: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of resources.splice(0).reverse()) await cleanup(); });
async function fixture(overrides: Partial<BridgePorts> = {}) {
  const root = mkdtempSync(join(dirname(scratchDbPath("roam-intercom")), "identity-")); resources.push(() => rmSync(root, { force: true, recursive: true }));
  const clock = { now: () => 1000, later: () => () => {} }, file = join(root, "q.db");
  let store = openIntercomStore({ file, machineId: H, clock });
  const homes = new Map<string, Home>(), origins = new Map<string, string>(), inbound: string[] = []; let published: RemoteSessionInfo[] = [];
  const make = () => createIntercomBridge({ machineId: H, machineAlias: "hub.invalid", store, clock,
    edges: [B, C].map(id => ({ peer: peer(id), edgeEpoch: "edge", initiator: false })),
    transport: { resolve: async () => { throw new Error("offline"); }, exec: async () => { throw new Error("offline"); } } as never,
    localPresence: () => [], authoritativeHome: address => homes.get(address.sessionId) ?? null,
    sessionOrigin: address => origins.get(address.sessionId) ?? B,
    publishPresence: entries => { published = [...entries]; }, onInbound: entry => inbound.push(entry.id), ...overrides });
  let bridge = make(); resources.push(async () => { await bridge.stop(); store.close(); }); await bridge.start();
  const generations = new Map<string, number>();
  const send = async (machine: string, presence: RemoteSessionInfo[] = [], frames: IntercomExchange["frames"] = [], extra: Partial<IntercomExchange> = {}) => {
    const n = (generations.get(machine) ?? 0) + 1; generations.set(machine, n);
    return bridge.exchange({ version: 1, holdMs: 0, deadlineMs: 5000, exchange: { protocol: 4, senderMachine: machine, recipientMachine: H,
      generation: { edgeEpoch: "edge", channel: "push", generation: n }, frames, acknowledgements: [], receipts: [], controls: [], presence, ...extra } });
  };
  const frame = (origin: string, id: string, sequence = 1, from = victim) => makeMessageFrame({ from,
    endpoint: { address: target, machineId: H, homeEpoch: null, activationEpoch: "recipient" }, sequence, originMachineId: origin,
    message: { id, timestamp: 1, content: { text: "synthetic" } } });
  return { homes, origins, inbound, frame, send, get store() { return store; }, get bridge() { return bridge; }, get published() { return published; },
    async restart() { await bridge.stop(); store.close(); store = openIntercomStore({ file, machineId: H, clock }); bridge = make(); await bridge.start(); } };
}
it.each([false, true])('propagates a retried relay receipt after an interrupted settlement (%s)', async interrupted => {
  const f = await fixture(), original = f.frame(B, 'relayed');
  const message = { ...original, endpoint: { ...original.endpoint, machineId: C } };
  expect((await f.send(B, [info(B)], [message])).exchange.refusals ?? []).toEqual([]);
  const sent = f.store.pending({ kind: 'outbound', peer: C, hopBudgetMs: 100 })[0];
  expect(sent.identity).toEqual(message.identity);
  await f.send(C, [], [], { acknowledgements: [{ identity: sent.identity, kind: 'message' }] });
  const receipt: IntercomReceiptFrame = { from: message.endpoint, to: victim, digest: message.identity.digest,
    originMachineId: B, sequence: 1, attempt: 1, receipt: { messageId: 'relayed', status: 'injected', timestamp: 1000,
      evidence: { kind: 'entry', entryId: 'relayed-entry', sessionId: target.sessionId, activationEpoch: 'recipient' } } };
  if (interrupted) {
    f.store.settleReceipt({ queue: 'outbound', peer: C, frame: receipt });
    await f.restart();
  }
  expect((await f.send(C, [], [], { receipts: [receipt] })).exchange.receiptAcknowledgements).toEqual([receipt]);
  expect(f.store.retained('inbound', 'relayed')?.state).toBe('injected');
  expect(f.store.pending({ kind: 'receipts', peer: B })).toContainEqual(receipt);
}, 5000);

it("rejects a box naming a local sender and acknowledges that frame without blocking valid mail", async () => {
  const f = await fixture({ localPresence: () => [info(H)] });
  const legitimate = { sessionId: "box-owner", scopeId: "scope" }, forged = f.frame(B, "forged"), valid = f.frame(B, "valid", 1, legitimate);
  const reply = await f.send(B, [info(B, legitimate)], [forged, valid]);
  expect(reply.exchange.refusals).toContainEqual({ identity: forged.identity, reason: "sender-unauthorized" });
  expect(reply.exchange.acknowledgements.map(ack => ack.identity.id)).toEqual(["forged", "valid"]);
  expect(f.inbound).toEqual(["valid"]);
  expect(f.store.retained("inbound", "forged")).toBeNull();
  expect(f.bridge.diagnostics()).toContainEqual(expect.objectContaining({ reason: "intercom-sender-unauthorized" }));
}, 5000);
it("authenticates the sender against its assigned home even without current presence", async () => {
  const f = await fixture(); f.homes.set(victim.sessionId, { sessionId: victim.sessionId, machineId: C, epoch: 2, moveId: null, updatedAt: 1 });
  const forged = f.frame(B, "forged"), valid = f.frame(C, "real");
  expect((await f.send(B, [], [forged])).exchange.refusals).toContainEqual({ identity: forged.identity, reason: "sender-unauthorized" });
  expect((await f.send(C, [], [valid])).exchange.acknowledgements).toContainEqual({ identity: valid.identity, kind: "message" });
  expect(f.inbound).toEqual(["real"]);
}, 5000);
it("records and isolates store errors per frame rather than aborting the link", async () => {
  const f = await fixture(), first = f.frame(B, "same-id"), other = { sessionId: "other", scopeId: "scope" };
  await f.send(B, [info(B)], [first]);
  const conflicting = makeMessageFrame({ from: victim, endpoint: first.endpoint, sequence: 2, originMachineId: B,
    message: { id: "same-id", timestamp: 2, content: { text: "changed" } } });
  const valid = f.frame(B, "other-pair", 1, other);
  const reply = await f.send(B, [info(B), info(B, other)], [conflicting, valid]);
  expect(reply.exchange.refusals).toContainEqual({ identity: conflicting.identity, reason: "store-rejected" });
  expect(reply.exchange.acknowledgements.map(ack => ack.identity.id)).toEqual(["same-id", "other-pair"]);
  expect(f.inbound).toEqual(["same-id", "other-pair"]);
  expect(f.bridge.diagnostics()).toContainEqual(expect.objectContaining({ reason: "intercom-store-rejected" }));
}, 5000);
it("accepts a sender moving from the hub to a box and back without cursor collisions", async () => {
  const f = await fixture(), endpoint = f.frame(B, "unused").endpoint;
  f.store.acceptLocal({ from: victim, endpoint, message: { id: "hub-first", timestamp: 1, content: { text: "x" } } });
  f.homes.set(victim.sessionId, { sessionId: victim.sessionId, machineId: B, epoch: 1, moveId: null, updatedAt: 1 });
  await f.send(B, [info(B, victim, 1)], [f.frame(B, "box-second")]);
  f.homes.set(victim.sessionId, { sessionId: victim.sessionId, machineId: H, epoch: 2, moveId: "returned", updatedAt: 2 });
  expect(f.store.acceptLocal({ from: victim, endpoint, message: { id: "hub-third", timestamp: 3, content: { text: "z" } } })).toMatchObject({ kind: "accepted", identity: { sequence: 2 } });
  expect(f.inbound).toEqual(["box-second"]);
}, 5000);
it.each(["wrong-machine", "wrong-epoch"])("rejects presence with %s against the assigned home", async mode => {
  const f = await fixture(); f.homes.set(victim.sessionId, { sessionId: victim.sessionId, machineId: C, epoch: 2, moveId: null, updatedAt: 1 });
  await f.send(mode === "wrong-machine" ? B : C, [info(mode === "wrong-machine" ? B : C, victim, mode === "wrong-machine" ? 2 : 999)]);
  expect(f.published).toEqual([]);
  expect(f.bridge.diagnostics()).toContainEqual(expect.objectContaining({ reason: "intercom-presence-home-mismatch" }));
}, 5000);
it("does not let a home-less claim displace the hub's live local session", async () => {
  const f = await fixture({ localPresence: () => [info(H)] });
  await f.send(B, [info(B)]);
  expect(f.store.presenceOwner(victim)).toMatchObject({ ambiguous: true });
  expect(await f.bridge.dispatch({ from: target, to: info(B), message: { id: "local-must-not-leak", timestamp: 1, content: { text: "x" } } }))
    .toMatchObject({ delivery: "failed", reason: "presence-ambiguous" });
  expect(f.store.retained("outbound", "local-must-not-leak")).toBeNull();
  expect(f.published).toEqual([]);
  expect(f.bridge.diagnostics()).toContainEqual(expect.objectContaining({ reason: "intercom-presence-ambiguous" }));
}, 5000);
it.each([H, C])("refuses a home-less claim when durable session records name %s", async owner => {
  const f = await fixture({ knownSessionMachines: () => [owner] });
  await f.send(B, [info(B)]);
  expect(f.published).toEqual([]);
  expect(f.bridge.diagnostics()).toContainEqual(expect.objectContaining({ reason: "intercom-presence-ambiguous" }));
}, 5000);
it("preserves the first null-epoch owner when another machine contradicts its synced origin after restart", async () => {
  const f = await fixture(); f.origins.set(victim.sessionId, C); await f.send(C, [info(C)]);
  expect(f.published).toMatchObject([{ address: victim, machineId: C }]);
  await f.send(C); await f.restart();
  await f.send(B, [info(B)]);
  expect(f.store.presenceOwner(victim)).toEqual({ machineId: C, activation: 'activation', ambiguous: false });
  expect(f.published).toEqual([]);
  const result = await f.bridge.dispatch({ from: target, to: info(B), message: { id: "do-not-route", timestamp: 1, content: { text: "x" } } });
  expect(result).toMatchObject({ delivery: "failed", reason: "presence-ambiguous", outcomeKnown: true });
  expect(f.store.retained("outbound", "do-not-route")).toBeNull();
  expect(f.bridge.diagnostics()).toContainEqual(expect.objectContaining({ reason: "intercom-presence-origin-mismatch" }));
}, 5000);
it("rejects a non-null epoch with no authoritative home rather than trusting its size", async () => {
  const f = await fixture(); await f.send(B, [info(B, victim, 999)]);
  expect(f.published).toEqual([]);
}, 5000);

it("queues the first post-adoption send using durable authenticated presence while its edge is down", async () => {
  const f = await fixture(), after = { ...info(B, victim, 1), firstHome: { activation: "activation", fromEpoch: null, toEpoch: 1 } };
  f.store.acceptOutbound({ from: target, endpoint: { address: victim, machineId: B, homeEpoch: null, activationEpoch: "activation" }, nextHop: B,
    message: { id: "before-adoption", timestamp: 1, content: { text: "x" } } });
  f.homes.set(victim.sessionId, { sessionId: victim.sessionId, machineId: B, epoch: 1, moveId: null, updatedAt: 1 });
  await f.send(B, [after]);
  f.store.updateEdgeState(B, "edge", state => ({ ...state, status: "recovering", reason: "helper-unauthorized", outageSince: 1000 }));
  expect(await f.bridge.dispatch({ from: target, to: after, message: { id: "after-adoption", timestamp: 2, content: { text: "y" } } }))
    .toMatchObject({ delivery: "queued", acceptance: { durable: true } });
  expect(f.store.retained("outbound", "after-adoption")).toMatchObject({ identity: { sequence: 2 } });
}, 5000);

it("retains the first accepted activation when the same machine advertises a later activation", async () => {
  const f = await fixture(); await f.send(B, [info(B)]);
  await f.send(B, [{ ...info(B), activationEpoch: "later", endpointEpoch: "later" }]); await f.restart();
  expect(f.store.presenceOwner(victim)).toEqual({ machineId: B, activation: "activation", ambiguous: false });
  expect(f.published).toMatchObject([{ activationEpoch: "later" }]);
}, 5000);
it("refuses two concurrent null-epoch activations for the same address even on one machine", async () => {
  const f = await fixture();
  await f.send(B, [info(B), { ...info(B), activationEpoch: "other", endpointEpoch: "other" }]);
  expect(f.published).toEqual([]);
  expect(f.store.presenceOwner(victim)).toMatchObject({ ambiguous: true });
  expect(f.bridge.diagnostics()).toContainEqual(expect.objectContaining({ reason: "intercom-presence-ambiguous" }));
}, 5000);
it("rechecks cached presence against offline durable owners before publishing after restart", async () => {
  const owners: string[] = [], f = await fixture({ knownSessionMachines: () => owners });
  f.store.updateEdgeState(B, "edge", old => ({ ...old, roster: [info(B)] }));
  owners.push(H); await f.restart();
  expect(f.published).toEqual([]);
  expect(f.store.presenceOwner(victim)).toMatchObject({ machineId: H, ambiguous: true });
  expect(f.bridge.diagnostics()).toContainEqual(expect.objectContaining({ reason: "intercom-presence-ambiguous" }));
}, 5000);

it("delivers later mail when a homeless sender exited before its first presence arrived", async () => {
  const f = await fixture(), first = f.frame(B, "departed", 1);
  const refused = await f.send(B, [], [first]);
  expect(refused.exchange.refusals).toEqual([{ identity: first.identity, reason: "sender-unauthorized" }]);
  expect(refused.exchange.acknowledgements).toContainEqual({ identity: first.identity, kind: "message" });
  await f.restart();
  const second = f.frame(B, "returned", 2), third = f.frame(B, "next", 3);
  const reply = await f.send(B, [info(B)], [second, third]);
  expect(reply.exchange.refusals ?? []).toEqual([]);
  expect(f.inbound).toEqual(["returned", "next"]);
}, 5000);

it("delivers successors after a lagging sender home catches up", async () => {
  const f = await fixture();
  f.homes.set(victim.sessionId, { sessionId: victim.sessionId, machineId: C, epoch: 1, moveId: null, updatedAt: 1 });
  const first = f.frame(B, "lagging", 1);
  expect((await f.send(B, [], [first])).exchange.refusals).toContainEqual({ identity: first.identity, reason: "sender-unauthorized" });
  f.homes.set(victim.sessionId, { sessionId: victim.sessionId, machineId: B, epoch: 2, moveId: "move", updatedAt: 2 });
  const reply = await f.send(B, [info(B, victim, 2)], [f.frame(B, "caught-up", 2), f.frame(B, "later", 3)]);
  expect(reply.exchange.refusals ?? []).toEqual([]);
  expect(f.inbound).toEqual(["caught-up", "later"]);
}, 5000);

it("consumes a store-rejected slot without replacing the accepted message with the same id", async () => {
  const f = await fixture(), first = f.frame(B, "original", 1);
  await f.send(B, [info(B)], [first]);
  const conflict = makeMessageFrame({ from: victim, endpoint: first.endpoint, sequence: 2, originMachineId: B,
    message: { id: "original", timestamp: 2, content: { text: "conflict" } } });
  const refused = await f.send(B, [info(B)], [conflict]);
  expect(refused.exchange.refusals).toEqual([{ identity: conflict.identity, reason: "store-rejected" }]);
  await f.restart();
  expect((await f.send(B, [info(B)], [f.frame(B, "successor", 3)])).exchange.refusals ?? []).toEqual([]);
  expect(f.inbound).toEqual(["original", "successor"]);
  expect(f.store.retained("inbound", "original")?.identity).toEqual(first.identity);
}, 5000);

it("acknowledges a revoked next-hop slot and delivers successors after enrollment and recipient return", async () => {
  const f = await fixture();
  await f.bridge.revokePair(C, "edge");
  const first = { ...f.frame(B, "revoked", 1), endpoint: { ...f.frame(B, "unused").endpoint, machineId: C } };
  const refused = await f.send(B, [info(B)], [first]);
  expect(refused.exchange.refusals).toEqual([{ identity: first.identity, reason: "peer-revoked" }]);
  expect(refused.exchange.acknowledgements).toContainEqual({ identity: first.identity, kind: "message" });
  const fence = f.store.pairFence(C)!;
  await f.bridge.enrollPair({ peer: peer(C), edgeEpoch: "new-edge", initiator: false },
    { operationId: "re-enroll", graphDigest: "a".repeat(64), expectedFenceId: fence.fenceId, edgeEpoch: "new-edge" });
  await f.restart();
  expect((await f.send(B, [info(B)], [f.frame(B, "returned-recipient", 2)])).exchange.refusals ?? []).toEqual([]);
  expect(f.inbound).toEqual(["returned-recipient"]);
}, 5000);

it("isolates a missing-origin slot in the middle of an authenticated sender stream", async () => {
  const f = await fixture(); await f.send(B, [info(B)], [f.frame(B, "before", 1)]);
  const { originMachineId: _origin, ...missing } = f.frame(B, "bad-middle", 2), good = f.frame(B, "after", 3);
  const reply = await f.send(B, [info(B)], [missing as never, good]);
  expect(reply.exchange.refusals).toEqual([{ identity: missing.identity, reason: "missing-origin" }]);
  expect(reply.exchange.acknowledgements).toContainEqual({ identity: good.identity, kind: "message" });
  expect(f.inbound).toEqual(["before", "after"]);
}, 5000);


it("does not inject an acknowledged refused frame replayed after its sender returns", async () => {
  const f = await fixture(), refused = f.frame(B, "refused-replay", 1);
  await f.send(B, [], [refused]); await f.restart();
  await f.send(B, [info(B)], [refused]);
  expect(f.inbound).toEqual([]);
  expect(f.store.retained("inbound", "refused-replay")).toBeNull();
  await f.send(B, [info(B)], [f.frame(B, "successor-after-replay", 2)]);
  expect(f.inbound).toEqual(["successor-after-replay"]);
}, 5000);
