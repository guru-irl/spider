import { afterEach, expect, it } from "vitest";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { openDbReadOnly } from "@spider/db-core";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { isRemoteSessionInfo, type SessionEndpoint } from "@spider/intercom/protocol";
import { createHostIntercomDelivery } from "../intercom-delivery";
import { readFirstHomeAdoption, recordFirstHomeAdoption, type FirstHomeAdoption } from "../intercom-first-home";
import { recordIntercomGeneration } from "../intercom-exclusion";
import { openIntercomStore } from "../intercom-store";

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002", C = "00000000-0000-4000-8000-000000000003";
const from = { sessionId: "sender", scopeId: "scope" }, to = { sessionId: "recipient", scopeId: "scope" };
const original: SessionEndpoint = { address: to, machineId: B, homeEpoch: null, activationEpoch: "original" };
const adopted: SessionEndpoint = { ...original, homeEpoch: 1 };
const key = JSON.stringify([to.sessionId, "original", B]);
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture(queued = original) {
  const replica = createReplica("global", B); cleanups.push(() => replica.close());
  const clock = { now: () => 1000 };
  let source = openIntercomStore({ file: join(replica.root, "source.db"), machineId: A, clock });
  let inbox = openIntercomStore({ file: join(replica.root, "inbox.db"), machineId: B, clock });
  cleanups.push(() => source.close(), () => inbox.close());
  recordIntercomGeneration(replica.db, { sessionId: to.sessionId, generation: "original", pid: 12345 }, () => ({ kind: "live", startIdentity: "fixture-start" }));
  source.acceptOutbound({ from, endpoint: queued, nextHop: B, message: { id: "before-adoption", timestamp: 1, content: { text: "synthetic retained mail" } } });
  const frame = source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0];
  inbox.acceptInbound({ peer: A, frame });
  const deliveries: Array<{ senderMachine: string; endpoint: SessionEndpoint; id: string }> = [];
  const broker = { async deliver(sender: { machineId: string }, endpoint: SessionEndpoint, message: { id: string }) {
    deliveries.push({ senderMachine: sender.machineId, endpoint, id: message.id });
    return { delivery: "socket_delivered", retryable: false, outcomeKnown: true, acceptance: { accepted: true, durable: false }, consumption: {
      messageId: message.id, status: "injected", timestamp: 1000,
      evidence: { kind: "entry", entryId: "physical-entry", sessionId: to.sessionId, activationEpoch: "original" },
    } } as const;
  }, deliverReceipt() {}, deliverControl() {} };
  const start = (live: SessionEndpoint | null, read = (endpoint: SessionEndpoint) => readFirstHomeAdoption(replica.db, endpoint)) => {
    const delivery = createHostIntercomDelivery({ store: inbox, broker: broker as never, endpoint: () => live, sender: () => null,
      initialHomeAdoption: read, wake() {}, now: clock.now });
    cleanups.push(() => delivery.stop()); return delivery;
  };
  return { ...replica, get source() { return source; }, get inbox() { return inbox; }, frame, deliveries, start,
    restartSource(limits?: { queueMessages?: number }) { source.close(); source = openIntercomStore({ file: join(replica.root, "source.db"), machineId: A, clock, limits }); },
    adopt() { recordFirstHomeAdoption(replica.db, original, adopted, 1000); },
    restart() { inbox.close(); inbox = openIntercomStore({ file: join(replica.root, "inbox.db"), machineId: B, clock }); },
  };
}
it.each([false, true])("delivers pre-adoption mail once with its original endpoint and origin after restart=%s", async restart => {
  const f = fixture(); f.adopt();
  const db = openDbReadOnly(join(f.root, "store.db"))!; cleanups.push(() => db.close());
  if (restart) f.restart();
  const delivery = f.start(adopted, endpoint => readFirstHomeAdoption(db, endpoint));
  await delivery.ready(to, "ready-after-adoption"); await delivery.ready(to, "replayed-readiness");
  expect(f.deliveries).toEqual([{ senderMachine: A, endpoint: adopted, id: "before-adoption" }]);
  expect(f.inbox.retained("inbound", "before-adoption")).toMatchObject({ endpoint: original, originMachineId: A, state: "injected", payloadRetained: false, latestAttempt: 1 });
  const receipts = f.inbox.pending({ kind: "receipts", peer: A });
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({ from: original, to: from, receipt: { messageId: "before-adoption", status: "injected" } });
  f.source.settleReceipt({ queue: "outbound", peer: B, frame: receipts[0] });
  expect(f.source.retained("outbound", "before-adoption")).toMatchObject({ endpoint: original, originMachineId: A, state: "injected", payloadRetained: false });
  f.inbox.acceptInbound({ peer: A, frame: f.frame });
  await delivery.ready(to, "replayed-transfer");
  expect(f.deliveries).toHaveLength(1);
}, 5000);
it.each(["activation", "machine", "later-epoch", "missing-record", "record-activation", "record-machine", "ended", "scope"] as const)("keeps pre-adoption mail fenced for %s", async mode => {
  const f = fixture(); if (mode !== "missing-record") f.adopt();
  if (mode === "record-activation" || mode === "record-machine") {
    const record = readLocal<FirstHomeAdoption>(f.db, "intercom-first-home", key)!;
    writeLocal(f.db, "intercom-first-home", key, { ...record, ...(mode === "record-activation" ? { activation: "other" } : { machine: C }) });
  }
  const live = mode === "ended" ? null : { ...adopted, ...(mode === "activation" ? { activationEpoch: "replacement" } : {}),
    ...(mode === "machine" ? { machineId: C } : {}), ...(mode === "later-epoch" ? { homeEpoch: 2 } : {}), ...(mode === "scope" ? { address: { ...to, scopeId: "other" } } : {}) };
  await f.start(live).ready(to, "not-equivalent");
  expect(f.deliveries).toEqual([]);
  expect(f.inbox.retained("inbound", "before-adoption")).toMatchObject({ endpoint: original, state: "queued", latestAttempt: 0, payloadRetained: true });
  expect(f.inbox.pending({ kind: "receipts", peer: A })).toEqual([]);
  if (live) expect(() => f.inbox.rebindInboundAfterAbsence("before-adoption", live)).toThrow();
}, 5000);
it("does not equate a non-null previous epoch with an adopted endpoint", async () => {
  const other = { ...original, homeEpoch: 2 }, f = fixture(other); f.adopt();
  await f.start(adopted).ready(to, "adopted");
  expect(f.deliveries).toEqual([]);
  expect(f.inbox.retained("inbound", "before-adoption")).toMatchObject({ state: "queued", endpoint: other, latestAttempt: 0 });
}, 5000);
it("keeps the first durable adoption on replay and refuses changed adoption arguments", () => {
  const f = fixture(); f.adopt();
  recordFirstHomeAdoption(f.db, original, adopted, 2000);
  expect(readLocal(f.db, "intercom-first-home", key)).toEqual({ sessionId: to.sessionId, activation: "original", machine: B, fromEpoch: null, toEpoch: 1, adoptedAt: 1000 });
  expect(() => recordFirstHomeAdoption(f.db, original, { ...adopted, homeEpoch: 2 }, 2000)).toThrow("intercom-first-home-conflict");
  expect(() => recordFirstHomeAdoption(f.db, original, { ...adopted, activationEpoch: "other" })).toThrow("intercom-first-home-invalid");
  expect(() => recordFirstHomeAdoption(f.db, original, { ...adopted, machineId: C })).toThrow("intercom-first-home-invalid");
}, 5000);

