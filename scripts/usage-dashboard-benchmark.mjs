#!/usr/bin/env node
import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, renameSync, realpathSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** A failed or incorrect read throws before statistics exist. Validation is not timed. */
export function benchmarkSamples(read, validate = () => {}) {
  validate(read()); // warmup, not a sample
  const samples = [];
  for (let i = 0; i < 10; i++) {
    const start = performance.now(), value = read(), elapsed = performance.now() - start;
    validate(value);
    samples.push(elapsed);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return { samplesMs: samples, p50Ms: (sorted[4] + sorted[5]) / 2, p95Ms: sorted[9], maxMs: sorted[9] };
}

/** Cold setup and warm p95 must both fit; 366-day rows have no D8 budget. */
export function summarizeBenchmarkBudgets(report) {
  const month = report.routes.filter(row => row.window === "dense-month");
  const allMonthBudgetsMet = month.length === 13 && new Set(month.map(row => row.route)).size === 13 && month.every(row => Number.isFinite(row.budgetMs) && row.coldMs <= row.budgetMs && row.p95Ms <= row.budgetMs);
  return { ...report, allMonthBudgetsMet, result: allMonthBudgetsMet ? "pass" : "fail" };
}

export function resolveBenchmarkOutput(checkout, output) {
  const scratch = resolve(checkout, ".spider/scratch"), out = resolve(output);
  const inside = (root, path) => { const rel = relative(root, path); return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel); };
  if (!inside(scratch, out)) throw new Error("Output must live under checkout .spider/scratch");
  // Resolve every existing ancestor so a symlink cannot escape the scratch boundary.
  let ancestor = out;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (!inside(realpathSync(scratch), realpathSync(ancestor)) && realpathSync(ancestor) !== realpathSync(scratch)) throw new Error("Output symlink escapes checkout scratch");
  return out;
}

