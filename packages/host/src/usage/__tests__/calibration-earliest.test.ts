import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCalibrationService } from "../calibration.js";
import type { CalibrationService } from "../dashboard-contract.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_DAY as DAY, DASHBOARD_MONTH as START, type DashboardFixture } from "./fixtures/dashboard-ledger.js";
import { seedCalibrationHistory } from "./fixtures/calibration-history.js";

let f: DashboardFixture, service: CalibrationService, revision: string;
beforeEach(() => { f = createDashboardFixture(false); revision = "fixture-1"; service = createCalibrationService(f.db, { revision: () => revision }); });
afterEach(() => { vi.restoreAllMocks(); f.close(); });
const counter = (day: number, creditsUsed: number, extra = {}) => f.ledger.insertCounter({ ts: START + day * DAY, creditsUsed, raw: {}, ...extra });
const call = (id: string, day: number, aic: number) => dashboardCall(id, { ts: START + day * DAY,
  price: { status: "priced", aic, components: { input: aic, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "fixture", tier: "fixture", confidence: "estimated" } });

// Kills whole-history materialization: absence may require all history, but
// neither snapshot reads nor interval binds may grow with ledger age.
it("earliest no-fit discovery bounds snapshot pages and interval binds", () => {
  seedCalibrationHistory(f, 30, false);
  const prepare = f.db.prepare.bind(f.db);
  const pageSizes: number[] = [], bindSizes: number[] = [];
  vi.spyOn(f.db, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (sql.includes("AS credits") && sql.includes("ORDER BY ts,rowid")) {
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...args) => {
        const rows = all(...args); pageSizes.push(rows.length); return rows;
      });
    }
    if (sql.includes("calls_period_read")) {
      for (const method of ["all", "iterate"] as const) {
        const read = statement[method].bind(statement);
        vi.spyOn(statement, method).mockImplementation((...args: unknown[]) => {
          bindSizes.push(JSON.parse(args[0] as string).length);
          return read(...args) as never;
        });
      }
    }
    return statement;
  });
  expect(service.earliest("auto").status).toBe("uncalibrated");
  expect(pageSizes.reduce((a, b) => a + b, 0)).toBe(30 * 144 + 1);
  expect(Math.max(...pageSizes)).toBeLessThanOrEqual(512);
  expect(Math.max(...bindSizes)).toBeLessThanOrEqual(512);
});

it("earliest stops call aggregation in the first chunk containing a fit", () => {
  seedCalibrationHistory(f, 365, true);
  const prepare = f.db.prepare.bind(f.db);
  let snapshots = 0;
  vi.spyOn(f.db, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (sql.includes("AS credits") && sql.includes("ORDER BY ts,rowid")) {
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...args) => {
        const rows = all(...args); snapshots += rows.length; return rows;
      });
    }
    return statement;
  });
  expect(service.earliest("auto")).toMatchObject({ status: "calibrated", windowEnd: START + DAY });
  expect(snapshots).toBeLessThanOrEqual(512);
});

it("earliest survives newer snapshot generations but invalidates earlier duplicates and call revisions", () => {
  f.ledger.apply(dashboardBatch([call("first", 0, 1000)])); counter(0, 0); counter(1, 500);
  const prepare = vi.spyOn(f.db, "prepare");
  const passes = () => prepare.mock.calls.filter(([sql]) => sql.includes("calls_period_read")).length;
  const first = service.earliest("auto"); expect(first.factor).toBe(0.5); expect(passes()).toBe(1);
  counter(2, 600);
  service.at(START + 2 * DAY, "auto"); // warming another generation must not erase earliest
  const warmed = passes();
  expect(service.earliest("auto")).toEqual(first); expect(passes()).toBe(warmed);
  counter(3, -1); // later invalid data also cannot change the earlier window
  expect(service.earliest("auto")).toEqual(first); expect(passes()).toBe(warmed);
  counter(1, 250); // a duplicate at the fit endpoint CAN change it
  expect(service.earliest("auto").factor).toBe(0.25); expect(passes()).toBe(warmed + 1);
  f.db.prepare("UPDATE calls SET aic=2000").run(); revision = "fixture-2";
  service.at(START + 2 * DAY, "auto");
  expect(service.earliest("auto").factor).toBe(0.125);
});

it("earliest slides whole pairs, dropping too-old and reset evidence before a later fit", () => {
  f.ledger.apply(dashboardBatch([call("old", 0.5, 1000), call("spanning-reset", 5, 9000), call("first", 9, 600),
    { ...call("unpriced", 9, 0), price: { status: "unpriced", reason: "unknown-model" } },
    { ...call("reset-unpriced", 5, 0), price: { status: "unpriced", reason: "unknown-model" } }]));
  counter(0, 0); counter(1, 3000); // implausible, not a fit
  counter(8, 4000, { resetDate: "next" });
  counter(10, 4300, { resetDate: "next" });
  expect(service.earliest("auto")).toMatchObject({ status: "calibrated", factor: 0.5, windowStart: START + 3 * DAY,
    windowEnd: START + 10 * DAY, computedAic: 600, counterDelta: 300, coveredHours: 48, unpricedCalls: 1 });
});

