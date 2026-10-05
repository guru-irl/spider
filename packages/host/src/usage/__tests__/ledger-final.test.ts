import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDbReadOnly, type Db } from "@spider/db-core";
import { COPILOT_RATE_VERSIONS } from "../rates.js";
import { openUsageLedger, type CallRow, type ImportBatch, type RunMeta, type UsageLedger } from "../ledger.js";

let root: string, file: string, ledger: UsageLedger;
const readers: Db[] = [];
function call(id: string, value = 20, overrides: Partial<CallRow> = {}): CallRow {
  return { id, entryId: id, ts: 100, sourceFile: "R.jsonl", sourceGeneration: 0,
    project: null, repo: null, sessionId: "R", runId: "R", actor: "subagent", role: null,
    agent: null, runName: null, phase: null, parentRunId: null, auxPurpose: null,
    provider: "github-copilot", model: "claude-opus-5.5", requestedModel: null, thinking: null, api: null,
    usage: { input: value, output: 0, cacheRead: 0, cacheWrite: 0 },
    price: { status: "priced", aic: value, components: { input: value, output: 0, cacheRead: 0, cacheWrite: 0 },
      rateVersion: "fixture", tier: "default", confidence: "verified" },
    piCost: null, latencyMs: null, aggregate: false, counted: true, originKey: null,
    sourceKind: "transcript", ...overrides };
}
function report(overrides: Partial<CallRow> = {}): CallRow {
  return call("report", 20, { sourceFile: "parent.jsonl", aggregate: true, sourceKind: "report", ...overrides });
}
function run(endedAt: number | null = 150): RunMeta {
  return { id: "R", dbPath: "runs.db", project: null, repo: null, sessionId: "R", parentRunId: null,
    agent: null, role: null, name: null, model: null, thinking: null, phase: null, startedAt: 0, endedAt };
}
function batch(calls: readonly CallRow[] = [], overrides: Partial<ImportBatch> = {}): ImportBatch {
  return { calls, runs: [], states: [], detailedRunIds: [], restoreAggregateRunIds: [], resetSources: [],
    sourceErrors: [], at: 1000, ...overrides };
}
const state = { path: "R.jsonl", inode: "fixture", size: 100, offset: 100, mtimeMs: 100,
  parseErrors: 0, generation: 0, prefixHash: "fixture" };
beforeEach(() => {
  root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "usage-final-"));
  file = join(root, "usage.db"); ledger = openUsageLedger(file);
});
afterEach(() => { readers.splice(0).forEach(db => db.close()); ledger.close(); rmSync(root, { recursive: true, force: true }); });

// M14: reports, summary/aux actors and price uncertainty must not saturate completeness.
it.each(["transcript", "report", "compaction", "unpriced", "estimated-price"])("does not flag a complete import (%s)", kind => {
  const own = kind === "report" ? report() : call("own", 20, kind === "compaction"
    ? { actor: "compaction", aggregate: true }
    : kind === "unpriced" ? { price: { status: "unpriced", reason: "unknown-model" } }
    : kind === "estimated-price" ? { price: { status: "priced", aic: 20,
      components: { input: 20, output: 0, cacheRead: 0, cacheWrite: 0 }, rateVersion: "fixture", tier: "default", confidence: "estimated" } } : {});
  ledger.apply(batch(kind === "transcript" ? [report(), own] : [own], { states: [state], runs: [run()] }));
  expect(ledger.summarize(0, 200)).toMatchObject({ estimated: false, possibleUndercount: false });
});
it("flags a mid-file cursor separately, including an empty period, and clears at EOF", () => {
  ledger.apply(batch([call("own")], { states: [{ ...state, offset: 50 }] }));
  expect(ledger.summarize(0, 200)).toMatchObject({ estimated: true, possibleUndercount: true });
  expect(ledger.summarize(200, 300)).toMatchObject({ estimated: true, possibleUndercount: true });
  ledger.apply(batch([], { states: [state] }));
  expect(ledger.summarize(0, 200)).toMatchObject({ estimated: false, possibleUndercount: false });
});
it.each(["transcript", "run-db-aux"] as const)("scopes a nonterminal %s run to periods containing its selected detail", sourceKind => {
  ledger.apply(batch([call("own", 20, { sourceKind, actor: sourceKind === "run-db-aux" ? "aux" : "subagent" })], { runs: [run(null)] }));
  expect(ledger.summarize(0, 200)).toMatchObject({ estimated: true, possibleUndercount: true });
  expect(ledger.summarize(200, 300)).toMatchObject({ estimated: false, possibleUndercount: false });
  ledger.apply(batch([], { runs: [run()] }));
  expect(ledger.summarize(0, 200)).toMatchObject({ estimated: false, possibleUndercount: false });
});
it("does not flag a nonterminal run whose only selected source is its report", () => {
  ledger.apply(batch([report()], { runs: [run(null)] }));
  expect(ledger.summarize(0, 200)).toMatchObject({ estimated: false, possibleUndercount: false });
});
it("does not flag nonterminal detail covered by a selected outer report", () => {
  ledger.apply(batch([report({ runId: "outer" }), call("own")], { runs: [run(null)],
    coverageEdges: [{ reportRunId: "outer", includedRunId: "R", evidence: "runs-db" }] }));
  expect(ledger.summarize(0, 200)).toMatchObject({ aic: 20, estimated: false, possibleUndercount: false });
});

