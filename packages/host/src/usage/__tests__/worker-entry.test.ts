import { EventEmitter } from "node:events";
import type { MessagePort } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as sessionBackfill from "../session-backfill.js";
import { bootUsageWorker } from "../worker-entry.js";
import { openUsageLedger, type UsageLedger } from "../ledger.js";
import { dashboardBatch, dashboardCall } from "./fixtures/dashboard-ledger.js";
import { ingestOnce } from "../ingest.js";
import { acquireUsageLease, UsageLeaseError } from "../lease.js";
import type { UsageWorkerEvent } from "../protocol.js";
const reads = vi.hoisted(() => ({ health: 0, summaries: 0, calibration: 0, month: 0, failMonth: false, followers: [] as UsageLedger[] }));
vi.mock("../ledger.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../ledger.js")>();
  return { ...actual, openUsageLedgerReadOnly: (file: string) => {
    const store = actual.openUsageLedgerReadOnly(file);
    if (store) { reads.followers.push(store); const health = store.health.bind(store), summarize = store.summarize.bind(store);
      store.health = () => { reads.health++; return health(); };
      store.summarize = (...args) => { reads.summaries++; return summarize(...args); };
      if (store.getCalibration) { const calibrate = store.getCalibration.bind(store); store.getCalibration = mode => { reads.calibration++; return calibrate(mode); }; }
    }
    return store;
  } };
});
vi.mock("../query-redesign-shared.js", async importOriginal => {
 const actual=await importOriginal<typeof import("../query-redesign-shared.js")>();
 return {...actual,readCorrectedTotal:(...args: Parameters<typeof actual.readCorrectedTotal>)=>{
  reads.month++;if(reads.failMonth)throw new Error("fixture month failure");return actual.readCorrectedTotal(...args);
 }};
});
class Port extends EventEmitter {
  events: UsageWorkerEvent[] = [];
  closed = false;
  postMessage(e: UsageWorkerEvent) { this.events.push(e); }
  close() { this.closed = true; }
}
let root: string, ports: Port[];
const metadataBudget = 64 * 1024;
const at = Date.parse("2026-10-04T12:00:00Z");
beforeEach(() => { root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "worker-entry-")); ports = []; reads.followers = []; reads.month=0; reads.failMonth=false; vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); })); });
afterEach(async () => {
  for (const port of ports) { port.emit("message", { type: "stop" }); await vi.waitFor(() => expect(port.closed).toBe(true)); }
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true });
});
function command(child = false, poll = false) { return { type: "start" as const, owner: `${process.pid}:test`, child, poll, roots: { registryDb: join(root, "missing-registry.db"), sessionsDir: join(root, "sessions"), ledgerFile: join(root, "usage.db"), authPath: join(root, "auth.json"), leaseDir: join(root, "leases") } }; }
function port() { const p = new Port(); ports.push(p); return p; }
function snapshots(p: Port) { return p.events.filter(e => e.type === "snapshot"); }
it("child boot opens nothing and stops immediately", async () => {
  const p = port(); await bootUsageWorker(p as unknown as MessagePort, command(true));
  expect(p.events).toEqual([{ type: "stopped" }]); expect(p.closed).toBe(true);
});
it("worker publishes twenty redacted diagnostics for owners and followers", async () => {
  const c = command(), p = port();
  const errors = Array.from({ length: 21 }, (_, i) => ({ path: `/synthetic-private/source-${i}.jsonl`, code: "EACCES" }));
  await bootUsageWorker(p as unknown as MessagePort, c, { discover: async () => ({ sources: [], runs: [], errors }), now: () => at });
  await vi.waitFor(() => expect(snapshots(p).at(-1)?.backfill).toBe("complete"));
  const owner = snapshots(p).at(-1)!;
  expect(owner.sourceErrorDiagnostics?.rows).toHaveLength(20);
  expect(owner.sourceErrorDiagnostics?.truncated).toBe(true);
  expect(owner.sourceErrorDiagnostics?.rows[0]).toEqual({ sourceLabel: "source-0.jsonl", projectLabel: "Unknown project", code: "EACCES", count: 1, lastCheckedAt: at });
  expect(JSON.stringify(owner.sourceErrorDiagnostics)).not.toContain("synthetic-private");
  const follower = port();
  await bootUsageWorker(follower as unknown as MessagePort, { ...c, owner: `${process.pid}:follower` }, {
    discover: async () => { throw new Error("follower must not discover"); }, now: () => at,
  });
  await vi.waitFor(() => expect(snapshots(follower).at(-1)?.ingestRole).toBe("follower"));
  expect(snapshots(follower).at(-1)?.sourceErrorDiagnostics).toEqual(owner.sourceErrorDiagnostics);
});

