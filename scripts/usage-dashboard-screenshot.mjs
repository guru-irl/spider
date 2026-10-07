import { accessSync, constants, statSync, mkdirSync, mkdtempSync, realpathSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openCdpBrowser, errorDetail, DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_STARTUP_TIMEOUT_MS, DEFAULT_CLOSE_TIMEOUT_MS, CLOSE_GRACE_MS } from "./usage-dashboard-cdp.mjs";

export const DEFAULT_VERIFY_TIMEOUT_MS = 30_000;
// The CLI runs a batch of views and sizes, not a single capture.

// Startup, route load, verification and bounded close, plus command/scheduling
// headroom. Real-browser tests must outlive the helper's own error deadlines.
export const BROWSER_TEST_TIMEOUT_MS = DEFAULT_STARTUP_TIMEOUT_MS + DEFAULT_COMMAND_TIMEOUT_MS + DEFAULT_VERIFY_TIMEOUT_MS + DEFAULT_CLOSE_TIMEOUT_MS + CLOSE_GRACE_MS + 15_000;
// Derive the batch budget from the visual tests, including any newly added tests.
const visualTests = readFileSync(new URL("../packages/host/src/usage/__tests__/dashboard-visual.test.ts", import.meta.url), "utf8");
const visualBudget = [...visualTests.matchAll(/}, implementation\.BROWSER_TEST_TIMEOUT_MS(?: \* (\d+))?\);/g)]
  .reduce((total, match) => total + Number(match[1] ?? 1), 0);
export const DEFAULT_CLI_TIMEOUT_MS = BROWSER_TEST_TIMEOUT_MS * visualBudget + 30_000;
import { spawn, execFileSync } from "node:child_process";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultScratch = join(checkout, ".spider/scratch/usage-dashboard-screenshots");
const origin = "https://dashboard.invalid";
const usage = "Usage: node scripts/usage-dashboard-screenshot.mjs [--out DIR] [--timeout-ms MS]";

export function screenshotSkipReason(env = process.env) {
  if (env.CI) return "CI disables local browser acceptance";
  if (!env.SPIDER_USAGE_BROWSER) return "set SPIDER_USAGE_BROWSER to a local Chromium executable";
  try {
    accessSync(env.SPIDER_USAGE_BROWSER, constants.X_OK);
    if (!statSync(env.SPIDER_USAGE_BROWSER).isFile()) throw new Error();
  } catch {
    return "SPIDER_USAGE_BROWSER is not an executable file";
  }
  return null;
}

