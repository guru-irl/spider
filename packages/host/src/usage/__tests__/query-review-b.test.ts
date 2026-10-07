import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDashboardReader } from "../dashboard-reader.js";
import type { DashboardQueryContext, DashboardReader, Dimension, Slice, UsageMeasure } from "../dashboard-contract.js";
import { queryOverview } from "../query-overview.js";
import { queryCache } from "../query-cache.js";
import { queryExplorer } from "../query-explorer.js";
import { queryDetail } from "../query-detail.js";
import { queryRates } from "../query-rates.js";
import { queryReconciliation } from "../query-reconciliation.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_DAY as D, DASHBOARD_MONTH as M, type DashboardFixture } from "./fixtures/dashboard-ledger.js";

let f: DashboardFixture, reader: DashboardReader;
beforeEach(() => {
  f = createDashboardFixture(false);
  reader = openDashboardReader(f.file, { instanceId: "review-b", serverBuild: "fixture", now: () => M + 40 * D, calibrationMode: () => "auto" })!;
});
afterEach(() => { vi.restoreAllMocks(); reader.close(); f.close(); });
const priced = (id: string, ts: number, aic: number) => dashboardCall(id, { ts, price: { status: "priced", aic,
  components: { input: aic, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "fixture", tier: "fixture", confidence: "estimated" } });
const counter = (ts: number, creditsUsed: number) => f.ledger.insertCounter({ ts, creditsUsed, accountLogin: "synthetic", resetDate: "2026-12-01", raw: {} });
const slice = (start: number, end: number): Slice => ({ start, end, filters: [] });
const explorer = (ctx: DashboardQueryContext, period: Slice, groupBy: readonly Dimension[]) => queryExplorer(ctx, { slice: period, groupBy, page: { limit: 200 } });

function seedChangingFit(): void {
  f.ledger.apply(dashboardBatch([priced("first", M + D / 2, 1000), priced("second", M + 1.5 * D, 1000), priced("third", M + 2.5 * D, 1000)]));
  counter(M, 0); counter(M + D, 500); counter(M + 2 * D, 1500); counter(M + 3 * D, 2400);
}

// The period fit is 0.8; day-end fits are independently 0.5 (back-applied), 0.5 and 0.75.
it("Cache daily measures, warmer and components use each day's fit, not the period fit", () => {
  seedChangingFit();
  f.db.exec("UPDATE calls SET actor='warmer'");
  const ctx = reader.snapshot(ctx => ctx);
  const result = queryCache(ctx, slice(M, M + 3 * D + 1), { limit: 200 });
  expect(result.totals.aicDisplay).toEqual({ primaryAic: 2400, publishedAic: 3000, basis: "calibrated" });
  for (const [i, primaryAic, basis] of [[0, 500, "back-applied"], [1, 500, "calibrated"], [2, 750, "calibrated"]] as const) {
    const day = result.daily.rows[i]!;
    const expected = { primaryAic, publishedAic: 1000, basis };
    expect(day.measure.aicDisplay).toEqual(expected);
    expect(day.warmer.aicDisplay).toEqual(expected);
    expect(day.components[0]!.aicDisplay).toEqual(expected);
    expect(day.warmerComponents[0]!.aicDisplay).toEqual(expected);
  }
});

it.each([["day"], ["model", "day"], ["model", "actor", "day"]].map(group => [group as Dimension[]]))(
  "Overview, Cache and Explorer agree on daily fits with grouping %j", groupBy => {
    seedChangingFit();
    const ctx = reader.snapshot(ctx => ctx);
    const period = slice(M, M + 3 * D + 1), overview = queryOverview(ctx, period), cache = queryCache(ctx, period, { limit: 200 });
    const result = explorer(ctx, period, groupBy);
    expect(result.totals.aicDisplay).toEqual({ primaryAic: 2400, publishedAic: 3000, basis: "calibrated" });
    const dayLevel = groupBy.indexOf("day");
    for (const [index, primaryAic, basis] of [[0, 500, "back-applied"], [1, 500, "calibrated"], [2, 750, "calibrated"]] as const) {
      const day = overview.daily.rows[index]!, row = result.rows.find(row => row.labels[dayLevel] === day.label)!;
      expect(row.measure.aicDisplay).toEqual({ primaryAic, publishedAic: 1000, basis });
      expect(row.measure.aicDisplay).toEqual(day.measure.aicDisplay);
      expect(row.measure.aicDisplay).toEqual(cache.daily.rows[index]!.measure.aicDisplay);
    }
    expect(explorer(ctx, period, ["model"]).rows[0]!.measure.aicDisplay).toEqual(result.totals.aicDisplay);
  });

// Dropping the slice.end cutoff uses the later same-day fit (0.75 instead of 0.5).
it.each([["day"], ["model", "day"], ["model", "actor", "day"]].map(group => [group as Dimension[]]))(
  "Explorer clips a past partial day's fit at the custom period end with grouping %j", groupBy => {
    f.ledger.apply(dashboardBatch([priced("first", M + D / 2, 1000), priced("partial-day", M + 1.25 * D, 1000)]));
    counter(M, 0); counter(M + D, 500); counter(M + 1.75 * D, 1500);
    const ctx = reader.snapshot(ctx => ctx);
    const period = slice(M + D, M + 1.5 * D);
    // The excluded snapshot lies after the custom end, before day end, and well before now.
    expect(ctx.calibration.at(M + 2 * D - 1, "auto")).toMatchObject({ factor: 0.75, windowEnd: M + 1.75 * D });
    const overview = queryOverview(ctx, period), cache = queryCache(ctx, period, { limit: 200 });
    const result = explorer(ctx, period, groupBy);
    expect(result.calibration).toMatchObject({ factor: 0.5, windowEnd: M + D });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.measure.calls).toBe(1);
    expect(result.rows[0]!.measure.aicDisplay).toEqual({ primaryAic: 500, publishedAic: 1000, basis: "calibrated" });
    expect(overview.daily.rows).toHaveLength(1);
    expect(cache.daily.rows).toHaveLength(1);
    expect(result.rows[0]!.measure.aicDisplay).toEqual(overview.daily.rows[0]!.measure.aicDisplay);
    expect(result.rows[0]!.measure.aicDisplay).toEqual(cache.daily.rows[0]!.measure.aicDisplay);
  });

