import { withHopRequest } from "./intercom-hop-fixture";
import { withHopExchange } from "./intercom-hop-fixture";
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createIntercomBridge } from "../intercom-bridge";
import { createHostIntercomDelivery } from "../intercom-delivery";
import { openIntercomStore } from "../intercom-store";
const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
const roots: string[] = []; afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { force: true, recursive: true }); });
it("never-dispatched mail for an exited activation reaches the next activation", async () => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "zz-stranded-")); roots.push(root);
  let t = 1000; const clock = { now: () => t };
  const source = openIntercomStore({ file: join(root, "s.db"), machineId: A, clock }), inbox = openIntercomStore({ file: join(root, "i.db"), machineId: B, clock });
  const old = { address: to, machineId: B, homeEpoch: null, activationEpoch: "old" }, next = { ...old, activationEpoch: "new" };
  source.acceptOutbound({ from, endpoint: old, nextHop: B, message: { id: "m1", timestamp: 1, content: { text: "x" } } });
  inbox.acceptInbound({ peer: A, frame: source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0] });
  const ids: string[] = [];
  const broker = { async deliver(_s: unknown, _e: unknown, m: { id: string }) { ids.push(m.id); return { delivery: "socket_delivered", retryable: false, outcomeKnown: true, acceptance: { accepted: true, durable: false } } as const; }, deliverReceipt() {}, deliverControl() {} };
  const d = createHostIntercomDelivery({ store: inbox, broker: broker as never, endpoint: () => next, sender: () => null, wake() {}, now: clock.now });
  await d.ready(to, "new-ready");
  const state = inbox.retained("inbound", "m1");
  await d.ready(to, "another-ready");
  expect(ids).toEqual(["m1"]);
  expect(state).toMatchObject({ state: "unknown", endpoint: next });
  await d.stop(); source.close(); inbox.close();
  expect(ids).toEqual(["m1"]);
}, 5000);
it("pre-adoption mail with an excluded old activation rebinds to the adopted epoch", () => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "zz-stranded2-")); roots.push(root);
  const clock = { now: () => 1000 };
  const source = openIntercomStore({ file: join(root, "s.db"), machineId: A, clock }), inbox = openIntercomStore({ file: join(root, "i.db"), machineId: B, clock });
  const old = { address: to, machineId: B, homeEpoch: null, activationEpoch: "old" }, next = { ...old, homeEpoch: 1, activationEpoch: "new" };
  source.acceptOutbound({ from, endpoint: old, nextHop: B, message: { id: "m2", timestamp: 1, content: { text: "x" } } });
  const f = source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0];
  inbox.acceptInbound({ peer: A, frame: f });
  inbox.beginDispatch({ id: "m2", endpoint: old, readiness: "r1" });
  const absence = { from: old, to: from, digest: f.identity.digest, attempt: 1, receipt: { messageId: "m2", status: "not_injected" as const, timestamp: 1000,
    evidence: { kind: "absence" as const, sessionId: to.sessionId, activationEpoch: "old", excludedGeneration: "old", complete: true as const } } };
  inbox.resolveUnknown({ queue: "inbound", id: "m2", digest: f.identity.digest, proof: absence });
  let err = ""; try { inbox.rebindInboundAfterAbsence("m2", next); } catch (e) { err = (e as Error).message; }
  source.close(); inbox.close();
  expect(err).toBe("");
}, 5000);
it("a 1 ms clock step back keeps ordinary queued mail", () => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "zz-rollback-")); roots.push(root);
  let t = 100_000; const clock = { now: () => t };
  const source = openIntercomStore({ file: join(root, "s.db"), machineId: A, clock });
  const ep = { address: to, machineId: B, homeEpoch: null, activationEpoch: "a" };
  source.acceptOutbound({ from, endpoint: ep, nextHop: B, message: { id: "m3", timestamp: 1, content: { text: "x" } } });
  t -= 1; const expired = source.expire();
  source.close();
  expect(expired).toEqual([]);
}, 5000);
it("a revoked origin does not pin the topology drain forever", () => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "zz-drain-")); roots.push(root);
  const H = "00000000-0000-4000-8000-0000000000aa", P = "00000000-0000-4000-8000-0000000000bb", C = "00000000-0000-4000-8000-0000000000cc";
  let t = 1000; const clock = { now: () => t };
  const p = openIntercomStore({ file: join(root, "p.db"), machineId: P, clock }), hub = openIntercomStore({ file: join(root, "h.db"), machineId: H, clock });
  const ep = { address: to, machineId: C, homeEpoch: null, activationEpoch: "a" };
  p.acceptOutbound({ from, endpoint: ep, nextHop: H, message: { id: "m4", timestamp: 1, content: { text: "x" } } });
  const f = p.pending({ kind: "outbound", peer: H, hopBudgetMs: 100 })[0];
  hub.acceptInbound({ peer: P, frame: f }); hub.acceptOutbound({ frame: f, nextHop: C });
  hub.fencePair(P, "edge");
  hub.startTopologyTransition({ transitionId: "00000000-0000-4000-8000-0000000000dd", from: "hub-only", to: "peers", boxes: [C] });
  t += 25 * 3600_000; hub.expire();
  const state = hub.advanceTopologyTransition().state;
  p.close(); hub.close();
  expect(state).toBe("switching");
}, 5000);
// A socket handoff without physical-entry evidence must never be replayed.
it("does not redeliver to a new activation after the old one received the payload", async () => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "recovery-once-")); roots.push(root);
  const clock = { now: () => 1000 };
  const source = openIntercomStore({ file: join(root, "s.db"), machineId: A, clock }), inbox = openIntercomStore({ file: join(root, "i.db"), machineId: B, clock });
  let endpoint = { address: to, machineId: B, homeEpoch: null, activationEpoch: "old" };
  source.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "once", timestamp: 1, content: { text: "x" } } });
  inbox.acceptInbound({ peer: A, frame: source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0] });
  const ids: string[] = [];
  const d = createHostIntercomDelivery({ store: inbox, broker: { async deliver(_s: unknown, _e: unknown, m: { id: string }) {
    ids.push(m.id); return { delivery: "socket_delivered", retryable: false, outcomeKnown: true, acceptance: { accepted: true, durable: false } };
  }, deliverReceipt() {}, deliverControl() {} } as never, endpoint: () => endpoint, sender: () => null, wake() {}, now: clock.now });
  await d.ready(to, "old-ready"); endpoint = { ...endpoint, activationEpoch: "new" };
  await d.ready(to, "new-ready");
  expect(ids).toEqual(["once"]);
  expect(() => inbox.rebindInboundAfterAbsence("once", endpoint)).toThrow(/absence proof/);
  await d.stop(); source.close(); inbox.close();
}, 5000);


