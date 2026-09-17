import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDbAt, type Db } from "@spider/db-core";
import { sendIntercom, SUBAGENT_RESULT_INTERCOM_EVENT, SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT } from "../intercom";
import { makeMessageHandler } from "../actions/message";
import { MessageStore } from "../message-store";

const scratch = resolve(".spider/scratch/message-integrity");
const roots: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const db of dbs.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "case-")); roots.push(root);
  const globalDb = openDbAt(join(root, "global.db"), "global");
  const db = openDbAt(join(root, "worktree.db"), "worktree");
  dbs.push(db, globalDb);
  return { db, globalDb };
}
function broker(reply: Record<string, unknown>) {
  const bus = new EventEmitter();
  bus.on(SUBAGENT_RESULT_INTERCOM_EVENT, ({ requestId }) => {
    // The actual pi-intercom plugin returns BOTH positive and negative replies.
    bus.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, { requestId, ...reply });
  });
  return { events: {
    on: (name: string, fn: (...args: any[]) => void) => { bus.on(name, fn); return () => { bus.off(name, fn); }; },
    emit: (name: string, payload: unknown) => { bus.emit(name, payload); },
  } };
}

describe("honest message delivery", () => {
  it("does not turn the real broker's delivered:false reply into a successful delivery", async () => {
    const { globalDb } = fixture();
    const res = await sendIntercom(broker({ delivered: false, error: "Recipient is offline" }), globalDb,
      { to: "peer-session", message: "Correction", timeoutMs: 100 });
    expect(res.delivered).toBe(false);
    expect(res.queued).toBe(true);
    expect(res.error).toContain("offline");
    expect(new MessageStore(globalDb).pending("peer-session")).toHaveLength(1);
  });

  it("distinguishes broker acceptance from a recipient acknowledgement", async () => {
    const { globalDb } = fixture();
    const res = await sendIntercom(broker({ delivered: true }), globalDb, { to: "peer-session", message: "Correction" });
    expect(res).toMatchObject({ delivered: true, delivery: "broker-accepted", recipientAcknowledged: false });
    expect(globalDb.prepare("SELECT delivered_at, read_at FROM message_mirror").get()).toMatchObject({
      delivered_at: expect.any(Number), read_at: null,
    });
  });

  it("cleans the timeout after a synchronous broker acknowledgement", async () => {
    const { globalDb } = fixture();
    vi.useFakeTimers();
    await sendIntercom(broker({ delivered: true }), globalDb, { to: "peer-session", message: "Correction" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves an unconfirmed reply pending instead of guessing that it was delivered", async () => {
    const { globalDb } = fixture();
    const res = await sendIntercom(broker({}), globalDb, { to: "peer-session", message: "Correction", timeoutMs: 10 });
    expect(res.delivered).toBe(false);
    expect(new MessageStore(globalDb).pending("peer-session")).toHaveLength(1);
  });

  it("queues durably without throwing when no broker API is installed", async () => {
    const { globalDb } = fixture();
    await expect(sendIntercom({}, globalDb, { to: "peer-session", message: "Correction" }))
      .resolves.toMatchObject({ delivered: false, queued: true, delivery: "queued" });
    expect(new MessageStore(globalDb).pending("peer-session")).toHaveLength(1);
  });

  it.each(["done", "failed", "cancelled"])("rejects a %s run target without creating an unread mailbox entry", async status => {
    const f = fixture();
    f.db.prepare("INSERT INTO runs(id,session_id,agent,name,status) VALUES (?,?,?,?,?)")
      .run("abcdef12-0000-4000-8000-000000000000", "parent", "worker", "finished-task", status);
    const result = await makeMessageHandler()({ to: "abcdef12", message: "Correction" }, {
      ...f, pi: broker({ delivered: true }), sessionId: "parent",
    });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ delivered: false, queued: false, delivery: "unavailable" });
    expect(result.content).toMatch(/fresh|new run/i);
    expect(f.globalDb.prepare("SELECT COUNT(*) n FROM message_mirror").get()).toEqual({ n: 0 });
  });

  it("explains that a running one-shot child is not an intercom session", async () => {
    const f = fixture();
    f.db.prepare("INSERT INTO runs(id,session_id,agent,name,status) VALUES ('child','parent','worker','active-task','running')").run();
    const result = await makeMessageHandler()({ to: "active-task", message: "Correction" }, {
      ...f, pi: broker({ delivered: true }), sessionId: "parent",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/headless|one-shot/i);
    expect(result.details.queued).toBe(false);
    expect(f.globalDb.prepare("SELECT COUNT(*) n FROM message_mirror").get()).toEqual({ n: 0 });
  });
});
