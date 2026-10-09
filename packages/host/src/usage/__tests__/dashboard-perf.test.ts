import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import { openDashboardReader } from "../dashboard-reader.js";
import { DASHBOARD_ROUTES } from "../api-routes.js";
import * as planModule from "./fixtures/dashboard-plan.js";
import { captureQueries, explainQueries, assertCallPlans, assertRoutePlans, seedPlanLedger, planRequests, executePlanRequest } from "./fixtures/dashboard-plan.js";
import { createDashboardFixture, DASHBOARD_NOW } from "./fixtures/dashboard-ledger.js";
const closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0).reverse()) close(); });

test("all five replacement queries use bounded indexed billing reads", () => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const seed = seedPlanLedger(fixture.file, 1600);
  expect(fixture.db.pragma("user_version")).toBe(5);
  const reader = openDashboardReader(fixture.file, { instanceId: "plans", serverBuild: "fixture", now: () => seed.now, calibrationMode: () => "auto" })!;
  closers.push(() => reader.close());
  for (const request of planRequests(seed.periods[0]!, seed.sessionId, seed.runId)) {
    const result = reader.snapshot(ctx => captureQueries(ctx, () => executePlanRequest(ctx, request)));
    expect(result.queries.filter(q => !q.calibration).length, request.name).toBeLessThanOrEqual(request.cap);
    assertRoutePlans(request, result.queries, explainQueries(fixture.db, result.queries));
    planModule.assertReferenceResult(request.name, result.value, planModule.referenceRouteResult(fixture.db, request));
    expect(Buffer.byteLength(JSON.stringify(result.value))).toBeLessThanOrEqual(request.kib * 1024);
  }
});
test("replacement billing-range oracle kills index and widened-bound mutants", () => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const seed = seedPlanLedger(fixture.file, 1600);
  const reader = openDashboardReader(fixture.file, { instanceId: "mutants", serverBuild: "fixture", now: () => seed.now, calibrationMode: () => "off" })!;
  closers.push(() => reader.close());
  const request = planRequests(seed.periods[0]!, seed.sessionId, seed.runId).find(r => r.name === "overview")!;
  const captured = reader.snapshot(ctx => captureQueries(ctx, () => executePlanRequest(ctx, request)));
  const query = captured.queries.find(q => !q.calibration && /calls c INDEXED BY calls_period_read/.test(q.sql) && /c.ts>=\?/.test(q.sql))!;
  expect(query).toBeDefined();
  for (const sql of [query.sql.replace("INDEXED BY calls_period_read", "NOT INDEXED"), query.sql.replace("c.ts>=?", "(c.ts>=? OR 1)")]) {
    expect(sql).not.toBe(query.sql);
    const mutant = { ...query, sql };
    const queries = captured.queries.map(q => q === query ? mutant : q);
    expect(() => assertRoutePlans(request, queries, explainQueries(fixture.db, queries))).toThrow(/call-table scan|access path/);
  }
});
test("stored selection oracle rejects dynamic-on-v4 billing queries", () => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const seed = seedPlanLedger(fixture.file, 100);
  const request = planRequests(seed.periods[0]!, seed.sessionId, seed.runId).find(r => r.name === "overview")!;
  const sql = "SELECT id FROM calls c INDEXED BY calls_period_read WHERE c.ts>=? AND c.ts<? AND NOT EXISTS (SELECT 1 FROM calls prior WHERE prior.fingerprint=c.fingerprint AND prior.id<c.id)";
  const queries = [{ sql, args: [seed.periods[0]!.start, seed.now] }];
  expect(() => assertRoutePlans(request, queries, explainQueries(fixture.db, queries))).toThrow(/stored selection/);
});

test("query capture includes each raw iterator execution but not unused prepares", () => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const reader = openDashboardReader(fixture.file, { instanceId: "stream-capture", serverBuild: "fixture", now: () => DASHBOARD_NOW, calibrationMode: () => "auto" })!;
  closers.push(() => reader.close());
  const result = reader.snapshot(ctx => captureQueries(ctx, () => {
    ctx.db.prepare("SELECT 99 AS unused");
    const statement = ctx.db.prepare("SELECT ? AS value").raw();
    return [...statement.iterate(7), ...statement.iterate(8)];
  }));
  expect(result.value).toEqual([[7], [8]]);
  expect(result.queries).toEqual([
    { sql: "SELECT ? AS value", args: [7], calibration: undefined },
    { sql: "SELECT ? AS value", args: [8], calibration: undefined },
  ]);
});


