import { paths } from "@spider/db-core";
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RemoteSessionInfo } from "@spider/intercom/protocol";
import { openIntercomStore } from "../intercom-store";
import { createIntercomBridge } from "../intercom-bridge";
import type { IntercomExchange } from "../intercom-contracts";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const sender = { sessionId: "sender", scopeId: "scope" };
const roots: string[] = [], resources: Array<{ stop(): Promise<void> }> = [], stores: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) await resource.stop();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const clock = { now: () => Date.now(), later: (ms: number, fn: () => void) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } };
const peer = (machineId: string) => ({ machineId, alias: `box-${machineId.slice(-1)}.invalid`, node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot: "/fixture/global" });
const info = (machineId: string): RemoteSessionInfo => ({ remote: true, id: `session-${machineId.slice(-1)}`, address: { sessionId: `session-${machineId.slice(-1)}`, scopeId: "scope" },
  machineId, machineAlias: `box-${machineId.slice(-1)}.invalid`, homeEpoch: 1, activationEpoch: "generation-1", endpointEpoch: "generation-1",
  cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1 });
const endpoint = (machineId: string) => {
  const value = info(machineId);
  return { address: value.address, machineId: value.machineId, homeEpoch: value.homeEpoch, activationEpoch: value.activationEpoch };
};
const wire = (source: string, generation: number, epoch = "edge-1", channel: "push" | "poll" = "push"): IntercomExchange => ({
  protocol: 3, senderMachine: source, recipientMachine: A, generation: { edgeEpoch: epoch, channel, generation },
  frames: [], acknowledgements: [], receipts: [], controls: [], presence: [],
});
const request = (exchange: IntercomExchange, holdMs = 0) => ({ version: 1, exchange, holdMs, deadlineMs: holdMs ? holdMs + 5000 : 5000 });

function fixture(options: { holdAbort?: boolean; rejectNotices?: boolean; holdConfirm?: boolean } = {}) {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "intercom-revoke-")); roots.push(root);
  const file = join(root, "queue.db"), store = openIntercomStore({ file, machineId: A, clock }); stores.push(store);
  let started!: () => void, releaseAbort = () => {}, transportCalls = 0;
  const outboundStarted = new Promise<void>(resolve => { started = resolve; });
  const receipts: any[] = [], asks: any[] = [], holdAbort = options.holdAbort === true, transportStops = new Set<() => void>();
  let confirmNotice: (confirmed: boolean) => void = () => {};
  const transport = {
    async resolve(value: unknown) { return value; },
    async exec(_peer: unknown, _argv: unknown, options: { signal: AbortSignal }) {
      transportCalls++; started();
      return new Promise<Buffer>((_resolve, reject) => {
        const finish = () => { transportStops.delete(finish); reject(new Error("aborted")); }; transportStops.add(finish);
        if (options.signal.aborted) { finish(); return; }
        options.signal.addEventListener("abort", () => { if (holdAbort) releaseAbort = finish; else finish(); }, { once: true });
      });
    },
  };
  const bridge = createIntercomBridge({ machineId: A, machineAlias: "box-1.invalid", edges: [
    { peer: peer(B), edgeEpoch: "edge-1", initiator: true }, { peer: peer(C), edgeEpoch: "edge-2", initiator: false },
  ], store, clock, transport: transport as any, localPresence: () => [], authoritativeHome: () => null,
  onReceipt: value => { if (options.rejectNotices) throw new Error("broker offline"); receipts.push(value); },
  onRevocationNotice: async value => { if (options.rejectNotices) throw new Error("broker offline"); receipts.push(value);
    if (options.holdConfirm) return new Promise<boolean>(resolve => { confirmNotice = resolve; }); return true; },
  onAskFailed: value => asks.push(value) });
  resources.push(bridge);
  return { root, file, store, bridge, receipts, asks, outboundStarted, confirmNotice: (confirmed: boolean) => confirmNotice(confirmed), releaseAbort: () => releaseAbort(),
    releaseAll: () => { for (const stop of [...transportStops]) stop(); }, transportCalls: () => transportCalls };
}

