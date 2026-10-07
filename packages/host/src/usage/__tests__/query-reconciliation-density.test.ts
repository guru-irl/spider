import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openDashboardReader } from "../dashboard-reader.js";
import { analysisFits } from "../query-cache.js";
import type { InternalCalibrationService } from "../calibration.js";
import { ANALYSIS_ROUTES } from "../query-rates.js";
import type { ReconciliationData } from "../query-reconciliation.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH as M, DASHBOARD_DAY as D, type DashboardFixture } from "./fixtures/dashboard-ledger.js";
let fixture: DashboardFixture;
let reader: NonNullable<ReturnType<typeof openDashboardReader>>;
const STEP = 600000, END = M + 31 * D;
const route = ANALYSIS_ROUTES.find(route => route.path === "/api/reconciliation")!;
beforeEach(() => {
  fixture = createDashboardFixture(false);
  reader = openDashboardReader(fixture.file, { instanceId: "density-fixture", now: () => END + D, serverBuild: "fixture", calibrationMode: () => "auto" })!;
});
afterEach(() => { vi.restoreAllMocks(); reader.close(); fixture.close(); });
function seed(step: number, end = END) {
  const insert = fixture.db.prepare("INSERT INTO counter_snapshots VALUES (?,?,?,?,?,?,?)");
  fixture.db.raw.transaction(() => {
    for (let ts = M, i = 0; ts <= end; ts += step, i++) insert.run(ts, "synthetic-seat", i, 100000, 100000 - i, "synthetic-cycle", "{}");
  })();
  fixture.ledger.apply(dashboardBatch(Array.from({ length: (end - M) / step }, (_, i) => dashboardCall(`density-${i}`, {
    ts: M + i * step, price: { status: "priced", aic: 2, components: { input: 2, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "fixture-rate", tier: "fixture-tier", confidence: "estimated" },
  }))));
}
function request(bucket = "day") {
  return reader.snapshot(ctx => route.handle(ctx, new URLSearchParams({ start: String(M), end: String(END), bucket })) as ReconciliationData);
}
// Small sparse wire golden, hand-calculated: 600 published / 300 counter per
// day. The first endpoint predates the first fit, so only that day back-applies.
test("sparse calibrated fixture keeps literal wire expectations", () => {
  const insert = fixture.db.prepare("INSERT INTO counter_snapshots VALUES (?,?,?,?,?,?,?)");
  for (let i = 0; i <= 3; i++) insert.run(M + i * D, "seat", i * 300, 10000, 10000 - i * 300, "cycle", "{}");
  fixture.ledger.apply(dashboardBatch(Array.from({ length: 3 }, (_, i) => dashboardCall(`sparse-${i}`, { ts: M + i * D,
    price: { status: "priced", aic: 600, components: { input: 600, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "fixture", tier: "fixture", confidence: "estimated" } }))));
  const data = reader.snapshot(ctx => route.handle(ctx, new URLSearchParams({ start: String(M), end: String(M + 3 * D) })) as ReconciliationData);
  expect(data.periods.nextCursor).toBeNull();
  expect(data.periods.rows.map(row => ({ status: row.status, counter: row.counterAic, published: row.computed?.aic, calibrated: row.calibratedAic, gap: row.gap,
    display: row.computed?.aicDisplay, calibration: row.calibration }))).toEqual([
    { status: "compared", counter: 300, published: 600, calibrated: 300, gap: -300,
      display: { primaryAic: 300, publishedAic: 600, basis: "back-applied" },
      calibration: { status: "calibrated", factor: 0.5, windowStart: 1790294400000, windowEnd: 1790899200000, coveredHours: 24, computedAic: 600, counterDelta: 300, unpricedCalls: 0, method: "trailing-7d-ratio" } },
    { status: "compared", counter: 300, published: 600, calibrated: 300, gap: -300,
      display: { primaryAic: 300, publishedAic: 600, basis: "calibrated" },
      calibration: { status: "calibrated", factor: 0.5, windowStart: 1790294400000, windowEnd: 1790899200000, coveredHours: 24, computedAic: 600, counterDelta: 300, unpricedCalls: 0, method: "trailing-7d-ratio" } },
    { status: "compared", counter: 300, published: 600, calibrated: 300, gap: -300,
      display: { primaryAic: 300, publishedAic: 600, basis: "calibrated" },
      calibration: { status: "calibrated", factor: 0.5, windowStart: 1790380800000, windowEnd: 1790985600000, coveredHours: 48, computedAic: 1200, counterDelta: 600, unpricedCalls: 0, method: "trailing-7d-ratio" } },
  ]);
});
// Reinstating the public endpoint cap on internal fan-out breaks this route.
test("a month of ten-minute snapshots reconciles exact pair totals through the route", () => {
  seed(STEP);
  const data = request();
  expect(data.periods.rows).toHaveLength(31);
  expect(data.periods.rows.every(row => row.status === "compared" && row.coverage === 1)).toBe(true);
  expect(data.periods.rows.map(row => [row.counterAic, row.computed?.aic, row.gap])).toEqual(Array.from({ length: 31 }, () => [144, 288, -144]));
  expect(data.periods.rows.slice(2).every(row => row.calibration.factor === 0.5 && row.calibratedAic === 144)).toBe(true);
  const month = request("month").periods.rows[0]!;
  expect(month).toMatchObject({ counterAic: 4464, computed: { aic: 8928 }, gap: -4464 });
  // The same internal fan-out must work when calibration is explicitly disabled.
  const off = reader.snapshot(ctx => {
    ctx.calibrationMode = "off";
    return route.handle(ctx, new URLSearchParams({ start: String(M), end: String(END) })) as ReconciliationData;
  });
  expect(off.periods.rows.every(row => row.calibration.status === "off" && row.computed?.aicDisplay.primaryAic === 288)).toBe(true);
});

// A per-endpoint SELECT loop or an unbounded persistent cache breaks these budgets.
test("period windows use one call pass and retain only the last 512 fits", () => {
  seed(STEP);
  const ctx = reader.snapshot(ctx => ctx);
  const calibration = ctx.calibration as InternalCalibrationService;
  {
    const prepare = vi.spyOn(ctx.db, "prepare");
    const windows = calibration.windows({ start: M, end: END }, "auto");
    expect(windows).toHaveLength(4465);
    expect(windows[0]).toMatchObject({ from: M, calibration: { status: "uncalibrated", windowEnd: M } });
    expect(windows[144]).toMatchObject({ from: M + D, calibration: { status: "uncalibrated", factor: null, computedAic: 288, counterDelta: 144, coveredHours: 24 } });
    expect(windows[288]).toMatchObject({ from: M + 2 * D, calibration: { status: "calibrated", factor: 0.5, computedAic: 576, counterDelta: 288, coveredHours: 48 } });
    expect(windows.at(-1)).toMatchObject({ from: END, calibration: { factor: 0.5, computedAic: 2016, counterDelta: 1008, coveredHours: 168 } });
    const callReads = () => prepare.mock.calls.filter(([sql]) => sql.includes("calls_period_read")).length;
    expect(callReads()).toBe(1);
    expect(analysisFits(ctx, Array.from({ length: 300 }, (_, i) => M + (288 + i) * STEP + 1))).toEqual(Array.from({ length: 300 }, (_, i) => ({
      basis: "calibrated", calibration: { status: "calibrated", factor: 0.5, windowStart: M + (288 + i) * STEP - 7 * D,
        windowEnd: M + (288 + i) * STEP, coveredHours: (288 + i) / 6, computedAic: (288 + i) * 2,
        counterDelta: 288 + i, unpricedCalls: 0, method: "trailing-7d-ratio" },
    })));
    prepare.mockClear();
    calibration.windows({ start: M, end: END }, "auto");
    expect(prepare.mock.calls.filter(([sql]) => sql.includes("FROM counter_snapshots"))).toHaveLength(1);
    prepare.mockClear();
    // An overlapping history has both hits and misses. It must promote its
    // existing tail fits too, not evict them before older newly computed fits.
    calibration.windows({ start: M, end: END }, "auto");
    expect(callReads()).toBe(1);
    prepare.mockClear();
    const hits = calibration.windows({ start: END - 511 * STEP, end: END }, "auto");
    expect(hits).toHaveLength(512);
    expect(hits.every(point => point.calibration.factor === 0.5)).toBe(true);
    expect(callReads()).toBe(0);
    prepare.mockClear();
    const promoted = END - 511 * STEP;
    expect(ctx.calibration.at(promoted, "auto").factor).toBe(0.5);
    expect(callReads()).toBe(0);
    expect(ctx.calibration.at(M + 2 * D, "auto")).toMatchObject({ status: "calibrated", factor: 0.5 });
    expect(callReads()).toBe(1); // early fit was evicted, not silently retained
    prepare.mockClear();
    expect(ctx.calibration.at(promoted, "auto").factor).toBe(0.5);
    expect(callReads()).toBe(0); // a promoted hit survives the new miss
    expect(() => ctx.calibration.atMany(Array.from({ length: 201 }, (_, i) => M + i * STEP), "auto")).toThrow("invalid-query");
    expect(() => ctx.calibration.atMany([M, M + 367 * D], "auto")).toThrow("invalid-query");
    expect(ctx.calibration.atMany([M, M + 366 * D], "off")).toHaveLength(2);
    expect(() => calibration.windows({ start: M, end: M + 367 * D }, "auto")).toThrow("invalid-query");
  }
});

// Invalid observations are gaps, not internal change points (r10).
test("internal windows exclude invalid observation change points", () => {
  const insert = fixture.db.prepare("INSERT INTO counter_snapshots VALUES (?,?,?,?,?,?,?)");
  insert.run(M, "seat", 0, 1000, 1000, "cycle", "{}");
  insert.run(M + 1, "seat", -1, 1000, 1000, "cycle", "{}");
  insert.run(M + 2, "seat", 1, 1000, 999, "cycle", "{}");
  expect(reader.snapshot(ctx => (ctx.calibration as InternalCalibrationService).windows({ start: M, end: M + 3 }, "auto")).map(w => w.from)).toEqual([M, M + 2]);
});
