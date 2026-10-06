import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer as createTcpServer } from "node:net";
import type { Socket } from "node:net";
import { networkInterfaces, userInfo } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { createUnresponsivePipeBrowser } from "./fixtures/dashboard-browser-fixture.js";
import * as implementation from "../../../../../scripts/usage-dashboard-screenshot.mjs";

const checkout = fileURLToPath(new URL("../../../../../", import.meta.url));
const script = join(checkout, "scripts/usage-dashboard-screenshot.mjs");
const scratch = join(checkout, ".spider/scratch/usage-dashboard-tests");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() {
  mkdirSync(scratch, { recursive: true });
  const result = mkdtempSync(join(scratch, "script-test-"));
  roots.push(result);
  return result;
}
function cli(env: NodeJS.ProcessEnv, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: checkout, env: { ...process.env, SPIDER_USAGE_SCREENSHOT_SCRATCH: root(), ...env }, encoding: "utf8", timeout: implementation.BROWSER_TEST_TIMEOUT_MS });
}

// Removing either skip branch would start a browser/Vitest or turn a skip into an error.
test("CI and missing browser skip explicitly", async () => {

  expect(implementation?.screenshotSkipReason).toBeTypeOf("function");
  const dir = root();
  const out = join(dir, "not-created");
  const nonExecutable = join(dir, "non-executable");
  writeFileSync(nonExecutable, "not an executable", { mode: 0o600 });
  for (const [env, expected] of [
    [{ CI: "1", SPIDER_USAGE_BROWSER: process.execPath }, "CI disables local browser acceptance"],
    [{ CI: "", SPIDER_USAGE_BROWSER: "" }, "set SPIDER_USAGE_BROWSER to a local Chromium executable"],
    [{ CI: "", SPIDER_USAGE_BROWSER: join(scratch, "does-not-exist") }, "SPIDER_USAGE_BROWSER is not an executable file"],
    [{ CI: "", SPIDER_USAGE_BROWSER: nonExecutable }, "SPIDER_USAGE_BROWSER is not an executable file"],
    [{ CI: "", SPIDER_USAGE_BROWSER: dir }, "SPIDER_USAGE_BROWSER is not an executable file"],
  ] as const) {
    const reply = cli(env, ["--out", out]);
    expect(reply.status, reply.stderr).toBe(77);
    expect(reply.stdout).toBe(`SKIP: ${expected}\n`);
    expect(reply.stderr).toBe("");
    expect(existsSync(out)).toBe(false);
    expect(implementation!.screenshotSkipReason(env)).toBe(expected);
  }
});

