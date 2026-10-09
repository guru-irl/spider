import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDashboardReader } from "../dashboard-reader.js";
import type { DashboardReader } from "../dashboard-contract.js";
import { readUsageCube, readCorrectedComponents, sumValues } from "../query-redesign-shared.js";
import { queryOverviewV4, querySessions } from "../query-overview-v4.js";
import { querySession } from "../query-session.js";
import { readCounterIntervals } from "../counter-intervals.js";
import { customRange } from "./fixtures/redesign-range.js";
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
function changingFit() {
  f.ledger.apply(dashboardBatch([priced("first", M + D / 2, 1000), priced("second", M + 1.5 * D, 1000), priced("third", M + 2.5 * D, 1000)]));
  counter(M, 0); counter(M + D, 500); counter(M + 2 * D, 1500); counter(M + 3 * D, 2400);
}
it("daily factors reconcile every replacement rollup instead of applying one period factor", () => {
  changingFit(); f.db.exec("UPDATE calls SET actor='warmer'");
  reader.snapshot(ctx => {
    const range = customRange(M, M + 3 * D + 1), cube = readUsageCube(ctx, range);
    expect(cube.buckets.slice(0, 3).map(b => b.total.credits)).toEqual([500, 500, 750]);
    expect(cube.total.credits).toBe(1750);
    expect(sumValues(cube.rows.map(row => row.value))).toEqual(cube.total);
    expect(queryOverviewV4(ctx, range).flow.total).toEqual(cube.total);
    expect(cube.rows.every(row => row.role === "background")).toBe(true);
  });
});
it("past partial-day correction shares the full UTC-day fit", () => {
  f.ledger.apply(dashboardBatch([priced("first", M + D / 2, 1000), priced("partial", M + 1.25 * D, 1000)]));
  counter(M, 0); counter(M + D, 500); counter(M + 1.75 * D, 1500);
  reader.snapshot(ctx => {
    expect(ctx.calibration.at(M + 2 * D - 1, "auto").factor).toBe(0.75);
    const cube = readUsageCube(ctx, customRange(M + D, M + 1.5 * D));
    expect(cube.total).toMatchObject({ credits: 750, calls: 1 });
    expect(cube.buckets).toHaveLength(12);
    expect(sumValues(cube.buckets.map(row => row.total))).toEqual(cube.total);
  });
});
it("future bounds never admit a calibration snapshot at now", () => {
  f.ledger.apply(dashboardBatch([priced("first", M + D / 2, 1000), priced("last", M + 1.5 * D, 500)]));
  counter(M, 0); counter(M + D, 500); counter(M + 2 * D, 1500);
  reader.snapshot(ctx => {
    expect(ctx.calibration.at(M + 3 * D - 1, "auto").factor).toBe(1);
    expect(readUsageCube({ ...ctx, now: () => M + 2 * D }, customRange(M + D, M + 3 * D)).total.credits).toBe(250);
  });
});
it("observed intervals omit invalid gaps without inventing monthly counter apportionment", () => {
  changingFit(); counter(M + 11 * D, 2600); counter(M + 12 * D, 3100);
  reader.snapshot(ctx => {
    const intervals = readCounterIntervals(ctx, { start: M, end: M + 13 * D });
    expect(intervals.map(row => row.counterDelta)).toEqual([500, 900, 1000, 500]);
    expect(intervals.some(row => row.start === M + 3 * D && row.end === M + 11 * D)).toBe(false);
  });
});
it("fractional credits stay unrounded across Overview, Sessions and whole-session totals", () => {
  const amount = 1.123456789;
  f.ledger.apply(dashboardBatch([priced("fit", M - D / 2, 1000), priced("fractional", M + D / 2, amount)]));
  counter(M - D, 0); counter(M, 500); counter(M + D, 500 + amount * 0.5);
  reader.snapshot(ctx => {
    const range = customRange(M, M + 2 * D), overview = queryOverviewV4(ctx, range);
    expect(overview.total.credits).toBe(amount * 0.5);
    expect(overview.sessions.rows[0]!.value.credits).toBe(amount * 0.5);
    expect(overview.buckets.find(row => row.total.calls)!.total.credits).toBe(amount * 0.5);
    const session = querySession(ctx, "parent-session", "UTC", { from: M-D, to: M+2*D });
    expect(session.total.credits).toBe(500 + amount * 0.5);
    expect(session.flow.total).toEqual(session.total);
    expect(readCorrectedComponents(ctx, ["fractional"]).get("fractional")?.cacheWriteCredits).toBe(0);
  });
});
it("paged Sessions cover long custom ranges once and endpoint batches remain bounded", () => {
  f.ledger.apply(dashboardBatch(Array.from({ length: 75 }, (_, day) => dashboardCall(`day-${day}`, { ts: M + day * D + 1, sessionId: `human-${day}` }))));
  const range = customRange(M, M + 75 * D), ids: (string | null)[] = [];
  for (let offset = 0; offset < 75; offset += 7) {
    const { page, many, again } = reader.snapshot(ctx => {
      const many = vi.spyOn(ctx.calibration, "atMany");
      const page = querySessions(ctx, { ...range, sort: "credits", offset, limit: 7 });
      return { page, many, again: querySessions(ctx, { ...range, sort: "credits", offset, limit: 7 }) };
    });
    expect(many).toHaveBeenCalled();
    for (const [ends] of many.mock.calls) expect(ends.length).toBeLessThanOrEqual(200);
    many.mockRestore();
    expect(page.rows.length).toBeLessThanOrEqual(7); ids.push(...page.rows.map(row => row.id));
    expect(again).toEqual(page);
  }
  expect(ids).toHaveLength(75); expect(new Set(ids).size).toBe(75);
});
