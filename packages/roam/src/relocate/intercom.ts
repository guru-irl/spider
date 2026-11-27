import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { openRoamPathReadOnly } from "@spider/db-core/roam/reads";
import { HerdrError } from "@spider/herdr/client/parse";
import { requestV0Broker } from "@spider/intercom/broker/roam-v0-client";
import {
  parseV0AgentReply, parseV0AgentRequest, v0BrokerOrigin, v0ExplicitName, V0_ASK_MAX_MS, V0_INTERCOM_BYTES, V0_INTERCOM_MS,
  type V0AgentReply, type V0AgentRequest, type V0Code, type V0Endpoint, type V0Prepare, type V0Refused, type V0Reply, type V0Text,
} from "@spider/intercom/roam-v0";
import type { LocalSessionInfo } from "@spider/intercom/types";
import { DEFAULT_LIMITS, type Peer, type RoamConfig, type Transport } from "../contracts";
import { readLocalIdentity } from "../runtime";
import { createTransport } from "../transport";
import { createHomeStore } from "./home";
import { localHerdrConnection } from "./local";
import { isV0Alias, readV0Routes, type V0Routes } from "./intercom-routes";
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

function homeCode(home: RelocateHome | null, machineId: string, epoch: number): V0Code | null {
  if (!home) return "changed";
  if (home.state === "moving") return "moving";
  if (home.state === "stopped") return "offline";
  if (home.machineId !== machineId || home.epoch !== epoch) return "changed";
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

export function createV0Intercom(root: string, deps: V0IntercomDeps = {}): {
  prepare: V0Prepare;
  handle(raw: unknown): Promise<V0AgentReply | null>;
} {
  const broker = deps.broker ?? requestV0Broker;

  async function callPeer(configured: V0Routes, peer: Peer, request: V0AgentRequest, deadline: number,
    deliveryDeadline: number, signal?: AbortSignal): Promise<V0Reply> {
    if (!parseV0AgentRequest(request)) return refused("invalid");
    let invoked = false;
    try {
      return await bounded(deadline, signal, async callSignal => {
        const transport = deps.transport?.(configured.sendTo) ?? createTransport({ ...localHerdrConnection(root), enrolled: configured.sendTo });
        const resolveMs = Math.floor(Math.min(deadline, deliveryDeadline) - performance.now());
        if (resolveMs <= 0) throw new Error("Intercom delivery deadline expired");
        const target = await bounded(Math.min(deadline, deliveryDeadline), callSignal,
          resolveSignal => transport.resolve(peer, { timeoutMs: resolveMs, signal: resolveSignal }));
        if (callSignal.aborted || performance.now() >= deliveryDeadline) throw new Error("Intercom delivery deadline expired");
        const remaining = Math.floor(deadline - performance.now());
        if (remaining <= POST_CHECK_MS) throw new Error("Intercom post-check reserve unavailable");
        const input = request.kind === "lookup" ? { stdin: Buffer.from(JSON.stringify(request)) } : {
          stdinForTimeout: (remoteMs: number) => {
            const deliveryMs = Math.floor(deliveryDeadline - performance.now());
            if (callSignal.aborted || deliveryMs <= 0) throw new Error("Intercom delivery deadline expired");
            let outbound = request;
            if (request.kind === "ask") {
              // Herdr starts this window before the remote agent reads stdin.
              const timeoutMs = Math.min(request.timeoutMs, deliveryMs, remoteMs - REMOTE_ASK_STARTUP_MS);
              if (timeoutMs <= 0) throw new Error("Intercom ask deadline expired");
              outbound = { ...request, timeoutMs };
            }
            const body = Buffer.from(JSON.stringify(outbound));
            invoked = true;
            return body;
          },
        };
        const output = await transport.exec(target, ["roam", "agent", "--v0", "intercom"], {
          timeoutMs: remaining, maxBytes: V0_INTERCOM_BYTES, postReserveMs: POST_CHECK_MS, signal: callSignal, ...input,
        });
        if (!Buffer.isBuffer(output) || output.length > V0_INTERCOM_BYTES) throw new Error("Invalid intercom reply size");
        const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output));
        const reply = parseV0AgentReply(raw);
        if (!reply || reply.requestId !== request.requestId || reply.machineId !== peer.machineId ||
            reply.kind === "refused" && reply.code === "reply-only") throw new Error("Uncorrelated intercom reply");
        const { version: _version, requestId: _requestId, machineId: _machineId, ...result } = reply;
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
      return refused(error instanceof HerdrError && (error.code === "machine-not-found" || error.code === "machine-ambiguous")
        ? "invalid-config" : "unreachable");
    }
  }

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
    const exactHome = unqualifiedHome ?? (qualifiedPeer && qualifiedHome?.machineId === qualifiedPeer.machineId ? qualifiedHome : null);
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
    if (qualifiedPeer && qualifiedHome && qualifiedHome.machineId !== qualifiedPeer.machineId) return refused("no-match");

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

    const peers = exactHome ? configured.sendTo.filter(peer => peer.machineId === exactHome.machineId)
      : selector.kind === "qualified" ? configured.sendTo.filter(peer => peer.alias.toLowerCase() === selector.machine.toLowerCase())
      : configured.sendTo.filter(peer => all.some(home => home.machineId === peer.machineId && home.state === "running"));
    if (!peers.length) return exactHome || selector.kind === "qualified" ? refused("not-configured") : refused("no-match");
    const query = exactHome ? { by: "id" as const, value: exactHome.sessionId }
      : { by: "name" as const, value: selector.value };
    const sourceWire = { ...source, machineId };
    const agentDir = configured.agentDir;
    const lookups = await Promise.all(peers.map(async peer => {
      const request: Extract<V0AgentRequest, { kind: "lookup" }> = {
        version: 1, requestId: randomUUID(), toMachineId: peer.machineId, from: sourceWire, kind: "lookup", selector: query,
      };
      return { peer, request, result: await callPeer(configured, peer, request, deadline, deadline, signal) };
    }));
    const candidates: { peer: Peer; endpoint: V0Endpoint }[] = [];
    const fanOut = selector.kind === "bare" && !exactHome;
    let incomplete = false;
    for (const { peer, request, result } of lookups) {
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
    if (!candidates.length) return refused(incomplete ? "incomplete" : exactHome ? "offline" : "no-match");
    const { peer, endpoint } = candidates[0];
    if (endpoint.address.sessionId === source.address.sessionId) return refused("self");
    const pinnedPeer = { ...peer }, pinnedTarget = { ...endpoint, address: { ...endpoint.address } };
    const label = `${encodeURIComponent(peer.alias)}/${encodeURIComponent(endpoint.name ?? endpoint.address.sessionId)}`;

    async function dispatch(kind: "deliver" | "ask", message: V0Text, timeoutMs: number | undefined, abort?: AbortSignal) {
      if (kind === "ask" && (!Number.isSafeInteger(timeoutMs) || timeoutMs! <= 0)) return refused("invalid");
      const started = performance.now();
      const askMs = kind === "ask" ? Math.min(timeoutMs!, V0_ASK_MAX_MS) : undefined;
      const askDeadline = askMs === undefined ? undefined : started + askMs;
      const setupDeadline = askDeadline ?? started + V0_INTERCOM_MS;
      // Leave time for the ask result and Herdr's post-check after the ask's timeout.
      const deadline = askMs === undefined ? setupDeadline
        : started + Math.min(DEFAULT_LIMITS.directMs, askMs + ASK_REPLY_RESERVE_MS + POST_CHECK_MS);
      let identity: RoamConfig, current: V0Routes;
      try { identity = readLocalIdentity(root); current = readV0Routes(root, identity); }
      catch { return refused("invalid-config"); }
      if (identity.machineId !== machineId || current.agentDir !== agentDir) return refused("changed");
      try {
        const code = await withHomes(root, identity, async homes => {
          const sourceHome = await homes.read(source.address.sessionId as SessionId);
          const sourceCode = homeCode(sourceHome, identity.machineId, source.homeEpoch);
          if (sourceCode) return sourceCode;
          const targetHome = await homes.read(pinnedTarget.address.sessionId as SessionId);
          if (targetHome && identity.role === "box" && targetHome.machineId === identity.hubMachineId) return "reply-only";
          return homeCode(targetHome, pinnedPeer.machineId, pinnedTarget.homeEpoch);
        });
        if (code) return refused(code);
      } catch { return refused("home-unreadable"); }
      const currentPeer = current.sendTo.find(item => item.machineId === pinnedPeer.machineId);
      if (!currentPeer || !samePeer(currentPeer, pinnedPeer)) return refused("changed");
      try {
        const active = await bounded(Math.min(deadline, setupDeadline), abort, s => broker(current.agentDir,
          { kind: "lookup", scopeId: source.address.scopeId, selector: { by: "id", value: source.address.sessionId } }, s));
        if (active.kind === "refused") return active.code === "reply-only" ? refused("unreachable") : active;
        if (active.kind !== "matches" || active.targets.length !== 1 || !sameEndpoint(active.targets[0], source)) return refused("changed");
      } catch { return refused("unreachable"); }
      const common = { version: 1 as const, requestId: randomUUID(), toMachineId: pinnedPeer.machineId,
        from: sourceWire, target: pinnedTarget, message };
      const request: V0AgentRequest = kind === "deliver" ? { ...common, kind: "deliver" }
        : { ...common, kind: "ask", timeoutMs: askMs! };
      const result = await callPeer(current, currentPeer, request, deadline, setupDeadline, abort);
      return result.kind === "matches" ? { kind: "unknown" as const, id: message.id } : result;
    }
    return { kind: "remote", label,
      send: (message, abort) => dispatch("deliver", message, undefined, abort),
      ask: (message, timeoutMs, abort) => dispatch("ask", message, timeoutMs, abort) };
  };

  async function handle(raw: unknown): Promise<V0AgentReply | null> {
    const request = parseV0AgentRequest(raw);
    if (!request) return null;
    const started = performance.now();
    const askDeadline = request.kind === "ask" ? started + request.timeoutMs : undefined;
    const deliveryDeadline = askDeadline ?? started + V0_INTERCOM_MS;
    let config: RoamConfig;
    try { config = readLocalIdentity(root); } catch { return null; }
    const envelope = (result: V0Reply): V0AgentReply => ({ version: 1, requestId: request.requestId, machineId: config.machineId, ...result });
    if (config.role === "hub" || request.toMachineId !== config.machineId) return envelope(refused("unauthorized"));
    let configured: V0Routes;
    try { configured = readV0Routes(root, config); } catch { return envelope(refused("invalid-config")); }
    const source = configured.acceptFrom.find(peer => peer.machineId === request.from.machineId);
    if (!source) return envelope(refused("unauthorized"));
    try {
      const code = await bounded(deliveryDeadline, undefined, () => withHomes(root, config, async homes => {
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
    } catch { return envelope(refused(performance.now() >= deliveryDeadline ? "unreachable" : "home-unreadable")); }

    let result: V0Reply;
    try {
      if (request.kind === "lookup") {
        result = await bounded(deliveryDeadline, undefined, signal => broker(configured.agentDir,
          { kind: "lookup", scopeId: request.from.address.scopeId, selector: request.selector }, signal));
      } else if (request.kind === "deliver") {
        result = await bounded(deliveryDeadline, undefined, signal => broker(configured.agentDir,
          { kind: "deliver", from: v0BrokerOrigin(request.from, source.alias), target: request.target, message: request.message }, signal));
      } else {
        const remaining = Math.floor(askDeadline! - performance.now());
        if (remaining <= 0 || performance.now() >= deliveryDeadline) return envelope(refused("unreachable"));
        result = await broker(configured.agentDir, { kind: "ask", from: v0BrokerOrigin(request.from, source.alias), target: request.target,
          message: request.message, timeoutMs: Math.min(remaining, V0_ASK_MAX_MS) });
      }
    } catch {
      result = request.kind === "lookup" ? refused("unreachable") : { kind: "unknown", id: request.message.id };
    }
    if (result.kind === "refused" && result.code === "reply-only") result = request.kind === "lookup"
      ? refused("unreachable") : { kind: "unknown", id: request.message.id };
    if (request.kind === "lookup" && result.kind === "matches") {
      if (result.targets.some(endpoint => !matching(endpoint, request))) return envelope(refused("unauthorized"));
      try {
        const targets = result.targets;
        const code = await bounded(deliveryDeadline, undefined, () => withHomes(root, config, async homes => {
          for (const endpoint of targets) {
            const stale = homeCode(await homes.read(endpoint.address.sessionId as SessionId), config.machineId, endpoint.homeEpoch);
            if (stale) return stale;
          }
          return null;
        }));
        if (code) return envelope(refused(code));
      } catch { return envelope(refused(performance.now() >= deliveryDeadline ? "unreachable" : "home-unreadable")); }
    }
    const answer = envelope(result);
    return parseV0AgentReply(answer) ? answer : envelope(request.kind === "lookup"
      ? refused("incomplete") : { kind: "unknown", id: request.message.id });
  }
  return { prepare, handle };
}
