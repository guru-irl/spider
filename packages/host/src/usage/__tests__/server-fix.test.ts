import { createFixtureDashboard, cleanupFixtureDashboards } from "./fixtures/dashboard-assets.js";
import { request, Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
afterEach(cleanupFixtureDashboards);
import * as security from "../server-security.js";
import { startUsageHttpServer } from "../server.js";
import type { HttpOptions } from "../dashboard-contract.js";
import { openDashboardReader } from "../dashboard-reader.js";
import { OVERVIEW_ROUTES } from "../query-overview.js";
import { createDashboardFixture, DASHBOARD_NOW } from "./fixtures/dashboard-ledger.js";

const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const close of closers.splice(0).reverse()) await close(); });
async function start(overrides: Partial<HttpOptions> = {}) {
  const fixture = createDashboardFixture(); closers.push(() => fixture.close());
  const secret = randomBytes(32).toString("base64url");
  const options: HttpOptions = { instanceId: "security-fix", serverBuild: "fixture", secret,
    reader: openDashboardReader(fixture.file, { instanceId: "security-fix", serverBuild: "fixture", now: () => DASHBOARD_NOW, calibrationMode: () => "auto" }),
    routes: OVERVIEW_ROUTES, dashboardDir: createFixtureDashboard(), now: () => DASHBOARD_NOW, ...overrides };
  const server = await startUsageHttpServer(options); closers.push(() => server.close());
  return { ...server, secret, options };
}
type Reply = { status: number; headers: import("node:http").IncomingHttpHeaders; body: string };
function get(port: number, path: string, headers: Record<string, string> = {}, method = "GET", body?: Buffer): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers, method, agent: false }, res => {
      const chunks: Buffer[] = []; res.on("aborted", () => reject(new Error("incomplete HTTP response"))); res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }); req.on("error", reject); req.end(body);
  });
}
function raw(port: number, text: string, deadlineMs = 2000, drip?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const socket = connect(port, "127.0.0.1", () => socket.write(text));
    closers.push(() => { socket.destroy(); });
    let index = 0;
    const interval = drip ? setInterval(() => { if (socket.writable) socket.write(drip[index++ % drip.length]!); }, 200) : undefined;
    const deadline = setTimeout(() => { socket.destroy(); reject(new Error("socket deadline exceeded")); }, deadlineMs);
    socket.on("data", c => { out += c; }); socket.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error); });
    socket.on("close", () => { clearTimeout(deadline); clearInterval(interval); resolve(out); });
  });
}
async function mint(s: { port: number; secret: string }) {
  const r = await get(s.port, "/local/bootstrap-nonce", { Authorization: `Bearer ${s.secret}` }); expect(r.status).toBe(200);
  return JSON.parse(r.body).data.nonce as string;
}
async function login(s: { port: number; secret: string }) {
  const r = await get(s.port, `/bootstrap?nonce=${await mint(s)}`); expect(r.status).toBe(303);
  return r.headers["set-cookie"]![0]!.split(";")[0]!;
}
const fixed = (code: string, message: string) => ({ apiVersion: 1, error: { code, message } });

// Kills normalization-before-validation and routing/security reparsing different targets.
test("rejects all noncanonical targets on the live listener", async () => {
  const s = await start(); const cookie = await login(s); const reads = vi.spyOn(s.options.reader!, "snapshot");
  const variants = ["/local/./bootstrap-nonce", "/local/%2e/bootstrap-nonce", "/x/../local/bootstrap-nonce",
    "/local/bootstrap-nonce/.", "/local//../local/bootstrap-nonce", "/local/%2E%2E/local/bootstrap-nonce",
    "/local//bootstrap-nonce", "/local\\bootstrap-nonce", "/api/overview#fragment", "//attacker.invalid/api/overview", "*", "api/status"];
  for (const dot of [".", "%2e", "%2E"]) {
    variants.push(`/local/${dot}/bootstrap-nonce`);
    for (const next of [".", "%2e", "%2E"]) variants.push(`/x/${dot}${next}/local/bootstrap-nonce`);
  }
  for (const encoding of ["%2f", "%2F", "%5c", "%5C", "%00", "%01", "%09", "%0a", "%0A", "%0d", "%0D", "%1f", "%1F", "%7f", "%7F", "%", "%zz"]) {
    variants.push(`/local/${encoding}bootstrap-nonce`);
  }
  variants.push(`http://127.0.0.1:${s.port}/local/bootstrap-nonce`, `HTTP://127.0.0.1:${s.port}/api/overview`, "https://attacker.invalid/api/overview");
  for (const path of variants) {
    const r = await get(s.port, path, { Authorization: `Bearer ${s.secret}` });
    expect([400, 404], path).toContain(r.status); expect(JSON.parse(r.body), path).toEqual(fixed("invalid-query", "Invalid query"));
    expect(r.headers["set-cookie"]).toBeUndefined(); expect(r.body).not.toContain("nonce");
  }
  for (const byte of ["\0", "\x01", "\x1f", "\x7f"]) {
    const r = await raw(s.port, `GET /local/${byte}bootstrap-nonce HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nConnection: close\r\n\r\n`);
    expect(r).toContain("400 Bad Request"); expect(r).toContain('"code":"invalid-query"');
  }
  expect(reads).not.toHaveBeenCalled();
  expect((await get(s.port, "/local/bootstrap-nonce")).status).toBe(401);
});

