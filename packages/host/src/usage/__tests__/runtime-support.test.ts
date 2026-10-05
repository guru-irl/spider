import * as fs from "node:fs/promises";
vi.mock("node:fs/promises", async importOriginal => { const actual = await importOriginal<typeof fs>(); return { ...actual, open: vi.fn(actual.open) }; });
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openUsageLedger, openUsageLedgerReadOnly, type UsageLedger } from "../ledger.js";
import { ingestOnce } from "../ingest.js";
import { CounterPoller } from "../counter.js";
import type { Discovery } from "../discovery.js";
let root: string, ledger: UsageLedger;
const at = Date.parse("2026-10-04T12:00:00Z");
beforeEach(() => { root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "runtime-support-")); ledger = openUsageLedger(join(root, "usage.db")); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); })); });
afterEach(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); vi.unstubAllGlobals(); });
function history(name: string, count = 60) {
  const path = join(root, name + ".jsonl");
  writeFileSync(path, [JSON.stringify({ type: "session", id: name, timestamp: new Date(at).toISOString() }), ...Array.from({ length: count }, (_, i) => JSON.stringify({ type: "message", id: `m${i}`, parentId: i ? `m${i - 1}` : null, timestamp: new Date(at + i).toISOString(), message: { role: "assistant", provider: "github-copilot", model: "gpt-6.1-sol", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } } }))].join("\n") + "\n");
  return { path, project: null, repo: null, run: null };
}
it("bounded batches commit byte cursors and resume all calls without duplication", async () => {
  const source = history("large"); const d: Discovery = { sources: [source], runs: [], errors: [] };
  await ingestOnce(ledger, d, at, new AbortController().signal, { maxBytes: 1024 });
  expect(ledger.health().calls).toBeGreaterThan(0); expect(ledger.health().calls).toBeLessThan(60);
  expect(ledger.getImportState(source.path)!.offset).toBeLessThan(statSync(source.path).size);
  for (let i = 0; i < 30 && ledger.getImportState(source.path)!.offset < statSync(source.path).size; i++) await ingestOnce(ledger, d, at, new AbortController().signal, { maxBytes: 1024 });
  expect(ledger.health().calls).toBe(60); expect(ledger.getImportState(source.path)!.offset).toBe(statSync(source.path).size);
});
it("large ignored message bodies never reach whole-line JSON.parse but usage and cursors remain exact", async () => {
  const path = join(root, "large-body.jsonl");
  const ts = new Date(at).toISOString();
  const content = [{ type: "text", text: '\\"雪\\\\'.repeat(600000) }, { type: "toolCall", arguments: { nested: [true, null, 1.25e-8] } }];
  writeFileSync(path, JSON.stringify({ type: "message", id: "huge", timestamp: ts, ignored: content, message: { role: "assistant", content, provider: "github-copilot", model: "gpt-6.1-sol", usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 } } }) + "\n");
  const source = { path, project: null, repo: null, run: null };
  const original = JSON.parse;
  let maxParsedBytes = 0;
  const spy = vi.spyOn(JSON, "parse").mockImplementation((raw, reviver) => { maxParsedBytes = Math.max(maxParsedBytes, Buffer.byteLength(raw)); return original(raw, reviver); });
  try { await ingestOnce(ledger, { sources: [source], runs: [], errors: [] }, at, new AbortController().signal, { maxBytes: 1024 }); }
  finally { spy.mockRestore(); }
  expect(ledger.health()).toMatchObject({ calls: 1, parseErrors: 0 });
  expect(ledger.summarize(at, at + 1).aic).toBe(0.2);
  expect(ledger.getImportState(path)?.offset).toBe(statSync(path).size);
  expect(maxParsedBytes).toBeLessThan(65536);
});
it("source selection bounds a batch without discarding discovery attribution", async () => {
  const a = history("a", 1), b = history("b", 1);
  await ingestOnce(ledger, { sources: [a, b], runs: [], errors: [] }, at, new AbortController().signal, { sourcePaths: [a.path] });
  expect(ledger.health().calls).toBe(1); expect(ledger.getImportState(b.path)).toBeUndefined();
});
it("a revoked ingest fence prevents all batch writes including diagnostics", async () => {
  const a = history("fenced", 1);
  const before = ledger.health();
  await ingestOnce(ledger, { sources: [a], runs: [], errors: [] }, at, new AbortController().signal, { commitGuard: () => false });
  expect(ledger.health()).toEqual(before); expect(ledger.getImportState(a.path)).toBeUndefined();
});
it("backfill status is shared read-only and updated only by a current ingest fence", () => {
  const batch = { calls: [], runs: [], states: [], resetSources: [], sourceErrors: [], detailedRunIds: [], restoreAggregateRunIds: [], at };
  ledger.apply({ ...batch, backfillState: "running" });
  ledger.apply({ ...batch, backfillState: "complete", commitGuard: () => false });
  const follower = openUsageLedgerReadOnly(join(root, "usage.db"))!;
  try { expect(follower.getBackfillState()).toBe("running"); } finally { follower.close(); }
  ledger.apply({ ...batch, backfillState: "complete" }); expect(ledger.getBackfillState()).toBe("complete");
});
it("read-only followers preserve counter staleness and cannot write or create a ledger", async () => {
  ledger.insertCounter({ ts: at, creditsUsed: 4, raw: {} });
  const readOnly = openUsageLedgerReadOnly(join(root, "usage.db"))!;
  const poller = new CounterPoller({ ledger: readOnly, authPath: join(root, "never-read-auth"), enabled: true, isChild: false, readOnly: true, now: () => at + 100, fetch: globalThis.fetch });
  try {
    poller.start(); expect(poller.state()).toMatchObject({ role: "follower", availability: "available", latest: { creditsUsed: 4 }, snapshotAgeMs: 100 });
    expect(readOnly.health().calls).toBe(0);
    expect(() => readOnly.insertCounter({ ts: at + 1, creditsUsed: 5, raw: {} })).toThrow();
    expect(openUsageLedgerReadOnly(join(root, "absent.db"))).toBeUndefined();
  } finally { await poller.stop(); readOnly.close(); }
});

