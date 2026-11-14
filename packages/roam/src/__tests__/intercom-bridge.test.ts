import { paths } from "@spider/db-core";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openIntercomStore } from "../intercom-store";
import type { IntercomExchange, IntercomReceiptFrame } from "../intercom-contracts";

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002", C = "00000000-0000-4000-8000-000000000003";
const from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
const endpoint = { address: to, machineId: B, homeEpoch: 1, activationEpoch: "activation-1" };
const reverseEndpoint = { address: from, machineId: A, homeEpoch: 1, activationEpoch: "activation-2" };
const roots: string[] = [], resources: Array<{ stop(): Promise<void> }> = [], stores: Array<{ close(): void }> = [];
afterEach(async () => { for (const resource of resources.splice(0)) await resource.stop(); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const clock = { now: () => Date.now(), later: (ms: number, fn: () => void) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } };
const peer = (machineId: string) => ({ machineId, alias: `fixture-${machineId.slice(-1)}.invalid`, node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot: "/fixture/global" });
const batch = (senderMachine: string, recipientMachine: string, generation: number, channel: "push" | "poll" = "push"): IntercomExchange => ({
  protocol: 1, senderMachine, recipientMachine, generation: { edgeEpoch: "edge-1", channel, generation },
  frames: [], acknowledgements: [], receipts: [], controls: [], presence: [],
});
const request = (exchange: IntercomExchange, holdMs = 0) => ({ version: 1, exchange, holdMs, deadlineMs: holdMs ? holdMs + 5000 : 5000 });
async function create(machineId: string, other: string, store: ReturnType<typeof openIntercomStore>, overrides: Record<string, unknown> = {}) {
  const api = await vi.importActual("../intercom-bridge").catch(() => ({})) as { createIntercomBridge?: (ports: any) => any };
  expect(api.createIntercomBridge).toBeTypeOf("function");
  const bridge = api.createIntercomBridge!({ machineId, machineAlias: `fixture-${machineId.slice(-1)}.invalid`, edges: [{ peer: peer(other), edgeEpoch: "edge-1", initiator: false }],
    store, clock, transport: { resolve: async () => { throw new Error("unexpected remote call"); }, exec: async () => { throw new Error("unexpected remote call"); } },
    localPresence: () => [], authoritativeHome: () => null, ...overrides });
  resources.push(bridge); await bridge.start(); return bridge;
}
function pair() {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "ib-")); roots.push(root);
  const source = openIntercomStore({ file: join(root, "source", "queue.db"), machineId: A, clock });
  const inbox = openIntercomStore({ file: join(root, "inbox", "queue.db"), machineId: B, clock });
  stores.push(source, inbox); return { source, inbox };
}

it("acks only durable acceptance and never treats a link ack as consumption", async () => {
  const { source, inbox } = pair(), a = await create(A, B, source), b = await create(B, A, inbox);
  source.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "m1", timestamp: 1, content: { text: "synthetic" } } });
  const frame = source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0];
  const inbound = batch(A, B, 1); inbound.frames.push(frame);
  const accepted = await b.exchange(request(inbound));
  expect(accepted.exchange.acknowledgements).toEqual([{ identity: frame.identity, kind: "message" }]);
  expect(inbox.retained("inbound", "m1")).toMatchObject({ payloadRetained: true, state: "queued" });
  const confirmation = batch(B, A, 1); confirmation.acknowledgements = accepted.exchange.acknowledgements;
  await a.exchange(request(confirmation));
  expect(source.retained("outbound", "m1")).toMatchObject({ linkAcknowledged: true, payloadRetained: true });
}, 5000);

