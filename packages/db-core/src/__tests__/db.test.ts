// packages/db-core/src/__tests__/db.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "../db.js";
import { scratchDbPath, cleanupScratch } from "../testutil.js";

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
});
