import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openDashboardReader } from "../dashboard-reader.js";
import { queryRates, ANALYSIS_ROUTES } from "../query-rates.js";
import { dashboardKey } from "../dashboard-identities.js";
import { queryExplorer } from "../query-explorer.js";
import { COPILOT_RATE_VERSIONS } from "../rates.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH as M, DASHBOARD_DAY as D, type DashboardFixture } from "./fixtures/dashboard-ledger.js";
let fixture: DashboardFixture; let reader: NonNullable<ReturnType<typeof openDashboardReader>>; let mode: "auto" | "off";
const end = M + 40 * D;
beforeEach(() => { fixture = createDashboardFixture(false); mode = "auto"; reader = openDashboardReader(fixture.file, { instanceId: "fixture", now: () => end, serverBuild: "fixture", rates: COPILOT_RATE_VERSIONS, calibrationMode: () => mode })!; });
afterEach(() => { reader.close(); fixture.close(); });
test("rates preserve stored amounts and provenance", () => {
  // Repricing from loaded metadata, losing nulls, or zero-filling status gaps breaks these assertions.
  fixture.ledger.apply(dashboardBatch([
    dashboardCall("stored", { ts: M + 1, model: "gpt-6.1-sol", price: { status: "priced", aic: 1000, components: { input: 100, cacheRead: 200, cacheWrite: 300, output: 400 }, rateVersion: "historic-fixture", tier: "historic", confidence: "estimated" } }),
    ...Array.from({ length: 450 }, (_, i) => dashboardCall(`unknown-${i}`, { ts: M + 2, model: `unknown-${i}`, price: { status: "unpriced", reason: "unknown-model" } })),
  ]));
  fixture.db.prepare("INSERT INTO counter_snapshots VALUES (?,?,?,?,?,?,?)").run(M, "synthetic-seat", 0, 10000, 10000, "reset-one", "{}");
  fixture.db.prepare("INSERT INTO counter_snapshots VALUES (?,?,?,?,?,?,?)").run(M + D, "synthetic-seat", 560, 10000, 9440, "reset-one", "{}");
  fixture.db.prepare("INSERT INTO counter_snapshots VALUES (?,?,?,?,?,?,?)").run(M + 20 * D, "synthetic-seat", 0, 10000, 10000, "reset-two", "{}");
  const slice = { start: M, end, filters: [] }; const ctx = reader.snapshot(ctx => ctx);
  const captured: { sql: string; args: unknown[] }[] = [], prepare = ctx.db.prepare.bind(ctx.db);
  const spy = vi.spyOn(ctx.db, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    for (const method of ["all", "get"] as const) { const run = statement[method].bind(statement); vi.spyOn(statement, method).mockImplementation((...args: unknown[]) => { captured.push({ sql, args }); return run(...args); }); }
    return statement;
  });
  const first = queryRates(ctx, slice, { limit: 50 });
  const cold = [...captured]; captured.length = 0;
  queryRates(ctx, slice, { limit: 50 }); const warm = [...captured]; spy.mockRestore();
  const calibrationPasses = (rows: typeof captured) => rows.filter(row => row.sql.includes("calls_period_read") && !row.sql.includes("AS callRow") && !row.sql.includes("c.rate_version"));
  expect(calibrationPasses(cold)).toHaveLength(2); // One history batch plus earliest-fit discovery, never one per day.
  expect(calibrationPasses(warm)).toHaveLength(0);
  if (process.env.SPIDER_T8_PLAN_LOG === "1") appendFileSync(join(process.env.SPIDER_TEST_FIXTURE_CHECKOUT!, ".spider", "scratch", "usage-ui", "T8-CALIBRATION-PLANS.jsonl"),
    JSON.stringify({ cold: cold.map(({ sql, args }) => ({ sql, args, plan: prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) })), warm: warm.map(({ sql, args }) => ({ sql, args, plan: prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) })) }) + "\n");
  expect(first).toMatchObject({ totals: { aic: 1000, unpricedCalls: 450, tokens: { prompt: 27060, total: 31570 },
    aicComponents: { input: 100, cacheRead: 200, cacheWrite: 300, output: 400 }, aicDisplay: { primaryAic: 1000, publishedAic: 1000, basis: "published" } },
    calibration: { status: "uncalibrated", factor: null } });
  const rates = first.rates.rows;
  expect(rates.find(row => row.model === "gpt-6.1-sol" && row.tier === "default")).toMatchObject({ usdPerMillion: { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 }, abovePromptTokens: 0 });
  expect(rates.find(row => row.model === "gpt-6.1-sol" && row.tier === "long-context")).toMatchObject({ usdPerMillion: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 15 }, abovePromptTokens: 272000 });
  expect(rates.find(row => row.model === "claude-opus-5.5")).toMatchObject({ aliases: ["claude-opus-5-5"], usdPerMillion: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 } });
  expect(rates.find(row => row.model === "gemini-3.8-flash")).toMatchObject({ validUntil: "2027-01-01T00:00:00.000Z", usdPerMillion: { input: 0.75, cacheRead: 0.075, cacheWrite: 0, output: 3.75 } });
  expect(first.versions[0]).toMatchObject({ id: "copilot-public-2026-10-04", sourceAsOf: "2026-10-04", effectiveFrom: "2026-10-01T00:00:00.000Z", confidence: "estimated" });
  expect(first.storedRateVersions).toEqual(["historic-fixture"]);
  expect(first.factorHistory.rows).toHaveLength(31);
  expect(first.factorHistory.rows[0]!.calibration.status).toBe("uncalibrated");
  expect(first.factorHistory.rows[1]!.calibration).toMatchObject({ status: "calibrated", factor: 0.56, coveredHours: 24, computedAic: 1000, counterDelta: 560, unpricedCalls: 450 });
  expect(first.factorHistory.rows[20]!.calibration).toMatchObject({ status: "uncalibrated", factor: null });
  const seen = [...first.unpricedModels.rows]; let cursor = first.nextCursor;
  // An append must not replace the history anchor frozen by the first page.
  fixture.db.prepare("INSERT INTO counter_snapshots VALUES (?,?,?,?,?,?,?)").run(M + 35 * D, "synthetic-seat", 100, 10000, 9900, "reset-two", "{}");
  let lastHistory = first.factorHistory.rows[0]!.day;
  while (cursor) {
    const page = queryRates(ctx, slice, { limit: 50, cursor }); seen.push(...page.unpricedModels.rows);
    for (const point of page.factorHistory.rows) { expect(point.day).toBeGreaterThan(lastHistory); lastHistory = point.day; expect(point.calibration.windowEnd).toBeLessThanOrEqual(M + 20 * D); }
    cursor = page.nextCursor;
  }
  expect(seen).toHaveLength(450); expect(new Set(seen.map(row => row.model)).size).toBe(450);
  expect(seen.every(row => row.measure.aic === null && row.measure.unpricedCalls === 1)).toBe(true);
  ctx.rates = [{ ...COPILOT_RATE_VERSIONS[0]!, models: [{ id: "gpt-6.1-sol", aliases: [], tiers: [{ name: "changed", abovePromptTokens: 0, usdPerMillion: { input: 999, cacheRead: 999, cacheWrite: 999, output: 999 } }] }] }];
  expect(queryRates(ctx, slice, { limit: 50 }).totals.aic).toBe(1000);
  mode = "off"; const offCtx = reader.snapshot(ctx => ctx); const off = queryRates(offCtx, slice, { limit: 50 });
  expect(off).toMatchObject({ calibration: { status: "off", factor: null }, factorHistory: { rows: [], nextCursor: null }, factorHistoryEnabled: false, totals: { aic: 1000, aicDisplay: { primaryAic: 1000, publishedAic: 1000, basis: "published" } } });
  expect(() => queryRates(ctx, { ...slice, filters: [{ field: "actor", value: "warmer" }] }, { limit: 50, cursor: first.nextCursor! })).toThrow("invalid-query");
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(512 * 1024);
});

