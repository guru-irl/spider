import { spawn } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import net from "net";
import { randomUUID } from "crypto";
import { createMessageReader, writeMessage } from "./framing.js";
import {
  ensureIntercomRuntimeDir,
  getAgentDirPath,
  getBrokerConnectTarget,
  getIntercomDirPath,
  INTERCOM_PROTOCOL_NAME,
  INTERCOM_PROTOCOL_VERSION,
  INTERCOM_RUNTIME_FILE_MODE,
  restrictIntercomRuntimeFile,
  type BrokerConnectTarget,
} from "./paths.js";

const INTERCOM_DIR = getIntercomDirPath();
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

export function getCompiledBrokerPath(): string {
  return fileURLToPath(new URL(import.meta.spiderIntercomBrokerRelative ?? "../../../../dist/intercom/broker.mjs", import.meta.url));
}
const BROKER_STARTUP_STDERR_LIMIT = 4_000;

type BrokerLaunchSpec =
  | {
    kind: "direct";
    command: string;
    args: string[];
    captureStartupStderr: boolean;
  }
  | {
    kind: "windows-launcher";
    command: string;
    args: string[];
    launcherPath: string;
    launcherCommandLine: string;
    captureStartupStderr: boolean;
  };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("broker-start-aborted")); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(new Error("broker-start-aborted")); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function getTsxCliPath(extensionDir: string = EXTENSION_DIR): string {
  // Resolve tsx via Node's module resolution so it works regardless of whether
  // tsx is bundled under extensionDir/node_modules or hoisted to a workspace
  // root by npm. We resolve the tsx package main entry (its "exports" field
  // does not expose ./dist/cli.mjs as a subpath) and then locate cli.mjs next
  // to it. If resolution fails, prefer the flat plugin-store layout before the
  // legacy nested fallback.
  try {
    const requireFromExtension = createRequire(join(extensionDir, "package.json"));
    const tsxMain = requireFromExtension.resolve("tsx");
    return join(dirname(tsxMain), "cli.mjs");
  } catch {
    const siblingTsxCli = join(extensionDir, "..", "tsx", "dist", "cli.mjs");
    if (existsSync(siblingTsxCli)) {
      return siblingTsxCli;
    }
    return join(extensionDir, "node_modules", "tsx", "dist", "cli.mjs");
  }
}

function quoteWindowsArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function getWindowsHiddenLauncherPath(intercomDir: string = INTERCOM_DIR): string {
  return join(intercomDir, "broker-launch.vbs");
}

function usesDefaultBrokerCommand(brokerCommand: string, brokerArgs: string[]): boolean {
  return brokerCommand === "npx"
    && brokerArgs.length === 2
    && brokerArgs[0] === "--no-install"
    && brokerArgs[1] === "tsx";
}

function getNodeCommand(nodePath: string): string {
  const executableName = nodePath.split(/[\\/]/).pop();
  return executableName && /^node(?:js)?(?:\.exe)?$/i.test(executableName)
    ? nodePath
    : "node";
}

export function getWindowsBrokerCommandLine(
  brokerPath: string,
  extensionDir: string = EXTENSION_DIR,
  nodePath: string = process.execPath,
  brokerCommand = "npx",
  brokerArgs: string[] = ["--no-install", "tsx"],
): string {
  if (usesDefaultBrokerCommand(brokerCommand, brokerArgs)) {
    return [quoteWindowsArg(getNodeCommand(nodePath)), quoteWindowsArg(brokerPath)].join(" ");
  }

  return [quoteWindowsArg(brokerCommand), ...brokerArgs.map(quoteWindowsArg), quoteWindowsArg(brokerPath)].join(" ");
}

export function getWindowsHiddenLauncherScript(commandLine: string): string {
  return [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run "${commandLine.replace(/"/g, '""')}", 0, False`,
    'Set WshShell = Nothing',
    '',
  ].join("\r\n");
}

export function isBrokerHealthOkMessage(message: unknown, requestId: string): boolean {
  if (typeof message !== "object" || message === null || !("type" in message)) {
    return false;
  }
  const response = message as Record<string, unknown>;
  return response.type === "health_ok"
    && response.requestId === requestId
    && response.protocol === INTERCOM_PROTOCOL_NAME
    && response.version === INTERCOM_PROTOCOL_VERSION;
}

export function writeWindowsHiddenLauncher(
  commandLine: string,
  launcherPath: string = getWindowsHiddenLauncherPath(),
): string {
  ensureIntercomRuntimeDir(dirname(launcherPath));
  writeFileSync(launcherPath, `\uFEFF${getWindowsHiddenLauncherScript(commandLine)}`, {
    encoding: "utf16le",
    mode: INTERCOM_RUNTIME_FILE_MODE,
  });
  restrictIntercomRuntimeFile(launcherPath);
  return launcherPath;
}

