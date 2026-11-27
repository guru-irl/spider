import net from "node:net";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { V0_INTERCOM_MS } from "../roam-v0.js";
import {
  RELAY_BROKER_FEATURE, RELAY_MAX_LINKS, RELAY_MAX_SLOTS, RELAY_POLL_REMOTE_MS, RELAY_PROTOCOL_VERSION,
  correlatesRelayReady, isRelayLinkView, isRelayReady, isRelayResult, isRelaySubmit, parseRelayBrokerRequest,
  relayReady, relayRefused, relayUnknown, type RelayBrokerRequest, type RelayLinkView, type RelayPoll, type RelayPollReply,
  type RelayReady, type RelayResult, type RelaySubmit,
} from "../relay-protocol.js";
import { createMessageReader, writeMessage } from "./framing.js";
import { isPrivateBrokerHealth, privateBroker, samePrivateBroker } from "./roam-v0-client.js";

export type { RelayLinkView } from "../relay-protocol.js";

const HEALTH_MS = 2000;
type FailureCode = "unreachable" | "unauthorized" | "unsupported" | "invalid";
type Exchange<T> = { ok: true; value: T } | { ok: false; code: FailureCode; sent: boolean };
type Frame = Record<string, unknown>;
const invalid = () => new Error("Invalid private relay broker reply");

/** An operation owns its socket. A failed exchange never starts a broker or retries. */
async function exchange<T>(agentDir: string, budgetMs: number, signal: AbortSignal | undefined,
  request: (requestId: string, remainingMs: number) => RelayBrokerRequest, read: (frame: Frame) => T | undefined): Promise<Exchange<T>> {
  const deadline = performance.now() + budgetMs;
  if (signal?.aborted) return { ok: false, code: "unreachable", sent: false };
  let broker: ReturnType<typeof privateBroker>;
  try { broker = privateBroker(agentDir); } catch { return { ok: false, code: "unreachable", sent: false }; }
  if (!broker) return { ok: false, code: "unauthorized", sent: false };

  const requestId = randomUUID(), healthId = randomUUID();
  return new Promise(resolve => {
    const socket = net.connect(broker.path);
    let sent = false, settled = false, reply: T | undefined;
    const finish = (result: Exchange<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", fail);
      socket.destroy();
      resolve(result);
    };
    const fail = () => finish({ ok: false, code: "unreachable", sent });
    const arm = (ms: number) => { const timer = setTimeout(fail, ms); timer.unref(); return timer; };
    let timer = arm(Math.min(HEALTH_MS, Math.max(0, deadline - performance.now())));
    signal?.addEventListener("abort", fail, { once: true });
    socket.on("error", fail);
    socket.on("close", fail);
    socket.on("end", () => {
      if (reply === undefined || performance.now() >= deadline) { fail(); return; }
      finish({ ok: true, value: reply });
    });
    socket.on("connect", () => {
      try {
        if (!samePrivateBroker(broker, privateBroker(agentDir))) {
          finish({ ok: false, code: "unauthorized", sent }); return;
        }
        writeMessage(socket, { type: "health", requestId: healthId });
      } catch { fail(); }
    });
    socket.on("data", createMessageReader(value => {
      if (settled) return;
      if (!sent) {
        if (!isPrivateBrokerHealth(value, healthId, RELAY_BROKER_FEATURE)) {
          finish({ ok: false, code: "unsupported", sent }); return;
        }
        const remainingMs = Math.floor(deadline - performance.now());
        if (remainingMs <= 0) { fail(); return; }
        const outbound = request(requestId, remainingMs);
        if (!parseRelayBrokerRequest(outbound)) { finish({ ok: false, code: "invalid", sent }); return; }
        clearTimeout(timer);
        timer = arm(remainingMs);
        sent = true;
        writeMessage(socket, outbound);
        return;
      }
      if (reply !== undefined || !value || typeof value !== "object" || Array.isArray(value) ||
          !("requestId" in value) || value.requestId !== requestId) throw invalid();
      reply = read(value as Frame);
    }, fail));
  });
}

function readBatch<T>(limit: number, count: (frame: Frame) => unknown, item: (frame: Frame) => T): (frame: Frame) => readonly T[] | undefined {
  let expected: number | undefined;
  const values: T[] = [];
  return frame => {
    if (expected === undefined) {
      const n = count(frame);
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > limit) throw invalid();
      expected = n;
    } else values.push(item(frame));
    return values.length === expected ? values : undefined;
  };
}

export async function pollV0RelayBroker(agentDir: string, poll: RelayPoll, signal?: AbortSignal): Promise<RelayPollReply> {
  let ready: RelayReady;
  const read = readBatch(RELAY_MAX_SLOTS, frame => {
    if (frame.type !== "roam_v0_relay_ready" || !isRelayReady(frame.ready) || frame.ready.version !== RELAY_PROTOCOL_VERSION ||
        !correlatesRelayReady(frame.ready, poll.hello) || !frame.ready.ok && frame.count !== 0) throw invalid();
    ready = frame.ready;
    return frame.count;
  }, frame => {
    if (frame.type !== "roam_v0_relay_submission" || !isRelaySubmit(frame.submit)) throw invalid();
    return frame.submit;
  });
  const response = await exchange(agentDir, RELAY_POLL_REMOTE_MS, signal, requestId => ({ type: "roam_v0_relay", requestId, kind: "poll", poll }), frame => {
    const submissions = read(frame);
    if (!submissions) return;
    if (new Set(submissions.map(submit => submit.message.id)).size !== submissions.length) throw invalid();
    return { ready, submissions };
  });
  return response.ok ? response.value : { ready: relayReady(poll.hello, response.code === "unauthorized" ? "unauthorized" : "unreachable"), submissions: [] };
}

export async function listV0RelayLinks(agentDir: string, signal?: AbortSignal): Promise<readonly RelayLinkView[]> {
  const read = readBatch(RELAY_MAX_LINKS, frame => {
    if (frame.type !== "roam_v0_relay_links") throw invalid();
    return frame.count;
  }, frame => {
    if (frame.type !== "roam_v0_relay_link" || !isRelayLinkView(frame.link)) throw invalid();
    return frame.link;
  });
  const response = await exchange(agentDir, HEALTH_MS, signal, requestId => ({ type: "roam_v0_relay", requestId, kind: "list" }), read);
  return response.ok ? response.value : [];
}

export async function submitV0Relay(agentDir: string, relayId: string, submit: RelaySubmit, signal?: AbortSignal): Promise<RelayResult> {
  const messageId = submit.message.id;
  const response = await exchange(agentDir, V0_INTERCOM_MS, signal,
    (requestId, remainingMs) => ({ type: "roam_v0_relay", requestId, kind: "submit", relayId, submit, remainingMs }), frame => {
      if (frame.type !== "roam_v0_relay_result" || !isRelayResult(frame.result) || frame.result.messageId !== messageId) throw invalid();
      return frame.result;
    });
  return response.ok ? response.value : response.sent ? relayUnknown(messageId) : relayRefused(messageId, response.code);
}
