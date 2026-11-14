import { afterEach, expect, it } from "vitest";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDb } from "@spider/db-core";
import { scratchDbPath } from "@spider/db-core/testutil";
import type { Message, MessageReceipt, SessionAddress, SessionEndpoint } from "@spider/intercom/protocol";
import { INTERCOM_QUEUE_BYTES, INTERCOM_QUEUE_MESSAGES, type IntercomFrame, type IntercomMessageFrame, type IntercomReceiptFrame, type IntercomReceiptInput } from "../intercom-contracts";
import { openIntercomStore } from "../intercom-store";
import { makeMessageFrame } from "../intercom-codec";

const sourceMachine = "00000000-0000-4000-8000-000000000001";
const targetMachine = "00000000-0000-4000-8000-000000000002";
const nextMachine = "00000000-0000-4000-8000-000000000003";
const sender: SessionAddress = { sessionId: "sender", scopeId: "scope" };
const recipient: SessionAddress = { sessionId: "recipient", scopeId: "scope" };
const endpoint: SessionEndpoint = { address: recipient, machineId: targetMachine, homeEpoch: 2, activationEpoch: "generation-2" };
const opened: Array<{ close(): void }> = [];
const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(join(dirname(scratchDbPath("roam-intercom")), "intercom-"));
  roots.push(value);
  return value;
}
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fakeClock(initial = 1_000_000) {
  let value = initial;
  return { now: () => value, set: (next: number) => { value = next; }, advance: (amount: number) => { value += amount; } };
}
async function open(file: string, machineId: string, clock: ReturnType<typeof fakeClock>, limits?: { queueMessages?: number; queueBytes?: number }) {
  const value = openIntercomStore({ file, machineId, clock, limits });
  opened.push(value);
  return value;
}
type Store = Awaited<ReturnType<typeof open>>;
function mail(id: string, text = `content-${id}`): Message { return { id, timestamp: 500, content: { text } }; }
function send(store: Store, message: Message, target = endpoint, from = sender, peer = targetMachine) {
  const result = store.acceptOutbound({ from, endpoint: target, message, nextHop: peer });
  expect(result.kind).toBe("accepted");
  if (result.kind !== "accepted") throw new Error("message was not accepted");
  return result.identity;
}
function outgoing(store: Store, peer = targetMachine, budget = 100): IntercomFrame[] {
  return [...store.pending({ kind: "outbound", peer, hopBudgetMs: budget })];
}
function incoming(store: Store): string[] { return store.pending({ kind: "inbound", address: recipient }).map(value => value.id); }
function receipt(frame: IntercomMessageFrame, status: "injected" | "not_injected" | "unknown" | "matched_waiter" | "expired", overrides: Partial<MessageReceipt> = {}): IntercomReceiptInput {
  const evidence = status === "injected" ? { kind: "entry" as const, entryId: "entry-1", sessionId: recipient.sessionId, activationEpoch: endpoint.activationEpoch }
    : status === "not_injected" ? { kind: "absence" as const, sessionId: recipient.sessionId, activationEpoch: endpoint.activationEpoch, excludedGeneration: endpoint.activationEpoch, complete: true as const }
    : status === "matched_waiter" ? { kind: "waiter" as const, entryId: "waiter-1", sessionId: recipient.sessionId, activationEpoch: endpoint.activationEpoch, askId: frame.identity.askId ?? "ask" }
    : undefined;
  return { from: endpoint, to: sender, digest: frame.identity.digest, receipt: { messageId: frame.identity.id, status, timestamp: 1_001_000, ...(evidence ? { evidence } : {}), ...overrides } };
}

it("source and inbox commits survive restart", async () => {
  const dir = root(), clock = fakeClock();
  const sourceFile = join(dir, "source", "queue.db"), inboxFile = join(dir, "target", "queue.db");
  let source = await open(sourceFile, sourceMachine, clock), inbox = await open(inboxFile, targetMachine, clock);
  expect(send(source, mail("first")).sequence).toBe(1);
  const frame = outgoing(source)[0] as IntercomMessageFrame;
  expect(inbox.acceptInbound({ peer: sourceMachine, frame }).kind).toBe("accepted");
  source.close(); inbox.close();
  source = await open(sourceFile, sourceMachine, clock); inbox = await open(inboxFile, targetMachine, clock);
  const retry = outgoing(source)[0] as IntercomMessageFrame;
  expect(retry).toMatchObject({ kind: "message", identity: frame.identity, endpoint: frame.endpoint, message: frame.message });
  expect(retry.remainingPayloadMs).toBeLessThanOrEqual(frame.remainingPayloadMs);
  expect(incoming(inbox)).toEqual(["first"]);
  expect(inbox.acceptInbound({ peer: sourceMachine, frame }).kind).toBe("duplicate");
  expect(send(source, mail("second")).sequence).toBe(2);
  await expect(open(sourceFile, targetMachine, clock)).rejects.toThrow(/machine|identity/i);
}, 5000);

it("persists and routes nullable-scope addresses without crossing scopes", async () => {
  const dir = root(), clock = fakeClock();
  const source = await open(join(dir, "source", "queue.db"), sourceMachine, clock);
  const inbox = await open(join(dir, "inbox", "queue.db"), targetMachine, clock);
  const from = { ...sender, scopeId: null }, address = { ...recipient, scopeId: null }, target = { ...endpoint, address };
  expect(() => send(source, mail("one"), target, from)).not.toThrow();
  const frame = outgoing(source)[0];
  expect(frame.identity).toMatchObject({ from, to: address });
  expect(inbox.acceptInbound({ peer: sourceMachine, frame }).kind).toBe("accepted");
  expect(inbox.pending({ kind: "inbound", address }).map(item => item.id)).toEqual(["one"]);
  expect(() => source.acceptOutbound({ from: sender, endpoint: target, message: mail("wrong-scope"), nextHop: targetMachine })).toThrow();
}, 5000);

it("link ack never deletes source payload", async () => {
  const dir = root(), clock = fakeClock(), source = await open(join(dir, "source", "queue.db"), sourceMachine, clock);
  send(source, mail("one", "source-retained-sentinel"));
  const frame = outgoing(source)[0];
  source.acknowledge({ peer: targetMachine, identity: frame.identity, kind: "message" });
  expect(outgoing(source)).toEqual([]);
  expect(source.retained("outbound", "one")).toMatchObject({ payloadRetained: true, linkAcknowledged: true });
  expect(JSON.stringify(source.inspectBlockers(sender))).not.toContain("source-retained-sentinel");
  source.close();
  const reopened = await open(join(dir, "source", "queue.db"), sourceMachine, clock);
  expect(reopened.retained("outbound", "one")).toMatchObject({ payloadRetained: true, linkAcknowledged: true });
}, 5000);

it("changed id content is refused", async () => {
  const dir = root(), clock = fakeClock(), source = await open(join(dir, "queue.db"), sourceMachine, clock);
  const first = send(source, mail("one", "original"));
  const same = source.acceptOutbound({ from: sender, endpoint, message: { ...mail("one", "original"), timestamp: 900 }, nextHop: targetMachine });
  expect(same).toMatchObject({ kind: "duplicate", identity: first });
  expect(() => source.acceptOutbound({ from: sender, endpoint, message: mail("one", "changed"), nextHop: targetMachine })).toThrow(/id|digest|content/i);
  expect(() => source.acceptOutbound({ from: sender, endpoint: { ...endpoint, address: { ...recipient, sessionId: "someone-else" } }, message: mail("one", "original"), nextHop: targetMachine })).toThrow(/id|digest|content/i);
  expect(send(source, mail("two")).sequence).toBe(2);
}, 5000);

it("unknown advances ordering but keeps evidence", async () => {
  const dir = root(), clock = fakeClock();
  const source = await open(join(dir, "source", "queue.db"), sourceMachine, clock);
  let inbox = await open(join(dir, "inbox", "queue.db"), targetMachine, clock);
  send(source, mail("first")); send(source, mail("second"));
  for (const frame of outgoing(source)) inbox.acceptInbound({ peer: sourceMachine, frame });
  expect(incoming(inbox)).toEqual(["first"]);
  const started = inbox.beginDispatch({ id: "first", endpoint, readiness: "ready-1" });
  expect(started.identity.id).toBe("first");
  expect(incoming(inbox)).toEqual(["second"]);
  expect(inbox.inspectBlockers(recipient).unknownOutcomes).toEqual(["first"]);
  inbox.close(); inbox = await open(join(dir, "inbox", "queue.db"), targetMachine, clock);
  expect(incoming(inbox)).toEqual(["second"]);
  expect(inbox.retained("inbound", "first")).toMatchObject({ state: "unknown", payloadRetained: true });
  expect(inbox.inspectBlockers(recipient).unknownOutcomes).toEqual(["first"]);
}, 5000);

it("absence proof permits only same-id redelivery", async () => {
  const dir = root(), clock = fakeClock();
  const source = await open(join(dir, "source", "queue.db"), sourceMachine, clock);
  const inbox = await open(join(dir, "inbox", "queue.db"), targetMachine, clock);
  send(source, mail("retry", "retained-body"));
  const frame = outgoing(source)[0] as IntercomMessageFrame;
  inbox.acceptInbound({ peer: sourceMachine, frame });
  inbox.beginDispatch({ id: "retry", endpoint, readiness: "ready-1" });
  const proof = receipt(frame, "not_injected");
  const wrong = { ...proof, receipt: { ...proof.receipt, evidence: { kind: "absence" as const, sessionId: recipient.sessionId,
    activationEpoch: endpoint.activationEpoch, excludedGeneration: "competing", complete: true as const } } };
  expect(() => inbox.resolveUnknown({ queue: "inbound", id: "retry", digest: frame.identity.digest, proof: wrong })).toThrow(/proof|evidence|receipt/i);
  expect(inbox.inspectBlockers(recipient).unknownOutcomes).toEqual(["retry"]);
  inbox.resolveUnknown({ queue: "inbound", id: "retry", digest: frame.identity.digest, proof });
  expect(inbox.inspectBlockers(recipient).unknownOutcomes).toEqual([]);
  expect(source.retained("outbound", "retry")).toMatchObject({ payloadRetained: true });
  expect(() => inbox.beginDispatch({ id: "retry", endpoint, readiness: "ready-1" })).toThrow(/readiness|retry/i);
  const retried = inbox.beginDispatch({ id: "retry", endpoint, readiness: "ready-2" });
  expect(retried.identity).toEqual(frame.identity);
  expect(retried.message.content.text).toBe("retained-body");
}, 5000);