// M18: invalid labels must fail before calls/cursors/proof can advance.
it.each([undefined, "unknown", "report"])("rejects a missing, unknown or mismatched detail sourceKind (%s)", sourceKind => {
  const bad = { ...call("bad"), sourceKind } as unknown as CallRow;
  expect(() => ledger.apply(batch([call("good"), bad], { states: [state], runs: [run()] }))).toThrow(/sourceKind/i);
  expect(ledger.health().calls).toBe(0);
  expect(ledger.getRuns()).toEqual([]);
  expect(ledger.getImportState(state.path)).toBeUndefined();
});
it("rejects a report labelled transcript", () => {
  expect(() => ledger.apply(batch([report({ sourceKind: "transcript" })]))).toThrow(/sourceKind/i);
});

// M19/Y5: reuse probe-window, with only the included run inside the queried period.
it.each(["unknown-edge", "parent-metadata"])("flags included detail when its outside-period report is hinted by %s", hint => {
  ledger.apply(batch([report({ ts: 500 }), call("nested", 10, { runId: "N", sourceFile: "N.jsonl" })], {
    runs: hint === "parent-metadata" ? [{ ...run(), id: "N", parentRunId: "R" }] : [],
    coverageEdges: hint === "unknown-edge" ? [{ reportRunId: "R", includedRunId: "N", evidence: "unknown" }] : [] }));
  expect(ledger.summarize(0, 200)).toMatchObject({ aic: 10, estimated: true, possibleOverlap: true, possibleUndercount: false });
  expect(ledger.summarize(200, 1000)).toMatchObject({ aic: 20, estimated: true, possibleOverlap: true });
});

it("maintains overlap adjacency and totals atomically across multi-source resets", () => {
  const a = { ...state, path: "one.jsonl" }, b = { ...state, path: "two.jsonl" };
  ledger.apply(batch([report(), call("one", 10, { runId: "N", parentRunId: "R", sourceFile: a.path }),
    call("two", 10, { runId: "N", parentRunId: "R", sourceFile: b.path })], { states: [a, b] }));
  expect(ledger.health()).toMatchObject({ calls: 3, possibleOverlaps: 1 });
  const reset = (s: typeof state): Partial<ImportBatch> => ({
    resetSources: [{ path: s.path, generation: 1 }], states: [{ ...s, generation: 1 }] });
  expect(() => ledger.apply(batch([call("bad", 1, { actor: "invalid" as CallRow["actor"] })], reset(a)))).toThrow();
  expect(ledger.health()).toMatchObject({ calls: 3, possibleOverlaps: 1 });
  ledger.apply(batch([], reset(a)));
  expect(ledger.health()).toMatchObject({ calls: 2, possibleOverlaps: 1 });
  ledger.apply(batch([], reset(b)));
  expect(ledger.health().calls).toBe(1);
  expect(ledger.health().possibleOverlaps ?? 0).toBe(0);
  expect(ledger.summarize(0, 200)).toMatchObject({ aic: 20, estimated: false });
  ledger.close(); ledger = openUsageLedger(file);
  expect(ledger.health().calls).toBe(1);
});

// Alias drift: model+fingerprint must be rebuilt from raw ids when rates change.
it("recanonicalizes stored aliases on reopen, reducing 40 to 20 without repricing", () => {
  const model = COPILOT_RATE_VERSIONS[0]!.models.find(m => m.id === "claude-opus-5.5")!;
  const aliases = model.aliases as string[], saved = [...aliases];
  try {
    aliases.splice(0, aliases.length);
    ledger.close(); ledger = openUsageLedger(file);
    ledger.apply(batch([report({ model: "claude-opus-5-5" }),
      report({ id: "copy", entryId: "copy", sourceFile: "fork.jsonl", copied: true })]));
    expect(ledger.summarize(0, 200).aic).toBe(40);
    ledger.close(); aliases.push(...saved); ledger = openUsageLedger(file);
    expect(ledger.summarize(0, 200).aic).toBe(20);
    const db = openDbReadOnly(file)!; readers.push(db);
    expect(db.prepare("SELECT model, raw_model, aic FROM calls WHERE id='report'").get()).toEqual({
      model: "claude-opus-5.5", raw_model: "claude-opus-5-5", aic: 20 });
    ledger.close(); ledger = openUsageLedger(file);
    expect(ledger.summarize(0, 200).aic).toBe(20);
  } finally { aliases.splice(0, aliases.length, ...saved); }
});
