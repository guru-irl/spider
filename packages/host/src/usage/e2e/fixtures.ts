import { supportedDetailId } from "../web/detail-id.js";
import type { Page } from "@playwright/test";
import { fixtureStateCases, statusFixture, envelope } from "../__tests__/fixtures/redesign-contract.js";
import type { FixtureScenario, FixtureStateCase } from "../__tests__/fixtures/redesign-contract.js";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { once } from "node:events";
export type FixtureReply = FixtureStateCase["responses"][string];
export type FixtureRoutes = { count(path: string): number; requests: readonly { path: string; params: URLSearchParams }[]; unexpected: readonly string[]; replace(path: string, reply: FixtureReply): void };
export async function installFixtureRoutes(page: Page, scenario: FixtureScenario = "default"): Promise<FixtureRoutes> {
  const requests: { path: string; params: URLSearchParams }[] = [], unexpected: string[] = [], replacements = new Map<string, FixtureReply>();
  await page.route("**/*", route => { const url = new URL(route.request().url()); return url.hostname === "127.0.0.1" && url.protocol === "http:" ? route.continue() : route.abort("blockedbyclient"); });
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()); requests.push({ path: url.pathname, params: url.searchParams });
    if (url.pathname === "/api/fixture-states") { await route.fulfill({ json: fixtureStateCases() }); return; }
    const actualScenario = new URL(page.url() || "http://127.0.0.1").searchParams.get("scenario") as FixtureScenario | null;
    const selected = actualScenario ?? scenario;
    const pageName = url.pathname === "/api/calibration" ? "calibration" : url.pathname.startsWith("/api/session/") ? "session" : "overview";
    const cases = fixtureStateCases(); const example = cases.find(c => c.page === pageName && c.scenario === selected) ?? cases.find(c => c.page === pageName && c.scenario === "default")!;
    let reply = replacements.get(url.pathname) ?? example.responses[url.pathname];
    let validSession = false; try { validSession = url.pathname.startsWith("/api/session/") && supportedDetailId(decodeURIComponent(url.pathname.slice(13))); } catch { /* Unknown API path. */ }
    if (!reply && validSession) reply = { status: 404, body: { apiVersion: 1, error: { code: "not-found", message: "Session not found" } } };
    if (url.pathname === "/api/status" && (selected === "default" || selected === "stale") && !replacements.has(url.pathname)) reply = { status: 200, body: envelope(statusFixture({ lastIngestAt: Date.now() - (selected === "stale" ? 600001 : 0) })) };
    if (!reply) { unexpected.push(url.pathname); await route.fulfill({ status: 500, json: { apiVersion: 1, error: { code: "internal", message: "Unexpected fixture API path" } } }); return; }
    await route.fulfill({ status: reply.status, json: reply.body });
  });
  return { requests, unexpected, count(path) { return requests.filter(r => r.path === path).length; }, replace(path, reply) { replacements.set(path, structuredClone(reply)); } };
}
export function expectNoBrowserErrors(page: Page): () => readonly string[] {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && !(message.location().url.startsWith("https://fonts.gstatic.com/") && /ERR_BLOCKED_BY_CLIENT|ERR_FAILED/.test(message.text()))) errors.push(message.text()); });
  return () => errors;
}
let buildPromise: Promise<void> | undefined;
async function buildRealFixture(): Promise<void> {
  buildPromise ??= (async () => {
    const { build } = await import("vite"); const outDir = resolve(process.env.SPIDER_PLAYWRIGHT_SCRATCH ?? ".spider/scratch/playwright", "real-dist");
    await build({ configFile: resolve("vite.config.mjs"), build: { outDir } });
    await build({ configFile: resolve("vite.dashboard.config.mjs"), mode: "production", build: { outDir: join(outDir, "dashboard") } });
  })();
  await buildPromise;
}
export async function startRealUsageFixture(): Promise<{ bootstrapUrl: string; origin: string; stop(): Promise<void> }> {
  await buildRealFixture();
  const base = resolve(process.env.SPIDER_PLAYWRIGHT_SCRATCH ?? ".spider/scratch/playwright"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "real-fixture-"));
  const env = { ...process.env, SPIDER_GLOBAL_ROOT: root, SPIDER_E2E_FIXTURE_ROOT: root, SPIDER_E2E_BUNDLE: resolve(base, "real-dist/extension.js"), TMPDIR: resolve(base, "tmp") };
  for (const key of ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_RUN_ID", "PI_SPIDER_DB_PATH", "PI_SPIDER_SESSION_ID"]) delete env[key as keyof typeof env];
  const child = spawn(process.execPath, [resolve(process.env.SPIDER_PLAYWRIGHT_REAL_SERVER ?? "scripts/usage-dashboard-e2e-real-server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  let exited = false; const exit = once(child, "exit").then(() => { exited = true; }); let stopped = false;
  const stop = async () => {
    if (stopped) return; stopped = true; if (exited) { await rm(root, { recursive: true, force: true }); return; }
    const kill = (signal: NodeJS.Signals) => { try { if (process.platform === "win32") child.kill(signal); else if (child.pid) process.kill(-child.pid, signal); } catch { /* Already exited. */ } };
    kill("SIGTERM"); let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([exit, new Promise<void>(resolve => { timer = setTimeout(() => { kill("SIGKILL"); resolve(); }, 5000); })]); } finally { clearTimeout(timer); }
    await exit;
    await rm(root, { recursive: true, force: true });
  };
  try {
    const result = await new Promise<{ bootstrapUrl: string; origin: string }>((resolve, reject) => {
      let buffer = "", stderr = ""; const timer = setTimeout(() => reject(new Error("Real fixture startup timed out")), 30000);
      child.stderr.on("data", data => { stderr = (stderr + String(data)).slice(-4000); });
      child.stdout.on("data", data => { buffer += String(data); for (const line of buffer.split("\n")) { if (!line.startsWith("SPIDER_E2E_READY ")) continue; clearTimeout(timer); try { resolve(JSON.parse(line.slice(17))); } catch { reject(new Error("Invalid real fixture readiness")); } } });
      child.once("error", error => { clearTimeout(timer); reject(error); }); child.once("exit", code => { clearTimeout(timer); reject(new Error(`Real fixture exited ${code}: ${stderr}`)); });
    });
    return { ...result, stop };
  } catch (error) { await stop(); throw error; }
}
