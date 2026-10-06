import { afterAll, afterEach, expect, it, vi } from "vitest";
import { readFile, rm, stat, writeFile, symlink, access, mkdir } from "node:fs/promises";
import { join } from "node:path";
let fixtures: any;
async function helpers() {
  const module = await import("../server-runtime.js").catch(() => undefined);
  expect(module, "detached runtime implementation exists").toBeDefined();
  const fixtureUrl = new URL("./fixtures/dashboard-process.mjs", import.meta.url).href;
  const h = await import(/* @vite-ignore */ fixtureUrl);
  fixtures ??= await h.processFixtures(); return { module: module!, h };
}
async function launchIsolated(m: any, f: any, options = f.options) {
  for (const key of ["HOME", "SPIDER_GLOBAL_ROOT", "PI_CODING_AGENT_DIR", "SPIDER_FIXTURE_OBSERVED"]) vi.stubEnv(key, f.env[key]);
  return m.ensureUsageServer(options);
}
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fixtures?.cleanup(); });
afterAll(async () => { await fixtures?.dispose(); });
it("launcher failures expose fixed codes only", async () => {
  const { module: m } = await helpers(); const f = await fixtures.fixture();
  const blocked = join(f.root, "synthetic-private-name"); await writeFile(blocked, "not-a-directory");
  await expect(launchIsolated(m, f, { ...f.options, lockFile: join(blocked, "usage-server", "lock.json") })).rejects.toThrow(/^usage-server-startup-invalid$/);
  await expect(launchIsolated(m, f, { ...f.options, calibrationMode: undefined as any })).rejects.toThrow(/^usage-server-startup-invalid$/);
});

it("crash inspection never creates a directory", async () => {
  const { module: m } = await helpers(); const f = await fixtures.fixture();
  const absent = join(f.root, "absent-private-dir");
  expect(await m.readUsageServerCrashCodes(absent)).toEqual([]);
  await expect(access(absent)).rejects.toThrow();
});

it("caller calibration reload reaches initial and retry readers", async () => {
  // Hardcoding the mode, omitting the reader callback, or omitting it on retry would keep auto/off stale.
  const { h } = await helpers();
  const { openUsageLedger } = await import("../ledger.js");
  for (const initiallyMissing of [false, true]) {
    const f = await fixtures.fixture(); const configFile = join(f.root, "config.json");
    f.options.calibrationConfigFile = configFile;
    await writeFile(configFile, JSON.stringify({ "usage.calibration": "off" }));
    await writeFile(join(f.root, "launcher-options.json"), JSON.stringify(f.options));
    if (!initiallyMissing) openUsageLedger(f.options.roots.ledgerFile).close();
    const launched = await f.start("launch").exited; expect(launched.code, launched.stderr).toBe(0);
    const running = JSON.parse(launched.stdout); f.pids.add(running.pid);
    const bootstrap = await h.reply(running.port, new URL(running.bootstrapUrl).pathname + new URL(running.bootstrapUrl).search);
    const headers = { Cookie: bootstrap.headers["set-cookie"][0].split(";")[0] };
    if (initiallyMissing) {
      expect((await h.reply(running.port, "/api/overview", headers)).status).toBe(503);
      openUsageLedger(f.options.roots.ledgerFile).close();
    }
    const off = await h.waitFor(async () => { const r = await h.reply(running.port, "/api/overview", headers); return r.status === 200 ? r : undefined; });
    expect(JSON.parse(off.body).data.calibration.status).toBe("off");
    for (const contents of ["{}", '{"usage.calibration":"invalid"}', "broken", null]) {
      if (contents === null) await rm(configFile); else await writeFile(configFile, contents);
      const auto = await h.reply(running.port, "/api/overview", headers);
      expect(auto.status).toBe(200); expect(JSON.parse(auto.body).data.calibration.status, contents ?? "missing").toBe("uncalibrated");
    }
  }
}, 20000);

