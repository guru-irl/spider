import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDashboardReader } from "../dashboard-reader.js";
import type { CalibrationService, DashboardReader } from "../dashboard-contract.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_DAY as DAY, DASHBOARD_MONTH as START, type DashboardFixture } from "./fixtures/dashboard-ledger.js";

let f: DashboardFixture, reader: DashboardReader, service: CalibrationService;
beforeEach(() => {
  f = createDashboardFixture(false);
  reader = openDashboardReader(f.file, { instanceId: "calibration-fixture", now: () => START + 40 * DAY, calibrationMode: () => "auto", serverBuild: "fixture" })!;
  service = reader.snapshot(ctx => ctx.calibration);
});
afterEach(() => { reader.close(); f.close(); vi.restoreAllMocks(); });
function call(id: string, ts: number, aic: number) {
  return dashboardCall(id, { ts, price: { status: "priced", aic, components: { input: aic, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "fixture", tier: "fixture", confidence: "estimated" } });
}
function counter(ts: number, creditsUsed: number, extra = {}) {
  f.ledger.insertCounter({ ts, creditsUsed, accountLogin: "synthetic-account", resetDate: "synthetic-reset", raw: {}, ...extra });
}
it("calibration uses counted interval calls", () => {
  const native = call("native", START, 500);
  f.ledger.apply(dashboardBatch([
    native, { ...native, id: "copy", sourceFile: "synthetic/fork", copied: true },
    { ...call("detail", START + DAY / 2, 500), runId: "child", actor: "subagent" },
    { ...call("report", START, 9000), runId: "child", actor: "subagent", aggregate: true, sourceKind: "report" },
    call("end", START + DAY, 9000), call("before", START - 1, 9000),
    { ...call("covering-report", START - 1, 0), runId: "coverage-report", actor: "subagent", aggregate: true, sourceKind: "report" },
    { ...call("covered-detail", START + 1, 9000), runId: "covered-run", actor: "aux" },
  ], { coverageEdges: [{ reportRunId: "coverage-report", includedRunId: "covered-run", evidence: "transcript" }] }));
  counter(START, 100); counter(START + DAY / 2, 380); counter(START + DAY, 660);
  expect(service.current("auto")).toMatchObject({ status: "calibrated", factor: 0.56, computedAic: 1000, counterDelta: 560, coveredHours: 24, unpricedCalls: 0, windowEnd: START + DAY });
});

it("calibration drops reset-spanning pairs", () => {
  f.ledger.apply(dashboardBatch([call("first", START, 500), call("reset-gap", START + DAY, 9000), call("negative-gap", START + 2 * DAY, 9000), call("last", START + 3 * DAY, 500)]));
  counter(START, 0); counter(START + DAY, 280);
  counter(START + 2 * DAY, 100, { resetDate: "new-reset" });
  counter(START + 3 * DAY, 0, { resetDate: "new-reset" });
  counter(START + 4 * DAY, 280, { resetDate: "new-reset" });
  expect(service.current("auto")).toMatchObject({ status: "calibrated", factor: 0.56, coveredHours: 48, computedAic: 1000, counterDelta: 560 });
});

it("calibration requires covered span and priced evidence", () => {
  expect(service.current("auto")).toMatchObject({ status: "uncalibrated", factor: null, windowStart: null, windowEnd: null });
  counter(START, 0);
  expect(service.current("auto").status).toBe("uncalibrated");
  f.ledger.apply(dashboardBatch([call("evidence", START, 500)]));
  counter(START + DAY - 36000, 280);
  expect(service.current("auto")).toMatchObject({ status: "uncalibrated", factor: null });
  f.db.prepare("UPDATE calls SET aic=499.99 WHERE id='evidence'").run();
  counter(START + DAY, 280);
  expect(service.current("auto").status).toBe("uncalibrated");
  f.db.prepare("UPDATE calls SET aic=500 WHERE id='evidence'").run();
  expect(service.current("auto")).toMatchObject({ status: "calibrated", computedAic: 500, coveredHours: 24, factor: 0.56 });
  f.db.prepare("UPDATE calls SET aic=0 WHERE id='evidence'").run();
  expect(service.current("auto")).toMatchObject({ status: "uncalibrated", factor: null });
});

it("calibration rejects implausible ratios", () => {
  f.ledger.apply(dashboardBatch([call("evidence", START, 1000)])); counter(START, 0);
  for (const [delta, status, factor] of [[49, "implausible", 0.05], [50, "calibrated", 0.05], [2000, "calibrated", 2], [2010, "implausible", 2]] as const) {
    f.db.prepare("DELETE FROM counter_snapshots WHERE ts>?").run(START); counter(START + DAY, delta);
    reader.close();
    reader = openDashboardReader(f.file, { instanceId: "ratio-fixture", now: () => START + DAY, calibrationMode: () => "auto", serverBuild: "fixture" })!;
    service = reader.snapshot(ctx => ctx.calibration);
    expect(service.current("auto")).toMatchObject({ status, factor, counterDelta: delta });
  }
});

it("calibration tolerates five minute billing lag", () => {
  const step = 600000;
  f.ledger.apply(dashboardBatch(Array.from({ length: 1008 }, (_, i) => call(`steady-${i}`, START + i * step, 10))));
  for (let i = 0; i <= 1008; i++) counter(START + i * step, Math.floor(i * 5.6));
  const baseline = service.at(START + 7 * DAY, "auto");
  expect(baseline.status).toBe("calibrated");
  reader.close();
  f.db.prepare("UPDATE counter_snapshots SET credits_used=MAX(0,CAST(((ts-?)/600000.0-0.5)*5.6 AS INTEGER))").run(START);
  reader = openDashboardReader(f.file, { instanceId: "lag-fixture", now: () => START + 7 * DAY, calibrationMode: () => "auto", serverBuild: "fixture" })!;
  service = reader.snapshot(ctx => ctx.calibration);
  const shifted = service.at(START + 7 * DAY, "auto");
  expect(shifted.status).toBe("calibrated");
  expect(Math.abs(shifted.factor! / baseline.factor! - 1)).toBeLessThan(0.01);
});

it("calibration excludes and reports unpriced calls", () => {
  f.ledger.apply(dashboardBatch([call("priced", START, 500), { ...call("unpriced", START, 0), price: { status: "unpriced", reason: "unknown-model" } }]));
  counter(START, 0); counter(START + DAY, 280);
  expect(service.atMany([START + DAY], "auto")[0]).toMatchObject({ status: "calibrated", computedAic: 500, unpricedCalls: 1, factor: 0.56 });
  f.db.prepare("DELETE FROM calls WHERE id='priced'").run();
  expect(service.atMany([START + DAY], "auto")[0]).toMatchObject({ status: "uncalibrated", factor: null, computedAic: 0, unpricedCalls: 1 });
});

it("calibration cache invalidates only on evidence changes", () => {
  f.ledger.apply(dashboardBatch([call("priced", START, 500)])); counter(START, 0); counter(START + DAY, 280);
  const sql: string[] = [];
  reader.snapshot(ctx => { const prepare = ctx.db.prepare.bind(ctx.db); vi.spyOn(ctx.db, "prepare").mockImplementation(text => { sql.push(text); return prepare(text); }); });
  const passes = () => sql.filter(text => text.includes("calls_period_read")).length;
  expect(service.current("auto").factor).toBe(0.56); expect(passes()).toBe(1);
  f.ledger.apply(dashboardBatch([], { sourceErrors: [{ path: "synthetic/missing", code: "missing-source" }] }));
  f.ledger.apply(dashboardBatch([call("priced", START, 500)]));
  f.db.prepare("INSERT INTO ledger_metadata(key,value) VALUES ('coordination','one')").run();
  service.current("auto"); expect(passes()).toBe(1);
  expect(service.current("off").status).toBe("off");
  f.ledger.apply(dashboardBatch([call("new", START + DAY, 500)])); counter(START + 2 * DAY, 560);
  expect(service.current("auto").computedAic).toBe(1000); expect(passes()).toBe(2);
  f.db.prepare("UPDATE calls SET aic=1000 WHERE id='new'").run();
  expect(service.current("auto").computedAic).toBe(1500); expect(passes()).toBe(3);
  counter(START + 3 * DAY, 600); service.current("auto"); expect(passes()).toBe(4);
});

it("calibration history batches daily trailing windows", () => {
  for (let i = 0; i <= 40; i++) counter(START + i * DAY, i * 280);
  f.ledger.apply(dashboardBatch(Array.from({ length: 40 }, (_, i) => call(`day-${i}`, START + i * DAY, 500))));
  const sql: string[] = [];
  reader.snapshot(ctx => { const prepare = ctx.db.prepare.bind(ctx.db); vi.spyOn(ctx.db, "prepare").mockImplementation(text => { sql.push(text); return prepare(text); }); });
  const page = service.history({ start: START, end: START + 40 * DAY }, { limit: 31 }, "auto");
  expect(page.rows).toHaveLength(31); expect(page.nextCursor).not.toBeNull();
  expect(page.rows[0]!.calibration).toMatchObject({ windowEnd: START, status: "uncalibrated" });
  expect(page.rows[7]!.calibration).toMatchObject({ windowEnd: START + 7 * DAY, coveredHours: 168, computedAic: 3500, factor: 0.56 });
  expect(sql.filter(text => text.includes("calls_period_read"))).toHaveLength(1);
  expect(sql.filter(text => text.includes("FROM counter_snapshots"))).toHaveLength(1);
  counter(START + 35 * DAY + 100, 99999);
  const next = service.history({ start: START, end: START + 40 * DAY }, { limit: 31, cursor: page.nextCursor! }, "auto");
  expect(next.rows).toHaveLength(9); expect(next.rows[0]!.day).toBe(START + 31 * DAY);
  expect(next.rows.at(-1)!.calibration.windowEnd).toBe(START + 39 * DAY);
  expect(next.rows.every(point => point.calibration.factor === 0.56)).toBe(true);
  sql.length = 0;
  const batch = service.atMany([START + 10 * DAY, START + 11 * DAY, START + 12 * DAY], "auto");
  expect(batch.map(x => x.factor)).toEqual([0.56, 0.56, 0.56]);
  expect(sql.filter(text => text.includes("calls_period_read")).length).toBeLessThanOrEqual(1);
  expect(service.history({ start: START, end: START + DAY }, { limit: 1 }, "off")).toEqual({ rows: [], nextCursor: null });
  expect(() => service.history({ start: START, end: START + DAY }, { limit: 32 }, "auto")).toThrow("invalid-query");
});

it("calibration rejects account invalid and clock gaps", () => {
  f.ledger.apply(dashboardBatch(Array.from({ length: 5 }, (_, i) => call(`gap-${i}`, START + i * DAY, 500))));
  counter(START, 0); counter(START + DAY, 280);
  counter(START + 2 * DAY, 560, { accountLogin: "different-synthetic-account" });
  counter(START + 3 * DAY, 840, { accountLogin: "different-synthetic-account", entitlement: -1 });
  counter(START + 4 * DAY, 1120, { accountLogin: "different-synthetic-account" });
  counter(START + 5 * DAY, 1400, { accountLogin: "different-synthetic-account" });
  expect(service.current("auto")).toMatchObject({ computedAic: 1000, counterDelta: 560, coveredHours: 48, factor: 0.56 });
  // A backwards append cannot create a valid clock span when timestamps are sorted.
  counter(START + 4 * DAY + DAY / 2, 1260, { accountLogin: "different-synthetic-account" });
  expect(service.current("auto")).toMatchObject({ coveredHours: 36, computedAic: 1000, counterDelta: 420 });
  counter(START + 6 * DAY, -1);
  expect(service.current("auto").windowEnd).toBe(START + 5 * DAY);
});
it("calibration duplicate anchors use stable keys and exact span", () => {
  f.ledger.apply(dashboardBatch([call("evidence", START, 500)]));
  for (let i = 0; i <= 144; i++) counter(START + i * 600000, Math.floor(i * 280 / 144));
  counter(START + DAY, 280);
  expect(service.current("auto")).toMatchObject({ coveredHours: 24, computedAic: 500, counterDelta: 280, status: "calibrated" });
});

it("calibration sparse history bounds its evidence passes", () => {
  const old = START - 600 * DAY;
  counter(old, 0); counter(old + DAY, 280); counter(START, 0); counter(START + DAY, 280);
  f.ledger.apply(dashboardBatch([call("old", old, 500), call("new", START, 500)]));
  const plans: string[] = [];
  reader.snapshot(ctx => {
    const prepare = ctx.db.prepare.bind(ctx.db);
    vi.spyOn(ctx.db, "prepare").mockImplementation(sql => {
      const statement = prepare(sql);
      if (sql.includes("calls_period_read") || sql.includes("FROM counter_snapshots")) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...args) => {
          plans.push(...(prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map(x => x.detail));
          return all(...args);
        });
        const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, "iterate").mockImplementation((...args) => {
          plans.push(...(prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map(x => x.detail));
          return iterate(...args);
        });
      }
      return statement;
    });
  });
  expect(service.atMany([START - DAY, START + DAY], "auto").map(x => x.computedAic)).toEqual([500, 500]);
  expect(() => service.atMany([0, START], "auto")).toThrow("invalid-query");
  expect(plans.join("\n")).toMatch(/SEARCH .*USING .*calls_period_read.*ts>\? AND ts<\?/);
});