test("routing and metadata use the one validated path even if raw url changes afterwards", async () => {
  const s = await start(); const cookie = await login(s);
  // A hostile downstream mutation cannot make routing reread IncomingMessage.url.
  const original = (security as unknown as { validateTransport?: (req: import("node:http").IncomingMessage, port: number, path: string) => boolean }).validateTransport;
  expect(original).toBeTypeOf("function");
  vi.spyOn(security, "validateTransport" as keyof typeof security).mockImplementation(((req: import("node:http").IncomingMessage, port: number, path: string) => {
    req.url = "/"; const ok = original!(req, port, path); req.url = "/local/bootstrap-nonce"; return ok;
  }) as never);
  const reply = await get(s.port, "/api/context", { Cookie: cookie });
  expect(reply.status).toBe(200); expect(JSON.parse(reply.body).data).not.toHaveProperty("nonce");
  expect((await get(s.port, "/api/context", { Cookie: cookie, "Sec-Fetch-Site": "none" })).status).toBe(403);
});

test("binding reports actual IPv4 loopback and refuses a nonloopback connection", async () => {
  const address = vi.spyOn(Server.prototype, "address"); const s = await start();
  expect(address.mock.results.some(result => result.type === "return" && (result.value as AddressInfo)?.port === s.port &&
    (result.value as AddressInfo).address === "127.0.0.1" && (result.value as AddressInfo).family === "IPv4")).toBe(true);
  const external = Object.values(networkInterfaces()).flat().find(info => info?.family === "IPv4" && !info.internal);
  if (!external) { console.info("Non-loopback binding probe skipped: this machine has no non-loopback IPv4 interface."); return; }
  await new Promise<void>((resolve, reject) => {
    const socket = connect(s.port, external.address, () => { socket.destroy(); reject(new Error("non-loopback listener exposed")); });
    closers.push(() => { socket.destroy(); }); socket.setTimeout(500, () => { console.info("Non-loopback connection attempt timed out without connecting; actual bound address was independently checked."); socket.destroy(); resolve(); });
    socket.on("error", error => { expect((error as NodeJS.ErrnoException).code).toBe("ECONNREFUSED"); resolve(); });
  });
});

test("application rejects missing HTTP 1.0 Host before authentication", async () => {
  const s = await start(); const reads = vi.spyOn(s.options.reader!, "snapshot");
  const r = await raw(s.port, "GET /api/status HTTP/1.0\r\n\r\n");
  expect(r).toContain("403 Forbidden"); expect(JSON.parse(r.split("\r\n\r\n")[1]!)).toEqual(fixed("forbidden", "Forbidden"));
  expect(reads).not.toHaveBeenCalled();
});

test("instances reject each other's nonce and session under the same clock and instance label", async () => {
  const now = () => DASHBOARD_NOW; const a = await start({ now }); const b = await start({ now });
  const nonce = await mint(a); expect((await get(b.port, `/bootstrap?nonce=${nonce}`)).status).toBe(401);
  const cookie = await login(a); const renamed = `spider_usage_${b.port}=${cookie.split("=")[1]}`;
  expect((await get(b.port, "/api/overview", { Cookie: renamed })).status).toBe(401);
  expect((await get(a.port, `/bootstrap?nonce=${nonce}`)).status).toBe(303);
});

