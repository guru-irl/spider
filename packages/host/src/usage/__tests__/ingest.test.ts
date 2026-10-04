import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as fs from "node:fs/promises";
import { openDbReadOnly } from "@spider/db-core";
import { openUsageLedger, type RunMeta, type UsageLedger } from "../ledger.js";
import * as pricing from "../price.js";
import type { Discovery, RunEvent, SourceInfo } from "../discovery.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
let actualOpen: typeof fs.open;
let root: string, ledger: UsageLedger, ingest: typeof import("../ingest.js").ingestOnce;
const at = Date.parse("2026-10-04T12:00:00Z");
const usage = { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 };
function header(id = "session", extra = {}) { return { type: "session", id, timestamp: new Date(at - 1000).toISOString(), ...extra }; }
function message(id: string, extra = {}, ts = at) { return { type: "message", id, timestamp: new Date(ts).toISOString(), message: { role: "assistant", provider: "github-copilot", model: "gpt-6.1-sol", responseId: id, usage, ...extra } }; }
function report(id: string, runId: string, tokens = usage, model = "gpt-6.1-sol", ts = at) { return { type: "usage", kind: "subagent", id, timestamp: new Date(ts).toISOString(), provider: "github-copilot", model, usage: tokens, note: `worker (${runId})` }; }
function run(id: string, extra: Partial<RunMeta> = {}): RunMeta { return { id, dbPath: join(root, "runs.db"), project: null, repo: null, sessionId: "owner", parentRunId: null, agent: null, role: null, name: null, model: null, thinking: null, phase: null, startedAt: at - 1000, endedAt: at, ...extra }; }
function source(name: string, r: RunMeta | null = null): SourceInfo { return { path: join(root, `${name}.jsonl`), project: null, repo: null, run: r }; }
function write(s: SourceInfo, entries: unknown[]) { writeFileSync(s.path, entries.map(e => JSON.stringify(e)).join("\n") + "\n"); }
function discovery(sources: SourceInfo[], runs: RunMeta[] = [], extra: Partial<Discovery> = {}): Discovery { return { sources, runs, errors: [], ledgerFile: join(root, "ledger.db"), ...extra }; }
function scan(d: Discovery, signal = new AbortController().signal) { return ingest(ledger, d, at + 1, signal); }
function rows(sql = "SELECT * FROM calls ORDER BY source_file, entry_id"): any[] { const d = openDbReadOnly(join(root, "ledger.db"))!; try { return d.prepare(sql).all(); } finally { d.close(); } }
function selected() { return rows("SELECT * FROM counted_calls ORDER BY entry_id"); }
function event(id: number, r: RunMeta, purpose: string | undefined, ts = at): RunEvent { return { dbPath: r.dbPath, id, runId: r.id, sessionId: r.sessionId, ts, type: "spider_usage", payload: JSON.stringify({ provider: "github-copilot", model: "gpt-6.1-sol", usage, ...(purpose ? { purpose } : {}) }) }; }
beforeEach(async () => { actualOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open; vi.mocked(fs.open).mockImplementation(actualOpen); root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "usage-ingest-")); ledger = openUsageLedger(join(root, "ledger.db")); ({ ingestOnce: ingest } = await import("../ingest.js")); });
afterEach(() => { vi.restoreAllMocks(); ledger.close(); rmSync(root, { recursive: true, force: true }); });

