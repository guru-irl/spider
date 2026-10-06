import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDashboardReader } from "../dashboard-reader.js";
import { queryExplorer, queryFilterValues } from "../query-explorer.js";
import { queryOverview } from "../query-overview.js";
import { readMeasure } from "../dashboard-selection.js";
import type { DashboardQueryContext, DashboardReader, Dimension, Filter, Slice } from "../dashboard-contract.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH as M, DASHBOARD_NOW as NOW, DASHBOARD_DAY as D } from "./fixtures/dashboard-ledger.js";

let fixture: ReturnType<typeof createDashboardFixture>;
let reader: DashboardReader;
const S: Slice = { start: M, end: M + 15 * D, filters: [] };
const open = () => openDashboardReader(fixture.file, { instanceId: "final-fixture", now: () => NOW, calibrationMode: () => "off", serverBuild: "fixture" })!;
const missing = (dimension: Dimension): Filter => ({ field: dimension, kind: "missing" });
function inspect<T>(fn: (ctx: DashboardQueryContext) => T): T {
  let error: unknown;
  const result = reader.snapshot(ctx => { try { return fn(ctx); } catch (failure) { error = failure; } });
  if (error) throw error;
  return result as T;
}
beforeEach(() => {
  fixture = createDashboardFixture(false);
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("a", { project: "project-a", model: "alpha", role: null }),
    dashboardCall("b", { project: "project-b", model: "Bravo", role: "Unknown" }),
    dashboardCall("c", { project: "project-a", model: "alpine", role: null, runId: "safe-run" }),
  ]));
  reader = open();
});
afterEach(() => { reader.close(); fixture.close(); vi.restoreAllMocks(); });