const attestedPresence = () => ({ remote: true as const, id: to.sessionId, address: to, machineId: B, machineAlias: "target.invalid", homeEpoch: 1,
  activationEpoch: "original", endpointEpoch: "original", cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1,
  firstHome: { activation: "original", fromEpoch: null, toEpoch: 1 } });
it.each([false, true])("continues sends and asks in order exactly once after first-home adoption with source restart=%s", async restart => {
  const f = fixture(); f.adopt(); const delivery = f.start(adopted);
  await delivery.ready(to, "first-home-ready");
  f.source.settleReceipt({ queue: "outbound", peer: B, frame: f.inbox.pending({ kind: "receipts", peer: A })[0] });
  const accepted = f.source.acceptOutbound({ from, endpoint: adopted, nextHop: B, firstHomePresence: attestedPresence(),
    message: { id: "after-adoption", timestamp: 2, content: { text: "synthetic second message" } } });
  expect(accepted).toMatchObject({ kind: "accepted", identity: { sequence: 2 } });
  const db = openDbReadOnly(join(f.root, "source.db"))!;
  try {
    const row = db.prepare("SELECT resume_json FROM intercom_resumptions").get() as { resume_json: string };
    expect(JSON.parse(row.resume_json)).toMatchObject({ reason: "first-home-adoption", from, to, through: 1,
      previousEndpoint: original, endpoint: adopted, attestation: { activation: "original", fromEpoch: null, toEpoch: 1 } });
  } finally { db.close(); }
  expect(f.source.outboundResumptions(B)).toEqual([]);
  if (restart) f.restartSource();
  expect(f.source.acceptOutbound({ from, endpoint: adopted, nextHop: B,
    message: { id: "ask-after-adoption", timestamp: 3, expectsReply: true, remainingMs: 100_000, content: { text: "synthetic question" } } }))
    .toMatchObject({ kind: "accepted", identity: { sequence: 3 } });
  const frames = f.source.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 });
  expect(frames.map(frame => [frame.identity.id, frame.identity.sequence])).toEqual([["after-adoption", 2], ["ask-after-adoption", 3]]);
  for (const frame of frames) f.inbox.acceptInbound({ peer: A, frame });
  await delivery.ready(to, "post-adoption-ready"); await delivery.ready(to, "post-adoption-replay");
  expect(f.deliveries.map(item => item.id)).toEqual(["before-adoption", "after-adoption", "ask-after-adoption"]);
  for (const frame of f.inbox.pending({ kind: "receipts", peer: A })) f.source.settleReceipt({ queue: "outbound", peer: B, frame });
  expect(f.source.retained("outbound", "before-adoption")).toMatchObject({ endpoint: original, state: "injected" });
  expect(f.source.retained("outbound", "after-adoption")).toMatchObject({ endpoint: adopted, state: "injected" });
}, 5000);
it.each(["activation", "machine", "non-null", "missing-attestation", "wrong-attestation", "later-epoch"] as const)("keeps the authoritative outbound rebind requirement for %s", mode => {
  const previous = { ...original, ...(mode === "activation" ? { activationEpoch: "earlier" } : {}),
    ...(mode === "machine" ? { machineId: C } : {}), ...(mode === "non-null" ? { homeEpoch: 2 } : {}) };
  const f = fixture(previous), presence = attestedPresence();
  const evidence = mode === "missing-attestation" ? { ...presence, firstHome: undefined } :
    mode === "wrong-attestation" ? { ...presence, firstHome: { ...presence.firstHome, activation: "forged" } } : presence;
  const endpoint = mode === "later-epoch" ? { ...adopted, homeEpoch: 2 } : adopted;
  expect(() => f.source.acceptOutbound({ from, endpoint, nextHop: B, firstHomePresence: evidence,
    message: { id: "must-stay-fenced", timestamp: 2, content: { text: "synthetic" } } })).toThrow("Intercom route requires authoritative rebind proof");
  expect(f.source.retained("outbound", "must-stay-fenced")).toBeNull();
  expect(f.source.retained("outbound", "before-adoption")).toMatchObject({ endpoint: previous, latestAttempt: 0 });
}, 5000);

