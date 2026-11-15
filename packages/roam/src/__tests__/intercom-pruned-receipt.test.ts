import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { scratchDbPath } from "@spider/db-core/testutil";
import { openDb } from "@spider/db-core";
import type { RemoteSessionInfo } from "@spider/intercom/protocol";
import { openIntercomStore } from "../intercom-store";
import { makeMessageFrame } from "../intercom-codec";
import { createIntercomBridge } from "../intercom-bridge";
import { INTERCOM_PAYLOAD_MS, type IntercomExchange, type IntercomReceiptFrame } from "../intercom-contracts";

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const aUser = { sessionId: "a-user", scopeId: "scope" }, bUser = { sessionId: "b-user", scopeId: "scope" };
const bEndpoint = { address: bUser, machineId: B, homeEpoch: 1, activationEpoch: "b-act" };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const peer = { machineId: B, alias: "peer.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/core", globalRoot: "/fixture/global" };
const presence: RemoteSessionInfo = { remote: true, id: bUser.sessionId, address: bUser, machineId: B, machineAlias: peer.alias, homeEpoch: 1,
  activationEpoch: "b-act", endpointEpoch: "b-act", cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1 };

async function fixture(queueMessages = 256) {
  const root = mkdtempSync(join(dirname(scratchDbPath("roam-intercom")), "pruned-receipt-"));
  cleanups.push(() => rmSync(root, { force: true, recursive: true }));
  let time = 1000;
  const clock = { now: () => time, later: () => () => {} }, file = join(root, "a.db");
  const sourceOptions = { file, machineId: A, clock, limits: { queueMessages } };
  let a = openIntercomStore(sourceOptions);
  let b = openIntercomStore({ file: join(root, "b.db"), machineId: B, clock });
  const inbound: string[] = [];
  const make = () => createIntercomBridge({ machineId: A, machineAlias: "source.invalid", store: a, clock,
    edges: [{ peer, edgeEpoch: "edge", initiator: false }],
    transport: { resolve: async () => { throw new Error("offline"); }, exec: async () => { throw new Error("offline"); } } as never,
    localPresence: () => [], authoritativeHome: address => address.sessionId === bUser.sessionId
      ? { sessionId: bUser.sessionId, machineId: B, epoch: 1, moveId: null, updatedAt: 1 } : null,
    publishPresence: () => {}, onInbound: entry => inbound.push(entry.id) });
  let bridge = make();
  cleanups.push(async () => { await bridge.stop(); a.close(); b.close(); }); await bridge.start();
  let generation = 0;
  const send = (input: Partial<IntercomExchange>) => bridge.exchange({ version: 1, holdMs: 0, deadlineMs: 5000, exchange: { protocol: 4,
    senderMachine: B, recipientMachine: A, generation: { edgeEpoch: "edge", channel: "push", generation: ++generation },
    frames: [], acknowledgements: [], receipts: [], controls: [], presence: [presence], ...input } });
  const injected = async (id: string): Promise<IntercomReceiptFrame> => {
    a.acceptOutbound({ from: aUser, endpoint: bEndpoint, nextHop: B, message: { id, timestamp: time, content: { text: "synthetic" } } });
    const frame = a.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 }).find(frame => frame.identity.id === id)!;
    b.acceptInbound({ peer: A, frame });
    await send({ acknowledgements: [{ identity: frame.identity, kind: "message" }] });
    b.beginDispatch({ id, endpoint: bEndpoint, readiness: `ready-${id}` });
    b.settleReceipt({ queue: "inbound", peer: A, frame: { from: bEndpoint, to: aUser, digest: frame.identity.digest, attempt: 1,
      receipt: { messageId: id, status: "injected", timestamp: time,
        evidence: { kind: "entry", entryId: `entry-${id}`, sessionId: bUser.sessionId, activationEpoch: "b-act" } } } });
    const receipt = b.pending({ kind: "receipts", peer: A }).find(frame => frame.receipt.messageId === id)!;
    await send({ receipts: [receipt] });
    return receipt;
  };
  const frame = (id: string, sequence: number) => makeMessageFrame({ from: bUser,
    endpoint: { address: aUser, machineId: A, homeEpoch: null, activationEpoch: "a-act" }, sequence, originMachineId: B,
    message: { id, timestamp: time, content: { text: "new work" } } });
  return { send, injected, frame, inbound, get b() { return b; }, get a() { return a; },
    settleStored(id: string) {
      a.acceptOutbound({ from: aUser, endpoint: bEndpoint, nextHop: B, message: { id, timestamp: time, content: { text: 'synthetic' } } });
      const original = a.pending({ kind: 'outbound', peer: B, hopBudgetMs: 100 }).find(frame => frame.identity.id === id)!;
      const receipt: IntercomReceiptFrame = { from: bEndpoint, to: aUser, digest: original.identity.digest,
        originMachineId: original.originMachineId, sequence: original.identity.sequence, attempt: 1,
        receipt: { messageId: id, status: 'injected', timestamp: time,
          evidence: { kind: 'entry', entryId: `entry-${id}`, sessionId: bUser.sessionId, activationEpoch: bEndpoint.activationEpoch } } };
      a.settleReceipt({ queue: 'outbound', peer: B, frame: receipt }); return receipt;
    },
    hashCount() { const db = openDb(file); try { return (db.prepare('SELECT count(*) AS count FROM intercom_settled_receipts').get() as { count: number }).count; } finally { db.close(); } },
    async upgradeQueuedReceipts(rejected = false) {
      let legacy: Record<string, unknown> | undefined;
      if (rejected) {
        const original = makeMessageFrame({ from: aUser, endpoint: bEndpoint, originMachineId: A, sequence: 2,
          message: { id: 'legacy-rejected', timestamp: 1000, content: { text: 'synthetic' } } });
        b.rejectMissingOrigin({ peer: A, frame: { index: 0, identity: original.identity, endpoint: bEndpoint, kind: 'message' } });
        legacy = { from: bEndpoint, to: aUser, digest: original.identity.digest, attempt: 0,
          receipt: { messageId: 'legacy-rejected', status: 'cancelled', timestamp: 1000, detail: 'missing-origin' } };
      }
      b.close(); const db = openDb(join(root, 'b.db'));
      try {
        if (legacy) db.prepare('INSERT INTO intercom_receipts(receipt_key,id,peer,frame_json) VALUES(?,?,?,?)').run('f'.repeat(64), 'legacy-rejected', A, JSON.stringify(legacy));
        db.exec("DROP TABLE IF EXISTS intercom_receipt_positions; DROP TABLE IF EXISTS intercom_settled_watermarks; UPDATE intercom_receipts SET frame_json=json_remove(frame_json,'$.originMachineId','$.sequence'); UPDATE intercom_meta SET version=6");
      }
      finally { db.close(); }
      b = openIntercomStore({ file: join(root, 'b.db'), machineId: B, clock });
    },
    prune() { time += 2 * INTERCOM_PAYLOAD_MS + 1; a.expire(); b.expire(); },
    async upgradeFromV5() {
      await bridge.stop(); a.close();
      const db = openDb(file);
      try { db.exec("DROP TABLE IF EXISTS intercom_receipt_positions; DROP TABLE IF EXISTS intercom_settled_watermarks; DROP TABLE intercom_refused_slots; DROP TABLE intercom_settled_receipts; UPDATE intercom_meta SET version=5"); } finally { db.close(); }
      a = openIntercomStore(sourceOptions); bridge = make(); await bridge.start();
    },
    async restart() { await bridge.stop(); a.close(); a = openIntercomStore(sourceOptions); bridge = make(); await bridge.start(); } };
}

