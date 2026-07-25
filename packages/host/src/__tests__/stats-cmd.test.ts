import { describe, it, expect, afterEach } from "vitest";
import { openDbAt } from "@spider/db-core";
import { testScratchPath } from "./testutil.js";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { collectStats } from "../control/stats-cmd.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

function scratchDb(kind: "project" | "global") {
  const p = testScratchPath(`stats-${kind}-${randomUUID()}.db`);
  const db = openDbAt(p, kind);
  cleanups.push(() => {
    try { db.close(); rmSync(p, { force: true }); rmSync(`${p}-wal`, { force: true }); rmSync(`${p}-shm`, { force: true }); } catch { /* ignore */ }
  });
  return db;
}

describe("collectStats", () => {
  it("counts project rows, estimates savings and aggregates model_stats", () => {
    const pdb = scratchDb("project");
    const gdb = scratchDb("global");
    pdb.prepare("INSERT INTO content(source, chunk, is_code, created_at) VALUES (?,?,?,?)").run("s", "hello world chunk of text", 0, Date.now());
    pdb.prepare("INSERT INTO memory(uuid, category, content, created_at) VALUES (?,?,?,?)").run(randomUUID(), "fact", "x", Date.now());
    gdb.prepare("INSERT INTO model_stats(model, ms, ok, tokens, ts) VALUES (?,?,?,?,?)").run("copilot/fast", 100, 1, 500, Date.now());
    gdb.prepare("INSERT INTO model_stats(model, ms, ok, tokens, ts) VALUES (?,?,?,?,?)").run("copilot/fast", 300, 0, 700, Date.now());

    const s = collectStats(pdb, gdb);
    expect(s.rowCounts.content).toBe(1);
    expect(s.rowCounts.memory).toBe(1);
    expect(s.tokenSavings.indexedChunks).toBe(1);
    expect(s.tokenSavings.estTokensSaved).toBeGreaterThan(0);
    const fast = s.models.find((m) => m.model === "copilot/fast")!;
    expect(fast.calls).toBe(2);
    expect(fast.tokens).toBe(1200);
  });

  it("degrades to zeroes on an empty database", () => {
    const s = collectStats(scratchDb("project"), scratchDb("global"));
    expect(s.rowCounts.content).toBe(0);
    expect(s.models).toEqual([]);
    expect(s.tokenSavings.estTokensSaved).toBe(0);
  });
});