it("private crash log contains only codes", async () => {
  // Serializing Error.message, following a log symlink or unbounded append would leak synthetic sensitive text.
  const { module: m, h } = await helpers();
  expect(m.readUsageServerCrashCodes, "bounded doctor crash-code reader exists").toBeTypeOf("function");
  const f = await fixtures.fixture({ SPIDER_FIXTURE_CRASH: "1" });
  const launched = await f.start("launch").exited; expect(launched.code, launched.stderr).toBe(0);
  const lock = JSON.parse(await readFile(f.options.lockFile, "utf8")); f.pids.add(lock.pid);
  await h.waitFor(async () => (await m.readUsageServerCrashCodes(f.privateDir)).length > 0);
  const log = join(f.privateDir, "crash.log");
  expect(await readFile(log, "utf8")).toBe("usage-server-crashed\n");
  expect((await stat(log)).mode & 0o777).toBe(0o600);
  for (let i = 0; i < 600; i++) await m.writeUsageServerCrashCode(f.privateDir, "usage-server-crashed");
  expect((await stat(log)).size).toBeLessThanOrEqual(8192);
  await m.writeUsageServerCrashCode(f.privateDir, "synthetic-token-private-path" as any);
  expect(await readFile(log, "utf8")).not.toContain("synthetic-token");
  await writeFile(log, "usage-server-crashed\nsynthetic-token-private-path\n", { mode: 0o600 });
  expect(await m.readUsageServerCrashCodes(f.privateDir)).toEqual(["usage-server-crashed"]);
  await rm(log); const target = join(f.root, "protected"); await writeFile(target, "synthetic-private", { mode: 0o600 }); await symlink(target, log);
  expect(await m.readUsageServerCrashCodes(f.privateDir)).toEqual([]);
  await m.writeUsageServerCrashCode(f.privateDir, "usage-server-crashed");
  expect(await readFile(target, "utf8")).toBe("synthetic-private");
}, 15000);

it("new start rotates secret and rejects old session", async () => {
  // Failing to drain/remove the owned lock on termination, or recycling startup credentials, breaks restart isolation.
  const { h } = await helpers(); const f = await fixtures.fixture();
  const first = await f.start("launch").exited; expect(first.code, first.stderr).toBe(0);
  const old = JSON.parse(await readFile(f.options.lockFile, "utf8")); f.pids.add(old.pid);
  const mint = await h.reply(old.port, "/local/bootstrap-nonce", { Authorization: `Bearer ${old.secret}` });
  const oldNonce = JSON.parse(mint.body).data.nonce;
  const bootstrap = await h.reply(old.port, new URL(JSON.parse(first.stdout).bootstrapUrl).pathname + new URL(JSON.parse(first.stdout).bootstrapUrl).search);
  const oldCookieValue = bootstrap.headers["set-cookie"][0].split(";")[0].split("=")[1];
  process.kill(old.pid, "SIGTERM");
  await h.waitFor(async () => { try { await readFile(f.options.lockFile); return false; } catch { return true; } }, 3000);
  const second = await f.start("launch").exited; expect(second.code, second.stderr).toBe(0);
  const next = JSON.parse(await readFile(f.options.lockFile, "utf8")); f.pids.add(next.pid);
  expect(next.secret).not.toBe(old.secret); expect(next.instanceId).not.toBe(old.instanceId);
  expect((await h.reply(next.port, "/local/bootstrap-nonce", { Authorization: `Bearer ${old.secret}` })).status).toBe(401);
  expect((await h.reply(next.port, `/bootstrap?nonce=${oldNonce}`)).status).toBe(401);
  expect((await h.reply(next.port, "/api/status", { Cookie: `spider_usage_${next.port}=${oldCookieValue}` })).status).toBe(401);
}, 15000);

