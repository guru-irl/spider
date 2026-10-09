import { seedCalibrationEvidence } from "./fixtures/calibration-evidence.js";
import { USAGE_REPLACEMENT_GRACE_MS, USAGE_LAUNCH_DEADLINE_MS } from "../server-lifecycle.js";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { readFile, rm, stat, writeFile, symlink, access, mkdir, chmod, utimes, open, readdir } from "node:fs/promises";
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

it("launcher propagates missing packaged assets with a safe code and no ledger startup", async () => {
  const { module: m } = await helpers(); const f = await fixtures.fixture({ SPIDER_FIXTURE_PARTICIPANT: "1" });
  const bundle = join(f.root, "missing-assets.mjs"); await writeFile(bundle, await readFile(fixtures.built));
  await rm(join(f.root, "dashboard"), { recursive: true, force: true });
  await expect(launchIsolated(m, f, { ...f.options, bundleUrl: bundle })).rejects.toThrow(/^usage-dashboard-missing$/);
  expect((await m.readUsageServerCrashCodes(f.privateDir)).filter((code: string) => code === "usage-dashboard-missing")).toEqual(["usage-dashboard-missing"]);
  await expect(access(f.options.roots.ledgerFile)).rejects.toThrow();
  await expect(access(join(f.root, "fixture-lease"))).rejects.toThrow();
  await expect(access(f.options.lockFile)).rejects.toThrow();
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
  for (const initiallyMissing of [false, true]) {
    const f = await fixtures.fixture(); const configFile = join(f.root, "config.json");
    f.options.calibrationConfigFile = configFile;
    await writeFile(configFile, JSON.stringify({ "usage.calibration": "off" }));
    await writeFile(join(f.root, "launcher-options.json"), JSON.stringify(f.options));
    if (!initiallyMissing) seedCalibrationEvidence(f.options.roots.ledgerFile);
    const launched = await f.start("launch").exited; expect(launched.code, launched.stderr).toBe(0);
    const running = JSON.parse(launched.stdout); f.pids.add(running.pid);
    const bootstrap = await h.reply(running.port, new URL(running.bootstrapUrl).pathname + new URL(running.bootstrapUrl).search);
    const headers = { Cookie: bootstrap.headers["set-cookie"][0].split(";")[0] };
    if (initiallyMissing) {
      expect((await h.reply(running.port, "/api/calibration", headers)).status).toBe(503);
      seedCalibrationEvidence(f.options.roots.ledgerFile);
    }
    const off = await h.waitFor(async () => { const r = await h.reply(running.port, "/api/calibration", headers); return r.status === 200 ? r : undefined; });
    expect(JSON.parse(off.body).data.correction).toMatchObject({ status: "published-only", factor: null });
    for (const contents of ["{}", '{"usage.calibration":"invalid"}', "broken", null]) {
      if (contents === null) await rm(configFile); else await writeFile(configFile, contents);
      const auto = await h.reply(running.port, "/api/calibration", headers);
      expect(auto.status).toBe(200); expect(JSON.parse(auto.body).data.correction, contents ?? "missing").toMatchObject({ status: "back-applied", factor: 0.5 });
    }
  }
});

it("global budget reload reaches initial and retry readers without ledger writes", async () => {
  const { h } = await helpers();
  const { openUsageLedger } = await import("../ledger.js");
  for (const initiallyMissing of [false, true]) {
    const f = await fixtures.fixture(), configFile = join(f.root, "config.json");
    f.options.calibrationConfigFile = configFile;
    await writeFile(configFile, JSON.stringify({ "usage.monthlyBudget": 250 }));
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
    const first = await h.waitFor(async () => { const r = await h.reply(running.port, "/api/overview", headers); return r.status === 200 ? r : undefined; });
    expect(JSON.parse(first.body).data.pace.budget).toBe(250);
    await writeFile(configFile, JSON.stringify({ "usage.monthlyBudget": 500 }));
    expect(JSON.parse((await h.reply(running.port, "/api/overview", headers)).body).data.pace.budget).toBe(500);
    for (const contents of ["{}", '{"usage.monthlyBudget":0}', "broken", null]) {
      if (contents === null) await rm(configFile); else await writeFile(configFile, contents);
      const response = await h.reply(running.port, "/api/overview", headers);
      expect(response.status).toBe(200); expect(JSON.parse(response.body).data.pace.budget).toBeNull();
    }
  }
});

