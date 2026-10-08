import { request } from "node:http";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { openDb } from "@spider/db-core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DASHBOARD_ROUTES } from "../api-routes.js";
import { startUsageHttpServer } from "../server.js";
import { openDashboardReader } from "../dashboard-reader.js";
import { ensureUsageServer, mintUsageBootstrap, usageProcessIdentity } from "../server-runtime.js";
import { ensurePrivateServerDir, writeServerRecord } from "../server-lock.js";
import { createDashboardClient } from "../web/client.js";
import { RESPONSE_CAPS_V4, type SessionData } from "../dashboard-v4-contract.js";
import type { ApiEnvelope, DashboardRoute, HttpOptions } from "../dashboard-contract.js";
import type { CallRow, RunMeta, SessionMeta } from "../ledger.js";
import { USAGE_LEASE_SCHEMA } from "../schema.js";
import { USAGE_MIGRATIONS, migrateUsageLedger } from "../migrate.js";
import { createFixtureDashboard, cleanupFixtureDashboards } from "./fixtures/dashboard-assets.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_NOW as NOW, DASHBOARD_MONTH as S, DASHBOARD_DAY as D, type DashboardFixture } from "./fixtures/dashboard-ledger.js";

const H = "parent-session", M = 60000;
const human = (id = H, ownerSessionId: string | null = null): SessionMeta => ({ id, ownerSessionId, name: `Name ${id}`, nameSource: "name", project: "synthetic", firstActivity: null, lastActivity: null, nameOrder: 1 });
const run = (id: string, extras: Partial<RunMeta> = {}): RunMeta => ({ id, dbPath: "synthetic/runs.db", project: null, repo: null, sessionId: H, parentRunId: null, agent: null, role: "worker", name: id, model: null, thinking: null, phase: null, startedAt: null, endedAt: null, status: null, ...extras });
let f: DashboardFixture;
const closers: (() => void | Promise<void>)[] = [];
beforeEach(() => { f = createDashboardFixture(false); });
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); f.close(); cleanupFixtureDashboards(); });
function reply(port: number, path: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; body: string; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, headers, method, agent: false }, res => {
      const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk)); res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    }); req.on("error", reject); req.end();
  });
}
async function start(overrides: Partial<HttpOptions> = {}, budget?: () => number | undefined, file = f.file) {
  const secret = randomBytes(32).toString("base64url"), instanceId = randomBytes(16).toString("hex");
  const reader = Object.hasOwn(overrides, "reader") ? overrides.reader : openDashboardReader(file, { instanceId, now: () => NOW, serverBuild: "fixture-build", calibrationMode: () => "auto", monthlyBudget: budget });
  const server = await startUsageHttpServer({ instanceId, serverBuild: "fixture-build", secret, reader, routes: DASHBOARD_ROUTES, dashboardDir: createFixtureDashboard(), now: () => NOW, ...overrides });
  closers.push(() => server.close());
  async function cookie(openerSessionId?: string, existing?: string) {
    const url = new URL(await mintUsageBootstrap({ version: 1, instanceId, pid: server.pid, port: server.port, secret }, Infinity, openerSessionId));
    const boot = await reply(server.port, url.pathname + url.search, existing ? { Cookie: existing } : {});
    expect(boot.status).toBe(303);
    const credential = boot.headers["set-cookie"]?.[0]?.split(";")[0] ?? existing!;
    expect(await reply(server.port, url.pathname + url.search)).toMatchObject({ status: 401 });
    return credential;
  }
  return { ...server, instanceId, secret, cookie, reader };
}
function seed() { f.ledger.apply(dashboardBatch([dashboardCall("old", { ts: S }), dashboardCall("recent", { ts: NOW - D })], { sessions: [human(), human("empty")] })); }
function data(response: { status: number; body: string }) { expect(response.status, response.body).toBe(200); const body = JSON.parse(response.body); expect(body).toMatchObject({ apiVersion: 1, generatedAt: NOW, revision: expect.any(String), period: { start: expect.any(Number), end: expect.any(Number) } }); return body; }

