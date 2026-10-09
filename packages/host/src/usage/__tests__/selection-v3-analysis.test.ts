import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "@spider/db-core";
import { openDashboardReader } from "../dashboard-reader.js";
import type { DashboardQueryContext } from "../dashboard-contract.js";
import { createCalibrationService } from "../calibration.js";
import { migrateUsageLedger } from "../migrate.js";
import { readMeasure } from "../dashboard-selection.js";
import { readUsageCube } from "../query-redesign-shared.js";
import { readCounterIntervals } from "../counter-intervals.js";
import { customRange } from "./fixtures/redesign-range.js";
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
  return { measure: readMeasure(ctx, slice), warmer: readMeasure(ctx, { ...slice, filters: [{ field: "actor", value: "warmer" }] }), intervals: readCounterIntervals(ctx, slice) };
}
it.each(["off", "auto"] as const)("replacement aggregates are identical before and after migration (%s)", mode => {
  expect(db.pragma("user_version")).toBe(2);
  const before = read(mode, responses);
  expect(before.measure.calls).toBe(75); expect(before.measure.unpricedCalls).toBe(2);
  expect(before.warmer.calls).toBe(1);
  expect(before.intervals).toHaveLength(3);
  migrateUsageLedger(db); expect(db.pragma("user_version")).toBe(5);
  expect(read(mode, responses)).toEqual(before);
  expect(read(mode, ctx => readUsageCube(ctx, customRange(slice.start, slice.end))).total.calls).toBe(75);
});
it.each(["cube", "intervals"] as const)("%s switches from dynamic to stored decisions after migration", endpoint => {
  const capture = () => read("off", ctx => {
    const sql: string[] = [], prepare = ctx.db.prepare.bind(ctx.db);
    const spy = vi.spyOn(ctx.db, "prepare").mockImplementation(statement => { if (statement.includes("window AS MATERIALIZED")) sql.push(statement); return prepare(statement); });
    try { if (endpoint === "cube") readMeasure(ctx, slice); else readCounterIntervals(ctx, slice); } finally { spy.mockRestore(); }
    expect(sql.length).toBeGreaterThan(0); return sql.join("\n");
  });
  const dynamic = capture(); expect(dynamic).toContain("prior.fingerprint");
  migrateUsageLedger(db); const stored = capture();
  expect(stored).toContain("c.selection_shadowed = 0"); expect(stored).not.toContain("prior.fingerprint");
});
