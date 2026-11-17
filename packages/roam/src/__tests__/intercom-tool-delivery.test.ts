import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { Socket } from "node:net";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession, type ExtensionContext, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { authorizeTestBridge, startTestBroker, stopTestBroker, testBrokerEnv, testTmpDir } from "../../../intercom/src/test-support.js";
import { IntercomFederationClient } from "../../../intercom/src/broker/client.js";
import { getAgentDirPath } from "../../../intercom/src/broker/paths.js";
import { getConfigPath } from "../../../intercom/src/config.js";
import { INTERCOM_HOST_EVENT, type IntercomHostRequest } from "../../../intercom/src/host-api.js";
import { FEDERATION_FEATURE, type MessageReceipt, type RemoteSessionInfo, type SessionAddress, type SessionEndpoint } from "../../../intercom/src/protocol.js";
import extension from "../../../intercom/src/local.js";
import { makeMessageFrame } from "../intercom-codec.js";
import type { IntercomMessageFrame } from "../intercom-contracts.js";

let broker: ChildProcess, bridge: IntercomFederationClient, root: string;
const sessions: AgentSession[] = [];
const frames: IntercomMessageFrame[] = [];
const receipts: Array<{ from: SessionAddress; receipt: MessageReceipt }> = [];
const remote: RemoteSessionInfo = { remote: true, id: "source", address: { sessionId: "source", scopeId: null }, machineId: "22222222-2222-4222-8222-222222222222", machineAlias: "source.invalid", homeEpoch: 1,
  activationEpoch: "source-activation", endpointEpoch: "source-activation", name: "source", cwd: "/workspace", model: "fixture", startedAt: 1, lastActivity: 1 };

beforeAll(async () => {
  root = mkdtempSync(join(testTmpDir(), "idle-"));
  mkdirSync(join(root, "home"));
  mkdirSync(join(getAgentDirPath(), "intercom"), { recursive: true });
  writeFileSync(getConfigPath(), JSON.stringify({ inboundTrigger: "never", confirmSend: false }));
  broker = startTestBroker(process.execPath, ["dist/intercom/broker.mjs"], { env: { ...testBrokerEnv(), HOME: join(root, "home"), USERPROFILE: join(root, "home") }, stdio: ["ignore", "pipe", "pipe"] }, "suite");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("broker startup timed out")), 4000);
    broker.once("exit", code => { clearTimeout(timer); reject(new Error(`broker exited ${code}`)); });
    broker.stdout!.on("data", chunk => { if (String(chunk).includes("Intercom broker started")) { clearTimeout(timer); resolve(); } });
  });
  bridge = new IntercomFederationClient();
  await bridge.connect({ feature: FEDERATION_FEATURE, agentDir: getAgentDirPath(), credential: authorizeTestBridge(getAgentDirPath(), "11111111-1111-4111-8111-111111111111"), machineId: "11111111-1111-4111-8111-111111111111", machineAlias: "local.invalid" }, {
    dispatch: async ({ from, to, message }) => {
      frames.push(makeMessageFrame({ from, endpoint: { address: to.address, machineId: to.machineId, homeEpoch: to.homeEpoch, activationEpoch: to.activationEpoch }, sequence: frames.length + 1, message, originMachineId: "11111111-1111-4111-8111-111111111111" }));
      return { delivery: "queued", outcomeKnown: true, retryable: false, acceptance: { accepted: true, durable: true, location: "source" } };
    },
    receipt: (from, receipt) => { receipts.push({ from, receipt }); }, control() {},
  });
  bridge.publishPresence([remote]);
});
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  vi.restoreAllMocks();
  receipts.length = 0;
  frames.length = 0;
});
afterAll(async () => {
  await bridge?.close();
  if (broker) await stopTestBroker(broker);
  if (root) rmSync(root, { recursive: true, force: true });
});

