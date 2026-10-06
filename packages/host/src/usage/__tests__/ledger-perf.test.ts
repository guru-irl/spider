import { expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb, openDbReadOnly, type Db } from "@spider/db-core";
import { countedUsageSql } from "../schema.js";
import { openUsageLedger, type CallRow, type CoverageEdge, type ImportBatch } from "../ledger.js";

function call(id: string, overrides: Partial<CallRow> = {}): CallRow {
  return { id, entryId: id, ts: 100, sourceFile: "parent.jsonl", sourceGeneration: 0, project: null, repo: null,
    sessionId: "parent", runId: null, actor: "parent", role: null, agent: null, runName: null, phase: null,
    parentRunId: null, auxPurpose: null, provider: "fixture", model: "fixture", requestedModel: null, thinking: null,
    api: null, usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
    price: { status: "priced", aic: 1, components: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      rateVersion: "fixture", tier: "default", confidence: "verified" }, piCost: null, latencyMs: null,
    aggregate: false, counted: true, originKey: null,
    sourceKind: overrides.actor === "subagent" && overrides.aggregate && overrides.runId != null ? "report" : "transcript", ...overrides };
}
function batch(calls: readonly CallRow[], coverageEdges: readonly CoverageEdge[] = []): ImportBatch {
  return { calls, runs: [], states: [], detailedRunIds: [], restoreAggregateRunIds: [], resetSources: [], sourceErrors: [], at: 1000, coverageEdges };
}

const sessionSql = `SELECT SUM(aic) AS aic, MAX(possible_overlap) AS overlap FROM (${countedUsageSql("c.session_id=? AND c.ts>=? AND c.ts<?", "c.aic, c.run_id, c.is_report, c.source_file, c.source_kind", "calls_session_read", true)})`;

// Observe the real statements without replacing execution or copying ledger SQL.
function observedLedger(file: string) {
  const queries: string[] = [];
  const prepare = Database.prototype.prepare;
  const spy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, sql: string) {
    queries.push(sql);
    return prepare.call(this, sql);
  });
  try {
    const ledger = openUsageLedger(file);
    return { ledger, queries };
  } finally { spy.mockRestore(); }
}

function plan(db: Db, sql: string, params: (string | number)[] = []): string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map(row => row.detail);
}

function assertNoAllTimeCallScan(details: string[]) {
  // c/r also alias materialized coverage/report CTEs, which may be scanned.
  // The calls window's c alias is checked separately by assertRangePlan.
  // These aliases refer only to calls; none may scan all historical detail.
  for (const detail of details.filter(detail => /\bSCAN (?:calls|d|prior|active|o)\b/.test(detail))) {
    expect(detail).toMatch(/USING (?:COVERING )?INDEX calls_(?:reports|health_reports|health_unpriced)\b/);
  }
}

function assertRangePlan(db: Db, sql: string, index: "calls_period_read" | "calls_session_read", params: (string | number)[]) {
  const details = plan(db, sql, params);
  const bounds = index === "calls_session_read" ? "session_id=? AND ts>? AND ts<?" : "ts>? AND ts<?";
  expect(details.map(detail => detail.replace("USING COVERING INDEX", "USING INDEX")))
    .toContain(`SEARCH c USING INDEX ${index} (${bounds})`);
  assertNoAllTimeCallScan(details);
}

function assertReadPlans(db: Db, queries: string[], start: number, end: number, sessionId: string) {
  const monthSql = queries.find(sql => sql.startsWith("SELECT COALESCE(SUM(aic), 0) AS aic"));
  expect(monthSql).toBeDefined();
  assertRangePlan(db, monthSql!, "calls_period_read", [start, end]);
  assertRangePlan(db, sessionSql, "calls_session_read", [sessionId, start, end]);
  for (const index of ["calls_health_reports", "calls_health_unpriced"]) {
    const sql = queries.find(sql => sql.includes(`INDEXED BY ${index}`));
    expect(sql).toBeDefined();
    const details = plan(db, sql!);
    expect(details.some(detail => new RegExp(`(?:SEARCH|SCAN) c USING (?:COVERING )?INDEX ${index}\\b`).test(detail))).toBe(true);
    if (index === "calls_health_reports") {
      expect(details.some(detail => detail.startsWith("SEARCH ledger_totals USING INTEGER PRIMARY KEY"))).toBe(true);
    }
    assertNoAllTimeCallScan(details);
  }
}

