import { createHopFixture } from "./intercom-hop-fixture";
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { scratchDbPath } from "@spider/db-core/testutil";
import { openDb } from "@spider/db-core";
import type { Home } from "@spider/db-core/roam/types";
import type { RemoteSessionInfo, SessionAddress } from "@spider/intercom/protocol";
import { createIntercomBridge, type BridgePorts } from "../intercom-bridge";
import { openIntercomStore } from "../intercom-store";
import { makeMessageFrame } from "../intercom-codec";
import type { IntercomExchange, IntercomReceiptFrame, IntercomWireFrame } from "../intercom-contracts";

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
  const generations = new Map<string, number>(), hops = createHopFixture();
  const send = async (machine: string, presence: RemoteSessionInfo[] = [], frames: IntercomExchange["frames"] = [], extra: Partial<IntercomExchange> = {}) => {
    const n = (generations.get(machine) ?? 0) + 1; generations.set(machine, n);
    return bridge.exchange(hops({ version: 1, holdMs: 0, deadlineMs: 5000, exchange: { protocol: 5, senderMachine: machine, recipientMachine: H,
      generation: { edgeEpoch: "edge", channel: "push", generation: n }, frames, acknowledgements: [], receipts: [], controls: [], presence, ...extra } }));
  };
  const frame = (origin: string, id: string, sequence = 1, from = victim) => makeMessageFrame({ from,
    endpoint: { address: target, machineId: H, homeEpoch: null, activationEpoch: "recipient" }, sequence, originMachineId: origin,
    message: { id, timestamp: 1, content: { text: "synthetic" } } });
  return { homes, origins, inbound, frame, send, file, get store() { return store; }, get bridge() { return bridge; }, get published() { return published; },
    async restart(limits?: { queueMessages: number }) { await bridge.stop(); store.close(); store = openIntercomStore({ file, machineId: H, clock, limits }); bridge = make(); await bridge.start(); } };
}
function receiveHop(file: string, frames: readonly IntercomWireFrame[]) {
  const store = openIntercomStore({ file: `${file}.receiver`, machineId: C, clock: { now: () => 1000 } });
  resources.push(async () => store.close()); store.openHop(H, 'edge');
  for (const frame of frames) store.acceptInbound({ peer: H, frame, hop: { edgeEpoch: 'edge', sequence: frame.hopSequence } });
  return store;
}

function consumeHop(store: ReturnType<typeof openIntercomStore>, frame: IntercomWireFrame) {
  const dispatched = store.beginDispatch({ id: frame.identity.id, endpoint: frame.endpoint, readiness: `${frame.identity.id}-ready` });
  store.settleReceipt({ queue: 'inbound', peer: H, frame: { from: frame.endpoint, to: frame.identity.from, digest: frame.identity.digest,
    originMachineId: frame.originMachineId, sequence: frame.identity.sequence, attempt: 1,
    receipt: { messageId: frame.identity.id, status: 'injected', timestamp: 1000,
      evidence: { kind: 'entry', entryId: `${frame.identity.id}-entry`, sessionId: target.sessionId, activationEpoch: frame.endpoint.activationEpoch } } } });
  return dispatched.message;
}