async function recipient({ fresh = false, inboundTrigger = "never", restored }: { fresh?: boolean; inboundTrigger?: "never" | "replies" | "always"; restored?: SessionManager } = {}) {
  const cwd = restored?.getCwd() ?? mkdtempSync(join(root, "session-")), agentDir = getAgentDirPath();
  writeFileSync(getConfigPath(), JSON.stringify({ inboundTrigger, confirmSend: false }));
  const sessionManager = restored ?? SessionManager.create(cwd, join(cwd, "sessions"));
  if (!fresh) sessionManager.appendMessage({ role: "user", content: "synthetic prior conversation", timestamp: 0 });
  const settingsManager = SettingsManager.inMemory({ packages: [], cacheWarming: "off" });
  let endpoint!: SessionEndpoint, context!: ExtensionContext;
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi => {
      pi.events.on(INTERCOM_HOST_EVENT, (value: unknown) => {
        const request = value as IntercomHostRequest;
        endpoint = { address: { sessionId: request.sessionId, scopeId: request.scopeId }, machineId: "11111111-1111-4111-8111-111111111111", homeEpoch: 1, activationEpoch: request.activationEpoch };
        request.endpoint = endpoint;
      });
      pi.on("session_start", (_event, ctx) => { context = ctx; });
      extension(pi);
    }],
  });
  await loader.reload();
  const { session, extensionsResult } = await createAgentSession({ cwd, agentDir, settingsManager, sessionManager, resourceLoader: loader, noTools: "builtin" });
  sessions.push(session);
  expect(extensionsResult.errors).toEqual([]);
  expect(extensionsResult.extensions).toHaveLength(1);
  await session.bindExtensions({ mode: "rpc" });
  const toolContext: ExtensionToolContext = {
    ...context,
    tools: [],
    executeTool: async () => { throw new Error("Nested tools are not available in this fixture"); },
  };
  await vi.waitFor(async () => {
    const result = await session.getToolDefinition("intercom")!.execute("status", { action: "status" }, undefined, undefined, toolContext);
    expect(result.details).toMatchObject({ connected: true });
  });
  const execute = (params: Record<string, unknown>) => session.getToolDefinition("intercom")!.execute("tool-call", params, undefined, undefined, toolContext);
  return { session, endpoint, execute };
}

function captureReceiptFrames() {
  // Call through to the real socket. These are framed bytes sent to the broker.
  const writes = vi.spyOn(Socket.prototype, "write");
  return () => writes.mock.calls.flatMap(([chunk]) => {
    if (!Buffer.isBuffer(chunk) || chunk.length < 4 || chunk.readUInt32BE(0) !== chunk.length - 4) return [];
    const frame = JSON.parse(chunk.subarray(4).toString("utf8")) as { type: string; receipt?: MessageReceipt };
    return frame.type === "message_receipt" && frame.receipt ? [frame.receipt] : [];
  });
}

it("returns physical consumption evidence for an idle recipient without a turn", async () => {
  const sent = captureReceiptFrames();
  const { session, endpoint, execute } = await recipient();
  let turns = 0;
  session.subscribe(event => { if (event.type === "agent_start") turns++; });
  const result = await bridge.deliver(remote, endpoint, { id: "idle-message", timestamp: 1, content: { text: "synthetic message" } });
  expect(result.delivery).toBe("socket_delivered");
  const physical = () => session.sessionManager.getEntries().flatMap(entry => entry.type === "custom_message" && entry.customType === "intercom_message" ? [entry] : []);
  await vi.waitFor(() => expect(physical()).toHaveLength(1));
  expect(turns).toBe(0);
  expect(session.isIdle).toBe(true);
  const entries = physical();
  await vi.waitFor(() => expect(receipts.filter(value => value.receipt.status === "injected")).toHaveLength(1));
  expect(receipts.find(value => value.receipt.status === "injected")).toMatchObject({ from: endpoint.address, receipt: { messageId: "idle-message", evidence: { kind: "entry", entryId: entries[0]!.id, sessionId: endpoint.address.sessionId, activationEpoch: endpoint.activationEpoch } } });
  expect(turns).toBe(0);
  expect(session.isIdle).toBe(true);
  const entryAcks = () => session.sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "intercom_receipt_ack" &&
    (entry.data as { messageId?: string; status?: string }).messageId === "idle-message" && (entry.data as { status?: string }).status === "injected");
  await vi.waitFor(() => expect(entryAcks()).toHaveLength(1));
  await session.extensionRunner.emitMessageEnd({ type: "message_end", message: { role: "custom", customType: "fixture", content: "synthetic", display: false, timestamp: 1 } });
  // Status lists sessions on the recipient's own socket, after any receipt sends.
  await execute({ action: "status" });
  expect(entryAcks()).toHaveLength(1);
  expect(sent().filter(receipt => receipt.messageId === "idle-message" && receipt.status === "injected")).toHaveLength(1);
  expect(physical()).toHaveLength(1);
});


