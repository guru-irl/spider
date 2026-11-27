import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { openRoamPathReadOnly } from "@spider/db-core/roam/reads";
import type { MachineId } from "@spider/db-core/roam/types";
import { requestV0Broker } from "@spider/intercom/broker/roam-v0-client";
import {
  parseV0AgentReply, parseV0AgentRequest, V0_ASK_MAX_MS, V0_INTERCOM_BYTES, V0_INTERCOM_MS,
  type V0AgentReply, type V0AgentRequest, type V0Code, type V0Endpoint, type V0Prepare, type V0Refused, type V0Reply, type V0Text,
} from "@spider/intercom/roam-v0";
import type { LocalSessionInfo, RemoteSessionInfo } from "@spider/intercom/types";
import { readPeer } from "../config";
import type { Peer, RoamConfig, Transport } from "../contracts";
import { loadHerdrConfig } from "../host-config";
import { isMachineId } from "../machine-id";
import { readLocalIdentity } from "../runtime";
import { createTransport } from "../transport";
import { createHomeStore } from "./home";
import { localHerdrConnection } from "./local";
import type { RelocateHome, SessionId } from "./types";

export interface V0IntercomDeps {
  broker?: typeof requestV0Broker;
  transport?: (peers: readonly Peer[]) => Pick<Transport, "resolve" | "exec">;
}

interface AcceptedPeer { machineId: MachineId; alias: string }
interface Settings { config: RoamConfig; agentDir: string; sendTo: readonly Peer[]; acceptFrom: readonly AcceptedPeer[] }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function alias(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255 && value.trim() === value
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
function distinct(peers: readonly { machineId: string; alias: string }[], local: string): boolean {
  return peers.every(peer => peer.machineId !== local) && new Set(peers.map(peer => peer.machineId)).size === peers.length
    && new Set(peers.map(peer => peer.alias.toLowerCase())).size === peers.length;
}

/** A present but invalid file opts in and fails closed rather than falling back to federation. */
export function hasV0IntercomConfig(root: string): boolean {
  try { lstatSync(join(root, "roam", "intercom-v0.json")); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

function settings(root: string): Settings {
  const config = readLocalIdentity(root);
  if (!config.enabled || config.intercom.enabled) throw new Error("Intercom v0 is not enabled");
  const file = join(root, "roam", "intercom-v0.json");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let value: unknown;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 ||
        typeof process.getuid === "function" && stat.uid !== process.getuid() ||
        process.platform !== "win32" && (stat.mode & 0o7777) !== 0o600) throw new Error("Unsafe intercom configuration");
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(fd)));
  } finally { closeSync(fd); }
  if (!object(value) || !keys(value, ["version", "sendTo", "acceptFrom"]) || value.version !== 1 ||
      !Array.isArray(value.sendTo) || value.sendTo.length > 8 || !Array.isArray(value.acceptFrom) || value.acceptFrom.length > 8)
    throw new Error("Invalid intercom configuration");
  const sendTo = value.sendTo.map(readPeer);
  if (sendTo.some(peer => !peer.agentDir || !isAbsolute(peer.agentDir) || !alias(peer.alias)) ||
      !distinct(sendTo, config.machineId) || config.role === "box" && sendTo.some(peer => peer.machineId === config.hubMachineId))
    throw new Error("Invalid intercom routes");
  const acceptFrom = value.acceptFrom.map((entry): AcceptedPeer => {
    if (!object(entry) || !keys(entry, ["machineId", "alias"]) || !isMachineId(entry.machineId) || !alias(entry.alias))
      throw new Error("Invalid intercom source");
    return { machineId: entry.machineId, alias: entry.alias };
  });
  if (!distinct(acceptFrom, config.machineId)) throw new Error("Invalid intercom sources");
  const agentDir = loadHerdrConfig(root).agentDirectory;
  if (!isAbsolute(agentDir) || process.env.PI_CODING_AGENT_DIR !== undefined && process.env.PI_CODING_AGENT_DIR !== agentDir)
    throw new Error("Intercom agent directory mismatch");
  return { config, agentDir, sendTo, acceptFrom };
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
function origin(request: V0AgentRequest, source: AcceptedPeer): RemoteSessionInfo {
  return {
    remote: true, id: request.from.address.sessionId, address: request.from.address,
    machineId: request.from.machineId, machineAlias: source.alias, homeEpoch: request.from.homeEpoch,
    activationEpoch: request.from.endpointEpoch, endpointEpoch: request.from.endpointEpoch,
    ...(request.from.name === null ? {} : { name: request.from.name }),
    cwd: "", model: "", startedAt: 0, lastActivity: 0,
  };
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
  return { address: { ...session.address }, name: session.runtimeFallbackAlias ? null : session.name ?? null,
    homeEpoch: session.v0HomeEpoch, endpointEpoch: session.endpointEpoch };
}
function samePeer(a: Peer, b: Peer): boolean {
  return a.machineId === b.machineId && a.alias === b.alias && a.node === b.node && a.pi === b.pi &&
    a.cli === b.cli && a.core === b.core && a.globalRoot === b.globalRoot && a.agentDir === b.agentDir && a.coreUnit === b.coreUnit;
}
function selectedTarget(to: string): { kind: "bare"; value: string } | { kind: "qualified"; machine: string; value: string } | null {
  if (!to || to.length > 1024 || /[\u0000-\u001f\u007f-\u009f]/.test(to)) return null;
  const slash = to.indexOf("/");
  if (slash < 0) return { kind: "bare", value: to };
  if (to.indexOf("/", slash + 1) >= 0) return null;
  try {
    const machine = decodeURIComponent(to.slice(0, slash)), value = decodeURIComponent(to.slice(slash + 1));
    return alias(machine) && value.length > 0 && value.length <= 256 && value.trim().length > 0 &&
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
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error !== null) reject(error); else resolve(value as T);
    };
    const abort = () => { controller.abort(); finish(new Error("Intercom request aborted")); };
    const timer = setTimeout(abort, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    Promise.resolve().then(() => work(controller.signal)).then(value => finish(null, value), error => finish(error));
  });
}

