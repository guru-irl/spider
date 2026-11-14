import { afterEach, expect, it, vi } from "vitest";
import "./test-support.js";
import { EventEmitter } from "node:events";
import { createIntercomDeliveryObserver, receiptReleasesPayload, type RemoteSessionInfo } from "./protocol.js";
const state = vi.hoisted(() => ({ clients: [] as any[], sessions: [] as any[], delivery: "queued" as string }));
vi.mock("./broker/spawn.js", () => ({ spawnBrokerIfNeeded: async () => undefined }));
vi.mock("./broker/client.js", async () => {
  const { EventEmitter } = await import("node:events");
  return { IntercomClient: class extends EventEmitter {
    sessionId = "own"; connected = false;
    constructor() { super(); state.clients.push(this); }
    async connect() { this.connected = true; }
    isConnected() { return this.connected; }
    supportsFeature() { return true; }
    async listSessions() { return state.sessions; }
    async disconnect() { this.connected = false; }
    updatePresence() {}
    onBrokerMessage(handler: any) { this.on("broker_message", handler); return () => this.off("broker_message", handler); }
    onMessageReceipt(handler: any) { this.on("message_receipt", handler); return () => this.off("message_receipt", handler); }
    onMessageControl(handler: any) { this.on("message_control", handler); return () => this.off("message_control", handler); }
    sendMessageReceipt(receipt: any) { this.emit("receipt", receipt); }
    cancelAsk() {}
    async send(to: string, options: any) { this.emit("send", to, options); return { id: options.messageId ?? "reply", delivered: state.delivery === "queued", delivery: state.delivery, outcomeKnown: state.delivery !== "unknown", retryable: false, acceptance: { accepted: true, durable: true, location: "source" } }; }
  } };
});
import extension from "./local.js";
import { ReplyTracker } from "./reply-tracker.js";
const remote: RemoteSessionInfo = { remote: true, id: "peer", address: { sessionId: "peer", scopeId: null }, machineId: "machine-2", machineAlias: "box-1.invalid", homeEpoch: 1, activationEpoch: "remote-1", endpointEpoch: "remote-1", name: "helper", cwd: "/workspace", model: "fixture", startedAt: 1, lastActivity: 1 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); state.clients.length = 0; state.delivery = "queued"; vi.useRealTimers(); });
async function fixture(restored: any[] = []) {
  vi.useFakeTimers();
  const handlers = new Map<string, any>(), tools: any[] = [], entries: any[] = restored, messages: any[] = [], events = new EventEmitter();
  const ctx = { cwd: "/workspace", hasUI: false, mode: "rpc", model: { id: "fixture" }, isIdle: () => true, sessionManager: { getSessionId: () => "own", getSessionFile: () => "fixture.jsonl", getEntries: () => entries }, ui: {}, getContextUsage: () => undefined };
  const pi = { on: (name: string, fn: any) => handlers.set(name, fn), events: { on: (name: string, fn: any) => { events.on(name, fn); return () => events.off(name, fn); }, emit: (name: string, payload: any) => events.emit(name, payload) }, registerTool: (tool: any) => tools.push(tool), registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, getSessionName: () => "own", getActiveTools: () => [], sendMessage: (message: any) => messages.push(message), appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data, id: `entry-${entries.length}` }) };
  state.sessions = [{ id: "own", name: "own", cwd: "/workspace", model: "fixture", pid: 1, startedAt: 1, lastActivity: 1 }, remote];
  extension(pi as any); handlers.get("session_start")({}, ctx); await vi.advanceTimersByTimeAsync(0);
  const client = state.clients.at(-1), tool = tools.find(t => t.name === "intercom");
  cleanups.push(async () => { await handlers.get("session_shutdown")({ reason: "reload" }, ctx); });
  const execute = (params: any) => tool.execute("call", params, new AbortController().signal, undefined, ctx);
  return { client, execute, entries, messages, ctx, handlers, events };
}

