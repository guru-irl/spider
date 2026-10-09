import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDashboardReader } from "../dashboard-reader.js";
import { calibrationFallback } from "../calibration.js";
import type { DashboardQueryContext, DashboardReader } from "../dashboard-contract.js";
import type { RangeQuery } from "../dashboard-v4-contract.js";
import type { RunMeta, SessionMeta } from "../ledger.js";
import { readCorrectedTotal, readUsageCube, sumValues, flowFromCube, modelRows, sessionRows, sessionOwnerResolver, readSessionCorrectedComponents, modelStyles, readCorrectedComponents, UNATTRIBUTED_SESSION_ID } from "../query-redesign-shared.js";
import { createDashboardFixture, dashboardCall, dashboardBatch, DASHBOARD_MONTH as S, DASHBOARD_DAY as D, type DashboardFixture } from "./fixtures/dashboard-ledger.js";
import { querySession } from "../query-session.js";
const resolveOwner = (ctx: DashboardQueryContext, sessionId: string | null, runId: string | null) => sessionOwnerResolver(ctx, sessionId === null ? [] : [sessionId])(sessionId, runId);
let f:DashboardFixture, reader:DashboardReader, ctx:DashboardQueryContext;
const q=(from=S,to=S+2*D,tz="UTC",buckets: number[]=[]):RangeQuery=>({range:"custom",from,to,tz,unit:"credits",buckets});
const human=(id="parent-session",ownerSessionId:string|null=null):SessionMeta=>({id,ownerSessionId,name:`Name ${id}`,nameSource:"name",nameOrder:1,project:"synthetic",firstActivity:S,lastActivity:S+D});
const run=(id:string,sessionId:string|null,parentRunId:string|null=null,dbPath="synthetic/runs.db"):RunMeta=>({id,sessionId,parentRunId,dbPath,project:null,repo:null,agent:null,role:"worker",name:id,model:null,thinking:null,phase:null,startedAt:S,endedAt:S+D});
const call=(id:string,ts:number,aic:number,extra:Parameters<typeof dashboardCall>[1]={})=>dashboardCall(id,{ts,price:{status:"priced",aic,components:{input:0,cacheRead:0,cacheWrite:aic,output:0},rateVersion:"synthetic",tier:"base",confidence:"estimated"},...extra});
function refresh(){reader?.close();reader=openDashboardReader(f.file,{instanceId:"synthetic",serverBuild:"fixture",now:()=>S+1000*D,calibrationMode:()=>"auto"})!;ctx=reader.snapshot(c=>c);}
beforeEach(()=>{f=createDashboardFixture(false);refresh();});
afterEach(()=>{vi.restoreAllMocks();reader.close();f.close();});
it("daily correction reconciles every slice including a local day crossing UTC",()=>{
 f.ledger.apply(dashboardBatch([call("a",S+23*3600000,10),call("b",S+D+3600000,20)],{sessions:[human()]}));refresh();
 ctx.calibration.atMany=ends=>ends.map(e=>({...calibrationFallback(),status:"calibrated",factor:e<S+D ? .5:1,windowEnd:e}));
 for(const tz of ["UTC","America/New_York","Asia/Kathmandu"]){
 const cube=readUsageCube(ctx,q(S,S+2*D,tz));
 expect(cube.total.credits).toBeCloseTo(25,10);
 for(const values of [cube.buckets.map(b=>b.total),modelRows(cube).map(r=>r.value),sessionRows(cube).map(r=>r.value),flowFromCube(cube).edges.map(e=>e.value)])expect(sumValues(values).credits).toBeCloseTo(25,10);
 expect(cube.total.tokens).toMatchObject({input:20,cacheRead:40,cacheWrite:60,output:20,prompt:120,total:140,reasoning:8,cacheWrite1h:10});
 expect(readCorrectedComponents(ctx,["a","b"]).get("a")!.cacheWriteCredits).toBe(5);
 }
});
it("hourly buckets share the range-independent UTC day fit",()=>{
 f.ledger.apply(dashboardBatch([call("early",S+1,10),call("late",S+23*3600000,20)]));refresh();
 ctx.calibration.atMany=ends=>ends.map(e=>({...calibrationFallback(),status:"calibrated",factor:e<S+12*3600000 ? .5:1,windowEnd:e}));
 expect(readUsageCube(ctx,q(S,S+D)).total.credits).toBe(30);
 expect(readUsageCube(ctx,q(S,S+8*3600000)).total.credits).toBe(10);
});
it("cyclic parent evidence cannot be rescued by a human session hint",()=>{
 f.ledger.apply(dashboardBatch([],{sessions:[human()],runs:[run("a","parent-session","b"),run("b","parent-session","a")]}));refresh();
 expect(resolveOwner(ctx,"parent-session","a")).toBeNull();
});
it("null pricing and priced zero stay distinct",()=>{
 f.ledger.apply(dashboardBatch([dashboardCall("unpriced",{price:{status:"unpriced",reason:"unknown-model"}})]));refresh();
 expect(readUsageCube(ctx,q()).total).toMatchObject({credits:null,calls:1,unpricedCalls:1});
 f.ledger.apply(dashboardBatch([call("zero",S+D,0)]));refresh();
 expect(readUsageCube(ctx,q()).total).toMatchObject({credits:0,calls:2,unpricedCalls:1});
});
it("selection stays globally canonical under bucket filtering",()=>{
 const native=call("native",S+100,2,{runId:"r",actor:"subagent",sessionId:"child",responseId:"same"});
 f.ledger.apply(dashboardBatch([native,call("copy",S+100,2,{copied:true,sourceFile:"synthetic/copy",responseId:"same"}),call("report",S+D,80,{runId:"r",actor:"subagent",aggregate:true,sourceKind:"report"}),call("cover",S+D+100,3,{runId:"cover",actor:"subagent",aggregate:true,sourceKind:"report"}),call("desc",S+D+200,50,{runId:"desc",actor:"subagent"})],{coverageEdges:[{reportRunId:"cover",includedRunId:"desc",evidence:"transcript"}],runs:[run("r","parent-session"),run("cover","parent-session")],sessions:[human(),human("child","parent-session")]}));refresh();
 const cube=readUsageCube(ctx,q(S,S+2*D,"UTC",[S+D]));
 expect(cube.total.credits).toBe(5);expect(cube.selectedTotal.credits).toBe(3);expect(sumValues(modelRows(cube).map(r=>r.value)).credits).toBe(3);
});
it("ownership resolves direct pipeline and mapped nested runs but not cycles or ambiguous ids",()=>{
 f.ledger.apply(dashboardBatch([],{sessions:[human(),human("child","parent-session"),human("cycle-a","cycle-b"),human("cycle-b","cycle-a")],runs:[run("direct","parent-session"),run("pipeline",null,"direct"),run("nested","child"),run("a",null,"b"),run("b",null,"a"),run("dup","parent-session"),run("dup","other",null,"synthetic/other.db")]}));refresh();
 for(const id of ["direct","pipeline","nested"])expect(resolveOwner(ctx,"child",id)).toBe("parent-session");
 for(const id of ["a","dup"])expect(resolveOwner(ctx,null,id)).toBeNull();
 expect(resolveOwner(ctx,"cycle-a",null)).toBeNull();
});
it("missing child is not human before backfill and moves exactly once afterward",()=>{
 f.ledger.apply(dashboardBatch([call("parent",S+100,2),call("nested",S+200,7,{sessionId:"missing-child",runId:"nested",actor:"subagent"})],{runs:[run("nested","missing-child")]}));refresh();
 expect(sessionRows(readUsageCube(ctx,q())).map(r=>[r.name,r.value.credits])).toEqual([["Unattributed runs",7],["parent-",2]]);
 f.ledger.apply(dashboardBatch([],{sessions:[human(),human("missing-child","parent-session")]}));refresh();
 expect(sessionRows(readUsageCube(ctx,q()))).toHaveLength(1);expect(sessionRows(readUsageCube(ctx,q()))[0]!.value.credits).toBe(9);
});
it("a mapped child resolves native human evidence outside the visible range",()=>{
 f.ledger.apply(dashboardBatch([call("parent-old",S+1,2),call("child-new",S+10*D,7,{sessionId:"child",runId:"nested",actor:"subagent"})],{runs:[run("nested","child")],sessions:[human("child","parent-session")]}));refresh();
 expect(resolveOwner(ctx,"child","nested")).toBe("parent-session");
 expect(sessionRows(readUsageCube(ctx,q(S+9*D,S+11*D)))[0]).toMatchObject({id:"parent-session",value:{credits:7}});
});
it("reserved identity stays synthetic on collision and colliding human has no drill-down",()=>{
 f.ledger.apply(dashboardBatch([call("unknown",S+10,3,{sessionId:"child",runId:"unknown",actor:"subagent"}),call("collision",S+20,5,{sessionId:UNATTRIBUTED_SESSION_ID})],{sessions:[human(UNATTRIBUTED_SESSION_ID)]}));refresh();
 const rows=sessionRows(readUsageCube(ctx,q()));
 expect(rows.find(r=>r.id===UNATTRIBUTED_SESSION_ID)).toMatchObject({name:"Unattributed runs",value:{credits:3}});
 expect(rows.find(r=>r.name===`Name ${UNATTRIBUTED_SESSION_ID}`)).toMatchObject({id:null,value:{credits:5}});
 expect(readUsageCube(ctx,q(),{sessionId:UNATTRIBUTED_SESSION_ID}).total.credits).toBe(3);
});
it("roles use metadata when report role is absent and unknown roles stay other runs",()=>{
 f.ledger.apply(dashboardBatch([call("w",S+1,2,{actor:"subagent",runId:"w",role:null}),call("r",S+2,3,{actor:"subagent",role:"reviewer"}),call("s",S+3,4,{actor:"subagent",role:"scout"}),call("u",S+4,5,{actor:"subagent",role:"odd"}),call("c",S+5,6,{actor:"compaction"}),call("bg",S+6,7,{actor:"aux"})],{runs:[run("w","parent-session")],sessions:[human()]}));refresh();
 expect(flowFromCube(readUsageCube(ctx,q())).edges.map(e=>[e.role,e.value.credits])).toEqual([["workers",2],["reviewers",3],["scouts",4],["other-runs",5],["compaction",6],["background",7]]);
});
it("session activity follows the effective bucket selection",()=>{
 f.ledger.apply(dashboardBatch([call("early",S+100,1),call("late",S+D+100,2)]));refresh();
 expect(sessionRows(readUsageCube(ctx,q(S,S+2*D,"UTC",[S])))[0]!.lastActive).toBe(S+100);
});
it("catalogue extensions do not recycle the primary four colours",()=>{
 f.ledger.apply(dashboardBatch(Array.from({length:12},(_,i)=>call(`m${i}`,S+i,12-i,{model:`model-${i}`}))));refresh();
 const styles=[...modelStyles(ctx).values()];
 expect(new Set(styles.slice(0,4).map(s=>s.color)).size).toBe(4);
 expect(styles.slice(4).every(s=>!styles.slice(0,4).some(p=>p.color===s.color))).toBe(true);
});
it("styles do not rerank on scope selection unit or same-day revisions",()=>{
 f.ledger.apply(dashboardBatch([call("a",S+1,10,{model:"model-a"}),call("b",S+2,5,{model:"model-b"})]));refresh();
 const styles=modelStyles(ctx);expect(styles.get("model-a")!.color).toBe("#f8785c");
 readUsageCube(ctx,{...q(),unit:"tokens",buckets:[S]}, {sessionId:"parent-session"});
 f.ledger.apply(dashboardBatch([call("b2",S+3,100,{model:"model-b"})]));ctx={...ctx,revision:"later"};
 expect(modelStyles(ctx)).toEqual(styles);
 expect(modelStyles({...ctx,now:()=>ctx.now()+D}).get("model-b")!.color).toBe("#f8785c");
});
it("two years and components have bounded calibration batches and indexed ranges",()=>{
 f.ledger.apply(dashboardBatch(Array.from({length:730},(_,i)=>call(`c${i}`,S+i*D+1,1))));refresh();
 const many=vi.spyOn(ctx.calibration,"atMany");const prepare=vi.spyOn(ctx.db,"prepare");
 modelStyles(ctx);expect(many).not.toHaveBeenCalled();
 const reference=readUsageCube(ctx,q(S,S+730*D),{sessionId:"parent-session"});
 expect(reference.total.credits).toBe(730);
 expect(querySession(ctx,"parent-session","UTC",{from:S,to:S+730*D}).total).toEqual(reference.total);
 const ids=Array.from({length:730},(_,i)=>`c${i}`);
 const referenceComponents=readCorrectedComponents(ctx,ids);
 expect(referenceComponents.size).toBe(730);
 expect(readSessionCorrectedComponents(ctx,{start:S,end:S+730*D},ids)).toEqual(referenceComponents);
 for(const [ends] of many.mock.calls){expect(ends.length).toBeLessThanOrEqual(200);expect(Math.max(...ends)-Math.min(...ends)).toBeLessThanOrEqual(366*D);}
 const sql=prepare.mock.calls.map(([s])=>s).find(s=>s.includes("calls_period_read") && s.includes("json_each"))!;
 expect(sql).toBeTruthy();
 const plan=ctx.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(S,S+93*D,JSON.stringify([{key:S,start:S,end:S+D,endpoint:S+D-1}]));
 expect(JSON.stringify(plan)).toMatch(/calls_period_read.*ts>.*ts</);
 for(const [statement] of prepare.mock.calls.filter(([s])=>s.includes("calls_session_read") && s.includes("json_each(?)"))) {
   const bindings=statement.includes("json_each(?)")?[JSON.stringify(["parent-session"])]:[];
   const evidencePlan=ctx.db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all(...bindings);
   expect(JSON.stringify(evidencePlan)).toMatch(/calls_session_read \(session_id=\?\)/);
 }
});
it("last accepted factor persists for unavailable counters without changing the engine",()=>{
 f.ledger.apply(dashboardBatch([call("old",S+1,10),call("new",S+10*D,20)]));refresh();
 ctx.calibration.earliest=()=>({...calibrationFallback(),status:"calibrated",factor:.5,windowEnd:S+D});
 ctx.calibration.atMany=ends=>ends.map(()=>calibrationFallback());
 expect(readUsageCube(ctx,q(S,S+11*D)).total.credits).toBe(15);
});

it("known runs with unresolved evidence cannot borrow the call's human session",()=>{
 f.ledger.apply(dashboardBatch([],{sessions:[human()],runs:[run("known-orphan",null)]}));refresh();
 expect(resolveOwner(ctx,"parent-session","known-orphan")).toBeNull();
});

it("total-only corrected aggregation reconciles days without resolving ownership",()=>{
 f.ledger.apply(dashboardBatch([call("total-a",S+23*3600000,10),call("total-b",S+D+3600000,20)]));refresh();
 ctx.calibration.atMany=ends=>ends.map(e=>({...calibrationFallback(),status:"calibrated",factor:e<S+D ? .5:1,windowEnd:e}));
 const prepare=ctx.db.prepare.bind(ctx.db);
 vi.spyOn(ctx.db,"prepare").mockImplementation(sql=>{
  if(/FROM (sessions|runs_meta)/i.test(sql))throw new Error("total aggregate must not resolve owners");
  return prepare(sql);
 });
 expect(readCorrectedTotal(ctx,{start:S,end:S+2*D})).toBeCloseTo(25,10);
});
