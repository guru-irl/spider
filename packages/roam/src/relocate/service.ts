import { chmodSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { assertTestConfigPath } from "@spider/db-core";
import { isMachineId } from "../machine-id";
import { privateDirectory } from "../staging";
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
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function socketPath(root: string): string {
  if (resolve(root) !== root) throw new Error("Invalid v0 runtime root");
  const path = join(root, "roam", "relocate.sock"); assertTestConfigPath(path);
  if (process.platform === "win32" || Buffer.byteLength(path) > (process.platform === "darwin" ? 103 : 107)) throw new Error("V0 control socket path is unsupported or too long");
  return path;
}
function decode(bytes: Buffer): unknown { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
type Request = { version: 1; kind: "relocate"; request: RelocateRequest } | { version: 1; kind: "set-home"; request: SetHomeRequest };
function parse(bytes: Buffer): Request {
  const value = decode(bytes);
  if (!object(value) || value.version !== 1 || !["relocate", "set-home"].includes(value.kind as string) || Object.keys(value).length !== 3 || !object(value.request)) throw new Error("Invalid v0 control");
  const r = value.request;
  if (!text(r.sessionId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(r.sessionId) || !isMachineId(r.destinationMachine)) throw new Error("Invalid v0 target");
  if (value.kind === "relocate" ? Object.keys(r).length !== 2 : Object.keys(r).length !== 4 || r.force !== true || !text(r.confirmation)) throw new Error("Invalid v0 confirmation");
  return value as Request;
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
export async function serveV0Control(root: string, services: V0ControlServices): Promise<{ close(): Promise<void> }> {
  const path = socketPath(root); privateDirectory(dirname(path)); await reclaim(path);
  const sockets = new Set<Socket>(), requests = new Set<Promise<void>>();
  let accepting = true;
  const server = createServer(socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); socket.setTimeout(30 * 60_000, () => socket.destroy());
    let bytes = Buffer.alloc(0), received = false;
    socket.on("data", data => {
      if (!accepting) { socket.destroy(); return; }
      if (received) return;
      bytes = Buffer.concat([bytes, data]); const end = bytes.indexOf(10);
      if (end < 0 && bytes.length <= MAX_REQUEST) return;
      received = true; socket.pause();
      const send = (value: unknown) => { const encoded = JSON.stringify(value) + "\n"; if (!socket.destroyed) socket.end(Buffer.byteLength(encoded) <= MAX_REPLY ? encoded : "{}\n"); };
      let request: Request;
      try { if (end < 0 || end > MAX_REQUEST || end !== bytes.length - 1) throw new Error(); request = parse(bytes.subarray(0, end)); }
      catch { send({ version: 1, error: "invalid-arguments" }); return; }
      const task = (async () => {
        const result = request.kind === "relocate" ? await services.relocate(request.request) : await services.setHome(request.request);
        send({ version: 1, kind: request.kind, result });
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
export function requestV0Services(root: string): V0ControlServices {
  async function call(request: Request): Promise<unknown> {
    const path = socketPath(root), parent = lstatSync(dirname(path)), info = lstatSync(path), uid = process.getuid?.();
    if (!parent.isDirectory() || parent.isSymbolicLink() || realpathSync(dirname(path)) !== dirname(path) || !info.isSocket() || info.isSymbolicLink() ||
        uid !== undefined && (parent.uid !== uid || info.uid !== uid) || (parent.mode & 0o777) !== 0o700 || (info.mode & 0o777) !== 0o600) throw new Error("Unsafe v0 socket");
    const encoded = Buffer.from(JSON.stringify(request) + "\n"); if (encoded.length > MAX_REQUEST) throw new Error("V0 request too large");
    return new Promise((done, reject) => {
      const socket = createConnection(path); let bytes = Buffer.alloc(0);
      socket.setTimeout(30 * 60_000, () => socket.destroy(new Error("V0 control timed out")));
      socket.once("error", reject); socket.once("connect", () => socket.write(encoded));
      socket.on("data", data => { bytes = Buffer.concat([bytes, data]); if (bytes.length > MAX_REPLY) socket.destroy(new Error("V0 reply too large")); });
      socket.once("end", () => {
        try {
          const value = decode(bytes);
          if (!object(value) || value.version !== 1 || value.kind !== request.kind || !object(value.result) || typeof value.result.ok !== "boolean" ||
              (value.result.ok ? !object(value.result.value) : !object(value.result.refusal) || !text(value.result.refusal.code) || !text(value.result.refusal.message) || !text(value.result.refusal.nextStep))) throw new Error("Invalid v0 reply");
          done(value.result);
        } catch (error) { reject(error); }
      });
    });
  }
  return {
    async relocate(request) { return await call({ version: 1, kind: "relocate", request }) as Awaited<ReturnType<V0ControlServices["relocate"]>>; },
    async setHome(request) { return await call({ version: 1, kind: "set-home", request }) as Awaited<ReturnType<V0ControlServices["setHome"]>>; },
  };
}
