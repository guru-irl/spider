import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDbReadOnly } from "@spider/db-core";
import { openIntercomStore } from "../intercom-store";
import { makeMessageFrame } from "../intercom-codec";
import { createIntercomBridge } from "../intercom-bridge";
import { INTERCOM_PAYLOAD_MS, type IntercomStoreOptions } from "../intercom-contracts";
const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002", C = "00000000-0000-4000-8000-000000000003";
const from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
const endpoint = { address: to, machineId: B, homeEpoch: null, activationEpoch: "recipient" };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f(); });
function fixture(limits?: IntercomStoreOptions["limits"]) {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "retention-")); cleanups.push(() => rmSync(root, { force: true, recursive: true }));
  let time = 1000; const clock = { now: () => time, later: () => () => {} }, file = join(root, "q.db");
  let store = openIntercomStore({ file, machineId: B, clock, limits }); cleanups.push(() => store.close());
  const frame = (id: string, originMachineId = A, address = to) => makeMessageFrame({ from, endpoint: { ...endpoint, address }, sequence: 1,
    originMachineId, message: { id, timestamp: 1, content: { text: "synthetic" } } });
  return { file, clock, frame, get store() { return store; }, advance(ms: number) { time += ms; },
    restart() { store.close(); store = openIntercomStore({ file, machineId: B, clock, limits }); } };
}
it.each(["originMessages", "machineMessages"] as const)("caps %s across arbitrary recipients before taking custody", limit => {
  const f = fixture({ [limit]: 2 });
  for (let i = 0; i < 2; i++) expect(f.store.acceptInbound({ peer: A, frame: f.frame(`accepted-${i}`, A, { ...to, sessionId: `recipient-${i}` }) }).kind).toBe("accepted");
  const full = f.frame("over-quota", limit === "machineMessages" ? C : A, { ...to, sessionId: "other-recipient" });
  expect(f.store.acceptInbound({ peer: full.originMachineId, frame: full })).toEqual({ kind: "refused", reason: "queue-full" });
  expect(f.store.retained("inbound", "accepted-0")).toMatchObject({ payloadRetained: true });
  expect(f.store.retained("inbound", "over-quota")).toBeNull();
  if (limit === "originMessages") expect(f.store.acceptInbound({ peer: C, frame: f.frame("other-origin", C, { ...to, sessionId: "third" }) }).kind).toBe("accepted");
}, 5000);
it.each(["originBytes", "machineBytes"] as const)("caps %s before custody across arbitrary recipients", limit => {
  const f = fixture({ [limit]: 900 });
  const first = f.frame("first"), second = f.frame("second", limit === "machineBytes" ? C : A, { ...to, sessionId: "other" });
  expect(f.store.acceptInbound({ peer: A, frame: first }).kind).toBe("accepted");
  expect(f.store.acceptInbound({ peer: second.originMachineId, frame: second })).toEqual({ kind: "refused", reason: "queue-full" });
}, 5000);
it("prunes acknowledged consumed history but keeps its cursor and acknowledges an old replay", () => {
  const f = fixture(), frame = f.frame("consumed");
  f.store.acceptInbound({ peer: A, frame }); f.store.beginDispatch({ id: frame.identity.id, endpoint, readiness: "ready" });
  f.store.settleReceipt({ queue: "inbound", peer: A, frame: { from: endpoint, to: from, digest: frame.identity.digest, attempt: 1,
    receipt: { messageId: frame.identity.id, status: "injected", timestamp: 1000, evidence: { kind: "entry", entryId: "physical", sessionId: to.sessionId, activationEpoch: endpoint.activationEpoch } } } });
  f.advance(2 * INTERCOM_PAYLOAD_MS + 1); f.store.expire();
  expect(f.store.retained("inbound", "consumed")).not.toBeNull();
  for (const receipt of f.store.pending({ kind: "receipts", peer: A })) f.store.acknowledgeReceipt({ peer: A, frame: receipt });
  f.store.expire(); expect(f.store.retained("inbound", "consumed")).toBeNull();
  const db = openDbReadOnly(f.file)!;
  try { expect(db.prepare("SELECT count(*) AS n FROM intercom_messages").get()).toEqual({ n: 0 }); } finally { db.close(); }
  f.restart(); expect(f.store.acceptInbound({ peer: A, frame }).kind).toBe("duplicate");
  expect(f.store.pending({ kind: "inbound", address: to })).toEqual([]);
}, 5000);
it("prunes expired history after its tombstone and receipt are acknowledged", () => {
  const f = fixture(), frame = f.frame("expired"); f.store.acceptInbound({ peer: A, frame });
  f.advance(INTERCOM_PAYLOAD_MS + 1); f.store.expire();
  for (const receipt of f.store.pending({ kind: "receipts", peer: A })) f.store.acknowledgeReceipt({ peer: A, frame: receipt });
  f.advance(INTERCOM_PAYLOAD_MS + 1); f.store.expire();
  expect(f.store.retained("inbound", "expired")).toBeNull();
}, 5000);
it("reports an expiry once even when the bridge and queue restart", async () => {
  const f = fixture(), notices: string[] = [];
  const peer = { machineId: C, alias: "peer.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot: "/fixture/global" };
  f.store.acceptOutbound({ from, endpoint: { ...endpoint, machineId: C }, nextHop: C, message: { id: "notice", timestamp: 1, content: { text: "x" } } });
  f.advance(INTERCOM_PAYLOAD_MS + 1);
  const make = () => createIntercomBridge({ machineId: B, machineAlias: "local.invalid", edges: [{ peer, edgeEpoch: "edge", initiator: false }],
    store: f.store, clock: f.clock, transport: {} as never, localPresence: () => [], authoritativeHome: () => null, onExpiry: event => { notices.push(event.id); } });
  let bridge = make(); await bridge.start(); await bridge.stop(); f.restart(); bridge = make(); await bridge.start(); await bridge.stop();
  expect(notices).toEqual(["notice"]);
}, 5000);
it("does not expire an already injected ask when only its dispatch deadline passes", () => {
  const f = fixture(); const frame = makeMessageFrame({ from, endpoint, sequence: 1, originMachineId: A,
    message: { id: "question", timestamp: 1, expectsReply: true, remainingMs: 1000, content: { text: "x" } } });
  f.store.acceptInbound({ peer: A, frame }); f.store.beginDispatch({ id: "question", endpoint, readiness: "ready" });
  f.store.settleReceipt({ queue: "inbound", peer: A, frame: { from: endpoint, to: from, digest: frame.identity.digest, attempt: 1,
    receipt: { messageId: "question", status: "injected", timestamp: 1000, evidence: { kind: "entry", entryId: "physical", sessionId: to.sessionId, activationEpoch: endpoint.activationEpoch } } } });
  f.advance(1001); expect(f.store.expire()).toEqual([]);
  expect(f.store.retained("inbound", "question")).toMatchObject({ state: "injected" });
  const db = openDbReadOnly(f.file)!; try { expect(db.prepare("SELECT ask_state FROM intercom_messages WHERE id='question'").get()).toEqual({ ask_state: "open" }); } finally { db.close(); }
}, 5000);

it.each(["originMessages", "machineMessages"] as const)("includes delivered metadata and tombstones in %s rather than only payload bytes", limit => {
  const f = fixture({ [limit]: 1 }), first = f.frame("delivered");
  f.store.acceptInbound({ peer: A, frame: first }); f.store.beginDispatch({ id: "delivered", endpoint, readiness: "ready" });
  f.store.settleReceipt({ queue: "inbound", peer: A, frame: { from: endpoint, to: from, digest: first.identity.digest, attempt: 1,
    receipt: { messageId: "delivered", status: "injected", timestamp: 1000, evidence: { kind: "entry", entryId: "physical", sessionId: to.sessionId, activationEpoch: endpoint.activationEpoch } } } });
  const next = f.frame("more-history", limit === "machineMessages" ? C : A, { ...to, sessionId: "another" });
  expect(f.store.acceptInbound({ peer: next.originMachineId, frame: next })).toEqual({ kind: "refused", reason: "queue-full" });
  const tombstone = { kind: "tombstone" as const, identity: next.identity, endpoint: next.endpoint, originMachineId: next.originMachineId, reason: "cancelled" as const };
  expect(f.store.acceptInbound({ peer: next.originMachineId, frame: tombstone })).toEqual({ kind: "refused", reason: "queue-full" });
  expect(f.store.retained("inbound", "delivered")).toMatchObject({ state: "injected", payloadRetained: false });
}, 5000);
it("aggregates refused frame diagnostics instead of retaining an unbounded identifier set", () => {
  const f = fixture();
  for (let i = 0; i < 50; i++) f.store.recordRejection(A, `forged-${i}`, "sender-unauthorized");
  const db = openDbReadOnly(f.file)!;
  try { expect(db.prepare("SELECT count(*) AS n FROM intercom_rejections").get()).toEqual({ n: 1 }); } finally { db.close(); }
  expect(f.store.rejectionDiagnostics()).toEqual([{ peer: A, reason: "intercom-sender-unauthorized", status: "blocked", since: 1000 }]);
}, 5000);

it("retains an unassigned rejected slot until a valid successor advances its authenticated origin cursor", () => {
  const f = fixture(), bad = f.frame("missing");
  f.store.rejectMissingOrigin({ peer: A, frame: { index: 0, identity: bad.identity, endpoint: bad.endpoint, kind: "message" } });
  for (const receipt of f.store.pending({ kind: "receipts", peer: A })) f.store.acknowledgeReceipt({ peer: A, frame: receipt });
  f.advance(2 * INTERCOM_PAYLOAD_MS + 1); f.store.expire();
  expect(f.store.retained("inbound", "missing")).toMatchObject({ failureReason: "missing-origin" });
  const good = makeMessageFrame({ from, endpoint, sequence: 2, originMachineId: A, message: { id: "successor", timestamp: 1, content: { text: "x" } } });
  expect(f.store.acceptInbound({ peer: A, frame: good }).kind).toBe("accepted");
  f.store.expire(); expect(f.store.retained("inbound", "missing")).toBeNull();
  expect(f.store.retained("inbound", "successor")).toMatchObject({ state: "queued", originMachineId: A });
}, 5000);
