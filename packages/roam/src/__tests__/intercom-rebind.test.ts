import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createIntercomBridge } from "../intercom-bridge";
import { createHostIntercomDelivery } from "../intercom-delivery";
import { openIntercomStore } from "../intercom-store";

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002", C = "00000000-0000-4000-8000-000000000003";
const from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
const peer = (machineId: string) => ({ machineId, alias: `peer-${machineId.slice(-1)}.invalid`, node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/core", globalRoot: "/fixture/global" });
const resources: Array<{ stop(): Promise<void> }> = [], stores: Array<{ close(): void }> = [], roots: string[] = [];
afterEach(async () => { for (const resource of resources.splice(0).reverse()) await resource.stop(); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
function request(senderMachine: string, recipientMachine: string, channel: "push" | "poll", generation: number) {
  return { version: 1, holdMs: 0, deadlineMs: 5000, exchange: { protocol: 3, senderMachine, recipientMachine, generation: { edgeEpoch: "edge", channel, generation },
    frames: [], acknowledgements: [], receipts: [], controls: [], presence: [] } };
}
it("rebinds a never-dispatched recipient without an impossible absence receipt", () => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "rebind-no-proof-")); roots.push(root);
  const clock = { now: () => 1000 }, source = openIntercomStore({ file: join(root, "source.db"), machineId: A, clock });
  const dest = openIntercomStore({ file: join(root, "dest.db"), machineId: B, clock }); stores.push(source, dest);
  const old = { address: to, machineId: B, homeEpoch: null, activationEpoch: "old" }, next = { ...old, activationEpoch: "new" };
  source.acceptOutbound({ from, endpoint: old, nextHop: B, message: { id: "no-proof", timestamp: 1, content: { text: "synthetic" } } });
  dest.acceptInbound({ peer: A, frame: source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0] });
  dest.rebindInboundAfterAbsence("no-proof", next);
  expect(dest.retained("inbound", "no-proof")).toMatchObject({ state: "queued", endpoint: next, payloadRetained: true });
}, 5000);

it("returns absence and later consumption to the original source after a local generation change", async () => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "rebind-")); roots.push(root);
  const clock = { now: () => 1000, later: () => () => {} }, source = openIntercomStore({ file: join(root, "source.db"), machineId: A, clock }), inbox = openIntercomStore({ file: join(root, "inbox.db"), machineId: B, clock }); stores.push(source, inbox);
  let endpoint = { address: to, machineId: B, homeEpoch: null, activationEpoch: "old" }, sender!: ReturnType<typeof createIntercomBridge>, receiver!: ReturnType<typeof createIntercomBridge>;
  const ids: string[] = [], receipts: unknown[] = [];
  const broker = { async deliver(_from: unknown, _to: unknown, message: { id: string }) { ids.push(message.id); return { delivery: "socket_delivered", retryable: false, outcomeKnown: true, acceptance: { accepted: true, durable: false } } as const; },
    deliverReceipt(_from: unknown, _to: unknown, value: unknown) { receipts.push(value); }, deliverControl() {} };
  const destDelivery = createHostIntercomDelivery({ store: inbox, broker: broker as never, endpoint: () => endpoint, sender: () => null, wake: id => receiver.wake(id), now: clock.now });
  const sourceDelivery = createHostIntercomDelivery({ store: source, broker: broker as never, endpoint: () => null, sender: () => null, wake: id => sender.wake(id), now: clock.now });
  const transport = { resolve: async () => { throw new Error("offline"); }, exec: async () => { throw new Error("offline"); } } as never;
  sender = createIntercomBridge({ machineId: A, machineAlias: "source.invalid", edges: [{ peer: peer(B), edgeEpoch: "edge", initiator: false }], store: source, clock, transport,
    localPresence: () => [], authoritativeHome: () => null, onReceipt: frame => sourceDelivery.onReceipt(frame) });
  receiver = createIntercomBridge({ machineId: B, machineAlias: "target.invalid", edges: [{ peer: peer(A), edgeEpoch: "edge", initiator: false }], store: inbox, clock, transport,
    localPresence: () => [], authoritativeHome: () => ({ sessionId: from.sessionId, machineId: A, epoch: 1, moveId: null, updatedAt: 1 }) });
  resources.push(sender, receiver, sourceDelivery, destDelivery); await sender.start(); await receiver.start();
  source.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "same-id", timestamp: 1, content: { text: "synthetic" } } });
  const frame = source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0], incoming = request(A, B, "push", 1);
  (incoming.exchange.frames as unknown[]).push(frame); await receiver.exchange(incoming);
  await destDelivery.ready(to, "old-ready"); expect(ids).toEqual(["same-id"]);
  receiver.receipt(to, { messageId: "same-id", status: "not_injected", timestamp: 1000,
    evidence: { kind: "absence", sessionId: to.sessionId, activationEpoch: "old", excludedGeneration: "old", complete: true } });
  endpoint = { ...endpoint, activationEpoch: "new" }; await destDelivery.ready(to, "new-ready"); expect(ids).toEqual(["same-id", "same-id"]);
  receiver.receipt(to, { messageId: "same-id", status: "injected", timestamp: 1000,
    evidence: { kind: "entry", entryId: "physical", sessionId: to.sessionId, activationEpoch: "new" } });
  const poll = await receiver.exchange(request(A, B, "poll", 1)); expect(poll.exchange.receipts.map(item => item.receipt.status)).toEqual(["not_injected", "injected"]);
  const returned = request(B, A, "push", 1); (returned.exchange.receipts as unknown[]).push(...poll.exchange.receipts);
  await sender.exchange(returned);
  expect(source.retained("outbound", "same-id")).toMatchObject({ state: "injected", payloadRetained: false, endpoint: { activationEpoch: "new" } });
  expect(receipts).toMatchObject([{ messageId: "same-id", status: "not_injected" }, { messageId: "same-id", status: "injected" }]);
}, 5000);

