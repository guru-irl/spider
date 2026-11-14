import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { assertTestConfigPath } from "@spider/db-core";
import { withProcessLock, type ProcessLockOptions } from "@spider/herdr/sessions/registry";
import { isMachineId } from "./machine-id";

export type ProvisionLock = <T>(machineId: string, work: () => Promise<T>) => Promise<T>;

/** A target has one writer, while independent targets can progress concurrently. */
export function createProvisionLock(globalRoot: string, options: ProcessLockOptions = {}): ProvisionLock {
  const root = join(globalRoot, "roam");
  assertTestConfigPath(root);
  if (!isAbsolute(globalRoot) || resolve(globalRoot) !== realpathSync(globalRoot) || realpathSync(root) !== root) throw new Error("Unsafe roaming root");
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || typeof process.getuid === "function" && info.uid !== process.getuid() ||
      process.platform !== "win32" && (info.mode & 0o7777) !== 0o700) throw new Error("Unsafe roaming root");
  return async <T>(machineId: string, work: () => Promise<T>): Promise<T> => {
    if (!isMachineId(machineId)) throw new Error("Invalid target identity");
    return withProcessLock(root, `provision:${machineId}`, work, options);
  };
}
