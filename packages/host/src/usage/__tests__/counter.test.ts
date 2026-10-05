import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as pi from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CounterPoller, CounterPollerOptions } from "../counter.js";
import { openUsageLedger, type CounterSnapshot, type UsageLedger } from "../ledger.js";
import Database from "better-sqlite3";

vi.mock("@earendil-works/pi-coding-agent", { spy: true });

const root = join(process.env.SPIDER_GLOBAL_ROOT!, "counter");
mkdirSync(root, { recursive: true });
let seq = 0;
const pollers: CounterPoller[] = [];
const ledgers: UsageLedger[] = [];
const testFiles = new Map<UsageLedger, string>();
const realInserts = new Map<UsageLedger, UsageLedger["insertCounter"]>();
const token = "synthetic-refresh-secret";
const valid = { quota_snapshots: { premium_interactions: { credits_used: 7, token_based_billing: true } } };
const response = (body: unknown = valid) => new Response(JSON.stringify(body), { status: 200 });
const noNetwork = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  noNetwork.mockReset().mockImplementation(async () => response());
});
afterEach(async () => {
  await Promise.all(pollers.splice(0).map((p) => p.stop()));
  for (const ledger of ledgers.splice(0)) ledger.close();
  testFiles.clear(); realInserts.clear();
  vi.restoreAllMocks(); vi.useRealTimers();
});

async function setup(overrides: Partial<CounterPollerOptions> = {}) {
  const { CounterPoller } = await import("../counter.js");
  const dir = join(root, String(++seq)); mkdirSync(dir);
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ "github-copilot": { type: "oauth", refresh: token, access: "synthetic-access", expires: 0 } }));
  const saved: CounterSnapshot[] = [];
  const ledger = overrides.ledger ?? openUsageLedger(join(dir, "usage.db"));
  if (!overrides.ledger) { ledgers.push(ledger); testFiles.set(ledger, join(dir, "usage.db")); }
  const insert = realInserts.get(ledger) ?? ledger.insertCounter.bind(ledger);
  realInserts.set(ledger, insert);
  vi.spyOn(ledger, "insertCounter").mockImplementation(snapshot => { insert(snapshot); saved.push(snapshot); });
  const options: CounterPollerOptions = {
    authPath, ledger, isChild: false, enabled: true,
    now: () => Date.now(), fetch: noNetwork, ...overrides,
  };
  const poller = new CounterPoller(options); pollers.push(poller);
  return { poller, saved, options };
}
const settle = () => vi.advanceTimersByTimeAsync(0);

it("polls at startup and ten minute intervals with fixed endpoint, no redirects and OAuth headers", async () => {
  const { poller, saved } = await setup();
  expect(noNetwork).not.toHaveBeenCalled();
  poller.start(); poller.start(); await settle();
  expect(saved).toHaveLength(1);
  const [url, init] = noNetwork.mock.calls[0];
  expect(url).toBe("https://api.github.com/copilot_internal/user");
  expect(init).toMatchObject({ method: "GET", redirect: "error", headers: {
    Authorization: `Bearer ${token}`, Accept: "application/json", "Copilot-Integration-Id": "vscode-chat",
  } });
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(poller.state()).toMatchObject({ availability: "available", lastAttemptAt: 1000, lastSuccessAt: 1000, nextPollAt: 601000, errorCode: null });
  await vi.advanceTimersByTimeAsync(599999); expect(saved).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1); expect(saved).toHaveLength(2);
});

it.each([{ isChild: true }, { enabled: false }])("child and disabled modes never touch credentials, lease or network: %j", async (mode) => {
  const read = vi.mocked(pi.readStoredCredential); read.mockClear();
  const { poller, saved, options } = await setup({ ...mode, authPath: join(root, "must-not-read") });
  poller.start(); await vi.advanceTimersByTimeAsync(1200000);
  expect(read).not.toHaveBeenCalled(); expect(noNetwork).not.toHaveBeenCalled(); expect(saved).toEqual([]);
  const db = new Database(testFiles.get(options.ledger)!);
  try { expect(db.prepare("SELECT COUNT(*) AS n FROM leases").get()).toEqual({ n: 0 }); }
  finally { db.close(); }
  expect(poller.state()).toMatchObject({ availability: "disabled", lastAttemptAt: null, nextPollAt: null });
  if (mode.isChild) { poller.setEnabled(true); await settle(); expect(read).not.toHaveBeenCalled(); }
});

it("optional fields are absent but missing credits records nothing", async () => {
  const { parseCounterResponse } = await import("../counter.js");
  expect(parseCounterResponse({}, 1000)).toBeUndefined();
  expect(parseCounterResponse({ quota_snapshots: { premium_interactions: { credits_used: 3, entitlement: "bad", remaining: null } }, login: 123, quota_reset_date: {} }, 1000)).toMatchObject({ ts: 1000, creditsUsed: 3 });
  const { poller, saved } = await setup({ fetch: async () => response({}) });
  poller.start(); await settle(); expect(saved).toEqual([]);
  expect(poller.state()).toMatchObject({ availability: "unavailable", errorCode: "missing-counter" });
});

