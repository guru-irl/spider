import type {
  Attachment,
  Message,
  MessageControl,
  MessageProvenance,
  MessageReceipt,
  MessageReceiptStatus,
  SessionInfo,
  SessionRegistration,
  RemoteSessionInfo,
} from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessageReceiptStatus(value: unknown): value is MessageReceiptStatus {
  return value === "receiver_received"
    || value === "queued"
    || value === "injected"
    || value === "acknowledged"
    || value === "expired"
    || value === "cancelled"
    || value === "superseded"
    || value === "cancellation_requested"
    || value === "matched_waiter"
    || value === "not_injected"
    || value === "unknown";
}

export function isMessageReceipt(value: unknown): value is MessageReceipt {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.messageId !== "string" || !isMessageReceiptStatus(value.status) || typeof value.timestamp !== "number") {
    return false;
  }
  if (value.evidence !== undefined && !isReceiptEvidence(value.evidence)) return false;
  if (["injected", "matched_waiter", "not_injected"].includes(value.status) && value.evidence !== undefined && !isConsumptionReceipt(value as unknown as MessageReceipt)) return false;
  return value.detail === undefined || typeof value.detail === "string";
}

export function isSessionAddress(value: unknown): value is import("../protocol.js").SessionAddress {
  return isRecord(value) && Object.keys(value).length === 2 && typeof value.sessionId === "string" && value.sessionId.length > 0 && (value.scopeId === null || typeof value.scopeId === "string" && value.scopeId.length > 0);
}

export function isSessionEndpoint(value: unknown): value is import("../protocol.js").SessionEndpoint {
  return isRecord(value) && Object.keys(value).length === 4 && isSessionAddress(value.address)
    && typeof value.machineId === "string" && value.machineId.length > 0
    && (value.homeEpoch === null || Number.isSafeInteger(value.homeEpoch) && Number(value.homeEpoch) >= 1)
    && typeof value.activationEpoch === "string" && value.activationEpoch.length > 0;
}

export function isReceiptEvidence(value: unknown): value is import("../protocol.js").ConsumptionEvidence {
  if (!isRecord(value) || typeof value.sessionId !== "string" || !value.sessionId || typeof value.activationEpoch !== "string" || !value.activationEpoch) return false;
  if (value.kind === "entry") return typeof value.entryId === "string" && value.entryId.length > 0;
  if (value.kind === "waiter") return typeof value.entryId === "string" && value.entryId.length > 0 && typeof value.askId === "string" && value.askId.length > 0;
  return value.kind === "absence" && value.complete === true && value.excludedGeneration === value.activationEpoch;
}

export function isConsumptionReceipt(receipt: MessageReceipt): boolean {
  if (!isReceiptEvidence(receipt.evidence)) return false;
  return receipt.status === "injected" && receipt.evidence.kind === "entry"
    || receipt.status === "matched_waiter" && receipt.evidence.kind === "waiter"
    || receipt.status === "not_injected" && receipt.evidence.kind === "absence";
}

const remoteSessionFields = new Set([
  "remote", "id", "address", "machineId", "machineAlias", "homeEpoch", "activationEpoch", "endpointEpoch",
  "name", "cwd", "model", "startedAt", "lastActivity", "status", "reachability", "stale",
  "contextPct", "contextTokens", "contextWindow",
]);
export function isRemoteSessionInfo(value: unknown): value is RemoteSessionInfo {
  if (!isRecord(value) || Object.keys(value).some(key => !remoteSessionFields.has(key))) return false;
  if (!isRecord(value) || value.remote !== true || !isSessionAddress(value.address) || value.id !== value.address.sessionId) return false;
  if (["pid", "peerUid", "trustedLocal", "tmuxPane", "runtimeFallbackAlias"].some(key => key in value)) return false;
  if (typeof value.machineId !== "string" || !value.machineId || typeof value.machineAlias !== "string" || !value.machineAlias) return false;
  if (value.homeEpoch !== null && (!Number.isSafeInteger(value.homeEpoch) || Number(value.homeEpoch) < 1)) return false;
  if (typeof value.activationEpoch !== "string" || !value.activationEpoch || value.endpointEpoch !== value.activationEpoch) return false;
  if (typeof value.cwd !== "string" || typeof value.model !== "string" || !Number.isSafeInteger(value.startedAt) || !Number.isSafeInteger(value.lastActivity)) return false;
  if (value.name !== undefined && typeof value.name !== "string" || value.status !== undefined && typeof value.status !== "string") return false;
  if (value.stale !== undefined && typeof value.stale !== "boolean") return false;
  for (const key of ["contextPct", "contextTokens", "contextWindow"]) if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) return false;
  return value.reachability === undefined || typeof value.reachability === "string" && ["live", "recovering", "down", "unknown"].includes(value.reachability);
}