it("forwards a durable receipt and stops replay only after its explicit acknowledgement", async () => {
  const { source, inbox } = pair(), a = await create(A, B, source), b = await create(B, A, inbox);
  source.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "m2", timestamp: 1, content: { text: "synthetic" } } });
  const frame = source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0];
  const initial = batch(A, B, 1); initial.frames.push(frame); await b.exchange(request(initial));
  inbox.beginDispatch({ id: "m2", endpoint, readiness: "ready" });
  const receipt: IntercomReceiptFrame = { from: endpoint, to: from, digest: frame.identity.digest, attempt: 1,
    receipt: { messageId: "m2", status: "injected", timestamp: 2, evidence: { kind: "entry", entryId: "entry-1", sessionId: to.sessionId, activationEpoch: endpoint.activationEpoch } } };
  inbox.settleReceipt({ queue: "inbound", peer: A, frame: receipt });
  const poll = await b.exchange(request(batch(A, B, 1, "poll")));
  expect(poll.exchange.receipts).toEqual([receipt]);
  const delivery = batch(B, A, 1); delivery.receipts = poll.exchange.receipts;
  const ack = await a.exchange(request(delivery));
  expect(source.retained("outbound", "m2")).toMatchObject({ state: "injected", payloadRetained: false });
  expect(ack.exchange.receiptAcknowledgements).toEqual([receipt]);
  expect(inbox.pending({ kind: "receipts", peer: A })).toEqual([receipt]);
  const confirmed = batch(A, B, 3); confirmed.receiptAcknowledgements = ack.exchange.receiptAcknowledgements;
  await b.exchange(request(confirmed));
  expect(inbox.pending({ kind: "receipts", peer: A })).toEqual([]);
}, 5000);

it("a newer poll preempts the old generation and only the new one can claim queued frames", async () => {
  const { inbox } = pair(), b = await create(B, A, inbox);
  const old = b.exchange(request(batch(A, B, 1, "poll"), 2000));
  inbox.acceptOutbound({ from: to, endpoint: reverseEndpoint, nextHop: A, message: { id: "out", timestamp: 1, content: { text: "synthetic" } } });
  const begun = performance.now(), current = b.exchange(request(batch(A, B, 2, "poll")));
  const older = await old;
  expect(performance.now() - begun).toBeLessThan(100);
  const newer = await current;
  expect(older.exchange.frames).toEqual([]);
  expect(newer.exchange.frames.map((frame: any) => frame.identity.id)).toEqual(["out"]);
  await expect(b.exchange(request(batch(A, B, 1, "poll")))).rejects.toMatchObject({ code: "stale-generation" });
}, 5000);

it("wakes a waiting long-poll when local outbound work arrives", async () => {
  const { inbox } = pair(), b = await create(B, A, inbox);
  const waiting = b.exchange(request(batch(A, B, 1, "poll"), 25_000));
  inbox.acceptOutbound({ from: to, endpoint: reverseEndpoint, nextHop: A, message: { id: "wake", timestamp: 1, content: { text: "synthetic" } } });
  const begun = performance.now(); b.wake(A);
  const result = await waiting;
  expect(performance.now() - begun).toBeLessThan(25);
  expect(result.exchange.frames.map((frame: any) => frame.identity.id)).toEqual(["wake"]);
}, 5000);

it("rejects unenrolled machines and wrong epochs before mutating durable queues", async () => {
  const { inbox } = pair(), b = await create(B, A, inbox);
  const wrong = batch(A, B, 1); wrong.generation.edgeEpoch = "stale-edge";
  await expect(b.exchange(request(wrong))).rejects.toMatchObject({ code: "machine-not-enrolled" });
  expect(inbox.edgeState(A, "edge-1").inbound.push).toBe(0);
}, 5000);


it("reserves the full 45-second poll bracket plus allowance for a response ask", async () => {
  const { inbox } = pair(), b = await create(B, A, inbox);
  inbox.acceptOutbound({ from: to, endpoint: reverseEndpoint, nextHop: A, message: { id: "short-poll", timestamp: 1, expectsReply: true,
    remainingMs: 40_000, content: { text: "synthetic" } } });
  const response = await b.exchange(request(batch(A, B, 1, "poll")));
  expect(response.exchange.frames[0]).toMatchObject({ kind: "tombstone", reason: "expired", identity: { id: "short-poll" } });
  expect(inbox.retained("outbound", "short-poll")).toMatchObject({ state: "expired", payloadRetained: false });
}, 5000);


