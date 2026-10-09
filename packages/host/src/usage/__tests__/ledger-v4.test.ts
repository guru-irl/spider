import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { USAGE_SCHEMA_V4 } from "../schema-v4.js";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "@spider/db-core";
import { assertUsageSchemaVersion, migrateUsageLedger, USAGE_MIGRATIONS } from "../migrate.js";
import { USAGE_LEASE_SCHEMA } from "../schema.js";
import { openUsageLedger, openUsageLedgerReadOnly, type ImportBatch, type MetadataCheckpoint,
  type RunMeta, type SessionMeta, type UsageLedger } from "../ledger.js";

let root: string;
let file: string;
const handles: { close(): void }[] = [];
function track<T extends { close(): void }>(handle: T): T { handles.push(handle); return handle; }
function database(path = file): Db { return track(openDb(path, { busyTimeoutMs: 0 })); }
function fixture(): Db {
  const db = database();
  db.exec(readFileSync(new URL("./fixtures/usage-v3.sql", import.meta.url), "utf8"));
  return db;
}
function batch(overrides: Partial<ImportBatch> = {}): ImportBatch {
  return { calls: [], runs: [], states: [], detailedRunIds: [], restoreAggregateRunIds: [],
    resetSources: [], sourceErrors: [], at: 2000, ...overrides };
}
function run(overrides: Partial<RunMeta> = {}): RunMeta {
  return { id: "run", dbPath: "synthetic.db", project: null, repo: null, sessionId: "session",
    parentRunId: null, agent: "worker", role: "worker", name: "Run", model: "fixture-model",
    thinking: null, phase: null, startedAt: 100, endedAt: 200, ...overrides };
}
function session(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return { id: "session", ownerSessionId: null, name: "Latest name", nameSource: "name",
    project: "example", firstActivity: 100, lastActivity: 200, nameOrder: 20, ...overrides };
}
function checkpoint(overrides: Partial<MetadataCheckpoint> = {}): MetadataCheckpoint {
  return { path: "synthetic.jsonl", generation: 0, offset: 80, size: 100, complete: false, ...overrides };
}
function revision(db: Db): number {
  return Number((db.prepare("SELECT value FROM ledger_metadata WHERE key='call-selection-revision'").get() as { value: string }).value);
}
function selected(db: Db) {
  return db.prepare(`SELECT id,fingerprint,input,output,cache_read,cache_write,aic,aic_input,aic_cache_read,aic_cache_write,aic_output
    FROM counted_calls ORDER BY id`).all();
}
function layout(db: Db) {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
}
function allFacts(db: Db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name,
    db.prepare(`SELECT * FROM "${name}"`).all()
      .filter(row => name !== "ledger_metadata" || (row as { key: string }).key !== "model-aliases")
      .map(row => Object.fromEntries(Object.entries(row as Record<string, unknown>)
        .filter(([key]) => name !== "runs_meta" || key !== "status")))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
}
function metadata(db: Db) {
  return Object.fromEntries(["runs_meta", "sessions", "session_metadata_import", "import_state", "ledger_metadata"]
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
beforeEach(() => {
  root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "usage-v4-"));
  file = join(root, "usage.db");
});
afterEach(() => {
  for (const handle of handles.splice(0).reverse()) handle.close();
  rmSync(root, { recursive: true, force: true });
});

