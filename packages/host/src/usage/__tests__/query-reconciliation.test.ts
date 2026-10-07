import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openDashboardReader } from "../dashboard-reader.js";
import { queryReconciliation } from "../query-reconciliation.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH as M, DASHBOARD_DAY as D, DASHBOARD_NOW as NOW, type DashboardFixture } from "./fixtures/dashboard-ledger.js";
let fixture: DashboardFixture; let reader: NonNullable<ReturnType<typeof openDashboardReader>>;
beforeEach(() => { fixture = createDashboardFixture(false); reader = openDashboardReader(fixture.file, { instanceId: "fixture", now: () => NOW, serverBuild: "fixture", calibrationMode: () => "auto" })!; });
afterEach(() => { reader.close(); fixture.close(); });
const snapshot = (ts: number, credits: number, account = "synthetic-seat", reset = new Date(Date.UTC(new Date(ts).getUTCFullYear(), new Date(ts).getUTCMonth() + 1, 1)).toISOString().slice(0, 10)) => fixture.db.prepare("INSERT INTO counter_snapshots VALUES (?,?,?,?,?,?,?)").run(ts, account, credits, 10000, 10000 - credits, reset, "{}");
const priced = (id: string, ts: number, aic: number) => dashboardCall(id, { ts, price: { status: "priced", aic, components: { input: aic, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "fixture-rate", tier: "fixture-tier", confidence: "estimated" } });
test("reconciliation pairs actual compatible anchors", () => {
  const M = Date.UTC(2026, 9, 3);
  // Using requested bucket edges or a future factor breaks the comparisons and evidence.
  snapshot(M - D, 0); snapshot(M, 560); snapshot(M + D / 2, 565); snapshot(M + D - 1000, 570);
  fixture.ledger.apply(dashboardBatch([
    priced("training", M - D + 1, 1000), priced("start-boundary", M, 12),
    priced("end-boundary", M + D - 1000, 9),
    dashboardCall("unpriced", { ts: M + 1, price: { status: "unpriced", reason: "unknown-model" } }),
  ]));
  const ctx = reader.snapshot(ctx => ctx);
  const atMany = vi.spyOn(ctx.calibration, "atMany");
  const data = queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "day", limit: 50 });
  expect(data).toMatchObject({ periods: { rows: [{ start: M, end: M + D - 1000, status: "partial", counterAic: 10,
    computed: { aic: 12, unpricedCalls: 1, tokens: { prompt: 120, total: 140 }, aicDisplay: { publishedAic: 12, basis: "calibrated" } },
    gap: -2, ratio: 1.2, calibratedRatio: 0.672,
    calibration: { status: "calibrated", factor: 565 / 1012, windowEnd: M + D / 2, coveredHours: 36, computedAic: 1012, counterDelta: 565 } }] } });
  const row = data.periods.rows[0]!;
  expect(row.calibratedAic).toBeCloseTo(6.72); expect(row.calibratedGap).toBeCloseTo(3.28); expect(row.computed!.aicDisplay.primaryAic).toBeCloseTo(6.72);
  expect(atMany).toHaveBeenCalledTimes(1); expect(atMany).toHaveBeenCalledWith([M + D / 2 - 1, M + D - 1001], "auto");
  expect(JSON.stringify(data)).not.toContain("synthetic-seat");
  const month = queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "month", limit: 50 });
  expect(month).toMatchObject({ periods: { rows: [{ start: M, end: M + D - 1000, gap: -2 }] } });
  const snap = queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "snapshot", limit: 1 });
  expect(snap).toMatchObject({ periods: { rows: [{ start: M, end: M + D / 2, counterAic: 5, computed: { aic: 12 } }] } });
  const cursor = (snap as { periods: { nextCursor: string } }).periods.nextCursor;
  snapshot(M + 3 * D / 4, 567); // Late append must not enter the frozen page.
  const next = queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "snapshot", limit: 1, cursor });
  expect(next).toMatchObject({ periods: { rows: [{ start: M + D / 2, end: M + D - 1000, counterAic: 5 }] } });
  expect(() => queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "day", limit: 1, cursor })).toThrow("invalid-query");
  expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThan(256 * 1024);
});