it("zero credits is valid and optional fields parse independently", async () => {
  const { parseCounterResponse } = await import("../counter.js");
  expect(parseCounterResponse({ login: "synthetic-seat", quota_reset_date: "2030-01-01", quota_snapshots: { premium_interactions: { credits_used: 0, entitlement: 20, remaining: 20 } } }, 1000)).toMatchObject({ ts: 1000, creditsUsed: 0, accountLogin: "synthetic-seat", entitlement: 20, remaining: 20, resetDate: "2030-01-01" });
});

it.each(["0", null, -1, Infinity, NaN, {}, undefined])("rejects unusable essential credits %s", async (credits) => {
  const { parseCounterResponse } = await import("../counter.js");
  expect(parseCounterResponse({ quota_snapshots: { premium_interactions: { credits_used: credits } } }, 1000)).toBeUndefined();
});

it("explicitly disabled token billing records nothing", async () => {
  const { parseCounterResponse } = await import("../counter.js");
  expect(parseCounterResponse({ quota_snapshots: { premium_interactions: { credits_used: 1, token_based_billing: false } } }, 1000)).toBeUndefined();
});

it("unknown nested fields are preserved without auth headers or credentials", async () => {
  const { parseCounterResponse } = await import("../counter.js");
  const body = { ...valid, extra: { future: [1, { mode: "synthetic" }], headers: { Authorization: "synthetic-secret" }, access_token: "synthetic-secret" }, refresh: "synthetic-secret" };
  const result = parseCounterResponse(body, 1000)!;
  expect(result.raw).toMatchObject({ extra: { future: [1, { mode: "synthetic" }] } });
  expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  expect(body.extra.headers.Authorization).toBe("synthetic-secret");
});

it.each([
  ["401", async () => new Response("sensitive-body", { status: 401 }), "http-401"],
  ["malformed JSON", async () => new Response("secret-malformed-body"), "malformed-json"],
  ["network failure", async () => { throw new Error(`Authorization Bearer ${token} sensitive-body`); }, "network"],
] as const)("%s records nothing and emits only a sanitized code", async (_name, fetcher, code) => {
  const { poller, saved } = await setup({ fetch: fetcher });
  poller.start(); await settle(); expect(saved).toEqual([]);
  expect(poller.state()).toMatchObject({ availability: "unavailable", errorCode: code, lastSuccessAt: null });
  expect(JSON.stringify(poller.state())).not.toMatch(/synthetic-refresh-secret|sensitive-body|secret-malformed-body|Authorization/);
});

it("doctor sees the owner's last polling failure without credential material", async () => {
  const { poller, options } = await setup({ fetch: async () => new Response("sensitive-body", { status: 401 }) });
  poller.start(); await settle();
  const { inspectUsageLease } = await import("../lease.js");
  expect(inspectUsageLease(options.ledger, "counter", 1000)).toMatchObject({ role: "follower", lastErrorCode: "http-401", expiresAt: 121000 });
  expect(JSON.stringify(inspectUsageLease(options.ledger, "counter", 1000))).not.toContain("sensitive-body");
});

it("missing auth records nothing without network", async () => {
  const { poller, saved } = await setup({ authPath: join(root, "missing.json") });
  poller.start(); await settle(); expect(saved).toEqual([]); expect(noNetwork).not.toHaveBeenCalled();
  expect(poller.state()).toMatchObject({ availability: "unavailable", errorCode: "missing-auth" });
});

it("timeout aborts at 15000ms even when the transport ignores abort", async () => {
  let signal: AbortSignal | undefined;
  const { poller, saved } = await setup({ fetch: async (_url, init) => { signal = init?.signal as AbortSignal; return new Promise<Response>(() => {}); } });
  poller.start(); await settle();
  await vi.advanceTimersByTimeAsync(14999); expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1); expect(signal?.aborted).toBe(true);
  expect(saved).toEqual([]); expect(poller.state()).toMatchObject({ availability: "unavailable", errorCode: "timeout" });
  await poller.stop();
});

it.each(["shutdown", "disable", "lease-loss"])("outstanding fetch cannot save after %s", async (action) => {
  let resolve!: (r: Response) => void;
  let signal: AbortSignal | undefined;
  const { poller, saved, options } = await setup({ fetch: (_url, init) => { signal = init?.signal as AbortSignal; return new Promise<Response>((r) => { resolve = r; }); } });
  poller.start(); await settle();
  if (action === "shutdown") await poller.stop();
  if (action === "disable") poller.setEnabled(false);
  if (action === "lease-loss") {
    const { acquireUsageLease } = await import("../lease.js");
    const successor = acquireUsageLease(options.ledger, "counter", "successor", Date.now() + 120001, 120000)!;
    expect(successor).toBeDefined();
    resolve(response()); await settle(); expect(saved).toEqual([]); successor.release(); return;
  }
  expect(signal?.aborted).toBe(true);
  resolve(response()); await settle(); expect(saved).toEqual([]);
});