// Dropping min(end, now) admits the later snapshot and changes 0.5 to 1.
it.each(["Explorer", "Detail"] as const)("%s caps a future period fit at now, excluding the snapshot at now", route => {
  f.ledger.apply(dashboardBatch([priced("first", M + D / 2, 1000), priced("last", M + 1.5 * D, 500)]));
  counter(M, 0); counter(M + D, 500); counter(M + 2 * D, 1500);
  const ctx = reader.snapshot(ctx => ctx);
  const c = { ...ctx, now: () => M + 2 * D }, period = slice(M + D, M + 3 * D);
  expect(ctx.calibration.at(M + 3 * D - 1, "auto").factor).toBe(1);
  const result = route === "Explorer" ? explorer(c, period, ["model"]) : queryDetail(c, { kind: "session", id: "parent-session", slice: period, page: { limit: 200 } });
  expect(result.calibration).toMatchObject({ windowEnd: M + D, factor: 0.5 });
  expect(result.totals.aicDisplay).toEqual({ primaryAic: 250, publishedAic: 500, basis: "calibrated" });
  if (route === "Explorer") expect(explorer(c, period, ["day"]).rows[0]!.measure.aicDisplay.primaryAic).toBe(250);
});

it("a Reconciliation bucket mixing published and calibrated pairs falls back wholly to published", () => {
  f.ledger.apply(dashboardBatch([priced("early", M + D / 2, 1000), priced("gap", M + 5 * D, 100),
    priced("later", M + 9.5 * D, 1000), priced("latest", M + 10.5 * D, 1000)]));
  counter(M, 0); counter(M + D, 500); counter(M + 9 * D, 600); counter(M + 10 * D, 1100); counter(M + 11 * D, 1600);
  const ctx = reader.snapshot(ctx => ctx);
  const periods = queryReconciliation(ctx, { start: M, end: M + 12 * D }, { bucket: "snapshot", limit: 200 }).periods.rows;
  expect(periods.map(row => row.computed!.aicDisplay.basis)).toEqual(["back-applied", "calibrated", "published", "calibrated"]);
  const row = queryReconciliation(ctx, { start: M, end: M + 12 * D }, { bucket: "month", limit: 200 }).periods.rows[0]!;
  expect(row.computed!.aicDisplay).toEqual({ primaryAic: 3100, publishedAic: 3100, basis: "published" });
  expect(row.calibratedAic).toBeNull();
  const withoutBackApplied = queryReconciliation(ctx, { start: M + D, end: M + 12 * D }, { bucket: "month", limit: 200 }).periods.rows[0]!;
  expect(withoutBackApplied.computed!.aicDisplay).toEqual({ primaryAic: 2100, publishedAic: 2100, basis: "published" });
  expect(withoutBackApplied.calibratedAic).toBeNull();
});

