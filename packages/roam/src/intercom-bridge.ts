import { randomBytes } from "node:crypto";
import type { IntercomFederationClient } from "../../intercom/src/broker/client";
import {
  FEDERATION_FEATURE, addressKey, isRemoteSessionInfo, sameAddress,
  type FederationBlockers, type FederationBridge, type FederationDispatch, type FederationDispatchResult,
  type LocalPresence, type MessageControl, type MessageReceipt, type RemoteSessionInfo, type SessionAddress,
} from "@spider/intercom/protocol";
import type { Home } from "@spider/db-core/roam/types";
import type { Clock, Peer, Transport } from "./contracts";
import { encodeExchange } from "./intercom-codec";
import { INTERCOM_EXCHANGE_BYTES, type ExchangeGeneration, type IntercomControlFrame, type IntercomExchange,
  type IntercomIdentity, type IntercomLinkAck, type IntercomReceiptFrame, type IntercomRefusal, type IntercomStore } from "./intercom-contracts";
import { ExchangeError, exchange as executeExchange, type EnrolledIntercomEdge } from "./intercom-exchange";
import { parseHelperRequest, type HelperReply } from "./intercom-helper";
import { acquireHelperRoute, type HelperRouteLease } from "./intercom-route";
import { isMachineId } from "./machine-id";

export interface BridgePorts {
  machineId: string;
  machineAlias: string;
  edges: readonly EnrolledIntercomEdge[];
  store: IntercomStore;
  transport: Transport;
  clock: Clock;
  broker?: IntercomFederationClient;
  globalRoot?: string;
  agentDir?: string;
  localPresence(): readonly RemoteSessionInfo[];
  authoritativeHome(address: SessionAddress): Home | null;
  nextHop?(destinationMachine: string, previousPeer?: string): string | null;
  authorizePresence?(peer: string, entry: RemoteSessionInfo): boolean;
  advertiseRelay?(peer: string, entry: RemoteSessionInfo): boolean;
  publishPresence?(entries: readonly RemoteSessionInfo[]): void;
  onInbound?(identity: { id: string; to: SessionAddress }): void;
  onReceipt?(frame: IntercomReceiptFrame): void;
  onRefusal?(failure: IntercomRefusal & { peer: string }): void;
  onExpiry?(event: { peer: string; id: string; from: SessionAddress; to: SessionAddress; outcomeKnown: boolean }): void;
  onControl?(frame: IntercomControlFrame): void;
  onLinkDown?(peer: string, reason: string): void;
  onBrokerState?(ready: boolean): void;
  onAskFailed?(failure: { peer: string; id: string; from: SessionAddress; to: SessionAddress; reason: "link-down"; outcomeKnown: false }): void;
}
export interface IntercomBridge extends FederationBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  exchange(input: unknown, signal?: AbortSignal): Promise<HelperReply>;
  wake(peer: string): void;
  inspectBlockers(address: SessionAddress): FederationBlockers;
  diagnostics(): readonly { peer: string; status: string; since: number; reason: string }[];
}
interface Inflight { generation: number; abort: AbortController; wake: (() => void) | null; preempted: boolean }
interface Outflight { generation: number; abort: AbortController; promise: Promise<boolean>; connectedUntil: number }
interface EdgeRuntime {
  config: EnrolledIntercomEdge;
  incoming: Map<"poll" | "push", Inflight>;
  outgoing: Map<"poll" | "push", Outflight>;
  controls: Map<string, IntercomControlFrame>;
  failedAsks: Set<string>;
  pollSent: Map<string, { at: number; until: number }>;
  pushIds: Set<string>;
  acknowledgements: Map<string, IntercomLinkAck>;
  receiptAcknowledgements: Map<string, IntercomReceiptFrame>;
  refusals: Map<string, IntercomRefusal>;
  reportedRefusals: Set<string>;
  reportedExpiries: Set<string>;
  resolved: Peer | null;
  retryCancel: (() => void) | null;
  pollCancel: (() => void) | null;
  livenessCancel: (() => void) | null;
  pushCancel: (() => void) | null;
  pushDirty: boolean;
  admissionWaiters: Set<{ deadline: number; finish(live: boolean): void }>;
}
const bad = (code: string): never => { throw new ExchangeError(code); };
const hasData = (value: IntercomExchange): boolean => value.frames.length > 0 || value.acknowledgements.length > 0 || (value.refusals?.length ?? 0) > 0 || value.receipts.length > 0 ||
  (value.receiptAcknowledgements?.length ?? 0) > 0 || value.controls.length > 0;
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const sameIdentity = (a: IntercomIdentity, b: IntercomIdentity): boolean => a.id === b.id && a.sequence === b.sequence && a.digest === b.digest &&
  a.askId === b.askId && sameAddress(a.from, b.from) && sameAddress(a.to, b.to);
