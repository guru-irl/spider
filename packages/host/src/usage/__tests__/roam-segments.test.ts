import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDb, openDbReadOnly, type Db } from "@spider/db-core";
import { ingestOnce } from "../ingest.js";
import { openUsageLedger, type RunMeta, type UsageLedger } from "../ledger.js";
import { COPILOT_RATE_VERSIONS } from "../rates.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const stamp = "2026-01-02T03:04:05.000Z";
const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 };
const header = (id = "session", cwd = "fixture") => ({ type: "session", version: 3, id, timestamp: stamp, cwd });
const message = (id: string, parentId: string | null = null, timestamp = stamp) => ({
  type: "message", id, parentId, timestamp,
  message: { role: "assistant", provider: "fixture", model: "fixture", usage },
});
const pricedMessage = (id: string) => {
  const entry = message(id, null, "2026-11-12T03:04:05.000Z");
  return { ...entry, message: { ...entry.message, provider: "github-copilot",
    model: COPILOT_RATE_VERSIONS[0]!.models[0]!.id, usage: { input: 10_000, output: 0, cacheRead: 0, cacheWrite: 0 } } };
};
const warm = (id: string) => ({ type: "usage", id, parentId: null, timestamp: stamp, kind: "cache_warm", provider: "fixture", model: "fixture", usage });
const compact = (id: string) => ({ type: "compaction", id, parentId: null, timestamp: stamp, provider: "fixture", model: "fixture", usage });
const marker = (id: string, previousMachine: string, nextMachine: string, parentId: string | null = null) => ({
  type: "custom", customType: "spider-roam-segment", id, parentId, timestamp: stamp,
  data: { version: 1, moveId: id, epoch: previousMachine === A ? 2 : 3, previousMachine, nextMachine, historyMachine: A, parentRef: null },
});
let root: string;
const ledgers: UsageLedger[] = [];
beforeEach(() => { root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "roam-usage-segments-")); });
afterEach(() => { for (const ledger of ledgers.splice(0)) ledger.close(); rmSync(root, { recursive: true, force: true }); });
function openLedger(name: string) {
  const file = join(root, name, "ledger.db");
  const ledger = openUsageLedger(file); ledgers.push(ledger);
  return { ledger, file };
}
function reopen(item: { ledger: UsageLedger; file: string }) {
  item.ledger.close(); ledgers.splice(ledgers.indexOf(item.ledger), 1);
  item.ledger = openUsageLedger(item.file); ledgers.push(item.ledger);
}
function write(path: string, entries: unknown[]) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
}
function source(path: string, localMachine?: string, run: RunMeta | null = null) {
  return { path, project: null, repo: null, run,
    ...(localMachine ? { roaming: { localMachine, originMachine: A } } : {}) };
}
async function scan(item: { ledger: UsageLedger; file: string }, sources: ReturnType<typeof source>[], maxBytes?: number) {
  return ingestOnce(item.ledger, { sources, runs: sources.flatMap(s => s.run ? [s.run] : []), errors: [], ledgerFile: item.file },
    Date.parse(stamp) + 10_000, new AbortController().signal, maxBytes === undefined ? {} : { maxBytes });
}
function rows(file: string, sql = "SELECT rowid,* FROM calls ORDER BY rowid") {
  const db = openDbReadOnly(file)!;
  try { return db.prepare(sql).all() as Record<string, unknown>[]; }
  finally { db.close(); }
}
function callIds(file: string) {
  return rows(file, "SELECT entry_id FROM calls ORDER BY entry_id").map(row => row.entry_id as string);
}
const withoutSelectionCaches = ({ selection_undercount, selection_shadowed, ...row }: Record<string, unknown>) => row;
const selectionCaches = (row: Record<string, unknown>) => [row.selection_shadowed, row.selection_undercount];

