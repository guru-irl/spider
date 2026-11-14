import { createHash } from "node:crypto";
import {
  isConsumptionReceipt, isMessage, isMessageControl, isMessageReceipt, isRemoteSessionInfo, isSessionAddress, isSessionEndpoint, sameAddress,
  type Message, type SessionAddress, type SessionEndpoint,
} from "@spider/intercom/protocol";
import {
  INTERCOM_EXCHANGE_BYTES, INTERCOM_MESSAGE_BYTES, INTERCOM_PAYLOAD_MS,
  type ExchangeGeneration, type IntercomExchange, type IntercomFrame, type IntercomIdentity,
  type IntercomMessageFrame, type IntercomPairResume, type RebindProof,
} from "./intercom-contracts";
import { isMachineId } from "./machine-id";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && Number(value) >= min;
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key));
const digest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const bad = (): never => { throw new Error("Invalid intercom frame"); };

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return bad();
}

function validMessage(value: unknown): value is Message {
  if (!isMessage(value) || !record(value) || !keys(value, ["id", "timestamp", "senderSequence", "brokerReceivedAt", "brokerDeliveredAt", "receiverReceivedAt", "injectedAt", "supersedes", "retryOf", "replyTo", "expectsReply", "remainingMs", "provenance", "content"])) return false;
  if (!text(value.id) || !integer(value.timestamp)) return false;
  for (const key of ["senderSequence", "brokerReceivedAt", "brokerDeliveredAt", "receiverReceivedAt", "injectedAt"]) {
    if (value[key] !== undefined && !integer(value[key])) return false;
  }
  for (const key of ["supersedes", "retryOf", "replyTo"]) if (value[key] !== undefined && !text(value[key])) return false;
  if (!record(value.content) || !keys(value.content, ["text", "attachments"])) return false;
  if (value.content.attachments !== undefined && (!Array.isArray(value.content.attachments) || value.content.attachments.some(item =>
    !record(item) || !keys(item, ["type", "name", "content", "language"])))) return false;
  if (value.provenance !== undefined && (!record(value.provenance) || !keys(value.provenance, ["type", "extensionId", "extensionName", "requestId"]))) return false;
  return true;
}

/** Delivery timestamps and a diminishing ask duration are not authored content. */
export function messageDigest(input: { from: SessionAddress; to: SessionAddress; message: Message }): string {
  if (!isSessionAddress(input.from) || !isSessionAddress(input.to) || !validMessage(input.message)) return bad();
  const message = input.message;
  const authored = {
    from: input.from, to: input.to, content: message.content,
    expectsReply: message.expectsReply ?? false, replyTo: message.replyTo ?? null,
    supersedes: message.supersedes ?? null, retryOf: message.retryOf ?? null, provenance: message.provenance ?? null,
  };
  return createHash("sha256").update(canonical(authored), "utf8").digest("hex");
}

