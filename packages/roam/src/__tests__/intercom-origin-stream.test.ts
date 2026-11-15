import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { scratchDbPath } from "@spider/db-core/testutil";
import type { SessionAddress, SessionEndpoint } from "@spider/intercom/protocol";
import { openIntercomStore } from "../intercom-store";
import { makeMessageFrame } from "../intercom-codec";
import { INTERCOM_PAYLOAD_MS } from '../intercom-contracts';

const B = "00000000-0000-4000-8000-000000000001";
const H = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const roots: string[] = []; const opened: Array<{ close(): void }> = [];
afterEach(() => { for (const s of opened.splice(0)) s.close(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const clock = { now: () => 1_000_000 };
const recipient: SessionAddress = { sessionId: "recipient", scopeId: "scope" };
const local: SessionEndpoint = { address: recipient, machineId: H, homeEpoch: null, activationEpoch: "gen-1" };

it('never borrows a refused physical position from another peer or enrollment epoch', () => {
  const root = mkdtempSync(join(dirname(scratchDbPath('roam-intercom')), 'hop-scope-')); roots.push(root);
  const store = openIntercomStore({ file: join(root, 'q.db'), machineId: H, clock }); opened.push(store);
  const from = { sessionId: 'sender', scopeId: 'scope' };
  const refused = makeMessageFrame({ from, endpoint: local, originMachineId: B, sequence: 1,
    message: { id: 'refused-hop', timestamp: 1, content: { text: 'synthetic' } } });
  store.openHop(B, 'old');
  store.rejectHop({ peer: B, edgeEpoch: 'old', sequence: 1, identity: refused.identity, origin: B, reason: 'sender-unauthorized' });
  store.openHop(B, 'fresh'); store.openHop(C, 'old');
  for (const [peer, edgeEpoch] of [[B, 'fresh'], [C, 'old']]) {
    expect(() => store.inspectHop({ peer, edgeEpoch, sequence: 2, identity: refused.identity, origin: B })).toThrow('hop-sequence-gap');
  }
  expect(store.retained('inbound', 'refused-hop')).toBeNull();
  const next = makeMessageFrame({ from, endpoint: local, originMachineId: B, sequence: 2,
    message: { id: 'fresh-hop', timestamp: 1, content: { text: 'synthetic' } } });
  expect(store.acceptInbound({ peer: B, frame: next, hop: { edgeEpoch: 'fresh', sequence: 1 } }).kind).toBe('accepted');
  store.beginDispatch({ id: 'fresh-hop', endpoint: local, readiness: 'ready' });
  expect(() => store.acceptInbound({ peer: B, frame: next, hop: { edgeEpoch: 'fresh', sequence: 3 } })).toThrow('hop-sequence-gap');
  expect(store.inspectBlockers(from).unknownOutcomes).toEqual(['fresh-hop']);
  store.openHop(B, 'fresh');
  expect(store.inspectHop({ peer: B, edgeEpoch: 'fresh', sequence: 1, identity: next.identity, origin: B })).toEqual({ kind: 'duplicate' });
}, 5000);

it('requires a fresh authenticated physical stream before storing a first frame', () => {
  const root = mkdtempSync(join(dirname(scratchDbPath('roam-intercom')), 'hop-start-')); roots.push(root);
  const store = openIntercomStore({ file: join(root, 'q.db'), machineId: H, clock }); opened.push(store);
  const frame = makeMessageFrame({ from: { sessionId: 'sender', scopeId: 'scope' }, endpoint: local, originMachineId: B, sequence: 10,
    message: { id: 'first', timestamp: 1, content: { text: 'synthetic' } } });
  expect(() => store.acceptInbound({ peer: B, frame, hop: { edgeEpoch: 'fresh', sequence: 1 } })).toThrow('hop-stream-unstarted');
  expect(store.retained('inbound', 'first')).toBeNull();
  store.openHop(B, 'fresh');
  expect(store.acceptInbound({ peer: B, frame, hop: { edgeEpoch: 'fresh', sequence: 1 } })).toMatchObject({ kind: 'accepted', identity: { sequence: 10 } });
}, 5000);

it('deduplicates retired hop acknowledgements without changing newer pending mail', () => {
  const root = mkdtempSync(join(dirname(scratchDbPath('roam-intercom')), 'hop-retired-')); roots.push(root);
  let time = 1000;
  const store = openIntercomStore({ file: join(root, 'q.db'), machineId: H, clock: { now: () => time } }); opened.push(store);
  const from = { sessionId: 'sender', scopeId: 'scope' }, endpoint = { ...local, machineId: C };
  store.acceptOutbound({ from, endpoint, nextHop: B, message: { id: 'retired', timestamp: 1, content: { text: 'synthetic' } } });
  const frame = store.pending({ kind: 'outbound', peer: B, edgeEpoch: 'old', hopBudgetMs: 100 })[0];
  store.settleReceipt({ queue: 'outbound', peer: B, frame: { from: endpoint, to: from, digest: frame.identity.digest, originMachineId: H, sequence: 1, attempt: 0,
    receipt: { messageId: frame.identity.id, status: 'injected', timestamp: 1000,
      evidence: { kind: 'entry', entryId: 'entry', sessionId: recipient.sessionId, activationEpoch: endpoint.activationEpoch } } } });
  time += 2 * INTERCOM_PAYLOAD_MS + 1; store.expire();
  expect(store.retained('outbound', 'retired')).toBeNull();
  store.acceptOutbound({ from, endpoint, nextHop: B, message: { id: 'newer', timestamp: 1, content: { text: 'synthetic' } } });
  const newer = store.pending({ kind: 'outbound', peer: B, edgeEpoch: 'old', hopBudgetMs: 100 })[0];
  expect(newer.hopSequence).toBe(2);
  expect(store.acknowledge({ peer: B, edgeEpoch: 'old', hopSequence: 1, identity: frame.identity, kind: 'message' })).toBeUndefined();
  expect(() => store.acknowledge({ peer: C, edgeEpoch: 'old', hopSequence: 1, identity: frame.identity, kind: 'message' })).toThrow('hop-ack-mismatch');
  expect(() => store.acknowledge({ peer: B, edgeEpoch: 'old', hopSequence: 1, identity: newer.identity, kind: 'message' })).toThrow('hop-ack-mismatch');
  expect(store.retained('outbound', 'newer')).toMatchObject({ state: 'queued', linkAcknowledged: false, payloadRetained: true });
}, 5000);

it('keeps resumption proofs scoped by peer and epoch without replacing earlier hop history', () => {
  const root = mkdtempSync(join(dirname(scratchDbPath('roam-intercom')), 'hop-resume-')); roots.push(root);
  const store = openIntercomStore({ file: join(root, 'q.db'), machineId: H, clock }); opened.push(store);
  const from = { sessionId: 'sender', scopeId: 'scope' }, old = { ...local, machineId: B, homeEpoch: 1 }, next = { ...old, homeEpoch: 2, activationEpoch: 'gen-2' };
  store.acceptOutbound({ from, endpoint: old, nextHop: B, message: { id: 'pending', timestamp: 1, content: { text: 'synthetic' } } });
  const owner = { sessionId: recipient.sessionId, machineId: B, epoch: 2, moveId: null, updatedAt: 1 };
  store.rebindUndispatched(recipient, next, { owner, nextHop: B, exclusion: { owner: old, excludedGeneration: old.activationEpoch, kind: 'generation-fenced' } }, 'old-edge');
  expect(store.outboundResumptions(B, 'old-edge')).toHaveLength(1);
  expect(store.outboundResumptions(B, 'new-edge')).toEqual([]);
  expect(store.outboundResumptions(C, 'old-edge')).toEqual([]);
  const newest = { ...next, homeEpoch: 3, activationEpoch: 'gen-3' };
  store.rebindUndispatched(recipient, newest, { owner: { ...owner, epoch: 3 }, nextHop: C,
    exclusion: { owner: next, excludedGeneration: next.activationEpoch, kind: 'generation-fenced' } }, 'new-edge');
  expect(store.outboundResumptions(C, 'new-edge')).toMatchObject([{ endpoint: newest }]);
  expect(store.outboundResumptions(B, 'old-edge')).toMatchObject([{ endpoint: next }]);
}, 5000);

it("keeps inbound sequence streams separate for each origin", () => {
  const dir = mkdtempSync(join(dirname(scratchDbPath("roam-intercom")), "spoof-")); roots.push(dir);
  const hub = openIntercomStore({ file: join(dir, "q.db"), machineId: H, clock }); opened.push(hub);
  const cSession: SessionAddress = { sessionId: "c-session", scopeId: "scope" };
  const forged = makeMessageFrame({ from: cSession, endpoint: local, sequence: 1, message: { id: "forged", timestamp: 1, content: { text: "hi from c (not)" } }, originMachineId: B });
  expect(hub.acceptInbound({ peer: B, frame: forged }).kind).toBe("accepted");
  const real = makeMessageFrame({ from: cSession, endpoint: local, sequence: 1, message: { id: "real", timestamp: 1, content: { text: "real" } }, originMachineId: C });
  let err: unknown = null; try { hub.acceptInbound({ peer: C, frame: real }); } catch (e) { err = e; }
  expect(err).toBeNull();
}, 5000);

it("isolates local cursors from remote-origin streams", () => {
  const dir = mkdtempSync(join(dirname(scratchDbPath("roam-intercom")), "spoof-")); roots.push(dir);
  const hub = openIntercomStore({ file: join(dir, "q.db"), machineId: H, clock }); opened.push(hub);
  const s1: SessionAddress = { sessionId: "hub-s1", scopeId: "scope" };
  const forged = makeMessageFrame({ from: s1, endpoint: local, sequence: 1, message: { id: "forged2", timestamp: 1, content: { text: "x" } }, originMachineId: B });
  expect(hub.acceptInbound({ peer: B, frame: forged }).kind).toBe("accepted");
  expect(hub.pending({ kind: "inbound", address: recipient }).map(i => [i.id, i.from.sessionId])).toEqual([["forged2", "hub-s1"]]);
  let err: unknown = null; try { hub.acceptLocal({ from: s1, endpoint: local, message: { id: "legit", timestamp: 2, content: { text: "y" } } }); } catch (e) { err = e; }
  expect(err).toBeNull();
}, 5000);

it("accepts a sender that messages locally then moves to another origin", () => {
  const dir = mkdtempSync(join(dirname(scratchDbPath("roam-intercom")), "spoof-")); roots.push(dir);
  const hub = openIntercomStore({ file: join(dir, "q.db"), machineId: H, clock }); opened.push(hub);
  const s1: SessionAddress = { sessionId: "mover", scopeId: "scope" };
  expect(hub.acceptLocal({ from: s1, endpoint: local, message: { id: "before-move", timestamp: 2, content: { text: "y" } } }).kind).toBe("accepted");
  const after = makeMessageFrame({ from: s1, endpoint: local, sequence: 1, message: { id: "after-move", timestamp: 3, content: { text: "z" } }, originMachineId: B });
  let err: unknown = null; try { hub.acceptInbound({ peer: B, frame: after }); } catch (e) { err = e; }
  expect(err).toBeNull();
}, 5000);
it("accepts a sender that messages remotely then returns to the hub", () => {
  const dir = mkdtempSync(join(dirname(scratchDbPath("roam-intercom")), "return-")); roots.push(dir);
  const hub = openIntercomStore({ file: join(dir, "q.db"), machineId: H, clock }); opened.push(hub);
  const from = { sessionId: "returning", scopeId: "scope" };
  const frame = makeMessageFrame({ from, endpoint: local, sequence: 1, message: { id: "remote-first", timestamp: 1, content: { text: "x" } }, originMachineId: B });
  hub.acceptInbound({ peer: B, frame });
  expect(hub.acceptLocal({ from, endpoint: local, message: { id: "local-second", timestamp: 2, content: { text: "y" } } })).toMatchObject({ kind: "accepted", identity: { sequence: 1 } });
}, 5000);


it("never borrows acknowledged refusal slots from a different origin", () => {
  const root = mkdtempSync(join(dirname(scratchDbPath("roam-intercom")), "refused-origin-")); roots.push(root);
  const store = openIntercomStore({ file: join(root, "q.db"), machineId: H, clock }); opened.push(store);
  const from = { sessionId: "sender", scopeId: "scope" };
  for (const sequence of [1, 2]) {
    const frame = makeMessageFrame({ from, endpoint: local, sequence, originMachineId: B,
      message: { id: `refused-${sequence}`, timestamp: 1, content: { text: "synthetic" } } });
    store.rejectFrame({ peer: B, origin: B, identity: frame.identity, reason: "sender-unauthorized" });
  }
  const frame = makeMessageFrame({ from, endpoint: local, sequence: 3, originMachineId: C,
    message: { id: "gap", timestamp: 1, content: { text: "synthetic" } } });
  expect(() => store.acceptInbound({ peer: C, frame })).toThrow("Intercom inbound sequence gap");
  expect(store.pending({ kind: "inbound", address: recipient })).toEqual([]);
}, 5000);

it("never borrows acknowledged refusal slots from a different recipient", () => {
  const root = mkdtempSync(join(dirname(scratchDbPath("roam-intercom")), "refused-recipient-")); roots.push(root);
  const store = openIntercomStore({ file: join(root, "q.db"), machineId: H, clock }); opened.push(store);
  const from = { sessionId: "sender", scopeId: "scope" };
  const refused = makeMessageFrame({ from, endpoint: local, sequence: 1, originMachineId: B,
    message: { id: "refused", timestamp: 1, content: { text: "synthetic" } } });
  store.rejectFrame({ peer: B, origin: B, identity: refused.identity, reason: "sender-unauthorized" });
  const endpoint = { ...local, address: { sessionId: "another", scopeId: "scope" } };
  const frame = makeMessageFrame({ from, endpoint, sequence: 2, originMachineId: B,
    message: { id: "gap", timestamp: 1, content: { text: "synthetic" } } });
  expect(() => store.acceptInbound({ peer: B, frame })).toThrow("Intercom inbound sequence gap");
  expect(store.pending({ kind: "inbound", address: endpoint.address })).toEqual([]);
}, 5000);
