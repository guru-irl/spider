import {
  parseV0AgentRequest, parseV0BrokerReply, v0TextFits, V0_ASK_MAX_MS, V0_INTERCOM_BYTES, V0_INTERCOM_MS,
  type V0AgentRequest, type V0Delivery, type V0Refused, type V0Selector, type V0Text,
} from "./roam-v0.js";

export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_HOLD_MS = 20_000;
export const RELAY_POLL_REMOTE_MS = 25_000;
export const RELAY_POLL_CALL_MS = 30_000;
export const RELAY_POLL_MAX_BYTES: number = 18 * V0_INTERCOM_BYTES;
export const RELAY_MAX_SLOTS = 16;
// A 64 KiB config cannot name this many distinct UUIDs.
export const RELAY_MAX_LINKS = 2048;
export const RELAY_BROKER_FEATURE = "roam-intercom-relay-v0";

export interface RelayPeer { machineId: string; alias: string }
export interface RelayTarget { machineId: string; selector: V0Selector; homeEpoch?: number }
export type RelaySubmit = { type: "submit"; from: V0AgentRequest["from"]; target: RelayTarget; message: V0Text } & (
  | { kind: "send" } | { kind: "ask"; timeoutMs: number } | { kind: "reply"; replyTo: string }
);
type RelayNotAttempted = V0Refused | { kind: "refused"; code: "relay-busy" | "relay-stopping" };
export type RelayResult = { type: "result"; messageId: string } & (
  | { attempted: true; outcome: Extract<V0Delivery, { kind: "socket_delivered" | "refused" | "unknown" }> }
  | { attempted: false; outcome: RelayNotAttempted }
);
export interface RelayHello {
  type: "hello"; version: number; relay: RelayPeer; toMachineId: string; linkId: string; pollId: string;
}
export interface RelayReach { type: "reach"; peers: readonly RelayPeer[] }
export interface RelayPoll {
  holdMs: 0 | typeof RELAY_HOLD_MS; hello: RelayHello; reach: RelayReach; results: readonly RelayResult[];
}
type ReadyRefusal = "version-mismatch" | "invalid-config" | "unauthorized" | "unreachable" | "relay-busy";
export type RelayReady = { type: "ready"; version: number; machineId: string; linkId: string; pollId: string } & (
  | { ok: true } | { ok: false; code: ReadyRefusal }
);
export interface RelayPollReply { ready: RelayReady; submissions: readonly RelaySubmit[] }
export interface RelayLinkView {
  relay: RelayPeer; reach: readonly RelayPeer[]; linkId: string; state: "up" | "connecting" | "down"; sinceMs: number;
  lastCallMs: number | null; lastError: string | null; messagesCarried: number;
}

