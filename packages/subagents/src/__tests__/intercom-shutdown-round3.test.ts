import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { openDbAt } from "@spider/db-core";
import { testScratchPath } from "./helpers/testutil";
import { sendIntercom, SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT } from "../intercom";
import { teardownAllAsync, teardownCoordinators } from "../coordinators";

afterEach(() => vi.useRealTimers());
it.each(["global-async", "scoped-session"])("%s shutdown cancels pending intercom calls and removes their listener and deadline", async path => {
  vi.useFakeTimers(); const db = openDbAt(testScratchPath("intercom-shutdown.db"), "global");
  const events = new EventEmitter();
  const pi = { events: { on: (n: string, fn: any) => { events.on(n, fn); return () => events.off(n, fn); }, emit: (n: string, p: any) => events.emit(n, p) } };
  try {
    const pending = sendIntercom(pi, db, { fromSession: "owner", to: "peer", message: "request", timeoutMs: 60_000 });
    expect(events.listenerCount(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT)).toBe(1);
    if (path === "scoped-session") teardownCoordinators("owner");
    else await teardownAllAsync();
    expect(events.listenerCount(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(await pending).toMatchObject({ delivered: false, error: expect.stringMatching(/shutdown/i) });
  } finally { await teardownAllAsync(); db.close(); }
});

it("shutdown cancels an ephemeral intercom wait even if mailbox cleanup throws", async () => {
  vi.useFakeTimers(); const db = openDbAt(testScratchPath("intercom-cleanup-failure.db"), "global");
  const events = new EventEmitter();
  const pi = { events: { on: (n: string, fn: any) => { events.on(n, fn); return () => events.off(n, fn); }, emit: (n: string, p: any) => events.emit(n, p) } };
  const failingDb = { ...db, prepare(sql: string) { if (sql.startsWith("DELETE FROM message_mirror")) throw new Error("fixture mailbox cleanup failed"); return db.prepare(sql); } };
  try {
    const pending = sendIntercom(pi, failingDb, { fromSession: "owner", to: "child", message: "steer", ephemeral: true, timeoutMs: 60_000 });
    await expect(teardownAllAsync()).resolves.toBeUndefined();
    expect(await pending).toMatchObject({ delivered: false, error: expect.stringMatching(/shutdown/i) });
    expect(events.listenerCount(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally { db.close(); }
});