it("batched ingest skips health even on abort or a rejected fence", async () => {
  const source = history("skip-health", 1), d = { sources: [source], runs: [], errors: [] };
  const health = vi.spyOn(ledger, "health");
  try {
    await ingestOnce(ledger, d, at, new AbortController().signal, { skipHealth: true });
    const aborted = new AbortController(); aborted.abort();
    await ingestOnce(ledger, d, at, aborted.signal, { skipHealth: true });
    await ingestOnce(ledger, d, at, new AbortController().signal, { skipHealth: true, commitGuard: () => false });
    expect(health).not.toHaveBeenCalled();
  } finally { health.mockRestore(); }
});
it("header preloads are cached across slices and unchanged sources are never opened", async () => {
  const a = history("cache-a", 1), b = history("cache-b", 1), d = { sources: [a, b], runs: [], errors: [] };
  const opens = vi.spyOn(fs, "open");
  try {
    await ingestOnce(ledger, d, at, new AbortController().signal, { sourcePaths: [a.path] });
    opens.mockClear();
    await ingestOnce(ledger, d, at, new AbortController().signal, { sourcePaths: [a.path] });
    expect(opens).not.toHaveBeenCalled();
    await ingestOnce(ledger, d, at, new AbortController().signal, { sourcePaths: [b.path] });
    expect(opens).toHaveBeenCalledTimes(1);
  } finally { opens.mockRestore(); }
});
it("unchanged shared run and discovery-error facts do not rewrite timestamps", async () => {
  const db = new (await import("better-sqlite3")).default(join(root, "usage.db"));
  db.exec("CREATE TABLE rewrite_probe(n INTEGER); INSERT INTO rewrite_probe VALUES(0); CREATE TRIGGER run_rewrite AFTER UPDATE ON runs_meta BEGIN UPDATE rewrite_probe SET n=n+1; END;");
  const run = { id: "r", dbPath: "fixture.db", project: null, repo: null, sessionId: null, parentRunId: null, agent: null, role: null, name: null, model: null, thinking: null, phase: null, startedAt: null, endedAt: null };
  const d = { sources: [], runs: [run], errors: [{ path: "missing.jsonl", code: "missing-source" }] };
  try {
    await ingestOnce(ledger, d, at, new AbortController().signal);
    await ingestOnce(ledger, d, at + 1, new AbortController().signal);
    expect(db.prepare("SELECT n FROM rewrite_probe").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT last_ingest_at AS at FROM import_state WHERE path='missing.jsonl'").get()).toEqual({ at });
    await ingestOnce(ledger, { ...d, runs: [{ ...run, endedAt: at }] }, at + 2, new AbortController().signal);
    expect(db.prepare("SELECT n FROM rewrite_probe").get()).toEqual({ n: 1 });
  } finally { db.close(); }
});
it("slice ending between model parts holds a nonterminal report group", async () => {
  const path = join(root, "report-slice.jsonl");
  const part = (id: string, model: string) => JSON.stringify({ type: "usage", id, timestamp: new Date(at).toISOString(), kind: "subagent", note: "worker (child)", provider: "github-copilot", model, usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 } }) + "\n";
  const first = part("one", "gpt-6.1-sol"), second = part("two", "claude-opus-5.5");
  writeFileSync(path, first + second);
  const d = { sources: [{ path, project: null, repo: null, run: null }], runs: [], errors: [] };
  await ingestOnce(ledger, d, at, new AbortController().signal, { maxBytes: Buffer.byteLength(first) });
  expect(ledger.health().calls).toBe(0); expect(ledger.getPendingReports()).toHaveLength(1);
  await ingestOnce(ledger, d, at, new AbortController().signal, { maxBytes: Buffer.byteLength(second) });
  expect(ledger.health().calls).toBe(2); expect(ledger.getPendingReports()).toHaveLength(0);
});
it("a rejected commit cannot retain session attribution or coverage proof", async () => {
  const source = history("uncommitted-head", 1);
  const run = { id: "outer", dbPath: "fixture.db", project: null, repo: null, sessionId: null, parentRunId: null, agent: null, role: null, name: null, model: null, thinking: null, phase: null, startedAt: null, endedAt: null };
  const d = { sources: [{ ...source, run }], runs: [run], errors: [] };
  await ingestOnce(ledger, d, at, new AbortController().signal, { commitGuard: () => false });
  // No persisted header remains. A later metadata-only snapshot must not reuse it
  // to prove that a child report belonged to the rejected outer session.
  const report = history("report-owner", 0);
  writeFileSync(report.path, JSON.stringify({ type: "usage", id: "rep", timestamp: new Date(at + 10).toISOString(), kind: "subagent", note: "worker (outer)", provider: "github-copilot", model: "gpt-6.1-sol", usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 } }) + "\n");
  const child = { ...run, id: "inner", parentRunId: "outer", sessionId: "uncommitted-head", endedAt: at + 1 };
  const events = [{ dbPath: "fixture.db", runId: "inner", sessionId: "uncommitted-head", id: 1, ts: at + 2, type: "spider_usage", payload: "{}" }, { dbPath: "fixture.db", runId: "inner", sessionId: "uncommitted-head", id: 2, ts: at + 3, type: "spider_usage_reported", payload: "{}" }];
  await ingestOnce(ledger, { sources: [report], runs: [run, child], errors: [], runStates: [{ dbPath: "fixture.db", id: "outer", status: "done", childMode: "rpc" }, { dbPath: "fixture.db", id: "inner", status: "done", childMode: "rpc" }], runEvents: events }, at + 20, new AbortController().signal);
  expect(ledger.getProof().edges).toContainEqual({ reportRunId: "outer", includedRunId: "inner", evidence: "unknown" });
});