it('receipts carry the original message origin and sequence', async () => {
  const f = await fixture(), receipt = await f.injected('stream-metadata');
  expect(receipt).toMatchObject({ originMachineId: A, sequence: 1 });
}, 5000);

it.each(['origin', 'sequence'] as const)('refuses a live receipt with mismatched original %s metadata by name', async field => {
  const f = await fixture(), receipt = await f.injected(`bad-${field}`);
  const changed = { ...receipt, originMachineId: field === 'origin' ? B : A, sequence: field === 'sequence' ? 2 : 1 };
  await expect(f.send({ receipts: [changed] })).rejects.toThrow('receipt-stream-mismatch');
  expect(f.a.retained('outbound', receipt.receipt.messageId)?.state).toBe('injected');
}, 5000);

it('refuses old-format receipts by name without a compatibility path', async () => {
  const f = await fixture(), receipt = await f.injected('old-format');
  const old = { ...receipt } as Record<string, unknown>;
  delete old.originMachineId; delete old.sequence;
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(f.send({ receipts: [old as unknown as IntercomReceiptFrame] })).rejects.toMatchObject({ code: 'receipt-stream-missing', retryable: true });
    await expect(f.send({ protocol: 3 as never, receipts: [old as unknown as IntercomReceiptFrame] })).rejects.toMatchObject({ code: 'peer-version-mismatch', retryable: true });
  }
  expect(f.a.retained('outbound', 'old-format')?.state).toBe('injected');
}, 5000);