it("skips unchanged managed sources but diagnoses changed participation", async () => {
  const item = openLedger("unchanged-managed"), s = source(join(root, "managed", "session.jsonl"), A);
  write(s.path, [header(), message("a1")]);
  await scan(item, [s]); reopen(item);
  const reads = vi.spyOn(item.ledger, "getSourceContext");
  await scan(item, [s]);
  expect(reads).not.toHaveBeenCalledWith(s.path, []);
  expect(callIds(item.file)).toEqual(["a1"]);
  await scan(item, [source(s.path)]);
  expect(item.ledger.getSourceErrors().map(e => e.code)).toContain("roam-participation-unavailable");
  expect(callIds(item.file)).toEqual(["a1"]);
  await scan(item, [source(s.path, B)]);
  expect(item.ledger.getSourceErrors().map(e => e.code)).toContain("roam-machine-changed");
  expect(callIds(item.file)).toEqual(["a1"]);
}, 5000);

// A and B may see the same history, but each must bill only its own execution.
it("round trip bills each local entry once", async () => {
  const a = openLedger("a"), b = openLedger("b");
  const old = source(join(root, "a", "original.jsonl"));
  write(old.path, [header(), message("a1")]); await scan(a, [old]);
  const oldRowsBefore = rows(a.file);
  const onB = source(join(root, "b", "moved.jsonl"), B);
  write(onB.path, [header("session", "other"), message("a1"), marker("m1", A, B), message("b1")]);
  await scan(b, [onB]);
  const onA = source(join(root, "a", "returned.jsonl"), A);
  write(onA.path, [header("session", "returned"), message("a1"), marker("m1", A, B), message("b1"),
    marker("m2", B, A, "a1"), message("a2", "a1"), warm("warm-a"), compact("compact-a")]);
  await scan(a, [onA]);
  const localEntryIds = callIds(a.file);
  expect(localEntryIds.sort()).toEqual(["a1", "a2", "warm-a", "compact-a"].sort());
  expect(new Set(localEntryIds).size).toBe(localEntryIds.length);
  expect(callIds(b.file)).toEqual(["b1"]);
  const foreignCharges = rows(a.file, "SELECT entry_id FROM calls WHERE entry_id='b1'");
  expect(foreignCharges).toEqual([]);
  const oldRowsAfter = rows(a.file).filter(row => row.source_file === old.path);
  expect(oldRowsAfter.map(withoutSelectionCaches)).toEqual(oldRowsBefore.map(withoutSelectionCaches));
  expect(oldRowsAfter.map(selectionCaches)).toEqual(oldRowsBefore.map(selectionCaches));
  expect(rows(a.file).find(row => row.entry_id === "a2")?.managed_entry_key).toBe(JSON.stringify([A, "session", "a2"]));
  expect(rows(a.file).find(row => row.entry_id === "a1")?.managed_entry_key).toBeNull();
}, 5000);

// Parent links select display ancestry; they never move a physical billing boundary.
it("physical segments ignore selected branch navigation", async () => {
  const item = openLedger("physical"), s = source(join(root, "physical", "session.jsonl"), B);
  write(s.path, [header(), message("a1"), marker("m1", A, B, "a1"), message("b1", "a1"),
    marker("m2", B, A, "a1"), message("a2", "b1")]);
  await scan(item, [s]);
  expect(callIds(item.file)).toEqual(["b1"]);
  expect(rows(item.file)[0]).toMatchObject({ entry_id: "b1", execution_machine: B, managed_entry_key: JSON.stringify([B, "session", "b1"]) });
}, 5000);

// A marker later than the current slice must be found before any history is billed.
it("first marker beyond a slice cannot charge foreign history", async () => {
  const item = openLedger("slices"), base = source(join(root, "slices", "session.jsonl"), B);
  const s = { ...base, roaming: { localMachine: B, originMachine: B } };
  write(s.path, [header(), message("a1"), { type: "custom", customType: "unknown", id: "unknown", data: "x".repeat(5000) },
    marker("m1", A, B), message("b1")]);
  await scan(item, [s], 128);
  expect(callIds(item.file)).toEqual([]);
  expect(item.ledger.getImportState(s.path)?.offset).toBeGreaterThan(0);
  reopen(item);
  for (let i = 0; i < 80 && !callIds(item.file).includes("b1"); i++) await scan(item, [s], 128);
  expect(callIds(item.file)).toEqual(["b1"]);
  expect(item.ledger.getImportState(s.path)?.offset).toBe(statSync(s.path).size);
}, 5000);

