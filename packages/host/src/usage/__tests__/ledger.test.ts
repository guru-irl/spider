import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrateUsageLedger } from "../migrate.js";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { openDb, openDbReadOnly, type Db } from "@spider/db-core";
import type { CallRow, ImportBatch, ImportState, RunMeta, UsageLedger } from "../ledger.js";

let root: string;
let file: string;
let openUsageLedger: typeof import("../ledger.js").openUsageLedger;
const handles: Array<{ close(): void }> = [];
function track<T extends { close(): void }>(handle: T): T { handles.push(handle); return handle; }
function reader(): Db { return track(openDbReadOnly(file)!); }
function call(overrides: Partial<CallRow> = {}): CallRow {
  return {
    id: "call-1", ts: 100, sourceFile: "synthetic-session.jsonl", entryId: "entry-1", sourceGeneration: 0,
    project: null, repo: null, sessionId: null, runId: null, actor: "parent", role: null, agent: null,
    runName: null, phase: null, parentRunId: null, auxPurpose: null, provider: "github-copilot", model: "fixture-model",
    requestedModel: null, thinking: null, api: null,
    usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 5, reasoning: 7, totalTokens: 100 },
    price: {
      status: "priced", aic: 10, components: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 },
      rateVersion: "fixture-rates", tier: "default", confidence: "estimated"
    },
    piCost: 0.12, latencyMs: 25, aggregate: false, counted: true, originKey: null,
    sourceKind: overrides.actor === "subagent" && overrides.aggregate && overrides.runId != null ? "report" : "transcript", ...overrides,
  };
}
function state(overrides: Partial<ImportState> = {}): ImportState {
  return {
    path: "synthetic-session.jsonl", inode: "fixture-inode", size: 200, mtimeMs: 1000,
    offset: 100, parseErrors: 1, generation: 0, prefixHash: "fixture-hash", ...overrides
  };
}
function batch(overrides: Partial<ImportBatch> = {}): ImportBatch {
  return {
    calls: [], runs: [], states: [], detailedRunIds: [], restoreAggregateRunIds: [],
    resetSources: [], sourceErrors: [], at: 1000, ...overrides
  };
}
function run(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    id: "fixture-run", dbPath: "fixture-repo.db", project: null, repo: null, sessionId: null,
    parentRunId: null, agent: null, role: null, name: null, model: null, thinking: null, phase: null,
    startedAt: null, endedAt: null, ...overrides
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "usage-ledger-"));
  file = join(root, "private", "usage.db");
  // A missing implementation fails individual tests, not test collection.
  ({ openUsageLedger } = await import("../ledger.js"));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0).reverse()) handle.close();
  rmSync(root, { recursive: true, force: true });
});

