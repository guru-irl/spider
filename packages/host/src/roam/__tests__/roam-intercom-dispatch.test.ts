import { afterEach, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, statSync, unlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openDbAt, type Db } from "@spider/db-core";
import { sendIntercom, pollPendingMessages } from "@spider/subagents";
import { MessageStore } from "../../../../subagents/src/message-store";
import { INTERCOM_RESOLVE_EVENT } from "@spider/intercom/protocol";
import { makeMessageHandler } from "../../../../subagents/src/actions/message";

const roots: string[] = [], dbs: Db[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(route: "bridge" | "local" | "ambiguous" = "local") {
  const scratch = resolve(".spider/scratch/3.6d"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "dispatch-")); roots.push(root);
  const db = openDbAt(join(root, "global.db"), "global"); dbs.push(db);
  const bus = new EventEmitter(), sent: any[] = [];
  bus.on(INTERCOM_RESOLVE_EVENT, (request: any) => {
    request.handled = true;
    request.respond(route === "ambiguous" ? { kind: "ambiguous" } : { kind: route, to: "target", address: { sessionId: "target", scopeId: null } });
  });
  bus.on("subagent:result-intercom", (request: any) => {
    sent.push(request);
    bus.emit("subagent:result-intercom-delivery", { requestId: request.requestId, messageId: request.requestId, delivered: true,
      delivery: route === "bridge" ? "queued" : "socket_delivered", outcomeKnown: true, retryable: false,
      acceptance: { accepted: true, durable: route === "bridge", ...(route === "bridge" ? { location: "intercom:source" } : {}) } });
  });
  const pi = { events: { on: (name: string, fn: any) => { bus.on(name, fn); return () => bus.off(name, fn); }, emit: (name: string, value: any) => bus.emit(name, value) } };
  return { db, pi, sent, bus };
}
it("remote spider message writes no mirror body", async () => {
  const f = fixture("bridge");
  const result = await makeMessageHandler()({ to: "target", message: "synthetic body" }, { globalDb: f.db, pi: f.pi, sessionId: "sender" });
  expect(result.isError).toBe(false);
  expect(result.details).toMatchObject({ messageId: f.sent[0].requestId, delivery: "queued", delivered: true, acceptance: { accepted: true, durable: true } });
  expect(f.db.prepare("SELECT * FROM message_mirror").all()).toEqual([]);
}, 5000);
it("bridge-routed legacy row never replays after move to sender machine", async () => {
  const f = fixture(), store = new MessageStore(f.db), messages: unknown[] = [];
  store.enqueue({ toSession: "target", body: "old body", route: { kind: "bridge", messageId: "old-remote" } });
  await pollPendingMessages(f.db, "target", { sendMessage: (m: unknown) => messages.push(m) });
  expect(messages).toEqual([]); expect(store.pending("target")).toHaveLength(1);
}, 5000);
it("local offline portable-id row without home still replays", async () => {
  const f = fixture(), store = new MessageStore(f.db), messages: any[] = [];
  const id = "12345678-1234-4321-8765-123456789abc";
  store.enqueue({ toSession: id, body: "local body" });
  await pollPendingMessages(f.db, id, { sendMessage: (m: unknown) => messages.push(m) });
  expect(messages).toHaveLength(1); expect(messages[0].details.body).toBe("local body"); expect(store.pending(id)).toEqual([]);
}, 5000);
it("pre-upgrade rows migrate once to local routes without address guessing", async () => {
  const f = fixture(), messages: unknown[] = [];
  f.db.prepare("INSERT INTO message_mirror(to_session,body,created_at) VALUES ('target','unresolved',1)").run();
  await pollPendingMessages(f.db, "target", { sendMessage: (m: unknown) => messages.push(m) });
  expect(messages).toHaveLength(1);
  expect(new MessageStore(f.db).pending("target")).toEqual([]);
}, 5000);
it("ambiguous target has zero send and mailbox effects", async () => {
  const f = fixture("ambiguous"); const result = await sendIntercom(f.pi, f.db, { to: "target", message: "synthetic" });
  expect(result).toMatchObject({ delivered: false, queued: false, delivery: "failed" });
  expect(f.sent).toEqual([]); expect(f.db.prepare("SELECT * FROM message_mirror").all()).toEqual([]);
}, 5000);
it("shutdown after early ack retains the source", async () => {
  const f = fixture("bridge");
  f.bus.removeAllListeners("subagent:result-intercom");
  f.bus.on("subagent:result-intercom", (p: any) => f.bus.emit("subagent:result-intercom-delivery", { requestId: p.requestId, messageId: p.requestId, delivered: true, delivery: "unknown", outcomeKnown: false, retryable: false, acceptance: { accepted: true, durable: true, location: "intercom:source" } }));
  const result = await sendIntercom(f.pi, f.db, { to: "target", message: "synthetic" });
  expect(result).toMatchObject({ delivery: "unknown", outcomeKnown: false, acceptance: { accepted: true, durable: true }, recipientAcknowledged: false });
  expect(result.consumption).toBeUndefined(); expect(typeof result.messageId).toBe("string");
}, 5000);

