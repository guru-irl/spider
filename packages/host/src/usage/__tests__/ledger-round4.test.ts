import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDbReadOnly, type Db } from "@spider/db-core";
import { openUsageLedger, type CallRow, type ImportBatch, type UsageLedger } from "../ledger.js";

type Fact = CallRow;
let root: string, file: string, ledger: UsageLedger;
const readers: Db[] = [];
function call(id: string, value: number, overrides: Partial<Fact> = {}): Fact {
  return { id, entryId: id, ts: 100, sourceFile: "R.jsonl", sourceGeneration: 0,
    project: null, repo: null, sessionId: "R", runId: "R", actor: "subagent", role: null,
    agent: null, runName: null, phase: null, parentRunId: null, auxPurpose: null,
    provider: "github-copilot", model: "claude-opus-5.5", requestedModel: null, thinking: null, api: null,
    usage: { input: value, output: 0, cacheRead: 0, cacheWrite: 0 },
    price: { status: "priced", aic: value, components: { input: value, output: 0, cacheRead: 0, cacheWrite: 0 },
      rateVersion: "fixture", tier: "default", confidence: "verified" },
    piCost: null, latencyMs: null, aggregate: false, counted: true, originKey: null,
    sourceKind: overrides.actor === "subagent" && overrides.aggregate && overrides.runId != null ? "report" : "transcript", ...overrides };
}
function report(run: string, value: number, overrides: Partial<Fact> = {}): Fact {
  return call(`report-${run}`, value, { runId: run, sourceFile: "parent.jsonl", actor: "subagent", aggregate: true, ...overrides });
}
function batch(calls: readonly Fact[], overrides: Partial<ImportBatch> = {}): ImportBatch {
  return { calls, runs: [], states: [], detailedRunIds: [], restoreAggregateRunIds: [], resetSources: [],
    sourceErrors: [], at: 1000, ...overrides };
}
function db(): Db { const reader = openDbReadOnly(file)!; readers.push(reader); return reader; }
beforeEach(() => {
  root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "usage-round4-"));
  file = join(root, "usage.db"); ledger = openUsageLedger(file);
});
afterEach(() => { readers.splice(0).forEach(reader => reader.close()); ledger.close(); rmSync(root, { recursive: true, force: true }); });

// I7: run DB aux must not displace the report and must be additive once own transcript wins.
it.each([false, true])("conserves 25 credits with report and DB-only aux (transcript=%s)", transcript => {
  ledger.apply(batch([report("R", 25), call("aux", 5, { sourceFile: "runs.db", actor: "aux", sourceKind: "run-db-aux" }),
    ...(transcript ? [call("own", 20)] : [])]));
  expect(ledger.summarize(0, 200).aic).toBe(25);
  expect(db().prepare("SELECT id FROM counted_calls ORDER BY id").all()).toEqual(
    transcript ? [{ id: "aux" }, { id: "own" }] : [{ id: "report-R" }]);
});

// I8: exact model equality is not coverage, and alias storage must preserve raw provenance.
it("covers alias detail at run granularity and stores canonical plus raw ids", () => {
  ledger.apply(batch([report("R", 20, { model: "claude-opus-5-5" }),
    call("nested", 20, { runId: "N", sourceFile: "N.jsonl" })], {
    coverageEdges: [{ reportRunId: "R", includedRunId: "N", evidence: "runs-db" }] }));
  expect(ledger.summarize(0, 200).aic).toBe(20);
  expect(db().prepare("SELECT provider, model, raw_provider, raw_model FROM calls WHERE id='report-R'").get()).toEqual({
    provider: "github-copilot", model: "claude-opus-5.5", raw_provider: "github-copilot", raw_model: "claude-opus-5-5" });
});
it("deduplicates report aliases without losing per-model report breakdowns", () => {
  ledger.apply(batch([report("R", 20, { model: "claude-opus-5-5" }),
    report("R", 20, { id: "alias-copy", entryId: "copy", sourceFile: "fork.jsonl", copied: true }),
    report("R", 5, { id: "second-model", entryId: "second-model", model: "gpt-6.1-sol" }),
    call("nested", 25, { runId: "N", model: "gpt-6.1-sol", sourceFile: "N.jsonl" })], {
    coverageEdges: [{ reportRunId: "R", includedRunId: "N", evidence: "transcript" }] }));
  expect(ledger.summarize(0, 200).aic).toBe(25);
  expect(db().prepare("SELECT model, SUM(input) AS input FROM counted_calls GROUP BY model ORDER BY model").all()).toEqual([
    { model: "claude-opus-5.5", input: 20 }, { model: "gpt-6.1-sol", input: 5 }]);
});
it("does not double tokens or unpriced calls for model-less covered compaction", () => {
  ledger.apply(batch([report("R", 20), call("summary", 20, { runId: "N", sourceFile: "N.jsonl",
    actor: "compaction", aggregate: true, provider: null, model: null,
    price: { status: "unpriced", reason: "missing-attribution" } })], {
    coverageEdges: [{ reportRunId: "R", includedRunId: "N", evidence: "transcript" }] }));
  expect(db().prepare("SELECT SUM(input) AS input FROM counted_calls").get()).toEqual({ input: 20 });
  expect(ledger.summarize(0, 200)).toEqual({ aic: 20, pricedCalls: 1, unpricedCalls: 0, estimated: false, possibleUndercount: false });
});

