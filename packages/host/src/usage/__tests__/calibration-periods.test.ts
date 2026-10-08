import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDashboardReader } from "../dashboard-reader.js";

import { readMeasure } from "../dashboard-selection.js";
import type { CalibrationService, DashboardReader, DashboardQueryContext } from "../dashboard-contract.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_DAY as DAY, DASHBOARD_MONTH as START, type DashboardFixture } from "./fixtures/dashboard-ledger.js";

// Reviewer hand-calculated scenarios. Expected numbers are worked out by hand in the review file.
let f: DashboardFixture, reader: DashboardReader, service: CalibrationService, ctx: DashboardQueryContext;
const A = START + 10 * DAY;
const reopen = () => {
  reader?.close();
  reader = openDashboardReader(f.file, { instanceId: "rv", now: () => A + DAY, calibrationMode: () => "auto", serverBuild: "rv" })!;
  ctx = reader.snapshot(c => c); service = ctx.calibration;
};
beforeEach(() => { f = createDashboardFixture(false); reopen(); });
afterEach(() => { reader.close(); f.close(); });
const priced = (id: string, ts: number, aic: number) => dashboardCall(id, { ts, price: { status: "priced", aic, components: { input: aic, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "rv", tier: "rv", confidence: "estimated" } });
const counter = (ts: number, creditsUsed: number, resetDate = "R1") => f.ledger.insertCounter({ ts, creditsUsed, accountLogin: "acct", resetDate, raw: {} });

// R1: period before the first fit uses the earliest fit, labelled back-applied, with bounded evaluations.
it("R1 before the first fit: earliest factor, basis back-applied, one batch", () => {
  f.ledger.apply(dashboardBatch([priced("fit", A - 1.5 * DAY, 1000), priced("old", A - 4.5 * DAY, 100)]));
  counter(A - 2 * DAY, 0); counter(A - DAY, 600);
  const c = { ...ctx, now: () => A };
  const many = vi.spyOn(service, "atMany"), early = vi.spyOn(service, "earliest");
  const r = readMeasure(c, { start: A - 5 * DAY, end: A - 4 * DAY, filters: [] });
  expect(early).toHaveBeenCalledTimes(1);
  many.mockRestore(); early.mockRestore();
  expect(r.aicDisplay).toEqual({ primaryAic: 60, publishedAic: 100, basis: "back-applied" });
  expect(readMeasure(c, { start: A - 5 * DAY, end: A - 4 * DAY, filters: [] }).aicDisplay).toEqual(r.aicDisplay);
  // Historical period after the fit uses its own window (no future data): [A-1.5D, A-1D) ends at A-1D-1 -> anchor A-2D -> no pair -> not calibrated.
  // Period [A-1D, A) ends at A-1 -> anchor A-1D -> 0.6, basis calibrated.
  f.ledger.apply(dashboardBatch([priced("after", A - 0.5 * DAY, 10)]));
  expect(readMeasure(c, { start: A - DAY, end: A, filters: [] }).aicDisplay).toEqual({ primaryAic: 6, publishedAic: 10, basis: "calibrated" });
});

// R2: current period whose trailing window is implausible, after an earlier accepted fit.
// Controller decision: back-apply only BEFORE the first fit. Implausible -> published (D11).
it("R2 current implausible window after an earlier fit stays published", () => {
  f.ledger.apply(dashboardBatch([priced("early", A - 9 * DAY + 3600000, 1000), priced("now", A - 0.5 * DAY, 1000)]));
  counter(A - 9 * DAY, 0); counter(A - 8 * DAY, 500); counter(A - DAY, 600); counter(A, 3600);
  expect(service.current("auto")).toMatchObject({ status: "implausible", counterDelta: 3000, computedAic: 1000 });
  expect(service.earliest("auto")).toMatchObject({ status: "calibrated", factor: 0.5, windowEnd: A - 8 * DAY });
  const c = { ...ctx, now: () => A + 1000 };
  const r = readMeasure(c, { start: A - DAY, end: A + 1000, filters: [] });
  // Footer (current()) would show "~1,000 AIC ?". Overview must not show a calibrated primary for the same span.
  expect(service.at(A, "auto").status).toBe("implausible");
  expect(r.aicDisplay).toEqual({ primaryAic: 1000, publishedAic: 1000, basis: "published" });
  expect(readMeasure(c, { start: A - DAY, end: A + 1000, filters: [] }).aicDisplay).toEqual(r.aicDisplay);
});

// R3: gap after the first fit (no later fit, current window insufficient) -> published.
it("R3 current gap after the first fit stays published", () => {
  f.ledger.apply(dashboardBatch([priced("early", A - 9 * DAY + 3600000, 1000), priced("now", A - 0.5 * DAY, 1000)]));
  counter(A - 9 * DAY, 0); counter(A - 8 * DAY, 500); counter(A - 0.5 * DAY, 600);
  expect(service.at(A - 1, "auto").status).toBe("uncalibrated");
  const c = { ...ctx, now: () => A };
  const r = readMeasure(c, { start: A - DAY, end: A, filters: [] });
  expect(service.at(A - 1, "auto").status).toBe("uncalibrated");
  expect(r.aicDisplay).toEqual({ primaryAic: 1000, publishedAic: 1000, basis: "published" });
  expect(readMeasure(c, { start: A - DAY, end: A, filters: [] }).aicDisplay).toEqual(r.aicDisplay);
});

// R4: M3 call range with sparse, gapped and non-contiguous anchors. Hand values in the review file.
it("R4 sparse/gapped snapshots: no dropped intervals, no double counting", () => {
  const B = A + 30 * DAY;
  f.ledger.apply(dashboardBatch([
    priced("pre-window", A - 6.5 * DAY, 7000), priced("p1", A - 5.5 * DAY, 100), priced("rejected", A - 3 * DAY, 300),
    priced("p3", A - 0.5 * DAY, 400), priced("at-A", A, 100),
    priced("b-out", B - 7.5 * DAY, 5000), priced("b-pre", B - 3 * DAY, 9000), priced("b1", B - DAY, 600),
  ]));
  counter(A - 10 * DAY, 0); counter(A - 6 * DAY, 100); counter(A - 5 * DAY, 200); counter(A - DAY, 150); counter(A, 450); counter(A + DAY, 500);
  counter(B - 8 * DAY, 1000); counter(B - 2 * DAY, 1100); counter(B, 1400);
  const exp = {
    a: { status: "calibrated", coveredHours: 48, counterDelta: 400, computedAic: 500, factor: 0.8 },
    ad: { status: "calibrated", coveredHours: 72, counterDelta: 450, computedAic: 600, factor: 0.75 },
    b: { status: "calibrated", coveredHours: 48, counterDelta: 300, computedAic: 600, factor: 0.5 },
  };
  const spy = vi.spyOn(ctx.db, "prepare");
  const many = service.atMany([A, A + DAY, B, A], "auto");
  const nonContig = spy.mock.calls.some(([sql]) => sql.includes("json_each(?) span"));
  spy.mockRestore();
  expect(nonContig).toBe(true);
  expect(many[0]).toMatchObject(exp.a); expect(many[1]).toMatchObject(exp.ad); expect(many[2]).toMatchObject(exp.b); expect(many[3]).toMatchObject(exp.a);
  reopen();
  expect(service.at(B, "auto")).toMatchObject(exp.b);
  reopen();
  expect(service.at(A + DAY, "auto")).toMatchObject(exp.ad);
  reopen();
  expect(service.atMany([B, A], "auto")).toMatchObject([exp.b, exp.a]);
});

// An inclusive endpoint would use the snapshot at A and change 0.5 to 1.
it("readMeasure excludes a calibration snapshot exactly at slice.end", () => {
  f.ledger.apply(dashboardBatch([priced("first", A - 1.5 * DAY, 1000), priced("last", A - 0.5 * DAY, 500)]));
  counter(A - 2 * DAY, 0); counter(A - DAY, 500); counter(A, 1500);
  expect(service.at(A, "auto").factor).toBe(1);
  const r = readMeasure(ctx, { start: A - DAY, end: A, filters: [] });
  expect(r.aicDisplay).toEqual({ primaryAic: 250, publishedAic: 500, basis: "calibrated" });
});

// Ignoring now would use the future snapshot at A and change 0.5 to 1.
it("Overview caps calibration at now for a slice ending in the future", () => {
  f.ledger.apply(dashboardBatch([priced("first", A - 1.5 * DAY, 1000), priced("last", A - 0.5 * DAY, 500)]));
  counter(A - 2 * DAY, 0); counter(A - DAY, 500); counter(A, 1500);
  const r = readMeasure({ ...ctx, now: () => A - DAY + 1 }, { start: A - DAY, end: A + 1, filters: [] });
  expect(r.aicDisplay).toEqual({ primaryAic: 250, publishedAic: 500, basis: "calibrated" });
});