it.skipIf(process.env.T1A_CALIBRATION_BENCHMARK !== "1")("large synthetic calibration cost (local opt-in)", async () => {
  const { writeFileSync } = await import("node:fs");
  const { loadavg } = await import("node:os");
  if (process.env.CI) throw new Error("local calibration benchmark refuses CI");
  f.ledger.apply(dashboardBatch([call("large-template", START - 730 * DAY, 1)]));
  const columns = (f.db.prepare("PRAGMA table_info(calls)").all() as { name: string }[]).map(x => x.name);
  const expressions = columns.map(name => name === "id" || name === "entry_id" || name === "fingerprint" ? "'large-'||n"
    : name === "ts" ? `${START - 730 * DAY}+CAST(n*${730 * DAY}/1000000.0 AS INTEGER)` : `template.${name}`);
  f.db.raw.transaction(() => f.db.exec(`WITH RECURSIVE sequence(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM sequence WHERE n<999998)
    INSERT INTO calls (${columns.join(",")}) SELECT ${expressions.join(",")} FROM sequence CROSS JOIN calls template WHERE template.id='large-template'`)).immediate();
  for (let i = 0; i <= 1008; i++) counter(START - 7 * DAY + i * 600000, Math.floor(i * 5.6));
  const beforeLoad = loadavg();
  let start = performance.now(); const evidence = service.current("auto"); const coldMs = performance.now() - start;
  const warmMs: number[] = [];
  for (let i = 0; i < 10; i++) { start = performance.now(); service.current("auto"); warmMs.push(performance.now() - start); }
  start = performance.now();
  const history = service.history({ start: START - 31 * DAY, end: START }, { limit: 31 }, "auto");
  const historyColdMs = performance.now() - start;
  const historyWarmMs: number[] = [];
  for (let i = 0; i < 10; i++) { start = performance.now(); service.history({ start: START - 31 * DAY, end: START }, { limit: 31 }, "auto"); historyWarmMs.push(performance.now() - start); }
  const report = { rows: (f.db.prepare("SELECT COUNT(*) AS n FROM calls").get() as { n: number }).n, months: 24, coldMs, warmMs,
    warmP95Ms: [...warmMs].sort((a,b) => a-b)[9], historyColdMs, historyWarmMs, historyWarmP95Ms: [...historyWarmMs].sort((a,b) => a-b)[9], evidence, historyPoints: history.rows.length, beforeLoad, afterLoad: loadavg() };
  expect(report.rows).toBe(1000000); expect(evidence.status).toBe("calibrated");
  console.log("SYNTHETIC CALIBRATION COST", JSON.stringify(report));
  if (process.env.T1A_CALIBRATION_BENCH_OUT) writeFileSync(process.env.T1A_CALIBRATION_BENCH_OUT, JSON.stringify(report, null, 2));
}, 120000);