it("private crash log contains only codes", async () => {
  // Serializing Error.message, following a log symlink or unbounded append would leak synthetic sensitive text.
  const { module: m, h } = await helpers();
  expect(m.readUsageServerCrashCodes, "bounded doctor crash-code reader exists").toBeTypeOf("function");
  const f = await fixtures.fixture({ SPIDER_FIXTURE_CRASH: "1" });
  const launched = await f.start("launch").exited; expect(launched.code, launched.stderr).toBe(0);
  const lock = JSON.parse(await readFile(f.options.lockFile, "utf8")); f.pids.add(lock.pid);
  await h.waitFor(async () => (await m.readUsageServerCrashCodes(f.privateDir)).length > 0);
  const log = join(f.privateDir, "crash.log");
  expect(await readFile(log, "utf8")).toMatch(/^usage-server-crashed \d+\n$/);
  expect((await stat(log)).mode & 0o777).toBe(0o600);
  const oldest = "usage-server-busy 1\n", row = `usage-server-crashed ${Date.now()}\n`;
  const seeded = oldest + row.repeat(Math.floor((8192 - oldest.length) / row.length));
  await writeFile(log, seeded, { mode: 0o600 });
  expect(Buffer.byteLength(seeded)).toBeGreaterThan(8192 - row.length);
  for (let i = 0; i < 2; i++) await m.writeUsageServerCrashCode(f.privateDir, "usage-server-crashed");
  await m.writeUsageServerCrashCode(f.privateDir, "usage-server-not-ready");
  const capped = await readFile(log, "utf8");
  expect((await stat(log)).size).toBeLessThanOrEqual(8192);
  expect(capped).not.toContain(oldest); // The overflow must evict whole oldest rows.
  expect(capped).toMatch(/usage-server-not-ready \d+\n$/);
  for (const line of capped.trimEnd().split("\n")) expect(line).toMatch(/^usage-server-(?:crashed|not-ready) \d+$/);
  await m.writeUsageServerCrashCode(f.privateDir, "synthetic-token-private-path" as any);
  expect(await readFile(log, "utf8")).toBe(capped);
  await writeFile(log, "usage-server-crashed\nsynthetic-token-private-path\n", { mode: 0o600 });
  expect(await m.readUsageServerCrashCodes(f.privateDir)).toEqual(["usage-server-crashed"]);
  await rm(log); const target = join(f.root, "protected"); await writeFile(target, "synthetic-private", { mode: 0o600 }); await symlink(target, log);
  expect(await m.readUsageServerCrashCodes(f.privateDir)).toEqual([]);
  await m.writeUsageServerCrashCode(f.privateDir, "usage-server-crashed");
  expect(await readFile(target, "utf8")).toBe("synthetic-private");
});

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
  await h.waitFor(async () => { try { await readFile(f.options.lockFile); return false; } catch { return true; } }, USAGE_REPLACEMENT_GRACE_MS + 3000);
  const second = await f.start("launch").exited; expect(second.code, second.stderr).toBe(0);
  const next = JSON.parse(await readFile(f.options.lockFile, "utf8")); f.pids.add(next.pid);
  expect(next.secret).not.toBe(old.secret); expect(next.instanceId).not.toBe(old.instanceId);
  expect((await h.reply(next.port, "/local/bootstrap-nonce", { Authorization: `Bearer ${old.secret}` })).status).toBe(401);
  expect((await h.reply(next.port, `/bootstrap?nonce=${oldNonce}`)).status).toBe(401);
  expect((await h.reply(next.port, "/api/status", { Cookie: `spider_usage_${next.port}=${oldCookieValue}` })).status).toBe(401);
});

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
    expect(JSON.parse(status.body).data.collector).toBe("none");
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
});

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
  expect(codes.filter(code => code === "usage-server-crashed")).toHaveLength(72);
  expect(codes.filter(code => code === "usage-server-not-ready")).toHaveLength(72);
  expect((await stat(join(f.privateDir, "crash.log"))).size).toBeLessThanOrEqual(8192);
});

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
    await h.waitFor(async () => { try { process.kill(old.pid, 0); return false; } catch { return true; } }, USAGE_REPLACEMENT_GRACE_MS + 3000);
  }
});


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

