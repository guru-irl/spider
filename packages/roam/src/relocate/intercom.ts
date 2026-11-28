import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { openRoamPathReadOnly } from "@spider/db-core/roam/reads";
import { HerdrError } from "@spider/herdr/client/parse";
import { requestV0Broker } from "@spider/intercom/broker/roam-v0-client";
import { relayRefused, relayUnknown, type RelayResult, type RelaySubmit, type RelayTarget } from "@spider/intercom/relay-protocol";
import {
  parseV0AgentReply, parseV0AgentRequest, parseV0RelayAgentRequest, v0BrokerOrigin, v0ExplicitName,
  V0_ASK_MAX_MS, V0_INTERCOM_BYTES, V0_INTERCOM_MS,
  type V0AgentReply, type V0AgentRequest, type V0Code, type V0Endpoint, type V0Prepare, type V0Refused,
  type V0RelayAgentRequest, type V0Reply, type V0SendPlan, type V0Text,
} from "@spider/intercom/roam-v0";
import type { LocalSessionInfo } from "@spider/intercom/types";
import { DEFAULT_LIMITS, type Peer, type RoamConfig, type Transport } from "../contracts";
import { isMachineId } from "../machine-id";
import { readLocalIdentity } from "../runtime";
import { createTransport } from "../transport";
import { createHomeStore } from "./home";
import { localHerdrConnection } from "./local";
import { isV0Alias, readV0Routes, type V0Routes } from "./intercom-routes";
import { configuredRelayLinks, routeV0Relay } from "./intercom-relay-route";
import type { RelocateHome, SessionId } from "./types";

export interface V0IntercomDeps {
  broker?: typeof requestV0Broker;
  transport?: (peers: readonly Peer[]) => Pick<Transport, "resolve" | "exec">;
}

const POST_CHECK_MS = 2000;
const ASK_REPLY_RESERVE_MS = 10_000;
const REMOTE_ASK_STARTUP_MS = 9500;

/** A present but invalid file opts in and fails closed rather than falling back to federation. */
export function hasV0IntercomConfig(root: string): boolean {
  try { lstatSync(join(root, "roam", "intercom-v0.json")); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

async function withHomes<T>(root: string, config: RoamConfig, read: (homes: ReturnType<typeof createHomeStore>) => Promise<T>): Promise<T> {
  const db = openRoamPathReadOnly(join(root, "spider.db"));
  if (!db) throw new Error("Home store unavailable");
  try {
    const meta = db.prepare("SELECT machine_id, store_key FROM roam_meta WHERE id=1").get() as { machine_id?: unknown; store_key?: unknown } | undefined;
    if (meta?.machine_id !== config.machineId || meta.store_key !== "global" && meta.store_key !== null) throw new Error("Home store identity mismatch");
    return await read(createHomeStore({ db, localMachineId: config.machineId, hubMachineId: config.hubMachineId }));
  } finally { db.close(); }
}

function homeCode(home: RelocateHome | null, machineId: string, epoch: number | undefined): V0Code | null {
  if (!home) return "changed";
  if (home.state === "moving") return "moving";
  if (home.state === "stopped") return "offline";
  if (home.machineId !== machineId || (epoch !== undefined && home.epoch !== epoch)) return "changed";
  return null;
}
function refused(code: V0Code): V0Refused { return { kind: "refused", code }; }
function localMatches(scoped: readonly LocalSessionInfo[], to: string): LocalSessionInfo[] {
  const exact = scoped.filter(item => item.id === to || item.address?.sessionId === to);
  if (exact.length) return exact;
  const names = scoped.filter(item => item.name?.toLowerCase() === to.toLowerCase());
  return names.length ? names : scoped.filter(item => item.id.startsWith(to));
}
function pinLocal(from: LocalSessionInfo, target: LocalSessionInfo) {
  if (target.id === from.id || from.address && target.address?.sessionId === from.address.sessionId) return refused("self");
  if (!target.endpointEpoch) return refused("changed");
  return { kind: "local" as const, target: { id: target.id, endpointEpoch: target.endpointEpoch } };
}
function matching(endpoint: V0Endpoint, request: Extract<V0AgentRequest, { kind: "lookup" }>): boolean {
  return endpoint.address.scopeId === request.from.address.scopeId &&
    (request.selector.by === "id" ? endpoint.address.sessionId === request.selector.value
      : endpoint.name !== null && endpoint.name.toLowerCase() === request.selector.value.toLowerCase());
}

function sameEndpoint(a: V0Endpoint, b: V0Endpoint): boolean {
  return a.address.sessionId === b.address.sessionId && a.address.scopeId === b.address.scopeId &&
    a.name === b.name && a.homeEpoch === b.homeEpoch && a.endpointEpoch === b.endpointEpoch;
}
function endpointOf(session: LocalSessionInfo): V0Endpoint | null {
  if (!session.address || !session.endpointEpoch || session.v0HomeEpoch === undefined) return null;
  return { address: { ...session.address }, name: v0ExplicitName(session),
    homeEpoch: session.v0HomeEpoch, endpointEpoch: session.endpointEpoch };
}
function samePeer(a: Peer, b: Peer): boolean {
  return a.machineId === b.machineId && a.alias === b.alias && a.node === b.node && a.pi === b.pi &&
    a.cli === b.cli && a.core === b.core && a.globalRoot === b.globalRoot && a.agentDir === b.agentDir && a.coreUnit === b.coreUnit;
}
function selectedTarget(to: string): { kind: "bare"; value: string } | { kind: "qualified"; machine: string; value: string } | null {
  if (!to) return null;
  const slash = to.indexOf("/");
  if (slash < 0) return { kind: "bare", value: to };
  if (to.length > 1024 || to.indexOf("/", slash + 1) >= 0 || /[\u0000-\u001f\u007f-\u009f]/.test(to)) return null;
  try {
    const machine = decodeURIComponent(to.slice(0, slash)), value = decodeURIComponent(to.slice(slash + 1));
    return isV0Alias(machine) && value.length > 0 && value.length <= 256 && value.trim().length > 0 &&
      !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? { kind: "qualified", machine, value } : null;
  } catch { return null; }
}

/** A deadline aborts ignored port signals too, and checks again before any dispatch. */
async function bounded<T>(deadline: number, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ms = Math.floor(deadline - performance.now());
  if (ms <= 0 || signal?.aborted) throw new Error("Intercom deadline expired");
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (result: { ok: true; value: T } | { ok: false; error: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (result.ok) resolve(result.value); else reject(result.error);
    };
    const abort = () => { controller.abort(); finish({ ok: false, error: new Error("Intercom request aborted") }); };
    const timer = setTimeout(abort, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error("Intercom request aborted");
      return work(controller.signal);
    }).then(value => finish({ ok: true, value }), error => finish({ ok: false, error }));
  });
}

