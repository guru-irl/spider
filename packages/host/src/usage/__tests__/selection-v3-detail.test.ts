import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "@spider/db-core";
import { createCalibrationService } from "../calibration.js";
import type { DashboardQueryContext } from "../dashboard-contract.js";
import { openDashboardReader } from "../dashboard-reader.js";
import { migrateUsageLedger, USAGE_MIGRATIONS } from "../migrate.js";
import { queryDetail, queryDetailLinks, type DetailQuery } from "../query-detail.js";
import { USAGE_LEASE_SCHEMA } from "../schema.js";
import { DASHBOARD_MONTH as M, DASHBOARD_DAY as D } from "./fixtures/dashboard-ledger.js";

let root: string, file: string, db: Db;
const slice = { start: M + 2 * D, end: M + 3 * D, filters: [] };
beforeEach(() => {
  root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "detail-selection-"));
  file = join(root, "ledger.db");
  db = openDb(file);
  for (const migration of USAGE_MIGRATIONS.filter(migration => migration.version <= 2)) db.exec(migration.sql);
  db.exec(USAGE_LEASE_SCHEMA);
  db.pragma("user_version=2");
  const insert = db.prepare(`INSERT INTO calls(id,ts,source_file,entry_id,source_generation,project,repo,session_id,run_id,
    actor,role,agent,run_name,phase,parent_run_id,aux_purpose,provider,model,requested_model,thinking,api,source_kind,
    input,cache_read,cache_write,output,cache_write_1h,reasoning,price_status,aic,aic_input,aic_cache_read,aic_cache_write,
    aic_output,pi_cost,latency_ms,aggregate,counted,copied,fingerprint,unpriced_reason,rate_version,tier,confidence)
    VALUES (@id,@ts,@source,@id,0,@project,@repo,@session,@run,'subagent','worker','detail-agent','Detail call','execute',
      @parent,'test-purpose','fixture-provider','fixture-model','requested-model','high','fixture-api',@kind,
      10,20,30,10,@cache1h,@reasoning,@status,@aic,@aic,@zero,@zero,@zero,@piCost,125,@report,1,@copied,@fingerprint,
      @unpricedReason,@rateVersion,@tier,@confidence)`);
  const calls: { id: string; ts?: number; source?: string; session?: string; run?: string | null;
    copied?: number; fingerprint?: string; report?: number; aic?: number | null; parent?: string }[] = [
    { id: "clean" },
    { id: "partial", source: "partial-source" },
    { id: "incomplete", run: "aggregate-run", source: "report-source", report: 1 },
    { id: "ongoing", run: "open-run" },
    { id: "unpriced", aic: null },
    { id: "zero", aic: 0 },
    { id: "hint", run: "hint-run", parent: "covering-run" },
    // Both canonical observations are outside the slice and the selected identity.
    { id: "native", ts: M, source: "a-native", session: "outside-session", run: "shadow-run", fingerprint: "copied-pair" },
    { id: "copy", source: "z-copy", copied: 1, fingerprint: "copied-pair" },
    { id: "canonical", ts: M, source: "a-native", session: "outside-session", run: "shadow-run", fingerprint: "native-pair" },
    { id: "native-shadow", source: "z-shadow", fingerprint: "native-pair" },
    { id: "replaced-report", session: "reporting-session", report: 1 },
    { id: "covering-report", ts: M, source: "cover-source", session: "report-owner", run: "covering-run", report: 1 },
    { id: "covered", run: "covered-run" },
    { id: "calibration", ts: M + 1, session: "account-session", run: null, aic: 1000 },
  ];
  calls.forEach((call, i) => {
    const aic = call.aic === undefined ? 1 : call.aic;
    insert.run({ id: call.id, ts: call.ts ?? slice.start + i * 1000, source: call.source ?? "complete-source",
      session: call.session ?? "detail-session", run: call.run === undefined ? "detail-run" : call.run,
      project: join(root, "project with spaces"), repo: i % 2 ? null : join(root, "repo"), parent: call.parent ?? null,
      kind: call.report ? "report" : "transcript", report: call.report ?? 0, copied: call.copied ?? 0,
      fingerprint: call.fingerprint ?? call.id, aic, status: aic === null ? "unpriced" : "priced",
      zero: aic === null ? null : 0, piCost: aic === null ? null : 0.5, cache1h: i % 2 ? null : 5, reasoning: i % 2 ? null : 4,
      unpricedReason: aic === null ? "unknown-model" : null, rateVersion: aic === null ? null : "fixture-rate",
      tier: aic === null ? null : "fixture-tier", confidence: aic === null ? null : "estimated" });
  });
  const run = db.prepare(`INSERT INTO runs_meta(id,db_path,session_id,parent_run_id,name,started_at,ended_at)
    VALUES (?,'synthetic/project.db',?,?,?, ?,?)`);
  for (const [id, session, parent, ended] of [
    ["detail-parent", "detail-session", null, M + D],
    ["detail-run", "reporting-session", "detail-parent", M + D],
    ["child-a", "reporting-session", "detail-run", M + D],
    ["child-b", "reporting-session", "detail-run", null],
    ["aggregate-run", "detail-session", null, M + D],
    ["open-run", "detail-session", null, null],
    ["hint-run", "detail-session", "covering-run", M + D],
    ["covered-run", "detail-session", "covering-run", M + D],
    ["covering-run", "report-owner", null, M + D],
  ] as const) run.run(id, session, parent, `Run ${id}`, M, ended);
  db.exec(`INSERT INTO import_state(path,size,offset,last_ingest_at) VALUES ('partial-source',100,90,${M}),('complete-source',100,100,${M});
    INSERT INTO incomplete_reports(path,run_id) VALUES ('report-source','aggregate-run');
    INSERT INTO coverage_edges(report_run_id,included_run_id,evidence) VALUES ('covering-run','covered-run','transcript');`);
  const counter = db.prepare("INSERT INTO counter_snapshots VALUES (?,'synthetic-seat',?,10000,?,'2026-11-01','{}')");
  counter.run(M, 0, 10000);
  counter.run(M + D, 501.5, 9498.5); // 1003 selected AIC in the fit window, factor 0.5.
});
afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(root, { recursive: true, force: true }); });