it("resumes only through complete UTF8 newline boundaries", async () => {
  const s = source("parent"); write(s, [header(), message("one")]); await scan(discovery([s])); const offset = statSync(s.path).size;
  const bytes = Buffer.from(JSON.stringify(message("two", { label: "猫" })) + "\n"); const split = bytes.indexOf(Buffer.from("猫")) + 1;
  appendFileSync(s.path, bytes.subarray(0, split)); await scan(discovery([s])); expect(ledger.getImportState(s.path)?.offset).toBe(offset); expect(ledger.health()).toMatchObject({ calls: 1, parseErrors: 0 }); expect(ledger.summarize(0, at + 1).possibleUndercount).toBe(true);
  appendFileSync(s.path, bytes.subarray(split)); await scan(discovery([s])); expect(ledger.health()).toMatchObject({ calls: 2, parseErrors: 0 }); expect(ledger.getImportState(s.path)?.offset).toBe(statSync(s.path).size); expect(ledger.summarize(0, at + 1).possibleUndercount).toBe(false);
});
it("isolates malformed complete lines without replaying parse errors", async () => {
  const s = source("parent"); writeFileSync(s.path, [header(), message("one")].map(e => JSON.stringify(e)).join("\n") + "\n{bad\n" + JSON.stringify(message("two")) + "\n");
  await scan(discovery([s])); expect(ledger.health()).toMatchObject({ calls: 2, parseErrors: 1 }); const before = ledger.summarize(0, at + 1); await scan(discovery([s])); expect(ledger.summarize(0, at + 1)).toEqual(before); expect(ledger.health().parseErrors).toBe(1);
});
it.each(["rotation", "truncation", "regrowth"])("detects %s and atomically removes old source contributions", async mode => {
  const s = source("parent"); write(s, [header(), message("one", { padding: "x".repeat(9000) })]); await scan(discovery([s])); const ino = statSync(s.path).ino;
  if (mode === "rotation") renameSync(s.path, join(root, "old.jsonl"));
  write(s, [header(), message("two", mode === "regrowth" ? { padding: "y".repeat(12000) } : {})]);
  if (mode !== "rotation") expect(statSync(s.path).ino).toBe(ino);
  await scan(discovery([s])); expect(ledger.getImportState(s.path)?.generation).toBe(1); expect(rows().map(r => r.entry_id)).toEqual(["two"]);
});
it("rebuilds prefix ancestry without repricing previously imported calls", async () => {
  const s = source("parent"); write(s, [header(), { type: "thinking_level_change", id: "effort", thinkingLevel: "high", parentId: null }, message("one")]); await scan(discovery([s])); const old = rows()[0];
  appendFileSync(s.path, JSON.stringify({ ...message("two"), parentId: "effort" }) + "\n"); await scan(discovery([s])); expect(rows().find(r => r.entry_id === "two").thinking).toBe("high"); expect(rows().find(r => r.entry_id === "one")).toEqual(old);
});
it("suppresses copied fork ancestors but counts both branches with missing and cyclic parents", async () => {
  const original = run("original"), fork = run("fork"), a = source("original", original), b = source("fork", fork);
  write(a, [header("a"), message("old", {}, at - 2000), message("a-new")]); write(b, [header("b", { parentSession: a.path }), message("old", {}, at - 2000), message("b-new")]);
  await scan(discovery([a, b], [original, fork])); expect(selected()).toHaveLength(3); expect(rows().find(r => r.source_file === b.path && r.entry_id === "old")).toMatchObject({ copied: 1, run_id: "original" });
  rmSync(a.path); await scan(discovery([b], [original, fork])); expect(selected()).toHaveLength(3);
  const missing = source("missing", run("missing")); write(missing, [header("missing", { parentSession: join(root, "never-read.jsonl") }), message("orphan-copy", {}, at - 2000), message("native")]); await scan(discovery([missing])); expect(rows().find(r => r.entry_id === "orphan-copy")).toMatchObject({ copied: 1, run_id: null });
  const c = source("cycle-c"), d = source("cycle-d"); write(c, [header("c", { parentSession: d.path }), message("c")]); write(d, [header("d", { parentSession: c.path }), message("d")]); await scan(discovery([c, d])); expect(rows().some(r => r.entry_id === "c")).toBe(true);
});
it("selects reports or retained own-transcript detail and direct DB aux", async () => {
  const r = run("child"), p = source("parent"), c = source("child", r); write(p, [header("owner"), report("report", r.id, { ...usage, input: 3000 })]);
  const events = [event(1, r, "memory-review"), event(2, r, undefined), event(3, r, "compaction"), event(4, r, "branch_summary"), event(5, r, "subagent"), event(6, r, "spider-subagent"), event(7, r, "cache_warm"), event(8, r, "arbitrary")];
  const d = discovery([p], [r], { runEvents: events }); await scan(d); expect(selected().map(r => r.source_kind)).toEqual(["report"]); expect(rows()).toHaveLength(2);
  write(c, [header("child-session"), message("one"), message("two")]); await scan({ ...d, sources: [p, c] }); expect(selected().map(r => r.source_kind).sort()).toEqual(["run-db-aux", "transcript", "transcript"]); expect(selected().reduce((n, r) => n + r.input, 0)).toBe(3000);
  rmSync(c.path); await scan({ ...d, sources: [p, c] }); expect(selected()).toHaveLength(3);
  ledger.close(); ledger = openUsageLedger(join(root, "fresh.db")); await scan({ ...d, ledgerFile: join(root, "fresh.db") }); expect(ledger.health().aggregateCalls).toBe(1);
});
it("does not let inherited detail displace a fork run report", async () => {
  const r = run("fork"), p = source("parent"), c = source("fork", r); write(p, [header(), report("r", r.id)]); write(c, [header("fork", { parentSession: "missing" }), message("copy", {}, at - 2000)]);
  await scan(discovery([p, c], [r])); expect(ledger.health().aggregateCalls).toBe(1); expect(rows().find(r => r.entry_id === "copy").copied).toBe(1);
});
it("covers nested runs only with native transcript evidence across models and anonymous summaries", async () => {
  const r = run("outer"), n = run("nested", { parentRunId: r.id }), p = source("parent"), c = source("outer", r), child = source("nested", n);
  write(p, [header(), report("outer-r", r.id, { ...usage, input: 4000 }, "claude-opus-5-5")]); write(c, [header("outer-session"), report("nested-r", n.id, { ...usage, input: 3000 }, "claude-opus-5.5")]);
  write(child, [header("nested-session"), message("nested-call"), { type: "compaction", id: "summary", timestamp: new Date(at).toISOString(), usage }]);
  await scan(discovery([p, c, child], [r, n])); expect(selected().map(r => r.entry_id)).toEqual(["outer-r"]); expect(rows("SELECT * FROM coverage_edges")).toEqual([{ report_run_id: r.id, included_run_id: n.id, evidence: "transcript" }]);
  rmSync(c.path); await scan(discovery([p, c, child], [r, n])); expect(selected().map(r => r.entry_id)).toEqual(["outer-r"]);
  write(c, [header("outer-session"), { type: "label", id: "no-report" }]); await scan(discovery([p, c, child], [r, n])); expect(ledger.summarize(0, at + 1).possibleOverlap).toBe(true); expect(selected().reduce((n, r) => n + r.input, 0)).toBe(6000);
});
it("inherited nested reports never establish coverage", async () => {
  const r = run("outer"), n = run("nested", { parentRunId: r.id }), p = source("p"), c = source("c", r); write(p, [header(), report("r", r.id)]); write(c, [header("fork", { parentSession: "missing" }), report("copy", n.id, usage, "gpt-6.1-sol", at - 2000)]);
  await scan(discovery([p, c], [r, n])); expect(rows("SELECT * FROM coverage_edges WHERE evidence='transcript'")).toHaveLength(0);
});
it.each(["proven", "late", "equal", "running", "wrong-context", "legacy"])("requires strict runs-db reporting proof: %s", async mode => {
  const r = run("outer"), n = run("nested", { parentRunId: r.id, sessionId: mode === "wrong-context" ? "other" : "outer-session", endedAt: mode === "running" ? null : at - 100 }), p = source("p"), c = source("outer", r), child = source("nested", n);
  write(p, [header(), report("r", r.id, { ...usage, input: 2000 })]); write(c, [header("outer-session")]); write(child, [header("nested-session"), message("nested")]);
  const marker: RunEvent = { dbPath: n.dbPath, id: 2, runId: n.id, sessionId: n.sessionId, ts: mode === "late" ? at + 1 : mode === "equal" ? at : at - 10, type: "spider_usage_reported", payload: null };
  await scan(discovery([p, c, child], [r, n], { runEvents: [event(1, n, undefined, at - 100), marker], runStates: [{ id: r.id, dbPath: r.dbPath, status: "done", childMode: "rpc" }, { id: n.id, dbPath: n.dbPath, status: mode === "running" ? "running" : "done", childMode: mode === "legacy" ? "print" : "rpc" }] }));
  expect(selected().length).toBe(mode === "proven" ? 1 : 2); expect(rows("SELECT evidence FROM coverage_edges")[0]?.evidence).toBe(mode === "proven" ? "runs-db" : "unknown");
});
it("withdraws stale DB proof but keeps a surviving transcript proof", async () => {
  const r = run("outer"), n = run("nested", { parentRunId: r.id, sessionId: "outer-session", endedAt: at - 100 }), p = source("p"), c = source("outer", r), child = source("nested", n); write(p, [header(), report("r", r.id)]); write(c, [header("outer-session")]); write(child, [header(), message("one")]);
  const d = discovery([p, c, child], [r, n], { runStates: [{ id: r.id, dbPath: r.dbPath, status: "done", childMode: "rpc" }, { id: n.id, dbPath: n.dbPath, status: "done", childMode: "rpc" }], runEvents: [event(1, n, undefined, at - 100), { dbPath: n.dbPath, id: 2, runId: n.id, sessionId: n.sessionId, ts: at - 10, type: "spider_usage_reported", payload: null }] });
  await scan(d); expect(selected()).toHaveLength(1); await scan({ ...d, runEvents: [] }); expect(selected()).toHaveLength(2);
  appendFileSync(c.path, JSON.stringify(report("nested-report", n.id)) + "\n"); await scan({ ...d, runEvents: [] }); expect(selected()).toHaveLength(1); await scan({ ...d, runEvents: [] }); expect(rows("SELECT evidence FROM coverage_edges")[0].evidence).toBe("transcript");
});
it("does not double count recursively nested run reports", async () => {
  const a = run("a"), b = run("b", { parentRunId: "a" }), c = run("c", { parentRunId: "b" }), p = source("p"), sa = source("a", a), sb = source("b", b), sc = source("c", c);
  write(p, [header(), report("ra", "a", { ...usage, input: 3000 })]); write(sa, [header("a"), report("rb", "b", { ...usage, input: 2000 })]); write(sb, [header("b"), report("rc", "c")]); write(sc, [header("c"), message("own")]); await scan(discovery([p, sa, sb, sc], [a, b, c])); expect(selected().reduce((n, r) => n + r.input, 0)).toBe(3000);
});
it("flags partial imports and nonterminal detail, not complete terminal detail", async () => {
  const r = run("r", { endedAt: null }), p = source("p"), c = source("r", r); write(p, [header(), report("r", r.id, { ...usage, input: 2000 })]); write(c, [header(), message("partial")]); await scan(discovery([p, c], [r])); expect(ledger.summarize(0, at + 1).possibleUndercount).toBe(true);
  await scan(discovery([p, c], [{ ...r, endedAt: at }])); expect(ledger.summarize(0, at + 1).possibleUndercount).toBe(false);
  appendFileSync(c.path, "{unfinished"); await scan(discovery([p, c], [r])); expect(ledger.summarize(at + 100, at + 200).possibleUndercount).toBe(true);
});
it("failed child read and transaction retain fallback and committed cursor", async () => {
  const r = run("r"), p = source("p"), c = source("r", r); write(p, [header(), report("r", r.id)]); await scan(discovery([p], [r])); mkdirSync(c.path); await scan(discovery([p, c], [r])); expect(ledger.health().aggregateCalls).toBe(1); rmSync(c.path, { recursive: true }); write(c, [header(), message("detail")]);
  const apply = ledger.apply.bind(ledger); vi.spyOn(ledger, "apply").mockImplementationOnce(() => { throw Object.assign(new Error("fixture lock"), { code: "SQLITE_BUSY" }); }).mockImplementation(apply);
  await scan(discovery([p, c], [r])); expect(ledger.health().aggregateCalls).toBe(1); expect(ledger.getImportState(c.path)?.offset ?? 0).toBe(0); await scan(discovery([p, c], [r])); expect(ledger.health().aggregateCalls).toBe(0);
});
it("reimport is idempotent and concurrent scans cannot regress offsets", async () => {
  const s = source("p"); write(s, [header(), message("one")]); const d = discovery([s]); await Promise.all([scan(d), scan(d)]); const before = rows(); await scan(d); expect(rows()).toEqual(before); appendFileSync(s.path, JSON.stringify(message("two")) + "\n"); await Promise.all([scan(d), scan(d)]); expect(rows()).toHaveLength(2); expect(ledger.getImportState(s.path)?.offset).toBe(statSync(s.path).size);
});
it("cancelled batch advances no uncommitted offset", async () => {
  const s = source("p"); write(s, [header(), message("one")]); const controller = new AbortController(); controller.abort(); await scan(discovery([s]), controller.signal); expect(rows()).toHaveLength(0); expect(ledger.getImportState(s.path)).toBeUndefined();
});
it("imports response model billing ids and aggregate lower-bound pricing", async () => {
  const s = source("p"); write(s, [header(), message("one", { model: "requested", responseModel: "claude-opus-5-5" }), report("r", "child", { ...usage, input: 1000000 }, "claude-opus-5.5")]); await scan(discovery([s])); expect(rows().find(r => r.entry_id === "one")).toMatchObject({ model: "claude-opus-5.5", raw_model: "claude-opus-5-5", requested_model: "requested", response_id: "one" }); expect(rows().find(r => r.entry_id === "r")).toMatchObject({ tier: "aggregate-default-lower-bound", confidence: "estimated" });
});

