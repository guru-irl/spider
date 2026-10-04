import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDbReadOnly } from "@spider/db-core";
import { countedUsageSql } from "../schema.js";
import { openUsageLedger, type CallRow, type CoverageEdge, type ImportBatch } from "../ledger.js";

function call(id: string, overrides: Partial<CallRow> = {}): CallRow {
  return { id, entryId: id, ts: 100, sourceFile: "parent.jsonl", sourceGeneration: 0, project: null, repo: null,
    sessionId: "parent", runId: null, actor: "parent", role: null, agent: null, runName: null, phase: null,
    parentRunId: null, auxPurpose: null, provider: "fixture", model: "fixture", requestedModel: null, thinking: null,
    api: null, usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
    price: { status: "priced", aic: 1, components: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      rateVersion: "fixture", tier: "default", confidence: "verified" }, piCost: null, latencyMs: null,
    aggregate: false, counted: true, originKey: null,
    sourceKind: overrides.actor === "subagent" && overrides.aggregate && overrides.runId != null ? "report" : "transcript", ...overrides };
}
function batch(calls: readonly CallRow[], coverageEdges: readonly CoverageEdge[] = []): ImportBatch {
  return { calls, runs: [], states: [], detailedRunIds: [], restoreAggregateRunIds: [], resetSources: [], sourceErrors: [], at: 1000, coverageEdges };
}

// The missing outer reports exercise read-time recursive exclusion as well as the
// 500-run parent tail that formerly fanned out to all session runs under the lock.
it("meets the 500-run, 20000-row write and total-query budgets", () => {
  const root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "usage-perf-"));
  const file = join(root, "usage.db"), ledger = openUsageLedger(file);
  const db = openDbReadOnly(file)!;
  try {
    const calls: CallRow[] = [], edges: CoverageEdge[] = [];
    for (let r = 0; r < 500; r++) {
      calls.push(call(`report-${r}`, { runId: `R${r}`, actor: "subagent", aggregate: true,
        parentRunId: r % 2 ? `R${r - 1}` : null }));
      if (r % 2) edges.push({ reportRunId: `R${r - 1}`, includedRunId: `R${r}`, evidence: "runs-db" });
      if (r % 2) for (let d = 0; d < 70; d++) calls.push(call(`R${r}-${d}`, {
        runId: `R${r}`, parentRunId: `R${r - 1}`, sourceFile: `R${r}.jsonl`, sessionId: `R${r}`, actor: "subagent" }));
    }
    for (let n = 0; n < 2000; n++) calls.push(call(`parent-${n}`));
    expect(calls).toHaveLength(20000);
    for (let n = 0; n < calls.length; n += 1000) ledger.apply(batch(calls.slice(n, n + 1000), n === 0 ? edges : []));
    expect(ledger.health().calls).toBe(20000);
    const startBatch = performance.now();
    ledger.apply(batch(Array.from({ length: 1000 }, (_, n) => call(`batch-${n}`))));
    const batchMs = performance.now() - startBatch;
    const startAppend = performance.now(); ledger.apply(batch([call("tail")]));
    const appendMs = performance.now() - startAppend;
    const startSession = performance.now();
    const session = db.prepare(`SELECT SUM(aic) AS aic, MAX(possible_overlap) AS overlap FROM (${countedUsageSql("c.session_id=? AND c.ts>=? AND c.ts<?", "c.aic, c.run_id, c.is_report, c.source_file, c.source_kind", "calls_session_read")})`).get("parent", 0, 200);
    const sessionMs = performance.now() - startSession;
    const startMonth = performance.now(); const month = ledger.summarize(0, 200);
    const monthMs = performance.now() - startMonth;
    console.log("LEDGER_PERF", JSON.stringify({ runs: 500, initialRows: 20000, batchRows: 1000, batchMs, appendMs, sessionMs, monthMs }));
    expect(session).toEqual({ aic: 3251, overlap: 0 }); // 3001 parent calls + 250 outer reports.
    expect(month.aic).toBe(3251);
    expect(batchMs).toBeLessThan(300);
    expect(appendMs).toBeLessThan(20);
    expect(sessionMs).toBeLessThan(200);
    expect(monthMs).toBeLessThan(200);
  } finally { db.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); }
}, 120000);

