import { describe, expect, it } from "vitest";
import {
  parseV0AgentReply,
  parseV0AgentRequest,
  parseV0BrokerReply,
  parseV0BrokerRequest,
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
