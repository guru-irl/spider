import type { DeliveryDetails, Message, MessageControl, MessageReceipt, SessionInfo, RemoteSessionInfo } from "./types.js";
export * from "./types.js";
import { isMessageReceipt, isConsumptionReceipt } from "./broker/protocol.js";
export { parseFederationBrokerMessage, isSessionAddress, isSessionEndpoint, isRemoteSessionInfo, isMessage, isMessageReceipt, isMessageControl, isFederationDispatchResult, isConsumptionReceipt, isReceiptEvidence } from "./broker/protocol.js";
export { createDeliveryObserver, createIntercomDeliveryObserver } from "./delivery-observation.js";
export type { DeliveryObservation, GenerationExclusion, IntercomObservationPorts } from "./delivery-observation.js";

export const FEDERATION_FEATURE = "federation-v1";

/** Logical identity. Machine aliases and endpoint generations are replaceable routes. */
export interface SessionAddress { sessionId: string; scopeId: string | null }
export interface SessionEndpoint {
  address: SessionAddress;
  machineId: string;
  homeEpoch: number | null;
  activationEpoch: string;
}
export type AcceptanceEvidence =
  | { accepted: false; durable: false; location?: never }
  | { accepted: true; durable: false; location?: never }
  | { accepted: true; durable: true; location: string };
export type ConsumptionEvidence =
  | { kind: "entry"; entryId: string; sessionId: string; activationEpoch: string }
  | { kind: "waiter"; entryId: string; sessionId: string; activationEpoch: string; askId: string }
  | { kind: "absence"; sessionId: string; activationEpoch: string; excludedGeneration: string; complete: true };
export interface FederationDispatchResult extends DeliveryDetails {
  acceptance: AcceptanceEvidence;
  reason?: string;
  consumption?: MessageReceipt;
}
export interface FederationDispatch { from: SessionAddress; to: RemoteSessionInfo; message: Message }
export interface AskBlocker { id: string; from: SessionAddress; to: SessionAddress }
/** Metadata only. None of these queries returns authored content or local handles. */
export interface FederationBlockers {
  asks: readonly AskBlocker[];
  pendingDispatch: readonly string[];
  unknownOutcomes: readonly string[];
  unobservedReceipts: readonly string[];
}
export interface BridgeRegistration { feature: string; agentDir: string; machineId: string; machineAlias: string }
/** The one machine-owned durable bridge. The broker owns no remote payload queue. */
export interface FederationBridge {
  dispatch(frame: FederationDispatch): Promise<FederationDispatchResult>;
  receipt(from: SessionAddress, receipt: MessageReceipt): void;
  control(from: SessionAddress, to: SessionAddress, control: MessageControl): void;
}
export interface FederationPort {
  registerBridge(registration: BridgeRegistration, bridge: FederationBridge): () => void;
  publishPresence(entries: readonly RemoteSessionInfo[]): void;
  dispatch(from: SessionAddress, to: RemoteSessionInfo, message: Message): Promise<FederationDispatchResult>;
  receipt(from: SessionAddress, receipt: MessageReceipt): void;
  control(from: SessionAddress, to: SessionAddress, control: MessageControl): void;
  inspectBlockers(address: SessionAddress): FederationBlockers;
}
export interface LocalPresence {
  startedAt: number;
  lastActivity: number;
  homeEpoch: number | null;
  address: SessionAddress;
  activationEpoch: string;
  name?: string;
  cwd: string;
  model: string;
  status?: string;
}
export type FederationClientMessage =
  | ({ type: "federation_register" } & BridgeRegistration)
  | { type: "federation_presence"; sessions: RemoteSessionInfo[] }
  | { type: "federation_result"; requestId: string; result: FederationDispatchResult }
  | { type: "federation_deliver"; requestId: string; from: RemoteSessionInfo; to: SessionEndpoint; message: Message }
  | { type: "federation_deliver_receipt"; from: RemoteSessionInfo; to: SessionAddress; receipt: MessageReceipt }
  | { type: "federation_deliver_control"; from: RemoteSessionInfo; to: SessionAddress; control: MessageControl }
  | { type: "inspect_blockers"; requestId: string; address: SessionAddress };
export type FederationBrokerMessage =
  | { type: "federation_registered"; features: string[] }
  | { type: "federation_local_presence"; sessions: LocalPresence[] }
  | { type: "federation_dispatch"; requestId: string; dispatch: FederationDispatch }
  | { type: "federation_receipt"; from: SessionAddress; receipt: MessageReceipt }
  | { type: "federation_control"; from: SessionAddress; to: SessionAddress; control: MessageControl }
  | { type: "federation_delivery_result"; requestId: string; result: FederationDispatchResult }
  | { type: "blockers"; requestId: string; blockers: FederationBlockers };

/** Validate the receipt after authenticating its route and immutable message identity. */
export function receiptReleasesPayload(receipt: MessageReceipt): boolean {
  return isMessageReceipt(receipt) && (receipt.status === "expired" || receipt.status !== "not_injected" && isConsumptionReceipt(receipt));
}

export function addressKey(address: SessionAddress): string { return JSON.stringify([address.scopeId, address.sessionId]); }
export function sameAddress(a: SessionAddress, b: SessionAddress): boolean { return a.sessionId === b.sessionId && a.scopeId === b.scopeId; }
export function sessionAddress(session: SessionInfo, scopeId: string | null = null): SessionAddress {
  return session.address ?? { sessionId: session.id, scopeId };
}
export function qualifiedName(session: SessionInfo): string {
  const name = session.name || session.id;
  return session.remote ? `${encodeURIComponent(session.machineAlias)}/${encodeURIComponent(name)}` : name;
}

/** ID first, then an exact qualified or bare name, then an unambiguous ID prefix. */
export function resolveSessionTarget(target: string, sessions: readonly SessionInfo[]): SessionInfo | null {
  let matches = sessions.filter(session => session.id === target || session.address?.sessionId === target);
  if (!matches.length) {
    const slash = target.indexOf("/");
    if (slash >= 0) {
      let machine: string, name: string;
      try { machine = decodeURIComponent(target.slice(0, slash)); name = decodeURIComponent(target.slice(slash + 1)); }
      catch { throw new Error("invalid-target-qualifier"); }
      matches = sessions.filter(session => session.remote && session.machineAlias.toLowerCase() === machine.toLowerCase() && (session.name?.toLowerCase() === name.toLowerCase() || session.id === name));
    } else matches = sessions.filter(session => session.name?.toLowerCase() === target.toLowerCase());
  }
  if (!matches.length && !target.includes("/")) matches = sessions.filter(session => session.id.startsWith(target));
  if (matches.length > 1) throw new Error(`ambiguous-target: Multiple sessions match "${target}". Use the session ID.`);
  return matches[0] ?? null;
}
