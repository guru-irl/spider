// Derived from rereview-t5/rr-probes.test.ts, with binding round-2 expectations.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CounterPoller } from "../counter.js";
import { openUsageLedger, type UsageLedger } from "../ledger.js";
import { acquireUsageLease, inspectUsageLease } from "../lease.js";

const root = join(process.env.SPIDER_GLOBAL_ROOT!, "counter-round2");
mkdirSync(root, { recursive: true });
let seq = 0;
const valid = { quota_snapshots: { premium_interactions: { credits_used: 7, token_based_billing: true } } };
const ok = async () => new Response(JSON.stringify(valid), { status: 200 });
const cleanup: (() => unknown)[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); });
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); vi.useRealTimers(); });
function setup(fetch: typeof globalThis.fetch = ok as typeof globalThis.fetch, ledger?: UsageLedger) {
  const dir = join(root, String(++seq)); mkdirSync(dir);
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ "github-copilot": { type: "oauth", refresh: "synthetic-refresh", access: "x", expires: 0 } }));
  const file = join(dir, "usage.db");
  const l = ledger ?? openUsageLedger(file);
  if (!ledger) cleanup.push(() => l.close());
  const poller = new CounterPoller({ authPath, ledger: l, isChild: false, enabled: true, now: () => Date.now(), fetch });
  cleanup.push(() => poller.stop());
  return { poller, ledger: l, file };
}
const settle = () => vi.advanceTimersByTimeAsync(0);
function block(file: string) {
  const db = new Database(file); db.exec("BEGIN IMMEDIATE");
  let closed = false;
  const release = () => { if (!closed) { db.exec("ROLLBACK"); db.close(); closed = true; } };
  cleanup.push(release); return release;
}

