import { randomBytes } from "node:crypto";
import { type IntercomIntakeAction, type IntercomIntakeFence } from "@spider/intercom/protocol";
import { isIntercomIntakeAction, isIntercomIntakeFence } from "../../intercom/src/broker/protocol";
import type { IntercomFederationClient } from "../../intercom/src/broker/client";
import {
  FEDERATION_FEATURE, addressKey, isHelperExchangeError, isConsumptionReceipt, isRemoteSessionInfo, receiptReleasesPayload, sameAddress,
  type FederationBlockers, type FederationBridge, type FederationDispatch, type FederationDispatchResult,
  type FirstHomeAttestation, type LocalPresence, type MessageControl, type MessageReceipt, type RemoteSessionInfo, type SessionAddress, type SessionEndpoint,
} from "@spider/intercom/protocol";
import type { Home } from "@spider/db-core/roam/types";
import type { Clock, Peer, Transport } from "./contracts";
import { encodeExchange } from "./intercom-codec";
import { INTERCOM_EXCHANGE_BYTES, INTERCOM_FEDERATION_VERSION, type ExchangeGeneration, type IntercomControlFrame, type IntercomExchange,
  type IntercomIdentity, type IntercomLinkAck, type IntercomPairApproval, type IntercomReceiptFrame, type IntercomRefusal, type AuthenticatedIntercomExchange, type IntercomWireAck, type IntercomWireRefusal, type IntercomStore, type RebindProof, type UndispatchedIntercom, type IntercomWireMissingOriginFrame } from "./intercom-contracts";
import { ExchangeError, exchange as executeExchange, type EnrolledIntercomEdge } from "./intercom-exchange";
import { parseHelperEnroll, parseHelperFence, parseHelperInspect, parseHelperRequest, parseHelperRevoke, parseHelperTopology, type HelperTopologyRequest, type HelperEnrollRequest, type HelperReply } from "./intercom-helper";
import { acquireHelperRoute, type HelperRouteLease } from "./intercom-route";
import { isMachineId } from "./machine-id";

export interface IntercomBroker extends Pick<IntercomFederationClient, "connect" | "enableHelpers" | "publishPresence" | "deliver" | "deliverReceipt" | "deliverRevocationNotice" | "deliverControl" | "close" | "inspectBlockers"> {
  on(event: "presence", listener: (sessions: LocalPresence[]) => void): unknown;
  on(event: "disconnected", listener: () => void): unknown;
  off(event: "presence", listener: (sessions: LocalPresence[]) => void): unknown;
  off(event: "disconnected", listener: () => void): unknown;
}
export interface BridgePorts {
  machineId: string;
  machineAlias: string;
  /** Enabled only by a roaming participant composition. */
  moveFences?: boolean;
  edges: readonly EnrolledIntercomEdge[];
  store: IntercomStore;
  transport: Transport;
  clock: Clock;
  broker?: IntercomBroker;
  globalRoot?: string;
  agentDir?: string;
  routeLease?: HelperRouteLease;
  ensureBroker?(): Promise<void>;
  localPresence(): readonly RemoteSessionInfo[];
  firstHomeAttestation?(endpoint: SessionEndpoint): FirstHomeAttestation | undefined;
  authorizeLocalPresence?(session: LocalPresence): boolean;
  authoritativeHome(address: SessionAddress): Home | null;
  knownSessionMachines?(address: SessionAddress): readonly string[];
  sessionOrigin?(address: SessionAddress): string | null;
  nextHop?(destinationMachine: string, previousPeer?: string): string | null;
  authorizePresence?(peer: string, entry: RemoteSessionInfo): boolean;
  authorizeOrigin?(peer: string, originMachineId: string): boolean;
  advertiseRelay?(peer: string, entry: RemoteSessionInfo): boolean;
  topology?(peer: string): IntercomExchange["topology"];
  onTopology?(peer: string, control: IntercomExchange["topology"]): void;
  onTopologyRequest?(request: HelperTopologyRequest): Promise<{ machineId: string; transitionId: string; state: "draining" | "switching" | "complete" }>;
  publishPresence?(entries: readonly RemoteSessionInfo[]): void;
  onInbound?(identity: { id: string; to: SessionAddress }): void;
  onReceipt?(frame: IntercomReceiptFrame): void;
  onRevocationNotice?(frame: IntercomReceiptFrame): Promise<boolean>;
  onRefusal?(failure: IntercomRefusal & { peer: string }): void;
  onExpiry?(event: { peer: string; id: string; from: SessionAddress; to: SessionAddress; outcomeKnown: boolean }): void;
  onControl?(frame: IntercomControlFrame): void;
  onLinkDown?(peer: string, reason: string): void;
  onBrokerState?(ready: boolean): void;
  maintain?(): void;
  onEnrollRequest?(input: HelperEnrollRequest): Promise<{ machineId: string; peer: string; edgeEpoch: string; applied: true }>;
  onRevokeRequest?(input: { peer: string; edgeEpoch: string; fenceId: string }): Promise<void>;
  onAskFailed?(failure: { peer: string; id: string; from: SessionAddress; to: SessionAddress; reason: "link-down"; outcomeKnown: false }): void;
}
export interface IntercomBridge extends FederationBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  revokePair(peer: string, edgeEpoch: string, fenceId?: string): Promise<{ peer: string; edgeEpoch: string; fenceId: string; exchanges: "closed"; inFlight: 0 }>;
  enrollPair(edge: EnrolledIntercomEdge, approval: IntercomPairApproval): Promise<void>;
  exchange(input: unknown, signal?: AbortSignal): Promise<HelperReply>;
  wake(peer: string): void;
  inspectBlockers(address: SessionAddress): FederationBlockers;
  inspectMoveBlockers(address: SessionAddress): FederationBlockers;
  drainIntake(fence: IntercomIntakeFence): Promise<void>;
  undispatched(address: SessionAddress): readonly UndispatchedIntercom[];
  rebindMove(fence: IntercomIntakeFence, endpoint: SessionEndpoint, proof: RebindProof): number;
  resumeIntake(fence: IntercomIntakeFence): void;
  diagnostics(): readonly { peer: string; status: string; since: number; reason: string }[];
}
interface Inflight { generation: number; abort: AbortController; wake: (() => void) | null; preempted: boolean; done: Promise<void>; finish(): void }
interface Outflight { generation: number; abort: AbortController; promise: Promise<boolean>; connectedUntil: number }
interface EdgeRuntime {
  config: EnrolledIntercomEdge;
  incoming: Map<"poll" | "push", Inflight>;
  incomingAll: Set<Inflight>;
  outgoing: Map<"poll" | "push", Outflight>;
  controls: Map<string, IntercomControlFrame>;
  failedAsks: Set<string>;
  pollSent: Map<string, { at: number; until: number }>;
  pushIds: Set<string>;
  acknowledgements: Map<string, IntercomWireAck>;
  receiptAcknowledgements: Map<string, IntercomReceiptFrame>;
  refusals: Map<string, IntercomWireRefusal>;
  reportedRefusals: Set<string>;
  resolved: Peer | null;
  versionReady: boolean;
  retryCancel: (() => void) | null;
  pollCancel: (() => void) | null;
  livenessCancel: (() => void) | null;
  pushCancel: (() => void) | null;
  pushDirty: boolean;
  admissionWaiters: Set<{ deadline: number; finish(live: boolean): void }>;
}
const bad = (code: string): never => { throw new ExchangeError(code); };
const hasData = (value: IntercomExchange): boolean => value.frames.length > 0 || value.acknowledgements.length > 0 || (value.refusals?.length ?? 0) > 0 || value.receipts.length > 0 ||
  (value.receiptAcknowledgements?.length ?? 0) > 0 || value.controls.length > 0 || value.topology !== undefined;
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const sameIdentity = (a: IntercomIdentity, b: IntercomIdentity): boolean => a.id === b.id && a.sequence === b.sequence && a.digest === b.digest &&
  a.askId === b.askId && sameAddress(a.from, b.from) && sameAddress(a.to, b.to);
const sameEndpoint = (a: import("@spider/intercom/protocol").SessionEndpoint, b: import("@spider/intercom/protocol").SessionEndpoint): boolean =>
  sameAddress(a.address, b.address) && a.machineId === b.machineId && a.homeEpoch === b.homeEpoch && a.activationEpoch === b.activationEpoch;
const failed = (reason: string): FederationDispatchResult => ({ delivery: "failed",
  retryable: !["machine-not-enrolled", "peer-revoked", "message-too-large", "ask-expired"].includes(reason), outcomeKnown: true,
  acceptance: { accepted: false, durable: false }, reason });

// Move intake is independent of transport, presence and relay receipts.
function createMoveIntake() {
  const fences = new Map<string, { fence: IntercomIntakeFence; closed: boolean }>();
  const active = new Set<{ id: string; from: SessionAddress; to: SessionAddress; done: Promise<void>; finish(): void }>();
  const same = (a: IntercomIntakeFence, b: IntercomIntakeFence) => sameAddress(a.address, b.address) && a.moveId === b.moveId &&
    a.expectedEpoch === b.expectedEpoch && a.generation === b.generation;
  const closed = (address: SessionAddress) => fences.get(addressKey(address))?.closed === true;
  const apply = (action: IntercomIntakeAction, fence: IntercomIntakeFence): string | null => {
    if (!isIntercomIntakeAction(action) || !isIntercomIntakeFence(fence)) throw new Error("invalid-intake-request");
    const key = addressKey(fence.address), current = fences.get(key);
    const replacing = action === "close" && current && !current.closed && fence.expectedEpoch >= current.fence.expectedEpoch && fence.moveId !== current.fence.moveId;
    if (current && !same(current.fence, fence) && !replacing || action !== "close" && !current || action === "check" && !current?.closed) return null;
    fences.set(key, { fence, closed: action !== "open" });
    return fence.generation;
  };
  return { closed, apply,
    begin(input: FederationDispatch) {
      if (closed(input.from) || input.message.expectsReply && closed(input.to.address)) return null;
      let finish!: () => void;
      const item = { id: input.message.id, from: input.from, to: input.to.address, done: new Promise<void>(resolve => { finish = resolve; }), finish: () => {} };
      item.finish = () => { active.delete(item); finish(); };
      active.add(item); return item;
    },
    pending(store: IntercomStore): string[] {
      return [...fences.values()].filter(row => row.closed).flatMap(row => [...store.inspectBlockers(row.fence.address).pendingDispatch]);
    },
    inspect(address: SessionAddress, store: IntercomStore): FederationBlockers {
      const snapshot = store.inspectMoveBlockers(address);
      return { ...snapshot, pendingDispatch: [...new Set([...snapshot.pendingDispatch, ...[...active].filter(row =>
        sameAddress(row.from, address) || sameAddress(row.to, address)).map(row => row.id)])] };
    },
    async drain(fence: IntercomIntakeFence) {
      if (apply("check", fence) !== fence.generation) throw new Error("intercom-generation-changed");
      await Promise.all([...active].filter(row => sameAddress(row.from, fence.address) || sameAddress(row.to, fence.address)).map(row => row.done));
      if (apply("check", fence) !== fence.generation) throw new Error("intercom-generation-changed");
    },
  };
}