test("plan entries reject duplicate or unreviewed registered routes", () => {
  const validate = planModule.assertRegisteredRoutes;
  const paths = planRequests({ start: 0, end: 1 }, "s", "r").map(r => r.path);
  expect(() => validate([...DASHBOARD_ROUTES, DASHBOARD_ROUTES[0]!], paths)).toThrow(/duplicate/);
  expect(() => validate([...DASHBOARD_ROUTES, { path: "/api/unbounded", handle() { return {}; } }], paths)).toThrow(/missing/);
});


test("dense-month fixture has month-end density, short lifetimes, ten-minute counters and reports", () => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const seed = seedPlanLedger(fixture.file, 10_000, { denseMonthCalls: 1750 });
  expect(seed.now).toBe(Date.UTC(2026, 9, 31, 23));
  expect(fixture.db.prepare("SELECT count(*) AS n FROM calls WHERE ts>=? AND ts<?").get(Date.UTC(2026, 9, 1), seed.now)).toEqual({ n: 1750 });
  expect(fixture.db.prepare("SELECT max(ended_at-started_at) AS lifetime FROM runs_meta").get()).toMatchObject({ lifetime: expect.any(Number) });
  expect((fixture.db.prepare("SELECT max(ended_at-started_at) AS lifetime FROM runs_meta").get() as any).lifetime).toBeLessThan(7 * 86_400_000);
  expect(fixture.db.prepare("SELECT min(ts-previous) AS cadence FROM (SELECT ts,lag(ts) OVER (ORDER BY ts) AS previous FROM counter_snapshots)").get()).toEqual({ cadence: 600000 });
  expect((fixture.db.prepare("SELECT count(*) AS n FROM calls WHERE is_report=1").get() as any).n).toBeGreaterThan(0);
});


test("million row timing is local opt in only", () => {
  for (const vars of [{ SPIDER_USAGE_BENCHMARK: "", CI: "" }, { SPIDER_USAGE_BENCHMARK: "1", CI: "true" }]) {
    const run = spawnSync(process.execPath, ["scripts/usage-dashboard-benchmark.mjs"], { encoding: "utf8", env: { ...process.env, ...vars } });
    expect(run.status, run.stderr).toBe(77); expect(run.stdout).toContain("SKIP");
  }
  const failed = spawnSync(process.execPath, ["--input-type=module", "-e", `import { benchmarkSamples } from './scripts/usage-dashboard-benchmark.mjs'; benchmarkSamples(() => { throw new Error('synthetic-failure'); });`], { encoding: "utf8" });
  expect(failed.status).toBe(1); expect(failed.stderr).toContain("synthetic-failure"); expect(failed.stdout).not.toMatch(/p50|p95/);
});



test("dense data has mixed providers/models, overlapping sessions, jitter and overlapping reports", () => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  seedPlanLedger(fixture.file, 10_000, { denseMonthCalls: 1750 });
  const scalar = (sql: string) => (fixture.db.prepare(sql).get() as { n: number }).n;
  expect(scalar("SELECT count(DISTINCT provider) AS n FROM calls")).toBeGreaterThan(1);
  expect(scalar("SELECT count(DISTINCT model) AS n FROM calls")).toBeGreaterThan(2);
  expect(scalar("SELECT count(*) AS n FROM calls WHERE run_id IS NULL")).toBeGreaterThan(0);
  expect(scalar("SELECT count(DISTINCT delta) AS n FROM (SELECT ts-lag(ts) OVER (ORDER BY ts) AS delta FROM calls)")).toBeGreaterThan(3);
  expect(scalar("SELECT count(*) AS n FROM calls r WHERE is_report=1 AND EXISTS (SELECT 1 FROM calls t WHERE t.run_id=r.run_id AND t.is_report=0)")).toBeGreaterThan(0);
  expect(scalar("WITH spans AS (SELECT session_id,min(ts) AS lo,max(ts) AS hi FROM calls GROUP BY session_id) SELECT count(*) AS n FROM spans a JOIN spans b ON a.session_id<b.session_id AND a.lo<b.hi AND b.lo<a.hi")).toBeGreaterThan(0);
});