it.each(["never", "replies"] as const)("waits for the session file before reporting consumption with %s triggering", async inboundTrigger => {
  const { session, endpoint, execute } = await recipient({ fresh: true, inboundTrigger });
  const file = session.sessionManager.getSessionFile()!;
  expect(existsSync(file)).toBe(false);
  await bridge.deliver(remote, endpoint, { id: "unflushed-message", timestamp: 1, content: { text: "synthetic message" } });
  await vi.waitFor(() => expect(session.sessionManager.getEntries().some(entry => entry.type === "custom_message" && entry.customType === "intercom_message")).toBe(true));
  await execute({ action: "status" });
  expect(existsSync(file)).toBe(false);
  expect(receipts.filter(value => value.receipt.status === "injected")).toHaveLength(0);
  await session.extensionRunner.emitMessageEnd({ type: "message_end", message: { role: "custom", customType: "fixture", content: "synthetic", display: false, timestamp: 1 } });
  await session.extensionRunner.emit({ type: "agent_settled", aborted: false });
  await execute({ action: "status" });
  expect(receipts.filter(value => value.receipt.status === "injected")).toHaveLength(0);
  const message = { role: "user" as const, content: "synthetic first prompt", timestamp: 2 };
  session.sessionManager.appendMessage(message);
  expect(existsSync(file)).toBe(true);
  await session.extensionRunner.emitMessageEnd({ type: "message_end", message });
  await vi.waitFor(() => expect(receipts.filter(value => value.receipt.status === "injected")).toHaveLength(1));
  const evidence = receipts.find(value => value.receipt.status === "injected")!.receipt.evidence;
  expect(evidence).toMatchObject({ kind: "entry", sessionId: endpoint.address.sessionId, activationEpoch: endpoint.activationEpoch });
  if (evidence?.kind !== "entry") throw new Error("Missing physical entry evidence");
  expect(SessionManager.open(file).getEntry(evidence.entryId)).toMatchObject({ type: "custom_message", customType: "intercom_message", details: { message: { id: "unflushed-message" } } });
});

it("does not consume an unflushed entry on shutdown", async () => {
  const { session, endpoint, execute } = await recipient({ fresh: true });
  await bridge.deliver(remote, endpoint, { id: "shutdown-message", timestamp: 1, content: { text: "synthetic message" } });
  await vi.waitFor(() => expect(session.sessionManager.getEntries().some(entry => entry.type === "custom_message")).toBe(true));
  await execute({ action: "status" });
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  await vi.waitFor(() => expect(receipts.some(value => value.receipt.messageId === "shutdown-message" && value.receipt.status === "unknown")).toBe(true));
  expect(receipts.some(value => value.receipt.status === "injected")).toBe(false);
  expect(existsSync(session.sessionManager.getSessionFile()!)).toBe(false);
});