export function isFederationDispatchResult(value: unknown): value is import("../protocol.js").FederationDispatchResult {
  if (!isRecord(value) || !isRecord(value.acceptance) || typeof value.acceptance.accepted !== "boolean" || typeof value.acceptance.durable !== "boolean") return false;
  if (value.acceptance.durable && (!value.acceptance.accepted || typeof value.acceptance.location !== "string" || !value.acceptance.location)) return false;
  if (!value.acceptance.durable && value.acceptance.location !== undefined) return false;
  if (typeof value.delivery !== "string" || !["socket_delivered", "queued", "failed", "unknown"].includes(value.delivery) || typeof value.retryable !== "boolean" || typeof value.outcomeKnown !== "boolean") return false;
  if (value.delivery === "queued" && !value.acceptance.durable) return false;
  if (value.delivery === "unknown" ? value.outcomeKnown !== false : value.outcomeKnown !== true) return false;
  if (["socket_delivered", "queued"].includes(value.delivery) && !value.acceptance.accepted || value.delivery === "failed" && value.acceptance.accepted) return false;
  if (value.code !== undefined && typeof value.code !== "string" || value.reason !== undefined && typeof value.reason !== "string") return false;
  return value.consumption === undefined || isMessageReceipt(value.consumption) && (isConsumptionReceipt(value.consumption) || value.consumption.status === "expired");
}

const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const localPresenceFields = new Set(["address", "homeEpoch", "activationEpoch", "name", "cwd", "model", "status", "startedAt", "lastActivity"]);
function isLocalPresence(value: unknown): value is import("../protocol.js").LocalPresence {
  return isRecord(value) && Object.keys(value).every(key => localPresenceFields.has(key))
    && isSessionAddress(value.address) && nonempty(value.activationEpoch)
    && (value.homeEpoch === null || Number.isSafeInteger(value.homeEpoch) && Number(value.homeEpoch) >= 1)
    && typeof value.cwd === "string" && typeof value.model === "string"
    && Number.isSafeInteger(value.startedAt) && Number.isSafeInteger(value.lastActivity)
    && (value.name === undefined || typeof value.name === "string")
    && (value.status === undefined || typeof value.status === "string");
}
function isBlockers(value: unknown): value is import("../protocol.js").FederationBlockers {
  return isRecord(value) && Object.keys(value).length === 4 && Array.isArray(value.asks)
    && value.asks.every(edge => isRecord(edge) && Object.keys(edge).length === 3 && nonempty(edge.id) && isSessionAddress(edge.from) && isSessionAddress(edge.to))
    && [value.pendingDispatch, value.unknownOutcomes, value.unobservedReceipts].every(ids => Array.isArray(ids) && ids.every(nonempty));
}
/** Local socket frames are parsed once before calling the service-owned bridge. */
export function parseFederationBrokerMessage(value: unknown): import("../protocol.js").FederationBrokerMessage | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case "federation_registered":
      return Array.isArray(value.features) && value.features.every(nonempty) ? { type: value.type, features: value.features } : null;
    case "federation_local_presence":
      return Array.isArray(value.sessions) && value.sessions.every(isLocalPresence) ? { type: value.type, sessions: value.sessions } : null;
    case "federation_dispatch": {
      const frame = value.dispatch;
      return nonempty(value.requestId) && isRecord(frame) && isSessionAddress(frame.from) && isRemoteSessionInfo(frame.to) && isMessage(frame.message)
        ? { type: value.type, requestId: value.requestId, dispatch: { from: frame.from, to: frame.to, message: frame.message } } : null;
    }
    case "federation_receipt":
      return isSessionAddress(value.from) && isMessageReceipt(value.receipt) ? { type: value.type, from: value.from, receipt: value.receipt } : null;
    case "federation_control":
      return isSessionAddress(value.from) && isSessionAddress(value.to) && isMessageControl(value.control) ? { type: value.type, from: value.from, to: value.to, control: value.control } : null;
    case "federation_delivery_result":
      return nonempty(value.requestId) && isFederationDispatchResult(value.result) ? { type: value.type, requestId: value.requestId, result: value.result } : null;
    case "blockers":
      return nonempty(value.requestId) && isBlockers(value.blockers) ? { type: value.type, requestId: value.requestId, blockers: value.blockers } : null;
    default: return null;
  }
}

