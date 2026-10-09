import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "@spider/db-core";
import { migrateUsageLedger, USAGE_MIGRATIONS } from "../migrate.js";
import { USAGE_SCHEMA, USAGE_SCHEMA_V2, USAGE_LEASE_SCHEMA, countedUsageSql } from "../schema.js";
import * as schema from "../schema.js";
import { USAGE_SCHEMA_V3 } from "../schema-v3.js";
import { DIMENSION_COLUMNS, readDimensionValues } from "../dimension-values.js";
import { dynamicSelectionSql } from "./fixtures/selection-v3.js";
import { openDashboardReader } from "../dashboard-reader.js";
import { readMeasure } from "../dashboard-selection.js";
import { readUsageCube, sumValues } from "../query-redesign-shared.js";
import { customRange } from "./fixtures/redesign-range.js";

let root: string, file: string, db: Db;
beforeEach(() => {
  root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "selection-fixes-")); file = join(root, "l.db"); db = openDb(file);
  for (const m of USAGE_MIGRATIONS.filter(m => m.version <= 2)) db.exec(m.sql);
  db.exec(USAGE_LEASE_SCHEMA); db.pragma("user_version=2");
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
function insert(id: string, source = id, entry = id, fingerprint = id, run: string | null = null) {
  db.prepare(`INSERT INTO calls(id,ts,source_file,entry_id,source_generation,actor,source_kind,input,output,cache_read,cache_write,
    price_status,aic,aic_input,aic_cache_read,aic_cache_write,aic_output,rate_version,tier,confidence,aggregate,counted,copied,fingerprint,run_id)
    VALUES (?,100,?,?,0,'parent','transcript',1,2,3,4,'priced',0.123456789,0.123456789,0,0,0,'r','t','estimated',0,1,0,?,?)`).run(id, source, entry, fingerprint, run);
}
function flags() { return db.prepare("SELECT id,selection_shadowed s,selection_undercount u FROM calls ORDER BY id").all(); }

