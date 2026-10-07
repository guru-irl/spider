import { queryOverview as referenceOverview } from "./fixtures/overview-v2-frozen.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH, DASHBOARD_NOW } from "./fixtures/dashboard-ledger.js";
import { countedUsageSql } from "../schema.js";
import { openDashboardReader } from "../dashboard-reader.js";
import { queryOverview } from "../query-overview.js";

let fixture: ReturnType<typeof createDashboardFixture>;
beforeEach(() => { fixture = createDashboardFixture(); });
afterEach(() => { fixture.close(); });

it("stored selection is byte identical to dynamic selection through randomized ledger mutations", () => {
  let state = 0x10203040;
  const random = (n: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
  let reader = openDashboardReader(fixture.file, { instanceId: "synthetic", serverBuild: "synthetic", now: () => DASHBOARD_NOW, calibrationMode: () => "off" })!;
  let comparisons = 0;
  try {
    for (let seed = 0; seed < 24; seed++) {
      if (seed > 0) {
        reader.close(); fixture.close(); fixture = createDashboardFixture();
        reader = openDashboardReader(fixture.file, { instanceId: "synthetic", serverBuild: "synthetic", now: () => DASHBOARD_NOW, calibrationMode: () => "off" })!;
      }
      const calls = Array.from({ length: 80 }, (_, i) => {
        const report = i % 13 === 0;
        return dashboardCall(`random-${seed}-${i}`, { sourceFile: `source-${seed}-${i % 4}`, copied: i % 9 === 1,
          responseId: report ? null : `response-${seed}-${Math.floor(i / 3)}`, runId: `run-${seed}-${i % 12}`,
          parentRunId: i % 7 === 0 ? `run-${seed}-0` : null,
          ts: DASHBOARD_MONTH + random(DASHBOARD_NOW - DASHBOARD_MONTH), counted: Boolean(random(2)),
          actor: report ? "subagent" : "parent",
          aggregate: report, sourceKind: report ? "report" : "transcript", role: random(3) ? `role-${random(9)}` : null,
          model: `model-${random(3)}`,
        });
      });
      // Choose nonreport actors separately to keep the typed fixture explicit.
      for (const call of calls) if (!call.aggregate) call.actor = (["parent", "aux", "compaction"] as const)[random(3)]!;
      fixture.ledger.apply(dashboardBatch(calls, {
        runs: Array.from({ length: 12 }, (_, i) => ({ id: `run-${seed}-${i}`, dbPath: "synthetic",
          project: null, repo: null, sessionId: null, parentRunId: i % 3 ? `run-${seed}-0` : null,
          agent: null, role: null, name: null, model: null, thinking: null, phase: null, startedAt: null, endedAt: i % 4 ? DASHBOARD_NOW : null })),
        coverageEdges: Array.from({ length: 5 }, (_, i) => ({ reportRunId: `run-${seed}-${i}`, includedRunId: `run-${seed}-${i + 1}`,
          evidence: (["unknown", "transcript", "runs-db"] as const)[random(3)]! })),
        states: Array.from({ length: 4 }, (_, i) => ({ path: `source-${seed}-${i}`, inode: "synthetic", size: 100,
          offset: i % 2 ? 90 : 100, mtimeMs: 1, parseErrors: 0, generation: 0, prefixHash: "synthetic" })),
        incompleteReports: [{ path: `source-${seed}-0`, runId: `run-${seed}-0` }],
        pendingReports: [{ path: `pending-${seed}`, runId: `pending-${seed}`, generation: 0, firstSeen: 1, calls: [] }],
      }));
      fixture.ledger.insertCounter({ ts: DASHBOARD_NOW - 100, creditsUsed: 1.9876543, raw: {} });
      const compare = () => {
        for (const predicate of ["c.ts>=? AND c.ts<?", "c.ts>=? AND c.ts<? AND c.role='role-1'", "c.ts>=? AND c.ts<? AND c.session_id='parent-session'"]) {
          const params = [DASHBOARD_MONTH, DASHBOARD_NOW];
          const stored = fixture.db.prepare(`SELECT * FROM (${countedUsageSql(predicate, "c.*", "calls_period_read", true)}) ORDER BY id`).all(...params);
          const dynamic = fixture.db.prepare(`SELECT * FROM (${countedUsageSql(predicate, "c.*", "calls_period_read", false)}) ORDER BY id`).all(...params);
          expect(JSON.stringify(stored), `seed ${seed} comparison ${comparisons}`).toBe(JSON.stringify(dynamic)); comparisons++;
        }
        reader.snapshot(ctx => {
          const slice = { start: DASHBOARD_MONTH, end: DASHBOARD_NOW, filters: [] };
          compareOverview(queryOverview(ctx, slice), referenceOverview(ctx, slice));
          comparisons++;
        });
      };
      compare();
      fixture.db.prepare("DELETE FROM calls WHERE id=?").run(calls[0]!.id); compare();
      fixture.ledger.apply(dashboardBatch([calls[0]!])); compare();
      fixture.db.prepare("UPDATE calls SET copied=1-copied,counted=1-counted WHERE id=?").run(calls[3]!.id); compare();
      fixture.db.prepare("UPDATE calls SET fingerprint=?,source_file=?,entry_id=? WHERE id=?").run(`new-${seed}`, `moved-${seed}`, "moved", calls[4]!.id); compare();
      fixture.db.prepare("UPDATE import_state SET offset=size WHERE path=?").run(`source-${seed}-1`);
      fixture.db.prepare("UPDATE runs_meta SET ended_at=? WHERE id=?").run(DASHBOARD_NOW, `run-${seed}-0`);
      fixture.db.prepare("DELETE FROM coverage_edges WHERE report_run_id=?").run(`run-${seed}-0`); compare();
    }
    expect(comparisons).toBe(576);
  } finally { reader.close(); }
});

it("Overview selection does not materialize unused raw provenance columns", () => {
  const reader = openDashboardReader(fixture.file, { instanceId: "synthetic", serverBuild: "synthetic", now: () => DASHBOARD_NOW, calibrationMode: () => "off" })!;
  const original = fixture.db.prepare.bind(fixture.db);
  let statement = "";
  const spy = vi.spyOn(fixture.db, "prepare").mockImplementation(sql => { if (sql.startsWith("WITH counted AS MATERIALIZED")) statement = sql; return original(sql); });
  try {
    reader.snapshot(ctx => queryOverview({ ...ctx, db: fixture.db }, { start: DASHBOARD_MONTH, end: DASHBOARD_NOW, filters: [] }));
    spy.mockRestore();
    const code = original(`EXPLAIN ${statement}`).all(DASHBOARD_MONTH, DASHBOARD_NOW, DASHBOARD_MONTH, DASHBOARD_NOW) as
      { opcode: string; p1: number; p2: number }[];
    const tableRoot = (original("SELECT rootpage FROM sqlite_master WHERE name='calls'").get() as { rootpage: number }).rootpage;
    const tableCursors = new Set(code.filter(op => op.opcode === "OpenRead" && op.p2 === tableRoot).map(op => op.p1));
    const rawModelColumn = (original("PRAGMA table_info(calls)").all() as { cid: number; name: string }[]).find(c => c.name === "raw_model")!.cid;
    expect(code.some(op => op.opcode === "Column" && tableCursors.has(op.p1) && op.p2 === rawModelColumn)).toBe(false);
  } finally { spy.mockRestore(); reader.close(); }
});

it("v3 bounded selection has no per-call fingerprint or completeness probes", () => {
  fixture.ledger.apply(dashboardBatch([dashboardCall("extra")]));
  const plan = fixture.db.prepare(`EXPLAIN QUERY PLAN ${countedUsageSql("c.ts>=? AND c.ts<?", "c.*", "calls_period_read", true)}`)
    .all(0, 9e15) as { detail: string }[];
  expect(plan.some(row => /prior.*calls_fingerprint/.test(row.detail)), JSON.stringify(plan)).toBe(false);
  expect(plan.some(row => /sqlite_autoindex_(import_state|incomplete_reports)_1|runs_meta_nonterminal/.test(row.detail)), JSON.stringify(plan)).toBe(false);
});

/** Counts/tokens and shape stay exact; only Overview AIC sum order is relaxed. */
function compareOverview(actual: unknown, expected: unknown, path = ""): void {
  if (typeof actual === "number" && typeof expected === "number" && /aic|\.comparison\.(gap|ratio)$/i.test(path)) {
    expect(Math.abs(actual - expected), path).toBeLessThanOrEqual(1e-6);
  } else if (actual !== null && expected !== null && typeof actual === "object" && typeof expected === "object") {
    expect(Object.keys(actual), path).toEqual(Object.keys(expected));
    for (const key of Object.keys(actual)) compareOverview((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${path}.${key}`);
  } else expect(actual, path).toEqual(expected);
}
