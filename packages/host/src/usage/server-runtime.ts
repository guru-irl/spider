import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { constants, closeSync, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { dirname, extname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LaunchOptions } from "./dashboard-contract.js";
import { USAGE_LAUNCH_DEADLINE_MS, USAGE_REPLACEMENT_GRACE_MS, USAGE_STARTUP_WINDOW_MS, USAGE_PROCESS_CHECK_TIMEOUT_MS } from "./server-lifecycle.js";
import { assertPrivateServerDir, ensurePrivateServerDir, reclaimStaleServerRecord, readServerRecord, readUsageServerLock, removeServerRecord, writeServerRecord, sweepServerRecordTemps, publishServerIntent, removeServerIntent, assertServerRecordOwner, type UsageServerLock } from "./server-lock.js";

/** The caller supplies resolved global calibration explicitly, never HTTP or an implicit server default. */
export type UsageServerLaunchOptions = LaunchOptions & { calibrationMode: "auto" | "off"; calibrationConfigFile?: string };
export type UsageServerLaunch = { pid: number; port: number; bootstrapUrl: string; reused: boolean; serverBuild: string; rateVersions: readonly string[] };
export async function usageProcessIdentity(pid: number, deadline: number = Infinity): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    }
    const result = await promisify(execFile)("/bin/ps", ["-p", String(pid), "-o", "lstart="], { env: { LC_ALL: "C", TZ: "UTC" }, timeout: Math.max(1, Math.min(USAGE_PROCESS_CHECK_TIMEOUT_MS, deadline - Date.now())), maxBuffer: 1024 });
    const start = result.stdout.trim();
    return start ? `ps-utc:${start}` : undefined;
  } catch { return undefined; }
}
/** Old ps lstart records omitted the locale and zone. They cannot prove PID reuse. */
export function legacyUsageProcessIdentity(identity: unknown): boolean {
  return process.platform !== "linux" && typeof identity === "string" && !identity.startsWith("ps-utc:");
}
export function nativeUsageBundle(bundleUrl: string | URL): string {
  const url = bundleUrl instanceof URL ? bundleUrl : /^[a-z][a-z\d+.-]*:/i.test(bundleUrl) ? new URL(bundleUrl) : pathToFileURL(bundleUrl);
  if (url.protocol !== "file:" || ![".js", ".mjs"].includes(extname(fileURLToPath(url)))) throw new Error("usage-server-bundle-invalid");
  return fileURLToPath(url);
}
export function usageServerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PI_") || key === "NODE_OPTIONS" || key === "NODE_PATH" || key.startsWith("NODE_INSPECT")) delete env[key];
  return env;
}
export function localUsageRequest(port: number, path: string, headers: Record<string, string> = {}, deadline: number = Infinity): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, headers, agent: false }, res => {
      let size = 0; const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 8192) req.destroy(new Error("usage-server-not-ready")); else chunks.push(chunk); });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    const timer = setTimeout(() => req.destroy(new Error("usage-server-not-ready")), Math.max(1, Math.min(400, deadline - Date.now())));
    req.once("close", () => clearTimeout(timer)); req.once("error", reject); req.end();
  });
}
export async function mintUsageBootstrap(lock: UsageServerLock, deadline: number = Infinity): Promise<string> {
  if (!lock.port) throw new Error("usage-server-not-ready");
  const reply = await localUsageRequest(lock.port, "/local/bootstrap-nonce", { Authorization: `Bearer ${lock.secret}` }, deadline);
  const envelope = JSON.parse(reply.body) as { apiVersion?: number; revision?: string; data?: { nonce?: string } };
  if (reply.status !== 200 || envelope.apiVersion !== 1 || envelope.revision !== `${lock.instanceId}:bootstrap` ||
    !/^[A-Za-z0-9_-]{43}$/.test(envelope.data?.nonce ?? "")) throw new Error("usage-server-not-ready");
  return `http://127.0.0.1:${lock.port}/bootstrap?nonce=${envelope.data!.nonce}`;
}
async function authenticatedOwner(lock: UsageServerLock, deadline: number): Promise<{ serverBuild: string; rateVersions: readonly string[] } | undefined> {
  try {
    if (!lock.port || !lock.processIdentity || await usageProcessIdentity(lock.pid, deadline) !== lock.processIdentity) return undefined;
    const url = new URL(await mintUsageBootstrap(lock, deadline));
    const bootstrap = await localUsageRequest(lock.port, url.pathname + url.search, {}, deadline);
    const cookies = bootstrap.headers["set-cookie"];
    if (bootstrap.status !== 303 || !cookies?.[0]) return undefined;
    const status = await localUsageRequest(lock.port, "/api/status", { Cookie: cookies[0].split(";")[0]! }, deadline);
    const dto = JSON.parse(status.body) as { apiVersion?: number; revision?: string; data?: { serverBuild?: string; rateVersions?: unknown } };
    if (status.status !== 200 || dto.apiVersion !== 1 || !dto.revision?.startsWith(`${lock.instanceId}:`) || typeof dto.data?.serverBuild !== "string" ||
      (lock.serverBuild !== undefined && lock.serverBuild !== dto.data.serverBuild) ||
      !Array.isArray(dto.data.rateVersions) || dto.data.rateVersions.length > 64 || dto.data.rateVersions.some(rate => typeof rate !== "string" || rate.length > 160)) return undefined;
    return { serverBuild: dto.data.serverBuild, rateVersions: dto.data.rateVersions as string[] };
  } catch { return undefined; }
}
import { DashboardAssetsError } from "./dashboard-assets.js";
import { usageServerCrashCodes } from "./server-crash-codes.js";
export { usageServerCrashCodes } from "./server-crash-codes.js";
export type UsageServerCrashFailure = { code: string; mtimeMs: number };
function readCrashFd(fd: number): UsageServerCrashFailure[] {
  const info = fstatSync(fd);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) throw new Error("usage-server-record-invalid");
  const bytes = Buffer.alloc(Math.min(8192, info.size));
  const offset = Math.max(0, info.size - bytes.length);
  const length = readSync(fd, bytes, 0, bytes.length, offset);
  const rows = bytes.subarray(0, length).toString("utf8").split("\n");
  if (offset) rows.shift(); // Never interpret a partial code at the truncation boundary.
  return rows.flatMap(row => {
    // Legacy code-only rows have no recorded time. Retain their mtime estimate,
    // then freeze it when rewriting the bounded log rather than refreshing it.
    if (usageServerCrashCodes.has(row)) return [{ code: row, mtimeMs: Math.floor(info.mtimeMs) }];
    const parts = /^([a-z-]+) (\d{1,16})$/.exec(row);
    const timestamp = Number(parts?.[2]);
    return parts && usageServerCrashCodes.has(parts[1]!) && timestamp >= 0 && timestamp <= Date.now() + 5000
      ? [{ code: parts[1]!, mtimeMs: timestamp }] : [];
  });
}
export type UsageServerCrashDiagnostics = { codes: readonly string[]; failures: readonly UsageServerCrashFailure[]; mtimeMs: number };
function crashRows(failures: readonly UsageServerCrashFailure[]): string {
  return failures.map(({ code, mtimeMs }) => `${code} ${mtimeMs}\n`).join("");
}
export async function readUsageServerCrashDiagnostics(dir: string): Promise<UsageServerCrashDiagnostics | undefined> {
  let fd: number | undefined;
  try {
    try { assertPrivateServerDir(dir); }
    catch {
      assertPrivateServerDir(dirname(dir));
      dir = join(dirname(dir), "usage-server-failures");
      assertPrivateServerDir(dir);
    }
    fd = openSync(join(dir, "crash.log"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const failures = readCrashFd(fd);
    return { codes: failures.map(row => row.code), failures, mtimeMs: fstatSync(fd).mtimeMs };
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}
/** Compatibility reader for consumers that only need the bounded code list. */
export async function readUsageServerCrashCodes(dir: string): Promise<readonly string[]> {
  return (await readUsageServerCrashDiagnostics(dir))?.codes ?? [];
}
export async function writeUsageServerCrashCode(dir: string, code: string, until: number = Date.now() + 5000): Promise<void> {
  if (!usageServerCrashCodes.has(code)) return;
  let fd: number | undefined, temporary: string | undefined, acquired = false;
  const instanceId = randomBytes(16).toString("hex");
  let guard = join(dir, "crash.guard");
  const processIdentity = await usageProcessIdentity(process.pid, until);
  try {
    try { await ensurePrivateServerDir(dir); }
    catch {
      // Do not write through an unsafe directory. Diagnostics use a private sibling,
      // only when the parent itself is already private and owned. Never chmod the parent.
      assertPrivateServerDir(dirname(dir));
      dir = join(dirname(dir), "usage-server-failures");
      await ensurePrivateServerDir(dir); guard = join(dir, "crash.guard");
    }
    while (!acquired) {
      try {
        await writeServerRecord(guard, { version: 1, instanceId, pid: process.pid, processIdentity: processIdentity ?? null, createdAt: Date.now() }, true);
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= until) return;
        await reclaimStaleServerRecord(guard, pid => usageProcessIdentity(pid, until));
        await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(10, until - Date.now()))));
      }
    }
    const log = join(dir, "crash.log");
    let failures: UsageServerCrashFailure[] = [];
    try {
      fd = openSync(log, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      failures = readCrashFd(fd); // Validate before replacing whole code-only timestamp rows.
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    failures.push({ code, mtimeMs: Date.now() });
    while (Buffer.byteLength(crashRows(failures)) > 8192) failures.shift();
    // Cap enforcement and legacy conversion share the append guard. Never refresh
    // an older row's time just because a different code is written today.
    temporary = `${log}.${randomBytes(16).toString("hex")}`;
    writeFileSync(temporary, crashRows(failures), { flag: "wx", mode: 0o600 });
    renameSync(temporary, log);
  } catch { /* Diagnostics never follow links or expose exception text. */ }
  finally {
    if (fd !== undefined) closeSync(fd);
    if (temporary) try { unlinkSync(temporary); } catch { /* Renamed or already gone. */ }
    if (acquired) await removeServerRecord(guard, instanceId);
  }
}

/** Bun binaries and SEA cannot run a Node child script; probe the actual executable too. */
const nodeCapabilities = new Map<string, Promise<boolean>>();
export function usableUsageNode(deadline: number): Promise<boolean> {
  let cached = nodeCapabilities.get(process.execPath);
  if (!cached) {
    const executable = process.execPath;
    cached = probeUsageNode(deadline).then(ok => {
      if (!ok && nodeCapabilities.get(executable) === cached) nodeCapabilities.delete(executable);
      return ok;
    });
    nodeCapabilities.set(executable, cached);
  }
  return cached;
}
async function probeUsageNode(deadline: number): Promise<boolean> {
  let sea = false;
  try { sea = process.getBuiltinModule?.("node:sea")?.isSea?.() ?? false; } catch { /* Optional builtin. */ }
  if (process.versions.bun || sea) return false;
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["--input-type=commonjs", "--eval", 'process.stdout.write(process.versions.node && !process.versions.bun ? "spider-node" : "")'],
      { detached: true, stdio: ["ignore", "pipe", "ignore"], env: usageServerEnv() });
    let output = "", settled = false;
    const finish = (ok: boolean) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), Math.max(1, Math.min(USAGE_PROCESS_CHECK_TIMEOUT_MS, deadline - Date.now())));
    child.stdout?.on("data", bytes => { output += bytes.toString(); if (output.length > 32) finish(false); });
    child.once("error", () => finish(false)); child.once("close", code => finish(code === 0 && output === "spider-node"));
  });
}
function buildTime(id: unknown): number | undefined {
  if (typeof id !== "string") return undefined;
  const match = /^[^@\s]+@(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(id);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return undefined;
  const day = Date.parse(`${match[1]}T00:00:00Z`), time = Date.parse(id.slice(id.indexOf("@") + 1));
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== match[1]) return undefined;
  return Number.isFinite(time) ? time : undefined;
}
function newerBuild(launcher: unknown, server: unknown): boolean {
  const next = buildTime(launcher), loaded = buildTime(server);
  return next !== undefined && loaded !== undefined && next > loaded;
}
class ChildReportedStartupError extends Error {}
let invalidBuildReported = false;
export async function ensureUsageServer(options: UsageServerLaunchOptions, policy: { deadlineMs?: number } = {}): Promise<UsageServerLaunch> {
  const deadlineMs = policy.deadlineMs ?? USAGE_LAUNCH_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error("usage-server-startup-invalid");
  const until = Date.now() + deadlineMs;
  try { return await ensureServer(options, until); }
  catch (error) {
    const message = error instanceof DashboardAssetsError ? error.code : error instanceof Error ? error.message : "";
    const code = usageServerCrashCodes.has(message) ? message : "usage-server-startup-invalid";
    if (!(error instanceof ChildReportedStartupError) && typeof options.lockFile === "string" && isAbsolute(options.lockFile)) await writeUsageServerCrashCode(dirname(options.lockFile), code, until);
    throw new Error(code);
  }
}
async function ensureServer(options: UsageServerLaunchOptions, until: number): Promise<UsageServerLaunch> {
  if (process.platform === "win32" || !process.getuid) throw new Error("usage-server-unsupported-platform");
  const bundle = nativeUsageBundle(options.bundleUrl);
  if (!isAbsolute(options.lockFile) || !["auto", "off"].includes(options.calibrationMode)) throw new Error("usage-server-startup-invalid");
  const dir = dirname(options.lockFile); await ensurePrivateServerDir(dir);
  if (buildTime(options.serverBuild) === undefined && !invalidBuildReported) {
    invalidBuildReported = true;
    await writeUsageServerCrashCode(dir, "usage-server-build-invalid", until);
  }
  const instanceId = randomBytes(16).toString("hex"), secret = randomBytes(32).toString("base64url");
  const guard = `${options.lockFile}.guard`, startup = join(dir, "startup.json");
  const intentFile = join(dir, "replace-intent.json");
  const processIdentity = await usageProcessIdentity(process.pid, until);
  const pause = () => new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(100, until - Date.now()))));
  const ownIntent = { version: 1, instanceId, serverBuild: options.serverBuild, pid: process.pid, processIdentity, expiresAt: Date.now() + 10_000 };
  const publishIntent = () => processIdentity ? publishServerIntent(intentFile, ownIntent, current =>
    typeof current.expiresAt === "number" && current.expiresAt > Date.now() && newerBuild(current.serverBuild, options.serverBuild), until) : Promise.resolve(false);
  const liveIntent = async (): Promise<Record<string, unknown> | undefined> => {
    let marker: Record<string, unknown> | undefined;
    try { marker = await readServerRecord(intentFile); } catch { await removeServerIntent(intentFile); return undefined; }
    if (!marker) return undefined;
    if (typeof marker.expiresAt === "number" && marker.expiresAt > Date.now() &&
      typeof marker.processIdentity === "string" && Number.isSafeInteger(marker.pid) && (marker.pid as number) > 0) {
      if (marker.pid === process.pid && marker.processIdentity === processIdentity) return marker;
      try {
        process.kill(marker.pid as number, 0);
        if (legacyUsageProcessIdentity(marker.processIdentity)) return marker;
        const current = await usageProcessIdentity(marker.pid as number, until);
        // A timed-out birth lookup is unknown, not proof that this live publisher died.
        if (!current || current === marker.processIdentity) return marker;
      } catch { /* Expired, dead or foreign-user intent is inert. */ }
    }
    // This function is called only under the launch guard. Fence cleanup by publisher.
    if (typeof marker.instanceId === "string") await removeServerIntent(intentFile, marker);
    return undefined;
  };
  let createdAt = 0, acquired = false, succeeded = false;
  const ownership = () => ({ file: guard, instanceId, createdAt });
  const refreshGuard = async () => {
    const nextCreatedAt = Date.now();
    await writeServerRecord(guard, { version: 1, instanceId, pid: process.pid, processIdentity: processIdentity ?? null, createdAt: nextCreatedAt }, false, ownership());
    createdAt = nextCreatedAt;
  };
  const ownerAlive = async (lock: UsageServerLock): Promise<boolean> => {
    if (acquired) await refreshGuard();
    try { process.kill(lock.pid, 0); }
    catch (error) { if (["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; return true; }
    const current = await usageProcessIdentity(lock.pid, until);
    return !current || !lock.processIdentity || legacyUsageProcessIdentity(lock.processIdentity) || current === lock.processIdentity;
  };
  // null means yield the guard to a pending newer launcher, not permission to spawn.
  const reuse = async (): Promise<UsageServerLaunch | null | undefined> => {
    let lock: UsageServerLock | undefined;
    try { lock = await readUsageServerLock(options.lockFile); }
    catch { await reclaimStaleServerRecord(options.lockFile, pid => usageProcessIdentity(pid, until)); return undefined; }
    if (!lock) { await reclaimStaleServerRecord(options.lockFile, pid => usageProcessIdentity(pid, until)); return undefined; }
    if (legacyUsageProcessIdentity(lock.processIdentity) &&
      await reclaimStaleServerRecord(options.lockFile, pid => usageProcessIdentity(pid, until))) return undefined;
    let loaded = await authenticatedOwner(lock, until);
    while (!loaded) {
      // A slow main thread is not a dead owner. Only a proven death or birth mismatch permits spawn.
      if (!await ownerAlive(lock)) return undefined;
      if (Date.now() >= until) throw new Error("usage-server-busy");
      await pause();
      loaded = await authenticatedOwner(lock, until);
    }
    if (newerBuild(options.serverBuild, loaded.serverBuild)) {
      // Signal only a just-authenticated, identity-matched owner, never a bare recorded PID.
      const latest = await readUsageServerLock(options.lockFile);
      if (latest?.instanceId !== lock.instanceId || latest.pid !== lock.pid ||
        await usageProcessIdentity(lock.pid, until) !== lock.processIdentity) {
        if (await ownerAlive(lock)) throw new Error("usage-server-busy");
        return undefined;
      }
      try { process.kill(lock.pid, "SIGTERM"); }
      catch {
        if (await ownerAlive(lock)) throw new Error("usage-server-busy");
        return undefined;
      }
      // Never shorten graceful close to fit a spent launch budget. A later launcher
      // can finish replacement, but this one must not kill before the close budget.
      const fallbackAt = Date.now() + USAGE_REPLACEMENT_GRACE_MS;
      // Replacement owns its close budget. Do not spend the child's startup window
      // or force the final birth check to time out before a full graceful drain.
      until = Math.max(until, fallbackAt + USAGE_PROCESS_CHECK_TIMEOUT_MS);
      while (Date.now() < fallbackAt) {
        await refreshGuard();
        if (await usageProcessIdentity(lock.pid, until) !== lock.processIdentity) break;
        await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(100, fallbackAt - Date.now()))));
      }
      await refreshGuard();
      if (await usageProcessIdentity(lock.pid, until) === lock.processIdentity) {
        assertServerRecordOwner(ownership());
        try { process.kill(-lock.pid, "SIGKILL"); } catch { /* Already exited. */ }
      }
      while (Date.now() < until && await ownerAlive(lock)) await pause();
      if (await ownerAlive(lock)) throw new Error("usage-server-busy");
      // Only a confirmed replacement exit earns a fresh bounded startup budget.
      until = Math.max(until, Date.now() + USAGE_STARTUP_WINDOW_MS);
      return undefined;
    }
    const marker = await liveIntent();
    if (marker && newerBuild(marker.serverBuild, options.serverBuild)) return null;
    const bootstrapUrl = await mintUsageBootstrap(lock, until);
    const latestIntent = await liveIntent();
    if (latestIntent && newerBuild(latestIntent.serverBuild, options.serverBuild)) return null;
    return { pid: lock.pid, port: lock.port!, bootstrapUrl, reused: true, ...loaded };
  };
  let child: ReturnType<typeof spawn> | undefined;
  try {
    // Publish even on cold starts. A fixed bounded admission window lets concurrent
    // launchers advertise before any of them replaces or spawns a server.
    await publishIntent();
    // A queued launcher already has an admission window. Do not add a second
    // delay after an external guard is released; preserve the 100 ms polling bound.
    let queued = false;
    try { queued = await readServerRecord(guard) !== undefined; } catch { queued = true; }
    const admitAt = Date.now() + (queued ? 0 : 400);
    if (!await usableUsageNode(until)) throw new Error("usage-server-unsupported-runtime");
    if (Date.now() < admitAt) await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(admitAt - Date.now(), until - Date.now()))));
    while (Date.now() < until) {
      try {
        createdAt = Date.now();
        await writeServerRecord(guard, { version: 1, instanceId, pid: process.pid, processIdentity: processIdentity ?? null, createdAt }, true);
        acquired = true;
        await sweepServerRecordTemps(dir);
        const pending = await liveIntent();
        // Compare to this launcher, not the loaded server. Equal builds never yield.
        if (pending && newerBuild(pending.serverBuild, options.serverBuild)) {
          await removeServerRecord(guard, instanceId); acquired = false;
          if (Date.now() >= until) throw new Error("usage-server-busy");
          await pause(); continue;
        }
        await publishIntent();
        const existing = await reuse();
        if (existing) return existing;
        if (existing === null) {
          await removeServerRecord(guard, instanceId); acquired = false;
          await pause(); continue;
        }
        break;
      } catch (error) {
        if (acquired || error instanceof Error && error.message === "usage-server-busy") throw error;
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("usage-server-startup-invalid");
        await reclaimStaleServerRecord(guard, pid => usageProcessIdentity(pid, until));
        await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(100, until - Date.now()))));
      }
    }
    if (!acquired || Date.now() >= until) throw new Error("usage-server-busy");
    await reclaimStaleServerRecord(startup, pid => usageProcessIdentity(pid, until));
    // Re-arm the guard/secret window after replacement, not at guard acquisition.
    await refreshGuard();
    await writeServerRecord(startup, { version: 1, instanceId, secret, createdAt,
      options: { bundleUrl: bundle, roots: options.roots, lockFile: options.lockFile, serverBuild: options.serverBuild,
        calibrationMode: options.calibrationMode, calibrationConfigFile: options.calibrationConfigFile } }, false, ownership());
    assertServerRecordOwner(ownership());
    child = spawn(process.execPath, [bundle, "--spider-usage-server", startup], { detached: true, stdio: "ignore", cwd: dir, env: usageServerEnv() });
    let stopped = false;
    const failed = new Promise<never>((_, reject) => {
      child!.once("error", () => { stopped = true; reject(new Error("usage-server-spawn-failed")); });
      child!.once("exit", () => { stopped = true;
        void readUsageServerCrashDiagnostics(dir).then(diagnostics => {
          const code = diagnostics?.failures.findLast(row => row.mtimeMs >= createdAt && row.code.startsWith("usage-dashboard-"))?.code;
          reject(code ? new ChildReportedStartupError(code) : new Error("usage-server-not-ready"));
        }, () => reject(new Error("usage-server-not-ready")));
      });
    });
    child.unref();
    const ready = async (): Promise<UsageServerLaunch | null> => {
      while (!stopped && Date.now() < until) {
        let lock: UsageServerLock | undefined;
        try { lock = await readUsageServerLock(options.lockFile); } catch { /* A concurrent publication is busy, not invalid. */ }
        if (lock?.instanceId === instanceId && lock.port) {
          const pending = await liveIntent();
          if (pending && newerBuild(pending.serverBuild, options.serverBuild)) return null;
          const loaded = await authenticatedOwner(lock, until);
          if (loaded) {
            const pending = await liveIntent();
            if (pending && newerBuild(pending.serverBuild, options.serverBuild)) return null;
            const bootstrapUrl = await mintUsageBootstrap(lock, until);
            const latestIntent = await liveIntent();
            if (latestIntent && newerBuild(latestIntent.serverBuild, options.serverBuild)) return null;
            return { pid: lock.pid, port: lock.port, bootstrapUrl, reused: false, ...loaded };
          }
        }
        await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(100, until - Date.now()))));
      }
      throw new Error("usage-server-not-ready");
    };
    try {
      const result = await Promise.race([ready(), failed]); succeeded = true;
      if (result) return result;
      // Keep the healthy child for the newer launcher to authenticate and replace.
      await removeServerRecord(startup, instanceId); await removeServerRecord(guard, instanceId); acquired = false;
      await pause();
      return await ensureServer(options, until);
    } finally { stopped = true; }
  } finally {
    if (child?.pid && !succeeded) try { process.kill(-child.pid, "SIGKILL"); } catch { /* Own child already exited. */ }
    // Intent deletion is compare-and-delete under the launch guard, including a
    // final nonblocking acquisition after a yield deadline. Never delete a successor.
    if (!acquired) {
      try {
        createdAt = Date.now();
        await writeServerRecord(guard, { version: 1, instanceId, pid: process.pid, processIdentity: processIdentity ?? null, createdAt }, true);
        acquired = true;
      } catch { /* A guard holder will sweep an expired/dead intent. */ }
    }
    if (acquired) {
      try { assertServerRecordOwner(ownership()); } catch { acquired = false; }
    }
    if (acquired) {
      await removeServerIntent(intentFile, ownIntent);
      await removeServerRecord(startup, instanceId); await removeServerRecord(guard, instanceId);
    }
  }
}
