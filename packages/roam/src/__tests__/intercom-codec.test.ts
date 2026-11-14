import { expect, it } from "vitest";
import type { Message, SessionAddress, SessionEndpoint } from "@spider/intercom/protocol";
import * as api from "../intercom-codec";
import type { IntercomExchange, IntercomPairResume, IntercomReceiptFrame } from "../intercom-contracts";
const from: SessionAddress = { sessionId: "sender", scopeId: "scope" };
const to: SessionAddress = { sessionId: "recipient", scopeId: "scope" };
const endpoint: SessionEndpoint = { address: to, machineId: "00000000-0000-4000-8000-000000000002", homeEpoch: 2, activationEpoch: "activation-2" };
const message: Message = { id: "message-1", timestamp: 1000, replyTo: "ask-1", expectsReply: false,
  content: { text: "Hello", attachments: [{ type: "snippet", name: "notes", content: "x" }] } };

it("canonical digest binds authored content and logical addresses, not transient delivery fields", async () => {
  const digest = api.messageDigest({ from, to, message });
  expect(digest).toBe("d2df93f628c82ee3322de8f434403a5c2e6325a9d59d30905c9598272077f3b8");
  expect(api.messageDigest({ from, to, message: { ...message, timestamp: 3000, senderSequence: 4, brokerDeliveredAt: 9, remainingMs: 42 } })).toBe(digest);
  expect(api.messageDigest({ from, to, message: { ...message, content: { ...message.content, text: "Changed" } } })).not.toBe(digest);
  expect(api.messageDigest({ from, to: { ...to, sessionId: "different" }, message })).not.toBe(digest);
  expect(api.messageDigest({ from, to, message: { ...message, replyTo: "ask-2" } })).not.toBe(digest);
  expect(api.messageDigest({ from, to, message: { ...message, content: { text: "Hello", attachments: [{ type: "snippet", name: "notes", content: "y" }] } } })).not.toBe(digest);
}, 5000);

it("preserves a message frame and rejects a forged digest or endpoint", async () => {
  const frame = api.makeMessageFrame({ from, endpoint, sequence: 1, message });
  expect(api.decodeFrame(api.encodeFrame(frame))).toEqual(frame);
  expect(() => api.encodeFrame({ ...frame, identity: { ...frame.identity, digest: "0".repeat(64) } })).toThrow();
  expect(() => api.encodeFrame({ ...frame, endpoint: { ...endpoint, address: { ...to, scopeId: "other" } } })).toThrow();
}, 5000);

it("caps an encoded message including attachments at 256 KiB", async () => {
  const create = (size: number) => api.makeMessageFrame({ from, endpoint, sequence: 1, message: {
    id: "large", timestamp: 1, content: { text: "", attachments: [{ type: "file", name: "blob", content: "x".repeat(size) }] },
  } });
  const overhead = api.encodeFrame(create(0)).byteLength;
  expect(api.encodeFrame(create(256 * 1024 - overhead)).byteLength).toBe(256 * 1024);
  expect(() => api.encodeFrame(create(256 * 1024 - overhead + 1))).toThrow(/size|limit|large/i);
}, 5000);

it("caps complete encoded exchanges at 512 KiB and separates poll and push generations", async () => {
  const make = (id: string, sequence: number) => api.makeMessageFrame({ from, endpoint, sequence,
    message: { id, timestamp: 1, content: { text: "x".repeat(180 * 1024) } } });
  const batch = { protocol: 1 as const, senderMachine: "00000000-0000-4000-8000-000000000001", recipientMachine: endpoint.machineId,
    generation: { edgeEpoch: "edge-1", channel: "poll" as const, generation: 1 },
    frames: [make("a", 1), make("b", 2)], acknowledgements: [], receipts: [], controls: [], presence: [] };
  expect(api.decodeExchange(api.encodeExchange(batch))).toEqual(batch);
  const push = { ...batch, generation: { ...batch.generation, channel: "push" as const } };
  expect(api.decodeExchange(api.encodeExchange(push)).generation).toEqual({ edgeEpoch: "edge-1", channel: "push", generation: 1 });
  expect(() => api.encodeExchange({ ...batch, frames: [...batch.frames, make("c", 3)] })).toThrow(/size|limit|large/i);
}, 5000);

it("round-trips an owner-bound pair cursor and rejects a forged exclusion", () => {
  const target: SessionEndpoint = { ...endpoint, machineId: "00000000-0000-4000-8000-000000000003", homeEpoch: 3, activationEpoch: "activation-3" };
  const resume: IntercomPairResume = { from, to, through: 7, endpoint: target, proof: {
    owner: { sessionId: to.sessionId, machineId: target.machineId, epoch: 3, moveId: "move-1", updatedAt: 100 },
    exclusion: { owner: endpoint, excludedGeneration: endpoint.activationEpoch, kind: "generation-fenced" }, nextHop: target.machineId,
  } };
  const batch: IntercomExchange = { protocol: 1, senderMachine: "00000000-0000-4000-8000-000000000001", recipientMachine: target.machineId,
    generation: { edgeEpoch: "edge", channel: "push", generation: 1 }, frames: [], acknowledgements: [], receipts: [], controls: [], presence: [], resumptions: [resume] };
  expect(api.decodeExchange(api.encodeExchange(batch)).resumptions).toEqual([resume]);
  const forged = { ...resume, proof: { ...resume.proof, exclusion: { ...resume.proof.exclusion, excludedGeneration: "wrong" } } };
  expect(() => api.encodeExchange({ ...batch, resumptions: [forged] })).toThrow();
}, 5000);