it("calibration with no snapshot pair skips call selection", () => {
  counter(START, 0);
  const db = reader.snapshot(ctx => ctx.db);
  const prepare = vi.spyOn(db, "prepare");
  expect(service.current("auto")).toMatchObject({ status: "uncalibrated", windowEnd: START, computedAic: 0, coveredHours: 0 });
  expect(prepare.mock.calls.filter(([sql]) => sql.includes("calls_period_read"))).toHaveLength(0);
});

it("calibration never publishes nonfinite evidence", () => {
  f.ledger.apply(dashboardBatch([call("corrupt-price", START, 1000)])); counter(START, 0); counter(START + DAY, 560);
  f.db.prepare("UPDATE calls SET aic=1e999 WHERE id='corrupt-price'").run();
  const result = service.current("auto");
  expect(result.status).toBe("uncalibrated"); expect(result.factor).toBeNull();
  for (const value of [result.computedAic, result.counterDelta, result.coveredHours, result.unpricedCalls]) {
    expect(Number.isFinite(value)).toBe(true); expect(value).toBeGreaterThanOrEqual(0);
  }
});

it("duplicate snapshot timestamps select the latest valid stable key", () => {
  f.ledger.apply(dashboardBatch([call("evidence", START, 500)]));
  counter(START, 0); counter(START + DAY, 200); counter(START + DAY, 280);
  expect(service.current("auto")).toMatchObject({ coveredHours: 24, counterDelta: 280, computedAic: 500, factor: 0.56 });
  counter(START + DAY, -1);
  expect(service.current("auto")).toMatchObject({ coveredHours: 24, counterDelta: 280, factor: 0.56 });
});