it.each(["calls_period_read", "calls_session_read"] as const)("rejects a read plan with %s dropped", index => {
  const root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "usage-plan-"));
  const file = join(root, "usage.db"), { ledger, queries } = observedLedger(file), db = openDb(file);
  try {
    ledger.apply(batch([call("parent")]));
    const sql = index === "calls_period_read"
      ? queries.find(sql => sql.startsWith("SELECT COALESCE(SUM(aic), 0) AS aic"))! : sessionSql;
    const params = index === "calls_period_read" ? [0, 200] : ["parent", 0, 200];
    db.exec("BEGIN");
    try {
      db.exec(`DROP INDEX ${index}`);
      expect(() => assertRangePlan(db, sql, index, params)).toThrow(`no such index: ${index}`);
    } finally { db.exec("ROLLBACK"); }
    assertRangePlan(db, sql, index, params);
  } finally { db.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); }
});

// The missing outer reports exercise read-time recursive exclusion as well as the
// 500-run parent tail that formerly fanned out to all session runs under the lock.
it("meets the 500-run, 20000-row write and total-query budgets", () => {
  const root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "usage-perf-"));
  const file = join(root, "usage.db"), { ledger, queries } = observedLedger(file);
  const db = openDbReadOnly(file)!;
  try {
    const calls: CallRow[] = [], edges: CoverageEdge[] = [];
    for (let r = 0; r < 500; r++) {
      calls.push(call(`report-${r}`, { runId: `R${r}`, actor: "subagent", aggregate: true,
        parentRunId: r % 2 ? `R${r - 1}` : null }));
      if (r % 2) edges.push({ reportRunId: `R${r - 1}`, includedRunId: `R${r}`, evidence: "runs-db" });
      if (r % 2) for (let d = 0; d < 70; d++) calls.push(call(`R${r}-${d}`, {
        runId: `R${r}`, parentRunId: `R${r - 1}`, sourceFile: `R${r}.jsonl`, sessionId: `R${r}`, actor: "subagent" }));
    }
    for (let n = 0; n < 2000; n++) calls.push(call(`parent-${n}`));
    expect(calls).toHaveLength(20000);
    for (let n = 0; n < calls.length; n += 1000) ledger.apply(batch(calls.slice(n, n + 1000), n === 0 ? edges : []));
    expect(ledger.health().calls).toBe(20000);
    const startBatch = performance.now();
    ledger.apply(batch(Array.from({ length: 1000 }, (_, n) => call(`batch-${n}`))));
    const batchMs = performance.now() - startBatch;
    const startAppend = performance.now(); ledger.apply(batch([call("tail")]));
    const appendMs = performance.now() - startAppend;
    const startSession = performance.now();
    const session = db.prepare(sessionSql).get("parent", 0, 200);
    const sessionMs = performance.now() - startSession;
    const startMonth = performance.now(); const month = ledger.summarize(0, 200);
    const monthMs = performance.now() - startMonth;
    console.log("LEDGER_PERF", JSON.stringify({ runs: 500, initialRows: 20000, batchRows: 1000, batchMs, appendMs, sessionMs, monthMs }));
    expect(session).toEqual({ aic: 3251, overlap: 0 }); // 3001 parent calls + 250 outer reports.
    expect(month.aic).toBe(3251);
    assertReadPlans(db, queries, 0, 200, "parent");
    // Plans protect bounded reads deterministically. 10x the original timings
    // leave room for shared CI scheduling/IO while still catching disasters.
    expect(batchMs).toBeLessThan(3000);
    expect(appendMs).toBeLessThan(200);
    expect(sessionMs).toBeLessThan(2000);
    expect(monthMs).toBeLessThan(2000);
  } finally { db.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); }
}, 120000);