it("refresh and the sixty second cycle coalesce without concurrent imports", async () => {
  vi.useFakeTimers(); const p = port(); let release!: () => void, started = 0, active = 0, peak = 0;
  const blocked = new Promise<void>(r => { release = r; });
  const ingest = async (...args: Parameters<typeof ingestOnce>) => { started++; active++; peak = Math.max(peak, active); if (started === 1) await blocked; const health = await ingestOnce(...args); active--; return health; };
  await bootUsageWorker(p as unknown as MessagePort, command(), { discover: async () => ({ sources: [], runs: [], errors: [] }), ingest, now: () => at });
  await vi.advanceTimersByTimeAsync(0); expect(started).toBe(1);
  for (let i = 0; i < 100; i++) p.emit("message", { type: "refresh" });
  await vi.advanceTimersByTimeAsync(60000); expect(started).toBe(1);
  release(); await vi.advanceTimersByTimeAsync(0);
  expect(started).toBe(2); expect(peak).toBe(1);
  p.emit("message", { type: "stop" }); await vi.advanceTimersByTimeAsync(0); expect(p.closed).toBe(true);
});
it("reconciliation stops at the counter timestamp in its UTC month and exposes the signed gap", async () => {
  const c = command(); const source = { path: join(root, "calls.jsonl"), project: null, repo: null, run: null };
  const entry = (id: string, ts: number) => ({ type: "message", id, timestamp: new Date(ts).toISOString(), message: { role: "assistant", provider: "github-copilot", model: "gpt-6.1-sol", usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 } } });
  writeFileSync(source.path, [entry("before", at - 1), entry("after", at + 1)].map(e => JSON.stringify(e)).join("\n") + "\n");
  const d = { sources: [source], runs: [], errors: [] };
  const ledger = openUsageLedger(c.roots.ledgerFile); await ingestOnce(ledger, d, at, new AbortController().signal); ledger.insertCounter({ ts: at, creditsUsed: 4, raw: {} }); ledger.close();
  const p = port(); await bootUsageWorker(p as unknown as MessagePort, c, { discover: async () => d, now: () => at + 100 });
  await vi.waitFor(() => expect(snapshots(p).at(-1)?.backfill).toBe("complete"));
  expect(snapshots(p).at(-1)?.reconciliation).toMatchObject({ windowStart: Date.parse("2026-10-01T00:00:00Z"), windowEnd: at, computedAIC: 0.2, counterAIC: 4, gap: 3.8, ratio: 0.05, estimated: true });
});
it("a lease lost during pending ingestion fences writes and switches to read-only refresh", async () => {
  vi.useFakeTimers(); const c = command(), p = port(); let clock = at, release!: () => void, finished = false;
  const source = { path: join(root, "fenced.jsonl"), project: null, repo: null, run: null };
  writeFileSync(source.path, JSON.stringify({ type: "message", id: "stale", timestamp: new Date(at).toISOString(), message: { role: "assistant", provider: "github-copilot", model: "gpt-6.1-sol", usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 } } }) + "\n");
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const discover = vi.fn(async () => ({ sources: [source], runs: [], errors: [] }));
  await bootUsageWorker(p as unknown as MessagePort, c, { now: () => clock, discover, ingest: async (...args) => { await blocked; const health = await ingestOnce(...args); finished = true; return health; } });
  await vi.advanceTimersByTimeAsync(0);
  const successor = openUsageLedger(c.roots.ledgerFile); clock += 120001;
  const lease = acquireUsageLease(successor, "ingest", `${process.pid}:successor`, () => clock, 120000)!;
  try {
    const snapshotBefore = successor.getPublishedSnapshot();
    expect(lease).toBeDefined(); release();
    await vi.waitFor(() => expect(finished).toBe(true));
    expect(successor.health().calls).toBe(0); expect(successor.getImportState(source.path)).toBeUndefined();
    expect(successor.getPublishedSnapshot()).toEqual(snapshotBefore);
    p.emit("message", { type: "refresh" }); await vi.advanceTimersByTimeAsync(0);
    expect(snapshots(p).at(-1)).toMatchObject({ backfill: "running", health: { calls: 0 } });
    expect(discover).toHaveBeenCalledTimes(1);
    p.emit("message", { type: "stop" }); await vi.advanceTimersByTimeAsync(0); expect(p.closed).toBe(true);
    expect(lease.isCurrent(() => clock)).toBe(true);
  } finally { lease?.release(); successor.close(); }
});
it("stop aborts an outstanding counter fetch releases both leases closes handles and acknowledges", async () => {
  const c = command(false, true); let signal: AbortSignal | undefined;
  writeFileSync(c.roots.authPath, JSON.stringify({ "github-copilot": { type: "oauth", refresh: "synthetic-token", access: "synthetic-access", expires: 0 } }));
  const p = port(); await bootUsageWorker(p as unknown as MessagePort, c, { discover: async () => ({ sources: [], runs: [], errors: [] }), now: () => at, fetch: (_url, init) => { signal = init?.signal ?? undefined; return new Promise((_r, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); } });
  await vi.waitFor(() => expect(signal).toBeDefined()); p.emit("message", { type: "stop" });
  await vi.waitFor(() => expect(p.closed).toBe(true)); expect(signal?.aborted).toBe(true);
  const ledger = openUsageLedger(c.roots.ledgerFile);
  try { expect(ledger.leases.inspect("ingest", at).owner).toBeNull(); expect(ledger.leases.inspect("counter", at).owner).toBeNull(); } finally { ledger.close(); }
  expect(p.events.at(-1)).toEqual({ type: "stopped", released: true });
});

it("multi-source cycles pay shared work once, publish bounded progress, and skip unchanged batches", async () => {
  const c = command(), p = port(); let clock = at;
  const sources = Array.from({ length: 40 }, (_, i) => {
    const path = join(root, `source-${i}.jsonl`);
    writeFileSync(path, JSON.stringify({ type: "session", id: `s${i}` }) + "\n");
    return { path, project: null, repo: null, run: null };
  });
  const d = { sources, runs: [], errors: [{ path: "missing", code: "missing-source" }] };
  let calls = 0, healthCalls = 0, sharedWrites = 0;
  let store: UsageLedger | undefined;
  const ingest = async (...args: Parameters<typeof ingestOnce>) => {
    calls++; clock += 1000;
    if (!store) {
      store = args[0]; const health = store.health.bind(store), apply = store.apply.bind(store);
      vi.spyOn(store, "health").mockImplementation(() => { healthCalls++; return health(); });
      vi.spyOn(store, "apply").mockImplementation(batch => { if (batch.sourceErrors.some(e => e.path === "missing")) sharedWrites++; return apply(batch); });
    }
    return ingestOnce(...args);
  };
  await bootUsageWorker(p as unknown as MessagePort, c, { discover: async () => d, ingest, now: () => clock });
  await vi.waitFor(() => expect(snapshots(p).at(-1)).toMatchObject({ backfill: "complete", metadataBackfill: "complete" }));
  expect(sharedWrites).toBe(1); expect(healthCalls).toBeLessThanOrEqual(2);
  const progress = snapshots(p).filter(s => s.backfill === "running" && (s as any).progress?.sourcesCompleted > 0);
  expect(progress.length).toBeGreaterThan(0);
  expect((progress[0] as any).progress).toMatchObject({ sourcesTotal: 40 });
  expect((progress[0] as any).progress.sourcesCompleted).toBeLessThan(40);
  const before = calls, complete = () => snapshots(p).filter(s => s.backfill === "complete").length, completeBefore = complete();
  p.emit("message", { type: "refresh" });
  // The refresh pass must run and publish exactly once: nothing changed, metadata is complete.
  await vi.waitFor(() => expect(complete()).toBe(completeBefore + 1));
  await new Promise(resolve => setTimeout(resolve, 200)); expect(complete()).toBe(completeBefore + 1);
  expect(calls - before).toBeLessThanOrEqual(1); expect(sharedWrites).toBe(1);
});
it("multi-MiB sources do not pay fixed work once per tiny slice", async () => {
  const c = command(), p = port(), path = join(root, "many-lines.jsonl");
  const lines = Array.from({ length: 8000 }, (_, i) => JSON.stringify({ type: "message", id: `m${i}`, timestamp: new Date(at).toISOString(), message: { role: "assistant", provider: "github-copilot", model: "gpt-6.1-sol", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } }));
  writeFileSync(path, lines.join("\n") + "\n"); let calls = 0;
  await bootUsageWorker(p as unknown as MessagePort, c, { now: () => at, discover: async () => ({ sources: [{ path, project: null, repo: null, run: null }], runs: [], errors: [] }), ingest: async (...args) => { calls++; return ingestOnce(...args); } });
  await vi.waitFor(() => expect(snapshots(p).at(-1)?.backfill).toBe("complete"), { timeout: 10000 });
  expect(calls).toBeLessThanOrEqual(2); expect(snapshots(p).at(-1)?.health.calls).toBe(8000);
});
it.each(["stale", "unavailable", "disabled"])("%s counter cannot reconcile against an old stored snapshot", async mode => {
  const c = command(false, mode !== "disabled");
  const ledger = openUsageLedger(c.roots.ledgerFile);
  ledger.insertCounter({ ts: mode === "unavailable" ? at : at - 3600000, creditsUsed: 4, raw: {} });
  if (mode === "stale") { const lease = acquireUsageLease(ledger, "counter", "fixture-counter", () => at, 120000)!; lease.release(); }
  if (mode === "unavailable") {
    writeFileSync(c.roots.authPath, JSON.stringify({ "github-copilot": { type: "oauth", refresh: "synthetic-token", access: "synthetic-access", expires: 0 } }));
  }
  ledger.close(); const p = port();
  // stale is a read-only follower of a live counter owner, unavailable is an actual failed fetch.
  let counterOwner: UsageLedger | undefined;
  if (mode === "stale") { counterOwner = openUsageLedger(c.roots.ledgerFile); acquireUsageLease(counterOwner, "counter", "other", () => at, 120000); }
  try {
    await bootUsageWorker(p as unknown as MessagePort, c, { discover: async () => ({ sources: [], runs: [], errors: [] }), now: () => at, fetch: async () => { throw new Error("fixture network failure"); } });
    await vi.waitFor(() => expect(snapshots(p).at(-1)?.backfill).toBe("complete"));
    expect(snapshots(p).at(-1)?.reconciliation).toMatchObject({ counterAIC: null, gap: null, ratio: null });
    if (mode !== "disabled") expect(snapshots(p).at(-1)?.counter.availability).toBe(mode);
  } finally { counterOwner?.close(); }
});
it("idle followers do not rerun ledger health or summaries on refresh or heartbeat writes", async () => {
  const c = command(), owner = port(); let healthCalls = 0, summaries = 0;
  await bootUsageWorker(owner as unknown as MessagePort, c, { discover: async () => ({ sources: [], runs: [], errors: [] }), now: () => at, ingest: async (...args) => {
    const health = args[0].health.bind(args[0]), summary = args[0].summarize.bind(args[0]);
    vi.spyOn(args[0], "health").mockImplementation(() => { healthCalls++; return health(); });
    vi.spyOn(args[0], "summarize").mockImplementation((...args) => { summaries++; return summary(...args); });
    return ingestOnce(...args);
  } });
  await vi.waitFor(() => expect(snapshots(owner).at(-1)?.backfill).toBe("complete"));
  reads.health = 0; reads.summaries = 0;
  const follower = port();
  try {
    await bootUsageWorker(follower as unknown as MessagePort, { ...c, owner: `${process.pid}:follower` }, { now: () => at });
    await vi.waitFor(() => expect(snapshots(follower).length).toBeGreaterThan(0));
    for (let i = 0; i < 3; i++) {
      // A real lease-heartbeat write changes data_version without changing any
      // usage fact. Followers must still reuse the owner's maintained snapshot.
      const Database = (await import("better-sqlite3")).default;
      const heartbeat = new Database(c.roots.ledgerFile);
      try { heartbeat.exec("UPDATE leases SET expires_at=expires_at+1 WHERE name='ingest'"); }
      finally { heartbeat.close(); }
      const n = snapshots(follower).length; follower.emit("message", { type: "refresh" });
      await vi.waitFor(() => expect(snapshots(follower).length).toBeGreaterThan(n));
    }
    expect(reads.health).toBe(0); expect(reads.summaries).toBe(0);
  } finally { /* workers are stopped by teardown */ }
});

// Final round: real ledger commits must become visible without follower scans.
it("a follower publishes refreshed usage after the owner commits new data", async () => {
  const c = command(), owner = port(), follower = port(), path = join(root, "growing.jsonl");
  const entry = (id: string) => JSON.stringify({ type: "message", id, timestamp: new Date(at).toISOString(), message: { role: "assistant", provider: "github-copilot", model: "gpt-6.1-sol", usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 } } }) + "\n";
  writeFileSync(path, entry("one"));
  await bootUsageWorker(owner as unknown as MessagePort, c, { now: () => at, discover: async () => ({ sources: [{ path, project: null, repo: null, run: null }], runs: [], errors: [] }) });
  await vi.waitFor(() => expect(snapshots(owner).at(-1)?.backfill).toBe("complete"));
  await bootUsageWorker(follower as unknown as MessagePort, { ...c, owner: `${process.pid}:follower` }, { now: () => at });
  await vi.waitFor(() => expect(snapshots(follower).at(-1)?.health.calls).toBe(1));
  appendFileSync(path, entry("two")); owner.emit("message", { type: "refresh" });
  await vi.waitFor(() => expect(snapshots(owner).at(-1)?.health.calls).toBe(2));
  const before = snapshots(follower).length; follower.emit("message", { type: "refresh" });
  await vi.waitFor(() => expect(snapshots(follower).length).toBeGreaterThan(before));
  expect(snapshots(follower).at(-1)?.health.calls).toBe(2);
});
it("the first refresh after a follower connection reopens publishes the new snapshot immediately", async () => {
  const c = command(), owner = port(), follower = port();
  await bootUsageWorker(owner as unknown as MessagePort, c, { now: () => at, discover: async () => ({ sources: [], runs: [], errors: [] }) });
  await vi.waitFor(() => expect(snapshots(owner).at(-1)?.backfill).toBe("complete"));
  await bootUsageWorker(follower as unknown as MessagePort, { ...c, owner: `${process.pid}:follower` }, { now: () => at });
  await vi.waitFor(() => expect(snapshots(follower).at(-1)?.health.calls).toBe(0));
  const connection = reads.followers.at(-1)!, initialVersion = connection.dataVersion();
  const writer = openUsageLedger(c.roots.ledgerFile);
  try {
    const snapshot = writer.getPublishedSnapshot()!;
    writer.apply({ calls: [], runs: [], states: [], resetSources: [], sourceErrors: [], detailedRunIds: [], restoreAggregateRunIds: [], at,
      publishedSnapshot: { ...snapshot, health: { ...snapshot.health, calls: 7 } } });
  } finally { writer.close(); }
  // Emulate ownership changing between inspect and open. Only that race is
  // injected: the connection, commit, snapshot and data_version are real SQLite.
  const inspection = connection.leases.inspect("ingest", at, `${process.pid}:follower`);
  vi.spyOn(connection.leases, "inspect").mockReturnValueOnce({ ...inspection, role: "free" });
  const before = snapshots(follower).length; follower.emit("message", { type: "refresh" });
  await vi.waitFor(() => expect(snapshots(follower).length).toBeGreaterThan(before));
  expect(reads.followers.at(-1)).not.toBe(connection);
  expect(reads.followers.at(-1)!.dataVersion()).toBe(initialVersion);
  expect(snapshots(follower).at(-1)?.health.calls).toBe(7);
});
it("worker reparses an unchanged EOF source when its persisted context is missing", async () => {
  const c = command(), p = port(), path = join(root, "missing-context.jsonl");
  writeFileSync(path, JSON.stringify({ type: "session", id: "restore-me" }) + "\n");
  const d = { sources: [{ path, project: null, repo: null, run: null }], runs: [], errors: [] };
  const ledger = openUsageLedger(c.roots.ledgerFile);
  try { await ingestOnce(ledger, d, at, new AbortController().signal); expect(ledger.getImportState(path)?.offset).toBeGreaterThan(0); }
  finally { ledger.close(); }
  const Database = (await import("better-sqlite3")).default, db = new Database(c.roots.ledgerFile);
  try { db.prepare("DELETE FROM source_context WHERE path=?").run(path); } finally { db.close(); }
  await bootUsageWorker(p as unknown as MessagePort, c, { now: () => at, discover: async () => d });
  await vi.waitFor(() => expect(snapshots(p).at(-1)?.backfill).toBe("complete"));
  const check = openUsageLedger(c.roots.ledgerFile);
  try { expect(check.getSourceHeaders()).toEqual([{ path, header: expect.objectContaining({ id: "restore-me" }) }]); }
  finally { check.close(); }
});
it.each(["fresh", "stale"])("disabled polling gives owner and follower the same %s reconciliation", async freshness => {
  const c = command(), owner = port(), follower = port(), ledger = openUsageLedger(c.roots.ledgerFile);
  ledger.insertCounter({ ts: freshness === "fresh" ? at : at - 3600000, creditsUsed: 4, raw: {} }); ledger.close();
  await bootUsageWorker(owner as unknown as MessagePort, c, { now: () => at, discover: async () => ({ sources: [], runs: [], errors: [] }) });
  await vi.waitFor(() => expect(snapshots(owner).at(-1)?.backfill).toBe("complete"));
  await bootUsageWorker(follower as unknown as MessagePort, { ...c, owner: `${process.pid}:follower` }, { now: () => at });
  await vi.waitFor(() => expect(snapshots(follower).length).toBeGreaterThan(0));
  expect(snapshots(owner).at(-1)?.reconciliation.counterAIC).toBe(freshness === "fresh" ? 4 : null);
  expect(snapshots(follower).at(-1)?.reconciliation).toEqual(snapshots(owner).at(-1)?.reconciliation);
});