export function createIntercomBridge(ports: BridgePorts): IntercomBridge {
  if (!isMachineId(ports.machineId) || typeof ports.machineAlias !== "string" || !ports.machineAlias || !Array.isArray(ports.edges)) throw new Error("Invalid intercom bridge identity");
  const intake = ports.moveFences ? createMoveIntake() : undefined;
  const notifyInbound: NonNullable<BridgePorts["onInbound"]> = input => { if (!intake?.closed(input.to)) ports.onInbound?.(input); };
  const edges = new Map<string, EdgeRuntime>();
  const validEdge = (config: EnrolledIntercomEdge) => !!config && !!config.peer && isMachineId(config.peer.machineId) &&
    config.peer.machineId !== ports.machineId && typeof config.edgeEpoch === "string" && !!config.edgeEpoch && typeof config.initiator === "boolean";
  const makeEdge = (config: EnrolledIntercomEdge): EdgeRuntime => ({ config, incoming: new Map(), incomingAll: new Set(), outgoing: new Map(), controls: new Map(), failedAsks: new Set(),
    pollSent: new Map(), pushIds: new Set(), acknowledgements: new Map(), receiptAcknowledgements: new Map(), refusals: new Map(),
    reportedRefusals: new Set(), resolved: null, versionReady: false, retryCancel: null, pollCancel: null,
    livenessCancel: null, pushCancel: null, pushDirty: false, admissionWaiters: new Set() });
  for (const config of ports.edges) {
    if (!validEdge(config) || edges.has(config.peer.machineId)) throw new Error("Invalid intercom enrollment");
    edges.set(config.peer.machineId, makeEdge(config));
  }
  if (ports.broker && (!ports.globalRoot || !ports.agentDir)) throw new Error("Invalid intercom broker route");
  let started = false, stopped = false, brokerReady = false;
  let startTask: Promise<void> | null = null, stopTask: Promise<void> | null = null;
  const lifetime = new AbortController();
  let routeLease: HelperRouteLease | null = null, brokerLocal: RemoteSessionInfo[] = [];
  let brokerRetryCancel: (() => void) | null = null, brokerRetries = 0, brokerConnectTask: Promise<void> | null = null;
  let expiryCancel: (() => void) | null = null, expiryDeadline: number | null = null, expiryNoticeRetry = false, localReceiptRetry = false, revocationNoticeRetry = false;
  const revocations = new Map<string, Promise<{ peer: string; edgeEpoch: string; fenceId: string; exchanges: "closed"; inFlight: 0 }>>();
  const noticeInFlight = new Set<string>();
  const fenced = (edge: EdgeRuntime): boolean => ports.store.pairFence(edge.config.peer.machineId) !== null;
  const lookup = (destination: string, previous?: string): EdgeRuntime | null => {
    const hop = edges.has(destination) ? destination : ports.nextHop?.(destination, previous) ?? null;
    return hop && hop !== previous ? edges.get(hop) ?? null : null;
  };
  const state = (edge: EdgeRuntime) => ports.store.edgeState(edge.config.peer.machineId, edge.config.edgeEpoch);
  const fatalReason = (edge: EdgeRuntime): string | null => {
    if (fenced(edge)) return "peer-revoked";
    const current = state(edge);
    return current.status === "down" && current.reason && !new ExchangeError(current.reason).retryable ? current.reason : null;
  };
  const routeLive = (edge: EdgeRuntime): boolean => {
    if (fenced(edge)) return false;
    const current = state(edge), now = ports.clock.now();
    if (current.status === "down" || current.status === "recovering") return false;
    return current.lastSuccess !== null && now >= current.lastSuccess && now - current.lastSuccess < 35_000 ||
      (edge.outgoing.get("poll")?.connectedUntil ?? 0) > now;
  };
  const projectPresence = (edge: EdgeRuntime, entry: RemoteSessionInfo): RemoteSessionInfo => {
    const current = state(edge);
    const link = current.status === "down" || current.status === "recovering" ? current.status : routeLive(edge) ? "live" : "unknown";
    const reachability = link !== "live" ? link : entry.stale && (!entry.reachability || entry.reachability === "live") ? "unknown" : entry.reachability ?? "live";
    return { ...entry, stale: reachability !== "live", reachability };
  };
  const currentLocalPresence = (): RemoteSessionInfo[] => [...ports.localPresence(), ...brokerLocal].filter(entry => {
    if (intake?.closed(entry.address)) return false;
    const home = ports.authoritativeHome(entry.address);
    return home ? home.machineId === entry.machineId && home.epoch === entry.homeEpoch : entry.homeEpoch === null || entry.homeEpoch === 1;
  });
  const firstHomePresence = (endpoint: SessionEndpoint, edge: EdgeRuntime | null): RemoteSessionInfo | undefined => {
    const entries = edge ? state(edge).roster : currentLocalPresence();
    return entries.find(entry => sameAddress(entry.address, endpoint.address) && entry.machineId === endpoint.machineId &&
      entry.homeEpoch === endpoint.homeEpoch && entry.activationEpoch === endpoint.activationEpoch &&
      (edge ? (ports.authorizePresence?.(edge.config.peer.machineId, entry) ?? entry.machineId === edge.config.peer.machineId)
        : entry.machineId === ports.machineId));
  };
  const wakeRelays = (edge: EdgeRuntime, entries = state(edge).roster): void => {
    if (!ports.advertiseRelay) return;
    for (const other of edges.values()) if (other !== edge && entries.some(entry => ports.advertiseRelay!(other.config.peer.machineId, entry))) {
      bridge.wake(other.config.peer.machineId);
    }
  };
  const acceptedPresence = (edge: EdgeRuntime, entries: readonly RemoteSessionInfo[]): RemoteSessionInfo[] => entries.filter(entry => {
    const peer = edge.config.peer.machineId;
    try {
      if (entry.machineId === ports.machineId || !(ports.authorizePresence?.(peer, entry) ?? entry.machineId === peer)) {
        ports.store.recordRejection(peer, "presence", "presence-home-mismatch"); return false;
      }
      const home = ports.authoritativeHome(entry.address);
      if (home && (home.machineId !== entry.machineId || home.epoch !== entry.homeEpoch) || !home && entry.homeEpoch !== null && entry.homeEpoch !== 1) {
        ports.store.recordRejection(peer, "presence", "presence-home-mismatch"); return false;
      }
      const origin = home ? null : ports.sessionOrigin?.(entry.address);
      if (origin && origin !== entry.machineId) {
        ports.store.recordRejection(peer, "presence", "presence-origin-mismatch"); return false;
      }
      const local = currentLocalPresence().filter(item => sameAddress(item.address, entry.address));
      const others = [...edges.values()].filter(other => other !== edge).flatMap(other => state(other).roster)
        .concat([...entries]).filter(item => sameAddress(item.address, entry.address) &&
          (item.machineId !== entry.machineId || item.activationEpoch !== entry.activationEpoch));
      const context = { assigned: home !== null, competing: local.length + others.length > 0,
        knownMachines: [...local, ...others].map(item => item.machineId).concat(ports.knownSessionMachines?.(entry.address) ?? []) };
      const originMatches = home !== null || origin === entry.machineId || !origin && entry.homeEpoch === 1;
      if (!originMatches && !ports.store.presenceOwner(entry.address) && !context.competing && context.knownMachines.every(machine => machine === entry.machineId)) {
        ports.store.recordRejection(peer, "presence", "presence-origin-unknown"); return false;
      }
      if (!ports.store.claimPresence(entry, context)) {
        ports.store.recordRejection(peer, "presence", "presence-ambiguous"); return false;
      }
      if (!originMatches) { ports.store.recordRejection(peer, "presence", "presence-origin-unknown"); return false; }
      return true;
    } catch { ports.store.recordRejection(peer, "presence", "presence-ownership-unavailable"); return false; }
  });
  const revalidatePresence = (): void => {
    for (const edge of edges.values()) {
      const roster = state(edge).roster, accepted = acceptedPresence(edge, roster);
      if (accepted.length !== roster.length) ports.store.updateEdgeState(edge.config.peer.machineId, edge.config.edgeEpoch, old => ({ ...old, roster: accepted }));
    }
  };
  const publish = (): void => {
    if (!ports.publishPresence && !brokerReady) return;
    const entries = new Map<string, RemoteSessionInfo>();
    const local = new Set(currentLocalPresence().filter(isRemoteSessionInfo).map(entry => addressKey(entry.address)));
    for (const edge of edges.values()) {
      if (fenced(edge)) continue;
      const persisted = state(edge);
      for (const entry of persisted.roster) {
        const candidate = projectPresence(edge, entry);
        const key = addressKey(candidate.address), prior = entries.get(key);
        const home = ports.authoritativeHome(candidate.address);
        if (local.has(key) || home && (home.machineId !== candidate.machineId || home.epoch !== candidate.homeEpoch) ||
            !home && (candidate.homeEpoch !== null && candidate.homeEpoch !== 1 || !ports.store.presenceOwner(candidate.address) || ports.store.presenceOwner(candidate.address)?.ambiguous || ports.store.presenceOwner(candidate.address)?.machineId !== candidate.machineId)) continue;
        const epoch = candidate.homeEpoch ?? -1, priorEpoch = prior?.homeEpoch ?? -1;
        if (!prior || epoch > priorEpoch || epoch === priorEpoch && prior.stale && !candidate.stale) entries.set(key, candidate);
      }
    }
    const roster = [...entries.values()];
    ports.publishPresence?.(roster);
    if (brokerReady) ports.broker!.publishPresence(roster);
  };
  const expirePassiveRoute = (edge: EdgeRuntime): void => {
    const current = state(edge);
    if (stopped || fenced(edge) || edge.config.initiator || current.lastSuccess === null || current.status === "down" || routeLive(edge)) return;
    ports.store.updateEdgeState(edge.config.peer.machineId, edge.config.edgeEpoch, old => ({ ...old, status: "down",
      outageSince: old.outageSince ?? ports.clock.now(), reason: "cli-timeout", failures: old.failures + 1 }));
    publish(); wakeRelays(edge); ports.onLinkDown?.(edge.config.peer.machineId, "cli-timeout");
  };
  const armLiveness = (edge: EdgeRuntime): void => {
    edge.livenessCancel?.(); edge.livenessCancel = null;
    if (stopped || fenced(edge)) return;
    const current = state(edge), now = ports.clock.now();
    if (current.status === "down" || current.status === "recovering") return;
    const successUntil = current.lastSuccess !== null && current.lastSuccess <= now ? current.lastSuccess + 35_000 : 0;
    const deadline = Math.max(successUntil, edge.outgoing.get("poll")?.connectedUntil ?? 0);
    if (deadline > now) edge.livenessCancel = ports.clock.later(deadline - now, () => { edge.livenessCancel = null; expirePassiveRoute(edge); publish(); wakeRelays(edge); armLiveness(edge); });
    else expirePassiveRoute(edge);
  };
  const blank = (peer: string, generation: ExchangeGeneration): AuthenticatedIntercomExchange => ({ protocol: INTERCOM_FEDERATION_VERSION, senderMachine: ports.machineId,
    recipientMachine: peer, generation, streamStart: { after: 0 }, frames: [], acknowledgements: [], receipts: [], controls: [], presence: [] });
  const build = (edge: EdgeRuntime, generation: ExchangeGeneration, acks: readonly IntercomLinkAck[], receiptAcks: readonly IntercomReceiptFrame[], hopBudgetMs: number,
    metadataOnly = false, skipIds: readonly string[] = [], refusals: readonly IntercomRefusal[] = []): IntercomExchange => {
    const peer = edge.config.peer.machineId, result = blank(peer, generation), max = INTERCOM_EXCHANGE_BYTES - 4096;
    const topology = ports.topology?.(peer); if (topology) result.topology = topology;
    const local = [...new Map(currentLocalPresence().map(entry => [addressKey(entry.address), entry])).values()];
    if (local.some(entry => !isRemoteSessionInfo(entry) || entry.machineId !== ports.machineId)) return bad("invalid-presence");
    const advertised = new Map(local.map(entry => [addressKey(entry.address), entry]));
    if (ports.advertiseRelay) for (const other of edges.values()) if (other !== edge && !fenced(other)) {
      for (const entry of state(other).roster) {
        if (entry.machineId === peer || entry.machineId === ports.machineId || !ports.advertiseRelay(peer, entry)) continue;
        const candidate = projectPresence(other, entry), key = addressKey(entry.address), prior = advertised.get(key);
        if (!prior || prior.machineId !== ports.machineId && ((candidate.homeEpoch ?? -1) > (prior.homeEpoch ?? -1) ||
            (candidate.homeEpoch ?? -1) === (prior.homeEpoch ?? -1) && prior.stale && !candidate.stale)) advertised.set(key, candidate);
      }
    }
    result.presence = [...advertised.values()];
    if (bytes(result) > max) return bad("exchange-too-large");
    const add = <T>(list: T[], item: T): boolean => { list.push(item); if (bytes(result) <= max) return true; list.pop(); return false; };
    for (const ack of acks) if (!add(result.acknowledgements, ack)) break;
    if (receiptAcks.length) {
      result.receiptAcknowledgements = [];
      for (const ack of receiptAcks) if (!add(result.receiptAcknowledgements, ack)) break;
    }
    if (refusals.length) {
      result.refusals = [];
      for (const refusal of refusals) if (!add(result.refusals, refusal)) break;
    }
    if (metadataOnly) return result;
    for (const control of edge.controls.values()) if (!add(result.controls, control)) break;
    const resumptions = ports.store.outboundResumptions(peer, edge.config.edgeEpoch);
    if (resumptions.length) {
      result.resumptions = [];
      for (const resume of resumptions) if (!add(result.resumptions, resume)) return bad("exchange-too-large");
    }
    const remaining = () => Math.max(0, Math.min(INTERCOM_EXCHANGE_BYTES - 1024, max - bytes(result) - 16));
    for (const receipt of ports.store.pending({ kind: "receipts", peer, maxBytes: remaining() })) result.receipts.push(receipt);
    for (const frame of ports.store.pending({ kind: "outbound", peer, edgeEpoch: edge.config.edgeEpoch, hopBudgetMs, maxBytes: remaining(), skipIds: intake ? [...skipIds, ...intake.pending(ports.store)] : skipIds })) result.frames.push(frame);
    armExpiry();
    try { encodeExchange(result); } catch { return bad("exchange-too-large"); }
    return result;
  };
  const observe = (edge: EdgeRuntime, presence: RemoteSessionInfo[]): void => {
    const peer = edge.config.peer.machineId, now = ports.clock.now(), before = state(edge);
    ports.store.updateEdgeState(peer, edge.config.edgeEpoch, old => ({ ...old, status: "live", outageSince: null, reason: null,
      lastSuccess: now, failures: 0, roster: presence.map(entry => ({ ...entry })) }));
    if (before.status !== "live" || JSON.stringify(before.roster) !== JSON.stringify(presence)) wakeRelays(edge, [...before.roster, ...presence]);
    edge.retryCancel?.(); edge.retryCancel = null;
    for (const waiter of [...edge.admissionWaiters]) waiter.finish(true);
    publish(); armLiveness(edge);
    // An incoming metadata-only recovery push cancels our retry timer. It must
    // also resume retained work; that push's reply cannot carry payload frames.
    if ((before.status === "down" || before.status === "recovering") && ports.store.hasPending(peer)) bridge.wake(peer);
  };
  const apply = (edge: EdgeRuntime, incoming: AuthenticatedIntercomExchange, missingOrigins: readonly IntercomWireMissingOriginFrame[] = []): { acks: IntercomWireAck[]; receiptAcks: IntercomReceiptFrame[]; refusals: IntercomWireRefusal[] } => {
    const peer = edge.config.peer.machineId, acks: IntercomWireAck[] = [], receiptAcks: IntercomReceiptFrame[] = [], refusals: IntercomWireRefusal[] = [];
    if (incoming.presence.some(entry => entry.machineId === ports.machineId || !(ports.authorizePresence?.(peer, entry) ?? entry.machineId === peer))) return bad("invalid-presence");
    ports.store.openHop(peer, edge.config.edgeEpoch);
    const presence = acceptedPresence(edge, incoming.presence);
    for (const ack of incoming.acknowledgements) {
      ports.store.acknowledge({ peer, edgeEpoch: edge.config.edgeEpoch, ...ack }); edge.pollSent.delete(ack.identity.id); edge.reportedRefusals.delete(ack.identity.id);
    }
    for (const refusal of incoming.refusals ?? []) {
      const row = ports.store.retained("outbound", refusal.identity.id);
      if (!row || !sameIdentity(row.identity, refusal.identity) || ports.store.hopPosition("outbound", peer, edge.config.edgeEpoch, refusal.identity) !== refusal.hopSequence) return bad("invalid-refusal");
      if (refusal.reason === "intercom-topology-changing") {
        try { ports.store.recordTopologyRefusal({ peer, identity: refusal.identity }); } catch { return bad("invalid-refusal"); }
        edge.pollSent.delete(refusal.identity.id);
        continue;
      }
      if (row.peer !== peer) return bad("invalid-refusal");
      if (refusal.reason === "link-down") {
        if (refusal.identity.askId !== refusal.identity.id) return bad("invalid-refusal");
        if (!ports.store.openAsks(peer).some(item => item.identity.id === refusal.identity.id)) continue;
      }
      const upstream = ports.store.retained("inbound", refusal.identity.id);
      if (["missing-origin", "peer-revoked", "sender-unauthorized", "store-rejected"].includes(refusal.reason)) {
        if (!row.originMachineId) return bad('missing-origin');
        const frame: IntercomReceiptFrame = { from: row.endpoint, to: row.identity.from, digest: row.identity.digest, attempt: row.latestAttempt,
          originMachineId: row.originMachineId, sequence: row.identity.sequence,
          receipt: { messageId: row.identity.id, status: "cancelled", timestamp: ports.clock.now(), detail: refusal.reason } };
        ports.store.settleReceipt({ queue: "outbound", peer, frame });
        if (upstream && upstream.peer !== peer) { ports.store.settleReceipt({ queue: "inbound", peer: upstream.peer, frame }); bridge.wake(upstream.peer); }
        else ports.onReceipt?.(frame);
        edge.reportedRefusals.add(refusal.identity.id);
        continue;
      }
      if (upstream && upstream.peer !== peer) {
        const previous = edges.get(upstream.peer);
        if (previous) { const hopSequence = ports.store.hopPosition("inbound", upstream.peer, previous.config.edgeEpoch, refusal.identity);
          if (hopSequence !== undefined) previous.refusals.set(String(hopSequence), { ...refusal, hopSequence }); bridge.wake(upstream.peer); }
      } else if (refusal.reason === "link-down") {
        if (!edge.failedAsks.has(refusal.identity.id) && ports.onAskFailed) {
          ports.onAskFailed({ peer, id: refusal.identity.id, from: refusal.identity.from, to: refusal.identity.to, reason: "link-down", outcomeKnown: false });
          edge.failedAsks.add(refusal.identity.id);
        }
      } else if (!edge.reportedRefusals.has(refusal.identity.id)) {
        ports.onRefusal?.({ peer, ...refusal }); edge.reportedRefusals.add(refusal.identity.id);
      }
    }
    for (const ack of incoming.receiptAcknowledgements ?? []) ports.store.acknowledgeReceipt({ peer, frame: ack });
    for (const frame of incoming.receipts) {
      let outbound = ports.store.retained("outbound", frame.receipt.messageId);
      if (outbound && (frame.originMachineId !== outbound.originMachineId || frame.sequence !== outbound.identity.sequence)) return bad('receipt-stream-mismatch');
      let settled: boolean;
      try { settled = ports.store.isSettledReceipt({ peer, frame }); }
      catch (error) { if (error instanceof Error && error.message === 'receipt-stream-mismatch') return bad('receipt-stream-mismatch'); throw error; }
      // A live relay copy may still need the second half of an interrupted settlement.
      // An older activation's receipt is only a replay once the new owner settled it.
      if (settled && (!outbound || !sameEndpoint(outbound.endpoint, frame.from))) { receiptAcks.push(frame); continue; }
      if (!outbound || outbound.peer !== peer) return bad("invalid-receipt");
      if (!sameEndpoint(outbound.endpoint, frame.from) && receiptReleasesPayload(frame.receipt)) {
        ports.store.followConsumption({ queue: "outbound", peer, frame });
        outbound = ports.store.retained("outbound", frame.receipt.messageId)!;
      }
      if (!sameEndpoint(outbound.endpoint, frame.from)) {
        const evidence = outbound.reconciliation?.status === "not_injected" && outbound.reconciliation.evidence?.kind === "absence" ? outbound.reconciliation.evidence : null;
        const next = lookup(frame.from.machineId);
        if (!evidence || evidence.excludedGeneration !== outbound.endpoint.activationEpoch || !next) return bad("invalid-receipt");
        ports.store.followResumedReceipt({ queue: "outbound", peer, frame, proof: { owner: ports.authoritativeHome(outbound.identity.to),
          exclusion: { owner: outbound.endpoint, excludedGeneration: evidence.excludedGeneration, kind: "generation-fenced" }, nextHop: next.config.peer.machineId } });
        outbound = ports.store.retained("outbound", frame.receipt.messageId);
        if (!outbound || outbound.peer !== peer) return bad("invalid-receipt");
      }
      ports.store.settleReceipt({ queue: "outbound", peer, frame });
      if (frame.receipt.status === "not_injected" && ports.store.retained("outbound", frame.receipt.messageId)?.pendingProof) {
        ports.store.resolveUnknown({ queue: "outbound", id: frame.receipt.messageId, digest: frame.digest, proof: frame });
      }
      const relay = ports.store.retained("inbound", frame.receipt.messageId);
      if (relay && relay.peer !== peer) {
        if (!sameEndpoint(relay.endpoint, frame.from)) {
          if (receiptReleasesPayload(frame.receipt)) ports.store.followConsumption({ queue: "inbound", peer: relay.peer, frame });
          else ports.store.rebindInboundAfterAbsence(frame.receipt.messageId, frame.from);
        }
        ports.store.settleReceipt({ queue: "inbound", peer: relay.peer, frame });
        if (frame.receipt.status === "not_injected" && ports.store.retained("inbound", frame.receipt.messageId)?.pendingProof) {
          ports.store.resolveUnknown({ queue: "inbound", id: frame.receipt.messageId, digest: frame.digest, proof: frame });
        }
      }
      edge.controls.delete(frame.receipt.messageId); edge.failedAsks.delete(frame.receipt.messageId);
      receiptAcks.push(frame);
      if (relay && relay.peer !== peer) bridge.wake(relay.peer);
      else ports.onReceipt?.(frame);
    }
    const rejected = new Map(missingOrigins.map(frame => [frame.index, frame]));
    let nextValid = 0;
    for (let index = 0; index < incoming.frames.length + missingOrigins.length; index++) {
      const invalid = rejected.get(index);
      if (invalid) {
        try { ports.store.rejectHop({ peer, edgeEpoch: edge.config.edgeEpoch, sequence: invalid.hopSequence, identity: invalid.identity, reason: "missing-origin" }); }
        catch (error) {
          if (error instanceof Error && (error.message === "hop-sequence-gap" || error.message === "hop-slot-mismatch")) {
            refusals.push({ identity: invalid.identity, hopSequence: invalid.hopSequence, reason: error.message }); continue;
          }
          return bad("invalid-request");
        }
        refusals.push({ identity: invalid.identity, hopSequence: invalid.hopSequence, reason: "missing-origin" });
        acks.push({ identity: invalid.identity, hopSequence: invalid.hopSequence, kind: invalid.kind });
        continue;
      }
      const frame = incoming.frames[nextValid++];
      const hop = { peer, edgeEpoch: edge.config.edgeEpoch, sequence: frame.hopSequence, identity: frame.identity, origin: frame.originMachineId };
      let position: ReturnType<IntercomStore["inspectHop"]>;
      try { position = ports.store.inspectHop(hop); }
      catch (error) {
        if (error instanceof Error && (error.message === "hop-sequence-gap" || error.message === "hop-slot-mismatch")) {
          refusals.push({ identity: frame.identity, hopSequence: frame.hopSequence, reason: error.message }); continue;
        }
        return bad("invalid-request");
      }
      const ack = { identity: frame.identity, hopSequence: frame.hopSequence, kind: frame.kind };
      if (position.kind === "refused") {
        refusals.push({ identity: frame.identity, hopSequence: frame.hopSequence, reason: position.reason });
        if (position.reason !== "intercom-topology-changing") acks.push(ack);
        continue;
      }
      const prior = ports.store.retained("inbound", frame.identity.id);
      if (intake?.closed(frame.identity.to) && frame.kind === "message" && frame.message.expectsReply && !prior && position.kind === "next") {
        refusals.push({ identity: frame.identity, hopSequence: frame.hopSequence, reason: "intercom-frozen" }); continue;
      }
      if (position.kind === "duplicate" && (!prior || prior.originMachineId !== frame.originMachineId || !sameIdentity(prior.identity, frame.identity))) {
        acks.push(ack); continue;
      }
      const originAuthorized = ports.authorizeOrigin?.(peer, frame.originMachineId) ?? frame.originMachineId === peer;
      const reject = (reason: "sender-unauthorized" | "store-rejected" | "peer-revoked") => {
        ports.store.rejectHop({ ...hop, reason });
        refusals.push({ identity: frame.identity, hopSequence: frame.hopSequence, reason }); acks.push(ack);
      };
      const home = ports.authoritativeHome(frame.identity.from), owner = ports.store.presenceOwner(frame.identity.from);
      const replay = prior && prior.originMachineId === frame.originMachineId && sameIdentity(prior.identity, frame.identity);
      if (!originAuthorized ||
          !replay && (home ? home.machineId !== frame.originMachineId : !owner || owner.ambiguous || owner.machineId !== frame.originMachineId)) {
        reject("sender-unauthorized"); continue;
      }
      const remote = frame.endpoint.machineId !== ports.machineId, next = remote ? lookup(frame.endpoint.machineId, peer) : null;
      if (remote && !next) { refusals.push({ identity: frame.identity, hopSequence: frame.hopSequence, reason: "machine-not-enrolled" }); continue; }
      if (next && fenced(next)) { reject("peer-revoked"); continue; }
      const resume = incoming.resumptions?.find(item => sameAddress(item.from, frame.identity.from) && sameAddress(item.to, frame.identity.to));
      try {
      const accepted = ports.store.acceptInbound({ peer, frame, hop: { edgeEpoch: edge.config.edgeEpoch, sequence: frame.hopSequence },
        ...(next ? { forward: { peer: next.config.peer.machineId, edgeEpoch: next.config.edgeEpoch, firstHomePresence: firstHomePresence(frame.endpoint, next) } } : {}),
        ...(resume ? { resume: { cursor: resume, owner: ports.authoritativeHome(frame.identity.to) } } : {}) });
      if (accepted.kind === "refused") { refusals.push({ identity: frame.identity, hopSequence: frame.hopSequence, reason: accepted.reason }); continue; }
      const retained = ports.store.retained("inbound", frame.identity.id);
      if (!retained) { acks.push(ack); continue; }
      if (next) {
        bridge.wake(next.config.peer.machineId);
      } else {
        if (frame.kind === "tombstone" && frame.reason === "cancelled" && !incoming.controls.some(item => item.control.messageId === frame.identity.id &&
            sameAddress(item.from, frame.identity.from) && sameAddress(item.to, frame.identity.to))) {
          ports.onControl?.({ from: frame.identity.from, to: frame.identity.to, control: { messageId: frame.identity.id, action: "cancel", timestamp: ports.clock.now() } });
        }
        notifyInbound({ id: frame.identity.id, to: frame.identity.to });
      }
      acks.push(ack);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("hop-")) return bad(error.message);
        reject("store-rejected");
      }
    }
    for (const control of incoming.controls) {
      const row = ports.store.retained("inbound", control.control.messageId);
      if (!row || row.peer !== peer || !sameAddress(row.identity.from, control.from) || !sameAddress(row.identity.to, control.to)) continue;
      ports.store.cancel({ queue: "inbound", id: control.control.messageId, from: control.from, to: control.to });
      if (row.endpoint.machineId === ports.machineId) ports.onControl?.(control);
      else {
        const outbound = ports.store.retained("outbound", control.control.messageId);
        if (outbound && outbound.peer !== peer) {
          ports.store.cancel({ queue: "outbound", id: control.control.messageId, from: control.from, to: control.to });
          const next = edges.get(outbound.peer);
          if (next) { next.controls.set(control.control.messageId, control); bridge.wake(outbound.peer); }
        }
      }
    }
    ports.onTopology?.(peer, incoming.topology);
    observe(edge, presence); armExpiry();
    return { acks, receiptAcks, refusals };
  };
  const wait = (active: Inflight, ms: number, signal?: AbortSignal): Promise<void> => new Promise(resolve => {
    let cancel = () => {}, done = false;
    const finish = () => { if (done) return; done = true; cancel(); active.wake = null; active.abort.signal.removeEventListener("abort", finish); signal?.removeEventListener("abort", finish); resolve(); };
    active.wake = finish; active.abort.signal.addEventListener("abort", finish, { once: true }); signal?.addEventListener("abort", finish, { once: true });
    if (active.abort.signal.aborted || signal?.aborted) finish(); else cancel = ports.clock.later(ms, finish);
  });

  const reportExpiries = (): void => {
    if (!ports.onExpiry && !ports.onAskFailed) { expiryNoticeRetry = false; return; }
    let retry = false;
    for (const edge of edges.values()) {
      const peer = edge.config.peer.machineId;
      for (const { identity, outcomeKnown } of ports.store.expiredOutbounds(peer)) {
        try {
          if (!edge.config.initiator && !routeLive(edge) && identity.askId === identity.id && ports.onAskFailed) {
            ports.onAskFailed({ peer, id: identity.id, from: identity.from, to: identity.to, reason: "link-down", outcomeKnown: false });
          } else ports.onExpiry?.({ peer, id: identity.id, from: identity.from, to: identity.to, outcomeKnown });
          ports.store.markNoticeReported(identity.id, "expiry");
        } catch { retry = true; }
      }
    }
    expiryNoticeRetry = retry;
  };
  const drainLocalReceipts = (): void => {
    localReceiptRetry = false;
    for (;;) {
      const receipts = ports.store.pending({ kind: "receipts", peer: ports.machineId });
      if (!receipts.length) break;
      for (const frame of receipts) {
        try {
          ports.store.settleReceipt({ queue: "outbound", peer: ports.machineId, frame });
          const outbound = ports.store.retained("outbound", frame.receipt.messageId);
          if (frame.receipt.status === "not_injected" && outbound?.pendingProof) ports.store.resolveUnknown({ queue: "outbound", id: outbound.identity.id, digest: outbound.identity.digest, proof: frame });
          ports.onReceipt?.(frame);
          ports.store.acknowledgeReceipt({ peer: ports.machineId, frame });
        } catch { localReceiptRetry = true; }
      }
      if (localReceiptRetry) break;
    }
  };
  const drainRevocationNotices = (): void => {
    revocationNoticeRetry = false;
    const pending = ports.store.pendingRevocationNotices();
    if (!ports.onRevocationNotice) { revocationNoticeRetry = pending.length > 0; return; }
    for (const frame of pending) {
      const id = frame.receipt.messageId;
      if (noticeInFlight.has(id)) continue;
      noticeInFlight.add(id);
      void Promise.resolve().then(() => ports.onRevocationNotice!(frame)).then(confirmed => {
        if (stopped) return;
        if (confirmed === true) ports.store.acknowledgeRevocationNotice(frame);
        else revocationNoticeRetry = true;
      }).catch(() => { if (!stopped) revocationNoticeRetry = true; }).finally(() => {
        noticeInFlight.delete(id); if (!stopped) armExpiry();
      });
    }
  };
  const sweep = (): void => {
    const expired = ports.store.expire();
    ports.maintain?.();
    for (const edge of edges.values()) {
      for (const id of edge.reportedRefusals) if (!ports.store.retained("outbound", id)) edge.reportedRefusals.delete(id);
      const open = new Set(ports.store.openAsks(edge.config.peer.machineId).map(row => row.identity.id));
      for (const id of edge.failedAsks) if (!open.has(id)) edge.failedAsks.delete(id);
    }
    reportExpiries();
    for (const item of expired) if (item.queue === "inbound") {
      const row = ports.store.retained("inbound", item.id);
      if (row && row.peer !== ports.machineId) bridge.wake(row.peer);
    }
    drainLocalReceipts(); drainRevocationNotices();
    armExpiry();
  };
  const armExpiry = (): void => {
    if (stopped) return;
    const next = ports.store.nextExpiry(), retry = expiryNoticeRetry || localReceiptRetry || revocationNoticeRetry ? ports.clock.now() + 30_000 : null;
    const deadline = next === null ? retry : retry === null ? next : Math.min(next, retry);
    if (deadline === expiryDeadline && expiryCancel) return;
    expiryCancel?.(); expiryCancel = null; expiryDeadline = deadline;
    if (deadline !== null) expiryCancel = ports.clock.later(Math.max(0, deadline - ports.clock.now()), () => {
      expiryCancel = null; expiryDeadline = null;
      if (!stopped) sweep();
    });
  };
  const ackKey = (ack: IntercomLinkAck): string => JSON.stringify([ack.hopSequence, ack.kind]);
  const refusalKey = (refusal: IntercomRefusal): string => String(refusal.hopSequence);
  const receiptKey = (receipt: IntercomReceiptFrame): string => JSON.stringify(receipt);
  const failureCode = (error: unknown): string => {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : null;
    return typeof code === "string" && /^[a-z0-9_-]{1,64}$/.test(code) ? code : "exchange-failed";
  };
  const failAsks = (edge: EdgeRuntime): void => {
    const peer = edge.config.peer.machineId;
    const open = ports.store.openAsks(peer), ids = new Set(open.map(row => row.identity.id));
    for (const id of edge.failedAsks) if (!ids.has(id)) edge.failedAsks.delete(id);
    for (const row of open) {
      const upstream = ports.store.retained("inbound", row.identity.id);
      if (upstream && upstream.peer !== peer) {
        const previous = edges.get(upstream.peer);
        if (previous) { const hopSequence = ports.store.hopPosition("inbound", upstream.peer, previous.config.edgeEpoch, row.identity);
          if (hopSequence !== undefined) previous.refusals.set(String(hopSequence), { identity: row.identity, reason: "link-down", hopSequence }); bridge.wake(upstream.peer); }
      } else if (!edge.failedAsks.has(row.identity.id) && ports.onAskFailed) {
        ports.onAskFailed({ peer, id: row.identity.id, from: row.identity.from, to: row.identity.to, reason: "link-down", outcomeKnown: false });
        edge.failedAsks.add(row.identity.id);
      }
    }
  };
  const retryDelay = (failures: number): number => [2000, 4000, 8000, 15_000, 30_000][Math.min(4, Math.max(0, failures - 2))];
  const scheduleRecovery = (edge: EdgeRuntime, delay: number): void => {
    if (stopped || fenced(edge) || !edge.config.initiator || edge.retryCancel) return;
    edge.retryCancel = ports.clock.later(delay, () => {
      edge.retryCancel = null;
      if (stopped || fenced(edge)) return;
      const deadlines = [...edge.admissionWaiters].map(waiter => waiter.deadline - ports.clock.now()).filter(value => value > 0);
      const limit = deadlines.length ? Math.min(10_000, ...deadlines) : undefined;
      const existing = edge.outgoing.get("push");
      if (existing) { existing.abort.abort(); void existing.promise.finally(() => { if (!stopped) void transfer(edge, "push", true, limit); }); }
      else void transfer(edge, "push", true, limit);
    });
  };
  const markFailure = (edge: EdgeRuntime, error: unknown, probe: boolean): void => {
    if (stopped || fenced(edge)) return;
    const peer = edge.config.peer.machineId, before = state(edge), reason = failureCode(error);
    const immediate = !new ExchangeError(reason).retryable;
    const down = immediate || before.status === "down" || probe && before.status === "recovering";
    const updated = ports.store.updateEdgeState(peer, edge.config.edgeEpoch, old => ({ ...old, status: down ? "down" : "recovering",
      outageSince: old.outageSince ?? ports.clock.now(), reason,
      failures: old.outageSince === null ? 1 : probe ? old.failures + 1 : old.failures }));
    edge.livenessCancel?.(); edge.livenessCancel = null; publish();
    if (before.status !== updated.status) wakeRelays(edge);
    if (down) {
      try { failAsks(edge); } catch { /* Leave unsent failures open for recovery on restart. */ }
      if (before.status !== "down") {
        for (const waiter of [...edge.admissionWaiters]) waiter.finish(false);
        ports.onLinkDown?.(peer, updated.reason ?? reason);
      }
    }
    if (immediate) {
      edge.retryCancel?.(); edge.retryCancel = null;
      for (const active of edge.outgoing.values()) active.abort.abort();
      for (const active of edge.incoming.values()) { active.preempted = true; active.abort.abort(); }
    } else scheduleRecovery(edge, down ? retryDelay(updated.failures) : 1000);
  };
  const schedulePoll = (edge: EdgeRuntime): void => {
    if (stopped || fenced(edge) || !edge.config.initiator || edge.outgoing.has("poll") || edge.pollCancel || state(edge).status === "down" || state(edge).status === "recovering") return;
    edge.pollCancel = ports.clock.later(0, () => { edge.pollCancel = null; if (!stopped) void transfer(edge, "poll", false); });
  };
  const schedulePush = (edge: EdgeRuntime, delay: number): void => {
    if (stopped || fenced(edge) || edge.pushCancel) return;
    edge.pushCancel = ports.clock.later(delay, () => { edge.pushCancel = null; bridge.wake(edge.config.peer.machineId); });
  };
  const transfer = (edge: EdgeRuntime, channel: "poll" | "push", probe: boolean, maximumMs?: number): Promise<boolean> => {
    if (fenced(edge) || !edge.config.initiator) return Promise.resolve(false);
    const existing = edge.outgoing.get(channel);
    if (existing) return existing.promise;
    const peer = edge.config.peer.machineId;
    const updated = ports.store.updateEdgeState(peer, edge.config.edgeEpoch, old => {
      if (old.outbound[channel] === Number.MAX_SAFE_INTEGER) return bad("invalid-generation");
      return { ...old, outbound: { ...old.outbound, [channel]: old.outbound[channel] + 1 } };
    });
    const generation = { edgeEpoch: edge.config.edgeEpoch, channel, generation: updated.outbound[channel] } as const;
    const total = Math.min(maximumMs ?? Infinity, probe ? 10_000 : channel === "poll" ? 45_000 : 20_000);
    const begun = ports.clock.now(), active: Outflight = { generation: generation.generation, abort: new AbortController(), promise: Promise.resolve(false), connectedUntil: 0 };
    edge.outgoing.set(channel, active);
    if (channel === "push") edge.pushDirty = false;
    active.promise = (async () => {
      let succeeded = false, input: IntercomExchange | null = null;
      try {
        const remaining = () => { const now = ports.clock.now(); if (now < begun || now - begun >= total) return bad("cli-timeout"); return Math.floor(total - (now - begun)); };
        sweep();
        if (!edge.resolved) edge.resolved = await ports.transport.resolve(edge.config.peer, { timeoutMs: remaining(), signal: active.abort.signal });
        if (stopped || active.abort.signal.aborted) return false;
        const now = ports.clock.now(), handshaking = !edge.versionReady;
        for (const [id, handoff] of edge.pollSent) if (now < handoff.at || now >= handoff.until) edge.pollSent.delete(id);
        input = build(edge, generation, [...edge.acknowledgements.values()], [...edge.receiptAcknowledgements.values()], total, handshaking || probe || channel === "poll",
          [...edge.pollSent.keys()], [...edge.refusals.values()]);
        reportExpiries(); armExpiry();
        if (channel === "push") for (const frame of input.frames) edge.pushIds.add(frame.identity.id);
        const response = await executeExchange(edge.resolved, { exchange: input, holdMs: channel === "poll" && !probe ? 25_000 : 0 }, {
          machineId: ports.machineId, enrollment: edge.config, transport: ports.transport, store: ports.store, clock: ports.clock, probe, maxTotalMs: remaining(), signal: active.abort.signal,
          onConnected: connected => { active.connectedUntil = connected && channel === "poll" && !probe ? begun + total : 0; publish(); armLiveness(edge); },
        });
        if (stopped || active.abort.signal.aborted || edge.outgoing.get(channel) !== active || state(edge).outbound[channel] !== generation.generation) return false;
        edge.versionReady = true;
        const applied = apply(edge, response.exchange, response.missingOrigins);
        if (handshaking && ports.store.hasPending(peer)) edge.pushDirty = true;
        for (const ack of input.acknowledgements) edge.acknowledgements.delete(ackKey(ack));
        for (const ack of input.receiptAcknowledgements ?? []) edge.receiptAcknowledgements.delete(receiptKey(ack));
        for (const refusal of input.refusals ?? []) edge.refusals.delete(refusalKey(refusal));
        for (const ack of applied.acks) edge.acknowledgements.set(ackKey(ack), ack);
        for (const ack of applied.receiptAcks) edge.receiptAcknowledgements.set(receiptKey(ack), ack);
        for (const refusal of applied.refusals) edge.refusals.set(refusalKey(refusal), refusal);
        if (applied.acks.length || applied.receiptAcks.length || applied.refusals.length) edge.pushDirty = true;
        succeeded = true;
        return true;
      } catch (error) {
        edge.resolved = null; edge.versionReady = false;
        if (!active.abort.signal.aborted && !stopped) markFailure(edge, error, probe);
        return false;
      } finally {
        if (channel === "push" && input) for (const frame of input.frames) edge.pushIds.delete(frame.identity.id);
        if (edge.outgoing.get(channel) === active) edge.outgoing.delete(channel);
        if (!stopped && channel === "poll") { publish(); armLiveness(edge); }
        if (!stopped && succeeded) {
          schedulePoll(edge);
          if (edge.pushDirty || probe && ports.store.hasPending(peer)) bridge.wake(peer);
          else if (channel === "push" && input && (input.frames.length || input.receipts.length) && ports.store.hasPending(peer)) schedulePush(edge, 1000);
        }
      }
    })();
    return active.promise;
  };

  const waitUntil = (pending: Promise<boolean>, ms: number): Promise<boolean> => new Promise(resolve => {
    let done = false;
    const finish = (value: boolean) => { if (done) return; done = true; cancel(); resolve(value); };
    const cancel = ports.clock.later(Math.max(0, ms), () => finish(false));
    void pending.then(finish, () => finish(false));
  });
  const awaitRecovery = (edge: EdgeRuntime, deadline: number): Promise<boolean> => new Promise(resolve => {
    let done = false;
    const waiter = { deadline, finish: (value: boolean) => { if (done) return; done = true; cancel(); edge.admissionWaiters.delete(waiter); resolve(value); } };
    const cancel = ports.clock.later(Math.max(0, deadline - ports.clock.now()), () => waiter.finish(false));
    edge.admissionWaiters.add(waiter);
  });
  const admitUnknown = async (edge: EdgeRuntime, originalMs: number): Promise<boolean> => {
    const deadline = ports.clock.now() + Math.min(originalMs, 21_000);
    if (deadline - ports.clock.now() < 3000) return false;
    const existing = edge.outgoing.get("push");
    const initial = existing ? await waitUntil(existing.promise, Math.min(10_000, deadline - ports.clock.now()))
      : await transfer(edge, "push", true, Math.min(10_000, deadline - ports.clock.now()));
    if (initial || routeLive(edge)) return true;
    if (stopped || state(edge).status === "down" || deadline - ports.clock.now() <= 1000) return false;
    return awaitRecovery(edge, deadline);
  };

  const onLocalPresence = (sessions: LocalPresence[]): void => {
    const next = sessions.filter(session => ports.authorizeLocalPresence?.(session) ?? true).map(session => {
      const info: RemoteSessionInfo = { remote: true, id: session.address.sessionId, address: session.address, machineId: ports.machineId,
        machineAlias: ports.machineAlias, homeEpoch: session.homeEpoch, activationEpoch: session.activationEpoch, endpointEpoch: session.activationEpoch,
        cwd: session.cwd, model: session.model, startedAt: session.startedAt, lastActivity: session.lastActivity,
        ...(session.name === undefined ? {} : { name: session.name }), ...(session.status === undefined ? {} : { status: session.status }) };
      const attestation = ports.firstHomeAttestation?.({ address: info.address, machineId: info.machineId, homeEpoch: info.homeEpoch, activationEpoch: info.activationEpoch });
      return attestation ? { ...info, firstHome: attestation } : info;
    });
    if (JSON.stringify(next) === JSON.stringify(brokerLocal)) return;
    brokerLocal = next;
    revalidatePresence(); publish();
    for (const edge of edges.values()) bridge.wake(edge.config.peer.machineId);
  };
  const connectBroker = async (): Promise<void> => {
    const broker = ports.broker!;
    await ports.ensureBroker?.();
    if (stopped) return bad("bridge-stopped");
    await broker.connect({ feature: FEDERATION_FEATURE, agentDir: ports.agentDir!, machineId: ports.machineId, machineAlias: ports.machineAlias, credential: await routeLease!.authorizeBridge(ports.machineId), ...(intake ? { moveFences: true as const } : {}) }, bridge);
    if (stopped) return bad("bridge-stopped");
    const token = randomBytes(32).toString("hex");
    await broker.enableHelpers(token, async (input, signal) => {
      if (input && typeof input === "object" && !Array.isArray(input) && (input as { action?: unknown }).action === "inspect-fence") {
        let request;
        try { request = parseHelperFence(input); } catch { return bad("invalid-request"); }
        if (request.machineId !== ports.machineId || signal.aborted) return bad("invalid-request");
        const fence = ports.store.pairFence(request.peer);
        return { machineId: ports.machineId, peer: request.peer, fence: fence ? { edgeEpoch: fence.edgeEpoch, fenceId: fence.fenceId } : null };
      }
      if (input && typeof input === "object" && !Array.isArray(input) && (input as { action?: unknown }).action === "inspect-pair") {
        let request;
        try { request = parseHelperInspect(input); } catch { return bad("invalid-request"); }
        if (request.machineId !== ports.machineId || signal.aborted) return bad("invalid-request");
        const edge = edges.get(request.peer);
        if (!edge || edge.config.edgeEpoch !== request.edgeEpoch) return bad("machine-not-enrolled");
        const fence = ports.store.pairFence(request.peer), current = state(edge);
        return { machineId: ports.machineId, peer: request.peer, edgeEpoch: request.edgeEpoch,
          status: fence ? "down" : current.status, reason: fence ? "peer-revoked" : current.reason };
      }
      if (input && typeof input === "object" && !Array.isArray(input) && (input as { action?: unknown }).action === "transition-topology") {
        let request;
        try { request = parseHelperTopology(input); } catch { return bad("invalid-request"); }
        if (request.machineId !== ports.machineId || !ports.onTopologyRequest) return bad("invalid-request");
        if (signal.aborted) return bad("cli-aborted");
        try { return await ports.onTopologyRequest(request); }
        catch (error) { return bad(error instanceof Error && isHelperExchangeError(error.message) ? error.message : "bridge-exchange-failed"); }
      }
      if (input && typeof input === "object" && !Array.isArray(input) && (input as { action?: unknown }).action === "enroll-pair") {
        let request;
        try { request = parseHelperEnroll(input); } catch { return bad("invalid-request"); }
        if (request.machineId !== ports.machineId || !ports.onEnrollRequest) return bad("invalid-request");
        if (signal.aborted) return bad("cli-aborted");
        return ports.onEnrollRequest(request);
      }
      if (input && typeof input === "object" && !Array.isArray(input) && (input as { action?: unknown }).action === "revoke-pair") {
        let request;
        try { request = parseHelperRevoke(input); } catch { return bad("invalid-request"); }
        if (request.machineId !== ports.machineId) return bad("machine-mismatch");
        if (signal.aborted) return bad("cli-aborted");
        const proof = await bridge.revokePair(request.peer, request.edgeEpoch, request.fenceId);
        await ports.onRevokeRequest?.({ peer: request.peer, edgeEpoch: proof.edgeEpoch, fenceId: proof.fenceId });
        return { machineId: ports.machineId, ...proof };
      }
      return bridge.exchange(input, signal);
    });
    if (stopped) return bad("bridge-stopped");
    await routeLease!.publish(token);
    if (stopped) return bad("bridge-stopped");
    brokerReady = true; brokerRetries = 0; ports.onBrokerState?.(true);
  };
  const scheduleBrokerReconnect = (): void => {
    if (stopped || !started || brokerRetryCancel) return;
    const delay = [2000, 4000, 8000, 15_000, 30_000][Math.min(brokerRetries++, 4)];
    brokerRetryCancel = ports.clock.later(delay, () => {
      brokerRetryCancel = null;
      if (stopped || !started) return;
      const task = (async () => {
        try {
          await connectBroker(); publish();
          for (const edge of edges.values()) if (edge.config.initiator && state(edge).status === "down") failAsks(edge);
        } catch {
          brokerReady = false; await ports.broker?.close();
          if (!stopped) scheduleBrokerReconnect();
        }
      })();
      brokerConnectTask = task;
      void task.finally(() => { if (brokerConnectTask === task) brokerConnectTask = null; });
    });
  };
  const onBrokerDisconnected = (): void => {
    const wasReady = brokerReady; brokerReady = false;
    if (wasReady) ports.onBrokerState?.(false);
    brokerLocal = [];
    scheduleBrokerReconnect();
  };

  const cancelWork = (): Promise<unknown>[] => {
    const pending: Promise<unknown>[] = [];
    expiryCancel?.(); expiryCancel = null; expiryDeadline = null;
    for (const edge of edges.values()) {
      edge.retryCancel?.(); edge.pollCancel?.(); edge.livenessCancel?.(); edge.pushCancel?.();
      edge.retryCancel = edge.pollCancel = edge.livenessCancel = edge.pushCancel = null;
      for (const active of edge.incomingAll) { active.abort.abort(); pending.push(active.done); }
      for (const waiter of [...edge.admissionWaiters]) waiter.finish(false);
      for (const active of edge.outgoing.values()) { active.abort.abort(); pending.push(active.promise); }
    }
    return pending;
  };
  const bridge: IntercomBridge = {
    start() {
      if (stopped) return Promise.reject(new ExchangeError("bridge-stopped"));
      if (startTask) return startTask;
      startTask = (async () => {
        started = true;
        try {
          revalidatePresence();
          if (ports.broker) {
            routeLease = ports.routeLease ?? await acquireHelperRoute(ports.globalRoot!, ports.agentDir!, lifetime.signal);
            if (stopped) return bad("bridge-stopped");
            ports.broker.on("presence", onLocalPresence);
            ports.broker.on("disconnected", onBrokerDisconnected);
            await connectBroker();
          }
          if (stopped) return bad("bridge-stopped");
          sweep(); publish();
          for (const edge of edges.values()) {
            if (fenced(edge)) continue;
            const current = state(edge); armLiveness(edge);
            if (current.status === "down" || current.status === "recovering") {
              if (edge.config.initiator && current.status === "down") { try { failAsks(edge); } catch { /* Keep open for the next recovery. */ } }
              if (!current.reason || new ExchangeError(current.reason).retryable) {
                scheduleRecovery(edge, current.status === "recovering" ? 1000 : retryDelay(current.failures));
              }
            } else {
              if (edge.config.initiator) void transfer(edge, "poll", false);
              if (ports.store.hasPending(edge.config.peer.machineId)) bridge.wake(edge.config.peer.machineId);
            }
          }
        } catch (error) {
          started = false; brokerReady = false;
          brokerRetryCancel?.(); brokerRetryCancel = null;
          const pending = cancelWork();
          ports.broker?.off("presence", onLocalPresence); ports.broker?.off("disconnected", onBrokerDisconnected);
          await ports.broker?.close(); await Promise.allSettled(pending); await routeLease?.close(); routeLease = null;
          throw error;
        }
      })().catch(error => { if (!stopped) startTask = null; throw error; });
      return startTask;
    },
    stop() {
      if (stopTask) return stopTask;
      stopped = true; lifetime.abort();
      stopTask = (async () => {
        const pending = cancelWork();
        brokerRetryCancel?.(); brokerRetryCancel = null;
        brokerReady = false; ports.broker?.off("presence", onLocalPresence); ports.broker?.off("disconnected", onBrokerDisconnected);
        await ports.broker?.close();
        if (startTask) await startTask.catch(() => {});
        await Promise.allSettled(pending);
        if (brokerConnectTask) await brokerConnectTask;
        await routeLease?.close(); routeLease = null;
      })();
      return stopTask;
    },
    revokePair(peer, edgeEpoch, fenceId) {
      const existing = revocations.get(peer); if (existing && ports.store.pairFence(peer)) return existing;
      if (existing) revocations.delete(peer);
      const edge = edges.get(peer);
      // This synchronous transaction commits the fence and the failure notices before any cleanup.
      const { fence, upstream } = ports.store.fencePair(peer, edgeEpoch, fenceId);
      if (!edge) {
        publish(); for (const previous of upstream) if (previous !== peer) bridge.wake(previous);
        drainRevocationNotices(); armExpiry();
        const closed = Promise.resolve({ peer, edgeEpoch: fence.edgeEpoch, fenceId: fence.fenceId, exchanges: "closed" as const, inFlight: 0 as const });
        revocations.set(peer, closed); return closed;
      }
      edge.retryCancel?.(); edge.pollCancel?.(); edge.livenessCancel?.(); edge.pushCancel?.();
      edge.retryCancel = edge.pollCancel = edge.livenessCancel = edge.pushCancel = null;
      const pending: Promise<unknown>[] = [];
      for (const active of edge.incomingAll) { active.abort.abort(); pending.push(active.done); }
      for (const active of edge.outgoing.values()) { active.abort.abort(); pending.push(active.promise); }
      for (const waiter of [...edge.admissionWaiters]) waiter.finish(false);
      publish(); wakeRelays(edge);
      for (const previous of upstream) if (previous !== peer) bridge.wake(previous);
      drainRevocationNotices(); armExpiry();
      const task = (async () => {
        await Promise.allSettled(pending);
        if (edge.incomingAll.size || edge.outgoing.size) throw new Error("intercom-edge-still-active");
        return { peer, edgeEpoch: fence.edgeEpoch, fenceId: fence.fenceId, exchanges: "closed" as const, inFlight: 0 as const };
      })();
      revocations.set(peer, task);
      return task;
    },
    async enrollPair(config, approval) {
      if (stopped || !validEdge(config) || approval.edgeEpoch !== config.edgeEpoch) throw new Error("Invalid intercom enrollment");
      const peer = config.peer.machineId, closing = revocations.get(peer); if (closing) await closing;
      const existing = edges.get(peer), fence = ports.store.pairFence(peer);
      if (existing && !fence) {
        const previous = existing.config.peer, next = config.peer;
        if (existing.config.edgeEpoch !== config.edgeEpoch || existing.config.initiator !== config.initiator ||
            previous.machineId !== next.machineId || previous.alias !== next.alias || previous.node !== next.node || previous.pi !== next.pi ||
            previous.cli !== next.cli || previous.core !== next.core || previous.globalRoot !== next.globalRoot) throw new Error("intercom-edge-must-be-revoked");
        const changed = ports.store.approvePair(peer, approval), current = state(existing);
        if (changed && current.reason && new ExchangeError(current.reason).retryable) {
          existing.retryCancel?.(); existing.retryCancel = null;
          existing.resolved = null; existing.versionReady = false;
          ports.store.updateEdgeState(peer, config.edgeEpoch, old => ({ ...old, status: "unknown", failures: 0, lastSuccess: null }));
          if (started && config.initiator) void transfer(existing, "push", true);
        }
        return;
      }
      if (existing && (existing.incomingAll.size || existing.outgoing.size)) throw new Error("intercom-edge-still-active");
      ports.store.approvePair(peer, approval);
      revocations.delete(peer);
      if (!existing || fence) edges.set(peer, makeEdge(config));
      const current = edges.get(peer)!;
      publish();
      if (started && current.config.initiator) void transfer(current, "poll", false);
      if (started && ports.store.hasPending(peer)) bridge.wake(peer);
    },
    async exchange(raw, signal) {
      if (!started || stopped) return bad("bridge-unavailable");
      let input;
      try { if (bytes(raw) > INTERCOM_EXCHANGE_BYTES - 1024) return bad("exchange-too-large"); input = parseHelperRequest(raw); }
      catch (error) { if (error instanceof ExchangeError) throw error; return bad(error instanceof Error && (error.message === "peer-version-mismatch" || error.message === "invalid-presence" || error.message === 'receipt-stream-missing' || error.message === "hop-stream-missing") ? error.message : "invalid-request"); }
      const incoming = input.exchange, edge = edges.get(incoming.senderMachine);
      if (!edge || incoming.recipientMachine !== ports.machineId) return bad("machine-not-enrolled");
      if (fenced(edge)) return bad("peer-revoked");
      if (incoming.generation.edgeEpoch !== edge.config.edgeEpoch) return bad("machine-not-enrolled");
      // A valid request advertises the current version before this side sends message frames.
      edge.versionReady = true;
      const fatal = fatalReason(edge); if (fatal) return bad(fatal);
      const channel = incoming.generation.channel, number = incoming.generation.generation;
      if (signal?.aborted) return bad("cli-aborted");
      ports.store.updateEdgeState(edge.config.peer.machineId, edge.config.edgeEpoch, old => {
        if (number <= old.inbound[channel]) return bad("stale-generation");
        return { ...old, inbound: { ...old.inbound, [channel]: number } };
      });
      const previous = edge.incoming.get(channel);
      if (previous) { previous.preempted = true; previous.abort.abort(); }
      let finish!: () => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      const active: Inflight = { generation: number, abort: new AbortController(), wake: null, preempted: false, done, finish };
      edge.incoming.set(channel, active); edge.incomingAll.add(active);
      try {
        sweep();
        const applied = apply(edge, incoming, input.missingOrigins);
        const hopBudgetMs = channel === "poll" ? 45_000 : 20_000;
        const makeReply = () => build(edge, incoming.generation,
          [...new Map([...edge.acknowledgements.values(), ...applied.acks].map(ack => [ackKey(ack), ack])).values()],
          [...new Map([...edge.receiptAcknowledgements.values(), ...applied.receiptAcks].map(ack => [receiptKey(ack), ack])).values()],
          hopBudgetMs, channel === "push", [...edge.pushIds],
          [...new Map([...edge.refusals.values(), ...applied.refusals].map(refusal => [refusalKey(refusal), refusal])).values()]);
        let output = makeReply();
        if (input.holdMs > 0 && !hasData(output)) {
          await wait(active, input.holdMs, signal);
          if (fenced(edge)) return bad("peer-revoked");
          if (active.preempted || edge.incoming.get(channel) !== active) {
            const fatal = fatalReason(edge); if (fatal) return bad(fatal);
            return { version: 1, exchange: blank(incoming.senderMachine, incoming.generation) };
          }
          if (signal?.aborted || stopped) return bad("cli-aborted");
          output = makeReply();
        }
        reportExpiries(); armExpiry();
        for (const ack of output.acknowledgements) edge.acknowledgements.delete(ackKey(ack));
        for (const ack of output.receiptAcknowledgements ?? []) edge.receiptAcknowledgements.delete(receiptKey(ack));
        for (const refusal of output.refusals ?? []) edge.refusals.delete(refusalKey(refusal));
        if (channel === "poll") {
          const at = ports.clock.now();
          for (const frame of output.frames) edge.pollSent.set(frame.identity.id, { at, until: at + 45_000 });
        }
        return { version: 1, exchange: output };
      } finally { if (edge.incoming.get(channel) === active) edge.incoming.delete(channel); edge.incomingAll.delete(active); active.finish(); }
    },
    wake(peer) {
      const edge = edges.get(peer); if (!edge || stopped || fenced(edge)) return;
      if (started) armExpiry();
      const waiting = !!edge.incoming.get("poll")?.wake;
      for (const active of edge.incoming.values()) active.wake?.();
      edge.pushDirty = true;
      if (!started || waiting && !edge.config.initiator || edge.outgoing.has("push")) return;
      const status = state(edge).status;
      if (status !== "down" && status !== "recovering") void transfer(edge, "push", false);
    },
    ...(intake ? { intake: (action: IntercomIntakeAction, fence: IntercomIntakeFence) => intake.apply(action, fence) } : {}),
    async dispatch(input: FederationDispatch): Promise<FederationDispatchResult> {
      const ticket = intake?.begin(input);
      if (intake && !ticket) return failed("intercom-frozen");
      try {
      if (!started || stopped) return failed("bridge-unavailable");
      const local = input.to.machineId === ports.machineId;
      const edge = lookup(input.to.machineId);
      if (!local && !edge) return failed("machine-not-enrolled");
      if (edge && fenced(edge)) return failed("peer-revoked");
      const currentHome = () => {
        const home = ports.authoritativeHome(input.to.address);
        return !home || home.sessionId === input.to.address.sessionId && home.machineId === input.to.machineId && home.epoch === input.to.homeEpoch;
      };
      if (!currentHome()) return failed("stale-home-epoch");
      const owner = ports.store.presenceOwner(input.to.address);
      if (!ports.authoritativeHome(input.to.address) && owner && (owner.ambiguous || owner.machineId !== input.to.machineId)) return failed("presence-ambiguous");
      if (local) {
        const endpoint = { address: input.to.address, machineId: ports.machineId, homeEpoch: input.to.homeEpoch, activationEpoch: input.to.activationEpoch };
        const accepted = ports.store.acceptLocal({ from: input.from, endpoint, message: input.message, firstHomePresence: firstHomePresence(endpoint, null) });
        if (accepted.kind === "refused") return failed(accepted.reason);
        notifyInbound({ id: accepted.identity.id, to: accepted.identity.to });
        armExpiry();
        return { delivery: "queued", retryable: false, outcomeKnown: true, acceptance: accepted.acceptance,
          ...(accepted.receipt && receiptReleasesPayload(accepted.receipt) ? { consumption: accepted.receipt } : {}) };
      }
      if (!edge) return failed("machine-not-enrolled");
      let message = input.message;
      if (message.expectsReply) {
        if (input.to.reachability === "down" || input.to.reachability === "recovering" ||
            edge.config.peer.machineId !== input.to.machineId && input.to.stale) return failed("link-down");
        const status = state(edge).status;
        if (status === "down" || status === "recovering") return failed("link-down");
        if (!Number.isSafeInteger(message.remainingMs) || Number(message.remainingMs) <= 0) return failed("ask-expired");
        const begun = ports.clock.now(), original = Number(message.remainingMs);
        if (!routeLive(edge) && !await admitUnknown(edge, original)) return failed(fenced(edge) ? "peer-revoked" : "link-down");
        const now = ports.clock.now();
        if (now < begun || now - begun >= original) return failed("ask-expired");
        message = { ...message, remainingMs: original - (now - begun) };
      }
      if (!started || stopped) return failed("bridge-unavailable");
      if (fenced(edge)) return failed("peer-revoked");
      if (!currentHome()) return failed("stale-home-epoch");
      const endpoint = { address: input.to.address, machineId: input.to.machineId, homeEpoch: input.to.homeEpoch, activationEpoch: input.to.activationEpoch };
      const accepted = ports.store.acceptOutbound({ from: input.from, endpoint, message, nextHop: edge.config.peer.machineId, edgeEpoch: edge.config.edgeEpoch, firstHomePresence: firstHomePresence(endpoint, edge) });
      if (accepted.kind === "refused") return failed(accepted.reason);
      armExpiry(); bridge.wake(edge.config.peer.machineId);
      return { delivery: "queued", retryable: false, outcomeKnown: true, acceptance: accepted.acceptance,
          ...(accepted.receipt && receiptReleasesPayload(accepted.receipt) ? { consumption: accepted.receipt } : {}) };
      } finally { ticket?.finish(); }
    },
    receipt(from: SessionAddress, receipt: MessageReceipt) {
      if (!started || stopped) return bad("bridge-unavailable");
      const row = ports.store.retained("inbound", receipt.messageId);
      if (!row || !sameAddress(row.endpoint.address, from) || !Number.isSafeInteger(receipt.timestamp) || receipt.timestamp < 0) return;
      if (receipt.evidence && (receipt.evidence.sessionId !== row.endpoint.address.sessionId || receipt.evidence.activationEpoch !== row.endpoint.activationEpoch)) return;
      if (["injected", "matched_waiter", "not_injected"].includes(receipt.status) && !isConsumptionReceipt(receipt)) return;
      if (receipt.status === "matched_waiter" && (receipt.evidence?.kind !== "waiter" || receipt.evidence.askId !== row.identity.askId || row.identity.askId === row.identity.id)) return;
      const frame = { from: row.endpoint, to: row.identity.from, digest: row.identity.digest, attempt: row.latestAttempt, receipt };
      ports.store.settleReceipt({ queue: "inbound", peer: row.peer, frame });
      if (receipt.status === "not_injected" && ports.store.retained("inbound", receipt.messageId)?.pendingProof) {
        ports.store.resolveUnknown({ queue: "inbound", id: receipt.messageId, digest: row.identity.digest, proof: frame });
        notifyInbound({ id: row.identity.id, to: row.identity.to });
      }
      if (row.peer === ports.machineId) drainLocalReceipts();
      else bridge.wake(row.peer);
      armExpiry();
    },
    control(from: SessionAddress, to: SessionAddress, control: MessageControl) {
      if (!started || stopped) return bad("bridge-unavailable");
      const row = ports.store.retained("outbound", control.messageId);
      if (!row || !sameAddress(row.identity.from, from) || !sameAddress(row.identity.to, to)) return bad("invalid-control");
      ports.store.cancel({ queue: "outbound", id: control.messageId, from, to }); armExpiry();
      const edge = edges.get(row.peer); if (edge) { edge.controls.set(control.messageId, { from, to, control }); bridge.wake(row.peer); }
    },
    inspectBlockers(address) { return ports.store.inspectBlockers(address); },
    inspectMoveBlockers(address) { if (!intake) throw new Error("intercom-fence-unsupported"); return intake.inspect(address, ports.store); },
    async drainIntake(fence) { if (!intake) throw new Error("intercom-fence-unsupported"); await intake.drain(fence); },
    undispatched(address) { if (!intake) throw new Error("intercom-fence-unsupported"); return ports.store.undispatched(address); },
    rebindMove(fence, endpoint, proof) {
      if (!intake || intake.apply("check", fence) !== fence.generation) throw new Error("intercom-generation-changed");
      const home = ports.authoritativeHome(fence.address);
      if (!home || !proof.owner || home.sessionId !== proof.owner.sessionId || home.machineId !== proof.owner.machineId || home.epoch !== proof.owner.epoch ||
          home.moveId !== fence.moveId || home.epoch <= fence.expectedEpoch || endpoint.homeEpoch !== home.epoch || endpoint.machineId !== home.machineId)
        throw new Error("intercom-home-unproved");
      const next = endpoint.machineId === ports.machineId ? null : lookup(endpoint.machineId);
      if (endpoint.machineId !== ports.machineId && !next) throw new Error("machine-not-enrolled");
      if (proof.nextHop !== (next?.config.peer.machineId ?? ports.machineId)) throw new Error("intercom-home-unproved");
      return ports.store.rebindMoveUndispatched(fence.address, endpoint, proof, next?.config.edgeEpoch);
    },
    resumeIntake(fence) {
      if (!intake || intake.apply("open", fence) !== fence.generation) throw new Error("intercom-generation-changed");
      for (const id of ports.store.pending({ kind: "inbound", address: fence.address })) {
        const row = ports.store.retained("inbound", id.id);
        if (row?.endpoint.machineId === ports.machineId) notifyInbound({ id: id.id, to: id.to });
        else if (row) { const edge = lookup(row.endpoint.machineId); if (edge) bridge.wake(edge.config.peer.machineId); }
      }
    },
    diagnostics() { return [...ports.store.rejectionDiagnostics(), ...[...edges.values()].flatMap(edge => { const fence = ports.store.pairFence(edge.config.peer.machineId);
      if (fence) return [{ peer: fence.peer, status: "down", since: fence.fencedAt, reason: "peer-revoked" }];
      const current = state(edge); return current.outageSince === null || !current.reason ? [] :
        [{ peer: current.peer, status: current.status, since: current.outageSince, reason: current.reason }]; })]; },
  };
  return bridge;
}