type V0WireRequest = V0AgentRequest | V0RelayAgentRequest;
class DirectRouteUnavailable extends Error {}

function replyResult(reply: V0AgentReply): V0Reply {
  const { version: _version, requestId: _requestId, machineId: _machineId, ...result } = reply;
  return result;
}

function createV0PeerCaller(root: string, deps: V0IntercomDeps) {
  return async function callPeer(configured: V0Routes, peer: Peer, wire: V0WireRequest, deadline: number,
    deliveryDeadline: number, signal?: AbortSignal, onDeliveryHandOff?: () => void, onRouteUnavailable?: () => void): Promise<V0Reply> {
    const request = wire.version === 2 ? parseV0RelayAgentRequest(wire)?.request : parseV0AgentRequest(wire);
    if (!request) return refused("invalid");
    let invoked = false;
    try {
      return await bounded(deadline, signal, async callSignal => {
        const transport = deps.transport?.(configured.sendTo) ?? createTransport({ ...localHerdrConnection(root), enrolled: configured.sendTo });
        const resolveMs = Math.floor(Math.min(deadline, deliveryDeadline) - performance.now());
        if (resolveMs <= 0) throw new Error("Intercom delivery deadline expired");
        const target = await bounded(Math.min(deadline, deliveryDeadline), callSignal,
          resolveSignal => transport.resolve(peer, { timeoutMs: resolveMs, signal: resolveSignal }));
        if ((wire.version === 2 || onRouteUnavailable) && !samePeer(peer, target)) return refused("changed");
        if (callSignal.aborted || performance.now() >= deliveryDeadline) throw new Error("Intercom delivery deadline expired");
        const remaining = Math.floor(deadline - performance.now());
        if (remaining <= POST_CHECK_MS) throw new Error("Intercom post-check reserve unavailable");
        const input = request.kind === "lookup" ? { stdin: Buffer.from(JSON.stringify(wire)) } : {
          stdinForTimeout: (remoteMs: number) => {
            const deliveryMs = Math.floor(deliveryDeadline - performance.now());
            if (callSignal.aborted || deliveryMs <= 0) throw new Error("Intercom delivery deadline expired");
            let outbound = wire;
            if (request.kind === "ask") {
              // Herdr starts this window before the remote agent reads stdin.
              const timeoutMs = Math.min(request.timeoutMs, deliveryMs, remoteMs - REMOTE_ASK_STARTUP_MS);
              if (timeoutMs <= 0) throw new Error("Intercom ask deadline expired");
              outbound = { ...request, timeoutMs };
            }
            const body = Buffer.from(JSON.stringify(outbound));
            invoked = true;
            onDeliveryHandOff?.();
            return body;
          },
        };
        const output = await transport.exec(target, ["roam", "agent", "--v0", "intercom"], {
          timeoutMs: remaining, maxBytes: V0_INTERCOM_BYTES, postReserveMs: POST_CHECK_MS, signal: callSignal, ...input,
          ...(onRouteUnavailable && { onConnected(connected: boolean) { if (!connected) throw new DirectRouteUnavailable(); } }),
        });
        if (!Buffer.isBuffer(output) || output.length > V0_INTERCOM_BYTES) throw new Error("Invalid intercom reply size");
        const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output));
        const reply = parseV0AgentReply(raw);
        if (!reply || reply.requestId !== request.requestId || reply.machineId !== peer.machineId ||
            wire.version === 1 && reply.kind === "refused" && reply.code === "reply-only")
          throw new Error("Uncorrelated intercom reply");
        if (wire.version === 2 && request.kind === "deliver" && !invoked) throw new Error("Missing intercom delivery hand-off");
        const result = replyResult(reply);
        if (result.kind === "refused") return result;
        if (request.kind === "lookup") {
          if (result.kind !== "matches") throw new Error("Invalid lookup result");
          return result;
        }
        if (result.kind === "matches" || result.id !== request.message.id ||
            request.kind === "deliver" && result.kind !== "socket_delivered" && result.kind !== "unknown" ||
            request.kind === "ask" && result.kind !== "replied" && result.kind !== "no_reply" && result.kind !== "unknown")
          throw new Error("Invalid delivery result");
        return result;
      });
    } catch (error) {
      if (request.kind !== "lookup" && invoked) return { kind: "unknown", id: request.message.id };
      if (!signal?.aborted && performance.now() < deliveryDeadline &&
          (error instanceof DirectRouteUnavailable || error instanceof HerdrError && error.code === "machine-not-found")) onRouteUnavailable?.();
      return refused(error instanceof HerdrError && (error.code === "machine-not-found" || error.code === "machine-ambiguous")
        ? "invalid-config" : "unreachable");
    }
  };
}

