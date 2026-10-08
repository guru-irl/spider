import { LOADED_BUILD } from "../build-id.js";
import { readLayer } from "../control.js";
import { readUsageConfig } from "./config.js";
import { isMainThread } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { openDashboardReader } from "./dashboard-reader.js";
import { DASHBOARD_ROUTES } from "./api-routes.js";
import type { ServerIngestOptions } from "./server-ingest.js";
import { loadDashboardAssets, DashboardAssetsError } from "./dashboard-assets.js";
import { startUsageHttpServerWithAssets } from "./server.js";
import type { DashboardReader, IngestHandle } from "./dashboard-contract.js";
import { usageProcessIdentity, writeUsageServerCrashCode, type UsageServerLaunchOptions } from "./server-runtime.js";
import { ensurePrivateServerDir, readServerRecord, removeOwnedUsageServerLock, removeServerRecord, validInstance, validSecret, writeServerRecord } from "./server-lock.js";

import { USAGE_PARTICIPANT_STOP_MS, USAGE_STARTUP_WINDOW_MS } from "./server-lifecycle.js";

export function isUsageServerMain(moduleUrl: string | URL, argv: readonly string[] = process.argv, mainThread: boolean = isMainThread): boolean {
  try {
    const url = moduleUrl instanceof URL ? moduleUrl : /^[a-z][a-z\d+.-]*:/i.test(moduleUrl) ? new URL(moduleUrl) : pathToFileURL(moduleUrl);
    return mainThread && url.protocol === "file:" && argv.length === 4 && argv[2] === "--spider-usage-server" &&
      resolve(argv[1]!) === fileURLToPath(url) && !!argv[3];
  } catch { return false; }
}
export type UsageServerParticipant = (options: ServerIngestOptions) => IngestHandle;
export type UsageServerBootOptions = UsageServerLaunchOptions & { instanceId: string; startParticipant?: UsageServerParticipant; dashboardDir: string };
export type UsageServerTestHook = { now?: () => number; idleMs?: number };
function resolvedCalibration(options: UsageServerLaunchOptions): "auto" | "off" {
  if (!options.calibrationConfigFile) return options.calibrationMode;
  return readUsageConfig(readLayer(options.calibrationConfigFile).config, {}).value.calibration;
}
export async function bootUsageServer(options: UsageServerBootOptions, testHook: UsageServerTestHook = {}): Promise<void> {
  const assets = await loadDashboardAssets(options.dashboardDir);
  const serverBuild = `${LOADED_BUILD.sha}@${LOADED_BUILD.builtAt}`;
  const dir = dirname(options.lockFile); await ensurePrivateServerDir(dir);
  const record = await readServerRecord(join(dir, "startup.json"));
  const guard = await readServerRecord(`${options.lockFile}.guard`);
  const now = Date.now();
  if (!validInstance(options.instanceId) || record?.version !== 1 || guard?.version !== 1 || record.instanceId !== options.instanceId ||
    guard.instanceId !== options.instanceId || !validSecret(record.secret) || !Number.isSafeInteger(record.createdAt) ||
    guard.createdAt !== record.createdAt || now < (record.createdAt as number) || now >= (record.createdAt as number) + USAGE_STARTUP_WINDOW_MS ||
    !Number.isSafeInteger(guard.pid) || (guard.pid as number) <= 0) throw new Error("usage-server-startup-invalid");
  const secret = record.secret;
  if (!await removeServerRecord(join(dir, "startup.json"), options.instanceId)) throw new Error("usage-server-startup-invalid");
  const getCalibrationMode = () => resolvedCalibration(options);
  const participant = options.startParticipant?.({ bundleUrl: options.bundleUrl, roots: options.roots, getCalibrationMode });
  const ingestStatus = participant ? () => participant.snapshot() : undefined;
  const readerOptions = { instanceId: options.instanceId, now: testHook.now ?? Date.now, serverBuild,
    ingestStatus, calibrationMode: getCalibrationMode,
    monthlyBudget: () => options.calibrationConfigFile
      ? readUsageConfig(readLayer(options.calibrationConfigFile).config, {}).value.monthlyBudget : undefined };
  const openReader = () => openDashboardReader(options.roots.ledgerFile, readerOptions);
  let reader: DashboardReader | undefined;
  try { reader = openReader(); } catch { /* identity is usable without a ledger */ }
  async function stopParticipant(): Promise<boolean> {
    if (!participant) return false;
    let timedOut = false, timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([participant.stop(), new Promise<void>(resolve => {
      timer = setTimeout(() => { timedOut = true; resolve(); }, USAGE_PARTICIPANT_STOP_MS);
    })]); } finally { clearTimeout(timer); }
    return timedOut;
  }
  let close: () => Promise<void> = async () => {};
  const onSignal = () => { void close().catch(async () => { await writeUsageServerCrashCode(dir, "usage-server-close-failed"); process.exitCode = 1; }); };
  const onFatal = () => {
    process.exitCode = 1;
    void writeUsageServerCrashCode(dir, "usage-server-crashed").then(close).catch(() => {});
  };
  const server = await startUsageHttpServerWithAssets({ instanceId: options.instanceId, serverBuild,
    secret, reader, retryOpenReader: openReader, ingestStatus, now: testHook.now, idleMs: testHook.idleMs, routes: DASHBOARD_ROUTES, dashboardDir: options.dashboardDir,
    onClose: async () => {
      process.off("SIGTERM", onSignal); process.off("SIGINT", onSignal);
      process.off("uncaughtException", onFatal); process.off("unhandledRejection", onFatal);
      let timedOut = false;
      try {
        timedOut = await stopParticipant();
      } finally {
        await removeOwnedUsageServerLock(options.lockFile, options.instanceId);
        // A broken participant may retain its own handles. Let HTTP close its reader first,
        // then terminate only this standalone process, never a recorded or reused PID.
        if (timedOut && isUsageServerMain(options.bundleUrl)) setImmediate(() => process.exit(process.exitCode ? 1 : 0));
      }
    } }, assets).catch(async failure => {
      let timedOut = false;
      try { timedOut = await stopParticipant(); } finally { reader?.close(); }
      if (timedOut && isUsageServerMain(options.bundleUrl)) {
        await writeUsageServerCrashCode(dir, "usage-server-startup-invalid");
        setImmediate(() => process.exit(1));
      }
      throw failure;
    });
  close = server.close;
  process.on("SIGTERM", onSignal); process.on("SIGINT", onSignal);
  process.once("uncaughtException", onFatal); process.once("unhandledRejection", onFatal);
  try {
    const processIdentity = await usageProcessIdentity(process.pid);
    const latestGuard = await readServerRecord(`${options.lockFile}.guard`);
    if (!processIdentity || latestGuard?.instanceId !== options.instanceId || latestGuard.createdAt !== record.createdAt ||
      Date.now() >= (record.createdAt as number) + USAGE_STARTUP_WINDOW_MS) throw new Error("usage-server-startup-invalid");
    await writeServerRecord(options.lockFile, { version: 1, instanceId: options.instanceId, secret, pid: process.pid, port: server.port, processIdentity, serverBuild },
      false, { file: `${options.lockFile}.guard`, instanceId: options.instanceId, createdAt: record.createdAt as number });
  } catch {
    await server.close();
    throw new Error("usage-server-startup-invalid");
  }
}
export async function runUsageServerEntry(moduleUrl: string | URL, hooks: { startParticipant?: UsageServerParticipant; dashboardDir: string; testHook?: UsageServerTestHook }): Promise<void> {
  if (!isUsageServerMain(moduleUrl)) return;
  try {
    const file = process.argv[3]!;
    const record = await readServerRecord(file);
    const options = record?.options as UsageServerLaunchOptions | undefined;
    if (!record || record.version !== 1 || !validInstance(record.instanceId) || !validSecret(record.secret) || !options ||
      !Number.isSafeInteger(record.createdAt) || Date.now() < (record.createdAt as number) || Date.now() >= (record.createdAt as number) + USAGE_STARTUP_WINDOW_MS ||
      !isAbsolute(options.lockFile) || file !== join(dirname(options.lockFile), "startup.json") ||
      !["auto", "off"].includes(options.calibrationMode) || typeof options.serverBuild !== "string" || options.serverBuild.length > 160 ||
      (options.calibrationConfigFile !== undefined && (typeof options.calibrationConfigFile !== "string" || !isAbsolute(options.calibrationConfigFile) || options.calibrationConfigFile.length > 4096)) ||
      !options.roots || Object.keys(options.roots).sort().join() !== "authPath,leaseDir,ledgerFile,registryDb,sessionsDir" ||
      Object.values(options.roots).some(path => typeof path !== "string" || !isAbsolute(path) || path.length > 4096)) throw new Error("usage-server-startup-invalid");
    await bootUsageServer({ bundleUrl: moduleUrl, roots: options.roots, lockFile: options.lockFile,
      serverBuild: options.serverBuild, calibrationMode: options.calibrationMode, calibrationConfigFile: options.calibrationConfigFile,
      instanceId: record.instanceId, startParticipant: hooks.startParticipant, dashboardDir: hooks.dashboardDir }, hooks.testHook);
  } catch (error) {
    await writeUsageServerCrashCode(process.cwd(), error instanceof DashboardAssetsError ? error.code : "usage-server-startup-invalid");
    process.exitCode = 1;
  }
}