// A fractional single call has no SQL sum-order ambiguity. Overview must not round it alone.
it("all routes preserve the same unrounded AIC at the DTO boundary", () => {
  const amount = 1.123456789;
  f.ledger.apply(dashboardBatch([priced("fit", M - D / 2, 1000), priced("fractional", M + D / 2, amount)]));
  counter(M - D, 0); counter(M, 500); counter(M + D, 500 + amount * 0.5);
  const ctx = reader.snapshot(ctx => ctx);
  const period = slice(M, M + 2 * D), overview = queryOverview(ctx, period), cache = queryCache(ctx, period, { limit: 200 });
  const measures: UsageMeasure[] = [overview.totals, overview.daily.rows[0]!.measure, cache.totals, cache.daily.rows[0]!.measure,
    explorer(ctx, period, ["model"]).totals, explorer(ctx, period, ["day"]).rows[0]!.measure,
    queryDetail(ctx, { kind: "session", id: "parent-session", slice: period, page: { limit: 200 } }).totals,
    queryRates(ctx, period, { limit: 200 }).totals,
    queryReconciliation(ctx, period, { bucket: "month", limit: 200 }).periods.rows[0]!.computed!];
  for (const measure of measures) {
    expect(measure.aic).toBe(amount);
    expect(measure.aicComponents.input).toBe(amount);
    expect(measure.aicDisplay).toMatchObject({ primaryAic: amount * 0.5, publishedAic: amount });
  }
  expect(cache.components[0]!.aicDisplay.publishedAic).toBe(amount);
  const now = M + D + 1;
  const current = queryOverview({ ...ctx, now: () => now }, period);
  expect(current.comparison.computed!.aic).toBe(amount);
  expect(current.comparison.gap).toBe(500 + amount * 0.5 - amount);
  expect(current.comparison.ratio).toBe(amount / (500 + amount * 0.5));
  expect(current.pace.projected!.aicDisplay.primaryAic).toBeCloseTo(amount * 0.5 * (31 * D / (now - M)), 12);
  expect(current.pace.projected!.aicDisplay.publishedAic).toBeCloseTo(amount * (31 * D / (now - M)), 12);
});

it.each([[["day", "model"], 200], [["model", "day"], 200], [["model", "actor", "day"], 200], [["model", "day"], 7]] as const)(
  "day-grouped pages stay complete and stable with grouping %j and limit %i", (groupBy, limit) => {
    const groups = groupBy as readonly Dimension[];
    const calls = Array.from({ length: 75 }, (_, day) => ["first", "second"].map(model => dashboardCall(`${day}-${model}`, {
      ts: M + day * D + 1, model, actor: model === "first" ? "parent" : "warmer",
    }))).flat();
    f.ledger.apply(dashboardBatch(calls));
    const ctx = reader.snapshot(ctx => ctx);
    const period = slice(M, M + 75 * D), rows: string[] = [];
    let cursor: string | undefined;
    do {
      const many = vi.spyOn(ctx.calibration, "atMany"), at = vi.spyOn(ctx.calibration, "at");
      const result = queryExplorer(ctx, { slice: period, groupBy: groups, page: { limit, cursor } });
      expect(many).toHaveBeenCalledTimes(1);
      expect(many.mock.calls[0]![0].length).toBeLessThanOrEqual(33);
      expect(at).not.toHaveBeenCalled();
      many.mockRestore(); at.mockRestore();
      const repeated = queryExplorer(ctx, { slice: period, groupBy: groups, page: { limit, cursor } });
      expect(JSON.stringify(repeated)).toBe(JSON.stringify(result));
      const dayLevel = groups.indexOf("day");
      expect(new Set(result.rows.map(row => row.key[dayLevel])).size).toBeLessThanOrEqual(32);
      expect(result.rows.length).toBeLessThanOrEqual(limit);
      expect(result.rows.length).toBeGreaterThan(0);
      rows.push(...result.rows.map(row => JSON.stringify(row.labels)));
      expect(rows.length).toBeLessThanOrEqual(150);
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    const expected = calls.map(call => JSON.stringify(groups.map(group => {
      switch (group) {
        case "day": return new Date(call.ts).toISOString().slice(0, 10);
        case "model": return call.model;
        case "actor": return call.actor;
        default: throw new Error("unsupported fixture dimension");
      }
    })));
    expect(rows).toHaveLength(150);
    expect(new Set(rows).size).toBe(150);
    expect(rows.sort()).toEqual(expected.sort());
  });
