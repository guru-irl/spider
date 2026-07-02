// packages/db-core/src/db.ts
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
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
  transaction<T>(fn: () => T): () => T;
  pragma(source: string): unknown;
  loadVec(): void;
  withRetry<T>(fn: () => T): T;
  readonly raw: BetterSqlite3.Database;
  close(): void;
}

let _sqliteVec: { getLoadablePath(): string } | null = null;
function sqliteVec(): { getLoadablePath(): string } {
  if (!_sqliteVec) _sqliteVec = require("sqlite-vec") as { getLoadablePath(): string };
  return _sqliteVec;
}

export function openDb(dbPath: string): Db {
  mkdirSync(dirname(dbPath), { recursive: true });
  const Database = loadDatabase();
  const raw = new Database(dbPath, { timeout: BUSY_TIMEOUT_MS });
  raw.pragma("journal_mode = WAL");
  raw.pragma("synchronous = NORMAL");
  raw.pragma("foreign_keys = ON");
  raw.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);

  let vecLoaded = false;
  return {
    prepare: (sql) => raw.prepare(sql),
    exec: (sql) => { raw.exec(sql); },
    transaction: <T>(fn: () => T) => raw.transaction(fn),
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
