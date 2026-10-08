import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "@spider/db-core";
import { openDashboardReader } from "../dashboard-reader.js";
import type { DashboardQueryContext } from "../dashboard-contract.js";
import { createCalibrationService } from "../calibration.js";
import { migrateUsageLedger } from "../migrate.js";
import { queryCache } from "../query-cache.js";
import { queryRates } from "../query-rates.js";
import { queryReconciliation } from "../query-reconciliation.js";
import { seedSelectionBenchmark } from "./fixtures/selection-v3.js";
import { DASHBOARD_MONTH as M, DASHBOARD_DAY as D } from "./fixtures/dashboard-ledger.js";

let root: string, file: string, db: Db;
beforeEach(() => {
  root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "analysis-selection-"));
  file = join(root, "ledger.db");
  db = openDb(file);
  seedSelectionBenchmark(db, 80, M, M + 3 * D);
  // Non-copied duplicate plus the fixture's copied shadows. Selection must
  // exclude both kinds, not just copied=1. Open runs and partial imports are
  // seeded independently; also cover incomplete report evidence.
  db.exec("UPDATE calls SET fingerprint='fp-0' WHERE id='call-00000002'");
  db.exec("INSERT INTO incomplete_reports(path,run_id) VALUES ('source-5','run-5')");
  db.exec("UPDATE calls SET actor='warmer' WHERE id='call-00000003'");
  db.exec("UPDATE calls SET cache_read=0 WHERE session_id IN ('session-4','session-5','session-6')");
  db.exec("UPDATE calls SET cache_write_1h=10 WHERE id='call-00000004'");
  db.exec("UPDATE calls SET price_status='unpriced',unpriced_reason='unknown-model',aic=NULL,aic_input=NULL,aic_output=NULL,aic_cache_read=NULL,aic_cache_write=NULL,rate_version=NULL,tier=NULL,confidence=NULL WHERE id IN ('call-00000006','call-00000007')");
  const counter = db.prepare("INSERT INTO counter_snapshots VALUES (?,'synthetic-seat',?,10000,?,'2026-11-01','{}')");
  for (let day = 0; day <= 3; day++) counter.run(M + day * D, day * 100, 10000 - day * 100);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(root, { recursive: true, force: true }); });

function read<T>(mode: "off" | "auto", run: (ctx: DashboardQueryContext) => T): T {
  const reader = openDashboardReader(file, { instanceId: "synthetic", serverBuild: "fixture", now: () => M + 4 * D, calibrationMode: () => mode })!;
  try {
    // Pin the transport identity only: a reader restart legitimately changes
    // cursors, whereas this test compares every response byte including cursors.
    return reader.snapshot(ctx => run({ ...ctx, revision: "synthetic:fixed", instanceId: "synthetic:fixed",
      calibration: createCalibrationService(ctx.db, { revision: () => "synthetic:fixed" }) }));
  } finally { reader.close(); }
}
const slice = { start: M, end: M + 3 * D, filters: [] };
function responses(ctx: DashboardQueryContext) {
  const cache = queryCache(ctx, slice, { limit: 1 });
  const rates = queryRates(ctx, slice, { limit: 1 });
  const reconciliation = queryReconciliation(ctx, slice, { bucket: "snapshot", limit: 1 });
  return {
    cache, cacheNext: queryCache(ctx, slice, { limit: 1, cursor: cache.sessionsWithWritesNoReads.nextCursor! }),
    rates, ratesNext: queryRates(ctx, slice, { limit: 1, cursor: rates.nextCursor! }),
    reconciliation, reconciliationNext: queryReconciliation(ctx, slice, { bucket: "snapshot", limit: 1, cursor: reconciliation.periods.nextCursor! }),
    day: queryReconciliation(ctx, slice, { bucket: "day", limit: 50 }),
    month: queryReconciliation(ctx, slice, { bucket: "month", limit: 50 }),
  };
}

it.each(["off", "auto"] as const)("Task 8 responses are byte identical on unmigrated v2 and migrated v3 (%s)", mode => {
  expect(db.pragma("user_version")).toBe(2);
  const before = read(mode, responses);
  expect(before.cache.totals.calls).toBe(75); // Four copied calls and one native shadow.
  expect(before.cache.totals.possibleUndercount).toBe(true);
  expect(before.cache.totals.unpricedCalls).toBe(2);
  expect(before.cache.warmer.calls).toBe(1);
  expect(before.cache.writeSplit.knownCalls).toBe(1);
  expect(before.cache.writeSplit.unknownCalls).toBe(74);
  expect(before.cache.sessionsWithWritesNoReads.nextCursor).not.toBeNull();
  expect(before.rates.unpricedModels.nextCursor).not.toBeNull();
  expect(before.reconciliation.periods.rows[0]!.computed!.calls).toBeGreaterThan(0);
  migrateUsageLedger(db);
  expect(db.pragma("user_version")).toBe(4);
  const after = read(mode, responses);
  // Task 8 has no Overview cube rounding. Counts and all AIC fields are exact.
  expect(after).toEqual(before);
  expect(JSON.stringify(after)).toBe(JSON.stringify(before));
});

const endpoints = [
  { name: "Cache", occurrences: 3, run: (ctx: DashboardQueryContext) => queryCache(ctx, slice, { limit: 1 }) },
  { name: "Rates", occurrences: 2, run: (ctx: DashboardQueryContext) => queryRates(ctx, slice, { limit: 1 }) },
  { name: "Reconciliation", occurrences: 1, run: (ctx: DashboardQueryContext) => queryReconciliation(ctx, slice, { bucket: "day" as const, limit: 50 }) },
];
it.each(endpoints)("$name reads stored decisions on v3 and dynamic decisions on v2", endpoint => {
  const capture = () => read("off", ctx => {
    const sql: string[] = [];
    const original = ctx.db.prepare.bind(ctx.db);
    const spy = vi.spyOn(ctx.db, "prepare").mockImplementation(statement => {
      if (statement.includes("window AS MATERIALIZED")) sql.push(statement);
      return original(statement);
    });
    try { endpoint.run(ctx); } finally { spy.mockRestore(); }
    return sql.join("\n");
  });
  const dynamic = capture();
  expect(dynamic).not.toMatch(/selection_shadowed|selection_undercount/);
  expect(dynamic.match(/prior\.fingerprint/g)).toHaveLength(2 * endpoint.occurrences);
  migrateUsageLedger(db);
  const stored = capture();
  // This spy kills a dynamic-on-v3 mutant even when its DTO is identical.
  // Check every selection subquery, including Cache's global session probe
  // and Rates' narrow stored-rate-version projection.
  expect(stored.match(/c\.selection_shadowed = 0/g)).toHaveLength(endpoint.occurrences);
  expect(stored.match(/w\.selection_undercount AS possible_undercount/g)).toHaveLength(endpoint.occurrences);
  expect(stored).toContain("active.selection_shadowed = 0");
  expect(stored).not.toMatch(/prior\.fingerprint|FROM incomplete_reports i|WHERE r\.id = w\.run_id/);
  const windows = [...stored.matchAll(/window AS MATERIALIZED \(SELECT (.*?) FROM calls c /g)].map(match => match[1]!);
  expect(windows).toHaveLength(endpoint.occurrences);
  for (const projection of windows) expect(projection).not.toMatch(/c\.\*|c\.role\b|c\.source_kind\b/);
  if (endpoint.name !== "Cache") for (const projection of windows) expect(projection).not.toMatch(/c\.ts\b|c\.actor\b/);
});
