import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { buildIntercom } from "../../../../scripts/build-intercom.mjs";
import type { RelayTarget } from "../relay-protocol.js";
import { v0BrokerOrigin, type V0AgentRequest, type V0Delivery, type V0Endpoint, type V0Text } from "../roam-v0.js";
import { startTestBroker, stopTestBroker, testBrokerEnv, testTmpDir } from "../test-support.js";
import type { Message } from "../types.js";
import { IntercomClient } from "./client.js";
import { createMessageReader, writeMessage } from "./framing.js";
import { authorizeV0RelayReply, beginV0RelayAsk } from "./roam-relay-client.js";
import { requestV0Broker } from "./roam-v0-client.js";

const scopeId = "ask-scope";
const originMachine = "origin.invalid", recipientMachine = "recipient.invalid";
const cleanups: (() => unknown | Promise<unknown>)[] = [];
const buildDir = mkdtempSync(join(testTmpDir(), "ask-build-"));
const brokerFile = join(buildDir, "broker.mjs");
const refused = { kind: "refused" };
const text = (id: string, value = id): V0Text => ({ id, text: value, timestamp: 1 });

beforeAll(() => buildIntercom(buildDir));
afterAll(() => rmSync(buildDir, { recursive: true, force: true }));
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { vi.unstubAllEnvs(); }
});

async function startBroker(fakeTime = false) {
  const agentDir = mkdtempSync(join(testTmpDir(), "ask-"));
  cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
  // Only the child broker's clock is fake; both Unix sockets remain real.
  const clock = `import { mock } from "node:test";
    mock.timers.enable({ apis: ["setTimeout"] });
    let now = 0;
    Object.defineProperty(globalThis.performance, "now", { value: () => now });
    process.on("message", ms => { now += ms; mock.timers.tick(ms); process.send(now); });
    await import(${JSON.stringify(pathToFileURL(brokerFile).href)});`;
  const child = startTestBroker(process.execPath, fakeTime ? ["--input-type=module", "-e", clock] : [brokerFile], {
    env: { ...testBrokerEnv(), PI_CODING_AGENT_DIR: agentDir },
    stdio: ["ignore", "pipe", "pipe", ...(fakeTime ? ["ipc" as const] : [])],
  });
  cleanups.push(() => stopTestBroker(child));
  const [line] = await once(child.stdout!, "data");
  expect(String(line)).toContain("Intercom broker started");
  return { agentDir, async advance(ms: number) { const received = once(child, "message"); child.send(ms); await received; } };
}

async function register(agentDir: string, machineId: string, id: string, scope: string = scopeId, epoch = 3) {
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_INTERCOM_SCOPE_ID", scope);
  const client = new IntercomClient(), inbox: Message[] = [];
  cleanups.push(() => client.disconnect());
  client.on("message", (_from, message) => inbox.push(message));
  const address = { sessionId: id, scopeId: scope };
  await client.connect({ address, name: id, v0HomeEpoch: epoch, cwd: "/fixture", model: "fixture",
    pid: process.pid, startedAt: 1, lastActivity: 1 }, `live-${id}`);
  const find = (await client.listSessions()).find(session => !session.remote && session.id === `live-${id}`);
  const endpoint: V0Endpoint = { address, name: id, homeEpoch: epoch, endpointEpoch: find!.endpointEpoch! };
  return { client, endpoint, from: { ...endpoint, machineId }, async received() { await client.listSessions(); return inbox; } };
}

async function fixture(fakeTime = false) {
  const origin = await startBroker(fakeTime), recipient = await startBroker();
  const asker = await register(origin.agentDir, originMachine, "asker", scopeId, 2);
  const replier = await register(recipient.agentDir, recipientMachine, "receiver");
  const target: RelayTarget = { machineId: recipientMachine, selector: { by: "id", value: "receiver" }, homeEpoch: 3 };
  const begin = async (askId: string, signal?: AbortSignal, selected = target) => {
    const waiter = await beginV0RelayAsk(origin.agentDir, { from: asker.from, target: selected, askId, timeoutMs: 20_000 }, signal);
    cleanups.push(waiter.close);
    return waiter;
  };
  const question = (id: string) => requestV0Broker(recipient.agentDir, {
    kind: "deliver", from: v0BrokerOrigin(asker.from, originMachine), target: replier.endpoint,
    message: text(id, "one question"), thread: { kind: "ask", timeoutMs: 20_000 },
  });
  const reply = (askId: string, from: V0AgentRequest["from"] = replier.from, to = asker.endpoint, value = "answer") =>
    requestV0Broker(origin.agentDir, { kind: "deliver", from: v0BrokerOrigin(from, recipientMachine),
      target: to, message: text(`reply-${askId}`, value), thread: { kind: "reply", replyTo: askId } });
  return { origin, recipient, asker, replier, target, begin, question, reply };
}