test("analysis routes reject invalid input before SQL and use bounded range plans", () => {
  mode = "off";
  fixture.ledger.apply(dashboardBatch(Array.from({ length: 10000 }, (_, i) => dashboardCall(`plan-${i}`, {
    ts: M + (i % 30) * D + 1, sessionId: `session-${i % 450}`, model: `unknown-${i % 450}`,
    project: `C:\\private\\project-${i % 450}`, usage: { input: 10, cacheRead: 0, cacheWrite: 30, output: 0 },
    price: { status: "unpriced", reason: "unknown-model" },
  }))));
  for (let i = 0; i <= 30; i++) fixture.db.prepare("INSERT INTO counter_snapshots VALUES (?,?,?,?,?,?,?)").run(M + i * D, "synthetic-seat", i * 10, 10000, 10000 - i * 10, "reset", "{}");
  const ctx = reader.snapshot(ctx => ctx), prepare = ctx.db.prepare.bind(ctx.db);
  for (const route of ANALYSIS_ROUTES) {
    for (const query of [new URLSearchParams("unknown=x"), new URLSearchParams("limit=0"), new URLSearchParams("limit=201"), new URLSearchParams("start=1"), new URLSearchParams("limit=1&limit=2"), new URLSearchParams("cursor=broken"), new URLSearchParams("filters=" + "x".repeat(8200))]) {
      const spy = vi.spyOn(ctx.db, "prepare"); expect(() => route.handle(ctx, query)).toThrow("invalid-query"); expect(spy).not.toHaveBeenCalled(); spy.mockRestore();
    }
    const captured: { sql: string; args: unknown[] }[] = [];
    const spy = vi.spyOn(ctx.db, "prepare").mockImplementation(sql => {
      const statement = prepare(sql);
      for (const method of ["all", "get"] as const) { const run = statement[method].bind(statement); vi.spyOn(statement, method).mockImplementation((...args: unknown[]) => { captured.push({ sql, args }); return run(...args); }); }
      return statement;
    });
    const result = route.handle(ctx, new URLSearchParams({ start: String(M), end: String(M + 31 * D), limit: "200" })); spy.mockRestore();
    expect(captured.length).toBeLessThanOrEqual(route.path === "/api/cache" ? 6 : route.path === "/api/reconciliation" ? 4 : 3);
    const plans = captured.map(({ sql, args }) => ({ sql, args, plan: prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { id: number; parent: number; detail: string }[] }));
    const details = plans.flatMap(row => row.plan);
    expect(details.map(row => row.detail).join("\n")).toMatch(/SEARCH (?:c|r) USING (?:COVERING )?INDEX calls_period_read \(ts>\? AND ts<\?\)/);
    expect(details.filter(row => /SCAN calls\b/.test(row.detail))).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan((route.path === "/api/rates" ? 512 : 256) * 1024);
    expect(JSON.stringify(result)).not.toContain("C:\\\\private");
    if (process.env.SPIDER_T8_PLAN_LOG === "1") appendFileSync(join(process.env.SPIDER_TEST_FIXTURE_CHECKOUT!, ".spider", "scratch", "usage-ui", "T8-QUERY-PLANS.jsonl"),
      JSON.stringify({ route: route.path, bytes: Buffer.byteLength(JSON.stringify(result)), statements: captured.length, plans }) + "\n");
  }
  const recon = ANALYSIS_ROUTES.find(route => route.path === "/api/reconciliation")!;
  const spy = vi.spyOn(ctx.db, "prepare"); expect(() => recon.handle(ctx, new URLSearchParams("filters=[]"))).toThrow("invalid-query"); expect(spy).not.toHaveBeenCalled(); spy.mockRestore();
});

