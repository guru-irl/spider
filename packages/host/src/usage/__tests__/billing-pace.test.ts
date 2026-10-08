import { expect, it } from "vitest";
import { billingPeriod, counterRate, computePace } from "../billing-pace.js";
import type { CounterSnapshot } from "../ledger.js";
const D=86_400_000, ts=(s:string)=>Date.parse(s);
const snap=(at:string,creditsUsed:number,extras:Partial<CounterSnapshot>={}):CounterSnapshot=>({ts:ts(at),creditsUsed,accountLogin:"synthetic-account",resetDate:"2026-11-01",entitlement:400,raw:{},...extras});
// Counter polls are ten minutes apart; no observation is stamped at render time.
const polls = (start: number, end: number, resetDate = "2026-11-01", lastUsed = 100) =>
 Array.from({length: Math.floor((end-start)/600000)+1}, (_, i) => {
  const at = start+i*600000;
  return snap(new Date(at).toISOString(), lastUsed-(end-at)/D*10, {resetDate});
 });
const base={now:ts("2026-10-30"),snapshots:polls(ts("2026-10-23"),ts("2026-10-30")-600000),budget:200,correctedMonth:40,correctedWindow:14};
it("reset defines billing month with non-leap and leap day clamping",()=>{
 expect(billingPeriod(ts("2026-03-10"),snap("2026-03-09",10,{resetDate:"2026-03-31"}))).toEqual({start:ts("2026-02-28"),end:ts("2026-03-31")});
 expect(billingPeriod(ts("2028-03-10"),snap("2028-03-09",10,{resetDate:"2028-03-31"}))).toEqual({start:ts("2028-02-29"),end:ts("2028-03-31")});
});
it("unusable reset dates and expired periods fall back to UTC calendar month",()=>{
 for(const resetDate of [undefined,"bad","2026-02-30","2026-10-01","2027-01-01"])
 expect(billingPeriod(base.now,snap("2026-10-01",10,{resetDate}))).toEqual({start:ts("2026-10-01"),end:ts("2026-11-01")});
});
it("counter takes account-wide used and budget before allowance",()=>{
 expect(computePace(base)).toMatchObject({used:100,budget:200,allowance:400,scale:200,remaining:100,usedSource:"counter",counterAvailable:true});
 expect(computePace({...base,budget:undefined})).toMatchObject({scale:400,remaining:300,evenPace:null});
});
it("seven day projection uses covered deltas and fractional days",()=>{
 const pace=computePace(base);expect(pace.ratePerDay).toBeCloseTo(10,10);expect(pace.projected).toBeCloseTo(120,10);expect(pace.daysLeft).toBe(2);expect(pace.rateSource).toBe("counter");
 const noon=computePace({...base,now:base.now+D/2,snapshots:polls(base.now+D/2-7*D,base.now+D/2-600000,"2026-11-01",105)});
 expect(noon.daysLeft).toBe(1.5);expect(noon.projected).toBeCloseTo(120,10);
});
it("short month-to-date window uses the actual elapsed duration",()=>{
 const pace=computePace({...base,now:ts("2026-10-03T12:00:00Z"),snapshots:[snap("2026-10-01",0),snap("2026-10-03T12:00:00Z",25)],correctedWindow:5});
 expect(pace.ratePerDay).toBe(10);expect(pace.projected).toBe(310);
});
it("counter rate ignores readings outside the window rather than interpolating",()=>{
 const snapshots=[snap("2026-10-20",0),...polls(ts("2026-10-23")+600000,ts("2026-10-29")-600000),snap("2026-10-30",1000)];
 expect(counterRate(snapshots,{start:ts("2026-10-23"),end:ts("2026-10-29")})).toBeCloseTo(10,10);
 expect(counterRate(snapshots,{start:ts("2026-10-18"),end:ts("2026-10-29")})).toBeNull();
 expect(counterRate(snapshots,{start:ts("2026-10-23"),end:ts("2026-10-31")})).toBeCloseTo((1000-snapshots[1].creditsUsed)/((ts("2026-10-30")-snapshots[1].ts)/D),10);
});
it.each([
 [snap("2026-10-24T00:00:00.001Z",40),snap("2026-10-30",100)],
 [snap("2026-10-23",120),snap("2026-10-30",100)],
 [snap("2026-10-23",30),snap("2026-10-30",100,{accountLogin:"other"})],
 [snap("2026-10-23",30,{accountLogin:undefined}),snap("2026-10-30",100,{accountLogin:undefined})],
 [snap("2026-10-23",30,{resetDate:"2026-10-25"}),snap("2026-10-30",100)],
 [snap("2026-10-23",30,{resetDate:undefined}),snap("2026-10-30",100,{resetDate:undefined})],
 [snap("2026-10-20",0),snap("2026-10-30",100)],
])("sparse identity reset decrease or long-gap evidence falls back to pi %#",(...snapshots)=>{
 const pace=computePace({...base,snapshots});expect(pace.rateSource).toBe("pi");expect(pace.ratePerDay).toBe(2);expect(pace.projected).toBe(snapshots.at(-1)?.resetDate===undefined ? 44:104);
});
it("invalid observations inside the chain are honest gaps",()=>{
 expect(counterRate([snap("2026-10-23",30),snap("2026-10-26",NaN),snap("2026-10-30",100)],{start:ts("2026-10-23"),end:base.now})).toBeNull();
});
it("stale in-period observation supplies used while unbracketed rate falls back",()=>{
 expect(computePace({...base,snapshots:[snap("2026-10-03",48)]})).toMatchObject({used:48,usedSource:"counter",rateSource:"pi"});
});
it("no denominator and absent evidence remain null and finite",()=>{
 const pace=computePace({...base,budget:undefined,snapshots:[],correctedMonth:null,correctedWindow:null});
 expect(pace).toMatchObject({used:null,scale:null,projected:null,remaining:null,ratePerDay:null,usedSource:"unavailable",rateSource:"unavailable",counterAvailable:false});
 expect(computePace({...base,budget:undefined,snapshots:[]})).toMatchObject({used:40,scale:null,projected:44,usedSource:"pi"});
 expect(computePace({...base,now:ts("2026-10-01"),snapshots:[],correctedWindow:0}).ratePerDay).toBeNull();
 for(const value of Object.values(pace))if(typeof value==="number")expect(Number.isFinite(value)).toBe(true);
});
it("danger flags compare credits against elapsed budget and chosen scale",()=>{
 const pace=computePace({...base,budget:110});expect(pace.overPace).toBe(false);expect(pace.overAtPace).toBeCloseTo(10,10);expect(pace.overBudget).toBe(false);
 expect(computePace({...base,budget:80})).toMatchObject({overPace:true,overBudget:true,overAtPace:40,remaining:0});
 expect(computePace({...base,budget:undefined,snapshots:base.snapshots.map(s=>({...s,entitlement:110}))})).toMatchObject({overPace:false,overAtPace:10});
});
it("invalid dates reject instead of generating NaN periods",()=>{
 for(const now of [NaN,Infinity,-1]) {
  expect(()=>billingPeriod(now,undefined)).toThrow("invalid-query");
  expect(()=>computePace({...base,now})).toThrow("invalid-query");
 }
});
it("a finite very large budget has a finite elapsed pace",()=>{
 const pace=computePace({...base,budget:Number.MAX_VALUE});
 expect(pace.evenPace).not.toBeNull();expect(Number.isFinite(pace.evenPace)).toBe(true);
});
it("bad budgets and numeric estimates never emit nonfinite pace",()=>{
 for(const budget of [0,-1,NaN,Infinity])expect(computePace({...base,budget}).budget).toBeNull();
 expect(computePace({...base,snapshots:[],correctedMonth:Infinity,correctedWindow:NaN})).toMatchObject({used:null,projected:null});
});

