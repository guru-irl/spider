import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "@spider/db-core";
import { assertUsageSchemaVersion, migrateUsageLedger, USAGE_MIGRATIONS } from "../migrate.js";
import { openUsageLedger, type ImportBatch } from "../ledger.js";

let root: string;
const handles: Db[] = [];
function fixture(): Db {
  const db = openDb(join(root, `fixture-${handles.length}.db`));
  handles.push(db);
  db.exec(readFileSync(new URL("./fixtures/usage-v1.sql", import.meta.url), "utf8"));
  return db;
}
function revision(db: Db): number {
  const row = db.prepare("SELECT value FROM ledger_metadata WHERE key='call-selection-revision'").get() as { value: string } | undefined;
  return row ? Number(row.value) : -1;
}
beforeEach(() => { root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "revision-triggers-")); });
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  rmSync(root, { recursive: true, force: true });
});

// Independent list of content fields, not derived from the trigger definitions.
// Legacy counted/origin_key and parser/coordination tables do not affect selection.
const columns: Record<string, readonly string[]> = {
  calls: ["id", "ts", "source_file", "entry_id", "source_generation", "project", "repo", "session_id", "run_id",
    "actor", "role", "agent", "run_name", "phase", "parent_run_id", "aux_purpose", "provider", "model", "raw_provider", "raw_model",
    "requested_model", "thinking", "api", "source_kind", "input", "output", "cache_read", "cache_write", "cache_write_1h",
    "reasoning", "total_tokens", "aic", "aic_input", "aic_cache_read", "aic_cache_write", "aic_output", "price_status", "unpriced_reason",
    "rate_version", "tier", "confidence", "pi_cost", "latency_ms", "aggregate", "response_id", "copied", "fingerprint"],
  runs_meta: ["id", "db_path", "project", "repo", "session_id", "parent_run_id", "agent", "role", "name", "model", "thinking", "phase", "started_at", "ended_at"],
  coverage_edges: ["report_run_id", "included_run_id", "evidence"],
  pending_reports: ["path", "run_id", "generation", "first_seen", "calls"],
  incomplete_reports: ["path", "run_id"],
  import_state: ["path", "generation", "offset", "size"],
  call_ancestry_edges: ["parent", "child"],
};

// Catches a missing UPDATE OF column, missing update trigger or unconditional bump.
// Disable CHECKs only for this isolated trigger contract: some price/report fields
// cannot change individually in a valid call. No application ingest uses this pragma.
for (const [table, fields] of Object.entries(columns)) {
  it(`raw writer updates every selection field of ${table} and skips identical values`, () => {
    const db = fixture();
    migrateUsageLedger(db);
    db.pragma("ignore_check_constraints = ON");
    if (table === "call_ancestry_edges") db.exec("INSERT INTO call_ancestry_edges VALUES ('parent','child',1)");
    const types = new Map((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[]).map(row => [row.name, row.type]));
    for (const field of fields) {
      const before = revision(db);
      const value = types.get(field) === "TEXT" ? `COALESCE(${field},'') || '-changed'` : `COALESCE(${field},0)+1`;
      db.exec(`UPDATE ${table} SET ${field}=${value}`);
      expect(revision(db), `${table}.${field}`).toBeGreaterThan(before);
      const changed = revision(db);
      db.exec(`UPDATE ${table} SET ${field}=${field}`);
      expect(revision(db), `${table}.${field} replay`).toBe(changed);
    }
  });
  // Catches each dropped INSERT/DELETE trigger, separately from UPDATE coverage.
  it(`raw writer inserts and deletes ${table} without application code`, () => {
    const db = fixture();
    migrateUsageLedger(db);
    if (table === "call_ancestry_edges") db.exec("INSERT INTO call_ancestry_edges VALUES ('parent','child',1)");
    const fields = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name).join(",");
    db.exec(`CREATE TEMP TABLE saved AS SELECT ${fields} FROM ${table}`);
    const before = revision(db);
    db.exec(`DELETE FROM ${table}`);
    expect(revision(db), `${table} deletion`).toBeGreaterThan(before);
    const deleted = revision(db);
    db.exec(`INSERT INTO ${table} (${fields}) SELECT ${fields} FROM saved`);
    expect(revision(db), `${table} insertion`).toBeGreaterThan(deleted);
  });
}

it("a v1-style writer opened before upgrade advances revision and rolls back atomically", () => {
  const old = fixture();
  const upgrader = openDb(old.raw.name);
  handles.push(upgrader);
  migrateUsageLedger(upgrader);
  const before = revision(upgrader);
  // These are the v1 alias-update and source-cursor write shapes, with no bump call.
  old.raw.transaction(() => {
    old.prepare("UPDATE calls SET model=@model, fingerprint=@fingerprint WHERE id=@id")
      .run({model: "fixture-canonical", fingerprint: "fixture-new-fingerprint", id: "v1-call"});
    old.exec("UPDATE import_state SET offset=size, last_ingest_at=2000");
  }).immediate();
  expect(revision(upgrader)).toBeGreaterThan(before);
  expect(old.prepare("SELECT fingerprint FROM calls WHERE id='v1-call'").get()).toEqual({ fingerprint: "fixture-new-fingerprint" });
  const committed = revision(upgrader);
  expect(() => old.raw.transaction(() => {
    old.exec("DELETE FROM calls; UPDATE runs_meta SET ended_at=3000");
    throw new Error("fixture rollback");
  }).immediate()).toThrow("fixture rollback");
  expect(revision(upgrader)).toBe(committed);
});