it("the tool reports uncertain remote delivery without inventing a mailbox", async () => {
  const f = fixture("bridge"); f.bus.removeAllListeners("subagent:result-intercom");
  f.bus.on("subagent:result-intercom", (p: any) => f.bus.emit("subagent:result-intercom-delivery", { requestId: p.requestId, messageId: p.requestId, delivered: false, delivery: "unknown", outcomeKnown: false, retryable: false, acceptance: { accepted: false, durable: false } }));
  const result = await makeMessageHandler()({ to: "target", message: "synthetic" }, { globalDb: f.db, pi: f.pi, sessionId: "sender" });
  expect(result.content).toContain("delivery is unknown"); expect(result.content).not.toContain("message queued"); expect(result.details.queued).toBe(false);
}, 5000);

it("portable local targets do not select durable bridge routing by id shape", async () => {
  const f = fixture("local"), id = "12345678-1234-4321-8765-123456789abc";
  f.bus.removeAllListeners(INTERCOM_RESOLVE_EVENT);
  f.bus.on(INTERCOM_RESOLVE_EVENT, request => { request.handled = true; request.respond({ kind: "local", to: id, address: { sessionId: id, scopeId: null } }); });
  const result = await sendIntercom(f.pi, f.db, { to: id, message: "synthetic" });
  expect(result.mirrorId).toBeTypeOf("number"); expect(result.delivery).toBe("broker-accepted");
  expect(f.db.prepare("SELECT body FROM message_mirror").all()).toEqual([{ body: "synthetic" }]);
}, 5000);
it("a send-time roaming home selects the bridge even for a resolved local target", async () => {
  const f = fixture("local");
  f.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,updated_at) VALUES (?,?,?,?)").run("target", "00000000-0000-4000-8000-000000000001", 1, 1);
  const result = await sendIntercom(f.pi, f.db, { to: "target", message: "synthetic" });
  expect(result.messageId).toBe(f.sent[0].requestId); expect(result.mirrorId).toBeUndefined();
  expect(f.db.prepare("SELECT * FROM message_mirror").all()).toEqual([]);
}, 5000);
it("private route evidence contains no body and cannot be reused for a changed row", async () => {
  const f = fixture(), store = new MessageStore(f.db), messages: unknown[] = [];
  const id = store.enqueue({ toSession: "target", body: "synthetic original", route: { kind: "local", messageId: "stable-id" } });
  const directory = join(dirname(f.db.raw.name), "intercom-routes"), file = join(directory, readdirSync(directory)[0]);
  expect(statSync(directory).mode & 0o077).toBe(0); expect(statSync(file).mode & 0o077).toBe(0);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ kind: "local", messageId: "stable-id" });
  f.db.prepare("UPDATE message_mirror SET body=? WHERE id=?").run("changed synthetic", id);
  await pollPendingMessages(f.db, "target", { sendMessage: (m: unknown) => messages.push(m) });
  expect(messages).toEqual([]); expect(store.pending("target")[0].route).toBeUndefined();
}, 5000);
it("a symlink cannot turn bridge provenance into replayable local evidence", async () => {
  const f = fixture(), store = new MessageStore(f.db), messages: unknown[] = [];
  store.enqueue({ toSession: "target", body: "synthetic", route: { kind: "bridge", messageId: "bridge-id" } });
  const directory = join(dirname(f.db.raw.name), "intercom-routes"), file = join(directory, readdirSync(directory)[0]), forged = join(dirname(directory), "forged.json");
  writeFileSync(forged, JSON.stringify({ kind: "local", messageId: "forged-id" }), { mode: 0o600 }); unlinkSync(file); symlinkSync(forged, file);
  await pollPendingMessages(f.db, "target", { sendMessage: (m: unknown) => messages.push(m) });
  expect(messages).toEqual([]); expect(store.pending("target")).toHaveLength(1);
}, 5000);