export async function captureDashboard({ html, routes, viewport = { width: 1440, height: 1000 }, fullPage = false, out = defaultScratch, scratchDir = defaultScratch, browser = process.env.SPIDER_USAGE_BROWSER, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS, verifyTimeoutMs = DEFAULT_VERIFY_TIMEOUT_MS, installSignalHandlers = false, verify, verifyAfterCapture }) {
  if (!browser) throw new Error("browser-required");
  for (const [path, route] of Object.entries(routes ?? {})) {
    const body = route?.body;
    if (!(typeof body === "string" || body instanceof Uint8Array || (body && typeof body === "object" && typeof body.base64 === "string"))) {
      throw new Error(`invalid-route-body: ${errorDetail(path)}`);
    }
  }
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  const profileDir = mkdtempSync(join(scratchDir, "browser-"));
  const controller = new AbortController();
  let signalCode;
  let interrupt;
  const interrupted = new Promise((_, reject) => { interrupt = reject; });
  const onSignal = signal => {
    if (signalCode) return;
    signalCode = signal === "SIGINT" ? 130 : 143;
    controller.abort();
    interrupt(Object.assign(new Error("capture-interrupted"), { exitCode: signalCode }));
  };
  const onInt = () => onSignal("SIGINT");
  const onTerm = () => onSignal("SIGTERM");
  if (installSignalHandlers) {
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
  }
  let cdp;
  let opening;
  let primaryError;
  let interceptionError;
  const interceptionFailed = new Promise((_, reject) => { interceptionError = reject; });
  const run = async () => {
    opening = openCdpBrowser({ browser, profileDir, timeoutMs, startupTimeoutMs, signal: controller.signal });
    cdp = await opening;
    if (controller.signal.aborted) throw new Error("capture-interrupted");
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);
    let blockedRequests = 0;
    let loaded;
    const load = new Promise(resolve => { loaded = resolve; });
    // Fulfill only this synthetic origin from local data; fail other page
    // requests at Fetch. Proxy/resolver flags also block paths not intercepted
    // here, including WebSockets and preconnect, as defence in depth.
    cdp.onEvent(message => {
      if (message.sessionId !== sessionId) return;
      if (message.method === "Page.loadEventFired") loaded();
      if (message.method === "Fetch.requestPaused") {
        const { requestId, request } = message.params;
        let route;
        if (routes) {
          const url = new URL(request.url);
          if (url.origin === origin) {
            const path = url.pathname + url.search;
            route = Object.hasOwn(routes, path) ? routes[path]
              : Object.hasOwn(routes, url.pathname) && routes[url.pathname].ignoreSearch ? routes[url.pathname]
              : path === "/" ? { body: html, contentType: "text/html; charset=utf-8" } : undefined;
          }
        }
        const response = route
          ? send("Fetch.fulfillRequest", { requestId, responseCode: route.status ?? 200, responseHeaders: [{ name: "Content-Type", value: route.contentType ?? "application/json" }, ...(route.headers ?? [])], body: typeof route.body === "object" && !Buffer.isBuffer(route.body) && "base64" in route.body ? route.body.base64 : Buffer.from(route.body).toString("base64") })
          : send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).then(() => { blockedRequests++; });
        void response.catch(interceptionError);
      }
    });
    await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
    if (routes) {
      const navigation = await send("Page.navigate", { url: origin + "/" });
      if (navigation.errorText) throw new Error(`Page.navigate: ${errorDetail(navigation.errorText)}`);
      let timer;
      try { await Promise.race([load, interrupted, interceptionFailed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("page-load-timeout")), timeoutMs); })]); }
      finally { clearTimeout(timer); }
    } else {
      const { frameTree } = await send("Page.getFrameTree");
      await send("Page.setDocumentContent", { frameId: frameTree.frame.id, html });
    }
    const evaluate = async expression => {
      const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (reply.exceptionDetails) throw new Error(`page-evaluation-failed: Runtime.evaluate: ${errorDetail(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text)}`);
      return reply.result.value;
    };
    const screenshot = async (name, wholePage = false) => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.png$/.test(name)) throw new Error("invalid-screenshot-name");
      const capture = { format: "png", fromSurface: true, captureBeyondViewport: wholePage };
      if (wholePage) {
        const { cssContentSize } = await send("Page.getLayoutMetrics");
        capture.clip = { x: cssContentSize.x, y: cssContentSize.y, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
      }
      const image = await send("Page.captureScreenshot", capture);
      mkdirSync(out, { recursive: true });
      const path = join(out, name);
      writeFileSync(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
      return path;
    };
    const pressKey = async key => {
      if (key !== "Tab") throw new Error("unsupported-capture-key");
      const params = { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 };
      await send("Input.dispatchKeyEvent", { ...params, type: "rawKeyDown" });
      await send("Input.dispatchKeyEvent", { ...params, type: "keyUp" });
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    };
    const runVerification = async callback => {
      if (!callback) return;
      let timer;
      try {
        await Promise.race([
          interrupted, interceptionFailed,
          callback({ pid: cdp.pid, evaluate, screenshot, pressKey, get blockedRequests() { return blockedRequests; } }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("capture-timeout")), verifyTimeoutMs); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    await runVerification(verify);
    const png = await screenshot("overview.png", fullPage);
    await runVerification(verifyAfterCapture);
    return png;
  };
  try { return await Promise.race([run(), interrupted, interceptionFailed]); }
  catch (error) { primaryError = error; throw error; }
  finally {
    try {
      // A signal during startup must also await the startup's bounded cleanup.
      if (!cdp && opening) cdp = await opening.catch(() => undefined);
      if (cdp) await cdp.close();
    } catch (error) { if (!primaryError) throw error; }
    finally {
      rmSync(profileDir, { recursive: true, force: true });
      if (installSignalHandlers) {
        process.off("SIGINT", onInt);
        process.off("SIGTERM", onTerm);
      }
    }
  }
}

export function closeOwnedBrowserProfiles(root) {
  // Vitest can exit synchronously in its own signal handler, before capture's
  // handler runs. Recover only groups carrying a profile inside our temp root.
  const processes = execFileSync("ps", ["-axo", "pgid=,command="], { encoding: "utf8" }).split("\n");
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name.startsWith("browser-")) {
        try {
          const pid = Number(readFileSync(join(path, "browser.pid"), "utf8"));
          if (Number.isInteger(pid) && pid > 0 && processes.some(line => {
            const match = line.trim().match(/^(\d+)\s+(.*)$/);
            return match && Number(match[1]) === pid && match[2].includes(`--user-data-dir=${path}`);
          })) {
            try { process.kill(-pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
          }
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      } else visit(path);
    }
  }
  visit(root);
}

async function main() {
  const args = process.argv.slice(2);
  let out = defaultScratch;
  let timeoutMs = DEFAULT_CLI_TIMEOUT_MS;
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (args[index] === "--out" && value && !value.startsWith("--")) out = resolve(value);
    else if (args[index] === "--timeout-ms" && /^\d+$/.test(value ?? "") && Number(value) > 0 && Number(value) <= 2_147_483_647) timeoutMs = Number(value);
    else { console.error(usage); return 1; }
  }
  const reason = screenshotSkipReason();
  if (reason) { console.log(`SKIP: ${reason}`); return 77; }
  const scratch = process.env.SPIDER_USAGE_SCREENSHOT_SCRATCH || defaultScratch;
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(join(scratch, "vitest-"));
  const env = { ...process.env, TMPDIR: tmp, SPIDER_USAGE_SCREENSHOT_OUT: out, SPIDER_USAGE_SCREENSHOT_SCRATCH: tmp, SPIDER_USAGE_SCREENSHOT_SIGNALS: "1" };
  for (const key of ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_RUN_ID", "PI_SPIDER_DB_PATH", "PI_SPIDER_SESSION_ID"]) delete env[key];
  let signalCode;
  let interrupt;
  const interrupted = new Promise(resolve => { interrupt = resolve; });
  const onInt = () => { signalCode = 130; interrupt(); };
  const onTerm = () => { signalCode = 143; interrupt(); };
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  let timer;
  let child;
  let exit;
  let ended = false;
  const killGroup = signal => {
    if (child?.pid) { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; } }
  };
  try {
    // Use the installed runner directly, never npx/npm or this CLI again.
    child = spawn(process.execPath, [join(checkout, "node_modules/vitest/vitest.mjs"), "run",
      "packages/host/src/usage/__tests__/dashboard-visual.test.ts", "--maxWorkers=1", "--reporter=verbose"], { cwd: checkout, stdio: "inherit", env, detached: true });
    exit = new Promise(resolve => {
      child.once("error", error => { console.error(`FAIL: ${errorDetail(error.message)}`); resolve(1); });
      child.once("close", code => { ended = true; resolve(code === 0 ? 0 : 1); });
    });
    const result = await Promise.race([exit, interrupted, new Promise(resolve => { timer = setTimeout(() => { console.error("FAIL: vitest-timeout"); resolve(1); }, timeoutMs); })]);
    return signalCode ?? result;
  } finally {
    clearTimeout(timer);
    try {
      if (child && !ended) {
        // Let capture's signal handler remove its profile before forcing exit.
        killGroup("SIGTERM");
        let grace;
        await Promise.race([exit, new Promise(resolve => { grace = setTimeout(resolve, 3000); })]).finally(() => clearTimeout(grace));
      }
      if (!ended) killGroup("SIGKILL");
      if (child && !ended) {
        let deadline;
        await Promise.race([exit, new Promise(resolve => { deadline = setTimeout(resolve, 2000); })]).finally(() => clearTimeout(deadline));
      }
    } finally {
      try { closeOwnedBrowserProfiles(tmp); }
      finally { rmSync(tmp, { recursive: true, force: true }); }
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    }
  }
}

// Node resolves module symlinks, so argv must be resolved the same way.
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`FAIL: usage screenshot capture failed: ${errorDetail(error.message)}`);
    process.exitCode = 1;
  });
}
