import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LEGACY_DASHBOARD_ROUTES as DASHBOARD_ROUTES } from "../api-routes.js";
import type { DashboardQueryContext, UsageMeasure } from "../dashboard-contract.js";
import { openDashboardReader } from "../dashboard-reader.js";
import type { ExplorerData } from "../query-explorer.js";
import type { CacheData } from "../query-cache.js";
import type { DetailData } from "../query-detail.js";
import type { RatesData } from "../query-rates.js";
import type { OverviewData } from "../dashboard-contract.js";
import { createDashboardFixture, DASHBOARD_MONTH as M } from "./fixtures/dashboard-ledger.js";
import { seedPlanLedger } from "./fixtures/dashboard-plan.js";

const closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0).reverse()) close(); });
const aggregate = (measure: UsageMeasure) => ({ calls: measure.calls, tokens: measure.tokens.total, published: measure.aic,
  primary: measure.aicDisplay.primaryAic, basis: measure.aicDisplay.basis, unpriced: measure.unpricedCalls });
function handle<T>(ctx: DashboardQueryContext, name: string, start: number, end: number, extra: Record<string, string> = {}): T {
  return DASHBOARD_ROUTES.find(route => route.path === `/api/${name}`)!.handle(ctx,
    new URLSearchParams({ start: String(start), end: String(end), ...extra })) as T;
}

it("dense plan fixture has consistent route totals, Detail sums and per-day calibrated AIC", () => {
  const f = createDashboardFixture(false); closers.push(f.close);
  const seed = seedPlanLedger(f.file, 1600, { denseMonthCalls: 1200 });
  const reader = openDashboardReader(f.file, { instanceId: "dense-parity", serverBuild: "fixture", now: () => seed.now, calibrationMode: () => "auto" })!;
  closers.push(() => reader.close());
  const ctx = reader.snapshot(ctx => ctx), report: unknown[] = [];
  for (const period of [seed.periods[0]!, { start: Date.UTC(2026, 8, 1), end: M }, seed.periods[1]!]) {
    const { start, end } = period;
    const overview = handle<OverviewData>(ctx, "overview", start, end);
    const cache = handle<CacheData>(ctx, "cache", start, end);
    const explorer = handle<ExplorerData>(ctx, "explorer", start, end);
    const rates = handle<RatesData>(ctx, "rates", start, end);
    for (const result of [cache, explorer, rates]) expect(aggregate(result.totals)).toEqual(aggregate(overview.totals));
    // The shipped dynamic view is an independent selection oracle, not handler SQL.
    const sql = ctx.db.prepare(`SELECT count(*) AS calls, sum(input+cache_read+cache_write+output) AS tokens,
      sum(aic) AS published, sum(price_status='unpriced') AS unpriced FROM selected_usage_calls WHERE ts>=? AND ts<?`).get(start, end);
    expect(aggregate(overview.totals)).toMatchObject(sql as object);
    const sums: Record<string, unknown> = {};
    for (const kind of ["session", "run"] as const) {
      const column = kind === "session" ? "session_id" : "run_id";
      const ids = ctx.db.prepare(`SELECT DISTINCT ${column} AS id FROM selected_usage_calls WHERE ts>=? AND ts<? AND ${column} IS NOT NULL`).all(start, end) as { id: string }[];
      let calls = 0, tokens = 0, published = 0, primary = 0, unpriced = 0;
      for (const { id } of ids) {
        const { totals } = handle<DetailData>(ctx, "detail", start, end, { kind, id, limit: "1" });
        expect(totals.aicDisplay.basis).toBe(overview.totals.aicDisplay.basis);
        calls += totals.calls; tokens += totals.tokens.total; published += totals.aic ?? 0;
        primary += totals.aicDisplay.primaryAic ?? 0; unpriced += totals.unpricedCalls;
      }
      // Calls without a run are intentionally not a Detail identity.
      const missing = handle<ExplorerData>(ctx, "explorer", start, end, { filters: JSON.stringify([{ field: kind, kind: "missing" }]) }).totals;
      calls += missing.calls; tokens += missing.tokens.total; published += missing.aic ?? 0;
      primary += missing.aicDisplay.primaryAic ?? 0; unpriced += missing.unpricedCalls;
      expect({ calls, tokens, published, unpriced }).toEqual({ calls: overview.totals.calls, tokens: overview.totals.tokens.total, published: overview.totals.aic, unpriced: overview.totals.unpricedCalls });
      expect(primary).toBeCloseTo(overview.totals.aicDisplay.primaryAic!, 8);
      sums[kind] = { ids: ids.length, calls, tokens, published, primary, unpriced };
    }
    let days = 0;
    if (start === M) {
      const grouped = handle<ExplorerData>(ctx, "explorer", start, end, { groupBy: "day", limit: "200" });
      expect(grouped.nextCursor).toBeNull();
      expect(grouped.rows).toHaveLength(31);
      for (const day of overview.daily.rows) {
        const cacheDay = cache.daily.rows.find(row => row.label === day.label)!;
        const explorerDay = grouped.rows.find(row => row.labels[0] === day.label)!;
        expect(aggregate(explorerDay.measure)).toEqual(aggregate(day.measure));
        expect(aggregate(cacheDay.measure)).toEqual(aggregate(day.measure));
        days++;
      }
    }
    report.push({ period, totals: aggregate(overview.totals), sums, parityDays: days });
  }
  if (process.env.SPIDER_USAGE_PLAN_REPORT === "1" && !process.env.CI) {
    const root = join(process.env.SPIDER_TEST_FIXTURE_CHECKOUT!, ".spider/scratch/usage-ui/fb");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "cross-route.json"), JSON.stringify(report, null, 2));
  }
}, 60_000);