// Observe actual allocation/retention, not a mock store. Insert-time sweeping alone hides timer leaks from HTTP.
function observeCredentialStores() {
  const stores = new Set<Map<unknown, { value: string }>>(); const original = Map.prototype.set;
  vi.spyOn(Map.prototype, "set").mockImplementation(function (this: Map<unknown, { value: string }>, key: unknown, value: { value: string }) {
    if (value && typeof value.value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value.value)) stores.add(this);
    return original.call(this, key, value);
  });
  return stores;
}
test("nonce floods retain at most 64 live records and insert sweeps expired ones", async () => {
  let now = DASHBOARD_NOW; const stores = observeCredentialStores(); const s = await start({ now: () => now });
  const live = []; for (let i = 0; i < 64; i++) live.push(await mint(s));
  for (let i = 0; i < 150; i++) expect((await get(s.port, "/local/bootstrap-nonce", { Authorization: `Bearer ${s.secret}` })).status).toBe(429);
  expect([...stores].map(store => store.size)).toEqual([64]);
  expect((await get(s.port, `/bootstrap?nonce=${live[0]}`)).status).toBe(303);
  await mint(s); now += 60_000; await mint(s);
  expect(Math.max(...[...stores].map(store => store.size))).toBe(1);
});

// Rejecting at the cap locks out the owner; removing the cap leaks retained sessions.
test("40 launches never lock out the owner and retain at most 32 sessions", async () => {
  let now = DASHBOARD_NOW; const stores = observeCredentialStores(); const s = await start({ now: () => now, idleMs: 120_000 });
  const cookies: string[] = [];
  for (let i = 0; i < 40; i++) {
    now += 1; const cookie = await login(s); cookies.push(cookie);
    expect((await get(s.port, "/api/status", { Cookie: cookie })).status).toBe(200);
    expect(Math.max(...[...stores].map(store => store.size))).toBeLessThanOrEqual(32);
  }
  for (const cookie of cookies.slice(0, 8)) expect((await get(s.port, "/api/status", { Cookie: cookie })).status).toBe(401);
  for (const cookie of cookies.slice(8)) expect((await get(s.port, "/api/status", { Cookie: cookie })).status).toBe(200);
  expect([...stores].map(store => store.size).sort((a, b) => a - b)).toEqual([0, 32]);
  now += 119_999; expect((await get(s.port, "/api/status", { Cookie: cookies[8]! })).status).toBe(200);
  now += 1; expect((await get(s.port, "/api/status", { Cookie: cookies[9]! })).status).toBe(401);
  expect(await login(s)).toMatch(/^spider_usage_/);
});

test("timer sweeps expired nonces and idle sessions without any further request", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  let now = DASHBOARD_NOW; const stores = observeCredentialStores(); const s = await start({ now: () => now, idleMs: 120_000 });
  await login(s); await mint(s); expect([...stores].map(store => store.size).sort()).toEqual([1, 1]);
  now += 60_000; await vi.advanceTimersByTimeAsync(60_000);
  expect([...stores].map(store => store.size).sort()).toEqual([0, 1]);
  // A new successful bootstrap keeps the server alive while the first session expires.
  await login(s); now += 60_000; await vi.advanceTimersByTimeAsync(60_000);
  expect([...stores].map(store => store.size).sort()).toEqual([0, 1]);
});

test("every data route requires a session before method, query or existence disclosure", async () => {
  const paths = ["/api/status", "/api/overview", "/api/context", "/api/source-errors", "/api/explorer", "/api/filter-values",
    "/api/detail", "/api/detail-links", "/api/cache", "/api/reconciliation", "/api/rates", "/api/unknown", "/", "/unknown"];
  const s = await start({ routes: paths.filter(path => path.startsWith("/api/")).map(path => ({ path, handle: () => ({ protected: true }) })) });
  const reads = vi.spyOn(s.options.reader!, "snapshot");
  for (const path of paths) for (const [suffix, method] of [["", "GET"], ["?bad=1&bad=1", "GET"], ["", "POST"], ["", "OPTIONS"], ["", "TRACE"], ["", "DELETE"]]) {
    const r = await get(s.port, path + suffix, {}, method); expect(r.status, method + path).toBe(401); expect(JSON.parse(r.body)).toEqual(fixed("unauthorized", "Unauthorized"));
  }
  expect(reads).not.toHaveBeenCalled();
  const cookie = await login(s); expect((await get(s.port, "/api/rates", { Cookie: cookie })).status).toBe(200);
});

