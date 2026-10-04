// Counter lease contention, recovery, shared cadence and shutdown regressions.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CounterPoller } from "../counter.js";
import { openUsageLedger, type UsageLedger } from "../ledger.js";
import { acquireUsageLease, inspectUsageLease, UsageLeaseError } from "../lease.js";

const root = join(process.env.SPIDER_GLOBAL_ROOT!, "counter-round3");
mkdirSync(root, { recursive: true });
let seq = 0;
const valid = { quota_snapshots: { premium_interactions: { credits_used: 7, token_based_billing: true } } };
const ok = async () => new Response(JSON.stringify(valid), { status: 200 });
const cleanup: (() => unknown)[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(1000);
});
afterEach(async () => { vi.restoreAllMocks(); for (const f of cleanup.splice(0).reverse()) await f(); vi.useRealTimers(); });
function setup(fetch: typeof globalThis.fetch = ok as typeof globalThis.fetch, ledger?: UsageLedger, file0?: string) {
  const dir = join(root, String(++seq)); mkdirSync(dir);
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ "github-copilot": { type: "oauth", refresh: "synthetic-refresh", access: "x", expires: 0 } }));
  const file = file0 ?? join(dir, "usage.db");
  const l = ledger ?? openUsageLedger(file);
  if (!ledger) cleanup.push(() => l.close());
  const poller = new CounterPoller({ authPath, ledger: l, isChild: false, enabled: true, now: () => Date.now(), fetch });
  cleanup.push(() => poller.stop());
  return { poller, ledger: l, file };
}
const settle = () => vi.advanceTimersByTimeAsync(0);
const row = (file: string) => { const d = new Database(file, { readonly: true }); try { return d.prepare("SELECT owner, token, acquired_at, expires_at, next_due_at, last_error_code, notice_code, notice_at FROM leases WHERE name='counter'").get() as Record<string, unknown>; } finally { d.close(); } };
function block(file: string) {
  const db = new Database(file); db.exec("BEGIN IMMEDIATE");
  let closed = false;
  const release = () => { if (!closed) { db.exec("ROLLBACK"); db.close(); closed = true; } };
  cleanup.push(release); return release;
}