it("fences one pair immediately, closes both exchange directions, and leaves another pair flowing", async () => {
  const f = fixture(); await f.bridge.start();
  const waiting = f.bridge.exchange(request(wire(B, 1, "edge-1", "poll"), 25_000));
  void waiting.catch(() => {});
  f.store.acceptOutbound({ from: sender, endpoint: endpoint(B), nextHop: B, message: { id: "queued", timestamp: 1, content: { text: "synthetic" } } });
  await f.outboundStarted;
  const revoke = (f.bridge as unknown as { revokePair?: (peer: string, epoch: string) => Promise<unknown> }).revokePair;
  expect(typeof revoke).toBe("function");
  const closing = revoke!(B, "edge-1");
  await expect(f.bridge.exchange(request(wire(B, 2)))).rejects.toMatchObject({ code: "peer-revoked" });
  await expect(waiting).rejects.toMatchObject({ code: "peer-revoked" });
  expect(await closing).toMatchObject({ peer: B, edgeEpoch: "edge-1", exchanges: "closed", inFlight: 0 });
  expect(f.receipts).toEqual([expect.objectContaining({ receipt: expect.objectContaining({ messageId: "queued", detail: "peer-revoked" }) })]);
  expect(f.store.retained("outbound", "queued")).toMatchObject({ failureReason: "peer-revoked" });
  expect((await f.bridge.exchange(request(wire(C, 1, "edge-2")))).exchange.senderMachine).toBe(A);
}, 5000);

it("fails a queued ask by name and reports a repeated revoke without new effects", async () => {
  const f = fixture(); await f.bridge.start();
  f.store.acceptOutbound({ from: sender, endpoint: endpoint(B), nextHop: B,
    message: { id: "question", timestamp: 1, expectsReply: true, remainingMs: 120_000, content: { text: "synthetic" } } });
  const revoke = (f.bridge as unknown as { revokePair?: (peer: string, epoch: string) => Promise<unknown> }).revokePair;
  expect(typeof revoke).toBe("function");
  const first = await revoke!(B, "edge-1"), second = await revoke!(B, "edge-1");
  expect(second).toEqual(first);
  expect(f.receipts).toEqual([expect.objectContaining({ receipt: expect.objectContaining({ messageId: "question", status: "cancelled", detail: "peer-revoked" }) })]);
  expect(f.store.openAsks(B)).toEqual([]);
}, 5000);

it("accepts a pinned fence generation from the other endpoint without replacing an existing fence", async () => {
  const f = fixture(); await f.bridge.start();
  const revoke = (f.bridge as unknown as { revokePair: (peer: string, epoch: string, fenceId: string) => Promise<{ fenceId: string }> }).revokePair;
  const token = "00000000-0000-4000-8000-000000000004";
  expect(await revoke(B, "edge-1", token)).toMatchObject({ fenceId: token });
  expect(f.store.pairFence(B)?.fenceId).toBe(token);
  expect(await revoke(B, "edge-1", "00000000-0000-4000-8000-000000000005")).toMatchObject({ fenceId: token });
}, 5000);

it("a durable pair fence survives restart and cannot be bypassed by a config epoch edit", async () => {
  const f = fixture(); await f.bridge.start();
  const revoke = (f.bridge as unknown as { revokePair?: (peer: string, epoch: string) => Promise<unknown> }).revokePair;
  expect(typeof revoke).toBe("function"); await revoke!(B, "edge-1");
  await f.bridge.stop(); f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const reopened = openIntercomStore({ file: f.file, machineId: A, clock }); stores.push(reopened);
  const bridge = createIntercomBridge({ machineId: A, machineAlias: "box-1.invalid", edges: [{ peer: peer(B), edgeEpoch: "edited-epoch", initiator: false }],
    store: reopened, clock, transport: {} as any, localPresence: () => [], authoritativeHome: () => null });
  resources.push(bridge); await bridge.start();
  await expect(bridge.exchange(request(wire(B, 1, "edited-epoch")))).rejects.toMatchObject({ code: "peer-revoked" });
}, 5000);

it("fences an edited or missing config route before it can be reintroduced", async () => {
  for (const edited of [false, true]) {
    const f = fixture(), bridge = createIntercomBridge({ machineId: A, machineAlias: "box-1.invalid",
      edges: edited ? [{ peer: peer(B), edgeEpoch: "edited-epoch", initiator: false }] : [], store: f.store, clock,
      transport: {} as any, localPresence: () => [], authoritativeHome: () => null });
    resources.push(bridge); await bridge.start();
    expect(await bridge.revokePair(B, "edge-1")).toMatchObject({ peer: B, edgeEpoch: "edge-1", exchanges: "closed", inFlight: 0 });
    expect(f.store.pairFence(B)).toMatchObject({ peer: B, edgeEpoch: "edge-1" });
    if (edited) await expect(bridge.exchange(request(wire(B, 1, "edited-epoch")))).rejects.toMatchObject({ code: "peer-revoked" });
  }
}, 5000);

