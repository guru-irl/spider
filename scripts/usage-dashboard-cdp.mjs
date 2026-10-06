import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
export const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
export const DEFAULT_CLOSE_TIMEOUT_MS = 2000;
export const CLOSE_GRACE_MS = 300;

export function errorDetail(value) {
  return String(value ?? "unknown error").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 300);
}

// Chromium's pipe uses fd 3 for input, fd 4 for output, and NUL framing.
// The transport is independent of browser lifecycle so framing is tested in CI.
export function createCdpTransport({ input, output, timeoutMs = 10_000 }) {
  let sequence = 0;
  let buffer = Buffer.alloc(0);
  let failure;
  const pending = new Map();
  const listeners = new Set();
  function fail(error = new Error("cdp-pipe-closed")) {
    if (failure) return;
    failure = error;
    buffer = Buffer.alloc(0);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
    listeners.clear();
  }
  const onError = error => fail(error);
  const onClose = () => fail();
  const onData = chunk => {
    if (failure) return;
    if (buffer.length + chunk.length > 32 * 1024 * 1024) { fail(new Error("cdp-buffer-limit")); return; }
    buffer = Buffer.concat([buffer, chunk]);
    let delimiter;
    while ((delimiter = buffer.indexOf(0)) !== -1) {
      const frame = buffer.subarray(0, delimiter);
      buffer = buffer.subarray(delimiter + 1);
      if (!frame.length) continue;
      let message;
      try { message = JSON.parse(frame.toString("utf8")); } catch { fail(new Error("cdp-invalid-frame")); return; }
      if (message.id) {
        const entry = pending.get(message.id);
        if (!entry) continue;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(`cdp-command-failed: ${entry.method} (${errorDetail(message.error.code)}): ${errorDetail(message.error.message)}`));
        else entry.resolve(message.result);
      } else {
        for (const listener of listeners) listener(message);
      }
    }
  };
  input.on("error", onError);
  output.on("error", onError);
  output.on("close", onClose);
  output.on("data", onData);
  function send(method, params = {}, sessionId, commandTimeoutMs = timeoutMs) {
    return new Promise((resolve, reject) => {
      if (failure) { reject(failure); return; }
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`cdp-command-timeout: ${method}`)); }, commandTimeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0", error => { if (error) fail(error); });
    });
  }
  function close() {
    fail();
    output.off("data", onData);
    output.off("close", onClose);
    // Keep error listeners until stream destruction, including failed spawns.
    input.destroy();
    output.destroy();
  }
  return { send, fail, close, onEvent(listener) { if (!failure) listeners.add(listener); } };
}

// A reaped leader's PGID can be reused. Only surviving members carrying this
// exact private profile authorize a kill after leader exit.
function ownsGroup(pid, profileDir) {
  return execFileSync("ps", ["-axo", "pgid=,command="], { encoding: "utf8" }).split("\n").some(line => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    return match && Number(match[1]) === pid && match[2].includes(`--user-data-dir=${profileDir}`);
  });
}

export async function openCdpBrowser({ browser, profileDir, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS, closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS, signal }) {
  if (signal?.aborted) throw new Error("capture-aborted");
  const env = { ...process.env, HOME: userInfo().homedir };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_") || key === "NODE_OPTIONS" || key === "NODE_PATH") delete env[key];
  }
  // Never trust caller HOME: a synthetic HOME can trigger macOS keychain UI.
  // Only the Chromium profile and transient files are isolated in scratch.
  mkdirSync(join(profileDir, "tmp"), { mode: 0o700 });
  env.TMPDIR = join(profileDir, "tmp");
  const child = spawn(browser, [
    "--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profileDir}`,
    "--use-mock-keychain", "--password-store=basic", "--no-first-run",
    "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "--disable-sync", "--disable-extensions", "--disable-breakpad",
    "--disable-features=MediaRouter",
    // Resolver rules enforce socket isolation; the dead proxy is defence in depth.
    "--host-resolver-rules=MAP * ~NOTFOUND", "--proxy-server=http://127.0.0.1:9", "about:blank",
  ], { detached: true, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], env, cwd: profileDir });
  let stderr = Buffer.alloc(0);
  child.stderr.on("data", chunk => { stderr = Buffer.concat([stderr, chunk]).subarray(-8192); });
  const diagnostic = error => {
    // Keep the most recent diagnostics, strip terminal controls and bound text.
    const tail = errorDetail(stderr.toString("utf8").slice(-300));
    if (tail) error.message += `; browser stderr: ${tail}`;
    return error;
  };
  if (child.pid) writeFileSync(join(profileDir, "browser.pid"), String(child.pid), { mode: 0o600 });
  const transport = createCdpTransport({ input: child.stdio[3], output: child.stdio[4], timeoutMs });
  let ended = false;
  let leaderExited = false;
  let closing;
  const exit = new Promise(resolve => { child.once("close", () => { ended = true; resolve(); }); });
  child.on("error", error => transport.fail(error));
  child.on("exit", () => {
    leaderExited = true;
    transport.fail();
    // A helper can inherit stderr without owning the browser's CDP pipes.
    // Diagnostics must not keep child.close pending after the leader exits.
    child.stderr.destroy();
  });
  const abort = () => transport.fail(new Error("capture-aborted"));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  function close() {
    return closing ??= (async () => {
      let grace;
      let deadline;
      let killError;
      try {
        if (!ended) {
          void transport.send("Browser.close").catch(() => {});
          await Promise.race([
            exit,
            new Promise(resolve => { grace = setTimeout(resolve, CLOSE_GRACE_MS); }),
          ]).finally(() => clearTimeout(grace));
        }
        try {
          if (child.pid && (!leaderExited || ownsGroup(child.pid, profileDir))) {
            try { process.kill(-child.pid, "SIGKILL"); }
            catch (error) {
              if (!["EPERM", "ESRCH"].includes(error.code) || ownsGroup(child.pid, profileDir)) killError = error;
            }
          }
        } catch (error) { killError = error; }
        // Always await bounded pipe/process closure, even when kill failed.
        await Promise.race([
          exit,
          new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("browser-close-timeout")), closeTimeoutMs); }),
        ]);
        if (killError) throw killError;
      } finally {
        clearTimeout(deadline);
        signal?.removeEventListener("abort", abort);
        transport.close();
        child.stderr.destroy();
      }
    })();
  }
  const send = (method, params, sessionId) => transport.send(method, params, sessionId).catch(error => { throw diagnostic(error); });
  try {
    await transport.send("Browser.getVersion", {}, undefined, startupTimeoutMs);
    return { pid: child.pid, send, onEvent: transport.onEvent, close };
  } catch (error) {
    // Cleanup failures must not mask the actual spawn or CDP error.
    await close().catch(() => {});
    throw diagnostic(error);
  }
}