// Inherited ps environments used to turn one live owner into a false birth mismatch.
it.skipIf(process.platform === "linux")("different caller locales and time zones reuse one server and preserve its lock", async () => {
  const { h } = await helpers();
  const f = await fixtures.fixture({ TZ: "UTC", LC_ALL: "C" });
  const first = await f.start("launch").exited; expect(first.code, first.stderr).toBe(0);
  const before = await readFile(f.options.lockFile, "utf8");
  const owner = JSON.parse(before); f.pids.add(owner.pid);
  f.env.TZ = "Asia/Tokyo"; f.env.LC_ALL = "de_DE.UTF-8";
  const second = await f.start("launch").exited; expect(second.code, second.stderr).toBe(0);
  const reused = JSON.parse(second.stdout); f.pids.add(reused.pid);
  expect(reused.reused).toBe(true); expect(reused.pid).toBe(owner.pid);
  expect(await readFile(f.options.lockFile, "utf8")).toBe(before);
  expect((await h.reply(owner.port, "/local/bootstrap-nonce", { Authorization: `Bearer ${owner.secret}` })).status).toBe(200);
});

// An old lstart record has no timezone metadata. A live legacy owner must stay fenced.
it.skipIf(process.platform === "linux")("live legacy local-time locks and guards fail closed until their owner is gone", async () => {
  const { module: m } = await helpers(); const f = await fixtures.fixture();
  const first = await f.start("launch").exited; expect(first.code, first.stderr).toBe(0);
  const owner = JSON.parse(await readFile(f.options.lockFile, "utf8")); f.pids.add(owner.pid);
  const legacy = { ...owner, processIdentity: "Mi.  7 Okt. 14:46:28 2026" };
  await writeFile(f.options.lockFile, JSON.stringify(legacy), { mode: 0o600 });
  const next = await f.start("launch", { launchDeadlineMs: USAGE_LAUNCH_DEADLINE_MS }).exited;
  expect(next.code).toBe(1); expect(next.stderr).toContain("usage-server-busy");
  expect(JSON.parse(await readFile(f.options.lockFile, "utf8"))).toEqual(legacy);
  const lock = await import("../server-lock.js");
  const guard = `${f.options.lockFile}.guard`;
  await lock.writeServerRecord(guard, { ...legacy, createdAt: Date.now() - 20000 });
  expect(await lock.reclaimStaleServerRecord(guard, m.usageProcessIdentity)).toBe(false);
  await lock.writeServerRecord(guard, { ...legacy, processIdentity: "2026年10月7日 14:46:28", createdAt: Date.now() - 20000 });
  expect(await lock.reclaimStaleServerRecord(guard, m.usageProcessIdentity)).toBe(false);
  process.kill(-owner.pid, "SIGKILL");
  await m.localUsageRequest(owner.port, "/api/status").catch(() => {});
  const h = await import(/* @vite-ignore */ new URL("./fixtures/dashboard-process.mjs", import.meta.url).href);
  await h.waitFor(async () => { try { process.kill(owner.pid, 0); return false; } catch { return true; } });
  expect(await lock.reclaimStaleServerRecord(guard, m.usageProcessIdentity)).toBe(true);
  const restarted = await f.start("launch").exited; expect(restarted.code, restarted.stderr).toBe(0);
  const row = JSON.parse(restarted.stdout); f.pids.add(row.pid); expect(row.pid).not.toBe(owner.pid);
});

// Deleting the parent's privacy checks must not create or read a public sibling log.
it("crash fallback refuses a non-private parent on both write and read", async () => {
  const { module: m } = await helpers(); const f = await fixtures.fixture();
  const target = join(f.root, "protected-dir"); await mkdir(target, { mode: 0o700 });
  await rm(f.privateDir, { recursive: true }); await symlink(target, f.privateDir);
  await chmod(f.root, 0o755);
  await m.writeUsageServerCrashCode(f.privateDir, "usage-server-crashed");
  const fallback = join(f.root, "usage-server-failures");
  await expect(access(fallback)).rejects.toThrow();
  await mkdir(fallback, { mode: 0o700 });
  await writeFile(join(fallback, "crash.log"), "usage-server-crashed\n", { mode: 0o600 });
  expect(await m.readUsageServerCrashCodes(f.privateDir)).toEqual([]);
  await expect(access(join(target, "crash.log"))).rejects.toThrow();
});

