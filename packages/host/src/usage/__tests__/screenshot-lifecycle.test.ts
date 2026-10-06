import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import * as cdp from "../../../../../scripts/usage-dashboard-cdp.mjs";
import * as capture from "../../../../../scripts/usage-dashboard-screenshot.mjs";
import { createPipeBrowser } from "./fixtures/cdp-pipe-fixture.js";
import { createUnresponsivePipeBrowser } from "./fixtures/dashboard-browser-fixture.js";

const checkout = fileURLToPath(new URL("../../../../../", import.meta.url));
const script = join(checkout, "scripts/usage-dashboard-screenshot.mjs");
const scratch = join(checkout, ".spider/scratch/usage-dashboard-tests");
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "lifecycle-")); roots.push(dir); return dir;
}
function dead(pid: number) { expect(() => process.kill(pid, 0)).toThrow(); }

test("symlinked CLI does not silently exit zero", () => {
  const link = join(root(), "checkout"); symlinkSync(checkout, link, "dir");
  const reply = spawnSync(process.execPath, [join(link, "scripts/usage-dashboard-screenshot.mjs")], { env: { ...process.env, CI: "1" }, encoding: "utf8", timeout: 5000 });
  expect(reply.status, reply.stderr).toBe(77);
  expect(reply.stdout).toMatch(/^SKIP: /);
});

test("browser HOME is real even when the caller supplies a fake HOME", async () => {
  const dir = root(); const fixture = createPipeBrowser(dir);
  vi.stubEnv("HOME", join(dir, "fake-home"));
  try {
    await capture.captureDashboard({ html: "fixture", out: dir, browser: fixture.executable, scratchDir: dir });
    expect(JSON.parse(readFileSync(fixture.launchFile, "utf8")).home).toBe(userInfo().homedir);
  } finally { fixture.close(); }
});

test("spawn failure preserves ENOENT and removes its profile", async () => {
  const dir = root();
  const kill = vi.spyOn(process, "kill"); // Call-through spy on the real spawn/cleanup boundary.
  await expect(capture.captureDashboard({ html: "fixture", out: dir, scratchDir: dir, browser: join(dir, "absent"), timeoutMs: 100 })).rejects.toThrow(/ENOENT/);
  expect(kill.mock.calls).toEqual([]); // There is no owned PID to kill, especially not NaN.
  expect(readdirSync(dir)).toEqual([]);
});

test("close kills the owned group even after the leader has exited", async () => {
  const dir = root(); const fixture = createPipeBrowser(dir, "group");
  const profileDir = join(dir, "profile"); mkdirSync(profileDir);
  try {
    const browser = await cdp.openCdpBrowser({ browser: fixture.executable, profileDir });
    const descendant = Number(readFileSync(fixture.descendantFile, "utf8"));
    await browser.close();
    await vi.waitFor(() => dead(descendant));
    dead(browser.pid);
  } finally { fixture.close(); }
});

test("close has a deadline when another process holds the CDP pipe open", async () => {
  const dir = root(); const fixture = createPipeBrowser(dir, "holder");
  const profileDir = join(dir, "profile"); mkdirSync(profileDir);
  try {
    const browser = await cdp.openCdpBrowser({ browser: fixture.executable, profileDir, closeTimeoutMs: 100 });
    let fallback: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(Promise.race([browser.close(), new Promise((_, reject) => { fallback = setTimeout(() => reject(new Error("fixture-fallback")), 2000); })])).rejects.toThrow("browser-close-timeout");
    } finally { clearTimeout(fallback); }
    await vi.waitFor(() => expect(existsSync(fixture.eofFile)).toBe(true), { timeout: 5000 });
    await expect(browser.send("Browser.getVersion")).rejects.toThrow("cdp-pipe-closed");
  } finally { fixture.close(); }
});

test("Fetch layer fails intercepted requests as defence in depth", async () => {
  const dir = root(); const fixture = createPipeBrowser(dir);
  try {
    await capture.captureDashboard({ html: "fixture", out: dir, scratchDir: dir, browser: fixture.executable, verify: async page => {
      expect(await page.evaluate("blocked")).toBe(true);
    } });
  } finally { fixture.close(); }
});

