import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb, openDbReadOnly, type Db } from "@spider/db-core";
import * as migrations from "../migrate.js";
import { assertUsageSchemaVersion, migrateUsageLedger, USAGE_MIGRATIONS } from "../migrate.js";
import { USAGE_LEASE_SCHEMA } from "../schema.js";
import { type CallRow, type ImportBatch, type ImportState, type RunMeta, openUsageLedger, openUsageLedgerReadOnly } from "../ledger.js";

let root: string;
let file: string;
const handles: { close(): void }[] = [];
function track<T extends { close(): void }>(handle: T): T { handles.push(handle); return handle; }
function v1(transform: (sql: string) => string = sql => sql): Db {
  const db = track(openDb(file));
  db.exec(transform(readFileSync(new URL("./fixtures/usage-v1.sql", import.meta.url), "utf8")));
  return db;
}
function revision(db: Db): number {
  const row = db.prepare("SELECT value FROM ledger_metadata WHERE key='call-selection-revision'").get() as { value: string } | undefined;
  return row ? Number(row.value) : -1;
}
function facts(db: Db) {
  return Object.fromEntries(["calls", "runs_meta", "import_state", "counter_snapshots", "coverage_edges",
    "pending_reports", "incomplete_reports", "source_context", "source_entries", "leases", "ledger_totals"]
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
beforeEach(() => {
  root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "usage-v2-"));
  file = join(root, "usage.db");
  vi.stubEnv("HOME", root);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const handle of handles.splice(0).reverse()) handle.close();
  rmSync(root, { recursive: true, force: true });
});

// Catches changing shipped DDL, losing live ownership, resetting revision on reopen,
// and accidentally migrating in the read-only Phase 1 opener.
it("v1 upgrades additively and twice is harmless", () => {
  const db = v1();
  const before = facts(db);
  const ddl = db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
  const metadata = db.prepare("SELECT * FROM ledger_metadata ORDER BY key").all();
  const follower = track(openUsageLedgerReadOnly(file)!);
  expect(follower.health().schemaVersion).toBe(1);
  expect(db.pragma("user_version")).toBe(1);
  expect(revision(db)).toBe(-1);
  migrateUsageLedger(db);
  migrateUsageLedger(db);
  expect(db.pragma("user_version")).toBe(2);
  expect(revision(db)).toBe(0);
  expect(facts(db)).toEqual(before);
  const afterDdl = db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
  expect(afterDdl.filter(row => {
    const name = (row as { name: string }).name;
    return name !== "runs_meta_session" && !name.startsWith("selection_revision_");
  })).toEqual(ddl);
  expect(db.prepare("PRAGMA index_info(runs_meta_session)").all().map(row => (row as { name: string }).name))
    .toEqual(["session_id", "db_path", "id"]);
  expect(db.prepare("SELECT * FROM ledger_metadata WHERE key != 'call-selection-revision' ORDER BY key").all()).toEqual(metadata);
  expect(() => assertUsageSchemaVersion(db)).not.toThrow();
  const writable = track(openUsageLedger(file));
  expect(writable.health().schemaVersion).toBe(2);
  expect(writable.leases.inspect("ingest", 2000)).toMatchObject({ owner: "fixture-owner", role: "follower", expiresAt: 121000 });
  expect(writable.leases.acquire("ingest", "other-owner", 2000, 120000)).toBeUndefined();
  expect(facts(db)).toEqual(before);
  db.prepare("UPDATE ledger_metadata SET value='17' WHERE key='call-selection-revision'").run();
  migrateUsageLedger(db);
  expect(revision(db)).toBe(17);
  file = join(root, "writable-v1.db");
  const shipped = v1();
  const shippedFacts = facts(shipped);
  const writer = track(openUsageLedger(file));
  expect(writer.health().schemaVersion).toBe(2);
  expect(revision(shipped)).toBe(0);
  expect(facts(shipped)).toEqual(shippedFacts);
});

