import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { assertTestConfigPath } from "@spider/db-core";
import type { JsonObject } from "@spider/db-core/roam/types";
import { privateDirectory } from "./staging";

const MAX_REQUEST = 32 * 1024;
const MAX_REPLY = 1024 * 1024;
const DEADLINE = 30 * 60_000;

export type HubControlRequest = { op: "status" } | { op: "disable" } | { op: "sync"; machine?: string };
export interface HubControlReply { code: 0 | 1 | 2 | 3; reason: string; value: JsonObject | null }

function socketPath(file: string): string {
  if (!isAbsolute(file) || /[\u0000-\u001f\u007f]/.test(file)) throw new Error("An absolute control socket path is required");
  const path = resolve(file);
  if (process.platform === "win32" || Buffer.byteLength(path) > (process.platform === "darwin" ? 103 : 107))
    throw new Error("The private control socket path is unsupported or too long");
  assertTestConfigPath(path);
  return path;
}
function parseRequest(bytes: Buffer): HubControlRequest | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    if ((input.op === "status" || input.op === "disable") && Object.keys(input).length === 1) return { op: input.op };
    if (input.op === "sync" && Object.keys(input).every(key => key === "op" || key === "machine") &&
        (input.machine === undefined || typeof input.machine === "string" && input.machine.length > 0 && input.machine.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(input.machine)))
      return input.machine === undefined ? { op: "sync" } : { op: "sync", machine: input.machine as string };
  } catch { /* Invalid input never reaches a control handler. */ }
  return null;
}
function removeStaleSocket(file: string): void {
  try {
    const stat = lstatSync(file);
    if (!stat.isSocket() || stat.isSymbolicLink() || typeof process.getuid === "function" && stat.uid !== process.getuid())
      throw new Error("Unsafe control socket or symlink");
    unlinkSync(file);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** The caller holds the hub process lock before reclaiming a stale socket. */
export async function startHubControl(file: string, handler: (request: HubControlRequest) => Promise<HubControlReply>): Promise<{ close(): Promise<void> }> {
  const path = socketPath(file);
  privateDirectory(dirname(path));
  removeStaleSocket(path);
  const sockets = new Set<Socket>(), requests = new Set<Promise<void>>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(DEADLINE, () => socket.destroy());
    let input = Buffer.alloc(0), received = false;
    const send = (reply: HubControlReply) => {
      if (socket.destroyed) return;
      const encoded = JSON.stringify(reply) + "\n";
      socket.end(Buffer.byteLength(encoded) <= MAX_REPLY ? encoded : JSON.stringify({ code: 1, reason: "Reply too large", value: null }) + "\n");
    };
    socket.on("data", bytes => {
      if (received) return;
      input = Buffer.concat([input, bytes]);
      const end = input.indexOf(10);
      if (end < 0 && input.length <= MAX_REQUEST) return;
      received = true; socket.pause();
      if (end < 0 || end > MAX_REQUEST || end !== input.length - 1) { send({ code: 2, reason: "Invalid request", value: null }); return; }
      const request = parseRequest(input.subarray(0, end)); input = Buffer.alloc(0);
      if (!request) { send({ code: 2, reason: "Invalid request", value: null }); return; }
      const task = Promise.resolve().then(() => handler(request)).then(send, () => send({ code: 1, reason: "Hub control failed", value: null }))
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
  return { close() {
    return closing ??= (async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(done => server.close(() => done()));
      await Promise.allSettled([...requests]);
    })();
  } };
}

export async function requestHubControl(file: string, request: HubControlRequest): Promise<HubControlReply> {
  const path = socketPath(file), encoded = Buffer.from(JSON.stringify(request) + "\n");
  if (encoded.length > MAX_REQUEST || !parseRequest(encoded.subarray(0, -1))) throw new Error("Invalid control request");
  return new Promise((done, reject) => {
    const socket = createConnection(path); let input = Buffer.alloc(0), finished = false;
    const fail = (error: Error) => { if (!finished) { finished = true; socket.destroy(); reject(error); } };
    socket.setTimeout(DEADLINE, () => fail(new Error("Hub control timed out")));
    socket.on("error", fail);
    socket.on("connect", () => socket.write(encoded));
    socket.on("data", bytes => { input = Buffer.concat([input, bytes]); if (input.length > MAX_REPLY) fail(new Error("Hub control reply is too large")); });
    socket.on("end", () => {
      if (finished) return;
      try {
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        const reply = value as HubControlReply;
        if (![0, 1, 2, 3].includes(reply.code) || typeof reply.reason !== "string" ||
            !(reply.value === null || typeof reply.value === "object" && !Array.isArray(reply.value))) throw new Error();
        finished = true; done(reply);
      } catch { fail(new Error("Invalid hub control reply")); }
    });
  });
}
