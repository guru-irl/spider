import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DEFAULT_LIMITS } from "./contracts";
import { isMachineId } from "./machine-id";
import type { Limits, Peer, RoamConfig } from "./contracts";

type RecordValue = Record<string, unknown>;

function object(value: unknown, label: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid roaming config: ${label}`);
  return value as RecordValue;
}
function keys(value: RecordValue, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Invalid roaming config: unknown ${label} field`);
}
function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid roaming config: ${label}`);
  }
  return value;
}
function machineIdentity(value: unknown): string {
  const identity = nonempty(value, "machine identity");
  if (!isMachineId(identity)) {
    throw new Error("Invalid roaming config: machine identity");
  }
  return identity;
}
function absolutePath(value: unknown): string {
  const path = nonempty(value, "absolute path required");
  if (!isAbsolute(path)) throw new Error("Invalid roaming config: absolute path required");
  return path;
}
function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid roaming config: ${label}`);
  return value;
}

const NUMBER_LIMITS = [
  "chunkBytes", "replyBytes", "manifestBytes", "targetBatchBytes", "hardBatchBytes", "applyTargetMs",
  "workspaceBytes", "sessionBytes", "agentBytes", "stagingBytes", "fileMs", "controlMs", "exportMs", "importMs",
  "directMs", "launchMs", "readyMs", "transferMs", "peerConcurrency", "retentionMs",
] as const;

function readLimits(value: unknown): Limits {
  const result: Limits = { ...DEFAULT_LIMITS, retryDelaysMs: [...DEFAULT_LIMITS.retryDelaysMs] };
  if (value === undefined) return result;
  const input = object(value, "limits");
  keys(input, [...NUMBER_LIMITS, "retryDelaysMs"], "limit");
  for (const key of NUMBER_LIMITS) {
    if (key in input) result[key] = positiveInteger(input[key], `limit ${key}`);
  }
  if ("retryDelaysMs" in input) {
    if (!Array.isArray(input.retryDelaysMs)) throw new Error("Invalid roaming config: retry delay limit");
    result.retryDelaysMs = input.retryDelaysMs.map(delay => positiveInteger(delay, "retry delay limit"));
  }
  if (result.chunkBytes > result.replyBytes || result.manifestBytes > result.replyBytes || result.targetBatchBytes > result.hardBatchBytes) {
    throw new Error("Invalid roaming config: inconsistent transfer limits");
  }
  return result;
}

function readPeer(value: unknown): Peer {
  const input = object(value, "peer");
  keys(input, ["machineId", "alias", "node", "pi", "cli", "core", "globalRoot"], "peer");
  const alias = nonempty(input.alias, "peer alias");
  return {
    machineId: machineIdentity(input.machineId),
    alias,
    node: absolutePath(input.node),
    pi: absolutePath(input.pi),
    cli: absolutePath(input.cli),
    core: absolutePath(input.core),
    globalRoot: absolutePath(input.globalRoot),
  };
}

/** Read untrusted configuration without including its values in diagnostics. */
export function loadConfig(file: string): RoamConfig {
  let input: unknown;
  try { input = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error("Cannot read or parse roaming config"); }
  const value = object(input, "expected an object");
  keys(value, ["enabled", "role", "machineId", "hubMachineId", "peers", "discoveryRoots", "coreUnit", "syncMs", "limits"], "config");
  const enabled = value.enabled === undefined ? false : value.enabled;
  if (typeof enabled !== "boolean") throw new Error("Invalid roaming config: enabled");
  if (value.role !== "hub" && value.role !== "box") throw new Error("Invalid roaming config: role");
  const machineId = machineIdentity(value.machineId);
  const hubMachineId = machineIdentity(value.hubMachineId);
  if ((value.role === "hub") !== (machineId === hubMachineId)) throw new Error("Invalid roaming config: hub identity");
  const peerInput = value.peers === undefined ? [] : value.peers;
  if (!Array.isArray(peerInput)) throw new Error("Invalid roaming config: peers");
  if (value.role === "box" && peerInput.length) throw new Error("Invalid roaming config: box cannot have outbound peers");
  const peers = peerInput.map(readPeer);
  if (new Set(peers.map(peer => peer.alias)).size !== peers.length ||
      new Set(peers.map(peer => peer.machineId)).size !== peers.length ||
      peers.some(peer => peer.machineId === machineId)) throw new Error("Invalid roaming config: duplicate peer identity or alias");
  const rootInput = value.discoveryRoots === undefined ? [] : value.discoveryRoots;
  if (!Array.isArray(rootInput)) throw new Error("Invalid roaming config: discovery roots");
  return {
    enabled,
    role: value.role,
    machineId,
    hubMachineId,
    peers,
    discoveryRoots: rootInput.map(absolutePath),
    coreUnit: nonempty(value.coreUnit, "core unit"),
    syncMs: value.syncMs === undefined ? 120_000 : positiveInteger(value.syncMs, "sync period"),
    limits: readLimits(value.limits),
  };
}