// Rejecting missing, ignoring its predicate, or treating Unknown as null breaks these hand totals.
it("missing filters select only SQL NULL in Explorer, filter-values and Overview", () => {
  fixture.db.prepare("UPDATE calls SET session_id=NULL WHERE id='a'").run();
  inspect(ctx => {
    const role = { ...S, filters: [missing("role")] };
    const result = queryExplorer(ctx, { slice: role, groupBy: ["role"], page: { limit: 200 } });
    expect(result.rows.map(row => ({ labels: row.labels, calls: row.measure.calls }))).toEqual([{ labels: [null], calls: 2 }]);
    expect(result.totals).toMatchObject({ calls: 2, aic: 2, tokens: { input: 20, cacheRead: 40, cacheWrite: 60, output: 20, total: 140 } });
    expect(queryFilterValues(ctx, role, "model", "", 200).rows.map(row => row.label)).toEqual(["alpha", "alpine"]);
    expect(queryOverview(ctx, role).totals).toMatchObject({ calls: 2, aic: 2, tokens: { total: 140 } });
    for (const dimension of ["session", "run", "requestedModel", "day"] as const) {
      const slice = { ...S, filters: [missing(dimension)] };
      const calls = { session: 1, run: 2, requestedModel: 3, day: 0 }[dimension];
      expect(queryExplorer(ctx, { slice, groupBy: [dimension], page: { limit: 200 } }).totals.calls).toBe(calls);
      expect(queryOverview(ctx, slice).totals.calls).toBe(calls);
      expect(queryFilterValues(ctx, slice, dimension, "", 200).rows).toEqual(calls ? [{ id: null, label: null }] : []);
    }
    const conjunction = { ...S, filters: [missing("role"), missing("run")] };
    expect(queryExplorer(ctx, { slice: conjunction, groupBy: ["model"], page: { limit: 200 } }).totals.calls).toBe(1);
    expect(queryOverview(ctx, conjunction).totals.tokens.total).toBe(70);
  });
});
it("filter-values distinguishes selectable Unknown from unsupported detail-id counts", () => {
  fixture.db.prepare("UPDATE calls SET session_id=NULL WHERE id='a'").run();
  fixture.ledger.apply(dashboardBatch([dashboardCall("unsupported", { sessionId: "bad id", runId: "bad/id" })]));
  inspect(ctx => {
    for (const field of ["session", "run"] as const) {
      const rows = queryFilterValues(ctx, S, field, "", 200).rows;
      expect(rows).toContainEqual({ id: null, label: null });
      expect(rows).toContainEqual({ id: null, label: "unsupported id", count: 1 });
      const slice = { ...S, filters: [missing(field)] };
      expect(queryFilterValues(ctx, slice, field, "", 200).rows).toEqual([{ id: null, label: null }]);
      expect(queryExplorer(ctx, { slice, groupBy: [field], page: { limit: 200 } }).totals.calls).toBe(field === "session" ? 1 : 2);
    }
  });
});
it("missing filters use indexed range access without identity dictionary lookups", () => inspect(ctx => {
  const prepare = vi.spyOn(ctx.db, "prepare");
  queryExplorer(ctx, { slice: { ...S, filters: [missing("role")] }, groupBy: ["model"], page: { limit: 200 } });
  expect(prepare).toHaveBeenCalledTimes(1);
  const sql = prepare.mock.calls[0]![0]; prepare.mockRestore();
  expect(sql).toContain("c.role IS NULL");
  const plan = ctx.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(M, S.end, 201) as { detail: string }[];
  expect(plan.some(row => row.detail === "SEARCH c USING INDEX calls_period_read (ts>? AND ts<?)")).toBe(true);
}));
it("missing filters count against the cap and reject ambiguous shapes and all raw nulls", () => inspect(ctx => {
  expect(queryExplorer(ctx, { slice: { ...S, filters: Array.from({ length: 16 }, () => missing("role")) }, groupBy: ["model"], page: { limit: 200 } }).totals.calls).toBe(2);
  const bad = [
    Array.from({ length: 17 }, () => missing("role")),
    [{ field: "role", value: null }], [{ field: "role", value: null, kind: "raw" }], [{ field: "role", value: null, kind: "id" }],
    [{ field: "bogus", kind: "missing" }], [{ field: "role", kind: "missing", value: null }],
    [{ field: "role", kind: "missing", value: "ignored" }], [{ field: "role", kind: "missing", value: undefined }],
    [{ dimension: "role", kind: "missing" }], [{ dimension: "role", field: "model", kind: "missing" }],
  ];
  for (const filters of bad) {
    const slice = { ...S, filters } as Slice;
    expect(() => queryExplorer(ctx, { slice, groupBy: ["model"], page: { limit: 200 } })).toThrow("invalid-query");
    expect(() => queryFilterValues(ctx, slice, "model", "", 200)).toThrow("invalid-query");
    expect(() => queryOverview(ctx, slice)).toThrow("invalid-query");
  }
}));
it("missing filters are canonical cursor identity and cannot be exchanged for other dimensions", () => inspect(ctx => {
  const filters = [missing("role"), missing("requestedModel")];
  const slice = { ...S, filters };
  const first = queryExplorer(ctx, { slice, groupBy: ["model"], page: { limit: 1 } });
  expect(first.nextCursor).not.toBeNull();
  const equivalent = { ...S, filters: [missing("requestedModel"), missing("role"), missing("role")] };
  expect(queryExplorer(ctx, { slice: equivalent, groupBy: ["model"], page: { limit: 1, cursor: first.nextCursor! } }).rows).toHaveLength(1);
  expect(() => queryExplorer(ctx, { slice: { ...S, filters: [missing("role"), missing("agent")] }, groupBy: ["model"], page: { limit: 1, cursor: first.nextCursor! } })).toThrow("invalid-query");
  const values = queryFilterValues(ctx, slice, "model", "", 1);
  expect(queryFilterValues(ctx, equivalent, "model", "", 1, values.nextCursor!).rows).toHaveLength(1);
  expect(() => queryFilterValues(ctx, { ...S, filters: [missing("agent")] }, "model", "", 1, values.nextCursor!)).toThrow("invalid-query");
}));

it("cold Overview and detail measures add one dictionary SELECT per id-filtered field", () => {
  const keys = inspect(ctx => ({ project: queryFilterValues(ctx, S, "project", "project-a", 200).rows[0]!.id!, model: queryFilterValues(ctx, S, "model", "alpha", 200).rows[0]!.id! }));
  const filters: Filter[] = [{ field: "project", value: keys.project, kind: "id" }, { field: "model", value: keys.model, kind: "id" }, { field: "project", value: keys.project, kind: "id" }];
  for (const endpoint of ["overview", "detail"] as const) {
    reader.close(); reader = open();
    inspect(ctx => {
      const prepare = vi.spyOn(ctx.db, "prepare");
      const read = (slice: Slice) => endpoint === "overview" ? queryOverview(ctx, slice).totals : readMeasure(ctx, slice);
      expect(read(S).calls).toBe(3);
      const base = prepare.mock.calls.length; expect(base).toBe(endpoint === "overview" ? 2 : 1);
      prepare.mockClear();
      expect(read({ ...S, filters }).calls).toBe(1);
      expect(prepare).toHaveBeenCalledTimes(base + 2);
      prepare.mockClear(); read({ ...S, filters }); expect(prepare).toHaveBeenCalledTimes(base);
      prepare.mockRestore();
    });
  }
});