export async function withBenchmarkReport(out, run) {
  rmSync(out, { force: true }); // An unsuccessful new run must not retain old success.
  const staging = `${out}.partial`;
  rmSync(staging, { force: true });
  try {
    const result = await run();
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(staging, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    renameSync(staging, out);
    return result;
  } finally { rmSync(staging, { force: true }); }
}

/** Publish pass/fail evidence even for budget misses, then return a failure exit. */
export async function runBenchmarkReport(out, run) {
  const report = await withBenchmarkReport(out, async () => summarizeBenchmarkBudgets(await run()));
  process.exitCode = report.allMonthBudgetsMet ? 0 : 1;
  return report;
}

/** Import built dist. Vite is declared and uses Rolldown, not undeclared esbuild.
 * Node 26 strip-only cannot erase the existing parameter-property constructors.
 */
export async function loadBenchmarkModules(checkout) {
  const scratch = join(checkout, ".spider/scratch/usage-ui");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "benchmark-dist-"));
  try {
    const { build } = await import("vite");
    const entry = join(root, "harness.mjs");
    const source = path => JSON.stringify(join(checkout, "packages/host/src/usage", path));
    writeFileSync(entry, `export { LEGACY_DASHBOARD_ROUTES as DASHBOARD_ROUTES } from ${source("api-routes.ts")};
      export { openDashboardReader } from ${source("dashboard-reader.ts")};
      export { seedPlanLedger, planRequests, captureQueries, referenceRouteResult, assertReferenceResult, assertNoWrites, callPassQueries } from ${source("__tests__/fixtures/dashboard-plan.ts")};
      export { openDb } from "@spider/db-core";`);
    await build({ configFile: false, root: checkout, logLevel: "error", build: {
      outDir: join(root, "dist"), emptyOutDir: false, minify: false,
      lib: { entry, formats: ["es"], fileName: () => "harness.mjs" },
      rolldownOptions: { external: id => !id.startsWith(".") && !isAbsolute(id) && !id.startsWith("@spider/") },
    } });
    return await import(pathToFileURL(join(root, "dist/harness.mjs")).href);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

async function main() {
  if (process.env.CI || process.env.SPIDER_USAGE_BENCHMARK !== "1") {
    console.log("SKIP: local opt-in only (SPIDER_USAGE_BENCHMARK=1, no CI)");
    process.exitCode = 77; return;
  }
  const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (resolve(process.cwd()) !== checkout) throw new Error("Run the benchmark from the checkout root");
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--out")) throw new Error("Usage: --out <report.json>");
  const scratch = join(checkout, ".spider", "scratch", "usage-ui");
  mkdirSync(scratch, { recursive: true });
  const out = resolveBenchmarkOutput(checkout, args[1] ?? join(scratch, "T12-benchmark.json"));
  const report = await runBenchmarkReport(out, async () => {
    const root = mkdtempSync(join(scratch, "benchmark-"));
    // Set before importing better-sqlite3: SQLite temp B-trees never use system temp.
    process.env.TMPDIR = root; process.env.SQLITE_TMPDIR = root;
    process.env.SPIDER_GLOBAL_ROOT = join(root, "global");
    mkdirSync(process.env.SPIDER_GLOBAL_ROOT, { recursive: true });
    try {
      const module = await loadBenchmarkModules(checkout);
      const file = join(root, "synthetic-plan.db");
      const loadBeforeSeed = loadavg();
      console.log(`Host load before seed: ${loadBeforeSeed.map(n => n.toFixed(2)).join(", ")}`);
      const seedStart = performance.now();
      const seed = module.seedPlanLedger(file, 1_000_000, { denseMonthCalls: 175_000 });
      const observer = module.openDb(file);
      const dataVersion = Number(observer.pragma("data_version"));
      try {
      const result = { scenario: "dense-month", rows: 1_000_000, rawMonthCalls: seed.expected.month, counterCadenceMs: 600000,
        now: seed.now, samplesPerRoute: 10, seedMs: performance.now() - seedStart,
        scope: "route handler + deferred read snapshot + wire JSON serialization; no network; validation outside timing",
        loadBeforeSeed, loadBefore: loadavg(), routes: [] };
      const summarize = (db, queries) => {
        const selects = queries.filter(q => !q.sql.includes("call-selection-revision"));
        return { totalSelects: selects.length, routeSelects: selects.filter(q => !q.calibration).length,
          calibrationSelects: selects.filter(q => q.calibration).length,
          calibrationCallPasses: module.callPassQueries(db, selects.filter(q => q.calibration)).length,
          historyCallPasses: module.callPassQueries(db, selects.filter(q => q.calibration === "history")).length };
      };
      const open = () => {
        const reader = module.openDashboardReader(file, { instanceId: "benchmark", serverBuild: "synthetic", now: () => seed.now, calibrationMode: () => "auto" });
        if (!reader) throw new Error("synthetic reader unavailable");
        return reader;
      };
      for (const [i, period] of seed.periods.entries()) {
        for (const request of module.planRequests(period, seed.sessionId, seed.runId)) {
          const reader = open(), freshReaders = [];
          try {
            const route = module.DASHBOARD_ROUTES.find(route => route.path === request.path);
            const expected = reader.snapshot(ctx => module.referenceRouteResult(ctx.db, request));
            if (i === 0 && request.name === "overview") result.countedMonthCalls = expected.totals.calls;
            const read = (activeReader = reader, capture = false) => {
              const value = activeReader.snapshot(ctx => {
                const run = () => route.handle(ctx, request.params);
                const data = capture ? module.captureQueries(ctx, run) : { value: run() };
                return { ...data, revision: ctx.revision };
              });
              const body = JSON.stringify({ apiVersion: 1, generatedAt: seed.now, revision: value.revision, period, data: value.value });
              if (Buffer.byteLength(body) > request.kib * 1024) throw new Error(`response cap: ${request.name}`);
              return value;
            };
            const validate = value => module.assertReferenceResult(request.name, value.value, expected);
            const load = loadavg(), coldStart = performance.now(), cold = read(reader, true);
            const coldMs = performance.now() - coldStart; validate(cold);
            const warm = read(reader, true); validate(warm);
            module.assertNoWrites(observer, dataVersion);
            // The filter-values budget is the cache-miss path. Each timed sample has
            // its own already-open connection with an empty per-reader values cache.
            if (request.name === "filter-values") for (let n = 0; n < 11; n++) freshReaders.push(open());
            let sample = 0;
            const timing = benchmarkSamples(() => read(request.name === "filter-values" ? freshReaders[sample++] : reader), validate);
            const row = { route: request.name, window: i === 0 ? "dense-month" : "366-day", period, load, coldMs,
              cachePath: request.name === "filter-values" ? "cold values cache, pre-opened reader for every sample" : "warm",
              reference: expected, coldCounts: reader.snapshot(ctx => summarize(ctx.db, cold.queries)), hitCounts: reader.snapshot(ctx => summarize(ctx.db, warm.queries)), ...timing,
              budgetMs: i === 0 ? request.budgetMs : null, withinBudget: i === 0 ? coldMs <= request.budgetMs && timing.p95Ms <= request.budgetMs : null };
            module.assertNoWrites(observer, dataVersion);
            result.routes.push(row);
            console.log(`${row.window} ${row.route}: p50=${timing.p50Ms.toFixed(2)} p95=${timing.p95Ms.toFixed(2)} max=${timing.maxMs.toFixed(2)} ms; cold=${coldMs.toFixed(2)}; load=${load.map(n => n.toFixed(2)).join(",")}${row.withinBudget === false ? "; D8 MISS" : ""}`);
          } finally { for (const fresh of freshReaders) fresh.close(); reader.close(); }
        }
      }
      result.loadAfter = loadavg();
      return result;
      } finally { observer.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  console.log(`Report: ${out}; ${report.result.toUpperCase()}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`FAIL: ${error.message}`); process.exitCode = 1; });
}