export function createV0Intercom(root: string, deps: V0IntercomDeps = {}): {
  prepare: V0Prepare;
  handle(raw: unknown): Promise<V0AgentReply | null>;
} {
  const broker = deps.broker ?? requestV0Broker;
  const callPeer = createV0PeerCaller(root, deps);
  const receive = createV0AgentReceiver(root, broker);

  const prepare: V0Prepare = async ({ to, from, locals, signal }) => {
    const deadline = performance.now() + V0_INTERCOM_MS;
    const selector = selectedTarget(to);
    if (!selector) return refused("invalid");
    let config: RoamConfig | undefined, configured: V0Routes | undefined;
    try { config = readLocalIdentity(root); configured = readV0Routes(root, config); }
    catch { /* Neither identity nor routes are needed to reach a known local peer. */ }
    let all: readonly RelocateHome[] | null = null;
    if (config) {
      const identity = config;
      try { all = await bounded(deadline, signal, () => withHomes(root, identity, homes => homes.list()).catch(() => null)); }
      catch { return refused("unreachable"); }
    }
    if (signal?.aborted || performance.now() >= deadline) return refused("unreachable");
    const byId = (id: string) => all?.find(home => home.sessionId === id) ?? null;
    const unqualifiedHome = byId(to);
    const scoped = locals.filter(item => !item.address || item.address.scopeId === (from.address?.scopeId ?? null));
    const atHome = (home: RelocateHome) => scoped.filter(item => item.address?.sessionId === home.sessionId);
    if (!config || !configured || !all) {
      // Only the live broker roster can prove a local destination when the
      // roaming inputs are unavailable. Never fall through to an unknown ID.
      if (selector.kind === "bare" && (!unqualifiedHome || unqualifiedHome.machineId === config?.machineId)) {
        const local = unqualifiedHome ? atHome(unqualifiedHome) : localMatches(scoped, to);
        if (local.length && from.v0HomeEpoch === undefined) return { kind: "legacy" };
        if (local.length > 1) return refused("ambiguous");
        if (local.length === 1) return pinLocal(from, local[0]);
      }
      return refused(configured ? "home-unreadable" : "invalid-config");
    }
    const { machineId, hubMachineId, role } = config;
    const senderHome = byId(from.address?.sessionId ?? from.id);
    const qualifiedPeer = selector.kind === "qualified" ? configured.sendTo.find(peer => peer.alias.toLowerCase() === selector.machine.toLowerCase()) : undefined;
    const qualifiedHome = selector.kind === "qualified" ? byId(selector.value) : null;
    let qualifiedMachine = qualifiedPeer?.machineId as string | undefined;
    let exactHome = unqualifiedHome ?? (qualifiedPeer && qualifiedHome?.machineId === qualifiedPeer.machineId ? qualifiedHome : null);
    const macQualified = selector.kind === "qualified" && configured.acceptFrom.some(peer =>
      peer.machineId === hubMachineId && peer.alias.toLowerCase() === selector.machine.toLowerCase());
    if (role === "box" && (exactHome?.machineId === hubMachineId || macQualified)) return refused("reply-only");
    if (from.v0HomeEpoch === undefined) {
      return selector.kind === "qualified" || exactHome && exactHome.machineId !== machineId
        ? refused("not-configured") : { kind: "legacy" };
    }
    if (!senderHome) return refused("changed");
    const candidateSource = endpointOf(from);
    if (!candidateSource || !locals.some(local => local.id === from.id && endpointOf(local) !== null && sameEndpoint(endpointOf(local)!, candidateSource)))
      return refused("changed");
    const source: V0Endpoint = candidateSource;
    const senderCode = homeCode(senderHome, machineId, source.homeEpoch);
    if (senderCode) return refused(senderCode);
    const useRelays = configured.version === 2;
    const knownPeers = [...configured.sendTo, ...configured.acceptFrom, ...config.peers];
    const machineLabel = (id: string) => knownPeers.find(peer => peer.machineId === id)?.alias ?? id;
    if (useRelays && selector.kind === "qualified") {
      let advertised;
      try { advertised = await bounded(deadline, signal, s => configuredRelayLinks(configured!, s)); }
      catch { return refused("unreachable"); }
      const qualifier = selector.machine.toLowerCase();
      const reachable = advertised.filter(link => link.state === "up").flatMap(link => link.reach);
      const matches = new Set([...knownPeers, ...reachable].filter(peer => isMachineId(peer.machineId) &&
        (peer.alias.toLowerCase() === qualifier || peer.machineId === qualifier)).map(peer => peer.machineId));
      if (qualifiedHome?.machineId === qualifier) matches.add(qualifiedHome.machineId);
      if (matches.size > 1) return refused("ambiguous");
      [qualifiedMachine] = matches;
      if (role === "box" && qualifiedMachine === hubMachineId) return refused("reply-only");
      exactHome = qualifiedHome?.machineId === qualifiedMachine ? qualifiedHome : null;
    }
    if (qualifiedMachine && qualifiedHome && qualifiedHome.machineId !== qualifiedMachine) return refused("no-match");

    const localPlan = (target: LocalSessionInfo) => {
      const plan = pinLocal(from, target);
      if (plan.kind === "refused") return plan;
      const home = byId(target.address?.sessionId ?? target.id);
      if (home) {
        const code = homeCode(home, machineId, target.v0HomeEpoch ?? 0);
        if (code) return refused(code);
      } else if (target.v0HomeEpoch !== undefined) return refused("changed");
      return plan;
    };

    if (exactHome) {
      if (exactHome.sessionId === source.address.sessionId) return refused("self");
      if (exactHome.state === "moving") return refused("moving");
      if (exactHome.state === "stopped") return refused("offline");
      if (exactHome.machineId === machineId) {
        const local = atHome(exactHome);
        return local.length > 1 ? refused("ambiguous") : local.length === 1 ? localPlan(local[0]) : refused("offline");
      }
    } else if (selector.kind === "bare") {
      const local = localMatches(scoped, to);
      if (local.length) return local.length > 1 ? refused("ambiguous") : localPlan(local[0]);
    }

    const targetMachine = exactHome?.machineId ?? qualifiedMachine;
    const remoteHomes = new Set(all.filter(home => home.state === "running" && home.machineId !== machineId &&
      !(role === "box" && home.machineId === hubMachineId)).map(home => home.machineId));
    const peers = targetMachine ? configured.sendTo.filter(peer => peer.machineId === targetMachine)
      : selector.kind === "qualified" ? [] : configured.sendTo.filter(peer => remoteHomes.has(peer.machineId));
    const query = exactHome ? { by: "id" as const, value: exactHome.sessionId }
      : { by: "name" as const, value: selector.value };
    const sourceWire = { ...source, machineId };
    const agentDir = configured.agentDir;
    const relayTarget: RelayTarget | undefined = useRelays && targetMachine && targetMachine !== machineId
      ? { machineId: targetMachine, selector: query, ...(exactHome && { homeEpoch: exactHome.epoch }) } : undefined;
    const fanOut = selector.kind === "bare" && !exactHome;
    if (useRelays && fanOut && [...remoteHomes].some(id => !peers.some(peer => peer.machineId === id))) return refused("incomplete");
    if (!peers.length) return relayTarget ? relayPlan(relayTarget) : exactHome || selector.kind === "qualified" ? refused("not-configured") : refused("no-match");
    const lookups = await Promise.all(peers.map(async peer => {
      const request: Extract<V0AgentRequest, { kind: "lookup" }> = {
        version: 1, requestId: randomUUID(), toMachineId: peer.machineId, from: sourceWire, kind: "lookup", selector: query,
      };
      let absent = false;
      const result = await callPeer(configured, peer, request, deadline, deadline, signal, undefined,
        useRelays ? () => { absent = true; } : undefined);
      return { peer, request, result, absent };
    }));
    const candidates: { peer: Peer; endpoint: V0Endpoint }[] = [];
    let incomplete = false;
    for (const { peer, request, result, absent } of lookups) {
      if (absent && relayTarget) return relayPlan(relayTarget, peer);
      if (result.kind === "matches") {
        const bad = result.targets.map(endpoint => !matching(endpoint, request) ? "unauthorized" as const
          : homeCode(byId(endpoint.address.sessionId), peer.machineId, endpoint.homeEpoch)).find(code => code !== null);
        if (!bad) {
          for (const endpoint of result.targets) candidates.push({ peer, endpoint });
          continue;
        }
        if (!fanOut) return refused(bad);
      } else if (!fanOut) {
        return result.kind === "refused" ? result : refused("incomplete");
      }
      incomplete = true;
    }
    if (candidates.length > 1) return refused("ambiguous");
    if (incomplete && useRelays || !candidates.length) return refused(incomplete ? "incomplete" : exactHome ? "offline" : "no-match");
    const { peer, endpoint } = candidates[0];
    if (endpoint.address.sessionId === source.address.sessionId) return refused("self");
    const pinnedPeer = { ...peer }, pinnedTarget = { ...endpoint, address: { ...endpoint.address } };
    const label = `${encodeURIComponent(peer.alias)}/${encodeURIComponent(endpoint.name ?? endpoint.address.sessionId)}`;

    function relayPlan(target: RelayTarget, unavailablePeer?: Peer): V0SendPlan {
      const targetMachine = machineLabel(target.machineId);
      return { kind: "remote", label: `${encodeURIComponent(targetMachine)}/${encodeURIComponent(target.selector.value)}`,
        ask: async () => ({ ...refused("unsupported"), targetMachine }),
        async send(message, abort) {
          const deadline = performance.now() + V0_INTERCOM_MS;
          const checked = await revalidate(target, unavailablePeer, deadline, abort);
          if ("kind" in checked) return { ...checked, targetMachine };
          if (checked.current.version !== 2) return { ...refused("changed"), targetMachine };
          return submit(checked.current, target, message, deadline, abort);
        } };
    }

    function submit(current: V0Routes, target: RelayTarget, message: V0Text, deadline: number, abort?: AbortSignal) {
      const budget = AbortSignal.timeout(Math.max(0, Math.floor(deadline - performance.now())));
      return routeV0Relay(current, machineLabel(target.machineId), { type: "submit", kind: "send", from: sourceWire, target, message },
        abort ? AbortSignal.any([abort, budget]) : budget);
    }

    async function revalidate(target: RelayTarget, pinnedPeer: Peer | undefined, deadline: number, abort?: AbortSignal) {
      let identity: RoamConfig, current: V0Routes;
      try { identity = readLocalIdentity(root); current = readV0Routes(root, identity); }
      catch { return refused("invalid-config"); }
      if (identity.machineId !== machineId || current.agentDir !== agentDir) return refused("changed");
      try {
        const code = await bounded(deadline, abort, () => withHomes(root, identity, async homes => {
          const sourceHome = await homes.read(source.address.sessionId as SessionId);
          const sourceCode = homeCode(sourceHome, identity.machineId, source.homeEpoch);
          if (sourceCode) return sourceCode;
          if (identity.role === "box" && target.machineId === identity.hubMachineId) return "reply-only";
          if (target.selector.by === "name") return null;
          const targetHome = await homes.read(target.selector.value as SessionId);
          if (targetHome && identity.role === "box" && targetHome.machineId === identity.hubMachineId) return "reply-only";
          return homeCode(targetHome, target.machineId, target.homeEpoch);
        }));
        if (code) return refused(code);
      } catch { return refused(abort?.aborted || performance.now() >= deadline ? "unreachable" : "home-unreadable"); }
      const currentPeer = current.sendTo.find(item => item.machineId === target.machineId);
      if (pinnedPeer ? !currentPeer || !samePeer(currentPeer, pinnedPeer) : currentPeer) return refused("changed");
      try {
        const active = await bounded(deadline, abort, s => broker(current.agentDir,
          { kind: "lookup", scopeId: source.address.scopeId, selector: { by: "id", value: source.address.sessionId } }, s));
        if (active.kind === "refused") return active.code === "reply-only" ? refused("unreachable") : active;
        if (active.kind !== "matches" || active.targets.length !== 1 || !sameEndpoint(active.targets[0], source)) return refused("changed");
      } catch { return refused("unreachable"); }
      return { current, currentPeer };
    }

    async function dispatch(kind: "deliver" | "ask", message: V0Text, timeoutMs: number | undefined, abort?: AbortSignal) {
      if (kind === "ask" && (!Number.isSafeInteger(timeoutMs) || timeoutMs! <= 0)) return refused("invalid");
      const started = performance.now();
      const askMs = kind === "ask" ? Math.min(timeoutMs!, V0_ASK_MAX_MS) : undefined;
      const askDeadline = askMs === undefined ? undefined : started + askMs;
      const setupDeadline = askDeadline ?? started + V0_INTERCOM_MS;
      // Leave time for the ask result and Herdr's post-check after the ask's timeout.
      const deadline = askMs === undefined ? setupDeadline
        : started + Math.min(DEFAULT_LIMITS.directMs, askMs + ASK_REPLY_RESERVE_MS + POST_CHECK_MS);
      const target: RelayTarget = { machineId: pinnedPeer.machineId,
        selector: { by: "id", value: pinnedTarget.address.sessionId }, homeEpoch: pinnedTarget.homeEpoch };
      const route = useRelays && kind === "deliver" ? { path: "direct" as const, targetMachine: pinnedPeer.alias } : {};
      const checked = await revalidate(target, pinnedPeer, Math.min(deadline, setupDeadline), abort);
      if ("kind" in checked) return { ...checked, ...route };
      const common = { version: 1 as const, requestId: randomUUID(), toMachineId: pinnedPeer.machineId,
        from: sourceWire, target: pinnedTarget, message };
      const request: V0AgentRequest = kind === "deliver" ? { ...common, kind: "deliver" }
        : { ...common, kind: "ask", timeoutMs: askMs! };
      let absent = false;
      const result = await callPeer(checked.current, checked.currentPeer!, request, deadline, setupDeadline, abort, undefined,
        useRelays && checked.current.version === 2 && kind === "deliver" ? () => { absent = true; } : undefined);
      if (absent) return submit(checked.current, target, message, setupDeadline, abort);
      return { ...(result.kind === "matches" ? { kind: "unknown" as const, id: message.id } : result), ...route };
    }
    return { kind: "remote", label,
      send: (message, abort) => dispatch("deliver", message, undefined, abort),
      ask: (message, timeoutMs, abort) => dispatch("ask", message, timeoutMs, abort) };
  };

  async function handle(raw: unknown): Promise<V0AgentReply | null> {
    const wire = parseV0AgentRequest(raw) ?? parseV0RelayAgentRequest(raw);
    if (!wire) return null;
    const deadline = performance.now() + (wire.version === 1 && wire.kind === "ask" ? wire.timeoutMs : V0_INTERCOM_MS);
    let config: RoamConfig;
    try { config = readLocalIdentity(root); } catch { return null; }
    return receive(config, wire, deadline);
  }
  return { prepare, handle };
}

