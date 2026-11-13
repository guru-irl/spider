import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, rmSync, statSync, truncateSync, unlinkSync, writeSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { endianness, tmpdir } from "node:os";
import { join } from "node:path";
import { assertTestDbPath, openDbReadOnly, type Db } from "@spider/db-core";

// SQLite's ordinary read-only open can create -wal/-shm files or modify an
// existing -shm. Inspect private copies instead; never open a source with SQLite.
// A stable DB+WAL+SHM view is needed because checkpoints and commits can change
// what readers see. A changing view is retried, then refused.
const snapshots = new Set<string>();
let cleanupRegistered = false;
function cleanup(directory: string): void {
  snapshots.delete(directory);
  rmSync(directory, { recursive: true, force: true });
}
function register(directory: string): void {
  snapshots.add(directory);
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.once("exit", () => { for (const item of snapshots) { try { cleanup(item); } catch { /* process is exiting */ } } });
  }
}
class Changed extends Error {}
function prefix(file: string, length: number, position = 0): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const count = readSync(fd, bytes, offset, length - offset, position + offset);
      if (!count) throw new Error("Cannot verify the WAL commit boundary");
      offset += count;
    }
    return bytes;
  } finally { closeSync(fd); }
}
function constrainWal(walFile: string, index: Buffer | null): void {
  const size = statSync(walFile).size;
  if (size === 0) return;
  if (!index || size < 32 || index.length !== 96 || !index.subarray(0, 48).equals(index.subarray(48))) {
    throw new Error("Cannot verify the WAL commit boundary");
  }
  const little = endianness() === "LE";
  const word = (offset: number) => little ? index.readUInt32LE(offset) : index.readUInt32BE(offset);
  const short = (offset: number) => little ? index.readUInt16LE(offset) : index.readUInt16BE(offset);
  let first = 0, second = 0;
  for (let offset = 0; offset < 40; offset += 8) {
    first = (first + word(offset) + second) >>> 0;
    second = (second + word(offset + 4) + first) >>> 0;
  }
  const header = prefix(walFile, 32), magic = header.readUInt32BE(0);
  const pageSize = short(14) === 1 ? 65_536 : short(14), frames = word(16), pages = word(20);
  if (word(0) !== 3_007_000 || index[12] !== 1 || first !== word(40) || second !== word(44) ||
      magic !== 0x377f0682 && magic !== 0x377f0683 || index[13] !== (magic & 1) ||
      pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0 || header.readUInt32BE(8) !== pageSize ||
      !index.subarray(32, 40).equals(header.subarray(16, 24))) throw new Error("Cannot verify the WAL commit boundary");
  const end = 32 + frames * (pageSize + 24);
  if (!Number.isSafeInteger(end) || end > size) throw new Error("Cannot verify the WAL commit boundary");
  if (frames) {
    const last = prefix(walFile, 24, end - pageSize - 24);
    if (!last.readUInt32BE(0) || !last.readUInt32BE(4) || last.readUInt32BE(4) !== pages ||
        !last.subarray(8, 16).equals(header.subarray(16, 24)) ||
        last.readUInt32BE(16) !== word(24) || last.readUInt32BE(20) !== word(28)) throw new Error("Cannot verify the WAL commit boundary");
  }
  if (size > end) {
    if (size - end < 24) throw new Error("Cannot verify the WAL commit boundary");
    const extra = prefix(walFile, 24, end);
    if (extra.readUInt32BE(0) && extra.subarray(8, 16).equals(header.subarray(16, 24))) {
      throw new Error("WAL frames beyond the published commit boundary are changing or need recovery");
    }
  }
  truncateSync(walFile, end);
}
function stamp(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
function fileStamp(file: string): string | null {
  try {
    const stat = lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) {
      throw new Error("Unsafe diagnostic source");
    }
    return stamp(stat);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function copyStable(source: string, destination: string, expected: string): void {
  let input: number | undefined, output: number | undefined;
  try {
    try { input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Changed(); throw error; }
    const stat = fstatSync(input, { bigint: true });
    if (stamp(stat) !== expected) throw new Changed();
    const size = Number(stat.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Diagnostic source is too large");
    output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let position = 0;
    while (position < size) {
      const length = readSync(input, buffer, 0, Math.min(buffer.length, size - position), position);
      if (!length) throw new Changed();
      let written = 0;
      while (written < length) {
        const count = writeSync(output, buffer, written, length - written);
        if (count <= 0) throw new Error("Cannot write diagnostic snapshot");
        written += count;
      }
      position += length;
    }
    if (stamp(fstatSync(input, { bigint: true })) !== expected) throw new Changed();
  } finally {
    if (output !== undefined) closeSync(output);
    if (input !== undefined) closeSync(input);
  }
}

/** A bounded stable snapshot, including WAL and its commit index, removed on close. */
export function openDiagnosticSnapshot(file: string): Db | undefined {
  assertTestDbPath(file);
  for (let attempt = 0; attempt < 3; attempt++) {
    const main = fileStamp(file);
    if (main === null) return undefined;
    const walFile = `${file}-wal`, wal = fileStamp(walFile);
    const shmFile = `${file}-shm`, shm = fileStamp(shmFile);
    const directory = mkdtempSync(join(tmpdir(), "spider-roam-inspect-"));
    register(directory);
    try {
      const copy = join(directory, "snapshot.db");
      copyStable(file, copy, main);
      if (wal !== null) copyStable(walFile, `${copy}-wal`, wal);
      if (shm !== null) copyStable(shmFile, `${copy}-shm`, shm);
      const index = shm === null ? null : prefix(`${copy}-shm`, 96);
      if (fileStamp(file) !== main || fileStamp(walFile) !== wal || fileStamp(shmFile) !== shm ||
          index && !index.equals(prefix(shmFile, 96))) throw new Changed();
      if (wal !== null) constrainWal(`${copy}-wal`, index);
      if (shm !== null) unlinkSync(`${copy}-shm`); // SQLite rebuilds an index for the bounded copy.
      const db = openDbReadOnly(copy);
      if (!db) throw new Error("Diagnostic snapshot disappeared");
      return { ...db, close() { try { db.close(); } finally { cleanup(directory); } } };
    } catch (error) {
      cleanup(directory);
      if (error instanceof Changed && attempt < 2) continue;
      if (error instanceof Changed) throw new Error("Store changed while preparing a diagnostic snapshot");
      throw error;
    }
  }
  throw new Error("Cannot prepare a diagnostic snapshot");
}