test("reset account and clock boundaries are explicit", () => {
  const H = 3600000;
  snapshot(M + 1, 100); snapshot(M + H, 110); snapshot(M + 2 * H, 0, "synthetic-seat", "reset-two");
  snapshot(M + 3 * H, 4, "other-synthetic-seat", "reset-two");
  snapshot(M + 4 * H, 2, "other-synthetic-seat", "reset-two");
  snapshot(M + 5 * H, 2, "other-synthetic-seat", "reset-two");
  snapshot(M + 6 * H, -1, "other-synthetic-seat", "reset-two");
  fixture.ledger.apply(dashboardBatch([priced("matched", M + 2, 12), priced("reset-call", M + H + 1, 99), priced("zero", M + 4 * H + 1, 0)]));
  const ctx = reader.snapshot(ctx => ctx);
  const data = queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "snapshot", limit: 200 });
  expect(data.periods.rows.map(row => row.status)).toEqual(["missing-anchor", "compared", "reset", "account-change", "counter-decrease", "compared", "invalid-counter"]);
  expect(data.periods.rows.map(row => row.counterAic)).toEqual([null, 10, null, null, null, 0, null]);
  expect(data.periods.rows[1]).toMatchObject({ gap: -2, ratio: 1.2, calibratedAic: null, calibratedGap: null, calibratedRatio: null });
  expect(data.periods.rows[5]).toMatchObject({ gap: 0, ratio: null, computed: { aic: 0, aicDisplay: { primaryAic: 0, publishedAic: 0, basis: "published" } } });
  for (const row of data.periods.rows.filter(row => row.status !== "compared")) expect(row).toMatchObject({ counterAic: null, gap: null, ratio: null, calibratedAic: null, calibratedGap: null, calibratedRatio: null });
  expect(queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "day", limit: 1 }).periods.rows[0]!.status).toBe("partial");
  snapshot(M + H / 2, 105);
  const clock = queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "snapshot", limit: 200 });
  expect(clock.periods.rows.find(row => row.end === M + H)!.status).toBe("clock");
  // Capture actual production statements, excluding separately-budgeted calibration.
  ctx.calibrationMode = "off";
  const captured: { sql: string; args: unknown[] }[] = []; const prepare = ctx.db.prepare.bind(ctx.db);
  const spy = vi.spyOn(ctx.db, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    for (const method of ["all", "get"] as const) { const run = statement[method].bind(statement); vi.spyOn(statement, method).mockImplementation((...args: unknown[]) => { captured.push({ sql, args }); return run(...args); }); }
    return statement;
  });
  queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "snapshot", limit: 200 }); spy.mockRestore();
  expect(captured.length).toBeLessThanOrEqual(4);
  const plans = captured.flatMap(({ sql, args }) => prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args)) as { id: number; parent: number; detail: string }[];
  expect(plans.map(row => row.detail).join("\n")).toContain("SEARCH r USING COVERING INDEX calls_period_read (ts>? AND ts<?)");
  expect(plans.map(row => row.detail).join("\n")).toContain("SEARCH s USING INDEX counter_snapshots_ts (ts>? AND ts<?)");
  expect(plans.filter(row => /SCAN (?:calls|s|p)\b/.test(row.detail) || (/SCAN r\b/.test(row.detail) && plans.some(parent => parent.id === row.parent && parent.detail === "MATERIALIZE interval_calls")))).toEqual([]);
  expect(() => queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "bad" as "day", limit: 200 })).toThrow("invalid-query");
});

