import { SessionMetadataCapture } from "../session-metadata.js";
import { dashboardBatch, dashboardCall } from "./fixtures/dashboard-ledger.js";
import { readFileSync, readdirSync } from "node:fs";
import { CONFIG_SCHEMA } from "../../../../ui/src/screens/config-schema.js";
import { sumValues } from "../query-redesign-shared.js";
import { defaultOverview } from "../web/navigation.js";
import { resolveRange } from "../time-buckets.js";
import { DAY_MS } from "../dashboard-selection.js";
import { renderUsageFooter, type FooterInput } from "../footer.js";
import type { DashboardRouteV4 } from "../dashboard-v4-contract.js";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { afterEach, expect, it } from "vitest";
import { DASHBOARD_ROUTES } from "../api-routes.js";
import { openDashboardReader } from "../dashboard-reader.js";
import { startUsageHttpServer } from "../server.js";
import { createFixtureDashboard, cleanupFixtureDashboards } from "./fixtures/dashboard-assets.js";
import { createDashboardFixture, DASHBOARD_NOW } from "./fixtures/dashboard-ledger.js";

const retired = ["context", "source-errors", "explorer", "filter-values", "cache", "detail-links", "detail", "rates", "reconciliation"];
const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); cleanupFixtureDashboards(); });
function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; cookie?: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers, agent: false }, res => {
      let body = ""; res.on("data", bytes => { body += bytes; }); res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode!, body, cookie: res.headers["set-cookie"]?.[0]?.split(";")[0] }));
    }); req.on("error", reject); req.end();
  });
}
async function fixture() {
  const f = createDashboardFixture(); closers.push(f.close);
  const reader = openDashboardReader(f.file, { instanceId: "retirement", now: () => DASHBOARD_NOW, serverBuild: "fixture", calibrationMode: () => "auto" })!;
  const secret = randomBytes(32).toString("base64url");
  const server = await startUsageHttpServer({ reader, secret, instanceId: "retirement", serverBuild: "fixture", routes: DASHBOARD_ROUTES, dashboardDir: createFixtureDashboard(), now: () => DASHBOARD_NOW });
  closers.push(() => server.close());
  const nonce = JSON.parse((await get(server.port, "/local/bootstrap-nonce", { Authorization: `Bearer ${secret}` })).body).data.nonce;
  const Cookie = (await get(server.port, `/bootstrap?nonce=${nonce}`)).cookie!;
  return { f, reader, port: server.port, Cookie };
}
it("obsolete endpoints are unreachable after authentication, including with the former legacy header", async () => {
  const { port, Cookie } = await fixture();
  for (const name of retired) {
    expect((await get(port, `/api/${name}`)).status).toBe(401);
    for (const headers of [{ Cookie }, { Cookie, "X-Spider-Usage-Legacy": "1" }] as Record<string, string>[]) {
      const reply = await get(port, `/api/${name}`, headers);
      expect(reply.status, name).toBe(404);
      expect(JSON.parse(reply.body)).toEqual({ apiVersion: 1, error: { code: "not-found", message: "Not found" } });
    }
  }
});
it("former headers cannot select colliding old DTOs and old Overview grammar is invalid", async () => {
  const { port, Cookie } = await fixture();
  for (const path of ["/api/status", "/api/overview"]) {
    const normal = await get(port, path, { Cookie });
    const former = await get(port, path, { Cookie, "X-Spider-Usage-Legacy": "1" });
    expect(former.status).toBe(200); expect(former.body).toBe(normal.body);
  }
  expect((await get(port, "/api/overview?start=1&end=2", { Cookie })).status).toBe(400);
});
it("dictionary and privacy foundations survive the replacement routes", async () => {
  const { f, port, Cookie } = await fixture();
  const privateName = "Inspect /home/private-person/secret-project/session.jsonl";
  const metadata = new SessionMetadataCapture({ path: "synthetic/parent.jsonl", project: null, repo: null, run: null });
  metadata.consume({ type: "session", id: "parent-session", timestamp: new Date(DASHBOARD_NOW).toISOString() }, 0);
  metadata.consume({ type: "session_info", name: privateName }, 1);
  f.ledger.apply(dashboardBatch([dashboardCall("privacy-recent", { ts: DASHBOARD_NOW - 1 })], { sessions: [metadata.session!] }));
  expect(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dimension_values'").get()).toEqual({ name: "dimension_values" });
  for (const path of ["/api/status", "/api/overview", "/api/sessions", "/api/session/parent-session", "/api/calibration"]) {
    const reply = await get(port, path, { Cookie }); expect(reply.status, path).toBe(200);
    expect(reply.body).not.toMatch(/sourceFile|dbPath|accountLogin|leaseOwner|promptText/);
    expect(reply.body).not.toContain("synthetic/");
    expect(reply.body).not.toContain(f.root);
    expect(reply.body).not.toContain(privateName);
    expect(reply.body).not.toContain("secret-project");
    const data = JSON.parse(reply.body).data;
    if (path === "/api/session/parent-session") expect(data.name).toBe("Inspect …");
    if (path === "/api/overview") expect(data.sessions.rows.find((row: { id: string }) => row.id === "parent-session")?.name).toBe("Inspect …");
    if (path === "/api/sessions") expect(data.rows.find((row: { id: string }) => row.id === "parent-session")?.name).toBe("Inspect …");
  }
});

const guide = () => readFileSync(new URL("../../../../../docs/guide/usage.md", import.meta.url), "utf8");
const pageNames: Record<DashboardRouteV4["page"], string> = { overview: "Overview", session: "Session", calibration: "Calibration & data" };
it("guide matches controls, units, budget, footer and the dashboard development loop", () => {
  const text = guide(), defaults = defaultOverview(DASHBOARD_NOW, "UTC");
  for (const name of Object.values(pageNames)) expect(text).toContain(`## ${name}`);
  expect(text).toContain(`last ${(defaults.to - defaults.from) / DAY_MS} days and ${defaults.unit[0]!.toUpperCase() + defaults.unit.slice(1)} selected`);
  const tokenUnit = resolveRange(new URLSearchParams({ unit: "tokens" }), DASHBOARD_NOW).unit;
  expect(text).toContain(`Credits | ${tokenUnit[0]!.toUpperCase() + tokenUnit.slice(1)}`);
  const tokenLabels = { input: "input", cacheRead: "cache read", cacheWrite: "cache write", output: "output", reasoning: "reasoning", cacheWrite1h: "one-hour cache writes" };
  const included = Object.entries(tokenLabels).filter(([key]) => {
    const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, prompt: 0, total: 0, reasoning: 0, cacheWrite1h: 0, [key]: 1 };
    return sumValues([{ credits: 0, calls: 0, unpricedCalls: 0, tokens }]).tokens.total > 0;
  }).map(([, label]) => label);
  expect(text).toContain(`Token totals are ${included.join(" plus ")}`);
  expect(text).toContain("Reasoning and one-hour cache writes are subsets, not additional tokens");
  // Discover the public range boundary through the real parser, not a second constant.
  let maxDays = 0;
  for (let days = 1; days <= 366; days++) {
    try { resolveRange(new URLSearchParams({ range: "custom", from: "0", to: String(days * DAY_MS), tz: "UTC" }), DASHBOARD_NOW); maxDays = days; }
    catch { break; }
  }
  expect(maxDays).toBeGreaterThan(0);
  expect(text).toContain(`up to ${maxDays} days`);
  expect(text).toContain("Session opens on the current billing month, or on the calendar month of the session's last activity if it had none this month");
  expect(text).toContain("From and To open a calendar"); expect(text).toContain("This month and Whole session");
  const budget = CONFIG_SCHEMA.flatMap(group => group.fields).find(field => field.key === "usage.monthlyBudget")!;
  expect(budget).toMatchObject({ scope: "global", optional: true, exclusiveMin: 0, default: undefined });
  expect(text).toContain(`/spider config set ${budget.key} <credits> --${budget.scope}`);
  expect(text).toContain(`/spider config unset ${budget.key} --${budget.scope}`);
  const input: FooterInput = { cwd: "fixture", branch: null, sessionName: null, modelId: "fixture-model", thinking: "off", context: { percent: 25, contextWindow: 200000 }, subscription: true,
    totals: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, piCost: 0, aic: 2, unpricedEntries: 0, aggregateEntries: 0, estimated: false, latestCacheHitRate: 75 },
    counter: { availability: "available", snapshot: { creditsUsed: 24, entitlement: 100, ts: DASHBOARD_NOW } }, statuses: new Map() };
  const format = renderUsageFooter(input, 1000)[1]!
    .replace(/^\d+\.\d+%\/\w+/, "context%/window")
    .replace(/[\d.]+ credits/, "credits").replace(/CH[\d.]+%/, "CH%")
    .replace(/month \d+%/, "month %").replace(/↑\w+ ↓\w+/, "↑input ↓output").replace(/R\w+ W\w+/, "Rread Wwrite");
  expect(text).toContain(`\`${format}\``);
  expect(text).toContain("Items are separated by middle dots");
  expect(text).toContain("`month` is a whole percentage");
  expect(text).toContain("If neither is available, the `month` item is left out");
  const scripts = JSON.parse(readFileSync(new URL("../../../../../package.json", import.meta.url), "utf8")).scripts;
  for (const command of ["dev:dashboard", "build:dashboard"]) {
    expect(scripts[command]).toBeTypeOf("string"); expect(text).toContain(`npm run ${command}`);
  }
  expect(text).toContain("30-minute idle timeout");
  expect(text).toContain("SIGTERM"); expect(text).toContain("then run `/usage`");
  expect(text).toContain("earlier spider builds cannot open the ledger");
  expect(text).toContain("~/.pi/agent/spider/usage.db");
  expect(text).not.toMatch(/^## (?:Cache|Context|Run|Detail|Rates)\b/m);
  expect(text).not.toMatch(/Explorer|Reconciliation|\bAIC\b|\bcal\b|\best\b|—|\/Users\//);
});
it("public README usage links describe the replacement dashboard and footer", () => {
  for (const file of ["README.md", "docs/README.md"]) {
    const text = readFileSync(new URL(`../../../../../${file}`, import.meta.url), "utf8");
    expect(text).not.toMatch(/AIC footer|usage\.md#dashboard|attribution filters|cache observations|call timelines/);
    for (const name of Object.values(pageNames)) expect(text).toContain(name);
    expect(text).toContain("usage.monthlyBudget"); expect(text).toContain("credits");
  }
});

it("browser sources contain no dead legacy helpers or retired recovery copy", () => {
  const source = readdirSync(new URL("../web/", import.meta.url)).filter(name => name.endsWith(".ts")).map(name => readFileSync(new URL(`../web/${name}`, import.meta.url), "utf8")).join("\n");
  expect(source).not.toMatch(/chartWithTable|ChartUnit|ChartPoint|aicKey|formatCallEvidence|readableKey|formatEstimatedAic|formatAicDisplay|formatCalibrationFactor|formatCalibrationEvidence|formatCalibration\b|calibrationText|tokenSummary|tokenCell|formatUtcTimestamp|utcTime|formatPeriod|liveMessage|ViewRoute|configureRepresentation/);
  expect(source).not.toMatch(/Selected filter is no longer available|Clear filters to continue|Opaque filter bookmarks|query or cursor|cal means calibrated/);
});