it("M1 BUSY beyond the budget retains valid owner availability and retries soon", async () => {
  const { poller, file } = setup(); poller.start(); await settle();
  const before = row(file);
  const release = block(file);
  await vi.advanceTimersByTimeAsync(45000);
  expect(poller.state()).toMatchObject({ role: "owner", availability: "available", errorCode: null, notice: { code: "lease-busy" } });
  release();
  await vi.advanceTimersByTimeAsync(5000);
  expect(row(file).expires_at).toBeGreaterThan(before.expires_at as number);
  expect(poller.state().notice).toBeNull();
});
it("BUSY lease writes use short SQLite waits and schedule asynchronous retry sleeps", async () => {
  const { poller, file } = setup(); poller.start(); await settle();
  const db = new Database(file);
  db.exec("BEGIN IMMEDIATE");
  cleanup.push(() => { db.exec("ROLLBACK"); db.close(); });
  const pragma = vi.spyOn(Database.prototype, "pragma");
  const timer = vi.spyOn(globalThis, "setTimeout");
  await vi.advanceTimersByTimeAsync(40000);
  expect(pragma.mock.calls.some(([sql]) => sql === "busy_timeout = 25")).toBe(true);
  expect(timer.mock.calls.some(([, ms]) => typeof ms === "number" && ms >= 75 && ms < 150)).toBe(true);
  expect(vi.getTimerCount()).toBe(1);
  vi.restoreAllMocks();
});
it.each(["http-401", "http-500", "timeout", "payload-limit", "missing-auth"])("M3 reacquire and handover retain real poll error %s", async code => {
  const { ledger } = setup();
  const a = acquireUsageLease(ledger, "counter", "a", 1000, 120000)!;
  a.recordError(1000, code);
  const again = acquireUsageLease(ledger, "counter", "a", 121000, 120000)!;
  expect(inspectUsageLease(ledger, "counter", 121000).lastErrorCode).toBe(code);
  again.release();
  const b = acquireUsageLease(ledger, "counter", "b", 121000, 120000)!;
  expect(inspectUsageLease(ledger, "counter", 121000).lastErrorCode).toBe(code);
  b.saveIfCurrent(121000, { ts: 121000, creditsUsed: 7, raw: {} });
  expect(inspectUsageLease(ledger, "counter", 121000).lastErrorCode).toBeNull();
});
it.each(["lease-busy", "lease-lost"])("M3 acquisition clears only transient %s", code => {
  const { ledger } = setup(); const a = acquireUsageLease(ledger, "counter", "a", 1000, 120000)!;
  a.recordError(1000, code); a.release(); acquireUsageLease(ledger, "counter", "b", 1000, 120000);
  expect(inspectUsageLease(ledger, "counter", 1000).lastErrorCode).toBeNull();
});
it("M4 clamped cadence uses the later shared due/age threshold for both roles", async () => {
  let status = 200;
  const { poller, ledger, file } = setup((async () => status === 200 ? ok() : new Response("x", { status })) as typeof fetch);
  poller.start(); await settle(); await vi.advanceTimersByTimeAsync(590000);
  const db = new Database(file); db.exec("UPDATE leases SET next_due_at=31536001000"); db.close();
  await vi.advanceTimersByTimeAsync(10000);
  const follower = setup(ok as typeof fetch, ledger); follower.poller.start(); await settle();
  await vi.advanceTimersByTimeAsync(719999);
  expect(poller.state().snapshotAgeMs).toBeGreaterThan(1320000 - 2);
  expect(poller.state().availability).toBe("available");
  expect(follower.poller.state().availability).toBe("available");
  // Freeze ticks to test the exact persisted schedule boundary without another claim.
  vi.clearAllTimers(); vi.setSystemTime(1921000);
  expect(poller.state().availability).toBe("available");
  expect(follower.poller.state().availability).toBe("available");
  vi.setSystemTime(1921001);
  expect(poller.state().availability).toBe("stale");
  expect(follower.poller.state().availability).toBe("stale");
});
it("Nit duplicate reacquire does not retry acquisition twice when a successor is live", async () => {
  const { poller, ledger } = setup(); poller.start(); await settle();
  vi.setSystemTime(201000); acquireUsageLease(ledger, "counter", "successor", Date.now(), 120000);
  const acquire = vi.spyOn(ledger.leases, "acquire");
  await vi.advanceTimersByTimeAsync(40000);
  expect(poller.state().role).toBe("follower"); expect(acquire).toHaveBeenCalledTimes(1);
});
it("Nit clock-skew is persisted and cleared for owner/follower/doctor when the snapshot resolves", async () => {
  const { poller, ledger } = setup(); ledger.insertCounter({ ts: 86401000, creditsUsed: 5, raw: {} });
  acquireUsageLease(ledger, "counter", "other", 1000, 120000); poller.start(); await settle();
  expect(poller.state().notice?.code).toBe("clock-skew");
  expect(inspectUsageLease(ledger, "counter", 1000).notice?.code).toBe("clock-skew");
  ledger.insertCounter({ ts: 1000, creditsUsed: 9, raw: {} });
  expect(poller.state().notice).toBeNull(); expect(inspectUsageLease(ledger, "counter", 1000).notice).toBeNull();
});
it("Nit repair notices clear when the repaired scheduled poll is reached", async () => {
  const { poller, ledger, file } = setup(); poller.start(); await settle();
  const db = new Database(file); db.exec("UPDATE leases SET next_due_at=31536001000"); db.close();
  await vi.advanceTimersByTimeAsync(40000);
  expect(poller.state().notice?.code).toBe("clock-jump");
  await vi.advanceTimersByTimeAsync(1200000);
  expect(poller.state().notice).toBeNull(); expect(inspectUsageLease(ledger, "counter", Date.now()).notice).toBeNull();
});
it("Nit first BUSY tick serves cache and acquires soon after the storm, not after 40 seconds", async () => {
  const { poller, ledger, file } = setup(); ledger.insertCounter({ ts: 1000, creditsUsed: 7, raw: {} });
  const release = block(file); poller.start(); await settle();
  expect(poller.state().latest?.creditsUsed).toBe(7);
  await vi.advanceTimersByTimeAsync(3500); release();
  await vi.advanceTimersByTimeAsync(5000);
  expect(poller.state()).toMatchObject({ role: "owner", availability: "available", errorCode: null });
});

