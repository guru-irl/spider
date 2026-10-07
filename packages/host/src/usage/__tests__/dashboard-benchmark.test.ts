import { spawnSync } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as benchmark from "../../../../../scripts/usage-dashboard-benchmark.mjs";
import * as plans from "./fixtures/dashboard-plan.js";
import { DASHBOARD_ROUTES } from "../api-routes.js";
import { openDashboardReader } from "../dashboard-reader.js";
import { createDashboardFixture } from "./fixtures/dashboard-ledger.js";

vi.mock("node:fs", async () => {
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});

const closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0).reverse()) close(); });

test("Node imports the real routes from built dist without esbuild", () => {
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", `import { loadBenchmarkModules } from './scripts/usage-dashboard-benchmark.mjs'; const m = await loadBenchmarkModules(process.cwd()); console.log(m.DASHBOARD_ROUTES.length);`], { encoding: "utf8", env: process.env });
  expect(run.status, run.stderr).toBe(0); expect(run.stdout.trim()).toBe("11");
});

test("benchmark rejects output outside checkout scratch, including symlink escapes", () => {
  const resolveOutput = Reflect.get(benchmark, "resolveBenchmarkOutput");
  expect(resolveOutput).toBeTypeOf("function");
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const scratch = join(fixture.root, ".spider/scratch"); mkdirSync(scratch, { recursive: true });
  for (const out of ["/tmp/usage.json", "/var/tmp/usage.json", join(process.env.TMPDIR!, "usage.json"), join(fixture.root, "usage.json")]) expect(() => resolveOutput(fixture.root, out)).toThrow(/scratch/);
  symlinkSync(fixture.root, join(scratch, "escape"));
  expect(() => resolveOutput(fixture.root, join(scratch, "escape/usage.json"))).toThrow(/scratch/);
  expect(resolveOutput(fixture.root, join(scratch, "usage/report.json"))).toBe(join(scratch, "usage/report.json"));
});

test("benchmark removes stale reports at start and publishes atomically only on success", async () => {
  const publish = Reflect.get(benchmark, "withBenchmarkReport");
  expect(publish).toBeTypeOf("function");
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const out = join(fixture.root, "report.json"); writeFileSync(out, "old success");
  await expect(publish(out, async () => { expect(existsSync(out)).toBe(false); throw new Error("wrong route result"); })).rejects.toThrow("wrong route result");
  expect(existsSync(out)).toBe(false);
  await publish(out, async () => ({ valid: true }));
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ valid: true });
});

test("wrong route results fail before any sample statistics", () => {
  const samples = benchmark.benchmarkSamples as (...args: any[]) => unknown;
  expect(() => samples(() => ({ calls: 0, aic: 0 }), (value: any) => { if (value.calls !== 175000 || value.aic !== 17500000) throw new Error("reference total mismatch"); })).toThrow("reference total mismatch");
});

test("every dense-fixture route matches its independent reference", () => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const seed = plans.seedPlanLedger(fixture.file, 10_000, { denseMonthCalls: 1750 });
  const reader = openDashboardReader(fixture.file, { instanceId: "reference", serverBuild: "fixture", now: () => seed.now, calibrationMode: () => "auto" })!;
  closers.push(() => reader.close());
  for (const period of seed.periods) for (const request of plans.planRequests(period, seed.sessionId, seed.runId)) {
    const reference = plans.referenceRouteResult(fixture.db, request);
    const value = reader.snapshot(ctx => DASHBOARD_ROUTES.find(r => r.path === request.path)!.handle(ctx, request.params));
    plans.assertReferenceResult(request.name, value, reference);
  }
});

test("reference validation checks calls and published AIC independently", () => {
  const validate = Reflect.get(plans, "assertReferenceResult");
  expect(validate).toBeTypeOf("function");
  const expected = { calls: 20, aic: 2000 };
  validate("overview", { totals: expected }, { totals: expected });
  expect(() => validate("cache", { totals: { calls: 19, aic: 2000 } }, { totals: expected })).toThrow(/reference/);
  expect(() => validate("rates", { totals: { calls: 20, aic: 1999 } }, { totals: expected })).toThrow(/reference/);
});


