import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { openDashboardReader } from "../dashboard-reader.js";
import { queryDetail, queryDetailLinks } from "../query-detail.js";
import { dashboardKey } from "../dashboard-identities.js";
import type { DashboardQueryContext, DashboardReader } from "../dashboard-contract.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH as M, DASHBOARD_DAY as D, DASHBOARD_NOW } from "./fixtures/dashboard-ledger.js";

let fixture: ReturnType<typeof createDashboardFixture>;
let reader: DashboardReader;
beforeEach(() => {
  fixture = createDashboardFixture(false);
  reader = openDashboardReader(fixture.file, { instanceId: "detail-round2", now: () => DASHBOARD_NOW,
    calibrationMode: () => "auto", serverBuild: "fixture" })!;
});
afterEach(() => { vi.restoreAllMocks(); reader.close(); fixture.close(); });
const slice = () => ({ start: M + 2 * D, end: M + 3 * D, filters: [] });
const priced = (aic: number) => ({ status: "priced" as const, aic,
  components: { input: aic, cacheRead: 0, cacheWrite: 0, output: 0 },
  rateVersion: "fixture-rate", tier: "fixture-tier", confidence: "estimated" as const });
// Keep assertions outside the reader error mapper for precise diagnostics.
function withContext<T>(read: (ctx: DashboardQueryContext) => T): T {
  return read(reader.snapshot(ctx => ctx));
}
function observe(ctx: DashboardQueryContext): string[] {
  const statements: string[] = [];
  if (vi.isMockFunction(ctx.db.prepare)) vi.mocked(ctx.db.prepare).mockRestore();
  const prepare = ctx.db.prepare.bind(ctx.db);
  vi.spyOn(ctx.db, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    for (const method of ["all", "get"] as const) {
      const run = statement[method].bind(statement);
      vi.spyOn(statement, method).mockImplementation((...args) => { statements.push(sql); return run(...args); });
    }
    return statement;
  });
  return statements;
}

// Breaks when links resolve ignored filter ids on a fresh dictionary.
it("detail links ignore id filters within two SELECTs but validate their shape", () => {
  fixture.ledger.apply(dashboardBatch([dashboardCall("links", { ts: M + 2 * D, project: "/synthetic/project", sessionId: "owner" })]));
  withContext(ctx => {
    const key = dashboardKey(ctx, "project", "/synthetic/project")!;
    const statements = observe(ctx);
    const query = { kind: "session" as const, id: "owner", slice: { ...slice(), filters: [{ field: "project" as const, kind: "id" as const, value: key }] }, page: { limit: 1 } };
    expect(queryDetailLinks(ctx, query)).toEqual({ rows: [], nextCursor: null });
    expect(statements).toHaveLength(2);
    statements.length = 0;
    // An unknown well-shaped id is also ignored, not resolved.
    expect(queryDetailLinks(ctx, { ...query, slice: { ...slice(), filters: [{ field: "project", kind: "id", value: "v1_" + "x".repeat(43) }] } })).toEqual({ rows: [], nextCursor: null });
    expect(statements).toHaveLength(2);
    for (const invalid of [
      { ...slice(), end: slice().start - 1 },
      { ...slice(), filters: [{ field: "project" as const, value: "/raw/path" }] },
      { ...slice(), filters: [{ field: "model" as const, value: "x".repeat(1025) }] },
      { ...slice(), filters: [{ field: "day" as const, value: "not-a-date" }] },
      { ...slice(), filters: [{ field: "model" as const, kind: "id" as const, value: null }] },
    ]) {
      statements.length = 0;
      // These intentionally malformed wire inputs bypass the public TypeScript contract.
      expect(() => queryDetailLinks(ctx, { ...query, slice: invalid } as unknown as Parameters<typeof queryDetailLinks>[1])).toThrow("invalid-query");
      expect(statements).toHaveLength(0);
    }
  });
});

// Breaks when unsafe relationship ids bypass publicId, while the calls still count.
it("unsafe parent and covering run ids never acquire a Detail key", () => {
  const unsafe = join(fixture.root, "private", "parent");
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("unsafe-parent", { ts: M + 2 * D, sessionId: "safe-owner", parentRunId: unsafe }),
    dashboardCall("unsafe-report", { ts: M, runId: unsafe, actor: "subagent", aggregate: true, sourceKind: "report" }),
    dashboardCall("covered-child", { ts: M + 2 * D, runId: "safe-child" }),
  ], { coverageEdges: [{ reportRunId: unsafe, includedRunId: "safe-child", evidence: "runs-db" }] }));
  const parent = reader.snapshot(ctx => queryDetail(ctx, { kind: "session", id: "safe-owner", slice: slice(), page: { limit: 1 } }));
  expect(parent.totals.calls).toBe(1);
  expect(parent.calls.rows[0]!.parentRunId).toBeNull();
  const covered = reader.snapshot(ctx => queryDetail(ctx, { kind: "run", id: "safe-child", slice: slice(), page: { limit: 1 } }));
  expect(covered.accounting).toMatchObject({ status: "covered", coveringRunId: null });
  expect(covered.totals.calls).toBe(0);
  expect(JSON.stringify([parent, covered])).not.toContain(fixture.root);
});