// Losing finally/kill-on-timeout would leave this deliberately unresponsive child alive.
test("capture errors fail and close owned processes", async () => {
  expect(implementation.captureDashboard).toBeTypeOf("function");
  const dir = root();
  const fixture = createUnresponsivePipeBrowser(dir);
  try {
    await expect(implementation.captureDashboard({ html: "<title>Fixture</title>", out: join(dir, "capture"), browser: fixture.executable, scratchDir: dir, timeoutMs: 800, startupTimeoutMs: 800 })).rejects.toThrow();
    const pid = Number(readFileSync(fixture.pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(join(dir, "capture/overview.png"))).toBe(false);
    const reply = cli({ CI: "", SPIDER_USAGE_BROWSER: process.execPath }, ["--out", join(dir, "cli")]);
    expect(reply.status, reply.stdout + reply.stderr).not.toBe(0);
    expect(reply.status).not.toBe(77);
  } finally { fixture.close(); }
});

test("verification failures close the browser and remove its private profile", async context => {
  const reason = implementation.screenshotSkipReason();
  if (reason) { console.log(`SKIP: ${reason}`); context.skip(`SKIP: ${reason}`); return; }
  expect(implementation.captureDashboard).toBeTypeOf("function");
  const dir = root();
  let pid = 0;
  const before = readdirSync(dir).filter(name => name.startsWith("browser-"));
  await expect(implementation.captureDashboard({ html: "<title>Fixture</title>", out: join(dir, "capture"), scratchDir: dir, verify: async (page: { pid: number }) => {
    pid = page.pid;
    throw new Error("fixture-verification-failed");
  } })).rejects.toThrow("fixture-verification-failed");
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
  expect(readdirSync(dir).filter(name => name.startsWith("browser-"))).toEqual(before);
  expect(existsSync(join(dir, "capture/overview.png"))).toBe(false);
}, implementation.BROWSER_TEST_TIMEOUT_MS);

// A hardcoded error, helper/CLI recursion, or swallowed Vitest error fails this gate.
test("CLI runs the installed visual test and propagates its result", async context => {
  const reason = implementation.screenshotSkipReason();
  if (reason) { console.log(`SKIP: ${reason}`); context.skip(`SKIP: ${reason}`); return; }
  const out = join(root(), "cli-capture");
  const reply = cli({ CI: "" }, ["--out", out]);
  expect(reply.status, reply.stdout + reply.stderr).toBe(0);
  expect(reply.stdout).toContain("dashboard-visual.test.ts");
  expect(reply.stdout).toContain("1 passed");
  for (const width of [390, 1272]) {
    const bytes = readFileSync(join(out, String(width), "overview.png"));
    expect(bytes.readUInt32BE(16)).toBe(width);
    expect(bytes.readUInt32BE(20)).toBe(width === 390 ? 3600 : 2000);
  }
  const invalid = cli({ CI: "" }, ["--unknown", out]);
  expect(invalid.status).toBe(1);
  expect(invalid.stderr).toContain("Usage:");
}, implementation.BROWSER_TEST_TIMEOUT_MS);

// Removing these flags or replacing HOME can open macOS keychain dialogs.
// This test starts a Node fixture, never Edge, and inspects the actual spawn boundary.
test("browser launch disables keychain UI and preserves HOME", async () => {
  const dir = root();
  const fixture = createUnresponsivePipeBrowser(dir);
  try {
    await expect(implementation.captureDashboard({ html: "<title>Fixture</title>", out: join(dir, "capture"), browser: fixture.executable, scratchDir: dir, timeoutMs: 800, startupTimeoutMs: 800 })).rejects.toThrow();
    const launch = JSON.parse(readFileSync(fixture.launchFile, "utf8")) as { args: string[]; home: string };
    expect(launch.args).toEqual(expect.arrayContaining([
      "--use-mock-keychain", "--password-store=basic", "--no-first-run",
      "--no-default-browser-check", "--disable-sync", "--disable-features=MediaRouter",
    ]));
    expect(launch.home).toBe(userInfo().homedir);
    const profile = launch.args.find(argument => argument.startsWith("--user-data-dir="))!.split("=")[1]!;
    expect(profile.startsWith(join(dir, "browser-"))).toBe(true);
    expect(existsSync(profile)).toBe(false);
    expect(() => process.kill(Number(readFileSync(fixture.pidFile, "utf8")), 0)).toThrow();
  } finally { fixture.close(); }
});

// An unbounded verify callback would time out the test and strand Chromium.
test("capture deadline closes a stalled verification callback", async context => {
  const reason = implementation.screenshotSkipReason();
  if (reason) { console.log(`SKIP: ${reason}`); context.skip(`SKIP: ${reason}`); return; }
  const dir = root();
  let pid = 0;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  try {
    await expect(implementation.captureDashboard({ html: "<title>Fixture</title>", out: join(dir, "capture"), scratchDir: dir, timeoutMs: 5000, verifyTimeoutMs: 5000, verify: async (page: { pid: number }) => {
      pid = page.pid;
      await new Promise((_, reject) => { fallback = setTimeout(() => reject(new Error("fixture-fallback-deadline")), 8000); });
    } })).rejects.toThrow("capture-timeout");
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(join(dir, "capture/overview.png"))).toBe(false);
  } finally { clearTimeout(fallback); }
}, implementation.BROWSER_TEST_TIMEOUT_MS);