it("expiry tombstones do not stall streams", async () => {
  const dir = root(), clock = fakeClock();
  const source = await open(join(dir, "source", "queue.db"), sourceMachine, clock);
  const inbox = await open(join(dir, "inbox", "queue.db"), targetMachine, clock);
  send(source, mail("old"));
  const old = outgoing(source)[0];
  clock.advance(24 * 60 * 60 * 1000 + 1);
  send(source, mail("new")); source.expire();
  const frames = outgoing(source);
  expect(frames.map(frame => [frame.identity.id, frame.kind])).toEqual([["old", "tombstone"], ["new", "message"]]);
  source.acknowledge({ peer: targetMachine, identity: old.identity, kind: "message" });
  expect(outgoing(source).map(frame => frame.identity.id)).toEqual(["old", "new"]);
  for (const frame of frames) inbox.acceptInbound({ peer: sourceMachine, frame });
  expect(incoming(inbox)).toEqual(["new"]);
  expect(inbox.acceptInbound({ peer: sourceMachine, frame: old }).kind).toBe("duplicate");
  expect(incoming(inbox)).toEqual(["new"]);
}, 5000);

it("undelivered ask expires before ordinary mail", async () => {
  const dir = root(), clock = fakeClock(), source = await open(join(dir, "queue.db"), sourceMachine, clock);
  send(source, { ...mail("ask"), expectsReply: true, remainingMs: 20_000 });
  send(source, mail("ordinary"));
  clock.advance(20_001); source.expire();
  expect(outgoing(source).map(frame => [frame.identity.id, frame.kind])).toEqual([["ask", "tombstone"], ["ordinary", "message"]]);
  expect(source.retained("outbound", "ask")).toMatchObject({ state: "expired", payloadRetained: false });
  expect(source.retained("outbound", "ordinary")).toMatchObject({ payloadRetained: true });
  expect(source.inspectBlockers(sender).asks).toEqual([]);
}, 5000);

it("clock offsets never refresh ask duration", async () => {
  const dir = root(), sourceClock = fakeClock(1_000_000), targetClock = fakeClock(9_000_000);
  let source = await open(join(dir, "source", "queue.db"), sourceMachine, sourceClock);
  const inbox = await open(join(dir, "inbox", "queue.db"), targetMachine, targetClock);
  send(source, { ...mail("ask"), expectsReply: true, remainingMs: 60_000 });
  const first = outgoing(source, targetMachine, 10_000)[0] as IntercomMessageFrame;
  expect(first.message.remainingMs).toBe(45_000);
  inbox.acceptInbound({ peer: sourceMachine, frame: first });
  sourceClock.advance(5_000);
  const second = outgoing(source, targetMachine, 10_000)[0] as IntercomMessageFrame;
  expect(second.message.remainingMs).toBe(25_000);
  source.close(); sourceClock.set(999_999);
  source = await open(join(dir, "source", "queue.db"), sourceMachine, sourceClock);
  source.expire();
  expect(source.retained("outbound", "ask")).toMatchObject({ state: "expired", payloadRetained: false });
  targetClock.advance(45_001); inbox.expire();
  expect(inbox.retained("inbound", "ask")).toMatchObject({ state: "expired", payloadRetained: false });
}, 5000);

it("pins the per-destination message and byte ceilings", () => {
  expect(INTERCOM_QUEUE_MESSAGES).toBe(256);
  expect(INTERCOM_QUEUE_BYTES).toBe(64 * 1024 * 1024);
  const dir = root(), clock = fakeClock();
  expect(() => openIntercomStore({ file: join(dir, "queue.db"), machineId: sourceMachine, clock, limits: { queueMessages: 257 } })).toThrow(/limit/i);
  expect(() => openIntercomStore({ file: join(dir, "queue.db"), machineId: sourceMachine, clock, limits: { queueBytes: 64 * 1024 * 1024 + 1 } })).toThrow(/limit/i);
}, 5000);

it("queue refusal never evicts accepted mail", async () => {
  const dir = root(), clock = fakeClock();
  const source = await open(join(dir, "count", "queue.db"), sourceMachine, clock);
  for (let i = 0; i < 256; i++) send(source, mail(`item-${i}`));
  expect(source.acceptOutbound({ from: sender, endpoint, message: mail("overflow"), nextHop: targetMachine })).toMatchObject({ kind: "refused", reason: "queue-full" });
  expect(source.retained("outbound", "item-0")).toMatchObject({ payloadRetained: true });
  expect(source.retained("outbound", "item-255")).toMatchObject({ payloadRetained: true });
  const limited = await open(join(dir, "bytes", "queue.db"), sourceMachine, clock, { queueBytes: 1400 });
  send(limited, mail("kept", "x".repeat(500)));
  const overflow = limited.acceptOutbound({ from: sender, endpoint, message: mail("large", "x".repeat(1200)), nextHop: targetMachine });
  expect(overflow).toMatchObject({ kind: "refused", reason: "queue-full" });
  expect(limited.retained("outbound", "kept")).toMatchObject({ payloadRetained: true });
  const accepted = outgoing(limited)[0] as IntercomMessageFrame;
  limited.settleReceipt({ queue: "outbound", peer: targetMachine, frame: receipt(accepted, "injected") });
  expect(send(limited, mail("large", "x".repeat(500))).sequence).toBe(2);
}, 5000);

it("only authenticated consumption evidence releases a settled payload and truncates WAL", async () => {
  const dir = root(), clock = fakeClock(), file = join(dir, "queue.db");
  const source = await open(file, sourceMachine, clock);
  send(source, mail("one", "sensitive-synthetic-sentinel"));
  const frame = outgoing(source)[0] as IntercomMessageFrame;
  const injected = receipt(frame, "injected");
  expect(() => source.settleReceipt({ queue: "outbound", peer: nextMachine, frame: injected })).toThrow(/route|peer/i);
  expect(() => source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: { ...injected, digest: "0".repeat(64) } })).toThrow(/digest|identity/i);
  expect(source.retained("outbound", "one")).toMatchObject({ payloadRetained: true });
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: injected });
  expect(source.retained("outbound", "one")).toMatchObject({ state: "injected", payloadRetained: false });
  expect(outgoing(source)).toEqual([]);
  expect(existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0).toBe(0);
  expect(readFileSync(file).includes(Buffer.from("sensitive-synthetic-sentinel"))).toBe(false);
}, 5000);

it("keeps receipts and unresolved blockers across restart without exposing content", async () => {
  const dir = root(), clock = fakeClock();
  const source = await open(join(dir, "source", "queue.db"), sourceMachine, clock);
  let inbox = await open(join(dir, "inbox", "queue.db"), targetMachine, clock);
  send(source, mail("first", "private-body")); send(source, mail("second", "another-private-body"));
  const frames = outgoing(source) as IntercomMessageFrame[];
  for (const frame of frames) inbox.acceptInbound({ peer: sourceMachine, frame });
  inbox.beginDispatch({ id: "first", endpoint, readiness: "one" });
  inbox.settleReceipt({ queue: "inbound", peer: sourceMachine, frame: receipt(frames[0], "injected") });
  inbox.beginDispatch({ id: "second", endpoint, readiness: "two" });
  inbox.close(); inbox = await open(join(dir, "inbox", "queue.db"), targetMachine, clock);
  expect(inbox.pending({ kind: "receipts", peer: sourceMachine })).toEqual([{ ...receipt(frames[0], "injected"), attempt: 1 }]);
  const blockers = inbox.inspectBlockers(recipient);
  expect(blockers.unknownOutcomes).toEqual(["second"]);
  expect(blockers.unobservedReceipts).toContain("first");
  expect(JSON.stringify(blockers)).not.toContain("private-body");
  expect(JSON.stringify(inbox.retained("inbound", "second"))).not.toContain("another-private-body");
}, 5000);

it("rebinds only undispatched messages with an authoritative home and excluded generation", async () => {
  const dir = root(), clock = fakeClock(), source = await open(join(dir, "queue.db"), sourceMachine, clock);
  send(source, mail("move"));
  const nextEndpoint: SessionEndpoint = { address: recipient, machineId: nextMachine, homeEpoch: 3, activationEpoch: "generation-3" };
  const proof = { owner: { sessionId: recipient.sessionId, machineId: nextMachine, epoch: 3, moveId: "move-1", updatedAt: clock.now() },
    exclusion: { owner: endpoint, excludedGeneration: endpoint.activationEpoch, kind: "generation-fenced" as const }, nextHop: nextMachine };
  expect(() => source.rebindUndispatched(recipient, nextEndpoint, { ...proof, exclusion: { ...proof.exclusion, excludedGeneration: "wrong" } })).toThrow(/proof|generation|endpoint/i);
  expect(source.retained("outbound", "move")?.endpoint).toEqual(endpoint);
  expect(source.rebindUndispatched(recipient, nextEndpoint, proof)).toBe(1);
  const rebound = outgoing(source, nextMachine)[0];
  expect(rebound.identity.id).toBe("move");
  expect(rebound.identity.to).toEqual(recipient);
  expect(rebound.identity.sequence).toBe(1);
  expect(rebound.endpoint).toEqual(nextEndpoint);
}, 5000);

