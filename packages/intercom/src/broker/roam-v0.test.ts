import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { startTestBroker, stopTestBroker, testBrokerEnv, testTmpDir } from "../test-support.js";
import { getAgentDirPath, getBrokerSocketPath, getIntercomDirPath } from "./paths.js";
import { requestV0Broker } from "./roam-v0-client.js";
import { createMessageReader, writeMessage } from "./framing.js";
import { IntercomClient } from "./client.js";
import type { RemoteSessionInfo } from "../types.js";
import {
  parseV0AgentReply,
  parseV0AgentRequest,
  parseV0BrokerReply,
  parseV0BrokerRequest,
  V0_INTERCOM_FEATURE,
  type V0Endpoint,
} from "../roam-v0.js";

const endpoint = {
  address: { sessionId: "recipient", scopeId: "scope-1" },
  name: "ben",
  homeEpoch: 3,
  endpointEpoch: "connection-1",
};
const origin: RemoteSessionInfo = {
  remote: true,
  id: "sender",
  address: { sessionId: "sender", scopeId: "scope-1" },
  machineId: "machine-1",
  machineAlias: "one",
  homeEpoch: 2,
  activationEpoch: "sender-connection",
  endpointEpoch: "sender-connection",
  cwd: "",
  model: "",
  startedAt: 0,
  lastActivity: 0,
};
const message = { id: "question-1", timestamp: 123, text: "hello" };
const brokerAsk = { type: "roam_v0", requestId: "request-1", kind: "ask", from: origin, target: endpoint, message, timeoutMs: 2000 };
const agentAsk = {
  version: 1,
  requestId: "request-1",
  toMachineId: "machine-2",
  from: { ...endpoint, machineId: "machine-1" },
  kind: "ask",
  target: endpoint,
  message,
  timeoutMs: 2000,
};

describe("roaming intercom envelopes", () => {
  it("accepts text-only ask requests and correlated replies", () => {
    expect(parseV0BrokerRequest(brokerAsk)).toEqual(brokerAsk);
    expect(parseV0AgentRequest(agentAsk)).toEqual(agentAsk);
    const response = { kind: "replied", id: "question-1", replyId: "reply-1", text: "answer" };
    const brokerReply = { type: "roam_v0_result", requestId: "request-1", ...response };
    const agentReply = { version: 1, requestId: "request-1", machineId: "machine-2", ...response };
    expect(parseV0BrokerReply(brokerReply)).toEqual(brokerReply);
    expect(parseV0AgentReply(agentReply)).toEqual(agentReply);
    expect(parseV0BrokerReply({ type: "roam_v0_result", requestId: "request-1", kind: "no_reply", id: "question-1" }))
      .toEqual({ type: "roam_v0_result", requestId: "request-1", kind: "no_reply", id: "question-1" });
  });

  it("accepts lookup and ordinary delivery envelopes", () => {
    const lookupRequest = { type: "roam_v0", requestId: "lookup-1", kind: "lookup", scopeId: null, selector: { by: "id", value: "recipient" } };
    const delivery = { type: "roam_v0", requestId: "delivery-1", kind: "deliver", from: origin, target: endpoint, message };
    const agentLookup = { version: 1, requestId: "lookup-1", toMachineId: "machine-2", from: { ...endpoint, machineId: "machine-1" }, kind: "lookup", selector: { by: "name", value: "ben" } };
    const agentDelivery = { version: 1, requestId: "delivery-1", toMachineId: "machine-2", from: { ...endpoint, machineId: "machine-1" }, kind: "deliver", target: endpoint, message };
    expect(parseV0BrokerRequest(lookupRequest)).toEqual(lookupRequest);
    expect(parseV0BrokerRequest(delivery)).toEqual(delivery);
    expect(parseV0AgentRequest(agentLookup)).toEqual(agentLookup);
    expect(parseV0AgentRequest(agentDelivery)).toEqual(agentDelivery);
    const matches = { type: "roam_v0_result", requestId: "lookup-1", kind: "matches", targets: [endpoint] };
    expect(parseV0BrokerReply(matches)).toEqual(matches);
    const refusal = { version: 1, requestId: "delivery-1", machineId: "machine-2", kind: "refused", code: "moving" };
    expect(parseV0AgentReply(refusal)).toEqual(refusal);
  });

  it("rejects extra fields and local-only handles in a remote sender", () => {
    expect(parseV0BrokerRequest({ ...brokerAsk, extra: true })).toBeNull();
    expect(parseV0BrokerRequest({ ...brokerAsk, from: { ...origin, pid: 123 } })).toBeNull();
    expect(parseV0BrokerRequest({ ...brokerAsk, message: { ...message, attachments: [] } })).toBeNull();
    expect(parseV0AgentRequest({ ...agentAsk, target: { ...endpoint, extra: true } })).toBeNull();
    expect(parseV0AgentReply({ version: 1, requestId: "request-1", machineId: "machine-2", kind: "no_reply", id: "question-1", extra: true })).toBeNull();
  });

  it("rejects invalid identifiers, scopes, epochs, and ask timeouts", () => {
    expect(parseV0BrokerRequest({ ...brokerAsk, requestId: "  " })).toBeNull();
    expect(parseV0BrokerRequest({ ...brokerAsk, message: { ...message, id: "bad\nid" } })).toBeNull();
    expect(parseV0BrokerRequest({ ...brokerAsk, target: { ...endpoint, address: { sessionId: "recipient", scopeId: "\u0000" } } })).toBeNull();
    expect(parseV0BrokerRequest({ ...brokerAsk, target: { ...endpoint, homeEpoch: 0 } })).toBeNull();
    expect(parseV0BrokerRequest({ ...brokerAsk, timeoutMs: 0 })).toBeNull();
    expect(parseV0BrokerRequest({ ...brokerAsk, from: { ...origin, address: { ...origin.address, sessionId: "someone-else" } } })).toBeNull();
  });

  it("bounds encoded requests and replies, including multibyte text", () => {
    expect(parseV0BrokerRequest({ ...brokerAsk, message: { ...message, text: "🦊".repeat(70_000) } })).toBeNull();
    expect(parseV0AgentReply({ version: 1, requestId: "request-1", machineId: "machine-2", kind: "replied", id: "question-1", replyId: "reply-1", text: "x".repeat(262_144) })).toBeNull();
  });
});