it("waits for persistence before reporting a reply handed to a waiter", async () => {
  const { session, endpoint, execute } = await recipient({ fresh: true });
  const result = execute({ action: "ask", to: "source.invalid/source", message: "synthetic question" });
  await vi.waitFor(() => expect(frames).toHaveLength(1));
  await bridge.deliver(remote, endpoint, { id: "waiter-reply", replyTo: frames[0]!.message.id, timestamp: 1, content: { text: "synthetic answer" } });
  expect((await result).content).toEqual([{ type: "text", text: "**Reply from source.invalid/source:**\nsynthetic answer" }]);
  await execute({ action: "status" });
  expect(existsSync(session.sessionManager.getSessionFile()!)).toBe(false);
  expect(receipts.some(value => value.receipt.status === "matched_waiter")).toBe(false);
  const message = { role: "user" as const, content: "synthetic first prompt", timestamp: 2 };
  session.sessionManager.appendMessage(message);
  await session.extensionRunner.emitMessageEnd({ type: "message_end", message });
  await vi.waitFor(() => expect(receipts.some(value => value.receipt.status === "matched_waiter")).toBe(true));
  const evidence = receipts.find(value => value.receipt.status === "matched_waiter")!.receipt.evidence;
  if (evidence?.kind !== "waiter") throw new Error("Missing waiter evidence");
  expect(SessionManager.open(session.sessionManager.getSessionFile()!).getEntry(evidence.entryId)).toMatchObject({ type: "custom", customType: "intercom_waiter_receipt", data: { messageId: "waiter-reply" } });
});

it("does not replay consumption from unflushed restored entries", async () => {
  const first = await recipient({ fresh: true });
  await bridge.deliver(remote, first.endpoint, { id: "restored-message", timestamp: 1, content: { text: "synthetic message" } });
  await vi.waitFor(() => expect(first.session.sessionManager.getEntries().some(entry => entry.type === "custom_message")).toBe(true));
  await first.execute({ action: "status" });
  await first.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
  first.session.dispose();
  sessions.splice(sessions.indexOf(first.session), 1);
  const { session, endpoint, execute } = await recipient({ fresh: true, restored: first.session.sessionManager });
  await bridge.deliver(remote, endpoint, { id: "restored-message", timestamp: 1, content: { text: "synthetic message" } });
  await execute({ action: "status" });
  await session.extensionRunner.emitMessageEnd({ type: "message_end", message: { role: "custom", customType: "fixture", content: "synthetic", display: false, timestamp: 1 } });
  await execute({ action: "status" });
  expect(receipts.some(value => value.receipt.status === "injected")).toBe(false);
  expect(existsSync(session.sessionManager.getSessionFile()!)).toBe(false);
  const message = { role: "user" as const, content: "synthetic first prompt", timestamp: 2 };
  session.sessionManager.appendMessage(message);
  await session.extensionRunner.emitMessageEnd({ type: "message_end", message });
  await vi.waitFor(() => expect(receipts.some(value => value.receipt.messageId === "restored-message" && value.receipt.status === "injected")).toBe(true));
  const evidence = receipts.find(value => value.receipt.status === "injected")!.receipt.evidence;
  if (evidence?.kind !== "entry") throw new Error("Missing restored entry evidence");
  expect(SessionManager.open(session.sessionManager.getSessionFile()!).getEntry(evidence.entryId)).toMatchObject({ customType: "intercom_message", details: { message: { id: "restored-message" } } });
});

it("reports consumption once when a lifecycle scan precedes its receipt acknowledgement", async () => {
  const sent = captureReceiptFrames();
  const { session, endpoint, execute } = await recipient();
  session.subscribe(event => {
    if (event.type === "message_end" && event.message.role === "custom" && event.message.customType === "intercom_message") {
      queueMicrotask(() => { void session.extensionRunner.emitMessageEnd({ type: "message_end", message: event.message }); });
    }
  });
  await bridge.deliver(remote, endpoint, { id: "once-message", timestamp: 1, content: { text: "synthetic message" } });
  await vi.waitFor(() => expect(receipts.some(value => value.receipt.messageId === "once-message" && value.receipt.status === "injected")).toBe(true));
  await execute({ action: "status" });
  expect(sent().filter(receipt => receipt.messageId === "once-message" && receipt.status === "injected")).toHaveLength(1);
  expect(session.sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "intercom_receipt_ack" &&
    (entry.data as { messageId?: string; status?: string }).messageId === "once-message" && (entry.data as { status?: string }).status === "injected")).toHaveLength(1);
});