test("reconciliation bounds stale anchor lookback", () => {
  snapshot(M - 400 * D, 0); snapshot(M + D / 2, 10);
  fixture.ledger.apply(dashboardBatch([priced("ancient", M - 399 * D, 99), priced("recent", M + 1, 12)]));
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  const data = queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "snapshot", limit: 50 });
  expect(data.periods.rows[0]).toMatchObject({ status: "missing-anchor", counterStart: null, counterAic: null, computed: null });
  const daily = queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "day", limit: 50 });
  expect(daily.periods.rows[0]).toMatchObject({ status: "missing-anchor", counterStart: null, counterAic: null, computed: null });
});

// Using calendar endpoint subtraction loses the first day and invents weekend clocks.
test("bucket comparisons sum pair evidence including the first observed day and cross-bucket spans", () => {
  snapshot(M + D / 4, 100); snapshot(M + D / 2, 120); snapshot(M + 3 * D + D / 2, 190);
  fixture.ledger.apply(dashboardBatch([priced("first", M + D / 4, 40), priced("spanning", M + D, 140)]));
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  const period = { start: M, end: M + 4 * D };
  const day = queryReconciliation(ctx, period, { bucket: "day", limit: 200 });
  expect(day.periods.rows.map(row => row.status)).toEqual(["partial", "no-snapshot", "no-snapshot", "partial"]);
  expect(day.periods.rows[0]).toMatchObject({ start: M + D / 4, end: M + D / 2, coverage: 0.25, coveredMs: D / 4, counterAic: 20, computed: { aic: 40 } });
  expect(day.periods.rows[1]).toMatchObject({ start: M + D, end: M + 2 * D, counterAic: null, computed: null, coverage: 0 });
  expect(day.periods.rows[3]).toMatchObject({ start: M + D / 2, end: M + 3.5 * D, coverage: 0.5, counterAic: 70, computed: { aic: 140 } });
  const month = queryReconciliation(ctx, period, { bucket: "month", limit: 200 });
  expect(month.periods.rows[0]).toMatchObject({ status: "partial", counterAic: 90, computed: { aic: 180 }, coverage: 3.25 / 4 });
  expect(day.periods.rows.reduce((sum, row) => sum + (row.counterAic ?? 0), 0)).toBe(90);
  expect(day).toMatchObject({ counterGranularityAic: 1, billingLagCaveat: "billing-lag-minutes" });
  const page = queryReconciliation(ctx, period, { bucket: "day", limit: 1 });
  expect(page.periods.rows).toHaveLength(1);
  expect(queryReconciliation(ctx, period, { bucket: "day", limit: 1, cursor: page.periods.nextCursor! }).periods.rows[0]!.status).toBe("no-snapshot");
});

test("observed resets use a zero anchor at the reset instant without discarding month evidence", () => {
  const H = 3600000;
  snapshot(M - H, 500, "synthetic-seat", "2026-10-01");
  snapshot(M + H, 7, "synthetic-seat", "2026-11-01"); snapshot(M + 2 * H, 12, "synthetic-seat", "2026-11-01");
  fixture.ledger.apply(dashboardBatch([priced("old-period", M - 1, 99), priced("since-reset", M, 14), priced("after-first", M + H, 10)]));
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  for (const bucket of ["day", "month"] as const) {
    const data = queryReconciliation(ctx, { start: M, end: M + D }, { bucket, limit: 200 });
    expect(data.periods.rows[0]).toMatchObject({ status: "partial", start: M, end: M + 2 * H, counterAic: 12, computed: { aic: 24 }, coveredMs: 2 * H, coverage: 1 / 12, resetAnchors: 1 });
  }
  const snap = queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "snapshot", limit: 200 });
  expect(snap.periods.rows[0]).toMatchObject({ status: "compared", start: M, end: M + H, counterAic: 7, computed: { aic: 14 } });
});

