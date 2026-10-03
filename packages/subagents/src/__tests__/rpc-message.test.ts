import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDbAt, type Db } from "@spider/db-core";
import { makeMessageHandler } from "../actions/message";
import { registerChild, teardownAll } from "../coordinators";
import { RunStore } from "../run-store";
import { SUBAGENT_RESULT_INTERCOM_EVENT, SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT } from "../intercom";
const dbs: Db[] = [], roots: string[] = [];
afterEach(() => { vi.useRealTimers(); teardownAll(); for (const db of dbs.splice(0)) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(mode: "rpc" | "print" = "rpc", intercom = false) {
  const scratch = resolve(".spider/scratch/rpc-message"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "case-")); roots.push(root);
  const db = openDbAt(join(root, "project.db"), "worktree"), globalDb = openDbAt(join(root, "global.db"), "global"); dbs.push(db, globalDb);
  const store = new RunStore(db);
  const { id } = store.create({ sessionId: "owner", agent: "worker", name: "task" }); store.start(id);
  // Launch capability is durable, not guessed from today's settings or installed packages.
  expect(typeof (store as any).setLaunch).toBe("function");
  (store as any).setLaunch(id, { childMode: mode, intercomSession: intercom ? "task-child-unique" : undefined });
  const routed: any[] = [];
  const events = new EventEmitter();
  events.on(SUBAGENT_RESULT_INTERCOM_EVENT, p => { routed.push(p); events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, { requestId: p.requestId, delivered: true }); });
  const pi = { events: { on: (n: string, f: (...args: any[]) => void) => { events.on(n, f); return () => { events.off(n, f); }; }, emit: (n: string, p: unknown) => events.emit(n, p) } };
  return { db, globalDb, store, id, routed, pi, root, dbPath: join(root, "project.db") };
}
describe("steerable child message routing", () => {
  // Mapping any accepted reply to unconfirmed would hide explicit extension consumption.
  it("reports consumed input as not delivered rather than accepted-unconfirmed", async () => {
    const f = fixture();
    registerChild("owner", f.id, { kill() {}, detach() {}, wait: async () => ({ exitCode: 0 }),
      steer: async () => ({ accepted: true, childAccepted: true, delivered: false, queued: false, delivery: "consumed by an extension, not delivered" }) } as any);
    const result = await makeMessageHandler()({ to: f.id, message: "consumed" }, { ...f, sessionId: "owner" });
    expect(result.isError).toBe(false);
    expect(result.details).toMatchObject({ accepted: true, childAccepted: true, delivered: false, queued: false, delivery: "consumed by an extension, not delivered" });
    expect(result.content).toMatch(/consumed by an extension.*not delivered.*model/i);
    expect(result.content).not.toMatch(/accepted but not confirmed|next turn boundary|do not resend|may still be delivered/i);
    const event = f.db.prepare("SELECT payload FROM run_events WHERE run_id=? AND type='steer'").get(f.id) as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ delivered: false, delivery: "consumed by an extension, not delivered" });
  });
  it("reports no pi reply as unknown instead of refusal", async () => {
    const f = fixture();
    registerChild("owner", f.id, { kill() {}, detach() {}, wait: async () => ({ exitCode: 0 }), steer: async () => ({ accepted: false, delivered: false, delivery: "no reply yet, delivery unknown" }) } as any);
    const result = await makeMessageHandler()({ to: f.id, message: "slow" }, { ...f, sessionId: "owner" });
    expect(result.isError).toBe(false); expect(result.details.delivery).toBe("no reply yet, delivery unknown");
    expect(result.content).toContain("no reply yet, delivery unknown"); expect(result.content).not.toContain("refused");
    expect(result.content).toMatch(/do not resend/i);
  });
  it.each(["Run settled before the child replied; delivery unknown.", "Child process has exited.", "Child was stopped."])("does not promise future delivery after tracking ends: %s", async error => {
    const f = fixture();
    registerChild("owner", f.id, { kill() {}, detach() {}, wait: async () => ({ exitCode: 0 }), steer: async () => ({ accepted: false, delivered: false, delivery: "no reply yet, delivery unknown", error }) } as any);
    const result = await makeMessageHandler()({ to: f.id, message: "correction" }, { ...f, sessionId: "owner" });
    expect(result.content).not.toMatch(/may still be delivered|do not resend/i);
    expect(result.content).toMatch(/steer was not delivered.*run has ended/i);
    expect(result.content).toMatch(/fresh run/i);
    expect(result.details.delivery).toBe("no reply yet, delivery unknown");
  });
  it("reports a never-written waiter as not sent rather than unconfirmed child acceptance", async () => {
    const f = fixture();
    registerChild("owner", f.id, { kill() {}, detach() {}, wait: async () => ({ exitCode: 0 }), steer: async () => ({ accepted: false, delivered: false, delivery: "refused", error: "Not sent: timed out waiting for an earlier steer's reply." }) } as any);
    const result = await makeMessageHandler()({ to: f.id, message: "waiter" }, { ...f, sessionId: "owner" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not sent/i);
    expect(result.content).not.toMatch(/did not confirm steering acceptance/i);
  });
  it("explains a deadline-expired steer still queued in the child without inviting a resend", async () => {
    const f = fixture();
    registerChild("owner", f.id, { kill() {}, detach() {}, wait: async () => ({ exitCode: 0 }),
      steer: async () => ({ accepted: true, childAccepted: true, delivered: false, queued: true, delivery: "accepted but not confirmed" }) });
    const result = await makeMessageHandler()({ to: f.id, message: "correction" }, { ...f, sessionId: "owner" });
    expect(result.isError).toBe(false);
    expect(result.details).toMatchObject({ accepted: true, delivered: false, queued: true, delivery: "accepted but not confirmed" });
    expect(result.content).toMatch(/queued in the child/i);
    expect(result.content).toMatch(/pi delivers it at the child's next turn boundary unless the run ends first/i);
    expect(result.content).toMatch(/final state.*run's events and completion summary/i);
    expect(result.content).toMatch(/do not resend/i);
  });
  it("omits queued-child guidance for accepted input that is not queued", async () => {
    const f = fixture();
    registerChild("owner", f.id, { kill() {}, detach() {}, wait: async () => ({ exitCode: 0 }),
      steer: async () => ({ accepted: true, childAccepted: true, delivered: false, queued: false, delivery: "accepted but not confirmed" }) });
    const result = await makeMessageHandler()({ to: f.id, message: "swallowed" }, { ...f, sessionId: "owner" });
    expect(result.isError).toBe(false);
    expect(result.details).toMatchObject({ accepted: true, delivered: false, queued: false, delivery: "accepted but not confirmed" });
    expect(result.content).not.toMatch(/it is queued in the child|next turn boundary/i);
  });
  it.each(["Child process has exited.", "Child was stopped.", "Run settled; accepted, delivery not confirmed."])("does not offer future queued delivery after an accepted wait ends: %s", async error => {
    const f = fixture();
    registerChild("owner", f.id, { kill() {}, detach() {}, wait: async () => ({ exitCode: 0 }),
      steer: async () => ({ accepted: true, delivered: false, queued: true, delivery: "accepted but not confirmed", error }) });
    const result = await makeMessageHandler()({ to: f.id, message: "correction" }, { ...f, sessionId: "owner" });
    expect(result.content).not.toMatch(/next turn boundary|do not resend/i);
    expect(result.content).toContain(error);
    expect(result.details.queued).toBe(false);
  });
  it("reports observed delivery with a transformed-text note", async () => {
    const f = fixture();
    registerChild("owner", f.id, { kill() {}, detach() {}, wait: async () => ({ exitCode: 0 }), steer: async () => ({ accepted: true, delivered: true, delivery: "delivered", transformed: true, observedText: "rewritten" }) });
    const result = await makeMessageHandler()({ to: f.id, message: "rewrite" }, { ...f, sessionId: "owner" });
    expect(result.isError).toBe(false); expect(result.details).toMatchObject({ accepted: true, delivered: true, delivery: "delivered", transformed: true });
    expect(result.content).toMatch(/delivered.*transformed/i);
  });
  it.each(["owner", "peer"])("refuses slash steers before local or foreign transport (%s)", async sessionId => {
    const f = fixture("rpc", true); const writes: string[] = [];
    registerChild("owner", f.id, { kill() {}, detach() {}, wait: async () => ({ exitCode: 0 }), steer: async text => { writes.push(text); return { accepted: true }; } });
    const result = await makeMessageHandler()({ to: f.id, message: "/skill:test" }, { ...f, sessionId });
    expect(result.isError).toBe(true); expect(result.details.delivery).toBe("refused");
    expect(result.content).toMatch(/refused.*expanded by the child as a skill or prompt template/i);
    expect(writes).toEqual([]); expect(f.routed).toEqual([]);
  });
  it("uses the owner's live pipe, records a steer, and calls acceptance queued rather than delivered", async () => {
    const f = fixture(); const stdin: string[] = [];
    registerChild("owner", f.id, { kill() {}, detach() {}, wait: async () => ({ exitCode: 0 }), steer: async (message: string) => { stdin.push(message); return { accepted: true }; } } as any);
    const result = await makeMessageHandler()({ to: f.id, message: "correction" }, { ...f, sessionId: "owner" });
    expect(result.isError).toBe(false);
    expect(result.details).toMatchObject({ accepted: true, delivered: false, delivery: "accepted but not confirmed" });
    expect(result.content).toContain("accepted but not confirmed");
    expect(stdin).toEqual(["correction"]);
    expect(f.routed).toHaveLength(0);
    expect(f.db.prepare("SELECT type FROM run_events WHERE run_id=? AND type='steer'").all(f.id)).toHaveLength(1);
    expect(f.db.prepare("SELECT summary FROM run_events WHERE run_id=? AND type='steer'").get(f.id)).toMatchObject({ summary: expect.stringContaining("accepted but not confirmed") });
  });
  it("distinguishes a late child queue acknowledgement from usable steering acceptance", async () => {
    const f = fixture();
    registerChild("owner", f.id, { kill() {}, detach() {}, wait: async () => ({ exitCode: 0 }), steer: async () => ({ accepted: false, childAccepted: true, error: "Run settled; any remaining queue was discarded. Model consumption is unconfirmed." }) });
    const result = await makeMessageHandler()({ to: f.id, message: "correction" }, { ...f, sessionId: "owner" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("accepted but not confirmed");
    expect(result.content).toMatch(/settled|discarded/);
    expect(result.details).toMatchObject({ childAccepted: true, delivered: false, queued: false });
  });
  it("routes a foreign run only to its persisted intercom name without claiming model receipt", async () => {
    const f = fixture("rpc", true);
    const result = await makeMessageHandler()({ to: f.id, message: "correction" }, { ...f, sessionId: "peer" });
    expect(result.isError).toBe(false);
    expect(f.routed.map(r => r.to)).toEqual(["task-child-unique"]);
    expect(result.details).toMatchObject({ delivery: "broker-accepted", delivered: false, recipientAcknowledged: false });
  });
  it("routes a run from another worktree through its owner's persisted capability", async () => {
    const f = fixture("rpc", true);
    f.globalDb.exec("CREATE TABLE IF NOT EXISTS run_routes (run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, db_path TEXT NOT NULL)");
    f.globalDb.prepare("INSERT INTO run_routes VALUES (?,?,?)").run(f.id, "owner", f.dbPath);
    const peerDb = openDbAt(join(f.root, "peer.db"), "worktree"); dbs.push(peerDb);
    const result = await makeMessageHandler()({ to: f.id, message: "cross-worktree correction" }, { ...f, db: peerDb, sessionId: "peer" });
    expect(result.isError).toBe(false);
    expect(f.routed.map(r => r.to)).toEqual(["task-child-unique"]);
    expect(f.db.prepare("SELECT type FROM run_events WHERE run_id=? AND type='steer'").all(f.id)).toHaveLength(1);
  });
  it("reports a broker-rejected foreign steer as not delivered, not a deferred success", async () => {
    const f = fixture("rpc", true);
    const events = new EventEmitter();
    events.on(SUBAGENT_RESULT_INTERCOM_EVENT, p => events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, { requestId: p.requestId, delivered: false, error: "Child disconnected" }));
    const pi = { events: { on: (n: string, fn: any) => { events.on(n, fn); return () => events.off(n, fn); }, emit: (n: string, p: any) => events.emit(n, p) } };
    const result = await makeMessageHandler()({ to: f.id, message: "late" }, { ...f, pi, sessionId: "peer" });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ delivered: false, queued: false });
    expect(result.content).toMatch(/broker did not accept the steer/i);
    expect(f.globalDb.prepare("SELECT id FROM message_mirror WHERE delivered_at IS NULL").all()).toEqual([]);
  });
  it("reports a broker timeout as unconfirmed without claiming non-delivery", async () => {
    vi.useFakeTimers(); const f = fixture("rpc", true);
    const pi = { events: { on: () => () => {}, emit() {} } };
    const pending = makeMessageHandler()({ to: f.id, message: "correction", timeoutMs: 10 }, { ...f, pi, sessionId: "peer" });
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.isError).toBe(false);
    expect(result.details.delivery).toBe("no reply yet, delivery unknown");
    expect(result.content).toContain("no reply yet, delivery unknown");
    expect(result.content).not.toMatch(/refused|was not delivered/i);
    expect(result.content).toMatch(/do not resend/i);
    expect(f.globalDb.prepare("SELECT id FROM message_mirror WHERE delivered_at IS NULL").all()).toEqual([]);
  });
  it("reports a peer broker timeout as queued and unconfirmed", async () => {
    vi.useFakeTimers(); const f = fixture(); const pi = { events: { on: () => () => {}, emit() {} } };
    const pending = makeMessageHandler()({ to: "other-session", message: "hello", timeoutMs: 10 }, { ...f, pi, sessionId: "peer" });
    await vi.advanceTimersByTimeAsync(100); const result = await pending;
    expect(result.isError).toBe(false); expect(result.details.queued).toBe(true);
    expect(result.content).toMatch(/unconfirmed/i);
    expect(result.content).not.toMatch(/not delivered|not accepted by the broker|use a peer session/i);
  });
  it("reports a queued peer message without a broker as unavailable, not refused", async () => {
    const f = fixture();
    const result = await makeMessageHandler()({ to: "other-session", message: "hello" }, { ...f, pi: {}, sessionId: "peer" });
    expect(result.details.queued).toBe(true);
    expect(result.content).toMatch(/no intercom broker available/i);
    expect(result.content).not.toMatch(/not accepted by the broker/i);
  });
  it("scopes peer broker refusal wording to an explicit negative reply", async () => {
    const f = fixture(), events = new EventEmitter();
    events.on(SUBAGENT_RESULT_INTERCOM_EVENT, p => events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, { requestId: p.requestId, delivered: false, error: "Peer disconnected" }));
    const pi = { events: { on: (n: string, fn: any) => { events.on(n, fn); return () => events.off(n, fn); }, emit: (n: string, p: any) => events.emit(n, p) } };
    const result = await makeMessageHandler()({ to: "other-session", message: "hello" }, { ...f, pi, sessionId: "peer" });
    expect(result.details.queued).toBe(true);
    expect(result.content).toMatch(/not accepted by the broker/i);
  });
  it("preserves an accepted steer when event persistence fails", async () => {
    const f = fixture();
    registerChild("owner", f.id, { kill() {}, detach() {}, wait: async () => ({ exitCode: 0 }), steer: async () => ({ accepted: true }) });
    const db = { ...f.db, prepare(sql: string) { if (sql.includes("INSERT INTO run_events")) throw new Error("fixture event write failed"); return f.db.prepare(sql); } };
    const result = await makeMessageHandler()({ to: f.id, message: "correction" }, { ...f, db, sessionId: "owner" });
    expect(result.isError).toBe(false);
    expect(result.details.accepted).toBe(true);
    expect(result.details.warning).toMatch(/event.*record|record.*event/i);
  });
  it("truthfully refuses foreign RPC runs without intercom", async () => {
    const f = fixture();
    const result = await makeMessageHandler()({ to: f.id, message: "correction" }, { ...f, sessionId: "peer" });
    expect(result.isError).toBe(true); expect(result.content).toMatch(/owned by session owner/i); expect(result.content).toContain("pi-intercom");
    expect(f.routed).toHaveLength(0);
  });
  it.each(["done", "failed", "cancelled", "paused", "queued", "print"])("refuses %s runs without writing a steer", async status => {
    const f = fixture(status === "print" ? "print" : "rpc", true);
    if (status !== "print") f.db.prepare("UPDATE runs SET status=? WHERE id=?").run(status, f.id);
    const writes: string[] = [];
    registerChild("owner", f.id, { kill() {}, detach() {}, wait: async () => ({ exitCode: 0 }), steer: async (message: string) => { writes.push(message); return { accepted: true }; } } as any);
    const result = await makeMessageHandler()({ to: f.id, message: "correction" }, { ...f, sessionId: "owner" });
    expect(result.isError).toBe(true); expect(writes).toHaveLength(0); expect(f.routed).toHaveLength(0);
  });
});
