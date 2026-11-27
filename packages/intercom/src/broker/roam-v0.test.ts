import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { startTestBroker, stopTestBroker, testBrokerEnv } from "../test-support.js";
import { getBrokerSocketPath } from "./paths.js";
import { createMessageReader, writeMessage } from "./framing.js";
import { IntercomClient } from "./client.js";
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
const origin = {
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

  async function register(stableId: string, persistentId: string, name: string, scopeId: string, v0HomeEpoch?: number, runtimeFallbackAlias = false) {
    const client = new IntercomClient();
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
