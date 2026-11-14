import { afterAll, beforeAll, expect, it } from "vitest";
import { once } from "node:events";
import net from "node:net";
import type { ChildProcess } from "node:child_process";
import { startTestBroker, stopTestBroker } from "../test-support.js";
import { getAgentDirPath, getBrokerSocketPath } from "./paths.js";
import { createMessageReader, writeMessage } from "./framing.js";
import { IntercomFederationClient } from "./client.js";
import { FEDERATION_FEATURE, type FederationBridge } from "../protocol.js";

let broker: ChildProcess;
beforeAll(async () => {
  broker = startTestBroker(process.execPath, ["dist/intercom/broker.mjs"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] }, "suite");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture broker startup timed out")), 4000);
    broker.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture broker exit ${code}`)); });
    broker.stdout!.on("data", chunk => { if (String(chunk).includes("Intercom broker started")) { clearTimeout(timer); resolve(); } });
  });
}, 5000);
afterAll(async () => { if (broker) await stopTestBroker(broker); }, 5000);

function connect() {
  const socket = net.connect(getBrokerSocketPath()), messages: Array<Record<string, unknown>> = [];
  const pending = new Set<() => void>();
  let closed = false;
  socket.on("data", createMessageReader(value => { messages.push(value as Record<string, unknown>); for (const wake of pending) wake(); }, () => socket.destroy()));
  socket.on("error", () => {});
  socket.on("close", () => { closed = true; for (const wake of pending) wake(); });
  return {
    socket,
    async take(type: string): Promise<Record<string, unknown> | null> {
      return new Promise(resolve => {
        const finish = (value: Record<string, unknown> | null) => { clearTimeout(timer); pending.delete(check); resolve(value); };
        const check = () => { const index = messages.findIndex(message => message.type === type); if (index >= 0) finish(messages.splice(index, 1)[0]); else if (closed) finish(null); };
        const timer = setTimeout(() => finish(null), 300);
        pending.add(check); check();
      });
    },
    async close() { if (!socket.destroyed) { const finished = once(socket, "close"); socket.destroy(); await finished; } },
  };
}

it("advertises helper exchange in the existing private broker handshake", async () => {
  const client = connect();
  try {
    writeMessage(client.socket, { type: "health", requestId: "health-1" });
    const reply = await client.take("health_ok");
    expect(reply).toMatchObject({ requestId: "health-1", features: expect.arrayContaining(["intercom-exchange-v1"]) });
  } finally { await client.close(); }
}, 5000);

it("refuses an ordinary client's helper request without disconnecting its normal traffic", async () => {
  const client = connect(), service = connect();
  try {
    writeMessage(service.socket, { type: "federation_register", feature: "federation-v1", agentDir: getAgentDirPath(), machineId: "fixture-machine", machineAlias: "fixture.invalid" });
    expect(await service.take("federation_registered")).not.toBeNull();
    writeMessage(service.socket, { type: "helper_authorize", requestId: "authorize", token: "a".repeat(64) });
    expect(await service.take("helper_authorized")).not.toBeNull();
    writeMessage(client.socket, { type: "register", sessionId: "ordinary", session: { cwd: "/workspace", model: "fixture", pid: process.pid, startedAt: 1, lastActivity: 1 } });
    expect(await client.take("registered")).not.toBeNull();
    writeMessage(client.socket, { type: "helper_exchange", requestId: "unauthorized", input: {}, deadlineMs: 1000 });
    expect(await client.take("helper_error")).toMatchObject({ requestId: "unauthorized", reason: "helper-unauthorized" });
    writeMessage(client.socket, { type: "list", requestId: "list-after-refusal" });
    expect(await client.take("sessions")).toMatchObject({ requestId: "list-after-refusal" });
  } finally { await client.close(); await service.close(); }
}, 5000);

it("a bridge-authorized helper sends one request to the registered bridge", async () => {
  const service = connect(), helper = connect(), token = "a".repeat(64);
  try {
    writeMessage(service.socket, { type: "federation_register", feature: "federation-v1", agentDir: getAgentDirPath(), machineId: "fixture-machine", machineAlias: "fixture.invalid" });
    expect(await service.take("federation_registered")).not.toBeNull();
    writeMessage(service.socket, { type: "helper_authorize", requestId: "authorize", token });
    expect(await service.take("helper_authorized")).toMatchObject({ requestId: "authorize" });
    writeMessage(helper.socket, { type: "health", requestId: "health" });
    expect(await helper.take("health_ok")).toMatchObject({ features: expect.arrayContaining(["intercom-exchange-v1"]) });
    writeMessage(helper.socket, { type: "helper_register", requestId: "register", token });
    expect(await helper.take("helper_registered")).toMatchObject({ requestId: "register" });
    writeMessage(helper.socket, { type: "helper_exchange", requestId: "request", input: { fixture: "request" }, deadlineMs: 1000 });
    const forwarded = await service.take("federation_helper_exchange");
    expect(forwarded).toMatchObject({ input: { fixture: "request" }, deadlineMs: 1000 });
    writeMessage(service.socket, { type: "federation_helper_result", requestId: forwarded!.requestId, output: { fixture: "reply" } });
    expect(await helper.take("helper_result")).toMatchObject({ requestId: "request", output: { fixture: "reply" } });
  } finally { await helper.close(); await service.close(); }
}, 5000);


it("the bridge client accepts helper exchanges only after it authorizes the helper", async () => {
  const service = new IntercomFederationClient(), helper = connect(), token = "b".repeat(64);
  const callbacks: FederationBridge = { dispatch: async () => ({ delivery: "failed", retryable: false, outcomeKnown: true,
    acceptance: { accepted: false, durable: false } }), receipt: () => {}, control: () => {} };
  try {
    await service.connect({ feature: FEDERATION_FEATURE, agentDir: getAgentDirPath(), machineId: "fixture-machine", machineAlias: "fixture.invalid" }, callbacks);
    const extended = service as IntercomFederationClient & { enableHelpers(token: string, handler: (input: unknown, signal: AbortSignal) => Promise<unknown>): Promise<void> };
    expect(typeof extended.enableHelpers).toBe("function");
    await extended.enableHelpers(token, async input => ({ answer: input }));
    writeMessage(helper.socket, { type: "health", requestId: "health" }); await helper.take("health_ok");
    writeMessage(helper.socket, { type: "helper_register", requestId: "register", token });
    expect(await helper.take("helper_registered")).toMatchObject({ requestId: "register" });
    writeMessage(helper.socket, { type: "helper_exchange", requestId: "request", input: { value: 7 }, deadlineMs: 1000 });
    expect(await helper.take("helper_result")).toMatchObject({ requestId: "request", output: { answer: { value: 7 } } });
  } finally { await helper.close(); await service.close(); }
}, 5000);

it("a socket alone or a stale token cannot authorize a helper", async () => {
  const service = connect(), helper = connect(), token = "c".repeat(64);
  try {
    writeMessage(service.socket, { type: "federation_register", feature: "federation-v1", agentDir: getAgentDirPath(), machineId: "fixture-machine", machineAlias: "fixture.invalid" });
    expect(await service.take("federation_registered")).not.toBeNull();
    writeMessage(service.socket, { type: "helper_authorize", requestId: "authorize", token });
    expect(await service.take("helper_authorized")).not.toBeNull();
    writeMessage(helper.socket, { type: "helper_register", requestId: "before-health", token });
    expect(await helper.take("helper_error")).toMatchObject({ requestId: "before-health", reason: "helper-unauthorized" });
    writeMessage(helper.socket, { type: "health", requestId: "health" }); await helper.take("health_ok");
    writeMessage(helper.socket, { type: "helper_register", requestId: "bad-token", token: "d".repeat(64) });
    expect(await helper.take("helper_error")).toMatchObject({ requestId: "bad-token", reason: "helper-unauthorized" });
    writeMessage(helper.socket, { type: "helper_register", requestId: "authorized", token });
    expect(await helper.take("helper_registered")).toMatchObject({ requestId: "authorized" });
  } finally { await helper.close(); await service.close(); }
}, 5000);

it("deadline cancels the bridge request and ignores its late completion", async () => {
  const service = connect(), helper = connect(), token = "d".repeat(64);
  try {
    writeMessage(service.socket, { type: "federation_register", feature: "federation-v1", agentDir: getAgentDirPath(), machineId: "fixture-machine", machineAlias: "fixture.invalid" });
    expect(await service.take("federation_registered")).not.toBeNull();
    writeMessage(service.socket, { type: "helper_authorize", requestId: "authorize", token }); await service.take("helper_authorized");
    writeMessage(helper.socket, { type: "health", requestId: "health" }); await helper.take("health_ok");
    writeMessage(helper.socket, { type: "helper_register", requestId: "register", token }); await helper.take("helper_registered");
    writeMessage(helper.socket, { type: "helper_exchange", requestId: "first", input: {}, deadlineMs: 25 });
    const request = await service.take("federation_helper_exchange");
    expect(request).not.toBeNull();
    expect(await helper.take("helper_error")).toMatchObject({ requestId: "first", reason: "helper-timeout" });
    expect(await service.take("federation_helper_cancel")).toMatchObject({ requestId: request!.requestId });
    writeMessage(service.socket, { type: "federation_helper_result", requestId: request!.requestId, output: { stale: true } });
    writeMessage(helper.socket, { type: "helper_exchange", requestId: "second", input: {}, deadlineMs: 1000 });
    const next = await service.take("federation_helper_exchange");
    writeMessage(service.socket, { type: "federation_helper_result", requestId: next!.requestId, output: { fresh: true } });
    expect(await helper.take("helper_result")).toMatchObject({ requestId: "second", output: { fresh: true } });
  } finally { await helper.close(); await service.close(); }
}, 5000);

it("oversized helper requests are refused without forwarding or disconnecting", async () => {
  const service = connect(), helper = connect(), token = "e".repeat(64);
  try {
    writeMessage(service.socket, { type: "federation_register", feature: "federation-v1", agentDir: getAgentDirPath(), machineId: "fixture-machine", machineAlias: "fixture.invalid" });
    expect(await service.take("federation_registered")).not.toBeNull();
    writeMessage(service.socket, { type: "helper_authorize", requestId: "authorize", token }); await service.take("helper_authorized");
    writeMessage(helper.socket, { type: "health", requestId: "health" }); await helper.take("health_ok");
    writeMessage(helper.socket, { type: "helper_register", requestId: "register", token }); await helper.take("helper_registered");
    writeMessage(helper.socket, { type: "helper_exchange", requestId: "big", input: { content: "x".repeat(512 * 1024) }, deadlineMs: 1000 });
    expect(await helper.take("helper_error")).toMatchObject({ requestId: "big", reason: "exchange-too-large" });
    writeMessage(helper.socket, { type: "health", requestId: "still-connected" });
    expect(await helper.take("health_ok")).toMatchObject({ requestId: "still-connected" });
  } finally { await helper.close(); await service.close(); }
}, 5000);


it("accepts a 512 KiB framed request exactly and refuses the next byte without disconnecting", async () => {
  const service = connect(), helper = connect(), token = "d".repeat(64), limit = 512 * 1024;
  try {
    writeMessage(service.socket, { type: "federation_register", feature: "federation-v1", agentDir: getAgentDirPath(), machineId: "fixture-machine", machineAlias: "fixture.invalid" });
    expect(await service.take("federation_registered")).not.toBeNull();
    writeMessage(service.socket, { type: "helper_authorize", requestId: "authorize", token }); await service.take("helper_authorized");
    writeMessage(helper.socket, { type: "health", requestId: "health" }); await helper.take("health_ok");
    writeMessage(helper.socket, { type: "helper_register", requestId: "register", token }); await helper.take("helper_registered");
    const request = { type: "helper_exchange", requestId: "boundary", input: { padding: "" }, deadlineMs: 1000 };
    request.input.padding = "x".repeat(limit - Buffer.byteLength(JSON.stringify(request)));
    expect(Buffer.byteLength(JSON.stringify(request))).toBe(limit);
    writeMessage(helper.socket, request);
    const forwarded = await service.take("federation_helper_exchange"); expect(forwarded).not.toBeNull();
    writeMessage(service.socket, { type: "federation_helper_result", requestId: forwarded!.requestId, output: { ok: true } });
    expect(await helper.take("helper_result")).toMatchObject({ requestId: "boundary", output: { ok: true } });
    request.input.padding += "x";
    writeMessage(helper.socket, request);
    expect(await helper.take("helper_error")).toMatchObject({ requestId: "boundary", reason: "exchange-too-large" });
    writeMessage(helper.socket, { type: "health", requestId: "alive" });
    expect(await helper.take("health_ok")).toMatchObject({ requestId: "alive" });
  } finally { await helper.close(); await service.close(); }
}, 5000);


it("returns a generic helper failure instead of leaking an unrecognized exception", async () => {
  const service = new IntercomFederationClient(), helper = connect(), token = "c".repeat(64);
  const bridge: FederationBridge = { dispatch: async () => ({ delivery: "failed", retryable: false, outcomeKnown: true,
    acceptance: { accepted: false, durable: false }, reason: "fixture" }), receipt() {}, control() {} };
  try {
    await service.connect({ feature: FEDERATION_FEATURE, agentDir: getAgentDirPath(), machineId: "fixture-machine", machineAlias: "fixture.invalid" }, bridge);
    await service.enableHelpers(token, async () => { throw Object.assign(new Error("synthetic confidential body"), { code: "synthetic confidential body" }); });
    writeMessage(helper.socket, { type: "health", requestId: "health" }); await helper.take("health_ok");
    writeMessage(helper.socket, { type: "helper_register", requestId: "register", token }); await helper.take("helper_registered");
    writeMessage(helper.socket, { type: "helper_exchange", requestId: "request", input: {}, deadlineMs: 1000 });
    const result = await helper.take("helper_error");
    expect(result).toMatchObject({ requestId: "request", reason: "bridge-exchange-failed" });
    expect(JSON.stringify(result)).not.toContain("synthetic confidential body");
  } finally { await helper.close(); await service.close(); }
}, 5000);


it("the broker sanitizes even a forged bridge error before replying to a helper", async () => {
  const service = connect(), helper = connect(), token = "d".repeat(64);
  try {
    writeMessage(service.socket, { type: "federation_register", feature: "federation-v1", agentDir: getAgentDirPath(), machineId: "fixture-machine", machineAlias: "fixture.invalid" });
    await service.take("federation_registered");
    writeMessage(service.socket, { type: "helper_authorize", requestId: "authorize", token }); await service.take("helper_authorized");
    writeMessage(helper.socket, { type: "health", requestId: "health" }); await helper.take("health_ok");
    writeMessage(helper.socket, { type: "helper_register", requestId: "register", token }); await helper.take("helper_registered");
    writeMessage(helper.socket, { type: "helper_exchange", requestId: "request", input: {}, deadlineMs: 1000 });
    const request = await service.take("federation_helper_exchange"); expect(request).not.toBeNull();
    writeMessage(service.socket, { type: "federation_helper_result", requestId: request!.requestId, error: "synthetic confidential body" });
    const result = await helper.take("helper_error");
    expect(result).toMatchObject({ requestId: "request", reason: "bridge-exchange-failed" });
    expect(JSON.stringify(result)).not.toContain("synthetic confidential body");
  } finally { await helper.close(); await service.close(); }
}, 5000);
