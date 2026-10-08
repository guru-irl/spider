import { mkdir, mkdtemp, readFile, rm, writeFile, utimes } from "node:fs/promises";
import { dirname as dirnameFixture, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fstatSync, writeFileSync, watch } from "node:fs";
import { request } from "node:http";
import { isUsageServerMain, runUsageServerEntry } from "../../server-entry.js";
import { createFixtureDashboard } from "./dashboard-assets.ts";
import { ensureUsageServer, writeUsageServerCrashCode } from "../../server-runtime.js";
import { writeServerRecord, removeServerRecord } from "../../server-lock.js";

export async function waitFor(read, timeout = 8000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await read(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("fixture-deadline");
}
export async function reply(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, headers, agent: false, timeout: 1000 }, res => {
      let body = ""; res.on("data", data => { body += data; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }); req.on("error", reject); req.on("timeout", () => req.destroy(new Error("fixture-http-timeout"))); req.end();
  });
}
export const FIXTURE_LAUNCH_DEADLINE_MS = 15000;
export const OLD_BUILD = "synthetic@2026-10-05T00:00:00.000Z";
export const NEW_BUILD = "synthetic@2026-10-06T00:00:00.000Z";
export async function processFixtures() {
  const scratch = resolve(".spider/scratch/usage-ui"); await mkdir(scratch, { recursive: true });
  const buildRoot = await mkdtemp(join(scratch, "dashboard-process-build-"));
  const built = join(buildRoot, "bundle.mjs");
  async function buildBundle(outDir, buildId) {
  await mkdir(outDir, { recursive: true });
  const { build } = await import("vite");
  await build({ configFile: false, logLevel: "silent", define: { __SPIDER_BUILD__: JSON.stringify({ sha: buildId.split("@")[0], builtAt: buildId.split("@")[1], dirty: false, version: "test" }) }, ssr: { noExternal: true }, build: {
    ssr: fileURLToPath(new URL(import.meta.url)), target: "node22", minify: false, outDir, emptyOutDir: false,
    rollupOptions: { external: id => id.startsWith("node:") || ["better-sqlite3", "sqlite-vec", "vite"].includes(id),
      output: { format: "es", entryFileNames: "bundle.mjs", codeSplitting: false } },
  } });
  createFixtureDashboard(undefined, join(outDir, "dashboard"));
  return join(outDir, "bundle.mjs");
  }
  await buildBundle(buildRoot, OLD_BUILD);
  const roots = [], children = new Set(), pids = new Set();
  async function fixture(extraEnv = {}) {
    const root = await mkdtemp(join(scratch, "dashboard-process-")); roots.push(root);
    const privateDir = join(root, "usage-server"); await mkdir(privateDir, { mode: 0o700 });
    const launcherCwd = join(root, "launcher-cwd"); await mkdir(launcherCwd);
    createFixtureDashboard(undefined, join(root, "dashboard"));
    const options = { dashboardDir: join(buildRoot, "dashboard"), bundleUrl: built, roots: { registryDb: join(root, "registry.db"), sessionsDir: join(root, "sessions"),
      ledgerFile: join(root, "usage.db"), authPath: join(root, "auth.json"), leaseDir: join(root, "leases") },
      lockFile: join(privateDir, "lock.json"), serverBuild: OLD_BUILD, calibrationMode: "off", launchDeadlineMs: FIXTURE_LAUNCH_DEADLINE_MS };
    const env = { ...process.env, HOME: root, SPIDER_GLOBAL_ROOT: root, PI_CODING_AGENT_DIR: join(root, "agent"),
      SPIDER_FIXTURE_OBSERVED: join(root, "observed.json"), ...extraEnv };
    for (const key of ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_RUN_ID", "PI_SPIDER_DB_PATH", "PI_SPIDER_SESSION_ID"]) delete env[key];
    const optionsFile = join(root, "launcher-options.json"); await writeFile(optionsFile, JSON.stringify(options));
    let launches = 0;
    const start = (mode, overrides) => {
      const launchFile = overrides ? join(root, `launcher-${++launches}.json`) : optionsFile;
      if (overrides) writeFileSync(launchFile, JSON.stringify({ ...options, ...overrides }));
      const child = spawn(process.execPath, [built, mode, launchFile], { cwd: launcherCwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      children.add(child); pids.add(child.pid);
      let stdout = "", stderr = ""; child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
      const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve({ code, stdout, stderr })); });
      return { child, exited };
    };
    const observed = async () => {
      try { const data = JSON.parse(await readFile(env.SPIDER_FIXTURE_OBSERVED, "utf8")); pids.add(data.pid); return data; } catch { return undefined; }
    };
    const startServer = () => {
      const serverEnv = { ...env }; for (const key of Object.keys(serverEnv)) if (key.startsWith("PI_") || key === "NODE_OPTIONS") delete serverEnv[key];
      const child = spawn(process.execPath, [built, "--spider-usage-server", join(privateDir, "startup.json")], { cwd: privateDir, env: serverEnv, detached: true, stdio: "ignore" });
      children.add(child); pids.add(child.pid);
      const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code)); });
      return { child, exited };
    };
    return { root, privateDir, launcherCwd, options, env, start, startServer, observed, pids };
  }
  async function cleanup() {
    for (const root of roots) {
      for (const name of ["observed.json", "usage-server/lock.json"]) {
        try { const data = JSON.parse(await readFile(join(root, name), "utf8")); if (data.pid > 0 && data.pid !== process.pid) pids.add(data.pid); } catch {}
      }
    }
    for (const pid of pids) { try { process.kill(-pid, "SIGKILL"); } catch {} }
    await Promise.all([...children].map(p => p.exitCode !== null || p.signalCode !== null ? undefined : new Promise(resolve => p.once("exit", resolve))));
    children.clear(); pids.clear();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  }
  const builds = new Map([[OLD_BUILD, Promise.resolve(built)]]);
  const memoizedBuild = id => {
    if (!builds.has(id)) builds.set(id, buildBundle(join(buildRoot, id.replace(/[^a-zA-Z0-9]/g, "_")), id));
    return builds.get(id);
  };
  return { built, buildBundle: memoizedBuild, fixture, cleanup, dispose: async () => { await cleanup(); await rm(buildRoot, { recursive: true, force: true }); } };
}