it.each(["lost", "busy"])("a %s heartbeat lease becomes a follower without failing the ledger", async mode => {
  vi.useFakeTimers(); const c = command(), p = port(); let clock = at;
  await bootUsageWorker(p as unknown as MessagePort, c, { now: () => clock, discover: async () => ({ sources: [], runs: [], errors: [] }) });
  await vi.advanceTimersByTimeAsync(0);
  expect(snapshots(p).at(-1)?.backfill).toBe("complete");
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(c.roots.ledgerFile);
  try {
    if (mode === "lost") {
      clock += 120001;
      db.prepare("UPDATE leases SET owner=?, token=?, expires_at=? WHERE name='ingest'").run("successor", "successor-token", clock + 120000);
    } else db.exec("BEGIN IMMEDIATE");
    await vi.advanceTimersByTimeAsync(40000);
    if (mode === "busy") db.exec("ROLLBACK");
    p.emit("message", { type: "refresh" }); await vi.advanceTimersByTimeAsync(0);
    expect(p.events.filter(e => e.type === "error" && !e.code.startsWith("usage-ingest-lease-"))).toEqual([]);
    expect(snapshots(p).some(s => s.backfill === "failed")).toBe(false);
    // Busy may reacquire on the next cycle, but the handover itself must be visible.
    expect(p.events).toContainEqual({ type: "error", code: `usage-ingest-lease-${mode}` });
    if (mode === "lost") expect(snapshots(p).at(-1)).toMatchObject({ ingestRole: "follower", backfill: "complete" });
    const check = openUsageLedger(c.roots.ledgerFile);
    try { expect(check.getBackfillState()).toBe("complete"); } finally { check.close(); }
    p.emit("message", { type: "stop" }); await vi.advanceTimersByTimeAsync(0);
  } finally { if (db.inTransaction) db.exec("ROLLBACK"); db.close(); }
});
it.each(["exception", "storage"])("an ingest %s failure after ledger open reports usage-ingest-failed", async mode => {
  const c = command(), p = port();
  await bootUsageWorker(p as unknown as MessagePort, c, { now: () => at, discover: async () => ({ sources: [], runs: [], errors: [] }),
    ingest: async () => { throw mode === "storage" ? new UsageLeaseError("lease-storage") : new Error("fixture ingest failure"); } });
  await vi.waitFor(() => expect(p.events.some(e => e.type === "error")).toBe(true));
  expect(p.events).toContainEqual({ type: "error", code: "usage-ingest-failed" });
  const check = openUsageLedger(c.roots.ledgerFile);
  try { expect(check.getBackfillState()).toBe("failed"); } finally { check.close(); }
});