// Replacing a file resets cursors and ancestry, not its committed usage facts.
it("reset caches do not reset managed facts", async () => {
  const item = openLedger("reset"), s = source(join(root, "reset", "session.jsonl"), A);
  const history = [header(), message("a1"), marker("m1", A, B), message("b1"), marker("m2", B, A), message("a2")];
  write(s.path, history); await scan(item, [s]);
  const oldRowsBefore = rows(item.file);
  expect(callIds(item.file)).toEqual(["a1", "a2"]);
  const replacement = `${s.path}.replacement`;
  write(replacement, [header("session", "new-location"), ...history.slice(1), warm("warm-a")]);
  renameSync(replacement, s.path); reopen(item); await scan(item, [s]);
  const oldIds = new Set(oldRowsBefore.map(row => row.id));
  const oldRowsAfter = rows(item.file).filter(row => oldIds.has(row.id));
  expect(oldRowsAfter.map(withoutSelectionCaches)).toEqual(oldRowsBefore.map(withoutSelectionCaches));
  expect(oldRowsAfter.map(selectionCaches)).toEqual(oldRowsBefore.map(selectionCaches));
  expect(callIds(item.file)).toEqual(["a1", "a2", "warm-a"]);
}, 5000);

// Malformed recognized markers cannot be treated as ordinary unknown entries.
it("malformed recognized markers refuse managed ingest", async () => {
  const item = openLedger("malformed"), s = source(join(root, "malformed", "session.jsonl"), B);
  const broken = { ...marker("m1", A, B), data: { version: 1, nextMachine: B } };
  write(s.path, [header(), message("a1"), broken, message("b1")]);
  await scan(item, [s]);
  expect(callIds(item.file)).toEqual([]);
  expect(item.ledger.getSourceErrors().map(error => error.code)).toContain("invalid-roam-segment");
}, 5000);

it.each(["before first marker", "after first marker"])("invalid segment JSON refuses attribution %s", async position => {
  const item = openLedger(position), s = source(join(root, position, "session.jsonl"), B);
  mkdirSync(dirname(s.path), { recursive: true });
  const entries = [header(), message("a1"), ...(position === "after first marker" ? [marker("m1", A, B)] : [])];
  writeFileSync(s.path, entries.map(entry => JSON.stringify(entry)).join("\n")
    + '\n{"type":"custom","customType":"spider-roam-segment","data": invalid}\n'
    + JSON.stringify(message("after")) + "\n");
  await scan(item, [s]);
  expect(callIds(item.file)).toEqual([]);
  expect(item.ledger.getSourceErrors().map(error => error.code)).toContain("invalid-roam-entry");
}, 5000);

// Unknown extension data may be large and cannot prevent following local usage.
it("unknown entries preserve parser progress", async () => {
  const item = openLedger("unknown"), s = source(join(root, "unknown", "session.jsonl"), B);
  write(s.path, [header(), message("a1"), marker("m1", A, B),
    { type: "custom", customType: "future-entry", id: "unknown", data: { text: "x".repeat(1_100_000) } }, message("b1")]);
  await scan(item, [s]);
  expect(callIds(item.file)).toEqual(["b1"]);
  expect(item.ledger.getImportState(s.path)?.offset).toBe(statSync(s.path).size);
  expect(item.ledger.getImportState(s.path)?.parseErrors).toBe(0);
}, 5000);