it("server survives launcher exiting", async () => {
  // Parent watchdogs, inherited cwd/stdio, or omitting detached/unref breaks one of these independent launches.
  const { h } = await helpers();
  for (const timing of ["exit-ready", "kill-ready", "hup-ready", "exit-before", "kill-before"]) {
    const f = await fixtures.fixture({ SPIDER_FIXTURE_DELAY: timing.endsWith("before") ? "500" : "0" });
    const launcher = f.start(timing === "exit-ready" ? "launch" : timing === "exit-before" ? "launch-exit-before" : "launch-hold");
    const observed = await h.waitFor(f.observed);
    expect(observed.cwd).toBe(f.privateDir); expect(observed.ipc).toBe(false);
    expect(observed.processGroup).toBe(observed.pid); expect(observed.ignoredStdio).toBe(true);
    if (timing.endsWith("before")) {
      expect(await readFile(f.options.lockFile, "utf8").catch(() => "")).not.toContain('"port":');
      if (timing === "kill-before") process.kill(launcher.child.pid!, "SIGKILL");
    } else if (timing === "kill-ready" || timing === "hup-ready") {
      await h.waitFor(async () => { try { return JSON.parse(await readFile(f.options.lockFile, "utf8")).port; } catch { return undefined; } });
      if (timing === "hup-ready") process.kill(-launcher.child.pid!, "SIGHUP");
      else process.kill(launcher.child.pid!, "SIGKILL");
    }
    await launcher.exited;
    await rm(f.launcherCwd, { recursive: true, force: true });
    const lock = await h.waitFor(async () => { try { const lock = JSON.parse(await readFile(f.options.lockFile, "utf8")); return lock.port ? lock : undefined; } catch { return undefined; } });
    expect(lock.pid).toBe(observed.pid);
    const mint = await h.reply(lock.port, "/local/bootstrap-nonce", { Authorization: `Bearer ${lock.secret}` });
    expect(mint.status).toBe(200);
    const nonce = JSON.parse(mint.body).data.nonce;
    const bootstrap = await h.reply(lock.port, `/bootstrap?nonce=${nonce}`);
    expect(bootstrap.status).toBe(303);
    const cookie = bootstrap.headers["set-cookie"][0].split(";")[0];
    const status = await h.reply(lock.port, "/api/status", { Cookie: cookie });
    expect(status.status).toBe(200); expect(JSON.parse(status.body).data.serverBuild).toBe("synthetic@2026-10-05T00:00:00.000Z");
    expect(JSON.parse(status.body).data.ingest.role).toBe("inactive");
  }
}, 30000);


it("launcher rejects a non-Node executable with a logged fixed code", async () => {
  const { module: m } = await helpers(); const f = await fixtures.fixture();
  const original = process.execPath;
  Object.defineProperty(process, "execPath", { value: "/bin/false", configurable: true });
  try {
    await expect(launchIsolated(m, f)).rejects.toThrow(/^usage-server-unsupported-runtime$/);
  } finally { Object.defineProperty(process, "execPath", { value: original, configurable: true }); }
  expect(await m.readUsageServerCrashCodes(f.privateDir)).toEqual(["usage-server-unsupported-runtime"]);
  await expect(access(join(f.privateDir, "startup.json"))).rejects.toThrow();
});

it("launcher returns promptly when the child exits and removes its secret", async () => {
  const { module: m } = await helpers(); const f = await fixtures.fixture();
  const bad = join(f.root, "exit.mjs"); await writeFile(bad, "process.exit(3)");
  const started = Date.now();
  await expect(launchIsolated(m, f, { ...f.options, bundleUrl: bad })).rejects.toThrow("usage-server-not-ready");
  expect(Date.now() - started).toBeLessThan(1500);
  await expect(access(join(f.privateDir, "startup.json"))).rejects.toThrow();
});

it("guard wait and readiness share a single five-second deadline", async () => {
  const { module: m, h } = await helpers(); const f = await fixtures.fixture({ SPIDER_FIXTURE_DELAY: "4000" });
  vi.stubEnv("SPIDER_FIXTURE_DELAY", "4000");
  const guard = `${f.options.lockFile}.guard`;
  await writeFile(guard, JSON.stringify({ version: 1, instanceId: "c".repeat(32), pid: process.pid, createdAt: Date.now() }), { mode: 0o600 });
  const timer = setTimeout(() => { void rm(guard); }, 2500);
  const started = Date.now();
  try { await expect(launchIsolated(m, f)).rejects.toThrow("usage-server-not-ready"); }
  finally { clearTimeout(timer); }
  expect(Date.now() - started).toBeLessThan(5400);
  await h.waitFor(f.observed); // register even a child that failed before lock publication
  await expect(access(join(f.privateDir, "startup.json"))).rejects.toThrow();
}, 10000);

