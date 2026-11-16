import type { Home, MachineId } from "@spider/db-core/roam/types";
import type { AcceptanceEvidence, FederationBlockers, Message, MessageControl, MessageReceipt, RemoteSessionInfo, SessionAddress, SessionEndpoint } from "@spider/intercom/protocol";
import type { Clock } from "./contracts";

// Protocol 5 predates cross-machine deployment. Prior hop formats have no compatibility path.
export const INTERCOM_FEDERATION_VERSION = 5 as const;
export const INTERCOM_MESSAGE_BYTES: number = 256 * 1024;
export const INTERCOM_EXCHANGE_BYTES: number = 512 * 1024;
export const INTERCOM_QUEUE_MESSAGES: number = 256;
export const INTERCOM_QUEUE_BYTES: number = 64 * 1024 * 1024;
export const INTERCOM_PAYLOAD_MS: number = 24 * 60 * 60 * 1000;
export const INTERCOM_ORIGIN_MESSAGES: number = 4096;
export const INTERCOM_ORIGIN_BYTES: number = 256 * 1024 * 1024;
export const INTERCOM_MACHINE_MESSAGES: number = 16384;
export const INTERCOM_MACHINE_BYTES: number = 1024 * 1024 * 1024;
/** Minimum terminal-history retention after the original payload deadline. */
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
  /** Physical position inside the authenticated enrollment edge, never original provenance. */
  hopSequence?: number;
  identity: IntercomIdentity;
  endpoint: SessionEndpoint;
  message: Message;
  /** First accepting machine, fixed for the lifetime of the message. */
  originMachineId: MachineId;
  /** Relative lifetime; receivers must never refresh it at a relay. */
  remainingPayloadMs: number;
}
export interface IntercomTombstoneFrame {
  kind: "tombstone";
  hopSequence?: number;
  identity: IntercomIdentity;
  endpoint: SessionEndpoint;
  /** Preserves the same origin when the message becomes a tombstone. */
  originMachineId: MachineId;
  reason: "expired" | "cancelled";
}
export type IntercomFrame = IntercomMessageFrame | IntercomTombstoneFrame;

/** A link acknowledgement proves durable inbox acceptance, not consumption. */
export interface IntercomLinkAck { hopSequence?: number; identity: IntercomIdentity; kind: IntercomFrame["kind"] }
export interface IntercomRefusal { hopSequence?: number; identity: IntercomIdentity; reason: "queue-full" | "message-too-large" | "machine-not-enrolled" | "hop-sequence-gap" | "hop-slot-mismatch" | "link-down" | "missing-origin" | "peer-revoked" | "intercom-topology-changing" | "intercom-frozen" | "sender-unauthorized" | "store-rejected" }
/** Validated metadata from a rejected frame; no payload or fabricated origin is retained. */
export interface MissingOriginFrame { hopSequence?: number; index: number; identity: IntercomIdentity; endpoint: SessionEndpoint; kind: IntercomFrame["kind"] }
export interface IntercomReceiptInput {
  from: SessionEndpoint;
  to: SessionAddress;
  digest: string;
  receipt: MessageReceipt;
  /** Assigned by the receiving store and relayed unchanged. */
  attempt?: number;
  /** Original message provenance; local producers let the store derive both fields. */
  originMachineId?: MachineId;
  sequence?: number;
}
export interface IntercomReceiptFrame extends IntercomReceiptInput {
  attempt: number;
  originMachineId: MachineId;
  sequence: number;
}
export interface IntercomControlFrame { from: SessionAddress; to: SessionAddress; control: MessageControl }
export interface IntercomExchange {
  protocol: typeof INTERCOM_FEDERATION_VERSION;
  senderMachine: MachineId;
  recipientMachine: MachineId;
  generation: ExchangeGeneration;
  /** Authenticated start at zero. Repeated starts never reset a persisted cursor. */
  streamStart?: { after: 0 };
  frames: IntercomFrame[];
  acknowledgements: IntercomLinkAck[];
  refusals?: IntercomRefusal[];
  receipts: IntercomReceiptFrame[];
  receiptAcknowledgements?: IntercomReceiptFrame[];
  controls: IntercomControlFrame[];
  presence: RemoteSessionInfo[];
  resumptions?: IntercomPairResume[];
  topology?: { transitionId: string; action: "switch" | "switched" };
}

