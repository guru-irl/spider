import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync,
  readFileSync, realpathSync, statSync, unlinkSync, writeFileSync,
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

function checkOwner(stat: Stats, options: MachineIdentityOptions): void {
  if (isWindows(options)) return;
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  if (uid !== undefined && stat.uid !== uid) throw new Error("Foreign-owned machine identity path");
}

function checkDirectory(path: string, privateMode: boolean, options: MachineIdentityOptions): void {
  if (isWindows(options)) {
    if (!statSync(path).isDirectory()) throw new Error("Unsafe machine identity directory");
    return;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    checkOwner(stat, options);
    if (!stat.isDirectory()) throw new Error("Unsafe machine identity directory");
    if (privateMode && (stat.mode & 0o7777) !== 0o700) fchmodSync(fd, 0o700);
  } finally { closeSync(fd); }
}

function syncDirectory(path: string, options: MachineIdentityOptions): void {
  if (isWindows(options)) return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function readIdentity(file: string, options: MachineIdentityOptions): MachineId {
  const fd = openSync(file, constants.O_RDONLY | (isWindows(options) ? 0 : constants.O_NOFOLLOW));
  try {
    const stat = fstatSync(fd);
    checkOwner(stat, options);
    if (!stat.isFile()) throw new Error("Unsafe machine identity file");
    if (!isWindows(options) && (stat.mode & 0o7777) !== 0o600) fchmodSync(fd, 0o600);
    let value: unknown;
    try { value = JSON.parse(readFileSync(fd, "utf8")); } catch { throw new Error("Invalid machine identity file"); }
    if (typeof value !== "object" || value === null || !("machineId" in value) ||
      typeof value.machineId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.machineId)) {
      throw new Error("Invalid machine identity file");
    }
    return value.machineId;
  } finally { closeSync(fd); }
}

/** Admission must not create a replacement identity when the recorded one is missing. */
export function readMachineIdentity(globalRoot: string, options: MachineIdentityOptions = {}): MachineId {
  const root = realpathSync(globalRoot);
  checkDirectory(root, false, options);
  const directory = join(root, "roam");
  checkDirectory(directory, true, options);
  return readIdentity(join(directory, "machine.json"), options);
}

export function loadMachineIdentity(globalRoot: string, options: MachineIdentityOptions = {}): MachineId {
  mkdirSync(globalRoot, { recursive: true, mode: 0o700 });
  const root = realpathSync(globalRoot);
  checkDirectory(root, false, options);
  const directory = join(root, "roam");
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  checkDirectory(directory, true, options);
  syncDirectory(root, options);
  const file = join(directory, "machine.json");
  try { return readIdentity(file, options); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (isWindows(options)) {
    let fd: number;
    try { fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return readIdentity(file, options);
      throw error;
    }
    try {
      writeFileSync(fd, `${JSON.stringify({ machineId: randomUUID() })}\n`);
      fsyncSync(fd);
    } catch (error) {
      try { unlinkSync(file); } catch { /* preserve the original error */ }
      throw error;
    } finally { closeSync(fd); }
    return readIdentity(file, options);
  }

  const temporary = join(directory, `.machine-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    checkOwner(stat, options);
    if (!stat.isFile()) throw new Error("Unsafe machine identity file");
    if ((stat.mode & 0o7777) !== 0o600) fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify({ machineId: randomUUID() })}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    try { linkSync(temporary, file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    syncDirectory(directory, options);
    return readIdentity(file, options);
  } finally {
    unlinkSync(temporary);
  }
}
