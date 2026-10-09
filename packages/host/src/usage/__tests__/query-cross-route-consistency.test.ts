import { afterEach, expect, it } from "vitest";
import { openDashboardReader } from "../dashboard-reader.js";
import { queryOverviewV4, querySessions } from "../query-overview-v4.js";
import { calibrationFallback } from "../calibration.js";
import { querySession } from "../query-session.js";
import { readCorrectedTotal, sumValues } from "../query-redesign-shared.js";
import { customRange } from "./fixtures/redesign-range.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH as M, DASHBOARD_DAY as D } from "./fixtures/dashboard-ledger.js";
const closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0).reverse()) close(); });
it.each(["off", "auto"] as const)("Overview, Sessions and lifetime slices reconcile overlapping synthetic owners (%s)", mode => {
  const f = createDashboardFixture(false); closers.push(f.close);
  f.ledger.apply(dashboardBatch([
    dashboardCall("a-old", { ts: M - D, sessionId: "human-a" }),
    dashboardCall("a-now", { ts: M + D, sessionId: "human-a" }),
    dashboardCall("b-now", { ts: M + D, sessionId: "human-b" }),
    dashboardCall("worker", { ts: M + 3 * D, sessionId: "child", actor: "subagent", runId: "worker" }),
    dashboardCall("a-later", { ts: M + 5 * D, sessionId: "human-a" }),
  ], { sessions: ["human-a", "human-b", "child"].map(id => ({ id, ownerSessionId: id === "child" ? "human-a" : null, name: id, nameSource: "name", project: "Synthetic", nameOrder: 1, firstActivity: null, lastActivity: null })),
    runs: [{ id: "worker", dbPath: "synthetic/runs.db", project: null, repo: null, sessionId: "human-a", parentRunId: null, agent: null, role: "worker", name: "Worker", model: null, thinking: null, phase: null, startedAt: M + 3 * D, endedAt: M + 3 * D + 1, status: "done" }] }));
  f.ledger.insertCounter({ ts: M, creditsUsed: 0, accountLogin: "synthetic", resetDate: "2026-11-01", raw: {} });
  f.ledger.insertCounter({ ts: M + 2 * D, creditsUsed: 1, accountLogin: "synthetic", resetDate: "2026-11-01", raw: {} });
  const reader = openDashboardReader(f.file, { instanceId: "parity", serverBuild: "fixture", now: () => M + 7 * D, calibrationMode: () => mode })!; closers.push(() => reader.close());
  reader.snapshot(ctx => {
    const range = customRange(M, M + 7 * D), all = queryOverviewV4(ctx, range);
    const selected = queryOverviewV4(ctx, { ...range, buckets: [M + D, M + 3 * D] });
    expect(all.total.calls).toBe(4); expect(selected.selectedTotal.calls).toBe(3);
    const sessions = querySessions(ctx, { ...selected.range, sort: "credits", offset: 0, limit: 200 });
    expect(sessions.rows).toEqual(selected.sessions.rows);
    const values = sessions.rows.map(row => row.value);
    expect(selected.selectedTotal).toEqual(sumValues(values));
    expect(selected.flow.total).toEqual(selected.selectedTotal);
    expect(sumValues(selected.models.map(row => row.value))).toEqual(selected.selectedTotal);
    for (const row of sessions.rows) expect(sumValues(row.roles.map(role => role.value))).toEqual(row.value);
    const lifetime = querySession(ctx, "human-a", "UTC", { from: M-D, to: M+7*D });
    expect(lifetime.total.calls).toBe(4); expect(lifetime.span?.start).toBe(M - D);
    expect(lifetime.flow.total).toEqual(lifetime.total);
    expect(sumValues(lifetime.models.map(row => row.value))).toEqual(lifetime.total);
    expect(lifetime.runs[0]!.value.calls).toBe(1);
    expect(querySessions(ctx, { ...range, sort: "credits", offset: 0, limit: 200 }).rows.find(row => row.id === "human-a")!.value.calls).toBe(3);
    expect(selected.total).toEqual(all.total); expect(selected.pace).toEqual(all.pace);
  });
});

