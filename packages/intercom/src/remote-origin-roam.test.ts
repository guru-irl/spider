import { afterEach, expect, it, vi } from "vitest";
import { testTmpDir } from "./test-support.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { RemoteSessionInfo } from "./protocol.js";
import { INTERCOM_HOST_EVENT } from "./host-api.js";
const state = vi.hoisted(() => ({ clients: [] as any[], sessions: [] as any[], receipts: [] as any[] }));
vi.mock("./broker/spawn.js", () => ({ spawnBrokerIfNeeded: async () => undefined }));
vi.mock("./broker/client.js", async () => {
  const { EventEmitter } = await import("node:events");
  return { IntercomClient: class extends EventEmitter {
    sessionId = "own"; connected = false;
    constructor() { super(); state.clients.push(this); }
    async connect() { this.connected = true; } isConnected() { return this.connected; } supportsFeature() { return true; }
    async listSessions() { return state.sessions; } async disconnect() { this.connected = false; } updatePresence(value: unknown) { this.emit("presence-update", value); }
    onBrokerMessage(handler: any) { this.on("broker_message", handler); return () => this.off("broker_message", handler); }
    onMessageReceipt(handler: any) { this.on("message_receipt", handler); return () => this.off("message_receipt", handler); }
    onMessageControl(handler: any) { this.on("message_control", handler); return () => this.off("message_control", handler); }
    sendMessageReceipt(receipt: any) { state.receipts.push(receipt); } cancelAsk() {}
    async send(to: string, options: any) { this.emit("send", to, options); return { id: options.messageId ?? "reply", delivered: true, delivery: "queued", outcomeKnown: true, retryable: false, acceptance: { accepted: true, durable: true, location: "source" } }; }
  } };
});
import extension from "./local.js";
const remote: RemoteSessionInfo = { remote: true, id: "peer", address: { sessionId: "peer", scopeId: null }, machineId: "machine-origin", machineAlias: "old.invalid", homeEpoch: 1,
  activationEpoch: "old-generation", endpointEpoch: "old-generation", name: "helper", cwd: "/workspace", model: "fixture", startedAt: 1, lastActivity: 1 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); state.clients.length = 0; state.receipts.length = 0; vi.useRealTimers(); });
async function fixture(restored: any[] = [], host?: (request: any) => void) {
  const root = mkdtempSync(join(testTmpDir(), "origin-session-"));
  const sessionFile = join(root, "session.jsonl");
  writeFileSync(sessionFile, restored.map(entry => JSON.stringify(entry)).join("\n"));
  vi.useFakeTimers(); const handlers = new Map<string, any>(), tools: any[] = [], entries: any[] = restored, events = new EventEmitter();
  if (host) events.on(INTERCOM_HOST_EVENT, host);
  const ctx = { cwd: "/workspace", hasUI: false, mode: "rpc", model: { id: "fixture" }, isIdle: () => true,
    sessionManager: { getSessionId: () => "own", getSessionFile: () => sessionFile, getEntries: () => entries }, ui: {}, getContextUsage: () => undefined };
  const pi = { on: (name: string, fn: any) => handlers.set(name, fn), events: { on: (name: string, fn: any) => { events.on(name, fn); return () => events.off(name, fn); }, emit: (name: string, payload: any) => events.emit(name, payload) },
    registerTool: (tool: any) => tools.push(tool), registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, getSessionName: () => "own", getActiveTools: () => [], sendMessage() {},
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data, id: `entry-${entries.length}` }) };
  state.sessions = [{ id: "own", name: "own", cwd: "/workspace", model: "fixture", pid: 1, startedAt: 1, lastActivity: 1 }, remote];
  extension(pi as any); handlers.get("session_start")({}, ctx); await vi.advanceTimersByTimeAsync(0);
  const client = state.clients.at(-1), tool = tools.find(t => t.name === "intercom");
  cleanups.push(async () => { await handlers.get("session_shutdown")({ reason: "reload" }, ctx); rmSync(root, { recursive: true, force: true }); });
  return { client, execute: (params: any) => tool.execute("call", params, new AbortController().signal, undefined, ctx) };
}