test("unauthenticated flood has a separate 120 per minute server-wide budget", async () => {
  let now = DASHBOARD_NOW; const s = await start({ now: () => now }); const cookie = await login(s);
  // Valid bootstrap may consume one unauthenticated admission, so start a clean minute.
  now += 60_000;
  for (let i = 0; i < 120; i++) expect((await get(s.port, i % 2 ? "/api/status" : "/unknown")).status).toBe(401);
  for (let i = 0; i < 580; i++) expect((await get(s.port, "/api/status")).status).toBe(429);
  expect((await get(s.port, "/api/status", { Cookie: cookie })).status).toBe(200);
  now += 59_999; expect((await get(s.port, "/")).status).toBe(429);
  now += 1; expect((await get(s.port, "/")).status).toBe(401);
});

test("nonce races, invalid credentials and response lengths stay safe", async () => {
  const s = await start(); const m = await get(s.port, "/local/bootstrap-nonce", { Authorization: `Bearer ${s.secret}` });
  expect(Number(m.headers["content-length"])).toBe(Buffer.byteLength(m.body));
  const nonce = JSON.parse(m.body).data.nonce;
  // Under the concurrent socket ceiling, every admitted racer must see atomic single-use consumption.
  const race = await Promise.all(Array.from({ length: 24 }, () => get(s.port, `/bootstrap?nonce=${nonce}`)));
  expect(race.filter(r => r.status === 303)).toHaveLength(1); expect(race.filter(r => r.status === 401)).toHaveLength(23);
  const boot = race.find(r => r.status === 303)!; expect(boot.headers["content-length"]).toBe("0"); expect(boot.body).toBe("");
  for (const auth of [`bearer ${s.secret}`, "Bearer " + "x".repeat(10000), `Bearer ${s.secret.slice(0, -1)}\xe9`])
    expect((await get(s.port, "/local/bootstrap-nonce", { Authorization: auth })).status).toBe(401);
  expect((await get(s.port, "/local/bootstrap-nonce", { Authorization: `Bearer ${s.secret}`, "Sec-Fetch-User": "?1" })).status).toBe(403);
});

test("XFO, CORP, COOP and identical duplicate Origins are enforced", async () => {
  const s = await start(); const cookie = await login(s);
  for (const [path, headers] of [["/", { Cookie: cookie }], ["/api/overview", { Cookie: cookie }], ["/api/status", {}], ["/absent", { Cookie: cookie }]] as const) {
    const r = await get(s.port, path, headers); expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["cross-origin-resource-policy"]).toBe("same-origin"); expect(r.headers["cross-origin-opener-policy"]).toBe("same-origin");
  }
  const r = await raw(s.port, `GET /api/status HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nCookie: ${cookie}\r\nOrigin: http://127.0.0.1:${s.port}\r\nOrigin: http://127.0.0.1:${s.port}\r\nConnection: close\r\n\r\n`);
  expect(r).toContain("403 Forbidden");
});

test("large URLs, headers and bodies do not bypass fixed errors", async () => {
  const s = await start(); const cookie = await login(s); const h = `Host: 127.0.0.1:${s.port}\r\nConnection: close\r\n`;
  for (const text of [`GET /api/status?x=${"a".repeat(20000)} HTTP/1.1\r\n${h}\r\n`, `GET /api/status HTTP/1.1\r\n${h}X-Big: ${"a".repeat(20000)}\r\n\r\n`]) {
    const r = await raw(s.port, text); expect(r).toContain("400 Bad Request"); expect(r).toContain('"code":"invalid-query"');
  }
  expect((await get(s.port, "/api/status?x=" + "a".repeat(9000), { Cookie: cookie })).status).toBe(400);
  expect((await get(s.port, "/" + "a".repeat(12000), { Cookie: cookie })).status).toBe(404);
  expect((await get(s.port, "/api/status", { Cookie: cookie, "Content-Length": "8388608" }, "POST", Buffer.from("x"))).status).toBe(405);
  // Immediate rejection can race the client's large write. A reset is also bounded refusal, not a read/echo.
  try { expect((await get(s.port, "/api/status", { Cookie: cookie }, "POST", Buffer.alloc(8 * 1024 * 1024))).status).toBe(405); }
  catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ECONNRESET"); }
});

