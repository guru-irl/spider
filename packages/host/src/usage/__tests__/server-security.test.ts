import { createFixtureDashboard, cleanupFixtureDashboards } from "./fixtures/dashboard-assets.js";
import { request } from "node:http";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
afterEach(cleanupFixtureDashboards);
import { startUsageHttpServer } from "../server.js";
import type { HttpOptions } from "../dashboard-contract.js";
import { openDashboardReader } from "../dashboard-reader.js";
import { OVERVIEW_ROUTES } from "../query-overview.js";
import { createDashboardFixture, DASHBOARD_NOW } from "./fixtures/dashboard-ledger.js";

type Reply = { status: number; headers: import("node:http").IncomingHttpHeaders; body: string };
const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
async function start(overrides: Partial<HttpOptions> = {}) {
  const fixture = createDashboardFixture();
  closers.push(() => fixture.close());
  const secret = randomBytes(32).toString("hex");
  const options: HttpOptions = { instanceId: "fixture-security", serverBuild: "fixture-build", secret,
    reader: openDashboardReader(fixture.file, { instanceId: "fixture-security", serverBuild: "fixture-build", now: () => DASHBOARD_NOW, calibrationMode: () => "auto" }),
    routes: OVERVIEW_ROUTES, dashboardDir: createFixtureDashboard(),
    now: () => DASHBOARD_NOW, ...overrides };
  const server = await startUsageHttpServer(options);
  closers.push(() => server.close());
  return { ...server, options, secret };
}
function get(port: number, path: string, headers: Record<string, string | undefined> = {}, method = "GET"): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers, method, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on("aborted", () => reject(new Error("incomplete HTTP response"))); res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject); req.end();
  });
}
function raw(port: number, target: string, headerLines: readonly string[]): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.end(`GET ${target} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\nConnection: close\r\n\r\n`));
    let text = "";
    socket.on("data", chunk => { text += chunk.toString(); });
    socket.on("error", reject);
    socket.on("end", () => resolve({ status: Number(text.split(" ")[1]), body: text.split("\r\n\r\n").slice(1).join("\r\n\r\n"), headers: {} }));
  });
}
async function mint(server: { port: number; secret: string }): Promise<string> {
  const reply = await get(server.port, "/local/bootstrap-nonce", { Authorization: `Bearer ${server.secret}` });
  expect(reply.status).toBe(200);
  return JSON.parse(reply.body).data.nonce;
}
async function login(server: { port: number; secret: string }): Promise<string> {
  const nonce = await mint(server);
  const boot = await get(server.port, `/bootstrap?nonce=${nonce}`);
  expect(boot.status).toBe(303);
  return boot.headers["set-cookie"]![0]!.split(";")[0]!;
}