it("an inbox subtracts its elapsed time before dispatching an ask", async () => {
  const dir = root(), clock = fakeClock();
  const source = await open(join(dir, "source", "queue.db"), sourceMachine, clock);
  const inbox = await open(join(dir, "inbox", "queue.db"), targetMachine, clock);
  send(source, { ...mail("ask"), expectsReply: true, remainingMs: 60_000 });
  const frame = outgoing(source, targetMachine, 10_000)[0];
  inbox.acceptInbound({ peer: sourceMachine, frame });
  clock.advance(35_000);
  expect(inbox.beginDispatch({ id: "ask", endpoint, readiness: "ready" }).message.remainingMs).toBe(10_000);
}, 5000);

it("does not charge a hop budget for an ask left out of a full batch", async () => {
  const dir = root(), clock = fakeClock(), source = await open(join(dir, "queue.db"), sourceMachine, clock);
  send(source, mail("large-1", "a".repeat(230 * 1024)));
  send(source, mail("large-2", "b".repeat(230 * 1024)));
  send(source, { ...mail("ask", "c".repeat(60 * 1024)), expectsReply: true, remainingMs: 100_000 });
  const first = outgoing(source, targetMachine, 10_000);
  expect(first.map(frame => frame.identity.id)).toEqual(["large-1", "large-2"]);
  for (const frame of first) source.acknowledge({ peer: targetMachine, identity: frame.identity, kind: "message" });
  const later = outgoing(source, targetMachine, 10_000)[0] as IntercomMessageFrame;
  expect(later.identity.id).toBe("ask");
  expect(later.message.remainingMs).toBe(85_000);
}, 5000);

it("a stale unknown receipt cannot overwrite observed injection evidence", async () => {
  const dir = root(), clock = fakeClock();
  const source = await open(join(dir, "source", "queue.db"), sourceMachine, clock);
  const inbox = await open(join(dir, "inbox", "queue.db"), targetMachine, clock);
  send(source, mail("observed"));
  const frame = outgoing(source)[0] as IntercomMessageFrame;
  inbox.acceptInbound({ peer: sourceMachine, frame });
  inbox.beginDispatch({ id: "observed", endpoint, readiness: "one" });
  inbox.settleReceipt({ queue: "inbound", peer: sourceMachine, frame: receipt(frame, "injected") });
  inbox.settleReceipt({ queue: "inbound", peer: sourceMachine, frame: receipt(frame, "unknown") });
  expect(inbox.inspectBlockers(recipient).unknownOutcomes).toEqual([]);
  expect(inbox.acceptInbound({ peer: sourceMachine, frame })).toMatchObject({ kind: "duplicate", receipt: { status: "injected" } });
  expect(inbox.pending({ kind: "receipts", peer: sourceMachine }).map(item => item.receipt.status)).toEqual(["injected"]);
}, 5000);

it("a late absence proof cannot revive observed injection", async () => {
  const dir = root(), clock = fakeClock(), source = await open(join(dir, "queue.db"), sourceMachine, clock);
  send(source, mail("observed"));
  const frame = outgoing(source)[0] as IntercomMessageFrame;
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: receipt(frame, "injected") });
  expect(() => source.resolveUnknown({ queue: "outbound", id: "observed", digest: frame.identity.digest, proof: { ...receipt(frame, "not_injected"), attempt: 1 } })).toThrow(/settled|evidence|proof/i);
  expect(source.retained("outbound", "observed")).toMatchObject({ state: "injected", payloadRetained: false });
}, 5000);

it("a recorded waiter answer never revives its uninjected question", async () => {
  const dir = root(), clock = fakeClock();
  const asker = await open(join(dir, "asker", "queue.db"), sourceMachine, clock);
  const replier = await open(join(dir, "replier", "queue.db"), targetMachine, clock);
  send(asker, { ...mail("ask"), expectsReply: true, remainingMs: 60_000 });
  const question = outgoing(asker)[0] as IntercomMessageFrame;
  asker.settleReceipt({ queue: "outbound", peer: targetMachine, frame: { ...receipt(question, "unknown"), attempt: 1 } });
  const askerEndpoint: SessionEndpoint = { address: sender, machineId: sourceMachine, homeEpoch: 1, activationEpoch: "generation-1" };
  send(replier, { ...mail("answer"), replyTo: "ask" }, askerEndpoint, recipient, sourceMachine);
  const answer = outgoing(replier, sourceMachine)[0] as IntercomMessageFrame;
  asker.acceptInbound({ peer: targetMachine, frame: answer });
  asker.beginDispatch({ id: "answer", endpoint: askerEndpoint, readiness: "waiting" });
  const matched: IntercomReceiptInput = { from: askerEndpoint, to: recipient, digest: answer.identity.digest,
    receipt: { messageId: "answer", status: "matched_waiter", timestamp: clock.now(), evidence: { kind: "waiter", entryId: "waiter-entry",
      sessionId: sender.sessionId, activationEpoch: askerEndpoint.activationEpoch, askId: "ask" } } };
  asker.settleReceipt({ queue: "inbound", peer: targetMachine, frame: matched });
  asker.resolveUnknown({ queue: "outbound", id: "ask", digest: question.identity.digest, proof: { ...receipt(question, "not_injected"), attempt: 1 } });
  expect(outgoing(asker).map(frame => frame.identity.id)).not.toContain("ask");
  expect(asker.retained("outbound", "ask")).toMatchObject({ payloadRetained: true });
  expect(asker.inspectBlockers(sender).unknownOutcomes).toEqual([]);
  clock.advance(60_001); asker.expire();
  expect(asker.retained("outbound", "ask")).toMatchObject({ state: "expired", payloadRetained: false });
}, 5000);

it.each(["cancelled", "expired"] as const)("absence proof preserves a prior %s outcome and its own evidence", async outcome => {
  const dir = root(), clock = fakeClock(), file = join(dir, "queue.db");
  let source = await open(file, sourceMachine, clock);
  send(source, mail("one"));
  const frame = outgoing(source)[0] as IntercomMessageFrame;
  if (outcome === "cancelled") source.cancel({ queue: "outbound", id: "one", from: sender, to: recipient });
  else { clock.advance(24 * 60 * 60 * 1000 + 1); source.expire(); }
  expect(source.inspectBlockers(sender).unknownOutcomes).toEqual(["one"]);
  source.resolveUnknown({ queue: "outbound", id: "one", digest: frame.identity.digest, proof: { ...receipt(frame, "not_injected"), attempt: 1 } });
  expect(source.inspectBlockers(sender).unknownOutcomes).toEqual([]);
  source.close(); source = await open(file, sourceMachine, clock);
  expect(source.acceptOutbound({ from: sender, endpoint, message: mail("one"), nextHop: targetMachine }))
    .toMatchObject({ kind: "duplicate", receipt: { status: outcome } });
  expect(source.retained("outbound", "one")).toMatchObject({ state: outcome, reconciliation: {
    status: "not_injected", evidence: { excludedGeneration: endpoint.activationEpoch },
  } });
}, 5000);

it.each(["cancelled", "expired"] as const)("stale queue receipts cannot replace a visible %s outcome", async outcome => {
  const dir = root(), clock = fakeClock(), source = await open(join(dir, "queue.db"), sourceMachine, clock);
  send(source, mail("one"));
  const frame = outgoing(source)[0] as IntercomMessageFrame;
  if (outcome === "cancelled") source.cancel({ queue: "outbound", id: "one", from: sender, to: recipient });
  else { clock.advance(24 * 60 * 60 * 1000 + 1); source.expire(); }
  for (const status of ["queued", "acknowledged", "unknown", "cancelled"] as const) {
    source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: { from: endpoint, to: sender, digest: frame.identity.digest, attempt: 1,
      receipt: { messageId: "one", status, timestamp: clock.now() } } });
    expect(source.acceptOutbound({ from: sender, endpoint, message: mail("one"), nextHop: targetMachine }))
      .toMatchObject({ kind: "duplicate", receipt: { status: outcome } });
  }
  expect(source.inspectBlockers(sender).unknownOutcomes).toEqual(["one"]);
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: { ...receipt(frame, "injected"), attempt: 1 } });
  expect(source.retained("outbound", "one")).toMatchObject({ state: "injected", payloadRetained: false });
  expect(source.inspectBlockers(sender).unknownOutcomes).toEqual([]);
}, 5000);

it("persists an unprocessed absence proof across expiry and restart", async () => {
  const dir = root(), clock = fakeClock(), file = join(dir, "queue.db");
  let source = await open(file, sourceMachine, clock);
  send(source, mail("one"));
  const frame = outgoing(source)[0] as IntercomMessageFrame;
  const proof: IntercomReceiptFrame = { ...receipt(frame, "not_injected"), attempt: 1 };
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: proof });
  clock.advance(24 * 60 * 60 * 1000 + 1); source.expire();
  source.close(); source = await open(file, sourceMachine, clock);
  const retained = source.retained("outbound", "one");
  expect(retained).toMatchObject({ state: "expired", payloadRetained: false, pendingProof: proof });
  expect(source.inspectBlockers(sender).unknownOutcomes).toEqual(["one"]);
  source.resolveUnknown({ queue: "outbound", id: "one", digest: frame.identity.digest, proof: retained!.pendingProof! });
  expect(source.inspectBlockers(sender).unknownOutcomes).toEqual([]);
  expect(source.retained("outbound", "one")).toMatchObject({ state: "expired" });
}, 5000);