test("HTTP deadlines and keep-alive bounds are configured on the real server", async () => {
  const listen = vi.spyOn(Server.prototype, "listen"); const s = await start();
  const actual = (listen.mock.instances as Server[]).find(instance => (instance.address() as AddressInfo)?.port === s.port)!;
  expect(actual.headersTimeout).toBe(5000); expect(actual.requestTimeout).toBe(10_000);
  expect(actual.keepAliveTimeout).toBe(2000); expect(actual.maxRequestsPerSocket).toBe(100); expect(actual.maxConnections).toBe(32);
});

test("header deadline closes idle sockets silently and trickled headers without 400", async () => {
  const s = await start();
  const idle = await raw(s.port, "", 7500); expect(idle).toBe("");
  const slow = await raw(s.port, "GET / HTTP/1.1\r\nHo", 7500, "s"); expect(slow === "" || slow.startsWith("HTTP/1.1 408")).toBe(true);
}, 20_000);

test("request deadline closes a trickled declared body without waiting a minute", async () => {
  const s = await start(); const cookie = await login(s); const before = Date.now();
  const r = await raw(s.port, `GET /api/status HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nCookie: ${cookie}\r\nContent-Length: 100000000\r\n\r\nabc`, 12_500, "b");
  expect(Date.now() - before).toBeLessThan(12_000); expect(r).not.toContain("400 Bad Request");
}, 15_000);

test("one keep-alive socket cannot serve unbounded requests", async () => {
  const s = await start(); const socket = connect(s.port, "127.0.0.1"); closers.push(() => { socket.destroy(); });
  const counts = await new Promise<number>((resolve, reject) => {
    let got = 0; let pending = ""; const send = () => socket.write(`GET /unknown HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\n\r\n`);
    socket.on("connect", send); const deadline = setTimeout(() => { socket.destroy(); reject(new Error("keep-alive not bounded")); }, 7500);
    socket.on("data", chunk => {
      pending += chunk.toString(); const split = pending.indexOf("\r\n\r\n"); if (split < 0) return;
      const header = pending.slice(0, split); const size = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
      if (pending.length < split + 4 + size) return;
      got++; pending = pending.slice(split + 4 + size);
      if (got === 100) expect(header).toContain("Connection: close");
      // Ignore Connection: close deliberately: Node must stop invoking the app after request 100.
      if (got === 101) { expect(header).toContain("503 Service Unavailable"); clearTimeout(deadline); socket.destroy(); resolve(got - 1); }
      else send();
    }); socket.on("error", error => { clearTimeout(deadline); reject(error); });
    socket.on("close", () => { clearTimeout(deadline); resolve(got); });
  }); expect(counts).toBe(100);
}, 10_000);