// A page fetched after eviction is only a suffix, not a complete prefix list.
it("typeahead never caches a cursor page as the complete value list", () => inspect(ctx => {
  const first = queryFilterValues(ctx, S, "model", "", 1);
  expect(first.rows[0]!.label).toBe("alpha");
  for (let n = 1; n <= 33; n++) queryFilterValues(ctx, { ...S, end: S.end + n }, "model", "", 200);
  expect(queryFilterValues(ctx, S, "model", "", 1, first.nextCursor!).rows[0]!.label).toBe("alpine");
  expect(queryFilterValues(ctx, S, "model", "", 200).rows.map(row => row.label)).toEqual(["alpha", "alpine", "Bravo"]);
}));
it("typeahead cache follows UTF-8 binary label order across astral page boundaries", () => {
  fixture.ledger.apply(dashboardBatch([dashboardCall("bmp", { model: "x\uFF5E" }), dashboardCall("astral", { model: "x😀" })]));
  inspect(ctx => {
    const first = queryFilterValues(ctx, S, "model", "x", 1);
    expect(first.rows[0]!.label).toBe("x\uFF5E");
    const prepare = vi.spyOn(ctx.db, "prepare");
    expect(queryFilterValues(ctx, S, "model", "x", 1, first.nextCursor!).rows.map(row => row.label)).toEqual(["x😀"]);
    expect(prepare).not.toHaveBeenCalled(); prepare.mockRestore();
  });
});
it("typeahead hits a narrower prefix typed in a different ASCII case", () => inspect(ctx => {
  queryFilterValues(ctx, S, "model", "al", 200);
  const prepare = vi.spyOn(ctx.db, "prepare");
  expect(queryFilterValues(ctx, S, "model", "ALP", 200).rows.map(row => row.label)).toEqual(["alpha", "alpine"]);
  expect(prepare).not.toHaveBeenCalled(); prepare.mockRestore();
}));

it("session and run unsupported-count subqueries use indexed period access, never full calls scans", () => {
  fixture.ledger.apply(dashboardBatch([dashboardCall("unsupported", { sessionId: "bad id", runId: "bad/id" })]));
  inspect(ctx => {
    for (const field of ["session", "run"] as const) {
      const prepare = vi.spyOn(ctx.db, "prepare");
      expect(queryFilterValues(ctx, S, field, "unsupported", 200).rows).toEqual([{ id: null, label: "unsupported id", count: 1 }]);
      const sql = prepare.mock.calls[0]![0]; prepare.mockRestore();
      const explain = (statement: string) => ctx.db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all(M, S.end, M, S.end, "unsupported%", 4097) as { id: number; parent: number; detail: string }[];
      const oracle = (rows: ReturnType<typeof explain>) => {
        const subquery = rows.find(row => /^SCALAR SUBQUERY/.test(row.detail));
        const access = rows.filter(row => row.parent === subquery?.id && /^(SCAN|SEARCH) c(?: |$)/.test(row.detail));
        return access.length === 1 && access[0]!.detail === "SEARCH c USING INDEX calls_period_read (ts>? AND ts<?)";
      };
      expect(oracle(explain(sql))).toBe(true);
      // Mutate only the unsupported-count probe, not DISTINCT or shared selection CTEs.
      const noIndex = sql.replace("SELECT COUNT(*) FROM calls c INDEXED BY calls_period_read", "SELECT COUNT(*) FROM calls c NOT INDEXED");
      const noRange = sql.replace("SELECT COUNT(*) FROM calls c INDEXED BY calls_period_read\n      WHERE c.ts >= ? AND c.ts < ?", "SELECT COUNT(*) FROM calls c INDEXED BY calls_period_read\n      WHERE ? IS NOT NULL AND ? IS NOT NULL");
      expect(noIndex).not.toBe(sql); expect(noRange).not.toBe(sql);
      expect(oracle(explain(noIndex))).toBe(false); expect(oracle(explain(noRange))).toBe(false);
    }
  });
});