// Catches v2 silently blessing a changed durable table even with a known marker,
// and the writable opener changing journal mode before rejecting unknown layouts.
it("unknown shipped layout fails without repair", () => {
  const variants = [
    "UPDATE ledger_metadata SET value='unknown-layout' WHERE key='schema-layout'",
    "DELETE FROM ledger_metadata WHERE key='schema-layout'",
    "ALTER TABLE runs_meta ADD COLUMN unknown_column TEXT",
    "ALTER TABLE import_state ADD COLUMN unknown_column TEXT",
    "DROP TABLE pending_reports",
    "changed CHECK literal",
    "PRAGMA user_version = 99",
  ];
  for (const [index, change] of variants.entries()) {
    file = join(root, `unknown-${index}.db`);
    const changedCheck = change === "changed CHECK literal";
    const db = v1(changedCheck ? sql => sql.replace("actor IN ('parent'", "actor IN ('PARENT'")
      .replace("'fixture-run','parent'", "'fixture-run','aux'") : undefined);
    if (!changedCheck) db.exec(change);
    const rows = db.prepare("SELECT * FROM calls").all();
    const ddl = db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
    const version = db.pragma("user_version");
    expect(() => migrateUsageLedger(db), change).toThrow(/layout|schema|future|obsolete/i);
    expect(db.pragma("user_version")).toBe(version);
    expect(db.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(ddl);
    expect(db.prepare("SELECT * FROM calls").all()).toEqual(rows);
    expect(revision(db)).toBe(-1);
    db.pragma("journal_mode = DELETE");
    db.close();
    const bytes = readFileSync(file);
    expect(() => openUsageLedgerReadOnly(file)).toThrow(/layout|schema|future|obsolete/i);
    expect(() => openUsageLedger(file)).toThrow(/layout|schema|future|obsolete/i);
    expect(readFileSync(file)).toEqual(bytes);
    const reader = track(openDbReadOnly(file)!);
    expect(reader.pragma("journal_mode")).toBe("delete");
    expect(reader.prepare("SELECT * FROM calls").all()).toEqual(rows);
    expect(reader.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(ddl);
  }
});

function call(overrides: Partial<CallRow> = {}): CallRow {
  return {
    id: "call-1", ts: 100, sourceFile: "fixture.jsonl", entryId: "entry-1", sourceGeneration: 0,
    project: null, repo: null, sessionId: "fixture-session", runId: "fixture-run", actor: "parent",
    role: null, agent: null, runName: null, phase: null, parentRunId: null, auxPurpose: null,
    provider: "github-copilot", model: "claude-opus-5-5", requestedModel: null, thinking: null, api: null,
    usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
    price: { status: "priced", aic: 10, components: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 },
      rateVersion: "fixture-rate", tier: "default", confidence: "estimated" },
    piCost: null, latencyMs: null, aggregate: false, counted: true, originKey: null,
    sourceKind: "transcript", ...overrides,
  };
}
function state(overrides: Partial<ImportState> = {}): ImportState {
  return { path: "fixture.jsonl", inode: "fixture-inode", size: 200, mtimeMs: 1000, offset: 100,
    parseErrors: 0, generation: 0, prefixHash: "fixture-prefix", ...overrides };
}
function run(overrides: Partial<RunMeta> = {}): RunMeta {
  return { id: "fixture-run", dbPath: "fixture-project.db", project: null, repo: null, sessionId: "fixture-session",
    parentRunId: null, agent: null, role: null, name: null, model: null, thinking: null, phase: null,
    startedAt: null, endedAt: null, ...overrides };
}
function batch(overrides: Partial<ImportBatch> = {}): ImportBatch {
  return { calls: [], runs: [], states: [], detailedRunIds: [], restoreAggregateRunIds: [], resetSources: [],
    sourceErrors: [], at: 1000, ...overrides };
}

// Each entry is a real isolated selection-affecting write. Omitting any category's
// triggers must fail; the revision is monotonic, not a transaction counter.
it("actual selection changes advance revision", () => {
  let ledger = track(openUsageLedger(file));
  const db = track(openDb(file));
  expect(revision(db)).toBe(0);
  const apply = (change: Partial<ImportBatch>, label: string) => {
    const before = revision(db);
    expect(ledger.apply(batch(change)), label).toBe(true);
    expect(revision(db), label).toBeGreaterThan(before);
  };
  apply({ calls: [call(), call({ id: "call-2", entryId: "entry-2" })], runs: [run()], states: [state()] }, "multi-row multi-kind transaction");
  apply({ calls: [call({ id: "call-3", entryId: "entry-3" })] }, "new call");
  apply({ runs: [run({ id: "other-run" })] }, "new run");
  apply({ runs: [run({ endedAt: 200 })] }, "run completeness");
  apply({ runs: [run({ endedAt: 200, sessionId: "other-session", project: "project", repo: "repo", parentRunId: "parent",
    agent: "agent", role: "worker", name: "name", model: "fixture-model", thinking: "high", phase: "review", startedAt: 10 })] }, "run attribution");
  const edge = { reportRunId: "report", includedRunId: "fixture-run", evidence: "unknown" as const };
  apply({ coverageEdges: [edge] }, "new coverage hint");
  apply({ coverageEdges: [{ ...edge, evidence: "transcript" }] }, "proven coverage");
  apply({ removeCoverageEdges: [edge] }, "coverage removal");
  const pending = { path: "fixture.jsonl", runId: "report", generation: 0, firstSeen: 1000, calls: [call()] };
  apply({ pendingReports: [pending] }, "pending report");
  apply({ pendingReports: [{ ...pending, partial: true }] }, "pending completeness");
  apply({ pendingReports: [{ ...pending, calls: [call({ ts: 200 })] }] }, "pending content");
  apply({ removePendingReports: [pending] }, "pending removal");
  apply({ incompleteReports: [pending] }, "incomplete report");
  apply({ completeReports: [pending] }, "complete report");
  apply({ states: [state({ path: "other.jsonl" })] }, "new import source");
  apply({ states: [state({ size: 300 })] }, "size only");
  apply({ states: [state({ size: 300, offset: 200 })] }, "offset only, still incomplete");
  apply({ states: [state({ size: 300, offset: 300 })] }, "cursor complete");
  apply({ states: [state({ size: 400, offset: 300 })] }, "cursor incomplete again");
  apply({ resetSources: [{ path: "fixture.jsonl", generation: 1 }], states: [state({ generation: 1, offset: 0 })] }, "generation and reset");
  expect(ledger.health().calls).toBe(0);
  // Seed a stale v1-style call independently to isolate deletion from cursor changes.
  // No real DB is involved; direct fixture writes are not ledger transactions.
  apply({ calls: [call({ sourceGeneration: 1 })] }, "replacement generation call");
  db.exec("UPDATE calls SET source_generation=0");
  apply({ resetSources: [{ path: "fixture.jsonl", generation: 1 }], states: [state({ generation: 1, offset: 0 })] }, "call deletion alone");
  expect(ledger.health().calls).toBe(0);
  apply({ pendingReports: [{ ...pending, generation: 1 }] }, "pending before reset");
  apply({ resetSources: [{ path: "fixture.jsonl", generation: 1 }], states: [state({ generation: 1, offset: 0 })] }, "reset pending alone");
  apply({ incompleteReports: [pending] }, "incomplete before reset");
  apply({ resetSources: [{ path: "fixture.jsonl", generation: 1 }], states: [state({ generation: 1, offset: 0 })] }, "reset incomplete alone");
  apply({ calls: [call({ sourceGeneration: 1 }), call({ id: "call-2", entryId: "entry-2", sourceGeneration: 1 })] }, "multiple alias candidates");
  ledger.close();
  const prices = db.prepare("SELECT aic,rate_version,raw_model FROM calls ORDER BY id").all();
  db.exec("UPDATE calls SET model=raw_model, fingerprint='stale-fingerprint'; DELETE FROM ledger_metadata WHERE key='model-aliases'");
  const aliasRevision = revision(db);
  ledger = track(openUsageLedger(file));
  expect(revision(db), "canonicalization changes content").toBeGreaterThan(aliasRevision);
  expect(db.prepare("SELECT DISTINCT model FROM calls").all()).toEqual([{ model: "claude-opus-5.5" }]);
  expect(db.prepare("SELECT COUNT(DISTINCT fingerprint) AS n FROM calls").get()).toEqual({ n: 2 });
  expect(db.prepare("SELECT aic,rate_version,raw_model FROM calls ORDER BY id").all()).toEqual(prices);
  // A changed fingerprint also matters when the canonical model is already right.
  ledger.close();
  db.exec("UPDATE calls SET fingerprint='stale-again'; DELETE FROM ledger_metadata WHERE key='model-aliases'");
  const fingerprintRevision = revision(db);
  ledger = track(openUsageLedger(file));
  expect(revision(db), "fingerprint-only transaction").toBeGreaterThan(fingerprintRevision);
  apply({ resetSources: [{ path: "other.jsonl", generation: 1 }], states: [state({ path: "other.jsonl", generation: 1 })] }, "generation alone");
  apply({ pendingReports: [pending] }, "new pending after reset");
  apply({ pendingReports: [{ ...pending, generation: 1 }] }, "pending generation");
  apply({ pendingReports: [{ ...pending, generation: 1, firstSeen: 2000 }] }, "pending aging");
});

// Catches broad data_version/total_changes invalidation, unconditional upsert
// bumps, pre-transaction bumps, and committing content after a lost lease.
it("coordination and replay leave revision stable", () => {
  let ledger = track(openUsageLedger(file));
  const db = track(openDb(file));
  const edge = { reportRunId: "report", includedRunId: "fixture-run", evidence: "transcript" as const };
  const pending = { path: "fixture.jsonl", runId: "report", generation: 0, firstSeen: 1000, calls: [call()], partial: true };
  const seeded = batch({ calls: [call()], states: [state()], runs: [run()], coverageEdges: [edge],
    pendingReports: [pending], incompleteReports: [pending] });
  ledger.apply(seeded);
  const seededRevision = revision(db);
  expect(seededRevision).toBeGreaterThan(0);
  const stable = (action: () => unknown, label: string) => {
    action();
    expect(revision(db), label).toBe(seededRevision);
  };
  stable(() => ledger.apply(batch()), "empty batch");
  stable(() => ledger.apply(batch({ calls: [call({ id: "replay-id", ts: 200, price: { status: "unpriced", reason: "unknown-model" } })] })), "call replay retains facts and pricing");
  stable(() => ledger.apply(batch({ runs: [run()] })), "run replay");
  stable(() => ledger.apply(batch({ coverageEdges: [edge] })), "coverage replay");
  stable(() => ledger.apply(batch({ pendingReports: [pending] })), "pending replay");
  stable(() => ledger.apply(batch({ incompleteReports: [pending] })), "incomplete replay");
  stable(() => ledger.apply(batch({ states: [state()], at: 2000 })), "last-ingest only");
  stable(() => ledger.apply(batch({ states: [state({ mtimeMs: 2000 })] })), "mtime only");
  stable(() => ledger.apply(batch({ states: [state({ parseErrors: 7 })] })), "parse-error only");
  stable(() => ledger.apply(batch({ states: [state({ inode: "changed-inode", prefixHash: "changed-prefix" })] })), "non-selection source metadata");
  stable(() => ledger.apply(seeded), "entire batch replay");
  stable(() => ledger.apply(batch({ sourceContexts: [{ path: "fixture.jsonl", context: { header: null, tailHash: "tail",
    entries: [{ byteOffset: 0, json: { type: "metadata", id: "source-entry" } }] } }] })), "parser context only");
  stable(() => ledger.apply(batch({ sourceContexts: [{ path: "fixture.jsonl", context: { header: null, tailHash: "new-tail",
    entries: [{ byteOffset: 0, json: { type: "metadata", id: "source-entry" } }] } }] })), "parser context replay");
  stable(() => ledger.apply(batch({ removeCoverageEdges: [{ ...edge, includedRunId: "absent" }], removePendingReports: [{ ...pending, runId: "absent" }],
    completeReports: [{ ...pending, runId: "absent" }] })), "absent removals");
  stable(() => ledger.apply(batch({ sourceErrors: [{ path: "missing.jsonl", code: "ENOENT" }] })), "error-only source insertion");
  stable(() => ledger.apply(batch({ sourceErrors: [{ path: "missing.jsonl", code: "EACCES", checkedPaths: ["fixture.jsonl"] }] })), "source error changes");
  stable(() => ledger.apply(batch({ sourceErrors: [{ path: "fixture.jsonl", code: "ENOENT" }] })), "error on known source");
  stable(() => ledger.apply(batch({ states: [state()] })), "clear source error");
  stable(() => ledger.apply(batch({ backfillState: "complete", detailedRunIds: ["fixture-run"], restoreAggregateRunIds: ["fixture-run"] })), "backfill and legacy selection signals");
  const snapshot: NonNullable<ImportBatch["publishedSnapshot"]> = {
    type: "snapshot", health: ledger.health(), backfill: "complete", ingestRole: "owner",
    reconciliation: { windowStart: 0, windowEnd: 200, computedAIC: 10, counterAIC: null, gap: null, ratio: null, unpricedCalls: 0, estimated: true },
    counter: { availability: "disabled", role: "inactive", lastAttemptAt: null, lastSuccessAt: null, nextPollAt: null,
      snapshotAgeMs: null, errorCode: null, notice: null, latest: null },
  };
  stable(() => ledger.apply(batch({ publishedSnapshot: snapshot })), "publication");
  stable(() => ledger.apply(batch({ publishedSnapshot: snapshot })), "publication replay");
  stable(() => ledger.insertCounter({ ts: 1000, creditsUsed: 7, raw: {} }), "counter append");
  const lease = ledger.leases.acquire("counter", "owner", 1000, 120000)!;
  expect(lease).toBeDefined();
  expect(revision(db)).toBe(seededRevision);
  stable(() => expect(lease.renew(2000)).toBe(true), "lease renewal");
  stable(() => expect(lease.claimPoll(2000, 10000)).toBe(true), "poll schedule");
  stable(() => expect(lease.recordError(2000, "offline")).toBe(true), "lease error");
  stable(() => expect(lease.saveIfCurrent(2000, { ts: 3000, creditsUsed: 8, raw: {} })).toBe(true), "fenced counter and clock notice");
  stable(() => ledger.leases.reconcileNotice("counter", 4000), "notice reconciliation");
  const ingest = ledger.leases.acquire("ingest", "owner", 2000, 120000)!;
  stable(() => expect(ingest.release()).toBe(true), "lease release");
  stable(() => expect(ledger.apply(batch({ calls: [call({ id: "rejected", entryId: "rejected" })],
    publishedSnapshot: { ...snapshot, ingestRole: "follower" }, commitGuard: () => ingest.isCurrent(3000) }))).toBe(false), "lease fence rejection");
  const before = facts(db);
  stable(() => expect(() => ledger.apply(batch({ calls: [call({ id: "stale", entryId: "stale" })],
    states: [state({ offset: 50 })], publishedSnapshot: { ...snapshot, ingestRole: "follower" } }))).toThrow(/stale/i), "source fence rejection");
  stable(() => expect(() => ledger.apply(batch({ calls: [call({ id: "new", entryId: "new" }),
    call({ id: "invalid", entryId: "invalid", usage: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } })],
    runs: [run({ endedAt: 999 })], publishedSnapshot: { ...snapshot, ingestRole: "follower" } }))).toThrow(), "constraint rollback after actual writes");
  expect(facts(db)).toEqual(before);
  expect(ledger.getPublishedSnapshot()).toEqual(snapshot);
  ledger.close();
  // Changing the alias catalogue marker alone does not invalidate call content.
  db.exec("DELETE FROM ledger_metadata WHERE key='model-aliases'");
  ledger = track(openUsageLedger(file));
  expect(revision(db), "alias replay with unchanged models and fingerprints").toBe(seededRevision);
  ledger.close();
  db.exec("UPDATE calls SET fingerprint='stale-fingerprint'; DELETE FROM ledger_metadata WHERE key='model-aliases'");
  const aliasBefore = facts(db);
  const aliasRevision = revision(db);
  // Inject failure after layout validation, then exercise the real refresh rollback.
  const migrate = migrations.migrateUsageLedger;
  vi.spyOn(migrations, "migrateUsageLedger").mockImplementation(connection => {
    migrate(connection);
    connection.exec("CREATE TRIGGER reject_alias_publication BEFORE INSERT ON ledger_metadata WHEN NEW.key='model-aliases' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");
  });
  expect(() => openUsageLedger(file)).toThrow(/fixture rollback/);
  expect(revision(db), "alias refresh rollback").toBe(aliasRevision);
  expect(facts(db)).toEqual(aliasBefore);
});