// A mid-file cursor or selected nonterminal detail is incomplete, not a retained report alone.
it("marks a known mid-file import estimated even without a report or run", () => {
  ledger.apply(batch([call("partial", 10, { runId: null })], { states: [{ path: "R.jsonl", inode: "fixture",
    size: 100, offset: 50, mtimeMs: 100, parseErrors: 0, generation: 0, prefixHash: "fixture" }] }));
  expect(ledger.summarize(0, 200).estimated).toBe(true);
  ledger.apply(batch([], { states: [{ path: "R.jsonl", inode: "fixture", size: 100, offset: 100,
    mtimeMs: 100, parseErrors: 0, generation: 0, prefixHash: "fixture" }] }));
  expect(ledger.summarize(0, 200).estimated).toBe(false);
});
it("marks an empty period estimated while a source is known to be mid-file", () => {
  ledger.apply(batch([], { states: [{ path: "partial.jsonl", inode: "fixture", size: 100, offset: 50,
    mtimeMs: 100, parseErrors: 0, generation: 0, prefixHash: "fixture" }] }));
  expect(ledger.summarize(0, 200)).toMatchObject({ aic: 0, estimated: true });
});
it("marks partial cursors and nonterminal detail without flagging unrelated periods", () => {
  ledger.apply(batch([report("R", 40), call("one-of-four", 10)], { runs: [{ id: "R", dbPath: "runs.db",
    project: null, repo: null, sessionId: "R", parentRunId: null, agent: null, role: null, name: null,
    model: null, thinking: null, phase: null, startedAt: 0, endedAt: 150 }],
    states: [{ path: "R.jsonl", inode: "fixture", size: 100, offset: 50, mtimeMs: 100,
      parseErrors: 0, generation: 0, prefixHash: "fixture" }] }));
  expect(ledger.summarize(0, 200)).toMatchObject({ aic: 10, estimated: true });
  expect(ledger.summarize(200, 300).estimated).toBe(true);
  ledger.apply(batch([], { states: [{ path: "R.jsonl", inode: "fixture", size: 100, offset: 100, mtimeMs: 100,
    parseErrors: 0, generation: 0, prefixHash: "fixture" }] }));
  expect(ledger.summarize(0, 200).estimated).toBe(false);
  const [run] = ledger.getRuns();
  ledger.apply(batch([], { runs: [{ ...run!, endedAt: null }] }));
  expect(ledger.summarize(0, 200)).toMatchObject({ aic: 10, estimated: true, possibleUndercount: true });
  expect(ledger.summarize(200, 300)).toMatchObject({ aic: 0, estimated: false });
});

// M12/X7: a native nested report in a multiply owned source proves no owner.
it("does not infer an owner for a nested report in a shared transcript", () => {
  ledger.apply(batch([report("A", 10),
    call("b", 10, { runId: "B", sourceFile: "shared.jsonl", parentRunId: "A" }),
    call("c", 10, { runId: "C", sourceFile: "shared.jsonl" }),
    report("N", 10, { sourceFile: "shared.jsonl" })]));
  expect(ledger.summarize(0, 200).aic).toBe(40);
  expect(db().prepare("SELECT report_run_id, included_run_id FROM usage_possible_overlaps").all()).toEqual([
    { report_run_id: "A", included_run_id: "B" }]);
  expect(db().prepare("SELECT possible_overlap FROM counted_calls WHERE id='report-N'").get()).toEqual({ possible_overlap: 0 });
});
