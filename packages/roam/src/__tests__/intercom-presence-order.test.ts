import { paths } from "@spider/db-core";
import { FEDERATION_FEATURE, type RemoteSessionInfo } from "@spider/intercom/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createFederation } from "../../../intercom/src/broker/federation";
import type { Clock, Peer, Transport } from "../contracts";
import { createIntercomBridge } from "../intercom-bridge";
import { openIntercomStore } from "../intercom-store";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const coordinator = { sessionId: "coordinator", scopeId: null };
const helper = { sessionId: "helper", scopeId: null };
const peer = (machineId: string): Peer => ({ machineId, alias: `fixture-${machineId.slice(-1)}.invalid`,
  node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot: "/fixture/global" });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it("keeps a reloaded sender reachable when an older poll arrives after a push", async () => {
  vi.useFakeTimers();
  const root = mkdtempSync(join(paths.globalRoot, "presence-order-"));
  const clock: Clock = { now: () => Date.now(), later: (ms, fn) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } };
  const source = openIntercomStore({ file: join(root, "source", "queue.db"), machineId: A, clock });
  const inbox = openIntercomStore({ file: join(root, "inbox", "queue.db"), machineId: B, clock });
  const oldPollCaptured = deferred(), releaseOldPoll = deferred(), oldPollApplied = deferred(), newPushApplied = deferred();
  const home = (address: typeof coordinator) => ({ sessionId: address.sessionId, machineId: address.sessionId === coordinator.sessionId ? A : B,
    epoch: 1, moveId: null, updatedAt: 1 });
  const federation = createFederation({ agentDir: "/fixture/agent", locals: () => [helper], now: clock.now });
  const receiver = createIntercomBridge({ machineId: B, machineAlias: "helper.invalid", edges: [{ peer: peer(A), edgeEpoch: "edge-1", initiator: false }],
    store: inbox, clock, transport: {} as Transport, localPresence: () => [], authoritativeHome: home,
    publishPresence: entries => federation.publishPresence(entries) });
  const detach = federation.registerBridge({ feature: FEDERATION_FEATURE, agentDir: "/fixture/agent", machineId: B, machineAlias: "helper.invalid" }, receiver);
  let local: RemoteSessionInfo[] = [];
  const transport = {
    resolve: async (target: Peer) => target,
    exec: async (_target: Peer, _args: readonly string[], options: { stdinForTimeout(ms: number): Buffer; signal: AbortSignal }) => {
      const request = JSON.parse(options.stdinForTimeout(30_000).toString());
      const old = request.exchange.generation.channel === "poll";
      if (old) { oldPollCaptured.resolve(); await releaseOldPoll.promise; }
      const value = await receiver.exchange(request, options.signal);
      if (old) oldPollApplied.resolve();
      else newPushApplied.resolve();
      return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-exchange", ok: true, value }));
    },
  } as unknown as Transport;
  const sender = createIntercomBridge({ machineId: A, machineAlias: "coordinator.invalid", edges: [{ peer: peer(B), edgeEpoch: "edge-1", initiator: true }],
    store: source, clock, transport, localPresence: () => local, authoritativeHome: home });
  try {
    await receiver.start();
    await sender.start();
    await oldPollCaptured.promise;
    local = [{ remote: true, id: coordinator.sessionId, address: coordinator, machineId: A, machineAlias: "coordinator.invalid",
      homeEpoch: 1, activationEpoch: "after-reload", endpointEpoch: "after-reload", cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1 }];
    sender.wake(B);
    await newPushApplied.promise;
    expect(federation.resolve(coordinator.sessionId, null, [])).toMatchObject({ activationEpoch: "after-reload" });
    releaseOldPoll.resolve();
    await oldPollApplied.promise;
    const target = federation.resolve(coordinator.sessionId, null, []);
    expect(target).toMatchObject({ remote: true, activationEpoch: "after-reload" });
    if (!target?.remote) throw new Error("sender is missing from the roster");
    const reply = await federation.dispatch(helper, target, { id: "late-reply", replyTo: "outage-ask", timestamp: Date.now(), content: { text: "late answer" } });
    expect(reply).toMatchObject({ delivery: "queued", retryable: false, outcomeKnown: true });
    expect(Object.values(reply)).toContainEqual(expect.objectContaining({ accepted: true, durable: true }));
    expect(inbox.retained("outbound", "late-reply")).toMatchObject({ state: "queued", payloadRetained: true });
  } finally {
    releaseOldPoll.resolve();
    await sender.stop();
    await receiver.stop();
    detach();
    source.close();
    inbox.close();
    rmSync(root, { recursive: true, force: true });
    vi.useRealTimers();
  }
});