it("launcher strips poisoned Node options, search paths and inspector settings", async () => {
  const { module: m } = await helpers();
  for (const [key, value] of Object.entries({ NODE_OPTIONS: "--no-warnings", NODE_PATH: "/synthetic-path", NODE_INSPECT_RESUME_ON_START: "1", PI_SUBAGENT_CHILD: "1" })) vi.stubEnv(key, value);
  const env = m.usageServerEnv();
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "NODE_INSPECT_RESUME_ON_START", "PI_SUBAGENT_CHILD"]) expect(env[key]).toBeUndefined();
  const f = await fixtures.fixture({ NODE_OPTIONS: "--no-warnings", NODE_PATH: "/synthetic-path", NODE_INSPECT_RESUME_ON_START: "1" });
  const launched = await f.start("launch").exited; expect(launched.code, launched.stderr).toBe(0);
});

it("concurrent crash writers retain every complete code", async () => {
  const { module: m } = await helpers(); const f = await fixtures.fixture();
  const results = await Promise.all(Array.from({ length: 6 }, () => f.start("crash-write").exited));
  for (const result of results) expect(result.code, result.stderr).toBe(0);
  const codes = await m.readUsageServerCrashCodes(f.privateDir);
  expect(codes.filter(code => code === "usage-server-crashed")).toHaveLength(120);
  expect(codes.filter(code => code === "usage-server-not-ready")).toHaveLength(120);
  expect((await stat(join(f.privateDir, "crash.log"))).size).toBeLessThanOrEqual(8192);
}, 15000);

it("build upgrade stops an authenticated old owner including a hung participant", async () => {
  const { h } = await helpers();
  for (const hang of ["", "1"]) {
    const f = await fixtures.fixture({ SPIDER_FIXTURE_PARTICIPANT: "1", SPIDER_FIXTURE_HANG_STOP: hang });
    const first = await f.start("launch").exited; expect(first.code, first.stderr).toBe(0);
    const old = JSON.parse(await readFile(f.options.lockFile, "utf8")); f.pids.add(old.pid);
    expect(old.serverBuild).toBe("synthetic@2026-10-05T00:00:00.000Z");
    f.options.serverBuild = "synthetic@2026-10-06T00:00:00.000Z";
    f.options.bundleUrl = await fixtures.buildBundle(f.options.serverBuild);
    await writeFile(join(f.root, "launcher-options.json"), JSON.stringify(f.options));
    const second = await f.start("launch").exited; expect(second.code, second.stderr).toBe(0);
    const next = JSON.parse(second.stdout); f.pids.add(next.pid);
    expect(next.reused).toBe(false); expect(next.pid).not.toBe(old.pid);
    expect(next.serverBuild).toBe("synthetic@2026-10-06T00:00:00.000Z");
    await h.waitFor(async () => { try { process.kill(old.pid, 0); return false; } catch { return true; } }, 1000);
  }
}, 15000);


it("unsafe private directory fails with an observable code without following its symlink", async () => {
  const { module: m } = await helpers(); const f = await fixtures.fixture();
  const target = join(f.root, "protected-dir"); await mkdir(target, { mode: 0o700 });
  await rm(f.privateDir, { recursive: true }); await symlink(target, f.privateDir);
  await expect(launchIsolated(m, f)).rejects.toThrow(/^usage-server-startup-invalid$/);
  expect(await m.readUsageServerCrashCodes(f.privateDir)).toEqual(["usage-server-startup-invalid"]);
  await expect(access(join(target, "crash.log"))).rejects.toThrow();
});


it("native bundle resolution accepts escaped file URLs but refuses remote URLs", async () => {
  const { module: m } = await helpers(); const f = await fixtures.fixture();
  const path = join(f.root, "bundle with spaces.mjs");
  const { pathToFileURL } = await import("node:url");
  expect(m.nativeUsageBundle(pathToFileURL(path))).toBe(path);
  expect(m.nativeUsageBundle(pathToFileURL(path).href)).toBe(path);
  expect(() => m.nativeUsageBundle("https://example.test/bundle.mjs")).toThrow("usage-server-bundle-invalid");
});
