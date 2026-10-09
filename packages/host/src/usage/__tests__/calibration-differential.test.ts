import { afterEach, expect, test, vi } from "vitest";
import { createCalibrationService } from "../calibration.js";
import { openDashboardReader } from "../dashboard-reader.js";
import { analysisFits, type AnalysisFit } from "./fixtures/calibration-endpoints.js";
import type { DashboardQueryContext } from "../dashboard-contract.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH as M, DASHBOARD_DAY as D, type DashboardFixture } from "./fixtures/dashboard-ledger.js";

let fixture: DashboardFixture | undefined;
let reader: ReturnType<typeof openDashboardReader>;
afterEach(() => { vi.restoreAllMocks(); reader?.close(); fixture?.close(); });
function random(seed: number) {
  return () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; };
}
function reference(ctx: DashboardQueryContext, ends: readonly number[]): AnalysisFit[] {
  const earliest = createCalibrationService(ctx.db, { revision: () => ctx.revision }).earliest(ctx.calibrationMode);
  return ends.map(end => {
    const point = Math.max(0, Math.min(end, ctx.now()) - 1);
    let calibration = createCalibrationService(ctx.db, { revision: () => ctx.revision }).at(point, ctx.calibrationMode);
    let basis: AnalysisFit["basis"] = calibration.status === "calibrated" ? "calibrated" : "published";
    if (ctx.calibrationMode !== "off" && calibration.status !== "calibrated" && earliest.status === "calibrated" && point < earliest.windowEnd!) {
      calibration = earliest; basis = "back-applied";
    }
    return { calibration, basis };
  });
}
function compare(got: readonly AnalysisFit[], want: readonly AnalysisFit[]) {
  expect(got).toHaveLength(want.length);
  expect(got).toEqual(want);
}
// Kills wrong inclusive boundaries, caller-order merge, skipped first/near-start
// windows, missing trailing/stale-anchor evidence and endpoint caps on fan-out.
test.each([false, true])("seeded history equals fresh single-endpoint lookup (fractional=%s)", fractional => {
  const r = random(0x811cab + Number(fractional));
  fixture = createDashboardFixture(false);
  const insert = fixture.db.prepare("INSERT INTO counter_snapshots VALUES (?,?,?,?,?,?,?)");
  const times: number[] = [];
  let ts = M - 9 * D, credits = 0, reset = "cycle-a";
  fixture.db.raw.transaction(() => {
    for (let i = 0; i < 320; i++) {
      if (i === 120) ts += 12 * D; // stale anchor, evidence far before query start
      else if (i) ts += i === 121 ? 1 : D / 16;
      times.push(ts);
      if (i === 210) { reset = "cycle-b"; credits = 0; }
      else if (i === 260) credits -= 10; // billing lag, not a reset
      else credits += 12 + Math.floor(r() * 20);
      const invalid = i === 118 || i === 119 || i === 180;
      insert.run(ts, "fixture-seat", invalid ? -1 : credits, 100000, 100000 - credits, reset, "{}");
      if (i === 80) insert.run(ts, "fixture-seat", credits + 1, 100000, 90000, reset, "{}");
    }
  })();
  fixture.ledger.apply(dashboardBatch(times.flatMap((t, i) => Array.from({ length: 3 }, (_, j) => {
    const aic = fractional ? Math.round((10 + r() * 30) * 100) / 100 : 10 + Math.floor(r() * 30);
    return dashboardCall(`diff-${i}-${j}`, { ts: t + j * 100, price: j === 2 && i % 17 === 0 ? { status: "unpriced", reason: "unknown-model" } : {
      status: "priced", aic, components: { input: aic, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "fixture", tier: "fixture", confidence: "estimated",
    } });
  }))));
  reader = openDashboardReader(fixture.file, { instanceId: "differential", now: () => ts + 10 * D, serverBuild: "fixture", calibrationMode: () => "auto" })!;
  // >200 distinct points, unsorted, duplicated, exactly at and just before snapshots.
  const ends = times.flatMap(t => [t + 1, t]).sort(() => r() - 0.5);
  ends.push(ends[0]!);
  reader.snapshot(ctx => {
    const want = reference(ctx, ends);
    compare(analysisFits(ctx, ends), want);
    compare(analysisFits(ctx, [...ends].reverse()), [...want].reverse());
    compare(analysisFits(ctx, ends.slice(0, 150)), want.slice(0, 150)); // old batch path
    expect(want.filter(f => f.calibration.status === "calibrated").length).toBeGreaterThan(200);
    expect(new Set(want.map(f => f.calibration.factor)).size).toBeGreaterThan(20);
    expect(new Set(want.map(f => f.basis))).toEqual(new Set(["back-applied", "calibrated", "published"]));
    // Query starts in the gap, after two invalid snapshots. Exercise both the
    // initial stale anchor and trailing evidence before the first query point.
    for (const start of [times[117]! + 8 * D, times[125]!]) {
      const gapEnds = Array.from({ length: 240 }, (_, i) => start + i * 60000 + 1);
      const cold = { ...ctx, calibration: createCalibrationService(ctx.db, { revision: () => ctx.revision }) };
      compare(analysisFits(cold, gapEnds), reference(ctx, gapEnds));
    }
  });
});

// Materializing timestamp rows scales with calls, not observations. A real
// statement iterator must continue to return correct calibrated evidence.
test("calibration streams counted calls without materializing a per-call array", () => {
  fixture = createDashboardFixture(false);
  fixture.db.prepare("INSERT INTO counter_snapshots VALUES (?,?,?,?,?,?,?)").run(M, "seat", 0, 1000, 1000, "cycle", "{}");
  fixture.db.prepare("INSERT INTO counter_snapshots VALUES (?,?,?,?,?,?,?)").run(M + D, "seat", 250, 1000, 750, "cycle", "{}");
  fixture.ledger.apply(dashboardBatch(Array.from({ length: 10 }, (_, i) => dashboardCall(`stream-${i}`, { ts: M + i * 1000,
    price: { status: "priced", aic: 50, components: { input: 50, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "fixture", tier: "fixture", confidence: "estimated" } }))));
  const prepare = fixture.db.prepare.bind(fixture.db);
  vi.spyOn(fixture.db, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (sql.includes("AS calibration_totals")) {
      vi.spyOn(statement, "all").mockImplementation(() => { throw new Error("per-call array materialized"); });
      const iterate = statement.iterate.bind(statement);
      vi.spyOn(statement, "iterate").mockImplementation((...params) => {
        const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
        expect(plan.some(row => row.detail === "MATERIALIZE window" || row.detail === "USE TEMP B-TREE FOR GROUP BY")).toBe(false);
        return iterate(...params);
      });
    }
    return statement;
  });
  expect(createCalibrationService(fixture.db, { revision: () => "fixture" }).at(M + D, "auto")).toMatchObject({ status: "calibrated", computedAic: 500, factor: 0.5 });
});

// JS adds interval SUMs rather than calls within one SQL SUM. Six intervals
// total 499.99999999999994; 3000 intervals put the ratio just below 0.05.
// Kills n1 and n2, which the single-interval threshold fixture does not kill.
// [6, 1000] puts the raw ratio at 2.0000000000000004, just above the upper
// limit (kills n2b).
test.each([[6, 250], [3000, 25], [6, 1000]] as const)("stabilizes JS interval-addition noise (%s intervals)", (count, delta) => {
  fixture = createDashboardFixture(false);
  const insert = fixture.db.prepare("INSERT INTO counter_snapshots VALUES (?,?,?,?,?,?,?)");
  fixture.db.raw.transaction(() => {
    for (let i = 0; i <= count; i++) insert.run(M + i * D / count, "seat", i * delta / count, 100000, 90000, "cycle", "{}");
  })();
  fixture.ledger.apply(dashboardBatch(Array.from({ length: count }, (_, i) => dashboardCall(`noise-${i}`, { ts: M + i * D / count,
    price: { status: "priced", aic: 500 / count, components: { input: 500 / count, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "fixture", tier: "fixture", confidence: "estimated" } }))));
  const fit = createCalibrationService(fixture.db, { revision: () => "fixture" }).at(M + D, "auto");
  expect(fit.computedAic).not.toBe(500);
  const ratio = fit.counterDelta / fit.computedAic;
  if (count === 6) { expect(fit.computedAic).toBeLessThan(500); expect(500 - fit.computedAic).toBeLessThan(1e-12); }
  if (delta === 1000) { expect(ratio).toBeGreaterThan(2); expect(ratio - 2).toBeLessThan(1e-12); }
  if (count === 3000) { expect(ratio).toBeLessThan(0.05); expect(0.05 - ratio).toBeLessThan(1e-12); }
  expect(fit.status).toBe("calibrated");
});

// Kills n11: the first 1024 validity flags must survive geometric growth.
test("batch preserves validity and evidence across more than 1024 snapshots", () => {
  fixture = createDashboardFixture(false);
  const insert = fixture.db.prepare("INSERT INTO counter_snapshots VALUES (?,?,?,?,?,?,?)");
  fixture.db.raw.transaction(() => {
    for (let i = 0; i <= 1200; i++) insert.run(M + i * 72000, "seat", i, 100000, 90000, "cycle", "{}");
  })();
  fixture.ledger.apply(dashboardBatch(Array.from({ length: 1200 }, (_, i) => dashboardCall(`growth-${i}`, { ts: M + i * 72000,
    price: { status: "priced", aic: 2, components: { input: 2, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "fixture", tier: "fixture", confidence: "estimated" } }))));
  const service = createCalibrationService(fixture.db, { revision: () => "fixture" });
  expect(service.atMany([M + D], "auto")[0]).toMatchObject({ status: "calibrated", coveredHours: 24, computedAic: 2400, counterDelta: 1200, factor: 0.5 });
});

// Floating-order noise must not flip any of the three acceptance thresholds.
test.each([[500, 25, "calibrated"], [500, 1000, "calibrated"], [499.999, 250, "uncalibrated"], [500, 24.999, "implausible"], [500, 1000.001, "implausible"]] as const)(
  "stable thresholds with fractional sums (%s AIC, %s counter)", (aic, delta, status) => {
    fixture = createDashboardFixture(false);
    const insert = fixture.db.prepare("INSERT INTO counter_snapshots VALUES (?,?,?,?,?,?,?)");
    insert.run(M, "seat", 0, 100000, 100000, "cycle", "{}");
    insert.run(M + D, "seat", delta, 100000, 90000, "cycle", "{}");
    fixture.ledger.apply(dashboardBatch(Array.from({ length: 3000 }, (_, i) => dashboardCall(`threshold-${i}`, { ts: M + i * 1000,
      price: { status: "priced", aic: aic / 3000, components: { input: aic / 3000, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "fixture", tier: "fixture", confidence: "estimated" } }))));
    expect(createCalibrationService(fixture.db, { revision: () => "fixture" }).at(M + D, "auto").status).toBe(status);
  });
