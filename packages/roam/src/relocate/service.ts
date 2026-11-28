import { chmodSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { assertTestConfigPath } from "@spider/db-core";
import type { ApplyReceipt, MachineId } from "@spider/db-core/roam/types";
import type { Outcome } from "../contracts";
import { isMachineId } from "../machine-id";
import { privateDirectory } from "../staging";
import { decodeManagedHome } from "./home";
import type { SettledRelocateOutcome } from "./relocate";
import type { RelocateRequest, SetHomeRequest, V0ControlServices } from "./types";

export async function runV0Service(start: () => Promise<{ stop(): Promise<void> }>): Promise<void> {
  let signal!: () => void;
  const stopped = new Promise<void>(done => { signal = done; });
  process.once("SIGTERM", signal); process.once("SIGINT", signal);
  let service: { stop(): Promise<void> } | undefined;
  try { service = await start(); await stopped; }
  finally {
    process.off("SIGTERM", signal); process.off("SIGINT", signal);
    await service?.stop();
  }
}

const MAX_REQUEST = 32 * 1024, MAX_REPLY = 1024 * 1024;
const CONTROL_TIMEOUT = 30 * 60_000;
type SyncRequest = { machineId?: MachineId };
export type V0SyncOutcome = Outcome<{ outcomes: readonly Outcome<ApplyReceipt>[] }>;
export type V0PlacementControlServices = Omit<V0ControlServices, "relocate"> & {
  relocate(request: RelocateRequest): Promise<SettledRelocateOutcome>;
};
export type V0HubControlServices = V0PlacementControlServices & { sync(request: SyncRequest): Promise<V0SyncOutcome> };

function syncCode(outcomes: readonly Pick<Outcome<ApplyReceipt>, "code">[]): V0SyncOutcome["code"] {
  return outcomes.some(row => row.code === 3) ? 3 : outcomes.some(row => row.code === 1) ? 1 : outcomes.some(row => row.code === 2) ? 2 : 0;
}
export function summarizeSync(outcomes: readonly Outcome<ApplyReceipt>[]): V0SyncOutcome {
  const code = syncCode(outcomes);
  return { code, reason: code === 0 ? "Synchronization complete" : "Synchronization needs attention", operationId: "", home: null,
    epoch: null, repairCommand: null, value: { outcomes } };
}

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function socketPath(root: string): string {
  if (resolve(root) !== root) throw new Error("Invalid v0 runtime root");
  const path = join(root, "roam", "relocate.sock"); assertTestConfigPath(path);
  if (process.platform === "win32" || Buffer.byteLength(path) > (process.platform === "darwin" ? 103 : 107)) throw new Error("V0 control socket path is unsupported or too long");
  return path;
}
export async function probeV0Control(root: string, timeoutMs: number): Promise<boolean> {
  const path = socketPath(root);
  try { if (!lstatSync(path).isSocket()) return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  return new Promise<boolean>(done => {
    const socket = createConnection(path);
    const finish = (available: boolean) => { socket.destroy(); done(available); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}
function decode(bytes: Buffer): unknown { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
type Request = { version: 1; kind: "relocate"; request: RelocateRequest } | { version: 1; kind: "set-home"; request: SetHomeRequest }
  | { version: 1; kind: "sync"; request: SyncRequest };
function parse(bytes: Buffer): Request {
  const value = decode(bytes);
  if (!object(value) || value.version !== 1 || Object.keys(value).length !== 3 || !object(value.request)) throw new Error("Invalid v0 control");
  const r = value.request;
  if (value.kind === "sync") {
    const keys = Object.keys(r);
    if (keys.length === 0) return { version: 1, kind: "sync", request: {} };
    if (keys.length === 1 && keys[0] === "machineId" && isMachineId(r.machineId))
      return { version: 1, kind: "sync", request: { machineId: r.machineId } };
    throw new Error("Invalid v0 sync target");
  }
  if (value.kind !== "relocate" && value.kind !== "set-home") throw new Error("Invalid v0 control");
  if (!text(r.sessionId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(r.sessionId) || !isMachineId(r.destinationMachine)) throw new Error("Invalid v0 target");
  if (value.kind === "relocate" ? Object.keys(r).length !== 2 : Object.keys(r).length !== 4 || r.force !== true || !text(r.confirmation)) throw new Error("Invalid v0 confirmation");
  return value as Request;
}
function isSyncOutcomeRecord(value: unknown): value is Record<string, unknown> & Pick<V0SyncOutcome, "code"> {
  return object(value) && (value.code === 0 || value.code === 1 || value.code === 2 || value.code === 3) && text(value.reason) &&
    (value.operationId === "" || text(value.operationId)) && value.home === null && value.epoch === null && value.repairCommand === null;
}
function isApplyReceipt(value: unknown): boolean {
  return object(value) && text(value.batchId) && text(value.stream) && Number.isSafeInteger(value.through) && Number(value.through) >= 0 &&
    typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256) &&
    (value.applyMs === null || typeof value.applyMs === "number" && Number.isFinite(value.applyMs) && value.applyMs >= 0);
}
function parseSyncReply(result: unknown): V0SyncOutcome {
  if (isSyncOutcomeRecord(result)) {
    const value = result.value;
    if (value === null && result.code !== 0 || object(value) && Object.keys(value).length === 1 && Array.isArray(value.outcomes) &&
        value.outcomes.every(row => isSyncOutcomeRecord(row) && (row.code === 0 ? isApplyReceipt(row.value) : row.value === null)) &&
        result.code === syncCode(value.outcomes)) return result as unknown as V0SyncOutcome;
  }
  throw new Error("Invalid v0 sync reply");
}
function checkRelocateSuccess(value: Record<string, unknown>, request: RelocateRequest): void {
  const invalid = () => new Error("Invalid v0 relocate reply");
  if (!object(value.home)) throw invalid();
  if (value.home.state === "running" && !Object.hasOwn(value, "stop") && text(value.terminal)) return;
  const home = decodeManagedHome(value.home);
  const stop = value.stop;
  if (home.state !== "stopped" || home.sessionId !== request.sessionId || home.machineId !== request.destinationMachine ||
      Object.keys(value).length !== 4 || Object.hasOwn(value, "terminal") || value.moveId !== home.moveId ||
      (value.disposition !== "already-home" && value.disposition !== "relocated" && value.disposition !== "undone") ||
      !object(stop) || Object.keys(stop).length !== 7 || stop.sessionId !== home.sessionId || stop.machineId !== home.machineId ||
      stop.homeEpoch !== home.epoch || stop.homeState !== "stopped" ||
      (stop.status !== "stopped" && stop.status !== "stopping" && stop.status !== "stop-pending") ||
      (stop.reason !== null && !text(stop.reason)) ||
      (stop.observedAt !== null && (typeof stop.observedAt !== "number" || !Number.isSafeInteger(stop.observedAt) || stop.observedAt < 0)) ||
      (stop.status !== "stop-pending" && stop.observedAt === null)) throw invalid();
}
async function reclaim(path: string): Promise<void> {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!stat.isSocket() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid()) throw new Error("Unsafe v0 socket");
  await new Promise<void>((done, reject) => {
    const socket = createConnection(path); socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("Uncertain v0 socket")); });
    socket.once("connect", () => { socket.destroy(); reject(new Error("V0 socket already active")); });
    socket.once("error", error => { socket.destroy(); if (["ECONNREFUSED", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) done(); else reject(error); });
  });
  const current = lstatSync(path);
  if (!current.isSocket() || current.dev !== stat.dev || current.ino !== stat.ino) throw new Error("V0 socket changed");
  unlinkSync(path);
}
export async function serveV0Control(root: string, services: V0HubControlServices): Promise<{ close(): Promise<void> }> {
  const path = socketPath(root); privateDirectory(dirname(path)); await reclaim(path);
  const sockets = new Set<Socket>(), requests = new Set<Promise<void>>();
  let accepting = true;
  const server = createServer(socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); socket.setTimeout(CONTROL_TIMEOUT, () => socket.destroy());
    let bytes = Buffer.alloc(0), received = false;
    socket.on("data", data => {
      if (!accepting) { socket.destroy(); return; }
      if (received) return;
      bytes = Buffer.concat([bytes, data]); const end = bytes.indexOf(10);
      if (end < 0 && bytes.length < MAX_REQUEST) return;
      received = true; socket.pause();
      const send = async (value: unknown) => {
        const encoded = JSON.stringify(value) + "\n";
        if (socket.destroyed) return;
        // Drain includes flushing the reply, even if it exceeds the socket's write buffer.
        await new Promise<void>(done => {
          const finish = () => { socket.off("close", finish); done(); };
          socket.once("close", finish);
          socket.end(Buffer.byteLength(encoded) <= MAX_REPLY ? encoded : "{}\n", finish);
        });
      };
      let request: Request;
      try { if (end < 0 || end >= MAX_REQUEST || end !== bytes.length - 1) throw new Error(); request = parse(bytes.subarray(0, end)); }
      catch { void send({ version: 1, error: "invalid-arguments" }); return; }
      const task = (async () => {
        const result = request.kind === "sync" ? await services.sync(request.request)
          : request.kind === "relocate" ? await services.relocate(request.request) : await services.setHome(request.request);
        await send({ version: 1, kind: request.kind, result });
      })().catch(() => send({ version: 1, error: "home-unavailable" })).finally(() => requests.delete(task));
      requests.add(task);
    });
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(path, () => { server.off("error", reject); done(); }); });
  chmodSync(path, 0o600); server.on("error", () => {});
  let closing: Promise<void> | undefined;
  return { close() { return closing ??= (async () => {
    // Wait for relocation effects before releasing its stores. Stop accepting
    // new requests while allowing current clients to receive their result.
    accepting = false;
    const closed = new Promise<void>(done => server.close(() => done()));
    await Promise.allSettled([...requests]);
    for (const socket of sockets) socket.destroy();
    await closed;
  })(); } };
}
export function requestV0Services(root: string): V0HubControlServices {
  async function call(request: Request): Promise<unknown> {
    const path = socketPath(root), parent = lstatSync(dirname(path)), info = lstatSync(path), uid = process.getuid?.();
    if (!parent.isDirectory() || parent.isSymbolicLink() || realpathSync(dirname(path)) !== dirname(path) || !info.isSocket() || info.isSymbolicLink() ||
        uid !== undefined && (parent.uid !== uid || info.uid !== uid) || (parent.mode & 0o777) !== 0o700 || (info.mode & 0o777) !== 0o600) throw new Error("Unsafe v0 socket");
    const encoded = Buffer.from(JSON.stringify(request) + "\n"); if (encoded.length > MAX_REQUEST) throw new Error("V0 request too large");
    return new Promise((done, reject) => {
      const socket = createConnection(path); let bytes = Buffer.alloc(0), finished = false;
      const finish = () => { finished = true; clearTimeout(deadline); };
      const fail = (error: unknown) => { if (!finished) { finish(); socket.destroy(); reject(error); } };
      const timeout = () => fail(new Error("V0 control timed out"));
      const deadline = request.kind === "sync" ? setTimeout(timeout, CONTROL_TIMEOUT) : undefined;
      if (request.kind !== "sync") socket.setTimeout(CONTROL_TIMEOUT, timeout);
      socket.once("error", fail); socket.once("connect", () => socket.write(encoded));
      socket.once("close", () => fail(new Error("V0 control closed before its reply")));
      socket.on("data", data => {
        if (bytes.length + data.length > MAX_REPLY) fail(new Error("V0 reply too large"));
        else bytes = Buffer.concat([bytes, data]);
      });
      socket.once("end", () => {
        if (finished) return;
        try {
          const value = decode(bytes);
          if (!object(value) || value.version !== 1 || value.kind !== request.kind) throw new Error("Invalid v0 reply");
          if (request.kind === "sync") {
            if (Object.keys(value).length !== 3 || bytes.length === 0 || bytes.indexOf(10) !== bytes.length - 1) throw new Error("Invalid v0 sync frame");
            const result = parseSyncReply(value.result);
            finish(); done(result); return;
          }
          if (!object(value.result) || typeof value.result.ok !== "boolean" ||
              (value.result.ok ? !object(value.result.value) : !object(value.result.refusal) || !text(value.result.refusal.code) || !text(value.result.refusal.message) || !text(value.result.refusal.nextStep))) throw new Error("Invalid v0 reply");
          if (request.kind === "relocate" && value.result.ok === true && object(value.result.value))
            checkRelocateSuccess(value.result.value, request.request);
          finish(); done(value.result);
        } catch (error) { fail(error); }
      });
    });
  }
  return {
    async sync(request) { return await call({ version: 1, kind: "sync", request }) as V0SyncOutcome; },
    async relocate(request) { return await call({ version: 1, kind: "relocate", request }) as SettledRelocateOutcome; },
    async setHome(request) { return await call({ version: 1, kind: "set-home", request }) as Awaited<ReturnType<V0ControlServices["setHome"]>>; },
  };
}
