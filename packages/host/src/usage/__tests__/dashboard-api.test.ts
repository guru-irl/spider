import { createFixtureDashboard, cleanupFixtureDashboards } from "./fixtures/dashboard-assets.js";
import { openDb } from "@spider/db-core";
import * as planModule from "./fixtures/dashboard-plan.js";
import { randomBytes } from "node:crypto";
import { request, type IncomingHttpHeaders } from "node:http";
import { afterEach, expect, test } from "vitest";
afterEach(cleanupFixtureDashboards);
import { DASHBOARD_ROUTES } from "../api-routes.js";
import { openDashboardReader } from "../dashboard-reader.js";
import { startUsageHttpServer } from "../server.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH, DASHBOARD_DAY, DASHBOARD_NOW } from "./fixtures/dashboard-ledger.js";

const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
function get(port: number, path: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers, method, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk)); res.on("aborted", () => reject(new Error("aborted")));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject); req.end();
  });
}
test("no-write guard detects a writer on another connection, including non-call tables", () => {
  const guard = Reflect.get(planModule, "assertNoWrites");
  expect(guard).toBeTypeOf("function");
  const fixture = createDashboardFixture(); closers.push(fixture.close);
  const before = Number(fixture.db.pragma("data_version"));
  guard(fixture.db, before);
  const writer = openDb(fixture.file);
  try { writer.prepare("INSERT INTO ledger_metadata(key,value) VALUES ('write-mutant','1')").run(); } finally { writer.close(); }
  expect(() => guard(fixture.db, before)).toThrow(/database write/);
});

const routes = [
  ["status", "", 8], ["source-errors", "", 64], ["overview", "", 512], ["context", "", 8],
  ["explorer", "", 256], ["filter-values", "?field=model", 64],
  ["detail", "?kind=session&id=parent-session", 512], ["detail", "?kind=run&id=detailed-run", 512],
  ["detail-links", "?kind=session&id=parent-session", 64], ["detail-links", "?kind=run&id=detailed-run", 64],
  ["cache", "", 256], ["reconciliation", "", 256], ["rates", "", 512],
] as const;

