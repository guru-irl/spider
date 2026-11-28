import net from "node:net";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  parseV0BrokerReply, parseV0RelayAskBrokerRequest, parseV0RelayReplyAuthorization, V0_ASK_MAX_MS, V0_INTERCOM_MS,
  type V0Delivery, type V0Endpoint, type V0RelayAskBrokerRequest, type V0RelayAskInput, type V0RelayReplyAuthorization,
} from "../roam-v0.js";
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
const WAITER_RESULT_RESERVE_MS = 250;
type Request = RelayBrokerRequest | V0RelayAskBrokerRequest;
type FailureCode = "unreachable" | "unauthorized" | "unsupported" | "invalid";
type Exchange<T> = { ok: true; value: T } | { ok: false; code: FailureCode; sent: boolean };
type Frame = Record<string, unknown>;
const invalid = () => new Error("Invalid private relay broker reply");

/** An operation owns its socket. A failed exchange never starts a broker or retries. */
async function exchange<T>(agentDir: string, budgetMs: number, signal: AbortSignal | undefined,
  request: (requestId: string, remainingMs: number) => Request, read: (frame: Frame) => T | undefined): Promise<Exchange<T>> {
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
        if (!(outbound.type === "roam_v0_relay_ask" ? parseV0RelayAskBrokerRequest(outbound) : parseRelayBrokerRequest(outbound))) {
          finish({ ok: false, code: "invalid", sent }); return;
        }
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

export async function beginV0RelayAsk(agentDir: string, input: V0RelayAskInput, signal?: AbortSignal): Promise<{ result: Promise<V0Delivery>; close(): void }> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) throw invalid();
  const askMs = Math.min(input.timeoutMs, V0_ASK_MAX_MS);
  const controller = new AbortController();
  const close = () => controller.abort();
  let confirmReady!: () => void, rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { confirmReady = resolve; rejectReady = reject; });
  let registered = false;
  const timer = setTimeout(close, Math.min(askMs, HEALTH_MS));
  timer.unref();
  const result = exchange<V0Delivery>(agentDir, askMs + WAITER_RESULT_RESERVE_MS,
    signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
    (requestId, remainingMs) => ({ type: "roam_v0_relay_ask", requestId, kind: "begin", ...input,
      timeoutMs: remainingMs - WAITER_RESULT_RESERVE_MS }), frame => {
      if (frame.type === "roam_v0_relay_ask_ready" && !registered && Object.keys(frame).length === 2) {
        registered = true;
        clearTimeout(timer);
        confirmReady();
        return;
      }
      const answer = parseV0BrokerReply(frame);
      if (!answer || answer.kind === "matches" || answer.kind === "socket_delivered" ||
          answer.kind !== "refused" && (!registered || answer.id !== input.askId)) throw invalid();
      const { type: _type, requestId: _id, ...delivery } = answer;
      return delivery;
    }).then(response => {
      if (!registered) rejectReady(new Error("The local broker could not register the ask waiter"));
      return response.ok ? response.value : { kind: "unknown" as const, id: input.askId };
    }, error => {
      rejectReady(error);
      return { kind: "unknown" as const, id: input.askId };
    }).finally(() => clearTimeout(timer));
  await ready;
  return { result, close };
}

export async function authorizeV0RelayReply(agentDir: string, from: V0Endpoint, askId: string, signal?: AbortSignal): Promise<V0RelayReplyAuthorization> {
  const response = await exchange(agentDir, HEALTH_MS, signal,
    requestId => ({ type: "roam_v0_relay_ask", requestId, kind: "authorize", from, askId }), frame => {
      const authorization = frame.type === "roam_v0_relay_reply_authorization" && parseV0RelayReplyAuthorization(frame.authorization);
      if (!authorization) throw invalid();
      return authorization;
    });
  return response.ok ? response.value : { kind: "refused", code: response.code };
}

export async function submitV0Relay(agentDir: string, relayId: string, submit: RelaySubmit,
  signal?: AbortSignal, budgetMs = V0_INTERCOM_MS): Promise<RelayResult> {
  const messageId = submit.message.id;
  const response = await exchange(agentDir, Math.min(budgetMs, V0_INTERCOM_MS), signal,
    (requestId, remainingMs) => ({ type: "roam_v0_relay", requestId, kind: "submit", relayId, submit, remainingMs }), frame => {
      if (frame.type !== "roam_v0_relay_result" || !isRelayResult(frame.result) || frame.result.messageId !== messageId) throw invalid();
      return frame.result;
    });
  if (response.ok) return response.value;
  if (response.sent) return relayUnknown(messageId);
  return relayRefused(messageId, response.code === "unreachable" ? "relay-stopping" : response.code);
}
