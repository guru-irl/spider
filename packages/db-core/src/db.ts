// packages/db-core/src/db.ts
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync,
  mkdirSync, openSync, readFileSync, readSync, realpathSync, statfsSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, basename, isAbsolute, join, resolve, sep } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import type { Scope } from "./roam/types";

const require = createRequire(import.meta.url);

let _Database: typeof BetterSqlite3 | null = null;
function loadDatabase(): typeof BetterSqlite3 {
  if (!_Database) {
    const mod = require("better-sqlite3") as { default?: typeof BetterSqlite3 } | typeof BetterSqlite3;
    _Database = (mod as { default?: typeof BetterSqlite3 }).default ?? (mod as typeof BetterSqlite3);
  }
  return _Database;
}

const BUSY_TIMEOUT_MS = 30_000;

/** Retry a DB op with backoff on SQLITE_BUSY / "database is locked". */
export function withRetry<T>(fn: () => T, delays: number[] = [100, 500, 2000]): T {
  let last: Error | undefined;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("SQLITE_BUSY") && !msg.includes("database is locked")) throw err;
      last = err instanceof Error ? err : new Error(msg);
      if (attempt < delays.length) {
        const start = Date.now();
        while (Date.now() - start < delays[attempt]) { /* sync busy-wait */ }
      }
    }
  }
  throw new Error(`SQLITE_BUSY after ${delays.length} retries: ${last?.message}`);
}

export interface Db {
  prepare(sql: string): BetterSqlite3.Statement;
  exec(sql: string): void;
  /** Queue effects until the outermost Db.transaction commits. Queued callback
   * failures are written to stderr, not thrown: a committed transaction remains
   * successful. Print-mode children discard stderr, so these errors are not visible. */
  transaction<T>(fn: () => T): () => T;
  /** Run after the outermost Db.transaction commits, or immediately when no
   * wrapper transaction is open. Rolled-back wrapper/savepoint effects are dropped.
   * Queued callback errors are written to stderr (not visible in print-mode children).
   * db.raw transactions bypass this queue. Do not emit events or register effects
   * inside them, or mix raw and wrapper transactions: publication may precede
   * commit, and raw rollback cannot discard callbacks. */
  afterCommit(fn: () => void): void;
  pragma(source: string): unknown;
  loadVec(): void;
  withRetry<T>(fn: () => T): T;
  /** Low-level escape hatch. Its transactions are not tracked by afterCommit. */
  readonly raw: BetterSqlite3.Database;
  close(): void;
}

let _sqliteVec: { getLoadablePath(): string } | null = null;
function sqliteVec(): { getLoadablePath(): string } {
  if (!_sqliteVec) _sqliteVec = require("sqlite-vec") as { getLoadablePath(): string };
  return _sqliteVec;
}

function assertTestFixturePath(dbPath: string, label: string): void {
  if (process.env.VITEST) {
    // Test DBs must live under a .spider/scratch fixture. The real checkout DBs
    // (.git/spider/repo.db and .spider/project.db) cannot match this rule. Check
    // the resolved parent too so a symlinked scratch directory cannot escape it.
    // Only this checkout's root or direct packages/* fixture roots are allowed.
    // The real checkout DBs (.git/spider/repo.db, .spider/project.db) are
    // siblings of scratch, never descendants, so they cannot match this rule.
    const checkout = realpathSync(process.env.SPIDER_TEST_FIXTURE_CHECKOUT ?? process.cwd());
    const roots = [join(checkout, ".spider", "scratch")];
    const packageRoot = join(checkout, "packages");
    const allowed = (candidate: string) => roots.some(root => candidate.startsWith(root + sep)) ||
      candidate.startsWith(packageRoot + sep) &&
      /^([^/\\]+)[/\\](?:src[/\\])?\.spider[/\\]scratch[/\\]/.test(candidate.slice(packageRoot.length + 1));
    let parent = dirname(resolve(dbPath));
    const missing: string[] = [];
    for (;;) {
      try { parent = join(realpathSync(parent), ...missing.reverse()); break; }
      catch { const next = dirname(parent); if (next === parent) break; missing.push(basename(parent)); parent = next; }
    }
    let file = resolve(dbPath);
    try { file = realpathSync(dbPath); }
    catch {
      // A dangling symlink is not a new file: SQLite follows it on O_CREAT.
      try { if (lstatSync(dbPath).isSymbolicLink()) throw new Error("dangling symlink"); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new Error(`${label}: refusing path outside a Vitest fixture (.spider/scratch): ${dbPath}`);
        }
      }
    }
    if (!isAbsolute(dbPath) || !allowed(resolve(dbPath)) || !allowed(parent + sep) || !allowed(file)) {
      throw new Error(`${label}: refusing path outside a Vitest fixture (.spider/scratch): ${dbPath}`);
    }
  }
}

export function assertTestDbPath(dbPath: string): void { assertTestFixturePath(dbPath, "openDb"); }
export function assertTestConfigPath(configPath: string): void { assertTestFixturePath(configPath, "config"); }