it("I1 renews at TTL/3 and tolerates one missed renewal without lease churn (P1)", async () => {
  const { poller, ledger, file } = setup(); poller.start(); await settle();
  const owner = inspectUsageLease(ledger, "counter", 1000).owner;
  await vi.advanceTimersByTimeAsync(40000);
  expect(inspectUsageLease(ledger, "counter", Date.now()).expiresAt).toBe(161000);
  const release = block(file);
  await vi.advanceTimersByTimeAsync(43500); release();
  await vi.advanceTimersByTimeAsync(40000);
  expect(inspectUsageLease(ledger, "counter", Date.now()).owner).toBe(owner);
  expect(poller.state()).toMatchObject({ role: "owner", availability: "available", errorCode: null, latest: { creditsUsed: 7 } });
});
it("I1 retries a BUSY storm within the same renewal tick and clears the transient code (P1)", async () => {
  const { poller, ledger, file } = setup(); poller.start(); await settle();
  const release = block(file);
  setTimeout(release, 40700);
  await vi.advanceTimersByTimeAsync(42000);
  expect(inspectUsageLease(ledger, "counter", Date.now()).expiresAt).toBeGreaterThan(160000);
  expect(poller.state()).toMatchObject({ role: "owner", availability: "available", errorCode: null });
});
it("I1 waking past TTL without a successor silently reacquires as the same owner (P2)", async () => {
  const { poller, ledger } = setup(); poller.start(); await settle();
  const owner = inspectUsageLease(ledger, "counter", 1000).owner;
  vi.setSystemTime(201000); await vi.advanceTimersByTimeAsync(40000);
  expect(inspectUsageLease(ledger, "counter", Date.now()).owner).toBe(owner);
  expect(poller.state()).toMatchObject({ role: "owner", availability: "available", errorCode: null, latest: { creditsUsed: 7 } });
});
it("I1 waking past TTL with a successor becomes a healthy follower without taking over", async () => {
  const { poller, ledger } = setup(); poller.start(); await settle();
  vi.setSystemTime(201000);
  const successor = acquireUsageLease(ledger, "counter", "successor", Date.now(), 120000)!;
  await vi.advanceTimersByTimeAsync(40000);
  expect(successor.isCurrent(Date.now())).toBe(true);
  expect(poller.state()).toMatchObject({ role: "follower", availability: "available", errorCode: null, latest: { creditsUsed: 7 } });
});
it.each([["bad", "schedule-corrupt"], [31536001000, "clock-jump"]])("M2 repair %s is a timestamped notice, not a poll failure (P3)", async (due, code) => {
  const { poller, ledger, file } = setup(); poller.start(); await settle();
  const db = new Database(file); db.prepare("UPDATE leases SET next_due_at=?").run(due); db.close();
  await vi.advanceTimersByTimeAsync(40000);
  expect(poller.state()).toMatchObject({ availability: "available", errorCode: null, notice: { code, at: 41000 } });
  const follower = setup(ok as typeof fetch, ledger); follower.poller.start(); await settle();
  expect(follower.poller.state()).toMatchObject({ availability: "available", errorCode: null, notice: { code, at: 41000 } });
  await poller.stop(); follower.poller.setEnabled(false); follower.poller.setEnabled(true); await settle();
  expect(follower.poller.state()).toMatchObject({ role: "owner", availability: "available", errorCode: null, notice: { code, at: 41000 } });
});
it("M1 follower state and all read-only lease paths read through an ingest writer without waiting (P5/P10)", async () => {
  const a = setup(); a.poller.start(); await settle();
  const b = setup(ok as typeof fetch, a.ledger); b.poller.start(); await settle();
  const lease = acquireUsageLease(a.ledger, "ingest", "reader", 1000, 120000)!;
  const release = block(a.file);
  const start = performance.now();
  try {
    expect(lease.isCurrent(1000)).toBe(true); expect(lease.nextPollAt()).toBeNull();
    expect(b.poller.state()).toMatchObject({ role: "follower", availability: "available", errorCode: null, latest: { creditsUsed: 7 } });
    // The writer stays locked until finally: successful reads prove they do
    // not wait for it. Keep only a 10x disaster ceiling for shared CI load.
    expect(performance.now() - start).toBeLessThan(1500);
  } finally { release(); }
});
it("M5 retries a BUSY save on the next renewal tick from memory without another fetch (P6)", async () => {
  let release: (() => void) | undefined, calls = 0;
  const { poller, ledger, file } = setup((async () => {
    calls++;
    if (calls === 2) return { ok: true, status: 200, json: async () => { release = block(file); return valid; } } as Response;
    return ok();
  }) as typeof fetch);
  poller.start(); await settle(); await vi.advanceTimersByTimeAsync(600000); release?.();
  expect(poller.state()).toMatchObject({ availability: "unavailable", errorCode: "save-failed", notice: { code: "lease-busy" } });
  expect(ledger.latestCounter()?.ts).toBe(1000);
  await vi.advanceTimersByTimeAsync(40000);
  expect(ledger.latestCounter()?.ts).toBe(601000);
  expect(calls).toBe(2);
  expect(poller.state()).toMatchObject({ role: "owner", availability: "available", errorCode: null, lastSuccessAt: 601000 });
  await vi.advanceTimersByTimeAsync(559999); expect(calls).toBe(2);
});
it("M5 follower snapshot becomes stale only after two poll intervals plus two minutes", async () => {
  const { poller, ledger } = setup();
  ledger.insertCounter({ ts: 1000, creditsUsed: 7, raw: {} });
  acquireUsageLease(ledger, "counter", "other", 1000, 120000);
  poller.start(); await settle();
  vi.setSystemTime(1321000);
  expect(poller.state()).toMatchObject({ availability: "available", snapshotAgeMs: 1320000 });
  vi.setSystemTime(1321001);
  expect(poller.state()).toMatchObject({ availability: "stale", errorCode: null, latest: { creditsUsed: 7 }, snapshotAgeMs: 1320001 });
});
it("Nit 1 a fenced old owner immediately stops reporting owner (P7)", async () => {
  let resolve!: (r: Response) => void;
  const { poller, ledger } = setup((() => new Promise<Response>(r => { resolve = r; })) as typeof fetch);
  poller.start(); await settle();
  acquireUsageLease(ledger, "counter", "successor", Date.now() + 120001, 120000);
  resolve(await ok()); await settle();
  expect(poller.state().role).toBe("follower");
  expect(ledger.latestCounter()).toBeUndefined();
});
it("M4 latestCounter selects the last insertion after a backward clock jump (P9)", async () => {
  const { ledger } = setup();
  ledger.insertCounter({ ts: 86401000, creditsUsed: 5, raw: {} });
  ledger.insertCounter({ ts: 1000, creditsUsed: 7, raw: {} });
  expect(ledger.latestCounter()).toMatchObject({ ts: 1000, creditsUsed: 7 });
});
it("M4 future snapshots keep their negative age and are stale with a clock-skew notice (P9)", async () => {
  const { poller, ledger } = setup();
  ledger.insertCounter({ ts: 86401000, creditsUsed: 5, raw: {} });
  acquireUsageLease(ledger, "counter", "other", 1000, 120000);
  poller.start(); await settle();
  expect(poller.state()).toMatchObject({ availability: "stale", errorCode: null, snapshotAgeMs: -86400000, notice: { code: "clock-skew", at: 1000 } });
});
