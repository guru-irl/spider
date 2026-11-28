import type { SessionAddress } from "./protocol.js";
import type { LocalSessionInfo, RemoteSessionInfo } from "./types.js";
import { isRemoteSessionInfo } from "./broker/protocol.js";
import type { RelayTarget } from "./relay-protocol.js";

export const V0_INTERCOM_BYTES: number = 256 * 1024;
export const V0_TEXT_BYTES: number = V0_INTERCOM_BYTES - 8 * 1024;
export const V0_INTERCOM_MS = 20_000;
export const V0_ASK_MAX_MS: number = 9 * 60_000;
export const V0_INTERCOM_FEATURE = "roam-intercom-v0";

export type V0Selector = { by: "id" | "name"; value: string };
export interface V0Endpoint {
  address: SessionAddress;
  name: string | null;
  homeEpoch: number;
  endpointEpoch: string;
}
export interface V0Text {
  id: string;
  timestamp: number;
  text: string;
}
export type V0Code = "moving" | "offline" | "no-match" | "ambiguous" | "incomplete"
  | "changed" | "unreachable" | "not-configured" | "unauthorized"
  | "unsupported" | "invalid" | "self" | "reply-only" | "invalid-config" | "home-unreadable";
export type V0Refused = { kind: "refused"; code: V0Code };
export type V0Delivery = V0Refused
  | { kind: "socket_delivered"; id: string }
  | { kind: "unknown"; id: string }
  | { kind: "replied"; id: string; replyId: string; text: string }
  | { kind: "no_reply"; id: string };
export type V0Reply = V0Delivery | { kind: "matches"; targets: V0Endpoint[] };
export type V0BrokerOp =
  | { kind: "lookup"; scopeId: SessionAddress["scopeId"]; selector: V0Selector }
  | { kind: "deliver"; from: RemoteSessionInfo; target: V0Endpoint; message: V0Text; thread?: V0RelayThread }
  | { kind: "ask"; from: RemoteSessionInfo; target: V0Endpoint; message: V0Text; timeoutMs: number };
export type V0AgentRequest = {
  version: 1;
  requestId: string;
  toMachineId: string;
  from: V0Endpoint & { machineId: string };
} & (
  | { kind: "lookup"; selector: V0Selector }
  | { kind: "deliver"; target: V0Endpoint; message: V0Text }
  | { kind: "ask"; target: V0Endpoint; message: V0Text; timeoutMs: number }
);
export type V0RelayThread = { kind: "ask"; timeoutMs: number } | { kind: "reply"; replyTo: string };
type AgentDelivery = Extract<V0AgentRequest, { kind: "deliver" }>;
export type V0RelayAgentRequest = { version: 2 } & (
  | { relayId: string; request: Extract<V0AgentRequest, { kind: "lookup" | "deliver" }>; thread?: never }
  | { relayId: string; request: AgentDelivery; thread: Extract<V0RelayThread, { kind: "ask" }> }
  | { relayId: string | null; request: AgentDelivery; thread: Extract<V0RelayThread, { kind: "reply" }> }
);
export type V0RelayAskInput = { from: V0AgentRequest["from"]; target: RelayTarget; askId: string; timeoutMs: number };
export type V0RelayReplyAuthorization = { asker: V0AgentRequest["from"]; remainingMs: number } | V0Refused;
export type V0RelayAskBrokerRequest = { type: "roam_v0_relay_ask"; requestId: string } & (
  | ({ kind: "begin" } & V0RelayAskInput)
  | { kind: "authorize"; from: V0Endpoint; askId: string }
);
export type V0AgentReply = { version: 1; requestId: string; machineId: string } & V0Reply;
export type V0BrokerRequest = { type: "roam_v0"; requestId: string } & V0BrokerOp;
export type V0BrokerReply = { type: "roam_v0_result"; requestId: string } & V0Reply;
export type V0RouteRefusal = V0Code | "no-relay" | "relay-unreachable" | "relay-busy";
export interface V0RouteDetails {
  path?: "local" | "direct" | `relay ${string}`;
  targetMachine?: string;
  relaySkips?: readonly { relay: string; reason: "down" | "cannot reach the target" | "busy" }[];
}
export type V0RouteResult = (Exclude<V0Delivery, V0Refused> | { kind: "refused"; code: V0RouteRefusal }) & V0RouteDetails;

export type V0SendPlan = V0Refused | { kind: "legacy" }
  | { kind: "local"; target: { id: string; endpointEpoch: string } }
  | {
      kind: "remote";
      label: string;
      send(message: V0Text, signal?: AbortSignal): Promise<V0RouteResult>;
      ask(message: V0Text, timeoutMs: number, signal?: AbortSignal): Promise<V0RouteResult>;
    };
export type V0Prepare = (input: {
  to: string;
  from: LocalSessionInfo;
  locals: readonly LocalSessionInfo[];
  signal?: AbortSignal;
}) => Promise<V0SendPlan>;
export type V0PrepareReply = (input: {
  from: LocalSessionInfo;
  askId: string;
  message: V0Text;
  signal?: AbortSignal;
}) => Promise<V0RouteResult>;
export interface V0ToolOptions {
  homeEpoch(sessionId: string): number | undefined;
  prepare: V0Prepare;
  prepareReply?: V0PrepareReply;
}