it("drifting daily fits give the same calls identical credits on both pages and range ends", () => {
 const f=createDashboardFixture(false);closers.push(f.close);
 const priced=(id:string,ts:number,aic:number,actor:"parent"|"compaction"="parent")=>dashboardCall(id,{ts,sessionId:"human",actor,
  price:{status:"priced",aic,components:{input:0,cacheRead:0,cacheWrite:aic,output:0},rateVersion:"synthetic",tier:"base",confidence:"estimated"}});
 f.ledger.apply(dashboardBatch([priced("first",M+D+3600000,10),priced("last",M+D+7200000,20),priced("compact",M+D+7200001,30)]));
 const reader=openDashboardReader(f.file,{instanceId:"drift",serverBuild:"fixture",now:()=>M+D+12*3600000,calibrationMode:()=>"auto"})!;closers.push(()=>reader.close());
 { const ctx=reader.snapshot(ctx=>ctx);
  // Intra-day counter drift makes an endpoint at the last call visibly different.
  ctx.calibration.atMany=points=>points.map(point=>({...calibrationFallback(),status:"calibrated",factor:(point-M-D)/D,windowStart:M,windowEnd:point}));
  const preset=queryOverviewV4(ctx,{range:"24h",from:0,to:0,tz:"UTC",unit:"credits",buckets:[]});
  const custom=queryOverviewV4(ctx,customRange(M+D,M+D+3*3600000));
  const session=querySession(ctx,"human","UTC");
  expect(preset.sessions.rows[0].value.credits).toBeCloseTo(30,5);
  expect(session.total.credits).toBe(preset.sessions.rows[0].value.credits);
  expect(custom.sessions.rows[0].value.credits).toBe(preset.sessions.rows[0].value.credits);
  expect(readCorrectedTotal(ctx,{start:M+D,end:M+D+3*3600000})).toBe(preset.sessions.rows[0].value.credits);
  expect(sumValues([...session.ownCallBins.map(b=>b.value),...session.compaction.map(e=>e.value)]).credits).toBe(session.total.credits);
  expect(session.idleGaps[0].cacheWriteCredits).toBeCloseTo(10,5);
 }
});
it("stored owner-null child stays off both human pages and retains unattributed credits", () => {
 const f=createDashboardFixture(false);closers.push(f.close);
 f.ledger.apply(dashboardBatch([dashboardCall("orphan",{ts:M+D,sessionId:"child",actor:"subagent",runId:"missing-run"})],{
  sessions:[{id:"child",ownerSessionId:null,name:"Child",nameSource:"id",nameOrder:0,project:null,firstActivity:null,lastActivity:null}]}));
 const reader=openDashboardReader(f.file,{instanceId:"owner",serverBuild:"fixture",now:()=>M+7*D,calibrationMode:()=>"off"})!;closers.push(()=>reader.close());
 { const ctx=reader.snapshot(ctx=>ctx);
  const overview=queryOverviewV4(ctx,customRange(M,M+7*D));
  expect(overview.sessions.rows.map(r=>r.id)).toEqual(["unattributed-runs"]);
  expect(()=>querySession(ctx,"child","UTC")).toThrowError(expect.objectContaining({code:"not-found"}));
  const unattributed=querySession(ctx,"unattributed-runs","UTC");
  expect(unattributed.total).toEqual(overview.sessions.rows[0].value);
  expect(unattributed.total).toMatchObject({calls:1,credits:1});
 }
});
it("metadata-free sessions use the same seven-character fallback on both pages", () => {
 const f=createDashboardFixture(false);closers.push(f.close);const id="1234567890-abcdef";
 f.ledger.apply(dashboardBatch([dashboardCall("fallback",{ts:M+D,sessionId:id})]));
 const reader=openDashboardReader(f.file,{instanceId:"fallback",serverBuild:"fixture",now:()=>M+7*D,calibrationMode:()=>"off"})!;closers.push(()=>reader.close());
 { const ctx=reader.snapshot(ctx=>ctx);expect(queryOverviewV4(ctx,customRange(M,M+7*D)).sessions.rows[0].name).toBe("1234567");expect(querySession(ctx,id,"UTC").name).toBe("1234567");}
});