it("does not put the same responder payload in both poll and push replies", async () => {
  const { inbox } = pair(), b = await create(B, A, inbox);
  inbox.acceptOutbound({ from: to, endpoint: reverseEndpoint, nextHop: A, message: { id: "one-response", timestamp: 1, expectsReply: true,
    remainingMs: 300_000, content: { text: "synthetic" } } });
  const poll = await b.exchange(request(batch(A, B, 1, "poll")));
  const push = await b.exchange(request(batch(A, B, 1, "push")));
  expect(poll.exchange.frames.map((frame: any) => frame.identity.id)).toEqual(["one-response"]);
  expect(push.exchange.frames).toEqual([]);
}, 5000);


it("a push generation does not preempt a waiting poll generation", async () => {
  const { inbox } = pair(), b = await create(B, A, inbox);
  let settled = false;
  const poll = b.exchange(request(batch(A, B, 1, "poll"), 25_000)).then((value: unknown) => { settled = true; return value; });
  await b.exchange(request(batch(A, B, 1, "push")));
  await Promise.resolve(); expect(settled).toBe(false);
  inbox.acceptOutbound({ from: to, endpoint: reverseEndpoint, nextHop: A, message: { id: "still-polling", timestamp: 1, content: { text: "synthetic" } } });
  b.wake(A);
  const result = await poll;
  expect(result.exchange.frames.map((frame: any) => frame.identity.id)).toEqual(["still-polling"]);
}, 5000);

it("a stale generation applies neither acknowledgements nor cancellations", async () => {
  const { source, inbox } = pair(), a = await create(A, B, source), b = await create(B, A, inbox);
  source.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "fenced", timestamp: 1, content: { text: "synthetic" } } });
  const frame = source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0];
  const initial = batch(A, B, 1); initial.frames.push(frame); await b.exchange(request(initial));
  await a.exchange(request(batch(B, A, 3))); await b.exchange(request(batch(A, B, 3)));
  const oldAck = batch(B, A, 2); oldAck.acknowledgements.push({ identity: frame.identity, kind: "message" });
  await expect(a.exchange(request(oldAck))).rejects.toMatchObject({ code: "stale-generation" });
  const oldControl = batch(A, B, 2); oldControl.controls.push({ from, to, control: { messageId: "fenced", action: "cancel", timestamp: 3 } });
  await expect(b.exchange(request(oldControl))).rejects.toMatchObject({ code: "stale-generation" });
  expect(source.retained("outbound", "fenced")).toMatchObject({ linkAcknowledged: false, payloadRetained: true });
  expect(inbox.retained("inbound", "fenced")).toMatchObject({ state: "queued", payloadRetained: true });
}, 5000);


it("reports receiver quota refusal without acknowledging or evicting accepted mail", async () => {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "quota-")); roots.push(root);
  const source = openIntercomStore({ file: join(root, "source", "queue.db"), machineId: A, clock });
  const inbox = openIntercomStore({ file: join(root, "inbox", "queue.db"), machineId: B, clock, limits: { queueMessages: 1 } });
  stores.push(source, inbox);
  const refused: unknown[] = [], a = await create(A, B, source, { onRefusal: (value: unknown) => refused.push(value) }), b = await create(B, A, inbox);
  for (const id of ["kept", "overflow"]) source.acceptOutbound({ from, endpoint, nextHop: B, message: { id, timestamp: 1, content: { text: "synthetic" } } });
  const frames = source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 });
  const first = batch(A, B, 1); first.frames.push(frames[0]); await b.exchange(request(first));
  const second = batch(A, B, 2); second.frames.push(frames[1]);
  const response = await b.exchange(request(second));
  expect(response.exchange.acknowledgements).toEqual([]);
  expect(response.exchange.refusals).toEqual([{ identity: frames[1].identity, reason: "queue-full" }]);
  const report = batch(B, A, 1) as IntercomExchange & { refusals: unknown[] }; report.refusals = response.exchange.refusals;
  await a.exchange(request(report));
  expect(refused).toEqual([{ peer: B, identity: frames[1].identity, reason: "queue-full" }]);
  expect(source.retained("outbound", "overflow")).toMatchObject({ linkAcknowledged: false, payloadRetained: true });
  expect(inbox.retained("inbound", "kept")).toMatchObject({ state: "queued", payloadRetained: true });
}, 5000);


