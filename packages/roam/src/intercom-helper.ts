import { randomUUID } from "node:crypto";
import { constants, fstatSync, lstatSync, openSync, readFileSync, closeSync, type Stats } from "node:fs";
import net from "node:net";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { createMessageReader, writeMessage } from "../../intercom/src/broker/framing.js";
import { getBrokerSocketPath } from "../../intercom/src/broker/paths.js";
import { HELPER_EXCHANGE_ERRORS, HELPER_EXCHANGE_FEATURE, isHelperExchangeError } from "@spider/intercom/protocol";
import { projectRoot } from "../../db-core/src/paths";
import { decodeExchangeWithFrameErrors, encodeExchange } from "./intercom-codec";
import { INTERCOM_EXCHANGE_BYTES, type AuthenticatedIntercomExchange, type IntercomExchange, type IntercomWireMissingOriginFrame } from "./intercom-contracts";
import { isMachineId } from "./machine-id";

export interface HelperRequest { version: 1; exchange: AuthenticatedIntercomExchange; holdMs: number; deadlineMs: number; missingOrigins?: IntercomWireMissingOriginFrame[] }
export interface HelperReply { version: 1; exchange: IntercomExchange }
export interface HelperRevokeRequest { version: 1; action: "revoke-pair"; machineId: string; peer: string; edgeEpoch: string; fenceId?: string }
export interface HelperInspectRequest { version: 1; action: "inspect-pair"; machineId: string; peer: string; edgeEpoch: string }
export interface HelperFenceRequest { version: 1; action: "inspect-fence"; machineId: string; peer: string }
export interface HelperEnrollRequest { version: 1; action: "enroll-pair"; machineId: string; peer: string; pairId: string; edgeEpoch: string;
  operationId: string; graphDigest: string; expectedFenceId: string | null }
export interface HelperTopologyRequest { version: 1; action: "transition-topology"; machineId: string; transitionId: string;
  operationId: string; graphDigest: string; from: "hub-only" | "peers"; to: "hub-only" | "peers" }
export function parseHelperTopology(value: unknown): HelperTopologyRequest {
  if (!record(value) || !exact(value, ["version", "action", "machineId", "transitionId", "operationId", "graphDigest", "from", "to"]) ||
      value.version !== 1 || value.action !== "transition-topology" || !isMachineId(value.machineId) || !isMachineId(value.transitionId) ||
      typeof value.operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.operationId) ||
      typeof value.graphDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.graphDigest) ||
      value.from !== "hub-only" && value.from !== "peers" || value.to !== "hub-only" && value.to !== "peers") return fail("invalid-request");
  return value as unknown as HelperTopologyRequest;
}
export async function requestHelperTopology(root: string, value: unknown): Promise<{ machineId: string; transitionId: string; state: "draining" | "switching" | "complete" }> {
  const input = parseHelperTopology(value), output = await brokerRequest(readRoute(root), 30_000, input);
  if (!record(output) || !exact(output, ["machineId", "transitionId", "state"]) || output.machineId !== input.machineId ||
      output.transitionId !== input.transitionId || !["draining", "switching", "complete"].includes(String(output.state))) return fail("invalid-reply");
  return output as unknown as { machineId: string; transitionId: string; state: "draining" | "switching" | "complete" };
}
interface HelperRoute { agentDir: string; token: string }
const fail = (reason: string): never => { throw new Error(reason); };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: readonly string[]): boolean => Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const owned = (info: Stats): boolean => process.platform === "win32" || typeof process.getuid !== "function" || info.uid === process.getuid();
const privateMode = (mode: number, expected: number): boolean => process.platform === "win32" || (mode & 0o7777) === expected;