test("page evaluation errors carry the method and sanitized truncated exception", async () => {
  const dir = root(); const fixture = createPipeBrowser(dir);
  try {
    const error = await capture.captureDashboard({ html: "fixture", out: dir, scratchDir: dir, browser: fixture.executable, verify: async page => { await page.evaluate("throw"); } }).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("expected evaluation error");
    expect(error.message).toMatch(/Runtime\.evaluate.*fixture exception/);
    expect(error.message).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(error.message.length).toBeLessThan(500);
  } finally { fixture.close(); }
});

test("verification deadline is independent of each CDP command deadline", async () => {
  const dir = root(); const fixture = createPipeBrowser(dir);
  try {
    await capture.captureDashboard({ html: "fixture", out: dir, scratchDir: dir, browser: fixture.executable, timeoutMs: 1500, verifyTimeoutMs: 4000, verify: async page => {
      await new Promise(resolve => setTimeout(resolve, 1800));
      expect(await page.evaluate("ready")).toBe(true);
    } });
  } finally { fixture.close(); }
});

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  test(`capture ${signal} closes browser and removes profile before exit ${code}`, async () => {
    const dir = root(); const fixture = createPipeBrowser(dir);
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import { captureDashboard } from ${JSON.stringify(pathToFileURL(script).href)}; try { await captureDashboard({ html: 'fixture', out: ${JSON.stringify(dir)}, scratchDir: ${JSON.stringify(dir)}, browser: ${JSON.stringify(fixture.executable)}, installSignalHandlers: true, verify: async () => { console.log('READY'); await new Promise(() => {}); } }); } catch (error) { process.exitCode = error.exitCode ?? 1; }`], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    const exit = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    let stdout = ""; child.stdout.on("data", chunk => { stdout += chunk; });
    try {
      await vi.waitFor(() => expect(stdout).toContain("READY"), { timeout: 5000 });
      child.kill(signal);
      expect(await exit).toEqual({ code, signal: null });
      dead(Number(readFileSync(fixture.pidFile, "utf8")));
      expect(readdirSync(dir).filter(name => name.startsWith("browser-"))).toEqual([]);
    } finally { child.kill("SIGKILL"); fixture.close(); }
  });

  test(`CLI ${signal} cleans browser and Vitest temp folders before exit ${code}`, async () => {
    const dir = root(); const fixture = createUnresponsivePipeBrowser(dir);
    const child = spawn(process.execPath, [script, "--out", join(dir, "out")], { env: { ...process.env, CI: "", SPIDER_USAGE_BROWSER: fixture.executable, SPIDER_USAGE_SCREENSHOT_SCRATCH: dir }, stdio: "ignore", detached: true });
    const exit = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    try {
      await vi.waitFor(() => expect(existsSync(fixture.pidFile)).toBe(true), { timeout: 10_000 });
      child.kill(signal);
      expect(await exit).toEqual({ code, signal: null });
      await vi.waitFor(() => dead(Number(readFileSync(fixture.pidFile, "utf8"))));
      expect(readdirSync(dir).filter(name => /^(browser|vitest)-/.test(name))).toEqual([]);
    } finally { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* closed */ } fixture.close(); }
  });
}

test("CLI overall deadline terminates stalled Vitest and cleans temp folders", async () => {
  const dir = root(); const fixture = createUnresponsivePipeBrowser(dir);
  try {
    const reply = spawnSync(process.execPath, [script, "--out", join(dir, "out"), "--timeout-ms", "2000"], { env: { ...process.env, CI: "", SPIDER_USAGE_BROWSER: fixture.executable, SPIDER_USAGE_SCREENSHOT_SCRATCH: dir }, encoding: "utf8", timeout: 10_000 });
    expect(reply.status, reply.stderr).toBe(1);
    expect(reply.stderr).toContain("vitest-timeout");
    expect(readdirSync(dir).filter(name => /^(browser|vitest)-/.test(name))).toEqual([]);
    if (existsSync(fixture.pidFile)) dead(Number(readFileSync(fixture.pidFile, "utf8")));
  } finally { fixture.close(); }
});

test("invalid CLI arguments print usage and exit nonzero", () => {
  const reply = spawnSync(process.execPath, [script, "--unknown"], { env: { ...process.env, CI: "", SPIDER_USAGE_BROWSER: process.execPath }, encoding: "utf8", timeout: 5000 });
  expect(reply.status).toBe(1);
  expect(reply.stderr).toMatch(/Usage: .*\[--out/);
});

test("synthetic origin fulfills mapped API routes and fails unmapped requests", async context => {
  const reason = capture.screenshotSkipReason();
  if (reason) { context.skip(`SKIP: ${reason}`); return; }
  const dir = root();
  await capture.captureDashboard({ html: "<!doctype html><title>Routes</title>", routes: { "/api/overview": { body: '{"tokens":1700}', contentType: "application/json" } }, out: dir, scratchDir: dir, verify: async page => {
    expect(await page.evaluate("location.origin")).toBe("https://dashboard.invalid");
    expect(await page.evaluate("fetch('/api/overview').then(r => r.json())")).toEqual({ tokens: 1700 });
    expect(await page.evaluate("fetch('/unmapped').then(() => false, () => true)")).toBe(true);
  } });
}, capture.BROWSER_TEST_TIMEOUT_MS);

// Startup delay exceeds the command budget, but not its own startup budget.
test("startup has its own deadline, separate from commands", async () => {
  const dir = root(); const fixture = createPipeBrowser(dir, "delayed");
  const profileDir = join(dir, "profile"); mkdirSync(profileDir);
  try {
    const browser = await cdp.openCdpBrowser({ browser: fixture.executable, profileDir, timeoutMs: 100, startupTimeoutMs: 2000 });
    await browser.close();
  } finally { fixture.close(); }
});

for (const mode of ["startup-stall", "command-stall"] as const) {
  test(`${mode} reports the bounded sanitized browser stderr tail`, async () => {
    const dir = root(); const fixture = createPipeBrowser(dir, mode);
    const profileDir = join(dir, "profile"); mkdirSync(profileDir);
    let browser: Awaited<ReturnType<typeof cdp.openCdpBrowser>> | undefined;
    try {
      const error = await (async () => {
        browser = await cdp.openCdpBrowser({ browser: fixture.executable, profileDir, timeoutMs: 500, startupTimeoutMs: 1500 });
        await browser.send("Runtime.evaluate");
      })().catch((error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("fixture stderr tail");
      expect((error as Error).message).not.toMatch(/DISCARDED-PREFIX|\[31m|[\x00-\x1f\x7f]/);
      expect((error as Error).message.length).toBeLessThan(9000);
    } finally { await browser?.close(); fixture.close(); }
  });
}

test("browser env strips PI variables and NODE_OPTIONS", async () => {
  const dir = root(); const fixture = createPipeBrowser(dir);
  vi.stubEnv("PI_FIXTURE_SECRET", "must-not-reach-browser");
  vi.stubEnv("NODE_OPTIONS", "--no-warnings");
  try {
    await capture.captureDashboard({ html: "fixture", out: dir, scratchDir: dir, browser: fixture.executable });
    const env = JSON.parse(readFileSync(fixture.launchFile, "utf8")).env;
    expect(Object.keys(env).filter(key => key.startsWith("PI_") || key === "NODE_OPTIONS")).toEqual([]);
    expect(env.TMPDIR).toMatch(/browser-.*\/tmp$/);
  } finally { fixture.close(); }
});

test("abort is wired during browser startup", async () => {
  const dir = root(); const fixture = createPipeBrowser(dir, "startup-stall");
  const profileDir = join(dir, "profile"); mkdirSync(profileDir);
  const controller = new AbortController();
  try {
    const opening = cdp.openCdpBrowser({ browser: fixture.executable, profileDir, timeoutMs: 4000, startupTimeoutMs: 4000, signal: controller.signal });
    const rejected = expect(opening).rejects.toThrow("capture-aborted");
    await vi.waitFor(() => expect(existsSync(fixture.pidFile)).toBe(true));
    controller.abort();
    await Promise.race([rejected, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("fixture abort fallback")), 1500); timer.unref(); })]);
    dead(Number(readFileSync(fixture.pidFile, "utf8")));
  } finally { fixture.close(); }
});

for (const [mode, error] of [["fulfill-error", "fixture fulfil failure"], ["navigate-error", "Page.navigate: fixture navigation failure"], ["load-stall", "page-load-timeout"]] as const) {
  test(`${mode} fails capture rather than producing a PNG`, async () => {
    const dir = root(); const fixture = createPipeBrowser(dir, mode);
    try {
      await expect(capture.captureDashboard({ html: "fixture", routes: {}, out: dir, scratchDir: dir, browser: fixture.executable, timeoutMs: 500 })).rejects.toThrow(error);
      expect(existsSync(join(dir, "overview.png"))).toBe(false);
    } finally { fixture.close(); }
  });
}

test("route map refuses a matching path at another origin", async () => {
  const dir = root(); const fixture = createPipeBrowser(dir);
  try {
    await capture.captureDashboard({ html: "fixture", routes: { "/api/overview": { body: "{}" } }, out: dir, scratchDir: dir, browser: fixture.executable, verify: async page => {
      expect(await page.evaluate("blocked")).toBe(true);
    } });
  } finally { fixture.close(); }
});

test("library signal handlers are opt-in and never exit the caller", async () => {
  const dir = root(); const fixture = createPipeBrowser(dir);
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  try {
    await capture.captureDashboard({ html: "fixture", out: dir, scratchDir: dir, browser: fixture.executable, verify: async () => {
      expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
    } });
    await expect(capture.captureDashboard({ html: "fixture", out: dir, scratchDir: dir, browser: fixture.executable, installSignalHandlers: true, verify: async () => {
      process.emit("SIGINT");
      await new Promise(() => {});
    } })).rejects.toMatchObject({ message: "capture-interrupted", exitCode: 130 });
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  } finally { fixture.close(); }
});

// Use real ps output: a recorded PID without the exact profile is not owned.
for (const owned of [false, true]) {
  test(`profile recovery ${owned ? "kills its owned" : "refuses an unrelated"} process group`, async () => {
    const dir = root(); const profile = join(dir, "browser-fixture"); mkdirSync(profile);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", dir, owned ? `--user-data-dir=${profile}` : "unrelated"], { detached: true, stdio: "ignore" });
    const exit = new Promise(resolve => child.once("close", resolve));
    writeFileSync(join(profile, "browser.pid"), String(child.pid));
    try {
      expect(capture.closeOwnedBrowserProfiles).toBeTypeOf("function");
      const kill = vi.spyOn(process, "kill");
      capture.closeOwnedBrowserProfiles(dir);
      if (!owned) expect(kill.mock.calls).toEqual([]);
      if (owned) { await exit; dead(child.pid!); }
      else expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* closed */ } await exit; }
  });
}

for (const code of ["EPERM", "ESRCH"]) {
  test(`close always awaits bounded exit after ${code}`, async () => {
    const dir = root(); const fixture = createPipeBrowser(dir, "close-stall");
    const profileDir = join(dir, "profile"); mkdirSync(profileDir);
    try {
      const browser = await cdp.openCdpBrowser({ browser: fixture.executable, profileDir, closeTimeoutMs: 100 });
      vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error(`fixture ${code}`), { code }); });
      await expect(browser.close()).rejects.toThrow("browser-close-timeout");
      expect(process.kill).toHaveBeenCalledWith(-browser.pid, "SIGKILL");
    } finally { vi.restoreAllMocks(); fixture.close(); }
  });
}

test("close does not signal a group after its members have exited", async () => {
  const dir = root(); const fixture = createPipeBrowser(dir);
  const profileDir = join(dir, "profile"); mkdirSync(profileDir);
  try {
    const browser = await cdp.openCdpBrowser({ browser: fixture.executable, profileDir });
    const kill = vi.spyOn(process, "kill");
    await browser.close();
    expect(kill.mock.calls).toEqual([]);
  } finally { fixture.close(); }
});

// Binary routes must survive Fetch.fulfillRequest base64 transport intact.
// CSP must be delivered as a real response header, not only as fixture markup.
test("route status, headers, binary and base64 bodies round trip with CSP", async context => {
  const reason = capture.screenshotSkipReason();
  if (reason) { context.skip(`SKIP: ${reason}`); return; }
  const dir = root();
  const bytes = Buffer.from([0, 255, 128, 1, 65]);
  await capture.captureDashboard({ html: "<!doctype html><title>Routes</title><script>window.documentRan = true</script>", routes: {
    "/": { body: "<!doctype html><title>Routes</title><script>window.documentRan = true</script>", contentType: "text/html", headers: [{ name: "Content-Security-Policy", value: "default-src 'self'; script-src 'none'" }] },
    "/binary": { body: bytes, contentType: "application/octet-stream", status: 201, headers: [{ name: "X-Fixture", value: "binary" }] },
    "/base64": { body: { base64: "AP+AAUE=" }, contentType: "application/octet-stream" },
    "/csp": { body: "<!doctype html><script>window.inlineRan = true</script>", contentType: "text/html", headers: [{ name: "Content-Security-Policy", value: "default-src 'none'; script-src 'none'" }] },
  }, out: dir, scratchDir: dir, verify: async page => {
    expect(await page.evaluate("window.documentRan === true")).toBe(false);
    expect(await page.evaluate("document.scripts.length")).toBe(1);
    expect(await page.evaluate("fetch('/binary').then(async r => ({ status: r.status, type: r.headers.get('Content-Type'), header: r.headers.get('X-Fixture'), bytes: [...new Uint8Array(await r.arrayBuffer())] }))")).toEqual({ status: 201, type: "application/octet-stream", header: "binary", bytes: [0, 255, 128, 1, 65] });
    expect(await page.evaluate("fetch('/base64').then(async r => [...new Uint8Array(await r.arrayBuffer())])")).toEqual([0, 255, 128, 1, 65]);
    expect(await page.evaluate("new Promise(resolve => { const frame = document.createElement('iframe'); frame.onload = () => resolve({ ran: frame.contentWindow.inlineRan === true, scripts: frame.contentDocument.scripts.length }); frame.src = '/csp'; document.body.append(frame); })")).toEqual({ ran: false, scripts: 1 });
    // The matching path at a foreign origin must fail, never return fixture data.
    expect(await page.evaluate("fetch('http://127.0.0.1:1234/binary').then(() => false, () => true)")).toBe(true);
  } });
}, capture.BROWSER_TEST_TIMEOUT_MS);

// Observe the real CLI kill boundary without changing the target processes.
test("CLI does not signal its already exited Vitest group", () => {
  const dir = root(); const trace = join(dir, "signals.jsonl");
  const probe = join(dir, "kill-probe.mjs");
  writeFileSync(probe, `import { appendFileSync } from 'node:fs';
const kill = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (signal === 'SIGKILL') {
    try { kill(pid, 0); } catch (error) {
      if (error.code === 'ESRCH') appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ pid, signal }) + '\\n');
    }
  }
  return kill(pid, signal);
};`);
  const reply = spawnSync(process.execPath, [script, "--out", dir], { env: { ...process.env, CI: "", SPIDER_USAGE_BROWSER: process.execPath, SPIDER_USAGE_SCREENSHOT_SCRATCH: dir, NODE_OPTIONS: `--import=${pathToFileURL(probe).href}` }, encoding: "utf8", timeout: 15_000 });
  expect(reply.status, reply.stdout + reply.stderr).toBe(1);
  expect(existsSync(trace) ? readFileSync(trace, "utf8") : "").toBe("");
});

// Force the real spawn error at the CLI boundary, without changing process.execPath.
test("CLI reports a child spawn error and exits nonzero", () => {
  const dir = root(); const probe = join(dir, "spawn-probe.mjs");
  writeFileSync(probe, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spawn = childProcess.spawn;
childProcess.spawn = (executable, args, options) => spawn(args[0]?.endsWith('/vitest/vitest.mjs') ? ${JSON.stringify(join(dir, "absent-executable"))} : executable, args, options);
syncBuiltinESMExports();`);
  const reply = spawnSync(process.execPath, [script, "--out", dir], { env: { ...process.env, CI: "", SPIDER_USAGE_BROWSER: process.execPath, SPIDER_USAGE_SCREENSHOT_SCRATCH: dir, NODE_OPTIONS: `--import=${pathToFileURL(probe).href}` }, encoding: "utf8", timeout: 5000 });
  expect(reply.status, reply.stdout + reply.stderr).toBe(1);
  expect(reply.stderr).toMatch(/FAIL: .*ENOENT/);
  expect(readdirSync(dir).filter(name => name.startsWith("vitest-"))).toEqual([]);
});

