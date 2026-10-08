import { expect, it } from "vitest";
import type { Db } from "@spider/db-core";
import { createCalibrationService } from "../calibration.js";
import type { DashboardQueryContext } from "../dashboard-contract.js";
import { loadavg } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDb } from "@spider/db-core";
import { migrateUsageLedger } from "../migrate.js";
import { openDashboardReader } from "../dashboard-reader.js";
import { readUsageCube } from "../query-redesign-shared.js";
import { customRange } from "./fixtures/redesign-range.js";
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
      const slice = customRange(start, end);
      const time = (run: () => unknown) => {
        run(); // unrecorded warmup; no other work runs during the samples.
        const beforeLoad = loadavg(), samples = [];
        for (let i = 0; i < 10; i++) { const start = performance.now(); run(); samples.push(performance.now() - start); }
        return { beforeLoad, afterLoad: loadavg(), samples, p95: [...samples].sort((a, b) => a - b)[9] };
      };
      const overviewBefore = time(() => reader!.snapshot(ctx => readUsageCube({ ...ctx, db: dynamicSelectionDb(ctx.db) }, slice)));
      const overviewAfter = time(() => reader!.snapshot(ctx => readUsageCube(ctx, slice)));
      reader.snapshot(ctx => expect(JSON.stringify(readUsageCube(ctx, slice)) === JSON.stringify(readUsageCube({ ...ctx, db: dynamicSelectionDb(ctx.db) }, slice))).toBe(true));
      const groupedSql = (stored: boolean) => `SELECT actor,role,model,${measureColumns} FROM (${countedUsageSql("c.ts>=? AND c.ts<?", "c.*", "calls_period_read", stored)}) GROUP BY actor,role,model LIMIT 51`;
      const filterSql = (stored: boolean) => `SELECT DISTINCT project FROM (${countedUsageSql("c.ts>=? AND c.ts<?", "c.*", "calls_period_read", stored)}) ORDER BY project LIMIT 201`;
      const explorerBefore = time(() => db.prepare(groupedSql(false)).all(start, end));
      const explorerAfter = time(() => db.prepare(groupedSql(true)).all(start, end));
      const filterBefore = time(() => db.prepare(filterSql(false)).all(start, end));
      const filterAfter = time(() => db.prepare(filterSql(true)).all(start, end));
      const statements = reader.snapshot(ctx => statementBreakdown(ctx.db, observed => readUsageCube({ ...ctx, db: observed }, slice)));
      reports.push({ rows, migrationMs, overviewBefore, overviewAfter, explorerBefore, explorerAfter, filterBefore, filterAfter, statements });
    } finally { reader?.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
  }
  const out = resolve(process.env.SPIDER_TEST_FIXTURE_CHECKOUT!, ".spider/scratch/usage-ui/t1b");
  mkdirSync(out, { recursive: true }); writeFileSync(join(out, "synthetic-timings.json"), JSON.stringify(reports, null, 2));
  console.log("SELECTION_TIMINGS", JSON.stringify(reports.map(({ statements, ...timings }) => timings)));
}, 600000);