test("CSRF methods and non-origin CONNECT fail before authentication", async () => {
  const s = await start(); const reads = vi.spyOn(s.options.reader!, "snapshot");
  for (const method of ["POST", "OPTIONS"]) {
    const r = await get(s.port, "/api/status", { Origin: "https://attacker.invalid", "Content-Type": "text/plain" }, method);
    expect(r.status).toBe(403); expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  }
  expect((await get(s.port, "/bootstrap?nonce=x", { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" })).status).toBe(403);
  const r = await raw(s.port, `CONNECT 127.0.0.1:${s.port} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\n\r\n`);
  expect(r).toContain("400 Bad Request"); expect(r).toContain('"code":"invalid-query"'); expect(reads).not.toHaveBeenCalled();
});

test("body-bearing CSRF rejects once without a second parser response", async () => {
  const s = await start();
  const r = await get(s.port, "/api/status", { Origin: "https://attacker.invalid", "Content-Type": "text/plain" }, "POST", Buffer.from("x"));
  expect(r.status).toBe(403); expect(JSON.parse(r.body)).toEqual(fixed("forbidden", "Forbidden"));
});

test("closing a neighboring instance cannot clear live nonce or session state", async () => {
  const a = await start(); const nonce = await mint(a); const cookie = await login(a);
  const b = await start(); await login(b); await b.close();
  expect((await get(a.port, "/api/status", { Cookie: cookie })).status).toBe(200);
  expect((await get(a.port, `/bootstrap?nonce=${nonce}`)).status).toBe(303);
});

// The review's browser-shaped burst must not spend owner admission.
test("120 cross-site requests cannot block bootstrap or poison unauthenticated admission", async () => {
  let now = DASHBOARD_NOW; const s = await start({ now: () => now }); const cookie = await login(s);
  now += 60_000; const nonce = await mint(s);
  for (let i = 0; i < 120; i++) {
    const r = await get(s.port, "/api/status", { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors" });
    expect(r.status).toBe(403); expect(JSON.parse(r.body)).toEqual(fixed("forbidden", "Forbidden"));
  }
  expect((await get(s.port, "/api/status", { "Sec-Fetch-Site": "cross-site" })).status).toBe(429);
  expect((await get(s.port, `/bootstrap?nonce=${nonce}`, { "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate" })).status).toBe(303);
  for (let i = 0; i < 120; i++) expect((await get(s.port, "/api/status")).status).toBe(401);
  expect((await get(s.port, "/api/status")).status).toBe(429);
  // Cross-site requests with a live cookie cannot spend the authenticated window either.
  now += 60_000;
  for (let i = 0; i < 610; i++) {
    const r = await get(s.port, "/api/status", { Cookie: cookie, Origin: "null" });
    expect(r.status, `cookie-bearing cross-site request ${i + 1}`).toBe(i < 120 ? 403 : 429);
  }
  for (let i = 0; i < 600; i++) expect((await get(s.port, "/api/status", { Cookie: cookie })).status, `authenticated admission ${i + 1}`).toBe(200);
  expect((await get(s.port, "/api/status", { Cookie: cookie })).status).toBe(429);
});

// Unmetered cookie-bearing traffic and a shortened window must both fail this live test.
test("cross-site cookie budget resets only at 60 seconds and never spends owner admission", async () => {
  let now = DASHBOARD_NOW; const s = await start({ now: () => now }); const cookie = await login(s);
  const crossSite = () => get(s.port, "/api/status", { Cookie: cookie, "Sec-Fetch-Site": "cross-site" });
  const owner = async () => expect((await get(s.port, "/api/status", { Cookie: cookie })).status).toBe(200);
  for (let i = 0; i < 120; i++) {
    expect((await crossSite()).status, `cross-site admission ${i + 1}`).toBe(403);
    await owner();
  }
  expect((await crossSite()).status).toBe(429); await owner();
  now = DASHBOARD_NOW + 30_000;
  expect((await crossSite()).status).toBe(429); await owner();
  now = DASHBOARD_NOW + 59_999;
  expect((await crossSite()).status).toBe(429); await owner();
  now = DASHBOARD_NOW + 60_000;
  for (let i = 0; i < 120; i++) {
    expect((await crossSite()).status, `renewed cross-site admission ${i + 1}`).toBe(403);
    await owner();
  }
  expect((await crossSite()).status).toBe(429); await owner();
});

// Same 180-second simulated flood as the review, not real-time sleeps.
test("five cross-site requests per second never block a valid bootstrap", async () => {
  let now = DASHBOARD_NOW; const s = await start({ now: () => now }); let launches = 0;
  for (let second = 0; second < 180; second++) {
    for (let i = 0; i < 5; i++) {
      const r = await get(s.port, "/api/status", second % 2 ? { Origin: "https://attacker.example" } : { "Sec-Fetch-Site": "cross-site" });
      expect([403, 429]).toContain(r.status);
    }
    if (second % 7 === 3) {
      const r = await get(s.port, `/bootstrap?nonce=${await mint(s)}`, { "Sec-Fetch-Site": "none" });
      expect(r.status, `launch at second ${second}`).toBe(303); launches++;
    }
    now += 1000;
  }
  expect(launches).toBe(26);
}, 20_000);

// Separate cross-site accounting alone is insufficient against a local unauth flood.
test("only live unconsumed instance nonces exempt bootstrap from the unauthenticated limiter", async () => {
  let now = DASHBOARD_NOW; const s = await start({ now: () => now }); const other = await start({ now: () => now });
  const foreign = await mint(other); const expired = await mint(s); now += 60_000;
  const live = await mint(s); const consumed = await mint(s);
  expect((await get(s.port, `/bootstrap?nonce=${consumed}`)).status).toBe(303);
  for (let i = 0; i < 120; i++) expect((await get(s.port, "/api/status")).status).toBe(401);
  for (const nonce of ["wrong", expired, consumed, foreign])
    expect((await get(s.port, `/bootstrap?nonce=${nonce}`)).status).toBe(429);
  // Cross-site presentation must not consume even a valid nonce.
  expect((await get(s.port, `/bootstrap?nonce=${live}`, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  expect((await get(s.port, `/bootstrap?nonce=${live}`)).status).toBe(303);
  expect((await get(s.port, `/bootstrap?nonce=${live}`)).status).toBe(429);
});

// Cookie reuse must never bypass transport checks or consume a rejected request's nonce.
test("bootstrap rejects cross-site and wrong Host with an owner cookie before session reuse", async () => {
  const s = await start(); const cookie = await login(s); const nonce = await mint(s);
  const reads = vi.spyOn(s.options.reader!, "snapshot");
  for (const headers of [{ "Sec-Fetch-Site": "cross-site" }, { Host: "evil.example" }] as Record<string, string>[]) {
    const r = await get(s.port, `/bootstrap?nonce=${nonce}`, { Cookie: cookie, ...headers });
    expect(r.status).toBe(403); expect(JSON.parse(r.body)).toEqual(fixed("forbidden", "Forbidden"));
    expect(r.headers.location).toBeUndefined(); expect(r.headers["set-cookie"]).toBeUndefined();
    expect(reads).not.toHaveBeenCalled();
    expect((await get(s.port, "/api/status", { Cookie: cookie })).status).toBe(200);
    reads.mockClear();
  }
  const reused = await get(s.port, `/bootstrap?nonce=${nonce}`, { Cookie: cookie });
  expect(reused.status).toBe(303); expect(reused.headers.location).toBe("/");
  expect(reused.headers["set-cookie"]).toBeUndefined();
  expect((await get(s.port, `/bootstrap?nonce=${nonce}`, { Cookie: cookie })).status).toBe(401);
  expect((await get(s.port, "/api/status", { Cookie: cookie })).status).toBe(200);
});

// Creating a replacement session here wastes slots and changes the browser's credential.
test("bootstrap reuses a valid session at the cap and consumes its nonce without issuing a cookie", async () => {
  let now = DASHBOARD_NOW; const stores = observeCredentialStores(); const s = await start({ now: () => now });
  const cookie = await login(s);
  for (let i = 1; i < 32; i++) { now++; await login(s); }
  for (let i = 0; i < 40; i++) {
    now++; const nonce = await mint(s);
    const r = await get(s.port, `/bootstrap?nonce=${nonce}`, { Cookie: cookie });
    expect(r.status).toBe(303); expect(r.headers.location).toBe("/"); expect(r.headers["set-cookie"]).toBeUndefined();
    expect(r.headers["content-length"]).toBe("0"); expect(r.body).toBe("");
    expect((await get(s.port, `/bootstrap?nonce=${nonce}`, { Cookie: cookie })).status).toBe(401);
    expect((await get(s.port, "/api/status", { Cookie: cookie })).status).toBe(200);
    expect([...stores].map(store => store.size).sort((a, b) => a - b)).toEqual([0, 32]);
  }
});

// FIFO eviction passes sequential-launch tests but drops an actively used oldest tab.
test("session cap evicts the least recently used tab and reopening recovers it", async () => {
  let now = DASHBOARD_NOW; const s = await start({ now: () => now }); const cookies: string[] = [];
  for (let i = 0; i < 32; i++) { now++; cookies.push(await login(s)); }
  now++; expect((await get(s.port, "/api/status", { Cookie: cookies[0]! })).status).toBe(200);
  now++; const newCookie = await login(s);
  expect((await get(s.port, "/api/status", { Cookie: cookies[0]! })).status).toBe(200);
  expect((await get(s.port, "/api/status", { Cookie: cookies[1]! })).status).toBe(401);
  expect((await get(s.port, "/api/status", { Cookie: newCookie })).status).toBe(200);
  now++; const recovered = await get(s.port, `/bootstrap?nonce=${await mint(s)}`, { Cookie: cookies[1]! });
  expect(recovered.status).toBe(303); const recoveredCookie = recovered.headers["set-cookie"]![0]!.split(";")[0]!;
  expect((await get(s.port, "/api/status", { Cookie: recoveredCookie })).status).toBe(200);
});

// Escaped unreserved bytes must reject, not be decoded into the privileged mint route.
test("percent encodings of every unreserved path character reject in either hex case", async () => {
  let now = DASHBOARD_NOW; const s = await start({ now: () => now }); const cookie = await login(s);
  for (const char of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~") {
    const hex = char.charCodeAt(0).toString(16);
    for (const escape of [`%${hex.toLowerCase()}`, `%${hex.toUpperCase()}`]) {
      const r = await get(s.port, `/opaque${escape}path`, { Cookie: cookie });
      expect(r.status, escape).toBe(400); expect(JSON.parse(r.body)).toEqual(fixed("invalid-query", "Invalid query"));
    }
  }
  for (const path of ["/local/bootstrap-nonc%65", "/%6cocal/bootstrap-nonce", "/%6Cocal/bootstrap-nonce", "/local/bootstrap%2dnonce", "/local/bootstrap%2Dnonce", "/api/overvi%65w", "/opaque%C3%A9%65", "/%20/opaque%C3%A9%7e"]) {
    const r = await get(s.port, path, { Authorization: `Bearer ${s.secret}` });
    expect(r.status, path).toBe(400); expect(JSON.parse(r.body)).toEqual(fixed("invalid-query", "Invalid query"));
    expect(r.body).not.toContain("nonce"); expect(r.headers["set-cookie"]).toBeUndefined();
  }
});

// Reserved/UTF-8 escapes remain opaque: routing on a decoded path is still a bug.
test("canonical escaped reserved and Unicode paths route without decoding", async () => {
  const s = await start({ routes: ["/opaque%20path", "/opaque%C3%A9", "/opaque%252e"].map(path => ({ path, handle: () => ({ opaque: true }) })) });
  const cookie = await login(s);
  for (const path of ["/opaque%20path", "/opaque%C3%A9", "/opaque%252e"]) {
    const r = await get(s.port, path, { Cookie: cookie });
    expect(r.status, path).toBe(200); expect(JSON.parse(r.body).data).toEqual({ opaque: true });
  }
});

// Exempting the mint path instead of the valid bearer leaves wrong-bearer floods unbounded.
test("wrong bearer mint attempts spend the unauthenticated limiter", async () => {
  const s = await start();
  for (let i = 0; i < 120; i++) {
    const r = await get(s.port, "/local/bootstrap-nonce", { Authorization: `Bearer ${"A".repeat(43)}` });
    expect(r.status).toBe(401); expect(JSON.parse(r.body)).toEqual(fixed("unauthorized", "Unauthorized"));
  }
  expect((await get(s.port, "/local/bootstrap-nonce", { Authorization: "Bearer wrong" })).status).toBe(429);
  expect(await mint(s)).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

// A valid bearer does not excuse Host rebinding or forwarded headers on the mint route.
test("mint checks Host and forwarding even with the valid bearer", async () => {
  const s = await start(); const reads = vi.spyOn(s.options.reader!, "snapshot");
  const probes: Record<string, string>[] = [{ Host: "evil.example" }, { Host: `localhost:${s.port}` }, { "X-Forwarded-For": "192.0.2.1" }, { Forwarded: "for=192.0.2.1" }];
  for (const headers of probes) {
    const r = await get(s.port, "/local/bootstrap-nonce", { Authorization: `Bearer ${s.secret}`, ...headers });
    expect(r.status).toBe(403); expect(JSON.parse(r.body)).toEqual(fixed("forbidden", "Forbidden")); expect(r.body).not.toContain("nonce");
  }
  expect(reads).not.toHaveBeenCalled(); expect(await mint(s)).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

// A broad spider_usage_* match mistakes two different port names for duplicate credentials.
test("old port cookies are ignored alongside the current session cookie", async () => {
  const old = await start(); const staleCookie = await login(old); const s = await start(); const cookie = await login(s);
  for (const jar of [`${staleCookie}; ${cookie}`, `${cookie}; ${staleCookie}`])
    expect((await get(s.port, "/api/status", { Cookie: jar })).status).toBe(200);
  expect((await get(s.port, "/api/status", { Cookie: staleCookie })).status).toBe(401);
});