it("replays explicit cancellation after restart and notifies the receiving runtime", async () => {
  const { root, source, inbox } = (() => { const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "cancel-")); roots.push(root);
    const source = openIntercomStore({ file: join(root, "source", "queue.db"), machineId: A, clock });
    const inbox = openIntercomStore({ file: join(root, "inbox", "queue.db"), machineId: B, clock }); stores.push(source, inbox); return { root, source, inbox }; })();
  const notices: unknown[] = [], a = await create(A, B, source), b = await create(B, A, inbox, { onControl: (frame: unknown) => notices.push(frame) });
  source.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "cancel-me", timestamp: 1, content: { text: "synthetic" } } });
  const frame = source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0];
  const first = batch(A, B, 1); first.frames.push(frame); await b.exchange(request(first));
  a.control(from, to, { messageId: "cancel-me", action: "cancel", timestamp: 2 });
  await a.stop(); source.close();
  const reopened = openIntercomStore({ file: join(root, "source", "queue.db"), machineId: A, clock }); stores.push(reopened);
  const tombstone = reopened.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0];
  expect(tombstone).toMatchObject({ kind: "tombstone", reason: "cancelled" });
  const retry = batch(A, B, 2); retry.frames.push(tombstone); await b.exchange(request(retry));
  expect(inbox.retained("inbound", "cancel-me")).toMatchObject({ state: "cancelled" });
  expect(notices).toEqual([expect.objectContaining({ from, to, control: expect.objectContaining({ messageId: "cancel-me", action: "cancel" }) })]);
}, 5000);


it("closed bridge intake cannot accept a new durable dispatch", async () => {
  const { source } = pair(), a = await create(A, B, source); await a.stop();
  const destination = { remote: true, id: to.sessionId, address: to, machineId: B, machineAlias: "fixture-b.invalid", homeEpoch: 1,
    activationEpoch: endpoint.activationEpoch, endpointEpoch: endpoint.activationEpoch, cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1 };
  const result = await a.dispatch({ from, to: destination, message: { id: "after-stop", timestamp: 1, content: { text: "synthetic" } } });
  expect(result).toMatchObject({ delivery: "failed", reason: "bridge-unavailable" });
  expect(source.retained("outbound", "after-stop")).toBeNull();
}, 5000);


it("relays a later cancellation tombstone instead of replaying the old payload", async () => {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "relay-")); roots.push(root);
  const source = openIntercomStore({ file: join(root, "a", "queue.db"), machineId: A, clock });
  const relay = openIntercomStore({ file: join(root, "b", "queue.db"), machineId: B, clock });
  const inbox = openIntercomStore({ file: join(root, "c", "queue.db"), machineId: C, clock }); stores.push(source, relay, inbox);
  const destination = { ...endpoint, machineId: C }, controls: unknown[] = [];
  const bridge = await create(B, A, relay, { edges: [{ peer: peer(A), edgeEpoch: "edge-1", initiator: false }, { peer: peer(C), edgeEpoch: "edge-1", initiator: false }], routeTo: () => C });
  const receiver = await create(C, B, inbox, { onControl: (frame: unknown) => controls.push(frame) });
  source.acceptOutbound({ from, endpoint: destination, nextHop: B, message: { id: "relayed-cancel", timestamp: 1, content: { text: "synthetic" } } });
  const original = source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0];
  const initial = batch(A, B, 1); initial.frames.push(original); await bridge.exchange(request(initial));
  expect(relay.retained("outbound", "relayed-cancel")).toMatchObject({ state: "queued" });
  source.cancel({ queue: "outbound", id: "relayed-cancel", from, to });
  const tombstone = source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0];
  const cancelled = batch(A, B, 2); cancelled.frames.push(tombstone); await bridge.exchange(request(cancelled));
  expect(relay.retained("outbound", "relayed-cancel")).toMatchObject({ state: "cancelled" });
  const forwarded = relay.pending({ kind: "outbound", peer: C, hopBudgetMs: 100 })[0];
  expect(forwarded).toMatchObject({ kind: "tombstone", reason: "cancelled" });
  const last = batch(B, C, 1); last.frames.push(forwarded); await receiver.exchange(request(last));
  expect(inbox.retained("inbound", "relayed-cancel")).toMatchObject({ state: "cancelled" });
  expect(controls).toEqual([expect.objectContaining({ control: expect.objectContaining({ messageId: "relayed-cancel", action: "cancel" }) })]);
}, 5000);