// A hard-coded five-second deadline ignores the explicit launcher's scheduling budget.
it("launch deadline is injectable without retrying the launch", async () => {
  const { module: m } = await helpers(); const f = await fixtures.fixture();
  const bad = join(f.root, "never-ready.mjs"); await writeFile(bad, "setInterval(() => {}, 1000)");
  for (const key of ["HOME", "SPIDER_GLOBAL_ROOT", "PI_CODING_AGENT_DIR", "SPIDER_FIXTURE_OBSERVED"]) vi.stubEnv(key, f.env[key]);
  const start = Date.now();
  await expect(m.ensureUsageServer({ ...f.options, bundleUrl: bad }, { deadlineMs: 600 })).rejects.toThrow("usage-server-not-ready");
  expect(Date.now() - start).toBeLessThan(2000);
});

// The 3.5 s fallback killed an owner still finishing HTTP drain + participant stop.
it("replacement lets a drained server finish its participant before the kill fallback", async () => {
  const { h } = await helpers();
  const f = await fixtures.fixture({ SPIDER_FIXTURE_PARTICIPANT: "1", SPIDER_FIXTURE_STOP_DELAY: "1900" });
  const first = await f.start("launch").exited; expect(first.code, first.stderr).toBe(0);
  const old = JSON.parse(first.stdout); f.pids.add(old.pid);
  const { createConnection } = await import("node:net");
  const socket = createConnection({ host: "127.0.0.1", port: old.port });
  socket.on("error", () => {});
  await new Promise<void>(resolve => socket.once("connect", resolve));
  socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${old.port}\r\n`);
  const bundleUrl = await fixtures.buildBundle(h.NEW_BUILD);
  try {
    const next = await f.start("launch", { bundleUrl, serverBuild: h.NEW_BUILD, launchDeadlineMs: 15000 }).exited;
    expect(next.code, next.stderr).toBe(0);
    const row = JSON.parse(next.stdout); f.pids.add(row.pid); expect(row.pid).not.toBe(old.pid);
    expect(await readFile(join(f.root, "participant-stop-finished"), "utf8")).toBe("1");
  } finally { socket.destroy(); }
});

// Legacy code-only readers remain supported and later writes must freeze their estimate.
it("legacy crash rows retain their original estimate after timestamped appends", async () => {
  const { module: m } = await helpers(); const f = await fixtures.fixture();
  const log = join(f.privateDir, "crash.log");
  await writeFile(log, "usage-server-busy\n", { mode: 0o600 });
  const initial = await m.readUsageServerCrashDiagnostics(f.privateDir);
  expect(initial).toBeDefined();
  const original = initial!.failures[0]!;
  expect(original.code).toBe("usage-server-busy");
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 86400000);
    await m.writeUsageServerCrashCode(f.privateDir, "usage-server-crashed");
    expect((await m.readUsageServerCrashDiagnostics(f.privateDir))!.failures).toEqual([
      original, { code: "usage-server-crashed", mtimeMs: Date.now() },
    ]);
    await writeFile(log, "usage-server-crashed 1\nusage-server-busy NaN\nusage-server-busy 9007199254740992\n/private/text 1\n", { mode: 0o600 });
    expect((await m.readUsageServerCrashDiagnostics(f.privateDir))!.failures).toEqual([{ code: "usage-server-crashed", mtimeMs: 1 }]);
  } finally { vi.useRealTimers(); }
});

// Expiring legacy birth records releases recycled PIDs without authenticating or signalling them.
it.skipIf(process.platform === "linux")("legacy locks and guards expire after idle plus margin even while the PID is live", async () => {
  const { module: m } = await helpers(); const f = await fixtures.fixture();
  const lock = await import("../server-lock.js");
  const legacy = { version: 1, instanceId: "a".repeat(32), pid: process.pid, port: null,
    secret: "a".repeat(43), processIdentity: "Mi.  7 Okt. 14:46:28 2026" };
  const old = new Date(Date.now() - 36 * 60 * 1000);
  for (const file of [f.options.lockFile, `${f.options.lockFile}.guard`]) {
    await lock.writeServerRecord(file, legacy);
    await utimes(file, old, old);
    expect(await lock.reclaimStaleServerRecord(file, m.usageProcessIdentity)).toBe(true);
    await expect(access(file)).rejects.toThrow();
  }
  // Also exercise the launcher, which must reclaim before retrying authentication forever.
  await lock.writeServerRecord(f.options.lockFile, legacy); await utimes(f.options.lockFile, old, old);
  const kill = vi.spyOn(process, "kill");
  const pending = launchIsolated(m, f);
  await expect(pending).resolves.toMatchObject({ reused: false });
  const row = await pending; f.pids.add(row.pid);
  expect(row.reused).toBe(false); expect(row.pid).not.toBe(process.pid);
  expect(kill.mock.calls.filter(([pid, signal]) => pid === process.pid && signal !== 0)).toEqual([]);
});

it.skipIf(process.platform === "linux")("an active aged legacy dashboard lock is not reclaimed or signalled", async () => {
  // Age alone must not spawn a duplicate beside a live legacy dashboard process.
  const { module: m } = await helpers(); const f = await fixtures.fixture();
  const first = await f.start("launch").exited; expect(first.code, first.stderr).toBe(0);
  const owner = JSON.parse(await readFile(f.options.lockFile, "utf8")); f.pids.add(owner.pid);
  const legacy = { ...owner, processIdentity: "Mi.  7 Okt. 14:46:28 2026" };
  await writeFile(f.options.lockFile, JSON.stringify(legacy), { mode: 0o600 });
  const old = new Date(Date.now() - 36 * 60 * 1000); await utimes(f.options.lockFile, old, old);
  const kill = vi.spyOn(process, "kill");
  for (const key of ["HOME", "SPIDER_GLOBAL_ROOT", "PI_CODING_AGENT_DIR", "SPIDER_FIXTURE_OBSERVED"]) vi.stubEnv(key, f.env[key]);
  await expect(m.ensureUsageServer(f.options, { deadlineMs: 1200 })).rejects.toThrow("usage-server-busy");
  expect(JSON.parse(await readFile(f.options.lockFile, "utf8"))).toEqual(legacy);
  expect(kill.mock.calls.filter(([pid, signal]) => Math.abs(pid) === owner.pid && signal !== 0)).toEqual([]);
});

it("crash timestamps reject unsafe integers and future rows beyond clock skew", async () => {
  const { module: m } = await helpers(); const f = await fixtures.fixture();
  const now = Date.now(), log = join(f.privateDir, "crash.log");
  await writeFile(log, `usage-server-busy 9007199254740992\nusage-server-busy ${now + 60000}\nusage-server-crashed ${now + 1000}\n`, { mode: 0o600 });
  expect((await m.readUsageServerCrashDiagnostics(f.privateDir))!.failures).toEqual([{ code: "usage-server-crashed", mtimeMs: now + 1000 }]);
});

// Truncate-in-place changes already-open readers; rename keeps their complete old snapshot.
it("crash append atomically publishes a complete snapshot and preserves open readers", async () => {
  const { module: m } = await helpers(); const f = await fixtures.fixture();
  const log = join(f.privateDir, "crash.log"), before = "usage-server-busy 1\n";
  await writeFile(log, before, { mode: 0o600 });
  const reader = await open(log, "r");
  try {
    await m.writeUsageServerCrashCode(f.privateDir, "usage-server-crashed");
    expect(await reader.readFile("utf8")).toBe(before);
    expect(await readFile(log, "utf8")).toMatch(/^usage-server-busy 1\nusage-server-crashed \d+\n$/);
    expect((await stat(log)).mode & 0o777).toBe(0o600);
    expect((await readdir(f.privateDir)).filter(name => name.startsWith("crash.log."))).toEqual([]);
  } finally { await reader.close(); }
});
