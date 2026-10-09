import { seedCalibrationEvidence } from "./fixtures/calibration-evidence.js";
import { createFixtureDashboard, cleanupFixtureDashboards } from "./fixtures/dashboard-assets.js";
import { request } from "node:http";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
afterEach(cleanupFixtureDashboards);
import { DashboardQueryError, type ApiErrorCode, type HttpOptions } from "../dashboard-contract.js";
import { openDashboardReader } from "../dashboard-reader.js";
import { DASHBOARD_ROUTES as OVERVIEW_ROUTES } from "../api-routes.js";
import { createDashboardFixture, DASHBOARD_NOW } from "./fixtures/dashboard-ledger.js";

type RunningServer = { pid: number; port: number; close(): Promise<void> };
type Reply = { status: number; headers: import("node:http").IncomingHttpHeaders; body: string };
const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const close of closers.splice(0).reverse()) await close(); });

async function start(overrides: Partial<HttpOptions> = {}, calibrationMode: () => "auto" | "off" = () => "auto") {
  // An absent implementation is a behavioral RED, not a test-loader failure.
  const implementation = await import("../server.js").catch(() => undefined);
  expect(implementation?.startUsageHttpServer).toBeTypeOf("function");
  const fixture = createDashboardFixture();
  closers.push(() => fixture.close());
  const secret = randomBytes(32).toString("hex");
  const options: HttpOptions = { instanceId: "fixture-instance", serverBuild: "fixture-build", secret,
    reader: Object.hasOwn(overrides, "reader") ? overrides.reader : openDashboardReader(fixture.file, { instanceId: "fixture-instance", serverBuild: "fixture-build", now: () => DASHBOARD_NOW, calibrationMode }),
    routes: OVERVIEW_ROUTES, dashboardDir: createFixtureDashboard(),
    now: () => DASHBOARD_NOW, ...overrides };
  const server: RunningServer = await implementation!.startUsageHttpServer(options);
  closers.push(() => server.close());
  return { ...server, secret, fixture, options };
}
function get(port: number, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers, method, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on("aborted", () => reject(new Error("incomplete HTTP response"))); res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject); req.end();
  });
}
async function login(server: { port: number; secret: string }): Promise<string> {
  const minted = await get(server.port, "/local/bootstrap-nonce", { Authorization: `Bearer ${server.secret}` });
  expect(minted.status).toBe(200);
  const boot = await get(server.port, `/bootstrap?nonce=${JSON.parse(minted.body).data.nonce}`);
  expect(boot.status).toBe(303);
  return boot.headers["set-cookie"]![0]!.split(";")[0]!;
}