export function createV0Intercom(root: string, deps: V0IntercomDeps = {}): {
  prepare: V0Prepare;
  handle(raw: unknown): Promise<V0AgentReply | null>;
} {
  const broker = deps.broker ?? requestV0Broker;

  async function callPeer(configured: Settings, peer: Peer, request: V0AgentRequest, deadline: number,
    deliveryDeadline: number, signal?: AbortSignal, askDeadline?: number): Promise<V0Reply> {
    if (!parseV0AgentRequest(request)) return refused("invalid");
    let invoked = false;
    try {
      return await bounded(deadline, signal, async callSignal => {
        const transport = deps.transport?.(configured.sendTo) ?? createTransport({ ...localHerdrConnection(root), enrolled: configured.sendTo });
        const resolveMs = Math.floor(Math.min(deadline, deliveryDeadline) - performance.now());
        if (resolveMs <= 0) throw new Error("Intercom delivery deadline expired");
        const target = await transport.resolve(peer, { timeoutMs: resolveMs, signal: callSignal });
        if (callSignal.aborted || performance.now() >= deliveryDeadline) throw new Error("Intercom delivery deadline expired");
        const remaining = Math.floor(deadline - performance.now());
        if (remaining <= 2000) throw new Error("Intercom post-check reserve unavailable");
        const bytes = Buffer.from(JSON.stringify(request));
        const input = request.kind !== "ask" ? { stdin: bytes } : {
          stdinForTimeout: (_remoteMs: number) => {
            if (callSignal.aborted || performance.now() >= deliveryDeadline) throw new Error("Intercom delivery deadline expired");
            const askMs = Math.floor((askDeadline ?? deadline) - performance.now());
            if (askMs <= 0) throw new Error("Intercom ask deadline expired");
            return Buffer.from(JSON.stringify({ ...request, timeoutMs: Math.min(request.timeoutMs, askMs) }));
          },
        };
        invoked = true;
        const output = await transport.exec(target, ["roam", "agent", "--v0", "intercom"], {
          timeoutMs: remaining, maxBytes: V0_INTERCOM_BYTES, postReserveMs: 2000, signal: callSignal, ...input,
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
    } catch {
      return request.kind !== "lookup" && invoked ? { kind: "unknown", id: request.message.id } : refused("unreachable");
    }
  }

  const prepare: V0Prepare = async ({ to, from, locals, signal }) => {
    const selector = selectedTarget(to);
    if (!selector) return refused("invalid");
    let configured: Settings;
    try { configured = settings(root); } catch { return refused("not-configured"); }
    let all: readonly RelocateHome[];
    try { all = await withHomes(root, configured.config, homes => homes.list()); }
    catch { return refused("unreachable"); }
    const byId = (id: string) => all.find(home => home.sessionId === id) ?? null;
    const senderHome = byId(from.address?.sessionId ?? from.id);
    const exactHome = byId(to);
    const macQualifiedHome = selector.kind === "qualified" && configured.acceptFrom.some(peer =>
      peer.machineId === configured.config.hubMachineId && peer.alias.toLowerCase() === selector.machine.toLowerCase())
      ? byId(selector.value) : null;
    if (configured.config.role === "box" && (exactHome?.machineId === configured.config.hubMachineId ||
        macQualifiedHome?.machineId === configured.config.hubMachineId)) return refused("reply-only");
    if (!senderHome) {
      return selector.kind === "qualified" || exactHome && exactHome.machineId !== configured.config.machineId
        ? refused("not-configured") : { kind: "legacy" };
    }
    const source = endpointOf(from);
    if (!source || !locals.some(local => local.id === from.id && endpointOf(local) !== null && sameEndpoint(endpointOf(local)!, source)))
      return refused("changed");
    const senderCode = homeCode(senderHome, configured.config.machineId, source.homeEpoch);
    if (senderCode) return refused(senderCode);

    const localPlan = (target: LocalSessionInfo) => {
      if (target.id === from.id || target.address?.sessionId === source.address.sessionId) return refused("self");
      if (!target.endpointEpoch) return refused("changed");
      const home = byId(target.address?.sessionId ?? target.id);
      if (home) {
        const code = homeCode(home, configured.config.machineId, target.v0HomeEpoch ?? 0);
        if (code) return refused(code);
      } else if (target.v0HomeEpoch !== undefined) return refused("changed");
      return { kind: "local" as const, target: { id: target.id, endpointEpoch: target.endpointEpoch } };
    };

    if (exactHome) {
      if (exactHome.sessionId === source.address.sessionId) return refused("self");
      if (exactHome.state === "moving") return refused("moving");
      if (exactHome.state === "stopped") return refused("offline");
      if (exactHome.machineId === configured.config.machineId) {
        const local = locals.filter(item => item.address?.sessionId === exactHome.sessionId && item.address.scopeId === source.address.scopeId);
        return local.length > 1 ? refused("ambiguous") : local.length === 1 ? localPlan(local[0]) : refused("offline");
      }
    } else if (selector.kind === "bare") {
      const scoped = locals.filter(item => !item.address || item.address.scopeId === source.address.scopeId);
      let local = scoped.filter(item => item.id === to || item.address?.sessionId === to);
      if (!local.length) local = scoped.filter(item => item.name?.toLowerCase() === to.toLowerCase());
      if (!local.length) local = scoped.filter(item => item.id.startsWith(to));
      if (local.length) return local.length > 1 ? refused("ambiguous") : localPlan(local[0]);
    }

    const peers = exactHome ? configured.sendTo.filter(peer => peer.machineId === exactHome.machineId)
      : selector.kind === "qualified" ? configured.sendTo.filter(peer => peer.alias.toLowerCase() === selector.machine.toLowerCase())
      : configured.sendTo.filter(peer => all.some(home => home.machineId === peer.machineId && home.state === "running"));
    if (!peers.length) return exactHome || selector.kind === "qualified" ? refused("not-configured") : refused("no-match");
    const query = exactHome ? { by: "id" as const, value: exactHome.sessionId }
      : { by: "name" as const, value: selector.value };
    const sourceWire = { ...source, machineId: configured.config.machineId };
    const deadline = performance.now() + V0_INTERCOM_MS;
    const lookups = await Promise.all(peers.map(async peer => {
      const request: Extract<V0AgentRequest, { kind: "lookup" }> = {
        version: 1, requestId: randomUUID(), toMachineId: peer.machineId, from: sourceWire, kind: "lookup", selector: query,
      };
      return { peer, request, result: await callPeer(configured, peer, request, deadline, deadline, signal) };
    }));
    const candidates: { peer: Peer; endpoint: V0Endpoint }[] = [];
    for (const { peer, request, result } of lookups) {
      if (result.kind === "refused") {
        return selector.kind === "bare" && !exactHome && (result.code === "unreachable" || result.code === "unsupported")
          ? refused("incomplete") : result;
      }
      if (result.kind !== "matches") return refused("incomplete");
      for (const endpoint of result.targets) {
        if (!matching(endpoint, request)) return refused("unauthorized");
        const code = homeCode(byId(endpoint.address.sessionId), peer.machineId, endpoint.homeEpoch);
        if (code) return refused(code);
        candidates.push({ peer, endpoint });
      }
    }
    if (candidates.length > 1) return refused("ambiguous");
    if (!candidates.length) return refused(exactHome ? "offline" : "no-match");
    const { peer, endpoint } = candidates[0];
    if (endpoint.address.sessionId === source.address.sessionId) return refused("self");
    const pinnedPeer = { ...peer }, pinnedTarget = { ...endpoint, address: { ...endpoint.address } };
    const label = `${encodeURIComponent(peer.alias)}/${encodeURIComponent(endpoint.name ?? endpoint.address.sessionId)}`;

    async function dispatch(kind: "deliver" | "ask", message: V0Text, timeoutMs: number | undefined, abort?: AbortSignal) {
      if (kind === "ask" && (!Number.isSafeInteger(timeoutMs) || timeoutMs! <= 0)) return refused("invalid");
      const started = performance.now(), deliveryDeadline = started + V0_INTERCOM_MS;
      const askMs = kind === "ask" ? Math.min(timeoutMs!, V0_ASK_MAX_MS) : undefined;
      const askDeadline = askMs === undefined ? undefined : started + askMs;
      const deadline = started + (askMs === undefined ? V0_INTERCOM_MS : Math.min(V0_ASK_MAX_MS, askMs + 3000));
      let current: Settings;
      try { current = settings(root); } catch { return refused("not-configured"); }
      if (current.config.machineId !== configured.config.machineId || current.agentDir !== configured.agentDir) return refused("changed");
      try {
        const code = await withHomes(root, current.config, async homes => {
          const sourceHome = await homes.read(source.address.sessionId as SessionId);
          const sourceCode = homeCode(sourceHome, current.config.machineId, source.homeEpoch);
          if (sourceCode) return sourceCode;
          const targetHome = await homes.read(pinnedTarget.address.sessionId as SessionId);
          if (targetHome && current.config.role === "box" && targetHome.machineId === current.config.hubMachineId) return "reply-only";
          return homeCode(targetHome, pinnedPeer.machineId, pinnedTarget.homeEpoch);
        });
        if (code) return refused(code);
      } catch { return refused("unreachable"); }
      const currentPeer = current.sendTo.find(item => item.machineId === pinnedPeer.machineId);
      if (!currentPeer || !samePeer(currentPeer, pinnedPeer)) return refused("changed");
      if (!locals.some(local => local.id === from.id && endpointOf(local) !== null && sameEndpoint(endpointOf(local)!, source))) return refused("changed");
      try {
        const active = await bounded(Math.min(deadline, deliveryDeadline), abort, s => broker(current.agentDir,
          { kind: "lookup", scopeId: source.address.scopeId, selector: { by: "id", value: source.address.sessionId } }, s));
        if (active.kind === "refused") return active.code === "reply-only" ? refused("unreachable") : active;
        if (active.kind !== "matches" || active.targets.length !== 1 || !sameEndpoint(active.targets[0], source)) return refused("changed");
      } catch { return refused("unreachable"); }
      const common = { version: 1 as const, requestId: randomUUID(), toMachineId: pinnedPeer.machineId,
        from: sourceWire, target: pinnedTarget, message };
      const request: V0AgentRequest = kind === "deliver" ? { ...common, kind: "deliver" }
        : { ...common, kind: "ask", timeoutMs: askMs! };
      const result = await callPeer(current, currentPeer, request, deadline, deliveryDeadline, abort, askDeadline);
      return result.kind === "matches" ? { kind: "unknown" as const, id: message.id } : result;
    }
    return { kind: "remote", label,
      send: (message, abort) => dispatch("deliver", message, undefined, abort),
      ask: (message, timeoutMs, abort) => dispatch("ask", message, timeoutMs, abort) };
  };

  async function handle(raw: unknown): Promise<V0AgentReply | null> {
    const request = parseV0AgentRequest(raw);
    if (!request) return null;
    let configured: Settings;
    try { configured = settings(root); }
    catch {
      // A correlated refusal is returned only when the local identity can be read.
      try { return { version: 1, requestId: request.requestId, machineId: readLocalIdentity(root).machineId, kind: "refused", code: "not-configured" }; }
      catch { return null; }
    }
    const envelope = (result: V0Reply): V0AgentReply => ({ version: 1, requestId: request.requestId, machineId: configured.config.machineId, ...result });
    if (request.toMachineId !== configured.config.machineId) return envelope(refused("unauthorized"));
    const source = configured.acceptFrom.find(peer => peer.machineId === request.from.machineId);
    if (!source) return envelope(refused("unauthorized"));
    try {
      const code = await withHomes(root, configured.config, async homes => {
        const sourceHome = await homes.read(request.from.address.sessionId as SessionId);
        const sourceCode = homeCode(sourceHome, request.from.machineId, request.from.homeEpoch);
        if (sourceCode) return sourceCode;
        if (request.kind !== "lookup") {
          if (request.target.address.scopeId !== request.from.address.scopeId) return "unauthorized";
          return homeCode(await homes.read(request.target.address.sessionId as SessionId), configured.config.machineId, request.target.homeEpoch);
        }
        return null;
      });
      if (code) return envelope(refused(code));
    } catch { return envelope(refused("unreachable")); }

    const signal = request.kind === "ask" ? undefined : AbortSignal.timeout(V0_INTERCOM_MS);
    let result: V0Reply;
    try {
      result = request.kind === "lookup"
        ? await broker(configured.agentDir, { kind: "lookup", scopeId: request.from.address.scopeId, selector: request.selector }, signal)
        : await broker(configured.agentDir, { kind: request.kind, from: origin(request, source), target: request.target,
            message: request.message, ...(request.kind === "ask" ? { timeoutMs: Math.min(request.timeoutMs, V0_ASK_MAX_MS) } : {}) } as Parameters<typeof broker>[1], signal);
    } catch {
      result = request.kind === "lookup" ? refused("unreachable") : { kind: "unknown", id: request.message.id };
    }
    if (request.kind === "lookup" && result.kind === "matches") {
      if (result.targets.some(endpoint => !matching(endpoint, request))) return envelope(refused("unauthorized"));
      try {
        const code = await withHomes(root, configured.config, async homes => {
          for (const endpoint of result.kind === "matches" ? result.targets : []) {
            const stale = homeCode(await homes.read(endpoint.address.sessionId as SessionId), configured.config.machineId, endpoint.homeEpoch);
            if (stale) return stale;
          }
          return null;
        });
        if (code) return envelope(refused(code));
      } catch { return envelope(refused("unreachable")); }
    }
    const answer = envelope(result);
    return parseV0AgentReply(answer) ? answer : envelope(refused("incomplete"));
  }
  return { prepare, handle };
}