test("interior decrease excludes only its span and retains explicit partial coverage", () => {
  const H = 3600000;
  snapshot(M, 100); snapshot(M + H, 120); snapshot(M + 2 * H, 5); snapshot(M + 3 * H, 150);
  fixture.ledger.apply(dashboardBatch([priced("before", M + 1, 5), priced("invalid-span", M + H + 1, 99), priced("after", M + 2 * H + 1, 7)]));
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  expect(queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "day", limit: 200 }).periods.rows[0]).toMatchObject({
    status: "partial", counterAic: 165, computed: { aic: 12 }, coverage: 1 / 12, exclusions: { "counter-decrease": 1 } });
});

test("snapshot cursor can continue through observations exactly at the period end", () => {
  snapshot(M, 0); snapshot(M + D / 2, 5); snapshot(M + D, 10); snapshot(M + D, 11);
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  const first = queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "snapshot", limit: 1 });
  expect(first.periods.nextCursor).not.toBeNull();
  const last = queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "snapshot", limit: 1, cursor: first.periods.nextCursor! });
  expect(last.periods.rows).toHaveLength(1); expect(last.periods.rows[0]).toMatchObject({ status: "compared", counterAic: 6, end: M + D });
  expect(last.periods.nextCursor).toBeNull();
});

test("covered day uses compared and calibration is summed on the exact pair spans", () => {
  const M = Date.UTC(2026, 9, 3);
  snapshot(M - D, 0); snapshot(M, 500); snapshot(M + D / 2, 505); snapshot(M + D, 510);
  fixture.ledger.apply(dashboardBatch([priced("fit", M - D + 1, 1000), priced("one", M + 1, 10), priced("two", M + D / 2 + 1, 10)]));
  const ctx = reader.snapshot(ctx => ctx);
  const data = queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "day", limit: 200 });
  expect(data.periods.rows[0]).toMatchObject({ status: "compared", counterAic: 10, computed: { aic: 20 }, calibratedAic: 10, coverage: 1, coveredMs: D });
});

test("snapshot byte caps shorten a 200-row page with a lossless cursor", () => {
  const M = Date.UTC(2026, 9, 3);
  snapshot(M - D, 0);
  for (let i = 0; i <= 201; i++) snapshot(M + i * 60000, 1234.56789012345 + i * 12.34567890123);
  fixture.ledger.apply(dashboardBatch([priced("training-wide", M - D + 1, 2469.1357802469)]));
  fixture.ledger.apply(dashboardBatch(Array.from({ length: 201 }, (_, i) => dashboardCall(`wide-${i}`, {
    ts: M + i * 60000 + 1, usage: { input: 1234567890123, cacheRead: 2345678901234, cacheWrite: 3456789012345, cacheWrite1h: 1234567890123, output: 4567890123456, reasoning: 1234567890123 },
    price: { status: "priced", aic: 123.4567890123, components: { input: 12.34567890123, cacheRead: 23.45678901234, cacheWrite: 34.56789012345, output: 53.08643097528 }, rateVersion: "fixture", tier: "fixture", confidence: "estimated" },
  }))));
  const ctx = reader.snapshot(ctx => ctx); let cursor: string | undefined; const ends: number[] = [];
  do {
    const data = queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "snapshot", limit: 200, cursor });
    expect(Buffer.byteLength(JSON.stringify({ revision: ctx.revision, data }))).toBeLessThanOrEqual(256 * 1024);
    if (!cursor) expect(data.periods.rows.length).toBeLessThan(200);
    ends.push(...data.periods.rows.map(row => row.end)); cursor = data.periods.nextCursor ?? undefined;
  } while (cursor);
  expect(ends).toHaveLength(201); expect(new Set(ends).size).toBe(201);
});