function createV0AgentReceiver(root: string, broker: typeof requestV0Broker) {
  return async function receive(config: RoamConfig, wire: V0WireRequest, deliveryDeadline: number,
    signal?: AbortSignal, onDeliveryHandOff?: () => void): Promise<V0AgentReply> {
    const request = wire.version === 2 ? wire.request : wire;
    const envelope = (result: V0Reply): V0AgentReply => ({ version: 1, requestId: request.requestId, machineId: config.machineId, ...result });
    if (request.toMachineId !== config.machineId || wire.version === 1 && config.role === "hub")
      return envelope(refused("unauthorized"));
    let configured: V0Routes;
    try { configured = readV0Routes(root, config); } catch { return envelope(refused("invalid-config")); }
    if (wire.version === 2) {
      if (configured.version !== 2 || !configured.relays.includes(wire.relayId)) return envelope(refused("unauthorized"));
      if (config.role === "hub") return envelope(refused("reply-only"));
    }
    const source = configured.acceptFrom.find(peer => peer.machineId === request.from.machineId);
    if (!source) return envelope(refused("unauthorized"));
    try {
      const code = await bounded(deliveryDeadline, signal, () => withHomes(root, config, async homes => {
        const sourceHome = await homes.read(request.from.address.sessionId as SessionId);
        const sourceCode = homeCode(sourceHome, request.from.machineId, request.from.homeEpoch);
        if (sourceCode) return sourceCode;
        if (request.kind !== "lookup") {
          if (request.target.address.scopeId !== request.from.address.scopeId) return "unauthorized";
          return homeCode(await homes.read(request.target.address.sessionId as SessionId), config.machineId, request.target.homeEpoch);
        }
        return null;
      }));
      if (code) return envelope(refused(code));
    } catch { return envelope(refused(signal?.aborted || performance.now() >= deliveryDeadline ? "unreachable" : "home-unreadable")); }

    let result: V0Reply;
    try {
      if (request.kind === "lookup") {
        result = await bounded(deliveryDeadline, signal, brokerSignal => broker(configured.agentDir,
          { kind: "lookup", scopeId: request.from.address.scopeId, selector: request.selector }, brokerSignal));
      } else if (request.kind === "deliver") {
        result = await bounded(deliveryDeadline, signal, brokerSignal => {
          const from = v0BrokerOrigin(request.from, source.alias);
          // A local relay hands off here, after the same checks as a remote receipt.
          onDeliveryHandOff?.();
          return broker(configured.agentDir, { kind: "deliver", from, target: request.target, message: request.message }, brokerSignal);
        });
      } else {
        const remaining = Math.floor(deliveryDeadline - performance.now());
        if (remaining <= 0 || performance.now() >= deliveryDeadline) return envelope(refused("unreachable"));
        result = await broker(configured.agentDir, { kind: "ask", from: v0BrokerOrigin(request.from, source.alias), target: request.target,
          message: request.message, timeoutMs: Math.min(remaining, V0_ASK_MAX_MS) });
      }
    } catch {
      result = request.kind === "lookup" ? refused("unreachable") : { kind: "unknown", id: request.message.id };
    }
    if (wire.version === 1 && result.kind === "refused" && result.code === "reply-only") result = request.kind === "lookup"
      ? refused("unreachable") : { kind: "unknown", id: request.message.id };
    if (request.kind === "lookup" && result.kind === "matches") {
      if (result.targets.some(endpoint => !matching(endpoint, request))) return envelope(refused("unauthorized"));
      try {
        const targets = result.targets;
        const code = await bounded(deliveryDeadline, signal, () => withHomes(root, config, async homes => {
          for (const endpoint of targets) {
            const stale = homeCode(await homes.read(endpoint.address.sessionId as SessionId), config.machineId, endpoint.homeEpoch);
            if (stale) return stale;
          }
          return null;
        }));
        if (code) return envelope(refused(code));
      } catch { return envelope(refused(signal?.aborted || performance.now() >= deliveryDeadline ? "unreachable" : "home-unreadable")); }
    }
    const answer = envelope(result);
    return parseV0AgentReply(answer) ? answer : envelope(request.kind === "lookup"
      ? refused("incomplete") : { kind: "unknown", id: request.message.id });
  };
}

