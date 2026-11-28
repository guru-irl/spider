import { createHash } from "node:crypto";
import { chmodSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { assertTestConfigPath } from "@spider/db-core";
import type { JsonObject, MachineId } from "@spider/db-core/roam/types";
import { isMachineId } from "./machine-id.js";
import type { OwnerGeneration } from "./relocate/session-stop-types.js";
import type { SessionId } from "./relocate/types.js";
import type { Operation, Outcome } from "./contracts.js";
import { validSessionControl } from "./session-control.js";
import { privateDirectory } from "./staging.js";

const MAX_REQUEST = 32 * 1024;
const MAX_REPLY = 1024 * 1024;
const DEADLINE = 30 * 60_000;
type Verb = "inspect" | "freeze" | "unfreeze" | "shutdown" | "readmit";
export interface SessionControlRequest { op: Verb; operation: Operation }

function verb(operation: Operation): Verb | null {
  switch (operation.kind) {
    case "session-inspect": return "inspect";
    case "session-freeze": return "freeze";
    case "session-unfreeze": return "unfreeze";
    case "session-readmit": return "readmit";
    case "session-shutdown": case "session-retire": return "shutdown";
    default: return null;
  }
}
function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
}
/** The short hashed directory is stable across live and dormant participants. */
export function sessionControlPath(runtimeRoot: string, sessionId: string): string {
  if (!isAbsolute(runtimeRoot) || resolve(runtimeRoot) !== runtimeRoot || !validText(sessionId)) throw new Error("Invalid session control path");
  const path = join(runtimeRoot, createHash("sha256").update(sessionId).digest("hex").slice(0, 32), "s");
  if (process.platform === "win32" || Buffer.byteLength(path) > (process.platform === "darwin" ? 103 : 107))
    throw new Error("The private session socket path is unsupported or too long");
  assertTestConfigPath(path);
  return path;
}
function validReadmit(operation: Operation): boolean {
  return operation?.kind === "session-readmit" && validSessionControl({ ...operation, kind: "session-unfreeze" }) &&
    !!operation.args.source && typeof operation.args.source === "object" && !!operation.args.restoredHome && typeof operation.args.restoredHome === "object" &&
    typeof operation.args.file === "string" && isAbsolute(operation.args.file);
}
export interface V0OwnerControl {
  kind: "stopped-shutdown" | "running-inspect";
  sessionId: SessionId;
  machineId: MachineId;
  homeMachineId: MachineId;
  epoch: number;
  owner: OwnerGeneration;
}

export function parseV0OwnerControl(operation: Operation): V0OwnerControl | null {
  const args = operation?.args, epoch = operation?.expectedEpoch;
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 5 || args.v0 !== true ||
      !validText(operation.id) || !isMachineId(operation.machineId) || typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1 ||
      !validText(args.sessionId) || !args.sessionId.trim() || !isMachineId(args.homeMachineId)) return null;
  const owner = args.owner;
  if (!owner || typeof owner !== "object" || Array.isArray(owner) || Object.keys(owner).length !== 3 ||
      typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
      !validText(owner.startIdentity) || !validText(owner.bootId)) return null;
  const kind = operation.kind === "session-shutdown" && args.homeState === "stopped" ? "stopped-shutdown"
    : operation.kind === "session-inspect" && args.homeState === "running" ? "running-inspect" : null;
  return kind && { kind, sessionId: args.sessionId as SessionId, machineId: operation.machineId, homeMachineId: args.homeMachineId,
    epoch, owner: { pid: owner.pid, startIdentity: owner.startIdentity, bootId: owner.bootId } };
}

function validSocketOperation(operation: Operation, v0OwnerControl: boolean): boolean {
  const args = operation.args;
  // An owner request with a stray moveId must not become a legacy request.
  if (args?.v0 === true && ("homeState" in args || "homeMachineId" in args || "owner" in args))
    return v0OwnerControl && parseV0OwnerControl(operation) !== null;
  return validSessionControl(operation) || validReadmit(operation);
}
function parseRequest(bytes: Buffer, v0OwnerControl: boolean): SessionControlRequest | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length !== 2 || !("op" in row) || !("operation" in row) ||
        !row.operation || typeof row.operation !== "object" || Array.isArray(row.operation)) return null;
    const operation = row.operation as Operation;
    if (!validSocketOperation(operation, v0OwnerControl) || row.op !== verb(operation)) return null;
    return { op: row.op as Verb, operation };
  } catch { return null; }
}
const invalid = (): Outcome<JsonObject> => ({ code: 2, reason: "invalid-session-control", operationId: "", home: null, epoch: null, repairCommand: null, value: null });