test.each(["calls", '"calls"'])("calibration attribution survives delayed execution, renamed CTEs and new statements using %s", (table) => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const seed = seedPlanLedger(fixture.file, 10_000);
  const reader = openDashboardReader(fixture.file, { instanceId: "attribution", serverBuild: "fixture", now: () => seed.now, calibrationMode: () => "auto" })!;
  closers.push(() => reader.close());
  const request = planRequests(seed.periods[0]!, seed.sessionId, seed.runId).find(r => r.name === "calibration")!;
  let delayed: ReturnType<typeof fixture.db.prepare>;
  const captured = reader.snapshot(ctx => {
    const service = ctx.calibration;
    ctx.calibration = new Proxy(service, { get(target, key) {
      if (key === "at") return () => { delayed = ctx.db.prepare(`WITH renamed AS MATERIALIZED (SELECT c.id FROM ${table} c INDEXED BY calls_period_read WHERE c.ts>=? AND c.ts<?) SELECT count(*) FROM renamed`); return target.at(seed.now, "off"); };
      return Reflect.get(target, key);
    } });
    try { return captureQueries(ctx, () => { ctx.calibration.at(seed.now, "auto"); delayed!.get(seed.periods[0]!.start, seed.now); }); }
    finally { ctx.calibration = service; }
  });
  expect(captured.queries[0]!.calibration).toBe("at");
  assertRoutePlans({ ...request, access: "none" }, captured.queries, explainQueries(fixture.db, captured.queries));
  const query = captured.queries[0]!;
  const widened = { ...query, sql: query.sql.replace("c.ts<?", "(c.ts<? OR 1)") };
  expect(() => assertRoutePlans({ ...request, access: "none" }, [widened], explainQueries(fixture.db, [widened]))).toThrow(/calibration access path/);
});



test("every calibration call access is bounded, even alongside a bounded period pass", () => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const seed = seedPlanLedger(fixture.file, 100);
  const request = { ...planRequests(seed.periods[0]!, seed.sessionId, seed.runId).find(r => r.name === "calibration")!, access: "none" as const };
  const period = "SELECT id FROM calls INDEXED BY calls_period_read WHERE ts>=? AND ts<?";
  const session = "SELECT id FROM calls INDEXED BY calls_session_read WHERE session_id=? AND ts>=?";
  for (const query of [
    { sql: session, args: [seed.sessionId, seed.periods[0]!.start] },
    { sql: `${period} UNION ALL ${session}`, args: [seed.periods[0]!.start, seed.now, seed.sessionId, seed.periods[0]!.start] },
    { sql: 'SELECT id FROM "calls" WHERE id=?', args: ["plan-0"] },
    { sql: 'SELECT id FROM "calls" WHERE rowid=?', args: [1] },
    { sql: `${period} UNION ALL SELECT id FROM calls WHERE rowid=?`, args: [seed.periods[0]!.start, seed.now, 1] },
  ]) {
    const queries = [{ ...query, calibration: "at" }];
    expect(() => assertRoutePlans(request, queries, explainQueries(fixture.db, queries))).toThrow(/calibration access path/);
  }
  const queries = [{ sql: `${period} UNION ALL ${period}`, args: [seed.periods[0]!.start, seed.now, seed.periods[0]!.start, seed.now], calibration: "at" }];
  expect(() => assertRoutePlans(request, queries, explainQueries(fixture.db, queries))).not.toThrow();
});


test("call passes use real call reads rather than SQL spelling or aliases", () => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const queries = [
    { sql: 'SELECT id FROM "calls" renamed WHERE ts>=? AND ts<?', args: [0, DASHBOARD_NOW] },
    { sql: 'WITH renamed AS MATERIALIZED (SELECT id FROM calls) SELECT * FROM renamed', args: [] },
    { sql: 'SELECT c.id FROM (SELECT 1) x JOIN calls c ON c.id=?', args: ["absent"] },
    { sql: "SELECT 'FROM calls c'", args: [] },
  ];
  const passes = Reflect.get(planModule, "callPassQueries");
  expect(passes).toBeTypeOf("function");
  expect(passes(fixture.db, queries)).toEqual(queries.slice(0, 3));
});


