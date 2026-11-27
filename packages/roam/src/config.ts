import { readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { DEFAULT_INTERCOM_LIMITS, DEFAULT_LIMITS } from "./contracts";
import { isMachineId } from "./machine-id";
import type { IntercomConfig, IntercomConnectorRecipe, IntercomLimits, IntercomRoute, Limits, Peer, RoamConfig } from "./contracts";

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

export function readPeer(value: unknown): Peer {
  const input = object(value, "peer");
  keys(input, ["machineId", "alias", "node", "pi", "cli", "core", "globalRoot", "agentDir", "coreUnit"], "peer");
  const alias = nonempty(input.alias, "peer alias");
  if (input.coreUnit !== undefined && (typeof input.coreUnit !== "string" || input.coreUnit.length > 255 ||
      !/^[A-Za-z0-9][A-Za-z0-9_.@:-]*\.service$/.test(input.coreUnit) || input.coreUnit.endsWith("@.service"))) throw new Error("Invalid roaming config: peer core unit");
  return {
    machineId: machineIdentity(input.machineId),
    alias,
    node: absolutePath(input.node),
    pi: absolutePath(input.pi),
    cli: absolutePath(input.cli),
    core: absolutePath(input.core),
    globalRoot: absolutePath(input.globalRoot),
    ...(input.agentDir === undefined ? {} : { agentDir: absolutePath(input.agentDir) }),
    ...(input.coreUnit === undefined ? {} : { coreUnit: nonempty(input.coreUnit, "peer core unit") }),
  };
}

export function parseConnectorRecipe(value: unknown): IntercomConnectorRecipe {
  const invalid = (): never => { throw new Error("intercom-connector-recipe-invalid"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const input = value as RecordValue;
  if (Object.keys(input).some(key => !["check", "host", "connect", "localPort", "pairPorts"].includes(key)) || !["check", "host", "connect", "localPort"].every(key => Object.hasOwn(input, key))) return invalid();
  const command = (candidate: unknown): string[] => {
    if (!Array.isArray(candidate) || candidate.length < 1 || candidate.length > 64 || candidate.some(arg => typeof arg !== "string" ||
        !arg || arg.length > 4096 || /[\u0000-\u001f\u007f]/.test(arg)) || !isAbsolute(candidate[0]) || resolve(candidate[0]) !== candidate[0] ||
        /^(?:ba|da|z|k|a)?sh$/.test(basename(candidate[0])) && candidate.slice(1).some(arg => /^-[A-Za-z]*c/.test(arg))) return invalid();
    return [...candidate] as string[];
  };
  if (!Number.isSafeInteger(input.localPort) || Number(input.localPort) < 1 || Number(input.localPort) > 65535) return invalid();
  let pairPorts: Record<string, number> | undefined;
  if (input.pairPorts !== undefined) {
    if (!input.pairPorts || typeof input.pairPorts !== "object" || Array.isArray(input.pairPorts) || Object.keys(input.pairPorts).length > 64) return invalid();
    pairPorts = Object.create(null) as Record<string, number>; const used = new Set<number>();
    for (const [pairId, port] of Object.entries(input.pairPorts)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pairId) || !Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65535 || used.has(Number(port))) return invalid();
      pairPorts[pairId] = Number(port); used.add(Number(port));
    }
  }
  return { check: command(input.check), host: command(input.host), connect: command(input.connect), localPort: Number(input.localPort), ...(pairPorts ? { pairPorts } : {}) };
}

function readIntercom(value: unknown, role: "hub" | "box", machineId: string, hubMachineId: string): IntercomConfig {
  const input = value === undefined ? {} : object(value, "intercom");
  keys(input, ["enabled", "mode", "machineAlias", "protocolFeature", "routes", "limits", "connector"], "intercom");
  const enabled = input.enabled === undefined ? false : input.enabled;
  if (typeof enabled !== "boolean") throw new Error("Invalid roaming config: intercom enabled");
  const mode = input.mode === undefined ? "hub-only" : input.mode;
  if (mode !== "hub-only" && mode !== "peers") throw new Error("Invalid roaming config: intercom mode");
  const machineAlias = input.machineAlias === undefined || input.machineAlias === null ? null : nonempty(input.machineAlias, "intercom alias");
  if (enabled && machineAlias === null) throw new Error("Invalid roaming config: intercom alias");
  const protocolFeature = input.protocolFeature === undefined ? "federation-v1" : input.protocolFeature;
  if (protocolFeature !== "federation-v1") throw new Error("Invalid roaming config: intercom protocol");
  const limits: IntercomLimits = { ...DEFAULT_INTERCOM_LIMITS };
  if (input.limits !== undefined) {
    const source = object(input.limits, "intercom limits");
    keys(source, ["queueMessages", "queueBytes"], "intercom limit");
    for (const key of ["queueMessages", "queueBytes"] as const) {
      if (key in source) limits[key] = positiveInteger(source[key], `intercom limit ${key}`);
      if (limits[key] > DEFAULT_INTERCOM_LIMITS[key]) throw new Error("Invalid roaming config: intercom limit exceeds protocol");
    }
  }
  const routeInput = input.routes === undefined ? [] : input.routes;
  if (!Array.isArray(routeInput)) throw new Error("Invalid roaming config: intercom routes");
  const routes: IntercomRoute[] = routeInput.map(raw => {
    const route = object(raw, "intercom route");
    if (route.kind === "direct") {
      keys(route, ["kind", "peer", "edgeEpoch"], "intercom route");
      const edgeEpoch = nonempty(route.edgeEpoch, "intercom edge epoch");
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(edgeEpoch)) throw new Error("Invalid roaming config: intercom edge epoch");
      return { kind: "direct", peer: readPeer(route.peer), edgeEpoch };
    }
    if (route.kind === "relay") {
      keys(route, ["kind", "peer", "via"], "intercom route");
      return { kind: "relay", peer: readPeer(route.peer), via: machineIdentity(route.via) };
    }
    throw new Error("Invalid roaming config: intercom route kind");
  });
  const identities = new Set<string>(), aliases = new Set<string>(machineAlias ? [machineAlias.toLowerCase()] : []);
  for (const route of routes) {
    const { peer } = route, alias = peer.alias.toLowerCase();
    if (peer.machineId === machineId || identities.has(peer.machineId) || aliases.has(alias)) throw new Error("Invalid roaming config: duplicate intercom identity or alias");
    identities.add(peer.machineId); aliases.add(alias);
    if (route.kind === "relay" && (mode !== "hub-only" || role !== "box" || route.via !== hubMachineId || peer.machineId === hubMachineId) ||
        route.kind === "direct" && mode === "hub-only" && role === "box" && peer.machineId !== hubMachineId) {
      throw new Error("Invalid roaming config: intercom graph");
    }
  }
  if (routes.some(route => route.kind === "relay") && !routes.some(route => route.kind === "direct" && route.peer.machineId === hubMachineId)) {
    throw new Error("Invalid roaming config: intercom relay lacks hub edge");
  }
  const settings = { mode, protocolFeature, routes, limits, ...(input.connector === undefined ? {} : { connector: parseConnectorRecipe(input.connector) }) } as const;
  return enabled ? { ...settings, enabled, machineAlias: machineAlias! } : { ...settings, enabled, machineAlias };
}

/** Parse untrusted configuration without including its values in diagnostics. */
export function parseConfig(input: unknown): RoamConfig {
  const value = object(input, "expected an object");
  keys(value, ["enabled", "role", "machineId", "hubMachineId", "peers", "discoveryRoots", "coreUnit", "syncMs", "limits", "intercom"], "config");
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
    intercom: readIntercom(value.intercom, value.role, machineId, hubMachineId),
  };
}

/** Read untrusted configuration without including its values in diagnostics. */
export function loadConfig(file: string): RoamConfig {
  let input: unknown;
  try { input = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error("Cannot read or parse roaming config"); }
  return parseConfig(input);
}