function validIdentity(value: unknown): value is IntercomIdentity {
  return record(value) && keys(value, ["id", "from", "to", "digest", "sequence", "askId"])
    && text(value.id) && isSessionAddress(value.from) && isSessionAddress(value.to)
    && value.from.scopeId === value.to.scopeId && !sameAddress(value.from, value.to)
    && digest(value.digest) && integer(value.sequence, 1) && (value.askId === null || text(value.askId));
}
function validEndpoint(value: unknown): value is SessionEndpoint {
  return isSessionEndpoint(value) && isMachineId(value.machineId);
}
function sameEndpoint(a: SessionEndpoint, b: SessionEndpoint): boolean {
  return sameAddress(a.address, b.address) && a.machineId === b.machineId && a.homeEpoch === b.homeEpoch && a.activationEpoch === b.activationEpoch;
}
export function isRebindProof(value: unknown, address: SessionAddress, endpoint: SessionEndpoint): value is RebindProof {
  if (!record(value) || !keys(value, ["owner", "exclusion", "nextHop"]) || !isMachineId(value.nextHop) || !record(value.exclusion) ||
      !keys(value.exclusion, ["owner", "excludedGeneration", "kind"]) || !validEndpoint(value.exclusion.owner) ||
      !sameAddress(address, value.exclusion.owner.address) || value.exclusion.excludedGeneration !== value.exclusion.owner.activationEpoch ||
      value.exclusion.kind !== "owner-exited" && value.exclusion.kind !== "generation-fenced" || sameEndpoint(value.exclusion.owner, endpoint)) return false;
  const old = value.exclusion.owner;
  if (old.homeEpoch !== null && (endpoint.homeEpoch === null || endpoint.homeEpoch < old.homeEpoch) ||
      old.machineId !== endpoint.machineId && (old.homeEpoch === null || endpoint.homeEpoch === null || endpoint.homeEpoch <= old.homeEpoch)) return false;
  if (endpoint.homeEpoch === null) return value.owner === null;
  return record(value.owner) && keys(value.owner, ["sessionId", "machineId", "epoch", "moveId", "updatedAt"])
    && value.owner.sessionId === address.sessionId && value.owner.machineId === endpoint.machineId && value.owner.epoch === endpoint.homeEpoch
    && (value.owner.moveId === null || text(value.owner.moveId)) && integer(value.owner.updatedAt);
}
export function isIntercomPairResume(value: unknown): value is IntercomPairResume {
  return record(value) && keys(value, ["from", "to", "through", "endpoint", "proof"]) && isSessionAddress(value.from)
    && isSessionAddress(value.to) && value.from.scopeId === value.to.scopeId && !sameAddress(value.from, value.to)
    && integer(value.through) && validEndpoint(value.endpoint) && sameAddress(value.to, value.endpoint.address)
    && isRebindProof(value.proof, value.to, value.endpoint);
}
function askId(message: Message): string | null { return message.replyTo ?? (message.expectsReply ? message.id : null); }
function validFrame(value: unknown): value is IntercomFrame {
  if (!record(value) || !validIdentity(value.identity) || !validEndpoint(value.endpoint) || !sameAddress(value.identity.to, value.endpoint.address)) return false;
  if (value.kind === "tombstone") return keys(value, ["kind", "identity", "endpoint", "reason"]) && (value.reason === "expired" || value.reason === "cancelled");
  if (value.kind !== "message" || !keys(value, ["kind", "identity", "endpoint", "message", "remainingPayloadMs"]) || !validMessage(value.message) ||
      !integer(value.remainingPayloadMs, 1) || value.remainingPayloadMs > INTERCOM_PAYLOAD_MS) return false;
  if (value.identity.id !== value.message.id || value.identity.askId !== askId(value.message)) return false;
  if (value.message.expectsReply && value.message.remainingMs === undefined) return false;
  return value.identity.digest === messageDigest({ from: value.identity.from, to: value.identity.to, message: value.message });
}

export function makeMessageFrame(input: { from: SessionAddress; endpoint: SessionEndpoint; sequence: number; message: Message; remainingPayloadMs?: number }): IntercomMessageFrame {
  if (!isSessionAddress(input.from) || !validEndpoint(input.endpoint) || !integer(input.sequence, 1) || !validMessage(input.message)) return bad();
  const message = JSON.parse(JSON.stringify(input.message)) as Message;
  const identity: IntercomIdentity = { id: message.id, from: { ...input.from }, to: { ...input.endpoint.address },
    digest: messageDigest({ from: input.from, to: input.endpoint.address, message }), sequence: input.sequence, askId: askId(message) };
  const frame: IntercomMessageFrame = { kind: "message", identity, endpoint: { ...input.endpoint, address: { ...input.endpoint.address } }, message,
    remainingPayloadMs: input.remainingPayloadMs ?? INTERCOM_PAYLOAD_MS };
  if (!validFrame(frame)) return bad();
  return frame;
}

function encode(value: unknown, maxBytes: number): Buffer {
  let encoded: Buffer;
  try { encoded = Buffer.from(JSON.stringify(value), "utf8"); } catch { return bad(); }
  if (encoded.byteLength > maxBytes) throw new Error("Intercom size limit exceeded");
  return encoded;
}
function parse(bytes: Uint8Array, maxBytes: number): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes) throw new Error("Intercom size limit exceeded");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; } catch { return bad(); }
}
export function encodeFrame(frame: IntercomFrame): Buffer {
  if (!validFrame(frame)) return bad();
  return encode(frame, INTERCOM_MESSAGE_BYTES);
}
export function decodeFrame(bytes: Uint8Array): IntercomFrame {
  const value = parse(bytes, INTERCOM_MESSAGE_BYTES);
  if (!validFrame(value)) return bad();
  return value;
}