// Dropping Fetch interception must fail even while the proxy/resolver fail closed.
test("page network requests are intercepted before reaching the network", async context => {
  const reason = implementation.screenshotSkipReason();
  if (reason) { console.log(`SKIP: ${reason}`); context.skip(`SKIP: ${reason}`); return; }
  let requests = 0;
  const server = createServer((_, response) => { requests++; response.setHeader("Access-Control-Allow-Origin", "*"); response.end("unexpected network"); });
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/canary`;
  const dir = root();
  try {
    await implementation.captureDashboard({ html: "<title>Offline fixture</title>", out: join(dir, "offline"), scratchDir: dir, verify: async (page: { blockedRequests: number; evaluate(expression: string): Promise<unknown> }) => {
      const loaded = await page.evaluate(`new Promise(resolve => { const image = new Image(); image.onload = () => resolve(true); image.onerror = () => resolve(false); image.src = ${JSON.stringify(url)}; document.body.append(image); })`);
      expect(loaded).toBe(false);
      expect(page.blockedRequests).toBeGreaterThan(0);
    } });
    expect(requests).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); });
  }
}, implementation.BROWSER_TEST_TIMEOUT_MS);

// Dropping viewport metrics or ignoring the opt-in query route flag breaks
// the real Overview, whose rolling-period query changes on every launch.
test("capture supports mobile metrics and query-insensitive synthetic API routes only when opted in", async context => {
  const reason = implementation.screenshotSkipReason();
  if (reason) { context.skip(`SKIP: ${reason}`); return; }
  const dir = root();
  const png = await implementation.captureDashboard({ html: "<!doctype html><title>Route fixture</title>", out: dir, scratchDir: dir,
    viewport: { width: 390, height: 900 }, routes: {
      "/api/overview": { body: '{"ok":true}', ignoreSearch: true },
      "/api/exact": { body: '{"ok":true}' },
    }, verify: async page => {
      expect(await page.evaluate("innerWidth")).toBe(390);
      expect(await page.evaluate("fetch('/api/overview?start=1&end=2').then(response => response.json())")).toEqual({ ok: true });
      expect(await page.evaluate("fetch('/api/exact?unexpected=1').then(() => true, () => false)")).toBe(false);
      expect(await page.evaluate("fetch('/api/unlisted').then(() => true, () => false)")).toBe(false);
    } });
  const bytes = readFileSync(png);
  expect(bytes.readUInt32BE(16)).toBe(390);
  expect(bytes.readUInt32BE(20)).toBe(900);
}, implementation.BROWSER_TEST_TIMEOUT_MS);

// A top-level CLI invocation would recurse into Vitest or emit SKIP on import.
test("capture helper is inert on import", () => {
  const reply = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(script).href)}); console.log('imported');`], {
    cwd: checkout, env: { ...process.env, CI: "1", SPIDER_USAGE_BROWSER: "" }, encoding: "utf8", timeout: 5000,
  });
  expect(reply.status, reply.stderr).toBe(0);
  expect(reply.stdout).toBe("imported\n");
  expect(reply.stderr).toBe("");
});

// Fetch interception does not cover WebSockets or preconnect. Removing the
// fail-closed proxy/resolver flags must expose accepted TCP connections here.
for (const routeMode of [false, true]) {
  test(`socket isolation blocks loopback and available LAN vectors (${routeMode ? "routes" : "document"})`, async context => {
    const reason = implementation.screenshotSkipReason();
    if (reason) { context.skip(`SKIP: ${reason}`); return; }
    const lan = Object.values(networkInterfaces()).flat().find(address => address?.family === "IPv4" && !address.internal)?.address;
    const hosts = ["127.0.0.1", ...(lan ? [lan] : [])];
    const sockets = new Set<Socket>();
    const accepted: string[] = [];
    const servers: ReturnType<typeof createTcpServer>[] = [];
    const urls: string[] = [];
    const dir = root();
    try {
      for (const host of hosts) {
        const server = createTcpServer(socket => { accepted.push(host); sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.destroy(); });
        servers.push(server);
        await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, host, resolve); });
        const address = server.address() as { port: number };
        urls.push(`http://${host}:${address.port}`);
      }
      const vectors = `Promise.all(${JSON.stringify(urls)}.map(async url => {
        const websocket = new WebSocket(url.replace('http:', 'ws:') + '/websocket');
        const preconnect = document.createElement('link'); preconnect.rel = 'preconnect'; preconnect.href = url; document.head.append(preconnect);
        navigator.sendBeacon(url + '/beacon', 'fixture');
        const request = fetch(url + '/fetch').catch(() => {});
        const image = new Image(); image.src = url + '/image'; document.body.append(image);
        await request;
        await new Promise(resolve => setTimeout(resolve, 800));
        websocket.close();
      })).then(() => true)`;
      await implementation.captureDashboard({ html: "<!doctype html><title>Socket isolation</title>", ...(routeMode ? { routes: {} } : {}), out: dir, scratchDir: dir, verify: async page => {
        expect(await page.evaluate(vectors)).toBe(true);
        expect(accepted).toEqual([]);
      } });
      expect(accepted).toEqual([]);
    } finally {
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map(server => new Promise<void>(resolve => { server.close(() => resolve()); })));
    }
  }, implementation.BROWSER_TEST_TIMEOUT_MS);
}