it("an older pending absence proof cannot clear a newer uncertain attempt", async () => {
  const dir = root(), clock = fakeClock(), file = join(dir, "queue.db");
  let source = await open(file, sourceMachine, clock);
  send(source, mail("one"));
  const frame = outgoing(source)[0] as IntercomMessageFrame;
  const old = { ...receipt(frame, "not_injected"), attempt: 1 };
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: old });
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: { ...receipt(frame, "unknown"), attempt: 2 } });
  source.close(); source = await open(file, sourceMachine, clock);
  expect(source.retained("outbound", "one")).toMatchObject({ latestAttempt: 2, pendingProof: old });
  expect(() => source.resolveUnknown({ queue: "outbound", id: "one", digest: frame.identity.digest, proof: old })).toThrow(/attempt|stale/i);
  expect(source.inspectBlockers(sender).unknownOutcomes).toEqual(["one"]);
  const current = { ...old, attempt: 2 };
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: current });
  source.resolveUnknown({ queue: "outbound", id: "one", digest: frame.identity.digest, proof: current });
  expect(source.inspectBlockers(sender).unknownOutcomes).toEqual([]);
}, 5000);

it("old consumption evidence cannot clear a newer uncertain attempt", async () => {
  const dir = root(), clock = fakeClock(), file = join(dir, "queue.db");
  let source = await open(file, sourceMachine, clock);
  send(source, mail("one"));
  const frame = outgoing(source)[0] as IntercomMessageFrame;
  const old = { ...receipt(frame, "not_injected"), attempt: 1 };
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: old });
  source.resolveUnknown({ queue: "outbound", id: "one", digest: frame.identity.digest, proof: old });
  outgoing(source);
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: { ...receipt(frame, "unknown"), attempt: 2 } });
  const newer = { ...receipt(frame, "not_injected"), attempt: 2 };
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: newer });
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: { ...receipt(frame, "injected"), attempt: 1 } });
  source.close(); source = await open(file, sourceMachine, clock);
  expect(source.retained("outbound", "one")).toMatchObject({ state: "injected", payloadRetained: false, pendingProof: newer });
  expect(source.inspectBlockers(sender).unknownOutcomes).toEqual(["one"]);
  source.resolveUnknown({ queue: "outbound", id: "one", digest: frame.identity.digest, proof: source.retained("outbound", "one")!.pendingProof! });
  expect(source.retained("outbound", "one")).toMatchObject({ state: "injected", payloadRetained: false });
  expect(source.inspectBlockers(sender).unknownOutcomes).toEqual([]);
  expect(outgoing(source)).toEqual([]);
}, 5000);

it("a cancellation remains distinct, retains payload, and replays its evidence", async () => {
  const dir = root(), clock = fakeClock(), source = await open(join(dir, "queue.db"), sourceMachine, clock);
  send(source, mail("cancelled"));
  source.cancel({ queue: "outbound", id: "cancelled", from: sender, to: recipient });
  expect(source.retained("outbound", "cancelled")).toMatchObject({ state: "cancelled", payloadRetained: true });
  expect(outgoing(source)[0]).toMatchObject({ kind: "tombstone", reason: "cancelled" });
  expect(source.acceptOutbound({ from: sender, endpoint, message: mail("cancelled"), nextHop: targetMachine }))
    .toMatchObject({ kind: "duplicate", receipt: { status: "cancelled" } });
}, 5000);

it("corrupt stored payload errors never echo message content", async () => {
  const dir = root(), clock = fakeClock(), file = join(dir, "queue.db"), source = await open(file, sourceMachine, clock);
  send(source, mail("one", "sensitive-corrupt-sentinel"));
  const db = openDb(file, { fileMustExist: true, checkpointOnClose: false });
  try { db.prepare("UPDATE intercom_copies SET payload_json=? WHERE id='one'").run('{"text":"sensitive-corrupt-sentinel",bad}'); }
  finally { db.close(); }
  let error: unknown;
  try { outgoing(source); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toMatch(/invalid intercom/i);
  expect(String(error)).not.toContain("sensitive-corrupt-sentinel");
}, 5000);

it("refuses a damaged queue schema without recreating lost evidence", async () => {
  const dir = root(), clock = fakeClock(), file = join(dir, "queue.db");
  const store = await open(file, sourceMachine, clock);
  send(store, mail("one")); store.close();
  const damaged = openDb(file); damaged.exec("DROP TABLE intercom_copies"); damaged.close();
  await expect(open(file, sourceMachine, clock)).rejects.toThrow(/schema|missing|invalid/i);
  const check = openDb(file);
  try {
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name='intercom_copies'").get()).toBeUndefined();
    expect(check.prepare("SELECT id FROM intercom_messages WHERE id='one'").get()).toEqual({ id: "one" });
  } finally { check.close(); }
}, 5000);

it("refuses a queue whose identity uniqueness constraints disappeared", async () => {
  const dir = root(), clock = fakeClock(), file = join(dir, "queue.db");
  const store = await open(file, sourceMachine, clock);
  send(store, mail("one")); store.close();
  const db = openDb(file); db.pragma("foreign_keys = OFF");
  try { db.exec("ALTER TABLE intercom_messages RENAME TO intercom_messages_old; CREATE TABLE intercom_messages AS SELECT * FROM intercom_messages_old; DROP TABLE intercom_messages_old"); }
  finally { db.close(); }
  await expect(open(file, sourceMachine, clock)).rejects.toThrow(/identity|constraint/i);
}, 5000);

it("refuses an unrelated database before changing its file or directory mode", async () => {
  const dir = root(), clock = fakeClock(), folder = join(dir, "other"), file = join(folder, "core.db");
  mkdirSync(folder, { mode: 0o700 });
  const other = openDb(file); other.exec("CREATE TABLE fixture_sentinel(value TEXT); INSERT INTO fixture_sentinel VALUES ('unchanged')"); other.close();
  if (process.platform !== "win32") { chmodSync(folder, 0o755); chmodSync(file, 0o644); }
  await expect(open(file, sourceMachine, clock)).rejects.toThrow(/separate database/i);
  if (process.platform !== "win32") {
    expect(lstatSync(folder).mode & 0o777).toBe(0o755);
    expect(lstatSync(file).mode & 0o777).toBe(0o644);
  }
  const check = openDb(file); try { expect(check.prepare("SELECT value FROM fixture_sentinel").get()).toEqual({ value: "unchanged" }); }
  finally { check.close(); }
}, 5000);

it("retries a busy WAL truncation before reporting a repeated settlement complete", async () => {
  const dir = root(), clock = fakeClock(), file = join(dir, "queue.db"), source = await open(file, sourceMachine, clock);
  send(source, mail("one", "wal-sensitive-sentinel"));
  const frame = outgoing(source)[0] as IntercomMessageFrame, observed = receipt(frame, "injected");
  const reader = openDb(file, { fileMustExist: true, checkpointOnClose: false });
  try {
    reader.raw.exec("BEGIN");
    expect(reader.prepare("SELECT payload_json FROM intercom_copies WHERE id='one'").get()).toBeDefined();
    expect(() => source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: observed })).toThrow(/checkpoint.*busy/i);
  } finally { reader.raw.exec("ROLLBACK"); reader.close(); }
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: observed });
  expect(existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0).toBe(0);
  expect(readFileSync(file).includes(Buffer.from("wal-sensitive-sentinel"))).toBe(false);
}, 5000);

it("retains deduplication metadata for at least 24 hours after expiry", async () => {
  const dir = root(), clock = fakeClock(), file = join(dir, "queue.db");
  let source = await open(file, sourceMachine, clock);
  send(source, mail("old", "dedupe-private-sentinel"));
  clock.advance(24 * 60 * 60 * 1000 + 1); source.expire();
  expect(existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0).toBe(0);
  expect(readFileSync(file).includes(Buffer.from("dedupe-private-sentinel"))).toBe(false);
  clock.advance(24 * 60 * 60 * 1000 + 1); source.close();
  source = await open(file, sourceMachine, clock);
  expect(source.acceptOutbound({ from: sender, endpoint, message: mail("old", "dedupe-private-sentinel"), nextHop: targetMachine }))
    .toMatchObject({ kind: "duplicate", receipt: { status: "expired" } });
  expect(() => source.acceptOutbound({ from: sender, endpoint, message: mail("old", "different"), nextHop: targetMachine })).toThrow(/id|digest/i);
}, 5000);

it("retains unresolved outcome metadata after payload expiry and restart", async () => {
  const dir = root(), clock = fakeClock(), file = join(dir, "queue.db");
  let source = await open(file, sourceMachine, clock);
  send(source, mail("unknown", "unresolved-private-sentinel"));
  const frame = outgoing(source)[0] as IntercomMessageFrame;
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: { ...receipt(frame, "unknown"), attempt: 1 } });
  clock.advance(48 * 60 * 60 * 1000 + 1); source.expire(); source.close();
  source = await open(file, sourceMachine, clock);
  expect(source.retained("outbound", "unknown")).toMatchObject({ state: "expired", payloadRetained: false });
  expect(source.inspectBlockers(sender).unknownOutcomes).toEqual(["unknown"]);
  expect(JSON.stringify(source.inspectBlockers(sender))).not.toContain("unresolved-private-sentinel");
  source.resolveUnknown({ queue: "outbound", id: "unknown", digest: frame.identity.digest, proof: { ...receipt(frame, "not_injected"), attempt: 1 } });
  expect(source.inspectBlockers(sender).unknownOutcomes).toEqual([]);
}, 5000);

