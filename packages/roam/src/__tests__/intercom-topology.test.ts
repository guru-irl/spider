import { withHopExchange } from "./intercom-hop-fixture";
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodeExchange, encodeExchange } from "../intercom-codec";
import { openIntercomStore } from "../intercom-store";
import type { IntercomReceiptFrame, IntercomStore } from "../intercom-contracts";

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002", H = "00000000-0000-4000-8000-000000000003";
const from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
const endpoint = { address: to, machineId: B, homeEpoch: null, activationEpoch: "recipient-generation" };
const transitionId = "00000000-0000-4000-8000-000000000004";
const roots: string[] = [], stores: IntercomStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
function fixture() {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "topology-")); roots.push(root);
  let time = 1000;
  const clock = { now: () => time, advance: (ms: number) => { time += ms; } };
  const open = (machineId: string) => {
    const store = openIntercomStore({ file: join(root, `${machineId}.db`), machineId, clock }); stores.push(store); return store;
  };
  const restart = (store: IntercomStore, machineId: string) => { stores.splice(stores.indexOf(store), 1); store.close(); return open(machineId); };
  return { root, clock, open, restart };
}
function send(store: IntercomStore, id: string, nextHop = H, target = endpoint) {
  const result = store.acceptOutbound({ from, endpoint: target, message: { id, timestamp: 1000, content: { text: `synthetic-${id}` } }, nextHop });
  if (result.kind === "refused") throw new Error(result.reason);
  return result.identity;
}
const start = (hub: IntercomStore) => hub.startTopologyTransition({ transitionId, from: "hub-only", to: "peers", boxes: [A, B] });
const switchBox = (box: IntercomStore) => box.switchTopology({ transitionId, hubMachineId: H, directPeers: [A, B] });
function transfer(source: IntercomStore, target: IntercomStore, peer: string, destination: string) {
  const frames = source.pending({ kind: "outbound", peer: destination, hopBudgetMs: 100 });
  for (const frame of frames) {
    const accepted = target.acceptInbound({ peer, frame });
    if (accepted.kind === "refused") throw new Error(accepted.reason);
    source.acknowledge({ peer: destination, identity: frame.identity, kind: frame.kind });
  }
  return frames;
}
function consume(store: IntercomStore, id: string, peer: string): IntercomReceiptFrame {
  store.beginDispatch({ id, endpoint, readiness: "ready" });
  const original = store.retained('inbound', id)!;
  const frame: IntercomReceiptFrame = { from: endpoint, to: from, digest: original.identity.digest, attempt: 1,
    originMachineId: original.originMachineId!, sequence: original.identity.sequence,
    receipt: { messageId: id, status: "injected", timestamp: 1000, evidence: { kind: "entry", entryId: `entry-${id}`, sessionId: to.sessionId, activationEpoch: endpoint.activationEpoch } } };
  store.settleReceipt({ queue: "inbound", peer, frame }); return frame;
}

it("switches source-held relay mail atomically with an audit and preserves identity, origin and receipts", () => {
  const f = fixture(), source = f.open(A), target = f.open(B);
  const identity = send(source, "source-held");
  expect(switchBox(source)).toEqual({ rebound: 1, missing: [] });
  expect(source.topology().mode).toBe("peers");
  expect(source.topologyAudit()).toEqual([{ id: identity.id, reason: "topology-transition", transitionId, oldNextHop: H, newNextHop: B, timestamp: 1000 }]);
  const frames = transfer(source, target, A, B);
  expect(frames).toHaveLength(1);
  expect(frames[0]).toMatchObject({ identity, originMachineId: A });
  const receipt = consume(target, identity.id, A);
  source.settleReceipt({ queue: "outbound", peer: B, frame: receipt });
  expect(source.retained("outbound", identity.id)).toMatchObject({ state: "injected", payloadRetained: false, peer: B, originMachineId: A });
  expect(target.acceptInbound({ peer: A, frame: frames[0] }).kind).toBe("duplicate");
  expect(target.pending({ kind: "inbound", address: to })).toEqual([]);
}, 5000);