it("earliest handles duplicate validity and backwards appends without bridging gaps", () => {
  f.ledger.apply(dashboardBatch([call("before", 0, 500), call("gap", 1, 9000), call("after", 2, 600)]));
  counter(0, 0); counter(1, 250, { entitlement: -1 }); counter(2, 300); counter(3, 600); counter(3, -1);
  counter(2.5, 450); // backwards append rejects [2d,2.5d), but [2.5d,3d) remains accepted
  expect(service.earliest("auto").status).toBe("uncalibrated");
  counter(1, 250); // latest valid duplicate repairs the first pair; later invalid duplicate at 3d still cannot win
  expect(service.earliest("auto")).toMatchObject({ status: "calibrated", windowEnd: START + DAY, computedAic: 500,
    coveredHours: 24, counterDelta: 250, factor: 0.5 });
});

it("earliest memoizes absence and fit per snapshot rowid and revision, including off to auto", () => {
  f.ledger.apply(dashboardBatch([call("first", 0, 1000)])); counter(0, 0); counter(1, 0);
  const prepare = vi.spyOn(f.db, "prepare");
  const passes = () => prepare.mock.calls.filter(([sql]) => sql.includes("calls_period_read")).length;
  expect(service.earliest("auto").status).toBe("uncalibrated"); expect(passes()).toBe(1);
  service.earliest("auto"); expect(passes()).toBe(1);
  f.db.prepare("INSERT INTO ledger_metadata(key,value) VALUES ('coordination','one')").run();
  service.earliest("auto"); expect(passes()).toBe(1);
  expect(service.earliest("off").status).toBe("off"); expect(passes()).toBe(1);
  counter(1, 500);
  expect(service.earliest("auto")).toMatchObject({ windowEnd: START + DAY, factor: 0.5 }); expect(passes()).toBe(2);
  f.db.prepare("UPDATE calls SET aic=2000").run(); revision = "fixture-2";
  expect(service.earliest("auto").factor).toBe(0.25); expect(passes()).toBe(3);
  const result = service.earliest("auto"); result.factor = 99;
  expect(service.earliest("auto").factor).toBe(0.25); expect(passes()).toBe(3);
});

it.skipIf(process.env.T1A_EARLIEST_BENCHMARK !== "1")("synthetic earliest cost with and without fits (local opt-in)", async () => {
  const { writeFileSync } = await import("node:fs");
  const { loadavg } = await import("node:os");
  if (process.env.CI) throw new Error("local earliest benchmark refuses CI");
  const results = [];
  for (const days of [30, 120, 365]) {
    for (const fits of [false, true]) {
      seedCalibrationHistory(f, days, fits);
      const beforeLoad = loadavg();
      const coldMs: number[] = [], warmMs: number[] = [];
      let fit;
      for (let sample = 0; sample < 3; sample++) {
        const service = createCalibrationService(f.db, { revision: () => "synthetic-benchmark" });
        let start = performance.now(); fit = service.earliest("auto"); coldMs.push(performance.now() - start);
        start = performance.now(); service.earliest("auto"); warmMs.push(performance.now() - start);
      }
      expect(fit!.status).toBe(fits ? "calibrated" : "uncalibrated");
      if (fits) {
        expect(fit!.windowEnd).toBe(START + DAY);
        expect(fit!.factor).toBeCloseTo(0.5);
      }
      results.push({ days, fits, snapshots: days * 144 + 1, calls: days * 500, coldMs, warmMs, beforeLoad, afterLoad: loadavg() });
    }
  }
  console.log("SYNTHETIC EARLIEST COST", JSON.stringify(results));
  if (process.env.T1A_EARLIEST_BENCH_OUT) writeFileSync(process.env.T1A_EARLIEST_BENCH_OUT, JSON.stringify(results, null, 2));
}, 120000);

// Filtering corrupt timestamps in SQL would silently bridge this invalid observation.
it("earliest treats non-integer snapshot timestamps as gaps, just like at", () => {
  const ins = f.db.prepare("INSERT INTO counter_snapshots(ts,account_login,credits_used,reset_date,raw) VALUES (?,'a',?,'R','{}')");
  ins.run(START, 0); ins.run(START + DAY / 2 + 0.5, 100); ins.run(START + DAY, 500);
  f.ledger.apply(dashboardBatch([call("noninteger-gap", 0, 1000)]));
  expect(service.at(START + DAY, "auto")).toMatchObject({ status: "uncalibrated", coveredHours: 0, computedAic: 0, counterDelta: 0 });
  expect(service.earliest("auto")).toMatchObject({ status: "uncalibrated", factor: null, coveredHours: 0 });
});
