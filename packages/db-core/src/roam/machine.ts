import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";
import type { MachineId } from "./types";

export interface MachineIdentityOptions {
  platform?: NodeJS.Platform;
  uid?: number;
}

function isWindows(options: MachineIdentityOptions): boolean {
  return (options.platform ?? process.platform) === "win32";
}

function refuse(path: string, reason: string, repair: string): Error {
  return new Error(`Spider can't use the machine identity at ${path}: ${reason}. ${repair}, then retry.`);
}

function checkOwner(path: string, stat: Stats, options: MachineIdentityOptions): void {
  if (isWindows(options)) return;
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  if (uid !== undefined && stat.uid !== uid) {
    throw refuse(path, "Foreign-owned machine identity path", "Fix its ownership");
  }
}

function throwPathError(path: string, error: unknown): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ELOOP" || code === "ENOTDIR") {
    throw refuse(path, "expected a regular file or directory, not a symlink", "Remove the symlink or fix the path");
  }
  throw error;
}

function openNoFollow(path: string, flags: number): number {
  try { return openSync(path, flags); } catch (error) { throwPathError(path, error); }
}

function resolveRoot(path: string): string {
  try { return realpathSync(path); } catch (error) { throwPathError(path, error); }
}

function checkDirectory(path: string, privateMode: boolean, options: MachineIdentityOptions): void {
  if (isWindows(options)) {
    let stat: Stats;
    try { stat = statSync(path); } catch (error) { throwPathError(path, error); }
    if (!stat.isDirectory()) throw refuse(path, "Unsafe machine identity directory", "Fix the directory");
    return;
  }
  const fd = openNoFollow(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    checkOwner(path, stat, options);
    if (!stat.isDirectory()) throw refuse(path, "Unsafe machine identity directory", "Fix the directory");
    if (privateMode && (stat.mode & 0o7777) !== 0o700) fchmodSync(fd, 0o700);
  } finally { closeSync(fd); }
}

function syncDirectory(path: string, options: MachineIdentityOptions): void {
  if (isWindows(options)) return;
  const fd = openNoFollow(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function readIdentity(file: string, options: MachineIdentityOptions): MachineId {
  const fd = openNoFollow(file, constants.O_RDONLY | (isWindows(options) ? 0 : constants.O_NOFOLLOW));
  try {
    const stat = fstatSync(fd);
    checkOwner(file, stat, options);
    if (!stat.isFile()) throw refuse(file, "Unsafe machine identity file", "Fix the file type");
    if (!isWindows(options) && (stat.mode & 0o7777) !== 0o600) fchmodSync(fd, 0o600);
    let value: unknown;
    try { value = JSON.parse(readFileSync(fd, "utf8")); } catch {
      throw refuse(file, "Invalid machine identity file", "Fix it by restoring the identity from a trusted backup");
    }
    if (typeof value !== "object" || value === null || !("machineId" in value) ||
      typeof value.machineId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.machineId)) {
      throw refuse(file, "Invalid machine identity file", "Fix it by restoring the identity from a trusted backup");
    }
    return value.machineId;
  } finally { closeSync(fd); }
}

function cleanStaleTemps(directory: string, options: MachineIdentityOptions): void {
  // Recent files may belong to a writer that has not linked its identity yet.
  try {
    for (const name of readdirSync(directory)) {
      if (!/^\.machine-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/.test(name)) continue;
      const path = join(directory, name);
      try {
        const stat = lstatSync(path);
        const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
        if (stat.isFile() && Date.now() - stat.mtimeMs > 60_000 &&
          (isWindows(options) || uid === undefined || stat.uid === uid)) unlinkSync(path);
      } catch { /* another process may have removed it, or cleanup may be denied */ }
    }
  } catch { /* cleanup must not prevent use of an identity */ }
}

/** Admission must not create a replacement identity when the recorded one is missing. */
export function readMachineIdentity(globalRoot: string, options: MachineIdentityOptions = {}): MachineId {
  const root = resolveRoot(globalRoot);
  checkDirectory(root, false, options);
  const directory = join(root, "roam");
  checkDirectory(directory, true, options);
  return readIdentity(join(directory, "machine.json"), options);
}

function ensureMachineIdentity(globalRoot: string, options: MachineIdentityOptions, requested: MachineId | null): MachineId {
  const match = (id: MachineId): MachineId => {
    if (requested !== null && id !== requested) throw Object.assign(new Error("The existing machine identity differs from enrollment"), { code: "machine-mismatch" });
    return id;
  };
  try { mkdirSync(globalRoot, { recursive: true, mode: 0o700 }); }
  catch (error) { throwPathError(globalRoot, error); }
  const root = resolveRoot(globalRoot);
  checkDirectory(root, false, options);
  const directory = join(root, "roam");
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throwPathError(directory, error);
  }
  checkDirectory(directory, true, options);
  syncDirectory(root, options);
  const file = join(directory, "machine.json");
  try {
    const id = match(readIdentity(file, options));
    cleanStaleTemps(directory, options);
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporary = join(directory, `.machine-${randomUUID()}.tmp`);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (isWindows(options) ? 0 : constants.O_NOFOLLOW);
  let fd: number;
  try { fd = openSync(temporary, flags, 0o600); }
  catch (error) { throwPathError(temporary, error); }
  try {
    try {
      const stat = fstatSync(fd);
      checkOwner(temporary, stat, options);
      if (!stat.isFile()) throw refuse(temporary, "Unsafe machine identity file", "Fix the file type");
      if (!isWindows(options) && (stat.mode & 0o7777) !== 0o600) fchmodSync(fd, 0o600);
      writeFileSync(fd, `${JSON.stringify({ machineId: requested ?? randomUUID() })}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    try { linkSync(temporary, file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // A later reader can clean an old temp after another writer publishes.
        try { readIdentity(file, options); } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === "ENOENT") throw error;
          throw readError;
        }
      } else if ((error as NodeJS.ErrnoException).code !== "EEXIST") throwPathError(file, error);
    }
    syncDirectory(directory, options);
    const id = match(readIdentity(file, options));
    cleanStaleTemps(directory, options);
    return id;
  } finally {
    try { unlinkSync(temporary); } catch { /* cleanup is best effort */ }
  }
}

export function loadMachineIdentity(globalRoot: string, options: MachineIdentityOptions = {}): MachineId {
  return ensureMachineIdentity(globalRoot, options, null);
}

/** Publish an enrolled identity without replacing a different identity. */
export function claimMachineIdentity(globalRoot: string, machineId: MachineId, options: MachineIdentityOptions = {}): MachineId {
  if (typeof machineId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(machineId)) {
    throw new Error("Invalid requested machine identity");
  }
  return ensureMachineIdentity(globalRoot, options, machineId);
}