// A diagnostic stderr pipe may be inherited by a helper outside the browser
// group. It must not delay leader/CDP closure or authorize killing that helper.
test("diagnostic stderr held by a helper does not prevent browser closure", async () => {
  const dir = root(); const fixture = createPipeBrowser(dir, "stderr-holder");
  const profileDir = join(dir, "profile"); mkdirSync(profileDir);
  try {
    const browser = await cdp.openCdpBrowser({ browser: fixture.executable, profileDir, closeTimeoutMs: 100 });
    await browser.close();
    dead(browser.pid);
    // This outside-group helper is fixture-owned, not a browser group member.
    expect(() => process.kill(Number(readFileSync(fixture.descendantFile, "utf8")), 0)).not.toThrow();
  } finally { fixture.close(); }
});

// These tests exercise kill-error ownership decisions, not just the exit timer.
for (const code of ["EPERM", "ESRCH"]) {
  test(`close tolerates ${code} when the signalled process group is gone`, async () => {
    const dir = root(); const fixture = createPipeBrowser(dir, "close-stall");
    const profileDir = join(dir, "profile"); mkdirSync(profileDir);
    const realKill = process.kill.bind(process);
    try {
      const browser = await cdp.openCdpBrowser({ browser: fixture.executable, profileDir });
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        realKill(pid, signal);
        throw Object.assign(new Error(`fixture ${code}`), { code });
      });
      await expect(browser.close()).resolves.toBeUndefined();
      vi.restoreAllMocks();
      dead(browser.pid);
    } finally { vi.restoreAllMocks(); fixture.close(); }
  });
}