// Keep the same twelve-month shape (200 calls/run, 50 parent calls/run,
// missing every eighth transcript), but separate plan protection from scale.
function yearFixture(runCount: 40 | 4000, checkPlans: boolean) {
  const root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "usage-year-perf-"));
  const file = join(root, "usage.db"), { ledger, queries } = observedLedger(file), db = openDb(file);
  const startSeed = performance.now();
  try {
    let pending: CallRow[] = [];
    let runs: ImportBatch["runs"][number][] = [];
    for (let r = 0; r < runCount; r++) {
      const ts = 1000 * (r % 12), parentRunId = r % 4 ? `R${r - r % 4}` : null;
      const calls = r % 8 === 0 ? [] : Array.from({ length: 200 }, (_, n) => call(`c${r}-${n}`, {
        ts: ts + 10, runId: `R${r}`, actor: "subagent", parentRunId,
        sourceFile: `child${r}.jsonl`, sessionId: `child${r}` }));
      calls.push(call(`rep${r}`, { ts: ts + 20, runId: `R${r}`, actor: "subagent", aggregate: true,
        sourceFile: `parent${r % 12}.jsonl`, sessionId: `parent${r % 12}`,
        usage: { input: 200, output: 0, cacheRead: 0, cacheWrite: 0 },
        price: { status: "priced", aic: 200, components: { input: 200, output: 0, cacheRead: 0, cacheWrite: 0 },
          rateVersion: "fixture", tier: "default", confidence: "verified" } }));
      calls.push(...Array.from({ length: 50 }, (_, n) => call(`p${r}-${n}`, {
        ts: ts + 5, sourceFile: `parent${r % 12}.jsonl`, sessionId: `parent${r % 12}` })));
      pending.push(...calls);
      runs.push({ id: `R${r}`, dbPath: "fixture.db", project: null, repo: null, sessionId: `child${r}`,
        parentRunId, agent: null, role: null, name: null, model: null, thinking: null, phase: null,
        startedAt: ts, endedAt: ts + 30 });
      if (r % 10 === 9) { ledger.apply({ ...batch(pending), runs }); pending = []; runs = []; }
    }
    const seedMs = performance.now() - startSeed;
    const rows = runCount * 226;
    expect(db.prepare("SELECT COUNT(*) AS n FROM calls").get()).toEqual({ n: rows });
    // Neither ledger open/apply nor the DB wrapper runs ANALYZE/optimize.
    // Fail if that changes, rather than silently relying on row-count-free plans.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").all()).toEqual([]);
    if (checkPlans) {
      const assertYearPlans = () => {
        for (let month = 0; month < 12; month++) assertReadPlans(db, queries, month * 1000, (month + 1) * 1000, `parent${month}`);
      };
      assertYearPlans();
      // Imported ledgers may have statistics even though spider never makes
      // them. Prove range/partial-index access on this ~10k fixture both ways.
      db.exec("ANALYZE; PRAGMA optimize;");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").all().length).toBeGreaterThan(0);
      assertYearPlans();
    }
    const monthTimes: number[] = [];
    let summary = ledger.summarize(0, 1000);
    for (let month = 0; month < 12; month++) {
      const startMonth = performance.now();
      const current = ledger.summarize(month * 1000, (month + 1) * 1000);
      monthTimes.push(performance.now() - startMonth);
      if (month === 0) summary = current;
      const monthRuns = Math.floor((runCount - 1 - month) / 12) + 1;
      expect(current.aic).toBe(monthRuns * 250);
    }
    const startHealth = performance.now(); const health = ledger.health();
    const healthMs = performance.now() - startHealth;
    const startSession = performance.now();
    const session = db.prepare(sessionSql)
      .get("parent0", 0, 1000);
    const sessionMs = performance.now() - startSession;
    expect(health.calls).toBe(rows);
    expect(summary.aic).toBe(runCount === 40 ? 1000 : 83500); expect(summary.possibleOverlap).toBe(true);
    expect(session).toEqual({ aic: runCount === 40 ? 600 : 50100, overlap: 1 });
    return { rows, months: 12, seedMs, monthTimes, worstMonthMs: Math.max(...monthTimes), sessionMs, healthMs };
  } finally { db.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); }
}

it("bounds month and session reads with overlap at 9040 all-time rows, with and without statistics", () => {
  yearFixture(40, true);
});

// Same local-only opt-in convention as the calibration benchmarks. Unlike
// the regression tests, elapsed times are measurements, never pass/fail gates.
const benchmarkEnabled = process.env.SPIDER_USAGE_BENCHMARK === "1";
if (!benchmarkEnabled) console.log("SKIP ledger 904000-row benchmark: set SPIDER_USAGE_BENCHMARK=1 locally (refused in CI)");
it.skipIf(!benchmarkEnabled)("measures 904000 all-time rows (local opt-in only)", async () => {
  if (process.env.CI) throw new Error("local ledger benchmark refuses CI");
  const { loadavg } = await import("node:os");
  const beforeLoad = loadavg();
  const start = performance.now();
  const report = yearFixture(4000, false);
  console.log("LEDGER_YEAR_PERF", JSON.stringify({ ...report, totalMs: performance.now() - start, beforeLoad, afterLoad: loadavg() }));
}, 1800000);
