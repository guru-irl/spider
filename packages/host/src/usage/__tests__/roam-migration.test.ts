import { USAGE_SCHEMA_VERSION } from "../schema.js";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDb, openDbReadOnly, type Db } from "@spider/db-core";
import Database from "better-sqlite3";
import { openUsageLedger } from "../ledger.js";
import { ingestOnce } from "../ingest.js";
import { assertUsageSchemaVersion, migrateUsageLedger } from "../migrate.js";
import { upgradeReportedCostSchema } from "../schema.js";
import { USAGE_SCHEMA_V4 } from "../schema-v4.js";
import { USAGE_SCHEMA_V6 } from "../schema-v6.js";
import { COPILOT_RATE_VERSIONS } from "../rates.js";

let root: string;
const handles: Db[] = [];
beforeEach(() => { root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "roam-usage-migration-")); });
afterEach(() => { for (const db of handles.splice(0)) if (db.raw.open) db.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

function v6(): Db {
  const db = openDb(join(root, "ledger.db")); handles.push(db);
  db.exec(readFileSync(new URL("./fixtures/usage-v3.sql", import.meta.url), "utf8"));
  db.exec(USAGE_SCHEMA_V4);
  upgradeReportedCostSchema(db.raw);
  db.exec(USAGE_SCHEMA_V6);
  db.pragma("user_version=6");
  const aliases = COPILOT_RATE_VERSIONS.flatMap(version => version.models.map(model => [model.id, [...model.aliases].sort()]));
  const digest = createHash("sha256").update(JSON.stringify(aliases)).digest("hex");
  db.prepare("INSERT INTO ledger_metadata(key,value) VALUES ('model-aliases',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(digest);
  return db;
}
function snapshot(db: Db) {
  return db.prepare("SELECT rowid,* FROM calls ORDER BY rowid").all() as Record<string, unknown>[];
}
function facts(db: Db) {
  return db.prepare("SELECT id,aic AS price,source_kind AS sourceKind,origin_key AS originKey FROM calls ORDER BY id").all() as
    { id: string; price: number | null; sourceKind: string; originKey: string | null }[];
}
function duplicate(db: Db) {
  const columns = (db.prepare("PRAGMA table_info(calls)").all() as { name: string }[]).map(column => column.name);
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  db.exec(`INSERT INTO calls (${columns.map(quote).join(",")}) SELECT ${columns.map(name =>
    name === "id" ? "'fixture-duplicate'" : name === "source_file" ? "'other.jsonl'" : quote(name)).join(",")} FROM calls LIMIT 1`);
}

// A v7 migration must not change any old call, its price, or its coverage proof.
it("migration seven preserves call IDs prices and proof", () => {
  const db = v6(), before = facts(db), oldRowsBefore = snapshot(db);
  const proof = db.prepare("SELECT * FROM coverage_edges ORDER BY report_run_id,included_run_id").all();
  const counters = db.prepare("SELECT * FROM counter_snapshots ORDER BY rowid").all();
  migrateUsageLedger(db);
  const after = facts(db), oldRowsAfter = snapshot(db).map(({ execution_machine, managed_entry_key, ...old }) => {
    expect(execution_machine).toBeNull();
    expect(managed_entry_key).toBeNull();
    return old;
  });
  expect(db.pragma("user_version")).toBe(USAGE_SCHEMA_VERSION);
  expect(after.map(c => [c.id, c.price, c.sourceKind, c.originKey])).toEqual(before.map(c => [c.id, c.price, c.sourceKind, c.originKey]));
  expect(oldRowsAfter).toEqual(oldRowsBefore);
  expect(db.prepare("SELECT * FROM coverage_edges ORDER BY report_run_id,included_run_id").all()).toEqual(proof);
  expect(db.prepare("SELECT * FROM counter_snapshots ORDER BY rowid").all()).toEqual(counters);
  expect(() => assertUsageSchemaVersion(db)).not.toThrow();
}, 5000);

// Old paths may already carry the same session and entry pair.
it("migration seven succeeds on a ledger with duplicate session entry pairs", () => {
  const db = v6(); duplicate(db);
  const oldRowsBefore = snapshot(db);
  expect(oldRowsBefore).toHaveLength(2);
  expect(db.prepare("SELECT COUNT(DISTINCT session_id || ':' || entry_id) AS n FROM calls").get()).toEqual({ n: 1 });
  migrateUsageLedger(db);
  const oldRowsAfter = snapshot(db).map(({ execution_machine, managed_entry_key, ...old }) => {
    expect(execution_machine).toBeNull(); expect(managed_entry_key).toBeNull(); return old;
  });
  expect(oldRowsAfter).toEqual(oldRowsBefore);
  expect(db.prepare("SELECT COUNT(*) AS n FROM calls WHERE managed_entry_key IS NULL").get()).toEqual({ n: 2 });
  expect(db.pragma("user_version")).toBe(USAGE_SCHEMA_VERSION);
}, 5000);

it("migration and reingest preserve non-cache historical fields", async () => {
  const db = v6(), first = join(root, "first.jsonl"), second = join(root, "second.jsonl"), moved = join(root, "moved.jsonl");
  const header = { type: "session", version: 3, id: "fixture-session", cwd: "fixture" };
  db.prepare("UPDATE calls SET source_file=? WHERE id='v1-call'").run(first);
  db.prepare("UPDATE source_context SET path=?,header=? WHERE path='fixture.jsonl'").run(first, JSON.stringify(header));
  duplicate(db);
  db.prepare("UPDATE calls SET source_file=? WHERE id='fixture-duplicate'").run(second);
  db.prepare("INSERT INTO source_context(path,header,tail_hash) VALUES (?,?,?)").run(second, JSON.stringify(header), "fixture-tail");
  const oldRowsBefore = snapshot(db);
  expect(oldRowsBefore).toHaveLength(2);
  migrateUsageLedger(db);
  expect(snapshot(db).map(({ execution_machine, managed_entry_key, ...old }) => old)).toEqual(oldRowsBefore);
  db.close();
  const a = "00000000-0000-4000-8000-00000000000a", b = "00000000-0000-4000-8000-00000000000b";
  const message = (id: string) => ({ type: "message", id, timestamp: "2026-01-02T03:04:05.000Z",
    message: { role: "assistant", provider: "fixture", model: "fixture", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
  const marker = (id: string, previousMachine: string, nextMachine: string) => ({ type: "custom", customType: "spider-roam-segment", id,
    data: { version: 1, moveId: id, epoch: 2, previousMachine, nextMachine, historyMachine: a, parentRef: null } });
  writeFileSync(moved, [header, message("v1-entry"), marker("m1", a, b), message("foreign"), marker("m2", b, a), message("new")]
    .map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const ledger = openUsageLedger(join(root, "ledger.db"));
  try {
    const source = { path: moved, project: null, repo: null, run: null, roaming: { localMachine: a, originMachine: a } };
    const discovery = { sources: [source], runs: [], errors: [], ledgerFile: join(root, "ledger.db") };
    await ingestOnce(ledger, discovery, Date.now(), new AbortController().signal);
    await ingestOnce(ledger, discovery, Date.now(), new AbortController().signal);
  } finally { ledger.close(); }
  const reopened = openDbReadOnly(join(root, "ledger.db"))!; handles.push(reopened);
  const after = snapshot(reopened);
  const oldRowsAfter = after.filter(row => row.id === "v1-call" || row.id === "fixture-duplicate")
    .map(({ execution_machine, managed_entry_key, ...old }) => {
      expect(execution_machine).toBeNull(); expect(managed_entry_key).toBeNull(); return old;
    });
  const withoutSelectionCaches = ({ selection_undercount, selection_shadowed, ...row }: Record<string, unknown>) => row;
  expect(oldRowsAfter.map(withoutSelectionCaches)).toEqual(oldRowsBefore.map(withoutSelectionCaches));
  expect(oldRowsAfter.map(row => [row.selection_shadowed, row.selection_undercount]))
    .toEqual(oldRowsBefore.map(row => [row.selection_shadowed, row.selection_undercount]));
  expect(after.filter(row => row.managed_entry_key !== null)).toMatchObject([{ entry_id: "new", execution_machine: a }]);
  expect(after.some(row => row.entry_id === "foreign")).toBe(false);
}, 5000);

it("historical selection undercount matches v6 behavior after sliced reingest", async () => {
  const db = v6(), file = join(root, "ledger.db"), referenceFile = join(root, "reference-v6.db"), path = join(root, "history.jsonl");
  const a = "00000000-0000-4000-8000-00000000000a", b = "00000000-0000-4000-8000-00000000000b";
  const header = { type: "session", version: 3, id: "fixture-session", cwd: "fixture" };
  const message = (id: string) => ({ type: "message", id, timestamp: "2026-01-02T03:04:05.000Z",
    message: { role: "assistant", provider: "fixture", model: "fixture", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
  writeFileSync(path, [header, message("v1-entry"), message("v1-entry-2")].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const info = statSync(path), hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  duplicate(db);
  db.prepare("UPDATE calls SET source_file=?,run_id=NULL WHERE id='v1-call'").run(path);
  db.prepare("UPDATE calls SET source_file=?,run_id=NULL,entry_id='v1-entry-2' WHERE id='fixture-duplicate'").run(path);
  db.prepare("UPDATE source_context SET path=?,header=?,tail_hash=? WHERE path='fixture.jsonl'").run(path, JSON.stringify(header), hash);
  db.prepare(`UPDATE import_state SET path=?,inode=?,size=?,mtime_ms=?,offset=?,prefix_hash=? WHERE path='fixture.jsonl'`)
    .run(path, `${info.dev}:${info.ino}`, info.size, info.mtimeMs, info.size, hash);
  const oldRowsBefore = snapshot(db);
  expect(oldRowsBefore).toHaveLength(2);
  expect(oldRowsBefore.map(row => row.selection_undercount)).toEqual([0, 0]);
  db.raw.prepare("VACUUM INTO ?").run(referenceFile);
  db.close();
  const reference = openDb(referenceFile); handles.push(reference);
  expect(reference.pragma("user_version")).toBe(6);
  const totals = (db: Db) => db.prepare("SELECT COUNT(*) AS calls,COALESCE(SUM(aic),0) AS aic FROM counted_calls WHERE session_id=?").get("fixture-session") as { calls: number; aic: number };
  const beforeTotals = totals(reference);
  expect(beforeTotals).toEqual({ calls: 1, aic: 10 });
  const ledger = openUsageLedger(file);
  appendFileSync(path, [
    { type: "custom", customType: "unknown", id: "unknown", data: "x".repeat(5000) },
    { type: "custom", customType: "spider-roam-segment", id: "move", data: {
      version: 1, moveId: "move", epoch: 2, previousMachine: a, nextMachine: b, historyMachine: a, parentRef: null } },
    message("foreign"),
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const source = { path, project: null, repo: null, run: null, roaming: { localMachine: a, originMachine: a } };
  const discovery = { sources: [source], runs: [], errors: [], ledgerFile: file };
  const unchanged = (row: Record<string, unknown>) => {
    const { execution_machine, managed_entry_key, selection_undercount, selection_shadowed, ...old } = row;
    return old;
  };
  let sawIncomplete = false, complete = false;
  try {
    for (let i = 0; i < 80; i++) {
      await ingestOnce(ledger, discovery, Date.now(), new AbortController().signal, { maxBytes: 128 });
      const state = ledger.getImportState(path)!;
      reference.prepare("UPDATE import_state SET size=?,offset=? WHERE path=?").run(state.size, state.offset, path);
      const oldV6 = snapshot(reference), reader = openDbReadOnly(file)!;
      let oldV7: Record<string, unknown>[];
      try {
        oldV7 = snapshot(reader).filter(row => row.id === "v1-call" || row.id === "fixture-duplicate");
        expect(totals(reader)).toEqual(totals(reference));
        expect(totals(reader)).toEqual(beforeTotals);
      } finally { reader.close(); }
      expect(oldV7.map(row => row.selection_undercount)).toEqual(oldV6.map(row => row.selection_undercount));
      expect(oldV7.map(row => row.selection_shadowed)).toEqual(oldV6.map(row => row.selection_shadowed));
      expect(oldV7.map(unchanged)).toEqual(oldRowsBefore.map(unchanged));
      expect(oldV7.map(row => [row.execution_machine, row.managed_entry_key])).toEqual([[null, null], [null, null]]);
      if (state.offset < state.size && oldV6.every(row => row.selection_undercount === 1)) sawIncomplete = true;
      if (state.offset === statSync(path).size && ledger.getSourceContext(path, [])?.segmentState) { complete = true; break; }
    }
  } finally { ledger.close(); }
  expect(sawIncomplete).toBe(true);
  expect(complete).toBe(true);
  expect(snapshot(reference).map(row => row.selection_undercount)).toEqual([0, 0]);
}, 5000);

// A failure after all v7 DDL must roll back both the schema and user_version.
it("failed v7 leaves version six and reopen never rewrites calls", () => {
  const db = v6();
  db.prepare("UPDATE calls SET fingerprint='historic-fingerprint' WHERE id='v1-call'").run();
  const oldRowsBefore = snapshot(db), execute = db.exec.bind(db);
  const fault = vi.spyOn(db, "exec").mockImplementation(sql => {
    execute(sql);
    if (sql.includes("idx_calls_managed_entry")) throw new Error("interrupted migration");
  });
  expect(() => migrateUsageLedger(db)).toThrow("interrupted migration");
  fault.mockRestore();
  expect(db.pragma("user_version")).toBe(6);
  expect(snapshot(db)).toEqual(oldRowsBefore);
  expect((db.prepare("PRAGMA table_info(calls)").all() as { name: string }[]).map(row => row.name)).not.toContain("execution_machine");
  db.close();
  const statements: string[] = [];
  const raw = new Database(join(root, "ledger.db"), { verbose: sql => statements.push(String(sql)) });
  const traced: Db = { ...db, raw, prepare: sql => raw.prepare(sql), exec: sql => { raw.exec(sql); },
    pragma: sql => raw.pragma(sql, { simple: true }) };
  try { migrateUsageLedger(traced); } finally { raw.close(); }
  expect(statements.some(sql => /ALTER TABLE calls ADD COLUMN execution_machine/i.test(sql))).toBe(true);
  expect(statements.some(sql => /CREATE UNIQUE INDEX idx_calls_managed_entry/i.test(sql))).toBe(true);
  expect(statements.filter(sql => /^\s*(?:UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+(?:main\s*\.\s*)?(?:"calls"|`calls`|\[calls\]|calls)(?=\s|$)/i.test(sql))).toEqual([]);
  const ledger = openUsageLedger(join(root, "ledger.db")); ledger.close();
  const reopened = openDb(join(root, "ledger.db")); handles.push(reopened);
  expect(reopened.pragma("user_version")).toBe(USAGE_SCHEMA_VERSION);
  const oldRowsAfter = snapshot(reopened).map(({ execution_machine, managed_entry_key, ...old }) => {
    expect(execution_machine).toBeNull(); expect(managed_entry_key).toBeNull(); return old;
  });
  expect(oldRowsAfter).toEqual(oldRowsBefore);
}, 5000);

it("old usage opener refuses v7 without writes then new ingest catches up", async () => {
  const file = join(root, "ledger.db"), transcript = join(root, "new.jsonl");
  const ledger = openUsageLedger(file); ledger.close();
  const a = "00000000-0000-4000-8000-00000000000a", b = "00000000-0000-4000-8000-00000000000b";
  writeFileSync(transcript, [
    { type: "session", version: 3, id: "fixture-session", cwd: "fixture" },
    { type: "custom", customType: "spider-roam-segment", id: "move", data: {
      version: 1, moveId: "move", epoch: 2, previousMachine: a, nextMachine: b, historyMachine: a, parentRef: null } },
    { type: "message", id: "local", timestamp: "2026-01-02T03:04:05.000Z",
      message: { role: "assistant", provider: "fixture", model: "fixture", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } },
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const digest = () => createHash("sha256").update(readFileSync(file)).digest("hex");
  const oldOpenerDigestBefore = digest();
  // The v6 opener used this same preflight with a schema ceiling of six.
  vi.resetModules();
  vi.doMock("../schema.js", async original => ({ ...await original<typeof import("../schema.js")>(), USAGE_SCHEMA_VERSION: 6 }));
  try {
    const old = await import("../ledger.js");
    expect(() => old.openUsageLedger(file)).toThrow(/Unsupported future usage schema 7/);
    expect(digest()).toBe(oldOpenerDigestBefore);
  } finally { vi.doUnmock("../schema.js"); vi.resetModules(); }
  const current = openUsageLedger(file);
  try {
    const source = { path: transcript, project: null, repo: null, run: null, roaming: { localMachine: b, originMachine: a } };
    await ingestOnce(current, { sources: [source], runs: [], errors: [], ledgerFile: file }, Date.now(), new AbortController().signal);
  } finally { current.close(); }
  const reopened = openDbReadOnly(file)!; handles.push(reopened);
  expect(reopened.prepare("SELECT entry_id,execution_machine FROM calls").all()).toEqual([{ entry_id: "local", execution_machine: b }]);
}, 5000);

it("alias table change still refreshes historical rows after v7", () => {
  const db = v6(), model = COPILOT_RATE_VERSIONS[0]!.models[0]!;
  const aliases = model.aliases as string[], alias = "fixture-new-alias";
  const oldDigest = db.prepare("SELECT value FROM ledger_metadata WHERE key='model-aliases'").get();
  db.prepare("UPDATE calls SET model=?,raw_model=?,fingerprint='old-fingerprint' WHERE id='v1-call'").run(alias, alias);
  duplicate(db);
  db.prepare(`UPDATE calls SET id='fixture-independent',source_file='independent.jsonl',
    entry_id='independent',fingerprint='independent-fingerprint' WHERE id='fixture-duplicate'`).run();
  duplicate(db);
  db.prepare("UPDATE calls SET copied=1 WHERE id='fixture-duplicate'").run();
  const billed = (ledger: Db) => ledger.prepare("SELECT id,aic FROM counted_calls WHERE session_id='fixture-session' ORDER BY id").all();
  const beforeBilling = billed(db);
  expect(beforeBilling).toEqual([{ id: "fixture-independent", aic: 10 }, { id: "v1-call", aic: 10 }]);
  const before = snapshot(db);
  migrateUsageLedger(db);
  expect(snapshot(db).map(({ execution_machine, managed_entry_key, ...old }) => old)).toEqual(before);
  db.close();
  try {
    aliases.push(alias);
    const ledger = openUsageLedger(join(root, "ledger.db")); ledger.close();
    const reopened = openDb(join(root, "ledger.db")); handles.push(reopened);
    const after = snapshot(reopened);
    expect(after.map(row => row.model)).toEqual([model.id, model.id, model.id]);
    expect(after.map(row => row.raw_model)).toEqual([alias, alias, alias]);
    expect(after[0]!.fingerprint).not.toBe("old-fingerprint");
    expect(after[0]!.fingerprint).toBe(after[2]!.fingerprint);
    expect(after[0]!.fingerprint).not.toBe(after[1]!.fingerprint);
    expect(after.map(row => row.aic)).toEqual(before.map(row => row.aic));
    expect(after.map(row => [row.execution_machine, row.managed_entry_key])).toEqual([[null, null], [null, null], [null, null]]);
    expect(billed(reopened)).toEqual(beforeBilling);
    expect(reopened.prepare("SELECT value FROM ledger_metadata WHERE key='model-aliases'").get()).not.toEqual(oldDigest);
  } finally { aliases.splice(aliases.indexOf(alias), 1); }
}, 5000);
