import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readSync, readdirSync, renameSync, rmSync, unlinkSync, writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { openDb, paths, withRetry } from "@spider/db-core";
import { isMachineId } from "./machine-id";
import type { ArtifactManifest, Limits } from "./contracts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;

/** The one default location for private artifact staging. */
export function defaultStagingRoot(): string { return join(paths.globalRoot, "roam", "staging"); }

/** Locks and quota pools are scoped to the same explicit staging root. */
export function transferLockRoot(root: string): string {
  if (!isAbsolute(root)) throw new Error("Invalid staging root");
  return join(root, "transfer-locks");
}

export function artifactId(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value) || /^quota\.db(?:-wal|-shm)?$/i.test(value)) throw new Error("Invalid artifact ID");
  return value;
}

export function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

function checkOwned(stat: Stats, directory: boolean): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if ((directory ? !stat.isDirectory() : !stat.isFile()) ||
      (process.platform !== "win32" && uid !== undefined && stat.uid !== uid)) {
    throw new Error("Unsafe staging path or foreign ownership");
  }
}

/** Create one private directory, refusing symlinks in any path component. */
export function privateDirectory(path: string): void {
  if (!isAbsolute(path)) throw new Error("Staging directory must be absolute");
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    let stat: Stats;
    try { stat = lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try { mkdirSync(current, { mode: 0o700 }); }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError; }
      stat = lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe staging path or symlink");
  }
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    checkOwned(stat, true);
    if (process.platform !== "win32" && (stat.mode & 0o7777) !== 0o700) fchmodSync(fd, 0o700);
  } finally { closeSync(fd); }
}

export function privateOutgoingArtifact(root: string, id: string): string {
  if (!isAbsolute(root)) throw new Error("Invalid staging root");
  const outgoing = join(root, "outgoing"), artifact = join(outgoing, artifactId(id));
  privateDirectory(root); privateDirectory(outgoing); privateDirectory(artifact);
  return artifact;
}

export function privateIncomingArtifact(root: string, peer: string, id: string): string {
  if (!isAbsolute(root) || !isMachineId(peer)) throw new Error("Invalid staging root or peer identity");
  const incoming = join(root, "incoming"), directory = join(incoming, peer);
  const artifacts = join(directory, "artifacts"), artifact = join(artifacts, artifactId(id));
  privateDirectory(root); privateDirectory(incoming); privateDirectory(directory);
  privateDirectory(artifacts); privateDirectory(artifact);
  return artifact;
}