it("keeps a reloaded peer reachable when an older push response arrives after a poll", async () => {
  vi.useFakeTimers();
  const root = mkdtempSync(join(paths.globalRoot, "presence-order-"));
  const clock: Clock = { now: () => Date.now(), later: (ms, fn) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } };
  const source = openIntercomStore({ file: join(root, "source", "queue.db"), machineId: A, clock });
  const inbox = openIntercomStore({ file: join(root, "inbox", "queue.db"), machineId: B, clock });
  const pollCaptured = deferred(), releasePoll = deferred(), oldPushCaptured = deferred(), releaseOldPush = deferred();
  const newPollPublished = deferred(), oldPushApplied = deferred();
  const home = (address: typeof coordinator) => ({ sessionId: address.sessionId, machineId: address.sessionId === coordinator.sessionId ? A : B,
    epoch: 1, moveId: null, updatedAt: 1 });
  let local: RemoteSessionInfo[] = [], released = false;
  const federation = createFederation({ agentDir: "/fixture/agent", locals: () => [coordinator], now: clock.now });
  const receiver = createIntercomBridge({ machineId: B, machineAlias: "helper.invalid", edges: [{ peer: peer(A), edgeEpoch: "edge-1", initiator: false }],
    store: inbox, clock, transport: {} as Transport, localPresence: () => local, authoritativeHome: home });
  const transport = {
    resolve: async (target: Peer) => target,
    exec: async (_target: Peer, _args: readonly string[], options: { stdinForTimeout(ms: number): Buffer; signal: AbortSignal }) => {
      const request = JSON.parse(options.stdinForTimeout(30_000).toString());
      const poll = request.exchange.generation.channel === "poll";
      if (poll) { pollCaptured.resolve(); await releasePoll.promise; }
      const value = await receiver.exchange(request, options.signal);
      if (!poll) { oldPushCaptured.resolve(); await releaseOldPush.promise; }
      return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-exchange", ok: true, value }));
    },
  } as unknown as Transport;
  const sender = createIntercomBridge({ machineId: A, machineAlias: "coordinator.invalid", edges: [{ peer: peer(B), edgeEpoch: "edge-1", initiator: true }],
    store: source, clock, transport, localPresence: () => [], authoritativeHome: home,
    publishPresence(entries) {
      federation.publishPresence(entries);
      if (released) oldPushApplied.resolve();
      else if (entries.some(entry => entry.address.sessionId === helper.sessionId)) newPollPublished.resolve();
    } });
  const detach = federation.registerBridge({ feature: FEDERATION_FEATURE, agentDir: "/fixture/agent", machineId: A, machineAlias: "coordinator.invalid" }, sender);
  try {
    await receiver.start();
    await sender.start();
    await pollCaptured.promise;
    sender.wake(B);
    await oldPushCaptured.promise;
    local = [{ remote: true, id: helper.sessionId, address: helper, machineId: B, machineAlias: "helper.invalid",
      homeEpoch: 1, activationEpoch: "after-reload", endpointEpoch: "after-reload", cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1 }];
    releasePoll.resolve();
    await newPollPublished.promise;
    expect(federation.resolve(helper.sessionId, null, [])).toMatchObject({ activationEpoch: "after-reload" });
    released = true;
    releaseOldPush.resolve();
    await oldPushApplied.promise;
    const target = federation.resolve(helper.sessionId, null, []);
    expect(target).toMatchObject({ remote: true, activationEpoch: "after-reload" });
    if (!target?.remote) throw new Error("peer is missing from the roster");
    const sent = await federation.dispatch(coordinator, target, { id: "message-after-reload", timestamp: Date.now(), content: { text: "message" } });
    expect(sent).toMatchObject({ delivery: "queued", retryable: false, outcomeKnown: true });
    expect(Object.values(sent)).toContainEqual(expect.objectContaining({ accepted: true, durable: true }));
    expect(source.retained("outbound", "message-after-reload")).toMatchObject({ state: "queued", payloadRetained: true });
  } finally {
    releasePoll.resolve();
    releaseOldPush.resolve();
    await sender.stop();
    await receiver.stop();
    detach();
    source.close();
    inbox.close();
    rmSync(root, { recursive: true, force: true });
    vi.useRealTimers();
  }
});