// Distinct child entries can share one accounting owner without colliding.
it("child transcripts sharing parent accounting session do not collide", async () => {
  const item = openLedger("children");
  const run = (id: string): RunMeta => ({ id, dbPath: join(root, "runs.db"), project: null, repo: null, sessionId: "parent",
    parentRunId: null, agent: "worker", role: null, name: null, model: null, thinking: null, phase: null, startedAt: 0, endedAt: 1 });
  const first = source(join(root, "children", "first.jsonl"), A, run("child-one"));
  const second = source(join(root, "children", "second.jsonl"), A, run("child-two"));
  write(first.path, [header("child-one"), pricedMessage("first-entry")]);
  write(second.path, [header("child-two"), pricedMessage("second-entry")]);
  await scan(item, [first, second]);
  const facts = rows(item.file);
  expect(facts).toHaveLength(2);
  expect(facts.map(row => row.session_id)).toEqual(["parent", "parent"]);
  expect(facts.map(row => row.managed_entry_key).sort()).toEqual([
    JSON.stringify([A, "child-one", "first-entry"]), JSON.stringify([A, "child-two", "second-entry"]),
  ].sort());
  expect(item.ledger.getSourceErrors()).toEqual([]);
  expect(rows(item.file, "SELECT entry_id FROM counted_calls ORDER BY entry_id")).toEqual([
    { entry_id: "first-entry" }, { entry_id: "second-entry" },
  ]);
  expect(rows(item.file, "SELECT COUNT(*) AS calls, COALESCE(SUM(aic),0) AS aic FROM counted_calls WHERE session_id='parent'"))
    .toEqual([{ calls: 2, aic: 0.5 }]);
}, 5000);

// An identical entry in a second child is a copy, not a second billable call.
it("identical entry copied into a second child transcript bills once", async () => {
  const item = openLedger("child-fork");
  const run = (id: string): RunMeta => ({ id, dbPath: join(root, "runs.db"), project: null, repo: null, sessionId: "parent",
    parentRunId: null, agent: "worker", role: null, name: null, model: null, thinking: null, phase: null, startedAt: 0, endedAt: 1 });
  const original = source(join(root, "child-fork", "first.jsonl"), A, run("child-one"));
  const fork = source(join(root, "child-fork", "fork.jsonl"), A, run("child-two"));
  write(original.path, [header("child-one"), pricedMessage("same")]);
  write(fork.path, [{ ...header("child-two"), timestamp: "2026-11-13T03:04:05.000Z", parentSession: original.path }, pricedMessage("same")]);
  await scan(item, [original, fork]);
  expect(rows(item.file).map(row => row.copied).sort()).toEqual([0, 1]);
  expect(rows(item.file).map(row => row.managed_entry_key).sort()).toEqual([
    JSON.stringify([A, "child-one", "same"]), JSON.stringify([A, "child-two", "same"]),
  ].sort());
  expect(rows(item.file, "SELECT entry_id FROM counted_calls")).toHaveLength(1);
  expect(rows(item.file, "SELECT COUNT(*) AS calls, COALESCE(SUM(aic),0) AS aic FROM counted_calls WHERE session_id='parent'"))
    .toEqual([{ calls: 1, aic: 0.25 }]);
}, 5000);

it("relocated child uses its historical header rather than its parent accounting identity", async () => {
  const item = openLedger("historical-child");
  const run = (id: string): RunMeta => ({ id, dbPath: join(root, "runs.db"), project: null, repo: null, sessionId: "parent",
    parentRunId: null, agent: "worker", role: null, name: null, model: null, thinking: null, phase: null, startedAt: 0, endedAt: 1 });
  const first = source(join(root, "historical-child", "first.jsonl"), undefined, run("child-one"));
  const second = source(join(root, "historical-child", "second.jsonl"), undefined, run("child-two"));
  write(first.path, [header("child-one"), message("old")]);
  write(second.path, [header("child-two"), message("old", null, "2026-01-02T03:04:06.000Z")]);
  await scan(item, [first, second]);
  const oldRowsBefore = rows(item.file);
  expect(oldRowsBefore).toHaveLength(2);
  const moved = source(join(root, "historical-child", "moved.jsonl"), A, run("child-one"));
  write(moved.path, [header("child-one", "changed"), message("old"), marker("m1", A, B),
    message("foreign"), marker("m2", B, A), message("new")]);
  await scan(item, [moved]);
  const after = rows(item.file), oldIds = new Set(oldRowsBefore.map(row => row.id));
  const oldRowsAfter = after.filter(row => oldIds.has(row.id));
  expect(oldRowsAfter.map(withoutSelectionCaches)).toEqual(oldRowsBefore.map(withoutSelectionCaches));
  expect(oldRowsAfter.map(selectionCaches)).toEqual(oldRowsBefore.map(selectionCaches));
  expect(after.filter(row => row.managed_entry_key !== null)).toMatchObject([
    { entry_id: "new", session_id: "parent", managed_entry_key: JSON.stringify([A, "child-one", "new"]) },
  ]);
  expect(after.some(row => row.entry_id === "foreign")).toBe(false);
}, 5000);