it("relays a separately delivered cancellation control before another payload can leave", async () => {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "relay-control-")); roots.push(root);
  const source = openIntercomStore({ file: join(root, "a", "queue.db"), machineId: A, clock });
  const relay = openIntercomStore({ file: join(root, "b", "queue.db"), machineId: B, clock }); stores.push(source, relay);
  const bridge = await create(B, A, relay, { edges: [{ peer: peer(A), edgeEpoch: "edge-1", initiator: false }, { peer: peer(C), edgeEpoch: "edge-1", initiator: false }], routeTo: () => C });
  const destination = { ...endpoint, machineId: C };
  source.acceptOutbound({ from, endpoint: destination, nextHop: B, message: { id: "relay-control", timestamp: 1, content: { text: "synthetic" } } });
  const first = batch(A, B, 1); first.frames.push(source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0]); await bridge.exchange(request(first));
  const control = batch(A, B, 2); control.controls.push({ from, to, control: { messageId: "relay-control", action: "cancel", timestamp: 2 } });
  await bridge.exchange(request(control));
  expect(relay.retained("outbound", "relay-control")).toMatchObject({ state: "cancelled" });
  expect(relay.pending({ kind: "outbound", peer: C, hopBudgetMs: 100 })[0]).toMatchObject({ kind: "tombstone", reason: "cancelled" });
}, 5000);


it("relays downstream quota refusals to the original sender without dropping the queued copy", async () => {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "relay-refusal-")); roots.push(root);
  const source = openIntercomStore({ file: join(root, "a", "queue.db"), machineId: A, clock });
  const relay = openIntercomStore({ file: join(root, "b", "queue.db"), machineId: B, clock }); stores.push(source, relay);
  const notices: unknown[] = [], sender = await create(A, B, source, { onRefusal: (value: unknown) => notices.push(value) });
  const bridge = await create(B, A, relay, { edges: [{ peer: peer(A), edgeEpoch: "edge-1", initiator: false }, { peer: peer(C), edgeEpoch: "edge-1", initiator: false }], routeTo: () => C });
  source.acceptOutbound({ from, endpoint: { ...endpoint, machineId: C }, nextHop: B, message: { id: "relay-full", timestamp: 1, content: { text: "synthetic" } } });
  const frame = source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0];
  const first = batch(A, B, 1); first.frames.push(frame); await bridge.exchange(request(first));
  const refusal = batch(C, B, 1); refusal.refusals = [{ identity: frame.identity, reason: "queue-full" }]; await bridge.exchange(request(refusal));
  const returned = await bridge.exchange(request(batch(A, B, 1, "poll")));
  expect(returned.exchange.refusals).toEqual([{ identity: frame.identity, reason: "queue-full" }]);
  const notify = batch(B, A, 1); notify.refusals = returned.exchange.refusals; await sender.exchange(request(notify));
  expect(notices).toEqual([{ peer: B, identity: frame.identity, reason: "queue-full" }]);
  expect(relay.retained("outbound", "relay-full")).toMatchObject({ state: "queued", payloadRetained: true });
}, 5000);


it("does not let a remote presence hint shadow a local session and prefers the newest home epoch", async () => {
  const { source } = pair(), observed: any[] = [];
  const local = { remote: true as const, id: from.sessionId, address: from, machineId: A, machineAlias: "local.invalid", homeEpoch: 5,
    activationEpoch: "local-epoch", endpointEpoch: "local-epoch", cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1 };
  const hint = (machineId: string, address: typeof to, homeEpoch: number, name: string) => ({ ...local, id: address.sessionId, address, machineId, machineAlias: `${name}.invalid`, homeEpoch, name });
  source.updateEdgeState(B, "edge-1", old => ({ ...old, status: "live", lastSuccess: clock.now(), roster: [hint(B, from, 99, "shadow"), hint(B, to, 1, "old")] }));
  source.updateEdgeState(C, "edge-1", old => ({ ...old, status: "down", outageSince: clock.now(), roster: [hint(C, to, 2, "new")] }));
  await create(A, B, source, { edges: [{ peer: peer(B), edgeEpoch: "edge-1", initiator: false }, { peer: peer(C), edgeEpoch: "edge-1", initiator: false }],
    localPresence: () => [local], publishPresence: (entries: unknown[]) => observed.push(entries) });
  expect(observed.at(-1)).toEqual([expect.objectContaining({ address: to, machineId: C, homeEpoch: 2, stale: true })]);
}, 5000);