test("close reports EPERM while the profile-carrying process is still alive", async () => {
  const dir = root(); const fixture = createPipeBrowser(dir, "close-stall");
  const profileDir = join(dir, "profile"); mkdirSync(profileDir);
  const realKill = process.kill.bind(process);
  let cleanup: ReturnType<typeof setTimeout> | undefined;
  try {
    const browser = await cdp.openCdpBrowser({ browser: fixture.executable, profileDir });
    const error = Object.assign(new Error("fixture owned EPERM"), { code: "EPERM" });
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      // Leave it alive for the real ps ownership check, then allow the bounded
      // exit wait to finish so the original permission error must be reported.
      cleanup = setTimeout(() => realKill(pid, signal), 300);
      throw error;
    });
    await expect(browser.close()).rejects.toBe(error);
    vi.restoreAllMocks();
    dead(browser.pid);
  } finally { clearTimeout(cleanup); vi.restoreAllMocks(); fixture.close(); }
});

test("close refuses a reused group id whose remaining command lacks the profile", async () => {
  const dir = root(); const fixture = createPipeBrowser(dir, "unrelated-group");
  const profileDir = join(dir, "profile"); mkdirSync(profileDir);
  try {
    const browser = await cdp.openCdpBrowser({ browser: fixture.executable, profileDir });
    const helper = Number(readFileSync(fixture.descendantFile, "utf8"));
    const kill = vi.spyOn(process, "kill");
    await browser.close();
    expect(kill.mock.calls).toEqual([]);
    expect(() => process.kill(helper, 0)).not.toThrow();
    dead(browser.pid);
  } finally { fixture.close(); }
});

