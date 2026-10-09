import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDbReadOnly, type Db } from "@spider/db-core";
import { openUsageLedger, type CallRow, type ImportBatch, type RunMeta, type UsageLedger } from "../ledger.js";

type Fact = CallRow;
type Edge = { reportRunId: string; includedRunId: string; evidence: "transcript" | "runs-db" | "unknown" };
type EdgeKey = Pick<Edge, "reportRunId" | "includedRunId">;
function edge(reportRunId: string, includedRunId: string, evidence: Edge["evidence"] = "transcript"): Edge {
  return { reportRunId, includedRunId, evidence };
}
let root: string, file: string, ledger: UsageLedger;
const readers: Db[] = [];
function row(id: string, overrides: Partial<Fact> = {}): Fact {
  return { id, entryId: id, sourceFile: "parent.jsonl", sourceGeneration: 0, ts: 100,
    project: null, repo: null, sessionId: "parent", runId: null, actor: "parent", role: null,
    agent: null, runName: null, phase: null, parentRunId: null, auxPurpose: null,
    provider: "fixture-provider", model: "fixture-model", requestedModel: null, thinking: null, api: null,
    usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
    price: { status: "priced", aic: 10, components: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
      rateVersion: "fixture", tier: "default", confidence: "verified" },
    piCost: null, latencyMs: null, aggregate: false, counted: true, originKey: null,
    sourceKind: overrides.actor === "subagent" && overrides.aggregate && overrides.runId != null ? "report" : "transcript", ...overrides };
}
function report(id: string, aic: number, overrides: Partial<Fact> = {}): Fact {
  return row(`report-${id}`, { runId: id, actor: "subagent", aggregate: true,
    price: { status: "priced", aic, components: { input: aic, output: 0, cacheRead: 0, cacheWrite: 0 },
      rateVersion: "fixture", tier: "default", confidence: "verified" }, ...overrides });
}
function detail(id: string, runId: string, overrides: Partial<Fact> = {}): Fact {
  return row(id, { runId, sourceFile: `${runId}.jsonl`, sessionId: runId, actor: "subagent", ...overrides });
}
function batch(calls: readonly Fact[] = [], overrides: Partial<ImportBatch> & { coverageEdges?: readonly Edge[]; removeCoverageEdges?: readonly EdgeKey[] } = {}): ImportBatch {
  return { calls, runs: [], states: [], detailedRunIds: [], restoreAggregateRunIds: [], resetSources: [],
    sourceErrors: [], at: 1000, ...overrides };
}
function meta(id: string, parentRunId: string | null): RunMeta {
  return { id, parentRunId, dbPath: "fixture.db", project: null, repo: null, sessionId: null,
    agent: null, role: null, name: null, model: null, thinking: null, phase: null, startedAt: null, endedAt: null };
}
function selected(): string[] {
  const db = readers[0] ?? openDbReadOnly(file)!;
  if (!readers.length) readers.push(db);
  return (db.prepare("SELECT id FROM counted_calls ORDER BY id").all() as { id: string }[]).map(r => r.id);
}
function total(): number { return ledger.summarize(0, 200).aic; }
beforeEach(() => {
  root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "usage-counting-"));
  file = join(root, "usage.db"); ledger = openUsageLedger(file);
});
afterEach(() => {
  for (const db of readers.splice(0)) db.close();
  ledger.close(); rmSync(root, { recursive: true, force: true });
});