const MAX_PEER_ALIAS_CHARS = 255;

const codes: ReadonlySet<string> = new Set<V0Code>([
  "moving", "offline", "no-match", "ambiguous", "incomplete", "changed", "unreachable",
  "not-configured", "unauthorized", "unsupported", "invalid", "self", "reply-only", "invalid-config", "home-unreadable",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fields(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function identifier(value: unknown, limit = 256): value is string {
  return typeof value === "string" && value.length <= limit && value.trim().length > 0
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

export function v0ExplicitName(session: Pick<LocalSessionInfo, "name" | "runtimeFallbackAlias">): string | null {
  return !session.runtimeFallbackAlias && identifier(session.name) ? session.name : null;
}

function scope(value: unknown): value is SessionAddress["scopeId"] {
  return value === null || identifier(value, 1024);
}

function address(value: unknown): value is SessionAddress {
  return record(value) && fields(value, ["sessionId", "scopeId"])
    && identifier(value.sessionId) && scope(value.scopeId);
}

function epoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function endpoint(value: unknown): value is V0Endpoint {
  return record(value) && fields(value, ["address", "name", "homeEpoch", "endpointEpoch"])
    && address(value.address) && (value.name === null || identifier(value.name))
    && epoch(value.homeEpoch) && identifier(value.endpointEpoch);
}

function agentEndpoint(value: unknown): value is V0Endpoint & { machineId: string } {
  if (!record(value) || !fields(value, ["address", "name", "homeEpoch", "endpointEpoch", "machineId"])) return false;
  return address(value.address) && (value.name === null || identifier(value.name))
    && epoch(value.homeEpoch) && identifier(value.endpointEpoch) && identifier(value.machineId);
}

function selector(value: unknown): value is V0Selector {
  return record(value) && fields(value, ["by", "value"])
    && (value.by === "id" || value.by === "name") && identifier(value.value);
}

export function v0TextFits(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(JSON.stringify(value), "utf8") - 2 <= V0_TEXT_BYTES;
}

function text(value: unknown): value is V0Text {
  return record(value) && fields(value, ["id", "timestamp", "text"])
    && identifier(value.id) && Number.isSafeInteger(value.timestamp) && Number(value.timestamp) >= 0
    && v0TextFits(value.text);
}

export function v0BrokerOrigin(from: V0AgentRequest["from"], machineAlias: string): RemoteSessionInfo {
  return {
    remote: true, id: from.address.sessionId, address: from.address,
    machineId: from.machineId, machineAlias, homeEpoch: from.homeEpoch,
    activationEpoch: from.endpointEpoch, endpointEpoch: from.endpointEpoch,
    ...(from.name === null ? {} : { name: from.name }),
    cwd: "", model: "", startedAt: 0, lastActivity: 0,
  };
}

function remote(value: unknown): value is RemoteSessionInfo {
  return isRemoteSessionInfo(value) && address(value.address) && identifier(value.id)
    && identifier(value.machineId) && identifier(value.machineAlias, MAX_PEER_ALIAS_CHARS)
    && identifier(value.activationEpoch) && epoch(value.homeEpoch)
    && (value.name === undefined || identifier(value.name));
}

function withinLimit(value: unknown, extraBytes = 0): boolean {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" && Buffer.byteLength(encoded, "utf8") + extraBytes <= V0_INTERCOM_BYTES;
  } catch {
    return false;
  }
}

function relayThread(value: unknown): value is V0RelayThread {
  return record(value) && (value.kind === "ask" && fields(value, ["kind", "timeoutMs"]) &&
    epoch(value.timeoutMs) && value.timeoutMs <= V0_ASK_MAX_MS ||
    value.kind === "reply" && fields(value, ["kind", "replyTo"]) && identifier(value.replyTo));
}

function reply(value: Record<string, unknown>, prefix: readonly string[]): boolean {
  switch (value.kind) {
    case "refused":
      return fields(value, [...prefix, "kind", "code"]) && typeof value.code === "string" && codes.has(value.code);
    case "matches":
      return fields(value, [...prefix, "kind", "targets"]) && Array.isArray(value.targets) && value.targets.every(endpoint);
    case "socket_delivered":
    case "unknown":
    case "no_reply":
      return fields(value, [...prefix, "kind", "id"]) && identifier(value.id);
    case "replied":
      return fields(value, [...prefix, "kind", "id", "replyId", "text"])
        && identifier(value.id) && identifier(value.replyId) && v0TextFits(value.text);
    default:
      return false;
  }
}

export function parseV0BrokerRequest(value: unknown): V0BrokerRequest | null {
  if (!record(value) || !withinLimit(value) || value.type !== "roam_v0" || !identifier(value.requestId)) return null;
  const prefix = ["type", "requestId", "kind"];
  if (value.kind === "lookup" && fields(value, [...prefix, "scopeId", "selector"])
      && scope(value.scopeId) && selector(value.selector)) return value as V0BrokerRequest;
  const extra = value.kind === "ask" ? ["timeoutMs"] : Object.hasOwn(value, "thread") ? ["thread"] : [];
  if ((value.kind === "deliver" || value.kind === "ask")
      && fields(value, [...prefix, "from", "target", "message", ...extra])
      && remote(value.from) && endpoint(value.target) && text(value.message)
      && (value.kind === "ask" ? epoch(value.timeoutMs) : !extra.length || relayThread(value.thread))) return value as V0BrokerRequest;
  return null;
}

export function parseV0BrokerReply(value: unknown): V0BrokerReply | null {
  return record(value) && withinLimit(value) && value.type === "roam_v0_result" && identifier(value.requestId)
    && reply(value, ["type", "requestId"]) ? value as V0BrokerReply : null;
}

export function parseV0RelayAskBrokerRequest(value: unknown): V0RelayAskBrokerRequest | null {
  if (!record(value) || !withinLimit(value) || value.type !== "roam_v0_relay_ask" ||
      !identifier(value.requestId) || !identifier(value.askId)) return null;
  const prefix = ["type", "requestId", "kind", "from", "askId"];
  if (value.kind === "authorize" && fields(value, prefix) && endpoint(value.from)) return value as V0RelayAskBrokerRequest;
  if (value.kind !== "begin" || !fields(value, [...prefix, "target", "timeoutMs"]) || !agentEndpoint(value.from) ||
      !epoch(value.timeoutMs) || !record(value.target)) return null;
  const target = value.target;
  const hasEpoch = Object.hasOwn(target, "homeEpoch");
  return fields(target, ["machineId", "selector", ...(hasEpoch ? ["homeEpoch"] : [])]) && identifier(target.machineId) &&
    selector(target.selector) && (!hasEpoch || epoch(target.homeEpoch)) ? value as V0RelayAskBrokerRequest : null;
}

export function parseV0RelayReplyAuthorization(value: unknown): V0RelayReplyAuthorization | null {
  if (!record(value)) return null;
  if (value.kind === "refused" && reply(value, [])) return value as V0Refused;
  return fields(value, ["asker", "remainingMs"]) && agentEndpoint(value.asker) && epoch(value.remainingMs) && value.remainingMs <= V0_ASK_MAX_MS
    ? value as V0RelayReplyAuthorization : null;
}

function brokerDeliveryFits(request: Exclude<V0AgentRequest, { kind: "lookup" }>, thread?: V0RelayThread): boolean {
  const { version, toMachineId, requestId, from, ...operation } = request;
  const projected = { type: "roam_v0", requestId: "0".repeat(36), from: v0BrokerOrigin(from, ""), ...operation, ...(thread && { thread }) };
  // The receiving machine supplies the alias, with up to six escaped bytes per code unit.
  return withinLimit(projected, 6 * MAX_PEER_ALIAS_CHARS);
}

export function parseV0AgentRequest(value: unknown): V0AgentRequest | null {
  if (!record(value) || !withinLimit(value) || value.version !== 1 || !identifier(value.requestId)
      || !identifier(value.toMachineId) || !agentEndpoint(value.from)) return null;
  const prefix = ["version", "requestId", "toMachineId", "from", "kind"];
  if (value.kind === "lookup" && fields(value, [...prefix, "selector"]) && selector(value.selector)) return value as V0AgentRequest;
  if ((value.kind === "deliver" || value.kind === "ask")
      && fields(value, [...prefix, "target", "message", ...(value.kind === "ask" ? ["timeoutMs"] : [])])
      && endpoint(value.target) && text(value.message) && (value.kind !== "ask" || epoch(value.timeoutMs))) {
    const request = value as Exclude<V0AgentRequest, { kind: "lookup" }>;
    if (brokerDeliveryFits(request)) return request;
  }
  return null;
}

export function parseV0RelayAgentRequest(value: unknown): V0RelayAgentRequest | null {
  if (!record(value) || value.version !== 2 || !withinLimit(value)) return null;
  const prefix = ["version", "relayId", "request"];
  const { relayId, thread } = value;
  const request = parseV0AgentRequest(value.request);
  if (!request || request.kind === "ask") return null;
  if (fields(value, prefix) && identifier(relayId)) return { version: 2, relayId, request };
  if (!fields(value, [...prefix, "thread"]) || request.kind !== "deliver" || !relayThread(thread) ||
      !brokerDeliveryFits(request, thread)) return null;
  if (thread.kind === "ask") return identifier(relayId) ? { version: 2, relayId, request, thread } : null;
  return relayId === null || identifier(relayId) ? { version: 2, relayId, request, thread } : null;
}

export function parseV0AgentReply(value: unknown): V0AgentReply | null {
  return record(value) && withinLimit(value) && value.version === 1 && identifier(value.requestId) && identifier(value.machineId)
    && reply(value, ["version", "requestId", "machineId"]) ? value as V0AgentReply : null;
}