it("accepts only an exact first-home attestation bound to the advertised activation and epoch", () => {
  const presence = attestedPresence();
  expect(isRemoteSessionInfo(presence)).toBe(true);
  for (const firstHome of [null, {}, { ...presence.firstHome, activation: "other" }, { ...presence.firstHome, fromEpoch: 0 },
    { ...presence.firstHome, toEpoch: 2 }, { ...presence.firstHome, extra: true }]) {
    expect(isRemoteSessionInfo({ ...presence, firstHome })).toBe(false);
  }
}, 5000);

it("does not persist pair continuity when the new acceptance is refused by quota", () => {
  const f = fixture(); f.restartSource({ queueMessages: 1 });
  expect(f.source.acceptOutbound({ from, endpoint: adopted, nextHop: B, firstHomePresence: attestedPresence(),
    message: { id: "refused-after-adoption", timestamp: 2, content: { text: "synthetic" } } })).toEqual({ kind: "refused", reason: "queue-full" });
  const db = openDbReadOnly(join(f.root, "source.db"))!;
  try { expect(db.prepare("SELECT COUNT(*) AS count FROM intercom_resumptions").get()).toEqual({ count: 0 }); } finally { db.close(); }
  expect(f.source.retained("outbound", "refused-after-adoption")).toBeNull();
}, 5000);