// A changed shipped migration must not silently reinterpret deployed ledgers.
it("v3 upgrades once without changing selected calls or shipped SQL", () => {
  const db = fixture();
  db.exec(`INSERT INTO calls(id,ts,source_file,entry_id,source_generation,actor,source_kind,input,output,cache_read,cache_write,
    price_status,unpriced_reason,aggregate,counted,copied,fingerprint)
    SELECT 'copy',ts,'copy.jsonl',entry_id,source_generation,actor,source_kind,input,output,cache_read,cache_write,
      'unpriced','synthetic',aggregate,counted,1,fingerprint FROM calls WHERE id='v1-call'`);
  const selectedBefore = selected(db);
  expect(selectedBefore).toHaveLength(1);
  expect(selectedBefore[0]).toMatchObject({ id: "v1-call", input: 10, output: 20, cache_read: 30, cache_write: 40, aic: 10 });
  const facts = allFacts(db);
  expect(facts.counter_snapshots).toHaveLength(1);
  expect(facts.source_entries).toHaveLength(1);
  const before = layout(db);
  const beforeRevision = revision(db);
  migrateUsageLedger(db);
  expect(db.pragma("user_version")).toBe(5);
  expect(selected(db)).toEqual(selectedBefore);
  expect(allFacts(db)).toEqual({ ...facts, sessions: [], session_metadata_import: [] });
  expect(db.prepare("SELECT status FROM runs_meta").get()).toEqual({ status: null });
  expect(layout(db).filter(row => (row as { name: string }).name !== "runs_meta" && (row as { name: string }).name !== "calls" && before.some(old => (old as { name: string }).name === (row as { name: string }).name)))
    .toEqual(before.filter(row => !["runs_meta", "calls"].includes((row as { name: string }).name)));
  expect(revision(db)).toBe(beforeRevision);
  const upgraded = layout(db);
  migrateUsageLedger(db);
  expect(layout(db)).toEqual(upgraded);
  expect(selected(db)).toEqual(selectedBefore);
  expect(revision(db)).toBe(beforeRevision);
  expect(USAGE_MIGRATIONS.filter(m => m.version <= 3).map(m => createHash("sha256").update(m.sql).digest("hex"))).toEqual([
    "abe25e614cdeae4819148f2815b1bf114941cc79a858196a09e99483e4c3d035",
    "14001c76dc6563f1328d64b9b6b71867c02e8866c04470df5b963c30f30eaff5",
    "9d97a2254dc1d653fcbf1682ca9dbe3d39e777d2763976bbbe97a0bae820f086",
  ]);
});

// Moving DDL outside migrateUsageLedger's transaction must lose this rollback guard.
it("an upgrade interrupted after v4 SQL rolls back all rows and upgrades on next open", () => {
  const db = fixture();
  const beforeLayout = layout(db);
  const beforeFacts = allFacts(db);
  const exec = db.exec.bind(db);
  const injected = vi.spyOn(db, "exec").mockImplementation(sql => {
    exec(sql);
    if (sql === USAGE_SCHEMA_V4) throw new Error("injected after v4 SQL");
  });
  try {
    expect(() => migrateUsageLedger(db)).toThrow("injected after v4 SQL");
  } finally { injected.mockRestore(); }
  expect(db.pragma("user_version")).toBe(3);
  expect(layout(db)).toEqual(beforeLayout);
  expect(allFacts(db)).toEqual(beforeFacts);
  expect(() => assertUsageSchemaVersion(db)).not.toThrow();
  const reopened = track(openUsageLedger(file));
  expect(reopened.health().schemaVersion).toBe(5);
  expect(allFacts(db)).toEqual({ ...beforeFacts, sessions: [], session_metadata_import: [] });
});

it("frozen v3 fixture matches the shipped migration path", () => {
  const frozen = fixture();
  const generated = database(join(root, "generated.db"));
  for (const m of USAGE_MIGRATIONS.filter(m => m.version <= 3)) generated.exec(m.sql);
  generated.exec(USAGE_LEASE_SCHEMA);
  generated.pragma("user_version=3");
  expect(layout(generated)).toEqual(layout(frozen));
  expect(() => assertUsageSchemaVersion(frozen)).not.toThrow();
});

// New prepared statements must not prevent a follower from opening v1-v3.
it.each([1, 2, 3])("read-only v%s follower does not migrate or require v4 objects", version => {
  const db = database();
  for (const m of USAGE_MIGRATIONS.filter(m => m.version <= version)) db.exec(m.sql);
  db.exec(USAGE_LEASE_SCHEMA);
  db.pragma(`user_version=${version}`);
  const before = layout(db);
  const reader = track(openUsageLedgerReadOnly(file)!);
  expect(reader.health().schemaVersion).toBe(version);
  expect(reader.getSessions()).toEqual([]);
  expect(reader.getMetadataCheckpoint("missing.jsonl")).toBeUndefined();
  expect(layout(db)).toEqual(before);
  expect(db.pragma("user_version")).toBe(version);
});