it("returns the new activation's physical consumption evidence to the original source for never-dispatched mail", async () => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "recovery-receipt-")); roots.push(root);
  const clock = { now: () => 1000, later: () => () => {} }, source = openIntercomStore({ file: join(root, "s.db"), machineId: A, clock }), inbox = openIntercomStore({ file: join(root, "i.db"), machineId: B, clock });
  const old = { address: to, machineId: B, homeEpoch: null, activationEpoch: "ended" }, next = { ...old, activationEpoch: "replacement" };
  source.acceptOutbound({ from, endpoint: old, nextHop: B, message: { id: "receipt-after-restart", timestamp: 1, content: { text: "x" } } });
  inbox.acceptInbound({ peer: A, frame: source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0] });
  const received: string[] = [], receipts: unknown[] = [];
  const bridge = createIntercomBridge({ machineId: A, machineAlias: "source.invalid", store: source, clock, transport: {} as never,
    edges: [{ peer: { machineId: B, alias: "peer.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/core", globalRoot: "/fixture/global" }, edgeEpoch: "edge", initiator: false }],
    localPresence: () => [], authoritativeHome: () => null, onReceipt: receipt => { receipts.push(receipt); } });
  const delivery = createHostIntercomDelivery({ store: inbox, broker: { async deliver(_sender: unknown, _endpoint: unknown, message: { id: string }) {
    received.push(message.id); return { delivery: "socket_delivered", retryable: false, outcomeKnown: true, acceptance: { accepted: true, durable: false }, consumption: {
      messageId: message.id, status: "injected", timestamp: 1000, evidence: { kind: "entry", entryId: "physical", sessionId: to.sessionId, activationEpoch: next.activationEpoch } } };
  }, deliverReceipt() {}, deliverControl() {} } as never, endpoint: () => next, sender: () => null, wake() {}, now: clock.now });
  try {
    await bridge.start(); await delivery.ready(to, "ready"); await delivery.ready(to, "ready-again");
    const reply = await bridge.exchange(withHopRequest({ version: 1, holdMs: 0, deadlineMs: 5000, exchange: withHopExchange({ protocol: 5, senderMachine: B, recipientMachine: A,
      generation: { edgeEpoch: "edge", channel: "push", generation: 1 }, frames: [], acknowledgements: [], receipts: inbox.pending({ kind: "receipts", peer: A }), controls: [], presence: [] }) }));
    for (const receipt of reply.exchange.receiptAcknowledgements ?? []) inbox.acknowledgeReceipt({ peer: A, frame: receipt });
    expect(received).toEqual(["receipt-after-restart"]);
    expect(receipts).toHaveLength(1);
    expect(source.retained("outbound", "receipt-after-restart")).toMatchObject({ state: "injected", payloadRetained: false, endpoint: next });
    expect(inbox.pending({ kind: "receipts", peer: A })).toEqual([]);
  } finally { await delivery.stop(); await bridge.stop(); source.close(); inbox.close(); }
}, 5000);