export function isMessageControl(value: unknown): value is MessageControl {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.messageId !== "string" || typeof value.timestamp !== "number") {
    return false;
  }
  if (value.action !== "cancel" && value.action !== "supersede") {
    return false;
  }
  if (value.supersededBy !== undefined && typeof value.supersededBy !== "string") {
    return false;
  }
  return value.detail === undefined || typeof value.detail === "string";
}

function isAttachment(value: unknown): value is Attachment {
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.type !== "file"
    && value.type !== "snippet"
    && value.type !== "context"
  ) {
    return false;
  }

  if (typeof value.name !== "string" || typeof value.content !== "string") {
    return false;
  }

  return value.language === undefined || typeof value.language === "string";
}

function isMessageProvenance(value: unknown): value is MessageProvenance {
  if (!isRecord(value)) {
    return false;
  }
  return value.type === "extension_outbox"
    && typeof value.extensionId === "string"
    && typeof value.extensionName === "string"
    && typeof value.requestId === "string";
}

export function isMessage(value: unknown): value is Message {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.id !== "string" || typeof value.timestamp !== "number") {
    return false;
  }

  for (const key of ["senderSequence", "brokerReceivedAt", "brokerDeliveredAt", "receiverReceivedAt", "injectedAt"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "number") {
      return false;
    }
  }

  if (value.supersedes !== undefined && typeof value.supersedes !== "string") {
    return false;
  }

  if (value.retryOf !== undefined && typeof value.retryOf !== "string") {
    return false;
  }

  if (value.replyTo !== undefined && typeof value.replyTo !== "string") {
    return false;
  }

  if (value.remainingMs !== undefined && (!Number.isSafeInteger(value.remainingMs) || Number(value.remainingMs) <= 0)) return false;
  if (value.expectsReply !== undefined && typeof value.expectsReply !== "boolean") {
    return false;
  }

  if (value.provenance !== undefined && !isMessageProvenance(value.provenance)) {
    return false;
  }

  if (!isRecord(value.content) || typeof value.content.text !== "string") {
    return false;
  }

  return value.content.attachments === undefined
    || (Array.isArray(value.content.attachments) && value.content.attachments.every(isAttachment));
}

export function isSessionInfo(value: unknown): value is SessionInfo {
  if (isRecord(value) && value.remote === true) return isRemoteSessionInfo(value);
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.id !== "string"
    || typeof value.cwd !== "string"
    || typeof value.model !== "string"
    || typeof value.pid !== "number"
    || typeof value.startedAt !== "number"
    || typeof value.lastActivity !== "number"
  ) {
    return false;
  }

  if (value.endpointEpoch !== undefined && typeof value.endpointEpoch !== "string") {
    return false;
  }

  if (value.name !== undefined && typeof value.name !== "string") {
    return false;
  }

  if (value.runtimeFallbackAlias !== undefined && typeof value.runtimeFallbackAlias !== "boolean") {
    return false;
  }

  if (value.status !== undefined && typeof value.status !== "string") {
    return false;
  }

  if (value.peerUid !== undefined && typeof value.peerUid !== "number") {
    return false;
  }

  for (const key of ["contextPct", "contextTokens", "contextWindow"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "number") {
      return false;
    }
  }

  if (value.tmuxPane !== undefined && typeof value.tmuxPane !== "string") {
    return false;
  }

  return value.trustedLocal === undefined || typeof value.trustedLocal === "boolean";
}

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isSessionRegistration(value: unknown): value is SessionRegistration {
  if (isRecord(value) && (value.remote !== undefined && value.remote !== false || value.address !== undefined && !isSessionAddress(value.address))) return false;
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.cwd !== "string"
    || typeof value.model !== "string"
    || typeof value.pid !== "number"
    || typeof value.startedAt !== "number"
    || typeof value.lastActivity !== "number"
  ) {
    return false;
  }

  if (value.homeEpoch !== undefined && value.homeEpoch !== null && (!Number.isSafeInteger(value.homeEpoch) || Number(value.homeEpoch) < 1)) return false;
  if (value.activationEpoch !== undefined && (typeof value.activationEpoch !== "string" || !value.activationEpoch)) return false;
  if (value.name !== undefined && typeof value.name !== "string") {
    return false;
  }
  if (value.runtimeFallbackAlias !== undefined && typeof value.runtimeFallbackAlias !== "boolean") {
    return false;
  }
  if (value.extensions !== undefined && !Array.isArray(value.extensions)) {
    return false;
  }
  if (value.tmuxPane !== undefined && typeof value.tmuxPane !== "string") {
    return false;
  }

  return value.status === undefined || typeof value.status === "string";
}