/** The codec proves these transport fields before exposing an authenticated exchange. */
export type IntercomWireMissingOriginFrame = MissingOriginFrame & { hopSequence: number };
export type IntercomWireFrame = IntercomFrame & { hopSequence: number };
export type IntercomWireAck = IntercomLinkAck & { hopSequence: number };
export type IntercomWireRefusal = IntercomRefusal & { hopSequence: number };
export type AuthenticatedIntercomExchange = Omit<IntercomExchange, "streamStart" | "frames" | "acknowledgements" | "refusals"> & {
  streamStart: { after: 0 };
  frames: IntercomWireFrame[];
  acknowledgements: IntercomWireAck[];
  refusals?: IntercomWireRefusal[];
};

export interface IntercomStoreOptions {
  file: string;
  machineId: MachineId;
  clock: Pick<Clock, "now">;
  mode?: IntercomMode;
  /** Lower local quotas. The defaults are the protocol ceilings. */
  limits?: { queueMessages?: number; queueBytes?: number; originMessages?: number; originBytes?: number; machineMessages?: number; machineBytes?: number };
}
export type IntercomAcceptance =
  | { kind: "accepted" | "duplicate"; identity: IntercomIdentity; acceptance: Extract<AcceptanceEvidence, { durable: true }>; receipt?: MessageReceipt }
  | { kind: "refused"; reason: "queue-full" | "message-too-large" | "intercom-topology-changing" };
