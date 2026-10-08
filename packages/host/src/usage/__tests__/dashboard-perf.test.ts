import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import { openDashboardReader } from "../dashboard-reader.js";
import { dashboardKey } from "../dashboard-identities.js";
import type { Filter } from "../dashboard-contract.js";
import { LEGACY_DASHBOARD_ROUTES as DASHBOARD_ROUTES } from "../api-routes.js";
import * as planModule from "./fixtures/dashboard-plan.js";
import { captureQueries, explainQueries, assertCallPlans, assertRoutePlans, seedPlanLedger, planRequests } from "./fixtures/dashboard-plan.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDashboardFixture, DASHBOARD_NOW } from "./fixtures/dashboard-ledger.js";

const closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0).reverse()) close(); });

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

test("small fixture plans enforce range access", async () => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const seed = seedPlanLedger(fixture.file, 10_000);
  expect(fixture.db.pragma("user_version")).toBe(4);
  expect(fixture.db.prepare("SELECT count(*) AS n FROM calls").get()).toEqual({ n: 10_000 });
  expect(seed.periods).toHaveLength(2);
  expect(seed.periods[0]!.end).toBe(DASHBOARD_NOW);
  expect(seed.periods[1]!.end - seed.periods[1]!.start).toBe(366 * 86_400_000);
  const counts: unknown[] = [];
  for (const period of seed.periods) for (const request of planRequests(period, seed.sessionId, seed.runId)) {
    const reader = openDashboardReader(fixture.file, { instanceId: "plan", serverBuild: "fixture", now: () => DASHBOARD_NOW, calibrationMode: () => "auto" })!;
    try {
      const route = DASHBOARD_ROUTES.find(route => route.path === request.path)!;
      expect(route, request.name).toBeDefined();
      const run = () => reader.snapshot(ctx => {
        const result = captureQueries(ctx, () => route.handle(ctx, request.params));
        const queries = result.queries.filter(query => !query.sql.includes("call-selection-revision"));
        const plans = explainQueries(ctx.db, queries);

        expect(Buffer.byteLength(JSON.stringify(result.value)), request.name).toBeLessThanOrEqual(request.kib * 1024);
        return { ...result, queries, plans };
      });
      const cold = run(), hit = run();
      const calls = (queries: typeof cold.queries) => planModule.callPassQueries(fixture.db, queries.filter(q => q.calibration));
      for (const result of [cold, hit]) {
        assertRoutePlans(request, result.queries, result.plans);
        expect(result.queries.filter(q => !q.calibration).length, request.name).toBeLessThanOrEqual(request.cap);
        const history = calls(result.queries).filter(q => q.calibration === "history");
        expect(history.length, request.name).toBe(result === cold && request.name === "rates" ? 1 : 0);
      }
      const hasCalibration = ["overview", "explorer", "detail-session", "detail-run", "cache", "reconciliation", "rates"].includes(request.name);
      expect(calls(cold.queries).length, `${request.name} calibration miss passes`).toBe(request.name === "rates" ? (period === seed.periods[0] ? 2 : 3) : hasCalibration ? 1 : 0);
      expect(cold.queries.filter(q => q.calibration), `${request.name} calibration miss SELECTs`).toHaveLength(request.name === "rates" ? (period === seed.periods[0] ? 5 : 6) : hasCalibration ? 2 : 0);
      expect(hit.queries.filter(q => q.calibration), `${request.name} calibration hit SELECTs`).toHaveLength(request.name === "rates" ? 3 : hasCalibration ? 1 : 0);
      expect(calls(hit.queries), `${request.name} calibration hit`).toHaveLength(0);
      if (!["status", "source-errors", "context", "detail-links-session", "detail-links-run"].includes(request.name)) {
        if (request.name !== "filter-values") expect(calls(cold.queries).length, `${request.name} calibration miss`).toBeGreaterThan(0);
      }
      if (request.name.startsWith("detail") && request.name.endsWith("session")) {
        expect(cold.plans.some(p => /SEARCH .*USING (?:COVERING )?INDEX calls_session_read \(session_id=\?/.test(p.detail))).toBe(true);
        expect(cold.plans.some(p => /SEARCH .*USING (?:COVERING )?INDEX runs_meta_session/.test(p.detail))).toBe(true);
      }
      if (request.name.startsWith("detail") && request.name.endsWith("run")) expect(cold.plans.some(p => /SEARCH .*USING (?:COVERING )?INDEX runs_meta_id/.test(p.detail))).toBe(true);
      if (["overview", "explorer", "cache", "rates", "detail-session", "detail-run"].includes(request.name)) {
        const column = request.name === "detail-session" ? "session_id" : request.name === "detail-run" ? "run_id" : undefined;
        const expected = fixture.db.prepare(`SELECT count(*) AS calls,sum(aic) AS aic FROM calls WHERE ts>=? AND ts<? ${column ? `AND ${column}=?` : ""}`).get(period.start, period.end, ...(column ? [column === "session_id" ? seed.sessionId : seed.runId] : []));
        expect((cold.value as any).totals, request.name).toMatchObject(expected as object);
      }
      counts.push({ route: request.name, period, routeSelects: cold.queries.filter(q => !q.calibration).length,
        calibrationMissSelects: cold.queries.filter(q => q.calibration).length, calibrationMissCallPasses: calls(cold.queries).length,
        calibrationHitSelects: hit.queries.filter(q => q.calibration).length, calibrationHitCallPasses: calls(hit.queries).length,
        historyCallPasses: calls(cold.queries).filter(q => q.calibration === "history").length, plans: cold.plans });
    } finally { reader.close(); }
  }
  if (process.env.SPIDER_USAGE_PLAN_REPORT === "1" && !process.env.CI) {
    mkdirSync(join(process.env.SPIDER_TEST_FIXTURE_CHECKOUT!, ".spider/scratch/usage-ui"), { recursive: true });
    writeFileSync(join(process.env.SPIDER_TEST_FIXTURE_CHECKOUT!, ".spider/scratch/usage-ui/T12-plans.json"), JSON.stringify(counts, null, 2));
  }
});

