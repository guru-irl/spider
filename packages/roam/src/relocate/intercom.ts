import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { openRoamPathReadOnly } from "@spider/db-core/roam/reads";
import type { MachineId } from "@spider/db-core/roam/types";
import { requestV0Broker } from "@spider/intercom/broker/roam-v0-client";
import {
  parseV0AgentReply, parseV0AgentRequest, V0_ASK_MAX_MS, V0_INTERCOM_MS,
  type V0AgentReply, type V0AgentRequest, type V0Code, type V0Endpoint, type V0Prepare, type V0Reply,
} from "@spider/intercom/roam-v0";
import type { RemoteSessionInfo } from "@spider/intercom/types";
import { readPeer } from "../config";
import type { Peer, RoamConfig, Transport } from "../contracts";
import { loadHerdrConfig } from "../host-config";
import { isMachineId } from "../machine-id";
import { readLocalIdentity } from "../runtime";
import { createHomeStore } from "./home";
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
    if (meta?.machine_id !== config.machineId || meta.store_key !== "global") throw new Error("Home store identity mismatch");
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
function refused(code: V0Code): V0Reply { return { kind: "refused", code }; }
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

export function createV0Intercom(root: string, deps: V0IntercomDeps = {}): {
  prepare: V0Prepare;
  handle(raw: unknown): Promise<V0AgentReply | null>;
} {
  const broker = deps.broker ?? requestV0Broker;
  const prepare: V0Prepare = async ({ to, from }) => {
    let configured: Settings;
    try { configured = settings(root); } catch { return { kind: "refused", code: "not-configured" }; }
    if (!from.address) return { kind: "refused", code: "changed" };
    try {
      const home = await withHomes(root, configured.config, homes => homes.read(from.address!.sessionId as SessionId));
      if (!home) return to.includes("/") ? { kind: "refused", code: "not-configured" } : { kind: "legacy" };
      const code = homeCode(home, configured.config.machineId, from.v0HomeEpoch ?? 0);
      if (code) return { kind: "refused", code };
      return { kind: "refused", code: "not-configured" };
    } catch { return { kind: "refused", code: "unreachable" }; }
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

    const signal = AbortSignal.timeout(request.kind === "ask" ? Math.min(request.timeoutMs, V0_ASK_MAX_MS) : V0_INTERCOM_MS);
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