it("relays old-generation absence and new-generation consumption to the original source", async () => {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "rebind-relay-")); roots.push(root);
  const clock = { now: () => 1000, later: () => () => {} }, source = openIntercomStore({ file: join(root, "source.db"), machineId: A, clock });
  const relay = openIntercomStore({ file: join(root, "relay.db"), machineId: B, clock }), dest = openIntercomStore({ file: join(root, "dest.db"), machineId: C, clock }); stores.push(source, relay, dest);
  const old = { address: to, machineId: C, homeEpoch: null, activationEpoch: "old" }, next = { ...old, activationEpoch: "new" };
  source.acceptOutbound({ from, endpoint: old, nextHop: B, message: { id: "relayed", timestamp: 1, content: { text: "synthetic" } } });
  const first = source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0]; relay.acceptInbound({ peer: A, frame: first }); relay.acceptOutbound({ nextHop: C, frame: first });
  const forwarded = relay.pending({ kind: "outbound", peer: C, hopBudgetMs: 100 })[0]; dest.acceptInbound({ peer: B, frame: forwarded });
  dest.beginDispatch({ id: "relayed", endpoint: old, readiness: "old-ready" });
  const absence = { from: old, to: from, digest: first.identity.digest, attempt: 1, receipt: { messageId: "relayed", status: "not_injected" as const, timestamp: 1000,
    evidence: { kind: "absence" as const, sessionId: to.sessionId, activationEpoch: "old", excludedGeneration: "old", complete: true as const } } };
  dest.settleReceipt({ queue: "inbound", peer: B, frame: absence }); dest.resolveUnknown({ queue: "inbound", id: "relayed", digest: first.identity.digest, proof: absence });
  dest.rebindInboundAfterAbsence("relayed", next); dest.beginDispatch({ id: "relayed", endpoint: next, readiness: "new-ready" });
  dest.settleReceipt({ queue: "inbound", peer: B, frame: { from: next, to: from, digest: first.identity.digest, attempt: 1, receipt: { messageId: "relayed", status: "injected", timestamp: 1000,
    evidence: { kind: "entry", entryId: "physical", sessionId: to.sessionId, activationEpoch: "new" } } } });
  const bridge = createIntercomBridge({ machineId: B, machineAlias: "relay.invalid", edges: [{ peer: peer(A), edgeEpoch: "edge", initiator: false }, { peer: peer(C), edgeEpoch: "edge", initiator: false }],
    store: relay, clock, transport: { resolve: async () => { throw new Error("offline"); }, exec: async () => { throw new Error("offline"); } } as never, localPresence: () => [], authoritativeHome: () => null });
  resources.push(bridge); await bridge.start();
  const incoming = request(C, B, "push", 1); (incoming.exchange.receipts as unknown[]).push(...dest.pending({ kind: "receipts", peer: B }));
  await bridge.exchange(incoming);
  expect(relay.pending({ kind: "receipts", peer: A }).map(item => item.receipt.status)).toEqual(["not_injected", "injected"]);
  expect(relay.retained("outbound", "relayed")).toMatchObject({ state: "injected", endpoint: { activationEpoch: "new" } });
}, 5000);