function read<T>(mode: "off" | "auto", query: (ctx: DashboardQueryContext) => T): T {
  const reader = openDashboardReader(file, { instanceId: "synthetic", serverBuild: "fixture",
    now: () => M + 4 * D, calibrationMode: () => mode })!;
  try {
    // Reader generations legitimately change cursors. Pin only the transport
    // identity so this comparison includes the exact cursor bytes on both layouts.
    return reader.snapshot(ctx => query({ ...ctx, revision: "synthetic:fixed", instanceId: "synthetic:fixed",
      calibration: createCalibrationService(ctx.db, { revision: () => "synthetic:fixed" }) }));
  } finally { reader.close(); }
}
const targets = [
  { kind: "session", id: "detail-session" }, { kind: "run", id: "detail-run" },
  { kind: "run", id: "aggregate-run" }, { kind: "run", id: "covered-run" },
  { kind: "run", id: "open-run" }, { kind: "run", id: "hint-run" },
] as const;
function responses(ctx: DashboardQueryContext) {
  return targets.map(target => {
    const query: DetailQuery = { ...target, slice, page: { limit: 1 } };
    const details = [], links = [];
    let cursor: string | undefined;
    do {
      const detail = queryDetail(ctx, { ...query, page: { limit: 1, cursor } });
      details.push(detail); cursor = detail.calls.nextCursor ?? undefined;
      expect(details.length).toBeLessThanOrEqual(7);
    } while (cursor);
    do {
      const page = queryDetailLinks(ctx, { ...query, page: { limit: 1, cursor } });
      links.push(page); cursor = page.nextCursor ?? undefined;
      expect(links.length).toBeLessThanOrEqual(20);
    } while (cursor);
    return { ...target, details, links };
  });
}