describe("usage HTTP", () => {
  test("reader calibration mode reaches Calibration correction status", async () => {
    let mode: "auto" | "off" = "off";
    const server = await start({}, () => mode);
    seedCalibrationEvidence(server.fixture.file, DASHBOARD_NOW);
    const cookie = await login(server);
    for (const selected of ["off", "auto"] as const) {
      mode = selected;
      const reply = await get(server.port, "/api/calibration", { Cookie: cookie });
      expect(reply.status).toBe(200);
      expect(JSON.parse(reply.body).data).toMatchObject({ correction: selected === "off" ? { factor: null, status: "published-only" } : { factor: 0.5, status: "back-applied" } });
    }
  });
  test("transport query errors fail before snapshots and focused handlers validate their own grammar", async () => {
    const server = await start(), cookie = await login(server);
    const snapshot = vi.spyOn(server.options.reader!, "snapshot");
    for (const path of ["/api/status?unknown=1", "/api/overview?tz=UTC&tz=UTC", "/api/status?x=" + "a".repeat(8192)]) expect((await get(server.port, path, { Cookie: cookie })).status).toBe(400);
    for (const path of ["/api/context", "/api/source-errors"]) expect((await get(server.port, path, { Cookie: cookie })).status).toBe(404);
    expect(snapshot).not.toHaveBeenCalled();
    for (const path of ["/api/overview?unknown=1", "/api/overview?start=1&end=2", "/api/sessions?limit=201", "/api/overview?range=custom&from=0&to=8035200001", "/api/overview?buckets=[1,1]"]) expect((await get(server.port, path, { Cookie: cookie })).status).toBe(400);
    expect((await get(server.port, "/api/sessions?limit=200", { Cookie: cookie })).status).toBe(200);
    expect(snapshot).toHaveBeenCalledTimes(6);
  });
  test("slow headers expire within five seconds", async () => {
    const server = await start();
    const result = await new Promise<string>((resolve, reject) => {
      const socket = connect(server.port, "127.0.0.1", () => socket.write("GET / HTTP/1.1\r\nHo"));
      closers.push(() => { socket.destroy(); });
      let reply = "";
      const deadline = setTimeout(() => { socket.destroy(); resolve("deadline exceeded"); }, 7500);
      socket.on("data", data => { reply += data.toString(); });
      socket.on("error", reject);
      socket.on("end", () => { clearTimeout(deadline); resolve(reply); });
    });
    expect(result === "" || result.startsWith("HTTP/1.1 408")).toBe(true);
  });
  test("socket admission caps connections", async () => {
    const server = await start();
    const sockets = [] as import("node:net").Socket[];
    closers.push(() => { for (const socket of sockets) socket.destroy(); });
    for (let count = 0; count < 32; count++) {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(server.port, "127.0.0.1", () => socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: keep-alive\r\n\r\n`));
        sockets.push(socket); socket.on("error", reject);
        socket.once("data", data => { expect(data.toString()).toContain("401 Unauthorized"); resolve(); });
      });
    }
    await expect(get(server.port, "/")).rejects.toThrow();

  });
  test("idle deadline resets only for authenticated requests", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let now = DASHBOARD_NOW;
    const onClose = vi.fn(async () => {});
    const server = await start({ now: () => now, onClose });
    const cookie = await login(server);
    const readerClose = vi.spyOn(server.options.reader!, "close");
    now += 1_799_999;
    await vi.advanceTimersByTimeAsync(1_799_999);
    expect((await get(server.port, "/", {})).status).toBe(401);
    expect((await get(server.port, "/api/status", { Cookie: cookie })).status).toBe(200);
    expect((await get(server.port, "/api/overview?bad=1", { Cookie: cookie })).status).toBe(400);
    expect((await get(server.port, "/local/bootstrap-nonce", { Authorization: `Bearer ${server.secret}` })).status).toBe(200);
    now += 1;
    await vi.advanceTimersByTimeAsync(1);
    await expect(get(server.port, "/api/status", { Cookie: cookie })).rejects.toMatchObject({ code: "ECONNREFUSED" });
    await server.close(); await server.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(readerClose).toHaveBeenCalledTimes(1);
    const activeClose = vi.fn(async () => {});
    const active = await start({ now: () => now, onClose: activeClose });
    const activeCookie = await login(active);
    now += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await get(active.port, "/", { Cookie: activeCookie })).status).toBe(200);
    now += 1_799_999;
    await vi.advanceTimersByTimeAsync(1_799_999);
    expect((await get(active.port, "/api/status", { Cookie: activeCookie })).status).toBe(200);
    now += 1;
    await vi.advanceTimersByTimeAsync(1);
    await expect(get(active.port, "/", { Cookie: activeCookie })).rejects.toMatchObject({ code: "ECONNREFUSED" });
    await active.close();
    expect(activeClose).toHaveBeenCalledTimes(1);
  });
  test("database unavailable keeps identity usable", async () => {
    let now = DASHBOARD_NOW;
    let ready = false;
    let attempts = 0;
    const server = await start({ reader: undefined, now: () => now, retryOpenReader: () => {
      attempts++;
      return ready ? openDashboardReader(server.fixture.file, { instanceId: "fixture-instance", serverBuild: "fixture-build", now: () => now, calibrationMode: () => "auto" }) : undefined;
    } });
    const cookie = await login(server);
    const status = await get(server.port, "/api/status", { Cookie: cookie });
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body)).toMatchObject({ apiVersion: 1, revision: "fixture-instance:unavailable", data: { serverBuild: "fixture-build", collector: "none", latestCounterAt: null, lastIngestAt: null } });
    expect(attempts).toBe(1);
    expect((await get(server.port, "/api/overview", { Cookie: cookie })).status).toBe(503);
    expect(attempts).toBe(1);
    now += 4999;
    ready = true;
    expect((await get(server.port, "/api/overview", { Cookie: cookie })).status).toBe(503);
    expect(attempts).toBe(1);
    now += 1;
    expect((await get(server.port, "/api/overview", { Cookie: cookie })).status).toBe(200);
    expect(attempts).toBe(2);
    const v1 = await start();
    v1.fixture.db.prepare("DELETE FROM ledger_metadata WHERE key='call-selection-revision'").run();
    const v1Cookie = await login(v1);
    expect((await get(v1.port, "/api/status", { Cookie: v1Cookie })).status).toBe(200);
    expect((await get(v1.port, "/api/overview", { Cookie: v1Cookie })).status).toBe(503);
    const unavailable = await start({ reader: undefined, retryOpenReader: () => { throw new DashboardQueryError("unsupported-schema"); } });
    const unavailableCookie = await login(unavailable);
    expect((await get(unavailable.port, "/api/status", { Cookie: unavailableCookie })).status).toBe(200);
    const error = await get(unavailable.port, "/api/overview", { Cookie: unavailableCookie });
    expect(error.status).toBe(503);
    expect(JSON.parse(error.body)).toEqual({ apiVersion: 1, error: { code: "unsupported-schema", message: "Unsupported schema" } });
  });
  test("wire errors are fixed and HEAD is bodyless", async () => {
    const server = await start();
    const cookie = await login(server);
    const data = await get(server.port, "/api/overview", { Cookie: cookie });
    expect(data.status).toBe(200);
    expect(JSON.parse(data.body)).toMatchObject({ apiVersion: 1, revision: expect.stringMatching(/^fixture-instance:[0-9a-f-]{36}:\d+$/),
      generatedAt: DASHBOARD_NOW, period: { start: DASHBOARD_NOW - 7 * 86400000, end: DASHBOARD_NOW }, data: { total: { calls: 0 }, pace: { used: 4 } } });
    const head = await get(server.port, "/api/overview", { Cookie: cookie }, "HEAD");
    expect(head.status).toBe(200); expect(head.body).toBe("");
    expect(Number(head.headers["content-length"])).toBe(Buffer.byteLength(data.body));
    for (const [path, method, status, code, message] of [
      ["/api/status", "POST", 405, "method-not-allowed", "Method not allowed"],
      ["/api/status", "OPTIONS", 405, "method-not-allowed", "Method not allowed"],
      ["/absent", "GET", 404, "not-found", "Not found"],
      ["/api/status?unknown=1", "GET", 400, "invalid-query", "Invalid query"],
      ["/api/overview?start=0", "GET", 400, "invalid-query", "Invalid query"],
      ["/api/overview?start=0&end=0&start=0", "GET", 400, "invalid-query", "Invalid query"],
      ["/api/overview?start=0&end=31622400001", "GET", 400, "invalid-query", "Invalid query"],
      ["/?unknown=1", "GET", 400, "invalid-query", "Invalid query"],
      ["/api/status?x=" + "a".repeat(8192), "GET", 400, "invalid-query", "Invalid query"],
    ] as const) {
      const reply = await get(server.port, path, { Cookie: cookie }, method);
      expect(reply.status, path).toBe(status);
      expect(JSON.parse(reply.body)).toEqual({ apiVersion: 1, error: { code, message } });
    }
    expect((await get(server.port, "/api/status", { Cookie: cookie }, "PUT")).headers.allow).toBe("GET, HEAD");
    const badHead = await get(server.port, "/absent", { Cookie: cookie }, "HEAD");
    expect(badHead.status).toBe(404); expect(badHead.body).toBe("");
    const replayCookie = cookie + "; " + cookie;
    expect((await get(server.port, "/", { Cookie: replayCookie })).status).toBe(401);
    expect((await get(server.port, "/", { Cookie: cookie + "extra" })).status).toBe(401);
    const failureCases: readonly [ApiErrorCode, number, string][] = [["ledger-changed", 409, "Ledger changed"],
      ["ledger-unavailable", 503, "Ledger unavailable"], ["unsupported-schema", 503, "Unsupported schema"], ["busy", 503, "Busy"], ["internal", 500, "Internal error"]];
    for (const [code, status, message] of failureCases) {
      const reader = server.options.reader!;
      const spy = vi.spyOn(reader, "snapshot").mockImplementationOnce(() => { throw new DashboardQueryError(code); });
      const reply = await get(server.port, "/api/overview", { Cookie: cookie });
      expect(reply.status).toBe(status);
      expect(JSON.parse(reply.body)).toEqual({ apiVersion: 1, error: { code, message } });
      spy.mockRestore();
    }
    const spy = vi.spyOn(server.options.reader!, "snapshot").mockImplementationOnce(() => { throw new Error("synthetic-private-path and private-token"); });
    const internal = await get(server.port, "/api/overview", { Cookie: cookie });
    expect(internal.status).toBe(500);
    expect(JSON.parse(internal.body)).toEqual({ apiVersion: 1, error: { code: "internal", message: "Internal error" } });
    spy.mockRestore();
    const releaseServer = await start({ routes: [{ path: "/api/released", handle: ctx => ({ toJSON() {
      if (ctx.db.raw.inTransaction) throw new Error("serialization held the snapshot");
      return { released: true };
    } }) }] });
    expect(JSON.parse((await get(releaseServer.port, "/api/released", { Cookie: await login(releaseServer) })).body).data).toEqual({ released: true });
  });
  test("authenticated admission is bounded", async () => {
    let now = DASHBOARD_NOW;
    const server = await start({ now: () => now, routes: [...OVERVIEW_ROUTES,
      { path: "/api/large", handle: () => ({ text: "x".repeat(1024 * 1024) }) },
      { path: "/api/small", handle: () => ({ text: "x".repeat(100) }) }] });
    const cookie = await login(server);
    for (let count = 1; count <= 600; count++) expect((await get(server.port, "/", { Cookie: cookie })).status, String(count)).toBe(200);
    const limited = await get(server.port, "/api/status", { Cookie: cookie });
    expect(limited.status).toBe(429);
    expect(JSON.parse(limited.body)).toEqual({ apiVersion: 1, error: { code: "rate-limited", message: "Rate limited" } });
    const otherCookie = await login(server);
    expect((await get(server.port, "/api/small", { Cookie: otherCookie })).status).toBe(429);
    now += 59_999;
    expect((await get(server.port, "/", { Cookie: cookie })).status).toBe(429);
    now += 1;
    expect((await get(server.port, "/", { Cookie: cookie })).status).toBe(200);
    const large = await get(server.port, "/api/large", { Cookie: cookie });
    expect(large.status).toBe(413);
    expect(JSON.parse(large.body)).toEqual({ apiVersion: 1, error: { code: "response-limit", message: "Response limit" } });
    expect(Buffer.byteLength(large.body)).toBeLessThan(1024);
    await expect(start({ dashboardDir: createFixtureDashboard("x".repeat(512 * 1024 + 1)) })).rejects.toMatchObject({ code: "usage-dashboard-invalid" });
    const largeStatus = await start({ routes: [{ path: "/api/status", handle: () => ({ text: "x".repeat(8192) }) }] });
    const statusCookie = await login(largeStatus);
    expect((await get(largeStatus.port, "/api/status", { Cookie: statusCookie })).status).toBe(413);
  });
  test("binds only authenticated IPv4 loopback", async () => {
    const server = await start();
    expect(server.port).toBeGreaterThan(0);
    expect(server.pid).toBe(process.pid);
    for (const path of ["/", "/api/status", "/api/overview", "/absent"]) {
      const reply = await get(server.port, path);
      expect(reply.status).toBe(401);
      expect(JSON.parse(reply.body)).toEqual({ apiVersion: 1, error: { code: "unauthorized", message: "Unauthorized" } });
      expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
      expect(reply.headers["cache-control"]).toBe("no-store");
    }
    await expect(get(server.port, "/", { Authorization: "Bearer incorrect" })).resolves.toMatchObject({ status: 401 });
    await new Promise<void>(resolve => {
      const req = request({ host: "::1", port: server.port, agent: false }, () => { req.destroy(); throw new Error("IPv6 listener exposed"); });
      req.on("error", error => { expect((error as NodeJS.ErrnoException).code).toBe("ECONNREFUSED"); resolve(); }); req.end();
    });
  });
});