function existingDirectory(directory: string): void {
  if (!isAbsolute(directory) || resolve(directory) !== directory) throw new Error("Unsafe staging path");
  const root = parse(directory).root;
  let current = root;
  for (const part of directory.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe staging path or symlink");
  }
  checkOwned(lstatSync(directory), true);
}
function openPrivate(file: string, flags: number): number {
  if (flags & constants.O_CREAT) privateDirectory(dirname(file));
  else existingDirectory(dirname(file));
  const fd = openSync(file, flags | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    checkOwned(stat, false);
    if (flags & constants.O_CREAT && process.platform !== "win32" && (stat.mode & 0o7777) !== 0o600) fchmodSync(fd, 0o600);
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

function privateSqliteFiles(file: string, create: boolean): void {
  privateDirectory(dirname(file));
  if (!present(file)) {
    if (!create) throw new Error("Staging database is missing");
    try { closeSync(openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    if (!present(candidate)) continue;
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) throw new Error("Unsafe staging database symlink");
    checkOwned(stat, false);
    if (process.platform !== "win32" && (stat.mode & 0o7777) !== 0o600) chmodSync(candidate, 0o600);
  }
}

export function readPrivate(file: string, maxBytes: number): Buffer {
  const fd = openPrivate(file, constants.O_RDONLY);
  try {
    const size = fstatSync(fd).size;
    if (!Number.isSafeInteger(size) || size > maxBytes) throw new Error("Staging file exceeds size limit");
    const bytes = Buffer.alloc(size);
    let at = 0;
    while (at < size) {
      const count = readSync(fd, bytes, at, size - at, at);
      if (!count) throw new Error("Truncated staging file");
      at += count;
    }
    return bytes;
  } finally { closeSync(fd); }
}

export function syncStagingDirectory(path: string): void {
  if (process.platform === "win32") return;
  privateDirectory(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Persist every directory entry needed to reach a published file. */
export function syncStagingAncestors(path: string): void {
  if (process.platform === "win32") return;
  privateDirectory(path);
  for (let current = resolve(path);;) {
    const fd = openSync(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function present(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Complete an immutable file without replacing an existing different file. */
export function writeImmutable(file: string, bytes: Buffer, options: { syncDirectory?: boolean } = {}): void {
  privateDirectory(dirname(file));
  if (present(file)) {
    if (!readPrivate(file, bytes.length).equals(bytes)) throw new Error("Conflicting immutable staging file");
    return;
  }
  const temporary = `${file}.part`;
  let fd: number;
  try { fd = openPrivate(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    fd = openPrivate(temporary, constants.O_RDWR);
  }
  try {
    const size = fstatSync(fd).size;
    if (size > bytes.length) throw new Error("Conflicting partial staging file");
    const prefix = Buffer.alloc(size);
    let at = 0;
    while (at < size) {
      const count = readSync(fd, prefix, at, size - at, at);
      if (!count) throw new Error("Truncated partial staging file");
      at += count;
    }
    if (!prefix.equals(bytes.subarray(0, size))) throw new Error("Conflicting partial staging file");
    at = size;
    while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at, at);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  if (present(file)) {
    if (!readPrivate(file, bytes.length).equals(bytes)) throw new Error("Conflicting immutable staging file");
    if (present(temporary)) unlinkSync(temporary);
  } else {
    renameSync(temporary, file);
  }
  if (options.syncDirectory !== false) syncStagingDirectory(dirname(file));
}

export function kindLimit(kind: ArtifactManifest["kind"], limits: Limits): number {
  switch (kind) {
    case "batch": return limits.hardBatchBytes;
    case "session": return limits.sessionBytes;
    case "workspace": return limits.workspaceBytes;
    case "release": case "agent": case "auth": return limits.agentBytes;
    default: throw new Error("Invalid artifact kind");
  }
}

/** Validate an untrusted manifest before using any of its identifiers or lengths. */
export function validateManifest(manifest: ArtifactManifest, limits: Limits): void {
  if (!manifest || typeof manifest !== "object") throw new Error("Invalid artifact manifest");
  artifactId(manifest.id);
  const cap = kindLimit(manifest.kind, limits);
  if (!Number.isSafeInteger(cap) || cap <= 0 || !Number.isSafeInteger(limits.chunkBytes) || limits.chunkBytes <= 0 ||
      !Number.isSafeInteger(manifest.byteLength) || manifest.byteLength < 0 || manifest.byteLength > cap ||
      typeof manifest.sha256 !== "string" || !HASH.test(manifest.sha256) || !Array.isArray(manifest.chunks)) {
    throw new Error("Invalid artifact size, digest, or limit");
  }
  let total = 0;
  for (let index = 0; index < manifest.chunks.length; index++) {
    const chunk = manifest.chunks[index];
    if (!chunk || chunk.index !== index || !Number.isSafeInteger(chunk.rawLength) || chunk.rawLength <= 0 ||
        chunk.rawLength > limits.chunkBytes || typeof chunk.sha256 !== "string" || !HASH.test(chunk.sha256)) {
      throw new Error("Invalid artifact chunk");
    }
    total += chunk.rawLength;
    if (!Number.isSafeInteger(total) || total > manifest.byteLength) throw new Error("Invalid artifact size");
  }
  if (total !== manifest.byteLength) throw new Error("Invalid artifact size");
}

export function sourceChunk(root: string, id: string, index: number, sha256: string): string {
  artifactId(id);
  if (!Number.isSafeInteger(index) || index < 0 || !HASH.test(sha256)) throw new Error("Invalid artifact chunk");
  return join(root, "outgoing", id, "chunks", `${index}-${sha256}`);
}

function canonicalManifest(manifest: ArtifactManifest): string {
  return JSON.stringify({
    id: manifest.id, kind: manifest.kind, byteLength: manifest.byteLength, sha256: manifest.sha256,
    chunks: manifest.chunks.map(chunk => ({ index: chunk.index, rawLength: chunk.rawLength, sha256: chunk.sha256 })),
  });
}

export function manifestDigest(manifest: ArtifactManifest): string { return hash(Buffer.from(canonicalManifest(manifest))); }

/** Hold a peer and one global slot until the transfer is no longer in flight. */
export function acquireTransferLease(root: string, peer: string, maximum: number): (() => void) | null {
  if (!isMachineId(peer) || !Number.isSafeInteger(maximum) || maximum <= 0) throw new Error("Invalid transfer lease");
  const directory = transferLockRoot(root);
  privateDirectory(root); privateDirectory(directory);
  const lock = (name: string): ReturnType<typeof openDb> | null => {
    const path = join(directory, `${name}.db`);
    privateSqliteFiles(path, true);
    let db: ReturnType<typeof openDb> | undefined;
    try {
      db = openDb(path, { fileMustExist: true, busyTimeoutMs: 0, checkpointOnClose: false });
      privateSqliteFiles(path, false);
      db.exec("BEGIN IMMEDIATE");
      return db;
    } catch (error) {
      db?.close();
      const code = (error as NodeJS.ErrnoException).code;
      if (code?.startsWith("SQLITE_BUSY") || code?.startsWith("SQLITE_LOCKED")) return null;
      throw error;
    }
  };
  const release = (db: ReturnType<typeof openDb>) => { try { db.exec("ROLLBACK"); } finally { db.close(); } };
  const peerLock = lock(`peer-${peer}`);
  if (!peerLock) return null;
  let slot: ReturnType<typeof openDb> | null = null;
  try {
    for (let index = 0; index < maximum && !slot; index++) slot = lock(`slot-${index}`);
  } catch (error) { peerLock.close(); throw error; }
  if (!slot) { release(peerLock); return null; }
  return () => { try { release(slot!); } finally { release(peerLock); } };
}

export class StagingFullError extends Error {
  readonly code = "STAGING_FULL";
  readonly retryable = true;
  constructor(root: string) { super(`Staging full (quota) at ${root}`); }
}

export interface OutgoingStore {
  inspect(id: string): { current: ArtifactManifest | null; pending: ArtifactManifest | null };
  prepare(manifest: ArtifactManifest, expectedCurrent: string | null): void;
  writeChunk(id: string, version: string, chunk: ArtifactManifest["chunks"][number], bytes: Buffer): void;
  commit(manifest: ArtifactManifest): void;
  get(id: string, version: string): ArtifactManifest | null;
  sweep(now: number, hasJournalOperation: (artifactId: string) => boolean): string[];
  remove(id: string): void;
  close(): void;
}

type OutgoingArtifactRow = { kind: string; current: string | null; pending: string | null };
type OutgoingVersionRow = { manifest: string; committed: number };
function sweepCandidates(db: ReturnType<typeof openDb>, table: "outgoing_artifacts" | "staging_artifacts", cutoff: number): { id: string }[] {
  db.exec("CREATE TABLE IF NOT EXISTS sweep_progress(id INTEGER PRIMARY KEY CHECK(id=1),after_id TEXT NOT NULL)");
  const after = (db.prepare("SELECT after_id FROM sweep_progress WHERE id=1").get() as { after_id: string } | undefined)?.after_id ?? "";
  let rows = db.prepare(`SELECT id FROM ${table} WHERE updated <= ? AND id > ? ORDER BY id LIMIT 256`).all(cutoff, after) as { id: string }[];
  if (!rows.length && after) rows = db.prepare(`SELECT id FROM ${table} WHERE updated <= ? ORDER BY id LIMIT 256`).all(cutoff) as { id: string }[];
  db.prepare("INSERT INTO sweep_progress VALUES(1,?) ON CONFLICT(id) DO UPDATE SET after_id=excluded.after_id").run(rows.at(-1)?.id ?? "");
  return rows;
}

/** Reserve each outgoing chunk before writing it, in a pool local to this staging root. */
export function openOutgoingStaging(root: string, limits: Limits, create = true): OutgoingStore {
  if (!isAbsolute(root) || !Number.isSafeInteger(limits.stagingBytes) || limits.stagingBytes <= 0 ||
      !Number.isSafeInteger(limits.retentionMs) || limits.retentionMs <= 0) throw new Error("Invalid outgoing staging root or quota");
  const directory = join(root, "outgoing");
  if (!create && (!present(root) || !present(directory))) throw new Error("Outgoing staging is missing");
  privateDirectory(root); privateDirectory(directory);
  const database = join(directory, "quota.db");
  privateSqliteFiles(database, create);
  const db = withRetry(() => openDb(database, { fileMustExist: true, checkpointOnClose: false }));
  try {
    db.pragma("synchronous = FULL");
    if (create) db.exec(`
      CREATE TABLE IF NOT EXISTS outgoing_artifacts (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, current TEXT, pending TEXT, updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outgoing_versions (
        artifact TEXT NOT NULL, version TEXT NOT NULL, manifest TEXT NOT NULL, committed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (artifact, version)
      );
      CREATE TABLE IF NOT EXISTS outgoing_allocations (
        path TEXT PRIMARY KEY, artifact TEXT NOT NULL, bytes INTEGER NOT NULL
      );
    `);
  } catch (error) { db.close(); throw error; }
  const artifactRow = (id: string): OutgoingArtifactRow | undefined => db.prepare(
    "SELECT kind, current, pending FROM outgoing_artifacts WHERE id = ?",
  ).get(id) as OutgoingArtifactRow | undefined;
  const versionRow = (id: string, version: string): OutgoingVersionRow | undefined => db.prepare(
    "SELECT manifest, committed FROM outgoing_versions WHERE artifact = ? AND version = ?",
  ).get(id, version) as OutgoingVersionRow | undefined;
  const discard = (id: string): void => {
    const path = join(directory, artifactId(id));
    if (present(path)) { verifyTree(path); rmSync(path, { recursive: true }); }
    db.prepare("DELETE FROM outgoing_allocations WHERE artifact = ?").run(id);
    db.prepare("DELETE FROM outgoing_versions WHERE artifact = ?").run(id);
    db.prepare("DELETE FROM outgoing_artifacts WHERE id = ?").run(id);
  };
  const readVersion = (id: string, version: string): ArtifactManifest => {
    const row = versionRow(id, version);
    if (!row) throw new Error("Corrupt outgoing manifest history");
    const manifest = JSON.parse(row.manifest) as ArtifactManifest;
    validateManifest(manifest, limits);
    if (manifest.id !== id || manifestDigest(manifest) !== version) throw new Error("Corrupt outgoing manifest history");
    return manifest;
  };
  return {
    inspect(id) {
      artifactId(id);
      const row = artifactRow(id);
      return { current: row?.current ? readVersion(id, row.current) : null, pending: row?.pending ? readVersion(id, row.pending) : null };
    },
    prepare(manifest, expectedCurrent) {
      validateManifest(manifest, limits);
      const version = manifestDigest(manifest), encoded = canonicalManifest(manifest);
      db.raw.transaction(() => {
        const existing = artifactRow(manifest.id);
        if (existing && existing.kind !== manifest.kind || existing?.pending && existing.pending !== version ||
            existing?.current !== expectedCurrent && existing?.current !== version && !(existing === undefined && expectedCurrent === null)) {
          throw new Error("Conflicting artifact ID or concurrent source stage");
        }
        if (existing?.current && existing.current !== version) {
          const previous = readVersion(manifest.id, existing.current);
          if (manifest.kind !== "session" || manifest.byteLength <= previous.byteLength) throw new Error("Conflicting artifact ID");
        }
        const used = db.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM outgoing_allocations").get() as AllocationRow;
        let total = used.bytes;
        for (const chunk of manifest.chunks) {
          const file = sourceChunk(root, manifest.id, chunk.index, chunk.sha256);
          const row = db.prepare("SELECT bytes FROM outgoing_allocations WHERE path = ?").get(file) as AllocationRow | undefined;
          if (row && row.bytes !== chunk.rawLength) throw new Error("Conflicting outgoing allocation");
          if (!row) total += chunk.rawLength;
          if (!Number.isSafeInteger(total) || total > limits.stagingBytes) throw new StagingFullError(root);
        }
        db.prepare(`INSERT INTO outgoing_artifacts(id, kind, current, pending, updated) VALUES (?, ?, NULL, ?, ?)
          ON CONFLICT(id) DO UPDATE SET pending = excluded.pending, updated = excluded.updated`)
          .run(manifest.id, manifest.kind, version, Date.now());
        db.prepare("INSERT OR IGNORE INTO outgoing_versions(artifact, version, manifest) VALUES (?, ?, ?)")
          .run(manifest.id, version, encoded);
        for (const chunk of manifest.chunks) db.prepare("INSERT OR IGNORE INTO outgoing_allocations(path, artifact, bytes) VALUES (?, ?, ?)")
          .run(sourceChunk(root, manifest.id, chunk.index, chunk.sha256), manifest.id, chunk.rawLength);
      }).immediate();
    },
    writeChunk(id, version, chunk, bytes) {
      artifactId(id);
      if (!HASH.test(version) || !Buffer.isBuffer(bytes) || bytes.length !== chunk.rawLength || hash(bytes) !== chunk.sha256) {
        throw new Error("Invalid outgoing artifact chunk");
      }
      const file = sourceChunk(root, id, chunk.index, chunk.sha256);
      db.raw.transaction(() => {
        const row = artifactRow(id);
        if (!row || row.pending !== version && !versionRow(id, version)?.committed) throw new Error("Outgoing artifact reservation changed");
        const allocation = db.prepare("SELECT bytes FROM outgoing_allocations WHERE path = ? AND artifact = ?").get(file, id) as AllocationRow | undefined;
        if (!allocation || allocation.bytes !== bytes.length) throw new Error("Outgoing chunk has no reservation");
        privateOutgoingArtifact(root, id);
        writeImmutable(file, bytes, { syncDirectory: false });
      }).immediate();
    },
    commit(manifest) {
      const version = manifestDigest(manifest);
      db.raw.transaction(() => {
        const row = artifactRow(manifest.id);
        const existing = versionRow(manifest.id, version);
        if (!row || !existing) throw new Error("Outgoing artifact reservation changed");
        if (row.pending !== version) {
          if (!existing.committed) throw new Error("Outgoing artifact reservation changed");
          return;
        }
        db.prepare("UPDATE outgoing_versions SET committed = 1 WHERE artifact = ? AND version = ?").run(manifest.id, version);
        db.prepare("UPDATE outgoing_artifacts SET current = ?, pending = NULL, updated = ? WHERE id = ?").run(version, Date.now(), manifest.id);
      }).immediate();
    },
    get(id, version) {
      artifactId(id);
      if (!HASH.test(version)) throw new Error("Invalid outgoing manifest digest");
      const row = versionRow(id, version);
      return row?.committed ? readVersion(id, version) : null;
    },
    remove(id) {
      db.raw.transaction(() => { discard(id); syncStagingDirectory(directory); }).immediate();
    },
    sweep(now, hasJournalOperation) {
      if (!Number.isSafeInteger(now) || now < 0 || typeof hasJournalOperation !== "function") throw new Error("Invalid outgoing staging sweep");
      return db.raw.transaction(() => {
        const candidates = sweepCandidates(db, "outgoing_artifacts", now - limits.retentionMs);
        const orphans: string[] = [];
        for (const candidate of candidates) {
          const referenced = hasJournalOperation(candidate.id);
          if (typeof referenced !== "boolean") throw new Error("Outgoing journal references are unavailable");
          if (!referenced) orphans.push(candidate.id);
        }
        privateDirectory(root); privateDirectory(directory);
        for (const id of orphans) discard(id);
        if (orphans.length) syncStagingDirectory(directory);
        return orphans;
      }).immediate();
    },
    close() { db.close(); },
  };
}

export interface ArtifactReceipt { artifactId: string; sha256: string }
export interface StagingHeader {
  artifact: Omit<ArtifactManifest, "chunks">; manifestDigest: string; head: string; pageCount: number;
}
export interface StagingStore {
  beginPages(header: StagingHeader, operationId: string): void;
  writePage(operationId: string, index: number, bytes: Buffer): void;
  readPage(operationId: string, index: number): Buffer;
  manifestFor(operationId: string): ArtifactManifest;
  declare(manifest: ArtifactManifest, operationId: string): void;
  chunkFile(manifest: ArtifactManifest, index: number): string;
  missing(manifest: ArtifactManifest, from?: number, count?: number): number[];
  receive(manifest: ArtifactManifest, index: number, bytes: Buffer): void;
  assemble(manifest: ArtifactManifest): string;
  /** Reserve a copy and return the hard-linked input path for validateBatch. */
  reserveValidationCopy(manifest: ArtifactManifest, attemptId: string): string;
  /** If output exists, prove the writer is inactive while holding the peer lease. */
  cancelValidationCopy(manifest: ArtifactManifest, attemptId: string, verifyInactive?: () => boolean): void;
  /** Replace the reconstructed file with the verified validation copy and release its reservation. */
  promoteValidationCopy(manifest: ArtifactManifest, attemptId: string, file: string): string;
  release(id: string, operationId: string): void;
  sweep(now: number, hasJournalReference?: (artifactId: string) => boolean): string[];
  removeAfterReceipt(manifest: ArtifactManifest, receipt: ArtifactReceipt, verifyReceipt: (receipt: ArtifactReceipt) => boolean): void;
  close(): void;
}

type ArtifactRow = { kind: string; current: string; updated: number };
type VersionRow = { manifest: string; parent: string | null; complete: number; receipted: number; cleaned: number };
type ClaimRow = { artifact: string; version: string };

type AllocationRow = { bytes: number };
type PagesRow = { artifact: string; version: string; header: string; page_count: number };

export function validateStagingHeader(header: StagingHeader, limits: Limits): void {
  if (!header || typeof header !== "object" || !header.artifact) throw new Error("Invalid artifact header");
  artifactId(header.artifact.id);
  const cap = kindLimit(header.artifact.kind, limits);
  if (!Number.isSafeInteger(cap) || cap <= 0 || !Number.isSafeInteger(header.artifact.byteLength) ||
      header.artifact.byteLength < 0 || header.artifact.byteLength > cap ||
      !HASH.test(header.artifact.sha256) || !HASH.test(header.manifestDigest) || !HASH.test(header.head) ||
      !Number.isSafeInteger(header.pageCount) || header.pageCount < 1 ||
      header.pageCount > Math.max(1, header.artifact.byteLength)) throw new Error("Invalid artifact header");
}

function verifyTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error("Unsafe staging symlink");
  checkOwned(stat, stat.isDirectory());
  if (stat.isDirectory()) for (const entry of readdirSync(path)) verifyTree(join(path, entry));
}

export function verifyStagedFile(file: string, manifest: ArtifactManifest, prefixes: readonly ArtifactManifest[] = []): void {
  const fd = openPrivate(file, constants.O_RDONLY);
  try {
    if (fstatSync(fd).size !== manifest.byteLength) throw new Error("Conflicting reconstructed artifact length");
    const digest = createHash("sha256");
    const ancestors = prefixes.map(old => ({ remaining: old.byteLength, digest: createHash("sha256"), expected: old.sha256 }));
    const buffer = Buffer.allocUnsafe(Math.min(128 * 1024, Math.max(1, manifest.byteLength)));
    let position = 0;
    while (position < manifest.byteLength) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, manifest.byteLength - position), position);
      if (!count) throw new Error("Truncated reconstructed artifact");
      digest.update(buffer.subarray(0, count));
      for (const ancestor of ancestors) {
        const prefix = Math.min(ancestor.remaining, count);
        if (prefix) ancestor.digest.update(buffer.subarray(0, prefix));
        ancestor.remaining -= prefix;
      }
      position += count;
    }
    if (digest.digest("hex") !== manifest.sha256) throw new Error("Conflicting reconstructed artifact digest");
    for (const ancestor of ancestors) {
      if (ancestor.remaining || ancestor.digest.digest("hex") !== ancestor.expected) throw new Error("Session artifact prefix changed");
    }
  } finally { closeSync(fd); }
}

/** Store immutable incoming artifacts under a separately accounted peer directory. */
export function openStaging(root: string, peer: string, limits: Limits): StagingStore {
  if (!isAbsolute(root) || !isMachineId(peer)) throw new Error("Invalid staging root or peer identity");
  if (!Number.isSafeInteger(limits.stagingBytes) || limits.stagingBytes <= 0 ||
      !Number.isSafeInteger(limits.retentionMs) || limits.retentionMs <= 0) throw new Error("Invalid staging limits");
  const incoming = join(root, "incoming");
  const directory = join(incoming, peer);
  const secure = () => { privateDirectory(root); privateDirectory(incoming); privateDirectory(directory); };
  secure();
  const database = join(directory, "quota.db");
  privateSqliteFiles(database, true);
  const db = withRetry(() => openDb(database, { fileMustExist: true, checkpointOnClose: false }));
  try {
    db.pragma("synchronous = FULL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS staging_artifacts (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, current TEXT NOT NULL, updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS staging_versions (
        artifact TEXT NOT NULL, version TEXT NOT NULL, manifest TEXT NOT NULL, parent TEXT,
        complete INTEGER NOT NULL DEFAULT 0, receipted INTEGER NOT NULL DEFAULT 0, cleaned INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (artifact, version)
      );
      CREATE TABLE IF NOT EXISTS staging_claims (
        operation_id TEXT PRIMARY KEY, artifact TEXT NOT NULL, version TEXT NOT NULL, referenced INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS staging_pages (
        operation_id TEXT PRIMARY KEY, artifact TEXT NOT NULL, version TEXT NOT NULL, header TEXT NOT NULL, page_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS staging_allocations (
        path TEXT PRIMARY KEY, artifact TEXT NOT NULL, bytes INTEGER NOT NULL
      );
    `);
  } catch (error) { db.close(); throw error; }
  const versionRow = (id: string, version: string): VersionRow | undefined => db.prepare(
    "SELECT manifest, parent, complete, receipted, cleaned FROM staging_versions WHERE artifact = ? AND version = ?",
  ).get(id, version) as VersionRow | undefined;
  const requireVersion = (manifest: ArtifactManifest): { version: string; row: VersionRow } => {
    validateManifest(manifest, limits);
    const version = manifestDigest(manifest);
    const row = versionRow(manifest.id, version);
    if (!row || row.cleaned) throw new Error("Artifact manifest has not been declared");
    return { version, row };
  };
  const reserve = (id: string, path: string, bytes: number, exclusive = false): void => {
    db.raw.transaction(() => {
      const existing = db.prepare("SELECT bytes FROM staging_allocations WHERE path = ?").get(path) as AllocationRow | undefined;
      if (existing) {
        if (exclusive) throw new Error("Validation attempt already has a reservation");
        if (existing.bytes !== bytes) throw new Error("Conflicting staging allocation");
        return;
      }
      const row = db.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM staging_allocations").get() as AllocationRow;
      if (!Number.isSafeInteger(row.bytes + bytes) || row.bytes + bytes > limits.stagingBytes) {
        throw new StagingFullError(directory);
      }
      db.prepare("INSERT INTO staging_allocations(path, artifact, bytes) VALUES (?, ?, ?)").run(path, id, bytes);
      db.prepare("UPDATE staging_artifacts SET updated = ? WHERE id = ?").run(Date.now(), id);
    }).immediate();
  };
  const writeReserved = (id: string, path: string, bytes: Buffer): void => {
    db.raw.transaction(() => {
      const allocation = db.prepare("SELECT bytes FROM staging_allocations WHERE path = ? AND artifact = ?").get(path, id) as AllocationRow | undefined;
      if (!allocation || allocation.bytes !== bytes.length) throw new Error("Staging allocation disappeared");
      writeImmutable(path, bytes);
    }).immediate();
  };
  const pageRow = (operationId: string): PagesRow => {
    artifactId(operationId);
    const row = db.prepare("SELECT artifact, version, header, page_count FROM staging_pages WHERE operation_id = ?").get(operationId) as PagesRow | undefined;
    if (!row) throw new Error("Artifact page transfer has not begun");
    return row;
  };
  const pagePath = (operationId: string, index: number): string => {
    const row = pageRow(operationId);
    if (!Number.isSafeInteger(index) || index < 0 || index >= row.page_count) throw new Error("Invalid manifest page index");
    const artifact = privateIncomingArtifact(root, peer, row.artifact);
    const pages = join(artifact, "pages"), parent = join(pages, hash(Buffer.from(operationId)));
    privateDirectory(pages); privateDirectory(parent);
    return join(parent, String(index));
  };
  const chunkPath = (manifest: ArtifactManifest, index: number): string => {
    validateManifest(manifest, limits);
    if (!Number.isSafeInteger(index) || index < 0 || index >= manifest.chunks.length) throw new Error("Invalid artifact chunk index");
    const chunk = manifest.chunks[index];
    const parent = join(privateIncomingArtifact(root, peer, manifest.id), "chunks");
    privateDirectory(parent);
    return join(parent, `${index}-${chunk.sha256}`);
  };
  const filePath = (id: string, version: string): string => {
    const parent = join(privateIncomingArtifact(root, peer, id), "complete");
    privateDirectory(parent);
    return join(parent, version);
  };
  const validationPaths = (manifest: ArtifactManifest, attemptId: string) => {
    artifactId(attemptId);
    const version = manifestDigest(manifest), key = `${version}-${hash(Buffer.from(attemptId))}`;
    const artifact = privateIncomingArtifact(root, peer, manifest.id);
    const parent = join(artifact, "validation"), attempt = join(parent, key);
    return { version, parent, attempt, input: join(attempt, "input.ndjson"),
      reservation: join(artifact, "validation-reservations", key) };
  };
  const requireValidationReservation = (id: string, path: string, bytes: number): void => {
    const allocation = db.prepare("SELECT bytes FROM staging_allocations WHERE path = ? AND artifact = ?").get(path, id) as AllocationRow | undefined;
    if (!allocation || allocation.bytes !== bytes) throw new Error("Validation reservation is missing");
  };
  const touch = (id: string): void => { db.prepare("UPDATE staging_artifacts SET updated = ? WHERE id = ?").run(Date.now(), id); };
  const discardFiles = (id: string): void => {
    const parent = join(directory, "artifacts"), path = join(parent, id);
    secure();
    if (present(parent)) privateDirectory(parent);
    if (present(path)) { verifyTree(path); rmSync(path, { recursive: true }); syncStagingDirectory(parent); }
    db.prepare("DELETE FROM staging_allocations WHERE artifact = ?").run(id);
    db.prepare("DELETE FROM staging_claims WHERE artifact = ?").run(id);
    db.prepare("DELETE FROM staging_pages WHERE artifact = ?").run(id);
    db.prepare("UPDATE staging_versions SET cleaned = 1, complete = 0 WHERE artifact = ?").run(id);
  };
  return {
    beginPages(header, operationId) {
      secure(); artifactId(operationId); validateStagingHeader(header, limits);
      const encoded = JSON.stringify(header);
      db.raw.transaction(() => {
        const claim = db.prepare("SELECT artifact, version FROM staging_claims WHERE operation_id = ?").get(operationId) as ClaimRow | undefined;
        if (claim && (claim.artifact !== header.artifact.id || claim.version !== header.manifestDigest)) throw new Error("Operation ID has conflicting artifact arguments");
        const existing = db.prepare("SELECT artifact, version, header, page_count FROM staging_pages WHERE operation_id = ?").get(operationId) as PagesRow | undefined;
        if (existing && existing.header !== encoded) throw new Error("Operation ID has conflicting page arguments");
        const artifact = db.prepare("SELECT kind, current, updated FROM staging_artifacts WHERE id = ?").get(header.artifact.id) as ArtifactRow | undefined;
        if (artifact && artifact.kind !== header.artifact.kind) throw new Error("Conflicting artifact ID");
        if (artifact?.current && !versionRow(header.artifact.id, header.manifestDigest)) {
          const previous = versionRow(header.artifact.id, artifact.current);
          if (!previous) throw new Error("Corrupt staging manifest history");
          const prior = JSON.parse(previous.manifest) as ArtifactManifest;
          if (artifact.kind !== "session" || header.artifact.byteLength <= prior.byteLength) throw new Error("Conflicting artifact ID");
        }
        if (artifact && !artifact.current) {
          const other = db.prepare("SELECT version FROM staging_pages WHERE artifact = ? LIMIT 1").get(header.artifact.id) as { version: string } | undefined;
          if (other && other.version !== header.manifestDigest) throw new Error("Conflicting artifact ID");
        }
        db.prepare("INSERT OR IGNORE INTO staging_artifacts(id, kind, current, updated) VALUES (?, ?, '', ?)")
          .run(header.artifact.id, header.artifact.kind, Date.now());
        db.prepare("INSERT OR IGNORE INTO staging_pages(operation_id, artifact, version, header, page_count) VALUES (?, ?, ?, ?, ?)")
          .run(operationId, header.artifact.id, header.manifestDigest, encoded, header.pageCount);
        db.prepare(`INSERT INTO staging_claims(operation_id, artifact, version, referenced) VALUES (?, ?, ?, 1)
          ON CONFLICT(operation_id) DO UPDATE SET referenced = 1`).run(operationId, header.artifact.id, header.manifestDigest);
        touch(header.artifact.id);
      }).immediate();
    },
    writePage(operationId, index, bytes) {
      secure();
      const row = pageRow(operationId);
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > Math.min(limits.manifestBytes, limits.replyBytes)) throw new Error("Invalid manifest page size");
      const path = pagePath(operationId, index);
      reserve(row.artifact, path, bytes.length);
      writeReserved(row.artifact, path, bytes);
    },
    readPage(operationId, index) {
      secure();
      return readPrivate(pagePath(operationId, index), Math.min(limits.manifestBytes, limits.replyBytes));
    },
    manifestFor(operationId) {
      secure(); artifactId(operationId);
      const claim = db.prepare("SELECT artifact, version FROM staging_claims WHERE operation_id = ?").get(operationId) as ClaimRow | undefined;
      if (!claim) throw new Error("Artifact operation has not begun");
      const row = versionRow(claim.artifact, claim.version);
      if (!row || row.cleaned) throw new Error("Artifact manifest has not been declared");
      const manifest = JSON.parse(row.manifest) as ArtifactManifest;
      validateManifest(manifest, limits);
      return manifest;
    },
    declare(manifest, operationId) {
      secure();
      validateManifest(manifest, limits);
      artifactId(operationId);
      const version = manifestDigest(manifest);
      const encoded = canonicalManifest(manifest);
      db.raw.transaction(() => {
        const claim = db.prepare("SELECT artifact, version FROM staging_claims WHERE operation_id = ?").get(operationId) as ClaimRow | undefined;
        if (claim && (claim.artifact !== manifest.id || claim.version !== version)) throw new Error("Operation ID has conflicting artifact arguments");
        const previous = db.prepare("SELECT kind, current, updated FROM staging_artifacts WHERE id = ?").get(manifest.id) as ArtifactRow | undefined;
        if (previous && previous.kind !== manifest.kind) throw new Error("Conflicting artifact ID");
        if (previous && !previous.current) {
          const reserved = db.prepare("SELECT version FROM staging_pages WHERE artifact = ? LIMIT 1").get(manifest.id) as { version: string } | undefined;
          if (reserved && reserved.version !== version) throw new Error("Conflicting artifact ID");
        }
        const existing = versionRow(manifest.id, version);
        if (!existing) {
          if (previous?.current) {
            const old = versionRow(manifest.id, previous.current);
            if (!old) throw new Error("Corrupt staging manifest history");
            const prior = JSON.parse(old.manifest) as ArtifactManifest;
            if (previous.kind !== "session" || manifest.kind !== "session" || manifest.byteLength <= prior.byteLength) {
              throw new Error("Conflicting artifact ID");
            }
          }
          db.prepare("INSERT INTO staging_versions(artifact, version, manifest, parent) VALUES (?, ?, ?, ?)")
            .run(manifest.id, version, encoded, previous?.current || null);
          db.prepare(`INSERT INTO staging_artifacts(id, kind, current, updated) VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET current = excluded.current, updated = excluded.updated`)
            .run(manifest.id, manifest.kind, version, Date.now());
        } else {
          if (existing.manifest !== encoded) throw new Error("Conflicting artifact manifest");
          if (existing.cleaned) db.prepare("UPDATE staging_versions SET cleaned = 0, receipted = 0 WHERE artifact = ? AND version = ?").run(manifest.id, version);
          touch(manifest.id);
        }
        db.prepare(`INSERT INTO staging_claims(operation_id, artifact, version, referenced) VALUES (?, ?, ?, 1)
          ON CONFLICT(operation_id) DO UPDATE SET referenced = 1`).run(operationId, manifest.id, version);
      }).immediate();
    },
    chunkFile(manifest, index) { secure(); requireVersion(manifest); return chunkPath(manifest, index); },
    missing(manifest, from = 0, count = manifest.chunks.length) {
      secure(); requireVersion(manifest);
      if (!Number.isSafeInteger(from) || from < 0 || from > manifest.chunks.length ||
          !Number.isSafeInteger(count) || count < 0) throw new Error("Invalid chunk range");
      const missing: number[] = [];
      for (const chunk of manifest.chunks.slice(from, from + count)) {
        const file = chunkPath(manifest, chunk.index);
        if (!present(file)) { missing.push(chunk.index); continue; }
        const bytes = readPrivate(file, chunk.rawLength);
        if (bytes.length !== chunk.rawLength || hash(bytes) !== chunk.sha256) throw new Error("Corrupt staged chunk");
      }
      return missing;
    },
    receive(manifest, index, bytes) {
      secure(); requireVersion(manifest);
      const file = chunkPath(manifest, index);
      const chunk = manifest.chunks[index];
      if (!Buffer.isBuffer(bytes) || bytes.length !== chunk.rawLength) throw new Error("Invalid chunk length");
      if (hash(bytes) !== chunk.sha256) throw new Error("Invalid chunk digest");
      reserve(manifest.id, file, chunk.rawLength);
      writeReserved(manifest.id, file, bytes);
    },
    assemble(manifest) {
      secure();
      const { version } = requireVersion(manifest);
      if (this.missing(manifest).length) throw new Error("Missing artifact chunks");
      const target = filePath(manifest.id, version);
      for (const chunk of manifest.chunks) reserve(manifest.id, chunkPath(manifest, chunk.index), chunk.rawLength);
      reserve(manifest.id, target, manifest.byteLength);
      return db.raw.transaction(() => {
        const { row } = requireVersion(manifest);
        if (this.missing(manifest).length) throw new Error("Missing artifact chunks");
        const prefixes: ArtifactManifest[] = [];
        let parent = row.parent;
        while (parent) {
          const previous = versionRow(manifest.id, parent);
          if (!previous) throw new Error("Corrupt staging manifest history");
          prefixes.push(JSON.parse(previous.manifest) as ArtifactManifest);
          parent = previous.parent;
        }
        if (present(target)) {
          verifyStagedFile(target, manifest, prefixes);
        } else {
          const part = `${target}.part`;
          let output: number;
          try { output = openPrivate(part, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            output = openPrivate(part, constants.O_RDWR);
          }
          try {
            const written = fstatSync(output).size;
            if (written > manifest.byteLength) throw new Error("Conflicting partial reconstruction");
            const ancestors = prefixes.map(old => ({ remaining: old.byteLength, digest: createHash("sha256"), expected: old.sha256 }));
            const whole = createHash("sha256");
            let position = 0;
            for (const chunk of manifest.chunks) {
              const bytes = readPrivate(chunkPath(manifest, chunk.index), chunk.rawLength);
              if (bytes.length !== chunk.rawLength || hash(bytes) !== chunk.sha256) throw new Error("Corrupt staged chunk");
              whole.update(bytes);
              for (const ancestor of ancestors) {
                const count = Math.min(ancestor.remaining, bytes.length);
                if (count) ancestor.digest.update(bytes.subarray(0, count));
                ancestor.remaining -= count;
              }
              const already = Math.min(bytes.length, Math.max(0, written - position));
              if (already) {
                const prefix = Buffer.alloc(already);
                let at = 0;
                while (at < already) {
                  const count = readSync(output, prefix, at, already - at, position + at);
                  if (!count) throw new Error("Truncated partial reconstruction");
                  at += count;
                }
                if (!prefix.equals(bytes.subarray(0, already))) throw new Error("Conflicting partial reconstruction");
              }
              let at = already;
              while (at < bytes.length) at += writeSync(output, bytes, at, bytes.length - at, position + at);
              position += bytes.length;
            }
            if (whole.digest("hex") !== manifest.sha256) throw new Error("Invalid reconstructed artifact digest");
            for (const ancestor of ancestors) {
              if (ancestor.remaining || ancestor.digest.digest("hex") !== ancestor.expected) throw new Error("Session artifact prefix changed");
            }
            fsyncSync(output);
          } finally { closeSync(output); }
          if (present(target)) {
            verifyStagedFile(target, manifest, prefixes);
            if (present(part)) unlinkSync(part);
          } else renameSync(part, target);
        }
        syncStagingAncestors(dirname(target));
        db.prepare("UPDATE staging_versions SET complete = 1 WHERE artifact = ? AND version = ?").run(manifest.id, version);
        touch(manifest.id);
        return target;
      }).immediate();
    },
    reserveValidationCopy(manifest, attemptId) {
      secure();
      const { row } = requireVersion(manifest);
      if (manifest.kind !== "batch" || !row.complete) throw new Error("Validation requires a completed batch artifact");
      const paths = validationPaths(manifest, attemptId);
      reserve(manifest.id, paths.reservation, manifest.byteLength, true);
      try {
        return db.raw.transaction(() => {
          const current = requireVersion(manifest).row;
          if (!current.complete) throw new Error("Validation requires a completed batch artifact");
          requireValidationReservation(manifest.id, paths.reservation, manifest.byteLength);
          privateDirectory(paths.parent); privateDirectory(paths.attempt);
          const target = filePath(manifest.id, paths.version);
          verifyStagedFile(target, manifest);
          linkSync(target, paths.input);
          syncStagingDirectory(paths.attempt);
          return paths.input;
        }).immediate();
      } catch (error) {
        try { this.cancelValidationCopy(manifest, attemptId); } catch { /* Keep uncertain reservations. */ }
        throw error;
      }
    },
    cancelValidationCopy(manifest, attemptId, verifyInactive) {
      secure(); requireVersion(manifest);
      const paths = validationPaths(manifest, attemptId);
      db.raw.transaction(() => {
        requireValidationReservation(manifest.id, paths.reservation, manifest.byteLength);
        if (present(paths.parent)) privateDirectory(paths.parent);
        if (present(paths.attempt)) {
          privateDirectory(paths.attempt);
          verifyTree(paths.attempt);
          const hasOutput = readdirSync(paths.attempt).some(name => name !== "input.ndjson");
          if (hasOutput && (typeof verifyInactive !== "function" || !verifyInactive())) throw new Error("Validation output still exists");
          if (hasOutput) verifyStagedFile(filePath(manifest.id, paths.version), manifest);
          rmSync(paths.attempt, { recursive: true });
          syncStagingDirectory(paths.parent);
        }
        db.prepare("DELETE FROM staging_allocations WHERE path = ? AND artifact = ?").run(paths.reservation, manifest.id);
      }).immediate();
    },
    promoteValidationCopy(manifest, attemptId, file) {
      secure();
      const { row } = requireVersion(manifest);
      if (manifest.kind !== "batch" || !row.complete) throw new Error("Validation requires a completed batch artifact");
      const paths = validationPaths(manifest, attemptId);
      const name = basename(file);
      if (!isAbsolute(file) || dirname(resolve(file)) !== resolve(paths.attempt) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.ndjson$/.test(name)) {
        throw new Error("Invalid validation output path");
      }
      return db.raw.transaction(() => {
        requireValidationReservation(manifest.id, paths.reservation, manifest.byteLength);
        privateDirectory(paths.parent); privateDirectory(paths.attempt);
        verifyTree(paths.attempt);
        if (readdirSync(paths.attempt).some(entry => entry !== "input.ndjson" && entry !== name)) throw new Error("Unexpected validation output");
        verifyStagedFile(file, manifest);
        const target = filePath(manifest.id, paths.version);
        if (present(paths.input)) unlinkSync(paths.input);
        renameSync(file, target);
        syncStagingDirectory(dirname(target));
        syncStagingDirectory(paths.attempt);
        rmSync(paths.attempt, { recursive: true });
        syncStagingDirectory(paths.parent);
        db.prepare("DELETE FROM staging_allocations WHERE path = ? AND artifact = ?").run(paths.reservation, manifest.id);
        return target;
      }).immediate();
    },
    release(id, operationId) {
      secure(); artifactId(id); artifactId(operationId);
      db.raw.transaction(() => {
        const changed = db.prepare("UPDATE staging_claims SET referenced = 0 WHERE artifact = ? AND operation_id = ? AND referenced = 1").run(id, operationId);
        if (changed.changes) touch(id);
      }).immediate();
    },
    sweep(now, hasJournalReference) {
      secure();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid staging cleanup time");
      return db.raw.transaction(() => {
        const rows = sweepCandidates(db, "staging_artifacts", now - limits.retentionMs);
        const orphans = rows.filter(row => {
          if (hasJournalReference) {
            const referenced = hasJournalReference(row.id);
            if (typeof referenced !== "boolean") throw new Error("Incoming journal references are unavailable");
            return !referenced;
          }
          return !db.prepare("SELECT 1 FROM staging_claims WHERE artifact=? AND referenced=1 LIMIT 1").get(row.id) &&
            !db.prepare("SELECT 1 FROM staging_versions WHERE artifact=? AND complete=1 AND receipted=0 LIMIT 1").get(row.id);
        });
        for (const row of orphans) {
          discardFiles(row.id);
          db.prepare("DELETE FROM staging_versions WHERE artifact=?").run(row.id);
          db.prepare("DELETE FROM staging_artifacts WHERE id=?").run(row.id);
        }
        return orphans.map(row => row.id);
      }).immediate();
    },
    removeAfterReceipt(manifest, receipt, verifyReceipt) {
      secure();
      const { version, row } = requireVersion(manifest);
      if (!receipt || receipt.artifactId !== manifest.id || receipt.sha256 !== manifest.sha256 || !row.complete ||
          typeof verifyReceipt !== "function" || !verifyReceipt(receipt)) {
        throw new Error("Artifact receipt does not match committed evidence");
      }
      db.raw.transaction(() => {
        const claims = db.prepare("SELECT COUNT(*) AS count FROM staging_claims WHERE artifact = ? AND referenced = 1").get(manifest.id) as { count: number };
        if (claims.count) throw new Error("Artifact is still referenced");
        db.prepare("UPDATE staging_versions SET receipted = 1 WHERE artifact = ? AND version = ?").run(manifest.id, version);
        const remaining = db.prepare("SELECT COUNT(*) AS count FROM staging_versions WHERE artifact = ? AND receipted = 0 AND cleaned = 0").get(manifest.id) as { count: number };
        if (!remaining.count) discardFiles(manifest.id);
      }).immediate();
    },
    close() { db.close(); },
  };
}