it("acknowledges an old absence receipt after the receiver resumes and proves delivery", async () => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "recovery-old-receipt-")); roots.push(root);
  const clock = { now: () => 1000, later: () => () => {} }, source = openIntercomStore({ file: join(root, "s.db"), machineId: A, clock }), inbox = openIntercomStore({ file: join(root, "i.db"), machineId: B, clock });
  const old = { address: to, machineId: B, homeEpoch: null, activationEpoch: "ended" }, next = { ...old, activationEpoch: "replacement" };
  const bridge = createIntercomBridge({ machineId: A, machineAlias: "source.invalid", store: source, clock, transport: {} as never,
    edges: [{ peer: { machineId: B, alias: "peer.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/core", globalRoot: "/fixture/global" }, edgeEpoch: "edge", initiator: false }],
    localPresence: () => [], authoritativeHome: () => null });
  try {
    source.acceptOutbound({ from, endpoint: old, nextHop: B, message: { id: "resumed", timestamp: 1, content: { text: "kept once" } } });
    const message = source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0];
    inbox.acceptInbound({ peer: A, frame: message });
    inbox.beginDispatch({ id: "resumed", endpoint: old, readiness: "old-ready" });
    inbox.resolveUnknown({ queue: "inbound", id: "resumed", digest: message.identity.digest, proof: { from: old, to: from, digest: message.identity.digest, attempt: 1,
      receipt: { messageId: "resumed", status: "not_injected", timestamp: 1000, evidence: { kind: "absence", sessionId: to.sessionId,
        activationEpoch: "ended", excludedGeneration: "ended", complete: true } } } });
    const [oldReceipt] = inbox.pending({ kind: "receipts", peer: A });
    inbox.rebindInboundAfterAbsence("resumed", next);
    inbox.beginDispatch({ id: "resumed", endpoint: next, readiness: "new-ready" });
    inbox.settleReceipt({ queue: "inbound", peer: A, frame: { from: next, to: from, digest: message.identity.digest, attempt: 1,
      receipt: { messageId: "resumed", status: "injected", timestamp: 1001, evidence: { kind: "entry", entryId: "physical", sessionId: to.sessionId, activationEpoch: "replacement" } } } });
    await bridge.start();
    const reply = await bridge.exchange(withHopRequest({ version: 1, holdMs: 0, deadlineMs: 5000, exchange: withHopExchange({ protocol: 5, senderMachine: B, recipientMachine: A,
      generation: { edgeEpoch: "edge", channel: "push", generation: 1 }, frames: [], acknowledgements: [], receipts: inbox.pending({ kind: "receipts", peer: A }), controls: [], presence: [] }) }));
    expect(reply.exchange.receiptAcknowledgements?.map(item => item.receipt.status)).toContain("not_injected");
    expect(source.retained("outbound", "resumed")).toMatchObject({ state: "injected", payloadRetained: false, endpoint: next });
    // The first acknowledgement can be lost after the source has consumed the new proof.
    const retry = await bridge.exchange(withHopRequest({ version: 1, holdMs: 0, deadlineMs: 5000, exchange: withHopExchange({ protocol: 5, senderMachine: B, recipientMachine: A,
      generation: { edgeEpoch: "edge", channel: "push", generation: 2 }, frames: [], acknowledgements: [], receipts: inbox.pending({ kind: "receipts", peer: A }), controls: [], presence: [] }) }));
    expect(() => inbox.acknowledgeReceipt({ peer: B, frame: oldReceipt })).toThrow(/peer/);
    expect(() => inbox.acknowledgeReceipt({ peer: A, frame: { ...oldReceipt, from: { ...old, activationEpoch: "forged" } } })).toThrow();
    expect(() => inbox.acknowledgeReceipt({ peer: A, frame: { ...oldReceipt, originMachineId: B } })).toThrow(/stream/);
    expect(() => source.isSettledReceipt({ peer: B, frame: { ...oldReceipt, digest: 'f'.repeat(64) } })).toThrow(/digest|identity/);
    expect(() => source.isSettledReceipt({ peer: B, frame: { ...oldReceipt, receipt: { messageId: 'resumed', status: 'injected', timestamp: 1002,
      evidence: { kind: 'entry', entryId: 'conflicting', sessionId: to.sessionId, activationEpoch: 'ended' } } } })).toThrow(/route/);
    for (const receipt of retry.exchange.receiptAcknowledgements ?? []) inbox.acknowledgeReceipt({ peer: A, frame: receipt });
    inbox.acknowledgeReceipt({ peer: A, frame: oldReceipt });
    expect(inbox.pending({ kind: "receipts", peer: A })).toEqual([]);
  } finally { await bridge.stop(); source.close(); inbox.close(); }
}, 5000);