test("capture honours a short startup deadline for a stalled browser", async () => {
  const dir = root(); const fixture = createPipeBrowser(dir, "startup-stall");
  const start = Date.now();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await expect(Promise.race([
      capture.captureDashboard({ html: "fixture", out: dir, scratchDir: dir, browser: fixture.executable, startupTimeoutMs: 250 }),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("startup-budget-not-honoured")), 4000); }),
    ])).rejects.toThrow("cdp-command-timeout: Browser.getVersion");
    expect(Date.now() - start).toBeLessThan(4000);
    dead(Number(readFileSync(fixture.pidFile, "utf8")));
  } finally { clearTimeout(deadline); fixture.close(); }
}, 6000);

test("already aborted open rejects without spawning a browser", async () => {
  const dir = root(); const fixture = createPipeBrowser(dir);
  const profileDir = join(dir, "profile"); mkdirSync(profileDir);
  const controller = new AbortController(); controller.abort();
  try {
    await expect(cdp.openCdpBrowser({ browser: fixture.executable, profileDir, signal: controller.signal })).rejects.toThrow("capture-aborted");
    expect(readdirSync(profileDir)).toEqual([]);
    expect(existsSync(fixture.pidFile)).toBe(false);
    expect(existsSync(fixture.launchFile)).toBe(false);
  } finally { fixture.close(); }
});

