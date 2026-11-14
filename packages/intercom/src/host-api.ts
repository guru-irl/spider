import type { MessageReceipt, SessionAddress, SessionEndpoint } from "./protocol.js";

export const INTERCOM_HOST_EVENT = "spider:intercom-host";
export const INTERCOM_RESOLVE_EVENT = "spider:intercom-resolve";
export interface IntercomHostRequest {
  sessionId: string;
  scopeId: string | null;
  activationEpoch: string;
  endpoint?: SessionEndpoint;
  exclusion?(owner: SessionEndpoint): { excludedGeneration: string; complete: true } | undefined;
  reconcile?(messageId: string, owner: SessionEndpoint): Promise<MessageReceipt>;
  pendingOwn?(): Promise<readonly { messageId: string; owner: SessionEndpoint }[]>;
  home?(address: SessionAddress): { machineId: string; epoch: number } | null | "unknown";
}
export type IntercomRouteResolution =
  | { kind: "local" | "bridge"; to: string; address: SessionAddress }
  | { kind: "ambiguous" | "unknown"; reason?: string };
export interface IntercomResolveRequest {
  to: string;
  handled: boolean;
  respond(result: IntercomRouteResolution): void;
}
