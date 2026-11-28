import net from "node:net";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  parseV0BrokerReply, parseV0BrokerRequest, V0_ASK_MAX_MS, V0_INTERCOM_FEATURE,
  type V0BrokerOp, type V0BrokerRequest, type V0Reply,
} from "../roam-v0.js";
import { createMessageReader, writeMessage } from "./framing.js";
import { INTERCOM_PROTOCOL_NAME, INTERCOM_PROTOCOL_VERSION } from "./paths.js";

const BROKER_REQUEST_MS = 2000;
const BROKER_REPLY_RESERVE_MS = 250;

interface PrivateBroker {
  path: string;
  directoryDev: number;
  directoryIno: number;
  socketDev: number;
  socketIno: number;
}

export function privateBroker(agentDir: string): PrivateBroker | null {
  if (!isAbsolute(agentDir) || resolve(agentDir) !== agentDir || realpathSync(agentDir) !== agentDir) return null;
  const agent = lstatSync(agentDir);
  const directoryPath = join(agentDir, "intercom");
  const directory = lstatSync(directoryPath);
  const socketPath = join(directoryPath, "broker.sock");
  const socket = lstatSync(socketPath);
  const owned = (uid: number) => typeof process.getuid !== "function" || uid === process.getuid();
  if (!agent.isDirectory() || agent.isSymbolicLink() || !owned(agent.uid) ||
      !directory.isDirectory() || directory.isSymbolicLink() || realpathSync(directoryPath) !== directoryPath ||
      !owned(directory.uid) || (directory.mode & 0o7777) !== 0o700 ||
      !socket.isSocket() || socket.isSymbolicLink() || !owned(socket.uid) || (socket.mode & 0o7777) !== 0o600) return null;
  return { path: socketPath, directoryDev: directory.dev, directoryIno: directory.ino, socketDev: socket.dev, socketIno: socket.ino };
}

export function samePrivateBroker(expected: PrivateBroker, current: PrivateBroker | null): boolean {
  return current !== null && current.directoryDev === expected.directoryDev && current.directoryIno === expected.directoryIno &&
    current.socketDev === expected.socketDev && current.socketIno === expected.socketIno;
}

export function isPrivateBrokerHealth(value: unknown, requestId: string, feature: string): boolean {
  if (!value || typeof value !== "object") return false;
  const health = value as Record<string, unknown>;
  return health.type === "health_ok" && health.requestId === requestId && health.protocol === INTERCOM_PROTOCOL_NAME &&
    health.version === INTERCOM_PROTOCOL_VERSION && health.implementation === "spider" &&
    Array.isArray(health.features) && health.features.includes(feature);
}

/** Never starts a broker or retries an operation whose delivery might have happened. */
export async function requestV0Broker(agentDir: string, op: V0BrokerOp, signal?: AbortSignal): Promise<V0Reply> {
  const requestId = randomUUID();
  const request = { type: "roam_v0" as const, requestId, ...op };
  if (!parseV0BrokerRequest(request)) return { kind: "refused", code: "invalid" };
  if (signal?.aborted) return { kind: "refused", code: "unreachable" };
  let broker: PrivateBroker | null;
  try { broker = privateBroker(agentDir); } catch { return { kind: "refused", code: "unreachable" }; }
  if (!broker) return { kind: "refused", code: "unauthorized" };

  const startedAt = performance.now();
  const askMs = op.kind === "ask" ? Math.min(op.timeoutMs, V0_ASK_MAX_MS) : undefined;
  return new Promise<V0Reply>(resolveResult => {
    const socket = net.connect(broker.path);
    const healthId = randomUUID();
    let sent = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const failure = (): V0Reply => sent && op.kind !== "lookup"
      ? { kind: "unknown", id: op.message.id }
      : { kind: "refused", code: "unreachable" };
    const finish = (result: V0Reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolveResult(result);
    };
    const onAbort = () => finish(failure());
    timer = setTimeout(() => finish(failure()), Math.min(BROKER_REQUEST_MS, askMs ?? BROKER_REQUEST_MS));
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("error", () => finish(failure()));
    socket.on("close", () => finish(failure()));
    socket.on("connect", () => {
      try {
        if (!samePrivateBroker(broker, privateBroker(agentDir))) {
          finish({ kind: "refused", code: "unauthorized" }); return;
        }
        writeMessage(socket, { type: "health", requestId: healthId });
      } catch { finish(failure()); }
    });
    socket.on("data", createMessageReader(value => {
      if (!sent) {
        if (!isPrivateBrokerHealth(value, healthId, V0_INTERCOM_FEATURE)) {
          finish({ kind: "refused", code: "unsupported" }); return;
        }
        let outbound: V0BrokerRequest = request;
        if (op.kind === "ask" && askMs !== undefined) {
          const remaining = Math.floor(askMs - (performance.now() - startedAt));
          // Leave room for the write and the broker's timeout result. For
          // shorter asks, reserve only a fraction of the remaining budget.
          const reserve = Math.min(BROKER_REPLY_RESERVE_MS, Math.max(1, Math.floor(remaining / 4)));
          if (remaining <= reserve) { finish(failure()); return; }
          clearTimeout(timer);
          timer = setTimeout(() => finish(failure()), remaining);
          timer.unref?.();
          outbound = { type: "roam_v0", requestId, ...op, timeoutMs: remaining - reserve };
        }
        sent = true;
        try { writeMessage(socket, outbound); } catch { finish(failure()); }
        return;
      }
      const response = parseV0BrokerReply(value, op.kind === "deliver" && op.thread?.kind === "reply");
      if (!response || response.requestId !== requestId) { finish(failure()); return; }
      const { type: _type, requestId: _requestId, ...result } = response;
      if (result.kind === "refused") { finish(result); return; }
      if (op.kind === "lookup") {
        finish(result.kind === "matches" ? result : failure()); return;
      }
      if (result.kind === "matches" || result.id !== op.message.id ||
          op.kind === "deliver" && result.kind !== "socket_delivered" && result.kind !== "unknown" ||
          op.kind === "ask" && result.kind !== "replied" && result.kind !== "no_reply" && result.kind !== "unknown") {
        finish(failure()); return;
      }
      finish(result);
    }, () => finish(failure())));
  });
}