if (isUsageServerMain(import.meta.url)) {
  // A missing env scrub, execArgv scrub or ignored stdio makes this real fixture refuse startup.
  if (process.send || process.execArgv.length || Object.keys(process.env).some(key => key === "NODE_OPTIONS" || key === "NODE_PATH" || key.startsWith("NODE_INSPECT") || key.startsWith("PI_"))) process.exit(91);
  if (process.env.SPIDER_FIXTURE_OBSERVED) {
    const group = await promisify(execFile)("/bin/ps", ["-p", String(process.pid), "-o", "pgid="]);
    await writeFile(process.env.SPIDER_FIXTURE_OBSERVED, JSON.stringify({ pid: process.pid, cwd: process.cwd(), ipc: !!process.send,
      processGroup: Number(group.stdout.trim()), ignoredStdio: [0, 1, 2].every(fd => fstatSync(fd).isCharacterDevice()) }));
  }
  if (process.env.SPIDER_FIXTURE_DELAY) await new Promise(resolve => setTimeout(resolve, Number(process.env.SPIDER_FIXTURE_DELAY)));
  if (process.env.SPIDER_FIXTURE_PARTICIPANT) {
    const record = JSON.parse(await readFile(process.argv[3], "utf8"));
    const lease = join(dirnameFixture(process.env.SPIDER_FIXTURE_OBSERVED), "fixture-lease");
    const stopped = join(dirnameFixture(process.env.SPIDER_FIXTURE_OBSERVED), "participant-stopped");
    await runUsageServerEntry(import.meta.url, {
      dashboardDir: fileURLToPath(new URL("./dashboard/", import.meta.url)),
      testHook: { idleMs: process.env.SPIDER_FIXTURE_IDLE ? 300 : undefined },
      startParticipant: () => {
        const keepAlive = setInterval(() => {}, 1000);
        writeFileSync(lease, "synthetic-lease"); let stops = 0;
        if (process.env.SPIDER_FIXTURE_REPLACE_GUARD) writeFileSync(`${record.options.lockFile}.guard`, JSON.stringify({ version: 1, instanceId: "b".repeat(32), pid: process.pid, createdAt: Date.now() }), { mode: 0o600 });
        return { snapshot: () => ({ role: "standby", lastIngestAt: null, backfill: "pending", errorCode: null }),
          stop: async () => { stops++; await writeFile(stopped, String(stops)); await rm(lease, { force: true });
            if (process.env.SPIDER_FIXTURE_HANG_STOP) await new Promise(() => {});
            if (process.env.SPIDER_FIXTURE_STOP_DELAY) await new Promise(resolve => setTimeout(resolve, Number(process.env.SPIDER_FIXTURE_STOP_DELAY)));
            await writeFile(join(dirnameFixture(process.env.SPIDER_FIXTURE_OBSERVED), "participant-stop-finished"), "1");
            clearInterval(keepAlive);
          } };
      } });
  } else await runUsageServerEntry(import.meta.url, { dashboardDir: fileURLToPath(new URL("./dashboard/", import.meta.url)) });
  if (process.env.SPIDER_FIXTURE_IGNORE_TERM) { process.removeAllListeners("SIGTERM"); process.on("SIGTERM", () => {}); }
  if (process.env.SPIDER_FIXTURE_CRASH) setTimeout(() => { throw new Error("synthetic-token-private-path"); }, 700);
} else if (process.argv[2] === "observe-publication") {
  const options = JSON.parse(await readFile(process.argv[3], "utf8"));
  const root = dirnameFixture(process.argv[3]); let partial = 0, seen = 0;
  await writeFile(join(root, "observer-ready"), "1");
  while (true) {
    if (await readFile(join(root, "publication-done"), "utf8").catch(() => "")) break;
    const bytes = await readFile(`${options.lockFile}.guard`, "utf8").catch(() => undefined);
    if (bytes !== undefined) { seen++; try { JSON.parse(bytes); } catch { partial++; } }
  }
  process.stdout.write(JSON.stringify({ partial, seen }) + "\n");
} else if (process.argv[2] === "publish-records") {
  const options = JSON.parse(await readFile(process.argv[3], "utf8"));
  const instanceId = "a".repeat(32);
  for (let i = 0; i < 2000; i++) {
    await writeServerRecord(`${options.lockFile}.guard`, { version: 1, instanceId, pid: process.pid, createdAt: Date.now(), padding: "x".repeat(12000) }, true);
    await removeServerRecord(`${options.lockFile}.guard`, instanceId);
  }
  await writeFile(join(dirnameFixture(process.argv[3]), "publication-done"), "1");
} else if (process.argv[2] === "crash-write") {
  const options = JSON.parse(await readFile(process.argv[3], "utf8"));
  for (let i = 0; i < 24; i++) await writeUsageServerCrashCode(dirnameFixture(options.lockFile), i % 2 ? "usage-server-crashed" : "usage-server-not-ready");
} else if (["launch", "launch-hold", "launch-exit-before", "launch-aged-guard"].includes(process.argv[2])) {
  if (process.argv[2] === "launch-exit-before") {
    void waitFor(async () => { try { return JSON.parse(await readFile(process.env.SPIDER_FIXTURE_OBSERVED, "utf8")); } catch { return undefined; } }).then(() => process.exit(0));
  }
  const options = JSON.parse(await readFile(process.argv[3], "utf8"));
  let guardWaitMs, guardWatcher;
  if (process.argv[2] === "launch-aged-guard") {
    const old = new Date(Date.now() - 9000);
    await utimes(`${options.lockFile}.guard`, old, old);
    const agedAt = Date.now();
    guardWatcher = watch(`${options.lockFile}.guard`, event => {
      if (event === "rename") guardWaitMs ??= Date.now() - agedAt;
    });
  }
  const startedAt = Date.now();
  let running;
  try { running = await ensureUsageServer(options, { deadlineMs: options.launchDeadlineMs }); }
  catch (error) { process.stderr.write(`fixtureLaunchElapsedMs=${Date.now() - startedAt}\n`); throw error; }
  finally { guardWatcher?.close(); }
  process.stdout.write(JSON.stringify({ ...running, launchElapsedMs: Date.now() - startedAt, guardWaitMs }) + "\n");
  if (process.argv[2] === "launch-hold") setInterval(() => {}, 1000);
}