export function getBrokerLaunchSpec(
  brokerPath: string,
  brokerCommand: string,
  brokerArgs: string[],
  extensionDir: string = EXTENSION_DIR,
  platform: NodeJS.Platform = process.platform,
  intercomDir: string = INTERCOM_DIR,
  nodePath: string = process.execPath,
): BrokerLaunchSpec {
  if (platform === "win32") {
    const launcherPath = getWindowsHiddenLauncherPath(intercomDir);
    return {
      kind: "windows-launcher",
      command: "wscript.exe",
      args: ["//E:VBScript", launcherPath],
      launcherPath,
      launcherCommandLine: getWindowsBrokerCommandLine(brokerPath, extensionDir, nodePath, brokerCommand, brokerArgs),
      captureStartupStderr: false,
    };
  }

  if (usesDefaultBrokerCommand(brokerCommand, brokerArgs)) {
    return {
      kind: "direct",
      command: getNodeCommand(nodePath),
      args: [brokerPath],
      captureStartupStderr: true,
    };
  }

  return {
    kind: "direct",
    command: brokerCommand,
    args: [...brokerArgs, brokerPath],
    captureStartupStderr: false,
  };
}

export function getBrokerSpawnOptions(
  extensionDir: string = EXTENSION_DIR,
  env: NodeJS.ProcessEnv = process.env,
  captureStderr = true,
): {
  detached: true;
  stdio: "ignore" | ["ignore", "ignore", "pipe"];
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsHide: true;
} {
  return {
    detached: true,
    stdio: captureStderr ? ["ignore", "ignore", "pipe"] : "ignore",
    cwd: extensionDir,
    env: { ...env, PI_CODING_AGENT_DIR: getAgentDirPath(env), NODE_NO_WARNINGS: "1" },
    windowsHide: true,
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export interface BrokerSpawnOptions { agentDir?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }
export async function spawnBrokerIfNeeded(brokerCommand: string, brokerArgs: string[], options: BrokerSpawnOptions = {}): Promise<void> {
  if (options.signal?.aborted) throw new Error("broker-start-aborted");
  const env = { ...(options.env ?? process.env), ...(options.agentDir ? { PI_CODING_AGENT_DIR: options.agentDir } : {}) };
  const intercomDir = getIntercomDirPath(getAgentDirPath(env));
  const pidPath = join(intercomDir, "broker.pid"), lockPath = join(intercomDir, "broker.spawn.lock");
  const context = { env, pidPath, signal: options.signal };
  ensureIntercomRuntimeDir(intercomDir);

  if (await isBrokerRunning(context)) {
    return;
  }

  const ownsLock = acquireSpawnLock(lockPath);
  if (!ownsLock) {
    await waitForBroker(context);
    return;
  }

  try {
    if (await isBrokerRunning(context)) {
      return;
    }

    const brokerPath = getCompiledBrokerPath();
    if (options.signal?.aborted) throw new Error("broker-start-aborted");
    const launch = getBrokerLaunchSpec(brokerPath, brokerCommand, brokerArgs, EXTENSION_DIR, process.platform, intercomDir);
    if (launch.kind === "windows-launcher") {
      writeWindowsHiddenLauncher(launch.launcherCommandLine, launch.launcherPath);
    }
    const child = spawn(launch.command, launch.args, getBrokerSpawnOptions(EXTENSION_DIR, env, launch.captureStartupStderr));
    let brokerStderr = "";
    const rememberBrokerStderr = (chunk: Buffer | string) => {
      brokerStderr = `${brokerStderr}${chunk.toString()}`.slice(-BROKER_STARTUP_STDERR_LIMIT);
    };
    const brokerStartupError = (message: string, cause?: unknown) => {
      const stderr = brokerStderr.trim();
      const errorMessage = stderr ? `${message}\nBroker stderr:\n${stderr}` : message;
      return cause === undefined ? new Error(errorMessage) : new Error(errorMessage, { cause });
    };
    child.stderr?.on("data", rememberBrokerStderr);
    (child.stderr as net.Socket | null)?.unref();
    child.unref();

    await new Promise<void>((resolve, reject) => {
      const waitAbort = new AbortController();
      const signal = options.signal ? AbortSignal.any([options.signal, waitAbort.signal]) : waitAbort.signal;
      const cleanup = () => {
        waitAbort.abort();
        child.stderr?.off("data", rememberBrokerStderr);
        child.stderr?.resume();
        child.off("error", onError);
        child.off("close", onExit);
      };

      const onError = (error: Error) => {
        cleanup();
        reject(brokerStartupError(`Failed to spawn intercom broker: ${error.message}`, error));
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (launch.kind === "windows-launcher" && code === 0 && signal === null) {
          return;
        }
        cleanup();
        if (signal) {
          reject(brokerStartupError(`Intercom broker exited before startup with signal ${signal}`));
          return;
        }
        reject(brokerStartupError(`Intercom broker exited before startup with code ${code ?? "unknown"}`));
      };

      child.once("error", onError);
      child.once("close", onExit);
      waitForBroker({ ...context, signal }).then(() => {
        cleanup();
        resolve();
      }, (error) => {
        cleanup();
        const startupError = toError(error);
        reject(brokerStartupError(startupError.message, startupError));
      });
    });
  } finally {
    releaseSpawnLock(lockPath);
  }
}

interface ProbeContext { env: NodeJS.ProcessEnv; pidPath: string; signal?: AbortSignal }
async function isBrokerRunning(context: ProbeContext): Promise<boolean> {
  const state = await probeSocket(context);
  if (state === "compatible") return true;
  if (state === "occupied") throw new Error("unsupported-broker");
  if (!existsSync(context.pidPath)) return false;
  let pid: number;
  try { pid = Number(readFileSync(context.pidPath, "utf-8").trim()); }
  catch { throw new Error("unsupported-broker"); }
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("unsupported-broker");
  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw new Error("unsupported-broker");
  }
  throw new Error("unsupported-broker");
}

function connectToBrokerTarget(target: BrokerConnectTarget): net.Socket {
  return typeof target === "string"
    ? net.connect(target)
    : net.connect({ host: target.host, port: target.port });
}

function probeSocket(context: ProbeContext): Promise<"compatible" | "occupied" | "absent"> {
  return new Promise((resolve, reject) => {
    if (context.signal?.aborted) { reject(new Error("broker-start-aborted")); return; }
    let target: BrokerConnectTarget;
    try { target = getBrokerConnectTarget(process.platform, context.env); }
    catch { resolve("absent"); return; }
    const socket = connectToBrokerTarget(target), requestId = randomUUID();
    const expectedStateId = typeof target === "string" ? undefined : target.stateId;
    let settled = false, connected = false;
    const finish = (state: "compatible" | "occupied" | "absent", aborted = false) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); context.signal?.removeEventListener("abort", onAbort);
      socket.off("connect", onConnect); socket.off("error", onError); socket.off("data", reader); socket.destroy();
      if (aborted) reject(new Error("broker-start-aborted")); else resolve(state);
    };
    const onAbort = () => finish("occupied", true);
    const onConnect = () => {
      connected = true;
      try { writeMessage(socket, { type: "health", requestId, ...(expectedStateId ? { stateId: expectedStateId } : {}) }); }
      catch { finish("occupied"); }
    };
    const onError = (error: NodeJS.ErrnoException) => finish(!connected && (error.code === "ENOENT" || error.code === "ECONNREFUSED") ? "absent" : "occupied");
    const reader = createMessageReader(message => finish(isBrokerHealthOkMessage(message, requestId) ? "compatible" : "occupied"), () => finish("occupied"));
    const timeout = setTimeout(() => finish("occupied"), 1000);
    context.signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("connect", onConnect); socket.on("error", onError); socket.on("data", reader);
  });
}