it("drains hub custody and its receipt to the origin before permitting the switch", () => {
  const f = fixture(), source = f.open(A), hub = f.open(H), target = f.open(B);
  const identity = send(source, "hub-held");
  const [frame] = transfer(source, hub, A, H);
  hub.acceptOutbound({ frame, nextHop: B });
  start(hub);
  expect(hub.advanceTopologyTransition().state).toBe("draining");
  expect(hub.topology().mode).toBe("hub-only");
  transfer(hub, target, H, B);
  expect(hub.advanceTopologyTransition().state).toBe("draining");
  const receipt = consume(target, identity.id, H);
  hub.settleReceipt({ queue: "outbound", peer: B, frame: receipt });
  hub.settleReceipt({ queue: "inbound", peer: A, frame: receipt });
  expect(hub.advanceTopologyTransition().state).toBe("draining");
  const [relayedReceipt] = hub.pending({ kind: "receipts", peer: A });
  source.settleReceipt({ queue: "outbound", peer: H, frame: relayedReceipt });
  hub.acknowledgeReceipt({ peer: A, frame: relayedReceipt });
  expect(hub.advanceTopologyTransition().state).toBe("switching");
  expect(source.retained("outbound", identity.id)).toMatchObject({ payloadRetained: false, state: "injected" });
  expect(switchBox(source)).toEqual({ rebound: 0, missing: [] });
  expect(source.topologyAudit()).toEqual([]);
}, 5000);

it("durably fences new relay custody before acceptance and rebinds a proved refusal", () => {
  const f = fixture(), source = f.open(A); let hub = f.open(H);
  const identity = send(source, "after-fence");
  start(hub); hub = f.restart(hub, H);
  const [frame] = source.pending({ kind: "outbound", peer: H, hopBudgetMs: 100 });
  expect(hub.acceptInbound({ peer: A, frame })).toEqual({ kind: "refused", reason: "intercom-topology-changing" });
  expect(hub.retained("inbound", identity.id)).toBeNull();
  expect(source.retained("outbound", identity.id)).toMatchObject({ state: "queued", payloadRetained: true });
  source.recordTopologyRefusal({ peer: H, identity });
  expect(switchBox(source)).toEqual({ rebound: 1, missing: [] });
  expect(source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0]).toMatchObject({ identity, originMachineId: A });
}, 5000);

it.each(["custody", "unknown"] as const)("refuses %s by name without changing mode, any route, or the audit", kind => {
  const f = fixture(), source = f.open(A);
  send(source, "safe-first");
  const identity = send(source, "unsafe-second");
  source.pending({ kind: "outbound", peer: H, hopBudgetMs: 100, skipIds: ["safe-first"] });
  // A separate sender pair permits the unsafe copy to cross the real handoff boundary.
  const other = { ...from, sessionId: "other-sender" };
  const accepted = source.acceptOutbound({ from: other, endpoint, nextHop: H, message: { id: "unsafe", timestamp: 1000, content: { text: "synthetic" } } });
  if (accepted.kind === "refused") throw new Error(accepted.reason);
  source.pending({ kind: "outbound", peer: H, hopBudgetMs: 100, skipIds: ["safe-first"] });
  if (kind === "custody") source.acknowledge({ peer: H, identity: accepted.identity, kind: "message" });
  expect(() => switchBox(source)).toThrow(kind === "custody" ? "intercom-topology-hub-custody" : "intercom-topology-outcome-unknown");
  expect(source.topology().mode).toBe("hub-only");
  expect(source.topologyAudit()).toEqual([]);
  expect(source.retained("outbound", "safe-first")?.peer).toBe(H);
  expect(source.retained("outbound", identity.id)?.peer).toBe(H);
}, 5000);

it("keeps destinations without a direct enrolled edge queued and reports the missing route", () => {
  const f = fixture(), source = f.open(A); send(source, "missing-route");
  expect(source.switchTopology({ transitionId, hubMachineId: H, directPeers: [] })).toEqual({ rebound: 0, missing: [B] });
  expect(source.topology().mode).toBe("peers");
  expect(source.retained("outbound", "missing-route")).toMatchObject({ state: "queued", peer: H, payloadRetained: true });
  expect(source.topologyAudit()).toEqual([]);
  expect(source.missingTopologyRoutes()).toEqual([B]);
  expect(source.pending({ kind: "outbound", peer: H, hopBudgetMs: 100 })).toEqual([]);
}, 5000);