// Existing duplicates are facts, while a relocated managed copy adds only new entries.
it("same transcript at two paths preserves old duplicates and reingests once", async () => {
  const item = openLedger("duplicates");
  const first = source(join(root, "duplicates", "first.jsonl"));
  const second = source(join(root, "duplicates", "second.jsonl"));
  write(first.path, [header(), message("old")]); write(second.path, [header(), message("old")]);
  await scan(item, [first, second]);
  const oldRowsBefore = rows(item.file);
  expect(oldRowsBefore).toHaveLength(2);
  const moved = source(join(root, "duplicates", "moved.jsonl"), A);
  write(moved.path, [header("session", "changed"), message("old"), marker("m1", A, B), message("foreign"), marker("m2", B, A), message("new")]);
  await scan(item, [moved]); await scan(item, [moved]);
  const oldIds = new Set(oldRowsBefore.map(row => row.id));
  const oldRowsAfter = rows(item.file).filter(row => oldIds.has(row.id));
  const newManagedCharges = rows(item.file).filter(row => row.managed_entry_key !== null);
  expect(oldRowsAfter.map(withoutSelectionCaches)).toEqual(oldRowsBefore.map(withoutSelectionCaches));
  expect(oldRowsAfter.map(selectionCaches)).toEqual(oldRowsBefore.map(selectionCaches));
  expect(newManagedCharges).toHaveLength(1);
  expect(newManagedCharges[0]).toMatchObject({ entry_id: "new", execution_machine: A, managed_entry_key: JSON.stringify([A, "session", "new"]) });
  expect(item.ledger.getSourceErrors().filter(error => error.code === "duplicate-managed-entry")).toHaveLength(1);
}, 5000);