it.each(["box-1.invalid/helper", "peer"])("machine-qualified and id asks match sender address and original ask id (%s)", async target => {
  const f = await fixture(); let ask: any;
  f.client.on("send", (_to: string, options: any) => { ask = options; });
  const result = f.execute({ action: "ask", to: target, message: "question" }); await vi.advanceTimersByTimeAsync(0);
  expect(ask).toMatchObject({ expectsReply: true });
  f.client.emit("message", { ...remote, address: { ...remote.address, scopeId: "other" } }, { id: "wrong", replyTo: ask.messageId, timestamp: 2, content: { text: "wrong scope" } });
  f.client.emit("message", remote, { id: "wrong-ask", replyTo: "different-ask", timestamp: 2, content: { text: "wrong thread" } });
  f.client.emit("message", remote, { id: "answer", replyTo: ask.messageId, timestamp: 2, content: { text: "answer" } });
  expect((await result).content[0].text).toContain("answer");
}, 5000);

it("matched waiter records evidence", async () => {
  const f = await fixture(); let ask: any; const receipts: any[] = [];
  f.client.on("send", (_to: string, options: any) => { ask = options; }); f.client.on("receipt", (r: any) => receipts.push(r));
  const result = f.execute({ action: "ask", to: "peer", message: "question" }); await vi.advanceTimersByTimeAsync(0);
  f.client.emit("message", remote, { id: "answer", replyTo: ask.messageId, timestamp: 2, content: { text: "answer" } });
  await result;
  expect(f.entries.find(e => e.customType === "intercom_waiter_receipt")).toMatchObject({ data: { messageId: "answer", askId: ask.messageId, from: remote.address } });
  expect(receipts.find(r => r.status === "matched_waiter")).toMatchObject({ messageId: "answer", evidence: { kind: "waiter", askId: ask.messageId } });
}, 5000);

it.each(["queued", "unknown"])("queued and unknown retain a live remote waiter (%s)", async delivery => {
  state.delivery = delivery;
  const f = await fixture(); let ask: any, settled = false;
  f.client.on("send", (_to: string, options: any) => { ask = options; });
  const result = f.execute({ action: "ask", to: "peer", message: "question" }).then((v: any) => { settled = true; return v; });
  await vi.advanceTimersByTimeAsync(100);
  expect(settled).toBe(false);
  f.client.emit("message", remote, { id: "answer", replyTo: ask.messageId, timestamp: 2, content: { text: "answer" } });
  expect((await result).content[0].text).toContain("answer");
}, 5000);

it("all real send producers use the same authoritative remote target", async () => {
  const f = await fixture(), sent: any[] = [], outbox: any[] = [];
  f.client.on("send", (...args: any[]) => sent.push(args));
  f.events.on("intercom:outbox-result", result => outbox.push(result));
  const result = await f.execute({ action: "send", to: "box-1.invalid/helper", message: "tool", attachments: [{ type: "snippet", name: "sample", content: "synthetic attachment" }] });
  expect(result.details).toMatchObject({ delivery: "queued", delivered: true, acceptance: { accepted: true, durable: true } });
  f.events.emit("subagent:control-intercom", { to: "box-1.invalid/helper", message: "control" });
  f.events.emit("subagent:result-intercom", { to: "box-1.invalid/helper", message: "result", requestId: "relay" });
  f.events.emit("intercom:outbox-request", { version: 1, requestId: "outbox", extensionId: "fixture", extensionName: "Fixture", to: "box-1.invalid/helper", message: "outbox" });
  await vi.advanceTimersByTimeAsync(0);
  expect(sent.map(([to, options]) => [to, options.text]).sort((a, b) => a[1].localeCompare(b[1]))).toEqual([["peer", "control"], ["peer", "outbox"], ["peer", "result"], ["peer", "tool"]]);
  expect(sent[0][1].attachments[0].content).toBe("synthetic attachment");
  expect(sent.find(([, options]) => options.text === "outbox")[1].provenance).toMatchObject({ type: "extension_outbox", requestId: "outbox" });
  expect(outbox).toEqual([expect.objectContaining({ requestId: "outbox", status: "sent" })]);
  expect(f.messages).toEqual([]);
}, 5000);