it("does not route from an old presence hint over a newer authoritative home", async () => {
  const { source } = pair(), a = await create(A, B, source, { authoritativeHome: () => ({ sessionId: to.sessionId, machineId: C, epoch: 2, moveId: null, updatedAt: 1 }) });
  const hint = { remote: true, id: to.sessionId, address: to, machineId: B, machineAlias: "old.invalid", homeEpoch: 1,
    activationEpoch: endpoint.activationEpoch, endpointEpoch: endpoint.activationEpoch, cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1 };
  expect(await a.dispatch({ from, to: hint, message: { id: "old-home", timestamp: 1, content: { text: "synthetic" } } })).toMatchObject({ delivery: "failed", reason: "stale-home-epoch" });
  expect(source.retained("outbound", "old-home")).toBeNull();
}, 5000);


it("relays explicitly authorized stale presence in hub-only mode and refuses asks to the down endpoint", async () => {
  const { source, inbox: hubStore } = pair(), rosters: any[] = [];
  const remote = { remote: true as const, id: to.sessionId, address: to, machineId: C, machineAlias: "box-c.invalid", homeEpoch: 1,
    activationEpoch: "c-activation", endpointEpoch: "c-activation", cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1 };
  hubStore.updateEdgeState(C, "edge-1", old => ({ ...old, status: "down", outageSince: clock.now(), roster: [remote] }));
  const hub = await create(B, A, hubStore, { edges: [{ peer: peer(A), edgeEpoch: "edge-1", initiator: false }, { peer: peer(C), edgeEpoch: "edge-1", initiator: false }],
    advertiseRelay: (recipient: string, entry: typeof remote) => recipient === A && entry.machineId === C });
  const a = await create(A, B, source, { nextHop: (machine: string) => machine === C ? B : null,
    authorizePresence: (previous: string, entry: typeof remote) => previous === B && entry.machineId === C,
    publishPresence: (entries: unknown[]) => rosters.push(entries) });
  const response = await hub.exchange(request(batch(A, B, 1, "poll")));
  expect(response.exchange.presence).toEqual([expect.objectContaining({ machineId: C, stale: true, reachability: "down" })]);
  const publication = batch(B, A, 1); publication.presence = response.exchange.presence; await a.exchange(request(publication));
  const target = rosters.at(-1)[0]; expect(target).toMatchObject({ machineId: C, stale: true, reachability: "down" });
  expect(await a.dispatch({ from, to: target, message: { id: "down-ask", timestamp: 1, expectsReply: true, remainingMs: 120_000, content: { text: "synthetic" } } }))
    .toMatchObject({ delivery: "failed", reason: "link-down" });
  expect(await a.dispatch({ from, to: target, message: { id: "down-mail", timestamp: 1, content: { text: "synthetic" } } }))
    .toMatchObject({ delivery: "queued" });
  expect(source.retained("outbound", "down-mail")).toMatchObject({ peer: B, state: "queued" });
}, 5000);


it("wakes a hub-only poll when a downstream route becomes stale", async () => {
  const { inbox: hubStore } = pair();
  const remote = { remote: true as const, id: to.sessionId, address: to, machineId: C, machineAlias: "box-c.invalid", homeEpoch: 1,
    activationEpoch: "c-activation", endpointEpoch: "c-activation", cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1 };
  hubStore.updateEdgeState(C, "edge-1", old => ({ ...old, status: "live", lastSuccess: clock.now(), roster: [remote] }));
  const hub = await create(B, A, hubStore, { edges: [{ peer: peer(A), edgeEpoch: "edge-1", initiator: false }, { peer: peer(C), edgeEpoch: "edge-1", initiator: false }],
    advertiseRelay: (recipient: string, entry: typeof remote) => recipient === A && entry.machineId === C });
  const waiting = hub.exchange(request(batch(A, B, 1, "poll"), 25_000)), begin = performance.now();
  hub.wake(C);
  const response = await waiting;
  expect(performance.now() - begin).toBeLessThan(100);
  expect(response.exchange.presence).toEqual([expect.objectContaining({ machineId: C, stale: true, reachability: "recovering" })]);
}, 5000);


