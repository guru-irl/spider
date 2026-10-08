import { readFileSync, writeFileSync } from "node:fs";
import { build } from "vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { DashboardRoute } from "../../../../../../scripts/usage-dashboard-screenshot.mjs";
import type { ApiEnvelope, DashboardCounter, DashboardStatus, OverviewData, UsageMeasure } from "../../dashboard-contract.js";
import { usageSecurityHeaders } from "../../server-security.js";

export type DashboardBrowserPage = {
  html: string;
  routes: Record<string, DashboardRoute>;
  ready: string;
  readChart: string;
  readTable: string;
  toggleTable: string;
  toggleChart: string;
};

// Build precisely the packaged app and stylesheet. Only its HTTP responses are
// synthetic: no real ledger, account data, filesystem paths or server is used.
export async function createDashboardBrowserPage(fakeClock = false): Promise<DashboardBrowserPage> {
  const result = await build({ configFile: false, logLevel: "silent", publicDir: false, build: { write: false, target: "es2022", minify: true, sourcemap: false, cssCodeSplit: false,
    lib: { entry: fileURLToPath(new URL("../../web/app.ts", import.meta.url)), name: "FixtureDashboard", formats: ["iife"] }, rollupOptions: { output: { codeSplitting: false } } } });
  const output = (Array.isArray(result) ? result : [result]).flatMap(r => "output" in r ? r.output : []);
  const code = output.filter(o => o.type === "chunk").map(o => o.code).join("\n");
  const css = output.flatMap(o => o.type === "asset" && o.fileName.endsWith(".css") ? [String(o.source)] : []).join("\n");
  const start = Date.UTC(2026, 0, 1), middle = Date.UTC(2026, 0, 2), end = Date.UTC(2026, 0, 3);
  const period = { start, end };
  // The real packaged app still starts itself. Only this fixture's clock is
  // pinned before startup, so its header and synthetic January data agree.
  const prelude = fakeClock ? `let now = ${end}, sequence = 0; const timers = new Map();
    Date.now = () => now;
    window.setTimeout = (run, delay = 0) => { const id = ++sequence; timers.set(id, { run, due: now + delay }); return id; };
    window.setInterval = (run, delay) => { const id = ++sequence; timers.set(id, { run, due: now + delay, delay }); return id; };
    window.clearTimeout = window.clearInterval = id => timers.delete(id);
    window.__usageClock = { advance(ms) { now += ms; for (const [id, timer] of Array.from(timers)) if (timer.due <= now && timers.has(id)) { if (timer.delay) timer.due = now + timer.delay; else timers.delete(id); timer.run(); } } };
    window.__usageFetches = 0; window.__usageCompleted = 0;
    const originalFetch = window.fetch; window.fetch = (...args) => { ++window.__usageFetches; return originalFetch(...args).then(response => { ++window.__usageCompleted; return response; }); };
  ` : `Date.now = () => ${end};`;
  const { html, routes: assetRoutes } = externalFixtureAssets(prelude + code, css);
  const measure = (primaryAic: number, publishedAic: number, total: number, basis: "calibrated" | "back-applied"): UsageMeasure => ({
    calls: 1, pricedCalls: 1, unpricedCalls: 0, aggregateCalls: 0,
    tokens: { input: total - 200, output: 200, cacheRead: 0, cacheWrite: 0, cacheWrite1h: null, reasoning: null, prompt: total - 200, total },
    aic: publishedAic, aicDisplay: { primaryAic, publishedAic, basis },
    aicComponents: { input: publishedAic / 2, output: publishedAic / 2, cacheRead: 0, cacheWrite: 0 },
    piCost: null, possibleOverlap: false, possibleUndercount: false, pendingData: false, estimated: false,
  });
  const backApplied = measure(8, 4, 700, "back-applied"), calibrated = measure(12, 6, 1000, "calibrated");
  const totals = { ...measure(20, 10, 1700, "calibrated"), calls: 2, pricedCalls: 2,
    tokens: { ...calibrated.tokens, input: 1300, prompt: 1300, output: 400, total: 1700 } };
  const counter: DashboardCounter = { ts: end, creditsUsed: 20, entitlement: 100, remaining: 80,
    resetDate: "2026-02-01", ageMs: 0, availability: "available", nextPollAt: null };
  const overview: OverviewData = {
    calibration: { status: "calibrated", factor: 2, windowStart: middle, windowEnd: end, coveredHours: 24,
      computedAic: 6, counterDelta: 12, unpricedCalls: 0, method: "trailing-7d-ratio" },
    totals, actors: [], roles: [],
    daily: { nextCursor: fakeClock ? "page-2" : null, rows: [
      { start, end: middle, label: "Day 1", measure: backApplied, actors: [], roles: [] },
      { start: middle, end, label: "Day 2", measure: calibrated, actors: [], roles: [] },
    ] },
    comparison: { ...period, counterAic: 20, computed: totals, gap: 0, ratio: 1 },
    counterObservation: counter, pace: { projected: null, counterAic: null, elapsedFraction: null },
  };
  const status: DashboardStatus = { serverBuild: "synthetic-build", schemaVersion: 2, rateVersions: ["synthetic-rates"],
    calls: 2, sources: 1, parseErrors: 0, sourceErrors: 0,
    ingest: { role: "owner", lastIngestAt: end, backfill: "complete", errorCode: null, ageMs: 0, stale: false }, counter };
  const response = <T>(data: T): DashboardRoute => {
    const envelope: ApiEnvelope<T> = { apiVersion: 1, revision: "synthetic-v1", period, generatedAt: end, data };
    return { body: JSON.stringify(envelope), contentType: "application/json", ignoreSearch: true };
  };
  return {
    html,
    // Overview calls status and overview initially. With zero source/parse
    // errors it does not request /api/source-errors. Unlisted routes fail closed.
    routes: {
      ...assetRoutes,
      "/api/status": response(status), "/api/overview": response(overview),
    },
    // Never await document.fonts.ready or the optional Google stylesheet.
    ready: `new Promise(resolve => { const deadline = performance.now() + 1500; const check = () => {
      if (document.querySelectorAll('.chart-panel svg circle').length === 2 && Array.from(document.querySelectorAll('.notice')).some(node => node.textContent === 'Health updated')) {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
      } else if (performance.now() >= deadline) resolve(false); else requestAnimationFrame(check);
    }; check(); })`,
    readChart: `Array.from(document.querySelectorAll('.chart-panel svg g > title'), title => {
      const parts = title.textContent.split(' · ');
      return [parts[0], Number(parts[2].match(/[\\d,]+/)[0].replaceAll(',', '')), Number(parts[3].match(/total ([\\d,]+)/)[1].replaceAll(',', ''))];
    })`,
    readTable: `Array.from(document.querySelectorAll('.chart-panel table tbody tr'), row => {
      const cells = Array.from(row.cells, cell => cell.querySelector(".cell-value")?.textContent ?? cell.textContent);
      return [cells[0], Number(cells[2].match(/[\\d,]+/)[0].replaceAll(',', '')), Number(cells[3].match(/total ([\\d,]+)/)[1].replaceAll(',', ''))];
    })`,
    toggleTable: `Array.from(document.querySelectorAll('.chart-panel')).every(panel => {
      const button = Array.from(panel.querySelectorAll('button')).find(button => button.textContent === 'Table');
      button.focus(); button.click();
      return !panel.querySelector('.table-region').hidden && panel.querySelector('svg').parentElement.hidden && document.activeElement === button && button.getAttribute('aria-pressed') === 'true';
    })`,
    toggleChart: `Array.from(document.querySelectorAll('.chart-panel')).every(panel => {
      const button = Array.from(panel.querySelectorAll('button')).find(button => button.textContent === 'Chart');
      button.focus(); button.click();
      return panel.querySelector('.table-region').hidden && !panel.querySelector('svg').parentElement.hidden && document.activeElement === button && button.getAttribute('aria-pressed') === 'true';
    })`,
  };
}

export function externalFixtureAssets(code: string, css: string, rootId = "usage-app"): { html: string; routes: Record<string, DashboardRoute> } {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/fixture-12345678.css"></head><body><div id="${rootId}"></div><script src="/assets/fixture-12345678.js"></script></body></html>`;
  const headers = Object.entries(usageSecurityHeaders()).map(([name, value]) => ({ name, value }));
  return { html, routes: {
    "/": { body: html, contentType: "text/html; charset=utf-8", headers },
    "/assets/fixture-12345678.js": { body: code, contentType: "text/javascript; charset=utf-8", headers },
    "/assets/fixture-12345678.css": { body: css, contentType: "text/css; charset=utf-8", headers },
  } };
}

export function createUnresponsivePipeBrowser(dir: string): { executable: string; pidFile: string; launchFile: string; close(): void } {
  const executable = join(dir, "unresponsive-browser.mjs");
  const pidFile = join(dir, "pid");
  const launchFile = join(dir, "launch.json");
  writeFileSync(executable, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nwriteFileSync(${JSON.stringify(launchFile)}, JSON.stringify({ args: process.argv.slice(2), home: process.env.HOME }));\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  return { executable, pidFile, launchFile, close() {
    try { process.kill(-Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* already closed */ }
  } };
}