test.each(["day", "model,day", "model,actor,day"])("day-grouped Explorer %s keeps the batched calibration budgets", groupBy => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const seed = seedPlanLedger(fixture.file, 10_000);
  for (const period of seed.periods) {
    const reader = openDashboardReader(fixture.file, { instanceId: "day-plans", serverBuild: "fixture", now: () => DASHBOARD_NOW, calibrationMode: () => "auto" })!;
    try {
      const request = planRequests(period, seed.sessionId, seed.runId).find(r => r.name === "explorer")!;
      request.params.set("groupBy", groupBy); request.params.set("limit", "200");
      const run = () => reader.snapshot(ctx => captureQueries(ctx, () => DASHBOARD_ROUTES.find(r => r.path === request.path)!.handle(ctx, request.params)));
      const cold = run(), hit = run(), db = reader.snapshot(ctx => ctx.db);
      for (const result of [cold, hit]) {
        assertRoutePlans(request, result.queries, explainQueries(db, result.queries));
        expect(result.queries.filter(q => !q.calibration && !q.sql.includes("call-selection-revision")), groupBy).toHaveLength(1);
      }
      expect(planModule.callPassQueries(db, cold.queries.filter(q => q.calibration)), groupBy).toHaveLength(1);
      expect(cold.queries.filter(q => q.calibration), groupBy).toHaveLength(2);
      expect(planModule.callPassQueries(db, hit.queries.filter(q => q.calibration)), groupBy).toHaveLength(0);
      expect(hit.queries.filter(q => q.calibration), groupBy).toHaveLength(1);
    } finally { reader.close(); }
  }
});

test.each([
  ["calibration_intervals AS MATERIALIZED", "c"],
  ["interval_calls AS MATERIALIZED", "r"],
])("calibration access path rejects widened ranges in %s", (fragment, alias) => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const seed = seedPlanLedger(fixture.file, 10_000);
  const reader = openDashboardReader(fixture.file, { instanceId: "calibration-plans", serverBuild: "fixture", now: () => DASHBOARD_NOW, calibrationMode: () => "auto" })!;
  closers.push(() => reader.close());
  const request = planRequests(seed.periods[0]!, seed.sessionId, seed.runId).find(r => r.name === "rates")!;
  const captured = reader.snapshot(ctx => captureQueries(ctx, () => {
    const value = DASHBOARD_ROUTES.find(r => r.path === request.path)!.handle(ctx, request.params);
    ctx.calibration.earliest("auto");
    return value;
  }));
  const db = reader.snapshot(ctx => ctx.db);
  assertRoutePlans(request, captured.queries, explainQueries(db, captured.queries));
  const query = captured.queries.find(q => q.calibration && q.sql.includes(fragment))!;
  expect(query, fragment).toBeDefined();
  const bound = `${alias}.ts<json_extract(span.value,'$[2]')`;
  const mutant = { ...query, sql: query.sql.replace(bound, `(${bound} OR 1)`) };
  expect(mutant.sql).not.toBe(query.sql);
  const changed = captured.queries.map(q => q === query ? mutant : q);
  const plans = explainQueries(db, changed); // Preparing successfully is not a kill.
  expect(() => assertRoutePlans(request, changed, plans), fragment).toThrow(/calibration access path/);
});

