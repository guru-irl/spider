import { afterEach, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { openDbAt, type Db } from "@spider/db-core";
import { RunStore } from "../run-store";
import * as usageModule from "../usage";
import { resolve } from "node:path";
const testScratchPath = (name: string) => resolve(".spider/scratch/usage-reporting", name);
const { recordRunUsage } = usageModule;
const api = usageModule as any;
const usage = { input: 10, output: 3, cacheRead: 5, cacheWrite: 2, cacheWrite1h: 1, reasoning: 2, totalTokens: 20,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 } };
const dbs: Db[] = [], files: string[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.raw.open) db.close(); for (const path of files.splice(0)) rmSync(path, { force: true }); });
function fixture() {
  const path = testScratchPath(`usage-report-${randomUUID()}.db`), db = openDbAt(path, "project"); dbs.push(db); files.push(path);
  const store = new RunStore(db), { id } = store.create({ sessionId: "owner", agent: "worker", name: "fixture" });
  return { path, db, store, id };
}
// Break: taking the last turn, grouping by model alone, or dropping optional usage/cost fields.
it("sums assistant and child auxiliary usage by provider and response model", () => {
  const f = fixture();
  recordRunUsage(f.db, f.id, { provider: "fixture", model: "actual", usage });
  recordRunUsage(f.db, f.id, { provider: "fixture", model: "actual", usage }, "memory-review");
  recordRunUsage(f.db, f.id, { provider: "other", model: "actual", usage });
  expect(api.runUsage?.(f.db, f.id)).toEqual([
    { provider: "fixture", model: "actual", usage: { input: 20, output: 6, cacheRead: 10, cacheWrite: 4, cacheWrite1h: 2, reasoning: 4, totalTokens: 40,
      cost: { input: 0.2, output: 0.4, cacheRead: 0.06, cacheWrite: 0.08, total: 0.74 } } },
    { provider: "other", model: "actual", usage },
  ]);
  expect(f.store.get(f.id)?.token_count).toBe(60);
});
// Break: marking too early, or keeping the marker in activation-local state.
it.each(["done", "failed", "cancelled"])("reports %s exactly once across double finalize and a restored DB", status => {
  const f = fixture(), reports: any[] = [];
  recordRunUsage(f.db, f.id, { provider: "fixture", model: "actual", usage });
  f.store.finish(f.id, { status: status as any });
  const sink = (run: any, records: any) => { reports.push({ id: run.id, records }); return true; };
  api.reportRunUsage?.(f.db, f.store.get(f.id), sink);
  api.reportRunUsage?.(f.db, f.store.get(f.id), sink);
  f.db.close();
  const restored = openDbAt(f.path, "project"); dbs.push(restored);
  api.reportRunUsage?.(restored, new RunStore(restored).get(f.id), sink);
  expect(reports).toEqual([{ id: f.id, records: [{ provider: "fixture", model: "actual", usage }] }]);
  expect(restored.prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id=? AND type='spider_usage_reported'").get(f.id)).toEqual({ n: 1 });
});
it("leaves a refused report unmarked so its owner can report after resume", () => {
  const f = fixture(), reports: any[] = [];
  recordRunUsage(f.db, f.id, { provider: "fixture", model: "actual", usage }); f.store.finish(f.id, { status: "done" });
  api.reportRunUsage?.(f.db, f.store.get(f.id), () => false);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM run_events WHERE type='spider_usage_reported'").get()).toEqual({ n: 0 });
  api.reportRunUsage?.(f.db, f.store.get(f.id), (_run: any, records: any) => { reports.push(records); return true; });
  expect(reports).toHaveLength(1);
});

// P1: acquire the writer lock before invoking the session sink, not after appending.
it("holds the write lock before the sink so a concurrent writer cannot break marker commit", () => {
  const f = fixture(), other = openDbAt(f.path, "project"); dbs.push(other);
  other.raw.pragma("busy_timeout = 0");
  recordRunUsage(f.db, f.id, { provider: "fixture", model: "actual", usage }); f.store.finish(f.id, { status: "done" });
  let appended = 0, concurrentError: any;
  expect(api.reportRunUsage(f.db, f.store.get(f.id), () => {
    appended++;
    try { other.raw.prepare("UPDATE runs SET token_count=token_count+1 WHERE id=?").run(f.id); } catch (error) { concurrentError = error; }
    return true;
  })).toBe(true);
  expect(concurrentError?.code).toBe("SQLITE_BUSY");
  expect(appended).toBe(1);
  expect(f.db.prepare("SELECT COUNT(*) n FROM run_events WHERE type='spider_usage_reported'").get()).toEqual({ n: 1 });
});