/** Caller holds the session ID and file leases before reclaiming a stale socket. */
async function reclaim(path: string): Promise<void> {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!stat.isSocket() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid()) throw new Error("Unsafe session control socket");
  await new Promise<void>((done, reject) => {
    const socket = createConnection(path);
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("Session control socket state is uncertain")); });
    socket.once("connect", () => { socket.destroy(); reject(new Error("Session control socket is already active")); });
    socket.once("error", error => {
      socket.destroy();
      if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED" || (error as NodeJS.ErrnoException).code === "ENOENT") done();
      else reject(error);
    });
  });
  try {
    const current = lstatSync(path);
    if (!current.isSocket() || current.dev !== stat.dev || current.ino !== stat.ino) throw new Error("Session control socket changed");
    unlinkSync(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export async function startSessionControlSocket(runtimeRoot: string, sessionId: string,
  handler: (request: SessionControlRequest) => Promise<Outcome<JsonObject>>,
  options: { v0OwnerControl?: boolean } = {}): Promise<{ close(): Promise<void> }> {
  const path = sessionControlPath(runtimeRoot, sessionId);
  privateDirectory(runtimeRoot); privateDirectory(dirname(path));
  await reclaim(path);
  const sockets = new Set<Socket>(), requests = new Set<Promise<void>>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(DEADLINE, () => socket.destroy());
    let input = Buffer.alloc(0), received = false;
    const send = (reply: Outcome<JsonObject>) => {
      if (socket.destroyed) return;
      try {
        const encoded = JSON.stringify(reply) + "\n";
        socket.end(Buffer.byteLength(encoded) <= MAX_REPLY ? encoded : JSON.stringify(invalid()) + "\n");
      } catch { socket.end(JSON.stringify(invalid()) + "\n"); }
    };
    socket.on("data", bytes => {
      if (received) return;
      input = Buffer.concat([input, bytes]);
      const end = input.indexOf(10);
      if (end < 0 && input.length <= MAX_REQUEST) return;
      received = true; socket.pause();
      if (end < 0 || end > MAX_REQUEST || end !== input.length - 1) { send(invalid()); return; }
      const request = parseRequest(input.subarray(0, end), options.v0OwnerControl === true); input = Buffer.alloc(0);
      if (!request || request.operation.args.sessionId !== sessionId) { send(invalid()); return; }
      const task = Promise.resolve().then(() => handler(request)).then(send, () => send({ ...invalid(), code: 1, reason: "session-control-failed", operationId: request.operation.id, epoch: request.operation.expectedEpoch }))
        .finally(() => requests.delete(task));
      requests.add(task);
    });
  });
  try {
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(path, () => { server.off("error", reject); done(); }); });
    chmodSync(path, 0o600);
  } catch (error) { server.close(); throw error; }
  server.on("error", () => {});
  let closing: Promise<void> | undefined;
  return { close() { return closing ??= (async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(done => server.close(() => done()));
    await Promise.allSettled([...requests]);
  })(); } };
}

export async function requestSessionControl(runtimeRoot: string, operation: Operation, options: { timeoutMs?: number } = {}): Promise<Outcome<JsonObject>> {
  const op = verb(operation), timeout = options.timeoutMs ?? DEADLINE;
  if (!op || !validSocketOperation(operation, true) || !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > DEADLINE) throw new Error("Invalid session control request");
  const path = sessionControlPath(runtimeRoot, operation.args.sessionId as string), encoded = Buffer.from(JSON.stringify({ op, operation }) + "\n");
  if (encoded.length > MAX_REQUEST || !parseRequest(encoded.subarray(0, -1), true)) throw new Error("Invalid session control request");
  const parent = lstatSync(dirname(path)), socketInfo = lstatSync(path), uid = process.getuid?.();
  if (!parent.isDirectory() || parent.isSymbolicLink() || realpathSync(dirname(path)) !== dirname(path) || !socketInfo.isSocket() || socketInfo.isSymbolicLink() ||
      uid !== undefined && (parent.uid !== uid || socketInfo.uid !== uid) || (parent.mode & 0o7777) !== 0o700 || (socketInfo.mode & 0o7777) !== 0o600)
    throw new Error("Unsafe session control socket");
  return new Promise((done, reject) => {
    const socket = createConnection(path); let input = Buffer.alloc(0), finished = false;
    const fail = (error: Error) => { if (!finished) { finished = true; socket.destroy(); reject(error); } };
    socket.setTimeout(timeout, () => fail(new Error("Session control timed out")));
    socket.on("error", fail); socket.on("connect", () => socket.write(encoded));
    socket.on("data", bytes => { input = Buffer.concat([input, bytes]); if (input.length > MAX_REPLY) fail(new Error("Session control reply is too large")); });
    socket.on("end", () => {
      if (finished) return;
      try {
        const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input)) as Outcome<JsonObject>;
        if (!result || ![0, 1, 2, 3].includes(result.code) || typeof result.reason !== "string" || result.operationId !== operation.id ||
            result.epoch !== operation.expectedEpoch || !(result.value === null || typeof result.value === "object" && !Array.isArray(result.value))) throw new Error();
        finished = true; done(result);
      } catch { fail(new Error("Invalid session control reply")); }
    });
  });
}