it("status only update invalidates revision but identical status does not", () => {
  const ledger = track(openUsageLedger(file));
  const db = database();
  ledger.apply(batch({ runs: [run({ status: "done" })] }));
  const before = revision(db);
  ledger.apply(batch({ runs: [run({ status: "cancelled" })] }));
  expect(ledger.getRuns()).toEqual([run({ status: "cancelled" })]);
  expect(revision(db)).not.toBe(before);
  const changed = revision(db);
  ledger.apply(batch({ runs: [run({ status: "cancelled" })] }));
  db.exec("UPDATE runs_meta SET status=status");
  expect(revision(db)).toBe(changed);
  db.exec("UPDATE runs_meta SET status='failed'");
  expect(revision(db)).toBeGreaterThan(changed);
});

it("omitted legacy status preserves captured status and explicit null clears it", () => {
  const ledger = track(openUsageLedger(file));
  const db = database();
  ledger.apply(batch({ runs: [run({ status: "done" })] }));
  const before = revision(db);
  ledger.apply(batch({ runs: [run()] }));
  expect(ledger.getRuns()[0].status).toBe("done");
  expect(revision(db)).toBe(before);
  ledger.apply(batch({ runs: [run({ status: null })] }));
  expect(ledger.getRuns()[0].status).toBeNull();
  expect(revision(db)).toBeGreaterThan(before);
});

// Omitting status must preserve it even when another column forces an UPDATE.
it("omitted status keeps stored status while endedAt changes", () => {
  const ledger = track(openUsageLedger(file));
  ledger.apply(batch({ runs: [run({ status: "done" })] }));
  expect(ledger.apply(batch({ runs: [run({ endedAt: 400 })] }))).toBe(true);
  expect(ledger.getRuns()).toEqual([run({ status: "done", endedAt: 400 })]);
});

// The durable CHECK accepts storage statuses, not the dashboard display labels.
it.each(["queued", "running", "paused", "done", "failed", "cancelled", null] as const)("stores the real run status %s", status => {
  const ledger = track(openUsageLedger(file));
  ledger.apply(batch({ runs: [run({ status })] }));
  expect(ledger.getRuns()[0].status).toBe(status);
});
it.each(["completed", "unknown"])("invalid status %s fails closed without other metadata writes", status => {
  const ledger = track(openUsageLedger(file));
  const db = database();
  ledger.apply(batch({ runs: [run({ status: "done" })], sessions: [session()], metadataCheckpoints: [checkpoint()] }));
  const before = metadata(db);
  expect(() => ledger.apply(batch({ runs: [run({ id: "first", status: "running" }), run({ status: status as RunMeta["status"] })],
    sessions: [session({ name: "Invalid batch", nameOrder: 99 })], metadataCheckpoints: [checkpoint({ offset: 90 })] }))).toThrow(/CHECK/);
  expect(metadata(db)).toEqual(before);
});

it("fenced metadata batch is atomic", () => {
  const ledger = track(openUsageLedger(file));
  const db = database();
  ledger.apply(batch({ runs: [run({ status: "done" })], sessions: [session()], metadataCheckpoints: [checkpoint()] }));
  const lease = ledger.leases.acquire("ingest", "owner", 1000, 120000)!;
  expect(lease.release()).toBe(true);
  const before = metadata(db);
  expect(ledger.apply(batch({ runs: [run({ status: "cancelled" })], sessions: [session({ name: "Rejected", nameOrder: 99 })],
    metadataCheckpoints: [checkpoint({ offset: 100, complete: true })], commitGuard: () => {
      expect(db.raw.inTransaction).toBe(false);
      expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/);
      return lease.isCurrent(2000);
    } }))).toBe(false);
  expect(metadata(db)).toEqual(before);
  expect(ledger.getSessions()).toEqual([session()]);
  expect(ledger.getMetadataCheckpoint("synthetic.jsonl")).toEqual(checkpoint());
});

