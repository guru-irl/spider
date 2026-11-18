import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, rmSync, statSync, truncateSync, writeSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { endianness, tmpdir } from "node:os";
import { join } from "node:path";
import { assertTestDbPath, openDbReadOnly, type Db } from "@spider/db-core";

// SQLite's ordinary read-only open can create -wal/-shm files or modify an
// existing -shm. Inspect private copies instead; never open a source with SQLite.
// Published WAL frames are immutable until a checkpoint/reset. Copy a finite
// prefix, bound it by an observed commit, and keep the main DB stable throughout.
// Appends may continue; checkpoints and generation changes are retried, then refused.
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
class Changed extends Error {
  constructor(message = "Store changed while preparing a diagnostic snapshot", readonly code = "diagnostic-snapshot-changing") { super(message); }
}
class Unpublished extends Changed {
  constructor() { super("WAL frames beyond the published commit boundary are changing or need recovery", "diagnostic-snapshot-wal-unpublished"); }
}
class InvalidWal extends Error {
  readonly code = "diagnostic-snapshot-wal-invalid";
  constructor() { super("Cannot verify the WAL commit boundary"); }
}
function prefix(file: string, length: number, position = 0): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const count = readSync(fd, bytes, offset, length - offset, position + offset);
      if (!count) throw new InvalidWal();
      offset += count;
    }
    return bytes;
  } finally { closeSync(fd); }
}
function walCommit(header: Buffer, index: Buffer | null): { end: number; frames: number; pages: number; first: number; second: number; salt: Buffer } {
  if (!index || index.length !== 96 || !index.subarray(0, 48).equals(index.subarray(48))) throw new InvalidWal();
  const little = endianness() === "LE";
  const word = (offset: number) => little ? index.readUInt32LE(offset) : index.readUInt32BE(offset);
  const short = (offset: number) => little ? index.readUInt16LE(offset) : index.readUInt16BE(offset);
  let first = 0, second = 0;
  for (let offset = 0; offset < 40; offset += 8) {
    first = (first + word(offset) + second) >>> 0;
    second = (second + word(offset + 4) + first) >>> 0;
  }
  const magic = header.readUInt32BE(0);
  const pageSize = short(14) === 1 ? 65_536 : short(14), frames = word(16), pages = word(20);
  if (word(0) !== 3_007_000 || index[12] !== 1 || first !== word(40) || second !== word(44) ||
      magic !== 0x377f0682 && magic !== 0x377f0683 || index[13] !== (magic & 1) ||
      pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0 || header.readUInt32BE(8) !== pageSize) throw new InvalidWal();
  const end = 32 + frames * (pageSize + 24);
  if (!Number.isSafeInteger(end)) throw new InvalidWal();
  return { end, frames, pages, first: word(24), second: word(28), salt: index.subarray(32, 40) };
}
function constrainWal(walFile: string, index: Buffer | null, publishedIndex: Buffer | null): void {
  const size = statSync(walFile).size;
  if (size === 0) return;
  if (size < 32) throw new InvalidWal();
  const header = prefix(walFile, 32), initial = walCommit(header, index), published = walCommit(header, publishedIndex);
  if (!initial.salt.equals(published.salt) || published.end < initial.end) throw new Changed();
  if (!initial.salt.equals(header.subarray(16, 24))) throw new InvalidWal();
  const commit = published.end <= size ? published : initial;
  const { end, frames, pages } = commit, pageSize = header.readUInt32BE(8);
  if (end > size) throw new InvalidWal();
  if (frames) {
    const last = prefix(walFile, 24, end - pageSize - 24);
    if (!last.readUInt32BE(0) || !last.readUInt32BE(4) || last.readUInt32BE(4) !== pages ||
        !last.subarray(8, 16).equals(header.subarray(16, 24)) ||
        last.readUInt32BE(16) !== commit.first || last.readUInt32BE(20) !== commit.second) throw new InvalidWal();
  }
  if (size > end) {
    if (size - end < 24) throw new InvalidWal();
    const extra = prefix(walFile, 24, end);
    if (extra.readUInt32BE(0) && extra.subarray(8, 16).equals(header.subarray(16, 24)) && published.end < size) throw new Unpublished();
  }
  truncateSync(walFile, end);
}
function stamp(stat: BigIntStats, contentStable = true): string {
  return (contentStable ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs] : [stat.dev, stat.ino]).join(":");
}
function fileStamp(file: string, contentStable = true): string | null {
  try {
    const stat = lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) {
      throw Object.assign(new Error("Unsafe diagnostic source"), { code: "diagnostic-snapshot-unsafe" });
    }
    return stamp(stat, contentStable);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function copyStable(source: string, destination: string, expected: string, contentStable = true): void {
  let input: number | undefined, output: number | undefined;
  try {
    try { input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Changed(); throw error; }
    const stat = fstatSync(input, { bigint: true });
    if (stamp(stat, contentStable) !== expected) throw new Changed();
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
    if (stamp(fstatSync(input, { bigint: true }), contentStable) !== expected) throw new Changed();
  } finally {
    if (output !== undefined) closeSync(output);
    if (input !== undefined) closeSync(input);
  }
}

/** A bounded snapshot at an observed WAL commit, removed on close. */
export function openDiagnosticSnapshot(file: string): Db | undefined {
  assertTestDbPath(file);
  for (let attempt = 0; attempt < 3; attempt++) {
    const main = fileStamp(file);
    if (main === null) return undefined;
    const walFile = `${file}-wal`, wal = fileStamp(walFile, false);
    const shmFile = `${file}-shm`, shm = fileStamp(shmFile, false);
    const directory = mkdtempSync(join(tmpdir(), "spider-roam-inspect-"));
    register(directory);
    try {
      const copy = join(directory, "snapshot.db");
      const index = shm === null ? null : prefix(shmFile, 96);
      copyStable(file, copy, main);
      if (wal !== null) {
        copyStable(walFile, `${copy}-wal`, wal, false);
        try { constrainWal(`${copy}-wal`, index, shm === null ? null : prefix(shmFile, 96)); }
        catch (error) {
          if (!(error instanceof Unpublished) || shm === null) throw error;
          // Publication may follow the index read. Recheck against the same finite
          // copy, not a new WAL tail that the writer can keep extending.
          constrainWal(`${copy}-wal`, index, prefix(shmFile, 96));
        }
      }
      if (fileStamp(file) !== main || fileStamp(walFile, false) !== wal || fileStamp(shmFile, false) !== shm) throw new Changed();
      const db = openDbReadOnly(copy);
      if (!db) throw new Error("Diagnostic snapshot disappeared");
      return { ...db, close() { try { db.close(); } finally { cleanup(directory); } } };
    } catch (error) {
      cleanup(directory);
      if (error instanceof Changed && attempt < 2) continue;
      throw error;
    }
  }
  throw new Error("Cannot prepare a diagnostic snapshot");
}