// Reuses the reviewer's probe-perf2 shape: 4,000 runs, 200 calls/run,
// 50 parent calls/run, missing every eighth transcript, over twelve months.
it("bounds month and session reads with overlap at 904000 all-time rows", () => {
  const root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "usage-year-perf-"));
  const file = join(root, "usage.db"), ledger = openUsageLedger(file), db = openDbReadOnly(file)!;
  try {
    let pending: CallRow[] = [];
    let runs: ImportBatch["runs"][number][] = [];
    for (let r = 0; r < 4000; r++) {
      const ts = 1000 * (r % 12), parentRunId = r % 4 ? `R${r - r % 4}` : null;
      const calls = r % 8 === 0 ? [] : Array.from({ length: 200 }, (_, n) => call(`c${r}-${n}`, {
        ts: ts + 10, runId: `R${r}`, actor: "subagent", parentRunId,
        sourceFile: `child${r}.jsonl`, sessionId: `child${r}` }));
      calls.push(call(`rep${r}`, { ts: ts + 20, runId: `R${r}`, actor: "subagent", aggregate: true,
        sourceFile: `parent${r % 12}.jsonl`, sessionId: `parent${r % 12}`,
        usage: { input: 200, output: 0, cacheRead: 0, cacheWrite: 0 },
        price: { status: "priced", aic: 200, components: { input: 200, output: 0, cacheRead: 0, cacheWrite: 0 },
          rateVersion: "fixture", tier: "default", confidence: "verified" } }));
      calls.push(...Array.from({ length: 50 }, (_, n) => call(`p${r}-${n}`, {
        ts: ts + 5, sourceFile: `parent${r % 12}.jsonl`, sessionId: `parent${r % 12}` })));
      pending.push(...calls);
      runs.push({ id: `R${r}`, dbPath: "fixture.db", project: null, repo: null, sessionId: `child${r}`,
        parentRunId, agent: null, role: null, name: null, model: null, thinking: null, phase: null,
        startedAt: ts, endedAt: ts + 30 });
      if (r % 10 === 9) { ledger.apply({ ...batch(pending), runs }); pending = []; runs = []; }
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM calls").get()).toEqual({ n: 904000 });
    const monthTimes: number[] = [];
    let summary = ledger.summarize(0, 1000);
    for (let month = 0; month < 12; month++) {
      const startMonth = performance.now();
      const current = ledger.summarize(month * 1000, (month + 1) * 1000);
      monthTimes.push(performance.now() - startMonth);
      if (month === 0) summary = current;
      const runCount = Math.floor((3999 - month) / 12) + 1;
      expect(current.aic).toBe(runCount * 250);
    }
    const startHealth = performance.now(); const health = ledger.health();
    const healthMs = performance.now() - startHealth;
    const startSession = performance.now();
    const session = db.prepare(`SELECT SUM(aic) AS aic, MAX(possible_overlap) AS overlap FROM (${countedUsageSql("c.session_id=? AND c.ts>=? AND c.ts<?", "c.aic, c.run_id, c.is_report, c.source_file, c.source_kind", "calls_session_read")})`)
      .get("parent0", 0, 1000);
    const sessionMs = performance.now() - startSession;
    console.log("LEDGER_YEAR_PERF", JSON.stringify({ rows: 904000, months: 12, monthTimes, worstMonthMs: Math.max(...monthTimes), sessionMs, healthMs }));
    expect(health.calls).toBe(904000);
    expect(healthMs).toBeLessThan(50);
    expect(summary.aic).toBe(83500); expect(summary.possibleOverlap).toBe(true);
    expect(session).toEqual({ aic: 50100, overlap: 1 });
    expect(Math.max(...monthTimes)).toBeLessThan(250); expect(sessionMs).toBeLessThan(200);
  } finally { db.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); }
}, 300000);