it("selection triggers recreate a missing revision row", () => {
  const db = fixture();
  migrateUsageLedger(db);
  db.exec("DELETE FROM ledger_metadata WHERE key='call-selection-revision'; UPDATE calls SET fingerprint='fixture-new'");
  expect(revision(db)).toBeGreaterThan(0);
  const before = revision(db);
  db.exec("UPDATE calls SET fingerprint='fixture-newer'");
  expect(revision(db)).toBeGreaterThan(before);
});

it("diagnostic source rows and legacy call flags do not change selection revision", () => {
  const db = fixture();
  migrateUsageLedger(db);
  const before = revision(db);
  db.exec("INSERT INTO import_state(path,source_error_code,last_ingest_at) VALUES ('error-only','ENOENT',2000)");
  db.exec("UPDATE import_state SET source_error_code='EACCES',mtime_ms=1,last_ingest_at=3000");
  db.exec("UPDATE import_state SET path='other-error' WHERE path='error-only'; DELETE FROM import_state WHERE path='other-error'");
  db.exec("UPDATE calls SET counted=1-counted,origin_key='legacy'");
  expect(revision(db)).toBe(before);
});

// Catches an OLD-only cursor guard: the new cursor changes completeness even
// when there are no calls and the previous row contains diagnostics only.
it("an error-only source gaining a cursor advances revision and exposes possible undercount", () => {
  const file = join(root, "error-to-cursor.db");
  const ledger = openUsageLedger(file);
  try {
    const db = openDb(file);
    handles.push(db);
    const batch: ImportBatch = {
      calls: [], runs: [], states: [], detailedRunIds: [], restoreAggregateRunIds: [],
      resetSources: [], sourceErrors: [], at: 2000,
    };
    const initial = revision(db);
    expect(ledger.apply({ ...batch, sourceErrors: [{ path: "fixture.jsonl", code: "ENOENT" }] })).toBe(true);
    expect(revision(db)).toBe(initial);
    expect(ledger.summarize(0, 3000).possibleUndercount).toBe(false);
    expect(ledger.apply({ ...batch, states: [{
      path: "fixture.jsonl", inode: "fixture-inode", size: 100, mtimeMs: 2000,
      offset: 0, parseErrors: 0, generation: 0, prefixHash: "fixture-prefix",
    }] })).toBe(true);
    expect(ledger.summarize(0, 3000).possibleUndercount).toBe(true);
    expect(revision(db)).toBeGreaterThan(initial);
  } finally { ledger.close(); }
});

// SQLite-owned statistics are not durable application layout objects.
it("an upgraded v2 ledger reopens after ANALYZE and PRAGMA optimize", () => {
  const db = fixture();
  migrateUsageLedger(db);
  db.exec("ANALYZE; PRAGMA optimize;");
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").all().length).toBeGreaterThan(0);
  const ledger = openUsageLedger(db.raw.name);
  try {
    expect(ledger.health().schemaVersion).toBe(3);
    expect(() => assertUsageSchemaVersion(db)).not.toThrow();
  } finally { ledger.close(); }
});

// Reject missing, changed and extra objects of every durable type, not only tables.
for (const version of [1, 2, 3]) {
  it(`schema ${version} validates all durable objects before any migration repair`, () => {
    const changes = [
      "DROP TRIGGER calls_insert_total", "DROP TRIGGER calls_delete_total", "DROP INDEX calls_ts_actor", "DROP VIEW counted_calls",
      "DROP INDEX calls_ts_actor; CREATE INDEX calls_ts_actor ON calls(actor)",
      "DROP VIEW usage_run_edges; CREATE VIEW usage_run_edges AS SELECT report_run_id AS parent,included_run_id AS child FROM coverage_edges",
      "DROP TRIGGER calls_insert_total; CREATE TRIGGER calls_insert_total AFTER INSERT ON calls BEGIN SELECT 1; END",
      "CREATE TABLE unexpected(value TEXT)", "CREATE INDEX unexpected ON calls(actor)",
      "CREATE TRIGGER unexpected AFTER INSERT ON calls BEGIN SELECT 1; END", "CREATE VIEW unexpected AS SELECT 1",
      ...(version >= 2 ? ["DROP TRIGGER selection_revision_calls_insert", "DROP INDEX runs_meta_session"] : []),
    ];
    for (const change of changes) {
      const db = fixture();
      for (const m of USAGE_MIGRATIONS.filter(m => m.version > 1 && m.version <= version)) { db.exec(m.sql); db.pragma(`user_version=${m.version}`); }
      db.exec(change);
      const before = db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
      const rev = revision(db);
      expect(() => assertUsageSchemaVersion(db), change).toThrow(new RegExp(`schema ${version}.*layout`));
      expect(() => migrateUsageLedger(db), change).toThrow(new RegExp(`schema ${version}.*layout`));
      expect(db.pragma("user_version")).toBe(version);
      expect(revision(db)).toBe(rev);
      expect(db.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(before);
    }
  });
  it(`schema ${version} reports its own version for an unknown marker`, () => {
    const db = fixture();
    for (const m of USAGE_MIGRATIONS.filter(m => m.version > 1 && m.version <= version)) { db.exec(m.sql); db.pragma(`user_version=${m.version}`); }
    db.exec("UPDATE ledger_metadata SET value='unknown' WHERE key='schema-layout'");
    expect(() => assertUsageSchemaVersion(db)).toThrow(new RegExp(`schema ${version}.*layout`));
  });
}