it('settled receipt hash retention does not grow with pruned history', async () => {
  const f = await fixture();
  for (let i = 0; i < 32; i++) f.settleStored(`history-${i}`);
  f.prune(); await f.restart();
  expect(f.hashCount()).toBe(0);
  for (let i = 32; i < 64; i++) f.settleStored(`history-${i}`);
  f.prune();
  expect(f.hashCount()).toBe(0);
}, 5000);

it.each(['injected', 'not_injected'] as const)('bounds receipt hashes behind an unknown slot and validates above-watermark digests with %s recovery', async recovery => {
  const f = await fixture(4);
  f.a.acceptOutbound({ from: aUser, endpoint: bEndpoint, nextHop: B, message: { id: 'hole', timestamp: 1, content: { text: 'synthetic' } } });
  const hole = f.a.pending({ kind: 'outbound', peer: B, hopBudgetMs: 100 })[0];
  f.a.settleReceipt({ queue: 'outbound', peer: B, frame: { from: bEndpoint, to: aUser, digest: hole.identity.digest, attempt: 1,
    receipt: { messageId: 'hole', status: 'unknown', timestamp: 1000 } } });
  const later = f.settleStored('later-1'); f.settleStored('later-2'); f.settleStored('later-3');
  f.prune(); await f.restart();
  expect(f.hashCount()).toBe(3);
  await expect(f.send({ receipts: [{ ...later, digest: 'f'.repeat(64) }] })).rejects.toThrow('invalid-receipt');
  expect((await f.send({ receipts: [later] })).exchange.receiptAcknowledgements).toEqual([later]);
  const sendNext = () => f.a.acceptOutbound({ from: aUser, endpoint: bEndpoint, nextHop: B, message: { id: 'next', timestamp: 1, content: { text: 'synthetic' } } });
  expect(sendNext()).toEqual({ kind: 'refused', reason: 'queue-full' });
  expect(f.hashCount()).toBe(3);
  if (recovery === 'injected') f.a.settleReceipt({ queue: 'outbound', peer: B, frame: { from: bEndpoint, to: aUser, digest: hole.identity.digest,
    originMachineId: hole.originMachineId, sequence: hole.identity.sequence, attempt: 1,
    receipt: { messageId: 'hole', status: 'injected', timestamp: 1000,
      evidence: { kind: 'entry', entryId: 'entry-hole', sessionId: bUser.sessionId, activationEpoch: bEndpoint.activationEpoch } } } });
  else f.a.resolveUnknown({ queue: 'outbound', id: 'hole', digest: hole.identity.digest,
    proof: { from: bEndpoint, to: aUser, digest: hole.identity.digest, originMachineId: hole.originMachineId, sequence: hole.identity.sequence, attempt: 1,
      receipt: { messageId: 'hole', status: 'not_injected', timestamp: 1000,
        evidence: { kind: 'absence', sessionId: bUser.sessionId, activationEpoch: bEndpoint.activationEpoch, excludedGeneration: bEndpoint.activationEpoch, complete: true } } } });
  expect(f.hashCount()).toBe(0); expect(sendNext().kind).toBe('accepted');
}, 5000);

