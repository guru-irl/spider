import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "@spider/db-core";
import { migrateUsageLedger, USAGE_MIGRATIONS } from "../migrate.js";
import { USAGE_LEASE_SCHEMA } from "../schema.js";

let root: string;
let db: Db;
beforeEach(() => {
  root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "usage-v3-"));
  db = openDb(join(root, "ledger.db"));
  for (const migration of USAGE_MIGRATIONS.filter(m => m.version <= 2)) db.exec(migration.sql);
  db.exec(USAGE_LEASE_SCHEMA);
  db.pragma("user_version = 2");
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

// Old writers use explicit shipped columns, with no knowledge of v3 decisions.
function insert(id: string, source: string, copied = 0, fingerprint = "same", run: string | null = null) {
  db.prepare(`INSERT INTO calls(id,ts,source_file,entry_id,source_generation,actor,source_kind,
    input,output,cache_read,cache_write,price_status,unpriced_reason,aggregate,counted,copied,fingerprint,run_id)
    VALUES (?,100,?,?,0,'parent','transcript',1,2,3,4,'unpriced','synthetic',0,1,?,?,?)`)
    .run(id, source, id, copied, fingerprint, run);
}
function revision() { return Number((db.prepare("SELECT value FROM ledger_metadata WHERE key='call-selection-revision'").get() as { value: string }).value); }
function decisions() {
  return db.prepare("SELECT id,selection_shadowed AS shadowed,selection_undercount AS undercount FROM calls ORDER BY id").all();
}

// Missing backfill would count the lexically earlier copy or lose completeness.
it("v3 backfills shipped v2 facts additively and repeated migration is inert", () => {
  insert("copy", "a-copy", 1);
  insert("native", "z-native");
  db.exec("INSERT INTO import_state(path,size,offset,last_ingest_at) VALUES ('z-native',20,10,1)");
  const facts = db.prepare("SELECT id,ts,source_file,copied,fingerprint,counted FROM calls ORDER BY id").all();
  const objects = db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
  migrateUsageLedger(db);
  expect(db.prepare("PRAGMA table_info(calls)").all().map(row => (row as { name: string }).name))
    .toContain("selection_shadowed");
  expect(decisions()).toEqual([
    { id: "copy", shadowed: 1, undercount: 0 }, { id: "native", shadowed: 0, undercount: 1 },
  ]);
  expect(db.prepare("SELECT id,ts,source_file,copied,fingerprint,counted FROM calls ORDER BY id").all()).toEqual(facts);
  const after = db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
  // Calls gains v3 selection columns; runs_meta gains the v4 status column.
  // All original SQL is preserved after stripping the additive status column.
  const stripStatus = (row: unknown) => {
    const object = row as { name: string; sql: string };
    return object.name === "runs_meta" ? { ...object, sql: object.sql.replace(/, status TEXT\s+CHECK \(status IN \('queued','running','paused','done','failed','cancelled'\)\)/, "") } : object;
  };
  expect(after.filter(row => (row as { name: string }).name !== "calls" && objects.some(old => (old as { name: string }).name === (row as { name: string }).name)).map(stripStatus))
    .toEqual(objects.filter(row => (row as { name: string }).name !== "calls"));
  const revision = db.prepare("SELECT value FROM ledger_metadata WHERE key='call-selection-revision'").get();
  migrateUsageLedger(db);
  expect(decisions()).toEqual([{ id: "copy", shadowed: 1, undercount: 0 }, { id: "native", shadowed: 0, undercount: 1 }]);
  expect(db.prepare("SELECT value FROM ledger_metadata WHERE key='call-selection-revision'").get()).toEqual(revision);
});

// These writes have exactly the shipped v2 shape and deliberately bypass apply.
it("old writer insert shadows a copy and rollback restores both decisions and revision", () => {
  migrateUsageLedger(db);
  insert("copy", "a", 1);
  const before = revision();
  db.exec("BEGIN");
  insert("native", "z");
  expect(decisions()).toEqual([{ id: "copy", shadowed: 1, undercount: 0 }, { id: "native", shadowed: 0, undercount: 0 }]);
  expect(revision()).toBeGreaterThan(before);
  db.exec("ROLLBACK");
  expect(decisions()).toEqual([{ id: "copy", shadowed: 0, undercount: 0 }]);
  expect(revision()).toBe(before);
});
it("old writer delete promotes the surviving fingerprint copy", () => {
  insert("copy", "a", 1); insert("native", "z"); migrateUsageLedger(db);
  const before = revision();
  db.prepare("DELETE FROM calls WHERE id='native'").run();
  expect(decisions()).toEqual([{ id: "copy", shadowed: 0, undercount: 0 }]);
  expect(revision()).toBeGreaterThan(before);
});
it("old writer counted changes cannot corrupt provenance and fingerprint changes promote peers", () => {
  insert("a", "a"); insert("b", "b"); migrateUsageLedger(db);
  const before = revision();
  db.exec("UPDATE calls SET counted=0 WHERE id='a'");
  expect(decisions()).toEqual([{ id: "a", shadowed: 0, undercount: 0 }, { id: "b", shadowed: 1, undercount: 0 }]);
  expect(revision()).toBe(before); // counted was already ignored in shipped v1/v2.
  db.exec("UPDATE calls SET fingerprint='different' WHERE id='a'");
  expect(decisions()).toEqual([{ id: "a", shadowed: 0, undercount: 0 }, { id: "b", shadowed: 0, undercount: 0 }]);
  expect(revision()).toBeGreaterThan(before);
});
it("old writer copy changes elect a new native winner", () => {
  insert("a", "a"); insert("b", "b"); migrateUsageLedger(db);
  db.exec("UPDATE calls SET copied=1 WHERE id='a'");
  expect(decisions()).toEqual([{ id: "a", shadowed: 1, undercount: 0 }, { id: "b", shadowed: 0, undercount: 0 }]);
});
it("old writers maintain all undercount inputs including duplicate run metadata", () => {
  insert("a", "a", 0, "a", "run"); migrateUsageLedger(db);
  const flag = () => (decisions()[0] as { undercount: number }).undercount;
  const change = (sql: string, want: number) => { const before = revision(); db.exec(sql); expect(flag(), sql).toBe(want); expect(revision()).toBeGreaterThan(before); };
  change("INSERT INTO import_state(path,size,offset,last_ingest_at) VALUES ('a',20,10,1)", 1);
  change("UPDATE import_state SET offset=size", 0);
  change("INSERT INTO incomplete_reports VALUES ('a','run')", 1);
  change("UPDATE incomplete_reports SET path='elsewhere'", 0);
  change("INSERT INTO runs_meta(id,db_path) VALUES ('run','one')", 1);
  change("INSERT INTO runs_meta(id,db_path) VALUES ('run','two')", 1);
  change("UPDATE runs_meta SET ended_at=100 WHERE db_path='one'", 1);
  change("DELETE FROM runs_meta WHERE db_path='two'", 0);
  change("UPDATE calls SET source_file='elsewhere'", 1);
  change("DELETE FROM incomplete_reports", 0);
});
it("stored shadow and undercount changes themselves advance revision but replay is inert", () => {
  insert("a", "a"); migrateUsageLedger(db);
  let before = revision();
  db.exec("UPDATE calls SET selection_shadowed=1"); expect(revision()).toBeGreaterThan(before);
  before = revision();
  db.exec("UPDATE calls SET selection_undercount=1"); expect(revision()).toBeGreaterThan(before);
  before = revision();
  db.exec("UPDATE calls SET selection_shadowed=selection_shadowed,selection_undercount=selection_undercount");
  expect(revision()).toBe(before);
});

