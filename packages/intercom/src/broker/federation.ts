import {
  FEDERATION_FEATURE, addressKey, sameAddress, resolveSessionTarget,
  type BridgeRegistration, type FederationBridge, type FederationBlockers, type FederationDispatchResult,
  type FederationPort, type Message, type MessageControl, type MessageReceipt, type RemoteSessionInfo,
  type SessionAddress, type SessionInfo,
} from "../protocol.js";
import { isRemoteSessionInfo, isConsumptionReceipt } from "./protocol.js";

interface DispatchMetadata {
  createdAt: number;
  from: SessionAddress;
  to: SessionAddress;
  endpoint: string;
  pending: boolean;
  unknown: boolean;
  unobserved: boolean;
}

export function createFederation(ports: { agentDir: string; locals(): readonly SessionAddress[]; now(): number }): FederationPort & {
  roster(scopeId: string | null): RemoteSessionInfo[];
  resolve(target: string, scopeId: string | null, local: readonly SessionInfo[]): SessionInfo | null;
  connected(): boolean;
  dispatchLocal(from: SessionAddress, to: RemoteSessionInfo, message: Message): Promise<FederationDispatchResult>;
  observeControl(from: SessionAddress, to: SessionAddress, control: MessageControl): void;
  observeReceipt(from: SessionAddress, receipt: MessageReceipt): void;
  observeInbound(from: SessionAddress, to: SessionAddress, activationEpoch: string, message: Message): void;
} {
  let bridge: FederationBridge | null = null;
  let localMachine: string | null = null;
  let remote = new Map<string, RemoteSessionInfo>();
  const dispatches = new Map<string, DispatchMetadata>();
  const asks = new Map<string, { id: string; from: SessionAddress; to: SessionAddress; createdAt: number }>();
  const prune = () => {
    const now = ports.now();
    for (const [id, value] of dispatches) if (now - value.createdAt > 60 * 60 * 1000) dispatches.delete(id);
    for (const [id, value] of asks) if (now - value.createdAt > 60 * 60 * 1000) asks.delete(id);
    for (const map of [dispatches, asks]) while (map.size > 4096) map.delete(map.keys().next().value!);
  };
  const requireBridge = () => { if (!bridge) throw new Error("federation-unavailable"); return bridge; };
  const related = (address: SessionAddress, item: DispatchMetadata) => sameAddress(address, item.from) || sameAddress(address, item.to);
  const applyControl = (from: SessionAddress, to: SessionAddress, control: MessageControl): void => {
    const edge = asks.get(control.messageId);
    if (edge && sameAddress(edge.from, from) && sameAddress(edge.to, to)) asks.delete(control.messageId);
  };
  const admitAsk = (from: SessionAddress, to: SessionAddress, message: Message): void => {
    if (!message.expectsReply) return;
    if ([...asks.values()].some(edge => sameAddress(edge.from, from) && edge.id !== message.id)) throw new Error("one-outbound-ask");
    if ([...asks.values()].some(edge => edge.id !== message.replyTo && sameAddress(edge.from, to) && sameAddress(edge.to, from))) throw new Error("mutual-ask-refused");
    asks.set(message.id, { id: message.id, from, to, createdAt: ports.now() });
  };
  const applyReceipt = (from: SessionAddress, receipt: MessageReceipt): void => {
    const edge = asks.get(receipt.messageId);
    if (receipt.status === "expired" && edge && sameAddress(edge.to, from)) asks.delete(receipt.messageId);
    const metadata = dispatches.get(receipt.messageId);
    if (metadata && sameAddress(metadata.to, from)) {
      if (isConsumptionReceipt(receipt) && receipt.evidence?.activationEpoch === metadata.endpoint && receipt.evidence.sessionId === from.sessionId) {
        metadata.unobserved = false; metadata.unknown = false;
      } else if (receipt.status === "expired") {
        metadata.unobserved = false; metadata.unknown = false;
      } else if (receipt.status === "unknown") metadata.unknown = true;
      if (!metadata.unobserved) dispatches.delete(receipt.messageId);
    }
  };
  async function dispatchTracked(from: SessionAddress, to: RemoteSessionInfo, message: Message): Promise<FederationDispatchResult> {
      prune();
      admitAsk(from, to.address, message);
      const metadata: DispatchMetadata = { createdAt: ports.now(), from, to: to.address, endpoint: to.activationEpoch, pending: true, unknown: false, unobserved: true };
      dispatches.set(message.id, metadata); prune();
      try {
        const result = await requireBridge().dispatch({ from, to, message });
        metadata.pending = false;
        metadata.unknown = result.delivery === "unknown";
        if (result.consumption && result.consumption.messageId !== message.id) throw new Error("receipt-message-mismatch");
        if (result.delivery === "failed") { metadata.unobserved = false; asks.delete(message.id); dispatches.delete(message.id); }
        if (result.consumption) applyReceipt(to.address, result.consumption);
        if (message.replyTo && result.acceptance.accepted) {
          const edge = asks.get(message.replyTo);
          if (edge && sameAddress(edge.to, from) && sameAddress(edge.from, to.address)) asks.delete(message.replyTo);
        }
        return result;
      } catch {
        metadata.pending = false; metadata.unknown = true;
        return { delivery: "unknown", retryable: false, outcomeKnown: false, acceptance: { accepted: false, durable: false }, reason: "bridge-dispatch-unknown" };
      }
  }
  return {
    connected: () => bridge !== null,
    observeReceipt: applyReceipt,
    observeControl: applyControl,
    observeInbound(from, to, activationEpoch, message): void {
      prune();
      admitAsk(from, to, message);
      dispatches.set(message.id, { createdAt: ports.now(), from, to, endpoint: activationEpoch, pending: false, unknown: false, unobserved: true });
      if (message.replyTo) {
        const edge = asks.get(message.replyTo);
        if (edge && sameAddress(edge.from, to) && sameAddress(edge.to, from)) asks.delete(message.replyTo);
      }
    },
    registerBridge(registration: BridgeRegistration, next: FederationBridge): () => void {
      if (registration.feature !== FEDERATION_FEATURE) throw new Error("federation-feature-required");
      if (registration.agentDir !== ports.agentDir) throw new Error("federation-agent-directory-mismatch");
      if (bridge) throw new Error("bridge-already-registered");
      bridge = next; localMachine = registration.machineId;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (bridge === next) {
          bridge = null; localMachine = null;
          remote = new Map([...remote].map(([key, entry]) => [key, { ...entry, stale: true, reachability: "unknown" }]));
        }
      };
    },
    publishPresence(entries): void {
      requireBridge();
      const next = new Map<string, RemoteSessionInfo>();
      for (const entry of entries) {
        if (["pid", "peerUid", "trustedLocal", "tmuxPane", "runtimeFallbackAlias"].some(key => key in entry)) throw new Error("remote-local-handle-refused");
        if (!isRemoteSessionInfo(entry)) throw new Error("invalid-remote-presence");
        if (ports.locals().some(local => sameAddress(local, entry.address))) throw new Error("remote-cannot-shadow-local-session");
        const key = addressKey(entry.address);
        if (next.has(key)) throw new Error("duplicate-remote-address");
        const previous = remote.get(key);
        if (previous && ((entry.homeEpoch ?? 0) < (previous.homeEpoch ?? 0))) throw new Error("stale-home-epoch");
        next.set(key, structuredClone(entry));
      }
      remote = next;
    },
    roster(scopeId): RemoteSessionInfo[] {
      return [...remote.values()].filter(entry => entry.address.scopeId === scopeId && !ports.locals().some(local => sameAddress(local, entry.address))).map(entry => structuredClone(entry));
    },
    resolve(target, scopeId, local): SessionInfo | null {
      return resolveSessionTarget(target, [...local, ...this.roster(scopeId)]);
    },
    async dispatch(from, to, message): Promise<FederationDispatchResult> {
      requireBridge();
      if (from.scopeId !== to.address.scopeId) throw new Error("federation-scope-mismatch");
      if (sameAddress(from, to.address)) throw new Error("self-target-refused");
      const current = remote.get(addressKey(to.address));
      if (!current || current.activationEpoch !== to.activationEpoch || current.homeEpoch !== to.homeEpoch || current.machineId !== to.machineId) throw new Error("stale-remote-endpoint");
      if (ports.locals().some(local => sameAddress(local, to.address))) throw new Error("remote-cannot-shadow-local-session");
      return dispatchTracked(from, current, message);
    },
    async dispatchLocal(from, to, message) {
      requireBridge();
      if (to.machineId !== localMachine || to.homeEpoch === null || !ports.locals().some(local => sameAddress(local, to.address)) || from.scopeId !== to.address.scopeId || sameAddress(from, to.address)) throw new Error("invalid-local-home-endpoint");
      return dispatchTracked(from, to, message);
    },
    receipt(from, receipt): void {
      applyReceipt(from, receipt);
      bridge?.receipt(from, receipt);
    },
    control(from, to, control: MessageControl): void {
      requireBridge().control(from, to, control);
      applyControl(from, to, control);
    },
    inspectBlockers(address): FederationBlockers {
      prune();
      const entries = [...dispatches.entries()].filter(([, value]) => related(address, value));
      return {
        asks: structuredClone([...asks.values()].filter(edge => sameAddress(edge.from, address) || sameAddress(edge.to, address)).map(({ id, from, to }) => ({ id, from, to }))),
        pendingDispatch: entries.filter(([, value]) => value.pending).map(([id]) => id),
        unknownOutcomes: entries.filter(([, value]) => value.unknown).map(([id]) => id),
        unobservedReceipts: entries.filter(([, value]) => value.unobserved).map(([id]) => id),
      };
    },
  };
}