it('does not watermark a cancelled slot whose delivery is still unknown', async () => {
  const f = await fixture();
  f.a.acceptOutbound({ from: aUser, endpoint: bEndpoint, nextHop: B, message: { id: 'late-consumption', timestamp: 1000, content: { text: 'synthetic' } } });
  const original = f.a.pending({ kind: 'outbound', peer: B, hopBudgetMs: 100 })[0];
  f.a.cancel({ queue: 'outbound', id: original.identity.id, from: aUser, to: bUser });
  expect(f.a.retained('outbound', original.identity.id)).toMatchObject({ state: 'cancelled', payloadRetained: true });
  expect(f.a.inspectBlockers(aUser).unknownOutcomes).toEqual([original.identity.id]);
  const receipt: IntercomReceiptFrame = { from: bEndpoint, to: aUser, digest: original.identity.digest,
    originMachineId: original.originMachineId, sequence: original.identity.sequence, attempt: 1,
    receipt: { messageId: original.identity.id, status: 'injected', timestamp: 1000,
      evidence: { kind: 'entry', entryId: 'late-entry', sessionId: bUser.sessionId, activationEpoch: bEndpoint.activationEpoch } } };
  expect((await f.send({ receipts: [receipt] })).exchange.receiptAcknowledgements).toEqual([receipt]);
  expect(f.a.retained('outbound', original.identity.id)).toMatchObject({ state: 'injected', payloadRetained: false });
}, 5000);

it('a forged low-sequence receipt from an authenticated peer is only acknowledged', async () => {
  const f = await fixture(), receipt = await f.injected('settled-low');
  f.prune();
  f.a.acceptOutbound({ from: aUser, endpoint: bEndpoint, nextHop: B, message: { id: 'still-live', timestamp: 1, content: { text: 'synthetic' } } });
  const before = f.a.retained('outbound', 'still-live');
  const forged = { ...receipt, originMachineId: A, sequence: 1, digest: 'f'.repeat(64), receipt: { ...receipt.receipt, messageId: 'forged-old' } };
  expect((await f.send({ receipts: [forged] })).exchange.receiptAcknowledgements).toEqual([forged]);
  expect(f.a.retained('outbound', 'still-live')).toEqual(before);
  expect(f.a.retained('outbound', 'forged-old')).toBeNull();
  expect(f.inbound).toEqual([]); expect(f.hashCount()).toBe(0);
  expect(f.a.isSettledReceipt({ peer: '00000000-0000-4000-8000-000000000003', frame: forged })).toBe(false);
  await expect(f.send({ receipts: [{ ...forged, originMachineId: B }] })).rejects.toThrow('invalid-receipt');
  await expect(f.send({ receipts: [{ ...forged, from: { ...forged.from, address: { ...bUser, scopeId: 'other' } }, to: { ...aUser, scopeId: 'other' } }] })).rejects.toThrow('invalid-receipt');
}, 5000);

it('migrates queued receipts from retained original identities once', async () => {
  const f = await fixture(), receipt = await f.injected('queued-upgrade');
  await f.upgradeQueuedReceipts();
  expect(f.b.pending({ kind: 'receipts', peer: A })).toEqual([receipt]);
  expect(receipt).toMatchObject({ originMachineId: A, sequence: 1 });
  f.prune();
  expect((await f.send({ receipts: [...f.b.pending({ kind: 'receipts', peer: A })] })).exchange.receiptAcknowledgements).toEqual([receipt]);
}, 5000);

it('does not invent an original stream for a queued legacy origin-less rejection', async () => {
  const f = await fixture(), receipt = await f.injected('valid-before-rejection-upgrade');
  await f.upgradeQueuedReceipts(true);
  expect(f.b.pending({ kind: 'receipts', peer: A })).toEqual([receipt]);
  expect(f.b.retained('inbound', 'legacy-rejected')).toMatchObject({ state: 'cancelled', failureReason: 'missing-origin', payloadRetained: false });
  expect(f.b.retained('inbound', 'legacy-rejected')?.originMachineId).toBeUndefined();
}, 5000);

