import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openIntercomStore } from "../intercom-store";
import { openDb, paths } from "@spider/db-core";
import type { IntercomExchange, IntercomReceiptFrame } from "../intercom-contracts";
import { decodeExchange, encodeExchange, makeMessageFrame } from "../intercom-codec";

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
const endpoint = { address: to, machineId: B, homeEpoch: 1, activationEpoch: "activation-1" };
const roots: string[] = [], stores: Array<{ close(): void }> = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function twoStores() {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "ix-")); roots.push(root);
  const clock = { now: () => 1_000_000 };
  const source = openIntercomStore({ file: join(root, "source", "queue.db"), machineId: A, clock });
  const inbox = openIntercomStore({ file: join(root, "inbox", "queue.db"), machineId: B, clock });
  stores.push(source, inbox); return { root, source, inbox };
}
function batch(senderMachine = A, recipientMachine = B): IntercomExchange {
  return { protocol: 1, senderMachine, recipientMachine, generation: { edgeEpoch: "edge-1", channel: "push", generation: 1 },
    frames: [], acknowledgements: [], receipts: [], controls: [], presence: [] };
}
function receipt(): IntercomReceiptFrame {
  const frame = makeMessageFrame({ from, endpoint, sequence: 1, message: { id: "message-1", timestamp: 1, content: { text: "synthetic" } } });
  return { from: endpoint, to: from, digest: frame.identity.digest, attempt: 2, receipt: { messageId: "message-1", status: "injected", timestamp: 2,
    evidence: { kind: "entry", entryId: "entry-1", sessionId: to.sessionId, activationEpoch: endpoint.activationEpoch } } };
}

it("round-trips explicit receipt acknowledgements without changing their attempt evidence", () => {
  const input = { ...batch(), receiptAcknowledgements: [receipt()] };
  expect(() => encodeExchange(input)).not.toThrow();
  expect(decodeExchange(encodeExchange(input))).toEqual(input);
}, 5000);


const peer = { machineId: B, alias: "box-1.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot: "/fixture/global" };
async function exchangeApi() {
  const api = await vi.importActual("../intercom-exchange").catch(() => ({})) as { exchange?: (...args: any[]) => Promise<any> };
  expect(api.exchange).toBeTypeOf("function");
  return api.exchange!;
}

it("45-second poll and 20-second push include brackets and adapt the hold at spawn", async () => {
  const exchange = await exchangeApi(), calls: Array<{ argv: readonly string[]; options: any; input: any }> = [];
  const transport = { exec: async (_peer: unknown, argv: readonly string[], options: any) => {
    const input = JSON.parse(options.stdinForTimeout(7000).toString());
    calls.push({ argv, options, input });
    return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-exchange", ok: true,
      value: { version: 1, exchange: { ...batch(B, A), generation: input.exchange.generation } } }));
  } };
  const ports = { transport, store: { edgeState: () => ({ outbound: { poll: 1, push: 1 } }) }, machineId: A, enrollment: { peer, edgeEpoch: "edge-1" }, clock: { now: () => 1000, later: () => () => {} } };
  const poll = { exchange: { ...batch(), generation: { edgeEpoch: "edge-1", channel: "poll", generation: 1 } }, holdMs: 25_000 };
  const push = { exchange: batch(), holdMs: 0 };
  expect((await exchange(peer, poll, ports)).exchange.senderMachine).toBe(B);
  expect((await exchange(peer, push, ports)).exchange.recipientMachine).toBe(A);
  expect(calls.map(call => call.argv)).toEqual([["roam", "intercom", "exchange"], ["roam", "intercom", "exchange"]]);
  expect(calls.map(call => [call.options.timeoutMs, call.options.remoteTimeoutMs, call.options.postReserveMs, call.options.maxBytes])).toEqual([
    [45_000, 30_000, 5000, 512 * 1024], [20_000, 10_000, 5000, 512 * 1024],
  ]);
  expect(calls.map(call => [call.input.holdMs, call.input.deadlineMs])).toEqual([[2000, 7000], [0, 7000]]);
}, 5000);

it("rejects malformed, stale, and identity-mismatched exchange outcomes without trusting them", async () => {
  const exchange = await exchangeApi();
  const input = { exchange: batch(), holdMs: 0 };
  let response = Buffer.from("{");
  const transport = { exec: async () => response };
  const ports = { transport, store: { edgeState: () => ({ outbound: { poll: 1, push: 1 } }) }, machineId: A, enrollment: { peer, edgeEpoch: "edge-1" }, clock: { now: () => 1000, later: () => () => {} } };
  await expect(exchange(peer, input, ports)).rejects.toMatchObject({ code: "invalid-reply" });
  response = Buffer.from(JSON.stringify({ version: 1, kind: "intercom-exchange", ok: true, value: { version: 1, exchange: batch(A, B) } }));
  await expect(exchange(peer, input, ports)).rejects.toMatchObject({ code: "machine-mismatch" });
  response = Buffer.from(JSON.stringify({ version: 1, kind: "intercom-exchange", ok: true, value: { version: 1,
    exchange: { ...batch(B, A), generation: { ...batch().generation, generation: 0 } } } }));
  await expect(exchange(peer, input, ports)).rejects.toMatchObject({ code: "invalid-reply" });
}, 5000);