// D8 counts the two calibration miss statements separately, not as Detail work.
it("cold pre-anchor history has at most six non-calibration statements", () => {
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("history-budget", { ts: M - D, sessionId: "history", project: "/synthetic/project", price: priced(100) }),
    dashboardCall("anchor-budget", { ts: M, sessionId: "account", price: priced(1000) }),
  ]));
  fixture.ledger.insertCounter({ ts: M, creditsUsed: 0, raw: {} });
  fixture.ledger.insertCounter({ ts: M + D, creditsUsed: 500, raw: {} });
  withContext(ctx => {
    const key = dashboardKey(ctx, "project", "/synthetic/project")!;
    const statements = observe(ctx);
    const query = { kind: "session" as const, id: "history", slice: { start: M - D, end: M,
      filters: [{ field: "project" as const, kind: "id" as const, value: key }] }, page: { limit: 1 } };
    for (const cold of [true, false]) {
      statements.length = 0;
      const result = queryDetail(ctx, query);
      expect(result.totals.aicDisplay).toEqual({ primaryAic: 50, publishedAic: 100, basis: "back-applied" });
      const work = statements.filter(sql => !sql.includes("call-selection-revision"));
      const misses = work.filter(sql => sql.includes("SELECT rowid AS id") || sql.includes("FROM interval_calls"));
      expect(misses).toHaveLength(cold ? 2 : 0);
      expect(work.length - misses.length).toBeLessThanOrEqual(6);
    }
  });
});

// Observe real SHA-256 update work, not a fake hasher, and executed bucket SQL.
it.each(["session", "run"] as const)("%s pages reuse selected-call hashing and timeline until revision changes", kind => {
  fixture.ledger.apply(dashboardBatch(Array.from({ length: 6 }, (_, i) => dashboardCall(`cached-${i}`, {
    ts: M + 2 * D + i, sessionId: "cache-owner", runId: "cache-owner", price: priced(1),
  }))));
  const update = vi.spyOn(Object.getPrototypeOf(createHash("sha256")), "update");
  const hashes = () => update.mock.calls.filter(args => typeof args[0] === "string" && args[0].startsWith('["call",')).length;
  let cursor: string;
  const first = withContext(ctx => {
    const statements = observe(ctx);
    const result = queryDetail(ctx, { kind, id: "cache-owner", slice: slice(), page: { limit: 2 } });
    expect(hashes()).toBe(6);
    expect(statements.some(sql => sql.includes("GROUP BY bucket"))).toBe(true);
    return result;
  });
  cursor = first.calls.nextCursor!;
  vi.restoreAllMocks();
  const secondUpdate = vi.spyOn(Object.getPrototypeOf(createHash("sha256")), "update");
  const subsequentHashes = () => secondUpdate.mock.calls.filter(args => typeof args[0] === "string" && args[0].startsWith('["call",')).length;
  withContext(ctx => {
    const statements = observe(ctx);
    const second = queryDetail(ctx, { kind, id: "cache-owner", slice: slice(), page: { limit: 2, cursor } });
    expect(second.timeline).toEqual(first.timeline);
    expect(second.totals).toEqual(first.totals);
    expect(second.calls.rows.map(row => row.ts)).toEqual([M + 2 * D + 2, M + 2 * D + 3]);
    expect(subsequentHashes()).toBe(0);
    expect(statements.some(sql => sql.includes("GROUP BY bucket"))).toBe(false);
  });
  fixture.ledger.apply(dashboardBatch([dashboardCall("cached-new", { ts: M + 2 * D + 10, sessionId: "cache-owner", runId: "cache-owner", price: priced(10) })]));
  withContext(ctx => {
    const statements = observe(ctx);
    const fresh = queryDetail(ctx, { kind, id: "cache-owner", slice: slice(), page: { limit: 2 } });
    expect(fresh.totals).toMatchObject({ calls: 7, aic: 16 });
    expect(fresh.timeline.reduce((n, point) => n + point.measure.calls, 0)).toBe(7);
    expect(subsequentHashes()).toBe(7);
    expect(statements.some(sql => sql.includes("GROUP BY bucket"))).toBe(true);
  });
});

// Breaks if the cache omits period/filters or is unbounded/FIFO instead of LRU.
it("detail memo separates periods and filters, and evicts least-recently-used selections", () => {
  fixture.ledger.apply(dashboardBatch(Array.from({ length: 10 }, (_, i) => dashboardCall(`lru-${i}`, {
    ts: M + 2 * D + i, sessionId: `owner-${i}`, model: i === 0 ? "model-zero" : "model-other",
  }))));
  withContext(ctx => {
    const statements = observe(ctx);
    const detail = (id: string, selectedSlice = slice()) => {
      statements.length = 0;
      const result = queryDetail(ctx, { kind: "session", id, slice: selectedSlice, page: { limit: 1 } });
      return { result, recomputed: statements.some(sql => sql.includes("GROUP BY bucket")) };
    };
    for (let i = 0; i < 8; i++) expect(detail(`owner-${i}`).recomputed).toBe(true);
    expect(detail("owner-0").recomputed).toBe(false);
    expect(detail("owner-8").recomputed).toBe(true);
    expect(detail("owner-0").recomputed).toBe(false);
    expect(detail("owner-1").recomputed).toBe(true);
    expect(detail("owner-0", { ...slice(), start: M + 2 * D + 1 }).result.totals.calls).toBe(0);
    const filtered = queryDetail(ctx, { kind: "session", id: "owner-0", slice: { ...slice(), filters: [{ field: "model", value: "model-other" }] }, page: { limit: 1 } });
    expect(filtered.totals.calls).toBe(0);
    expect(filtered.timeline).toEqual([]);
  });
});