it("publishes initial sessions and later withdrawals in both directions", async () => {
  vi.useFakeTimers();
  const root = mkdtempSync(join(paths.globalRoot, "presence-order-"));
  const clock: Clock = { now: () => Date.now(), later: (ms, fn) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } };
  const source = openIntercomStore({ file: join(root, "source", "queue.db"), machineId: A, clock });
  const inbox = openIntercomStore({ file: join(root, "inbox", "queue.db"), machineId: B, clock });
  const sourceReady = deferred(), targetReady = deferred(), sourceGone = deferred(), targetGone = deferred(), pollWaiting = deferred();
  const home = (address: typeof coordinator) => ({ sessionId: address.sessionId, machineId: address.sessionId === coordinator.sessionId ? A : B,
    epoch: 1, moveId: null, updatedAt: 1 });
  const entry = (address: typeof coordinator, machineId: string): RemoteSessionInfo => ({ remote: true, id: address.sessionId, address, machineId,
    machineAlias: `fixture-${machineId.slice(-1)}.invalid`, homeEpoch: 1, activationEpoch: "initial", endpointEpoch: "initial",
    cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1 });
  let sourceLocal = [entry(coordinator, A)], targetLocal = [entry(helper, B)], withdrawingSource = false, withdrawingTarget = false;
  const sourceRoster = createFederation({ agentDir: "/fixture/a", locals: () => [coordinator], now: clock.now });
  const targetRoster = createFederation({ agentDir: "/fixture/b", locals: () => [helper], now: clock.now });
  const receiver = createIntercomBridge({ machineId: B, machineAlias: "helper.invalid", edges: [{ peer: peer(A), edgeEpoch: "edge-1", initiator: false }],
    store: inbox, clock, transport: {} as Transport, localPresence: () => targetLocal, authoritativeHome: home,
    publishPresence(entries) {
      targetRoster.publishPresence(entries);
      if (withdrawingSource && !entries.some(item => item.id === coordinator.sessionId)) sourceGone.resolve();
      if (entries.some(item => item.id === coordinator.sessionId)) sourceReady.resolve();
    } });
  const transport = {
    resolve: async (target: Peer) => target,
    exec: async (_target: Peer, _args: readonly string[], options: { stdinForTimeout(ms: number): Buffer; signal: AbortSignal }) => {
      const request = JSON.parse(options.stdinForTimeout(30_000).toString());
      const pending = receiver.exchange(request, options.signal);
      if (request.holdMs > 0) pollWaiting.resolve();
      const value = await pending;
      return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-exchange", ok: true, value }));
    },
  } as unknown as Transport;
  const sender = createIntercomBridge({ machineId: A, machineAlias: "coordinator.invalid", edges: [{ peer: peer(B), edgeEpoch: "edge-1", initiator: true }],
    store: source, clock, transport, localPresence: () => sourceLocal, authoritativeHome: home,
    publishPresence(entries) {
      sourceRoster.publishPresence(entries);
      if (withdrawingTarget && !entries.some(item => item.id === helper.sessionId)) targetGone.resolve();
      if (entries.some(item => item.id === helper.sessionId)) targetReady.resolve();
    } });
  const detachSource = sourceRoster.registerBridge({ feature: FEDERATION_FEATURE, agentDir: "/fixture/a", machineId: A, machineAlias: "coordinator.invalid" }, sender);
  const detachTarget = targetRoster.registerBridge({ feature: FEDERATION_FEATURE, agentDir: "/fixture/b", machineId: B, machineAlias: "helper.invalid" }, receiver);
  try {
    await receiver.start();
    await sender.start();
    await Promise.all([sourceReady.promise, targetReady.promise]);
    expect(targetRoster.resolve(coordinator.sessionId, null, [])).toMatchObject({ activationEpoch: "initial" });
    expect(sourceRoster.resolve(helper.sessionId, null, [])).toMatchObject({ activationEpoch: "initial" });
    await vi.advanceTimersByTimeAsync(0);
    await pollWaiting.promise;
    withdrawingSource = true;
    sourceLocal = [];
    sender.wake(B);
    await sourceGone.promise;
    expect(targetRoster.resolve(coordinator.sessionId, null, [])).toBeNull();
    withdrawingTarget = true;
    targetLocal = [];
    receiver.wake(A);
    await targetGone.promise;
    expect(sourceRoster.resolve(helper.sessionId, null, [])).toBeNull();
  } finally {
    await sender.stop();
    await receiver.stop();
    detachSource();
    detachTarget();
    source.close();
    inbox.close();
    rmSync(root, { recursive: true, force: true });
    vi.useRealTimers();
  }
});