it("reingest preserves historical selection when a response repeats", async () => {
  const item = openLedger("repeated-response"), old = source(join(root, "repeated-response", "z.jsonl"));
  const response = (id: string) => {
    const entry = message(id, null, "2026-11-12T03:04:05.000Z");
    return { ...entry, message: { ...entry.message, provider: "github-copilot",
      model: COPILOT_RATE_VERSIONS[0]!.models[0]!.id, usage: { input: 10_000, output: 0, cacheRead: 0, cacheWrite: 0 }, responseId: "same-response" } };
  };
  write(old.path, [header(), response("old"), message("other")]);
  await scan(item, [old]);
  const oldRowsBefore = rows(item.file), referenceFile = join(root, "repeated-response", "reference-v6.db");
  expect(oldRowsBefore).toHaveLength(2);
  const initial = openDb(item.file);
  try { initial.raw.prepare("VACUUM INTO ?").run(referenceFile); } finally { initial.close(); }
  const reference = openDb(referenceFile);
  const totals = (db: Db) => db.prepare("SELECT COUNT(*) AS calls,COALESCE(SUM(aic),0) AS aic FROM counted_calls WHERE session_id=?").get("session") as { calls: number; aic: number };
  try {
    reference.exec("DROP INDEX idx_calls_managed_entry; ALTER TABLE calls DROP COLUMN managed_entry_key; ALTER TABLE calls DROP COLUMN execution_machine; PRAGMA user_version=6");
    expect(reference.pragma("user_version")).toBe(6);
    const beforeTotals = totals(reference);
    expect(beforeTotals.calls).toBe(2);
    expect(beforeTotals.aic).toBeGreaterThan(0);
    const moved = source(join(root, "repeated-response", "a.jsonl"), A);
    write(moved.path, [header(), response("old"), message("other"), marker("m1", A, B), marker("m2", B, A), response("new")]);
    await scan(item, [moved]);
    const allV7 = rows(item.file), newFact = allV7.find(row => row.entry_id === "new")!;
    const columns = (reference.prepare("PRAGMA table_info(calls)").all() as { name: string }[]).map(column => column.name);
    reference.prepare(`INSERT INTO calls (${columns.map(name => `"${name}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
      .run(...columns.map(column => newFact[column] as string | number | null));
    const oldIds = new Set(oldRowsBefore.map(row => row.id));
    const oldV7 = allV7.filter(row => oldIds.has(row.id));
    const oldV6 = (reference.prepare("SELECT rowid,* FROM calls ORDER BY rowid").all() as Record<string, unknown>[]).filter(row => oldIds.has(row.id));
    expect(oldV7.map(row => row.selection_shadowed)).toEqual(oldV6.map(row => row.selection_shadowed));
    expect(oldV7.map(row => row.selection_undercount)).toEqual(oldV6.map(row => row.selection_undercount));
    expect(oldV6.map(row => row.selection_shadowed)).toEqual([1, 0]);
    expect(oldV7.map(row => [row.execution_machine, row.managed_entry_key])).toEqual([[null, null], [null, null]]);
    expect(oldV7.map(withoutSelectionCaches)).toEqual(oldRowsBefore.map(withoutSelectionCaches));
    const reader = openDbReadOnly(item.file)!;
    try { expect(totals(reader)).toEqual(totals(reference)); expect(totals(reader)).toEqual(beforeTotals); }
    finally { reader.close(); }
  } finally { reference.close(); }
}, 5000);

it("a second managed path keeps the first fact and emits one diagnostic", async () => {
  const item = openLedger("managed-duplicate"), first = source(join(root, "managed-duplicate", "first.jsonl"), A);
  const second = source(join(root, "managed-duplicate", "second.jsonl"), A);
  write(first.path, [header(), pricedMessage("same")]);
  write(second.path, [header(), pricedMessage("same")]);
  await scan(item, [first]);
  const oldRowsBefore = rows(item.file);
  await scan(item, [second]);
  await scan(item, [second]);
  const oldRowsAfter = rows(item.file);
  expect(oldRowsAfter.map(withoutSelectionCaches)).toEqual(oldRowsBefore.map(withoutSelectionCaches));
  expect(oldRowsAfter.map(selectionCaches)).toEqual(oldRowsBefore.map(selectionCaches));
  expect(oldRowsAfter).toMatchObject([{ source_file: first.path, managed_entry_key: JSON.stringify([A, "session", "same"]) }]);
  expect(rows(item.file, "SELECT COUNT(*) AS calls, COALESCE(SUM(aic),0) AS aic FROM counted_calls"))
    .toEqual([{ calls: 1, aic: 0.25 }]);
  expect(item.ledger.getSourceErrors().filter(error => error.path === second.path && error.code === "duplicate-managed-entry")).toHaveLength(1);
}, 5000);

it("a concurrent managed insert keeps its duplicate diagnostic", async () => {
  const item = openLedger("race"), first = source(join(root, "race", "first.jsonl"), A), second = source(join(root, "race", "second.jsonl"), A);
  write(first.path, [header(), message("same")]);
  write(second.path, [header(), message("same")]);
  await scan(item, [first]);
  const oldRowsBefore = rows(item.file);
  const staleLookup = vi.spyOn(item.ledger, "findLocalCall").mockReturnValue(undefined);
  try { await scan(item, [second]); } finally { staleLookup.mockRestore(); }
  const oldRowsAfter = rows(item.file);
  expect(oldRowsAfter.map(withoutSelectionCaches)).toEqual(oldRowsBefore.map(withoutSelectionCaches));
  expect(oldRowsAfter.map(selectionCaches)).toEqual(oldRowsBefore.map(selectionCaches));
  expect(item.ledger.getSourceErrors().filter(error => error.path === second.path && error.code === "duplicate-managed-entry")).toHaveLength(1);
}, 5000);

// A nonparticipating transcript keeps the shipped path-based behavior.
it("unmanaged ingestion leaves the new attribution columns null", async () => {
  const item = openLedger("unmanaged"), s = source(join(root, "unmanaged", "session.jsonl"));
  write(s.path, [header(), message("local")]); await scan(item, [s]);
  expect(rows(item.file)).toHaveLength(1);
  expect(rows(item.file)[0]).toMatchObject({ entry_id: "local", execution_machine: null, managed_entry_key: null });
}, 5000);