it("ambiguous remote names give every producer zero send effects", async () => {
  const f = await fixture(), sent: any[] = [], outbox: any[] = [];
  state.sessions.push({ ...remote, id: "second", address: { sessionId: "second", scopeId: null } });
  f.client.on("send", (...args: any[]) => sent.push(args)); f.events.on("intercom:outbox-result", result => outbox.push(result));
  expect((await f.execute({ action: "send", to: "helper", message: "tool" })).details.error).toBe(true);
  f.events.emit("subagent:control-intercom", { to: "helper", message: "control" });
  f.events.emit("intercom:outbox-request", { version: 1, requestId: "ambiguous", extensionId: "fixture", extensionName: "Fixture", to: "helper", message: "outbox" });
  await vi.advanceTimersByTimeAsync(0);
  expect(sent).toEqual([]); expect(f.messages).toEqual([]);
  expect(outbox).toEqual([expect.objectContaining({ status: "blocked", code: "target_ambiguous" })]);
}, 5000);

it("reply inference accepts encoded machine-qualified names", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(remote, { id: "ask", expectsReply: true, timestamp: 1, content: { text: "question" } }, 1);
  expect(tracker.resolveReplyTarget({ to: "box-1.invalid/helper" }, 2).message.id).toBe("ask");
  expect(tracker.resolveReplyTarget({ to: "box-1.invalid/helper", replyTo: "ask" }, 2).from.id).toBe("peer");
  expect(tracker.findUniquePendingAskFrom("box-1.invalid/helper", 2)?.message.id).toBe("ask");
}, 5000);

it("the fork confirms only its physical message entry after message_end", async () => {
  const f = await fixture(), receipts: any[] = [];
  f.client.on("receipt", (value: any) => receipts.push(value));
  f.client.emit("message", remote, { id: "incoming", timestamp: 1, content: { text: "synthetic" } });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.messages).toHaveLength(1);
  expect(receipts.some(r => r.status === "injected")).toBe(false);
  f.handlers.get("message_end")({}, f.ctx);
  expect(receipts.some(r => r.status === "injected")).toBe(false);
  f.entries.push({ type: "custom_message", id: "physical", customType: "intercom_message", details: f.messages[0].details });
  f.handlers.get("message_end")({}, f.ctx); f.handlers.get("message_end")({}, f.ctx);
  expect(receipts.filter(r => r.status === "injected")).toHaveLength(1);
  f.client.emit("message", remote, { id: "incoming", timestamp: 1, content: { text: "synthetic" } });
  expect(f.messages).toHaveLength(1);
  expect(receipts.at(-1)).toMatchObject({ status: "injected", evidence: { entryId: "physical" } });
}, 5000);

it.each(["reload", "quit"])("shutdown intent without queue exclusion stays unknown (%s)", async reason => {
  const f = await fixture(), receipts: any[] = [];
  f.ctx.hasUI = true; f.ctx.isIdle = () => false; f.client.on("receipt", (value: any) => receipts.push(value));
  f.client.emit("message", remote, { id: "queued-before-shutdown", timestamp: 1, content: { text: "synthetic" } });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.messages).toHaveLength(1);
  await f.handlers.get("session_shutdown")({ reason }, f.ctx);
  expect(receipts.some(r => r.status === "not_injected")).toBe(false);
  expect(receipts.at(-1)).toMatchObject({ status: "unknown" });
}, 5000);

it("busy headless refusal emits not_injected and retries only after idle", async () => {
  const f = await fixture(), receipts: any[] = [];
  const replies: any[] = [];
  f.ctx.isIdle = () => false; f.client.on("receipt", (value: any) => receipts.push(value)); f.client.on("send", (...args: any[]) => replies.push(args));
  const message = { id: "busy", timestamp: 1, content: { text: "synthetic" } };
  f.client.emit("message", remote, message); await vi.advanceTimersByTimeAsync(0);
  expect(receipts.find(r => r.status === "not_injected")).toBeDefined();
  f.client.emit("message", remote, message); await vi.advanceTimersByTimeAsync(0);
  expect(f.messages).toHaveLength(0);
  expect(replies).toHaveLength(1);
  f.ctx.isIdle = () => true;
  f.client.emit("message", remote, message); f.client.emit("message", remote, message); await vi.advanceTimersByTimeAsync(0);
  expect(f.messages).toHaveLength(1);
}, 5000);

