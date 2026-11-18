import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, rmSync, statSync, truncateSync, writeSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { endianness, tmpdir } from "node:os";
import { join } from "node:path";
import { assertTestDbPath, openDbReadOnly, type Db } from "@spider/db-core";

// SQLite's ordinary read-only open can create -wal/-shm files or modify an
// existing -shm. Inspect private copies instead; never open a source with SQLite.
// Frames through an index read taken after the main copy and before opening the
// WAL are immutable within that generation, even when later writes overwrite a
// stale tail in place. Validate the entire chosen prefix; retry generation resets.
// Linux coarse timestamps use jiffies (10 ms at HZ=100). Allow 50 ms,
// also covering APFS nanoseconds and the Linux clock used by WSL2 ext4.
// https://docs.kernel.org/filesystems/multigrain-ts.html
const timestampWindowMs = 50;
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
class MissingIndex extends Changed {
  constructor() { super("WAL commit index is missing while the store is opening or closing", "diagnostic-snapshot-wal-index-missing"); }
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
interface WalIndex {
  frames: number;
  pages: number;
  pageSize: number;
  first: number;
  second: number;
  salt: Buffer;
  bigEndChecksum: boolean;
}
function checksum(bytes: Buffer, bigEndian: boolean, first = 0, second = 0): [number, number] {
  const word = (offset: number) => bigEndian ? bytes.readUInt32BE(offset) : bytes.readUInt32LE(offset);
  for (let offset = 0; offset < bytes.length; offset += 8) {
    first = (first + word(offset) + second) >>> 0;
    second = (second + word(offset + 4) + first) >>> 0;
  }
  return [first, second];
}
function indexBytes(file: string): Buffer {
  // Keep both copies of the checksummed commit header together.
  try { return prefix(file, 96); }
  catch (error) {
    if (error instanceof InvalidWal) throw new Changed();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MissingIndex();
    throw error;
  }
}
function walIndex(index: Buffer): WalIndex {
  if (!index.subarray(0, 48).equals(index.subarray(48, 96)) || index[12] !== 1) throw new Changed();
  const bigEndian = endianness() === "BE";
  const word = (offset: number) => bigEndian ? index.readUInt32BE(offset) : index.readUInt32LE(offset);
  const short = (offset: number) => bigEndian ? index.readUInt16BE(offset) : index.readUInt16LE(offset);
  const [first, second] = checksum(index.subarray(0, 40), bigEndian);
  const pageSize = short(14) === 1 ? 65_536 : short(14);
  if (word(0) !== 3_007_000 || first !== word(40) || second !== word(44) || index[13] > 1 ||
      !(pageSize === 0 && word(16) === 0) && (pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0)) throw new InvalidWal();
  return { frames: word(16), pages: word(20), pageSize, first: word(24), second: word(28),
    salt: index.subarray(32, 40), bigEndChecksum: index[13] === 1 };
}
function sameGeneration(initial: WalIndex, limit: WalIndex, published: WalIndex): void {
  if (!initial.salt.equals(limit.salt) || !limit.salt.equals(published.salt) ||
      initial.pageSize !== limit.pageSize || limit.pageSize !== published.pageSize ||
      initial.frames > limit.frames || limit.frames > published.frames) throw new Changed();
}
function constrainWal(walFile: string, initial: WalIndex, limit: WalIndex, published: WalIndex): void {
  sameGeneration(initial, limit, published);
  const size = statSync(walFile).size;
  if (size === 0) {
    if (limit.frames !== 0) throw new Changed();
    return;
  }
  if (size < 32) throw new Changed();
  const header = prefix(walFile, 32), magic = header.readUInt32BE(0);
  // walRestartHdr publishes new index salts before rewriting/truncating the WAL.
  if (!limit.salt.equals(header.subarray(16, 24))) throw new Changed();
  if (magic !== 0x377f0682 && magic !== 0x377f0683 || header.readUInt32BE(4) !== 3_007_000 ||
      header.readUInt32BE(8) !== limit.pageSize || !!(magic & 1) !== limit.bigEndChecksum) throw new InvalidWal();
  let [first, second] = checksum(header.subarray(0, 24), limit.bigEndChecksum);
  if (first !== header.readUInt32BE(24) || second !== header.readUInt32BE(28)) throw new InvalidWal();
  const frameSize = limit.pageSize + 24, end = 32 + limit.frames * frameSize;
  if (end > size) throw new Changed();
  const available = Math.floor((size - 32) / frameSize);
  for (let frame = 1; frame <= available; frame++) {
    const bytes = prefix(walFile, frameSize, 32 + (frame - 1) * frameSize);
    const [nextFirst, nextSecond] = checksum(bytes.subarray(24), limit.bigEndChecksum,
      ...checksum(bytes.subarray(0, 8), limit.bigEndChecksum, first, second));
    const valid = bytes.readUInt32BE(0) !== 0 && bytes.subarray(8, 16).equals(limit.salt) &&
      nextFirst === bytes.readUInt32BE(16) && nextSecond === bytes.readUInt32BE(20);
    if (!valid) {
      if (frame <= limit.frames) throw new InvalidWal();
      break; // Stale generations, torn tails and uncommitted residue are ignored.
    }
    first = nextFirst; second = nextSecond;
    if (frame === limit.frames && (bytes.readUInt32BE(4) !== limit.pages || !limit.pages ||
        first !== limit.first || second !== limit.second)) throw new InvalidWal();
    if (frame > published.frames && bytes.readUInt32BE(4) !== 0) throw new Unpublished();
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
function copyStable(source: string, destination: string, expected: string, contentStable = true): BigIntStats {
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
    return stat;
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
    let observed: Buffer | null = null, indexFd: number | undefined;
    try {
      const copy = join(directory, "snapshot.db");
      if (shm !== null) {
        // A full close deletes the index; a reopen can recover the same empty
        // header. Pin its inode so reuse cannot hide that generation change.
        indexFd = openSync(shmFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        if (stamp(fstatSync(indexFd, { bigint: true }), false) !== shm) throw new Changed();
      }
      observed = shm === null ? null : indexBytes(shmFile);
      const initial = observed === null ? null : walIndex(observed);
      const started = Date.now(), copied = copyStable(file, copy, main);
      if (wal === null && shm === null) {
        const newest = copied.mtimeNs > copied.ctimeNs ? copied.mtimeNs : copied.ctimeNs;
        const ageMs = Number(BigInt(started) * 1_000_000n - newest) / 1_000_000;
        if (ageMs < timestampWindowMs) {
          // Same-tick writes can leave the stamps equal. Discard this copy,
          // waiting at most one window so the next attempt can use aged stamps.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(timestampWindowMs, Math.ceil(timestampWindowMs - ageMs)));
          throw new Changed();
        }
      }
      // This is the commit bound, not the pre-copy or post-WAL publication.
      const limit = shm === null ? null : walIndex(indexBytes(shmFile));
      if (wal !== null) {
        copyStable(walFile, `${copy}-wal`, wal, false);
        if (!initial || !limit) throw new MissingIndex();
        try { constrainWal(`${copy}-wal`, initial, limit, walIndex(indexBytes(shmFile))); }
        catch (error) {
          if (!(error instanceof Unpublished)) throw error;
          // Publication may follow the index read. Recheck the same finite
          // copy without chasing a newly extended or overwritten WAL tail.
          constrainWal(`${copy}-wal`, initial, limit, walIndex(indexBytes(shmFile)));
        }
      } else if (initial && limit) {
        sameGeneration(initial, limit, walIndex(indexBytes(shmFile)));
        if (limit.frames !== 0) throw new Changed();
      }
      if (fileStamp(file) !== main) throw new Changed();
      // An initially absent WAL and index must still be absent after the copy.
      if (fileStamp(walFile, false) !== wal || fileStamp(shmFile, false) !== shm ||
          indexFd !== undefined && fstatSync(indexFd).nlink === 0) throw new Changed();
      const db = openDbReadOnly(copy);
      if (!db) throw new Error("Diagnostic snapshot disappeared");
      try {
        const pages = db.pragma("page_count"); // Force private WAL recovery.
        if (limit) {
          const recovered = walIndex(indexBytes(`${copy}-shm`));
          if (recovered.frames !== limit.frames || limit.frames !== 0 &&
              (pages !== limit.pages || recovered.first !== limit.first || recovered.second !== limit.second)) throw new Changed();
        }
        return { ...db, close() { try { db.close(); } finally { cleanup(directory); } } };
      } catch (error) { db.close(); throw error; }
    } catch (caught) {
      let error = caught;
      try {
        if (error instanceof InvalidWal && (fileStamp(file) !== main || fileStamp(walFile, false) !== wal ||
            fileStamp(shmFile, false) !== shm || observed !== null && !prefix(shmFile, 96).equals(observed.subarray(0, 96)))) error = new Changed();
        if ((error as NodeJS.ErrnoException).code === "ENOENT") error = new Changed();
      } catch (changed) {
        if ((changed as NodeJS.ErrnoException).code === "ENOENT" || changed instanceof InvalidWal) error = new Changed();
        else error = changed;
      } finally { cleanup(directory); }
      if (error instanceof Changed && attempt < 2) continue;
      throw error;
    } finally { if (indexFd !== undefined) closeSync(indexFd); }
  }
  throw new Error("Cannot prepare a diagnostic snapshot");
}
