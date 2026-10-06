import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH, DASHBOARD_DAY } from "./fixtures/dashboard-ledger.js";
import { queryOverview } from "../query-overview.js";
import { queryOverview as referenceOverview } from "./fixtures/overview-v2-frozen.js";
import { openDashboardReader } from "../dashboard-reader.js";
import { readMeasure } from "../dashboard-selection.js";
import { openUsageLedger } from "../ledger.js";
import { countedUsageSql } from "../schema.js";
import type { DashboardQueryContext, Dimension } from "../dashboard-contract.js";
import { readDimensionValues } from "../dimension-values.js";

let fixture: ReturnType<typeof createDashboardFixture>;
beforeEach(() => { fixture = createDashboardFixture(false); });
afterEach(() => { vi.restoreAllMocks(); fixture.close(); });
const rounded = (x: number) => Math.round(x * 1e6) / 1e6 || 0;
function overview(now: number, check: (ctx: DashboardQueryContext) => void): void {
  const reader = openDashboardReader(fixture.file, { instanceId: "final", serverBuild: "fixture", now: () => now, calibrationMode: () => "off" })!;
  let failure: unknown;
  try { reader.snapshot(ctx => { try { check(ctx); } catch (error) { failure = error; } }); } finally { reader.close(); }
  if (failure) throw failure;
}
function price(aic: number) {
  return { status: "priced" as const, aic, components: { input: aic, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "fixture", tier: "fixture", confidence: "estimated" as const };
}

it("Overview uses MAX undercount across mixed complete and open-run cube cells", () => {
  const now = DASHBOARD_MONTH + 3 * DASHBOARD_DAY;
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("open", { runId: "open", actor: "subagent", role: "worker" }),
    dashboardCall("complete", { ts: DASHBOARD_MONTH + 2 * DASHBOARD_DAY, actor: "parent", role: "reviewer" }),
  ], { runs: [{ id: "open", dbPath: "fixture", project: null, repo: null, sessionId: null, parentRunId: null,
    agent: null, role: null, name: null, model: null, thinking: null, phase: null, startedAt: null, endedAt: null }] }));
  overview(now, ctx => {
    const result = queryOverview(ctx, { start: DASHBOARD_MONTH, end: now, filters: [] });
    expect(result.totals.pendingData).toBe(false);
    expect(result.totals.possibleUndercount).toBe(true);
    expect(result.actors.find(x => x.label === "subagent")!.measure.possibleUndercount).toBe(true);
    expect(result.roles.find(x => x.label === "worker")!.measure.possibleUndercount).toBe(true);
    expect(result.daily.rows[1]!.measure.possibleUndercount).toBe(true);
    expect(result.actors.find(x => x.label === "parent")!.measure.possibleUndercount).toBe(false);
    expect(result.daily.rows[2]!.measure.possibleUndercount).toBe(false);
  });
});

it.each([0.1234564, 0.1234566, -0.0000001])("Overview rounds exactly to 1e-6 and normalizes negative zero for %s", aic => {
  fixture.ledger.apply(dashboardBatch([dashboardCall("precision", { price: price(aic) })]));
  overview(DASHBOARD_MONTH + 3 * DASHBOARD_DAY, ctx => {
    const result = queryOverview(ctx, { start: DASHBOARD_MONTH, end: ctx.now(), filters: [] });
    const measures = [result.totals, ...result.actors.filter(x => x.measure.calls).map(x => x.measure),
      ...result.roles.map(x => x.measure), ...result.daily.rows.filter(x => x.measure.calls).map(x => x.measure)];
    for (const measure of measures) {
      for (const value of [measure.aic, measure.aicComponents.input, measure.aicDisplay.primaryAic, measure.aicDisplay.publishedAic])
        expect(Object.is(value, rounded(aic))).toBe(true);
    }
  });
});

// The copy probe retained only an approximate elapsed fraction (~0.2), not its timestamp.
it.each([1 / 744, 0.2].flatMap(fraction => ["published", "calibrated", "back-applied"].map(basis => ({ fraction, basis }))))(
  "pace scales unrounded $basis totals once at elapsed fraction $fraction", ({ fraction, basis }) => {
  const now = DASHBOARD_MONTH + Math.round(fraction * 31 * DASHBOARD_DAY);
  fixture.ledger.apply(dashboardBatch([dashboardCall("off-grid", { ts: DASHBOARD_MONTH + 1000, price: price(0.1234564) })]));
  fixture.ledger.insertCounter({ ts: now - 100, creditsUsed: 0.9876543, raw: {} });
  overview(now, ctx => {
    const fallback = ctx.calibration.at(now - 1, "off");
    const fit = { ...fallback, status: "calibrated" as const, factor: 0.54321987, windowEnd: now + 1000 };
    ctx = { ...ctx, calibrationMode: basis === "published" ? "off" : "auto", calibration: { ...ctx.calibration,
      atMany: ends => ends.map(() => basis === "calibrated" ? fit : fallback), earliest: () => fit } };
    const slice = { start: DASHBOARD_MONTH, end: now, filters: [] };
    const actual = queryOverview(ctx, slice), reference = referenceOverview(ctx, slice);
    expect(actual.pace.projected!.aicDisplay.basis).toBe(basis);
    for (const key of ["primaryAic", "publishedAic"] as const) {
      const expected = reference.pace.projected!.aicDisplay[key]!;
      expect(actual.pace.projected!.aicDisplay[key]).toBe(rounded(expected));
      expect(Math.abs(actual.pace.projected!.aicDisplay[key]! - expected)).toBeLessThan(1e-6);
    }
    expect(actual.comparison.computed!.aic).toBe(0.123456);
    expect(actual.comparison.computed!.aicDisplay.primaryAic).toBe(rounded(reference.comparison.computed!.aicDisplay.primaryAic!));
    expect(actual.comparison.gap).toBe(rounded(0.9876543 - 0.123456));
    expect(actual.comparison.ratio).toBe(rounded(0.123456 / 0.9876543));
    for (const key of ["gap", "ratio"] as const)
      expect(Math.abs(actual.comparison[key]! - reference.comparison[key]!)).toBeLessThan(1e-6);
  });
});

