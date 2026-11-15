import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter, once } from "node:events";
import net from "node:net";
import type { ChildProcess } from "node:child_process";
import { startTestBroker, stopTestBroker, testTmpDir } from "../test-support.js";
import { FEDERATION_FEATURE, type FederationBridge, type RemoteSessionInfo } from "../protocol.js";
import { IntercomClient, IntercomFederationClient } from "./client.js";
import { getAgentDirPath, getBrokerSocketPath } from "./paths.js";
import { createMessageReader, writeMessage } from "./framing.js";

let broker: ChildProcess, home: string;
const remote: RemoteSessionInfo = { remote: true, id: "remote", address: { sessionId: "remote", scopeId: null }, machineId: "machine-2",
  machineAlias: "box-1.invalid", homeEpoch: null, activationEpoch: "generation", endpointEpoch: "generation", name: "helper",
  cwd: "/workspace", model: "fixture", startedAt: 1, lastActivity: 1 };
beforeAll(async () => {
  home = mkdtempSync(join(testTmpDir(), "h-"));
  broker = startTestBroker(process.execPath, ["dist/intercom/broker.mjs"], { env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] }, "suite");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture broker startup timed out")), 4000);
    broker.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture broker exit ${code}`)); });
    broker.stdout!.on("data", chunk => { if (String(chunk).includes("Intercom broker started")) { clearTimeout(timer); resolve(); } });
  });
}, 5000);
afterAll(async () => { if (broker) await stopTestBroker(broker); if (home) rmSync(home, { recursive: true, force: true }); }, 5000);

it.each(["helper-success", "helper-error", "dispatch-success", "dispatch-error"])("does not leak a rejected completion when %s finishes during disconnect", async kind => {
  let enter!: () => void, settle!: (value: unknown) => void, reject!: (error: Error) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const pending = new Promise<unknown>((resolve, rejectPromise) => { settle = resolve; reject = rejectPromise; });
  const adapter: FederationBridge = { dispatch: async () => { enter(); return await pending as Awaited<ReturnType<FederationBridge["dispatch"]>>; }, receipt() {}, control() {} };
  const bridge = new IntercomFederationClient(), unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  let helper: net.Socket | undefined, session: IntercomClient | undefined;
  try {
    await bridge.connect({ feature: FEDERATION_FEATURE, agentDir: getAgentDirPath(), machineId: "machine-1", machineAlias: "local.invalid" }, adapter);
    if (kind.startsWith("helper")) {
      const token = "a".repeat(64);
      await bridge.enableHelpers(token, async () => { enter(); return pending; });
      helper = net.connect(getBrokerSocketPath());
      const responses = new EventEmitter();
      helper.on("data", createMessageReader(value => responses.emit(String((value as { requestId?: string }).requestId), value), error => responses.emit("error", error)));
      helper.on("error", error => responses.emit("error", error));
      await once(helper, "connect");
      const health = once(responses, "health");
      writeMessage(helper, { type: "health", requestId: "health" });
      expect((await health)[0]).toMatchObject({ type: "health_ok" });
      const registered = once(responses, "register");
      writeMessage(helper, { type: "helper_register", requestId: "register", token });
      expect((await registered)[0]).toMatchObject({ type: "helper_registered" });
      writeMessage(helper, { type: "helper_exchange", requestId: "held", input: { fixture: true }, deadlineMs: 3000 });
    } else {
      bridge.publishPresence([remote]);
      session = new IntercomClient();
      await session.connect({ address: { sessionId: "sender", scopeId: null }, cwd: "/workspace", model: "fixture", pid: process.pid,
        name: "sender", startedAt: 1, lastActivity: 1, activationEpoch: "sender-generation" }, "sender");
      void session.send("box-1.invalid/helper", { messageId: "held-dispatch", text: "synthetic" }).catch(() => {});
    }
    await entered;
    const closing = bridge.close();
    if (kind.endsWith("error")) reject(new Error("fixture failure"));
    else settle(kind.startsWith("helper") ? { version: 1 } : { delivery: "queued", retryable: false, outcomeKnown: true,
      acceptance: { accepted: true, durable: true, location: "source" } });
    await closing;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    helper?.destroy(); await session?.disconnect(); await bridge.close();
  }
}, 5000);

it("does not send an old dispatch result through a reconnected broker", async () => {
  const root = mkdtempSync(join(testTmpDir(), "reconnect-")), agent = join(root, "agent");
  mkdirSync(join(agent, "intercom"), { recursive: true, mode: 0o700 });
  const socketPath = getBrokerSocketPath(process.platform, agent), received: Array<{ connection: number; type: string }> = [];
  let count = 0, enter!: () => void, finish!: (value: unknown) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const pending = new Promise<unknown>(resolve => { finish = resolve; });
  const server = net.createServer(socket => {
    const connection = ++count;
    socket.on("data", createMessageReader(value => {
      const message = value as { type: string; requestId?: string }; received.push({ connection, type: message.type });
      if (message.type === "federation_register") {
        writeMessage(socket, { type: "federation_registered", features: [FEDERATION_FEATURE] });
        if (connection === 1) writeMessage(socket, { type: "federation_dispatch", requestId: "old-request", dispatch: {
          from: { sessionId: "sender", scopeId: null }, to: remote, message: { id: "old-message", timestamp: 1, content: { text: "synthetic" } },
        } });
      } else if (message.type === "inspect_blockers") {
        writeMessage(socket, { type: "blockers", requestId: message.requestId, blockers: { asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] } });
      }
    }, error => socket.destroy(error)));
  });
  const bridge = new IntercomFederationClient();
  const adapter: FederationBridge = { dispatch: async () => { enter(); return await pending as Awaited<ReturnType<FederationBridge["dispatch"]>>; }, receipt() {}, control() {} };
  try {
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    const registration = { feature: FEDERATION_FEATURE, agentDir: agent, machineId: "machine-1", machineAlias: "local.invalid" };
    await bridge.connect(registration, adapter); await entered; await bridge.close();
    await bridge.connect(registration, adapter);
    finish({ delivery: "queued", retryable: false, outcomeKnown: true, acceptance: { accepted: true, durable: true, location: "source" } });
    await Promise.resolve();
    await bridge.inspectBlockers({ sessionId: "sender", scopeId: null });
    expect(received.filter(row => row.connection === 2 && row.type === "federation_result")).toEqual([]);
  } finally {
    await bridge.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true });
  }
}, 5000);