it("early acknowledgement and queue receipt never imply consumption", async () => {
  const dir = root(), clock = fakeClock(), source = await open(join(dir, "queue.db"), sourceMachine, clock);
  send(source, mail("one"));
  const frame = outgoing(source)[0] as IntercomMessageFrame;
  for (const status of ["receiver_received", "queued", "acknowledged"] as const) {
    source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: { from: endpoint, to: sender, digest: frame.identity.digest,
      receipt: { messageId: "one", status, timestamp: clock.now() } } });
    expect(source.retained("outbound", "one")).toMatchObject({ payloadRetained: true });
  }
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: { ...receipt(frame, "unknown"), attempt: 1 } });
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: { from: endpoint, to: sender, digest: frame.identity.digest,
    receipt: { messageId: "one", status: "acknowledged", timestamp: clock.now() } } });
  expect(source.inspectBlockers(sender).unknownOutcomes).toEqual(["one"]);
  expect(source.retained("outbound", "one")).toMatchObject({ payloadRetained: true });
}, 5000);

it("unproved absence cannot authorize same-id retry", async () => {
  const dir = root(), clock = fakeClock(), source = await open(join(dir, "queue.db"), sourceMachine, clock);
  send(source, mail("one"));
  const frame = outgoing(source)[0] as IntercomMessageFrame;
  const incomplete: IntercomReceiptFrame = { from: endpoint, to: sender, digest: frame.identity.digest, attempt: 1,
    receipt: { messageId: "one", status: "not_injected", timestamp: clock.now() } };
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: { ...receipt(frame, "unknown"), attempt: 1 } });
  expect(() => source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: incomplete })).toThrow(/proof|evidence/i);
  expect(() => source.resolveUnknown({ queue: "outbound", id: "one", digest: frame.identity.digest, proof: incomplete })).toThrow(/proof|evidence/i);
  expect(source.inspectBlockers(sender).unknownOutcomes).toEqual(["one"]);
  expect(source.retained("outbound", "one")).toMatchObject({ payloadRetained: true });
  expect(outgoing(source)).toEqual([]);
}, 5000);

it("waiter evidence must name the reply's original ask", async () => {
  const dir = root(), clock = fakeClock(), source = await open(join(dir, "queue.db"), sourceMachine, clock);
  send(source, { ...mail("reply"), replyTo: "ask-original" });
  const frame = outgoing(source)[0] as IntercomMessageFrame;
  const wrong = receipt(frame, "matched_waiter", { evidence: { kind: "waiter", entryId: "entry", sessionId: recipient.sessionId,
    activationEpoch: endpoint.activationEpoch, askId: "different-ask" } });
  expect(() => source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: wrong })).toThrow(/ask|waiter/i);
  expect(source.retained("outbound", "reply")).toMatchObject({ payloadRetained: true });
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: receipt(frame, "matched_waiter") });
  expect(source.retained("outbound", "reply")).toMatchObject({ state: "matched_waiter", payloadRetained: false });
}, 5000);

it("does not acknowledge receipt evidence before it was handed off", async () => {
  const dir = root(), clock = fakeClock(), inbox = await open(join(dir, "queue.db"), targetMachine, clock);
  const frame = makeMessageFrame({ from: sender, endpoint, sequence: 1, message: mail("one") });
  inbox.acceptInbound({ peer: sourceMachine, frame });
  inbox.beginDispatch({ id: "one", endpoint, readiness: "ready" });
  const observed = receipt(frame, "unknown");
  inbox.settleReceipt({ queue: "inbound", peer: sourceMachine, frame: observed });
  expect(() => inbox.acknowledgeReceipt({ peer: sourceMachine, frame: { ...observed, attempt: 1 } })).toThrow(/handoff|sent|acknowledg/i);
  const pending = inbox.pending({ kind: "receipts", peer: sourceMachine });
  expect(pending).toHaveLength(1);
  inbox.acknowledgeReceipt({ peer: sourceMachine, frame: pending[0] });
  expect(inbox.pending({ kind: "receipts", peer: sourceMachine })).toEqual([]);
}, 5000);

it("reports uncertainty again after a proved same-id retry", async () => {
  const dir = root(), clock = fakeClock(), file = join(dir, "queue.db");
  let inbox = await open(file, targetMachine, clock);
  const frame = makeMessageFrame({ from: sender, endpoint, sequence: 1, message: mail("one") });
  inbox.acceptInbound({ peer: sourceMachine, frame });
  inbox.beginDispatch({ id: "one", endpoint, readiness: "idle-1" });
  inbox.settleReceipt({ queue: "inbound", peer: sourceMachine, frame: receipt(frame, "unknown") });
  const first = inbox.pending({ kind: "receipts", peer: sourceMachine });
  expect(first.map(item => item.receipt.status)).toEqual(["unknown"]);
  inbox.acknowledgeReceipt({ peer: sourceMachine, frame: first[0] });
  inbox.close(); inbox = await open(file, targetMachine, clock);
  inbox.resolveUnknown({ queue: "inbound", id: "one", digest: frame.identity.digest, proof: receipt(frame, "not_injected") });
  for (const proof of inbox.pending({ kind: "receipts", peer: sourceMachine })) inbox.acknowledgeReceipt({ peer: sourceMachine, frame: proof });
  inbox.beginDispatch({ id: "one", endpoint, readiness: "idle-2" });
  inbox.settleReceipt({ queue: "inbound", peer: sourceMachine, frame: receipt(frame, "unknown") });
  const second = inbox.pending({ kind: "receipts", peer: sourceMachine });
  expect(second.map(item => item.receipt.status)).toEqual(["unknown"]);
  expect(second[0].attempt).not.toBe(first[0].attempt);
}, 5000);

it("deduplicates equivalent receipts regardless of object key order and timestamp", async () => {
  const dir = root(), clock = fakeClock(), inbox = await open(join(dir, "queue.db"), targetMachine, clock);
  const frame = makeMessageFrame({ from: sender, endpoint, sequence: 1, message: mail("one") });
  inbox.acceptInbound({ peer: sourceMachine, frame });
  inbox.beginDispatch({ id: "one", endpoint, readiness: "ready" });
  const first = receipt(frame, "unknown");
  const reordered: IntercomReceiptInput = { from: { activationEpoch: endpoint.activationEpoch, homeEpoch: endpoint.homeEpoch,
    machineId: endpoint.machineId, address: { scopeId: recipient.scopeId, sessionId: recipient.sessionId } },
    to: { scopeId: sender.scopeId, sessionId: sender.sessionId }, digest: frame.identity.digest,
    receipt: { timestamp: first.receipt.timestamp + 1, status: "unknown", messageId: "one" } };
  inbox.settleReceipt({ queue: "inbound", peer: sourceMachine, frame: first });
  inbox.settleReceipt({ queue: "inbound", peer: sourceMachine, frame: reordered });
  const pending = inbox.pending({ kind: "receipts", peer: sourceMachine });
  expect(pending).toHaveLength(1);
  inbox.acknowledgeReceipt({ peer: sourceMachine, frame: { ...reordered, attempt: pending[0].attempt } });
  expect(inbox.pending({ kind: "receipts", peer: sourceMachine })).toEqual([]);
}, 5000);

it("returns bounded receipt batches without dropping unacknowledged evidence", async () => {
  const dir = root(), clock = fakeClock(), inbox = await open(join(dir, "queue.db"), targetMachine, clock);
  for (let index = 1; index <= 30; index++) {
    const frame = makeMessageFrame({ from: sender, endpoint, sequence: index, message: mail(`receipt-${index}`) });
    inbox.acceptInbound({ peer: sourceMachine, frame });
    inbox.beginDispatch({ id: frame.identity.id, endpoint, readiness: `ready-${index}` });
    const observed = receipt(frame, "injected", { evidence: { kind: "entry", entryId: `${"e".repeat(30_000)}${index}`,
      sessionId: recipient.sessionId, activationEpoch: endpoint.activationEpoch } });
    inbox.settleReceipt({ queue: "inbound", peer: sourceMachine, frame: observed });
  }
  const first = inbox.pending({ kind: "receipts", peer: sourceMachine });
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(512 * 1024);
  expect(first.length).toBeLessThan(30);
  for (const frame of first) inbox.acknowledgeReceipt({ peer: sourceMachine, frame });
  const second = inbox.pending({ kind: "receipts", peer: sourceMachine });
  expect(first.length + second.length).toBe(30);
  expect(Buffer.byteLength(JSON.stringify(second))).toBeLessThanOrEqual(512 * 1024);
}, 5000);

it("a relay durably forwards consumption evidence to the original source", async () => {
  const dir = root(), clock = fakeClock();
  const source = await open(join(dir, "source", "queue.db"), sourceMachine, clock);
  const relay = await open(join(dir, "relay", "queue.db"), nextMachine, clock);
  const inbox = await open(join(dir, "inbox", "queue.db"), targetMachine, clock);
  send(source, mail("relay", "relay-private-sentinel"), endpoint, sender, nextMachine);
  const original = outgoing(source, nextMachine)[0] as IntercomMessageFrame;
  relay.acceptInbound({ peer: sourceMachine, frame: original });
  source.acknowledge({ peer: nextMachine, identity: original.identity, kind: "message" });
  expect(source.retained("outbound", "relay")).toMatchObject({ payloadRetained: true });
  relay.acceptOutbound({ frame: original, nextHop: targetMachine });
  const forwarded = outgoing(relay, targetMachine)[0] as IntercomMessageFrame;
  inbox.acceptInbound({ peer: nextMachine, frame: forwarded });
  relay.acknowledge({ peer: targetMachine, identity: forwarded.identity, kind: "message" });
  inbox.beginDispatch({ id: "relay", endpoint, readiness: "ready" });
  const observed = receipt(forwarded, "injected");
  inbox.settleReceipt({ queue: "inbound", peer: nextMachine, frame: observed });
  const published = inbox.pending({ kind: "receipts", peer: nextMachine })[0];
  expect(published.attempt).toBe(1);
  relay.settleReceipt({ queue: "outbound", peer: targetMachine, frame: published });
  relay.settleReceipt({ queue: "inbound", peer: sourceMachine, frame: published });
  source.settleReceipt({ queue: "outbound", peer: nextMachine, frame: published });
  expect(source.retained("outbound", "relay")).toMatchObject({ state: "injected", payloadRetained: false });
  expect(relay.retained("inbound", "relay")).toMatchObject({ state: "injected", payloadRetained: false });
  expect(relay.retained("outbound", "relay")).toMatchObject({ state: "injected", payloadRetained: false });
  expect(relay.pending({ kind: "receipts", peer: sourceMachine })).toEqual([published]);
  expect(JSON.stringify(relay.inspectBlockers(recipient))).not.toContain("relay-private-sentinel");
}, 5000);

