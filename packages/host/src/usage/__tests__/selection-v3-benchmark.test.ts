import { expect, it } from "vitest";
import type { Db } from "@spider/db-core";
import { phase2CompositionProvider } from "../composition-provider.js";
import { createCalibrationService } from "../calibration.js";
import type { DashboardQueryContext } from "../dashboard-contract.js";
import { loadavg } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDb } from "@spider/db-core";
import { migrateUsageLedger } from "../migrate.js";
import { openDashboardReader } from "../dashboard-reader.js";
import { queryOverview } from "../query-overview.js";
import { countedUsageSql } from "../schema.js";
import { measureColumns } from "../dashboard-selection.js";
import { dynamicSelectionDb, seedSelectionBenchmark } from "./fixtures/selection-v3.js";

function statementBreakdown(db: Db, read: (observed: Db) => unknown) {
  const statements: { sql: string; elapsedMs: number; plan: unknown[] }[] = [];
  const observed = new Proxy(db, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      const statement = target.prepare(sql);
      return new Proxy(statement, { get(stmt, method) {
        if (method === "all" || method === "get") return (...params: (string | number | null)[]) => {
          const start = performance.now(); const result = stmt[method](...params); const elapsedMs = performance.now() - start;
          statements.push({ sql, elapsedMs, plan: target.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) }); return result;
        };
        const value = Reflect.get(stmt, method); return typeof value === "function" ? value.bind(stmt) : value;
      } });
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  read(observed); return statements;
}

const enabled = process.env.SPIDER_USAGE_T1B_BENCHMARK === "1";
it.skipIf(!enabled)("measures sequential Overview and grouped selection at 60000 and 175000 synthetic rows", () => {
  if (process.env.CI) throw new Error("local benchmark refuses CI");
  const reports = [];
  for (const rows of [60000, 175000]) {
    const root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "selection-benchmark-"));
    const file = join(root, "ledger.db"), db = openDb(file);
    const start = Date.UTC(2026, 0, 1), end = Date.UTC(2026, 0, 31);
    let reader: ReturnType<typeof openDashboardReader>;
    try {
      seedSelectionBenchmark(db, rows, start, end);
      const migrationStart = performance.now(); migrateUsageLedger(db); const migrationMs = performance.now() - migrationStart;
      reader = openDashboardReader(file, { instanceId: "synthetic", serverBuild: "synthetic", now: () => end, calibrationMode: () => "off" })!;
      const slice = { start, end, filters: [] };
      const time = (run: () => unknown) => {
        run(); // unrecorded warmup; no other work runs during the samples.
        const beforeLoad = loadavg(), samples = [];
        for (let i = 0; i < 10; i++) { const start = performance.now(); run(); samples.push(performance.now() - start); }
        return { beforeLoad, afterLoad: loadavg(), samples, p95: [...samples].sort((a, b) => a - b)[9] };
      };
      const overviewBefore = time(() => reader!.snapshot(ctx => queryOverview({ ...ctx, db: dynamicSelectionDb(ctx.db) }, slice)));
      const overviewAfter = time(() => reader!.snapshot(ctx => queryOverview(ctx, slice)));
      reader.snapshot(ctx => expect(JSON.stringify(queryOverview(ctx, slice)) === JSON.stringify(queryOverview({ ...ctx, db: dynamicSelectionDb(ctx.db) }, slice))).toBe(true));
      const groupedSql = (stored: boolean) => `SELECT actor,role,model,${measureColumns} FROM (${countedUsageSql("c.ts>=? AND c.ts<?", "c.*", "calls_period_read", stored)}) GROUP BY actor,role,model LIMIT 51`;
      const filterSql = (stored: boolean) => `SELECT DISTINCT project FROM (${countedUsageSql("c.ts>=? AND c.ts<?", "c.*", "calls_period_read", stored)}) ORDER BY project LIMIT 201`;
      const explorerBefore = time(() => db.prepare(groupedSql(false)).all(start, end));
      const explorerAfter = time(() => db.prepare(groupedSql(true)).all(start, end));
      const filterBefore = time(() => db.prepare(filterSql(false)).all(start, end));
      const filterAfter = time(() => db.prepare(filterSql(true)).all(start, end));
      const statements = reader.snapshot(ctx => statementBreakdown(ctx.db, observed => queryOverview({ ...ctx, db: observed }, slice)));
      reports.push({ rows, migrationMs, overviewBefore, overviewAfter, explorerBefore, explorerAfter, filterBefore, filterAfter, statements });
    } finally { reader?.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
  }
  const out = resolve(process.env.SPIDER_TEST_FIXTURE_CHECKOUT!, ".spider/scratch/usage-ui/t1b");
  mkdirSync(out, { recursive: true }); writeFileSync(join(out, "synthetic-timings.json"), JSON.stringify(reports, null, 2));
  console.log("SELECTION_TIMINGS", JSON.stringify(reports.map(({ statements, ...timings }) => timings)));
}, 600000);

