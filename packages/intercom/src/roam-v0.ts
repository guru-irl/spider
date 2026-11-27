import type { SessionAddress } from "./protocol.js";
import type { LocalSessionInfo, RemoteSessionInfo } from "./types.js";
import { isRemoteSessionInfo } from "./broker/protocol.js";

export const V0_INTERCOM_BYTES = 256 * 1024;
export const V0_INTERCOM_MS = 20_000;
export const V0_ASK_MAX_MS = 10 * 60_000;
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
  | "unsupported" | "invalid" | "self";
export type V0Refused = { kind: "refused"; code: V0Code };
export type V0Delivery = V0Refused
  | { kind: "socket_delivered"; id: string }
  | { kind: "unknown"; id: string }
  | { kind: "replied"; id: string; replyId: string; text: string }
  | { kind: "no_reply"; id: string };
export type V0Reply = V0Delivery | { kind: "matches"; targets: V0Endpoint[] };
export type V0BrokerOp =
  | { kind: "lookup"; scopeId: SessionAddress["scopeId"]; selector: V0Selector }
  | { kind: "deliver"; from: RemoteSessionInfo; target: V0Endpoint; message: V0Text }
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
export type V0AgentReply = { version: 1; requestId: string; machineId: string } & V0Reply;
export type V0BrokerRequest = { type: "roam_v0"; requestId: string } & V0BrokerOp;
export type V0BrokerReply = { type: "roam_v0_result"; requestId: string } & V0Reply;
export type V0SendPlan = V0Refused | { kind: "legacy" }
  | { kind: "local"; target: { id: string; endpointEpoch: string } }
  | {
      kind: "remote";
      label: string;
      send(message: V0Text, signal?: AbortSignal): Promise<V0Delivery>;
      ask(message: V0Text, timeoutMs: number, signal?: AbortSignal): Promise<V0Delivery>;
    };
export type V0Prepare = (input: {
  to: string;
  from: LocalSessionInfo;
  locals: readonly LocalSessionInfo[];
  signal?: AbortSignal;
}) => Promise<V0SendPlan>;
export interface V0ToolOptions {
  homeEpoch(sessionId: string): number | undefined;
  prepare: V0Prepare;
}

const codes: ReadonlySet<string> = new Set<V0Code>([
  "moving", "offline", "no-match", "ambiguous", "incomplete", "changed", "unreachable",
  "not-configured", "unauthorized", "unsupported", "invalid", "self",
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

function text(value: unknown): value is V0Text {
  return record(value) && fields(value, ["id", "timestamp", "text"])
    && identifier(value.id) && Number.isSafeInteger(value.timestamp) && Number(value.timestamp) >= 0
    && typeof value.text === "string";
}

function remote(value: unknown): value is RemoteSessionInfo {
  return isRemoteSessionInfo(value) && address(value.address) && identifier(value.id)
    && identifier(value.machineId) && identifier(value.machineAlias, 255)
    && identifier(value.activationEpoch) && epoch(value.homeEpoch)
    && (value.name === undefined || identifier(value.name));
}

function withinLimit(value: unknown): boolean {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" && Buffer.byteLength(encoded, "utf8") <= V0_INTERCOM_BYTES;
  } catch {
    return false;
  }
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
        && identifier(value.id) && identifier(value.replyId) && typeof value.text === "string";
    default:
      return false;
  }
}

export function parseV0BrokerRequest(value: unknown): V0BrokerRequest | null {
  if (!record(value) || !withinLimit(value) || value.type !== "roam_v0" || !identifier(value.requestId)) return null;
  const prefix = ["type", "requestId", "kind"];
  if (value.kind === "lookup" && fields(value, [...prefix, "scopeId", "selector"])
      && scope(value.scopeId) && selector(value.selector)) return value as V0BrokerRequest;
  if ((value.kind === "deliver" || value.kind === "ask")
      && fields(value, [...prefix, "from", "target", "message", ...(value.kind === "ask" ? ["timeoutMs"] : [])])
      && remote(value.from) && endpoint(value.target) && text(value.message)
      && (value.kind !== "ask" || epoch(value.timeoutMs))) return value as V0BrokerRequest;
  return null;
}

export function parseV0BrokerReply(value: unknown): V0BrokerReply | null {
  return record(value) && withinLimit(value) && value.type === "roam_v0_result" && identifier(value.requestId)
    && reply(value, ["type", "requestId"]) ? value as V0BrokerReply : null;
}

export function parseV0AgentRequest(value: unknown): V0AgentRequest | null {
  if (!record(value) || !withinLimit(value) || value.version !== 1 || !identifier(value.requestId)
      || !identifier(value.toMachineId) || !agentEndpoint(value.from)) return null;
  const prefix = ["version", "requestId", "toMachineId", "from", "kind"];
  if (value.kind === "lookup" && fields(value, [...prefix, "selector"]) && selector(value.selector)) return value as V0AgentRequest;
  if ((value.kind === "deliver" || value.kind === "ask")
      && fields(value, [...prefix, "target", "message", ...(value.kind === "ask" ? ["timeoutMs"] : [])])
      && endpoint(value.target) && text(value.message) && (value.kind !== "ask" || epoch(value.timeoutMs))) return value as V0AgentRequest;
  return null;
}

export function parseV0AgentReply(value: unknown): V0AgentReply | null {
  return record(value) && withinLimit(value) && value.version === 1 && identifier(value.requestId) && identifier(value.machineId)
    && reply(value, ["version", "requestId", "machineId"]) ? value as V0AgentReply : null;
}