it("reset date alone rejects a rising-credit pair and its unpriced calls", () => {
  f.ledger.apply(dashboardBatch([call("first", START, 500), call("reset-gap", START + DAY, 1000), call("last", START + 1.5 * DAY, 250),
    { ...call("accepted-unpriced", START, 0), price: { status: "unpriced", reason: "unknown-model" } },
    { ...call("rejected-unpriced", START + DAY, 0), price: { status: "unpriced", reason: "unknown-model" } }]));
  counter(START, 100); counter(START + DAY, 400);
  counter(START + 1.5 * DAY, 500, { resetDate: "next-reset" }); counter(START + 2 * DAY, 640, { resetDate: "next-reset" });
  expect(service.current("auto")).toMatchObject({ status: "calibrated", coveredHours: 36, counterDelta: 440, computedAic: 750, unpricedCalls: 1 });
  expect(service.current("auto").factor).toBeCloseTo(440 / 750);
});
it("trailing window excludes evidence older than seven days", () => {
  const A = START + 8 * DAY;
  for (const [day, credits] of [[0, 0], [1, 100], [2, 300], [5, 400], [8, 1000]]) counter(START + day! * DAY, credits!);
  f.ledger.apply(dashboardBatch([call("too-old", START + DAY / 2, 5000), call("boundary", START + DAY, 400),
    call("middle", A - 4 * DAY, 200), call("last", A - DAY, 600), call("end", A, 9999)]));
  expect(service.current("auto")).toMatchObject({ windowStart: A - 7 * DAY, windowEnd: A, coveredHours: 168, computedAic: 1200, counterDelta: 900, factor: 0.75 });
});
it("calls pass reads only the span covered by snapshot pairs", () => {
  f.ledger.apply(dashboardBatch([call("older", START - DAY, 9000), call("covered", START, 500)]));
  counter(START, 0); counter(START + 9 * 3600000, 280);
  const bounds: unknown[][] = [];
  const db = reader.snapshot(ctx => ctx.db), prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (sql.includes("calls_period_read")) {
      const iterate = statement.iterate.bind(statement);
      vi.spyOn(statement, "iterate").mockImplementation((...args) => {
        const intervals = JSON.parse(String(args[0])) as [number, number, number][];
        bounds.push(...intervals.map(([, start, end]) => [start, end]));
        return iterate(...args);
      });
    }
    return statement;
  });
  expect(service.current("auto")).toMatchObject({ computedAic: 500, coveredHours: 9 });
  expect(bounds).toEqual([[START, START + 9 * 3600000]]);
});