test("rates retain the complete alias provenance of a paged model", () => {
  const aliases = ["alias01", "alias02", "alias03", "alias04", "alias05", "alias06", "alias07", "alias08", "alias09", "alias10", "alias11", "alias12", "alias13", "alias14", "alias15", "alias16", "alias17"];
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  ctx.rates = [{ ...COPILOT_RATE_VERSIONS[0]!, models: [{ ...COPILOT_RATE_VERSIONS[0]!.models[0]!, aliases }] }];
  const result = queryRates(ctx, { start: M, end: M + D, filters: [] }, { limit: 1 });
  expect(result.rates.rows[0]!.aliases).toEqual(["alias01", "alias02", "alias03", "alias04", "alias05", "alias06", "alias07", "alias08", "alias09", "alias10", "alias11", "alias12", "alias13", "alias14", "alias15", "alias16", "alias17"]);
});

// Unsalted/composite keys cannot drill into Explorer's dimension-scoped ids.
test("rates expose Explorer-compatible dimension keys and shared redacted labels", () => {
  fixture.ledger.apply(dashboardBatch([dashboardCall("unknown", { provider: 'note="/private/team/project"', model: "unknown-model", price: { status: "unpriced", reason: "unknown-model" } })]));
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  const slice = { start: M, end: M + 2 * D, filters: [] };
  const data = queryRates(ctx, slice, { limit: 200 });
  const row = data.unpricedModels.rows[0]!;
  expect(row).toMatchObject({ provider: 'note="…/team/project"', model: "unknown-model" });
  expect(row.providerKey).toMatch(/^v1_[A-Za-z0-9_-]{43}$/); expect(row.modelKey).toMatch(/^v1_[A-Za-z0-9_-]{43}$/);
  expect(row).not.toHaveProperty("key");
  const explorer = queryExplorer(ctx, { slice, groupBy: ["model", "provider"], page: { limit: 200 } });
  expect(JSON.stringify(explorer)).toContain(row.modelKey); expect(JSON.stringify(explorer)).toContain(row.providerKey);
  expect(queryRates(ctx, { ...slice, filters: [{ field: "model", kind: "id", value: row.modelKey! }] }, { limit: 200 }).totals.calls).toBe(1);
  const rate = data.rates.rows.find(row => row.model === "gpt-6.1-sol")!;
  expect(rate.modelKey).toBe(dashboardKey(ctx, "model", "gpt-6.1-sol"));
  expect(rate.version).toBe("copilot-public-2026-10-04"); expect(rate).not.toHaveProperty("key");
});