it("clears cached presence after a handshake with an empty roster", async () => {
  vi.useFakeTimers();
  const root = mkdtempSync(join(paths.globalRoot, "presence-order-"));
  const clock: Clock = { now: () => Date.now(), later: (ms, fn) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } };
  const source = openIntercomStore({ file: join(root, "source", "queue.db"), machineId: A, clock });
  const inbox = openIntercomStore({ file: join(root, "inbox", "queue.db"), machineId: B, clock });
  const old: RemoteSessionInfo = { remote: true, id: coordinator.sessionId, address: coordinator, machineId: A, machineAlias: "coordinator.invalid",
    homeEpoch: 1, activationEpoch: "old", endpointEpoch: "old", cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1 };
  inbox.updateEdgeState(A, "edge-1", state => ({ ...state, status: "live", lastSuccess: clock.now(), roster: [old] }));
  const home = (address: typeof coordinator) => ({ sessionId: address.sessionId, machineId: address.sessionId === coordinator.sessionId ? A : B,
    epoch: 1, moveId: null, updatedAt: 1 });
  const federation = createFederation({ agentDir: "/fixture/agent", locals: () => [helper], now: clock.now });
  const receiver = createIntercomBridge({ machineId: B, machineAlias: "helper.invalid", edges: [{ peer: peer(A), edgeEpoch: "edge-1", initiator: false }],
    store: inbox, clock, transport: {} as Transport, localPresence: () => [], authoritativeHome: home,
    publishPresence: entries => federation.publishPresence(entries) });
  const handshake = deferred();
  const transport = {
    resolve: async (target: Peer) => target,
    exec: async (_target: Peer, _args: readonly string[], options: { stdinForTimeout(ms: number): Buffer; signal: AbortSignal }) => {
      const request = JSON.parse(options.stdinForTimeout(30_000).toString());
      const value = await receiver.exchange(request, options.signal);
      if (request.exchange.generation.channel === "poll" && request.holdMs === 0) handshake.resolve();
      return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-exchange", ok: true, value }));
    },
  } as unknown as Transport;
  const sender = createIntercomBridge({ machineId: A, machineAlias: "coordinator.invalid", edges: [{ peer: peer(B), edgeEpoch: "edge-1", initiator: true }],
    store: source, clock, transport, localPresence: () => [], authoritativeHome: home });
  const detach = federation.registerBridge({ feature: FEDERATION_FEATURE, agentDir: "/fixture/agent", machineId: B, machineAlias: "helper.invalid" }, receiver);
  try {
    await receiver.start();
    expect(federation.resolve(coordinator.sessionId, null, [])).toMatchObject({ activationEpoch: "old" });
    await sender.start();
    await handshake.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(federation.resolve(coordinator.sessionId, null, [])).toBeNull();
  } finally {
    await sender.stop();
    await receiver.stop();
    detach();
    source.close();
    inbox.close();
    rmSync(root, { recursive: true, force: true });
    vi.useRealTimers();
  }
});