/** The poll carrier has already bound the origin to its linked peer. Never route a submission to another relay. */
export function createV0RelayForwarder(root: string, deps: V0IntercomDeps = {}):
  (submit: RelaySubmit, signal?: AbortSignal) => Promise<RelayResult> {
  const callPeer = createV0PeerCaller(root, deps);
  const receive = createV0AgentReceiver(root, deps.broker ?? requestV0Broker);
  return async (submit, signal) => {
    const { from, target, message } = submit;
    const refuse = (code: V0Code) => relayRefused(message.id, code);
    if (submit.kind !== "send") return refuse("unsupported");
    const deadline = performance.now() + V0_INTERCOM_MS;
    let attempted = false;
    const handOff = () => { attempted = true; };
    let config: RoamConfig, configured: V0Routes;
    try { config = readLocalIdentity(root); configured = readV0Routes(root, config); }
    catch { return refuse("invalid-config"); }
    if (configured.version !== 2 || !configured.relays.includes(config.machineId)) return refuse("unauthorized");
    if (target.machineId === config.hubMachineId) return refuse("reply-only");
    const local = target.machineId === config.machineId;
    const peer = local ? undefined : configured.sendTo.find(entry => entry.machineId === target.machineId);
    if (!local && !peer) return refuse("not-configured");

    async function checkHomes(identity: RoamConfig, targetId?: string, epoch?: number): Promise<V0Code | null> {
      try {
        return await bounded(deadline, signal, () => withHomes(root, identity, async homes => {
          const sourceCode = homeCode(await homes.read(from.address.sessionId as SessionId), from.machineId, from.homeEpoch);
          if (sourceCode || targetId === undefined) return sourceCode;
          return homeCode(await homes.read(targetId as SessionId), target.machineId, epoch);
        }));
      } catch { return signal?.aborted || performance.now() >= deadline ? "unreachable" : "home-unreadable"; }
    }

    async function exchange(request: V0RelayAgentRequest["request"], identity: RoamConfig, routes: V0Routes, pinned?: Peer): Promise<V0Reply> {
      const wire: V0RelayAgentRequest = { version: 2, relayId: config.machineId, request };
      if (pinned) return callPeer(routes, pinned, wire, deadline, deadline, signal, handOff);
      if (!parseV0RelayAgentRequest(wire)) return refused("invalid");
      return replyResult(await receive(identity, wire, deadline, signal, handOff));
    }

    try {
      const knownId = target.selector.by === "id" ? target.selector.value : undefined;
      const stale = await checkHomes(config, knownId, target.homeEpoch);
      if (stale) return refuse(stale);
      if (knownId === from.address.sessionId) return refuse("self");
      const header = { version: 1 as const, toMachineId: target.machineId, from };
      const lookup = { ...header, kind: "lookup" as const, requestId: randomUUID(), selector: target.selector };
      const found = await exchange(lookup, config, configured, peer);
      if (found.kind === "refused") return refuse(found.code);
      if (found.kind !== "matches") return refuse("incomplete");
      if (found.targets.some(endpoint => !matching(endpoint, lookup))) return refuse("unauthorized");
      if (found.targets.length > 1) return refuse("ambiguous");
      const [endpoint] = found.targets;
      if (!endpoint) return refuse(knownId === undefined ? "no-match" : "offline");
      if (endpoint.address.sessionId === from.address.sessionId) return refuse("self");
      if (target.homeEpoch !== undefined && target.homeEpoch !== endpoint.homeEpoch) return refuse("changed");
      const pinnedTarget = { ...endpoint, address: { ...endpoint.address } };

      let identity: RoamConfig, current: V0Routes;
      try { identity = readLocalIdentity(root); current = readV0Routes(root, identity); }
      catch { return refuse("invalid-config"); }
      if (identity.machineId !== config.machineId || identity.hubMachineId !== config.hubMachineId ||
          identity.role !== config.role || current.agentDir !== configured.agentDir) return refuse("changed");
      if (current.version !== 2 || !current.relays.includes(identity.machineId)) return refuse("unauthorized");
      const currentPeer = peer && current.sendTo.find(entry => entry.machineId === peer.machineId);
      if (peer) {
        if (!currentPeer || !samePeer(peer, currentPeer)) return refuse("changed");
        const stale = await checkHomes(identity, pinnedTarget.address.sessionId, pinnedTarget.homeEpoch);
        if (stale) return refuse(stale);
      }
      const outcome = await exchange({ ...header, kind: "deliver", requestId: randomUUID(), target: pinnedTarget, message },
        identity, current, currentPeer);
      if (!attempted) return refuse(outcome.kind === "refused" ? outcome.code : "unreachable");
      if (outcome.kind === "refused" || outcome.kind === "socket_delivered" && outcome.id === message.id)
        return { type: "result", messageId: message.id, attempted: true, outcome };
      return relayUnknown(message.id);
    } catch { return attempted ? relayUnknown(message.id) : refuse("unreachable"); }
  };
}