it("clock rollback expires old payloads without poisoning newly accepted mail", async () => {
  const dir = root(), clock = fakeClock(), source = await open(join(dir, "queue.db"), sourceMachine, clock);
  send(source, mail("old"));
  clock.advance(10_000); outgoing(source);
  clock.set(999_000); source.expire();
  expect(source.retained("outbound", "old")).toMatchObject({ state: "expired", payloadRetained: false });
  expect(send(source, mail("new")).sequence).toBe(2);
  expect(outgoing(source).map(frame => [frame.identity.id, frame.kind])).toEqual([["old", "tombstone"], ["new", "message"]]);
}, 5000);

it("ordinary retries do not restart or repeatedly shorten the source deadline", async () => {
  const dir = root(), clock = fakeClock(), source = await open(join(dir, "queue.db"), sourceMachine, clock);
  send(source, mail("one"));
  for (let index = 0; index < 20; index++) expect(outgoing(source)[0].kind).toBe("message");
  clock.advance(24 * 60 * 60 * 1000 - 10_000);
  expect(outgoing(source)[0].kind).toBe("message");
  clock.advance(10_001);
  expect(outgoing(source)[0]).toMatchObject({ kind: "tombstone", reason: "expired" });
}, 5000);

it("a relay recovers a proved non-injection with the same ID", async () => {
  const dir = root(), clock = fakeClock();
  const source = await open(join(dir, "source", "queue.db"), sourceMachine, clock);
  const relay = await open(join(dir, "relay", "queue.db"), nextMachine, clock);
  const inbox = await open(join(dir, "inbox", "queue.db"), targetMachine, clock);
  send(source, mail("one"), endpoint, sender, nextMachine);
  const first = outgoing(source, nextMachine)[0] as IntercomMessageFrame;
  relay.acceptInbound({ peer: sourceMachine, frame: first });
  relay.acceptOutbound({ frame: first, nextHop: targetMachine });
  const forwarded = outgoing(relay, targetMachine)[0] as IntercomMessageFrame;
  inbox.acceptInbound({ peer: nextMachine, frame: forwarded });
  inbox.beginDispatch({ id: "one", endpoint, readiness: "idle-1" });
  inbox.settleReceipt({ queue: "inbound", peer: nextMachine, frame: receipt(forwarded, "not_injected") });
  inbox.resolveUnknown({ queue: "inbound", id: "one", digest: forwarded.identity.digest, proof: receipt(forwarded, "not_injected") });
  const proof = inbox.pending({ kind: "receipts", peer: nextMachine }).find(item => item.receipt.status === "not_injected")!;
  expect(proof.attempt).toBe(1);
  relay.settleReceipt({ queue: "outbound", peer: targetMachine, frame: proof });
  relay.resolveUnknown({ queue: "outbound", id: "one", digest: first.identity.digest, proof });
  relay.settleReceipt({ queue: "inbound", peer: sourceMachine, frame: proof });
  relay.resolveUnknown({ queue: "inbound", id: "one", digest: first.identity.digest, proof });
  source.settleReceipt({ queue: "outbound", peer: nextMachine, frame: proof });
  source.resolveUnknown({ queue: "outbound", id: "one", digest: first.identity.digest, proof });
  const retried = outgoing(source, nextMachine)[0] as IntercomMessageFrame;
  expect(retried.identity).toEqual(first.identity);
  expect(relay.acceptInbound({ peer: sourceMachine, frame: retried }).kind).toBe("duplicate");
  expect(relay.acceptOutbound({ frame: retried, nextHop: targetMachine }).kind).toBe("duplicate");
  const again = outgoing(relay, targetMachine)[0] as IntercomMessageFrame;
  expect(inbox.acceptInbound({ peer: nextMachine, frame: again }).kind).toBe("duplicate");
  expect(inbox.beginDispatch({ id: "one", endpoint, readiness: "idle-2" }).identity).toEqual(first.identity);
  inbox.settleReceipt({ queue: "inbound", peer: nextMachine, frame: receipt(again, "injected") });
  const observed = inbox.pending({ kind: "receipts", peer: nextMachine }).find(item => item.receipt.status === "injected")!;
  expect(observed.attempt).toBe(2);
  relay.settleReceipt({ queue: "outbound", peer: targetMachine, frame: observed });
  relay.settleReceipt({ queue: "inbound", peer: sourceMachine, frame: observed });
  source.settleReceipt({ queue: "outbound", peer: nextMachine, frame: observed });
  expect(source.retained("outbound", "one")).toMatchObject({ state: "injected", payloadRetained: false });
}, 5000);

it("a duplicate cannot extend the inbox payload lifetime", async () => {
  const dir = root(), clock = fakeClock(), inbox = await open(join(dir, "queue.db"), targetMachine, clock);
  const frame = makeMessageFrame({ from: sender, endpoint, sequence: 1, message: mail("one"), remainingPayloadMs: 10_000 });
  inbox.acceptInbound({ peer: sourceMachine, frame });
  clock.advance(5_000);
  expect(inbox.acceptInbound({ peer: sourceMachine, frame: { ...frame, remainingPayloadMs: 90_000 } }).kind).toBe("duplicate");
  clock.advance(5_001); inbox.expire();
  expect(inbox.retained("inbound", "one")).toMatchObject({ state: "expired", payloadRetained: false });
}, 5000);

it("does not start dispatch when the clock crosses the exact expiry boundary", async () => {
  const dir = root(), clock = fakeClock(), inbox = await open(join(dir, "queue.db"), targetMachine, clock);
  const frame = makeMessageFrame({ from: sender, endpoint, sequence: 1, message: mail("one"), remainingPayloadMs: 10_000 });
  inbox.acceptInbound({ peer: sourceMachine, frame });
  const deadline = clock.now() + 10_000; let reads = 0;
  clock.now = () => ++reads === 1 ? deadline - 1 : deadline;
  expect(() => inbox.beginDispatch({ id: "one", endpoint, readiness: "ready" })).toThrow(/expired/i);
  inbox.expire();
  expect(inbox.retained("inbound", "one")).toMatchObject({ state: "expired", payloadRetained: false });
}, 5000);

it("a relay never refreshes an ask held in its persisted inbox", async () => {
  const dir = root(), clock = fakeClock();
  const source = await open(join(dir, "source", "queue.db"), sourceMachine, clock);
  const relay = await open(join(dir, "relay", "queue.db"), nextMachine, clock);
  send(source, { ...mail("ask", "question"), expectsReply: true, remainingMs: 120_000 }, endpoint, sender, nextMachine);
  const first = outgoing(source, nextMachine, 2_000)[0] as IntercomMessageFrame;
  relay.acceptInbound({ peer: sourceMachine, frame: first });
  clock.advance(30_000);
  relay.acceptOutbound({ frame: first, nextHop: targetMachine });
  const forwarded = outgoing(relay, targetMachine, 2_000)[0] as IntercomMessageFrame;
  expect(forwarded.message.remainingMs).toBeLessThanOrEqual(first.message.remainingMs! - 37_000);
  expect(forwarded.remainingPayloadMs).toBeLessThanOrEqual(first.remainingPayloadMs - 37_000);
  expect(forwarded.identity).toEqual(first.identity);
}, 5000);

it("an ordinary payload cannot gain a fresh 24-hour lifetime at a relay", async () => {
  const dir = root(), clock = fakeClock();
  const source = await open(join(dir, "source", "queue.db"), sourceMachine, clock);
  const relay = await open(join(dir, "relay", "queue.db"), nextMachine, clock);
  send(source, mail("aged"), endpoint, sender, nextMachine);
  clock.advance(23 * 60 * 60 * 1000 + 30 * 60 * 1000);
  const frame = outgoing(source, nextMachine)[0] as IntercomMessageFrame;
  relay.acceptInbound({ peer: sourceMachine, frame });
  relay.acceptOutbound({ frame, nextHop: targetMachine });
  clock.advance(31 * 60 * 1000);
  expect(outgoing(relay, targetMachine)[0]).toMatchObject({ kind: "tombstone", reason: "expired", identity: frame.identity });
  expect(relay.retained("inbound", "aged")).toMatchObject({ state: "expired", payloadRetained: false });
  expect(relay.retained("outbound", "aged")).toMatchObject({ state: "expired", payloadRetained: false });
}, 5000);