it("calibration DTO preserves old snapshots and reloads", async () => {
  const { dashboardBatch, dashboardCall } = await import("./fixtures/dashboard-ledger.js");
  const c = command(), owner = port();
  const ledger = openUsageLedger(c.roots.ledgerFile);
  ledger.apply(dashboardBatch([dashboardCall("calibration-call", { ts: at - 86400000, price: { status: "priced", aic: 1000, components: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }, rateVersion: "fixture", tier: "fixture", confidence: "estimated" } })]));
  ledger.insertCounter({ ts: at - 86400000, creditsUsed: 0, raw: {} }); ledger.insertCounter({ ts: at, creditsUsed: 560, raw: {} });
  ledger.close();
  const Database = (await import("better-sqlite3")).default, check = new Database(c.roots.ledgerFile);
  const revision = () => check.prepare("SELECT value FROM ledger_metadata WHERE key='call-selection-revision'").get();
  const before = revision();
  try {
    await bootUsageWorker(owner as unknown as MessagePort, { ...c, calibration: "auto" }, { now: () => at, discover: async () => ({ sources: [], runs: [], errors: [] }) });
    await vi.waitFor(() => expect(snapshots(owner).at(-1)?.backfill).toBe("complete"));
    expect(snapshots(owner).at(-1)?.calibration).toMatchObject({ status: "calibrated", factor: 0.56 });
    expect(revision()).toEqual(before);
    reads.calibration = 0; const follower = port();
    await bootUsageWorker(follower as unknown as MessagePort, { ...c, owner: `${process.pid}:calibration-follower`, calibration: "auto" }, { now: () => at });
    await vi.waitFor(() => expect(snapshots(follower).length).toBeGreaterThan(0));
    expect(snapshots(follower).at(-1)?.calibration).toEqual(snapshots(owner).at(-1)?.calibration);
    expect(reads.calibration).toBe(0);
    const offFollower = port();
    await bootUsageWorker(offFollower as unknown as MessagePort, { ...c, owner: `${process.pid}:off-follower`, calibration: "off" }, { now: () => at });
    await vi.waitFor(() => expect(snapshots(offFollower).length).toBeGreaterThan(0));
    expect(snapshots(offFollower).at(-1)?.calibration).toMatchObject({ status: "off", factor: null });
    expect(snapshots(owner).at(-1)?.calibration?.status).toBe("calibrated");
    owner.emit("message", { type: "configure", poll: false, calibration: "off" });
    await vi.waitFor(() => expect(snapshots(owner).at(-1)?.calibration?.status).toBe("off"));
    expect(snapshots(owner).at(-1)?.health.calls).toBe(1); expect(snapshots(owner).at(-1)?.counter.availability).toBe("disabled");
    owner.emit("message", { type: "configure", poll: false, calibration: "auto" });
    await vi.waitFor(() => expect(snapshots(owner).at(-1)?.calibration?.status).toBe("calibrated"));
    expect(revision()).toEqual(before);
  } finally { check.close(); }
});