it("asks the production host to reconcile a restored owner before replay", async () => {
  const owner = { address: { sessionId: "own", scopeId: null }, machineId: "machine-local", homeEpoch: 1, activationEpoch: "old" };
  const calls: unknown[] = [];
  await fixture([{ type: "custom", customType: "intercom_pending", id: "pending-entry", data: { messageId: "recover", sessionId: "own", activationEpoch: "old", owner } }], request => {
    request.reconcile = async (id: string, previous: unknown) => { calls.push({ id, previous }); return { messageId: id, status: "not_injected", timestamp: 1,
      evidence: { kind: "absence", sessionId: "own", activationEpoch: "old", excludedGeneration: "old", complete: true } }; };
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toEqual([{ id: "recover", previous: owner }]);
  expect(state.receipts).toMatchObject([{ messageId: "recover", status: "not_injected", evidence: { excludedGeneration: "old" } }]);
}, 5000);

it("reconciles an uncertain handoff absent from the session's entries", async () => {
  const owner = { address: { sessionId: "own", scopeId: null }, machineId: "machine-local", homeEpoch: 1, activationEpoch: "old" };
  const calls: unknown[] = [];
  await fixture([], request => {
    request.pendingOwn = async () => [{ messageId: "before-entry", owner }];
    request.reconcile = async (id: string, previous: unknown) => { calls.push({ id, previous }); return { messageId: id, status: "not_injected", timestamp: 1,
      evidence: { kind: "absence", sessionId: "own", activationEpoch: "old", excludedGeneration: "old", complete: true } }; };
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toEqual([{ id: "before-entry", previous: owner }]);
  expect(state.receipts).toMatchObject([{ messageId: "before-entry", status: "not_injected" }]);
}, 5000);

it("ends a remote ask promptly when its frame is rejected for missing origin", async () => {
  const f = await fixture(); let ask: any, settled = false;
  f.client.on("send", (_to: string, options: any) => { ask = options; });
  const result = f.execute({ action: "ask", to: "peer", message: "question" }).then((value: any) => { settled = true; return value; });
  await vi.advanceTimersByTimeAsync(0);
  f.client.emit("broker_message", { type: "message_receipt", from: remote, receipt: { messageId: ask.messageId, status: "cancelled", timestamp: 2, detail: "missing-origin" } });
  await vi.advanceTimersByTimeAsync(0); expect(settled).toBe(true);
  const outcome = await result; expect(outcome.content[0].text).toContain("missing-origin"); expect(outcome.details.reason).toBe("missing-origin");
}, 5000);

it("ends a remote ask promptly when its pair is revoked", async () => {
  const f = await fixture(); let ask: any, settled = false;
  f.client.on("send", (_to: string, options: any) => { ask = options; });
  const result = f.execute({ action: "ask", to: "peer", message: "question" }).then((value: any) => { settled = true; return value; });
  await vi.advanceTimersByTimeAsync(0);
  f.client.emit("broker_message", { type: "message_receipt", from: remote, receipt: { messageId: ask.messageId, status: "cancelled", timestamp: 2, detail: "peer-revoked" } });
  await vi.advanceTimersByTimeAsync(0); expect(settled).toBe(true);
  const outcome = await result; expect(outcome.content[0].text).toContain("peer-revoked"); expect(outcome.details.reason).toBe("peer-revoked");
}, 5000);

it("replies by session ID after its sender moves to a different machine", async () => {
  const f = await fixture(), sent: any[] = []; f.client.on("send", (...args: any[]) => sent.push(args));
  f.client.emit("message", remote, { id: "original-ask", expectsReply: true, timestamp: 1, remainingMs: 10000, content: { text: "question" } });
  await vi.advanceTimersByTimeAsync(0);
  state.sessions = [state.sessions[0], { ...remote, machineId: "machine-new", machineAlias: "new.invalid", homeEpoch: 2, activationEpoch: "new-generation", endpointEpoch: "new-generation" }];
  const result = await f.execute({ action: "reply", replyTo: "original-ask", message: "answer" });
  expect(result.details.delivered).toBe(true); expect(sent.at(-1)[0]).toBe("peer"); expect(sent.at(-1)[1].replyTo).toBe("original-ask");
}, 5000);


it("promptly republishes the original session after its owner formalizes the first home", async () => {
  let firstHome = false;
  const f = await fixture([], request => {
    const endpoint = { address: { sessionId: "own", scopeId: null }, machineId: "local-machine", homeEpoch: null, activationEpoch: request.activationEpoch };
    request.endpoint = endpoint;
    request.refreshInitialHome = async () => firstHome ? { ...endpoint, homeEpoch: 1 } : undefined;
  });
  const updates: unknown[] = []; f.client.on("presence-update", (value: unknown) => updates.push(value));
  firstHome = true;
  await vi.advanceTimersByTimeAsync(2000);
  expect(updates).toContainEqual(expect.objectContaining({ homeEpoch: 1 }));
}, 5000);