it.skipIf(process.env.T1A_SHAPED_BENCHMARK !== "1")("real-shaped synthetic calibration cost (local opt-in)", async () => {
  const { writeFileSync } = await import("node:fs");
  const { loadavg } = await import("node:os");
  const { createCalibrationService } = await import("../calibration.js");
  if (process.env.CI) throw new Error("local calibration benchmark refuses CI");
  const begin = START - 30 * DAY;
  f.ledger.apply(dashboardBatch([{ ...call("shape-template", begin, 1), runId: "shape-run-0", actor: "subagent", aggregate: true, sourceKind: "report", sourceFile: "synthetic/shape-0" }]));
  const columns = (f.db.prepare("PRAGMA table_info(calls)").all() as { name: string }[]).map(row => row.name);
  const report = "(n%20=0 OR n%200<20)";
  const expressions = columns.map(name => ["id", "entry_id", "fingerprint"].includes(name) ? "'shape-'||n"
    : name === "ts" ? `${begin}+CAST(n*${30 * DAY}/130000.0 AS INTEGER)`
    : name === "run_id" ? "'shape-run-'||CAST(n/20 AS INTEGER)"
    : name === "source_file" ? "'synthetic/shape-'||CAST(n/20 AS INTEGER)"
    : name === "aggregate" ? report
    : name === "source_kind" ? `CASE WHEN ${report} THEN 'report' ELSE 'transcript' END`
    : name === "copied" ? `CASE WHEN NOT ${report} AND n%20=19 THEN 1 ELSE 0 END` : `template.${name}`);
  f.db.raw.transaction(() => {
    f.db.exec(`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<129999)
      INSERT INTO calls (${columns.join(",")}) SELECT ${expressions.join(",")} FROM sequence CROSS JOIN calls template WHERE template.id='shape-template'`);
    f.db.exec(`WITH RECURSIVE sequence(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM sequence WHERE n<6499)
      INSERT INTO runs_meta(id,db_path,started_at,ended_at,parent_run_id)
      SELECT 'shape-run-'||n,'synthetic/runs.db',${begin},${START},CASE WHEN n%10=2 THEN 'shape-run-'||(n-2) ELSE NULL END FROM sequence`);
    f.db.exec(`INSERT INTO coverage_edges(report_run_id,included_run_id,evidence)
      SELECT id,'shape-run-'||(CAST(substr(id,11) AS INTEGER)+1),'transcript' FROM runs_meta WHERE CAST(substr(id,11) AS INTEGER)%10=0`);
  }).immediate();
  const shape = f.db.prepare("SELECT COUNT(*) AS calls,SUM(is_report) AS reports,SUM(copied) AS copies FROM calls").get();
  expect(shape).toMatchObject({ calls: 130000 });
  expect((f.db.prepare("SELECT COUNT(*) AS n FROM coverage_edges").get() as { n: number }).n).toBe(650);
  const results = [];
  for (const hours of [9, 168]) {
    f.db.exec("DELETE FROM counter_snapshots");
    for (let i = 0; i <= hours * 6; i++) counter(START - hours * 3600000 + i * 600000, i * 20);
    const db = reader.snapshot(ctx => ctx.db);
    const calibration = createCalibrationService(db, { revision: () => "synthetic-generation" });
    const beforeLoad = loadavg();
    let start = performance.now(); const evidence = calibration.current("auto"); const coldMs = performance.now() - start;
    const cachedMs = [];
    for (let i = 0; i < 10; i++) { start = performance.now(); calibration.current("auto"); cachedMs.push(performance.now() - start); }
    expect(evidence.coveredHours).toBe(hours);
    expect(evidence.status).toBe(hours === 9 ? "uncalibrated" : "calibrated");
    results.push({ hours, coldMs, cachedMs, cachedP95Ms: [...cachedMs].sort((a,b) => a-b)[9], evidence, beforeLoad, afterLoad: loadavg() });
  }
  const timings = { shape, days: 30, runs: 6500, coverageEdges: 650, results };
  console.log("REAL-SHAPED SYNTHETIC CALIBRATION COST", JSON.stringify(timings));
  if (process.env.T1A_SHAPED_BENCH_OUT) writeFileSync(process.env.T1A_SHAPED_BENCH_OUT, JSON.stringify(timings, null, 2));
}, 120000);