function acquireSpawnLock(lockPath: string): boolean {
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, {
        flag: "wx",
        mode: INTERCOM_RUNTIME_FILE_MODE,
      });
      restrictIntercomRuntimeFile(lockPath);
      return true;
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (isSpawnLockStale(lockPath)) {
        try {
          unlinkSync(lockPath);
        } catch {
          // If we can't delete the stale lock, retry a few times before giving up
        }
        continue;
      }
      return false;
    }
  }
  return false;
}

function isSpawnLockStale(lockPath: string): boolean {
  if (!existsSync(lockPath)) {
    return false;
  }

  try {
    const [pidLine = "", createdAtLine = "0"] = readFileSync(lockPath, "utf-8").trim().split("\n");
    const pid = Number.parseInt(pidLine, 10);
    const createdAt = Number.parseInt(createdAtLine, 10);
    const ageMs = Date.now() - createdAt;

    if (Number.isSafeInteger(pid) && pid > 1) {
      try { process.kill(pid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    }
    return Number.isFinite(createdAt) && ageMs > 10_000;
  } catch {
    // An unreadable owner cannot safely be displaced.
    return false;
  }
}

function releaseSpawnLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Another cleanup path may already have removed the lock.
  }
}

async function waitForBroker(context: ProbeContext, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await probeSocket(context);
    if (state === "compatible") return;
    if (state === "occupied") throw new Error("unsupported-broker");
    await sleep(100, context.signal);
  }
  throw new Error("Broker failed to start within timeout");
}