describe("usage HTTP security", () => {
  test("CSP allows external local assets only", async () => {
    const server = await start();
    const reply = await get(server.port, "/", { Cookie: await login(server) });
    const csp = reply.headers["content-security-policy"]!;
    expect(csp).toContain("script-src 'self'"); expect(csp).toContain("style-src 'self'");
    expect(csp).not.toMatch(/sha256|unsafe-inline|fonts.googleapis.com/);
  });
  test("credential routes reject ambiguous headers and probes", async () => {
    const server = await start();
    const nonce = await mint(server);
    const probe = await get(server.port, `/bootstrap?nonce=${nonce}`, {}, "HEAD");
    expect(probe.status).toBe(405); expect(probe.body).toBe(""); expect(probe.headers["set-cookie"]).toBeUndefined();
    expect(probe.headers.allow).toBe("GET");
    expect((await get(server.port, `/bootstrap?nonce=${nonce}`)).status).toBe(303);
    expect((await get(server.port, "/local/bootstrap-nonce", { Authorization: `Bearer ${server.secret}` }, "HEAD")).status).toBe(405);
    const duplicate = await raw(server.port, "/local/bootstrap-nonce", [`Host: 127.0.0.1:${server.port}`,
      `Authorization: Bearer ${server.secret}`, `Authorization: Bearer ${server.secret}`]);
    expect(duplicate.status).toBe(401);
    expect(JSON.parse(duplicate.body)).toEqual({ apiVersion: 1, error: { code: "unauthorized", message: "Unauthorized" } });
    expect((await get(server.port, "/local/bootstrap-nonce?extra=x", { Authorization: `Bearer ${server.secret}` })).status).toBe(400);
    expect((await get(server.port, "/bootstrap?nonce=" + "x".repeat(8192))).status).toBe(400);
    const malformed = await raw(server.port, "/", [`Host: 127.0.0.1:${server.port}`, "invalid header"]);
    expect(malformed.status).toBe(400);
    expect(JSON.parse(malformed.body)).toEqual({ apiVersion: 1, error: { code: "invalid-query", message: "Invalid query" } });
    expect(malformed.body).not.toContain("invalid header");
  });
  test("responses enforce external CSP and secret-free headers", async () => {
    const server = await start();
    const cookie = await login(server);
    for (const [path, headers] of [["/", { Cookie: cookie }], ["/api/status", { Cookie: cookie }],
      ["/api/status", {}], ["/absent", { Cookie: cookie }], ["/local/bootstrap-nonce", { Authorization: `Bearer ${server.secret}` }]] as const) {
      const reply = await get(server.port, path, headers);
      const csp = reply.headers["content-security-policy"]!;
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("style-src 'self'");
      for (const directive of ["default-src 'none'", "connect-src 'self'", "img-src 'self'", "font-src https://fonts.gstatic.com",
        "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'", "frame-ancestors 'none'", "style-src-attr 'none'"]) expect(csp).toContain(directive);
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
      expect(reply.headers["referrer-policy"]).toBe("no-referrer");
      expect(reply.headers["x-content-type-options"]).toBe("nosniff");
      expect(reply.headers["cache-control"]).toBe("no-store");
      expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
      expect(JSON.stringify(reply.headers)).not.toContain(server.secret);
      expect(reply.body).not.toContain(server.secret);
    }
  });
  test("API accepts only same-origin fetch metadata", async () => {
    const server = await start();
    const cookie = await login(server);
    const reads = vi.spyOn(server.options.reader!, "snapshot");
    for (const origin of ["null", "https://attacker.invalid", `http://localhost:${server.port}`, "http://127.0.0.1",
      `http://127.0.0.1:${server.port}/`, `http://127.0.0.1:${server.port + 1}`, `HTTP://127.0.0.1:${server.port}`, ""]) {
      for (const path of ["/", "/api/status"]) expect((await get(server.port, path, { Cookie: cookie, Origin: origin })).status, origin).toBe(403);
    }
    for (const site of ["none", "same-site", "cross-site", "unknown", "", "Same-Origin"]) {
      expect((await get(server.port, "/api/status", { Cookie: cookie, "Sec-Fetch-Site": site })).status, site).toBe(403);
    }
    for (const site of ["same-site", "cross-site", "unknown"]) {
      expect((await get(server.port, "/", { Cookie: cookie, "Sec-Fetch-Site": site })).status).toBe(403);
    }
    expect(reads).not.toHaveBeenCalled();
    for (const headers of [{}, { "Sec-Fetch-Site": "same-origin" }, { Origin: `http://127.0.0.1:${server.port}`, "Sec-Fetch-Site": "same-origin" }]) {
      expect((await get(server.port, "/api/status", { Cookie: cookie, ...headers })).status).toBe(200);
    }
    expect((await get(server.port, "/", { Cookie: cookie, "Sec-Fetch-Site": "none" })).status).toBe(200);
    const nonce = await mint(server);
    expect((await get(server.port, `/bootstrap?nonce=${nonce}`, { Origin: "null" })).status).toBe(403);
    expect((await get(server.port, `/bootstrap?nonce=${nonce}`, { "Sec-Fetch-Site": "none" })).status).toBe(303);
    expect((await get(server.port, "/absent", { Cookie: cookie, "Sec-Fetch-Site": "none" })).status).toBe(403);
    for (const lines of [["Origin: null", `Origin: http://127.0.0.1:${server.port}`],
      ["Sec-Fetch-Site: same-origin", "Sec-Fetch-Site: same-origin"]]) {
      expect((await raw(server.port, "/api/status", [`Host: 127.0.0.1:${server.port}`, `Cookie: ${cookie}`, ...lines])).status).toBe(403);
    }
  });
  test("Host rebinding fails before reader access", async () => {
    const server = await start();
    const cookie = await login(server);
    const reads = [vi.spyOn(server.options.reader!, "snapshot"), vi.spyOn(server.options.reader!, "status"), vi.spyOn(server.options.reader!, "revision")];
    for (const host of ["attacker.invalid", "attacker.invalid:" + server.port, "localhost:" + server.port, "LOCALHOST:" + server.port,
      "LocalHost:" + server.port, "127.0.0.1", `127.0.0.1:${server.port + 1}`, `127.0.0.1.:${server.port}`,
      `127.0.0.1:0${server.port}`, `127.0.0.1:+${server.port}`, `[::1]:${server.port}`, `127.1:${server.port}`,
      `2130706433:${server.port}`, `127.0.0.1:${server.port}, attacker.invalid`, `user@127.0.0.1:${server.port}`]) {
      const reply = await get(server.port, "/api/overview", { Host: host, Cookie: cookie });
      expect(reply.status, host).toBe(403);
      expect(JSON.parse(reply.body)).toEqual({ apiVersion: 1, error: { code: "forbidden", message: "Forbidden" } });
    }
    for (const lines of [[], ["Host:"], [`Host: 127.0.0.1:${server.port}`, `Host: 127.0.0.1:${server.port}`],
      [`Host: 127.0.0.1:${server.port}`, "hOsT: attacker.invalid"]]) {
      expect([400, 403]).toContain((await raw(server.port, "/api/overview", [...lines, `Cookie: ${cookie}`])).status);
    }
    for (const header of ["Forwarded", "X-Forwarded-Host", "X-Forwarded-For", "X-Forwarded-Proto", "X-Forwarded-Port", "X-Forwarded-Prefix", "X-Real-IP"]) {
      expect((await get(server.port, "/api/overview", { Cookie: cookie, [header]: "" })).status).toBe(403);
    }
    for (const target of [`http://127.0.0.1:${server.port}/api/overview`, `HTTP://127.0.0.1:${server.port}/api/overview`,
      "https://attacker.invalid/api/overview", "//attacker.invalid/api/overview", "/\\attacker.invalid/api/overview", "/api/overview#fragment"]) {
      expect((await get(server.port, target, { Cookie: cookie })).status, target).toBe(400);
    }
    for (const read of reads) expect(read).not.toHaveBeenCalled();
    expect((await get(server.port, "/", { Cookie: cookie })).status).toBe(200);
  });
  test("bootstrap nonce is single use and short lived", async () => {
    let now = DASHBOARD_NOW;
    const server = await start({ now: () => now });
    const nonce = await mint(server);
    now += 59_999;
    const boot = await get(server.port, `/bootstrap?nonce=${nonce}`);
    expect(boot.status).toBe(303);
    expect(boot.headers.location).toBe("/");
    expect(boot.body).toBe("");
    const cookie = boot.headers["set-cookie"]![0]!;
    expect(cookie).toMatch(new RegExp(`^spider_usage_${server.port}=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=/$`));
    expect(cookie).not.toContain(nonce);
    expect(cookie).not.toContain(server.secret);
    expect(cookie).not.toMatch(/Domain|Max-Age|Expires|Secure/i);
    const credential = cookie.split(";")[0]!;
    expect((await get(server.port, "/", { Cookie: credential })).status).toBe(200);
    expect((await get(server.port, `/bootstrap?nonce=${nonce}`)).status).toBe(401);
    const expired = await mint(server);
    now += 60_000;
    expect((await get(server.port, `/bootstrap?nonce=${expired}`)).status).toBe(401);
    const simultaneous = await mint(server);
    const race = await Promise.all([get(server.port, `/bootstrap?nonce=${simultaneous}`), get(server.port, `/bootstrap?nonce=${simultaneous}`)]);
    expect(race.map(reply => reply.status).sort()).toEqual([303, 401]);
    for (const path of ["/bootstrap", "/bootstrap?nonce=", "/bootstrap?nonce=wrong", "/bootstrap?nonce=wrong&nonce=wrong", "/bootstrap?nonce=wrong&extra=x"]) {
      const reply = await get(server.port, path);
      expect(reply.status).toBe(path.includes("nonce=wrong") && !path.includes("&") ? 401 : 400);
      expect(reply.body).not.toContain(server.secret);
    }
    const restarted = await start({ instanceId: "fixture-restart", now: () => now });
    expect((await get(restarted.port, "/", { Cookie: credential })).status).toBe(401);
    const oldValueOnNewPort = `spider_usage_${restarted.port}=${credential.split("=")[1]}`;
    expect((await get(restarted.port, "/", { Cookie: oldValueOnNewPort })).status).toBe(401);
    expect((await get(restarted.port, `/bootstrap?nonce=${await mint(server)}`)).status).toBe(401);
    expect((await get(restarted.port, "/local/bootstrap-nonce", { Authorization: `Bearer ${server.secret}` })).status).toBe(401);
    const nextCookie = await login(server);
    expect(nextCookie).not.toBe(credential);
    expect((await get(server.port, "/local/bootstrap-nonce", { Cookie: credential, Authorization: `Bearer ${server.secret}` })).status).toBe(403);
  });
  test("local nonce mint requires lock secret", async () => {
    const server = await start();
    for (const headers of [{}, { Authorization: "Bearer wrong" }, { Authorization: `Basic ${server.secret}` },
      { Authorization: `Bearer ${server.secret}extra` }]) {
      const reply = await get(server.port, "/local/bootstrap-nonce", headers);
      expect(reply.status).toBe(401);
      expect(reply.body).not.toContain(server.secret);
    }
    for (const browser of [{ Cookie: "unrelated=fixture" }, { Cookie: "" }, { Origin: `http://127.0.0.1:${server.port}` },
      { Origin: "null" }, { "Sec-Fetch-Site": "same-origin" }, { "Sec-Fetch-Mode": "navigate" }, { "Sec-Fetch-Dest": "empty" }]) {
      const reply = await get(server.port, "/local/bootstrap-nonce", { Authorization: `Bearer ${server.secret}`, ...browser });
      expect(reply.status).toBe(403);
      expect(reply.body).not.toContain(server.secret);
    }
    const reply = await get(server.port, "/local/bootstrap-nonce", { Authorization: `Bearer ${server.secret}` });
    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.body);
    expect(body.apiVersion).toBe(1);
    expect(body.data.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.data.nonce).not.toBe(server.secret);
    expect(Buffer.byteLength(reply.body)).toBeLessThan(8192);
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.headers["set-cookie"]).toBeUndefined();
    expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
    expect(reply.body).not.toContain(server.secret);
    expect(await mint(server)).not.toBe(body.data.nonce);
    expect((await get(server.port, "/api/status", { Authorization: `Bearer ${server.secret}` })).status).toBe(401);
  });
});