it("metadata preserves later name and extends nullable activity span", () => {
  const ledger = track(openUsageLedger(file));
  const db = database();
  ledger.apply(batch({ sessions: [session()] }));
  ledger.apply(batch({ sessions: [session({ name: "Older first message", nameSource: "first-user", nameOrder: 10,
    firstActivity: 50, lastActivity: 300 })] }));
  expect(ledger.getSessions()).toEqual([session({ firstActivity: 50, lastActivity: 300 })]);
  ledger.apply(batch({ sessions: [session({ name: "Newest name", nameOrder: 30, firstActivity: null, lastActivity: null })] }));
  expect(ledger.getSessions()).toEqual([session({ name: "Newest name", nameOrder: 30, firstActivity: 50, lastActivity: 300 })]);
  const before = revision(db);
  ledger.apply(batch({ sessions: [session({ name: "Newest name", nameOrder: 30, firstActivity: 100, lastActivity: 200 })] }));
  expect(revision(db)).toBe(before);
  ledger.apply(batch({ sessions: [session({ id: "empty", name: "Empty", nameSource: "id", nameOrder: 0,
    project: null, firstActivity: null, lastActivity: null, ownerSessionId: "session" })] }));
  ledger.apply(batch({ sessions: [session({ id: "empty", name: "Empty", nameSource: "id", nameOrder: 0,
    project: null, firstActivity: 500, lastActivity: 500, ownerSessionId: "session" })] }));
  expect(ledger.getSessions().find(row => row.id === "empty")).toEqual(session({ id: "empty", name: "Empty", nameSource: "id",
    nameOrder: 0, project: null, firstActivity: 500, lastActivity: 500, ownerSessionId: "session" }));
  expect(db.prepare("PRAGMA index_info(sessions_owner)").all().map(row => (row as { name: string }).name)).toEqual(["owner_session_id", "id"]);
  ledger.close();
  const reopened = track(openUsageLedgerReadOnly(file)!);
  expect(reopened.getSessions()).toHaveLength(2);
});

it("merging spans with one missing end each commits and persists a sane span", () => {
  const ledger = track(openUsageLedger(file));
  expect(ledger.apply(batch({ sessions: [session({ firstActivity: 300, lastActivity: null })] }))).toBe(true);
  expect(ledger.getSessions()).toEqual([session({ firstActivity: 300, lastActivity: 300 })]);
  expect(ledger.apply(batch({ sessions: [session({ firstActivity: null, lastActivity: 200 })],
    runs: [run({ status: "done" })], metadataCheckpoints: [checkpoint()] }))).toBe(true);
  expect(ledger.getSessions()).toEqual([session({ firstActivity: 200, lastActivity: 300 })]);
  expect(ledger.getRuns()).toEqual([run({ status: "done" })]);
  expect(ledger.getMetadataCheckpoint("synthetic.jsonl")).toEqual(checkpoint());
  ledger.close();
  const reopened = track(openUsageLedgerReadOnly(file)!);
  expect(reopened.getSessions()).toEqual([session({ firstActivity: 200, lastActivity: 300 })]);
});

it("reversed activity endpoints normalize without aborting the batch", () => {
  const ledger = track(openUsageLedger(file));
  expect(ledger.apply(batch({ sessions: [session({ firstActivity: 300, lastActivity: 100 })],
    metadataCheckpoints: [checkpoint()] }))).toBe(true);
  expect(ledger.getSessions()).toEqual([session({ firstActivity: 100, lastActivity: 300 })]);
  expect(ledger.getMetadataCheckpoint("synthetic.jsonl")).toEqual(checkpoint());
});

it("a name with the same order replaces the stored name and source", () => {
  const ledger = track(openUsageLedger(file));
  ledger.apply(batch({ sessions: [session()] }));
  ledger.apply(batch({ sessions: [session({ name: "Replacement", nameSource: "first-user" })] }));
  expect(ledger.getSessions()).toEqual([session({ name: "Replacement", nameSource: "first-user" })]);
});

it.each([null, ""])("empty owner and project (%s) never overwrite stored evidence", empty => {
  const ledger = track(openUsageLedger(file));
  ledger.apply(batch({ sessions: [session({ ownerSessionId: "owner" })] }));
  ledger.apply(batch({ sessions: [session({ ownerSessionId: empty, project: empty, name: "Later name", nameOrder: 30 })] }));
  expect(ledger.getSessions()).toEqual([session({ ownerSessionId: "owner", name: "Later name", nameOrder: 30 })]);
  ledger.apply(batch({ sessions: [session({ ownerSessionId: "new-owner", project: "new-project", name: "Later name", nameOrder: 30 })] }));
  expect(ledger.getSessions()).toEqual([session({ ownerSessionId: "new-owner", project: "new-project", name: "Later name", nameOrder: 30 })]);
});