// A generation rebuild must count new malformed records, not erase its diagnostics.
it("retains parse errors in a reset generation", async () => {
  const s = source("p"); write(s, [header(), message("old")]); await scan(discovery([s]));
  writeFileSync(s.path, JSON.stringify(header()) + "\n{bad\n" + JSON.stringify(message("new")) + "\n"); await scan(discovery([s]));
  expect(ledger.health()).toMatchObject({ calls: 1, parseErrors: 1 }); expect(ledger.getImportState(s.path)?.generation).toBe(1);
});
it("does not withdraw historical DB evidence when its source DB cannot be read", async () => {
  const r = run("outer"), n = run("nested", { parentRunId: r.id, sessionId: "outer-session", endedAt: at - 100 }), p = source("p"), c = source("outer", r), child = source("nested", n);
  write(p, [header(), report("r", r.id)]); write(c, [header("outer-session")]); write(child, [header(), message("one")]);
  const d = discovery([p, c, child], [r, n], { runStates: [{ id: r.id, dbPath: r.dbPath, status: "done", childMode: "rpc" }, { id: n.id, dbPath: n.dbPath, status: "done", childMode: "rpc" }], runEvents: [event(1, n, undefined, at - 100), { dbPath: n.dbPath, id: 2, runId: n.id, sessionId: n.sessionId, ts: at - 10, type: "spider_usage_reported", payload: null }] });
  await scan(d); expect(selected()).toHaveLength(1);
  await scan({ ...d, runs: [], runStates: [], runEvents: [], errors: [{ path: r.dbPath, code: "SQLITE_BUSY" }] }); expect(selected()).toHaveLength(1); expect(rows("SELECT evidence FROM coverage_edges")[0].evidence).toBe("runs-db");
});
it("reconstructs retained transcript proof after reopen and withdraws it on generation replacement", async () => {
  const r = run("outer"), n = run("nested", { parentRunId: r.id }), p = source("p"), c = source("outer", r), child = source("nested", n); write(p, [header(), report("r", r.id)]); write(c, [header(), report("n", n.id)]); write(child, [header(), message("one")]); const d = discovery([p, c, child], [r, n]); await scan(d);
  ledger.close(); ledger = openUsageLedger(join(root, "ledger.db")); rmSync(c.path); await scan(d); expect(selected()).toHaveLength(1);
  write(c, [header(), { type: "label", id: "replacement" }]); await scan(d); expect(selected()).toHaveLength(2); expect(rows("SELECT evidence FROM coverage_edges")[0].evidence).toBe("unknown");
});
it("commits every report model group together and rolls them back together", async () => {
  const r = run("child"), p = source("p"); write(p, [header(), report("one", r.id), report("two", r.id, usage, "claude-opus-5-5")]); const d = discovery([p], [r]); const apply = ledger.apply.bind(ledger);
  vi.spyOn(ledger, "apply").mockImplementationOnce(batch => { expect(batch.calls.filter(c => c.sourceKind === "report")).toHaveLength(2); throw new Error("fixture transaction failure"); }).mockImplementation(apply);
  await scan(d); expect(rows()).toHaveLength(0); expect(ledger.getImportState(p.path)?.offset ?? 0).toBe(0); await scan(d); expect(ledger.health().aggregateCalls).toBe(2);
});
it("detects regrowth beyond an unchanged fixed prefix", async () => {
  const s = source("p"); const first = message("first", { padding: "x".repeat(9000) }); write(s, [header(), first, message("old-tail")]); await scan(discovery([s])); write(s, [header(), first, message("new-tail", { padding: "x".repeat(1000) })]); await scan(discovery([s])); expect(ledger.getImportState(s.path)?.generation).toBe(1); expect(rows().map(r => r.entry_id).sort()).toEqual(["first", "new-tail"]);
});