it("dashboard standby and handback retain calibration DTOs without follower scans", async () => {
  vi.useFakeTimers();
  const { dashboardBatch, dashboardCall } = await import("./fixtures/dashboard-ledger.js");
  const c = command(), server = port(), pi = port();
  let clock = at;
  const ledger = openUsageLedger(c.roots.ledgerFile);
  ledger.apply(dashboardBatch([dashboardCall("server-calibration", { ts: at - 86400000,
    price: { status: "priced", aic: 1000, components: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }, rateVersion: "fixture", tier: "fixture", confidence: "estimated" } })]));
  ledger.insertCounter({ ts: at - 86400000, creditsUsed: 0, raw: {} });
  ledger.insertCounter({ ts: at, creditsUsed: 560, raw: {} }); ledger.close();
  const discover = async () => ({ sources: [], runs: [], errors: [] });
  await bootUsageWorker(server as unknown as MessagePort, { ...c, dashboardMode: true, calibration: "auto" }, { now: () => clock, discover });
  await vi.advanceTimersByTimeAsync(0);
  expect(server.events.at(-1)).toEqual({ type: "standby" });
  expect(snapshots(server).at(-1)?.calibration).toMatchObject({ status: "calibrated", factor: 0.56 });
  await bootUsageWorker(pi as unknown as MessagePort, { ...c, owner: `${process.pid}:calibration-pi` }, { now: () => clock, discover });
  await vi.advanceTimersByTimeAsync(0);
  expect(snapshots(pi).at(-1)?.calibration).toMatchObject({ status: "calibrated", factor: 0.56 });
  reads.calibration = reads.health = reads.summaries = 0;
  server.emit("message", { type: "configure", poll: true, calibration: "off" });
  clock += 10000; await vi.advanceTimersByTimeAsync(10000);
  expect(snapshots(server).at(-1)).toMatchObject({ ingestRole: "follower", calibration: { status: "off", factor: null }, health: { calls: 1 }, counter: { availability: "disabled" } });
  server.emit("message", { type: "configure", poll: true, calibration: "auto" }); await vi.advanceTimersByTimeAsync(0);
  expect(snapshots(server).at(-1)?.calibration).toMatchObject({ status: "calibrated", factor: 0.56 });
  expect(reads.calibration).toBe(0); expect(reads.health).toBe(0); expect(reads.summaries).toBe(0);
  const writer = openUsageLedger(c.roots.ledgerFile);
  try {
    const published = writer.getPublishedSnapshot()!;
    const { calibration: _oldDto, ...old } = published;
    writer.apply({ calls: [], runs: [], states: [], resetSources: [], sourceErrors: [], detailedRunIds: [], restoreAggregateRunIds: [], at, publishedSnapshot: old });
  } finally { writer.close(); }
  server.emit("message", { type: "refresh" }); await vi.advanceTimersByTimeAsync(0);
  expect(snapshots(server).at(-1)?.calibration).toMatchObject({ status: "uncalibrated", factor: null });
  for (const p of [pi, server]) p.emit("message", { type: "stop" }); await vi.advanceTimersByTimeAsync(0);
});


it("owner publishes corrected billing-month fallback and follower reuses it",async()=>{
 const c=command(),ledger=openUsageLedger(c.roots.ledgerFile),start=Date.parse("2026-10-01"),day=86400000;
 const priced=(id:string,ts:number)=>dashboardCall(id,{ts,price:{status:"priced",aic:600,components:{input:600,cacheRead:0,cacheWrite:0,output:0},rateVersion:"synthetic",tier:"base",confidence:"estimated"}});
 ledger.apply(dashboardBatch([priced("fit",start+1.5*day),priced("later",start+3.25*day)]));
 ledger.insertCounter({ts:start+day,creditsUsed:0,accountLogin:"synthetic",resetDate:"2026-11-01",raw:{}});
 ledger.insertCounter({ts:start+2*day,creditsUsed:300,accountLogin:"synthetic",resetDate:"2026-11-01",raw:{}});ledger.close();
 const owner=port();await bootUsageWorker(owner as unknown as MessagePort,c,{now:()=>at,discover:async()=>({sources:[],runs:[],errors:[]})});
 await vi.waitFor(()=>expect(snapshots(owner).at(-1)?.backfill).toBe("complete"));
 expect(snapshots(owner).at(-1)).toMatchObject({monthUsed:600,monthPeriod:{start,end:Date.parse("2026-11-01")}});
 const follower=port();await bootUsageWorker(follower as unknown as MessagePort,{...c,owner:`${process.pid}:follower`},{now:()=>at,discover:async()=>{throw new Error("follower scan forbidden");}});
 await vi.waitFor(()=>expect(snapshots(follower).at(-1)?.ingestRole).toBe("follower"));
 expect(snapshots(follower).at(-1)?.monthUsed).toBe(600);
});

it.each([false, true])("collector identity publishes with the fenced snapshot, dashboard=%s", async dashboardMode => {
  const c = { ...command(), sessionId: "fixture-session", dashboardMode }; const p = port();
  await bootUsageWorker(p as unknown as MessagePort, c, { now: () => at, discover: async () => ({ sources: [], runs: [], errors: [] }) });
  await vi.waitFor(() => expect(snapshots(p).at(-1)?.backfill).toBe("complete"));
  const collector = { kind: dashboardMode ? "dashboard" : "pi", sessionId: dashboardMode ? null : "fixture-session", owner: c.owner };
  expect(snapshots(p).at(-1)?.collector).toEqual(collector);
  const reader = openUsageLedger(c.roots.ledgerFile); try { expect(reader.getPublishedSnapshot()?.collector).toEqual(collector); } finally { reader.close(); }
});

it("normal worker ingestion precedes bounded historical metadata in every pass", async () => {
  const c = { ...command(), metadataBackfillBytesPerPass: metadataBudget }, p = port(); let clock = at;
  const historical = { path: join(root, "historical.jsonl"), project: null, repo: null, run: null };
  const live = { path: join(root, "live.jsonl"), project: null, repo: null, run: null };
  const header = { type: "session", id: "fixture-live", timestamp: new Date(at).toISOString() };
  const call = (id: string) => ({ type: "message", id, timestamp: new Date(clock).toISOString(), message: { role: "assistant", provider: "github-copilot", model: "gpt-6.1-sol", usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } } });
  writeFileSync(historical.path, JSON.stringify({ ...header, id: "fixture-history" }) + "\n" + JSON.stringify({ type: "message", message: { role: "toolResult", content: "x".repeat(metadataBudget * 3 + metadataBudget / 4) } }) + "\n");
  writeFileSync(live.path, JSON.stringify(header) + "\n" + JSON.stringify(call("one")) + "\n");
  await bootUsageWorker(p as unknown as MessagePort, c, { now: () => clock, discover: async () => ({ sources: [historical, live], runs: [], errors: [] }) });
  // Each pass publishes after ingestion (metadata still pending on the first pass) and again after its bounded
  // metadata step, so wait for the end-of-pass snapshot rather than the first one that counts the call.
  await vi.waitFor(() => expect(snapshots(p).at(-1)).toMatchObject({ backfill: "complete", metadataBackfill: "running", health: { calls: 1 } }), { timeout: 5000 });
  const firstIngested = snapshots(p).findIndex(s => s.health.calls === 1), firstRunning = snapshots(p).findIndex(s => s.metadataBackfill === "running");
  expect(firstIngested).toBeGreaterThanOrEqual(0);
  expect(firstIngested).toBeLessThanOrEqual(firstRunning);
  clock += 1000; appendFileSync(live.path, JSON.stringify(call("two")) + "\n"); p.emit("message", { type: "refresh" });
  await vi.waitFor(() => expect(snapshots(p).at(-1)?.health.calls).toBe(2), { timeout: 5000 });
  expect(snapshots(p).at(-1)).toMatchObject({ backfill: "complete", metadataBackfill: "running", health: { lastIngestAt: clock } });
});

