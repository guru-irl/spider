import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDb, type Db } from "@spider/db-core";
import { openUsageLedger, openUsageLedgerReadOnly } from "../ledger.js";
import { assertUsageSchemaVersion, migrateUsageLedger } from "../migrate.js";
import { USAGE_SCHEMA_V4 } from "../schema-v4.js";
import { upgradeReportedCostSchema } from "../schema.js";
import { ingestOnce } from "../ingest.js";

let root: string;
const handles: { close(): void }[] = [];
function track<T extends { close(): void }>(value: T): T { handles.push(value); return value; }
function fixture(): Db {
  const db = track(openDb(join(root, "usage.db")));
  db.exec(readFileSync(new URL("./fixtures/usage-v3.sql", import.meta.url), "utf8"));
  db.exec(USAGE_SCHEMA_V4);
  upgradeReportedCostSchema(db.raw);
  db.pragma("user_version=5");
  return db;
}
const layout = (db: Db) => db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
beforeEach(() => { root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "usage-v6-")); });
afterEach(() => { for (const handle of handles.splice(0).reverse()) handle.close(); rmSync(root, { recursive: true, force: true }); });

// Breaks if migration rewrites durable calls, drops dependencies, fabricates values, or repeats.
it("upgrades a v5 fixture once while preserving call rowids, selection, counters and metadata", () => {
  const db = fixture();
  const calls = db.prepare("SELECT rowid,* FROM calls ORDER BY rowid").all() as Record<string, unknown>[];
  const counter = db.prepare("SELECT * FROM counter_snapshots").all();
  const selected = db.prepare("SELECT id,input,aic FROM counted_calls").all();
  expect(calls).toHaveLength(1);
  expect(() => assertUsageSchemaVersion(db)).not.toThrow();
  migrateUsageLedger(db);
  expect(db.pragma("user_version")).toBe(6);
  const upgraded = db.prepare("SELECT rowid,* FROM calls ORDER BY rowid").all();
  expect(upgraded).toEqual(calls.map(call => ({ ...call, thinking_level: null, provider_thinking_level: null, tool_call_id: null, tool_duration_ms: null })));
  expect(db.prepare("SELECT id,input,aic FROM counted_calls").all()).toEqual(selected);
  expect(db.prepare("SELECT * FROM counter_snapshots").all()).toEqual(counter);
  expect(db.prepare("SELECT value FROM ledger_metadata WHERE key='schema-layout'").get()).toEqual({ value: "v1-ingest-append-1" });
  expect(() => assertUsageSchemaVersion(db)).not.toThrow();
  const before = layout(db), cursors = db.prepare("SELECT * FROM import_state").all();
  migrateUsageLedger(db);
  expect(layout(db)).toEqual(before);
  expect(db.prepare("SELECT * FROM import_state").all()).toEqual(cursors);
});

it("rolls back an interrupted v6 migration without invalidating the historical cursor", () => {
  const db = fixture();
  const before = layout(db), cursors = db.prepare("SELECT * FROM import_state").all();
  const exec = db.exec.bind(db);
  const fault = vi.spyOn(db, "exec").mockImplementation(sql => {
    exec(sql);
    if (sql.includes("tool_duration_ms")) throw new Error("interrupted v6");
  });
  try { expect(() => migrateUsageLedger(db)).toThrow("interrupted v6"); } finally { fault.mockRestore(); }
  expect(db.pragma("user_version")).toBe(5);
  expect(layout(db)).toEqual(before);
  expect(db.prepare("SELECT * FROM import_state").all()).toEqual(cursors);
  migrateUsageLedger(db);
  expect(db.pragma("user_version")).toBe(6);
});

it("a read-only v5 follower neither needs the new columns nor migrates the writer's file", () => {
  const db = fixture(), before = layout(db);
  const reader = track(openUsageLedgerReadOnly(join(root, "usage.db"))!);
  expect(reader.health().schemaVersion).toBe(5);
  expect(reader.getProgress().calls).toBe(1);
  expect(layout(db)).toEqual(before);
  expect(db.pragma("user_version")).toBe(5);
});

// Breaks if an unchanged transcript is stat-skipped after the upgrade, re-read on every open,
// or its retained facts are deleted before the replacement scan succeeds.
it("re-reads unchanged transcripts once after v5, retaining facts when the source is unavailable", async () => {
  const db = fixture(), path = join(root, "history.jsonl");
  const at = Date.parse("2026-10-04T12:00:00Z");
  const header = { type: "session", id: "historical-session", timestamp: new Date(at).toISOString() };
  const message = { type: "message", id: "historical", timestamp: new Date(at).toISOString(), message: {
    role: "assistant", provider: "github-copilot", model: "gpt-6.1-sol", usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
    durationMs: 32, thinkingLevel: "low", providerThinkingLevel: "minimal",
  } };
  const body = [header, message].map(e => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(path, body);
  const info = statSync(path), bytes = Buffer.from(body), hash = createHash("sha256").update(bytes).digest("hex");
  db.prepare(`INSERT INTO calls(id,ts,source_file,entry_id,source_generation,actor,source_kind,input,output,cache_read,cache_write,
    price_status,unpriced_reason,aggregate,counted,copied,fingerprint)
    VALUES ('old-history',?,?,'historical',0,'parent','transcript',10,20,0,0,'unpriced','missing-attribution',0,1,0,'history')`).run(at, path);
  db.prepare(`INSERT INTO import_state(path,inode,size,mtime_ms,offset,parse_errors,generation,prefix_hash,last_ingest_at)
    VALUES (?,?,?,?,?,0,0,?,?)`).run(path, `${info.dev}:${info.ino}`, info.size, info.mtimeMs, info.size, hash, at);
  db.prepare("INSERT INTO source_context(path,header,tail_hash) VALUES (?,?,?)").run(path, JSON.stringify(header), hash);
  const auxPath = `${join(root, "runs.db")}#spider-aux`;
  db.prepare(`INSERT INTO import_state(path,inode,size,mtime_ms,offset,generation,last_ingest_at) VALUES (?, 'aux-inode',0,0,0,0,0)`).run(auxPath);
  const ledger = track(openUsageLedger(join(root, "usage.db")));
  const source = { path, project: null, repo: null, run: null };
  const discovery = { sources: [source], runs: [], errors: [] };
  const retained = db.prepare("SELECT * FROM calls WHERE source_file=?").all(path);
  renameSync(path, `${path}.parked`);
  await ingestOnce(ledger, discovery, at, new AbortController().signal);
  expect(db.prepare("SELECT * FROM calls WHERE source_file=?").all(path)).toEqual(retained);
  renameSync(`${path}.parked`, path);
  await ingestOnce(ledger, discovery, at, new AbortController().signal);
  expect(ledger.getImportState(auxPath)?.inode).toBe("aux-inode");
  expect(db.prepare("SELECT latency_ms,thinking_level,provider_thinking_level FROM calls WHERE source_file=?").get(path))
    .toEqual({ latency_ms: 32, thinking_level: "low", provider_thinking_level: "minimal" });
  const cursor = ledger.getImportState(path);
  expect(cursor).toMatchObject({ generation: 1, offset: info.size, inode: `${info.dev}:${info.ino}` });
  const before = db.prepare("SELECT rowid,* FROM calls WHERE source_file=?").all(path);
  const follower = track(openUsageLedger(join(root, "usage.db")));
  await ingestOnce(follower, discovery, at + 1, new AbortController().signal);
  expect(follower.getImportState(path)).toEqual(cursor);
  expect(db.prepare("SELECT rowid,* FROM calls WHERE source_file=?").all(path)).toEqual(before);
});