it("retains DB aux facts when a replacement DB has no events", async () => {
  const r = run("child"), p = source("p"); write(p, [header(), message("one")]); const d = discovery([p], [r], { runStates: [{ id: r.id, dbPath: r.dbPath, status: "done", childMode: "rpc" }], runEvents: [event(1, r, "memory-review")] }); await scan(d); expect(selected()).toHaveLength(2);
  await scan({ ...d, runEvents: [], runDbs: [r.dbPath] }); expect(selected()).toHaveLength(2); expect(ledger.getImportState(`${r.dbPath}#spider-aux`)?.generation).toBe(0);
});
it("does not drop new calls after malformed metadata in an earlier prefix", async () => {
  const s = source("p"); writeFileSync(s.path, JSON.stringify(header()) + "\n{bad\n" + JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high" }) + "\n"); await scan(discovery([s])); appendFileSync(s.path, JSON.stringify(message("one")) + "\n"); await scan(discovery([s])); expect(rows()[0].thinking).toBe("high"); expect(ledger.health().parseErrors).toBe(1);
});

it("ignores invalid earlier entry roots when rebuilding linear attribution", async () => {
  const s = source("p"); write(s, [header(), { type: "thinking_level_change", id: "effort", thinkingLevel: "high" }, { id: "invalid", parentId: null }]); await scan(discovery([s])); appendFileSync(s.path, JSON.stringify(message("one")) + "\n"); await scan(discovery([s])); expect(rows()[0].thinking).toBe("high");
});
it("preserves original provenance through multiple discovered fork ancestors", async () => {
  const original = run("original", { role: "worker", agent: "author" }), fork = run("fork"), leaf = run("leaf"), a = source("a", original), b = source("b", fork), c = source("c", leaf);
  const old = message("old", {}, at - 4000); write(a, [header("a"), old]); write(b, [header("b", { parentSession: a.path }), old]); write(c, [header("c", { parentSession: b.path }), old]); await scan(discovery([a, b, c], [original, fork, leaf])); expect(rows().find(r => r.source_file === c.path)).toMatchObject({ copied: 1, run_id: "original", agent: "author", role: "worker" }); expect(selected()).toHaveLength(1);
});

it("defers every model part of a report group at an incomplete file tail", async () => {
  const r = run("child", { endedAt: null }), p = source("p"); write(p, [header()]); const start = statSync(p.path).size;
  appendFileSync(p.path, JSON.stringify(report("one", r.id)) + "\n"); const last = Buffer.from(JSON.stringify(report("two", r.id, usage, "claude-opus-5.5")) + "\n"); appendFileSync(p.path, last.subarray(0, 50));
  await scan(discovery([p], [r])); expect(ledger.health().aggregateCalls).toBe(0); expect(ledger.getImportState(p.path)?.offset).toBe(start + Buffer.byteLength(JSON.stringify(report("one", r.id)) + "\n")); expect(ledger.health().parseErrors).toBe(0);
  appendFileSync(p.path, last.subarray(50)); await scan(discovery([p], [r])); expect(ledger.health().aggregateCalls).toBe(2); expect(ledger.getImportState(p.path)?.offset).toBe(statSync(p.path).size);
});

it("holds a newline-complete report until all known DB model groups are present", async () => {
  const r = run("child", { endedAt: null }), p = source("p"); write(p, [header(), report("one", r.id)]); const start = Buffer.byteLength(JSON.stringify(header()) + "\n");
  const second = { ...event(2, r, undefined), payload: JSON.stringify({ provider: "github-copilot", model: "claude-opus-5.5", usage }) };
  const d = discovery([p], [r], { runStates: [{ id: r.id, dbPath: r.dbPath, status: "running", childMode: "rpc" }], runEvents: [event(1, r, undefined), second, { dbPath: r.dbPath, id: 3, runId: r.id, sessionId: r.sessionId, ts: at, type: "spider_usage_reported", payload: null }] });
  await scan(d); expect(ledger.health().aggregateCalls).toBe(0); expect(ledger.getImportState(p.path)?.offset).toBe(statSync(p.path).size);
  appendFileSync(p.path, JSON.stringify(report("two", r.id, usage, "claude-opus-5.5")) + "\n"); await scan(d); expect(ledger.health().aggregateCalls).toBe(2);
});

it("cancelled during a bounded read commits neither facts nor offsets", async () => {
  const s = source("p"); write(s, [header(), message("one", { padding: "x".repeat(200000) })]); const controller = new AbortController(), realOpen = actualOpen;
  vi.mocked(fs.open).mockImplementation(async (...args) => { const file = await realOpen(...args); const read = file.read.bind(file); vi.spyOn(file, "read").mockImplementation(async (...readArgs: any[]) => { const result = await (read as any)(...readArgs); controller.abort(); return result; }); return file; });
  await scan(discovery([s]), controller.signal); expect(rows()).toHaveLength(0); expect(ledger.getImportState(s.path)).toBeUndefined();
});
it("a delayed stale scan cannot regress a newer byte cursor or raw calls", async () => {
  const a = source("a"), b = source("b"); write(a, [header(), message("one")]); write(b, [header(), message("other")]); const d = discovery([a, b]); await scan(d);
  const realOpen = actualOpen; let release!: () => void, blocked!: () => void; const entered = new Promise<void>(r => { blocked = r; }), gate = new Promise<void>(r => { release = r; }); let first = true;
  vi.mocked(fs.open).mockImplementation(async (...args) => { const file = await realOpen(...args); if (args[0] === b.path && first) { first = false; const read = file.read.bind(file); vi.spyOn(file, "read").mockImplementationOnce(async (...readArgs: any[]) => { blocked(); await gate; return (read as any)(...readArgs); }); } return file; });
  appendFileSync(b.path, JSON.stringify(message("other-two")) + "\n"); const old = scan(d); await entered; appendFileSync(a.path, JSON.stringify(message("two")) + "\n"); await scan(d); const cursor = ledger.getImportState(a.path), before = rows(); release(); await old; expect(ledger.getImportState(a.path)).toEqual(cursor); expect(rows()).toEqual(before); expect(selected()).toHaveLength(4);
});
it("retains another source's transcript proof when one proving generation is replaced", async () => {
  const r = run("outer"), n = run("nested", { parentRunId: r.id }), p = source("p"), a = source("a", r), b = source("b", r), c = source("c", n); write(p, [header(), report("r", r.id)]); write(a, [header(), report("n-a", n.id)]); write(b, [header(), report("n-b", n.id)]); write(c, [header(), message("one")]); const d = discovery([p, a, b, c], [r, n]); await scan(d); write(a, [header(), { type: "label", id: "gone" }]); await scan(d); expect(selected()).toHaveLength(1); expect(rows("SELECT evidence FROM coverage_edges")[0].evidence).toBe("transcript");
});

// Fix round 1: these assertions fail if ingest replays, fences or loses facts.
it("skips unchanged sources without opening them after a ledger restart", async () => {
  const s = source("p"); write(s, [header(), message("one")]); await scan(discovery([s]));
  ledger.close(); ledger = openUsageLedger(join(root, "ledger.db"));
  vi.mocked(fs.open).mockClear(); await scan(discovery([s]));
  expect(fs.open).not.toHaveBeenCalled(); expect(rows()).toHaveLength(1);
});
it("prices only new entries on an append after a ledger restart", async () => {
  const s = source("p"); write(s, [header(), { type: "thinking_level_change", id: "effort", thinkingLevel: "high" }, message("one")]);
  await scan(discovery([s])); ledger.close(); ledger = openUsageLedger(join(root, "ledger.db"));
  const price = vi.spyOn(pricing, "priceCall");
  appendFileSync(s.path, JSON.stringify({ ...message("two"), parentId: "effort" }) + "\n"); await scan(discovery([s]));
  expect(price).toHaveBeenCalledTimes(1); expect(rows().find(r => r.entry_id === "two").thinking).toBe("high");
});
it("commits the initial snapshot when the source grows during its read", async () => {
  const s = source("p"); write(s, [header()]); await scan(discovery([s])); appendFileSync(s.path, JSON.stringify(message("one")) + "\n"); const size = statSync(s.path).size;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await actualOpen(...args), read = file.read.bind(file);
    vi.spyOn(file, "read").mockImplementationOnce(async (...a: any[]) => {
      const result = await (read as any)(...a); appendFileSync(s.path, JSON.stringify(message("two")) + "\n"); return result;
    }); return file;
  });
  await scan(discovery([s])); expect(ledger.health()).toMatchObject({ calls: 1, sourceErrors: 0 });
  expect(ledger.getImportState(s.path)?.offset).toBe(size);
  vi.mocked(fs.open).mockImplementation(actualOpen); await scan(discovery([s])); expect(rows()).toHaveLength(2);
});
it("never fences messages after a report and excludes post-marker usage", async () => {
  const r = run("child"), p = source("p"); write(p, [header(), report("r", r.id), message("later")]);
  const other = { ...event(3, r, undefined, at + 1), payload: JSON.stringify({ provider: "github-copilot", model: "other", usage }) };
  await scan(discovery([p], [r], { runEvents: [event(1, r, undefined), { ...event(2, r, undefined), type: "spider_usage_reported", payload: null }, other] }));
  expect(rows().map(r => r.entry_id)).toEqual(["later", "r"]); expect(ledger.getImportState(p.path)?.offset).toBe(statSync(p.path).size);
  expect(rows("SELECT * FROM incomplete_reports")).toEqual([]);
  expect(ledger.summarize(0, at + 1).possibleUndercount).toBe(false);
});
it("persists pending groups without pinning the cursor and releases aged incomplete reports", async () => {
  const r = run("child", { endedAt: null }), p = source("p"); write(p, [header(), report("one", r.id)]);
  const partial = Buffer.from(JSON.stringify(report("two", r.id, usage, "claude-opus-5.5")) + "\n");
  appendFileSync(p.path, partial.subarray(0, 50)); const complete = statSync(p.path).size - 50;
  const d = discovery([p], [r], { runEvents: [event(1, r, undefined), { ...event(2, r, undefined), payload: JSON.stringify({ provider: "github-copilot", model: "claude-opus-5.5", usage }) }] });
  await scan(d); expect(ledger.getImportState(p.path)?.offset).toBe(complete); expect(ledger.health().aggregateCalls).toBe(0);
  ledger.close(); ledger = openUsageLedger(join(root, "ledger.db"));
  await ingest(ledger, d, at + 86400000, new AbortController().signal);
  expect(ledger.health().aggregateCalls).toBe(1); expect(ledger.summarize(0, at + 1).possibleUndercount).toBe(true);
});
it("counts malformed lines once after a same-inode rewrite", async () => {
  const s = source("p"); writeFileSync(s.path, JSON.stringify(header()) + "\n{bad\n" + JSON.stringify(message("old")) + "\n"); await scan(discovery([s]));
  writeFileSync(s.path, JSON.stringify(header("changed")) + "\n{bad\n" + JSON.stringify(message("new", { padding: "xxx" })) + "\n"); await scan(discovery([s]));
  expect(ledger.getImportState(s.path)?.generation).toBe(1); expect(ledger.health().parseErrors).toBe(1);
});
it("diagnoses unknown aux purposes by name without importing them", async () => {
  const r = run("r"); await scan(discovery([], [r], { runEvents: [event(1, r, "future-purpose"), event(2, r, "future-purpose")] }));
  expect(rows()).toHaveLength(0); expect(rows("SELECT source_error_code FROM import_state").map(r => r.source_error_code)).toContain("unknown-aux-purpose:future-purpose:2");
});
it("retains immutable aux facts when a runs DB is recreated at the same path", async () => {
  const r = run("r"); const d = discovery([], [r], { runDbs: [r.dbPath], runEvents: [event(1, r, "memory-review"), event(2, r, "learner")] }); await scan(d);
  await scan({ ...d, runEvents: [event(1, r, "skill-review")] });
  expect(rows()).toHaveLength(3); expect(ledger.health().sourceErrors).toBe(1);
});
it("uses the open ledger for proof even with an incorrect discovery ledger path", async () => {
  const r = run("outer"), n = run("nested", { parentRunId: r.id }), p = source("p"), c = source("c", r), child = source("child", n);
  write(p, [header(), report("r", r.id)]); write(c, [header(), report("n", n.id)]); write(child, [header(), message("one")]); const d = discovery([p, c, child], [r, n]); await scan(d);
  ledger.close(); ledger = openUsageLedger(join(root, "ledger.db")); rmSync(c.path);
  await scan({ ...d, ledgerFile: join(root, "wrong.db") }); expect(selected()).toHaveLength(1); expect(rows("SELECT evidence FROM coverage_edges")[0].evidence).toBe("transcript");
});
it("aborts after the final source read before applying any part of a two-source batch", async () => {
  const a = source("a"), b = source("b"); write(a, [header()]); write(b, [header()]); await scan(discovery([a, b]));
  const before = ledger.getImportState(a.path); appendFileSync(a.path, JSON.stringify(message("a")) + "\n"); appendFileSync(b.path, JSON.stringify(message("b")) + "\n");
  const controller = new AbortController();
  vi.mocked(fs.open).mockImplementation(async (...args) => { const f = await actualOpen(...args); if (args[0] === b.path) { const close = f.close.bind(f); vi.spyOn(f, "close").mockImplementation(async () => { await close(); controller.abort(); }); } return f; });
  await scan(discovery([a, b]), controller.signal); expect(rows()).toHaveLength(0); expect(ledger.getImportState(a.path)).toEqual(before);
});