it("replays a switch idempotently after restart without another route change or audit", () => {
  const f = fixture(); let source = f.open(A); send(source, "replayed");
  switchBox(source); source = f.restart(source, A);
  expect(switchBox(source)).toEqual({ rebound: 0, missing: [] });
  expect(source.topology()).toMatchObject({ mode: "peers", switched: transitionId });
  expect(source.topologyAudit()).toHaveLength(1);
  expect(source.retained("outbound", "replayed")?.peer).toBe(B);
}, 5000);

it("resumes a pending hub transition after restart and completes only after every box acknowledges", () => {
  const f = fixture(); let hub = f.open(H);
  expect(start(hub)).toMatchObject({ transitionId, from: "hub-only", to: "peers", state: "draining", boxes: { [A]: "pending", [B]: "pending" } });
  expect(hub.advanceTopologyTransition().state).toBe("switching");
  hub.acknowledgeTopologySwitch(transitionId, A);
  hub = f.restart(hub, H);
  expect(start(hub)).toMatchObject({ state: "switching", boxes: { [A]: "switched", [B]: "pending" } });
  expect(hub.topology().mode).toBe("hub-only");
  hub.acknowledgeTopologySwitch(transitionId, B);
  expect(hub.topology()).toMatchObject({ mode: "peers", transition: { state: "complete" } });
  hub.acknowledgeTopologySwitch(transitionId, B);
  expect(hub.topology().transition?.state).toBe("complete");
}, 5000);

it("leaves direct box-to-hub and hub-origin traffic unaffected by the relay fence", () => {
  const f = fixture(), source = f.open(A), hub = f.open(H), target = f.open(B);
  start(hub);
  const localEndpoint = { ...endpoint, address: { ...to, sessionId: "hub-recipient" }, machineId: H };
  send(source, "to-hub", H, localEndpoint);
  expect(transfer(source, hub, A, H)).toHaveLength(1);
  send(hub, "from-hub", B);
  expect(transfer(hub, target, H, B)).toHaveLength(1);
}, 5000);

it("expires undelivered hub custody through the existing failure receipt before switching", () => {
  const f = fixture(), source = f.open(A), hub = f.open(H);
  send(source, "expires"); const [frame] = transfer(source, hub, A, H); hub.acceptOutbound({ frame, nextHop: B }); start(hub);
  f.clock.advance(24 * 60 * 60 * 1000 + 1); hub.expire();
  expect(hub.advanceTopologyTransition().state).toBe("draining");
  const receipts = hub.pending({ kind: "receipts", peer: A });
  expect(receipts.some(item => item.receipt.status === "expired")).toBe(true);
  for (const receipt of receipts) { source.settleReceipt({ queue: "outbound", peer: H, frame: receipt }); hub.acknowledgeReceipt({ peer: A, frame: receipt }); }
  expect(hub.advanceTopologyTransition().state).toBe("switching");
}, 5000);

it("refuses the unsupported reverse transition by name without changing topology", () => {
  const f = fixture(), hub = f.open(H);
  expect(() => hub.startTopologyTransition({ transitionId, from: "peers", to: "hub-only", boxes: [A, B] })).toThrow("intercom-transition-unsupported");
  expect(hub.topology()).toEqual({ mode: "hub-only", transition: null, switched: null });
}, 5000);


it("round-trips bounded topology controls and the retryable refusal without accepting malformed controls", () => {
  const exchange = withHopExchange({ protocol: 5 as const, senderMachine: H, recipientMachine: A,
    generation: { edgeEpoch: "edge", channel: "push" as const, generation: 1 }, frames: [], acknowledgements: [], receipts: [], controls: [], presence: [],
    topology: { transitionId, action: "switch" as const } });
  expect(decodeExchange(encodeExchange(withHopExchange(exchange)))).toEqual(exchange);
  expect(() => decodeExchange(Buffer.from(JSON.stringify({ ...exchange, topology: { ...exchange.topology, transitionId: "not-an-id" } })))).toThrow();
  expect(() => decodeExchange(Buffer.from(JSON.stringify({ ...exchange, topology: { ...exchange.topology, action: "fallback" } })))).toThrow();
  expect(() => decodeExchange(Buffer.from(JSON.stringify({ ...exchange, topology: { ...exchange.topology, extra: true } })))).toThrow();
  const f = fixture(), source = f.open(A), identity = send(source, "refusal-codec");
  const refused = { ...exchange, topology: undefined, refusals: [{ identity, hopSequence: 1, reason: "intercom-topology-changing" as const }] };
  expect(decodeExchange(encodeExchange(withHopExchange(refused))).refusals).toEqual(refused.refusals);
}, 5000);