test("bucket calibrated totals use each pair endpoint fit rather than a single bucket factor", () => {
  const M = Date.UTC(2026, 9, 3);
  snapshot(M - D, 0); snapshot(M, 500); snapshot(M + D / 2, 900); snapshot(M + D, 1300);
  fixture.ledger.apply(dashboardBatch([priced("fit", M - D + 1, 1000), priced("first-pair", M + 1, 1000), priced("second-pair", M + D / 2 + 1, 1000)]));
  const ctx = reader.snapshot(ctx => ctx);
  const row = queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "day", limit: 200 }).periods.rows[0]!;
  expect(row).toMatchObject({ counterAic: 800, computed: { aic: 2000, aicDisplay: { primaryAic: 950 } }, calibratedAic: 950, calibration: { factor: 0.45 } });
});

test("an unobserved reset is never inferred from the initial snapshot reset date", () => {
  snapshot(M + D / 4, 7, "synthetic-seat", "2026-11-01");
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  expect(queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "month", limit: 200 }).periods.rows[0]).toMatchObject({ status: "missing-anchor", counterAic: null, coverage: 0, resetAnchors: 0 });
});

test("a previously unknown reset date cannot justify a synthetic zero anchor", () => {
  snapshot(M - D / 4, 100); fixture.db.prepare("UPDATE counter_snapshots SET reset_date=NULL").run();
  snapshot(M + D / 4, 5, "synthetic-seat", "2026-11-01");
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  expect(queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "day", limit: 200 }).periods.rows[0]).toMatchObject({ status: "reset", counterAic: null, coverage: 0, resetAnchors: 0 });
});

test("mixed excluded evidence cannot label an entire bucket as only an unobserved reset", () => {
  snapshot(M - D / 4, 100); snapshot(M + D / 2, 6, "synthetic-seat", "unobserved-reset");
  snapshot(M + D / 4, 5, "synthetic-seat", "unobserved-reset");
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  expect(queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "day", limit: 200 }).periods.rows[0]).toMatchObject({ status: "clock", counterAic: null, coverage: 0, exclusions: { reset: 1, clock: 1 } });
});

// Taking later.reset, dropping either time bound, or accepting multiple cycles loses or overlaps evidence.
test("next-reset dates anchor a gap spanning November exactly at the old next reset", () => {
  const N = Date.UTC(2026, 10, 1);
  snapshot(N - 10 * D, 500, "synthetic-seat", "2026-11-01");
  snapshot(N + 4 * D, 40, "synthetic-seat", "2026-12-01");
  fixture.ledger.apply(dashboardBatch([priced("before-reset-gap", N - 1, 99), priced("november-gap", N, 80)]));
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  const row = queryReconciliation(ctx, { start: N, end: N + 5 * D }, { bucket: "month", limit: 50 }).periods.rows[0]!;
  expect(row).toMatchObject({ start: N, end: N + 4 * D, counterAic: 40, computed: { aic: 80 }, resetAnchors: 1, coveredMs: 4 * D, coverage: 0.8 });
});

test.each([
  ["before earlier", M + D, M + 2 * D, "2026-10-01", "2026-11-01"],
  ["after later", M + D, M + 2 * D, "2026-11-01", "2026-12-01"],
  ["multiple cycles", M - D, M + D, "2026-10-01", "2026-12-01"],
  ["backwards dates", M - D, M + D, "2026-11-01", "2026-10-01"],
  ["last-reset reading", M - D, M + D, "2026-09-01", "2026-10-01"],
  ["malformed date", M - D, M + D, "2026-09-31", "2026-11-01"],
] as const)("unobserved reset %s stays excluded", (_name, before, after, oldReset, nextReset) => {
  snapshot(before, 500, "synthetic-seat", oldReset); snapshot(after, 7, "synthetic-seat", nextReset);
  fixture.ledger.apply(dashboardBatch([priced("excluded-reset", M, 99)]));
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  expect(queryReconciliation(ctx, { start: M, end: M + 3 * D }, { bucket: "snapshot", limit: 50 }).periods.rows.at(-1)).toMatchObject({
    status: "reset", counterAic: null, computed: null, resetAnchors: 0, coveredMs: 0, exclusions: { reset: 1 } });
});

