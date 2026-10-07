import { expect, it } from "vitest";
import { loadavg } from "node:os";
import { openDashboardReader } from "../dashboard-reader.js";
import { dashboardKey } from "../dashboard-identities.js";
import { compileSlice } from "../dashboard-selection.js";
import { queryExplorer, queryFilterValues } from "../query-explorer.js";
import { queryOverview } from "../query-overview.js";
import type { DashboardQueryContext, Dimension, Slice } from "../dashboard-contract.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH as M, DASHBOARD_NOW as NOW, DASHBOARD_DAY as D } from "./fixtures/dashboard-ledger.js";

// Opt-in local measurement, never a wall-clock CI gate. Run alone from the worktree root.
it.skipIf(process.env.SPIDER_T6_PERF !== "1")("synthetic Explorer identity performance at 60000 and 140000 rows", () => {
  for (const size of [60000, 140000]) {
    const fixture = createDashboardFixture(false);
    const loadBefore = loadavg();
    let reader: ReturnType<typeof openDashboardReader>;
    try {
      for (let offset = 0; offset < size; offset += 5000) fixture.ledger.apply(dashboardBatch(Array.from({ length: Math.min(5000, size - offset) }, (_, n) => {
        const i = offset + n;
        return dashboardCall(`perf-${i}`, { ts: M + (i % (14 * 24)) * 3600000 + i % 1000,
          project: `/synthetic/projects/project-${i % 31}`, sessionId: `session-${i % 400}`, model: `model-${i % 6}`,
          runId: i % 5 ? null : `run-${i % 700}`, actor: i % 5 ? "parent" : "subagent" });
      })));
      reader = openDashboardReader(fixture.file, { instanceId: `perf-${size}`, now: () => NOW, calibrationMode: () => "off", serverBuild: "fixture" })!;
      const slice: Slice = { start: M, end: M + 15 * D, filters: [] };
      const raw = { ...slice, filters: [{ field: "project" as const, value: "/synthetic/projects/project-7" }] };
      const id = reader.snapshot(ctx => queryFilterValues(ctx, slice, "project", "…/projects/project-7", 50).rows.find(row => row.label === "…/projects/project-7")!.id!);
      const filtered = { ...slice, filters: [{ field: "project" as const, value: id, kind: "id" as const }] };
      const coldAt = performance.now();
      expect(reader.snapshot(ctx => queryOverview(ctx, filtered)).totals.calls).toBe(Math.floor((size - 8) / 31) + 1);
      const coldOverview = performance.now() - coldAt;
      // Same raw-grouped SQL, with output identity projection replaced by precomputed ids.
      // Overview baseline uses the equivalent raw equality predicate. No per-row HMAC baseline.
      const ids = new Map<string, string | null>();
      reader.snapshot(ctx => {
        for (const field of ["model", "project", "session"] as const) {
          const rows = ctx.db.prepare(`SELECT DISTINCT ${field === "session" ? "session_id" : field} AS value FROM calls c INDEXED BY calls_period_read WHERE c.ts >= ? AND c.ts < ?`).all(M, M + 15 * D) as { value: string | null }[];
          for (const row of rows) ids.set(JSON.stringify([field, row.value]), dashboardKey(ctx, field, row.value));
        }
      });
      const queries: [string, (ctx: DashboardQueryContext) => unknown, ((ctx: DashboardQueryContext) => unknown)?][] = [
        ["Explorer model", ctx => queryExplorer(ctx, { slice, groupBy: ["model"], page: { limit: 50 } })],
        ["Explorer project/session", ctx => queryExplorer(ctx, { slice, groupBy: ["project", "session"], page: { limit: 200 } })],
        ["filter-values session", ctx => queryFilterValues(ctx, slice, "session", "", 50)],
        ["Explorer id-filter/session", ctx => queryExplorer(ctx, { slice: filtered, groupBy: ["session"], page: { limit: 200 } })],
        ["filter-values id-filter/session", ctx => queryFilterValues(ctx, filtered, "session", "", 50)],
        ["Overview id-filter", ctx => queryOverview(ctx, filtered), ctx => queryOverview(ctx, raw)],
      ];
      const result: Record<string, unknown> = {};
      for (const [name, query, baselineQuery = query] of queries) {
        const sample = (baseline: boolean): number => {
          reader!.snapshot(ctx => ctx.db.raw.function("explorer_id", { deterministic: true }, (field: Dimension, value: string | null) => baseline
            ? ids.get(JSON.stringify([field, value])) ?? null : dashboardKey(ctx, field, value)));
          const at = performance.now(); reader!.snapshot(baseline ? baselineQuery : query); return performance.now() - at;
        };
        sample(true); sample(false);
        const baseline: number[] = []; const actual: number[] = [];
        for (let n = 0; n < 9; n++) {
          if (n % 2) { actual.push(sample(false)); baseline.push(sample(true)); }
          else { baseline.push(sample(true)); actual.push(sample(false)); }
        }
        const median = (samples: number[]) => [...samples].sort((a,b) => a-b)[Math.floor(samples.length / 2)]!;
        const b = median(baseline); const a = median(actual);
        result[name] = { baselineMs: +b.toFixed(2), actualMs: +a.toFixed(2), ratio: +(a / b).toFixed(3), baseline, actual };
        if (size === 60000) expect(a / b, name).toBeLessThanOrEqual(1.2);
      }
      const explain = reader.snapshot(ctx => {
        const prepare = ctx.db.prepare.bind(ctx.db);
        const lookup = "SELECT DISTINCT c.project AS value FROM calls c INDEXED BY calls_period_read WHERE c.ts >= ? AND c.ts < ? AND c.project IS NOT NULL";
        const compiled = compileSlice(filtered, undefined, ctx);
        return { lookup: prepare("EXPLAIN QUERY PLAN " + lookup).all(M, M + 15 * D), compiled };
      });
      process.stdout.write("T6_PERF " + JSON.stringify({ size, loadBefore, loadAfter: loadavg(), coldOverviewMs: +coldOverview.toFixed(2), queries: result, explain }) + "\n");
    } finally { reader?.close(); fixture.close(); }
  }
}, 600000);