describe("usage ledger", () => {
  // Catches run-report reconciliation suppressing a child's own billed compaction.
  it("counts 20 AIC from child detail plus compaction, not 10", () => {
    const ledger = track(openUsageLedger(file));
    ledger.apply(batch({ calls: [call({ aggregate: true, actor: "subagent", runId: "R" })] }));
    const detail = call({ id: "detail", entryId: "detail", sourceFile: "child.jsonl", actor: "subagent", runId: "R" });
    const compaction = call({ id: "compact", entryId: "compact", sourceFile: "child.jsonl", actor: "compaction", aggregate: true, runId: "R" });
    ledger.apply(batch({ calls: [detail, compaction], detailedRunIds: ["R"] }));
    expect(ledger.summarize(0, 200).aic).toBe(20);
    expect(ledger.health().aggregateCalls).toBe(0);
  });

  // Catches an intra-batch cursor rollback that otherwise bypasses committed fences.
  it("rejects duplicate state paths before any writes", () => {
    const ledger = track(openUsageLedger(file));
    ledger.apply(batch({ states: [state({ offset: 0 })] }));
    expect(() => ledger.apply(batch({
      calls: [call()], runs: [run()],
      states: [state({ size: 400, offset: 300 }), state({ size: 400, offset: 100 })]
    }))).toThrow(/duplicate.*state|duplicate.*path/i);
    expect(ledger.health().calls).toBe(0);
    expect(ledger.getRuns()).toEqual([]);
    expect(ledger.getImportState(state().path)?.offset).toBe(0);
  });
  // M04: dropping the bare-state generation fence rolls a committed cursor back.
  it("rejects an older-generation state without a reset", () => {
    const ledger = track(openUsageLedger(file));
    ledger.apply(batch({ states: [state({ generation: 1 })] }));
    expect(() => ledger.apply(batch({ states: [state({ generation: 0, offset: 0 })] }))).toThrow(/stale|generation/i);
    expect(ledger.getImportState(state().path)?.generation).toBe(1);
  });

  // M05: a generation bump must not bypass deletion of the previous generation.
  it("rejects a generation bump without a reset", () => {
    const ledger = track(openUsageLedger(file));
    ledger.apply(batch({ calls: [call()], states: [state()] }));
    expect(() => ledger.apply(batch({ states: [state({ generation: 1 })] }))).toThrow(/without reset/i);
    expect(ledger.health().calls).toBe(1);
    expect(ledger.getImportState(state().path)?.generation).toBe(0);
  });

  // M06: resetting calls without the matching cursor would leave a broken resume fence.
  it("rejects a reset without matching state", () => {
    const ledger = track(openUsageLedger(file));
    ledger.apply(batch({ calls: [call()], states: [state()] }));
    expect(() => ledger.apply(batch({ resetSources: [{ path: state().path, generation: 1 }] }))).toThrow(/matching.*state/i);
    expect(ledger.health().calls).toBe(1);
    expect(ledger.getImportState(state().path)?.generation).toBe(0);
  });

  // M01: DEFERRED would let another writer take the lock after cursor validation begins.
  it("acquires the apply write lock before reading a source fence", () => {
    const ledger = track(openUsageLedger(file));
    const competitor = track(openDb(file, { busyTimeoutMs: 0 }));
    const prepare = Database.prototype.prepare;
    let competingWriteSucceeded = false;
    let observedFence = false;
    vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, sql: string) {
      const statement = prepare.call(this, sql) as Database.Statement<unknown[]>;
      if (sql.startsWith("SELECT generation, offset")) {
        const get = statement.get;
        vi.spyOn(statement, "get").mockImplementation((...args: unknown[]) => {
          observedFence = true;
          try {
            competitor.exec("BEGIN IMMEDIATE");
            competingWriteSucceeded = true;
            competitor.exec("ROLLBACK");
          } catch (error) { expect(error).toMatchObject({ code: "SQLITE_BUSY" }); }
          return get.apply(statement, args);
        });
      }
      return statement;
    });
    // Statements are prepared at open, so open a fresh connection with the observation installed.
    const observed = track(openUsageLedger(file));
    observed.apply(batch({ states: [state()] }));
    expect(observedFence).toBe(true);
    expect(competingWriteSucceeded).toBe(false);
    expect(ledger.getImportState(state().path)?.offset).toBe(100);
  });

  // M02: DEFERRED lets a competitor acquire the lock before migration's version read.
  it("acquires the migration write lock before reading user_version", () => {
    const db = track(openDb(file));
    const competitor = track(openDb(file, { busyTimeoutMs: 0 }));
    const pragma = db.pragma.bind(db);
    let competingWriteSucceeded = false;
    vi.spyOn(db, "pragma").mockImplementation((sql) => {
      if (sql === "user_version") {
        try {
          competitor.exec("BEGIN IMMEDIATE");
          competingWriteSucceeded = true;
          competitor.exec("ROLLBACK");
        } catch (error) { expect(error).toMatchObject({ code: "SQLITE_BUSY" }); }
      }
      return pragma(sql);
    });
    migrateUsageLedger(db);
    expect(competingWriteSucceeded).toBe(false);
    expect(db.pragma("user_version")).toBe(4);
  });

  // M23: callers of migrate directly must not overwrite a future schema version.
  it("rechecks future schema inside migration", () => {
    const db = track(openDb(file));
    db.pragma("user_version = 99");
    expect(() => migrateUsageLedger(db)).toThrow(/future/i);
    expect(db.pragma("user_version")).toBe(99);
    expect(db.prepare("SELECT name FROM sqlite_master").all()).toEqual([]);
  });

  // M33: a failed migration must release its actual native handle, not wait for GC.
  it("closes the writable handle on migration failure", () => {
    const db = track(openDb(file));
    db.exec("CREATE TABLE counter_snapshots (fixture TEXT)");
    const exec = Database.prototype.exec;
    let failedHandle: Database.Database | undefined;
    vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
      if (sql.includes("CREATE TABLE calls")) { failedHandle = this; track(this); }
      return exec.call(this, sql);
    });
    expect(() => openUsageLedger(file)).toThrow(/already exists/i);
    expect(failedHandle).toBeDefined();
    expect(failedHandle!.open).toBe(false);
  });

  // M34: the global root can be shared; do not silently chmod an existing parent.
  it("preserves permissions on a pre-existing parent", () => {
    mkdirSync(join(root, "private"), { mode: 0o755 });
    if (process.platform !== "win32") chmodSync(join(root, "private"), 0o755);
    track(openUsageLedger(file));
    if (process.platform !== "win32") expect(statSync(join(root, "private")).mode & 0o777).toBe(0o755);
  });

  // Pricing and aggregation are not evidence of incomplete imported data.
  it("keeps complete verified aggregate data unflagged", () => {
    const ledger = track(openUsageLedger(file));
    const price: CallRow["price"] = {
      status: "priced", aic: 10, components: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 },
      rateVersion: "fixture", tier: "default", confidence: "verified"
    };
    ledger.apply(batch({ calls: [call({ actor: "subagent", aggregate: true, price })] }));
    expect(ledger.summarize(0, 200)).toEqual({ aic: 10, pricedCalls: 1, unpricedCalls: 0, estimated: false, possibleUndercount: false });
  });

  // M20: a successful replay must not roll lastIngestAt back.
  it("keeps last ingestion time monotonic across successful states", () => {
    const ledger = track(openUsageLedger(file));
    ledger.apply(batch({ states: [state()], at: 2000 }));
    ledger.apply(batch({ states: [state()], at: 1000 }));
    expect(ledger.health().lastIngestAt).toBe(2000);
  });

  // Legacy counted flags do not discard raw detail or hide its uncertainty.
  it("counts retained unpriced detail regardless of the obsolete counted flag", () => {
    const ledger = track(openUsageLedger(file));
    ledger.apply(batch({ calls: [call({ counted: false, price: { status: "unpriced", reason: "unknown-model" } })] }));
    expect(ledger.health(100).unpricedBillingPeriod).toEqual({ models: ["fixture-model"], withoutModel: 0 });
  });

  // M15: detailedRunIds must reconcile retained rows even if this batch has no calls.
  it("hides an existing report on a detail-only reconciliation signal", () => {
    const ledger = track(openUsageLedger(file));
    const report = call({ actor: "subagent", aggregate: true, runId: "R" });
    ledger.apply(batch({ calls: [report, call({ id: "detail", entryId: "detail", runId: "R" })] }));
    // Re-enable the report to model reconciliation of retained rows after dedup changes.
    const db = track(openDb(file));
    db.exec("UPDATE calls SET counted=1 WHERE aggregate=1");
    ledger.apply(batch({ detailedRunIds: ["R"] }));
    expect(ledger.summarize(0, 200).aic).toBe(10);
    expect(ledger.health().aggregateCalls).toBe(0);
  });

  // Catches fallback commands hiding the only surviving detail when no report exists.
  it("does not discard surviving details without an aggregate to restore", () => {
    const ledger = track(openUsageLedger(file));
    ledger.apply(batch({ calls: [call({ runId: "run-1" })] }));
    ledger.apply(batch({ restoreAggregateRunIds: ["run-1"] }));
    expect(ledger.summarize(0, 200).aic).toBe(10);
  });

  // Catches conflicting reconciliation signals making every row uncounted.
  it("gives readable detail priority over a simultaneous fallback request", () => {
    const ledger = track(openUsageLedger(file));
    ledger.apply(batch({ calls: [call({ aggregate: true, actor: "subagent", runId: "run-1" })] }));
    ledger.apply(batch({
      calls: [call({ id: "detail", entryId: "detail", sourceFile: "child.jsonl", runId: "run-1" })],
      detailedRunIds: ["run-1"], restoreAggregateRunIds: ["run-1"]
    }));
    expect(ledger.summarize(0, 200).aic).toBe(10);
    expect(ledger.health().aggregateCalls).toBe(0);
  });

  // Catches new ancestor directories exposing private ledger contents.
  it("makes newly created ancestor directories private", () => {
    const nested = join(root, "new-parent", "nested", "usage.db");
    track(openUsageLedger(nested));
    if (process.platform !== "win32") expect(statSync(join(root, "new-parent")).mode & 0o777).toBe(0o700);
  });

  // Catches partial DDL surviving a failed migration.
  it("rolls back failed schema creation and user_version", () => {
    const broken = track(openDb(file));
    broken.exec("CREATE TABLE counter_snapshots (fixture TEXT)");
    expect(() => openUsageLedger(file)).toThrow();
    expect(broken.pragma("user_version")).toBe(0);
    expect(broken.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: "counter_snapshots" }]);
  });

  // Catches cursors cached per connection instead of fenced against committed state.
  it("fences raced writers and permits retry after a short busy failure", () => {
    const first = track(openUsageLedger(file));
    const second = track(openUsageLedger(file));
    first.apply(batch({ states: [state({ offset: 0 })] }));
    second.apply(batch({ calls: [call()], states: [state()] }));
    expect(() => first.apply(batch({ states: [state({ offset: 50 })] }))).toThrow(/stale|offset/i);
    const blocker = track(openDb(file));
    blocker.exec("BEGIN IMMEDIATE");
    try {
      const started = performance.now();
      expect(() => first.apply(batch({ calls: [call({ id: "retry", entryId: "retry" })], states: [state({ offset: 200 })] }))).toThrow(/locked|busy/i);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(second.health().calls).toBe(1);
      expect(second.getImportState(state().path)?.offset).toBe(100);
    } finally { blocker.exec("ROLLBACK"); }
    first.apply(batch({ calls: [call({ id: "retry", entryId: "retry" })], states: [state({ offset: 200 })] }));
    expect(second.health().calls).toBe(2);
    expect(second.getImportState(state().path)?.offset).toBe(200);
  });
  // Catches accidental use of spider migrations or default DB resolution.
  it("creates isolated usage tables", () => {
    const spiderFile = join(root, "spider.db");
    const spider = track(openDb(spiderFile));
    spider.exec("CREATE TABLE fixture_context (value TEXT); INSERT INTO fixture_context VALUES ('untouched')");
    const before = spider.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
    const ledger = track(openUsageLedger(file));
    expect(reader().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([
      { name: "call_ancestry_edges" }, { name: "calls" }, { name: "counter_snapshots" }, { name: "coverage_edges" }, { name: "dimension_values" }, { name: "import_state" }, { name: "incomplete_reports" }, { name: "leases" }, { name: "ledger_metadata" }, { name: "ledger_totals" }, { name: "pending_reports" }, { name: "runs_meta" }, { name: "session_metadata_import" }, { name: "sessions" }, { name: "source_context" }, { name: "source_entries" },
    ]);
    expect(spider.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(before);
    expect(spider.prepare("SELECT value FROM fixture_context").get()).toEqual({ value: "untouched" });
    expect(ledger.health()).toEqual({
      schemaVersion: 4, calls: 0, sources: 0, parseErrors: 0, sourceErrors: 0,
      aggregateCalls: 0, lastIngestAt: null,
      unpricedBillingPeriod: { models: [], withoutModel: 0 },
      reprice: { state: "pending", processed: 0, total: 0, repriced: 0 },
    });
    expect(reader().pragma("journal_mode")).toBe("wal");
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(root, "private")).mode & 0o777).toBe(0o700);
    }
  });

  // Catches writable preflight changing the journal mode of a future DB.
  it("migrates once and rejects future schema without modification", () => {
    const first = openUsageLedger(file);
    first.apply(batch({ calls: [call()], states: [state()] }));
    first.close();
    const before = readFileSync(file);
    const second = openUsageLedger(file);
    expect(second.health().schemaVersion).toBe(4);
    expect(second.health().calls).toBe(1);
    second.close();
    expect(readFileSync(file)).toEqual(before);
    const futureFile = join(root, "future.db");
    const future = openDb(futureFile);
    future.exec("CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('preserve')");
    future.pragma("user_version = 99");
    future.pragma("journal_mode = DELETE");
    future.close();
    const futureBytes = readFileSync(futureFile);
    const started = performance.now();
    expect(() => openUsageLedger(futureFile)).toThrow(/future|newer|unsupported/i);
    // M7/N07: a non-BUSY rejection must not consume the contention retry budget.
    expect(performance.now() - started).toBeLessThan(500);
    expect(readFileSync(futureFile)).toEqual(futureBytes);
    const snapshot = track(openDbReadOnly(futureFile)!);
    expect(snapshot.pragma("journal_mode")).toBe("delete");
    expect(snapshot.prepare("SELECT * FROM future_data").all()).toEqual([{ value: "preserve" }]);
  });

  // Catches dropped or fabricated attribution, merged token buckets and price components.
  it("round trips all nullable attribution and token fields", () => {
    const ledger = track(openUsageLedger(file));
    ledger.apply(batch({
      calls: [call({ actor: "warmer", aggregate: true, provider: null, model: null })],
      runs: [run(), run({
        dbPath: "second-repo.db", project: "fixture-project", repo: "fixture-repo", sessionId: "session",
        parentRunId: "parent", agent: "worker", role: "research", name: "fixture", model: "fixture-model", thinking: "high",
        phase: "implement", startedAt: 10, endedAt: 20
      })], states: [state()]
    }));
    expect(reader().prepare("SELECT * FROM calls").get()).toMatchObject({
      id: "call-1", ts: 100, source_file: "synthetic-session.jsonl", entry_id: "entry-1", source_generation: 0,
      project: null, repo: null, session_id: null, run_id: null, actor: "warmer", role: null, agent: null,
      run_name: null, phase: null, parent_run_id: null, aux_purpose: null, provider: null, model: null,
      requested_model: null, thinking: null, api: null, input: 10, output: 20, cache_read: 30, cache_write: 40,
      cache_write_1h: 5, reasoning: 7, total_tokens: 100, aic: 10, aic_input: 1, aic_cache_read: 2,
      aic_cache_write: 3, aic_output: 4, price_status: "priced", unpriced_reason: null, rate_version: "fixture-rates",
      tier: "default", confidence: "estimated", pi_cost: 0.12, latency_ms: 25, aggregate: 1, counted: 1, origin_key: null,
    });
    expect(ledger.getImportState("synthetic-session.jsonl")).toEqual(state());
    expect(ledger.getImportState("absent")).toBeUndefined();
    expect(ledger.getRuns()).toEqual([run({ status: null }), run({
      status: null,
      dbPath: "second-repo.db", project: "fixture-project", repo: "fixture-repo", sessionId: "session",
      parentRunId: "parent", agent: "worker", role: "research", name: "fixture", model: "fixture-model", thinking: "high",
      phase: "implement", startedAt: 10, endedAt: 20
    })]);
  });

  // Catches swapped attribution columns and dropped requested model/origin provenance.
  it("preserves populated call attribution and original pricing on replay", () => {
    const ledger = track(openUsageLedger(file));
    ledger.apply(batch({
      calls: [call({
        project: "project", repo: "repo", sessionId: "session", runId: "run",
        actor: "aux", role: "worker", agent: "agent", runName: "run-name", phase: "review", parentRunId: "parent",
        auxPurpose: "reflection", requestedModel: "requested-model", thinking: "high", api: "fixture-api", originKey: "origin"
      })]
    }));
    ledger.apply(batch({ calls: [call({ id: "copy-id", ts: 900, counted: false })] }));
    expect(reader().prepare("SELECT * FROM calls").get()).toMatchObject({
      id: "call-1", ts: 100,
      project: "project", repo: "repo", session_id: "session", run_id: "run", actor: "aux", role: "worker", agent: "agent",
      run_name: "run-name", phase: "review", parent_run_id: "parent", aux_purpose: "reflection",
      requested_model: "requested-model", thinking: "high", api: "fixture-api", origin_key: "origin", counted: 1, aic: 10
    });
    expect(ledger.summarize(0, 200).pricedCalls).toBe(1);
  });

  // A later invalid row must roll back earlier row/run/state mutations.
  it("applies offset and calls atomically", () => {
    const ledger = track(openUsageLedger(file));
    ledger.apply(batch({ states: [state({ offset: 0, parseErrors: 0 })] }));
    const before = ledger.health();
    expect(() => ledger.apply(batch({
      calls: [call(), call({ id: "call-2", entryId: "entry-2", actor: "invalid" as CallRow["actor"] })],
      runs: [run()], states: [state({ offset: 200 })], at: 2000
    }))).toThrow();
    expect(ledger.health()).toEqual(before);
    expect(ledger.getImportState(state().path)?.offset).toBe(0);
    expect(ledger.getRuns()).toEqual([]);
  });

  // Catches duplicate inserts and cursors moving backward on raced scans.
  it("deduplicates source entry and fences stale state", () => {
    const ledger = track(openUsageLedger(file));
    const initial = batch({ calls: [call()], states: [state()] });
    ledger.apply(initial);
    const first = ledger.health();
    ledger.apply(initial);
    ledger.apply(batch({ calls: [call({ id: "different-id" })], states: [state()] }));
    expect(ledger.health()).toEqual(first);
    expect(ledger.getImportState(state().path)?.offset).toBe(100);
    expect(() => ledger.apply(batch({
      calls: [call({ id: "stale", entryId: "stale" })],
      states: [state({ offset: 50 })]
    }))).toThrow(/stale|offset/i);
    expect(ledger.health()).toEqual(first);
    expect(ledger.summarize(0, 1).unpricedCalls).toBe(0);
  });

  // Catches reset deletion outside the transaction, generation bypass and repeat reset deletion.
  it("resets a source generation atomically and rejects old calls", () => {
    const ledger = track(openUsageLedger(file));
    ledger.apply(batch({ calls: [call()], states: [state()] }));
    const replacement = batch({
      resetSources: [{ path: state().path, generation: 1 }],
      calls: [call({ id: "replacement", sourceGeneration: 1 })], states: [state({ generation: 1, offset: 30 })], at: 2000
    });
    ledger.apply(replacement);
    ledger.apply(replacement);
    expect(ledger.health().calls).toBe(1);
    expect(reader().prepare("SELECT id, source_generation FROM calls").all()).toEqual([{ id: "replacement", source_generation: 1 }]);
    const before = ledger.health();
    expect(() => ledger.apply(batch({ calls: [call()], states: [state()], resetSources: [{ path: state().path, generation: 0 }] }))).toThrow(/stale|generation/i);
    expect(() => ledger.apply(batch({ calls: [call({ entryId: "stale-without-state" })] }))).toThrow(/stale|generation/i);
    expect(ledger.health()).toEqual(before);
    expect(() => ledger.apply(batch({
      resetSources: [{ path: state().path, generation: 2 }],
      states: [state({ generation: 2, offset: 0 })], calls: [call({ sourceGeneration: 2, actor: "invalid" as CallRow["actor"] })]
    }))).toThrow();
    expect(ledger.health()).toEqual(before);
    expect(ledger.getImportState(state().path)?.generation).toBe(1);
  });

  // M09 is not equivalent: valid same-generation resets need not replay their calls.
  it("retains current-generation calls on an empty repeated reset", () => {
    const ledger = track(openUsageLedger(file));
    ledger.apply(batch({ calls: [call()], states: [state()] }));
    ledger.apply(batch({
      resetSources: [{ path: state().path, generation: 1 }],
      states: [state({ generation: 1 })], calls: [call({ sourceGeneration: 1 })]
    }));
    ledger.apply(batch({ resetSources: [{ path: state().path, generation: 1 }], states: [state({ generation: 1 })] }));
    expect(ledger.health().calls).toBe(1);
    expect(ledger.summarize(0, 200).aic).toBe(10);
  });

  // Catches suppression happening before a detail write that later fails.
  it("replaces aggregates atomically by run", () => {
    const ledger = track(openUsageLedger(file));
    ledger.apply(batch({ calls: [call({ aggregate: true, actor: "subagent", runId: "run-1" })] }));
    const detail = call({ id: "detail", sourceFile: "child.jsonl", entryId: "detail", runId: "run-1", actor: "subagent" });
    expect(() => ledger.apply(batch({
      calls: [detail, call({ id: "bad", entryId: "bad", actor: "invalid" as CallRow["actor"] })],
      detailedRunIds: ["run-1"]
    }))).toThrow();
    expect(ledger.summarize(0, 200).aic).toBe(10);
    expect(ledger.health().aggregateCalls).toBe(1);
    ledger.apply(batch({ calls: [detail], detailedRunIds: ["run-1"] }));
    expect(ledger.summarize(0, 200).aic).toBe(10);
    expect(ledger.health().aggregateCalls).toBe(0);
    expect(reader().prepare("SELECT aggregate, counted FROM calls ORDER BY aggregate").all()).toEqual([
      { aggregate: 0, counted: 1 }, { aggregate: 1, counted: 1 },
    ]);
  });

  // Catches reports arriving after child details re-enabling the aggregate.
  it("keeps late and replayed aggregates hidden behind counted details", () => {
    const ledger = track(openUsageLedger(file));
    ledger.apply(batch({ calls: [call({ runId: "run-1" })], detailedRunIds: ["run-1"] }));
    const aggregate = call({ id: "late", sourceFile: "parent.jsonl", entryId: "late", runId: "run-1", actor: "subagent", aggregate: true });
    ledger.apply(batch({ calls: [aggregate] }));
    ledger.apply(batch({ calls: [aggregate] }));
    expect(ledger.summarize(0, 200).aic).toBe(10);
    expect(ledger.health().aggregateCalls).toBe(0);
  });

  // Catches assigning zero AIC to unknown models or counting suppressed uncertainty.
  it("preserves uncertainty", () => {
    const ledger = track(openUsageLedger(file));
    ledger.apply(batch({
      calls: [call({
        price: { status: "unpriced", reason: "no-rate-at-time" }, piCost: null, latencyMs: null,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      })]
    }));
    expect(reader().prepare("SELECT aic, aic_input, price_status, unpriced_reason, confidence, reasoning, cache_write_1h FROM calls").get()).toEqual({
      aic: null, aic_input: null, price_status: "unpriced", unpriced_reason: "no-rate-at-time", confidence: null,
      reasoning: null, cache_write_1h: null,
    });
    expect(ledger.summarize(0, 200)).toEqual({ aic: 0, pricedCalls: 0, unpricedCalls: 1, estimated: false, possibleUndercount: false });
    expect(ledger.health(100).unpricedBillingPeriod).toEqual({ models: ["fixture-model"], withoutModel: 0 });
  });

  // Catches closed intervals, hidden aggregates and estimated flag based on excluded rows.
  it("summarizes a bounded period without hidden aggregates", () => {
    const ledger = track(openUsageLedger(file));
    const verified: CallRow["price"] = {
      status: "priced", aic: 2, components: { input: 0, cacheRead: 0, cacheWrite: 0, output: 2 },
      rateVersion: "verified-fixture", tier: "default", confidence: "verified"
    };
    ledger.apply(batch({
      calls: [call({ ts: 10, price: verified }),
      call({ id: "unpriced", entryId: "unpriced", ts: 15, price: { status: "unpriced", reason: "unknown-model" } }),
      call({ id: "hidden", entryId: "hidden", ts: 12, actor: "subagent", runId: "hidden-run", aggregate: true, counted: false }),
      call({ id: "end", entryId: "end", ts: 20 }), call({ id: "before", entryId: "before", ts: 9, runId: "hidden-run" })]
    }));
    expect(ledger.summarize(10, 20)).toEqual({ aic: 2, pricedCalls: 1, unpricedCalls: 1, estimated: false, possibleUndercount: false });
    expect(ledger.summarize(10, 11)).toEqual({ aic: 2, pricedCalls: 1, unpricedCalls: 0, estimated: false, possibleUndercount: false });
    expect(ledger.summarize(30, 40)).toEqual({ aic: 0, pricedCalls: 0, unpricedCalls: 0, estimated: false, possibleUndercount: false });
    expect(ledger.summarize(20, 21)).toEqual({ aic: 10, pricedCalls: 1, unpricedCalls: 0, estimated: false, possibleUndercount: false });
  });

  // Catches source failures being confused with malformed lines, or stale timestamps.
  it("records source errors separately and clears them on successful import", () => {
    const ledger = track(openUsageLedger(file));
    ledger.apply(batch({ states: [state()], sourceErrors: [{ path: "missing.jsonl", code: "ENOENT" }], at: 2000 }));
    expect(ledger.health()).toMatchObject({ sources: 2, parseErrors: 1, sourceErrors: 1, lastIngestAt: 2000 });
    expect(ledger.getImportState("missing.jsonl")).toBeUndefined();
    ledger.apply(batch({ sourceErrors: [{ path: "missing.jsonl", code: "EACCES" }], at: 1000 }));
    expect(ledger.health()).toMatchObject({ sourceErrors: 1, lastIngestAt: 2000 });
    ledger.apply(batch({ states: [state({ path: "missing.jsonl", parseErrors: 0 })], at: 3000 }));
    expect(ledger.health()).toMatchObject({ parseErrors: 1, sourceErrors: 0, lastIngestAt: 3000 });
  });

  // Catches fabricated optional fields and timestamp ordering hiding a newer save.
  it("stores optional counter fields and selects the latest insertion", () => {
    const ledger = track(openUsageLedger(file));
    expect(ledger.latestCounter()).toBeUndefined();
    const snapshot = { ts: 200, creditsUsed: 12, raw: { optional: { value: true }, extra: "fixture" } };
    ledger.insertCounter(snapshot);
    expect(ledger.latestCounter()).toEqual(snapshot);
    ledger.insertCounter({ ts: 100, accountLogin: "synthetic-account", creditsUsed: 2, entitlement: 10,
      remaining: 8, resetDate: "2026-11-01", raw: {} });
    expect(ledger.latestCounter()).toEqual({ ts: 100, accountLogin: "synthetic-account", creditsUsed: 2, entitlement: 10,
      remaining: 8, resetDate: "2026-11-01", raw: {} });
    ledger.insertCounter({ ts: 300, accountLogin: "synthetic-account", creditsUsed: 3, entitlement: 10,
      remaining: 7, resetDate: "2026-11-01", raw: {} });
    expect(ledger.latestCounter()).toEqual({ ts: 300, accountLogin: "synthetic-account", creditsUsed: 3, entitlement: 10,
      remaining: 7, resetDate: "2026-11-01", raw: {} });
  });
});