it("does not repeatedly concatenate an unfinished large JSON line", async () => {
  const s = source("p"); write(s, [header(), message("one", { content: "x".repeat(2 * 1024 * 1024) })]);
  const concat = Buffer.concat; let allocated = 0;
  vi.spyOn(Buffer, "concat").mockImplementation((list, total) => { allocated += total ?? list.reduce((n, b) => n + b.length, 0); return concat(list, total); });
  await scan(discovery([s])); expect(rows()).toHaveLength(1); expect(allocated).toBeLessThan(5 * 1024 * 1024);
});

// Final round: P3, P4 and P6 plus surviving ancestry/report mutations.
function twoModels(r: RunMeta): RunEvent[] {
  return [event(1, r, undefined), {
    ...event(2, r, undefined), payload: JSON.stringify({ provider: "github-copilot", model: "claude-opus-5.5", usage })
  }, { ...event(3, r, undefined), type: "spider_usage_reported", payload: null }];
}
it.each(["terminal", "aged", "held"])("clears undercount when a %s split report completes (P3/P4)", async mode => {
  const r = run("child", { endedAt: mode === "terminal" ? at : null }), p = source("p");
  write(p, [header(), report("one", r.id)]);
  const d = discovery([p], [r], { runEvents: twoModels(r) });
  await ingest(ledger, d, at, new AbortController().signal);
  if (mode === "aged") await ingest(ledger, d, at + 300000, new AbortController().signal);
  expect(rows("SELECT * FROM incomplete_reports")).toHaveLength(mode === "held" ? 0 : 1);
  expect(ledger.summarize(0, at + 1).possibleUndercount).toBe(true);
  ledger.close(); ledger = openUsageLedger(join(root, "ledger.db"));
  appendFileSync(p.path, JSON.stringify(report("two", r.id, usage, "claude-opus-5.5")) + "\n");
  await ingest(ledger, d, at + 301000, new AbortController().signal);
  expect(rows()).toHaveLength(2);
  expect(rows("SELECT * FROM pending_reports")).toEqual([]);
  expect(rows("SELECT * FROM incomplete_reports")).toEqual([]);
  expect(ledger.summarize(0, at + 1).possibleUndercount).toBe(false);
});
it.each([false, true])("recomputes a report tail after an ordinary line completes (P6 terminal=%s)", async terminal => {
  const r = run("child", { endedAt: terminal ? at : null }), p = source("p");
  write(p, [header(), report("one", r.id)]);
  const line = JSON.stringify(message("later")) + "\n";
  appendFileSync(p.path, line.slice(0, 40));
  const d = discovery([p], [r], { runEvents: [event(1, r, undefined), { ...event(2, r, undefined), type: "spider_usage_reported", payload: null }] });
  await scan(d);
  appendFileSync(p.path, line.slice(40)); await scan(d);
  expect(rows().map(r => r.entry_id)).toEqual(["later", "one"]);
  expect(rows("SELECT * FROM pending_reports")).toEqual([]);
  expect(rows("SELECT * FROM incomplete_reports")).toEqual([]);
  expect(ledger.summarize(0, at + 1).possibleUndercount).toBe(false);
});
it("releases a held group when discovery observes a terminal status", async () => {
  const r = run("child", { endedAt: null }), p = source("p"); write(p, [header(), report("one", r.id)]);
  const d = discovery([p], [r], { runEvents: twoModels(r) }); await scan(d);
  expect(ledger.health().aggregateCalls).toBe(0);
  await scan({ ...d, runStates: [{ dbPath: r.dbPath, id: r.id, status: "done", childMode: "rpc" }] });
  expect(ledger.health().aggregateCalls).toBe(1);
  expect(rows("SELECT * FROM pending_reports")).toEqual([]);
  expect(rows("SELECT * FROM incomplete_reports")).toHaveLength(1);
  expect(ledger.summarize(0, at + 1).possibleUndercount).toBe(true);
});
it("follows persisted explicit metadata ancestry rather than the previous branch", async () => {
  const p = source("p");
  write(p, [header(), { type: "thinking_level_change", id: "high", thinkingLevel: "high", parentId: null },
  { type: "thinking_level_change", id: "low", thinkingLevel: "low", parentId: null },
  { type: "label", id: "branch", parentId: "high" }]);
  await scan(discovery([p])); ledger.close(); ledger = openUsageLedger(join(root, "ledger.db"));
  appendFileSync(p.path, JSON.stringify({ ...message("branch-call"), parentId: "branch" }) + "\n");
  await scan(discovery([p]));
  expect(rows()[0].thinking).toBe("high");
});
it("bounds the report hold after a backward wall-clock step", async () => {
  const r = run("child", { endedAt: null }), p = source("p"); write(p, [header(), report("one", r.id)]);
  const d = discovery([p], [r], { runEvents: twoModels(r) });
  for (const t of [at, at - 3600000, at - 3600000 + 299999]) await ingest(ledger, d, t, new AbortController().signal);
  expect(ledger.health().aggregateCalls).toBe(0);
  await ingest(ledger, d, at - 3600000 + 300000, new AbortController().signal);
  expect(ledger.health().aggregateCalls).toBe(1);
});
it("does not rewrite unchanged aux state and emits recreation once", async () => {
  const r = run("r"), d = discovery([], [r], { runDbs: [r.dbPath], runEvents: [event(1, r, "memory-review")], runDbIdentities: { [r.dbPath]: "old" } });
  await scan(d); const before = ledger.getImportState(`${r.dbPath}#spider-aux`);
  const apply = vi.spyOn(ledger, "apply");
  await ingest(ledger, d, at + 100, new AbortController().signal);
  expect(apply.mock.calls[0][0].states).toEqual([]);
  expect(apply.mock.calls[0][0].sourceContexts).toEqual([]);
  expect(ledger.getImportState(`${r.dbPath}#spider-aux`)).toEqual(before);
  const empty = { ...d, runEvents: [], runDbIdentities: { [r.dbPath]: "new" } };
  await ingest(ledger, empty, at + 200, new AbortController().signal);
  expect(apply.mock.calls.at(-1)![0].sourceErrors).toContainEqual({ path: `${r.dbPath}#spider-aux`, code: "runs-db-recreated:facts-retained" });
  await ingest(ledger, empty, at + 300, new AbortController().signal);
  expect(apply.mock.calls.at(-1)![0].sourceErrors).toEqual([]);
  expect(apply.mock.calls.at(-1)![0].states).toEqual([]);
  expect(rows()).toHaveLength(1);
});
it("persists all checked discovery paths in the source diagnostic", async () => {
  const paths = [join(root, "first.jsonl"), join(root, "second.jsonl")];
  await scan(discovery([], [], { errors: [{ path: paths[0], code: "missing-source", checkedPaths: paths }] }));
  expect(JSON.parse(rows("SELECT source_error_paths FROM import_state")[0].source_error_paths)).toEqual(paths);
});

