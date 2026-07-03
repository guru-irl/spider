import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "../db";
import { scratchDbPath, cleanupScratch } from "../testutil";

const opened: { close(): void }[] = [];
afterEach(() => { for (const d of opened) d.close(); opened.length = 0; cleanupScratch(); });

describe("sqlite-vec loadVec", () => {
  it("loads the extension and creates the vec0 vectors table", () => {
    const db = openDb(scratchDbPath("vec")); opened.push(db);
    db.loadVec();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE name = 'vectors'").get();
    expect(row).toBeTruthy();
    // KNN query against an empty index must not throw.
    const q = JSON.stringify(new Array(384).fill(0));
    const res = db.prepare(
      "SELECT rowid FROM vectors WHERE embedding MATCH ? ORDER BY distance LIMIT 1"
    ).all(q);
    expect(Array.isArray(res)).toBe(true);
  });

  it("is idempotent — a second loadVec() is a no-op", () => {
    const db = openDb(scratchDbPath("vec2")); opened.push(db);
    db.loadVec();
    expect(() => db.loadVec()).not.toThrow();
  });
});