test.each([0, 3600000])("observed reset accepts equality with either timestamp (%i)", offset => {
  snapshot(M, 500, "synthetic-seat", "2026-10-01");
  snapshot(M + 3600000, 7, "synthetic-seat", "2026-11-01");
  // offset=0: reset equals earlier.ts; offset=1h: reset equals later.ts.
  fixture.db.prepare("UPDATE counter_snapshots SET ts=ts-?").run(offset);
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  expect(queryReconciliation(ctx, { start: M - D, end: M + D }, { bucket: "snapshot", limit: 50 }).periods.rows.at(-1)).toMatchObject({
    status: "compared", start: M, counterAic: 7, resetAnchors: 1 });
});

test("equal timestamps keep the latest write without a clock or lost counter rise", () => {
  const H = 3600000;
  snapshot(M, 100); snapshot(M + H, 105); snapshot(M + H, 107); snapshot(M + 2 * H, 110);
  fixture.ledger.apply(dashboardBatch([priced("dup-before", M, 5), priced("dup-after", M + H, 3)]));
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  const day = queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "day", limit: 50 }).periods.rows[0]!;
  expect(day).toMatchObject({ counterAic: 10, computed: { aic: 8 }, exclusions: {}, coveredMs: 2 * H });
  const snap = queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "snapshot", limit: 50 }).periods.rows;
  expect(snap.map(row => [row.end, row.status, row.counterAic])).toEqual([[M + H, "compared", 7], [M + 2 * H, "compared", 3]]);
});

test("snapshot and day modes both exclude a pair ending exactly at the period start", () => {
  const M = Date.UTC(2026, 9, 3);
  snapshot(M - D / 2, 0); snapshot(M, 50); snapshot(M + D / 2, 60);
  fixture.ledger.apply(dashboardBatch([priced("outside-period", M - 1, 99), priced("inside-period", M, 12)]));
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  for (const bucket of ["day", "snapshot"] as const) {
    const rows = queryReconciliation(ctx, { start: M, end: M + D }, { bucket, limit: 50 }).periods.rows;
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ start: M, counterAic: 10, computed: { aic: 12 } });
  }
});

test("a compared span with no local calls exposes the other-client gap and no ratio", () => {
  snapshot(M, 100); snapshot(M + D, 110);
  const ctx = reader.snapshot(ctx => ctx);
  for (const mode of ["off", "auto"] as const) {
    ctx.calibrationMode = mode;
    for (const bucket of ["day", "snapshot"] as const) {
      const row = queryReconciliation(ctx, { start: M, end: M + D }, { bucket, limit: 50 }).periods.rows[0]!;
      expect(row).toMatchObject({ counterAic: 10, computed: { calls: 0, aic: 0, aicDisplay: { primaryAic: 0, publishedAic: 0 } },
        calibratedAic: 0, gap: 10, calibratedGap: 10, ratio: null, calibratedRatio: null, ratioReason: "no-local-calls" });
    }
  }
  const data = queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "day", limit: 50 });
  expect(data.caveats.join(" ")).toMatch(/no local calls.*other clients/i);
});

test("unknown all-unpriced spans remain null rather than becoming no-local-call zeros", () => {
  snapshot(M, 100); snapshot(M + D, 110);
  fixture.ledger.apply(dashboardBatch([dashboardCall("unknown-only", { ts: M, price: { status: "unpriced", reason: "unknown-model" } })]));
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  expect(queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "day", limit: 50 }).periods.rows[0]).toMatchObject({
    computed: { calls: 1, aic: null }, calibratedAic: null, gap: null, ratio: null, ratioReason: null });
});

test("account change takes precedence over an otherwise observed reset", () => {
  snapshot(M - 3600000, 500, "synthetic-seat", "2026-10-01");
  snapshot(M + 3600000, 7, "other-synthetic-seat", "2026-11-01");
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  expect(queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "snapshot", limit: 50 }).periods.rows[0]).toMatchObject({
    status: "account-change", exclusions: { "account-change": 1 }, counterAic: null, resetAnchors: 0 });
});