export type OutboundMessage = (
  | { from: SessionAddress; endpoint: SessionEndpoint; message: Message; nextHop: MachineId }
  | { frame: IntercomFrame; nextHop: MachineId }
) & { firstHomePresence?: RemoteSessionInfo; edgeEpoch?: string };
export type IntercomQueue = "outbound" | "inbound";
export type IntercomState = "queued" | "unknown" | "not_injected" | "injected" | "matched_waiter" | "answered" | "expired" | "cancelled";
export interface UndispatchedIntercom { id: string; from: SessionAddress; to: SessionAddress; endpoint: SessionEndpoint }
export interface RetainedIntercom {
  identity: IntercomIdentity;
  endpoint: SessionEndpoint;
  peer: MachineId;
  /** Persisted first-accepting machine, independent of the current sender roster. */
  originMachineId?: MachineId;
  state: IntercomState;
  payloadRetained: boolean;
  linkAcknowledged: boolean;
  latestAttempt: number;
  reconciliation?: MessageReceipt;
  pendingProof?: IntercomReceiptFrame;
  failureReason?: string;
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
export interface IntercomEdgeState {
  peer: MachineId;
  edgeEpoch: string;
  outbound: { poll: number; push: number };
  inbound: { poll: number; push: number };
  status: "unknown" | "live" | "recovering" | "down";
  outageSince: number | null;
  reason: string | null;
  lastSuccess: number | null;
  failures: number;
  roster: RemoteSessionInfo[];
}

export interface IntercomPairFence { peer: MachineId; edgeEpoch: string; fenceId: string; fencedAt: number }
export interface IntercomPairApproval { expectedFenceId: string | null; operationId: string; graphDigest: string; edgeEpoch: string }
export type IntercomMode = "hub-only" | "peers";
export interface IntercomTopologyTransition {
  transitionId: string;
  from: "hub-only";
  to: "peers";
  state: "draining" | "switching" | "complete";
  boxes: Record<MachineId, "pending" | "switched">;
}
export interface IntercomTopologyAudit {
  id: string; reason: "topology-transition"; transitionId: string; oldNextHop: MachineId; newNextHop: MachineId; timestamp: number;
}
export interface IntercomTopologyStore {
  topology(): { mode: IntercomMode; transition: IntercomTopologyTransition | null; switched: string | null };
  startTopologyTransition(input: { transitionId: string; from: IntercomMode; to: IntercomMode; boxes: readonly MachineId[] }): IntercomTopologyTransition;
  advanceTopologyTransition(): IntercomTopologyTransition;
  acknowledgeTopologySwitch(transitionId: string, peer: MachineId): void;
  /** One local transaction changes mode, proves each route change safe, and writes its audit. */
  switchTopology(input: { transitionId: string; hubMachineId: MachineId; directPeers: readonly MachineId[] }): { rebound: number; missing: MachineId[] };
  rebindTopologyRoutes(input: { hubMachineId: MachineId; directPeers: readonly MachineId[] }): { rebound: number; missing: MachineId[] };
  recordTopologyRefusal(input: { peer: MachineId; identity: IntercomIdentity }): void;
  topologyAudit(): readonly IntercomTopologyAudit[];
  missingTopologyRoutes(): readonly MachineId[];
}
export interface IntercomStore extends IntercomTopologyStore {
  claimPresence(entry: RemoteSessionInfo, context: { knownMachines: readonly MachineId[]; assigned: boolean; competing: boolean }): boolean;
  presenceOwner(address: SessionAddress): { machineId: MachineId; activation: string; ambiguous: boolean } | null;
  recordRejection(peer: MachineId, id: string, reason: string): void;
  rejectionDiagnostics(): readonly { peer: MachineId; status: string; since: number; reason: string }[];
  pairFence(peer: MachineId): IntercomPairFence | null;
  /** Persist the fence and failure receipts atomically; it never clears an existing fence. */
  fencePair(peer: MachineId, edgeEpoch: string, fenceId?: string): { fence: IntercomPairFence; upstream: readonly MachineId[] };
  /** Call only with a durable human-consent record for the exact graph and fence generation. */
  approvePair(peer: MachineId, approval: IntercomPairApproval): boolean;
  pendingRevocationNotices(): readonly IntercomReceiptFrame[];
  acknowledgeRevocationNotice(frame: IntercomReceiptFrame): void;
  edgeState(peer: MachineId, edgeEpoch: string): IntercomEdgeState;
  updateEdgeState(peer: MachineId, edgeEpoch: string, change: (state: IntercomEdgeState) => IntercomEdgeState): IntercomEdgeState;
  /** Atomic same-machine source and inbox admission, with no second broker mailbox. */
  acceptLocal(input: { from: SessionAddress; endpoint: SessionEndpoint; message: Message; firstHomePresence?: RemoteSessionInfo }): IntercomAcceptance;
  acceptOutbound(input: OutboundMessage): IntercomAcceptance;
  /** The transport authenticates the peer. Resume owners come from the local authoritative home lookup, not the wire. */
  openHop(peer: MachineId, edgeEpoch: string): void;
  inspectHop(input: { peer: MachineId; edgeEpoch: string; sequence: number; identity: IntercomIdentity; origin?: MachineId }):
    { kind: "next" | "duplicate" } | { kind: "refused"; reason: IntercomRefusal["reason"] };
  hopPosition(queue: IntercomQueue, peer: MachineId, edgeEpoch: string, identity: IntercomIdentity): number | undefined;
  rejectHop(input: { peer: MachineId; edgeEpoch: string; sequence: number; identity: IntercomIdentity; origin?: MachineId; reason: IntercomRefusal["reason"] }): void;
  acceptInbound(input: { peer: MachineId; frame: IntercomFrame; hop?: { edgeEpoch: string; sequence: number };
    forward?: { peer: MachineId; edgeEpoch: string; firstHomePresence?: RemoteSessionInfo };
    resume?: { cursor: IntercomPairResume; owner: Home | null } }): IntercomAcceptance;
  rejectMissingOrigin(input: { peer: MachineId; frame: MissingOriginFrame }): void;
  rejectFrame(input: { peer: MachineId; origin: MachineId; identity: IntercomIdentity; reason: "sender-unauthorized" | "store-rejected" | "peer-revoked" }): void;
  outboundResumptions(peer: MachineId, edgeEpoch?: string): readonly IntercomPairResume[];
  /** maxBytes includes each encoded frame and one separator, after reserving the rest of the exchange. */
  pending(input: { kind: "outbound"; peer: MachineId; edgeEpoch: string; hopBudgetMs: number; maxBytes?: number; skipIds?: readonly string[] }): readonly IntercomWireFrame[];
  pending(input: { kind: "outbound"; peer: MachineId; edgeEpoch?: string; hopBudgetMs: number; maxBytes?: number; skipIds?: readonly string[] }): readonly IntercomFrame[];
  pending(input: { kind: "inbound"; address: SessionAddress }): readonly IntercomIdentity[];
  pending(input: { kind: "receipts"; peer: MachineId; maxBytes?: number }): readonly IntercomReceiptFrame[];
  acknowledge(input: { peer: MachineId; edgeEpoch?: string; hopSequence?: number; identity: IntercomIdentity; kind: IntercomFrame["kind"] }): void;
  acknowledgeReceipt(input: { peer: MachineId; frame: IntercomReceiptFrame }): void;
  beginDispatch(input: { id: string; endpoint: SessionEndpoint; readiness: string }): IntercomMessageFrame;
  /** Call only with client proof that this exact dispatch never reached a socket write. */
  retryKnownNotSent(input: { id: string; endpoint: SessionEndpoint; attempt: number }): void;
  followConsumption(input: { queue: IntercomQueue; peer: MachineId; frame: IntercomReceiptInput }): void;
  followResumedReceipt(input: { queue: IntercomQueue; peer: MachineId; frame: IntercomReceiptInput; proof: RebindProof }): void;
  settleReceipt(input: { queue: IntercomQueue; peer: MachineId; frame: IntercomReceiptInput }): void;
  isSettledReceipt(input: { peer: MachineId; frame: IntercomReceiptFrame }): boolean;
  resolveUnknown(input: { queue: IntercomQueue; id: string; digest: string; proof: IntercomReceiptInput }): void;
  cancel(input: { queue: IntercomQueue; id: string; from: SessionAddress; to: SessionAddress }): void;
  expire(): readonly { queue: IntercomQueue; id: string }[];
  nextExpiry(): number | null;
  inspectBlockers(address: SessionAddress): FederationBlockers;
  /** Ordinary copies with positive never-dispatched metadata may remain queued during a move. */
  inspectMoveBlockers(address: SessionAddress): FederationBlockers;
  undispatched(address: SessionAddress): readonly UndispatchedIntercom[];
  openAsks(peer: MachineId): readonly RetainedIntercom[];
  hasGenerationReferences(sessionId: string, generation: string): boolean;
  noticeReported(id: string, kind: "expiry" | "link-down"): boolean;
  markNoticeReported(id: string, kind: "expiry" | "link-down"): void;
  expiredOutbounds(peer: MachineId): readonly { identity: IntercomIdentity; outcomeKnown: boolean }[];
  hasPending(peer: MachineId): boolean;
  rebindUndispatched(address: SessionAddress, endpoint: SessionEndpoint, proof: RebindProof, edgeEpoch?: string): number;
  rebindMoveUndispatched(address: SessionAddress, endpoint: SessionEndpoint, proof: RebindProof, edgeEpoch?: string): number;
  rebindInboundAfterAbsence(id: string, endpoint: SessionEndpoint): void;
  retained(queue: IntercomQueue, id: string): RetainedIntercom | null;
  close(): void;
}