it("rejects unknown fields in receipt and control metadata", () => {
  const frame = api.makeMessageFrame({ from, endpoint, sequence: 1, message });
  const batch: IntercomExchange = { protocol: 1, senderMachine: "00000000-0000-4000-8000-000000000001", recipientMachine: endpoint.machineId,
    generation: { edgeEpoch: "edge", channel: "push", generation: 1 }, frames: [], acknowledgements: [], receipts: [], controls: [], presence: [] };
  const badReceipt = { from: endpoint, to: from, digest: frame.identity.digest, attempt: 1, receipt: { messageId: message.id, status: "unknown", timestamp: 1, hidden: "body" } };
  const badEvidence = { ...badReceipt, receipt: { messageId: message.id, status: "injected", timestamp: 1,
    evidence: { kind: "entry", sessionId: to.sessionId, activationEpoch: endpoint.activationEpoch, entryId: "entry", hidden: "body" } } };
  const badControl = { from, to, control: { messageId: message.id, action: "cancel", timestamp: 1, hidden: "body" } };
  expect(() => api.encodeExchange({ ...batch, receipts: [badReceipt] } as unknown as IntercomExchange)).toThrow();
  expect(() => api.encodeExchange({ ...batch, receipts: [badEvidence] } as unknown as IntercomExchange)).toThrow();
  expect(() => api.encodeExchange({ ...batch, controls: [badControl] } as unknown as IntercomExchange)).toThrow();
}, 5000);

it("round-trips receipt attempt fences and rejects invalid generations", () => {
  const frame = api.makeMessageFrame({ from, endpoint, sequence: 1, message });
  const observed = { from: endpoint, to: from, digest: frame.identity.digest, attempt: 2, receipt: {
    messageId: message.id, status: "injected" as const, timestamp: 1,
    evidence: { kind: "entry" as const, entryId: "entry", sessionId: to.sessionId, activationEpoch: endpoint.activationEpoch },
  } };
  const batch: IntercomExchange = { protocol: 1, senderMachine: endpoint.machineId, recipientMachine: "00000000-0000-4000-8000-000000000001",
    generation: { edgeEpoch: "edge", channel: "push", generation: 1 }, frames: [], acknowledgements: [], receipts: [observed], controls: [], presence: [] };
  expect(api.decodeExchange(api.encodeExchange(batch)).receipts).toEqual([observed]);
  const { attempt: _attempt, ...untagged } = observed;
  expect(() => api.encodeExchange({ ...batch, receipts: [untagged as unknown as IntercomReceiptFrame] })).toThrow();
  for (const attempt of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => api.encodeExchange({ ...batch, receipts: [{ ...observed, attempt }] })).toThrow();
  }
}, 5000);

it("rejects terminal receipt claims that lack the corresponding evidence", () => {
  const frame = api.makeMessageFrame({ from, endpoint, sequence: 1, message });
  const batch: IntercomExchange = { protocol: 1, senderMachine: "00000000-0000-4000-8000-000000000001", recipientMachine: endpoint.machineId,
    generation: { edgeEpoch: "edge", channel: "push", generation: 1 }, frames: [], acknowledgements: [], receipts: [], controls: [], presence: [] };
  for (const status of ["injected", "matched_waiter", "not_injected"] as const) {
    expect(() => api.encodeExchange({ ...batch, receipts: [{ from: endpoint, to: from, digest: frame.identity.digest, attempt: 1,
      receipt: { messageId: message.id, status, timestamp: 1 } }] })).toThrow();
  }
}, 5000);

it("validates relative payload lifetime without changing authored identity", () => {
  const frame = api.makeMessageFrame({ from, endpoint, sequence: 1, message });
  const shorter = { ...frame, remainingPayloadMs: frame.remainingPayloadMs - 1 };
  expect(api.decodeFrame(api.encodeFrame(shorter)).identity).toEqual(frame.identity);
  for (const invalid of [0, -1, 0.5, 24 * 60 * 60 * 1000 + 1, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => api.encodeFrame({ ...frame, remainingPayloadMs: invalid })).toThrow();
  }
}, 5000);

it("rejects malformed, truncated and inconsistent wire frames before acceptance", async () => {
  const frame = api.makeMessageFrame({ from, endpoint, sequence: 1, message });
  expect(() => api.decodeFrame(Buffer.from("{"))).toThrow();
  expect(() => api.decodeFrame(Buffer.from([0xff]))).toThrow();
  expect(() => api.decodeFrame(Buffer.from(JSON.stringify({ ...frame, identity: { ...frame.identity, sequence: 0 } })))).toThrow();
  expect(() => api.decodeFrame(Buffer.from(JSON.stringify({ ...frame, message: { ...message, id: "other" } })))).toThrow();
  expect(() => api.decodeFrame(Buffer.from(JSON.stringify({ ...frame, message: { ...message, content: { text: "tampered" } } })))).toThrow();
}, 5000);
