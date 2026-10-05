import { EventEmitter } from "node:events";
import type { MessagePort } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { bootUsageWorker } from "../worker-entry.js";
import { openUsageLedger, type UsageLedger } from "../ledger.js";
import { ingestOnce } from "../ingest.js";
import { acquireUsageLease } from "../lease.js";
import type { UsageWorkerEvent } from "../protocol.js";
const reads = vi.hoisted(() => ({ health: 0, summaries: 0, followers: [] as UsageLedger[] }));
vi.mock("../ledger.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../ledger.js")>();
  return { ...actual, openUsageLedgerReadOnly: (file: string) => {
    const store = actual.openUsageLedgerReadOnly(file);
    if (store) { reads.followers.push(store); const health = store.health.bind(store), summarize = store.summarize.bind(store);
      store.health = () => { reads.health++; return health(); };
      store.summarize = (...args) => { reads.summaries++; return summarize(...args); };
    }
    return store;
  } };
});
class Port extends EventEmitter {
  events: UsageWorkerEvent[] = [];
  closed = false;
  postMessage(e: UsageWorkerEvent) { this.events.push(e); }
  close() { this.closed = true; }
}
let root: string, ports: Port[];
const at = Date.parse("2026-10-04T12:00:00Z");
beforeEach(() => { root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "worker-entry-")); ports = []; reads.followers = []; vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); })); });
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
    expect(lease).toBeDefined(); release();
    await vi.waitFor(() => expect(finished).toBe(true));
    expect(successor.health().calls).toBe(0); expect(successor.getImportState(source.path)).toBeUndefined();
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
  expect(p.events.at(-1)).toEqual({ type: "stopped" });
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
  await vi.waitFor(() => expect(snapshots(p).at(-1)?.backfill).toBe("complete"));
  expect(sharedWrites).toBe(1); expect(healthCalls).toBeLessThanOrEqual(2);
  const progress = snapshots(p).filter(s => s.backfill === "running" && (s as any).progress?.sourcesCompleted > 0);
  expect(progress.length).toBeGreaterThan(0);
  expect((progress[0] as any).progress).toMatchObject({ sourcesTotal: 40 });
  expect((progress[0] as any).progress.sourcesCompleted).toBeLessThan(40);
  const before = calls; p.emit("message", { type: "refresh" });
  await vi.waitFor(() => expect(snapshots(p).filter(s => s.backfill === "complete")).toHaveLength(2));
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