it("proved old-queue exclusion retains source payload until one same-id entry", async () => {
  const old = await fixture(), payloads = new Map([["recover", "synthetic"]]), statuses: string[] = [];
  const record = (receipt: any) => { statuses.push(receipt.status); if (receiptReleasesPayload(receipt)) payloads.delete(receipt.messageId); };
  old.ctx.hasUI = true; old.ctx.isIdle = () => false; old.client.on("receipt", record);
  const message = { id: "recover", timestamp: 1, content: { text: "synthetic" } };
  old.client.emit("message", remote, message); await vi.advanceTimersByTimeAsync(0);
  const oldGeneration = old.messages[0].details.intercom.activationEpoch;
  await old.handlers.get("session_shutdown")({ reason: "reload" }, old.ctx);
  expect(statuses.at(-1)).toBe("unknown"); expect(payloads.has("recover")).toBe(true);
  // The fake fence makes the old queue unable to drain. Queue removal alone emits no receipt.
  old.messages.length = 0;
  const reconciliation = createIntercomDeliveryObserver({ sessionId: "own", generation: oldGeneration, entries: () => old.entries, receipt: record, now: Date.now });
  reconciliation.register("recover"); reconciliation.accept("recover");
  reconciliation.settle({ excludedGeneration: oldGeneration, complete: true });
  expect(statuses.at(-1)).toBe("not_injected"); expect(payloads.has("recover")).toBe(true);
  const next = await fixture(); next.client.on("receipt", record);
  next.client.emit("message", remote, message); next.client.emit("message", remote, message);
  expect(next.messages).toHaveLength(1);
  expect(next.messages[0].details.intercom.activationEpoch).not.toBe(oldGeneration);
  next.entries.push({ type: "custom_message", customType: "intercom_message", id: "recovered-entry", details: next.messages[0].details });
  next.handlers.get("message_end")({}, next.ctx); next.handlers.get("message_end")({}, next.ctx);
  expect(statuses.filter(status => status === "injected")).toHaveLength(1); expect(payloads.size).toBe(0);
}, 5000);

it("a busy-refusal answer never revives its settled ask", async () => {
  const f = await fixture(); f.ctx.isIdle = () => false;
  const message = { id: "busy-ask", expectsReply: true, remainingMs: 1000, timestamp: 1, content: { text: "question" } };
  f.client.emit("message", remote, message); await vi.advanceTimersByTimeAsync(0);
  f.ctx.isIdle = () => true;
  f.client.emit("message", remote, message); await vi.advanceTimersByTimeAsync(0);
  expect(f.messages).toHaveLength(0);
}, 5000);

it("remote cwd is a destination guard and never opens a pane", async () => {
  const f = await fixture(), sends: any[] = []; f.client.on("send", (...args: any[]) => sends.push(args));
  expect((await f.execute({ action: "send", to: "box-1.invalid/helper", cwd: "/wrong", message: "synthetic" })).details.error).toBe(true);
  expect(sends).toHaveLength(0);
  expect((await f.execute({ action: "send", to: "box-1.invalid/helper", cwd: "/workspace", openProjectPaneIfMissing: true, message: "synthetic" })).details.error).toBe(true);
  expect(sends).toHaveLength(0);
  await f.execute({ action: "send", to: "box-1.invalid/helper", cwd: "/workspace", message: "synthetic" });
  expect(sends[0][0]).toBe("peer");
}, 5000);

it("broker reconnect preserves the source deadline", async () => {
  const f = await fixture(); let settled = false;
  const result = f.execute({ action: "ask", to: "peer", message: "question" }).then((v: any) => { settled = true; return v; });
  await vi.advanceTimersByTimeAsync(1000); f.client.emit("disconnected", new Error("fixture reconnect"));
  await vi.advanceTimersByTimeAsync(1000); expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(598000);
  expect((await result).content[0].text).toMatch(/within 10 minutes/);
}, 5000);