it.each(["", " \t\n"])("treats blank optional IDs as absent in the real send tool: %j", async blank => {
  const { execute } = await recipient();
  const result = await execute({ action: "send", to: "source.invalid/source", message: "synthetic message", attachments: [], replyTo: blank, supersedes: blank, retryOf: blank, messageId: blank });
  expect(result.details).toMatchObject({ delivered: true, delivery: "queued" });
  expect(frames).toHaveLength(1);
  expect([frames[0]!.message.replyTo, frames[0]!.message.supersedes, frames[0]!.message.retryOf]).toEqual([undefined, undefined, undefined]);
  expect(frames[0]!.message.id).not.toBe(blank);
});


it("preserves idle message order and retains the original ask for a later reply", async () => {
  const { session, endpoint, execute } = await recipient();
  await bridge.deliver(remote, endpoint, { id: "original-question", timestamp: 1, expectsReply: true, remainingMs: 60000, content: { text: "synthetic question" } });
  await bridge.deliver(remote, endpoint, { id: "following-message", timestamp: 2, content: { text: "synthetic follow-up" } });
  await vi.waitFor(() => expect(receipts.filter(value => value.receipt.status === "injected")).toHaveLength(2));
  const entries = session.sessionManager.getEntries().flatMap(entry => entry.type === "custom_message" && entry.customType === "intercom_message" ? [entry] : []);
  expect(entries.map(entry => (entry.details as { message: { id: string } }).message.id)).toEqual(["original-question", "following-message"]);
  expect(JSON.stringify((await execute({ action: "pending" })).content)).toContain("original-question");
  const result = await execute({ action: "reply", replyTo: "original-question", message: "synthetic answer" });
  expect(result.details).toMatchObject({ delivered: true, replyTo: "original-question" });
  expect(frames).toHaveLength(1);
  expect(frames[0]!.message.replyTo).toBe("original-question");
  expect(frames[0]!.identity.askId).toBe("original-question");
  expect(frames[0]!.message.id).not.toBe("original-question");
  expect(JSON.stringify((await execute({ action: "pending" })).content)).not.toContain("original-question");
  expect(session.isIdle).toBe(true);
});

it.each(["", " \t\n"])("keeps reply inference when optional IDs are blank: %j", async blank => {
  const { endpoint, execute } = await recipient();
  await bridge.deliver(remote, endpoint, { id: "infer-question", timestamp: 1, expectsReply: true, remainingMs: 60000, content: { text: "synthetic question" } });
  await vi.waitFor(() => expect(receipts.some(value => value.receipt.messageId === "infer-question" && value.receipt.status === "injected")).toBe(true));
  const result = await execute({ action: "send", to: "source.invalid/source", message: "synthetic answer", replyTo: blank, supersedes: blank, retryOf: blank });
  expect(result.details).toMatchObject({ delivered: true, replyTo: "infer-question" });
  expect(frames[0]!.message.replyTo).toBe("infer-question");
  expect([frames[0]!.message.supersedes, frames[0]!.message.retryOf]).toEqual([undefined, undefined]);
});

it("preserves nonblank optional IDs verbatim", async () => {
  const { execute } = await recipient();
  const result = await execute({ action: "send", to: "source.invalid/source", message: "synthetic message", replyTo: " original-id ", supersedes: " previous-id ", retryOf: " retry-id " });
  expect(result.details).toMatchObject({ delivered: true });
  expect([frames[0]!.message.replyTo, frames[0]!.message.supersedes, frames[0]!.message.retryOf]).toEqual([" original-id ", " previous-id ", " retry-id "]);
});

it.each(["", " \t\n"])("requires a nonblank message ID for cancellation: %j", async blank => {
  const { execute } = await recipient();
  const result = await execute({ action: "cancel", messageId: blank });
  expect(result.details).toEqual({ error: true });
  expect(result.content).toEqual([{ type: "text", text: "Missing 'messageId' parameter" }]);
  expect(frames).toHaveLength(0);
});
