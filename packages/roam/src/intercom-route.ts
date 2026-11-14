import { constants } from "node:fs";
import { chmod, lstat, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { assertTestConfigPath } from "@spider/db-core";
import { privateDirectory, readPrivateJson, withProcessLock, writePrivateJson } from "@spider/herdr/sessions/registry";

export interface HelperRouteLease { publish(token: string): Promise<void>; close(): Promise<void> }
const owned = (info: Awaited<ReturnType<typeof lstat>>): boolean => process.platform === "win32" || typeof process.getuid !== "function" || info.uid === process.getuid();
async function directory(path: string, privateMode: boolean): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !owned(info)) throw new Error("unsafe-helper-route");
  if (privateMode && process.platform !== "win32" && (info.mode & 0o7777) !== 0o700) await chmod(path, 0o700);
}
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await fd.sync(); } finally { await fd.close(); }
}
async function safeFile(file: string): Promise<boolean> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || !owned(info) || info.nlink !== 1 ||
        process.platform !== "win32" && (info.mode & 0o7777) !== 0o600) throw new Error("unsafe-helper-route");
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** A service owns one root until it closes; a stale process ticket is reclaimed by the shared lock. */
export async function acquireHelperRoute(globalRoot: string, agentDir: string, signal?: AbortSignal): Promise<HelperRouteLease> {
  if (!isAbsolute(globalRoot) || resolve(globalRoot) !== globalRoot || !isAbsolute(agentDir) || resolve(agentDir) !== agentDir) throw new Error("unsafe-helper-route");
  const roam = join(globalRoot, "roam"), base = join(roam, "intercom"), file = join(base, "helper.json");
  assertTestConfigPath(base);
  if (await realpath(globalRoot) !== globalRoot || await realpath(agentDir) !== agentDir) throw new Error("unsafe-helper-route");
  await directory(globalRoot, false); await directory(agentDir, false);
  for (const path of [roam, base]) { await privateDirectory(path); await directory(path, true); }
  await syncDirectory(globalRoot); await syncDirectory(roam);
  signal?.throwIfAborted();
  let release!: () => void, acquired!: () => void;
  const held = new Promise<void>(resolveHeld => { release = resolveHeld; });
  const ready = new Promise<void>(resolveReady => { acquired = resolveReady; });
  const lease = withProcessLock(base, "intercom-bridge-service", async () => { acquired(); await held; }, { signal });
  await Promise.race([ready, lease.then(() => { throw new Error("helper-route-lease-lost"); })]);
  let current: string | null = null, closed = false;
  return {
    async publish(token) {
      if (closed || !/^[0-9a-f]{64}$/.test(token)) throw new Error("unsafe-helper-route");
      await directory(base, true); await safeFile(file);
      await writePrivateJson(file, { version: 1, agentDir, token }); await syncDirectory(base); current = token;
    },
    async close() {
      if (closed) return; closed = true;
      try {
        if (current && await safeFile(file)) {
          const value = await readPrivateJson(file) as { token?: unknown; agentDir?: unknown } | null;
          if (value?.token === current && value.agentDir === agentDir) { await unlink(file); await syncDirectory(base); }
        }
      } finally { release(); await lease; }
    },
  };
}
