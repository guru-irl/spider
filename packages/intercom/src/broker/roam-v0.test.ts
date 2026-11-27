import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import type { ChildProcess } from "node:child_process";
import { startTestBroker, stopTestBroker, testBrokerEnv } from "../test-support.js";
import { getBrokerSocketPath } from "./paths.js";
import { createMessageReader, writeMessage } from "./framing.js";
import {
  parseV0AgentReply,
  parseV0AgentRequest,
  parseV0BrokerReply,
  parseV0BrokerRequest,
  V0_INTERCOM_FEATURE,
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

  afterAll(async () => { if (broker) await stopTestBroker(broker); }, 5000);

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