const copy = process.env.SPIDER_USAGE_T1B_REAL_COPY;
it.skipIf(!copy)("times backfill and preserves Overview bytes on the authorized consistent ledger copy", () => {
  if (process.env.CI) throw new Error("real-copy probe refuses CI");
  const allowed = resolve(process.env.SPIDER_TEST_FIXTURE_CHECKOUT!, ".spider/scratch/usage-ui/t1b/usage-copy.db");
  if (resolve(copy!) !== allowed) throw new Error("only the authorized scratch copy is allowed");
  const db = openDb(allowed);
  let reader: ReturnType<typeof openDashboardReader>;
  try {
    const summary = db.prepare("SELECT COUNT(*) AS rows,MAX(ts) AS latest FROM calls").get() as { rows: number; latest: number };
    const end = summary.latest + 1, date = new Date(end), start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    const options = { instanceId: "copy", serverBuild: "copy", now: () => end, calibrationMode: () => "off" as const };
    const slice = { start, end, filters: [] };
    const beforeCtx: DashboardQueryContext = { db, instanceId: "copy", revision: "copy", now: () => end,
      rates: [], composition: phase2CompositionProvider, calibrationMode: "off",
      calibration: createCalibrationService(db, { revision: () => "copy" }), status: () => { throw new Error("unused"); } };
    // A v1 copy intentionally has no reader revision. Use a deferred, aggregate-only
    // reference snapshot rather than altering the copied ledger before measuring.
    const before = db.raw.transaction(() => queryOverview(beforeCtx, slice)).deferred();
    const allBefore = db.prepare(`SELECT ${measureColumns} FROM (${countedUsageSql("1", "c.*", undefined, false)})`).get();
    const beforeLoad = loadavg(), migrationStart = performance.now(); migrateUsageLedger(db);
    const migrationMs = performance.now() - migrationStart, afterLoad = loadavg();
    reader = openDashboardReader(allowed, options)!;
    const after = reader.snapshot(ctx => queryOverview(ctx, slice));
    expect(JSON.stringify(before) === JSON.stringify(after)).toBe(true);
    const allAfter = db.prepare(`SELECT ${measureColumns} FROM (${countedUsageSql("1", "c.*", undefined, true)})`).get();
    expect(JSON.stringify(allBefore) === JSON.stringify(allAfter)).toBe(true);
    reader.snapshot(ctx => expect(JSON.stringify(queryOverview(ctx, slice)) === JSON.stringify(queryOverview({ ...ctx, db: dynamicSelectionDb(ctx.db) }, slice))).toBe(true));
    const out = resolve(process.env.SPIDER_TEST_FIXTURE_CHECKOUT!, ".spider/scratch/usage-ui/t1b");
    const report = { rows: summary.rows, migrationMs, beforeLoad, afterLoad, overviewByteIdentical: true, allTimeAggregateIdentical: true };
    writeFileSync(join(out, "real-copy-aggregates.json"), JSON.stringify(report, null, 2)); console.log("COPY_AGGREGATES", JSON.stringify(report));
  } finally {
    reader?.close(); db.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${allowed}${suffix}`, { force: true });
  }
}, 300000);