it("delivers a routed question once and authorizes only the live receiving endpoint", async () => {
  const f = await fixture();
  expect(await f.question("ask-once")).toEqual({ kind: "socket_delivered", id: "ask-once" });
  expect(await f.question("ask-once")).toMatchObject(refused);
  expect(await f.replier.received()).toMatchObject([{ id: "ask-once", expectsReply: true, v0RelayAsk: true, content: { text: "one question" } }]);
  expect(await authorizeV0RelayReply(f.recipient.agentDir, f.replier.endpoint, "ask-once"))
    .toMatchObject({ asker: f.asker.from, remainingMs: expect.any(Number) });
  const replacement = await register(f.recipient.agentDir, recipientMachine, "receiver");
  expect(replacement.endpoint.endpointEpoch).not.toBe(f.replier.endpoint.endpointEpoch);
  for (const endpoint of [f.replier.endpoint, replacement.endpoint])
    expect(await authorizeV0RelayReply(f.recipient.agentDir, endpoint, "ask-once")).toMatchObject(refused);
  expect(await replacement.received()).toEqual([]);
});

it("refuses late and mismatched replies without injecting a message", async () => {
  const f = await fixture();
  const waiter = await f.begin("ask-1");
  const outcomes: V0Delivery[] = [];
  void waiter.result.then(result => outcomes.push(result));
  for (const attempt of [
    () => f.reply("wrong-ask"),
    () => f.reply("ask-1", { ...f.replier.from, machineId: "another.invalid" }),
    () => f.reply("ask-1", { ...f.replier.from, address: { sessionId: "not-the-receiver", scopeId } }),
    () => f.reply("ask-1", { ...f.replier.from, address: { ...f.replier.from.address, scopeId: "wrong-scope" } }),
    () => f.reply("ask-1", { ...f.replier.from, homeEpoch: 4 }),
    () => f.reply("ask-1", f.replier.from, { ...f.asker.endpoint, endpointEpoch: "wrong-connection" }),
    () => f.reply("ask-1", f.replier.from, { ...f.asker.endpoint, homeEpoch: 4 }),
  ]) expect(await attempt()).toMatchObject(refused);
  expect(outcomes).toEqual([]);
  expect(await f.reply("ask-1")).toEqual({ kind: "socket_delivered", id: "reply-ask-1" });
  expect(await waiter.result).toEqual({ kind: "replied", id: "ask-1", replyId: "reply-ask-1", text: "answer" });
  expect(await f.reply("ask-1", f.replier.from, f.asker.endpoint, "duplicate")).toMatchObject(refused);
  expect(outcomes).toHaveLength(1);
  expect(await f.asker.received()).toEqual([]);
});

it("matches a named ask within its pinned scope and machine", async () => {
  const f = await fixture();
  const waiter = await f.begin("ask-name", undefined, { machineId: recipientMachine, selector: { by: "name", value: "Receiver" } });
  expect(await f.reply("ask-name", { ...f.replier.from, name: "other" })).toMatchObject(refused);
  expect(await f.reply("ask-name")).toMatchObject({ kind: "socket_delivered" });
  expect(await waiter.result).toMatchObject({ kind: "replied", id: "ask-name" });
});

it.each(["abort", "disconnect"] as const)("closes the waiter after the local asker's %s", async cause => {
  const f = await fixture();
  const abort = new AbortController();
  const waiter = await f.begin("ask-cancelled", abort.signal);
  if (cause === "abort") abort.abort();
  else await f.asker.client.disconnect();
  expect(await waiter.result).toEqual({ kind: "unknown", id: "ask-cancelled" });
  const current = cause === "abort" ? f.asker : await register(f.origin.agentDir, originMachine, "asker", scopeId, 2);
  expect(await f.reply("ask-cancelled", f.replier.from, current.endpoint)).toMatchObject(refused);
  expect(await current.received()).toEqual([]);
});

it("caps the broker waiter at exactly 540000 ms of fake time", async () => {
  const f = await fixture(true);
  const socket = net.connect(join(f.origin.agentDir, "intercom", "broker.sock"));
  cleanups.push(() => { socket.destroy(); });
  const frames: Record<string, unknown>[] = [];
  socket.on("data", createMessageReader(frame => frames.push(frame as Record<string, unknown>), error => socket.destroy(error)));
  socket.on("error", () => {});
  writeMessage(socket, { type: "health", requestId: "health" });
  await vi.waitFor(() => expect(frames).toMatchObject([{ type: "health_ok", requestId: "health" }]));
  writeMessage(socket, { type: "roam_v0_relay_ask", requestId: "wait", kind: "begin", from: f.asker.from,
    target: f.target, askId: "ask-1", timeoutMs: 600_000 });
  await vi.waitFor(() => expect(frames).toMatchObject([{}, { type: "roam_v0_relay_ask_ready", requestId: "wait" }]));
  expect(await f.question("ask-1")).toMatchObject({ kind: "socket_delivered" });
  await f.replier.client.disconnect(); // The recipient going away cannot end the ask.
  await f.origin.advance(539_999);
  await f.asker.received(); // A socket round trip drains results emitted by the fake tick.
  expect(frames).toHaveLength(2);
  await f.origin.advance(1);
  await vi.waitFor(() => expect(frames).toMatchObject([{}, {}, { type: "roam_v0_result", requestId: "wait", kind: "no_reply", id: "ask-1" }]));
  expect(await f.reply("ask-1")).toMatchObject(refused);
  expect(await f.asker.received()).toEqual([]);
});
