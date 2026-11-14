import type { AcceptanceEvidence, ConsumptionEvidence, SessionAddress } from "./protocol.js";
export const EXTENSION_BUS_FEATURE = "extension-bus-v1";
export const EXACT_SEND_FEATURE = "exact-send-v1";

export type DeliveryState = "socket_delivered" | "queued" | "failed" | "unknown";

export interface DeliveryDetails {
  delivery: DeliveryState;
  code?: string;
  retryable: boolean;
  outcomeKnown: boolean;
  acceptance?: AcceptanceEvidence;
  consumption?: MessageReceipt;
}

export interface LocalSessionInfo {
  remote?: false;
  activationEpoch?: string;
  homeEpoch?: number | null;
  address?: SessionAddress;
  id: string;
  /** Broker-owned lifetime of this live endpoint. */
  endpointEpoch?: string;
  name?: string;
  /** True only when the extension synthesized name for an unnamed runtime. */
  runtimeFallbackAlias?: boolean;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
  peerUid?: number;
  trustedLocal?: boolean;
  /** Live context-window usage, pushed via presence from the source session's
   *  getContextUsage(). contextPct is 0..100 (rounded); contextTokens /
   *  contextWindow are raw token counts. All optional: unknown right after a
   *  compaction (before the next assistant response), when no model is selected,
   *  or on older clients that never report it. */
  contextPct?: number;
  contextTokens?: number;
  contextWindow?: number;
  /** tmux pane id (e.g. "%212") of the session's terminal, read from
   *  $TMUX_PANE at registration. Present only when the session runs inside a
   *  tmux pane; absent for cloud, headless, IDE-embedded, or Herdr sessions.
   *  The pane id is immutable for the process lifetime . unlike the window
   *  name, which is mutable . so a peer can live-resolve the current window
   *  from it via tmux when it needs to introspect or drive that pane. */
  tmuxPane?: string;
}

export interface RemoteSessionInfo {
  remote: true;
  pid?: never;
  peerUid?: never;
  trustedLocal?: never;
  tmuxPane?: never;
  runtimeFallbackAlias?: never;
  contextPct?: number;
  contextTokens?: number;
  contextWindow?: number;
  id: string;
  address: SessionAddress;
  machineId: string;
  machineAlias: string;
  homeEpoch: number | null;
  activationEpoch: string;
  endpointEpoch: string;
  name?: string;
  cwd: string;
  model: string;
  startedAt: number;
  lastActivity: number;
  status?: string;
  reachability?: "live" | "recovering" | "down" | "unknown";
  stale?: boolean;
}
export type SessionInfo = LocalSessionInfo | RemoteSessionInfo;

export interface Message {
  id: string;
  timestamp: number;
  senderSequence?: number;
  brokerReceivedAt?: number;
  brokerDeliveredAt?: number;
  receiverReceivedAt?: number;
  injectedAt?: number;
  supersedes?: string;
  retryOf?: string;
  replyTo?: string;
  expectsReply?: boolean;
  /** Diminishing dispatch duration, never a remote wall-clock deadline. */
  remainingMs?: number;
  provenance?: MessageProvenance;
  content: {
    text: string;
    attachments?: Attachment[];
  };
}

export interface MessageProvenance {
  type: "extension_outbox";
  extensionId: string;
  extensionName: string;
  requestId: string;
}

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}

export type MessageReceiptStatus = "receiver_received" | "queued" | "injected" | "acknowledged" | "expired" | "cancelled" | "superseded" | "cancellation_requested" | "matched_waiter" | "not_injected" | "unknown";

export interface MessageReceipt {
  messageId: string;
  status: MessageReceiptStatus;
  timestamp: number;
  evidence?: ConsumptionEvidence;
  detail?: string;
}

export type MessageControlAction = "cancel" | "supersede";

export interface MessageControl {
  messageId: string;
  action: MessageControlAction;
  timestamp: number;
  supersededBy?: string;
  detail?: string;
}

export interface ExtensionCapability {
  namespace: string;
  ownerEligible: boolean;
}

export type SessionRegistration = Omit<LocalSessionInfo, "id" | "endpointEpoch" | "peerUid" | "trustedLocal"> & {
  extensions?: ExtensionCapability[];
};

export type ClientMessage =
  | { type: "register"; session: SessionRegistration; sessionId?: string; stateId?: string; scopeId?: string; features?: string[] }
  | { type: "unregister" }
  | { type: "extension_capabilities_update"; extensions: ExtensionCapability[] }
  | { type: "list"; requestId: string }
  | { type: "send"; to: string; message: Message; targetId?: string; targetEpoch?: string }
  | { type: "message_receipt"; receipt: MessageReceipt }
  | { type: "cancel_message"; messageId: string }
  | { type: "cancel_ask"; messageId: string }
  | { type: "presence"; name?: string; runtimeFallbackAlias?: boolean; status?: string; model?: string; contextPct?: number | null; contextTokens?: number | null; contextWindow?: number | null }
  | {
      type: "extension_publish";
      namespace: string;
      audience: "owner" | "capable";
      ownerEpoch?: string;
      ownerOnly?: boolean;
      payload: unknown;
    }
  | {
      type: "extension_state_commit";
      namespace: string;
      ownerEpoch: string;
      expectedRevision: number;
      payload: unknown;
    };

export type BrokerMessage =
  | { type: "registered"; sessionId: string; features?: string[] }
  | { type: "sessions"; requestId: string; sessions: SessionInfo[] }
  | { type: "message"; from: SessionInfo; message: Message }
  | { type: "presence_update"; session: SessionInfo }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "error"; error: string }
  | ({ type: "delivered"; messageId: string } & DeliveryDetails)
  | ({ type: "delivery_failed"; messageId: string; reason: string } & DeliveryDetails)
  | { type: "message_receipt"; from: SessionInfo; receipt: MessageReceipt }
  | { type: "message_control"; from: SessionInfo; control: MessageControl }
  | { type: "extension_owner"; namespace: string; ownerId?: string; ownerEpoch?: string }
  | {
      type: "extension_message";
      namespace: string;
      fromSessionId: string;
      ownerId?: string;
      ownerEpoch?: string;
      payload: unknown;
    }
  | {
      type: "extension_state";
      namespace: string;
      revision: number;
      payload: unknown;
    }
  | {
      type: "extension_state_result";
      namespace: string;
      committed: boolean;
      revision: number;
      reason?: string;
    };