describe("private roaming broker", () => {
  let broker: ChildProcess;
  const clients: IntercomClient[] = [];

  async function register(stableId: string, persistentId: string, name: string, scopeId: string, v0HomeEpoch?: number, runtimeFallbackAlias = false, onMessage?: (...args: unknown[]) => void) {
    const client = new IntercomClient();
    if (onMessage) client.on("message", onMessage);
    clients.push(client);
    const prior = process.env.PI_INTERCOM_SCOPE_ID;
    process.env.PI_INTERCOM_SCOPE_ID = scopeId;
    try {
      await client.connect({
        address: { sessionId: persistentId, scopeId }, name, cwd: "/fixture", model: "fixture",
        pid: process.pid, startedAt: 1, lastActivity: 1, runtimeFallbackAlias,
        ...(v0HomeEpoch === undefined ? {} : { v0HomeEpoch }),
      }, stableId);
    } finally {
      if (prior === undefined) delete process.env.PI_INTERCOM_SCOPE_ID;
      else process.env.PI_INTERCOM_SCOPE_ID = prior;
    }
    return client;
  }

  async function request(op: Record<string, unknown>): Promise<Record<string, unknown>> {
    const socket = net.connect(getBrokerSocketPath());
    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        socket.on("error", error => { if (!settled) reject(error); });
        socket.on("close", () => { if (!settled) reject(new Error("broker closed before roaming result")); });
        socket.on("data", createMessageReader(value => {
          const frame = value as Record<string, unknown>;
          if (frame.type === "health_ok") {
            writeMessage(socket, { type: "roam_v0", requestId: "fixture-request", ...op });
          } else if (frame.type === "roam_v0_result") {
            settled = true;
            const { type, requestId, ...result } = frame;
            resolve(result);
          }
        }, reject));
        writeMessage(socket, { type: "health", requestId: "fixture-health" });
      });
    } finally { socket.destroy(); }
  }

  function lookup(scopeId: string, by: "id" | "name", value: string) {
    return request({ kind: "lookup", scopeId, selector: { by, value } });
  }

  async function fakeBroker(features: string[], onRequest: (socket: net.Socket, frame: Record<string, unknown>) => void, healthDelayMs = 0) {
    const dir = mkdtempSync(join(testTmpDir(), "f-"));
    mkdirSync(join(dir, "intercom"), { mode: 0o700 });
    const path = join(dir, "intercom", "broker.sock");
    const server = net.createServer(socket => {
      socket.on("error", () => {});
      socket.on("data", createMessageReader(value => {
        const frame = value as Record<string, unknown>;
        if (frame.type === "health") {
          const sendHealth = () => writeMessage(socket, { type: "health_ok", requestId: frame.requestId, protocol: "pi-intercom", version: 1, implementation: "spider", features });
          if (healthDelayMs) setTimeout(sendHealth, healthDelayMs);
          else sendHealth();
        } else onRequest(socket, frame);
      }, () => socket.destroy()));
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    chmodSync(path, 0o600);
    return {
      dir,
      async close() {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  beforeAll(async () => {
    broker = startTestBroker(process.execPath, ["dist/intercom/broker.mjs"], {
      env: testBrokerEnv(), stdio: ["ignore", "pipe", "pipe"],
    }, "suite");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture broker startup timed out")), 4000);
      broker.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture broker exit ${code}`)); });
      broker.stdout!.on("data", chunk => {
        if (String(chunk).includes("Intercom broker started")) { clearTimeout(timer); resolve(); }
      });
    });
  }, 5000);

  afterEach(async () => { for (const client of clients.splice(0)) await client.disconnect(); });
  afterAll(async () => { if (broker) await stopTestBroker(broker); }, 5000);

  it("looks up persistent IDs and explicit names only in the requested scope", async () => {
    await register("stable-b", "b", "ben", "scope-1", 3);
    await register("stable-c", "c", "ben", "scope-2", 4);
    await register("stable-d", "d", "unmanaged", "scope-1");
    await register("stable-e", "e", "fallback", "scope-1", 5, true);

    const result = await lookup("scope-1", "name", "BEN");
    expect(result).toEqual({ kind: "matches", targets: [{
      address: { sessionId: "b", scopeId: "scope-1" }, name: "ben", homeEpoch: 3,
      endpointEpoch: expect.any(String),
    }] });
    expect(await lookup("scope-1", "id", "b")).toEqual(result);
    expect(await lookup("scope-1", "id", "stable-b")).toEqual({ kind: "matches", targets: [] });
    expect(await lookup("scope-1", "name", "unmanaged")).toEqual({ kind: "matches", targets: [] });
    expect(await lookup("scope-1", "name", "fallback")).toEqual({ kind: "matches", targets: [] });
    expect(await lookup("scope-2", "name", "ben")).toEqual({ kind: "matches", targets: [{
      address: { sessionId: "c", scopeId: "scope-2" }, name: "ben", homeEpoch: 4,
      endpointEpoch: expect.any(String),
    }] });
    expect(await lookup("scope-3", "name", "ben")).toEqual({ kind: "matches", targets: [] });
  });

  it("dispatches one ordinary text message to the pinned live endpoint", async () => {
    const ben = await register("stable-b", "b", "ben", "scope-1", 3);
    const found = await lookup("scope-1", "name", "ben");
    const target = (found.targets as V0Endpoint[])[0];
    const observed = once(ben, "message");
    expect(await request({ kind: "deliver", from: origin, target, message })).toEqual({ kind: "socket_delivered", id: "question-1" });
    const [from, received] = await observed;
    expect(from).toEqual(origin);
    expect(received).toMatchObject({ id: "question-1", timestamp: 123, content: { text: "hello" } });
  });

  it("refuses cross-scope, forged, offline, and reconnected deliveries without retargeting", async () => {
    const ben = await register("stable-b", "b", "ben", "scope-1", 3);
    const found = await lookup("scope-1", "name", "ben");
    const target = (found.targets as V0Endpoint[])[0];
    const inbox: unknown[] = [];
    ben.on("message", (...args) => inbox.push(args));
    const scopeTwo = { ...origin, address: { ...origin.address, scopeId: "scope-2" } };
    expect(await request({ kind: "deliver", from: scopeTwo, target, message })).toEqual({ kind: "refused", code: "unauthorized" });
    expect(await request({ kind: "deliver", from: origin, target: { ...target, address: { ...target.address, scopeId: "scope-2" } }, message })).toEqual({ kind: "refused", code: "unauthorized" });
    expect(await request({ kind: "deliver", from: { ...origin, pid: 123 }, target, message })).toEqual({ kind: "refused", code: "invalid" });
    expect(await request({ kind: "deliver", from: origin, target: { ...target, homeEpoch: target.homeEpoch + 1 }, message })).toEqual({ kind: "refused", code: "changed" });
    await ben.listSessions();
    expect(inbox).toEqual([]);

    await ben.disconnect();
    expect(await request({ kind: "deliver", from: origin, target, message })).toEqual({ kind: "refused", code: "offline" });
    const replacement = await register("stable-b", "b", "ben", "scope-1", 3);
    const replacementInbox: unknown[] = [];
    replacement.on("message", (...args) => replacementInbox.push(args));
    expect(await request({ kind: "deliver", from: origin, target, message })).toEqual({ kind: "refused", code: "changed" });
    await replacement.listSessions();
    expect(replacementInbox).toEqual([]);
  });

  it("does not retarget an exact local send after the recipient reconnects", async () => {
    const sender = await register("stable-a", "a", "alice", "scope-1", 1);
    const old = await register("stable-b", "b", "ben", "scope-1", 3);
    const oldInfo = (await sender.listSessions()).find(item => item.id === "stable-b")!;
    await old.disconnect();
    const replacement = await register("stable-b", "b", "ben", "scope-1", 3);
    const inbox: unknown[] = [];
    replacement.on("message", (...args) => inbox.push(args));
    const result = await sender.send("ben", {
      text: "must not retarget", messageId: "exact-local-1",
      exactTarget: { id: "stable-b", endpointEpoch: oldInfo.endpointEpoch! },
    });
    expect(result).toMatchObject({ delivered: false, code: "E_TARGET_REBOUND", outcomeKnown: true });
    await replacement.listSessions();
    expect(inbox).toEqual([]);

    expect(await sender.send("ben", { text: "ordinary send" })).toMatchObject({ delivered: true, delivery: "socket_delivered" });
    await replacement.listSessions();
    expect(inbox).toHaveLength(1);
  });

  it("negotiates and sends one lookup over the configured private broker", async () => {
    await register("stable-b", "b", "ben", "scope-1", 3);
    expect(await requestV0Broker(getAgentDirPath(), { kind: "lookup", scopeId: "scope-1", selector: { by: "name", value: "ben" } }))
      .toEqual({ kind: "matches", targets: [{
        address: { sessionId: "b", scopeId: "scope-1" }, name: "ben", homeEpoch: 3,
        endpointEpoch: expect.any(String),
      }] });
  });

  it("holds a remote ask for a reply from the asked session only", async () => {
    const ben = await register("stable-b", "b", "ben", "scope-1", 3);
    const intruder = await register("stable-c", "c", "charlie", "scope-1", 4);
    const found = await lookup("scope-1", "name", "ben");
    const target = (found.targets as V0Endpoint[])[0];
    const observed = once(ben, "message").then(args => ({ kind: "inbound" as const, args }));
    const pending = requestV0Broker(getAgentDirPath(), { kind: "ask", from: origin, target, message, timeoutMs: 2000 });
    const first = await Promise.race([observed, pending.then(result => ({ kind: "finished" as const, result }))]);
    expect(first.kind).toBe("inbound");
    if (first.kind !== "inbound") return;
    expect(first.args[0]).toEqual(origin);
    expect(first.args[1]).toMatchObject({ id: "question-1", expectsReply: true, content: { text: "hello" } });

    const wrong = await intruder.send("sender", { text: "forged", replyTo: "question-1", messageId: "bad-reply" });
    expect(wrong).toMatchObject({ delivered: false, code: "E_REPLY_TARGET" });
    const answer = await ben.send("sender", { text: "answer", replyTo: "question-1", messageId: "reply-1" });
    expect(answer).toMatchObject({ delivered: true, delivery: "socket_delivered" });
    expect(await pending).toEqual({ kind: "replied", id: "question-1", replyId: "reply-1", text: "answer" });
  });

  it("returns no reply on timeout and refuses a late reply", async () => {
    const ben = await register("stable-b", "b", "ben", "scope-1", 3);
    const target = ((await lookup("scope-1", "name", "ben")).targets as V0Endpoint[])[0];
    const inbound = once(ben, "message");
    const question = { ...message, id: "timeout-question" };
    const pending = requestV0Broker(getAgentDirPath(), { kind: "ask", from: origin, target, message: question, timeoutMs: 120 });
    await inbound;
    expect(await pending).toEqual({ kind: "no_reply", id: "timeout-question" });
    const late = await ben.send("sender", { text: "late", replyTo: "timeout-question", messageId: "late-reply" });
    expect(late).toMatchObject({ delivered: false, reason: "The asker is no longer waiting." });
  });

  it("reports an aborted call as unknown and refuses its late reply", async () => {
    const ben = await register("stable-b", "b", "ben", "scope-1", 3);
    const target = ((await lookup("scope-1", "name", "ben")).targets as V0Endpoint[])[0];
    const inbound = once(ben, "message");
    const controller = new AbortController();
    const pending = requestV0Broker(getAgentDirPath(), { kind: "ask", from: origin, target, message: { ...message, id: "aborted-question" }, timeoutMs: 2000 }, controller.signal);
    await inbound;
    controller.abort();
    expect(await pending).toEqual({ kind: "unknown", id: "aborted-question" });
    const late = await ben.send("sender", { text: "late", replyTo: "aborted-question", messageId: "aborted-reply" });
    expect(late).toMatchObject({ delivered: false, reason: "The asker is no longer waiting." });
  });

  it("ends the ask when the recipient disconnects", async () => {
    const ben = await register("stable-b", "b", "ben", "scope-1", 3);
    const target = ((await lookup("scope-1", "name", "ben")).targets as V0Endpoint[])[0];
    const inbound = once(ben, "message");
    const pending = requestV0Broker(getAgentDirPath(), { kind: "ask", from: origin, target, message: { ...message, id: "closed-question" }, timeoutMs: 2000 });
    await inbound;
    await ben.disconnect();
    expect(await pending).toEqual({ kind: "no_reply", id: "closed-question" });
    const replacement = await register("stable-b", "b", "ben", "scope-1", 3);
    const late = await replacement.send("sender", { text: "late", replyTo: "closed-question", messageId: "closed-reply" });
    expect(late).toMatchObject({ delivered: false, reason: "The asker is no longer waiting." });
  });

  it("holds the negotiated connection beyond the ordinary registration deadline", async () => {
    const ben = await register("stable-b", "b", "ben", "scope-1", 3);
    const target = ((await lookup("scope-1", "name", "ben")).targets as V0Endpoint[])[0];
    const inbound = once(ben, "message");
    const pending = requestV0Broker(getAgentDirPath(), { kind: "ask", from: origin, target, message: { ...message, id: "long-question" }, timeoutMs: 2000 });
    await inbound;
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(await ben.send("sender", { text: "still waiting", replyTo: "long-question", messageId: "long-reply" })).toMatchObject({ delivered: true });
    expect(await pending).toEqual({ kind: "replied", id: "long-question", replyId: "long-reply", text: "still waiting" });
  });

  it("refuses duplicate asks and non-text replies without ending the first ask", async () => {
    const ben = await register("stable-b", "b", "ben", "scope-1", 3);
    const target = ((await lookup("scope-1", "name", "ben")).targets as V0Endpoint[])[0];
    const inbound = once(ben, "message");
    const question = { ...message, id: "unique-question" };
    const op = { kind: "ask" as const, from: origin, target, message: question, timeoutMs: 2000 };
    const pending = requestV0Broker(getAgentDirPath(), op);
    await inbound;
    expect(await requestV0Broker(getAgentDirPath(), op)).toEqual({ kind: "refused", code: "invalid" });
    expect(await ben.send("sender", { text: "bad", attachments: [{ type: "snippet", name: "file", content: "data" }], replyTo: "unique-question", messageId: "attachment-reply" }))
      .toMatchObject({ delivered: false, code: "E_INVALID_MESSAGE" });
    expect(await ben.send("sender", { text: "x".repeat(262_144), replyTo: "unique-question", messageId: "oversized-reply" }))
      .toMatchObject({ delivered: false, code: "E_INVALID_MESSAGE" });
    expect(await ben.send("sender", { text: "ok", replyTo: "unique-question", messageId: "valid-reply" })).toMatchObject({ delivered: true });
    expect(await pending).toEqual({ kind: "replied", id: "unique-question", replyId: "valid-reply", text: "ok" });
  });

  it("returns unknown without resending after a real delivery loses its acknowledgement", async () => {
    const ben = await register("stable-b", "b", "ben", "scope-1", 3);
    const target = ((await lookup("scope-1", "name", "ben")).targets as V0Endpoint[])[0];
    const inbox: unknown[] = [];
    ben.on("message", (...args) => inbox.push(args));
    const frames: Record<string, unknown>[] = [];
    const proxy = await fakeBroker([V0_INTERCOM_FEATURE], (socket, frame) => {
      frames.push(frame);
      const { type, requestId, ...op } = frame;
      void request(op).then(() => socket.destroy(), () => socket.destroy());
    });
    try {
      const result = await requestV0Broker(proxy.dir, { kind: "deliver", from: origin, target, message: { ...message, id: "lost-ack" } });
      expect(result).toEqual({ kind: "unknown", id: "lost-ack" });
      await ben.listSessions();
      expect(inbox).toHaveLength(1);
      expect(frames).toHaveLength(1);
    } finally { await proxy.close(); }
  });

  it("refuses an older broker without sending a roaming request", async () => {
    const frames: Record<string, unknown>[] = [];
    const old = await fakeBroker([], (_socket, frame) => { frames.push(frame); });
    try {
      expect(await requestV0Broker(old.dir, { kind: "lookup", scopeId: "scope-1", selector: { by: "name", value: "ben" } }))
        .toEqual({ kind: "refused", code: "unsupported" });
      expect(frames).toEqual([]);
    } finally { await old.close(); }
  });

  it("refuses a broker directory or socket with unsafe modes", async () => {
    const op = { kind: "lookup" as const, scopeId: "scope-1", selector: { by: "name" as const, value: "ben" } };
    const directory = getIntercomDirPath(), socket = getBrokerSocketPath();
    try {
      chmodSync(directory, 0o755);
      expect(await requestV0Broker(getAgentDirPath(), op)).toEqual({ kind: "refused", code: "unauthorized" });
      chmodSync(directory, 0o700);
      chmodSync(socket, 0o666);
      expect(await requestV0Broker(getAgentDirPath(), op)).toEqual({ kind: "refused", code: "unauthorized" });
    } finally {
      chmodSync(directory, 0o700);
      chmodSync(socket, 0o600);
    }
  });

  it("refuses a symlinked agent directory", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "link-"));
    try {
      const alias = join(dir, "agent");
      symlinkSync(getAgentDirPath(), alias);
      expect(await requestV0Broker(alias, { kind: "lookup", scopeId: "scope-1", selector: { by: "name", value: "ben" } }))
        .toEqual({ kind: "refused", code: "unauthorized" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("does not trust an uncorrelated delivery result", async () => {
    const frames: Record<string, unknown>[] = [];
    const peer = await fakeBroker([V0_INTERCOM_FEATURE], (socket, frame) => {
      frames.push(frame);
      writeMessage(socket, { type: "roam_v0_result", requestId: "wrong-request", kind: "socket_delivered", id: "wrong-ack" });
    });
    try {
      expect(await requestV0Broker(peer.dir, { kind: "deliver", from: origin, target: endpoint, message: { ...message, id: "wrong-ack" } }))
        .toEqual({ kind: "unknown", id: "wrong-ack" });
      expect(frames).toHaveLength(1);
    } finally { await peer.close(); }
  });

  it("refuses v0 registrations with invalid IDs, scopes, names, or epochs", async () => {
    await expect(register("bad-id", "bad\nid", "ben", "scope-1", 1)).rejects.toThrow();
    await expect(register("bad-scope", "scope-session", "ben", "scope\u0000one", 1)).rejects.toThrow();
    await expect(register("bad-name", "named-session", "bad\nname", "scope-1", 1)).rejects.toThrow();
    await expect(register("bad-epoch", "epoch-session", "ben", "scope-1", 0)).rejects.toThrow();
  });

  it("subtracts broker negotiation time from the recipient's ask budget", async () => {
    const ben = await register("stable-b", "b", "ben", "scope-1", 3);
    const target = ((await lookup("scope-1", "name", "ben")).targets as V0Endpoint[])[0];
    const proxy = await fakeBroker([V0_INTERCOM_FEATURE], (socket, frame) => {
      const { type, requestId, ...op } = frame;
      void request(op).then(result => writeMessage(socket, { type: "roam_v0_result", requestId, ...result }), () => socket.destroy());
    }, 200);
    const controller = new AbortController();
    const inbound = once(ben, "message");
    const pending = requestV0Broker(proxy.dir, { kind: "ask", from: origin, target, message: { ...message, id: "budget-question" }, timeoutMs: 1500 }, controller.signal);
    try {
      const [, question] = await inbound;
      expect(question.remainingMs).toBeLessThanOrEqual(1350);
      expect(await ben.send("sender", { text: "ok", replyTo: "budget-question", messageId: "budget-reply" })).toMatchObject({ delivered: true });
      expect(await pending).toEqual({ kind: "replied", id: "budget-question", replyId: "budget-reply", text: "ok" });
    } finally { controller.abort(); await pending; await proxy.close(); }
  });

  it("still tells a late replier that the asker stopped waiting after metadata expires", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "clock-"));
    const clock = join(dir, "now"), preload = join(dir, "clock.mjs");
    const priorAgent = process.env.PI_CODING_AGENT_DIR;
    writeFileSync(clock, String(Date.now()));
    writeFileSync(preload, `import { readFileSync } from 'node:fs'; Date.now = () => Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));`);
    process.env.PI_CODING_AGENT_DIR = dir;
    let clocked: ChildProcess | undefined;
    let ben: IntercomClient | undefined;
    try {
      clocked = startTestBroker(process.execPath, ["--import", preload, "dist/intercom/broker.mjs"], { env: testBrokerEnv(), stdio: ["ignore", "pipe", "pipe"] }, "suite");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("clocked broker startup timed out")), 4000);
        clocked!.once("exit", code => { clearTimeout(timer); reject(new Error(`clocked broker exit ${code}`)); });
        clocked!.stdout!.on("data", chunk => { if (String(chunk).includes("Intercom broker started")) { clearTimeout(timer); resolve(); } });
      });
      ben = await register("stable-b", "b", "ben", "scope-1", 3);
      const target = ((await lookup("scope-1", "name", "ben")).targets as V0Endpoint[])[0];
      const inbound = once(ben, "message");
      const controller = new AbortController();
      const pending = requestV0Broker(dir, { kind: "ask", from: origin, target, message: { ...message, id: "expired-question" }, timeoutMs: 2000 }, controller.signal);
      await inbound;
      controller.abort();
      expect(await pending).toEqual({ kind: "unknown", id: "expired-question" });
      expect(await ben.send("sender", { text: "late", replyTo: "expired-question", messageId: "first-late" }))
        .toMatchObject({ delivered: false, reason: "The asker is no longer waiting." });
      writeFileSync(clock, String(Date.now() + 2 * 60 * 60 * 1000));
      expect(await ben.send("sender", { text: "later", replyTo: "expired-question", messageId: "second-late" }))
        .toMatchObject({ delivered: false, reason: "The asker is no longer waiting." });
    } finally {
      if (ben) await ben.disconnect();
      if (clocked) await stopTestBroker(clocked);
      if (priorAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = priorAgent;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an endpoint whose explicit name changed after lookup", async () => {
    const ben = await register("stable-b", "b", "ben", "scope-1", 3);
    const target = ((await lookup("scope-1", "name", "ben")).targets as V0Endpoint[])[0];
    const inbox: unknown[] = [];
    ben.on("message", (...args) => inbox.push(args));
    ben.updatePresence({ name: "renamed" });
    await ben.listSessions();
    expect(await request({ kind: "deliver", from: origin, target, message })).toEqual({ kind: "refused", code: "changed" });
    await ben.listSessions();
    expect(inbox).toEqual([]);
  });

  it("does not queue an exact send when its recipient disconnects", async () => {
    const sender = await register("stable-a", "a", "alice", "scope-1", 1);
    const old = await register("stable-b", "b", "ben", "scope-1", 3);
    const oldInfo = (await sender.listSessions()).find(item => item.id === "stable-b")!;
    await old.disconnect();
    const result = await sender.send("ben", {
      text: "not queued", messageId: "offline-exact",
      exactTarget: { id: "stable-b", endpointEpoch: oldInfo.endpointEpoch! },
    });
    expect(result).toMatchObject({ delivered: false, code: "E_TARGET_NOT_FOUND" });
    const inbox: unknown[] = [];
    const replacement = await register("stable-b", "b", "ben", "scope-1", 3, false, (...args) => inbox.push(args));
    await replacement.listSessions();
    expect(inbox).toEqual([]);
  });

  it("keeps the ordinary local mailbox for clients without v0 admission", async () => {
    const sender = await register("legacy-a", "a", "alice", "scope-1");
    const old = await register("legacy-b", "b", "mailbox-ben", "scope-1");
    await old.disconnect();
    expect(await sender.send("mailbox-ben", { text: "queued locally", messageId: "local-mail" }))
      .toMatchObject({ delivered: true, delivery: "queued" });
    const inbox: unknown[][] = [];
    const replacement = await register("legacy-b", "b", "mailbox-ben", "scope-1", undefined, false, (...args) => inbox.push(args));
    await replacement.listSessions();
    expect(inbox).toHaveLength(1);
    expect(inbox[0][1]).toMatchObject({ id: "local-mail", content: { text: "queued locally" } });
  });

  it("keeps an accepted ask open when other unregistered sockets connect", async () => {
    const ben = await register("stable-b", "b", "ben", "scope-1", 3);
    const target = ((await lookup("scope-1", "name", "ben")).targets as V0Endpoint[])[0];
    const controller = new AbortController();
    const inbound = once(ben, "message");
    const pending = requestV0Broker(getAgentDirPath(), { kind: "ask", from: origin, target, message: { ...message, id: "pressure-question" }, timeoutMs: 2000 }, controller.signal);
    const sockets: net.Socket[] = [];
    try {
      await inbound;
      for (let i = 0; i < 32; i++) {
        const socket = net.connect(getBrokerSocketPath());
        socket.on("error", () => {});
        sockets.push(socket);
        await once(socket, "connect");
      }
      const barrier = sockets[sockets.length - 1];
      const health = new Promise<unknown>((resolve, reject) => barrier.on("data", createMessageReader(resolve, reject)));
      writeMessage(barrier, { type: "health", requestId: "pressure-health" });
      expect(await health).toMatchObject({ type: "health_ok", requestId: "pressure-health" });
      expect(await ben.send("sender", { text: "answer", replyTo: "pressure-question", messageId: "pressure-reply" })).toMatchObject({ delivered: true });
      expect(await pending).toEqual({ kind: "replied", id: "pressure-question", replyId: "pressure-reply", text: "answer" });
    } finally { controller.abort(); await pending; for (const socket of sockets) socket.destroy(); }
  });

  it("refuses excess asks before dispatch rather than evicting accepted asks", async () => {
    const ben = await register("stable-b", "b", "ben", "scope-1", 3);
    const target = ((await lookup("scope-1", "name", "ben")).targets as V0Endpoint[])[0];
    const controller = new AbortController();
    const pending: Promise<unknown>[] = [];
    try {
      for (let i = 0; i < 32; i++) {
        const inbound = once(ben, "message");
        pending.push(requestV0Broker(getAgentDirPath(), { kind: "ask", from: origin, target, message: { ...message, id: `capacity-${i}` }, timeoutMs: 2000 }, controller.signal));
        await inbound;
      }
      const inbox: unknown[] = [];
      ben.on("message", (...args) => inbox.push(args));
      expect(await requestV0Broker(getAgentDirPath(), { kind: "ask", from: origin, target, message: { ...message, id: "capacity-overflow" }, timeoutMs: 2000 }, controller.signal))
        .toEqual({ kind: "refused", code: "unreachable" });
      await ben.listSessions();
      expect(inbox).toEqual([]);
    } finally { controller.abort(); await Promise.all(pending); }
  });

  it("refuses a lookup whose complete encoded reply would exceed the wire limit", async () => {
    const scope = "界".repeat(1024), name = "界".repeat(256);
    for (let i = 0; i < 60; i++) {
      await register(`many-${i}`, `id${"界".repeat(250)}${i}`, name, scope, 1);
    }
    const result = await lookup(scope, "name", name);
    expect(result.kind).toBe("refused");
    expect(result).toEqual({ kind: "refused", code: "incomplete" });
  });

  it("keeps local asks distinct from roaming asks with the same message ID", async () => {
    const ben = await register("stable-b", "b", "ben", "scope-1", 3);
    const alice = await register("local-a", "local-a", "collision-alice", "scope-1");
    const charlie = await register("local-c", "local-c", "collision-charlie", "scope-1");
    const target = ((await lookup("scope-1", "name", "ben")).targets as V0Endpoint[])[0];
    const question = { ...message, id: "collision-question" };
    const inbound = once(ben, "message");
    const controller = new AbortController();
    const pending = requestV0Broker(getAgentDirPath(), { kind: "ask", from: origin, target, message: question, timeoutMs: 2000 }, controller.signal);
    try {
      await inbound;
      const inbox: unknown[] = [];
      charlie.on("message", (...args) => inbox.push(args));
      expect(await alice.send("collision-charlie", { text: "duplicate", messageId: question.id, expectsReply: true }))
        .toMatchObject({ delivered: false, code: "E_INVALID_MESSAGE" });
      await charlie.listSessions();
      expect(inbox).toEqual([]);
      expect(await ben.send("sender", { text: "remote answer", replyTo: question.id, messageId: "remote-collision-reply" })).toMatchObject({ delivered: true });
      expect(await pending).toEqual({ kind: "replied", id: question.id, replyId: "remote-collision-reply", text: "remote answer" });

      expect(await alice.send("collision-charlie", { text: "local question", messageId: question.id, expectsReply: true })).toMatchObject({ delivered: true });
      const localReply = once(alice, "message");
      expect(await charlie.send("collision-alice", { text: "local answer", replyTo: question.id, messageId: "local-collision-reply" })).toMatchObject({ delivered: true });
      expect((await localReply)[1]).toMatchObject({ id: "local-collision-reply", content: { text: "local answer" } });
    } finally { controller.abort(); await pending; }
  });

  it("does not echo an oversized invalid request ID in a broker refusal", async () => {
    const socket = net.connect(getBrokerSocketPath());
    try {
      const response = new Promise<unknown | null>((resolve, reject) => {
        socket.on("error", reject);
        socket.on("close", () => resolve(null));
        socket.on("data", createMessageReader(value => {
          const frame = value as Record<string, unknown>;
          if (frame.type === "health_ok") {
            writeMessage(socket, { type: "roam_v0", requestId: "x".repeat(262_144), kind: "lookup", scopeId: "scope-1", selector: { by: "name", value: "ben" } });
          } else resolve(value);
        }, reject));
        writeMessage(socket, { type: "health", requestId: "health-large-id" });
      });
      expect((await response) === null).toBe(true);
    } finally { socket.destroy(); }
  });

  it("advertises roaming over its private Unix socket", async () => {
    const socket = net.connect(getBrokerSocketPath());
    try {
      const response = new Promise<unknown>((resolve, reject) => {
        socket.on("error", reject);
        socket.on("data", createMessageReader(resolve, reject));
      });
      writeMessage(socket, { type: "health", requestId: "health-1" });
      expect(await response).toMatchObject({
        type: "health_ok", requestId: "health-1", implementation: "spider",
        features: expect.arrayContaining([V0_INTERCOM_FEATURE]),
      });
    } finally { socket.destroy(); }
  });
});