it("torn tails finish call and metadata backfill independently",async()=>{
 const c=command(),p=port(),path=join(root,"torn.jsonl");
 writeFileSync(path,JSON.stringify({type:"session",id:"torn"})+"\n"+'{"type":"session_info","name":"torn');
 await bootUsageWorker(p as unknown as MessagePort,c,{now:()=>at,discover:async()=>({sources:[{path,project:null,repo:null,run:null}],runs:[],errors:[]})});
 await vi.waitFor(()=>expect(snapshots(p).at(-1)).toMatchObject({backfill:"complete",metadataBackfill:"complete"}));
});
it("month totals recompute for committed calls and period changes, not idle metadata",async()=>{
 const c=command(),p=port(),path=join(root,"month-calls.jsonl");let clock=at;
 const entry=(id:string)=>JSON.stringify({type:"message",id,timestamp:new Date(clock-1).toISOString(),message:{role:"assistant",provider:"github-copilot",model:"gpt-6.1-sol",usage:{input:1000,output:0,cacheRead:0,cacheWrite:0}}})+"\n";
 writeFileSync(path,entry("one"));
 await bootUsageWorker(p as unknown as MessagePort,c,{now:()=>clock,discover:async()=>({sources:[{path,project:null,repo:null,run:null}],runs:[],errors:[]})});
 await vi.waitFor(()=>expect(snapshots(p).at(-1)?.backfill).toBe("complete"));
 expect(snapshots(p).at(-1)?.monthUsed).toBeCloseTo(0.2);const initial=reads.month;
 appendFileSync(path,JSON.stringify({type:"session_info",name:"New metadata"})+"\n");
 let before=snapshots(p).length;p.emit("message",{type:"refresh"});await vi.waitFor(()=>expect(snapshots(p).length).toBeGreaterThan(before));
 expect(reads.month).toBe(initial);
 appendFileSync(path,entry("two"));before=snapshots(p).length;p.emit("message",{type:"refresh"});await vi.waitFor(()=>expect(snapshots(p).at(-1)?.health.calls).toBe(2));
 expect(reads.month).toBe(initial+1);expect(snapshots(p).at(-1)?.monthUsed).toBeCloseTo(0.4);
 clock=Date.parse("2026-11-02");before=snapshots(p).length;p.emit("message",{type:"refresh"});await vi.waitFor(()=>expect(snapshots(p).length).toBeGreaterThan(before));
 expect(reads.month).toBe(initial+2);expect(snapshots(p).at(-1)?.monthUsed).toBeNull();
});
it("a failed month aggregate omits monthUsed without failing ingest",async()=>{
 const c=command(),p=port();reads.failMonth=true;
 await bootUsageWorker(p as unknown as MessagePort,c,{now:()=>at,discover:async()=>({sources:[],runs:[],errors:[]})});
 await vi.waitFor(()=>expect(snapshots(p).at(-1)?.backfill).toBe("complete"));
 expect(reads.month).toBeGreaterThan(0);expect(snapshots(p).at(-1)?.monthUsed).toBeNull();
 expect(p.events.filter(e=>e.type==="error")).toEqual([]);
});

it("a month failure after new calls clears the previous total and preserves completed ingest",async()=>{
 const c=command(),p=port(),path=join(root,"month-failure.jsonl");
 const entry=(id:string)=>JSON.stringify({type:"message",id,timestamp:new Date(at-1).toISOString(),message:{role:"assistant",provider:"github-copilot",model:"gpt-6.1-sol",usage:{input:1000,output:0,cacheRead:0,cacheWrite:0}}})+"\n";
 writeFileSync(path,entry("one"));
 await bootUsageWorker(p as unknown as MessagePort,c,{now:()=>at,discover:async()=>({sources:[{path,project:null,repo:null,run:null}],runs:[],errors:[]})});
 await vi.waitFor(()=>expect(snapshots(p).at(-1)?.backfill).toBe("complete"));expect(snapshots(p).at(-1)?.monthUsed).toBeCloseTo(0.2);
 reads.failMonth=true;appendFileSync(path,entry("two"));p.emit("message",{type:"refresh"});
 await vi.waitFor(()=>expect(snapshots(p).at(-1)?.health.calls).toBe(2));
 expect(snapshots(p).at(-1)).toMatchObject({monthUsed:null,backfill:"complete"});expect(p.events.filter(e=>e.type==="error")).toEqual([]);
});


it("footer month recomputes when calibration mode changes without new calls", async () => {
  const c = command(), ledger = openUsageLedger(c.roots.ledgerFile);
  ledger.apply(dashboardBatch([dashboardCall("mode-fit", { ts: at - 86400000,
    price: { status: "priced", aic: 1000, components: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }, rateVersion: "fixture", tier: "base", confidence: "estimated" } })]));
  ledger.insertCounter({ ts: at - 86400000, creditsUsed: 0, raw: {} });
  ledger.insertCounter({ ts: at, creditsUsed: 500, raw: {} }); ledger.close();
  const p = port();
  await bootUsageWorker(p as unknown as MessagePort, { ...c, calibration: "auto" }, { now: () => at, discover: async () => ({ sources: [], runs: [], errors: [] }) });
  await vi.waitFor(() => expect(snapshots(p).at(-1)?.backfill).toBe("complete"));
  expect(snapshots(p).at(-1)?.monthUsed).toBe(500);
  p.emit("message", { type: "configure", poll: false, calibration: "off" });
  await vi.waitFor(() => expect(snapshots(p).at(-1)?.calibration?.status).toBe("off"));
  expect(snapshots(p).at(-1)?.monthUsed).toBe(1000);
  p.emit("message", { type: "configure", poll: false, calibration: "auto" });
  await vi.waitFor(() => expect(snapshots(p).at(-1)?.calibration?.status).toBe("calibrated"));
  expect(snapshots(p).at(-1)?.monthUsed).toBe(500);
  expect(snapshots(p).at(-1)?.health.calls).toBe(1);
});

it.each([false, true])("footer month recomputes when the latest counter changes within the same period, duplicate timestamp=%s", async duplicateTimestamp => {
  const c = command(), ledger = openUsageLedger(c.roots.ledgerFile);
  ledger.apply(dashboardBatch([dashboardCall("counter-fit", { ts: at - 3600000,
    price: { status: "priced", aic: 1000, components: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }, rateVersion: "fixture", tier: "base", confidence: "estimated" } })]));
  ledger.insertCounter({ ts: at - 2 * 86400000, creditsUsed: 0, raw: {} });
  ledger.insertCounter({ ts: at - 1, creditsUsed: 500, raw: {} });
  let clock = at;
  const p = port();
  try {
    await bootUsageWorker(p as unknown as MessagePort, c, { now: () => clock, discover: async () => ({ sources: [], runs: [], errors: [] }) });
    await vi.waitFor(() => expect(snapshots(p).at(-1)?.backfill).toBe("complete"));
    expect(snapshots(p).at(-1)?.monthUsed).toBe(500);
    clock += 60000;
    ledger.insertCounter({ ts: duplicateTimestamp ? at - 1 : clock - 1, creditsUsed: 750, raw: {} });
    const before = snapshots(p).length; p.emit("message", { type: "refresh" });
    await vi.waitFor(() => expect(snapshots(p).length).toBeGreaterThan(before));
    expect(snapshots(p).at(-1)?.monthUsed).toBe(750);
    expect(snapshots(p).at(-1)?.health.calls).toBe(1);
  } finally { ledger.close(); }
});