it("only an approval of the current fence and a new edge epoch clears it", async () => {
  const f = fixture(); await f.bridge.start(); await f.bridge.revokePair(B, "edge-1");
  const fence = f.store.pairFence(B)!;
  const approve = (f.store as unknown as { approvePair?: (peer: string, value: unknown) => void }).approvePair;
  expect(typeof approve).toBe("function");
  const approval = { expectedFenceId: fence.fenceId, operationId: "fresh-consent", graphDigest: "a".repeat(64), edgeEpoch: "edge-2" };
  expect(() => approve!(B, { ...approval, expectedFenceId: null })).toThrow("fresh-peer-consent-required");
  expect(() => approve!(B, { ...approval, edgeEpoch: "edge-1" })).toThrow("fresh-peer-consent-required");
  expect(f.store.pairFence(B)).toEqual(fence);
  approve!(B, approval); expect(f.store.pairFence(B)).toBeNull();
  expect(() => approve!(B, approval)).not.toThrow();
  f.store.fencePair(B, "edge-2");
  expect(() => approve!(B, approval)).toThrow("fresh-peer-consent-required");
  expect(f.store.pairFence(B)).not.toBeNull();
}, 5000);

it("fresh consent installs a new live epoch and a later revoke fences it again", async () => {
  const f = fixture(); await f.bridge.start(); const first = await f.bridge.revokePair(B, "edge-1");
  const enroll = (f.bridge as unknown as { enrollPair?: (edge: unknown, approval: unknown) => Promise<void> }).enrollPair;
  expect(typeof enroll).toBe("function");
  const edge = { peer: peer(B), edgeEpoch: "edge-2", initiator: true };
  const approval = { expectedFenceId: first.fenceId, operationId: "consent-2", graphDigest: "b".repeat(64), edgeEpoch: "edge-2" };
  await enroll!(edge, approval);
  await expect(enroll!(edge, approval)).resolves.toBeUndefined();
  await expect(f.bridge.exchange(request(wire(B, 1, "edge-1")))).rejects.toMatchObject({ code: "machine-not-enrolled" });
  expect((await f.bridge.exchange(request(wire(B, 1, "edge-2")))).exchange.senderMachine).toBe(A);
  const second = await f.bridge.revokePair(B, "edge-2");
  expect(second.fenceId).not.toBe(first.fenceId);
  await expect(f.bridge.exchange(request(wire(B, 2, "edge-2")))).rejects.toMatchObject({ code: "peer-revoked" });
}, 5000);

it("concurrent retries install exactly one new edge after the old transport closes", async () => {
  const f = fixture({ holdAbort: true }); await f.bridge.start(); await f.outboundStarted;
  const closing = f.bridge.revokePair(B, "edge-1"), fence = f.store.pairFence(B)!;
  const edge = { peer: peer(B), edgeEpoch: "edge-2", initiator: true };
  const approval = { expectedFenceId: fence.fenceId, operationId: "consent-2", graphDigest: "b".repeat(64), edgeEpoch: "edge-2" };
  try {
    const one = f.bridge.enrollPair(edge, approval), two = f.bridge.enrollPair(edge, approval);
    f.releaseAbort(); await closing; await Promise.all([one, two]);
    expect(f.transportCalls()).toBe(2);
    expect(f.store.edgeState(B, "edge-2").status).toBe("unknown");
  } finally { f.releaseAll(); }
}, 5000);

it("does not report edge closure while the aborted transport is still running", async () => {
  const f = fixture({ holdAbort: true }); await f.bridge.start(); await f.outboundStarted;
  let closed = false;
  const closing = f.bridge.revokePair(B, "edge-1").then(proof => { closed = true; return proof; });
  try {
    await Promise.resolve();
    expect(f.store.pairFence(B)).toMatchObject({ peer: B, edgeEpoch: "edge-1" });
    expect(closed).toBe(false);
    expect(await f.bridge.dispatch({ from: sender, to: info(B), message: { id: "new", timestamp: 1, content: { text: "test" } } })).toMatchObject({
      delivery: "failed", reason: "peer-revoked", retryable: false,
    });
  } finally { f.releaseAbort(); }
  expect(await closing).toMatchObject({ exchanges: "closed", inFlight: 0 });
}, 5000);

