import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";
import type { MachineId } from "./types";

function checkOwner(stat: Stats): void {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Foreign-owned machine identity path");
}

function checkDirectory(path: string, privateMode: boolean): void {
  const stat = lstatSync(path);
  checkOwner(stat);
  if (!stat.isDirectory() || (privateMode && (stat.mode & 0o7777) !== 0o700)) {
    throw new Error("Unsafe machine identity directory");
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function readIdentity(file: string): MachineId {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    checkOwner(stat);
    if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600) throw new Error("Unsafe machine identity file");
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
export function readMachineIdentity(globalRoot: string): MachineId {
  checkDirectory(globalRoot, false);
  const directory = join(globalRoot, "roam");
  checkDirectory(directory, true);
  return readIdentity(join(directory, "machine.json"));
}

export function loadMachineIdentity(globalRoot: string): MachineId {
  mkdirSync(globalRoot, { recursive: true, mode: 0o700 });
  checkDirectory(globalRoot, false);
  const directory = join(globalRoot, "roam");
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  checkDirectory(directory, true);
  syncDirectory(globalRoot);
  const file = join(directory, "machine.json");
  try { return readIdentity(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporary = join(directory, `.machine-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    checkOwner(stat);
    if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600) throw new Error("Unsafe machine identity file");
    writeFileSync(fd, `${JSON.stringify({ machineId: randomUUID() })}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    try { linkSync(temporary, file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    syncDirectory(directory);
    return readIdentity(file);
  } finally {
    unlinkSync(temporary);
  }
}