it.each([false, true])('propagates a retried relay receipt after an interrupted settlement (%s)', async interrupted => {
  const f = await fixture(), original = f.frame(B, 'relayed');
  const message = { ...original, endpoint: { ...original.endpoint, machineId: C } };
  expect((await f.send(B, [info(B)], [message])).exchange.refusals ?? []).toEqual([]);
  const sent = f.store.pending({ kind: 'outbound', peer: C, edgeEpoch: 'edge', hopBudgetMs: 100 })[0];
  expect(sent.identity).toEqual(message.identity);
  await f.send(C, [], [], { acknowledgements: [{ identity: sent.identity, hopSequence: sent.identity.sequence, kind: 'message' }] });
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

it('continues relaying after refusing a departed sender without retaining the refused frame', async () => {
  const f = await fixture(), endpoint = { ...f.frame(B, 'unused').endpoint, machineId: C };
  const first = { ...f.frame(B, 'departed', 1), endpoint };
  expect((await f.send(B, [], [first])).exchange.refusals).toContainEqual({ identity: first.identity, hopSequence: first.identity.sequence, reason: 'sender-unauthorized' });
  expect(f.store.retained('inbound', 'departed')).toBeNull();
  expect(f.store.retained('outbound', 'departed')).toBeNull();
  await f.restart();
  const later = ['returned', 'successor'].map((id, i) => ({ ...f.frame(B, id, i + 2), endpoint }));
  expect((await f.send(B, [info(B)], later)).exchange.refusals ?? []).toEqual([]);
  const forwarded = f.store.pending({ kind: 'outbound', peer: C, edgeEpoch: 'edge', hopBudgetMs: 100 });
  expect(forwarded.map(frame => [frame.identity.id, frame.hopSequence, frame.identity.sequence])).toEqual([['returned', 1, 2], ['successor', 2, 3]]);
  const recipient = receiveHop(f.file, forwarded);
  expect(recipient.pending({ kind: 'inbound', address: target }).map(message => message.id)).toEqual(['returned']);
  consumeHop(recipient, forwarded[0]);
  expect(recipient.pending({ kind: 'inbound', address: target }).map(message => message.id)).toEqual(['successor']);
  expect(recipient.retained('inbound', 'departed')).toBeNull();
}, 5000);

it('never masks accepted relay identity with a refused reused id and deduplicates the accepted resend', async () => {
  const f = await fixture(), endpoint = { ...f.frame(B, 'unused').endpoint, machineId: C };
  const original = { ...f.frame(B, 'accepted', 1), endpoint };
  await f.send(B, [info(B)], [original]);
  const conflict = makeMessageFrame({ from: victim, endpoint, sequence: 2, originMachineId: B,
    message: { id: 'accepted', timestamp: 2, content: { text: 'rejected content' } } });
  expect((await f.send(B, [info(B)], [conflict])).exchange.refusals).toContainEqual({ identity: conflict.identity, hopSequence: conflict.identity.sequence, reason: 'store-rejected' });
  expect(f.store.retained('inbound', 'accepted')?.identity).toEqual(original.identity);
  expect(f.store.retained('outbound', 'accepted')?.identity).toEqual(original.identity);
  await f.restart();
  expect((await f.send(B, [info(B)], [original])).exchange.refusals ?? []).toEqual([]);
  const successor = { ...f.frame(B, 'after-conflict', 3), endpoint };
  expect((await f.send(B, [info(B)], [successor])).exchange.refusals ?? []).toEqual([]);
  const forwarded = f.store.pending({ kind: 'outbound', peer: C, edgeEpoch: 'edge', hopBudgetMs: 100 });
  expect(forwarded.map(frame => frame.identity)).toEqual([original.identity, successor.identity]);
  const recipient = receiveHop(f.file, forwarded);
  expect(recipient.retained('inbound', 'accepted')?.identity).toEqual(original.identity);
  const delivered = forwarded.map(frame => consumeHop(recipient, frame));
  expect(delivered.map(message => [message.id, message.content?.text])).toEqual([['accepted', 'synthetic'], ['after-conflict', 'synthetic']]);
}, 5000);

it('rolls back relay inbox admission when forwarding cannot commit', async () => {
  const f = await fixture(), endpoint = { ...f.frame(B, 'unused').endpoint, machineId: C };
  const db = openDb(f.file);
  try {
    db.exec("CREATE TRIGGER fail_forward BEFORE INSERT ON intercom_copies WHEN NEW.direction='outbound' BEGIN SELECT RAISE(ABORT,'forward unavailable'); END");
    const original = { ...f.frame(B, 'failed-forward', 1), endpoint };
    expect((await f.send(B, [info(B)], [original])).exchange.refusals).toContainEqual({ identity: original.identity, hopSequence: original.identity.sequence, reason: 'store-rejected' });
    expect(f.store.retained('inbound', 'failed-forward')).toBeNull();
    expect(f.store.retained('outbound', 'failed-forward')).toBeNull();
    db.exec('DROP TRIGGER fail_forward');
    expect((await f.send(B, [info(B)], [{ ...f.frame(B, 'after-failed-forward', 2), endpoint }])).exchange.refusals ?? []).toEqual([]);
  } finally { db.close(); }
}, 5000);

it('rolls back relay inbox and hop admission on quota refusal and accepts the same slot after capacity returns', async () => {
  const f = await fixture(), endpoint = { ...f.frame(B, 'unused').endpoint, machineId: C };
  await f.send(B, [info(B)], [{ ...f.frame(B, 'existing', 1), endpoint }]);
  await f.restart({ queueMessages: 3 });
  const frame = { ...f.frame(B, 'backpressure', 2), endpoint }, refused = await f.send(B, [info(B)], [frame]);
  expect(f.store.retained('inbound', frame.identity.id)).toBeNull();
  expect(f.store.retained('outbound', frame.identity.id)).toBeNull();
  expect(refused.exchange.refusals).toContainEqual({ identity: frame.identity, hopSequence: 2, reason: 'queue-full' });
  expect(refused.exchange.acknowledgements).toEqual([]);
  await f.restart({ queueMessages: 4 });
  expect((await f.send(B, [info(B)], [frame])).exchange.refusals ?? []).toEqual([]);
  expect(f.store.retained('inbound', frame.identity.id)).toMatchObject({ state: 'queued', payloadRetained: true });
  expect(f.store.retained('outbound', frame.identity.id)).toMatchObject({ state: 'queued', payloadRetained: true });
}, 5000);

it('relays a successor after its previously revoked next hop is re-enrolled', async () => {
  const f = await fixture(); await f.bridge.revokePair(C, 'edge');
  const endpoint = { ...f.frame(B, 'unused').endpoint, machineId: C }, first = { ...f.frame(B, 'revoked-relay', 1), endpoint };
  expect((await f.send(B, [info(B)], [first])).exchange.refusals).toContainEqual({ identity: first.identity, hopSequence: first.identity.sequence, reason: 'peer-revoked' });
  const fence = f.store.pairFence(C)!;
  await f.bridge.enrollPair({ peer: peer(C), edgeEpoch: 'new-edge', initiator: false },
    { operationId: 'relay-re-enroll', graphDigest: 'a'.repeat(64), expectedFenceId: fence.fenceId, edgeEpoch: 'new-edge' });
  const second = { ...f.frame(B, 'reenrolled-successor', 2), endpoint };
  expect((await f.send(B, [info(B)], [second])).exchange.refusals ?? []).toEqual([]);
  expect(f.store.retained('outbound', 'reenrolled-successor')).toMatchObject({ peer: C });
}, 5000);

it('starts a fresh relay hop after re-enrollment while retaining the prior unknown outcome', async () => {
  const f = await fixture(), endpoint = { ...f.frame(B, 'unused').endpoint, machineId: C };
  const old = { ...f.frame(B, 'uncertain-old', 1), endpoint }; await f.send(B, [info(B)], [old]);
  f.store.pending({ kind: 'outbound', peer: C, edgeEpoch: 'edge', hopBudgetMs: 100 });
  const receipt: IntercomReceiptFrame = { from: endpoint, to: victim, digest: old.identity.digest, originMachineId: B, sequence: 1, attempt: 1,
    receipt: { messageId: old.identity.id, status: 'unknown', timestamp: 1000 } };
  f.store.settleReceipt({ queue: 'outbound', peer: C, frame: receipt });
  await f.bridge.revokePair(C, 'edge'); const fence = f.store.pairFence(C)!;
  await f.bridge.enrollPair({ peer: peer(C), edgeEpoch: 'fresh', initiator: false },
    { operationId: 'fresh-hop', graphDigest: 'a'.repeat(64), expectedFenceId: fence.fenceId, edgeEpoch: 'fresh' });
  const next = { ...f.frame(B, 'fresh-message', 2), endpoint };
  expect((await f.send(B, [info(B)], [next])).exchange.refusals ?? []).toEqual([]);
  const reply = await f.send(C, [], [], { generation: { edgeEpoch: 'fresh', channel: 'poll', generation: 1 } });
  expect(reply.exchange.streamStart).toEqual({ after: 0 });
  expect(reply.exchange.frames.map(frame => [frame.identity.id, frame.hopSequence, frame.kind])).toEqual([
    ['uncertain-old', 1, 'tombstone'], ['fresh-message', 2, 'message'],
  ]);
  expect(f.store.inspectBlockers(victim).unknownOutcomes).toEqual(['uncertain-old']);
  expect(f.store.retained('outbound', 'uncertain-old')?.state).toBe('cancelled');
}, 5000);

it('refuses missing physical starts and prior wire formats by name on every retry', async () => {
  const f = await fixture();
  for (const generation of [1, 2]) {
    const request = { version: 1, holdMs: 0, deadlineMs: 5000, exchange: { protocol: 5, senderMachine: B, recipientMachine: H,
      generation: { edgeEpoch: 'edge', channel: 'push', generation }, frames: [], acknowledgements: [], receipts: [], controls: [], presence: [] } };
    await expect(f.bridge.exchange(request)).rejects.toMatchObject({ code: 'hop-stream-missing', retryable: true });
    await expect(f.bridge.exchange({ ...request, exchange: { ...request.exchange, streamStart: { after: 0 },
      frames: [f.frame(B, 'no-hop')], presence: [info(B)] } })).rejects.toMatchObject({ code: 'hop-stream-missing', retryable: true });
    expect(f.store.retained('inbound', 'no-hop')).toBeNull();
    await expect(f.bridge.exchange({ ...request, exchange: { ...request.exchange, protocol: 4 } })).rejects.toMatchObject({ code: 'peer-version-mismatch', retryable: true });
  }
  const gap = { ...f.frame(B, 'gap', 10), hopSequence: 2 };
  const raw = { version: 1, holdMs: 0, deadlineMs: 5000, exchange: { protocol: 5, senderMachine: B, recipientMachine: H,
    generation: { edgeEpoch: 'edge', channel: 'push', generation: 3 }, streamStart: { after: 0 },
    frames: [gap], acknowledgements: [], receipts: [], controls: [], presence: [info(B)] } };
  await expect(f.bridge.exchange({ ...raw, exchange: { ...raw.exchange, protocol: 4, frames: [] } })).rejects.toMatchObject({ code: 'peer-version-mismatch', retryable: true });
  const reply = await f.bridge.exchange(raw);
  expect(reply.exchange.refusals).toEqual([{ identity: gap.identity, hopSequence: 2, reason: 'hop-sequence-gap' }]);
  expect(reply.exchange.acknowledgements).toEqual([]);
  expect(f.store.retained('inbound', 'gap')).toBeNull();
  const valid = { ...f.frame(B, 'first-physical', 12), hopSequence: 1 };
  expect((await f.bridge.exchange({ ...raw, exchange: { ...raw.exchange, generation: { ...raw.exchange.generation, generation: 4 }, frames: [valid] } })).exchange.refusals ?? []).toEqual([]);
  expect(f.store.retained('inbound', 'first-physical')?.identity).toEqual(valid.identity);
}, 5000);

it("rejects a box naming a local sender and acknowledges that frame without blocking valid mail", async () => {
  const f = await fixture({ localPresence: () => [info(H)] });
  const legitimate = { sessionId: "box-owner", scopeId: "scope" }, forged = f.frame(B, "forged"), valid = f.frame(B, "valid", 1, legitimate);
  const reply = await f.send(B, [info(B, legitimate)], [forged, valid]);
  expect(reply.exchange.refusals).toContainEqual({ identity: forged.identity, hopSequence: forged.identity.sequence, reason: "sender-unauthorized" });
  expect(reply.exchange.acknowledgements.map(ack => ack.identity.id)).toEqual(["forged", "valid"]);
  expect(f.inbound).toEqual(["valid"]);
  expect(f.store.retained("inbound", "forged")).toBeNull();
  expect(f.bridge.diagnostics()).toContainEqual(expect.objectContaining({ reason: "intercom-sender-unauthorized" }));
}, 5000);
it("authenticates the sender against its assigned home even without current presence", async () => {
  const f = await fixture(); f.homes.set(victim.sessionId, { sessionId: victim.sessionId, machineId: C, epoch: 2, moveId: null, updatedAt: 1 });
  const forged = f.frame(B, "forged"), valid = f.frame(C, "real");
  expect((await f.send(B, [], [forged])).exchange.refusals).toContainEqual({ identity: forged.identity, hopSequence: forged.identity.sequence, reason: "sender-unauthorized" });
  expect((await f.send(C, [], [valid])).exchange.acknowledgements).toContainEqual({ identity: valid.identity, hopSequence: valid.identity.sequence, kind: "message" });
  expect(f.inbound).toEqual(["real"]);
}, 5000);
it("records and isolates store errors per frame rather than aborting the link", async () => {
  const f = await fixture(), first = f.frame(B, "same-id"), other = { sessionId: "other", scopeId: "scope" };
  await f.send(B, [info(B)], [first]);
  const conflicting = makeMessageFrame({ from: victim, endpoint: first.endpoint, sequence: 2, originMachineId: B,
    message: { id: "same-id", timestamp: 2, content: { text: "changed" } } });
  const valid = f.frame(B, "other-pair", 1, other);
  const reply = await f.send(B, [info(B), info(B, other)], [conflicting, valid]);
  expect(reply.exchange.refusals).toContainEqual({ identity: conflicting.identity, hopSequence: conflicting.identity.sequence, reason: "store-rejected" });
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
  expect(refused.exchange.refusals).toEqual([{ identity: first.identity, hopSequence: first.identity.sequence, reason: "sender-unauthorized" }]);
  expect(refused.exchange.acknowledgements).toContainEqual({ identity: first.identity, hopSequence: first.identity.sequence, kind: "message" });
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
  expect((await f.send(B, [], [first])).exchange.refusals).toContainEqual({ identity: first.identity, hopSequence: first.identity.sequence, reason: "sender-unauthorized" });
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
  expect(refused.exchange.refusals).toEqual([{ identity: conflict.identity, hopSequence: conflict.identity.sequence, reason: "store-rejected" }]);
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
  expect(refused.exchange.refusals).toEqual([{ identity: first.identity, hopSequence: first.identity.sequence, reason: "peer-revoked" }]);
  expect(refused.exchange.acknowledgements).toContainEqual({ identity: first.identity, hopSequence: first.identity.sequence, kind: "message" });
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
  expect(reply.exchange.refusals).toEqual([{ identity: missing.identity, hopSequence: missing.identity.sequence, reason: "missing-origin" }]);
  expect(reply.exchange.acknowledgements).toContainEqual({ identity: good.identity, hopSequence: good.identity.sequence, kind: "message" });
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