// An empty accepted pair must not turn an adjacent all-unpriced pair into a known zero.
test("an empty pair does not erase unknown AIC in a neighboring accepted span", () => {
  snapshot(M, 100); snapshot(M + D / 2, 105); snapshot(M + D, 110);
  fixture.ledger.apply(dashboardBatch([dashboardCall("unknown-with-empty-neighbor", { ts: M, price: { status: "unpriced", reason: "unknown-model" } })]));
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  expect(queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "day", limit: 50 }).periods.rows[0]).toMatchObject({
    counterAic: 10, computed: { calls: 1, pricedCalls: 0, unpricedCalls: 1, aic: null, aicDisplay: { primaryAic: null, publishedAic: null } },
    calibratedAic: null, gap: null, ratio: null, ratioReason: null });
});

// These regressions pin ingest completeness, calendar resets, and duplicate selection.
test.each([false, true])("zero-call spans preserve ingest completeness (%s)", pending => {
  snapshot(M, 100); snapshot(M + D, 110);
  if (pending) fixture.ledger.apply(dashboardBatch([], { states: [{ path: "synthetic/pending.jsonl", inode: "fixture-inode",
    size: 10, offset: 0, mtimeMs: NOW, parseErrors: 0, generation: 0, prefixHash: "fixture" }] }));
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  for (const bucket of ["day", "month", "snapshot"] as const) {
    const row = queryReconciliation(ctx, { start: M, end: M + D }, { bucket, limit: 50 }).periods.rows[0]!;
    expect(row).toMatchObject({ computed: { calls: 0, pendingData: pending, possibleUndercount: pending, aic: pending ? null : 0,
      aicDisplay: { publishedAic: pending ? null : 0, primaryAic: pending ? null : 0 } },
      gap: pending ? null : 10, ratio: null, ratioReason: pending ? "ingest-pending" : "no-local-calls",
      calibratedAic: pending ? null : 0, calibratedGap: pending ? null : 10 });
  }
});

test("duplicate selection remains frozen when a late duplicate is appended during paging", () => {
  const H = 3600000; snapshot(M, 0); snapshot(M + H, 5); snapshot(M + 2 * H, 9);
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  const period = { start: M, end: M + D };
  const first = queryReconciliation(ctx, period, { bucket: "snapshot", limit: 1 });
  snapshot(M + 2 * H, 50);
  const next = queryReconciliation(ctx, period, { bucket: "snapshot", limit: 1, cursor: first.periods.nextCursor! });
  expect(first.periods.rows).toHaveLength(1); expect(next.periods.rows).toHaveLength(1);
  expect([first.periods.rows[0]!.counterAic, next.periods.rows[0]!.counterAic]).toEqual([5, 4]);
});

test("a reset date advancing less than one calendar cycle is unobserved", () => {
  const N = Date.UTC(2026, 10, 1);
  snapshot(N - D, 100, "synthetic-seat", "2026-11-01"); snapshot(N + D, 5, "synthetic-seat", "2026-11-15");
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  expect(queryReconciliation(ctx, { start: N, end: N + 2 * D }, { bucket: "snapshot", limit: 50 }).periods.rows[0])
    .toMatchObject({ status: "reset", counterAic: null, resetAnchors: 0 });
});

test("a priced zero-AIC call has a ratio without a no-local-calls reason", () => {
  snapshot(M, 100); snapshot(M + D, 110); fixture.ledger.apply(dashboardBatch([priced("zero-priced", M, 0)]));
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  expect(queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "snapshot", limit: 50 }).periods.rows[0])
    .toMatchObject({ computed: { calls: 1, aic: 0 }, ratio: 0, ratioReason: null });
});

