import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "@spider/db-core";
import { createCalibrationService } from "../calibration.js";
import type { DashboardQueryContext } from "../dashboard-contract.js";
import { openDashboardReader } from "../dashboard-reader.js";
import { migrateUsageLedger, USAGE_MIGRATIONS } from "../migrate.js";
import { readMeasure } from "../dashboard-selection.js";
import { querySession } from "../query-session.js";
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
  return targets.map(target => readMeasure(ctx, slice, target.kind === "session" ? { sessionId: target.id } : { runId: target.id }));
}
it.each(["off", "auto"] as const)("scoped canonical measures preserve migration evidence (%s)", mode => {
  const before = read(mode, responses);
  expect(before[0]).toMatchObject({ calls: 7, unpricedCalls: 1, aic: 5, possibleUndercount: true, possibleOverlap: true });
  expect(before[1]).toMatchObject({ calls: 4, unpricedCalls: 1, aic: 2, possibleUndercount: true });
  expect(before[2]).toMatchObject({ possibleUndercount: true });
  expect(before[3]).toMatchObject({ calls: 0, aic: null });
  expect(before[4]).toMatchObject({ possibleUndercount: true }); expect(before[5]).toMatchObject({ possibleOverlap: true });
  if (mode === "auto") expect(before[0]!.aicDisplay.primaryAic).toBe(2.5);
  migrateUsageLedger(db); expect(db.pragma("user_version")).toBe(5);
  expect(read(mode, responses)).toEqual(before);
});
it.each(targets.slice(0, 2))("$kind scoped measure switches to stored selection", target => {
  const capture = () => read("off", ctx => {
    const sql: string[] = [], prepare = ctx.db.prepare.bind(ctx.db);
    const spy = vi.spyOn(ctx.db, "prepare").mockImplementation(statement => { if (statement.includes("window AS MATERIALIZED")) sql.push(statement); return prepare(statement); });
    try { readMeasure(ctx, slice, target.kind === "session" ? { sessionId: target.id } : { runId: target.id }); } finally { spy.mockRestore(); }
    expect(sql).toHaveLength(1); return sql[0]!;
  });
  expect(capture()).toContain("prior.fingerprint"); migrateUsageLedger(db);
  expect(capture()).toContain("c.selection_shadowed = 0"); expect(capture()).not.toContain("prior.fingerprint");
});
it("whole-session replacement redacts names and excludes copied and covered calls", () => {
  migrateUsageLedger(db);
  db.prepare("INSERT INTO sessions(id,name,name_source,name_order) VALUES ('human','Safe name','name',1)").run();
  db.exec("UPDATE runs_meta SET session_id='human',parent_run_id=NULL WHERE id IN ('detail-parent','detail-run','aggregate-run','open-run'); UPDATE calls SET session_id='human' WHERE session_id='detail-session'");
  db.exec("UPDATE calls SET actor='parent',run_id=NULL WHERE id='clean'");
  const session = read("off", ctx => querySession(ctx, "human", "UTC"));
  {
    // The hint run points to another owner's covering run, so ownership
    // fails closed. Six canonical calls remain on this human session.
    expect(session.total.calls).toBe(6); expect(session.total.credits).toBe(4);
    expect(session.flow.total).toEqual(session.total); expect(JSON.stringify(session)).not.toContain(root);
    expect(session.runs.find(row => row.id === "detail-run")?.value.calls).toBe(3);
  }
});