test("rates report truncation for more than 200 stored versions", () => {
  mode = "off";
  fixture.ledger.apply(dashboardBatch(Array.from({ length: 201 }, (_, i) => dashboardCall(`version-${i}`, {
    price: { status: "priced", aic: 1, components: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: `historic-${String(i).padStart(3, "0")}`, tier: "fixture", confidence: "estimated" },
  }))));
  const data = reader.snapshot(ctx => queryRates(ctx, { start: M, end: M + 2 * D, filters: [] }, { limit: 200 }));
  expect(data.storedRateVersions).toHaveLength(200); expect(data.storedRateVersionsTruncated).toBe(true);
});

test("rates current calibration differs from a historical slice fit", () => {
  fixture.ledger.apply(dashboardBatch([dashboardCall("historical", { ts: M + 1, price: { status: "priced", aic: 1000, components: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "fixture", tier: "fixture", confidence: "estimated" } })]));
  fixture.db.prepare("INSERT INTO counter_snapshots VALUES (?,?,?,?,?,?,?)").run(M, "seat", 0, 10000, 10000, "reset", "{}");
  fixture.db.prepare("INSERT INTO counter_snapshots VALUES (?,?,?,?,?,?,?)").run(M + D, "seat", 500, 10000, 9500, "reset", "{}");
  fixture.db.prepare("INSERT INTO counter_snapshots VALUES (?,?,?,?,?,?,?)").run(M + 20 * D, "seat", 0, 10000, 10000, "reset-two", "{}");
  const ctx = reader.snapshot(ctx => ctx);
  const data = queryRates(ctx, { start: M, end: M + D + 1, filters: [] }, { limit: 200 });
  expect(data.calibration).toMatchObject({ status: "uncalibrated", factor: null });
  expect(data.periodCalibration).toMatchObject({ status: "calibrated", factor: 0.5 });
});