test.each(["2026-11-01T19:45:00Z", "2026-11-01T00:00:00+08:00"])("reset date format-only changes are not resets (%s)", reset => {
  snapshot(M, 100, "synthetic-seat", reset); snapshot(M + D, 110, "synthetic-seat", "2026-11-01");
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  expect(queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "snapshot", limit: 50 }).periods.rows[0])
    .toMatchObject({ status: "compared", counterAic: 10, resetAnchors: 0 });
});

test("observed time-suffixed reset dates anchor at midnight UTC", () => {
  snapshot(M - 3600000, 100, "synthetic-seat", "2026-10-01T20:45:00-08:00");
  snapshot(M + 3600000, 5, "synthetic-seat", "2026-11-01T12:00:00Z");
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  expect(queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "snapshot", limit: 50 }).periods.rows[0])
    .toMatchObject({ status: "compared", start: M, counterAic: 5, resetAnchors: 1 });
});

test.each([
  [2026, 0, 29, "2026-02-28"], [2026, 0, 30, "2026-02-28"], [2026, 0, 31, "2026-02-28"],
  [2028, 0, 29, "2028-02-29"], [2028, 0, 30, "2028-02-29"], [2028, 0, 31, "2028-02-29"],
  [2026, 2, 29, "2026-04-29"], [2026, 2, 30, "2026-04-30"], [2026, 2, 31, "2026-04-30"],
])("calendar reset cycle clamps %i/%i/%i to %s", (year, month, day, next) => {
  const at = Date.UTC(year, month, day), reset = new Date(at).toISOString().slice(0, 10);
  snapshot(at - 3600000, 100, "synthetic-seat", reset); snapshot(at + 3600000, 5, "synthetic-seat", next);
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  expect(queryReconciliation(ctx, { start: at, end: at + D }, { bucket: "snapshot", limit: 50 }).periods.rows[0])
    .toMatchObject({ status: "compared", start: at, counterAic: 5, resetAnchors: 1 });
});

test.each([true, false])("unchanged next-reset date with a dropped counter anchors only inside the pair (%s)", inside => {
  const before = inside ? M - 3600000 : M + 3600000, after = M + 2 * 3600000;
  snapshot(before, 100, "synthetic-seat", "2026-10-01"); snapshot(after, 5, "synthetic-seat", "2026-10-01");
  fixture.ledger.apply(dashboardBatch([priced("billing-lag-reset", M, 7)]));
  const ctx = reader.snapshot(ctx => ctx); ctx.calibrationMode = "off";
  expect(queryReconciliation(ctx, { start: M, end: M + D }, { bucket: "snapshot", limit: 50 }).periods.rows.at(-1))
    .toMatchObject(inside ? { status: "compared", start: M, counterAic: 5, resetAnchors: 1, computed: { aic: 7 } }
      : { status: "counter-decrease", counterAic: null, resetAnchors: 0 });
});

test("reconciliation and calibration select the highest valid duplicate and retain invalid-only gaps", () => {
  snapshot(M, 100); snapshot(M, 110); snapshot(M, -1);
  snapshot(M + D, 510); snapshot(M + D, 610); snapshot(M + D, 620);
  fixture.db.prepare("UPDATE counter_snapshots SET remaining=-1 WHERE rowid=(SELECT MAX(rowid) FROM counter_snapshots)").run();
  snapshot(M + 2 * D, -1); snapshot(M + 2 * D, -2); snapshot(M + 3 * D, 710);
  fixture.ledger.apply(dashboardBatch([priced("valid-duplicates", M, 1000)]));
  const ctx = reader.snapshot(ctx => ctx);
  expect(ctx.calibration.at(M + D, "auto")).toMatchObject({ status: "calibrated", counterDelta: 500, factor: 0.5 });
  const rows = queryReconciliation(ctx, { start: M, end: M + 3 * D }, { bucket: "snapshot", limit: 50 }).periods.rows;
  expect(rows.map(row => [row.status, row.counterAic])).toEqual([["compared", 500], ["invalid-counter", null], ["invalid-counter", null]]);
});