it("persistent non-parse metadata errors finish status progress while keeping the diagnostic", async () => {
  const c = command(), p = port(), missing = join(root, "missing-session.jsonl");
  await bootUsageWorker(p as unknown as MessagePort, c, { now: () => at,
    discover: async () => ({ sources: [{ path: missing, project: null, repo: null, run: null }], runs: [], errors: [] }) });
  await vi.waitFor(() => expect(snapshots(p).at(-1)?.backfill).toBe("complete"));
  expect(snapshots(p).at(-1)).toMatchObject({ metadataBackfill: "complete", metadataProgress: { sourcesCompleted: 1, sourcesTotal: 1 } });
  const check = openUsageLedger(c.roots.ledgerFile);
  try {
    expect(check.getSourceErrors()).toContainEqual({ path: `metadata:source:${missing}`, code: "metadata-missing-source" });
    const before = snapshots(p).length; p.emit("message", { type: "refresh" });
    await vi.waitFor(() => expect(snapshots(p).length).toBeGreaterThan(before));
    expect(snapshots(p).at(-1)).toMatchObject({ metadataBackfill: "complete", metadataProgress: { sourcesCompleted: 1, sourcesTotal: 1 } });
    expect(check.getSourceErrors()).toContainEqual({ path: `metadata:source:${missing}`, code: "metadata-missing-source" });
  } finally { check.close(); }
});

// Catches leaving incomplete metadata on the 60s cadence, including dashboard standby.
it.each([false, true])("incomplete metadata schedules short owner passes with billing each time, dashboard=%s", async dashboardMode => {
  const c = { ...command(), dashboardMode, metadataBackfillBytesPerPass: metadataBudget }, p = port(), path = join(root, "bounded-history.jsonl"), live = join(root, "bounded-live.jsonl");
  const entry = (id: string) => JSON.stringify({ type: "message", id, timestamp: new Date(at - 1).toISOString(), message: { role: "assistant", provider: "github-copilot", model: "gpt-6.1-sol", usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 } } }) + "\n";
  writeFileSync(path, JSON.stringify({ type: "session", id: "bounded-history" }) + "\n" + JSON.stringify({ type: "message", message: { role: "toolResult", content: "x".repeat(metadataBudget * 2 + metadataBudget / 4) } }) + "\n");
  writeFileSync(live, entry("first"));
  const d = { sources: [ { path, project: null, repo: null, run: null }, { path: live, project: null, repo: null, run: null } ], runs: [], errors: [] };
  const store = openUsageLedger(c.roots.ledgerFile);
  await ingestOnce(store, d, at, new AbortController().signal);
  store.apply(dashboardBatch([], { resetSessionMetadata: [{ path, sessionId: "bounded-history" }] })); store.close();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] }); let ingests = 0;
  await bootUsageWorker(p as unknown as MessagePort, c, { now: () => at, monotonicNow: () => Date.now(), discover: async () => d, ingest: async (...args) => { ingests++; return ingestOnce(...args); } });
  await vi.advanceTimersByTimeAsync(0);
  await vi.waitFor(() => expect(snapshots(p).at(-1)?.metadataBackfill).toBe("running"));
  await vi.advanceTimersByTimeAsync(0);
  const first = snapshots(p).length;
  appendFileSync(live, entry("second"));
  await vi.advanceTimersByTimeAsync(3000);
  await vi.waitFor(() => expect(snapshots(p).length).toBeGreaterThan(first));
  expect(snapshots(p).at(-1)?.health.calls).toBe(2); expect(ingests).toBe(2);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(3000);
  await vi.waitFor(() => expect(snapshots(p).at(-1)?.metadataBackfill).toBe("complete"));
  await vi.advanceTimersByTimeAsync(0);
  const complete = snapshots(p).length, imported = ingests;
  await vi.advanceTimersByTimeAsync(59000);
  expect(ingests).toBe(imported);
  await vi.advanceTimersByTimeAsync(1100);
  await vi.waitFor(() => expect(snapshots(p).length).toBeGreaterThan(complete));
  expect(ingests).toBe(imported + 1);
  p.emit("message", { type: "stop" }); await vi.advanceTimersByTimeAsync(0);
});

it("owner reprices stored calls and refreshes an already cached footer month", async () => {
  const c = command(), p = port(), store = openUsageLedger(c.roots.ledgerFile);
  store.repriceUnpriced?.(() => true); // A completed fingerprint precedes a synthetic legacy call.
  store.apply(dashboardBatch([dashboardCall("legacy-month", { ts: at - 1, provider: "github-copilot", model: "gpt-6.1-sol", usage: { input: 10000, output: 0, cacheRead: 0, cacheWrite: 0 }, price: { status: "unpriced", reason: "no-rate-at-time" } })]));
  store.close();
  await bootUsageWorker(p as unknown as MessagePort, c, { now: () => at, discover: async () => ({ sources: [], runs: [], errors: [] }) });
  await vi.waitFor(() => expect(snapshots(p).at(-1)?.backfill).toBe("complete"));
  expect(snapshots(p).at(-1)?.monthUsed).toBeNull();
  const Database = (await import("better-sqlite3")).default, db = new Database(c.roots.ledgerFile);
  try { db.prepare("UPDATE ledger_metadata SET value='previous-table' WHERE key='reprice-rate-fingerprint'").run(); } finally { db.close(); }
  p.emit("message", { type: "refresh" });
  await vi.waitFor(() => expect(snapshots(p).at(-1)?.monthUsed).toBe(2));
  expect(snapshots(p).at(-1)?.health.reprice).toMatchObject({ state: "complete", repriced: 1 });
});

it("owner publishes fresh billing before repricing and before metadata reads start", async () => {
  const c = command(), p = port(), path = join(root, "publish-order.jsonl");
  writeFileSync(path, JSON.stringify({ type: "message", id: "fresh-order", timestamp: new Date(at - 1).toISOString(),
    message: { role: "assistant", provider: "github-copilot", model: "gpt-6.1-sol",
      usage: { input: 10000, output: 0, cacheRead: 0, cacheWrite: 0 } } }) + "\n");
  const d = { sources: [{ path, project: null, repo: null, run: null }], runs: [], errors: [] };
  let beforeReprice: ReturnType<UsageLedger["getPublishedSnapshot"]>, beforeMetadata: ReturnType<UsageLedger["getPublishedSnapshot"]>;
  const backfill = sessionBackfill.backfillSessionMetadata;
  vi.spyOn(sessionBackfill, "backfillSessionMetadata").mockImplementation(async (...args) => {
    beforeMetadata = args[0].getPublishedSnapshot();
    return backfill(...args);
  });
  await bootUsageWorker(p as unknown as MessagePort, c, { now: () => at, discover: async () => d,
    ingest: async (...args) => {
      const result = await ingestOnce(...args), repricer = args[0].repriceUnpriced.bind(args[0]);
      vi.spyOn(args[0], "repriceUnpriced").mockImplementation((...params) => {
        beforeReprice = args[0].getPublishedSnapshot(); return repricer(...params);
      });
      return result;
    } });
  await vi.waitFor(() => expect(snapshots(p).at(-1)?.metadataBackfill).toBe("complete"));
  for (const published of [beforeReprice!, beforeMetadata!]) {
    expect(published).toMatchObject({ backfill: "complete", monthUsed: 2, health: { calls: 1 },
      reconciliation: { computedAIC: 2, unpricedCalls: 0 } });
  }
  expect(snapshots(p).at(-1)?.health.reprice).toMatchObject({ repriced: 0, state: "complete" });
});