it("acknowledges a lost-link-ack replay of the original endpoint after a safe local activation rebind", async () => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "recovery-replay-")); roots.push(root);
  const clock = { now: () => 1000, later: () => () => {} }, source = openIntercomStore({ file: join(root, "s.db"), machineId: A, clock }), inbox = openIntercomStore({ file: join(root, "i.db"), machineId: B, clock });
  const old = { address: to, machineId: B, homeEpoch: null, activationEpoch: "ended" }, next = { ...old, activationEpoch: "replacement" };
  const receiver = createIntercomBridge({ machineId: B, machineAlias: "peer.invalid", store: inbox, clock, transport: {} as never,
    edges: [{ peer: { machineId: A, alias: "source.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/core", globalRoot: "/fixture/global" }, edgeEpoch: "edge", initiator: false }],
    localPresence: () => [], authoritativeHome: () => ({ sessionId: from.sessionId, machineId: A, epoch: 1, moveId: null, updatedAt: 1 }) });
  try {
    source.acceptOutbound({ from, endpoint: old, nextHop: B, message: { id: "lost-ack", timestamp: 1, content: { text: "x" } } });
    const original = source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0];
    inbox.acceptInbound({ peer: A, frame: original }); inbox.rebindInboundAfterAbsence("lost-ack", next);
    await receiver.start();
    const reply = await receiver.exchange(withHopRequest({ version: 1, holdMs: 0, deadlineMs: 5000, exchange: withHopExchange({ protocol: 5, senderMachine: A, recipientMachine: B,
      generation: { edgeEpoch: "edge", channel: "push", generation: 1 }, frames: [original], acknowledgements: [], receipts: [], controls: [], presence: [] }) }));
    expect(reply.exchange.refusals ?? []).toEqual([]);
    expect(reply.exchange.acknowledgements).toEqual([{ identity: original.identity, kind: "message" , hopSequence: original.identity.sequence }]);
    expect(inbox.retained("inbound", "lost-ack")).toMatchObject({ endpoint: next, state: "queued", latestAttempt: 0 });
  } finally { await receiver.stop(); source.close(); inbox.close(); }
}, 5000);

it("preserves ordinary mail but expires only undelivered asks on a backward clock step", () => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "recovery-clock-")); roots.push(root);
  let time = 1000; const store = openIntercomStore({ file: join(root, "q.db"), machineId: A, clock: { now: () => time } });
  const endpoint = { address: to, machineId: B, homeEpoch: null, activationEpoch: "recipient" };
  try {
    for (const [id, expectsReply] of [["mail", false], ["ask", true]] as const) store.acceptOutbound({ from, endpoint, nextHop: B,
      message: { id, timestamp: 1, content: { text: "x" }, ...(expectsReply ? { expectsReply: true, remainingMs: 1000 } : {}) } });
    time += 1; store.expire(); time -= 1; store.expire();
    expect(store.retained("outbound", "mail")).toMatchObject({ state: "queued", payloadRetained: true });
    expect(store.retained("outbound", "ask")).toMatchObject({ state: "expired", payloadRetained: false });
    store.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "new-ask", timestamp: 1, expectsReply: true, remainingMs: 1000, content: { text: "x" } } });
    expect(store.retained("outbound", "new-ask")).toMatchObject({ state: "queued" });
    time += 1000; store.expire();
    expect(store.retained("outbound", "new-ask")).toMatchObject({ state: "expired", payloadRetained: false });
  } finally { store.close(); }
}, 5000);