it("acknowledges re-sent pruned receipts without dropping later frames", async () => {
  const f = await fixture(), receipt = await f.injected("settled");
  expect(f.a.retained("outbound", "settled")?.state).toBe("injected");
  f.prune(); expect(f.a.retained("outbound", "settled")).toBeNull();
  for (const sequence of [1, 2, 3]) {
    const reply = await f.send({ receipts: [...f.b.pending({ kind: "receipts", peer: A })], frames: [f.frame(`new-${sequence}`, sequence)] });
    expect(reply.exchange.receiptAcknowledgements).toContainEqual(receipt);
  }
  expect(f.inbound).toEqual(["new-1", "new-2", "new-3"]);
  f.b.acknowledgeReceipt({ peer: A, frame: receipt });
  expect(f.b.pending({ kind: "receipts", peer: A })).toEqual([]);
}, 5000);

it.each(['receiver_received', 'acknowledged'] as const)('acknowledges a previously validated %s receipt after terminal history is pruned', async status => {
  const f = await fixture(), terminal = await f.injected(`progress-${status}`);
  const progress: IntercomReceiptFrame = { ...terminal, receipt: { messageId: terminal.receipt.messageId, status, timestamp: 1000 } };
  expect((await f.send({ receipts: [progress] })).exchange.receiptAcknowledgements).toEqual([progress]);
  expect(f.a.retained('outbound', terminal.receipt.messageId)?.state).toBe('injected');
  f.prune(); await f.restart();
  const reply = await f.send({ receipts: [progress], frames: [f.frame(`after-${status}`, 1)] });
  expect(reply.exchange.receiptAcknowledgements).toEqual([progress]);
  expect(f.inbound).toEqual([`after-${status}`]);
}, 5000);

it("keeps compact settled receipt evidence across a queue restart", async () => {
  const f = await fixture(), receipt = await f.injected("before-restart");
  f.prune(); await f.restart();
  expect(f.a.retained("outbound", "before-restart")).toBeNull();
  const reply = await f.send({ receipts: [receipt], frames: [f.frame("after-restart", 1)] });
  expect(reply.exchange.receiptAcknowledgements).toEqual([receipt]);
  expect(f.inbound).toEqual(["after-restart"]);
}, 5000);

it("still validates receipts for newer unsettled messages and rejects changed pruned evidence", async () => {
  const f = await fixture(), receipt = await f.injected("old");
  f.prune();
  f.a.acceptOutbound({ from: aUser, endpoint: bEndpoint, nextHop: B, message: { id: "newer", timestamp: 1, content: { text: "synthetic" } } });
  const newer = f.a.pending({ kind: "outbound", peer: B, hopBudgetMs: 100 })[0];
  const invalid = { ...receipt, originMachineId: A, sequence: newer.identity.sequence, digest: "f".repeat(64), receipt: { ...receipt.receipt, messageId: "newer" } };
  await expect(f.send({ receipts: [invalid] })).rejects.toThrow();
  expect(f.a.retained("outbound", "newer")).toMatchObject({ state: "queued", payloadRetained: true });
  const settledDuplicate = { ...receipt, digest: 'f'.repeat(64) };
  expect((await f.send({ receipts: [settledDuplicate] })).exchange.receiptAcknowledgements).toEqual([settledDuplicate]);
  const valid = { ...receipt, originMachineId: A, sequence: newer.identity.sequence, digest: newer.identity.digest, receipt: { ...receipt.receipt, messageId: "newer", evidence: {
    kind: "entry" as const, entryId: "entry-newer", sessionId: bUser.sessionId, activationEpoch: "b-act" } } };
  expect((await f.send({ receipts: [valid] })).exchange.receiptAcknowledgements).toEqual([valid]);
  expect(f.a.retained("outbound", "newer")?.state).toBe("injected");
}, 5000);


it("preserves settled receipt duplicates when a version-5 queue upgrades before pruning", async () => {
  const f = await fixture(), receipt = await f.injected("before-upgrade");
  await f.upgradeFromV5(); f.prune();
  expect(f.a.retained("outbound", "before-upgrade")).toBeNull();
  expect((await f.send({ receipts: [receipt] })).exchange.receiptAcknowledgements).toEqual([receipt]);
}, 5000);