it("five authenticated route envelopes expose complete new shapes and resolved periods", async () => {
  seed(); const server = await start(), Cookie = await server.cookie();
  const status = data(await reply(server.port, "/api/status", { Cookie }));
  expect(status.data).toEqual({ lastIngestAt: null, collector: "none", latestCounterAt: null, serverBuild: "fixture-build", rateVersions: ["copilot-public-2026-10-04"] });
  const overview = data(await reply(server.port, "/api/overview?tz=Not%2FAZone", { Cookie }));
  expect(overview.data).toMatchObject({ range: { range: "7d", from: NOW - 7 * D, to: NOW, tz: "UTC", unit: "credits", buckets: [] }, total: { credits: 1, calls: 1 }, sessions: { limit: 10 } });
  expect(overview.period).toEqual({ start: NOW - 7 * D, end: NOW });
  const sessions = data(await reply(server.port, "/api/sessions", { Cookie }));
  expect(sessions.data.rows).toEqual(overview.data.sessions.rows); expect(sessions.period).toEqual(overview.period);
  const session = data(await reply(server.port, `/api/session/${H}?tz=UTC`, { Cookie }));
  expect(session.data).toMatchObject({ id: H, total: { credits: 2 }, stats: { ownCalls: 2 }, span: { start: S, end: NOW - D + 1 } });
  expect(session.period).toEqual(session.data.span);
  const calibration = data(await reply(server.port, "/api/calibration", { Cookie }));
  expect(calibration.data).toMatchObject({ correction: { factor: null }, daily: expect.any(Array), rates: expect.any(Array), ingestion: { collector: "none" }, errors: [], gaps: { unpricedCalls: 0 } });
  expect(calibration.period).toEqual({ start: S, end: NOW });
});

it("session not-found is nonretryable, unsupported ids fail and extra segments never match", async () => {
  seed(); const server = await start(), Cookie = await server.cookie();
  const unknown = await reply(server.port, "/api/session/missing", { Cookie });
  expect(unknown.status).toBe(404); expect(JSON.parse(unknown.body)).toEqual({ apiVersion: 1, error: { code: "not-found", message: "Session not found" } });
  expect((await reply(server.port, "/api/session/bad!", { Cookie })).status).toBe(400);
  for (const path of ["/api/session/parent-session/extra", "/api/session/", "/api/session/%2e%2e%2fescape"]) expect((await reply(server.port, path, { Cookie })).status).not.toBe(200);
  for (const search of ["?start=1&end=2", "?from=1&to=2", "?tz=UTC&tz=UTC", "?unit=tokens"]) expect((await reply(server.port, `/api/session/${H}${search}`, { Cookie })).status).toBe(400);
  const empty = data(await reply(server.port, "/api/session/empty", { Cookie }));
  expect(empty.data.span).toBeNull(); expect(empty.period).toEqual({ start: NOW, end: NOW });
});

it("all retired routes return not-found and client uses only focused DTOs", async () => {
  seed(); const server = await start(), Cookie = await server.cookie();
  for (const path of ["context", "source-errors", "explorer", "filter-values", "cache", "detail-links", "detail", "rates", "reconciliation"]) expect((await reply(server.port, `/api/${path}`, { Cookie })).status).toBe(404);
  const fetcher = ((path: string, init: RequestInit) => fetch(`http://127.0.0.1:${server.port}${path}`, { ...init, headers: { ...init.headers, Cookie } })) as typeof fetch;
  expect((await createDashboardClient(fetcher).get("/api/status", new URLSearchParams(), new AbortController().signal)).data).toHaveProperty("collector");
  expect((await reply(server.port, `/api/overview?start=${S}&end=${NOW}`, { Cookie })).status).toBe(400);
});