it.each(["COALESCE(c.aic,0) AS aic", "c.aic + 1", "c.aic AS value extra", "other.aic", "c.aic,c.*"])("stored projection rejects non-plain entries: %s", projection => {
  expect(() => countedUsageSql("1", projection, undefined, true)).toThrow(/plain c\.<column>/);
});
it("stored projection accepts plain columns and positional aliases", () => {
  const sql = countedUsageSql("1", "c.rowid AS callId, c.aic,c.run_id,c.is_report,c.source_file,c.source_kind", undefined, true);
  expect(() => fixture.db.prepare(sql).all()).not.toThrow();
  expect(sql).toMatch(/SELECT w\.callId,\s*w\.aic,w\.run_id/);
});

it("registry rejects dimensions outside the frozen v3 list", () => {
  expect(() => readDimensionValues(fixture.db, "futureDimension" as Dimension)).toThrow(/invalid dimension registry query/);
});

it("frozen Overview comparison computes independently with dynamic selection", () => {
  const now = DASHBOARD_MONTH + 3 * DASHBOARD_DAY;
  fixture.ledger.apply(dashboardBatch([dashboardCall("reference")]));
  fixture.ledger.insertCounter({ ts: now - 100, creditsUsed: 10, raw: {} });
  overview(now, ctx => {
    const queries: string[] = [], original = fixture.db.prepare.bind(fixture.db);
    vi.spyOn(fixture.db, "prepare").mockImplementation(sql => { queries.push(sql); return original(sql); });
    const result = referenceOverview({ ...ctx, db: fixture.db }, { start: DASHBOARD_MONTH, end: now, filters: [] });
    expect(result.comparison.computed!.calls).toBe(1);
    const comparison = queries.filter(sql => sql.startsWith("SELECT") && sql.includes("FROM calls c"));
    expect(comparison).toHaveLength(1);
    expect(comparison[0]).not.toContain("c.selection_shadowed = 0");
    expect(comparison[0]).toContain("prior.fingerprint = c.fingerprint");
  });
});

it("readMeasure, ledger period/health and both calibration readers use stored selection on v3", () => {
  fixture.ledger.apply(dashboardBatch([dashboardCall("plan")]));
  fixture.ledger.insertCounter({ ts: DASHBOARD_MONTH, creditsUsed: 0, raw: {} });
  fixture.ledger.insertCounter({ ts: DASHBOARD_MONTH + 2 * DASHBOARD_DAY, creditsUsed: 100, raw: {} });
  const queries: string[] = [];
  const original = Database.prototype.prepare;
  vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, sql: string) {
    queries.push(sql); return original.call(this, sql);
  });
  const assertStored = (run: () => unknown, matcher: (sql: string) => boolean) => {
    queries.length = 0; run();
    const selected = queries.filter(matcher);
    expect(selected.length).toBeGreaterThan(0);
    for (const sql of selected) expect(sql, sql).toContain("c.selection_shadowed = 0");
  };
  overview(DASHBOARD_MONTH + 3 * DASHBOARD_DAY, ctx => {
    assertStored(() => readMeasure(ctx, { start: DASHBOARD_MONTH, end: ctx.now(), filters: [] }), sql => sql.includes("FROM calls c"));
    assertStored(() => ctx.calibration.at(ctx.now() - 1, "auto"), sql => sql.includes("GROUP BY ts ORDER BY ts"));
    assertStored(() => ctx.calibration.earliest("auto"), sql => sql.includes("interval_calls AS MATERIALIZED"));
  });
  queries.length = 0;
  const ledger = openUsageLedger(fixture.file);
  try {
    ledger.summarize(DASHBOARD_MONTH, DASHBOARD_MONTH + 3 * DASHBOARD_DAY); ledger.health();
    for (const matcher of ["AS possibleUndercount", "calls_health_reports", "calls_health_unpriced"]) {
      const selected = queries.filter(sql => sql.includes(matcher) && sql.includes("FROM calls c"));
      expect(selected.length, matcher).toBeGreaterThan(0);
      for (const sql of selected) expect(sql, matcher).toContain("c.selection_shadowed = 0");
    }
  } finally { ledger.close(); }
});