// Each independently changed reader input must invalidate caches, including raw writes.
it.each([
  ["id", "'renamed'"], ["owner_session_id", "'owner'"], ["name", "'Changed'"],
  ["name_source", "'first-user'"], ["project", "'other'"], ["first_activity", "50"],
  ["last_activity", "300"], ["name_order", "21"],
])("session %s changes invalidate revision but no-op writes do not", (column, value) => {
  const ledger = track(openUsageLedger(file));
  const db = database();
  const empty = revision(db);
  ledger.apply(batch({ sessions: [session()] }));
  expect(revision(db)).toBeGreaterThan(empty);
  const before = revision(db);
  db.exec(`UPDATE sessions SET ${column}=${value}`);
  expect(revision(db)).toBeGreaterThan(before);
  const changed = revision(db);
  db.exec(`UPDATE sessions SET ${column}=${column}`);
  expect(revision(db)).toBe(changed);
  db.exec("DELETE FROM sessions");
  expect(revision(db)).toBeGreaterThan(changed);
});

it("metadata checkpoints persist separately from billing offsets and do not invalidate revision", () => {
  const ledger = track(openUsageLedger(file));
  const db = database();
  ledger.apply(batch({ states: [{ path: "synthetic.jsonl", generation: 0, offset: 20, size: 100,
    inode: "fixture", mtimeMs: 1, parseErrors: 0, prefixHash: "prefix" }] }));
  const billingBefore = ledger.getImportState("synthetic.jsonl");
  const before = revision(db);
  ledger.apply(batch({ metadataCheckpoints: [checkpoint()] }));
  ledger.apply(batch({ metadataCheckpoints: [checkpoint({ offset: 100, complete: true })] }));
  expect(ledger.getImportState("synthetic.jsonl")).toEqual(billingBefore);
  expect(revision(db)).toBe(before);
  expect(ledger.getMetadataCheckpoint("absent")).toBeUndefined();
  ledger.close();
  const reader = track(openUsageLedgerReadOnly(file)!);
  expect(reader.getMetadataCheckpoint("synthetic.jsonl")).toEqual(checkpoint({ offset: 100, complete: true }));
});

it("an invalid checkpoint rolls back earlier run and session writes", () => {
  const ledger = track(openUsageLedger(file));
  const db = database();
  ledger.apply(batch({ runs: [run({ status: "done" })], sessions: [session()], metadataCheckpoints: [checkpoint()] }));
  const before = metadata(db);
  expect(() => ledger.apply(batch({ runs: [run({ status: "cancelled" })], sessions: [session({ name: "Rollback", nameOrder: 99 })],
    metadataCheckpoints: [checkpoint({ offset: 101 })] }))).toThrow(/CHECK/);
  expect(metadata(db)).toEqual(before);
});
it.each([
  { generation: -1 }, { offset: -1 }, { size: -1 }, { complete: 2 as unknown as boolean },
])("checkpoint constraints reject %j", patch => {
  const ledger = track(openUsageLedger(file));
  expect(() => ledger.apply(batch({ metadataCheckpoints: [checkpoint(patch)] }))).toThrow(/CHECK/);
  expect(ledger.getMetadataCheckpoint("synthetic.jsonl")).toBeUndefined();
});

it.each([
  "CREATE TABLE unexpected(value TEXT)",
  "DROP TRIGGER selection_revision_runs_status_update; CREATE TRIGGER selection_revision_runs_status_update AFTER UPDATE OF status ON runs_meta BEGIN SELECT 1; END",
  "DROP INDEX sessions_owner",
  "DROP TRIGGER selection_revision_sessions_update",
])("durable v4 drift is rejected: %s", change => {
  track(openUsageLedger(file));
  const db = database();
  db.exec(change);
  const before = layout(db);
  expect(() => assertUsageSchemaVersion(db)).toThrow(/schema 5.*durable layout/);
  expect(() => migrateUsageLedger(db)).toThrow(/schema 5.*durable layout/);
  expect(() => openUsageLedger(file)).toThrow(/schema 5.*durable layout/);
  expect(layout(db)).toEqual(before);
  expect(db.pragma("user_version")).toBe(5);
});