it("security, HEAD and cached authenticated assets survive all new paths", async () => {
  seed(); const server = await start();
  const paths = ["/api/status", "/api/overview", "/api/sessions", `/api/session/${H}`, "/api/calibration"];
  for (const path of paths) expect((await reply(server.port, path)).status).toBe(401);
  const Cookie = await server.cookie();
  for (const path of paths) {
    expect((await reply(server.port, path, { Cookie, Origin: "https://evil.invalid" })).status).toBe(403);
    expect((await reply(server.port, path, { Cookie, "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    const head = await reply(server.port, path, { Cookie }, "HEAD"); expect(head.status).toBe(200); expect(head.body).toBe(""); expect(Number(head.headers["content-length"])).toBeGreaterThan(0);
  }
  const html = await reply(server.port, "/", { Cookie });
  expect(html.headers["content-security-policy"]).toContain("script-src 'self'"); expect(html.headers["content-security-policy"]).not.toMatch(/unsafe-inline|sha256/);
  const asset = /(?:src|href)="(\/assets\/[^\"]+)"/.exec(html.body)![1]!;
  expect((await reply(server.port, asset)).status).toBe(401); expect((await reply(server.port, asset, { Cookie })).status).toBe(200);
  server.reader!.snapshot(ctx => { expect(ctx.db.pragma("query_only")).toBe(1); expect(() => ctx.db.prepare("DELETE FROM calls").run()).toThrow(); });
});

it("two opener cookies on one server classify the live collector independently and remint updates existing cookies", async () => {
  const owner = "private-lease-owner", viewer = "private-viewer";
  f.ledger.leases.acquire("ingest", owner, NOW, 60000);
  f.db.prepare("INSERT INTO ledger_metadata(key,value) VALUES ('worker-snapshot',?)").run(JSON.stringify({ collector: { kind: "pi", sessionId: viewer, owner } }));
  const server = await start(), a = await server.cookie(viewer), b = await server.cookie("other-viewer");
  for (const path of ["/api/status", "/api/calibration"]) {
    const own = data(await reply(server.port, path, { Cookie: a })), other = data(await reply(server.port, path, { Cookie: b }));
    expect(path === "/api/status" ? own.data.collector : own.data.ingestion.collector).toBe("this-session");
    expect(path === "/api/status" ? other.data.collector : other.data.ingestion.collector).toBe("another-session");
    for (const body of [own, other]) expect(JSON.stringify(body)).not.toMatch(/private-viewer|other-viewer|private-lease-owner|viewerSessionId|openerSessionId/);
  }
  await server.cookie(viewer, b);
  expect(data(await reply(server.port, "/api/status", { Cookie: b })).data.collector).toBe("this-session");
  // Exercise both warm-reuse mint call sites through the launcher, not just its helper.
  const dir = join(f.root, "usage-server"); await ensurePrivateServerDir(dir);
  const lockFile = join(dir, "lock.json");
  await writeServerRecord(lockFile, { version: 1, instanceId: server.instanceId, pid: process.pid, port: server.port,
    secret: server.secret, processIdentity: (await usageProcessIdentity(process.pid))!, serverBuild: "fixture-build" });
  for (const [openerSessionId, collector] of [[viewer, "this-session"], ["other-viewer", "another-session"]]) {
    const launched = await ensureUsageServer({ bundleUrl: join(f.root, "fixture.mjs"), lockFile, serverBuild: "fixture-build", calibrationMode: "auto", openerSessionId,
      roots: { ledgerFile: f.file, registryDb: join(f.root, "registry.db"), sessionsDir: join(f.root, "sessions"), authPath: join(f.root, "auth.json"), leaseDir: join(f.root, "leases") } });
    expect(launched.reused).toBe(true); expect(launched.port).toBe(server.port); expect(launched.bootstrapUrl).not.toContain(openerSessionId!);
    const url = new URL(launched.bootstrapUrl), boot = await reply(server.port, url.pathname + url.search);
    expect(data(await reply(server.port, "/api/status", { Cookie: boot.headers["set-cookie"]![0]!.split(";")[0]! })).data.collector).toBe(collector);
  }
  // Request headers on API paths cannot change an established cookie context.
  expect(data(await reply(server.port, "/api/status", { Cookie: a, "X-Spider-Opener-Session": "other-viewer" })).data.collector).toBe("this-session");
  expect((await reply(server.port, "/local/bootstrap-nonce", { Authorization: `Bearer ${server.secret}`, "X-Spider-Opener-Session": "bad!" })).status).toBe(400);
  expect((await reply(server.port, "/local/bootstrap-nonce", { "X-Spider-Opener-Session": viewer })).status).toBe(401);
});

it("budget callback is evaluated live for the next Overview response", async () => {
  seed(); let budget: number | undefined;
  const server = await start({}, () => budget), Cookie = await server.cookie();
  expect(data(await reply(server.port, "/api/overview", { Cookie })).data.pace.budget).toBeNull();
  budget = 250; expect(data(await reply(server.port, "/api/overview", { Cookie })).data.pace.budget).toBe(250);
  budget = undefined; expect(data(await reply(server.port, "/api/overview", { Cookie })).data.pace.budget).toBeNull();
});

it("status is complete without a ledger and invalid queries still fail", async () => {
  const server = await start({ reader: undefined }), Cookie = await server.cookie();
  expect(data(await reply(server.port, "/api/status", { Cookie })).data).toEqual({ lastIngestAt: null, collector: "none", latestCounterAt: null, serverBuild: "fixture-build", rateVersions: ["copilot-public-2026-10-04"] });
  expect((await reply(server.port, "/api/status?extra=1", { Cookie })).status).toBe(400);
  expect((await reply(server.port, "/api/overview", { Cookie })).status).toBe(503);
});

it("no-ledger status fallback obeys the same UTF-8 byte cap", async () => {
  const server = await start({ reader: undefined, serverBuild: "é".repeat(4096) }), Cookie = await server.cookie();
  const response = await reply(server.port, "/api/status", { Cookie });
  expect(response.status).toBe(413); expect(JSON.parse(response.body).error.code).toBe("response-limit");
});

it.each(Object.entries(RESPONSE_CAPS_V4))("enforces UTF-8 envelope cap for %s including the dynamic template", async (template, cap) => {
  // A boundary double supplies oversized query output; routing, snapshot and serialization remain real.
  const reader = openDashboardReader(f.file, { instanceId: "caps", now: () => NOW, serverBuild: "fixture", calibrationMode: () => "auto" })!;
  const route = DASHBOARD_ROUTES.find(route => route.path === template)!;
  seed();
  let payload = "é".repeat(Math.floor(((template === "/api/session/<id>" ? 2 * 1024 * 1024 : cap) - Math.min(16384, cap / 2)) / 2));
  const routes: readonly DashboardRoute[] = DASHBOARD_ROUTES.map(r => r === route ? { ...r, handle: (ctx, params, id) => ({ ...r.handle(ctx, params, id) as object, padding: payload }) } : r);
  const server = await start({ reader, routes }), Cookie = await server.cookie();
  const path = template.replace("<id>", H);
  const accepted = await reply(server.port, path, { Cookie }); expect(accepted.status).toBe(200);
  payload = "é".repeat(Math.floor(cap / 2));
  const response = await reply(server.port, path, { Cookie }); expect(response.status).toBe(413);
  expect(JSON.parse(response.body)).toEqual({ apiVersion: 1, error: { code: "response-limit", message: "Response limit" } });
});

it.each([1, 2, 3])("reopens a read-only v%s reader after another connection upgrades and serves sessions without restart", async version => {
  const file = join(f.root, `v${version}.db`), db = openDb(file); closers.push(() => db.close());
  for (const migration of USAGE_MIGRATIONS.filter(m => m.version <= version)) db.exec(migration.sql);
  db.pragma(`user_version=${version}`);
  db.exec(USAGE_LEASE_SCHEMA);
  db.prepare("INSERT OR IGNORE INTO ledger_metadata(key,value) VALUES ('call-selection-revision','0')").run();
  const server = await start({}, undefined, file), Cookie = await server.cookie();
  const oldDb = server.reader!.snapshot(ctx => ctx.db);
  expect(db.pragma("user_version")).toBe(version);
  migrateUsageLedger(db);
  db.prepare("INSERT INTO sessions(id,owner_session_id,name,name_source,project,first_activity,last_activity,name_order) VALUES ('upgraded',NULL,'Upgraded','name',NULL,NULL,NULL,1)").run();
  expect(data(await reply(server.port, "/api/session/upgraded", { Cookie })).data.name).toBe("Upgraded");
  expect(server.reader!.snapshot(ctx => ctx.db)).not.toBe(oldDb);
  expect(oldDb.raw.open).toBe(false);
  expect(server.reader!.snapshot(ctx => ctx.db.pragma("query_only"))).toBe(1);
});

it("six-month whole-session envelope retains 50000 own calls, 300 runs and all compact gaps through the production matcher", async () => {
  const calls: CallRow[] = [], runs: RunMeta[] = []; let last = S;
  for (let p = 0; p < 250; p++) {
    let ts = S + p * 17 * 60 * M;
    for (let i = 0; i < 200; i++) { if (i) ts += i <= 40 ? 6 * M : 1000; calls.push(dashboardCall(`own-${p}-${i}`, { ts })); last = ts; }
  }
  for (let i = 0; i < 300; i++) {
    const ts = S + i * 12 * 60 * M, id = `run-${String(i).padStart(3, "0")}`;
    runs.push(run(id, { startedAt: ts, endedAt: ts + M, status: "done", model: "model-worker" }));
    calls.push(dashboardCall(`worker-${i}`, { ts, actor: "subagent", runId: id, sessionId: `child-${i}`, model: "model-worker", price: { status: "priced", aic: 2, components: { input: 0, cacheRead: 0, cacheWrite: 2, output: 0 }, rateVersion: "fixture", tier: "base", confidence: "estimated" } }));
  }
  f.ledger.apply(dashboardBatch(calls, { runs, sessions: [human(), ...runs.map((_, i) => human(`child-${i}`, H))] }));
  const server = await start(), Cookie = await server.cookie();
  const response = await reply(server.port, `/api/session/${H}?tz=America%2FNew_York`, { Cookie });
  const envelope = data(response) as ApiEnvelope<SessionData>;
  expect(last - S).toBeLessThan(183 * D); expect(last - S).toBeGreaterThan(160 * D);
  expect(envelope.period).toEqual({ start: S, end: last + 1 });
  expect(envelope.data.stats).toEqual({ runs: 300, ownCalls: 50000, compaction: 0, idleGaps: 10249 });
  expect(envelope.data.ownCallBins).toHaveLength(250); expect(envelope.data.runs).toHaveLength(300);
  expect(envelope.data.total).toMatchObject({ credits: 50600, calls: 50300 });
  expect(envelope.data.idleGaps.every(g => Object.keys(g).sort().join(",") === "cacheWriteCredits,end,start")).toBe(true);
  expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(2 * 1024 * 1024);
  process.stdout.write(`HTTP_LONG_SESSION calls=50000 runs=300 gaps=10249 bins=250 bytes=${Buffer.byteLength(response.body)} cap=2097152\n`);
}, 120000);


it("percent-decoded colon session ids reach the real whole-session route", async () => {
  const id = "session:with:colon";
  f.ledger.apply(dashboardBatch([dashboardCall("colon-call", { sessionId: id, ts: S })], { sessions: [human(id)] }));
  const server = await start(), Cookie = await server.cookie();
  const response = data(await reply(server.port, `/api/session/${encodeURIComponent(id)}?tz=UTC`, { Cookie }));
  expect(response.data).toMatchObject({ id, name: `Name ${id}`, total: { calls: 1, credits: 1 } });
  for (const path of ["/api/session/bad%ZZ", "/api/session/%E0%A4%A", "/api/session/bad%253Aid", "/api/session/a%2Fb", "/api/session/a%5Cb"]) {
    const invalid = await reply(server.port, path, { Cookie });
    expect(invalid.status).toBe(400); expect(JSON.parse(invalid.body).error.code).toBe("invalid-query");
  }
});

it.each([1, 2, 3])("pre-v%s missing redesign tables are unavailable, not internal or migrated by the reader", async version => {
  const file = join(f.root, `waiting-v${version}.db`), db = openDb(file); closers.push(() => db.close());
  for (const migration of USAGE_MIGRATIONS.filter(m => m.version <= version)) db.exec(migration.sql);
  db.pragma(`user_version=${version}`);
  db.exec(USAGE_LEASE_SCHEMA);
  db.prepare("INSERT OR IGNORE INTO ledger_metadata(key,value) VALUES ('call-selection-revision','0')").run();
  const server = await start({}, undefined, file), Cookie = await server.cookie();
  expect(data(await reply(server.port, "/api/status", { Cookie })).data.collector).toBe("none");
  for (const path of ["/api/overview", "/api/sessions", "/api/session/pending"]) {
    const response = await reply(server.port, path, { Cookie });
    expect(response.status, response.body).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ apiVersion: 1, error: { code: "ledger-unavailable", message: "Ledger unavailable" } });
  }
  expect(db.pragma("user_version")).toBe(version);
  migrateUsageLedger(db);
  expect(data(await reply(server.port, "/api/overview", { Cookie })).data.sessions.total).toBe(0);
});