it("every dispatch producer preserves one message id", async () => {
  const f = await fixture(), sent: any[] = [], results: any[] = [];
  f.client.on("send", (...args: any[]) => sent.push(args));
  f.events.on("subagent:result-intercom-delivery", value => results.push(value));
  f.events.emit("subagent:result-intercom", { to: "peer", message: "synthetic", requestId: "stable-relay" });
  await vi.advanceTimersByTimeAsync(0);
  expect(sent[0][1].messageId).toBe("stable-relay");
  expect(results[0]).toMatchObject({ messageId: "stable-relay", delivery: "queued", acceptance: { accepted: true, durable: true } });
}, 5000);
it("not_injected retries on next idle or start without stale queue duplication", async () => {
  const f = await fixture(); f.ctx.isIdle = () => false;
  f.client.emit("message", remote, { id: "idle-retry", timestamp: 1, content: { text: "synthetic" } });
  await vi.advanceTimersByTimeAsync(0); expect(f.messages).toEqual([]);
  f.ctx.isIdle = () => true;
  f.handlers.get("agent_end")({}, f.ctx); await vi.advanceTimersByTimeAsync(0);
  f.handlers.get("agent_end")({}, f.ctx); await vi.advanceTimersByTimeAsync(0);
  expect(f.messages).toHaveLength(1); expect(f.messages[0].details.message.id).toBe("idle-retry");
}, 5000);
it("pending metadata survives reconnect without an await stack", async () => {
  const restored = [{ type: "custom_message", customType: "intercom_message", id: "physical-old", details: { message: { id: "old-delivery" }, intercom: { sessionId: "own", activationEpoch: "old" } } }];
  const f = await fixture(restored), receipts: any[] = [];
  f.client.on("receipt", (value: any) => receipts.push(value));
  f.client.emit("message", remote, { id: "old-delivery", timestamp: 1, content: { text: "synthetic" } });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.messages).toEqual([]); expect(receipts.at(-1)).toMatchObject({ status: "injected", evidence: { entryId: "physical-old", activationEpoch: "old" } });
}, 5000);
it("recorded busy refusal never revives a settled ask", async () => {
  const f = await fixture([{ type: "custom", customType: "intercom_ask_settled", id: "settled", data: { askId: "settled-ask", reason: "busy-refusal" } }]);
  f.client.emit("message", remote, { id: "settled-ask", expectsReply: true, remainingMs: 1000, timestamp: 1, content: { text: "question" } });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.messages).toEqual([]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.entries.some(e => e.customType === "intercom_expired" && e.data.messageId === "settled-ask")).toBe(true);
}, 5000);
it("late reply after reload becomes ordinary threaded message", async () => {
  const f = await fixture();
  f.client.emit("message", remote, { id: "late-answer", replyTo: "old-ask", timestamp: 2, content: { text: "answer" } });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.messages[0].details.message.replyTo).toBe("old-ask");
  expect(f.messages[0].content).toContain("old-ask");
}, 5000);
it("known-down ask fails with link-down", async () => {
  const f = await fixture();
  f.client.send = async (_to: string, options: any) => ({ id: options.messageId, delivered: false, delivery: "failed", reason: "link-down", outcomeKnown: true, retryable: true, acceptance: { accepted: false, durable: false } });
  const result = await f.execute({ action: "ask", to: "peer", message: "question" });
  expect(result.content[0].text).toContain("Link down to box-1.invalid. This ask is no longer waiting for a reply.");
  expect(result.details).toMatchObject({ reason: "link-down", edge: "box-1.invalid" });
}, 5000);
it("active ask survives first transient failure and retry success", async () => {
  const f = await fixture(); let ask: any, settled = false;
  f.client.on("send", (_to: string, options: any) => { ask = options; });
  const result = f.execute({ action: "ask", to: "peer", message: "question" }).then((value: any) => { settled = true; return value; });
  await vi.advanceTimersByTimeAsync(0);
  f.client.emit("broker_message", { type: "presence_update", session: { ...remote, stale: true, reachability: "recovering" } });
  await vi.advanceTimersByTimeAsync(1000); expect(settled).toBe(false);
  f.client.emit("broker_message", { type: "presence_update", session: { ...remote, reachability: "live" } });
  f.client.emit("message", remote, { id: "retry-answer", replyTo: ask.messageId, timestamp: 2, content: { text: "answer" } });
  expect((await result).content[0].text).toContain("answer");
}, 5000);
it("active ask fails after first retry failure but later answer survives", async () => {
  const f = await fixture(); let ask: any;
  f.client.on("send", (_to: string, options: any) => { ask = options; });
  const result = f.execute({ action: "ask", to: "peer", message: "question" });
  await vi.advanceTimersByTimeAsync(0);
  f.client.emit("broker_message", { type: "presence_update", session: { ...remote, stale: true, reachability: "down" } });
  expect((await result).content[0].text).toContain("Link down to box-1.invalid. This ask is no longer waiting for a reply.");
  f.client.emit("message", remote, { id: "orphan-answer", replyTo: ask.messageId, timestamp: 2, content: { text: "late answer" } });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.messages.at(-1).details.message).toMatchObject({ id: "orphan-answer", replyTo: ask.messageId });
}, 5000);