// Catches losing an earlier alias change when the last scanned row is unchanged.
it("alias refresh retains an earlier change with an unchanged last row", () => {
  const first = track(openUsageLedger(file));
  first.apply(batch({ calls: [call({ id: "a" }), call({ id: "z", entryId: "last" })] }));
  first.close();
  const db = track(openDb(file));
  const last = db.prepare("SELECT * FROM calls WHERE id='z'").get();
  db.exec("UPDATE calls SET model=raw_model, fingerprint='stale' WHERE id='a'; DELETE FROM ledger_metadata WHERE key='model-aliases'");
  const before = revision(db);
  track(openUsageLedger(file));
  expect(revision(db)).toBeGreaterThan(before);
  expect(db.prepare("SELECT model FROM calls WHERE id='a'").get()).toEqual({ model: "claude-opus-5.5" });
  expect(db.prepare("SELECT * FROM calls WHERE id='z'").get()).toEqual(last);
});

// Catches treating source_entries deletion as a change to the selected call set.
it("same-generation reset clearing only parser entries leaves revision stable", () => {
  const ledger = track(openUsageLedger(file));
  const db = track(openDb(file));
  ledger.apply(batch({ calls: [call()], states: [state()], sourceContexts: [{ path: "fixture.jsonl", context: {
    header: null, tailHash: "tail", entries: [{ byteOffset: 0, json: { type: "metadata", id: "source-entry" } }]
  } }] }));
  const before = revision(db);
  expect(db.prepare("SELECT COUNT(*) AS n FROM source_entries").get()).toEqual({ n: 1 });
  ledger.apply(batch({ resetSources: [{ path: "fixture.jsonl", generation: 0 }], states: [state()] }));
  expect(db.prepare("SELECT COUNT(*) AS n FROM source_entries").get()).toEqual({ n: 0 });
  expect(ledger.health().calls).toBe(1);
  expect(revision(db)).toBe(before);
});

// The v1 code path must still produce the independently frozen shipped fixture.
// Comparing executed sqlite_master also covers implicit indexes and expanded views.
it("v1 fixture matches the shipped v1 migration code path", () => {
  const fixture = v1();
  const generated = track(openDb(join(root, "generated-v1.db")));
  generated.exec(USAGE_MIGRATIONS[0].sql);
  generated.exec(USAGE_LEASE_SCHEMA);
  const layout = (db: Db) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
  expect(layout(generated)).toEqual(layout(fixture));
});