it("a relay forwards an accepted frame without dispatching to a foreign endpoint", async () => {
  const dir = root(), clock = fakeClock();
  const source = await open(join(dir, "source", "queue.db"), sourceMachine, clock);
  const relay = await open(join(dir, "relay", "queue.db"), nextMachine, clock);
  send(source, mail("relay"), endpoint, sender, nextMachine);
  const frame = outgoing(source, nextMachine)[0] as IntercomMessageFrame;
  relay.acceptInbound({ peer: sourceMachine, frame });
  expect(incoming(relay)).toEqual([]);
  expect(() => relay.beginDispatch({ id: "relay", endpoint, readiness: "ready" })).toThrow(/machine|owner|endpoint/i);
  expect(relay.acceptOutbound({ frame, nextHop: targetMachine }).kind).toBe("accepted");
  const forwarded = outgoing(relay, targetMachine)[0];
  expect(forwarded.identity).toEqual(frame.identity);
  expect(forwarded.endpoint).toEqual(endpoint);
}, 5000);

it("does not mark an unsent message acknowledged", async () => {
  const dir = root(), clock = fakeClock(), source = await open(join(dir, "queue.db"), sourceMachine, clock);
  const identity = send(source, mail("unsent"));
  expect(() => source.acknowledge({ peer: targetMachine, identity, kind: "message" })).toThrow(/handoff|sent|acknowledg/i);
  expect(outgoing(source).map(frame => frame.identity.id)).toEqual(["unsent"]);
}, 5000);

it("a stale unknown receipt cannot undo a proved non-injection", async () => {
  const dir = root(), clock = fakeClock(), source = await open(join(dir, "queue.db"), sourceMachine, clock);
  send(source, mail("retry"));
  const frame = outgoing(source)[0] as IntercomMessageFrame;
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: { ...receipt(frame, "unknown"), attempt: 1 } });
  source.resolveUnknown({ queue: "outbound", id: "retry", digest: frame.identity.digest, proof: { ...receipt(frame, "not_injected"), attempt: 1 } });
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: { ...receipt(frame, "unknown"), attempt: 1 } });
  expect(source.inspectBlockers(sender).unknownOutcomes).toEqual([]);
  expect(outgoing(source)[0].identity).toEqual(frame.identity);
}, 5000);

it("a late receipt from an older attempt cannot settle a new same-id retry", async () => {
  const dir = root(), clock = fakeClock(), source = await open(join(dir, "queue.db"), sourceMachine, clock);
  send(source, mail("one"));
  const frame = outgoing(source)[0] as IntercomMessageFrame;
  const unknown = { ...receipt(frame, "unknown"), attempt: 1 };
  const proof = { ...receipt(frame, "not_injected"), attempt: 1 };
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: unknown });
  source.resolveUnknown({ queue: "outbound", id: "one", digest: frame.identity.digest, proof });
  expect(outgoing(source)[0].identity).toEqual(frame.identity);
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: unknown });
  expect(source.inspectBlockers(sender).unknownOutcomes).toEqual([]);
  expect(() => source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: receipt(frame, "unknown") })).toThrow(/attempt/i);
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: { ...unknown, attempt: 2 } });
  expect(source.inspectBlockers(sender).unknownOutcomes).toEqual(["one"]);
  expect(() => source.resolveUnknown({ queue: "outbound", id: "one", digest: frame.identity.digest, proof })).toThrow(/attempt|stale|proof/i);
  source.resolveUnknown({ queue: "outbound", id: "one", digest: frame.identity.digest, proof: { ...proof, attempt: 2 } });
  expect(source.inspectBlockers(sender).unknownOutcomes).toEqual([]);
}, 5000);

it("a stale link acknowledgement cannot suppress a proved same-id retry", async () => {
  const dir = root(), clock = fakeClock(), source = await open(join(dir, "queue.db"), sourceMachine, clock);
  send(source, mail("retry"));
  const frame = outgoing(source)[0] as IntercomMessageFrame;
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: { ...receipt(frame, "unknown"), attempt: 1 } });
  source.resolveUnknown({ queue: "outbound", id: "retry", digest: frame.identity.digest, proof: { ...receipt(frame, "not_injected"), attempt: 1 } });
  expect(() => source.acknowledge({ peer: targetMachine, identity: frame.identity, kind: "message" })).toThrow(/handoff|sent|acknowledg/i);
  expect(outgoing(source)[0].identity).toEqual(frame.identity);
}, 5000);

it("sending only a cancellation tombstone creates no unknown injection", async () => {
  const dir = root(), clock = fakeClock(), source = await open(join(dir, "queue.db"), sourceMachine, clock);
  send(source, mail("cancelled"));
  source.cancel({ queue: "outbound", id: "cancelled", from: sender, to: recipient });
  expect(outgoing(source)[0].kind).toBe("tombstone");
  clock.advance(24 * 60 * 60 * 1000 + 1); source.expire();
  expect(source.inspectBlockers(sender).unknownOutcomes).toEqual([]);
  expect(source.retained("outbound", "cancelled")).toMatchObject({ state: "expired", payloadRetained: false });
}, 5000);

it("a new route hint cannot replace authoritative home evidence", async () => {
  const dir = root(), clock = fakeClock(), source = await open(join(dir, "queue.db"), sourceMachine, clock);
  send(source, mail("old"));
  const old = outgoing(source)[0] as IntercomMessageFrame;
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: receipt(old, "injected") });
  const target: SessionEndpoint = { address: recipient, machineId: nextMachine, homeEpoch: 3, activationEpoch: "generation-3" };
  expect(() => source.acceptOutbound({ from: sender, endpoint: target, message: mail("new"), nextHop: nextMachine })).toThrow(/rebind|home|proof/i);
  const proof = { owner: { sessionId: recipient.sessionId, machineId: nextMachine, epoch: 3, moveId: "move-1", updatedAt: clock.now() },
    exclusion: { owner: endpoint, excludedGeneration: endpoint.activationEpoch, kind: "generation-fenced" as const }, nextHop: nextMachine };
  source.rebindUndispatched(recipient, target, proof);
  expect(send(source, mail("new"), target, sender, nextMachine).sequence).toBe(2);
}, 5000);

it("a rebind never strands accepted mail behind an oversized endpoint", async () => {
  const dir = root(), clock = fakeClock(), source = await open(join(dir, "queue.db"), sourceMachine, clock);
  send(source, mail("large", "x".repeat(255_000)));
  const target: SessionEndpoint = { address: recipient, machineId: nextMachine, homeEpoch: 3, activationEpoch: "n".repeat(20_000) };
  const proof = { owner: { sessionId: recipient.sessionId, machineId: nextMachine, epoch: 3, moveId: "move-1", updatedAt: clock.now() },
    exclusion: { owner: endpoint, excludedGeneration: endpoint.activationEpoch, kind: "generation-fenced" as const }, nextHop: nextMachine };
  expect(() => source.rebindUndispatched(recipient, target, proof)).toThrow(/size|limit/i);
  expect(source.retained("outbound", "large")).toMatchObject({ endpoint, payloadRetained: true });
  expect(outgoing(source)[0].identity.id).toBe("large");
}, 5000);

it("a rebind fences old attempts without suppressing the new owner's first attempt", async () => {
  const dir = root(), clock = fakeClock();
  const source = await open(join(dir, "source", "queue.db"), sourceMachine, clock);
  const destination = await open(join(dir, "destination", "queue.db"), nextMachine, clock);
  send(source, mail("one"));
  const old = outgoing(source)[0] as IntercomMessageFrame;
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: { ...receipt(old, "unknown"), attempt: 1 } });
  source.resolveUnknown({ queue: "outbound", id: "one", digest: old.identity.digest, proof: { ...receipt(old, "not_injected"), attempt: 1 } });
  const target: SessionEndpoint = { address: recipient, machineId: nextMachine, homeEpoch: 3, activationEpoch: "generation-3" };
  const proof = { owner: { sessionId: recipient.sessionId, machineId: nextMachine, epoch: 3, moveId: "move-1", updatedAt: clock.now() },
    exclusion: { owner: endpoint, excludedGeneration: endpoint.activationEpoch, kind: "generation-fenced" as const }, nextHop: nextMachine };
  expect(source.rebindUndispatched(recipient, target, proof)).toBe(1);
  const moved = outgoing(source, nextMachine)[0] as IntercomMessageFrame;
  destination.acceptInbound({ peer: sourceMachine, frame: moved });
  destination.beginDispatch({ id: "one", endpoint: target, readiness: "new-owner-ready" });
  const uncertain: IntercomReceiptInput = { from: target, to: sender, digest: moved.identity.digest,
    receipt: { messageId: "one", status: "unknown", timestamp: clock.now() } };
  destination.settleReceipt({ queue: "inbound", peer: sourceMachine, frame: uncertain });
  const published = destination.pending({ kind: "receipts", peer: sourceMachine })[0];
  expect(published.attempt).toBe(1);
  source.settleReceipt({ queue: "outbound", peer: nextMachine, frame: published });
  expect(source.inspectBlockers(sender).unknownOutcomes).toEqual(["one"]);
}, 5000);