it("replays a named local failure receipt after the broker callback fails and the bridge restarts", async () => {
  const f = fixture({ rejectNotices: true }); await f.bridge.start();
  f.store.acceptOutbound({ from: sender, endpoint: endpoint(B), nextHop: B, message: { id: "retry", timestamp: 1, content: { text: "test" } } });
  await f.bridge.revokePair(B, "edge-1");
  expect(f.store.pendingRevocationNotices()).toEqual([expect.objectContaining({ receipt: expect.objectContaining({ messageId: "retry", detail: "peer-revoked" }) })]);
  await f.bridge.stop(); f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const reopened = openIntercomStore({ file: f.file, machineId: A, clock }); stores.push(reopened);
  const delivered: any[] = [];
  const bridge = createIntercomBridge({ machineId: A, machineAlias: "box-1.invalid", edges: [{ peer: peer(B), edgeEpoch: "edge-1", initiator: false }],
    store: reopened, clock, transport: {} as any, localPresence: () => [], authoritativeHome: () => null,
    onRevocationNotice: async frame => { delivered.push(frame); return true; } });
  resources.push(bridge); await bridge.start();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(delivered).toEqual([expect.objectContaining({ to: sender, receipt: expect.objectContaining({ messageId: "retry", detail: "peer-revoked" }) })]);
  expect(reopened.pendingRevocationNotices()).toEqual([]);
}, 5000);

it("retains an unconfirmed revocation notice across a bridge crash and retries until confirmed", async () => {
  const f = fixture({ holdConfirm: true }); await f.bridge.start();
  f.store.acceptOutbound({ from: sender, endpoint: endpoint(B), nextHop: B, message: { id: "uncertain", timestamp: 1, content: { text: "test" } } });
  await f.bridge.revokePair(B, "edge-1");
  expect(f.receipts).toHaveLength(1);
  expect(f.store.pendingRevocationNotices()).toMatchObject([{ receipt: { messageId: "uncertain", detail: "peer-revoked" } }]);
  await f.bridge.stop(); f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  f.confirmNotice(true); await Promise.resolve();
  const reopened = openIntercomStore({ file: f.file, machineId: A, clock }); stores.push(reopened);
  let confirm!: (value: boolean) => void, called!: () => void;
  const started = new Promise<void>(resolve => { called = resolve; });
  const bridge = createIntercomBridge({ machineId: A, machineAlias: "box-1.invalid", edges: [{ peer: peer(B), edgeEpoch: "edge-1", initiator: false }],
    store: reopened, clock, transport: {} as any, localPresence: () => [], authoritativeHome: () => null,
    onRevocationNotice: async () => { called(); return new Promise<boolean>(resolve => { confirm = resolve; }); } });
  resources.push(bridge); await bridge.start(); await started;
  expect(reopened.pendingRevocationNotices()).toHaveLength(1);
  confirm(true); for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(reopened.pendingRevocationNotices()).toEqual([]);
}, 5000);

it("returns relay failures to the upstream origin and refuses new work routed through a fenced edge", async () => {
  const f = fixture(); await f.bridge.start();
  const source = openIntercomStore({ file: join(f.root, "source", "queue.db"), machineId: C, clock }); stores.push(source);
  source.acceptOutbound({ from: sender, endpoint: endpoint(B), nextHop: A, message: { id: "relay-1", timestamp: 1, content: { text: "test" } } });
  const initial = wire(C, 1, "edge-2"); initial.frames.push(source.pending({ kind: "outbound", peer: A, hopBudgetMs: 100 })[0]);
  await f.bridge.exchange(request(initial));
  await f.bridge.revokePair(B, "edge-1");
  const upstream = await f.bridge.exchange(request(wire(C, 1, "edge-2", "poll")));
  expect(upstream.exchange.receipts).toEqual([expect.objectContaining({ to: sender, receipt: expect.objectContaining({ messageId: "relay-1", detail: "peer-revoked" }) })]);
  expect(f.store.retained("outbound", "relay-1")).toMatchObject({ failureReason: "peer-revoked" });
  source.acceptOutbound({ from: sender, endpoint: endpoint(B), nextHop: A, message: { id: "relay-2", timestamp: 1, content: { text: "test" } } });
  const newFrame = source.pending({ kind: "outbound", peer: A, hopBudgetMs: 100 }).find(frame => frame.identity.id === "relay-2")!;
  const next = wire(C, 2, "edge-2"); next.frames.push(newFrame);
  const refusal = await f.bridge.exchange(request(next));
  expect(refusal.exchange.refusals).toEqual([expect.objectContaining({ identity: expect.objectContaining({ id: "relay-2" }), reason: "peer-revoked" })]);
  expect(f.store.retained("outbound", "relay-2")).toBeNull();
}, 5000);