function noSymlink(path: string): void {
  const root = parse(path).root;
  let current = root;
  for (const component of path.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, component);
    if (lstatSync(current).isSymbolicLink()) fail("unsafe-helper-route");
  }
}
function directory(path: string, mode: boolean): void {
  noSymlink(path);
  const info = lstatSync(path);
  if (!info.isDirectory() || !owned(info) || mode && !privateMode(info.mode, 0o700)) fail("unsafe-helper-route");
}
function readRoute(root: string): HelperRoute {
  if (!isAbsolute(root) || resolve(root) !== root) return fail("unsafe-helper-route");
  if (process.env.VITEST) {
    const scratch = join(projectRoot(process.cwd()), "scratch"), local = relative(scratch, root);
    if (!local || local.startsWith("..") || isAbsolute(local)) return fail("unsafe-helper-route");
  }
  const roam = join(root, "roam"), state = join(roam, "intercom"), file = join(state, "helper.json");
  directory(root, false); directory(roam, true); directory(state, true);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value: unknown;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || !owned(info) || info.nlink !== 1 || !privateMode(info.mode, 0o600) || info.size > 4096) return fail("unsafe-helper-route");
    value = JSON.parse(readFileSync(fd, "utf8")) as unknown;
  } finally { closeSync(fd); }
  if (!record(value) || !exact(value, ["version", "agentDir", "token"]) || value.version !== 1 ||
      typeof value.agentDir !== "string" || !isAbsolute(value.agentDir) || resolve(value.agentDir) !== value.agentDir ||
      typeof value.token !== "string" || !/^[0-9a-f]{64}$/.test(value.token)) return fail("unsafe-helper-route");
  directory(value.agentDir, false); directory(join(value.agentDir, "intercom"), true);
  const socket = getBrokerSocketPath(process.platform, value.agentDir);
  if (process.platform !== "win32") {
    if (Buffer.byteLength(socket) > 103) return fail("unsafe-helper-route");
    const info = lstatSync(socket);
    if (!info.isSocket() || !owned(info) || !privateMode(info.mode, 0o600)) return fail("unsafe-helper-route");
  }
  return { agentDir: value.agentDir, token: value.token };
}
export function parseHelperRevoke(value: unknown): HelperRevokeRequest {
  if (!record(value) || !(exact(value, ["version", "action", "machineId", "peer", "edgeEpoch"]) ||
      exact(value, ["version", "action", "machineId", "peer", "edgeEpoch", "fenceId"])) || value.version !== 1 || value.action !== "revoke-pair" ||
      !isMachineId(value.machineId) || !isMachineId(value.peer) || value.machineId === value.peer || typeof value.edgeEpoch !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.edgeEpoch) || value.fenceId !== undefined && !isMachineId(value.fenceId)) return fail("invalid-request");
  return value as unknown as HelperRevokeRequest;
}
export function parseHelperFence(value: unknown): HelperFenceRequest {
  if (!record(value) || !exact(value, ["version", "action", "machineId", "peer"]) || value.version !== 1 || value.action !== "inspect-fence" ||
      !isMachineId(value.machineId) || !isMachineId(value.peer) || value.machineId === value.peer) return fail("invalid-request");
  return value as unknown as HelperFenceRequest;
}
export function parseHelperInspect(value: unknown): HelperInspectRequest {
  if (!record(value) || !exact(value, ["version", "action", "machineId", "peer", "edgeEpoch"]) || value.action !== "inspect-pair") return fail("invalid-request");
  parseHelperRevoke({ ...value, action: "revoke-pair" });
  return value as unknown as HelperInspectRequest;
}
export function parseHelperEnroll(value: unknown): HelperEnrollRequest {
  const id = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
  if (!record(value) || !exact(value, ["version", "action", "machineId", "peer", "pairId", "edgeEpoch", "operationId", "graphDigest", "expectedFenceId"]) ||
      value.version !== 1 || value.action !== "enroll-pair" || !isMachineId(value.machineId) || !isMachineId(value.peer) || value.machineId === value.peer ||
      !id(value.pairId) || !id(value.edgeEpoch) || !id(value.operationId) || typeof value.graphDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.graphDigest) ||
      !(value.expectedFenceId === null || isMachineId(value.expectedFenceId))) return fail("invalid-request");
  return value as unknown as HelperEnrollRequest;
}
export function parseHelperRequest(value: unknown): HelperRequest {
  if (!record(value) || !exact(value, ["version", "exchange", "holdMs", "deadlineMs"]) || value.version !== 1 ||
      !Number.isSafeInteger(value.holdMs) || Number(value.holdMs) < 0 || Number(value.holdMs) > 25_000 ||
      !Number.isSafeInteger(value.deadlineMs) || Number(value.deadlineMs) < 1 || Number(value.deadlineMs) > 30_000) return fail("invalid-request");
  const encoded = JSON.stringify(value.exchange);
  if (typeof encoded !== "string") return fail("invalid-request");
  const { exchange, missingOrigins } = decodeExchangeWithFrameErrors(Buffer.from(encoded));
  const holdMs = Number(value.holdMs), deadlineMs = Number(value.deadlineMs);
  if (exchange.generation.channel === "push" && holdMs !== 0 || holdMs > Math.max(0, deadlineMs - 5000)) return fail("invalid-request");
  return { version: 1, exchange, holdMs, deadlineMs, ...(missingOrigins.length ? { missingOrigins } : {}) };
}
function reply(value: unknown, input: HelperRequest): HelperReply {
  if (!record(value) || !exact(value, ["version", "exchange"]) || value.version !== 1) return fail("invalid-reply");
  const { exchange } = decodeExchangeWithFrameErrors(Buffer.from(JSON.stringify(value.exchange)));
  if (exchange.senderMachine !== input.exchange.recipientMachine || exchange.recipientMachine !== input.exchange.senderMachine ||
      JSON.stringify(exchange.generation) !== JSON.stringify(input.exchange.generation)) return fail("invalid-reply");
  // Preserve the wire frames: the caller records and rejects any missing-origin frame.
  return value as unknown as HelperReply;
}