// A missing shipped-layout marker must never leave an unknown view in service.
it("fails loudly when opening a ledger with an unknown layout marker", () => {
  const ledger = openUsageLedger(file); ledger.close();
  const legacy = new Database(file);
  legacy.exec("DELETE FROM ledger_metadata WHERE key='schema-layout'; DROP VIEW counted_calls; CREATE VIEW counted_calls AS SELECT * FROM calls");
  legacy.close();
  expect(() => openUsageLedger(file)).toThrow(/schema 4.*layout/i);
});
it("appends attribution entries without updating historical rows", () => {
  const ledger = track(openUsageLedger(file));
  ledger.apply(batch({
    states: [state({ offset: 200 })], sourceContexts: [{
      path: state().path, context: {
        header: null, tailHash: "a", entries: [{ byteOffset: 0, json: { type: "metadata", id: "old", parentId: null } }]
      }
    }]
  }));
  const db = track(openDb(file));
  db.exec("CREATE TRIGGER reject_old_entry_update BEFORE UPDATE ON source_entries BEGIN SELECT RAISE(ABORT,'historical entry rewritten'); END");
  ledger.apply(batch({
    states: [state({ offset: 300, size: 300 })], sourceContexts: [{
      path: state().path, context: {
        header: null, tailHash: "b", entries: [{ byteOffset: 200, json: { type: "metadata", id: "new", parentId: "old" } }]
      }
    }]
  }));
  expect(ledger.getSourceContext(state().path)?.entries.map(e => (e.json as any).id)).toEqual(["old", "new"]);
  expect(db.prepare("SELECT COUNT(*) n FROM source_entries").get()).toEqual({ n: 2 });
});
