import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { RelayPeer } from "@spider/intercom/relay-protocol";
import { readPeer } from "../config";
import type { Peer, RoamConfig } from "../contracts";
import { loadHerdrConfig } from "../host-config";
import { isMachineId } from "../machine-id";

export interface V0Routes {
  version: 1 | 2;
  agentDir: string;
  sendTo: readonly Peer[];
  acceptFrom: readonly RelayPeer[];
  relays: readonly string[];
  linkTo: readonly string[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
export function isV0Alias(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255 && value.trim() === value
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
function distinct(peers: readonly { machineId: string; alias: string }[], local: string): boolean {
  return peers.every(peer => peer.machineId !== local) && new Set(peers.map(peer => peer.machineId)).size === peers.length
    && new Set(peers.map(peer => peer.alias.toLowerCase())).size === peers.length;
}

function machineList(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isMachineId) || new Set(value).size !== value.length)
    throw new Error("Invalid intercom relay machine list");
  return value;
}

export function readV0Routes(root: string, config: RoamConfig): V0Routes {
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
  if (!object(value) || (value.version !== 1 && value.version !== 2) ||
      !keys(value, ["version", "sendTo", "acceptFrom", ...(value.version === 2
        ? ["relays", "linkTo"].filter(key => Object.hasOwn(value, key)) : [])]) ||
      !Array.isArray(value.sendTo) || value.sendTo.length > 8 || !Array.isArray(value.acceptFrom) || value.acceptFrom.length > 8)
    throw new Error("Invalid intercom configuration");
  const sendTo = value.sendTo.map(readPeer);
  if (sendTo.some(peer => !peer.agentDir || !isAbsolute(peer.agentDir) || !isV0Alias(peer.alias)) ||
      !distinct(sendTo, config.machineId) || config.role === "box" && sendTo.some(peer => peer.machineId === config.hubMachineId))
    throw new Error("Invalid intercom routes");
  const acceptFrom = value.acceptFrom.map((entry): RelayPeer => {
    if (!object(entry) || !keys(entry, ["machineId", "alias"]) || !isMachineId(entry.machineId) || !isV0Alias(entry.alias))
      throw new Error("Invalid intercom source");
    return { machineId: entry.machineId, alias: entry.alias };
  });
  if (!distinct(acceptFrom, config.machineId) || value.version === 1 && config.role === "hub" && acceptFrom.length > 0)
    throw new Error("Invalid intercom sources");
  const outboundAliases = new Map(sendTo.map(peer => [peer.alias.toLowerCase(), peer.machineId]));
  for (const source of acceptFrom) {
    const outbound = outboundAliases.get(source.alias.toLowerCase());
    if (outbound !== undefined && outbound !== source.machineId) throw new Error("Conflicting intercom aliases");
  }
  const relays = value.version === 2 ? machineList(value.relays) : [];
  const linkTo = value.version === 2 ? machineList(value.linkTo) : [];
  if ((linkTo.length > 0 && !relays.includes(config.machineId)) ||
      linkTo.some(id => !sendTo.some(peer => peer.machineId === id))) throw new Error("Invalid intercom relay links");
  const agentDir = loadHerdrConfig(root).agentDirectory;
  if (!isAbsolute(agentDir) || process.env.PI_CODING_AGENT_DIR !== undefined && process.env.PI_CODING_AGENT_DIR !== agentDir)
    throw new Error("Intercom agent directory mismatch");
  return { version: value.version, agentDir, sendTo, acceptFrom, relays, linkTo };
}