it("uses the injected clock for lease fencing, not the wall clock", async () => {
  vi.setSystemTime(1000000);
  const { poller, saved } = await setup({ now: () => 0 });
  poller.start(); await settle();
  expect(saved).toHaveLength(1);
  expect(poller.state()).toMatchObject({ availability: "available", lastSuccessAt: 0 });
});

it("the deadline also bounds stalled body decoding", async () => {
  const { poller, saved } = await setup({ fetch: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) as Response });
  poller.start(); await settle(); await vi.advanceTimersByTimeAsync(15000);
  expect(saved).toEqual([]);
  expect(poller.state()).toMatchObject({ availability: "unavailable", errorCode: "timeout" });
});

it("body decoding cannot save after shutdown", async () => {
  let resolve!: (body: unknown) => void;
  const { poller, saved } = await setup({ fetch: async () => ({ ok: true, status: 200, json: () => new Promise((r) => { resolve = r; }) }) as Response });
  poller.start(); await settle(); await poller.stop();
  resolve(valid); await settle(); expect(saved).toEqual([]);
});

it("stale cached snapshot is explicitly unavailable after failed refresh", async () => {
  const { poller, saved } = await setup(); poller.start(); await settle();
  noNetwork.mockImplementation(async () => new Response("body", { status: 401 }));
  await vi.advanceTimersByTimeAsync(600000);
  expect(saved).toHaveLength(1);
  expect(poller.state()).toMatchObject({ availability: "unavailable", lastSuccessAt: 1000, latest: { creditsUsed: 7 }, errorCode: "http-401" });
});

it("parent handover cannot reset the ten minute limit", async () => {
  const a = await setup(); a.poller.start(); await settle(); await a.poller.stop();
  const b = await setup({ authPath: a.options.authPath, ledger: a.options.ledger });
  b.poller.start(); await settle(); expect(b.saved).toEqual([]);
  expect(b.poller.state().nextPollAt).toBe(601000);
  await vi.advanceTimersByTimeAsync(600000); expect(b.saved).toHaveLength(1);
});

it("disable then re-enable cancels work without bypassing cadence", async () => {
  const { poller, saved } = await setup(); poller.start(); await settle();
  poller.setEnabled(false); expect(poller.state().availability).toBe("disabled");
  poller.setEnabled(true); await settle(); expect(saved).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(600000); expect(saved).toHaveLength(2);
});

it("poller strips an echoed request credential before saving", async () => {
  const { poller, saved } = await setup({ fetch: async () => response({ ...valid, future: { echo: `Bearer ${token}` } }) });
  poller.start(); await settle(); expect(saved).toHaveLength(1);
  expect(JSON.stringify(saved)).not.toContain(token);
  expect(JSON.stringify(poller.state())).not.toContain(token);
});

it("a save followed by the renew tick remains available, not lease-lost (M1)", async () => {
  const { poller, options } = await setup();
  poller.start(); await settle(); await vi.advanceTimersByTimeAsync(60000);
  expect(options.ledger.latestCounter()?.creditsUsed).toBe(7);
  expect(poller.state()).toMatchObject({ availability: "available", role: "owner", errorCode: null, latest: { creditsUsed: 7 } });
});

it("save failures are sanitized and not advertised as fresh snapshots", async () => {
  const { poller, options } = await setup();
  vi.spyOn(options.ledger, "insertCounter").mockImplementation(() => { throw new Error(`secret-body ${token}`); });
  poller.start(); await settle();
  expect(poller.state()).toMatchObject({ availability: "unavailable", errorCode: "save-failed", lastSuccessAt: null, latest: null });
  expect(options.ledger.latestCounter()).toBeUndefined();
});