it("M3 poll errors survive a BUSY error write and are persisted on recovery", async () => {
  let release: (() => void) | undefined;
  const { poller, ledger, file } = setup((async () => {
    release = block(file);
    return new Response("x", { status: 401 });
  }) as typeof fetch);
  ledger.insertCounter({ ts: 1000, creditsUsed: 7, raw: {} });
  poller.start(); await settle();
  expect(poller.state()).toMatchObject({ availability: "unavailable", errorCode: "http-401" });
  release?.(); await vi.advanceTimersByTimeAsync(40000);
  expect(poller.state().errorCode).toBe("http-401");
  expect(inspectUsageLease(ledger, "counter", Date.now()).lastErrorCode).toBe("http-401");
});


it("hard age cap overrides a moving schedule for owners and followers", async () => {
  const { poller, ledger, file } = setup(); poller.start(); await settle();
  const follower = setup(ok as typeof fetch, ledger).poller; follower.start(); await settle();
  vi.clearAllTimers();
  const db = new Database(file); db.exec("UPDATE leases SET next_due_at=999999999"); db.close();
  vi.setSystemTime(1921000);
  expect(poller.state().availability).toBe("available");
  expect(follower.state().availability).toBe("available");
  vi.setSystemTime(1921001);
  expect(poller.state().availability).toBe("stale");
  expect(follower.state().availability).toBe("stale");
});

it("90 minutes of failed saves stay save-failed and become stale for both roles until a save succeeds", async () => {
  let status = 200;
  const { poller, ledger, file } = setup((async () => status === 200 ? ok() : new Response("x", { status })) as typeof fetch);
  poller.start(); await settle();
  const follower = setup(ok as typeof fetch, ledger).poller; follower.start(); await settle();
  const db = new Database(file);
  db.exec("CREATE TRIGGER fail_save BEFORE INSERT ON counter_snapshots BEGIN SELECT RAISE(FAIL, 'fixture-full'); END");
  cleanup.push(() => db.close());
  await vi.advanceTimersByTimeAsync(600000);
  expect(poller.state().errorCode).toBe("save-failed");
  expect(follower.state().errorCode).toBe("save-failed");
  await vi.advanceTimersByTimeAsync(4800000);
  expect(poller.state()).toMatchObject({ availability: "stale", errorCode: "save-failed", snapshotAgeMs: 5400000 });
  expect(follower.state()).toMatchObject({ availability: "stale", errorCode: "save-failed", snapshotAgeMs: 5400000 });
  status = 401; await vi.advanceTimersByTimeAsync(600000);
  expect(poller.state().errorCode).toBe("save-failed");
  expect(follower.state().errorCode).toBe("save-failed");
  status = 200; db.exec("DROP TRIGGER fail_save");
  await vi.advanceTimersByTimeAsync(600000);
  expect(poller.state()).toMatchObject({ availability: "available", errorCode: null, lastSuccessAt: 6601000 });
  expect(follower.state()).toMatchObject({ availability: "available", errorCode: null, lastSuccessAt: 6601000 });
});

it("spent owner BUSY budgets back off exponentially and reset after recovery", async () => {
  const { poller, ledger } = setup();
  const acquire = ledger.leases.acquire.bind(ledger.leases);
  let blocked = false;
  const attempts: number[] = [];
  vi.spyOn(ledger.leases, "acquire").mockImplementation((...args) => {
    const lease = acquire(...args);
    if (lease) {
      const renew = lease.renew.bind(lease);
      lease.renew = at => {
        attempts.push(performance.now());
        if (blocked) throw new UsageLeaseError("lease-busy");
        return renew(at);
      };
    }
    return lease;
  });
  poller.start(); await settle(); blocked = true;
  vi.spyOn(Math, "random").mockReturnValue(0);
  await vi.advanceTimersByTimeAsync(180000);
  const gaps = attempts.slice(1).map((at, i) => at - attempts[i]).filter(ms => ms >= 1000);
  expect(gaps.slice(0, 7)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 40000]);
  blocked = false; await vi.advanceTimersByTimeAsync(45000);
  expect(poller.state().notice).toBeNull();
  attempts.length = 0; blocked = true; await vi.advanceTimersByTimeAsync(45000);
  expect(attempts.slice(1).map((at, i) => at - attempts[i])).toContain(1000);
  blocked = false; vi.restoreAllMocks();
});