const readyRefusals: ReadonlySet<unknown> = new Set<ReadyRefusal>(["version-mismatch", "invalid-config", "unauthorized", "unreachable", "relay-busy"]);
const invalidProtocol = () => new Error("Invalid relay poll protocol");

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function identifier(value: unknown, limit = 256): value is string {
  return typeof value === "string" && value.length <= limit && value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
function unsigned(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function fitsFrame(value: unknown): boolean {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8") + 1 <= V0_INTERCOM_BYTES; }
  catch { return false; }
}

function isRelayPeer(value: unknown): value is RelayPeer {
  return record(value) && fields(value, ["machineId", "alias"]) && identifier(value.machineId) &&
    identifier(value.alias, 255) && value.alias.trim() === value.alias;
}
function isReachList(value: unknown): value is readonly RelayPeer[] {
  return Array.isArray(value) && value.every(isRelayPeer) && new Set(value.map(peer => peer.machineId)).size === value.length;
}
function isRelayHello(value: unknown): value is RelayHello {
  return record(value) && fields(value, ["type", "version", "relay", "toMachineId", "linkId", "pollId"]) &&
    value.type === "hello" && unsigned(value.version) && isRelayPeer(value.relay) && identifier(value.toMachineId) &&
    identifier(value.linkId) && identifier(value.pollId);
}
function isRelayReach(value: unknown): value is RelayReach {
  return record(value) && fields(value, ["type", "peers"]) && value.type === "reach" && isReachList(value.peers);
}
export function isRelayReady(value: unknown): value is RelayReady {
  return record(value) && value.type === "ready" && unsigned(value.version) && identifier(value.machineId) &&
    identifier(value.linkId) && identifier(value.pollId) &&
    fields(value, ["type", "version", "machineId", "linkId", "pollId", "ok", ...(value.ok === false ? ["code"] : [])]) &&
    (value.ok === true || value.ok === false && readyRefusals.has(value.code));
}
export function isRelaySubmit(value: unknown): value is RelaySubmit {
  if (!record(value) || value.type !== "submit" || !record(value.target) || !record(value.message)) return false;
  const { kind, target, message } = value;
  if (!fields(value, ["type", "kind", "from", "target", "message", ...(kind === "ask" ? ["timeoutMs"] : kind === "reply" ? ["replyTo"] : [])]) ||
      !fields(target, ["machineId", "selector", ...(Object.hasOwn(target, "homeEpoch") ? ["homeEpoch"] : [])]) ||
      (Object.hasOwn(target, "homeEpoch") && (!unsigned(target.homeEpoch) || target.homeEpoch === 0)) ||
      !fields(message, ["id", "timestamp", "text"]) || !unsigned(message.timestamp) || !v0TextFits(message.text)) return false;
  // The lookup envelope validates the origin, the selector, and both IDs
  // without budgeting for a v0 delivery envelope that we do not send here.
  return Boolean(parseV0AgentRequest({ version: 1, kind: "lookup", requestId: message.id, from: value.from,
    toMachineId: target.machineId, selector: target.selector })) &&
    (kind === "send" || kind === "ask" && unsigned(value.timeoutMs) && value.timeoutMs > 0 && value.timeoutMs <= V0_ASK_MAX_MS ||
     kind === "reply" && identifier(value.replyTo)) && fitsFrame(value);
}
export function isRelayResult(value: unknown): value is RelayResult {
  if (!record(value) || !fields(value, ["type", "messageId", "attempted", "outcome"]) || value.type !== "result" ||
      typeof value.attempted !== "boolean" || !identifier(value.messageId) || !record(value.outcome)) return false;
  const { outcome, messageId, attempted } = value;
  if (outcome.kind === "refused" && fields(outcome, ["kind", "code"])) {
    return (!attempted && (outcome.code === "relay-busy" || outcome.code === "relay-stopping")) ||
      parseV0BrokerReply({ type: "roam_v0_result", requestId: messageId, ...outcome }) !== null;
  }
  return attempted && fields(outcome, ["kind", "id"]) && outcome.id === messageId &&
    (outcome.kind === "socket_delivered" || outcome.kind === "unknown");
}

function isRelayPoll(value: unknown): value is RelayPoll {
  return record(value) && fields(value, ["holdMs", "hello", "reach", "results"]) &&
    (value.holdMs === 0 || value.holdMs === RELAY_HOLD_MS) && isRelayHello(value.hello) && isRelayReach(value.reach) &&
    fitsFrame(value.reach) && Array.isArray(value.results) && value.results.length <= RELAY_MAX_SLOTS &&
    (value.holdMs === 0 || value.results.length === 0) && value.results.every(isRelayResult);
}
function isRelayPollReply(value: RelayPollReply): boolean {
  return isRelayReady(value.ready) && value.submissions.length <= RELAY_MAX_SLOTS &&
    (value.ready.ok || value.submissions.length === 0) && value.submissions.every(isRelaySubmit) &&
    new Set(value.submissions.map(submit => submit.message.id)).size === value.submissions.length;
}

function frames(input: Buffer, maxFrames: number): unknown[] {
  if (input.length > RELAY_POLL_MAX_BYTES) throw invalidProtocol();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const values: unknown[] = [];
  for (let offset = 0; offset < input.length;) {
    const end = input.indexOf(10, offset);
    if (end < 0 || end - offset + 1 > V0_INTERCOM_BYTES || values.length === maxFrames) throw invalidProtocol();
    try { values.push(JSON.parse(decoder.decode(input.subarray(offset, end)))); }
    catch { throw invalidProtocol(); }
    offset = end + 1;
  }
  return values;
}
function encode(frames: readonly unknown[]): Buffer {
  return Buffer.from(frames.map(frame => `${JSON.stringify(frame)}\n`).join(""));
}
export function encodeRelayPoll(poll: RelayPoll): Buffer {
  if (!isRelayPoll(poll)) throw invalidProtocol();
  return encode([poll.hello, poll.reach, ...poll.results]);
}
export function decodeRelayPoll(input: Buffer, holdMs: RelayPoll["holdMs"]): RelayPoll {
  const [hello, reach, ...results] = frames(input, 2 + RELAY_MAX_SLOTS);
  const poll = { holdMs, hello, reach, results };
  if (!isRelayPoll(poll)) throw invalidProtocol();
  return poll;
}
export function encodeRelayPollReply(reply: RelayPollReply): Buffer {
  if (!isRelayPollReply(reply)) throw invalidProtocol();
  return encode([reply.ready, ...reply.submissions]);
}
export function decodeRelayPollReply(input: Buffer): RelayPollReply {
  const [ready, ...submissions] = frames(input, 1 + RELAY_MAX_SLOTS);
  const reply = { ready, submissions } as RelayPollReply;
  if (!isRelayPollReply(reply)) throw invalidProtocol();
  return reply;
}

export function relayReady(hello: RelayHello, code?: ReadyRefusal, machineId: string = hello.toMachineId): RelayReady {
  const { linkId, pollId } = hello;
  const header = { type: "ready" as const, version: RELAY_PROTOCOL_VERSION, machineId, linkId, pollId };
  return code ? { ...header, ok: false, code } : { ...header, ok: true };
}
export function correlatesRelayReady(ready: RelayReady, hello: RelayHello): boolean {
  return ready.machineId === hello.toMachineId && ready.linkId === hello.linkId && ready.pollId === hello.pollId;
}
export function relayRefused(messageId: string, code: RelayNotAttempted["code"]): RelayResult {
  return { type: "result", messageId, attempted: false, outcome: { kind: "refused", code } as RelayNotAttempted };
}
export function relayUnknown(messageId: string): RelayResult {
  return { type: "result", messageId, attempted: true, outcome: { kind: "unknown", id: messageId } };
}

export type RelayBrokerRequest = { type: "roam_v0_relay"; requestId: string } & (
  | { kind: "poll"; poll: RelayPoll }
  | { kind: "list" }
  | { kind: "submit"; relayId: string; submit: RelaySubmit; remainingMs: number }
);
export function parseRelayBrokerRequest(value: unknown): RelayBrokerRequest | null {
  if (!record(value) || value.type !== "roam_v0_relay" || !identifier(value.requestId)) return null;
  const base = ["type", "requestId", "kind"];
  if (value.kind === "list" && fields(value, base) ||
      value.kind === "poll" && fields(value, [...base, "poll"]) && isRelayPoll(value.poll) ||
      value.kind === "submit" && fields(value, [...base, "relayId", "submit", "remainingMs"]) && identifier(value.relayId) &&
      isRelaySubmit(value.submit) && unsigned(value.remainingMs) && value.remainingMs > 0 && value.remainingMs <= V0_INTERCOM_MS)
    return value as RelayBrokerRequest;
  return null;
}
export function isRelayLinkView(value: unknown): value is RelayLinkView {
  return record(value) && fields(value, ["relay", "reach", "linkId", "state", "sinceMs", "lastCallMs", "lastError", "messagesCarried"]) &&
    isRelayPeer(value.relay) && isReachList(value.reach) && fitsFrame({ type: "reach", peers: value.reach }) && identifier(value.linkId) &&
    (value.state === "up" || value.state === "connecting" || value.state === "down") && unsigned(value.sinceMs) &&
    (value.lastCallMs === null || unsigned(value.lastCallMs)) && (value.lastError === null || identifier(value.lastError)) && unsigned(value.messagesCarried);
}