describe("read-time usage selection", () => {
  // I1/I3: summaries are detail, and obsolete restore signals cannot hide retained facts.
  it.each(["compaction", "branch-summary", "nested-report"])("keeps I1/I3 at 20 after restore with %s", kind => {
    const covered = kind === "nested-report" ? report("N", 10, { sourceFile: "R.jsonl" }) :
      detail("summary", "R", { actor: kind === "compaction" ? "compaction" : "aux", aggregate: true });
    ledger.apply(batch([report("R", 20)]));
    ledger.apply(batch([detail("own", "R"), covered]));
    expect(total()).toBe(20);
    ledger.apply(batch([], { restoreAggregateRunIds: ["R"] }));
    expect(total()).toBe(20);
    expect(selected()).toEqual(["own", kind === "nested-report" ? "report-N" : "summary"]);
  });

  // I4/N5/N3r: descendant evidence never displaces an absent ancestor transcript.
  it.each(["call", "metadata"])("keeps a missing outer transcript at 40 with %s ancestry", link => {
    ledger.apply(batch([report("R", 40), report("N", 30, { parentRunId: "R" })], { coverageEdges: [edge("R", "N", "runs-db")] }));
    for (let n = 0; n < 3; n++) {
      const d = detail(`d${n}`, "N", { parentRunId: link === "call" ? "R" : null,
        actor: n === 2 ? "compaction" : "subagent", aggregate: n === 2 });
      ledger.apply(batch([d, d], { detailedRunIds: ["N"], restoreAggregateRunIds: ["R"],
        runs: link === "metadata" ? [meta("N", "R")] : [] }));
      expect(total()).toBe(40);
    }
    ledger.apply(batch([report("R", 40), detail("d0", "N")], { restoreAggregateRunIds: ["R"] }));
    expect(total()).toBe(40);
    expect(selected()).toEqual(["report-R"]);
  });

  // Execution ancestry is metadata only. Missing/unknown proof must not lose usage.
  it.each(["none", "unknown"] as const)("counts both and flags possible overlap with %s evidence", evidence => {
    ledger.apply(batch([report("R", 10), detail("orphan", "N", { parentRunId: "R" })], {
      runs: [meta("N", "R")], coverageEdges: evidence === "unknown" ? [edge("R", "N", "unknown")] : [] }));
    expect(total()).toBe(20);
    expect(selected()).toEqual(["orphan", "report-R"]);
    expect(ledger.summarize(0, 200)).toMatchObject({ possibleOverlap: true, estimated: true });
    expect(ledger.health()).toMatchObject({ possibleOverlaps: 1 });
    const db = openDbReadOnly(file)!; readers.push(db);
    expect(db.prepare("SELECT report_run_id, included_run_id, evidence FROM usage_possible_overlaps").all()).toEqual([
      { report_run_id: "R", included_run_id: "N", evidence }]);
    expect(db.prepare("SELECT id, possible_overlap FROM counted_calls ORDER BY id").all()).toEqual([
      { id: "orphan", possible_overlap: 1 }, { id: "report-R", possible_overlap: 1 }]);
    expect(ledger.getRuns()).toEqual([{ ...meta("N", "R"), status: null }]);
  });

  // Only late explicit proof changes selection; later withdrawal restores raw detail.
  it.each(["transcript", "runs-db"] as const)("applies late %s evidence, withdrawals and unknown downgrades", evidence => {
    ledger.apply(batch([report("R", 20), detail("n", "N")]));
    expect(total()).toBe(30);
    ledger.apply(batch([], { runs: [meta("N", "R")] }));
    expect(total()).toBe(30);
    expect(ledger.summarize(0, 200)).toMatchObject({ possibleOverlap: true });
    ledger.apply(batch([], { coverageEdges: [edge("R", "N", evidence)] }));
    expect(total()).toBe(20);
    expect(selected()).toEqual(["report-R"]);
    expect(ledger.summarize(0, 200).possibleOverlap ?? false).toBe(false);
    ledger.apply(batch([], { removeCoverageEdges: [edge("R", "N")] }));
    expect(total()).toBe(30);
    expect(ledger.health()).toMatchObject({ possibleOverlaps: 1 });
    ledger.apply(batch([], { coverageEdges: [edge("R", "N", evidence)] }));
    expect(total()).toBe(20);
    ledger.apply(batch([], { coverageEdges: [edge("R", "N", "unknown")] }));
    expect(total()).toBe(30);
    expect(ledger.summarize(0, 200)).toMatchObject({ possibleOverlap: true });
  });

  // Explicit unknown proof flags a pair even when execution ancestry is absent.
  it("flags unknown edges without inventing coverage or needing ancestry", () => {
    ledger.apply(batch([report("R", 20), detail("n", "N")], { coverageEdges: [edge("R", "N", "unknown")] }));
    expect(total()).toBe(30);
    expect(ledger.health()).toMatchObject({ possibleOverlaps: 1 });
  });

  // L.0/N4.1: intent signals are inert; partial detail persists across offset resumes.
  it("retains partial own detail through early restore, late reports and resumed appends", () => {
    ledger.apply(batch([detail("first", "R")], { restoreAggregateRunIds: ["R"] }));
    ledger.apply(batch([report("R", 30)]));
    expect(total()).toBe(10);
    ledger.apply(batch([], { restoreAggregateRunIds: ["R"] }));
    ledger.apply(batch([detail("second", "R")]));
    expect(total()).toBe(20);
    ledger.apply(batch([detail("third", "R")]));
    expect(total()).toBe(30);
    expect(ledger.health().aggregateCalls).toBe(0);
  });

  // I5: inherited reports never make a sibling a descendant of the fork.
  it.each([false, true])("keeps fork siblings at 30 (copied parent link: %s)", parentLink => {
    const a = report("A", 20), b = report("B", 10);
    ledger.apply(batch([a, b, detail("a1", "A"), detail("a2", "A")]));
    const copied = { ...a, id: "fork-report", sourceFile: "B.jsonl", counted: false,
      copied: true, parentRunId: parentLink ? "B" : null };
    const inherited = detail("copy-a1", "B", { entryId: "a1", sourceFile: "B.jsonl", copied: true, counted: false });
    ledger.apply(batch([copied, inherited], { restoreAggregateRunIds: ["A", "B"] }));
    expect(total()).toBe(30); // B's fallback is still selected; copies cannot cover sibling A.
    expect(selected()).toEqual(["a1", "a2", "report-B"]);
    expect(ledger.summarize(0, 200).possibleOverlap ?? false).toBe(false);
    expect(ledger.health().possibleOverlaps ?? 0).toBe(0);
    ledger.apply(batch([detail("b1", "B")], { restoreAggregateRunIds: ["B"] }));
    expect(total()).toBe(30);
    ledger.apply(batch([], { restoreAggregateRunIds: ["B"] }));
    expect(total()).toBe(30);
    expect(selected()).toEqual(["a1", "a2", "b1"]);
  });

  // I13/G1: sibling reports in a parent source must not form ownership edges.
  it("counts both sibling reports in one restore batch", () => {
    ledger.apply(batch([report("A", 20), report("B", 20)], { restoreAggregateRunIds: ["A", "B"] }));
    expect(total()).toBe(40);
    expect(selected()).toEqual(["report-A", "report-B"]);
  });

  // I10/G3: ancestry alone does not suppress; an explicit edge does.
  it("uses an explicit included-run edge, never a call parentRunId, to suppress detail", () => {
    ledger.apply(batch([report("R", 10), detail("n", "N", { parentRunId: "R" })]));
    expect(total()).toBe(20);
    ledger.apply(batch([], { coverageEdges: [edge("R", "N")] }));
    expect(total()).toBe(10);
    expect(selected()).toEqual(["report-R"]);
  });

  // I03/G4: only proven edges may be traversed through multiple report levels.
  it("recurses through explicit nested-report evidence and flags a withdrawn edge", () => {
    ledger.apply(batch([report("R", 50), detail("n", "N", { parentRunId: "R" }),
      report("G", 20, { sourceFile: "N.jsonl" }), detail("g1", "G"), detail("g2", "G")],
      { coverageEdges: [edge("R", "N"), edge("N", "G")] }));
    expect(total()).toBe(50);
    expect(selected()).toEqual(["report-R"]);
    ledger.apply(batch([], { removeCoverageEdges: [edge("N", "G")] }));
    expect(total()).toBe(70);
    expect(ledger.summarize(0, 200)).toMatchObject({ possibleOverlap: true });
  });

  // Coverage proof is run-wide; per-model totals come from the report's own rows.
  it.each(["model", "provider"] as const)("covers a nested run regardless of its %s spelling", field => {
    const other = { [field]: "other" };
    ledger.apply(batch([report("R", 20), detail("n", "N", other)], { coverageEdges: [edge("R", "N")] }));
    expect(total()).toBe(20); // A proven edge covers all of N, not a string-matched subset.
    expect(ledger.summarize(0, 200).possibleOverlap ?? false).toBe(false);
    ledger.apply(batch([report("R", 40, { id: "other-report", entryId: "other-report", ...other })]));
    expect(total()).toBe(60);
    expect(selected()).toEqual(["other-report", "report-R"]);
  });

  it("excludes a different-model nested fallback report under run-wide proof", () => {
    ledger.apply(batch([report("R", 20), report("N", 10, { model: "other" })], { coverageEdges: [edge("R", "N")] }));
    expect(total()).toBe(20);
    expect(selected()).toEqual(["report-R"]);
    expect(ledger.summarize(0, 200).possibleOverlap ?? false).toBe(false);
  });

  // Edge writes and withdrawals share the same atomic cursor/call transaction.
  it("rolls back proof writes and withdrawals when another raw row is invalid", () => {
    ledger.apply(batch([report("R", 20), detail("n", "N", { parentRunId: "R" })]));
    const bad = row("bad", { actor: "invalid" as CallRow["actor"] });
    expect(() => ledger.apply(batch([bad], { coverageEdges: [edge("R", "N")] }))).toThrow();
    expect(total()).toBe(30);
    ledger.apply(batch([], { coverageEdges: [edge("R", "N")] }));
    expect(() => ledger.apply(batch([bad], { removeCoverageEdges: [edge("R", "N")] }))).toThrow();
    expect(total()).toBe(20);
    ledger.apply(batch([], { coverageEdges: [edge("R", "N", "unknown")], removeCoverageEdges: [edge("R", "N")] }));
    expect(total()).toBe(30); // remove then upsert: the new unknown evidence wins.
  });

  // M9/S2/S3: multiple native owners of one source are independent, not a source cycle.
  it.each([{ restores: ["A"] }, { restores: ["A", "B"] }])("keeps shared-transcript runs independent with restore $restores", ({ restores }) => {
    ledger.apply(batch([report("A", 10), report("B", 30),
      detail("a", "A", { sourceFile: "shared.jsonl" }), detail("b", "B", { sourceFile: "shared.jsonl" })]));
    ledger.apply(batch([], { restoreAggregateRunIds: restores }));
    expect(total()).toBe(20); // Partial detail is intentionally not filled by its report.
    expect(selected()).toEqual(["a", "b"]);
  });

  // Explicit malformed ancestry terminates and counts one deterministic SCC fallback.
  it("chooses one deterministic report for a genuine explicit-coverage cycle", () => {
    ledger.apply(batch([report("A", 20), report("B", 30)], { runs: [meta("A", "B"), meta("B", "A")], coverageEdges: [edge("A", "B"), edge("B", "A")] }));
    expect(total()).toBe(20);
    expect(selected()).toEqual(["report-A"]);
  });

  // Copies always count once, even when copied rows arrive before the native row.
  it.each([false, true])("deduplicates copied detail with preserved %s identity", response => {
    const native = detail("entry", "A", response ? { responseId: "response" } : {});
    const copy = { ...native, id: "copy", sourceFile: "B.jsonl", runId: "B", actor: "parent" as const,
      counted: false, copied: true, entryId: response ? "another-entry" : native.entryId };
    ledger.apply(batch([copy])); expect(total()).toBe(10);
    ledger.apply(batch([native, copy])); expect(total()).toBe(10);
    expect(selected()).toEqual(["entry"]);
    expect(ledger.health().calls).toBe(2);
  });

  // A dedup copy cannot escape the ancestor report that suppresses its native original.
  it("deduplicates before coverage selection so fork copies cannot escape a fallback", () => {
    const native = detail("native", "N", { parentRunId: "R", responseId: "response" });
    ledger.apply(batch([report("R", 40), native,
      { ...native, id: "copy", sourceFile: "fork.jsonl", runId: "fork", copied: true, parentRunId: null }],
      { coverageEdges: [edge("R", "N")] }));
    expect(total()).toBe(40);
    expect(selected()).toEqual(["report-R"]);
  });

  // Response ids are provider scoped; fallback hashes preserve tuple/timestamp distinctions.
  it("does not collapse unrelated response ids, timestamps or usage tuples", () => {
    ledger.apply(batch([row("a", { responseId: "same", provider: "one" }),
      row("b", { responseId: "same", provider: "two" }),
      row("c", { entryId: "fallback", sourceFile: "one", ts: 100 }),
      row("d", { entryId: "fallback", sourceFile: "two", ts: 101 }),
      row("e", { entryId: "fallback", sourceFile: "three", usage: { input: 11, output: 0, cacheRead: 0, cacheWrite: 0 } })]));
    expect(total()).toBe(50);
  });

  // Reports dedup by run/provider/model, not the fork's source, entry id or price.
  it("counts one report per run and model, preferring native provenance", () => {
    const native = report("R", 20), copy = report("R", 30, { id: "copy", entryId: "fork-entry", sourceFile: "fork", copied: true });
    ledger.apply(batch([copy, native, report("R", 10, { id: "other-model", entryId: "other-model", model: "other" })]));
    expect(total()).toBe(30);
    expect(ledger.health().aggregateCalls).toBe(2);
  });

  // Health uncertainty and aggregate counts use the same selection as totals.
  it("excludes covered unpriced descendants from health", () => {
    ledger.apply(batch([report("R", 40, { model: "unknown" }), detail("unknown", "N", { parentRunId: "R", model: "unknown",
      price: { status: "unpriced", reason: "unknown-model" } })], { coverageEdges: [edge("R", "N")] }));
    expect(ledger.health()).toMatchObject({ calls: 2, aggregateCalls: 1, unpricedBillingPeriod: { models: [], withoutModel: 0 } });
    expect(ledger.summarize(0, 200)).toEqual({ aic: 40, pricedCalls: 1, unpricedCalls: 0, estimated: false, possibleUndercount: false });
  });

  // Any own detail replaces the run's report, not just the same provider/model part.
  it("does not fill a partial transcript with a different-model report", () => {
    ledger.apply(batch([report("R", 20), report("R", 30, { id: "other", entryId: "other", model: "other" }), detail("own", "R")]));
    expect(total()).toBe(10);
    expect(ledger.health().aggregateCalls).toBe(0);
  });

  // Only removal of raw facts, not filesystem availability intent, restores fallback.
  it("reselects fallback after an atomic source reset removes all native detail", () => {
    const state = { path: "R.jsonl", inode: "fixture", size: 100, mtimeMs: 100, offset: 100,
      parseErrors: 0, generation: 0, prefixHash: "fixture" };
    ledger.apply(batch([report("R", 20), detail("own", "R")], { states: [state] }));
    expect(total()).toBe(10);
    ledger.apply(batch([], { resetSources: [{ path: state.path, generation: 1 }], states: [{ ...state, generation: 1, offset: 0 }] }));
    expect(total()).toBe(20);
    ledger.apply(batch([detail("own", "R", { sourceGeneration: 1 })]));
    expect(total()).toBe(10);
  });

  // Period filters must not change global fallback selection or provenance ranking.
  it("selects globally before filtering totals by time or session", () => {
    ledger.apply(batch([report("R", 40, { ts: 150 }), detail("own", "R", { ts: 90 }),
      row("native", { ts: 100, responseId: "r", sessionId: "original" }),
      row("copy", { ts: 100, responseId: "r", sourceFile: "fork", copied: true, sessionId: "fork" })]));
    expect(ledger.summarize(100, 200).aic).toBe(10);
    const db = openDbReadOnly(file)!; readers.push(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM counted_calls WHERE session_id='fork'").get()).toEqual({ n: 0 });
  });
});

// Conservation oracle: true billed calls are generated FIRST. Reports and all
// observations below are derived from those calls, not from ledger selection.
describe("ground-truth conservation under random imports", () => {
  it.each([7, 37, 101, 419, 12345])("conserves true calls or flags incomplete evidence (seed %i)", seedValue => {
    let seed = seedValue;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
    type TrueCall = { id: string; run: number; model: string; tokens: number; kind: "assistant" | "compaction" | "aux" };
    const truth: TrueCall[] = [];
    for (let r = 0; r < 7; r++) for (let n = 0; n < 4; n++) truth.push({
      id: `billed-${r}-${n}`, run: r, model: n % 2 ? "gpt-6.1-sol" : "claude-opus-5.5",
      tokens: 1 + random() % 29, kind: n === 2 ? "compaction" : n === 3 ? "aux" : "assistant" });
    const trueTotal = truth.reduce((sum, c) => sum + c.tokens, 0);
    const parent = (r: number) => r === 0 ? null : Math.floor((r - 1) / 2);
    const includes = (outer: number, inner: number): boolean => {
      for (let r: number | null = inner; r !== null; r = parent(r)) if (r === outer) return true;
      return false;
    };
    const priced = (value: number): Fact["price"] => ({ status: "priced", aic: value,
      components: { input: value, output: 0, cacheRead: 0, cacheWrite: 0 },
      rateVersion: "fixture", tier: "default", confidence: "verified" });
    const observations = truth.map(c => detail(c.id, `R${c.run}`, {
      provider: "github-copilot", model: c.kind === "compaction" ? null : c.model,
      actor: c.kind === "aux" ? "aux" : c.kind === "compaction" ? "compaction" : "subagent",
      aggregate: c.kind === "compaction", sourceKind: c.kind === "aux" ? "run-db-aux" : "transcript",
      sourceFile: c.kind === "aux" ? `R${c.run}.db` : `R${c.run}.jsonl`,
      usage: { input: c.tokens, output: 0, cacheRead: 0, cacheWrite: 0 }, price: priced(c.tokens),
      parentRunId: parent(c.run) === null ? null : `R${parent(c.run)}`,
      responseId: c.kind === "assistant" ? c.id : null }));
    // The report groups include own assistant/summary/DB-only aux and newly
    // appended nested reports. Fork history is NOT a new billed call.
    const reports: Fact[] = [];
    for (let r = 0; r < 7; r++) for (const model of ["claude-opus-5.5", "gpt-6.1-sol"]) {
      const sum = truth.filter(c => includes(r, c.run) && c.model === model).reduce((n, c) => n + c.tokens, 0);
      reports.push(report(`R${r}`, sum, { id: `report-${r}-${model}`, entryId: `report-${r}-${model}`,
        model: model === "claude-opus-5.5" ? "claude-opus-5-5" : model, provider: "github-copilot",
        sourceFile: parent(r) === null ? "parent.jsonl" : `R${parent(r)}.jsonl`,
        parentRunId: parent(r) === null ? null : `R${parent(r)}`,
        usage: { input: sum, output: 0, cacheRead: 0, cacheWrite: 0 }, price: priced(sum) }));
    }
    const proofs = Array.from({ length: 6 }, (_, n) => edge(`R${parent(n + 1)}`, `R${n + 1}`,
      random() % 2 ? "transcript" : "runs-db"));
    ledger.apply(batch(reports, { coverageEdges: proofs }));
    expect(total()).toBe(trueTotal);
    const ingested = new Set<string>();
    const order = Array.from({ length: 6 }, (_, r) => r + 1);
    for (let n = order.length - 1; n > 0; n--) {
      const j = random() % (n + 1); [order[n], order[j]] = [order[j]!, order[n]!];
    }
    order.push(0); // Keep the outer fallback until its children have started.
    const branches = { complete: 0, incomplete: 0, undercount: 0, overcount: 0 };
    for (let step = 0; step < 80; step++) {
      // Aux-only first kills Y1. Then begin each transcript and complete each
      // whole run without replacement. The tail replays/copies random facts.
      const incoming = step === 0 ? observations.filter(c => c.sourceKind === "run-db-aux")
        : step <= 7 ? [observations.find(c => c.runId === `R${order[step - 1]}` && c.sourceKind === "transcript")!]
        : step <= 14 ? observations.filter(c => c.runId === `R${order[step - 8]}`)
        : [observations[random() % observations.length]!];
      const copies = incoming.map(c => ({ ...c, id: `copy-${step}-${c.id}`, sourceFile: `fork-${step}.jsonl`, copied: true,
        parentRunId: random() % 2 ? "R0" : "R6", counted: false }));
      const uncertainty = step === 1 || step > 0 && step % 5 === 0;
      const proof = step === 1 ? proofs.find(p => p.includedRunId === incoming[0]!.runId)!
        : proofs[random() % proofs.length]!;
      incoming.forEach(c => ingested.add(c.id));
      // No mid-file cursor here: Y4 must fail on the per-row nonterminal signal,
      // rather than being rescued by the independent global cursor flag.
      const runs = Array.from(new Set(incoming.filter(c => c.sourceKind === "transcript").map(c => c.runId!))).map(id => ({
        ...meta(id, id === "R0" ? null : `R${parent(Number(id.slice(1)))}`),
        endedAt: observations.filter(c => c.runId === id).every(c => ingested.has(c.id)) ? 150 : null }));
      ledger.apply(batch([...copies, ...incoming, ...incoming], {
        runs, coverageEdges: uncertainty ? [{ ...proof, evidence: "unknown" }] : proofs }));
      const complete = observations.every(observed => {
        const own = observations.filter(other => other.runId === observed.runId);
        const transcriptStarted = own.some(other => other.sourceKind === "transcript" && ingested.has(other.id));
        return !transcriptStarted || own.every(other => ingested.has(other.id));
      });
      const summary = ledger.summarize(0, 200);
      if (complete && !uncertainty) {
        branches.complete++;
        expect(summary.aic, `complete seed ${seedValue}, step ${step}`).toBe(trueTotal);
        expect(summary.estimated, `complete flags seed ${seedValue}, step ${step}`).toBe(false);
      } else {
        branches.incomplete++;
        if (summary.aic !== trueTotal) expect(summary.estimated, `incomplete seed ${seedValue}, step ${step}`).toBe(true);
      }
      const missing = truth.filter(c => {
        const own = observations.filter(o => o.runId === `R${c.run}`);
        return own.some(o => o.sourceKind === "transcript" && ingested.has(o.id)) && !ingested.has(c.id);
      }).reduce((sum, c) => sum + c.tokens, 0);
      expect(summary.aic, `lower bound seed ${seedValue}, step ${step}`).toBeGreaterThanOrEqual(trueTotal - missing);
      if (summary.aic < trueTotal) {
        branches.undercount++;
        expect(summary.possibleUndercount, `undercount seed ${seedValue}, step ${step}`).toBe(true);
      }
      if (summary.aic > trueTotal) { branches.overcount++; expect(summary.possibleOverlap).toBe(true); }
    }
    expect(branches.complete, `complete branch seed ${seedValue}`).toBeGreaterThanOrEqual(24);
    expect(branches.complete).toBe(54);
    expect(branches.incomplete, `incomplete branch seed ${seedValue}`).toBe(26);
    expect(branches.undercount).toBeGreaterThan(0);
    expect(branches.overcount).toBeGreaterThan(0);
    console.log("LEDGER_ORACLE_BRANCHES", JSON.stringify({ seed: seedValue, ...branches }));
    expect(branches.complete + branches.incomplete).toBe(80);
    ledger.apply(batch(observations, { coverageEdges: proofs }));
    expect(total()).toBe(trueTotal);
    const db = openDbReadOnly(file)!; readers.push(db);
    expect(db.prepare("SELECT SUM(input) AS tokens FROM counted_calls").get()).toEqual({ tokens: trueTotal });
    expect(ledger.summarize(0, 200).possibleOverlap ?? false).toBe(false);
  });
});
