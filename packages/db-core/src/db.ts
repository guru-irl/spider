// packages/db-core/src/db.ts
import { createRequire } from "node:module";
import { mkdirSync, realpathSync, existsSync, lstatSync } from "node:fs";
import { dirname, basename, isAbsolute, join, resolve, sep } from "node:path";
import type BetterSqlite3 from "better-sqlite3";

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

export function openDbReadOnly(dbPath: string): Db | undefined {
  assertTestDbPath(dbPath);
  if (!existsSync(dbPath)) return undefined;
  const Database = loadDatabase();
  const raw = new Database(dbPath, { readonly: true, fileMustExist: true });
  const readonly = () => { throw new Error("read-only snapshot DB"); };
  return {
    prepare: sql => raw.prepare(sql),
    exec: readonly,
    transaction: readonly,
    afterCommit: fn => fn(),
    pragma: source => raw.pragma(source, { simple: true }),
    loadVec: readonly,
    withRetry: fn => withRetry(fn),
    get raw() { return raw; },
    close: () => raw.close(),
  };
}

export function openDb(dbPath: string): Db {
  assertTestDbPath(dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  const Database = loadDatabase();
  const raw = new Database(dbPath, { timeout: BUSY_TIMEOUT_MS });
  raw.pragma("journal_mode = WAL");
  raw.pragma("synchronous = NORMAL");
  raw.pragma("foreign_keys = ON");
  raw.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);

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
    close() { try { raw.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* WAL may be inactive */ } raw.close(); },
  };
}