test("report-overlap exemption requires an indexed run equality inside report_runs", () => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const seed = seedPlanLedger(fixture.file, 100);
  const request = { ...planRequests(seed.periods[0]!, seed.sessionId, seed.runId).find(r => r.name === "calibration")!, access: "none" as const };
  const check = (lookup: string, cte = "report_runs") => {
    const sql = `WITH ${cte} AS MATERIALIZED (SELECT r.run_id FROM calls r INDEXED BY calls_reports WHERE r.is_report=1 AND NOT EXISTS (${lookup}))
      SELECT id FROM calls INDEXED BY calls_period_read WHERE ts>=? AND ts<? UNION ALL SELECT run_id FROM ${cte}`;
    const queries = [{ sql, args: [seed.periods[0]!.start, seed.now], calibration: "at" }];
    return () => assertRoutePlans(request, queries, explainQueries(fixture.db, queries));
  };
  const lookup = "SELECT 1 FROM calls d INDEXED BY calls_run_detail WHERE d.run_id=r.run_id AND d.is_report=0 AND d.copied=0 AND d.source_kind='transcript'";
  expect(check(lookup)).not.toThrow();
  expect(check(lookup.replace("INDEXED BY calls_run_detail", "NOT INDEXED"))).toThrow(/call-table scan|calibration access path/);
  expect(check(lookup, "outside_reports")).toThrow(/calibration access path/);
  expect(check(lookup.replace("calls_run_detail", "calls_session_read"))).toThrow(/call-table scan|calibration access path/);
  expect(check(lookup.replace("d.run_id=r.run_id", "d.run_id>r.run_id"))).toThrow(/calibration access path/);
});



test("legacy earliest access indexes cannot change silently", () => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const seed = seedPlanLedger(fixture.file, 100);
  const request = { ...planRequests(seed.periods[0]!, seed.sessionId, seed.runId).find(r => r.name === "calibration")!, access: "none" as const };
  const queries = [{ sql: "SELECT id FROM calls INDEXED BY calls_period_read WHERE ts>=? AND ts<?", args: [seed.periods[0]!.start, seed.now], calibration: "earliest" }];
  expect(() => assertRoutePlans(request, queries, explainQueries(fixture.db, queries))).toThrow(/earliest.*index/);
});



test("attributed calls reads with no identifiable access cannot pass vacuously", () => {
  const request = { ...planRequests({ start: 0, end: 1 }, "session", "run").find(r => r.name === "calibration")!, access: "none" as const };
  const queries = [{ sql: "SELECT id FROM calls WHERE rowid=?", args: [1], calibration: "at" }];
  expect(() => assertRoutePlans(request, queries, [{ id: 1, parent: 0, statement: 0, detail: "SEARCH renamed", callReads: ["calls"] }])).toThrow(/calibration access path/);
});



test("legacy earliest keeps its exact call-index set and rejects full call scans", () => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const seed = seedPlanLedger(fixture.file, 10_000);
  const reader = openDashboardReader(fixture.file, { instanceId: "earliest-pins", serverBuild: "fixture", now: () => seed.now, calibrationMode: () => "auto" })!;
  closers.push(() => reader.close());
  const request = { ...planRequests(seed.periods[0]!, seed.sessionId, seed.runId).find(r => r.name === "calibration")!, access: "none" as const };
  const captured = reader.snapshot(ctx => captureQueries(ctx, () => ctx.calibration.earliest("auto")));
  const query = captured.queries.find(q => q.sql.includes("interval_calls AS MATERIALIZED"))!;
  expect(query.calibration).toBe("earliest");
  const plans = explainQueries(fixture.db, [query]);
  expect(() => assertRoutePlans(request, [query], plans)).not.toThrow();
  for (const callReads of [plans[0]!.callReads!.slice(1), [...plans[0]!.callReads!, "calls_session_read"]]) {
    expect(() => assertRoutePlans(request, [query], [{ ...plans[0]!, callReads }, ...plans.slice(1)])).toThrow(/earliest.*index/);
  }
  const scan = { ...query, sql: query.sql.replace("CROSS JOIN calls r INDEXED BY calls_period_read", "CROSS JOIN calls r NOT INDEXED") };
  expect(scan.sql).not.toBe(query.sql);
  expect(() => assertRoutePlans(request, [scan], explainQueries(fixture.db, [scan]))).toThrow(/call-table scan/);
});