const failed = (reason: string): FederationDispatchResult => ({ delivery: "failed",
  retryable: !["machine-not-enrolled", "message-too-large", "ask-expired"].includes(reason), outcomeKnown: true,
  acceptance: { accepted: false, durable: false }, reason });

export function createIntercomBridge(ports: BridgePorts): IntercomBridge {
  if (!isMachineId(ports.machineId) || typeof ports.machineAlias !== "string" || !ports.machineAlias || !Array.isArray(ports.edges)) throw new Error("Invalid intercom bridge identity");
  const edges = new Map<string, EdgeRuntime>();
  for (const config of ports.edges) {
    if (!isMachineId(config.peer.machineId) || config.peer.machineId === ports.machineId || !config.edgeEpoch || typeof config.initiator !== "boolean" || edges.has(config.peer.machineId)) throw new Error("Invalid intercom enrollment");
    edges.set(config.peer.machineId, { config, incoming: new Map(), outgoing: new Map(), controls: new Map(), failedAsks: new Set(),
      pollSent: new Map(), pushIds: new Set(), acknowledgements: new Map(),
      receiptAcknowledgements: new Map(), refusals: new Map(), reportedRefusals: new Set(), reportedExpiries: new Set(), resolved: null, retryCancel: null, pollCancel: null,
      livenessCancel: null, pushCancel: null, pushDirty: false, admissionWaiters: new Set() });
  }
  if (ports.broker && (!ports.globalRoot || !ports.agentDir)) throw new Error("Invalid intercom broker route");
  let started = false, stopped = false, brokerReady = false;
  let startTask: Promise<void> | null = null, stopTask: Promise<void> | null = null;
  const lifetime = new AbortController();
  let routeLease: HelperRouteLease | null = null, brokerLocal: RemoteSessionInfo[] = [];
  let brokerRetryCancel: (() => void) | null = null, brokerRetries = 0, brokerConnectTask: Promise<void> | null = null;
  let expiryCancel: (() => void) | null = null, expiryDeadline: number | null = null, expiryNoticeRetry = false;
  const lookup = (destination: string, previous?: string): EdgeRuntime | null => {
    const hop = edges.has(destination) ? destination : ports.nextHop?.(destination, previous) ?? null;
    return hop && hop !== previous ? edges.get(hop) ?? null : null;
  };
  const state = (edge: EdgeRuntime) => ports.store.edgeState(edge.config.peer.machineId, edge.config.edgeEpoch);
  const fatalReason = (edge: EdgeRuntime): string | null => {
    const current = state(edge);
    return current.status === "down" && current.reason && !new ExchangeError(current.reason).retryable ? current.reason : null;
  };
  const routeLive = (edge: EdgeRuntime): boolean => {
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
  const wakeRelays = (edge: EdgeRuntime, entries = state(edge).roster): void => {
    if (!ports.advertiseRelay) return;
    for (const other of edges.values()) if (other !== edge && entries.some(entry => ports.advertiseRelay!(other.config.peer.machineId, entry))) {
      bridge.wake(other.config.peer.machineId);
    }
  };
  const publish = (): void => {
    if (!ports.publishPresence && !brokerReady) return;
    const entries = new Map<string, RemoteSessionInfo>();
    const local = new Set([...ports.localPresence(), ...brokerLocal].filter(isRemoteSessionInfo).map(entry => addressKey(entry.address)));
    for (const edge of edges.values()) {
      const persisted = state(edge);
      for (const entry of persisted.roster) {
        const candidate = projectPresence(edge, entry);
        const key = addressKey(candidate.address), prior = entries.get(key);
        if (local.has(key)) continue;
        const epoch = candidate.homeEpoch ?? -1, priorEpoch = prior?.homeEpoch ?? -1;
        if (!prior || epoch > priorEpoch || epoch === priorEpoch && prior.stale && !candidate.stale) entries.set(key, candidate);
      }
    }
    const roster = [...entries.values()];
    ports.publishPresence?.(roster);
    if (brokerReady) ports.broker!.publishPresence(roster);
  };
  const armLiveness = (edge: EdgeRuntime): void => {
    edge.livenessCancel?.(); edge.livenessCancel = null;
    if (stopped) return;
    const current = state(edge), now = ports.clock.now();
    if (current.status === "down" || current.status === "recovering") return;
    const successUntil = current.lastSuccess !== null && current.lastSuccess <= now ? current.lastSuccess + 35_000 : 0;
    const deadline = Math.max(successUntil, edge.outgoing.get("poll")?.connectedUntil ?? 0);
    if (deadline > now) edge.livenessCancel = ports.clock.later(deadline - now, () => { edge.livenessCancel = null; publish(); wakeRelays(edge); armLiveness(edge); });
  };
  const blank = (peer: string, generation: ExchangeGeneration): IntercomExchange => ({ protocol: 1, senderMachine: ports.machineId,
    recipientMachine: peer, generation, frames: [], acknowledgements: [], receipts: [], controls: [], presence: [] });
  const build = (edge: EdgeRuntime, generation: ExchangeGeneration, acks: readonly IntercomLinkAck[], receiptAcks: readonly IntercomReceiptFrame[], hopBudgetMs: number,
    metadataOnly = false, skipIds: readonly string[] = [], refusals: readonly IntercomRefusal[] = []): IntercomExchange => {
    const peer = edge.config.peer.machineId, result = blank(peer, generation), max = INTERCOM_EXCHANGE_BYTES - 4096;
    const local = [...new Map([...ports.localPresence(), ...brokerLocal].map(entry => [addressKey(entry.address), entry])).values()];
    if (local.some(entry => !isRemoteSessionInfo(entry) || entry.machineId !== ports.machineId)) return bad("invalid-presence");
    const advertised = new Map(local.map(entry => [addressKey(entry.address), entry]));
    if (ports.advertiseRelay) for (const other of edges.values()) if (other !== edge) {
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
    const resumptions = ports.store.outboundResumptions(peer);
    if (resumptions.length) {
      result.resumptions = [];
      for (const resume of resumptions) if (!add(result.resumptions, resume)) return bad("exchange-too-large");
    }
    const remaining = () => Math.max(0, Math.min(INTERCOM_EXCHANGE_BYTES - 1024, max - bytes(result) - 16));
    for (const receipt of ports.store.pending({ kind: "receipts", peer, maxBytes: remaining() })) result.receipts.push(receipt);
    for (const frame of ports.store.pending({ kind: "outbound", peer, hopBudgetMs, maxBytes: remaining(), skipIds })) result.frames.push(frame);
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
  };
  const apply = (edge: EdgeRuntime, incoming: IntercomExchange): { acks: IntercomLinkAck[]; receiptAcks: IntercomReceiptFrame[]; refusals: IntercomRefusal[] } => {
    const peer = edge.config.peer.machineId, acks: IntercomLinkAck[] = [], receiptAcks: IntercomReceiptFrame[] = [], refusals: IntercomRefusal[] = [];
    if (incoming.presence.some(entry => entry.machineId === ports.machineId || !(ports.authorizePresence?.(peer, entry) ?? entry.machineId === peer))) return bad("invalid-presence");
    for (const ack of incoming.acknowledgements) {
      ports.store.acknowledge({ peer, ...ack }); edge.pollSent.delete(ack.identity.id); edge.reportedRefusals.delete(ack.identity.id);
    }
    for (const refusal of incoming.refusals ?? []) {
      const row = ports.store.retained("outbound", refusal.identity.id);
      if (!row || row.peer !== peer || !sameIdentity(row.identity, refusal.identity)) return bad("invalid-refusal");
      if (refusal.reason === "link-down") {
        if (refusal.identity.askId !== refusal.identity.id) return bad("invalid-refusal");
        if (!ports.store.openAsks(peer).some(item => item.identity.id === refusal.identity.id)) continue;
      }
      const upstream = ports.store.retained("inbound", refusal.identity.id);
      if (upstream && upstream.peer !== peer) {
        const previous = edges.get(upstream.peer);
        if (previous) { previous.refusals.set(refusal.identity.id, refusal); bridge.wake(upstream.peer); }
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
      const outbound = ports.store.retained("outbound", frame.receipt.messageId);
      if (!outbound || outbound.peer !== peer) return bad("invalid-receipt");
      ports.store.settleReceipt({ queue: "outbound", peer, frame });
      const relay = ports.store.retained("inbound", frame.receipt.messageId);
      if (relay && relay.peer !== peer) ports.store.settleReceipt({ queue: "inbound", peer: relay.peer, frame });
      edge.controls.delete(frame.receipt.messageId); edge.failedAsks.delete(frame.receipt.messageId);
      receiptAcks.push(frame);
      if (relay && relay.peer !== peer) bridge.wake(relay.peer);
      else ports.onReceipt?.(frame);
    }
    for (const frame of incoming.frames) {
      const remote = frame.endpoint.machineId !== ports.machineId, next = remote ? lookup(frame.endpoint.machineId, peer) : null;
      if (remote && !next) { refusals.push({ identity: frame.identity, reason: "machine-not-enrolled" }); continue; }
      const resume = incoming.resumptions?.find(item => sameAddress(item.from, frame.identity.from) && sameAddress(item.to, frame.identity.to));
      const accepted = ports.store.acceptInbound({ peer, frame, ...(resume ? { resume: { cursor: resume, owner: ports.authoritativeHome(frame.identity.to) } } : {}) });
      if (accepted.kind === "refused") { refusals.push({ identity: frame.identity, reason: accepted.reason }); continue; }
      if (next) {
        const forwarded = ports.store.acceptOutbound({ frame, nextHop: next.config.peer.machineId });
        if (forwarded.kind === "refused") { refusals.push({ identity: frame.identity, reason: forwarded.reason }); continue; }
        bridge.wake(next.config.peer.machineId);
      } else {
        if (frame.kind === "tombstone" && frame.reason === "cancelled" && !incoming.controls.some(item => item.control.messageId === frame.identity.id &&
            sameAddress(item.from, frame.identity.from) && sameAddress(item.to, frame.identity.to))) {
          ports.onControl?.({ from: frame.identity.from, to: frame.identity.to, control: { messageId: frame.identity.id, action: "cancel", timestamp: ports.clock.now() } });
        }
        ports.onInbound?.({ id: frame.identity.id, to: frame.identity.to });
      }
      acks.push({ identity: frame.identity, kind: frame.kind });
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
    observe(edge, incoming.presence); armExpiry();
    return { acks, receiptAcks, refusals };
  };
  const wait = (active: Inflight, ms: number, signal?: AbortSignal): Promise<void> => new Promise(resolve => {
    let cancel = () => {}, done = false;
    const finish = () => { if (done) return; done = true; cancel(); active.wake = null; active.abort.signal.removeEventListener("abort", finish); signal?.removeEventListener("abort", finish); resolve(); };
    active.wake = finish; active.abort.signal.addEventListener("abort", finish, { once: true }); signal?.addEventListener("abort", finish, { once: true });
    if (active.abort.signal.aborted || signal?.aborted) finish(); else cancel = ports.clock.later(ms, finish);
  });

  const reportExpiries = (): void => {
    if (!ports.onExpiry) { expiryNoticeRetry = false; return; }
    let retry = false;
    for (const edge of edges.values()) {
      const peer = edge.config.peer.machineId;
      for (const { identity, outcomeKnown } of ports.store.expiredOutbounds(peer)) {
        if (edge.reportedExpiries.has(identity.id)) continue;
        try {
          ports.onExpiry({ peer, id: identity.id, from: identity.from, to: identity.to, outcomeKnown });
          edge.reportedExpiries.add(identity.id);
        } catch { retry = true; }
      }
    }
    expiryNoticeRetry = retry;
  };
  const sweep = (): void => {
    const expired = ports.store.expire();
    reportExpiries();
    for (const item of expired) if (item.queue === "inbound") {
      const row = ports.store.retained("inbound", item.id);
      if (row) bridge.wake(row.peer);
    }
    armExpiry();
  };
  const armExpiry = (): void => {
    if (stopped) return;
    const next = ports.store.nextExpiry(), retry = expiryNoticeRetry ? ports.clock.now() + 30_000 : null;
    const deadline = next === null ? retry : retry === null ? next : Math.min(next, retry);
    if (deadline === expiryDeadline && expiryCancel) return;
    expiryCancel?.(); expiryCancel = null; expiryDeadline = deadline;
    if (deadline !== null) expiryCancel = ports.clock.later(Math.max(0, deadline - ports.clock.now()), () => {
      expiryCancel = null; expiryDeadline = null;
      if (!stopped) sweep();
    });
  };
  const ackKey = (ack: IntercomLinkAck): string => JSON.stringify([ack.identity.id, ack.kind]);
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
        if (previous) { previous.refusals.set(row.identity.id, { identity: row.identity, reason: "link-down" }); bridge.wake(upstream.peer); }
      } else if (!edge.failedAsks.has(row.identity.id) && ports.onAskFailed) {
        ports.onAskFailed({ peer, id: row.identity.id, from: row.identity.from, to: row.identity.to, reason: "link-down", outcomeKnown: false });
        edge.failedAsks.add(row.identity.id);
      }
    }
  };
  const retryDelay = (failures: number): number => [2000, 4000, 8000, 15_000, 30_000][Math.min(4, Math.max(0, failures - 2))];
  const scheduleRecovery = (edge: EdgeRuntime, delay: number): void => {
    if (stopped || edge.retryCancel) return;
    edge.retryCancel = ports.clock.later(delay, () => {
      edge.retryCancel = null;
      if (stopped) return;
      const deadlines = [...edge.admissionWaiters].map(waiter => waiter.deadline - ports.clock.now()).filter(value => value > 0);
      const limit = deadlines.length ? Math.min(10_000, ...deadlines) : undefined;
      const existing = edge.outgoing.get("push");
      if (existing) { existing.abort.abort(); void existing.promise.finally(() => { if (!stopped) void transfer(edge, "push", true, limit); }); }
      else void transfer(edge, "push", true, limit);
    });
  };
  const markFailure = (edge: EdgeRuntime, error: unknown, probe: boolean): void => {
    if (stopped) return;
    const peer = edge.config.peer.machineId, before = state(edge), reason = failureCode(error);
    const immediate = !new ExchangeError(reason).retryable;
    const down = immediate || before.status === "down" || probe && before.status === "recovering";
    const updated = ports.store.updateEdgeState(peer, edge.config.edgeEpoch, old => ({ ...old, status: down ? "down" : "recovering",
      outageSince: old.outageSince ?? ports.clock.now(), reason: immediate ? reason : old.reason ?? reason,
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
    if (stopped || !edge.config.initiator || edge.outgoing.has("poll") || edge.pollCancel || state(edge).status === "down" || state(edge).status === "recovering") return;
    edge.pollCancel = ports.clock.later(0, () => { edge.pollCancel = null; if (!stopped) void transfer(edge, "poll", false); });
  };
  const schedulePush = (edge: EdgeRuntime, delay: number): void => {
    if (stopped || edge.pushCancel) return;
    edge.pushCancel = ports.clock.later(delay, () => { edge.pushCancel = null; bridge.wake(edge.config.peer.machineId); });
  };
  const transfer = (edge: EdgeRuntime, channel: "poll" | "push", probe: boolean, maximumMs?: number): Promise<boolean> => {
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
        const now = ports.clock.now();
        for (const [id, handoff] of edge.pollSent) if (now < handoff.at || now >= handoff.until) edge.pollSent.delete(id);
        input = build(edge, generation, [...edge.acknowledgements.values()], [...edge.receiptAcknowledgements.values()], total, probe || channel === "poll",
          [...edge.pollSent.keys()], [...edge.refusals.values()]);
        reportExpiries(); armExpiry();
        if (channel === "push") for (const frame of input.frames) edge.pushIds.add(frame.identity.id);
        const response = await executeExchange(edge.resolved, { exchange: input, holdMs: channel === "poll" && !probe ? 25_000 : 0 }, {
          machineId: ports.machineId, enrollment: edge.config, transport: ports.transport, store: ports.store, clock: ports.clock, probe, maxTotalMs: remaining(), signal: active.abort.signal,
          onConnected: connected => { active.connectedUntil = connected && channel === "poll" && !probe ? begun + total : 0; publish(); armLiveness(edge); },
        });
        if (stopped || active.abort.signal.aborted || edge.outgoing.get(channel) !== active || state(edge).outbound[channel] !== generation.generation) return false;
        const applied = apply(edge, response.exchange);
        for (const ack of input.acknowledgements) edge.acknowledgements.delete(ackKey(ack));
        for (const ack of input.receiptAcknowledgements ?? []) edge.receiptAcknowledgements.delete(receiptKey(ack));
        for (const refusal of input.refusals ?? []) edge.refusals.delete(refusal.identity.id);
        for (const ack of applied.acks) edge.acknowledgements.set(ackKey(ack), ack);
        for (const ack of applied.receiptAcks) edge.receiptAcknowledgements.set(receiptKey(ack), ack);
        for (const refusal of applied.refusals) edge.refusals.set(refusal.identity.id, refusal);
        if (applied.acks.length || applied.receiptAcks.length || applied.refusals.length) edge.pushDirty = true;
        succeeded = true;
        return true;
      } catch (error) {
        edge.resolved = null;
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
    const next = sessions.map(session => ({ remote: true as const, id: session.address.sessionId, address: session.address, machineId: ports.machineId,
      machineAlias: ports.machineAlias, homeEpoch: session.homeEpoch, activationEpoch: session.activationEpoch, endpointEpoch: session.activationEpoch,
      cwd: session.cwd, model: session.model, startedAt: session.startedAt, lastActivity: session.lastActivity,
      ...(session.name === undefined ? {} : { name: session.name }), ...(session.status === undefined ? {} : { status: session.status }) }));
    if (JSON.stringify(next) === JSON.stringify(brokerLocal)) return;
    brokerLocal = next;
    publish();
    for (const edge of edges.values()) bridge.wake(edge.config.peer.machineId);
  };
  const connectBroker = async (): Promise<void> => {
    const broker = ports.broker!;
    await broker.connect({ feature: FEDERATION_FEATURE, agentDir: ports.agentDir!, machineId: ports.machineId, machineAlias: ports.machineAlias }, bridge);
    if (stopped) return bad("bridge-stopped");
    const token = randomBytes(32).toString("hex");
    await broker.enableHelpers(token, (input, signal) => bridge.exchange(input, signal));
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
          for (const edge of edges.values()) if (state(edge).status === "down") failAsks(edge);
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

  const cancelWork = (): Promise<boolean>[] => {
    const pending: Promise<boolean>[] = [];
    expiryCancel?.(); expiryCancel = null; expiryDeadline = null;
    for (const edge of edges.values()) {
      edge.retryCancel?.(); edge.pollCancel?.(); edge.livenessCancel?.(); edge.pushCancel?.();
      edge.retryCancel = edge.pollCancel = edge.livenessCancel = edge.pushCancel = null;
      for (const active of edge.incoming.values()) active.abort.abort();
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
          if (ports.broker) {
            routeLease = await acquireHelperRoute(ports.globalRoot!, ports.agentDir!, lifetime.signal);
            if (stopped) return bad("bridge-stopped");
            ports.broker.on("presence", onLocalPresence);
            ports.broker.on("disconnected", onBrokerDisconnected);
            await connectBroker();
          }
          if (stopped) return bad("bridge-stopped");
          sweep(); publish();
          for (const edge of edges.values()) {
            const current = state(edge); armLiveness(edge);
            if (current.status === "down" || current.status === "recovering") {
              if (current.status === "down") { try { failAsks(edge); } catch { /* Keep open for the next recovery. */ } }
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
    async exchange(raw, signal) {
      if (!started || stopped) return bad("bridge-unavailable");
      let input;
      try { if (bytes(raw) > INTERCOM_EXCHANGE_BYTES - 1024) return bad("exchange-too-large"); input = parseHelperRequest(raw); }
      catch (error) { if (error instanceof ExchangeError) throw error; return bad("invalid-request"); }
      const incoming = input.exchange, edge = edges.get(incoming.senderMachine);
      if (!edge || incoming.recipientMachine !== ports.machineId || incoming.generation.edgeEpoch !== edge.config.edgeEpoch) return bad("machine-not-enrolled");
      const fatal = fatalReason(edge); if (fatal) return bad(fatal);
      const channel = incoming.generation.channel, number = incoming.generation.generation;
      if (signal?.aborted) return bad("cli-aborted");
      ports.store.updateEdgeState(edge.config.peer.machineId, edge.config.edgeEpoch, old => {
        if (number <= old.inbound[channel]) return bad("stale-generation");
        return { ...old, inbound: { ...old.inbound, [channel]: number } };
      });
      const previous = edge.incoming.get(channel);
      if (previous) { previous.preempted = true; previous.abort.abort(); }
      const active: Inflight = { generation: number, abort: new AbortController(), wake: null, preempted: false };
      edge.incoming.set(channel, active);
      try {
        sweep();
        const applied = apply(edge, incoming);
        const hopBudgetMs = channel === "poll" ? 45_000 : 20_000;
        const makeReply = () => build(edge, incoming.generation,
          [...new Map([...edge.acknowledgements.values(), ...applied.acks].map(ack => [ackKey(ack), ack])).values()],
          [...new Map([...edge.receiptAcknowledgements.values(), ...applied.receiptAcks].map(ack => [receiptKey(ack), ack])).values()],
          hopBudgetMs, channel === "push", [...edge.pushIds],
          [...new Map([...edge.refusals.values(), ...applied.refusals].map(refusal => [refusal.identity.id, refusal])).values()]);
        let output = makeReply();
        if (input.holdMs > 0 && !hasData(output)) {
          await wait(active, input.holdMs, signal);
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
        for (const refusal of output.refusals ?? []) edge.refusals.delete(refusal.identity.id);
        if (channel === "poll") {
          const at = ports.clock.now();
          for (const frame of output.frames) edge.pollSent.set(frame.identity.id, { at, until: at + 45_000 });
        }
        return { version: 1, exchange: output };
      } finally { if (edge.incoming.get(channel) === active) edge.incoming.delete(channel); }
    },
    wake(peer) {
      const edge = edges.get(peer); if (!edge || stopped) return;
      if (started) armExpiry();
      const waiting = !!edge.incoming.get("poll")?.wake;
      for (const active of edge.incoming.values()) active.wake?.();
      edge.pushDirty = true;
      if (!started || waiting && !edge.config.initiator || edge.outgoing.has("push")) return;
      const status = state(edge).status;
      if (status !== "down" && status !== "recovering") void transfer(edge, "push", false);
    },
    async dispatch(input: FederationDispatch): Promise<FederationDispatchResult> {
      if (!started || stopped) return failed("bridge-unavailable");
      const edge = lookup(input.to.machineId);
      if (!edge) return failed("machine-not-enrolled");
      const currentHome = () => {
        const home = ports.authoritativeHome(input.to.address);
        return !home || home.sessionId === input.to.address.sessionId && home.machineId === input.to.machineId && home.epoch === input.to.homeEpoch;
      };
      if (!currentHome()) return failed("stale-home-epoch");
      let message = input.message;
      if (message.expectsReply) {
        if (input.to.reachability === "down" || input.to.reachability === "recovering" ||
            edge.config.peer.machineId !== input.to.machineId && input.to.stale) return failed("link-down");
        const status = state(edge).status;
        if (status === "down" || status === "recovering") return failed("link-down");
        if (!Number.isSafeInteger(message.remainingMs) || Number(message.remainingMs) <= 0) return failed("ask-expired");
        const begun = ports.clock.now(), original = Number(message.remainingMs);
        if (!routeLive(edge) && !await admitUnknown(edge, original)) return failed("link-down");
        const now = ports.clock.now();
        if (now < begun || now - begun >= original) return failed("ask-expired");
        message = { ...message, remainingMs: original - (now - begun) };
      }
      if (!started || stopped) return failed("bridge-unavailable");
      if (!currentHome()) return failed("stale-home-epoch");
      const endpoint = { address: input.to.address, machineId: input.to.machineId, homeEpoch: input.to.homeEpoch, activationEpoch: input.to.activationEpoch };
      const accepted = ports.store.acceptOutbound({ from: input.from, endpoint, message, nextHop: edge.config.peer.machineId });
      if (accepted.kind === "refused") return failed(accepted.reason);
      armExpiry(); bridge.wake(edge.config.peer.machineId);
      return { delivery: "queued", retryable: false, outcomeKnown: true, acceptance: accepted.acceptance };
    },
    receipt(from: SessionAddress, receipt: MessageReceipt) {
      if (!started || stopped) return bad("bridge-unavailable");
      const row = ports.store.retained("inbound", receipt.messageId);
      if (!row || !sameAddress(row.endpoint.address, from)) return bad("invalid-receipt");
      const frame = { from: row.endpoint, to: row.identity.from, digest: row.identity.digest, attempt: row.latestAttempt, receipt };
      ports.store.settleReceipt({ queue: "inbound", peer: row.peer, frame }); armExpiry(); bridge.wake(row.peer);
    },
    control(from: SessionAddress, to: SessionAddress, control: MessageControl) {
      if (!started || stopped) return bad("bridge-unavailable");
      const row = ports.store.retained("outbound", control.messageId);
      if (!row || !sameAddress(row.identity.from, from) || !sameAddress(row.identity.to, to)) return bad("invalid-control");
      ports.store.cancel({ queue: "outbound", id: control.messageId, from, to }); armExpiry();
      const edge = edges.get(row.peer); if (edge) { edge.controls.set(control.messageId, { from, to, control }); bridge.wake(row.peer); }
    },
    inspectBlockers(address) { return ports.store.inspectBlockers(address); },
    diagnostics() { return [...edges.values()].flatMap(edge => { const current = state(edge); return current.outageSince === null || !current.reason ? [] :
      [{ peer: current.peer, status: current.status, since: current.outageSince, reason: current.reason }]; }); },
  };
  return bridge;
}