it("classifies unenrolled destinations and oversized or expired messages as non-retryable", async () => {
  const { source } = pair(), a = await create(A, B, source);
  const target = { remote: true, id: to.sessionId, address: to, machineId: B, machineAlias: "fixture-b.invalid", homeEpoch: 1,
    activationEpoch: endpoint.activationEpoch, endpointEpoch: endpoint.activationEpoch, cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1 };
  const ordinary = { id: "unenrolled", timestamp: 1, content: { text: "synthetic" } };
  expect(await a.dispatch({ from, to: { ...target, machineId: C }, message: ordinary }))
    .toMatchObject({ delivery: "failed", reason: "machine-not-enrolled", retryable: false });
  expect(await a.dispatch({ from, to: target, message: { ...ordinary, id: "oversized", content: { text: "x".repeat(256 * 1024) } } }))
    .toMatchObject({ delivery: "failed", reason: "message-too-large", retryable: false });
  expect(await a.dispatch({ from, to: target, message: { ...ordinary, id: "expired-ask", expectsReply: true, remainingMs: 0 } }))
    .toMatchObject({ delivery: "failed", reason: "ask-expired", retryable: false });
}, 5000);


it("refuses an unenrolled relay destination before accepting its payload", async () => {
  const { source, inbox } = pair(), refusals: unknown[] = [];
  const sender = await create(A, B, source, { onRefusal: (value: unknown) => refusals.push(value) }), relay = await create(B, A, inbox);
  source.acceptOutbound({ from, endpoint: { ...endpoint, machineId: C }, nextHop: B,
    message: { id: "no-route", timestamp: 1, content: { text: "synthetic" } } });
  const frame = source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0], sent = batch(A, B, 1); sent.frames.push(frame);
  const result = await relay.exchange(request(sent));
  expect(result.exchange.acknowledgements).toEqual([]);
  expect(result.exchange.refusals).toEqual([{ identity: frame.identity, reason: "machine-not-enrolled" }]);
  const notify = batch(B, A, 1); notify.refusals = result.exchange.refusals; await sender.exchange(request(notify));
  expect(refusals).toEqual([{ peer: B, identity: frame.identity, reason: "machine-not-enrolled" }]);
  expect(inbox.retained("inbound", "no-route")).toBeNull();
}, 5000);


it("forwards a multihop consumption receipt without notifying a non-origin relay", async () => {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "relay-receipt-")); roots.push(root);
  const source = openIntercomStore({ file: join(root, "a", "queue.db"), machineId: A, clock });
  const relay = openIntercomStore({ file: join(root, "b", "queue.db"), machineId: B, clock });
  const inbox = openIntercomStore({ file: join(root, "c", "queue.db"), machineId: C, clock }); stores.push(source, relay, inbox);
  const originNotices: unknown[] = [], relayNotices: unknown[] = [], destination = { ...endpoint, machineId: C };
  const origin = await create(A, B, source, { onReceipt: (value: unknown) => originNotices.push(value) });
  const hub = await create(B, A, relay, { edges: [{ peer: peer(A), edgeEpoch: "edge-1", initiator: false }, { peer: peer(C), edgeEpoch: "edge-1", initiator: false }],
    onReceipt: (value: unknown) => relayNotices.push(value) });
  const receiver = await create(C, B, inbox);
  source.acceptOutbound({ from, endpoint: destination, nextHop: B, message: { id: "relay-receipt", timestamp: 1, content: { text: "synthetic" } } });
  const original = source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0], first = batch(A, B, 1); first.frames.push(original); await hub.exchange(request(first));
  const forwarded = relay.pending({ kind: "outbound", peer: C, hopBudgetMs: 100 })[0], last = batch(B, C, 1); last.frames.push(forwarded); await receiver.exchange(request(last));
  inbox.beginDispatch({ id: "relay-receipt", endpoint: destination, readiness: "ready" });
  const receipt: IntercomReceiptFrame = { from: destination, to: from, digest: original.identity.digest, attempt: 1,
    receipt: { messageId: "relay-receipt", status: "injected", timestamp: 2, evidence: { kind: "entry", entryId: "entry-1", sessionId: to.sessionId, activationEpoch: destination.activationEpoch } } };
  inbox.settleReceipt({ queue: "inbound", peer: B, frame: receipt });
  const downstream = batch(C, B, 1); downstream.receipts = [...inbox.pending({ kind: "receipts", peer: B })]; await hub.exchange(request(downstream));
  expect(relayNotices).toEqual([]);
  const upstream = await hub.exchange(request(batch(A, B, 1, "poll")));
  expect(upstream.exchange.receipts).toEqual([receipt]);
  const delivery = batch(B, A, 1); delivery.receipts = upstream.exchange.receipts; await origin.exchange(request(delivery));
  expect(originNotices).toEqual([receipt]);
  expect(source.retained("outbound", "relay-receipt")).toMatchObject({ state: "injected", payloadRetained: false });
}, 5000);