it("a follower serves the owner's ledger snapshot with its age, not a failure (I3)", async () => {
  const a = await setup(); a.poller.start(); await settle();
  vi.setSystemTime(2000);
  const b = await setup({ ledger: a.options.ledger }); b.poller.start(); await settle();
  expect(b.poller.state()).toMatchObject({ availability: "available", role: "follower", snapshotAgeMs: 1000, errorCode: null, latest: { creditsUsed: 7 }, lastSuccessAt: 1000 });
  expect(noNetwork).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(600000);
  expect(b.poller.state().latest?.ts).toBe(a.poller.state().latest?.ts);
});
it("a follower reads a newly committed snapshot before its next tick (I3)", async () => {
  let done!: (response: Response) => void;
  const a = await setup({ fetch: () => new Promise(resolve => { done = resolve; }) });
  a.poller.start(); await settle();
  const b = await setup({ ledger: a.options.ledger }); b.poller.start(); await settle();
  expect(b.poller.state().latest).toBeNull();
  done(response()); await settle();
  expect(b.poller.state()).toMatchObject({ availability: "available", role: "follower", latest: { creditsUsed: 7 }, snapshotAgeMs: 0 });
});
it("a follower waiting for the first snapshot is available with no error (I3)", async () => {
  const { acquireUsageLease } = await import("../lease.js"); const a = await setup();
  acquireUsageLease(a.options.ledger, "counter", "other", 1000, 120000);
  a.poller.start(); await settle();
  expect(a.poller.state()).toMatchObject({ availability: "available", role: "follower", latest: null, snapshotAgeMs: null, errorCode: null });
  expect(noNetwork).not.toHaveBeenCalled();
});
it("stop resolves promptly when a fetch ignores abort (I1)", async () => {
  const { poller } = await setup({ fetch: () => new Promise(() => {}) });
  poller.start(); await settle(); let stopped = false;
  void poller.stop().then(() => { stopped = true; }); await vi.advanceTimersByTimeAsync(2000);
  expect(stopped).toBe(true);
});
it("SQLite write-lock contention and release are bounded; stop resolves (I1/M4)", async () => {
  const { poller, options } = await setup();
  let db: Database.Database | undefined;
  // Acquire contention after fetch, before the atomic save transaction starts.
  options.fetch = async () => ({ ok: true, status: 200, json: async () => {
    // setup supplies the concrete ledger path below, without any production hook.
    db = new Database(testFiles.get(options.ledger)!); db.exec("BEGIN IMMEDIATE"); return valid;
  } }) as Response;
  poller.start(); await settle();
  try {
    expect(poller.state()).toMatchObject({ availability: "unavailable", errorCode: "save-failed", latest: null });
    let stopped = false;
    const stop = poller.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(2100); await stop;
    expect(stopped).toBe(true);
    expect(poller.state()).toMatchObject({ availability: "disabled", errorCode: "release-failed" });
  } finally { db?.exec("ROLLBACK"); db?.close(); }
  expect(options.ledger.latestCounter()).toBeUndefined();
});
it("unexpected async save adapters cannot make stop wait indefinitely (I1)", async () => {
  const { poller, options } = await setup();
  vi.spyOn(options.ledger, "insertCounter").mockImplementation((() => new Promise(() => {})) as () => void);
  poller.start(); await settle(); let stopped = false;
  expect(poller.state()).toMatchObject({ errorCode: "save-failed", latest: null });
  void poller.stop().then(() => { stopped = true; }); await vi.advanceTimersByTimeAsync(2000);
  expect(stopped).toBe(true);
});
it.each(["deep", "large"])("bounded sanitization rejects %s payload without snapshot or rejection (M3)", async kind => {
  let extra: unknown = "x";
  if (kind === "deep") for (let i = 0; i < 200000; i++) extra = [extra];
  else extra = "x".repeat(1100000);
  const { poller, options } = await setup({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ ...valid, extra }) }) as Response });
  poller.start(); await settle();
  expect(options.ledger.latestCounter()).toBeUndefined();
  expect(poller.state()).toMatchObject({ availability: "unavailable", errorCode: "payload-limit", latest: null });
  const { parseCounterResponse } = await import("../counter.js");
  expect(parseCounterResponse({ ...valid, extra }, 1000)).toBeUndefined();
  await poller.stop();
});
it("error responses cancel the body without reading or exposing it", async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const { poller } = await setup({ fetch: async () => new Response(body, { status: 401 }) });
  poller.start(); await settle();
  expect(cancelled).toBe(true); expect(poller.state().errorCode).toBe("http-401");
});
it.each([["bad", "schedule-corrupt", 601000], [31536001000, "clock-jump", 1201000]])("schedule repair is visible and eventually polls (I2/M2): %s", async (due, code, next) => {
  const { poller, options } = await setup();
  const { acquireUsageLease } = await import("../lease.js");
  const lease = acquireUsageLease(options.ledger, "counter", "old", 1000, 100)!; lease.release();
  const db = new Database(testFiles.get(options.ledger)!);
  try { db.prepare("UPDATE leases SET next_due_at=? WHERE name='counter'").run(due); } finally { db.close(); }
  poller.start(); await settle();
  expect(poller.state()).toMatchObject({ availability: "available", errorCode: null, notice: { code, at: 1000 }, nextPollAt: next });
  expect(noNetwork).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(Number(next) - 1000);
  expect(poller.state()).toMatchObject({ availability: "available", errorCode: null, latest: { creditsUsed: 7 } });
});