it("a proved same-ID rebind can return to an earlier inbox on a new generation", async () => {
  const dir = root(), clock = fakeClock();
  const source = await open(join(dir, "source", "queue.db"), sourceMachine, clock);
  const inbox = await open(join(dir, "inbox", "queue.db"), targetMachine, clock);
  send(source, mail("one"));
  const first = outgoing(source)[0] as IntercomMessageFrame;
  inbox.acceptInbound({ peer: sourceMachine, frame: first });
  inbox.beginDispatch({ id: "one", endpoint, readiness: "old-idle" });
  const target: SessionEndpoint = { ...endpoint, activationEpoch: "generation-new" };
  const proof = { owner: { sessionId: recipient.sessionId, machineId: targetMachine, epoch: 2, moveId: null, updatedAt: clock.now() },
    exclusion: { owner: endpoint, excludedGeneration: endpoint.activationEpoch, kind: "owner-exited" as const }, nextHop: targetMachine };
  const candidate = { ...first, endpoint: target };
  const cursor = { from: sender, to: recipient, through: 0, endpoint: target, proof };
  expect(() => inbox.acceptInbound({ peer: sourceMachine, frame: candidate, resume: { cursor, owner: proof.owner } })).toThrow(/non-injection|proof/i);
  inbox.resolveUnknown({ queue: "inbound", id: "one", digest: first.identity.digest, proof: receipt(first, "not_injected") });
  expect(() => inbox.acceptInbound({ peer: sourceMachine, frame: candidate, resume: { cursor, owner: proof.owner } })).toThrow(/unobserved|receipt/i);
  const absence = inbox.pending({ kind: "receipts", peer: sourceMachine })[0];
  inbox.acknowledgeReceipt({ peer: sourceMachine, frame: absence });
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: absence });
  source.resolveUnknown({ queue: "outbound", id: "one", digest: first.identity.digest, proof: absence });
  expect(source.rebindUndispatched(recipient, target, proof)).toBe(1);
  const frame = outgoing(source)[0] as IntercomMessageFrame;
  expect(() => inbox.acceptInbound({ peer: sourceMachine, frame })).toThrow(/route|proof/i);
  const resume = source.outboundResumptions(targetMachine)[0];
  expect(inbox.acceptInbound({ peer: sourceMachine, frame, resume: { cursor: resume, owner: proof.owner } }).kind).toBe("duplicate");
  expect(inbox.beginDispatch({ id: "one", endpoint: target, readiness: "new-idle" }).identity).toEqual(first.identity);
}, 5000);

it("a new home resumes pair ordering without accepting a skipped frame", async () => {
  const dir = root(), clock = fakeClock();
  const source = await open(join(dir, "source", "queue.db"), sourceMachine, clock);
  const destination = await open(join(dir, "destination", "queue.db"), nextMachine, clock);
  send(source, mail("old"));
  const old = outgoing(source)[0] as IntercomMessageFrame;
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: receipt(old, "injected") });
  expect(send(source, mail("moved")).sequence).toBe(2);
  const target: SessionEndpoint = { address: recipient, machineId: nextMachine, homeEpoch: 3, activationEpoch: "generation-3" };
  const proof = { owner: { sessionId: recipient.sessionId, machineId: nextMachine, epoch: 3, moveId: "move-1", updatedAt: clock.now() },
    exclusion: { owner: endpoint, excludedGeneration: endpoint.activationEpoch, kind: "generation-fenced" as const }, nextHop: nextMachine };
  source.rebindUndispatched(recipient, target, proof);
  expect(send(source, mail("later"), target, sender, nextMachine).sequence).toBe(3);
  const frames = outgoing(source, nextMachine);
  expect(frames.map(frame => frame.identity.sequence)).toEqual([2, 3]);
  expect(() => destination.acceptInbound({ peer: sourceMachine, frame: frames[0] })).toThrow(/sequence|cursor/i);
  expect(source.outboundResumptions).toBeTypeOf("function");
  const resume = source.outboundResumptions(nextMachine)[0];
  expect(resume).toMatchObject({ from: sender, to: recipient, through: 1, endpoint: target });
  expect(() => destination.acceptInbound({ peer: sourceMachine, frame: frames[1], resume: { cursor: resume, owner: proof.owner } })).toThrow(/sequence|cursor/i);
  expect(() => destination.acceptInbound({ peer: sourceMachine, frame: frames[0], resume: { cursor: resume, owner: { ...proof.owner, epoch: 4 } } })).toThrow(/home|proof/i);
  expect(destination.acceptInbound({ peer: sourceMachine, frame: frames[0], resume: { cursor: resume, owner: proof.owner } }).kind).toBe("accepted");
  expect(destination.acceptInbound({ peer: sourceMachine, frame: frames[1] }).kind).toBe("accepted");
  expect(incoming(destination)).toEqual(["moved"]);
}, 5000);

it("a pair with no queued mail resumes after its next message is created", async () => {
  const dir = root(), clock = fakeClock();
  const source = await open(join(dir, "source", "queue.db"), sourceMachine, clock);
  const destination = await open(join(dir, "destination", "queue.db"), nextMachine, clock);
  send(source, mail("old"));
  const old = outgoing(source)[0] as IntercomMessageFrame;
  source.settleReceipt({ queue: "outbound", peer: targetMachine, frame: receipt(old, "injected") });
  const target: SessionEndpoint = { address: recipient, machineId: nextMachine, homeEpoch: 3, activationEpoch: "generation-3" };
  const proof = { owner: { sessionId: recipient.sessionId, machineId: nextMachine, epoch: 3, moveId: "move-1", updatedAt: clock.now() },
    exclusion: { owner: endpoint, excludedGeneration: endpoint.activationEpoch, kind: "owner-exited" as const }, nextHop: nextMachine };
  expect(source.rebindUndispatched(recipient, target, proof)).toBe(0);
  expect(send(source, mail("later"), target, sender, nextMachine).sequence).toBe(2);
  const frame = outgoing(source, nextMachine)[0];
  expect(source.outboundResumptions).toBeTypeOf("function");
  const resume = source.outboundResumptions(nextMachine)[0];
  expect(destination.acceptInbound({ peer: sourceMachine, frame, resume: { cursor: resume, owner: proof.owner } }).kind).toBe("accepted");
  expect(incoming(destination)).toEqual(["later"]);
}, 5000);

it("an exchange budget that cannot fit a frame has no handoff effects", async () => {
  const dir = root(), clock = fakeClock(), source = await open(join(dir, "queue.db"), sourceMachine, clock);
  send(source, mail("one"));
  expect(source.pending({ kind: "outbound", peer: targetMachine, hopBudgetMs: 100, maxBytes: 1 })).toEqual([]);
  const target: SessionEndpoint = { address: recipient, machineId: nextMachine, homeEpoch: 3, activationEpoch: "generation-3" };
  const proof = { owner: { sessionId: recipient.sessionId, machineId: nextMachine, epoch: 3, moveId: "move-1", updatedAt: clock.now() },
    exclusion: { owner: endpoint, excludedGeneration: endpoint.activationEpoch, kind: "generation-fenced" as const }, nextHop: nextMachine };
  expect(source.rebindUndispatched(recipient, target, proof)).toBe(1);
  expect(outgoing(source, nextMachine)[0].identity.id).toBe("one");
}, 5000);

it("a lost link reply cannot make an attempted dispatch eligible for rebind", async () => {
  const dir = root(), clock = fakeClock(), source = await open(join(dir, "queue.db"), sourceMachine, clock);
  send(source, mail("uncertain"));
  outgoing(source);
  const target: SessionEndpoint = { address: recipient, machineId: nextMachine, homeEpoch: 3, activationEpoch: "generation-3" };
  const proof = { owner: { sessionId: recipient.sessionId, machineId: nextMachine, epoch: 3, moveId: "move-1", updatedAt: clock.now() },
    exclusion: { owner: endpoint, excludedGeneration: endpoint.activationEpoch, kind: "generation-fenced" as const }, nextHop: nextMachine };
  expect(() => source.rebindUndispatched(recipient, target, proof)).toThrow(/unknown|dispatch|proof/i);
  expect(source.retained("outbound", "uncertain")).toMatchObject({ payloadRetained: true, endpoint });
}, 5000);

it("repairs private modes only for a valid owned store", async () => {
  if (process.platform === "win32") return;
  const dir = root(), clock = fakeClock(), folder = join(dir, "private"), file = join(folder, "queue.db");
  mkdirSync(folder); chmodSync(folder, 0o755); writeFileSync(file, ""); chmodSync(file, 0o644);
  const store = await open(file, sourceMachine, clock);
  send(store, mail("one"));
  expect(lstatSync(folder).mode & 0o777).toBe(0o700);
  expect(lstatSync(file).mode & 0o777).toBe(0o600);
}, 5000);

it("rejects hard-linked databases and symlinked WAL files", async () => {
  if (process.platform === "win32") return;
  const dir = root(), clock = fakeClock(), original = join(dir, "original"), hard = join(dir, "hard.db");
  writeFileSync(original, ""); linkSync(original, hard);
  await expect(open(hard, sourceMachine, clock)).rejects.toThrow(/unsafe|symlink/i);
  expect(readFileSync(original, "utf8")).toBe("");
  const folder = join(dir, "sidecar"), file = join(folder, "queue.db"), victim = join(dir, "victim");
  mkdirSync(folder); writeFileSync(file, ""); writeFileSync(victim, "unchanged"); symlinkSync(victim, `${file}-wal`);
  await expect(open(file, sourceMachine, clock)).rejects.toThrow(/unsafe|symlink/i);
  expect(readFileSync(victim, "utf8")).toBe("unchanged");
}, 5000);

it("uses private files and refuses symlink destinations", async () => {
  const dir = root(), clock = fakeClock(), file = join(dir, "private", "queue.db");
  const store = await open(file, sourceMachine, clock);
  send(store, mail("one"));
  if (process.platform !== "win32") {
    expect(lstatSync(dirname(file)).mode & 0o777).toBe(0o700);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
  }
  expect(() => store.acceptOutbound({ from: sender, endpoint, message: mail("one", "changed"), nextHop: targetMachine })).toThrow();
  if (process.platform !== "win32") {
    const other = join(dir, "other.db"), bad = join(dir, "bad", "queue.db");
    writeFileSync(other, "unchanged"); mkdirSync(dirname(bad)); symlinkSync(other, bad);
    await expect(open(bad, sourceMachine, clock)).rejects.toThrow(/unsafe|symlink/i);
    expect(readFileSync(other, "utf8")).toBe("unchanged");
  }
}, 5000);
