import type { Home, MachineId } from "@spider/db-core/roam/types";
import type { AcceptanceEvidence, FederationBlockers, Message, MessageControl, MessageReceipt, RemoteSessionInfo, SessionAddress, SessionEndpoint } from "@spider/intercom/protocol";
import type { Clock } from "./contracts";

export const INTERCOM_MESSAGE_BYTES: number = 256 * 1024;
export const INTERCOM_EXCHANGE_BYTES: number = 512 * 1024;
export const INTERCOM_QUEUE_MESSAGES: number = 256;
export const INTERCOM_QUEUE_BYTES: number = 64 * 1024 * 1024;
export const INTERCOM_PAYLOAD_MS: number = 24 * 60 * 60 * 1000;
/** Minimum after payload expiry. The store currently retains identity evidence indefinitely. */
export const INTERCOM_DEDUPE_MS: number = 24 * 60 * 60 * 1000;
export const INTERCOM_HOP_ALLOWANCE_MS: number = 5_000;

/** A push never supersedes a simultaneous poll on the same edge. */
export interface ExchangeGeneration { edgeEpoch: string; channel: "poll" | "push"; generation: number }

/** The recipient is logical identity. Endpoint is separate and can be rebound with proof. */
export interface IntercomIdentity {
  id: string;
  from: SessionAddress;
  to: SessionAddress;
  digest: string;
  sequence: number;
  askId: string | null;
}
export interface IntercomMessageFrame {
  kind: "message";
  identity: IntercomIdentity;
  endpoint: SessionEndpoint;
  message: Message;
  /** Relative lifetime; receivers must never refresh it at a relay. */
  remainingPayloadMs: number;
}
export interface IntercomTombstoneFrame {
  kind: "tombstone";
  identity: IntercomIdentity;
  endpoint: SessionEndpoint;
  reason: "expired" | "cancelled";
}
export type IntercomFrame = IntercomMessageFrame | IntercomTombstoneFrame;

/** A link acknowledgement proves durable inbox acceptance, not consumption. */
export interface IntercomLinkAck { identity: IntercomIdentity; kind: IntercomFrame["kind"] }
export interface IntercomReceiptInput {
  from: SessionEndpoint;
  to: SessionAddress;
  digest: string;
  receipt: MessageReceipt;
  /** Assigned by the receiving store and relayed unchanged. */
  attempt?: number;
}
export interface IntercomReceiptFrame extends IntercomReceiptInput { attempt: number }
export interface IntercomControlFrame { from: SessionAddress; to: SessionAddress; control: MessageControl }
export interface IntercomExchange {
  protocol: 1;
  senderMachine: MachineId;
  recipientMachine: MachineId;
  generation: ExchangeGeneration;
  frames: IntercomFrame[];
  acknowledgements: IntercomLinkAck[];
  receipts: IntercomReceiptFrame[];
  controls: IntercomControlFrame[];
  presence: RemoteSessionInfo[];
  resumptions?: IntercomPairResume[];
}

export interface IntercomStoreOptions {
  file: string;
  machineId: MachineId;
  clock: Pick<Clock, "now">;
  /** Lower local quotas. The defaults are the protocol ceilings. */
  limits?: { queueMessages?: number; queueBytes?: number };
}
export type IntercomAcceptance =
  | { kind: "accepted" | "duplicate"; identity: IntercomIdentity; acceptance: Extract<AcceptanceEvidence, { durable: true }>; receipt?: MessageReceipt }
  | { kind: "refused"; reason: "queue-full" | "message-too-large" };
export type OutboundMessage =
  | { from: SessionAddress; endpoint: SessionEndpoint; message: Message; nextHop: MachineId }
  | { frame: IntercomFrame; nextHop: MachineId };
export type IntercomQueue = "outbound" | "inbound";
export type IntercomState = "queued" | "unknown" | "not_injected" | "injected" | "matched_waiter" | "answered" | "expired" | "cancelled";
export interface RetainedIntercom {
  identity: IntercomIdentity;
  endpoint: SessionEndpoint;
  state: IntercomState;
  payloadRetained: boolean;
  linkAcknowledged: boolean;
  latestAttempt: number;
  reconciliation?: MessageReceipt;
  pendingProof?: IntercomReceiptFrame;
}
/** The host supplies an actual exit or generation-fence observation for the old owner. */
export interface SessionGenerationExclusion {
  owner: SessionEndpoint;
  excludedGeneration: string;
  kind: "owner-exited" | "generation-fenced";
}
/** The home and exclusion come from authoritative home and host observations. */
export interface RebindProof { owner: Home | null; exclusion: SessionGenerationExclusion; nextHop: MachineId }
export interface IntercomPairResume {
  from: SessionAddress;
  to: SessionAddress;
  through: number;
  endpoint: SessionEndpoint;
  proof: RebindProof;
}
export interface IntercomStore {
  acceptOutbound(input: OutboundMessage): IntercomAcceptance;
  /** The transport authenticates the peer. Resume owners come from the local authoritative home lookup, not the wire. */
  acceptInbound(input: { peer: MachineId; frame: IntercomFrame; resume?: { cursor: IntercomPairResume; owner: Home | null } }): IntercomAcceptance;
  outboundResumptions(peer: MachineId): readonly IntercomPairResume[];
  /** maxBytes includes each encoded frame and one separator, after reserving the rest of the exchange. */
  pending(input: { kind: "outbound"; peer: MachineId; hopBudgetMs: number; maxBytes?: number }): readonly IntercomFrame[];
  pending(input: { kind: "inbound"; address: SessionAddress }): readonly IntercomIdentity[];
  pending(input: { kind: "receipts"; peer: MachineId }): readonly IntercomReceiptFrame[];
  acknowledge(input: { peer: MachineId; identity: IntercomIdentity; kind: IntercomFrame["kind"] }): void;
  acknowledgeReceipt(input: { peer: MachineId; frame: IntercomReceiptFrame }): void;
  beginDispatch(input: { id: string; endpoint: SessionEndpoint; readiness: string }): IntercomMessageFrame;
  settleReceipt(input: { queue: IntercomQueue; peer: MachineId; frame: IntercomReceiptInput }): void;
  resolveUnknown(input: { queue: IntercomQueue; id: string; digest: string; proof: IntercomReceiptInput }): void;
  cancel(input: { queue: IntercomQueue; id: string; from: SessionAddress; to: SessionAddress }): void;
  expire(): readonly { queue: IntercomQueue; id: string }[];
  inspectBlockers(address: SessionAddress): FederationBlockers;
  rebindUndispatched(address: SessionAddress, endpoint: SessionEndpoint, proof: RebindProof): number;
  retained(queue: IntercomQueue, id: string): RetainedIntercom | null;
  close(): void;
}