it("reports a failed downstream ask at its origin without cancelling the durable thread", async () => {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "relay-ask-")); roots.push(root);
  let now = 1_000_000, sequence = 0;
  const timers = new Map<number, { at: number; fn(): void }>();
  const fakeClock = { now: () => now, later: (ms: number, fn: () => void) => { const id = ++sequence; timers.set(id, { at: now + ms, fn }); return () => { timers.delete(id); }; } };
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const source = openIntercomStore({ file: join(root, "a", "queue.db"), machineId: A, clock: fakeClock });
  const relay = openIntercomStore({ file: join(root, "b", "queue.db"), machineId: B, clock: fakeClock }); stores.push(source, relay);
  const originFailures: unknown[] = [], relayFailures: unknown[] = [];
  const transport = { resolve: async () => { throw Object.assign(new Error("offline"), { code: "unavailable" }); }, exec: async () => { throw new Error("unexpected"); } };
  const origin = await create(A, B, source, { clock: fakeClock, transport, onAskFailed: (value: unknown) => originFailures.push(value) });
  const hub = await create(B, A, relay, { clock: fakeClock, transport, edges: [{ peer: peer(A), edgeEpoch: "edge-1", initiator: false }, { peer: peer(C), edgeEpoch: "edge-1", initiator: false }],
    onAskFailed: (value: unknown) => relayFailures.push(value) });
  source.acceptOutbound({ from, endpoint: { ...endpoint, machineId: C }, nextHop: B,
    message: { id: "relay-ask", timestamp: 1, expectsReply: true, remainingMs: 180_000, content: { text: "synthetic" } } });
  const frame = source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0], sent = batch(A, B, 1); sent.frames.push(frame); await hub.exchange(request(sent));
  await flush(); expect(relay.edgeState(C, "edge-1").status).toBe("recovering");
  now += 1000; for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.fn(); await flush();
  expect(relay.edgeState(C, "edge-1").status).toBe("down");
  const report = await hub.exchange(request(batch(A, B, 1, "poll")));
  expect(report.exchange.refusals).toEqual([{ identity: frame.identity, reason: "link-down" }]);
  expect(relayFailures).toEqual([]); expect(originFailures).toEqual([]);
  now += 2000; for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.fn(); await flush();
  const retry = await hub.exchange(request(batch(A, B, 2, "poll")));
  expect(retry.exchange.refusals).toEqual([{ identity: frame.identity, reason: "link-down" }]);
  const notify = batch(B, A, 1); notify.refusals = retry.exchange.refusals; await origin.exchange(request(notify));
  expect(originFailures).toEqual([{ peer: B, id: "relay-ask", from, to, reason: "link-down", outcomeKnown: false }]);
  const duplicate = batch(B, A, 2); duplicate.refusals = retry.exchange.refusals; await origin.exchange(request(duplicate));
  expect(originFailures).toHaveLength(1);
  expect(source.retained("outbound", "relay-ask")).toMatchObject({ state: "queued", payloadRetained: true });
}, 5000);