it("pins all shipped migration SQL including the approved v3 SQL", () => {
  const hash = (sql: string) => createHash("sha256").update(sql).digest("hex");
  expect(hash(USAGE_SCHEMA)).toBe("abe25e614cdeae4819148f2815b1bf114941cc79a858196a09e99483e4c3d035");
  expect(hash(USAGE_SCHEMA_V2)).toBe("14001c76dc6563f1328d64b9b6b71867c02e8866c04470df5b963c30f30eaff5");
  expect(hash(USAGE_SCHEMA_V3)).toBe("9d97a2254dc1d653fcbf1682ca9dbe3d39e777d2763976bbbe97a0bae820f086");
});
it.each(["import_state", "runs_meta"])("%s refresh scans only when completeness flips or identity moves", table => {
  insert("a", "s", "a", "a", "r"); migrateUsageLedger(db);
  let scans = 0; db.raw.function("refresh_probe", () => { scans++; return 1; });
  const name = `selection_inputs_${table}_update`;
  const original = (db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name) as { sql: string }).sql;
  db.exec(`DROP TRIGGER ${name}`);
  db.exec(original.replace("WHERE (", "WHERE refresh_probe() AND ("));
  if (table === "import_state") {
    db.exec("INSERT INTO import_state(path,size,offset,last_ingest_at) VALUES ('s',10,10,1)");
    db.exec("UPDATE import_state SET size=20,offset=20"); expect(scans).toBe(0);
    db.exec("UPDATE import_state SET size=21"); expect(scans).toBeGreaterThan(0);
  } else {
    db.exec("INSERT INTO runs_meta(id,db_path,ended_at) VALUES ('r','d',10)");
    db.exec("UPDATE runs_meta SET ended_at=20"); expect(scans).toBe(0);
    db.exec("UPDATE runs_meta SET ended_at=NULL"); expect(scans).toBeGreaterThan(0);
  }
  expect(flags()).toEqual([{ id: "a", s: 0, u: 1 }]);
});
it("backfill does not rewrite rows whose decisions stay zero", () => {
  insert("a"); insert("b", "s", "b", "same"); insert("c", "s", "c", "same");
  db.exec("CREATE TABLE writes(id TEXT); CREATE TRIGGER track_backfill AFTER UPDATE ON calls BEGIN INSERT INTO writes VALUES (NEW.id); END;");
  db.raw.transaction(() => db.exec(USAGE_SCHEMA_V3)).immediate();
  expect(db.prepare("SELECT id FROM writes ORDER BY id").all()).toEqual([{ id: "c" }]);
});
it("old writers insert undercounted calls, move to new groups and reorder entry-only within a source", () => {
  migrateUsageLedger(db);
  db.exec("INSERT INTO runs_meta(id,db_path) VALUES ('r','d')");
  insert("a", "s", "e1", "fp", "r"); insert("b", "s", "e3", "fp"); insert("c", "z", "c", "other");
  expect(flags()).toEqual([{ id: "a", s: 0, u: 1 }, { id: "b", s: 1, u: 0 }, { id: "c", s: 0, u: 0 }]);
  db.exec("UPDATE calls SET entry_id='e4' WHERE id='a'");
  expect(flags()).toEqual([{ id: "a", s: 1, u: 1 }, { id: "b", s: 0, u: 0 }, { id: "c", s: 0, u: 0 }]);
  db.exec("UPDATE calls SET fingerprint='other' WHERE id='b'");
  expect(flags()).toEqual([{ id: "a", s: 0, u: 1 }, { id: "b", s: 0, u: 0 }, { id: "c", s: 1, u: 0 }]);
  db.exec("UPDATE calls SET source_file='zz' WHERE id='b'");
  expect(flags()).toEqual([{ id: "a", s: 0, u: 1 }, { id: "b", s: 1, u: 0 }, { id: "c", s: 0, u: 0 }]);
});
it("actor-only, aggregate-only and run-only edits refresh report completeness", () => {
  migrateUsageLedger(db); insert("a", "s", "a", "a", "r");
  db.exec("INSERT INTO runs_meta(id,db_path) VALUES ('r','d')");
  const flag = () => (flags()[0] as { u: number }).u;
  expect(flag()).toBe(1);
  // Generated is_report is exactly actor=subagent, aggregate=1, run_id!=NULL.
  db.exec("UPDATE calls SET aggregate=1 WHERE id='a'"); expect(flag()).toBe(1);
  db.exec("UPDATE calls SET actor='subagent',source_kind='report' WHERE id='a'"); expect(flag()).toBe(0);
  db.exec("UPDATE calls SET aggregate=0,source_kind='transcript' WHERE id='a'"); expect(flag()).toBe(1);
  db.exec("UPDATE calls SET run_id='other' WHERE id='a'"); expect(flag()).toBe(0);
  db.exec("INSERT INTO incomplete_reports VALUES ('s','r')"); expect(flag()).toBe(0);
  db.exec("UPDATE incomplete_reports SET run_id='other'"); expect(flag()).toBe(1);
  db.exec("UPDATE incomplete_reports SET run_id='r'"); expect(flag()).toBe(0);
  db.exec("UPDATE runs_meta SET id='other'"); expect(flag()).toBe(1);
  db.exec("UPDATE runs_meta SET ended_at=100"); expect(flag()).toBe(0);
});
it("registry maps every dimension, skips null and preserves timestamp extrema across insert and edit", () => {
  migrateUsageLedger(db); insert("a");
  expect(readDimensionValues(db, "role")).toEqual([]);
  const assignments = Object.entries(DIMENSION_COLUMNS).filter(([d]) => d !== "day").map(([d,c]) => `${c}='${d === "actor" ? "subagent" : `value-${d}`}'`);
  db.exec(`UPDATE calls SET ${assignments.join(",")},ts=1000 WHERE id='a'`);
  for (const [d] of Object.entries(DIMENSION_COLUMNS)) {
    expect(readDimensionValues(db, d as keyof typeof DIMENSION_COLUMNS)).toContainEqual({ value: d === "day" ? "1970-01-01" : d === "actor" ? "subagent" : `value-${d}`, firstSeen: d === "day" ? 100 : 1000, lastSeen: 1000 });
  }
  insert("b"); db.exec("UPDATE calls SET role='value-role',ts=2000 WHERE id='b'");
  db.exec("UPDATE calls SET ts=500 WHERE id='b'");
  expect(readDimensionValues(db, "role")).toEqual([{ value: "value-role", firstSeen: 500, lastSeen: 2000 }]);
  db.exec("DELETE FROM calls"); expect(readDimensionValues(db, "role")).toEqual([{ value: "value-role", firstSeen: 500, lastSeen: 2000 }]);
});
it("dynamic reference fails loudly if any stored predicate replacement stops matching", () => {
  const sql = countedUsageSql("1", "c.*", undefined, true);
  expect(dynamicSelectionSql(sql)).not.toBe(sql);
  for (const text of ["c.selection_shadowed = 0", "active.selection_shadowed = 0", "w.selection_undercount AS possible_undercount"])
    expect(() => dynamicSelectionSql(sql.replaceAll(text, "1"))).toThrow(/replacement/);
});
it("dynamic reference rejects a changed window matcher rather than returning stored SQL", () => {
  const sql = countedUsageSql("1", "c.*", undefined, true).replace("window AS MATERIALIZED", "window AS NOT MATERIALIZED");
  expect(() => dynamicSelectionSql(sql)).toThrow(/replacement/);
});
it("stored narrow result has only requested columns and public selection flags", () => {
  migrateUsageLedger(db); insert("a");
  const sql = countedUsageSql("1", "c.ts,c.run_id,c.is_report,c.source_file,c.source_kind", undefined, true);
  expect(Object.keys(db.prepare(sql).get()!)).not.toContain("selection_undercount");
});
it.each([2, 3])("replacement selects canonical rows on unmigrated v%s", version => {
  insert("a"); insert("b", "b", "b", "a");
  if (version === 3) { db.exec(USAGE_SCHEMA_V3); db.pragma("user_version=3"); }
  const reader = openDashboardReader(file, { instanceId: "fixture", serverBuild: "fixture", now: () => 1000, calibrationMode: () => "off" })!;
  try {
    reader.snapshot(ctx => {
      const queries: string[] = [], prepare = ctx.db.prepare.bind(ctx.db);
      const spy = vi.spyOn(ctx.db, "prepare").mockImplementation(sql => { queries.push(sql); return prepare(sql); });
      try { expect(readMeasure(ctx, { start: 0, end: 1000, filters: [] }).calls).toBe(1); } finally { spy.mockRestore(); }
      const selections = queries.filter(sql => sql.includes("selected_reports") && sql.includes("FROM calls c"));
      expect(selections.length).toBeGreaterThan(0);
      for (const sql of selections) expect(sql.includes("c.selection_shadowed = 0")).toBe(version === 3);
    });
  } finally { reader.close(); }
});
it.each(["published", "calibrated", "back-applied"])("replacement keeps %s credit precision in all slices", basis => {
  migrateUsageLedger(db); insert("a");
  const reader = openDashboardReader(file, { instanceId: "rounding", serverBuild: "fixture", now: () => 1000, calibrationMode: () => "auto" })!;
  try {
    reader.snapshot(ctx => {
      const fallback = ctx.calibration.at(999, "off"), fit = { ...fallback, status: "calibrated" as const, factor: 0.54321987, windowEnd: 2000 };
      ctx = { ...ctx, calibrationMode: basis === "published" ? "off" : "auto", calibration: { ...ctx.calibration,
        atMany: ends => ends.map(() => basis === "calibrated" ? fit : fallback), earliest: () => fit } };
      const cube = readUsageCube(ctx, customRange(0, 1000));
      const expected = 0.123456789 * (basis === "published" ? 1 : 0.54321987);
      expect(cube.total.credits).toBe(expected); expect(sumValues(cube.rows.map(row => row.value))).toEqual(cube.total);
    });
  } finally { reader.close(); }
});