for (const route of [{}, { body: null }]) {
  test(`route with ${"body" in route ? "null" : "missing"} body is rejected before launch`, async () => {
    const dir = root(); const fixture = createPipeBrowser(dir);
    try {
      await expect(capture.captureDashboard({ html: "fixture", routes: { "/invalid": route } as unknown as Record<string, capture.DashboardRoute>, out: dir, scratchDir: dir, browser: fixture.executable })).rejects.toThrow("invalid-route-body: /invalid");
      expect(existsSync(fixture.pidFile)).toBe(false);
      expect(existsSync(join(dir, "overview.png"))).toBe(false);
    } finally { fixture.close(); }
  });
}

// Observe the real allocation boundary: the previous stderr chunk passed to
// the next concat must be bounded, even though only 300 characters are shown.
test("browser retains at most 8 KiB between stderr chunks", async () => {
  const dir = root(); const fixture = createPipeBrowser(dir, "command-stall");
  const profileDir = join(dir, "profile"); mkdirSync(profileDir);
  let browser: Awaited<ReturnType<typeof cdp.openCdpBrowser>> | undefined;
  const concat = Buffer.concat.bind(Buffer);
  const retained: number[] = [];
  try {
    browser = await cdp.openCdpBrowser({ browser: fixture.executable, profileDir, timeoutMs: 500 });
    vi.spyOn(Buffer, "concat").mockImplementation((chunks, length) => {
      if (chunks.length === 2 && Buffer.from(chunks[1]!).includes(Buffer.from("DISCARDED-PREFIX"))) retained.push(chunks[0]!.length);
      return concat(chunks, length);
    });
    await expect(browser.send("Runtime.evaluate")).rejects.toThrow("cdp-command-timeout");
    await expect(browser.send("Runtime.evaluate")).rejects.toThrow("cdp-command-timeout");
    expect(retained).toEqual([0, 8192]);
  } finally { vi.restoreAllMocks(); await browser?.close(); fixture.close(); }
});

test("real browser test timeout exceeds startup, load, verify and close budgets", () => {
  const worstCase = cdp.DEFAULT_STARTUP_TIMEOUT_MS + cdp.DEFAULT_COMMAND_TIMEOUT_MS + capture.DEFAULT_VERIFY_TIMEOUT_MS + cdp.DEFAULT_CLOSE_TIMEOUT_MS + cdp.CLOSE_GRACE_MS;
  expect(capture.BROWSER_TEST_TIMEOUT_MS).toBeGreaterThan(worstCase);
  expect(capture.BROWSER_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(75_000);
});