function validGeneration(value: unknown): value is ExchangeGeneration {
  return record(value) && keys(value, ["edgeEpoch", "channel", "generation"]) && text(value.edgeEpoch)
    && (value.channel === "poll" || value.channel === "push") && integer(value.generation, 1);
}
function validReceipt(value: unknown): boolean {
  if (!record(value) || !keys(value, ["from", "to", "digest", "receipt", "attempt"]) || !validEndpoint(value.from) || !isSessionAddress(value.to)
      || value.from.address.scopeId !== value.to.scopeId || !digest(value.digest) || !isMessageReceipt(value.receipt) || !integer(value.attempt)) return false;
  const receipt = value.receipt;
  if (!record(receipt) || !keys(receipt, ["messageId", "status", "timestamp", "evidence", "detail"]) || !text(receipt.messageId) || !integer(receipt.timestamp)) return false;
  if ((receipt.status === "injected" || receipt.status === "matched_waiter" || receipt.status === "not_injected") && !isConsumptionReceipt(receipt)) return false;
  if (receipt.evidence && (receipt.evidence.sessionId !== value.from.address.sessionId || receipt.evidence.activationEpoch !== value.from.activationEpoch)) return false;
  if (receipt.evidence !== undefined) {
    if (!record(receipt.evidence)) return false;
    const fields = receipt.evidence.kind === "entry" ? ["kind", "entryId", "sessionId", "activationEpoch"]
      : receipt.evidence.kind === "waiter" ? ["kind", "entryId", "sessionId", "activationEpoch", "askId"]
      : ["kind", "sessionId", "activationEpoch", "excludedGeneration", "complete"];
    if (!keys(receipt.evidence, fields)) return false;
  }
  return true;
}
function validExchange(value: unknown): value is IntercomExchange {
  if (!record(value) || !keys(value, ["protocol", "senderMachine", "recipientMachine", "generation", "frames", "acknowledgements", "refusals", "receipts", "receiptAcknowledgements", "controls", "presence", "resumptions"])
      || value.protocol !== 1 || !isMachineId(value.senderMachine) || !isMachineId(value.recipientMachine)
      || value.senderMachine === value.recipientMachine || !validGeneration(value.generation)) return false;
  if (!Array.isArray(value.frames) || !value.frames.every(item => validFrame(item) && encode(item, INTERCOM_MESSAGE_BYTES).byteLength <= INTERCOM_MESSAGE_BYTES)) return false;
  if (!Array.isArray(value.acknowledgements) || !value.acknowledgements.every(item => record(item) && keys(item, ["identity", "kind"])
      && validIdentity(item.identity) && (item.kind === "message" || item.kind === "tombstone"))) return false;
  if (value.refusals !== undefined && (!Array.isArray(value.refusals) || !value.refusals.every(item => record(item) && keys(item, ["identity", "reason"]) &&
      validIdentity(item.identity) && (item.reason === "queue-full" || item.reason === "message-too-large" || item.reason === "machine-not-enrolled" || item.reason === "link-down")))) return false;
  if (!Array.isArray(value.receipts) || !value.receipts.every(validReceipt)) return false;
  if (value.receiptAcknowledgements !== undefined && (!Array.isArray(value.receiptAcknowledgements) || !value.receiptAcknowledgements.every(validReceipt))) return false;
  if (!Array.isArray(value.controls) || !value.controls.every(item => record(item) && keys(item, ["from", "to", "control"])
      && isSessionAddress(item.from) && isSessionAddress(item.to) && item.from.scopeId === item.to.scopeId
      && isMessageControl(item.control) && record(item.control) && keys(item.control, ["messageId", "action", "timestamp", "supersededBy", "detail"])
      && text(item.control.messageId) && integer(item.control.timestamp))) return false;
  return Array.isArray(value.presence) && value.presence.every(item => isRemoteSessionInfo(item) && isMachineId(item.machineId))
    && (value.resumptions === undefined || Array.isArray(value.resumptions) && value.resumptions.every(isIntercomPairResume));
}
export function encodeExchange(exchange: IntercomExchange): Buffer {
  if (!validExchange(exchange)) return bad();
  return encode(exchange, INTERCOM_EXCHANGE_BYTES);
}
export function decodeExchange(bytes: Uint8Array): IntercomExchange {
  const value = parse(bytes, INTERCOM_EXCHANGE_BYTES);
  if (!validExchange(value)) return bad();
  return value;
}