it("a restored incoming question can be answered without reconstructing a waiter", async () => {
  const question = { id: "restored-question", expectsReply: true, timestamp: 1, content: { text: "question" } };
  const f = await fixture([{ type: "custom_message", customType: "intercom_message", id: "old-question-entry", details: { from: remote, message: question, intercom: { sessionId: "own", activationEpoch: "old" } } }]);
  const sent: any[] = []; f.client.on("send", (...args: any[]) => sent.push(args));
  const result = await f.execute({ action: "reply", replyTo: "restored-question", message: "answer" });
  expect(result.details.replyTo).toBe("restored-question"); expect(sent[0][1].replyTo).toBe("restored-question");
}, 5000);
it("late replies tell the replier when the asker was no longer waiting", async () => {
  const f = await fixture(); const receipts: any[] = []; f.client.on("receipt", (value: any) => receipts.push(value));
  f.client.emit("message", remote, { id: "orphan-notice", replyTo: "old-ask", timestamp: 2, content: { text: "answer" } });
  await vi.advanceTimersByTimeAsync(0);
  f.entries.push({ type: "custom_message", customType: "intercom_message", id: "orphan-entry", details: f.messages[0].details });
  f.handlers.get("message_end")({}, f.ctx);
  expect(receipts.at(-1)).toMatchObject({ status: "injected", detail: "asker-no-longer-waiting" });
}, 5000);
it("explicit threaded replies remain possible after the live ask duration", () => {
  const tracker = new ReplyTracker(1000);
  tracker.recordIncomingMessage(remote, { id: "expired-wait", expectsReply: true, timestamp: 1, content: { text: "question" } }, 1);
  expect(tracker.listPending(2000)).toEqual([]);
  expect(tracker.resolveReplyTarget({ replyTo: "expired-wait" }, 2000).message.id).toBe("expired-wait");
}, 5000);

it("outbox acknowledgements preserve durable acceptance without claiming consumption", async () => {
  state.delivery = "unknown"; const f = await fixture(), results: any[] = [];
  f.events.on("intercom:outbox-result", result => results.push(result));
  f.events.emit("intercom:outbox-request", { version: 1, requestId: "uncertain-outbox", extensionId: "fixture", extensionName: "Fixture", to: "peer", message: "synthetic" });
  await vi.advanceTimersByTimeAsync(0);
  expect(results[0]).toMatchObject({ status: "unknown", messageId: "uncertain-outbox", delivery: "unknown", outcomeKnown: false, acceptance: { accepted: true, durable: true } });
  expect(results[0].consumption).toBeUndefined();
}, 5000);