it("writes only new attribution rows and ignores unrelated historical branches", async () => {
  const p = source("p");
  write(p, [header(), ...Array.from({ length: 1000 }, (_, i) => ({ type: "label", id: `unused-${i}`, parentId: null })),
  { type: "thinking_level_change", id: "selected", thinkingLevel: "high", parentId: null }]);
  await scan(discovery([p]));
  const apply = vi.spyOn(ledger, "apply"), get = vi.spyOn(ledger, "getSourceContext");
  appendFileSync(p.path, JSON.stringify({ ...message("new"), parentId: "selected" }) + "\n");
  await scan(discovery([p]));
  expect(apply.mock.calls[0][0].sourceContexts![0].context.entries).toHaveLength(1);
  expect(get.mock.results.filter(r => r.type === "return").every(r => !r.value || r.value.entries.length <= 2)).toBe(true);
  expect(rows()[0].thinking).toBe("high");
});

it("does not deserialize linear historical messages for an append", async () => {
  const p = source("p");
  write(p, [header(), { type: "thinking_level_change", id: "effort", thinkingLevel: "high", parentId: null },
  ...Array.from({ length: 1000 }, (_, i) => ({ type: "label", id: `old-${i}` }))]);
  await scan(discovery([p])); ledger.close(); ledger = openUsageLedger(join(root, "ledger.db"));
  const get = vi.spyOn(ledger, "getSourceContext");
  appendFileSync(p.path, JSON.stringify(message("new")) + "\n"); await scan(discovery([p]));
  expect(get.mock.results.filter(r => r.type === "return").every(r => !r.value || r.value.entries.length <= 3)).toBe(true);
  expect(rows()[0].thinking).toBe("high");
});