it("read-only legacy lease inspection works and additive migration preserves live ownership", async () => {
  const file = join(root, "usage.db"); ledger.close();
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(file);
  try {
    db.exec("DROP TABLE leases; CREATE TABLE leases (name TEXT PRIMARY KEY NOT NULL, owner TEXT, token TEXT, acquired_at INTEGER, expires_at INTEGER, next_due_at INTEGER, last_error_code TEXT, notice_code TEXT, notice_at INTEGER)");
    db.prepare("INSERT INTO leases(name,owner,token,acquired_at,expires_at) VALUES ('ingest','legacy-live','fixture-token',?,?)").run(at, at + 120000);
  } finally { db.close(); }
  const follower = openUsageLedgerReadOnly(file)!;
  try { expect(follower.leases.inspect("ingest", at).role).toBe("follower"); } finally { follower.close(); }
  ledger = openUsageLedger(file);
  expect(ledger.leases.inspect("ingest", at).owner).toBe("legacy-live");
});

it("stat-skipped source heads still prove changed DB coverage after a worker restart", async () => {
  const source = history("outer-session", 0), parent = history("parent-report", 0);
  writeFileSync(parent.path, JSON.stringify({ type: "usage", id: "report", timestamp: new Date(at + 10).toISOString(), kind: "subagent", note: "worker (outer)", provider: "github-copilot", model: "gpt-6.1-sol", usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 } }) + "\n");
  const outer = { id: "outer", dbPath: "fixture.db", project: null, repo: null, sessionId: null, parentRunId: null, agent: null, role: null, name: null, model: null, thinking: null, phase: null, startedAt: null, endedAt: at + 5 };
  const inner = { ...outer, id: "inner", sessionId: "outer-session", parentRunId: "outer", endedAt: at + 1 };
  const d = { sources: [{ ...source, run: outer }, parent], runs: [outer, inner], errors: [], runStates: [{ dbPath: "fixture.db", id: "outer", status: "done", childMode: "rpc" }, { dbPath: "fixture.db", id: "inner", status: "done", childMode: "rpc" }] };
  await ingestOnce(ledger, d, at + 20, new AbortController().signal);
  ledger.close(); ledger = openUsageLedger(join(root, "usage.db"));
  const runEvents = [{ dbPath: "fixture.db", runId: "inner", sessionId: "outer-session", id: 1, ts: at + 2, type: "spider_usage", payload: "{}" }, { dbPath: "fixture.db", runId: "inner", sessionId: "outer-session", id: 2, ts: at + 3, type: "spider_usage_reported", payload: "{}" }];
  await ingestOnce(ledger, { ...d, runEvents }, at + 30, new AbortController().signal, { sourcePaths: [] });
  expect(ledger.getProof().edges).toContainEqual({ reportRunId: "outer", includedRunId: "inner", evidence: "runs-db" });
});

it("a read-only follower treats the not-yet-migrated first-open file as pending", async () => {
  const file = join(root, "first-open.db");
  const Database = (await import("better-sqlite3")).default;
  const creating = new Database(file);
  try {
    creating.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE");
    expect(openUsageLedgerReadOnly(file)).toBeUndefined();
  } finally { creating.exec("ROLLBACK"); creating.close(); }
  const migrated = openUsageLedger(file);
  const ready = openUsageLedgerReadOnly(file)!;
  try { expect(ready.getBackfillState()).toBe("pending"); }
  finally { ready.close(); migrated.close(); }
});