// Losing route registration, auth-before-data, fixed errors, bounds, or DTO parity breaks this contract.
test("all routes preserve wire and read-only boundary", async () => {
  const fixture = createDashboardFixture(); closers.push(fixture.close);
  fixture.ledger.apply(dashboardBatch([dashboardCall("wire-calibrated", { ts: DASHBOARD_MONTH + 10 * DASHBOARD_DAY + 1,
    price: { status: "priced", aic: 1000, components: { input: 100, cacheRead: 200, cacheWrite: 300, output: 400 }, rateVersion: "fixture-rate", tier: "fixture-tier", confidence: "estimated" } })]));
  for (const [ts, credits] of [[DASHBOARD_MONTH + 10 * DASHBOARD_DAY, 0], [DASHBOARD_MONTH + 11 * DASHBOARD_DAY, 500]])
    fixture.db.prepare("INSERT INTO counter_snapshots VALUES (?,?,?,?,?,?,?)").run(ts, "synthetic-private-account", credits, 10000, 10000 - credits!, "synthetic-reset", '{"private":"synthetic-private-payload"}');
  const reader = openDashboardReader(fixture.file, { instanceId: "api-fixture", serverBuild: "fixture", now: () => DASHBOARD_NOW, calibrationMode: () => "auto" })!;
  const secret = randomBytes(32).toString("hex");
  const server = await startUsageHttpServer({ instanceId: "api-fixture", serverBuild: "fixture", secret, reader, routes: DASHBOARD_ROUTES, dashboardDir: createFixtureDashboard(), now: () => DASHBOARD_NOW });
  closers.push(() => server.close());
  const nonce = JSON.parse((await get(server.port, "/local/bootstrap-nonce", { Authorization: `Bearer ${secret}` })).body).data.nonce;
  const bootstrap = await get(server.port, `/bootstrap?nonce=${nonce}`);
  const setCookie = bootstrap.headers["set-cookie"]![0]!;
  expect(setCookie).toContain("HttpOnly"); expect(setCookie).toContain("SameSite=Strict"); expect(setCookie).toContain("Path=/");
  expect(setCookie).not.toMatch(/Domain|Max-Age|Expires|Secure/);
  expect(bootstrap.status).toBe(303); expect(bootstrap.headers.location).toBe("/");
  const Cookie = setCookie.split(";")[0]!;
  const before = Number(fixture.db.pragma("data_version"));
  const revision = reader.revision();
  const readDb = reader.snapshot(ctx => ctx.db);
  expect(readDb.raw.readonly).toBe(true); expect(readDb.pragma("query_only")).toBe(1);
  const readerChanges = readDb.prepare("SELECT total_changes() AS n").get();
  const fingerprint = () => fixture.db.prepare("SELECT count(*) AS n,sum(ts) AS ts,sum(aic) AS aic FROM calls").get();
  const original = fingerprint();
  const seenMeasures: Record<string, number> = {};
  const bases = new Set<string>();
  const inspect = (value: unknown, name: string): void => {
    if (!value || typeof value !== "object") return;
    const obj = value as Record<string, any>;
    expect(Object.keys(obj)).not.toContain("account_login"); expect(Object.keys(obj)).not.toContain("accountLogin"); expect(Object.keys(obj)).not.toContain("raw");
    if (obj.calibration) expect(obj.calibration).toMatchObject({ status: expect.stringMatching(/^(calibrated|uncalibrated|implausible|off)$/), method: "trailing-7d-ratio", coveredHours: expect.any(Number), computedAic: expect.any(Number), counterDelta: expect.any(Number), unpricedCalls: expect.any(Number) });
    if (obj.tokens && "unpricedCalls" in obj) {
      bases.add(obj.aicDisplay.basis);
      expect(obj.aicDisplay.publishedAic).toBe(obj.aic);
      expect(obj.aicDisplay.primaryAic).toBe(obj.aic === null ? null : obj.aic * (obj.aicDisplay.basis === "published" ? 1 : 0.5));
      expect(["published", "calibrated", "back-applied"]).toContain(obj.aicDisplay.basis);
      expect(obj.tokens.prompt).toBe(obj.tokens.input + obj.tokens.cacheRead + obj.tokens.cacheWrite);
      expect(obj.tokens.total).toBe(obj.tokens.prompt + obj.tokens.output);
      seenMeasures[name] = (seenMeasures[name] ?? 0) + 1;
    }
    for (const child of Object.values(obj)) inspect(child, name);
  };
  planModule.assertRegisteredRoutes(DASHBOARD_ROUTES, routes.map(([name]) => `/api/${name}`));
  for (const registered of DASHBOARD_ROUTES) for (const [name, query, kib] of routes.filter(([name]) => `/api/${name}` === registered.path)) {
    const path = `/api/${name}${query}`;
    expect((await get(server.port, path)).status, path).toBe(401);
    for (const hostile of [{ Origin: "null" }, { Origin: "https://foreign.invalid" }, { "Sec-Fetch-Site": "cross-site" }, { "X-Forwarded-Host": "foreign.invalid" }, { Host: "foreign.invalid" }] as Record<string, string>[]) {
      expect((await get(server.port, path, { Cookie, ...hostile })).status, path).toBe(403);
    }
    const reply = await get(server.port, path, { Cookie, "Sec-Fetch-Site": "same-origin" });
    expect(reply.status, path).toBe(200);
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
    expect(reply.headers["referrer-policy"]).toBe("no-referrer");
    expect(reply.headers["content-security-policy"]).toBe([
      "default-src 'none'", "script-src 'self'", "style-src 'self'", "style-src-attr 'none'",
      "font-src https://fonts.gstatic.com", "connect-src 'self'", "img-src 'self'", "object-src 'none'", "base-uri 'none'",
      "form-action 'none'", "frame-src 'none'", "frame-ancestors 'none'",
    ].join("; "));
    expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
    expect(reply.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(Buffer.byteLength(reply.body), path).toBeLessThanOrEqual(kib * 1024);
    expect(reply.body).not.toContain("synthetic-private-account"); expect(reply.body).not.toContain("synthetic-private-payload");
    expect(readDb.raw.inTransaction).toBe(false);
    expect(readDb.prepare("SELECT total_changes() AS n").get()).toEqual(readerChanges);
    const wire = JSON.parse(reply.body);
    expect(wire).toMatchObject({ apiVersion: 1, revision, generatedAt: DASHBOARD_NOW, period: { start: expect.any(Number), end: expect.any(Number) }, data: expect.anything() });
    inspect(wire.data, name);
    const head = await get(server.port, path, { Cookie }, "HEAD");
    expect(head.status, path).toBe(200); expect(head.body).toBe(""); expect(Number(head.headers["content-length"])).toBe(Buffer.byteLength(reply.body));
    const invalid = `${path}${query ? "&" : "?"}unknown=1`;
    const bad = await get(server.port, invalid, { Cookie });
    expect(bad.status, invalid).toBe(400); expect(JSON.parse(bad.body)).toEqual({ apiVersion: 1, error: { code: "invalid-query", message: "Invalid query" } });
    const pageable = ["source-errors", "explorer", "filter-values", "detail", "detail-links", "cache", "reconciliation", "rates"].includes(name);
    const period = !["status", "source-errors"].includes(name);
    const cursor = pageable || name === "overview";
    const suffixes = [...(pageable ? ["limit=201"] : []), ...(period ? ["start=0&end=31622400001", "start=0&start=0"] : []), ...(cursor ? [`cursor=${"x".repeat(2049)}`] : [])];
    if (pageable) expect((await get(server.port, `${path}${query ? "&" : "?"}limit=200`, { Cookie })).status).toBe(200);
    for (const suffix of suffixes) expect((await get(server.port, `${path}${query ? "&" : "?"}${suffix}`, { Cookie })).status, `${name} ${suffix.slice(0, 50)}`).toBe(400);
    const post = await get(server.port, path, { Cookie }, "POST");
    expect(post.status).toBe(405); expect(post.headers.allow).toBe("GET, HEAD");
    expect(JSON.parse(post.body)).toEqual({ apiVersion: 1, error: { code: "method-not-allowed", message: "Method not allowed" } });
  }
  for (const name of ["overview", "explorer", "detail", "cache", "reconciliation", "rates"]) expect(seenMeasures[name], name).toBeGreaterThan(0);
  expect(bases).toContain("calibrated"); expect(bases).toContain("back-applied");
  expect(fingerprint()).toEqual(original); expect(reader.revision()).toBe(revision);
  planModule.assertNoWrites(fixture.db, before);
  const unknown = await get(server.port, "/api/does-not-exist", { Cookie });
  expect(unknown.status).toBe(404); expect(JSON.parse(unknown.body)).toEqual({ apiVersion: 1, error: { code: "not-found", message: "Not found" } });
  expect(() => reader.snapshot(ctx => ctx.db.prepare("DELETE FROM calls").run())).toThrow();
  expect(fingerprint()).toEqual(original);
});