test.each([1, 3, 10])("timed sample %i is validated even when warmup succeeds", (badSample) => {
  let reads = 0;
  expect(() => benchmark.benchmarkSamples(() => ++reads === badSample + 1 ? "wrong" : "correct", value => {
    if (value !== "correct") throw new Error("timed sample mismatch");
  })).toThrow("timed sample mismatch");
  expect(reads).toBe(badSample + 1);
});

test("atomic report publication leaves no final or partial report if rename fails", async () => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const out = join(fixture.root, "atomic.json");
  vi.mocked(renameSync).mockImplementationOnce((from, to) => {
    expect(String(from)).toBe(`${out}.partial`);
    expect(String(to)).toBe(out);
    expect(existsSync(out)).toBe(false);
    expect(JSON.parse(readFileSync(from, "utf8"))).toEqual({ valid: true });
    throw new Error("publication interrupted");
  });
  try {
    await expect(benchmark.withBenchmarkReport(out, async () => ({ valid: true }))).rejects.toThrow("publication interrupted");
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.partial`)).toBe(false);
  } finally { vi.mocked(renameSync).mockReset(); }
});

test("any cold or warm month budget miss produces a failed report and non-SKIP failure exit", () => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const out = join(fixture.root, "budget.json");
  const summarize = Reflect.get(benchmark, "summarizeBenchmarkBudgets");
  expect(summarize).toBeTypeOf("function");
  const route = { route: "overview", window: "dense-month", coldMs: 5, p95Ms: 5, budgetMs: 10 };
  const month = Array.from({ length: 13 }, (_, i) => ({ ...route, route: `route-${i}` }));
  for (const first of [route, { ...route, coldMs: 11 }, { ...route, p95Ms: 11 }, { ...route, coldMs: 10, p95Ms: 10 }]) {
    const rows = [first, ...month.slice(1)];
    const result = summarize({ routes: rows });
    const pass = rows[0]!.coldMs <= 10 && rows[0]!.p95Ms <= 10;
    expect(result.allMonthBudgetsMet).toBe(pass);
    expect(result.result).toBe(pass ? "pass" : "fail");
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", `import { runBenchmarkReport } from './scripts/usage-dashboard-benchmark.mjs'; await runBenchmarkReport(${JSON.stringify(out)}, async () => (${JSON.stringify({ routes: rows })}));`], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(pass ? 0 : 1);
    expect(run.status).not.toBe(77);
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ allMonthBudgetsMet: pass, result: pass ? "pass" : "fail" });
  }
});

test("Status reference does not depend on maintained ledger_totals", () => {
  const fixture = createDashboardFixture(false); closers.push(fixture.close);
  const seed = plans.seedPlanLedger(fixture.file, 100);
  fixture.db.exec("UPDATE ledger_totals SET calls=999 WHERE singleton=1");
  const request = plans.planRequests(seed.periods[0]!, seed.sessionId, seed.runId).find(r => r.name === "status")!;
  expect(plans.referenceRouteResult(fixture.db, request)).toEqual({ calls: 100 });
});


test("month budgets require exactly 13 distinct budgeted dense-month routes", () => {
  const month = Array.from({ length: 13 }, (_, i) => ({ route: `route-${i}`, window: "dense-month", coldMs: 5, p95Ms: 5, budgetMs: 10 }));
  expect(benchmark.summarizeBenchmarkBudgets({ routes: month }).allMonthBudgetsMet).toBe(true);
  for (const routes of [[], month.slice(1), [...month, { ...month[0]!, route: "extra" }],
    month.map(row => ({ ...row, window: "current-month" })),
    [...month.slice(1), month[1]!],
    month.map((row, i) => i === 0 ? { ...row, budgetMs: null } : row),
    month.map((row, i) => i === 0 ? { ...row, budgetMs: NaN } : row)]) {
    expect(benchmark.summarizeBenchmarkBudgets({ routes })).toMatchObject({ allMonthBudgetsMet: false, result: "fail" });
  }
});