/** This client never starts a broker or uses a TCP fallback. */
async function brokerRequest(route: HelperRoute, deadlineMs: number, original: unknown): Promise<unknown> {
  const target = getBrokerSocketPath(process.platform, route.agentDir), socket = net.connect(target);
  const ends = performance.now() + deadlineMs;
  let failure: Error | null = null;
  const pending = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const stop = (error: Error) => {
    if (failure) return;
    failure = error;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  socket.on("error", () => stop(new Error("broker-unavailable")));
  socket.on("close", () => stop(new Error("broker-unavailable")));
  socket.on("data", createMessageReader(value => {
    if (!record(value) || typeof value.requestId !== "string") throw new Error("invalid-reply");
    const item = pending.get(value.requestId); if (!item) return;
    clearTimeout(item.timer); pending.delete(value.requestId); item.resolve(value);
  }, () => { stop(new Error("invalid-reply")); socket.destroy(); }));
  const ask = (message: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (failure) return Promise.reject(failure);
    const requestId = randomUUID(), envelope = { ...message, requestId };
    if (Buffer.byteLength(JSON.stringify(envelope)) > INTERCOM_EXCHANGE_BYTES) return Promise.reject(new Error("exchange-too-large"));
    const left = Math.floor(ends - performance.now());
    if (left <= 0) return Promise.reject(new Error("helper-timeout"));
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("helper-timeout")); }, left);
      pending.set(requestId, { resolve: resolvePromise, reject, timer });
      try { writeMessage(socket, envelope); } catch { clearTimeout(timer); pending.delete(requestId); reject(new Error("broker-unavailable")); }
    });
  };
  try {
    const health = await ask({ type: "health" });
    if (health.type !== "health_ok" || health.protocol !== "pi-intercom" || health.version !== 1 ||
        !Array.isArray(health.features) || !health.features.includes(HELPER_EXCHANGE_FEATURE)) return fail("unsupported-broker");
    const registered = await ask({ type: "helper_register", token: route.token });
    if (registered.type !== "helper_registered") return fail(registered.reason === "helper-unauthorized" ? "helper-unauthorized" : "broker-unavailable");
    const remaining = Math.min(deadlineMs, Math.max(1, Math.floor(ends - performance.now())));
    const outcome = await ask({ type: "helper_exchange", input: original, deadlineMs: remaining });
    if (outcome.type !== "helper_result") return fail(isHelperExchangeError(outcome.reason) || outcome.reason === "helper-timeout" ||
      outcome.reason === "helper-unauthorized" || outcome.reason === "bridge-exchange-failed" ? outcome.reason : "bridge-unavailable");
    if (Buffer.byteLength(JSON.stringify(outcome)) > INTERCOM_EXCHANGE_BYTES) return fail("exchange-too-large");
    return outcome.output;
  } finally { socket.destroy(); }
}
export async function requestHelperRevoke(root: string, value: unknown): Promise<{ machineId: string; peer: string; edgeEpoch: string; fenceId: string; exchanges: "closed"; inFlight: 0 }> {
  const input = parseHelperRevoke(value), output = await brokerRequest(readRoute(root), 30_000, input);
  if (!record(output) || !exact(output, ["machineId", "peer", "edgeEpoch", "fenceId", "exchanges", "inFlight"]) ||
      output.machineId !== input.machineId || output.peer !== input.peer || output.edgeEpoch !== input.edgeEpoch || !isMachineId(output.fenceId) ||
      output.exchanges !== "closed" || output.inFlight !== 0) return fail("invalid-reply");
  return output as unknown as { machineId: string; peer: string; edgeEpoch: string; fenceId: string; exchanges: "closed"; inFlight: 0 };
}
export async function requestHelperFence(root: string, value: unknown): Promise<{ machineId: string; peer: string; fence: { edgeEpoch: string; fenceId: string } | null }> {
  const input = parseHelperFence(value), output = await brokerRequest(readRoute(root), 30_000, input);
  if (!record(output) || !exact(output, ["machineId", "peer", "fence"]) || output.machineId !== input.machineId || output.peer !== input.peer ||
      !(output.fence === null || record(output.fence) && exact(output.fence, ["edgeEpoch", "fenceId"]) &&
        typeof output.fence.edgeEpoch === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(output.fence.edgeEpoch) && isMachineId(output.fence.fenceId))) return fail("invalid-reply");
  return output as unknown as { machineId: string; peer: string; fence: { edgeEpoch: string; fenceId: string } | null };
}
export async function observeHelperFeatures(root: string): Promise<readonly string[]> {
  const route = readRoute(root), socket = net.connect(getBrokerSocketPath(process.platform, route.agentDir)), id = randomUUID();
  return new Promise((resolvePromise, reject) => {
    let done = false;
    const finish = (error: Error | null, value: string[] = []) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolvePromise(value); };
    const timer = setTimeout(() => finish(new Error("broker-unavailable")), 2000); timer.unref();
    socket.on("error", () => finish(new Error("broker-unavailable")));
    socket.on("close", () => finish(new Error("broker-unavailable")));
    socket.on("data", createMessageReader(value => {
      if (!record(value) || value.type !== "health_ok" || value.requestId !== id || value.protocol !== "pi-intercom" || value.version !== 1 ||
          !Array.isArray(value.features) || !value.features.every(item => typeof item === "string" && item.length <= 128)) return finish(new Error("unsupported-broker"));
      finish(null, value.features);
    }, () => finish(new Error("invalid-reply"))));
    socket.once("connect", () => { try { writeMessage(socket, { type: "health", requestId: id }); } catch { finish(new Error("broker-unavailable")); } });
  });
}
export async function requestHelperInspect(root: string, value: unknown, deadlineMs = 30_000): Promise<{ machineId: string; peer: string; edgeEpoch: string; status: "unknown" | "live" | "recovering" | "down"; reason: string | null }> {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30_000) return fail("invalid-request");
  const input = parseHelperInspect(value), output = await brokerRequest(readRoute(root), deadlineMs, input);
  if (!record(output) || !exact(output, ["machineId", "peer", "edgeEpoch", "status", "reason"]) || output.machineId !== input.machineId ||
      output.peer !== input.peer || output.edgeEpoch !== input.edgeEpoch || !["unknown", "live", "recovering", "down"].includes(String(output.status)) ||
      !(output.reason === null || typeof output.reason === "string" && /^[a-z-]{1,80}$/.test(output.reason))) return fail("invalid-reply");
  return output as unknown as { machineId: string; peer: string; edgeEpoch: string; status: "unknown" | "live" | "recovering" | "down"; reason: string | null };
}
export async function requestHelperEnroll(root: string, value: unknown): Promise<{ machineId: string; peer: string; edgeEpoch: string; applied: true }> {
  const input = parseHelperEnroll(value), output = await brokerRequest(readRoute(root), 30_000, input);
  if (!record(output) || !exact(output, ["machineId", "peer", "edgeEpoch", "applied"]) || output.machineId !== input.machineId ||
      output.peer !== input.peer || output.edgeEpoch !== input.edgeEpoch || output.applied !== true) return fail("invalid-reply");
  return output as unknown as { machineId: string; peer: string; edgeEpoch: string; applied: true };
}
async function readInput(): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > INTERCOM_EXCHANGE_BYTES) return fail("exchange-too-large");
    chunks.push(bytes);
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown; }
  catch { return fail("invalid-request"); }
}