test("range-predicate and hint mutants are meaningful", async () => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const seed = seedPlanLedger(fixture.file, 10_000);
  const reader = openDashboardReader(fixture.file, { instanceId: "mutant", serverBuild: "fixture", now: () => DASHBOARD_NOW, calibrationMode: () => "off" })!;
  closers.push(() => reader.close());
  const query = reader.snapshot(ctx => captureQueries(ctx, () => DASHBOARD_ROUTES.find(r => r.path === "/api/overview")!.handle(ctx, new URLSearchParams({ start: String(seed.periods[0]!.start), end: String(seed.periods[0]!.end) })))).queries.find(q => q.sql.includes("WITH RECURSIVE"))!;
  assertCallPlans(explainQueries(fixture.db, [query]));
  // Keep bind arity and existing indexes: failures must come from the plan oracle.
  const range = { ...query, sql: query.sql.replace(/c\.ts >= \? AND c\.ts < \?/, "(c.ts + 0) >= ? AND (c.ts + 0) < ?") };
  expect(range.sql).not.toBe(query.sql);
  const hint = { ...query, sql: query.sql.replace("INDEXED BY calls_period_read", "NOT INDEXED") };
  const evidence: { name: string; rejected: string; plans: ReturnType<typeof explainQueries> }[] = [];
  for (const [name, mutant] of [["range predicate", range], ["index hint", hint]] as const) {
    const plans = explainQueries(fixture.db, [mutant]); // Must prepare successfully, not throw a missing-index exception.
    expect(() => assertCallPlans(plans)).toThrow(/call-table scan/);
    evidence.push({ name, rejected: "call-table scan (EXPLAIN succeeded)", plans });
  }
  fixture.db.exec("BEGIN");
  try {
    for (const name of ["calls_period_read", "calls_ts_actor", "calls_session_ts", "calls_provider_model_ts"]) fixture.db.exec(`DROP INDEX ${name}`);
    const noHint = { ...query, sql: query.sql.replace("INDEXED BY calls_period_read", "") };
    const plans = explainQueries(fixture.db, [noHint]);
    expect(() => assertCallPlans(plans)).toThrow(/call-table scan/);
    evidence.push({ name: "index drop inside rollback", rejected: "call-table scan (EXPLAIN succeeded)", plans });
  } finally { fixture.db.exec("ROLLBACK"); }
  assertCallPlans(explainQueries(fixture.db, [query]));
  if (process.env.SPIDER_USAGE_PLAN_REPORT === "1" && !process.env.CI) {
    mkdirSync(join(process.env.SPIDER_TEST_FIXTURE_CHECKOUT!, ".spider/scratch/usage-ui"), { recursive: true });
    writeFileSync(join(process.env.SPIDER_TEST_FIXTURE_CHECKOUT!, ".spider/scratch/usage-ui/T12-mutants.json"), JSON.stringify(evidence, null, 2));
  }
});

test("oracle rejects calls scans inside materialized reconciliation subplans", async () => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const seed = seedPlanLedger(fixture.file, 10_000);
  const reader = openDashboardReader(fixture.file, { instanceId: "scan", serverBuild: "fixture", now: () => DASHBOARD_NOW, calibrationMode: () => "off" })!;
  closers.push(() => reader.close());
  const request = planRequests(seed.periods[0]!, seed.sessionId, seed.runId).find(r => r.name === "reconciliation")!;
  const captured = reader.snapshot(ctx => captureQueries(ctx, () => DASHBOARD_ROUTES.find(r => r.path === request.path)!.handle(ctx, request.params)));
  const query = captured.queries.find(q => q.sql.includes("interval_calls AS MATERIALIZED"))!;
  const mutant = { ...query, sql: query.sql.replace("calls r INDEXED BY calls_period_read", "calls r NOT INDEXED") };
  expect(mutant.sql).not.toBe(query.sql);
  const plans = explainQueries(fixture.db, [mutant]);
  expect(plans.some(p => p.detail === "SCAN r")).toBe(true);
  expect(() => assertCallPlans(plans)).toThrow(/call-table scan/);
});