it("recent ten-minute polls cover the seven-day window using their actual span",()=>{
 const rows=polls(base.now-7*D+600000,base.now-600000);
 const pace=computePace({...base,snapshots:rows});
 expect(pace.rateSource).toBe("counter");expect(pace.ratePerDay).toBeCloseTo(10,10);expect(pace.projected).toBeCloseTo(120,10);
});
it("part-day counter coverage starts within one day and uses its actual span",()=>{
 const window={start:base.now-7*D,end:base.now};
 expect(counterRate(polls(window.start+D,window.end-12*3600000),window)).toBeCloseTo(10,10);
 expect(counterRate(polls(window.start+D+1,window.end-600000),window)).toBeNull();
 expect(counterRate(polls(window.start+12*3600000,window.start+36*3600000),window)).toBeCloseTo(10,10);
 expect(counterRate(polls(window.start+12*3600000,window.start+36*3600000-600000),window)).toBeNull();
});
it("a reset in the window uses only the post-reset day-long chain",()=>{
 const now=ts("2026-11-03"), start=now-7*D;
 const old=polls(start,ts("2026-11-01")-600000,"2026-11-01",100);
 const fresh=polls(ts("2026-11-01")+600000,now-600000,"2026-12-01",20);
 expect(counterRate([...old,...fresh],{start,end:now})).toBeCloseTo(10,10);
 expect(counterRate([...old,...polls(ts("2026-11-01")+600000,ts("2026-11-01T12:00:00Z")-600000,"2026-12-01",5)],{start,end:ts("2026-11-01T12:00:00Z")})).toBeNull();
});
it("a lagging reset cannot supply this month's used counter",()=>{
 expect(computePace({...base,now:ts("2026-11-01T00:20:00Z"),snapshots:[snap("2026-11-01T00:10:00Z",180)],correctedMonth:3})).toMatchObject({used:3,usedSource:"pi",counterAvailable:false});
});

it("a reset's partial first day uses corrected pi totals until a full day is covered",()=>{
 const now=ts("2026-11-01T12:00:00Z");
 const pace=computePace({...base,now,snapshots:polls(ts("2026-11-01")+600000,now-600000,"2026-12-01",5),correctedWindow:1});
 expect(pace.rateSource).toBe("pi");expect(pace.ratePerDay).toBe(2);
});

it("reset crossing uses the observed reset boundary when short months overlap",()=>{
 const start=ts("2027-01-26"),now=ts("2027-02-02");
 const old=polls(start,ts("2027-01-31")-600000,"2027-01-31",100);
 const fresh=polls(ts("2027-01-31")+600000,now-600000,"2027-02-28",20);
 expect(counterRate([...old,...fresh],{start,end:now})).toBeCloseTo(10,10);
});

it.each([120, 200])("projection within scale %s has no over amount", budget => {
 const pace=computePace({...base,budget}); expect(pace.projected).toBe(120); expect(pace.overAtPace).toBeNull();
});