/** Every completed private command returns one exit-zero outcome envelope. */
export async function main(root: string, mode: "exchange" | "revoke-local" = "exchange"): Promise<number> {
  const allowed = new Set([...HELPER_EXCHANGE_ERRORS, "unsupported-broker", "helper-unauthorized", "helper-timeout", "broker-unavailable",
    "bridge-exchange-failed", "unsafe-helper-route", "invalid-reply", "peer-version-mismatch", "hop-stream-missing", "hop-stream-unstarted", "hop-sequence-gap", "hop-sequence-invalid", "hop-slot-mismatch", "hop-ack-mismatch"]);
  const kind = mode === "exchange" ? "intercom-exchange" : "intercom-revoke";
  try {
    const original = await readInput();
    let value: unknown;
    if (mode === "revoke-local") value = await requestHelperRevoke(root, original);
    else {
      const input = parseHelperRequest(original);
      // Validate the good frames; the bridge records rejected origin-less frames.
      encodeExchange(input.exchange);
      value = reply(await brokerRequest(readRoute(root), input.deadlineMs, original), input);
    }
    process.stdout.write(`${JSON.stringify({ version: 1, kind, ok: true, value })}\n`);
  } catch (error) {
    const reason = error instanceof Error && allowed.has(error.message) ? error.message : "bridge-unavailable";
    process.stdout.write(`${JSON.stringify({ version: 1, kind, ok: false, reason })}\n`);
  }
  return 0;
}