it.each(["cancelled", "expired"] as const)("rebinds an undispatched %s tombstone so the next pair message has no sequence gap", reason => {
  const f = fixture(), source = f.open(A), target = f.open(B);
  const first = send(source, "tombstone-first");
  if (reason === "cancelled") source.cancel({ queue: "outbound", id: first.id, from, to });
  else { f.clock.advance(24 * 60 * 60 * 1000 + 1); source.expire(); }
  const second = send(source, "following");
  expect(switchBox(source)).toEqual({ rebound: 2, missing: [] });
  const frames = transfer(source, target, A, B);
  expect(frames.map(frame => [frame.identity.id, frame.kind])).toEqual([[first.id, "tombstone"], [second.id, "message"]]);
  expect(target.pending({ kind: "inbound", address: to })).toEqual([second]);
}, 5000);


it("accepts a delayed topology refusal only for the audited old hop, including after direct consumption", () => {
  const f = fixture(), source = f.open(A), target = f.open(B), identity = send(source, "delayed-refusal");
  source.pending({ kind: "outbound", peer: H, hopBudgetMs: 100 });
  source.recordTopologyRefusal({ peer: H, identity }); switchBox(source);
  expect(() => source.recordTopologyRefusal({ peer: H, identity })).not.toThrow();
  transfer(source, target, A, B);
  source.settleReceipt({ queue: "outbound", peer: B, frame: consume(target, identity.id, A) });
  expect(() => source.recordTopologyRefusal({ peer: H, identity })).not.toThrow();
  expect(() => source.recordTopologyRefusal({ peer: A, identity })).toThrow("intercom-topology-invalid-refusal");
  expect(() => source.recordTopologyRefusal({ peer: H, identity: { ...identity, digest: "0".repeat(64) } })).toThrow("intercom-topology-invalid-refusal");
  expect(source.retained("outbound", identity.id)).toMatchObject({ peer: B, state: "injected", payloadRetained: false });
}, 5000);

it("rebinds a previously missing direct route under the original transition and audit", () => {
  const f = fixture(); let source = f.open(A); const identity = send(source, "missing-then-enrolled");
  source.switchTopology({ transitionId, hubMachineId: H, directPeers: [] });
  expect(source.hasPending(H)).toBe(false);
  expect(source.pending({ kind: "outbound", peer: H, hopBudgetMs: 100 })).toEqual([]);
  source = f.restart(source, A);
  expect(source.rebindTopologyRoutes({ hubMachineId: H, directPeers: [B] })).toEqual({ rebound: 1, missing: [] });
  expect(source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 }).map(frame => frame.identity)).toEqual([identity]);
  expect(source.topologyAudit()).toEqual([{ id: identity.id, reason: "topology-transition", transitionId, oldNextHop: H, newNextHop: B, timestamp: 1000 }]);
  expect(source.rebindTopologyRoutes({ hubMachineId: H, directPeers: [B] }).rebound).toBe(0);
}, 5000);

it("does not let an unacknowledgeable receipt to a revoked upstream block draining", () => {
  const f = fixture(), source = f.open(A), hub = f.open(H), target = f.open(B);
  const identity = send(source, "revoked-upstream"); const [frame] = transfer(source, hub, A, H);
  hub.acceptOutbound({ frame, nextHop: B }); start(hub); transfer(hub, target, H, B);
  const receipt = consume(target, identity.id, H);
  hub.settleReceipt({ queue: "outbound", peer: B, frame: receipt }); hub.settleReceipt({ queue: "inbound", peer: A, frame: receipt });
  expect(hub.pending({ kind: "receipts", peer: A })).toHaveLength(1);
  expect(hub.advanceTopologyTransition().state).toBe("draining");
  hub.fencePair(A, "edge-a");
  expect(hub.pending({ kind: "receipts", peer: A })).toHaveLength(1);
  expect(hub.advanceTopologyTransition().state).toBe("switching");
}, 5000);