// Breaks if stored selection changes any wire field, misses global copied/native
// shadows or loses partial-import, incomplete-report or ongoing-run undercount.
it.each(["off", "auto"] as const)("Task 7 responses are byte identical on unmigrated v2 and migrated v3 (%s)", mode => {
  expect(db.pragma("user_version")).toBe(2);
  const before = read(mode, responses);
  const session = before[0]!.details[0]!, run = before[1]!.details[0]!;
  expect(session.totals).toMatchObject({ calls: 7, unpricedCalls: 1, aic: 5, possibleUndercount: true, possibleOverlap: true });
  expect(run.totals).toMatchObject({ calls: 4, unpricedCalls: 1, aic: 2, possibleUndercount: true });
  expect(run.accounting.status).toBe("replaced");
  expect(before[2]!.details[0]!).toMatchObject({ accounting: { status: "aggregate" }, totals: { possibleUndercount: true } });
  expect(before[3]!.details[0]!).toMatchObject({ accounting: { status: "covered", coveringRunId: "covering-run" },
    totals: { calls: 0, aic: null }, timeline: [], calls: { rows: [] } });
  expect(before[4]!.details[0]!.totals.possibleUndercount).toBe(true);
  expect(before[5]!.details[0]!.totals.possibleOverlap).toBe(true);
  expect(before[0]!.details).toHaveLength(7);
  expect(before[1]!.details).toHaveLength(4);
  expect(session.timeline.reduce((sum, point) => sum + point.measure.calls, 0)).toBe(7);
  expect(session.calls.nextCursor).not.toBeNull();
  expect(run.links.nextCursor).not.toBeNull();
  expect(before[1]!.links.flatMap(page => page.rows).map(row => [row.relationship, row.id])).toEqual([
    ["child", "child-a"], ["child", "child-b"], ["parent", "detail-parent"],
    ["reporting-session", "reporting-session"], ["transcript-session", "detail-session"],
  ]);
  expect(session.contextFillPercent).toBeNull();
  expect(session.contextFillMessage).toBe("Context fill unavailable: historical window not recorded");
  for (const key of ["composition", "carry", "itemReuse"] as const) {
    expect(session[key]).toEqual({ status: "unavailable", phase: 2, reason: "not-built", message: "Not available yet (Phase 2)" });
  }
  expect(session.calibration.status).toBe(mode === "off" ? "off" : "calibrated");
  if (mode === "auto") expect(session.calibration.factor).toBe(0.5);
  migrateUsageLedger(db);
  expect(db.pragma("user_version")).toBe(4);
  const after = read(mode, responses);
  // Compare the entire DTO on every calls and links page, including timeline,
  // accounting, calibration, context, redacted labels, opaque ids and cursors.
  expect(after).toEqual(before);
  expect(JSON.stringify(after)).toBe(JSON.stringify(before));
});

// A dynamic-on-v3 mutant returns identical DTOs but must fail this SQL-plan spy.
it.each(targets.slice(0, 2))("$kind detail reads stored decisions on v3 and dynamic decisions on v2", target => {
  const capture = () => read("off", ctx => {
    const sql: string[] = [], original = ctx.db.prepare.bind(ctx.db);
    const spy = vi.spyOn(ctx.db, "prepare").mockImplementation(statement => {
      if (statement.includes("window AS MATERIALIZED")) sql.push(statement);
      return original(statement);
    });
    try { queryDetail(ctx, { ...target, slice, page: { limit: 1 } }); } finally { spy.mockRestore(); }
    expect(sql).toHaveLength(1);
    return sql[0]!;
  });
  const dynamic = capture();
  expect(dynamic).not.toMatch(/selection_shadowed|selection_undercount/);
  expect(dynamic.match(/prior\.fingerprint/g)).toHaveLength(2);
  migrateUsageLedger(db);
  const stored = capture();
  expect(stored.match(/c\.selection_shadowed = 0/g)).toHaveLength(1);
  expect(stored).toContain("active.selection_shadowed = 0");
  expect(stored).toContain("w.selection_undercount AS possible_undercount");
  expect(stored).not.toMatch(/prior\.fingerprint|FROM incomplete_reports i|WHERE r\.id = w\.run_id/);
  const projection = /window AS MATERIALIZED \(SELECT (.*?) FROM calls c /.exec(stored)![1]!;
  for (const column of projection.split(",")) expect(column.trim()).toMatch(/^c\.[a-z_][a-z_0-9]*$/);
  expect(projection).not.toMatch(/source_generation|fingerprint|entry_id|total_tokens|rate_version/);
});