it("owner republishes repriced values for followers before a blocked metadata pass", async () => {
  const c = command(), owner = port(), follower = port();
  const discovery = { sources: [], runs: [], errors: [] };
  await bootUsageWorker(owner as unknown as MessagePort, c, { now: () => at, discover: async () => discovery });
  await vi.waitFor(() => expect(snapshots(owner).at(-1)?.backfill).toBe("complete"));
  await bootUsageWorker(follower as unknown as MessagePort, { ...c, owner: `${process.pid}:follower` }, { now: () => at });
  await vi.waitFor(() => expect(snapshots(follower).at(-1)?.ingestRole).toBe("follower"));
  const store = openUsageLedger(c.roots.ledgerFile);
  store.apply(dashboardBatch([dashboardCall("early-publish", { ts: at - 1, provider: "github-copilot", model: "gpt-6.1-sol",
    usage: { input: 10000, output: 0, cacheRead: 0, cacheWrite: 0 }, price: { status: "unpriced", reason: "no-rate-at-time" } })]));
  const Database = (await import("better-sqlite3")).default, db = new Database(c.roots.ledgerFile);
  db.prepare("UPDATE ledger_metadata SET value='previous-table' WHERE key='reprice-rate-fingerprint'").run(); db.close();
  let release!: () => void, entered = false;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const backfill = sessionBackfill.backfillSessionMetadata;
  vi.spyOn(sessionBackfill, "backfillSessionMetadata").mockImplementationOnce(async (...args) => {
    entered = true; await blocked; return backfill(...args);
  });
  try {
    owner.emit("message", { type: "refresh" });
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(store.getPublishedSnapshot()).toMatchObject({ collector: { kind: "pi" }, monthUsed: 2, health: { reprice: { repriced: 1 } } });
    const before = snapshots(follower).length; follower.emit("message", { type: "refresh" });
    await vi.waitFor(() => expect(snapshots(follower).length).toBeGreaterThan(before));
    expect(snapshots(follower).at(-1)).toMatchObject({ ingestRole: "follower", collector: { kind: "pi" }, monthUsed: 2, health: { calls: 1, reprice: { repriced: 1 } } });
  } finally { release(); store.close(); }
});

it.each([false, true])("incomplete repricing alone schedules three second owner passes then sixty seconds, dashboard=%s", async dashboardMode => {
  const c = { ...command(), dashboardMode }, p = port(), store = openUsageLedger(c.roots.ledgerFile);
  store.apply(dashboardBatch(Array.from({ length: 3 }, (_, i) => dashboardCall(`cadence-${i}`, {
    ts: at - 1, provider: "github-copilot", model: "gpt-6.1-sol", usage: { input: 10000, output: 0, cacheRead: 0, cacheWrite: 0 },
    price: { status: "unpriced", reason: "no-rate-at-time" },
  })))); store.close();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  let ingests = 0;
  await bootUsageWorker(p as unknown as MessagePort, c, { repriceBatchSize: 1, now: () => at, monotonicNow: () => Date.now(),
    discover: async () => ({ sources: [], runs: [], errors: [] }), ingest: async (...args) => { ingests++; return ingestOnce(...args); } });
  await vi.advanceTimersByTimeAsync(0);
  await vi.waitFor(() => expect(snapshots(p).at(-1)).toMatchObject({ metadataBackfill: "complete", health: { reprice: { state: "running", processed: 1 } } }));
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(3000);
  await vi.waitFor(() => expect(snapshots(p).at(-1)?.health.reprice).toMatchObject({ state: "running", processed: 2 }));
  expect(ingests).toBe(2);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(3000);
  await vi.waitFor(() => expect(snapshots(p).at(-1)?.health.reprice).toMatchObject({ state: "complete", processed: 3, repriced: 3 }));
  expect(ingests).toBe(3);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(59000); expect(ingests).toBe(3);
  await vi.advanceTimersByTimeAsync(1100);
  await vi.waitFor(() => expect(ingests).toBe(4));
  p.emit("message", { type: "stop" }); await vi.advanceTimersByTimeAsync(0);
});

it("worker passes its live lease guard into the reprice transaction", async () => {
  const c = command(), p = port(), store = openUsageLedger(c.roots.ledgerFile);
  store.apply(dashboardBatch([dashboardCall("lease-fenced-reprice", { ts: at - 1, provider: "github-copilot", model: "gpt-6.1-sol",
    usage: { input: 10000, output: 0, cacheRead: 0, cacheWrite: 0 }, price: { status: "unpriced", reason: "no-rate-at-time" } })]));
  const Database = (await import("better-sqlite3")).default, db = new Database(c.roots.ledgerFile);
  const prices = () => db.prepare("SELECT aic, aic_input, aic_output, aic_cache_read, aic_cache_write, price_status, unpriced_reason, rate_version, tier, confidence FROM calls").all();
  const before = prices(); let clock = at, finished = false, successor: ReturnType<typeof acquireUsageLease>;
  try {
    await bootUsageWorker(p as unknown as MessagePort, c, { now: () => clock, discover: async () => ({ sources: [], runs: [], errors: [] }),
      ingest: async (...args) => {
        const result = await ingestOnce(...args), repricer = args[0].repriceUnpriced.bind(args[0]);
        vi.spyOn(args[0], "repriceUnpriced").mockImplementation((guard, size) => {
          clock += 120001; successor = acquireUsageLease(store, "ingest", `${process.pid}:successor`, () => clock, 120000);
          const progress = repricer(guard, size); finished = true; return progress;
        });
        return result;
      } });
    await vi.waitFor(() => expect(finished).toBe(true));
    expect(successor!.isCurrent(() => clock)).toBe(true);
    expect(prices()).toEqual(before);
    expect(store.health(clock).reprice).toMatchObject({ state: "pending", processed: 0 });
  } finally { successor?.release(); db.close(); store.close(); }
});

// Catches an omitted default or a worker/backfill budget mismatch without a large fixture.
it("worker passes the production metadata budget to backfill when no override is given", async () => {
  const backfill = vi.spyOn(sessionBackfill, "backfillSessionMetadata");
  const p = port();
  await bootUsageWorker(p as unknown as MessagePort, command(), { now: () => at, discover: async () => ({ sources: [], runs: [], errors: [] }) });
  await vi.waitFor(() => expect(snapshots(p).at(-1)?.metadataBackfill).toBe("complete"));
  expect(backfill).toHaveBeenCalledTimes(1);
  expect(backfill.mock.calls[0][5]).toBe(sessionBackfill.METADATA_BACKFILL_BYTES_PER_PASS);
  expect(backfill.mock.calls[0][5]).toBe(32 * 1024 * 1024);
});