it("dimension registry backfills and retains historical non-null and empty values across old-writer reingest", async () => {
  insert("a", "a", 0, "a"); insert("b", "b", 0, "b");
  db.exec("UPDATE calls SET project='',role='historic',ts=50 WHERE id='b'");
  migrateUsageLedger(db);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => (r as { name: string }).name))
    .toContain("dimension_values");
  const { readDimensionValues } = await import("../dimension-values.js");
  expect(readDimensionValues(db, "project")).toEqual([
    { value: "", firstSeen: 50, lastSeen: 50 },
  ]);
  expect(readDimensionValues(db, "project", { limit: 1 })).toEqual([{ value: "", firstSeen: 50, lastSeen: 50 }]);
  expect(readDimensionValues(db, "project", { after: null, limit: 1 })).toEqual([{ value: "", firstSeen: 50, lastSeen: 50 }]);
  db.exec("DELETE FROM calls WHERE id='b'");
  expect(readDimensionValues(db, "role")).toContainEqual({ value: "historic", firstSeen: 50, lastSeen: 50 });
  insert("b", "b", 0, "b");
  db.exec("UPDATE calls SET project='',role='historic',ts=150 WHERE id='b'");
  expect(readDimensionValues(db, "project")).toEqual([
    { value: "", firstSeen: 50, lastSeen: 150 },
  ]);
  expect(readDimensionValues(db, "day")).toEqual([{ value: "1970-01-01", firstSeen: 50, lastSeen: 150 }]);
  expect(() => readDimensionValues(db, "project", { limit: 0 })).toThrow();
});

// Old processes already holding a connection/prepared statement never call the
// new opener. SQLite must maintain decisions after a different process migrates.
it.each([1, 2])("a live v%s explicit-column writer stays correct after another connection migrates", version => {
  const old = openDb(join(root, `old-${version}.db`));
  const newer = openDb(old.raw.name);
  try {
    for (const m of USAGE_MIGRATIONS.filter(m => m.version <= version)) old.exec(m.sql);
    old.exec(USAGE_LEASE_SCHEMA); old.pragma(`user_version=${version}`);
    const write = old.prepare(`INSERT INTO calls(id,ts,source_file,entry_id,source_generation,actor,source_kind,
      input,output,cache_read,cache_write,price_status,unpriced_reason,aggregate,counted,copied,fingerprint)
      VALUES (?,100,?,?,0,'parent','transcript',1,2,3,4,'unpriced','synthetic',0,1,?,'same')`);
    write.run("copy", "a-copy", "copy", 1);
    migrateUsageLedger(newer);
    write.run("native", "z-native", "native", 0);
    expect(old.prepare("SELECT id,selection_shadowed AS shadowed FROM calls ORDER BY id").all())
      .toEqual([{ id: "copy", shadowed: 1 }, { id: "native", shadowed: 0 }]);
    old.exec("DELETE FROM calls WHERE id='native'");
    expect(old.prepare("SELECT selection_shadowed AS shadowed FROM calls").get()).toEqual({ shadowed: 0 });
  } finally { newer.close(); old.close(); }
});

it("dimension registry keyset cursor excludes its boundary including an empty string", async () => {
  migrateUsageLedger(db); insert("a", "a"); insert("b", "b", 0, "b");
  db.exec("UPDATE calls SET project='' WHERE id='a'; UPDATE calls SET project='next' WHERE id='b';");
  const { readDimensionValues } = await import("../dimension-values.js");
  expect(readDimensionValues(db, "project", { limit: 1 })).toEqual([{ value: "", firstSeen: 100, lastSeen: 100 }]);
  expect(readDimensionValues(db, "project", { after: "", limit: 1 })).toEqual([{ value: "next", firstSeen: 100, lastSeen: 100 }]);
  expect(readDimensionValues(db, "project", { after: "next" })).toEqual([]);
});