function checkOwned(stat: Stats, mode: number, kind: "file" | "directory"): void {
  if ((typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      (stat.mode & 0o7777) !== mode ||
      !(kind === "file" ? stat.isFile() : stat.isDirectory())) {
    throw new Error(`Unsafe ${kind} for core backup`);
  }
}

function privateDirectory(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  checkOwned(lstatSync(path), 0o700, "directory");
}

function openPrivateFile(path: string): number {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    checkOwned(fstatSync(fd), 0o600, "file");
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function backupDigest(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    checkOwned(fstatSync(fd), 0o600, "file");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(128 * 1024);
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest("hex");
  } finally { closeSync(fd); }
}

interface BackupIdentity {
  scope: Scope;
  pathHash: string;
  version: number;
  device: string;
  inode: string;
}

interface BackupManifest extends BackupIdentity { sha256: string }

function validateBackup(file: string, identity: BackupIdentity): void {
  const manifestPath = `${file}.json`;
  checkOwned(lstatSync(manifestPath), 0o600, "file");
  const fd = openSync(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let manifest: BackupManifest;
  try {
    checkOwned(fstatSync(fd), 0o600, "file");
    manifest = JSON.parse(readFileSync(fd, "utf8")) as BackupManifest;
  } finally { closeSync(fd); }
  if (!manifest || manifest.scope !== identity.scope || manifest.pathHash !== identity.pathHash ||
      manifest.version !== identity.version || manifest.device !== identity.device || manifest.inode !== identity.inode) {
    throw new Error("Core backup store identity or version does not match");
  }
  if (backupDigest(file) !== manifest.sha256) throw new Error("Core backup digest does not match");
  const Database = loadDatabase();
  const backup = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (backup.pragma("user_version", { simple: true }) !== identity.version ||
        backup.pragma("quick_check", { simple: true }) !== "ok") {
      throw new Error("Core backup version or integrity does not match");
    }
  } finally { backup.close(); }
}

/** Create or reuse a verified pre-migration backup of a canonical core store. */
export function backupBeforeMigration(db: Db, scope: Scope, globalRoot: string, expectedVersion: number = Number(db.pragma("user_version"))): string {
  const source = realpathSync(db.raw.name);
  const sourceStat = statSync(source, { bigint: true });
  if (!sourceStat.isFile()) throw new Error("Core backup source is not a file");
  mkdirSync(globalRoot, { recursive: true, mode: 0o700 });
  const rootStat = lstatSync(globalRoot);
  if (!rootStat.isDirectory() || (typeof process.getuid === "function" && rootStat.uid !== process.getuid())) {
    throw new Error("Unsafe core backup root");
  }
  const roam = join(globalRoot, "roam");
  privateDirectory(roam);
  const directory = join(roam, "backups");
  privateDirectory(directory);
  const identity: BackupIdentity = {
    scope, pathHash: createHash("sha256").update(source).digest("hex"), version: expectedVersion,
    device: String(sourceStat.dev), inode: String(sourceStat.ino),
  };
  const file = join(directory, `${scope}-${identity.pathHash}-v${expectedVersion}.db`);
  const lockPath = `${file}.lock`;
  try { closeSync(openPrivateFile(lockPath)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  checkOwned(lstatSync(lockPath), 0o600, "file");
  const Database = loadDatabase();
  const lock = new Database(lockPath, { timeout: BUSY_TIMEOUT_MS, fileMustExist: true });
  try {
    return lock.transaction(() => {
      if (existsSync(file)) {
        validateBackup(file, identity);
        return file;
      }
      if (existsSync(`${file}.json`)) throw new Error("Core backup is incomplete");
      const lockedSource = statSync(source, { bigint: true });
      if (lockedSource.dev !== sourceStat.dev || lockedSource.ino !== sourceStat.ino) {
        throw new Error("Core backup source identity changed");
      }
      const walBytes = existsSync(`${source}-wal`) ? statSync(`${source}-wal`, { bigint: true }).size : 0n;
      const space = statfsSync(directory, { bigint: true });
      if (space.bavail * space.bsize < lockedSource.size + walBytes + 16n * 1024n * 1024n) {
        throw new Error("Insufficient space for core backup");
      }
      const temporary = join(directory, `.backup-${randomUUID()}.tmp`);
      const temporaryManifest = `${temporary}.json`;
      try {
        closeSync(openPrivateFile(temporary));
        db.raw.prepare("VACUUM INTO ?").run(temporary);
        const sourceAfter = statSync(source, { bigint: true });
        if (sourceAfter.dev !== sourceStat.dev || sourceAfter.ino !== sourceStat.ino) {
          throw new Error("Core backup source identity changed");
        }
        const temporaryFd = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { checkOwned(fstatSync(temporaryFd), 0o600, "file"); fsyncSync(temporaryFd); }
        finally { closeSync(temporaryFd); }
        const manifest: BackupManifest = { ...identity, sha256: backupDigest(temporary) };
        const manifestFd = openPrivateFile(temporaryManifest);
        try { writeFileSync(manifestFd, JSON.stringify(manifest)); fsyncSync(manifestFd); }
        finally { closeSync(manifestFd); }
        validateBackup(temporary, identity);
        linkSync(temporary, file);
        linkSync(temporaryManifest, `${file}.json`);
        syncDirectory(directory);
        validateBackup(file, identity);
        return file;
      } finally {
        try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        try { unlinkSync(temporaryManifest); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }).immediate();
  } finally { lock.close(); }
}

/** Produce an independent SQLite snapshot without blocking the caller's event loop. */
export async function snapshotCoreDb(db: Db, destination: string): Promise<void> {
  const parent = dirname(destination);
  checkOwned(lstatSync(parent), 0o700, "directory");
  closeSync(openPrivateFile(destination));
  try {
    await db.raw.backup(destination);
    const fd = openSync(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { checkOwned(fstatSync(fd), 0o600, "file"); fsyncSync(fd); }
    finally { closeSync(fd); }
    syncDirectory(parent);
  } catch (error) {
    unlinkSync(destination);
    throw error;
  }
}

export function openDbReadOnly(dbPath: string, opts: { busyTimeoutMs?: number } = {}): Db | undefined {
  assertTestDbPath(dbPath);
  if (!existsSync(dbPath)) return undefined;
  const Database = loadDatabase();
  const raw = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: opts.busyTimeoutMs ?? BUSY_TIMEOUT_MS });
  const readonly = () => { throw new Error("read-only snapshot DB"); };
  let vecLoaded = false;
  return {
    prepare: sql => raw.prepare(sql),
    exec: readonly,
    transaction: readonly,
    afterCommit: fn => fn(),
    pragma: source => raw.pragma(source, { simple: true }),
    loadVec() {
      if (vecLoaded) return;
      // Loading an extension is connection-local. Snapshot reads must never CREATE vectors.
      raw.loadExtension(sqliteVec().getLoadablePath());
      vecLoaded = true;
    },
    withRetry: fn => withRetry(fn),
    get raw() { return raw; },
    close: () => raw.close(),
  };
}

export function openDb(dbPath: string, opts: { fileMustExist?: boolean; busyTimeoutMs?: number; checkpointOnClose?: boolean; maxCoreSchemaVersion?: number } = {}): Db {
  assertTestDbPath(dbPath);
  if (!opts.fileMustExist) mkdirSync(dirname(dbPath), { recursive: true });
  const Database = loadDatabase();
  const raw = new Database(dbPath, { timeout: opts.busyTimeoutMs ?? BUSY_TIMEOUT_MS, fileMustExist: opts.fileMustExist ?? false });
  try {
    if (opts.maxCoreSchemaVersion !== undefined) {
      const version = Number(raw.pragma("user_version", { simple: true }));
      if (version > opts.maxCoreSchemaVersion) throw new Error(`Cannot open future core schema ${version}`);
      // A newer build may upgrade after this read. Every Spider build since WAL was
      // introduced keeps core stores in WAL mode, so the following pragma is a no-op
      // on a store just migrated by a newer build.
    }
    raw.pragma("journal_mode = WAL");
    raw.pragma("synchronous = NORMAL");
    raw.pragma("foreign_keys = ON");
    raw.pragma(`busy_timeout = ${opts.busyTimeoutMs ?? BUSY_TIMEOUT_MS}`);
  } catch (error) {
    // The caller has no handle yet, notably when a fresh WAL switch is busy.
    raw.close();
    throw error;
  }

  let vecLoaded = false;
  const effects: Array<Array<() => void>> = [];
  return {
    prepare: (sql) => raw.prepare(sql),
    exec: (sql) => { raw.exec(sql); },
    transaction: <T>(fn: () => T) => {
      const transact = raw.transaction(fn);
      return () => {
        const pending: Array<() => void> = [];
        effects.push(pending);
        let result: T;
        try {
          result = transact(); // Includes COMMIT / RELEASE SAVEPOINT, which can throw.
        } catch (error) {
          effects.pop();
          throw error;
        }
        effects.pop();
        const parent = effects.at(-1);
        if (parent) parent.push(...pending);
        else {
          // The commit succeeded. Never make callers mistake an effect failure
          // for rollback, and still run every remaining callback.
          for (const effect of pending) {
            try { effect(); } catch (error) {
              try { console.error("Post-commit effect failed", error); } catch { /* diagnostic is best effort */ }
            }
          }
        }
        return result;
      };
    },
    afterCommit: fn => {
      const pending = effects.at(-1);
      if (pending) pending.push(fn);
      else fn();
    },
    pragma: (source) => raw.pragma(source, { simple: true }),
    withRetry,
    get raw() { return raw; },
    loadVec() {
      if (vecLoaded) return;
      raw.loadExtension(sqliteVec().getLoadablePath());
      raw.exec("CREATE VIRTUAL TABLE IF NOT EXISTS vectors USING vec0(embedding float[384])");
      vecLoaded = true;
    },
    close() { if (opts.checkpointOnClose !== false) { try { raw.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* WAL may be inactive */ } } raw.close(); },
  };
}