test("each route pins its own access path and v3 selection, not calibration SQL", async () => {

  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const seed = planModule.seedPlanLedger(fixture.file, 10_000);
  for (const request of planRequests(seed.periods[0]!, seed.sessionId, seed.runId)) {
    const reader = openDashboardReader(fixture.file, { instanceId: "route-mutant", serverBuild: "fixture", now: () => DASHBOARD_NOW, calibrationMode: () => "auto" })!;
    try {
      const result = reader.snapshot(ctx => captureQueries(ctx, () => DASHBOARD_ROUTES.find(r => r.path === request.path)!.handle(ctx, request.params)));
      const own = result.queries.filter(q => !q.calibration);
      const db = reader.snapshot(ctx => ctx.db);
      assertRoutePlans(request, own, explainQueries(db, own));
      for (const query of own) {
        const references = [...query.sql.matchAll(/(?:FROM|JOIN)\s+calls\b(?:\s+(?!WHERE\b|INDEXED\b|NOT\b|ON\b)([A-Za-z_]\w*))?(?:\s+INDEXED BY \w+|\s+NOT INDEXED)?/gi)];
        for (const reference of references) {
          const from = reference[0].replace(/\s+INDEXED BY \w+|\s+NOT INDEXED$/i, "");
          const mutant = { ...query, sql: query.sql.slice(0, reference.index) + from + " NOT INDEXED" + query.sql.slice(reference.index! + reference[0].length) };
          const changed = own.map(q => q === query ? mutant : q);
          const plans = explainQueries(db, changed); // SQL must prepare, not fail with an exception.
          if (JSON.stringify(plans) === JSON.stringify(explainQueries(db, own))) continue; // Optimizer-pruned SQL is equivalent.
          const alias = reference[1] ?? "calls";
          if (plans.some(p => new RegExp(`SEARCH ${alias} USING INTEGER PRIMARY KEY`).test(p.detail)) && !plans.some(p => p.callScans?.length)) continue; // Equivalent rowid lookup, not a scan mutant.
          expect(() => assertRoutePlans(request, changed, plans), `${request.name} ${from} #${reference.index}`).toThrow(/call-table scan|access path/);
        }
        if (query.sql.includes("selection_shadowed = 0")) {
          const mutant = { ...query, sql: query.sql.replaceAll(/(\w+)\.selection_shadowed = 0/g, "NOT EXISTS (SELECT 1 FROM calls prior WHERE prior.fingerprint = $1.fingerprint AND prior.id < $1.id)") };
          const changed = own.map(q => q === query ? mutant : q);
          const plans = explainQueries(db, changed);
          expect(() => assertRoutePlans(request, changed, plans), request.name).toThrow(/stored selection/);
        }
        if (["overview", "explorer", "cache", "rates", "detail-session"].includes(request.name)) {
          const mutant = { ...query, sql: query.sql.replace(/c\.ts >= \?/, "(c.ts >= ? OR 1)") };
          if (mutant.sql === query.sql) continue;
          const changed = own.map(q => q === query ? mutant : q);
          const plans = explainQueries(db, changed);
          expect(() => assertRoutePlans(request, changed, plans), request.name).toThrow(/access path|call-table scan/);
        }
      }
    } finally { reader.close(); }
  }
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


test("dense current-month Overview includes the account comparison pass", () => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const seed = seedPlanLedger(fixture.file, 10_000, { denseMonthCalls: 1750 });
  const reader = openDashboardReader(fixture.file, { instanceId: "dense-comparison", serverBuild: "fixture", now: () => seed.now, calibrationMode: () => "auto" })!;
  closers.push(() => reader.close());
  const request = planRequests(seed.periods[0]!, seed.sessionId, seed.runId).find(r => r.name === "overview")!;
  const result = reader.snapshot(ctx => captureQueries(ctx, () => DASHBOARD_ROUTES.find(r => r.path === request.path)!.handle(ctx, request.params)));
  expect(result.queries.filter(q => !q.calibration)).toHaveLength(3);
  const reference = planModule.referenceRouteResult(fixture.db, request);
  expect(reference).toHaveProperty("comparison.computed");
  expect((result.value as any).comparison.computed).not.toBeNull();
  planModule.assertReferenceResult(request.name, result.value, reference);
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
  const request = planRequests(seed.periods[0]!, seed.sessionId, seed.runId).find(r => r.name === "rates")!;
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


test("id and missing filters plan-check dictionary misses and every lookup range", () => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const seed = seedPlanLedger(fixture.file, 10_000);
  const setup = openDashboardReader(fixture.file, { instanceId: "filter-ids", serverBuild: "fixture", now: () => seed.now, calibrationMode: () => "off" })!;
  const filters = setup.snapshot(ctx => {
    const ids: Filter[] = [{ field: "session", kind: "id", value: seed.sessionId }, { field: "run", kind: "id", value: seed.runId },
      ...([ ["model", "fixture-model"], ["provider", "fixture-provider"], ["project", "fixture-project"], ["repo", "fixture-repo"], ["actor", "parent"], ["role", "worker"] ] as const)
        .map(([field, value]) => ({ field, kind: "id" as const, value: dashboardKey(ctx, field, value)! }))];
    return [...ids.map(filter => [filter]), [{ field: "run", kind: "missing" } as Filter], ids.slice(2)];
  });
  setup.close();
  for (const selection of filters) for (const request of planRequests(seed.periods[0]!, seed.sessionId, seed.runId, selection)) {
    expect(request.params.get("filters")).toBe(JSON.stringify(selection));
    const reader = openDashboardReader(fixture.file, { instanceId: "filtered-plans", serverBuild: "fixture", now: () => seed.now, calibrationMode: () => "off" })!;
    try {
      const result = reader.snapshot(ctx => captureQueries(ctx, () => DASHBOARD_ROUTES.find(r => r.path === request.path)!.handle(ctx, request.params)));
      const db = reader.snapshot(ctx => ctx.db);
      assertRoutePlans(request, result.queries, explainQueries(db, result.queries));
      expect(result.queries.filter(q => !q.calibration), `${request.name}: ${JSON.stringify(selection)}`).toHaveLength(result.queries.length);
      expect(result.queries.length).toBeLessThanOrEqual(request.cap);
      if (selection.some(filter => filter.kind === "id" && !["session", "run"].includes(filter.field))) {
        const lookups = result.queries.filter(q => /SELECT DISTINCT/.test(q.sql) && /AS value FROM calls/.test(q.sql));
        expect(lookups.length, `${request.name} dictionary miss`).toBeGreaterThan(0);
        for (const lookup of lookups) {
          const widened = { ...lookup, sql: lookup.sql.replace("c.ts >= ?", "(c.ts >= ? OR 1)") };
          expect(widened.sql).not.toBe(lookup.sql);
          const changed = result.queries.map(q => q === lookup ? widened : q);
          expect(() => assertRoutePlans(request, changed, explainQueries(db, changed))).toThrow(/access path|call-table scan/);
        }
      }
    } finally { reader.close(); }
  }
});

test.each([
  ["overview", 12, 11, 1, 0], ["cache", 12, 11, 1, 0],
  ["rates", 16, 13, 3, 0], ["reconciliation", 12, 11, 11, 10],
])("dense calibration SELECTs and interval batches are pinned for %s", (name, coldSelects, coldPasses, warmSelects, warmPasses) => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const seed = seedPlanLedger(fixture.file, 10_000, { denseMonthCalls: 1750 });
  const reader = openDashboardReader(fixture.file, { instanceId: "dense-accounting", serverBuild: "fixture", now: () => seed.now, calibrationMode: () => "auto" })!;
  closers.push(() => reader.close());
  const request = planRequests(seed.periods[0]!, seed.sessionId, seed.runId).find(r => r.name === name)!;
  const run = () => reader.snapshot(ctx => captureQueries(ctx, () => DASHBOARD_ROUTES.find(r => r.path === request.path)!.handle(ctx, request.params)));
  const cold = run(), warm = run();
  for (const [result, selects, passes] of [[cold, coldSelects, coldPasses], [warm, warmSelects, warmPasses]] as const) {
    const service = result.queries.filter(q => q.calibration);
    expect(service).toHaveLength(selects);
    const calls = planModule.callPassQueries(fixture.db, service);
    expect(calls).toHaveLength(passes);
    const byStatement = new Map<string, number[]>();
    for (const q of calls) {
      const intervals = JSON.parse(String(q.args[0])) as unknown[];
      expect(intervals.length).toBeGreaterThan(0);
      expect(intervals.length).toBeLessThanOrEqual(512);
      const sizes = byStatement.get(q.sql) ?? []; sizes.push(intervals.length); byStatement.set(q.sql, sizes);
    }
    for (const sizes of byStatement.values()) expect(sizes.length).toBe(Math.ceil(sizes.reduce((sum, n) => sum + n, 0) / 512));
    assertRoutePlans(request, result.queries, explainQueries(fixture.db, result.queries));
    planModule.assertReferenceResult(request.name, result.value, planModule.referenceRouteResult(fixture.db, request));
  }
});


test("every calibration call access is bounded, even alongside a bounded period pass", () => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const seed = seedPlanLedger(fixture.file, 100);
  const request = { ...planRequests(seed.periods[0]!, seed.sessionId, seed.runId).find(r => r.name === "rates")!, access: "none" as const };
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

test("filtered dense Overview totals differ from its unfiltered account comparison", () => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const seed = seedPlanLedger(fixture.file, 10_000, { denseMonthCalls: 1750 });
  const reader = openDashboardReader(fixture.file, { instanceId: "filtered-reference", serverBuild: "fixture", now: () => seed.now, calibrationMode: () => "auto" })!;
  closers.push(() => reader.close());
  const request = planRequests(seed.periods[0]!, seed.sessionId, seed.runId, [{ field: "session", kind: "id", value: seed.sessionId }]).find(r => r.name === "overview")!;
  const reference = planModule.referenceRouteResult(fixture.db, request);
  expect(reference.totals).toEqual({ calls: seed.expected.session, aic: seed.expected.session * 100 });
  const result = reader.snapshot(ctx => captureQueries(ctx, () => DASHBOARD_ROUTES.find(r => r.path === request.path)!.handle(ctx, request.params)));
  planModule.assertReferenceResult(request.name, result.value, reference);
  const value = result.value as any;
  expect(value.comparison.computed.calls).toBeGreaterThan(value.totals.calls);
  expect(() => planModule.assertReferenceResult(request.name, { ...value, comparison: { ...value.comparison, computed: value.totals } }, reference)).toThrow(/reference/);
  assertRoutePlans(request, result.queries, explainQueries(fixture.db, result.queries));
});


test("report-overlap exemption requires an indexed run equality inside report_runs", () => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const seed = seedPlanLedger(fixture.file, 100);
  const request = { ...planRequests(seed.periods[0]!, seed.sessionId, seed.runId).find(r => r.name === "rates")!, access: "none" as const };
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
  const request = { ...planRequests(seed.periods[0]!, seed.sessionId, seed.runId).find(r => r.name === "rates")!, access: "none" as const };
  const queries = [{ sql: "SELECT id FROM calls INDEXED BY calls_period_read WHERE ts>=? AND ts<?", args: [seed.periods[0]!.start, seed.now], calibration: "earliest" }];
  expect(() => assertRoutePlans(request, queries, explainQueries(fixture.db, queries))).toThrow(/earliest.*index/);
});


test("attributed calls reads with no identifiable access cannot pass vacuously", () => {
  const request = { ...planRequests({ start: 0, end: 1 }, "session", "run").find(r => r.name === "rates")!, access: "none" as const };
  const queries = [{ sql: "SELECT id FROM calls WHERE rowid=?", args: [1], calibration: "at" }];
  expect(() => assertRoutePlans(request, queries, [{ id: 1, parent: 0, statement: 0, detail: "SEARCH renamed", callReads: ["calls"] }])).toThrow(/calibration access path/);
});


test("legacy earliest keeps its exact call-index set and rejects full call scans", () => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const seed = seedPlanLedger(fixture.file, 10_000);
  const reader = openDashboardReader(fixture.file, { instanceId: "earliest-pins", serverBuild: "fixture", now: () => seed.now, calibrationMode: () => "auto" })!;
  closers.push(() => reader.close());
  const request = { ...planRequests(seed.periods[0]!, seed.sessionId, seed.runId).find(r => r.name === "rates")!, access: "none" as const };
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
