// packages/db-core/src/__tests__/db.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { openDb, withRetry } from "../db";
import { scratchDbPath, cleanupScratch } from "../testutil";

const opened: { close(): void }[] = [];
afterEach(() => { for (const d of opened) d.close(); opened.length = 0; cleanupScratch(); });

describe("Db wrapper", () => {
  it("opens in WAL mode with a nonzero busy_timeout", () => {
    const db = openDb(scratchDbPath("wal")); opened.push(db);
    expect(String(db.pragma("journal_mode")).toLowerCase()).toBe("wal");
    expect(Number(db.pragma("busy_timeout"))).toBeGreaterThan(0);
  });

  it("runs prepared statements and transactions", () => {
    const db = openDb(scratchDbPath("tx")); opened.push(db);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const insert = db.transaction(() => {
      db.prepare("INSERT INTO t (v) VALUES (?)").run("a");
      db.prepare("INSERT INTO t (v) VALUES (?)").run("b");
    });
    insert();
    const row = db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number };
    expect(row.n).toBe(2);
  });

  it("withRetry passes non-busy errors straight through", () => {
    const db = openDb(scratchDbPath("retry")); opened.push(db);
    expect(() => db.withRetry(() => { throw new Error("boom"); })).toThrow("boom");
  });

  it("withRetry returns the value on success", () => {
    const db = openDb(scratchDbPath("retry2")); opened.push(db);
    expect(db.withRetry(() => 42)).toBe(42);
  });

  it("withRetry retries on SQLITE_BUSY then succeeds", () => {
    let callCount = 0;
    const fn = () => {
      callCount++;
      if (callCount < 3) throw new Error("SQLITE_BUSY: database is locked");
      return 42;
    };
    const result = withRetry(fn);
    expect(result).toBe(42);
    expect(callCount).toBe(3);
  });

  it("withRetry throws after bounded retries", () => {
    let callCount = 0;
    const fn = () => {
      callCount++;
      throw new Error("SQLITE_BUSY: database is locked");
    };
    // withRetry default delays = [100, 500, 2000], so max attempts = delays.length + 1 = 4
    expect(() => withRetry(fn)).toThrow(/SQLITE_BUSY after 3 retries/);
    expect(callCount).toBe(4);
  });

  it("withRetry rethrows non-SQLITE_BUSY error immediately", () => {
    let callCount = 0;
    const fn = () => {
      callCount++;
      throw new Error("boom");
    };
    expect(() => withRetry(fn)).toThrow("boom");
    expect(callCount).toBe(1);
  });

  it("loadVec loads sqlite-vec extension", () => {
    const db = openDb(scratchDbPath("vec")); opened.push(db);
    db.loadVec();
    // Verify the extension loaded by calling vec_version()
    const row = db.prepare("SELECT vec_version() AS v").get() as { v: string };
    expect(row.v).toBeTruthy();
    expect(typeof row.v).toBe("string");
  });
});