it("followers only attempt acquisition on normal ticks during a storm", async () => {
  const { poller, ledger } = setup(); poller.start(); await settle();
  const follower = setup(ok as typeof fetch, ledger).poller; follower.start(); await settle();
  const acquire = ledger.leases.acquire.bind(ledger.leases);
  const attempts: number[] = [];
  vi.spyOn(ledger.leases, "acquire").mockImplementation((...args) => {
    attempts.push(Date.now());
    throw new UsageLeaseError("lease-busy");
  });
  await vi.advanceTimersByTimeAsync(119999);
  expect(attempts).toEqual([41000, 81000]);
  vi.spyOn(ledger.leases, "acquire").mockImplementation(acquire);
  vi.restoreAllMocks();
});

it("a BUSY notice reconciliation does not erase valid owner availability or a real poll error", async () => {
  const { poller, ledger, file } = setup(); poller.start(); await settle();
  const db = new Database(file); db.exec("UPDATE leases SET notice_code='clock-skew', notice_at=1000"); db.close();
  const release = block(file);
  expect(poller.state()).toMatchObject({ availability: "available", errorCode: null, notice: { code: "lease-busy" } });
  release();
  const db2 = new Database(file); db2.exec("UPDATE leases SET last_error_code='http-401', notice_code='clock-skew', notice_at=1000"); db2.close();
  // Load the shared poll error before reconciliation is blocked.
  expect(poller.state().errorCode).toBe("http-401");
  const db3 = new Database(file); db3.exec("UPDATE leases SET notice_code='clock-skew', notice_at=1000"); db3.close();
  block(file);
  expect(poller.state()).toMatchObject({ availability: "unavailable", errorCode: "http-401", notice: { code: "lease-busy" } });
});

it("stop asynchronously retries release when the lock clears within its budget", async () => {
  const { poller, ledger, file } = setup(); poller.start(); await settle();
  const release = block(file);
  const stop = poller.stop();
  await vi.advanceTimersByTimeAsync(500); release();
  await vi.advanceTimersByTimeAsync(1500); await stop;
  expect(inspectUsageLease(ledger, "counter", Date.now()).owner).toBeNull();
  expect(poller.state()).toMatchObject({ availability: "disabled", errorCode: null });
  expect(vi.getTimerCount()).toBe(0);
});

it("stop bounds a persistent storm and reports release-failed while the held lease expires normally", async () => {
  const { poller, ledger, file } = setup(); poller.start(); await settle();
  const owner = inspectUsageLease(ledger, "counter", Date.now()).owner;
  const release = block(file);
  await vi.advanceTimersByTimeAsync(40000);
  expect(poller.state().notice?.code).toBe("lease-busy");
  let finished = false;
  const stop = poller.stop().then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(500);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1600); await stop;
  expect(poller.state()).toMatchObject({ availability: "disabled", errorCode: "release-failed", notice: null });
  expect(inspectUsageLease(ledger, "counter", Date.now())).toMatchObject({ owner, expiresAt: 121000 });
  expect(vi.getTimerCount()).toBe(0);
  release(); vi.setSystemTime(121000);
  expect(inspectUsageLease(ledger, "counter", Date.now()).role).toBe("expired");
  expect(acquireUsageLease(ledger, "counter", "successor", Date.now(), 120000)).toBeDefined();
});


it("stop clears the poll deadline as soon as abort settles while release is still retrying", async () => {
  const { poller, file } = setup((() => new Promise<Response>(() => {})) as typeof fetch);
  poller.start(); await settle();
  const release = block(file);
  const stop = poller.stop();
  await vi.advanceTimersByTimeAsync(500);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(700);
  expect(poller.state()).toMatchObject({ availability: "disabled", errorCode: "release-failed" });
  release(); await vi.advanceTimersByTimeAsync(900); await stop;
  expect(poller.state().errorCode).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