it("an undelivered busy question expires visibly and cannot drain from a stale pi queue", async () => {
  const f = await fixture(); f.ctx.hasUI = true; f.ctx.isIdle = () => false;
  f.client.emit("message", remote, { id: "expired-busy-question", expectsReply: true, remainingMs: 1000, timestamp: 1, content: { text: "question" } });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.messages.filter(m => m.customType === "intercom_message")).toEqual([]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.messages.some(m => m.customType === "intercom_notice" && m.details.messageId === "expired-busy-question")).toBe(true);
  f.ctx.isIdle = () => true; f.handlers.get("agent_end")({}, f.ctx); await vi.advanceTimersByTimeAsync(0);
  expect(f.messages.filter(m => m.customType === "intercom_message")).toEqual([]);
}, 5000);

it("restored undelivered question keeps its original deadline across reload", async () => {
  const f = await fixture([{ type: "custom", customType: "intercom_pending", id: "pending-entry", data: { messageId: "restored-expiry", sessionId: "own", activationEpoch: "old", expectsReply: true, receivedAt: Date.now() - 2000, deadline: Date.now() - 1, from: remote } }]);
  expect(f.entries.some(e => e.customType === "intercom_expired" && e.data.messageId === "restored-expiry")).toBe(true);
  f.client.emit("message", remote, { id: "restored-expiry", expectsReply: true, remainingMs: 60000, timestamp: 1, content: { text: "question" } });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.messages.filter(m => m.customType === "intercom_message")).toEqual([]);
}, 5000);

it("restored consumed evidence is not downgraded by competing pending metadata", async () => {
  const f = await fixture([
    { type: "custom_message", customType: "intercom_message", id: "physical", details: { from: remote, message: { id: "consumed", expectsReply: true, remainingMs: 1000, timestamp: Date.now(), content: { text: "synthetic" } }, intercom: { sessionId: "own", activationEpoch: "observed-generation" } } },
    { type: "custom", customType: "intercom_pending", id: "pending", data: { messageId: "consumed", sessionId: "own", activationEpoch: "competing-generation", from: remote, expectsReply: true, receivedAt: Date.now(), deadline: Date.now() + 1000 } },
  ]), receipts: any[] = [];
  f.client.on("receipt", (r: any) => receipts.push(r));
  f.client.emit("message", remote, { id: "consumed", timestamp: 1, content: { text: "synthetic" } });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.messages).toEqual([]); expect(receipts.at(-1)).toMatchObject({ status: "injected", evidence: { entryId: "physical", activationEpoch: "observed-generation" } });
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.entries.some(e => e.customType === "intercom_expired" && e.data.messageId === "consumed")).toBe(false);
}, 5000);

it.each([false, true])("replier notice is idempotent including restored notices (%s)", async restored => {
  const notice = { type: "custom", customType: "intercom_reply_notice", id: "notice", data: { messageId: "orphan-reply" } };
  const f = await fixture(restored ? [notice] : []);
  const frame = { type: "message_receipt", from: remote, receipt: { messageId: "orphan-reply", status: "injected", timestamp: 2, detail: "asker-no-longer-waiting", evidence: { kind: "entry", entryId: "reply-entry", sessionId: remote.id, activationEpoch: remote.activationEpoch } } };
  f.client.emit("broker_message", frame); f.client.emit("broker_message", frame);
  expect(f.entries.filter(e => e.customType === "intercom_reply_notice")).toHaveLength(1);
}, 5000);

it("unsupported brokers cannot turn a remote send into legacy local delivery", async () => {
  const f = await fixture(), sent: any[] = [], outbox: any[] = [];
  f.client.supportsFeature = () => false; f.client.on("send", (...args: any[]) => sent.push(args));
  f.events.on("intercom:outbox-result", value => outbox.push(value));
  const result = await f.execute({ action: "send", to: "peer", message: "synthetic" });
  expect(result.content[0].text).toContain("unsupported-broker");
  f.events.emit("subagent:result-intercom", { to: "peer", message: "synthetic", requestId: "unsupported" });
  f.events.emit("intercom:outbox-request", { version: 1, requestId: "unsupported-outbox", extensionId: "fixture", extensionName: "Fixture", to: "peer", message: "synthetic" });
  await vi.advanceTimersByTimeAsync(0);
  expect(sent).toEqual([]); expect(outbox[0]).toMatchObject({ status: "failed", detail: "unsupported-broker" });
}, 5000);