it("does not use report models from a superseded source generation to complete a new group", async () => {
  const r = run("child", { endedAt: null }), p = source("p");
  const d = discovery([p], [r], { runEvents: twoModels(r) });
  write(p, [header(), report("old-one", r.id), report("old-two", r.id, usage, "claude-opus-5.5")]);
  await scan(d); expect(ledger.health().aggregateCalls).toBe(2);
  write(p, [header("replaced"), report("new-one", r.id)]); await scan(d);
  expect(ledger.getImportState(p.path)?.generation).toBe(1);
  expect(ledger.health().aggregateCalls).toBe(0);
  expect(ledger.getPendingReports()).toHaveLength(1);
  expect(ledger.summarize(0, at + 1).possibleUndercount).toBe(true);
});

it("persists newly attributable aux entries even when the event snapshot is unchanged", async () => {
  const r = run("later"), events = [event(1, r, "memory-review")];
  await scan(discovery([], [], { runEvents: events }));
  expect(rows()).toEqual([]);
  const price = vi.spyOn(pricing, "priceCall"), d = discovery([], [r], { runEvents: events });
  await scan(d); await scan(d);
  expect(rows()).toHaveLength(1);
  expect(price).toHaveBeenCalledTimes(1);
  expect(ledger.getSourceContext(`${r.dbPath}#spider-aux`)?.entries).toHaveLength(1);
});
