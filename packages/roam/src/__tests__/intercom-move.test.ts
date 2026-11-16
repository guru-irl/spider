import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createIntercomBridge } from "../intercom-bridge";
import { openIntercomStore } from "../intercom-store";
import { ExchangeError } from "../intercom-exchange";
import { INTERCOM_FEDERATION_VERSION } from "../intercom-contracts";
import { decodeExchange, encodeExchange } from "../intercom-codec";
import type { IntercomIntakeFence, SessionEndpoint } from "@spider/intercom/protocol";
import type { Home } from "@spider/db-core/roam/types";

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
const old: SessionEndpoint = { address: to, machineId: A, homeEpoch: 2, activationEpoch: "old" };
const fence: IntercomIntakeFence = { address: to, moveId: "move-1", expectedEpoch: 2, generation: "closure-1" };
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(enabled = true, withPeer = false) {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "move-intake-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  let now = 1000;
  const clock = { now: () => now, later: () => () => {} };
  const store = openIntercomStore({ file: join(root, "queue.db"), machineId: A, clock }); cleanups.push(() => store.close());
  const injected: string[] = [];
  let committedHome: Home | undefined;
  const bridge = createIntercomBridge({ machineId: A, machineAlias: "source.invalid", edges: withPeer ? [{ peer: { machineId: B, alias: "peer.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/core", globalRoot: "/fixture/root" }, edgeEpoch: "edge", initiator: false }] : [], clock, store, moveFences: enabled,
    transport: {} as never, localPresence: () => [], authoritativeHome: address => address.sessionId === "recipient" && committedHome ? committedHome : ({ sessionId: address.sessionId, machineId: address.sessionId === "recipient" ? A : B, epoch: address.sessionId === "recipient" ? 2 : 1, moveId: null, updatedAt: now }),
    onInbound: message => injected.push(message.id) });
  cleanups.push(() => bridge.stop()); await bridge.start();
  const target = { ...old, remote: true as const, id: "recipient", endpointEpoch: "old", machineAlias: "source.invalid", name: "helper", cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1 };
  const send = (id: string, ask = false) => bridge.dispatch({ from, to: target, message: { id, timestamp: now, content: { text: "synthetic" }, ...(ask ? { expectsReply: true, remainingMs: 2000 } : {}) } });
  return { store, bridge, injected, send, tick: (ms: number) => { now += ms; }, commitHome: (home: Home) => { committedHome = home; } };
}
it("ordinary mail stays queued while frozen", async () => {
  const f = await fixture();
  expect(await f.bridge.intake!("close", fence)).toBe("closure-1");
  expect(await f.send("ordinary")).toMatchObject({ delivery: "queued", acceptance: { durable: true } });
  expect(f.injected).toEqual([]);
  expect(f.store.retained("inbound", "ordinary")).toMatchObject({ payloadRetained: true, state: "queued", endpoint: old });
  expect(f.bridge.inspectMoveBlockers(to)).toEqual({ asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] });
  expect(await f.send("late-ask", true)).toMatchObject({ delivery: "failed", reason: "intercom-frozen" });
  expect(f.store.retained("inbound", "late-ask")).toBeNull();
}, 5000);
it("proved-undispatched mail rebinds with the same id", async () => {
  const f = await fixture(); await f.bridge.intake!("close", fence); await f.send("portable-mail");
  const next = { ...old, machineId: B, homeEpoch: 3, activationEpoch: "destination" };
  f.store.rebindMoveUndispatched(to, next, { owner: { sessionId: "recipient", machineId: B, epoch: 3, moveId: "move-1", updatedAt: 1001 },
    exclusion: { owner: old, excludedGeneration: "old", kind: "generation-fenced" }, nextHop: B });
  expect(f.store.retained("outbound", "portable-mail")).toMatchObject({ identity: { id: "portable-mail", to: { sessionId: "recipient", scopeId: "scope" } }, endpoint: next, peer: B, payloadRetained: true });
  expect(f.store.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0]).toMatchObject({ identity: { id: "portable-mail" }, message: { content: { text: "synthetic" } } });
}, 5000);
it("moving a remote inbox preserves provenance across a new enrollment edge", async () => {
  const f = await fixture(true, true), root = mkdtempSync(join(resolve(".spider/scratch"), "move-origin-sequence-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const source = openIntercomStore({ file: join(root, "queue.db"), machineId: B, clock: { now: () => 1000 } });
  cleanups.push(() => source.close());
  source.acceptOutbound({ from, endpoint: old, nextHop: A, edgeEpoch: "earlier-edge",
    message: { id: "earlier-route", timestamp: 1000, content: { text: "earlier" } } });
  const earlier = source.pending({ kind: "outbound", peer: A, edgeEpoch: "earlier-edge", hopBudgetMs: 100 })[0]!;
  source.acknowledge({ peer: A, edgeEpoch: "earlier-edge", hopSequence: earlier.hopSequence, identity: earlier.identity, kind: earlier.kind });
  source.acceptOutbound({ from, endpoint: old, nextHop: A, edgeEpoch: "edge",
    message: { id: "portable-remote", timestamp: 1000, content: { text: "portable" } } });
  const incoming = source.pending({ kind: "outbound", peer: A, edgeEpoch: "edge", hopBudgetMs: 100 })[0]!;
  expect(incoming).toMatchObject({ identity: { sequence: 2 }, hopSequence: 1, originMachineId: B });
  f.store.openHop(B, "edge");
  expect(f.store.acceptInbound({ peer: B, frame: incoming, hop: { edgeEpoch: "edge", sequence: incoming.hopSequence } }).kind).toBe("accepted");
  const next = { ...old, machineId: B, homeEpoch: 3, activationEpoch: "destination" };
  f.store.rebindMoveUndispatched(to, next, { owner: { sessionId: "recipient", machineId: B, epoch: 3, moveId: "move-1", updatedAt: 1001 },
    exclusion: { owner: old, excludedGeneration: "old", kind: "generation-fenced" }, nextHop: B }, "destination-edge");
  const forwarded = f.store.pending({ kind: "outbound", peer: B, edgeEpoch: "destination-edge", hopBudgetMs: 100 });
  expect(forwarded).toEqual([expect.objectContaining({ identity: incoming.identity, endpoint: next, originMachineId: B, hopSequence: 1 })]);
  expect(f.store.retained("inbound", "portable-remote")).toMatchObject({ endpoint: next, originMachineId: B, payloadRetained: true });
  expect(f.store.retained("outbound", "portable-remote")).toMatchObject({ endpoint: next, originMachineId: B, payloadRetained: true });
  expect(f.store.acceptInbound({ peer: B, frame: incoming, hop: { edgeEpoch: "edge", sequence: incoming.hopSequence } }).kind).toBe("duplicate");
  expect(f.store.retained("inbound", "portable-remote")).toMatchObject({ endpoint: next, identity: incoming.identity });
}, 5000);

it("bridge move resumptions use the negotiated destination edge", async () => {
  const f = await fixture(true, true);
  await f.bridge.intake!("close", fence);
  await f.send("bridge-portable");
  const next = { ...old, machineId: B, homeEpoch: 3, activationEpoch: "destination" };
  const home = { sessionId: "recipient", machineId: B, epoch: 3, moveId: "move-1", updatedAt: 1001 };
  f.commitHome(home);
  const proof = { owner: home, exclusion: { owner: old, excludedGeneration: "old", kind: "generation-fenced" as const }, nextHop: B };
  expect(f.bridge.rebindMove(fence, next, proof)).toBe(1);
  expect(f.store.outboundResumptions(B, "edge")).toEqual([expect.objectContaining({ endpoint: next, proof })]);
  expect(f.store.outboundResumptions(B, "local")).toEqual([]);
}, 5000);

it.each([false, true])("bridge move refuses an unproved enrollment route, enrolled=%s", async enrolled => {
  const f = await fixture(true, enrolled);
  await f.bridge.intake!("close", fence);
  await f.send("unproved-route");
  const next = { ...old, machineId: B, homeEpoch: 3, activationEpoch: "destination" };
  const home = { sessionId: "recipient", machineId: B, epoch: 3, moveId: "move-1", updatedAt: 1001 };
  f.commitHome(home);
  const proof = { owner: home, exclusion: { owner: old, excludedGeneration: "old", kind: "generation-fenced" as const },
    nextHop: enrolled ? "00000000-0000-4000-8000-000000000003" : B };
  expect(() => f.bridge.rebindMove(fence, next, proof)).toThrow(enrolled ? "intercom-home-unproved" : "machine-not-enrolled");
  expect(f.store.retained("inbound", "unproved-route")).toMatchObject({ endpoint: old, payloadRetained: true });
  expect(f.store.retained("outbound", "unproved-route")).toMatchObject({ endpoint: old, payloadRetained: true, peer: A });
}, 5000);

it("unknown old dispatch blocks the move", async () => {
  const f = await fixture(); await f.send("unknown-mail");
  f.store.beginDispatch({ id: "unknown-mail", endpoint: old, readiness: "old-ready" });
  await f.bridge.intake!("close", fence);
  expect(f.bridge.inspectMoveBlockers(to).unknownOutcomes).toEqual(["unknown-mail"]);
  expect(() => f.store.rebindMoveUndispatched(to, { ...old, machineId: B, homeEpoch: 3, activationEpoch: "next" }, {
    owner: { sessionId: "recipient", machineId: B, epoch: 3, moveId: "move-1", updatedAt: 1001 },
    exclusion: { owner: old, excludedGeneration: "old", kind: "generation-fenced" }, nextHop: B })).toThrow();
  expect(f.store.retained("inbound", "unknown-mail")).toMatchObject({ endpoint: old, payloadRetained: true });
}, 5000);
it("closure generations refuse stale activation and rollback epochs", async () => {
  const f = await fixture(); await f.bridge.intake!("close", fence);
  expect(await f.bridge.intake!("open", { ...fence, generation: "obsolete" })).toBeNull();
  expect(await f.bridge.intake!("open", { ...fence, expectedEpoch: 1 })).toBeNull();
  expect(await f.bridge.intake!("open", { ...fence, moveId: "other-move" })).toBeNull();
  await f.send("retained"); expect(f.injected).toEqual([]);
  expect(await f.bridge.intake!("open", fence)).toBe("closure-1");
  await f.send("current"); expect(f.injected).toEqual(["current"]);
}, 5000);
it("disabled roaming has no move intake handler", async () => {
  const f = await fixture(false);
  expect(f.bridge.intake).toBeUndefined();
  expect(await f.send("local-unfenced")).toMatchObject({ delivery: "queued" });
  expect(f.injected).toEqual(["local-unfenced"]);
}, 5000);
it("frozen inspection retains expired but unsettled asks", async () => {
  const f = await fixture(); await f.send("expired-waiter", true); f.tick(10_000);
  await f.bridge.intake!("close", fence);
  expect(f.bridge.inspectMoveBlockers(to).asks).toContainEqual({ id: "expired-waiter", from, to });
  expect(f.store.retained("inbound", "expired-waiter")).toMatchObject({ payloadRetained: true });
}, 5000);

it("transport asks cannot cross closed intake while ordinary mail is retained", async () => {
  const f = await fixture(true, true), root = mkdtempSync(join(resolve(".spider/scratch"), "move-remote-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const source = openIntercomStore({ file: join(root, "queue.db"), machineId: B, clock: { now: () => 1000 } }); cleanups.push(() => source.close());
  source.acceptOutbound({ from: { sessionId: "sender-mail", scopeId: "scope" }, endpoint: old, nextHop: A, edgeEpoch: "edge", message: { id: "remote-mail", timestamp: 1000, content: { text: "synthetic" } } });
  source.acceptOutbound({ from, endpoint: old, nextHop: A, edgeEpoch: "edge", message: { id: "remote-ask", timestamp: 1000, content: { text: "synthetic" }, expectsReply: true, remainingMs: 30_000 } });
  await f.bridge.intake!("close", fence);
  const result = await f.bridge.exchange({ version: 1, holdMs: 0, deadlineMs: 5000, exchange: { protocol: INTERCOM_FEDERATION_VERSION, senderMachine: B, recipientMachine: A, streamStart: { after: 0 },
    generation: { edgeEpoch: "edge", channel: "push", generation: 1 }, frames: source.pending({ kind: "outbound", peer: A, edgeEpoch: "edge", hopBudgetMs: 100 }),
    acknowledgements: [], receipts: [], controls: [], presence: [] } });
  expect(result.exchange.refusals).toContainEqual(expect.objectContaining({ identity: expect.objectContaining({ id: "remote-ask" }), reason: "intercom-frozen" }));
  expect(result.exchange.acknowledgements.map(item => item.identity.id)).not.toContain("remote-ask");
  expect(f.store.retained("inbound", "remote-ask")).toBeNull();
  expect(f.store.retained("inbound", "remote-mail")).toMatchObject({ state: "queued", payloadRetained: true });
  expect(source.retained("outbound", "remote-ask")).toMatchObject({ payloadRetained: true });
  expect(f.injected).toEqual([]);
}, 5000);

it("frozen asks preserve authenticated hop positions for later retries", async () => {
  const f = await fixture(true, true), root = mkdtempSync(join(resolve(".spider/scratch"), "move-hop-retry-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const source = openIntercomStore({ file: join(root, "queue.db"), machineId: B, clock: { now: () => 1000 } });
  cleanups.push(() => source.close());
  source.acceptOutbound({ from, endpoint: old, nextHop: A, edgeEpoch: "edge", message: { id: "first-ask", timestamp: 1000,
    content: { text: "question" }, expectsReply: true, remainingMs: 60_000 } });
  source.acceptOutbound({ from, endpoint: old, nextHop: A, edgeEpoch: "edge", message: { id: "later-mail", timestamp: 1000, content: { text: "after question" } } });
  const exchange = (generation: number) => f.bridge.exchange({ version: 1, holdMs: 0, deadlineMs: 5000, exchange: {
    protocol: INTERCOM_FEDERATION_VERSION, senderMachine: B, recipientMachine: A, streamStart: { after: 0 },
    generation: { edgeEpoch: "edge", channel: "push", generation }, frames: source.pending({ kind: "outbound", peer: A, edgeEpoch: "edge", hopBudgetMs: 100 }),
    acknowledgements: [], receipts: [], controls: [], presence: [] } });
  await f.bridge.intake!("close", fence);
  const refused = await exchange(1);
  expect(decodeExchange(encodeExchange(refused.exchange)).refusals).toEqual(refused.exchange.refusals);
  expect(refused.exchange.refusals).toEqual([
    expect.objectContaining({ identity: expect.objectContaining({ id: "first-ask" }), hopSequence: 1, reason: "intercom-frozen" }),
    expect.objectContaining({ identity: expect.objectContaining({ id: "later-mail" }), hopSequence: 2, reason: "hop-sequence-gap" }),
  ]);
  expect(refused.exchange.acknowledgements).toEqual([]);
  expect(f.store.retained("inbound", "first-ask")).toBeNull();
  expect(f.store.retained("inbound", "later-mail")).toBeNull();
  expect(f.injected).toEqual([]);
  f.bridge.resumeIntake(fence);
  const retried = await exchange(2);
  expect(retried.exchange.acknowledgements.map(ack => [ack.identity.id, ack.hopSequence])).toEqual([["first-ask", 1], ["later-mail", 2]]);
  expect(retried.exchange.refusals ?? []).toEqual([]);
  for (const id of ["first-ask", "later-mail"]) expect(f.store.retained("inbound", id)).toMatchObject({ state: "queued", payloadRetained: true });
  for (const ack of retried.exchange.acknowledgements) source.acknowledge({ peer: A, edgeEpoch: "edge", ...ack });
  expect(source.pending({ kind: "outbound", peer: A, edgeEpoch: "edge", hopBudgetMs: 100 })).toEqual([]);
}, 5000);

it("drain waits for a started dispatch without cancelling it", async () => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "move-drain-")); cleanups.push(() => rmSync(root, { force: true, recursive: true }));
  const store = openIntercomStore({ file: join(root, "queue.db"), machineId: A, clock: { now: () => 1000 } }); cleanups.push(() => store.close());
  let release!: () => void, signalStarted!: () => void;
  const held = new Promise<void>(resolveHeld => { release = resolveHeld; }), started = new Promise<void>(resolveStarted => { signalStarted = resolveStarted; });
  const peer = { machineId: B, alias: "peer.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/core", globalRoot: "/fixture/root" };
  const bridge = createIntercomBridge({ machineId: A, machineAlias: "source.invalid", edges: [{ peer, edgeEpoch: "edge", initiator: true }], store, moveFences: true,
    clock: { now: () => 1000, later: () => () => {} }, localPresence: () => [], authoritativeHome: () => ({ sessionId: "sender", machineId: B, epoch: 1, moveId: null, updatedAt: 1000 }),
    transport: { resolve: async () => peer, exec: async () => { signalStarted(); await held; throw new ExchangeError("machine-mismatch"); } } as never });
  cleanups.push(() => bridge.stop()); await bridge.start();
  const dispatch = bridge.dispatch({ from: to, to: { remote: true, id: "sender", address: from, machineId: B, machineAlias: "peer.invalid", homeEpoch: 1,
    activationEpoch: "remote", endpointEpoch: "remote", cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1 },
    message: { id: "started-ask", timestamp: 1000, content: { text: "synthetic" }, expectsReply: true, remainingMs: 30000 } });
  await started; await bridge.intake!("close", fence);
  let drained = false;
  const drain = bridge.drainIntake(fence).then(() => { drained = true; }); await new Promise<void>(resolveTurn => setImmediate(resolveTurn));
  expect(drained).toBe(false);
  expect(bridge.inspectMoveBlockers(to).pendingDispatch).toContain("started-ask");
  release(); await dispatch; await drain;
  expect(drained).toBe(true);
}, 5000);