it("preserves a named hc failure but never exposes its stderr or falls back locally", async () => {
  const exchange = await exchangeApi();
  let calls = 0;
  const transport = { exec: async () => { calls++; throw Object.assign(new Error("synthetic-secret-body"), { code: "needs_login", details: { stderr: "synthetic-secret-body" } }); } };
  const ports = { transport, store: { edgeState: () => ({ outbound: { poll: 1, push: 1 } }) }, machineId: A, enrollment: { peer, edgeEpoch: "edge-1" }, clock: { now: () => 1000, later: () => () => {} } };
  const result = await exchange(peer, { exchange: batch(), holdMs: 0 }, ports).catch((error: unknown) => error);
  expect(result).toMatchObject({ code: "needs_login" });
  expect(JSON.stringify(result)).not.toContain("synthetic-secret-body");
  expect(String(result)).not.toContain("synthetic-secret-body");
  expect(calls).toBe(1);
}, 5000);


it("retains the authenticated previous and next hops for receipt reconciliation", () => {
  const { source, inbox } = twoStores();
  source.acceptOutbound({ from, endpoint, nextHop: B, message: { id: "route", timestamp: 1, content: { text: "synthetic" } } });
  const frame = source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0];
  inbox.acceptInbound({ peer: A, frame });
  expect(source.retained("outbound", "route")).toMatchObject({ peer: B });
  expect(inbox.retained("inbound", "route")).toMatchObject({ peer: A });
}, 5000);

it("reserves receipt batch space without marking omitted receipts sent", () => {
  const { source, inbox } = twoStores();
  for (const id of ["one", "two"]) source.acceptOutbound({ from, endpoint, nextHop: B, message: { id, timestamp: 1, content: { text: "synthetic" } } });
  const frames = source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 });
  const received = frames.map(frame => {
    inbox.acceptInbound({ peer: A, frame }); inbox.beginDispatch({ id: frame.identity.id, endpoint, readiness: "ready" });
    const observed: IntercomReceiptFrame = { from: endpoint, to: from, digest: frame.identity.digest, attempt: 1,
      receipt: { messageId: frame.identity.id, status: "unknown", timestamp: 2 } };
    inbox.settleReceipt({ queue: "inbound", peer: A, frame: observed }); return observed;
  });
  const maxBytes = 2 + Buffer.byteLength(JSON.stringify(received[0])) + 1;
  const first = inbox.pending({ kind: "receipts", peer: A, maxBytes } as { kind: "receipts"; peer: string; maxBytes: number });
  expect(first).toEqual([received[0]]);
  expect(() => inbox.acknowledgeReceipt({ peer: A, frame: received[1] })).toThrow(/handoff|sent/i);
  inbox.acknowledgeReceipt({ peer: A, frame: received[0] });
  expect(inbox.pending({ kind: "receipts", peer: A }).map(item => item.receipt.messageId)).toEqual(["two"]);
}, 5000);


it("persists independent edge generations and outages in the private store across restart", () => {
  const { root, source } = twoStores();
  const api = source as unknown as { edgeState?: (peer: string, epoch: string) => any; updateEdgeState?: (peer: string, epoch: string, change: (state: any) => any) => any };
  expect(api.edgeState).toBeTypeOf("function"); expect(api.updateEdgeState).toBeTypeOf("function");
  expect(api.edgeState!(B, "edge-1")).toMatchObject({ outbound: { poll: 0, push: 0 }, inbound: { poll: 0, push: 0 }, status: "unknown" });
  api.updateEdgeState!(B, "edge-1", state => ({ ...state, outbound: { poll: 2, push: 1 }, inbound: { poll: 4, push: 3 },
    status: "down", outageSince: 100, reason: "needs_login" }));
  expect(() => api.updateEdgeState!(B, "edge-1", state => ({ ...state, outbound: { ...state.outbound, poll: 1 } }))).toThrow();
  source.close();
  const reopened = openIntercomStore({ file: join(root, "source", "queue.db"), machineId: A, clock: { now: () => 1_000_000 } }); stores.push(reopened);
  expect((reopened as unknown as typeof api).edgeState!(B, "edge-1")).toMatchObject({ outbound: { poll: 2, push: 1 }, inbound: { poll: 4, push: 3 }, status: "down", outageSince: 100, reason: "needs_login" });
  expect((reopened as unknown as typeof api).edgeState!(B, "edge-2")).toMatchObject({ outbound: { poll: 0, push: 0 }, status: "unknown" });
}, 5000);


it("does not silently reset durable edge generations if a migrated table is lost", () => {
  const { root, source } = twoStores();
  source.updateEdgeState(B, "edge-1", state => ({ ...state, inbound: { ...state.inbound, poll: 5 } }));
  source.close();
  const file = join(root, "source", "queue.db"), corrupt = openDb(file);
  try { corrupt.exec("DROP TABLE intercom_edge_state"); } finally { corrupt.close(); }
  expect(() => { const reopened = openIntercomStore({ file, machineId: A, clock: { now: () => 1_000_000 } }); reopened.close(); }).toThrow(/schema|missing|invalid/i);
}, 5000);


it("rejects an adversarial late reply after its own persisted generation is superseded", async () => {
  const exchange = await exchangeApi();
  let current = 1, release!: (value: Buffer) => void;
  const store = { edgeState: () => ({ outbound: { push: current, poll: 100 } }) };
  const transport = { exec: async () => new Promise<Buffer>(resolveReply => { release = resolveReply; }) };
  const ports = { transport, store, machineId: A, enrollment: { peer, edgeEpoch: "edge-1" }, clock: { now: () => 1000, later: () => () => {} } };
  const pending = exchange(peer, { exchange: batch(), holdMs: 0 }, ports);
  current = 2;
  release(Buffer.from(JSON.stringify({ version: 1, kind: "intercom-exchange", ok: true, value: { version: 1, exchange: batch(B, A) } })));
  await expect(pending).rejects.toMatchObject({ code: "stale-generation" });
}, 5000);
