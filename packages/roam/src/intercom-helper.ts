import { randomUUID } from "node:crypto";
import { constants, fstatSync, lstatSync, openSync, readFileSync, closeSync, type Stats } from "node:fs";
import net from "node:net";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { createMessageReader, writeMessage } from "../../intercom/src/broker/framing.js";
import { getBrokerSocketPath } from "../../intercom/src/broker/paths.js";
import { HELPER_EXCHANGE_ERRORS, HELPER_EXCHANGE_FEATURE, isHelperExchangeError } from "@spider/intercom/protocol";
import { projectRoot } from "../../db-core/src/paths";
import { decodeExchange, encodeExchange } from "./intercom-codec";
import { INTERCOM_EXCHANGE_BYTES, type IntercomExchange } from "./intercom-contracts";

export interface HelperRequest { version: 1; exchange: IntercomExchange; holdMs: number; deadlineMs: number }
export interface HelperReply { version: 1; exchange: IntercomExchange }
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
export function parseHelperRequest(value: unknown): HelperRequest {
  if (!record(value) || !exact(value, ["version", "exchange", "holdMs", "deadlineMs"]) || value.version !== 1 ||
      !Number.isSafeInteger(value.holdMs) || Number(value.holdMs) < 0 || Number(value.holdMs) > 25_000 ||
      !Number.isSafeInteger(value.deadlineMs) || Number(value.deadlineMs) < 1 || Number(value.deadlineMs) > 30_000) return fail("invalid-request");
  const encoded = JSON.stringify(value.exchange);
  if (typeof encoded !== "string") return fail("invalid-request");
  const exchange = decodeExchange(Buffer.from(encoded));
  const holdMs = Number(value.holdMs), deadlineMs = Number(value.deadlineMs);
  if (exchange.generation.channel === "push" && holdMs !== 0 || holdMs > Math.max(0, deadlineMs - 5000)) return fail("invalid-request");
  return { version: 1, exchange, holdMs, deadlineMs };
}
function reply(value: unknown, input: HelperRequest): HelperReply {
  if (!record(value) || !exact(value, ["version", "exchange"]) || value.version !== 1) return fail("invalid-reply");
  const exchange = decodeExchange(Buffer.from(JSON.stringify(value.exchange)));
  if (exchange.senderMachine !== input.exchange.recipientMachine || exchange.recipientMachine !== input.exchange.senderMachine ||
      JSON.stringify(exchange.generation) !== JSON.stringify(input.exchange.generation)) return fail("invalid-reply");
  return { version: 1, exchange };
}

/** This client never starts a broker or uses a TCP fallback. */
async function brokerExchange(route: HelperRoute, input: HelperRequest): Promise<HelperReply> {
  const target = getBrokerSocketPath(process.platform, route.agentDir), socket = net.connect(target);
  const ends = performance.now() + input.deadlineMs;
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
    const remaining = Math.min(input.deadlineMs, Math.max(1, Math.floor(ends - performance.now())));
    const outcome = await ask({ type: "helper_exchange", input, deadlineMs: remaining });
    if (outcome.type !== "helper_result") return fail(isHelperExchangeError(outcome.reason) || outcome.reason === "helper-timeout" ||
      outcome.reason === "helper-unauthorized" || outcome.reason === "bridge-exchange-failed" ? outcome.reason : "bridge-unavailable");
    if (Buffer.byteLength(JSON.stringify(outcome)) > INTERCOM_EXCHANGE_BYTES) return fail("exchange-too-large");
    return reply(outcome.output, input);
  } finally { socket.destroy(); }
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
export async function main(root: string): Promise<number> {
  const allowed = new Set([...HELPER_EXCHANGE_ERRORS, "unsupported-broker", "helper-unauthorized", "helper-timeout", "broker-unavailable",
    "bridge-exchange-failed", "unsafe-helper-route", "invalid-reply"]);
  try {
    const input = parseHelperRequest(await readInput());
    // Validate the same complete exchange that will be sent over the socket.
    encodeExchange(input.exchange);
    const value = await brokerExchange(readRoute(root), input);
    process.stdout.write(`${JSON.stringify({ version: 1, kind: "intercom-exchange", ok: true, value })}\n`);
  } catch (error) {
    const reason = error instanceof Error && allowed.has(error.message) ? error.message : "bridge-unavailable";
    process.stdout.write(`${JSON.stringify({ version: 1, kind: "intercom-exchange", ok: false, reason })}\n`);
  }
  return 0;
}
