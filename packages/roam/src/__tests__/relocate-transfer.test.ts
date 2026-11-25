import { describe, expect, it } from "vitest";
import { stopLocalSession, type LocalIO } from "../relocate/local";
import type { SessionId } from "../relocate/types";
const id="33333333-3333-4333-8333-333333333333" as SessionId;
function stopFixture() {
 let now=0, exits=false, probes=0;
 const owner={identity:{pid:42,startIdentity:"pi-42"},bootId:"boot",pendingOperationId:null,pendingFile:null,pendingCoreId:null,operationId:null};
 const signals:number[]=[];
 const events:string[]=[];
 const io:LocalIO={inspect:async()=>exits?null:owner,probe:async()=>{probes++;return exits?{kind:"absent"}:{kind:"live",startIdentity:"pi-42",pi:true};},claimFree:async()=>{events.push("lock-free");},signal:async pid=>{signals.push(pid);events.push("signal");},shutdown:async()=>{events.push("shutdown");return false;},pause:async()=>{events.push("wait");now+=10;if(now>=20)exits=true;},terminals:async()=>[],launch:async()=>({terminal:"t"})};
 return {io,signals,events,clock:{now:()=>now,later:()=>()=>{}},owner,get probes(){return probes;}};
}
describe("v0 transfer stop boundary",()=>{
 it("shutdown fallback waits for the ID lock",async()=>{
  const f=stopFixture();let capture=false;
  const done=stopLocalSession(id,null,f.io,f.clock,30).then(r=>{if(r.ok){capture=true;f.events.push("capture");}return r;});
  expect(capture).toBe(false);
  expect(await done).toEqual({ok:true,value:undefined});
  expect(f.signals).toEqual([42]);
  expect(f.events.indexOf("capture")).toBeGreaterThan(f.events.indexOf("lock-free"));
  expect(f.events.filter(e=>e==="wait")).toHaveLength(2);
 });
 it("changed lock owner is never signalled",async()=>{
  const f=stopFixture();let reads=0;
  f.io.inspect=async()=>++reads===1?f.owner:{...f.owner,identity:{pid:99,startIdentity:"replacement"}};
  expect((await stopLocalSession(id,null,f.io,f.clock,30)).ok).toBe(false);
  expect(f.signals).toEqual([]);
 });
 it("unknown owner prevents capture",async()=>{
  const f=stopFixture();f.io.probe=async()=>({kind:"unknown"});
  expect((await stopLocalSession(id,null,f.io,f.clock,30)).ok).toBe(false);
  expect(f.signals).toEqual([]);
 });
 it("stop timeout leaves capture unavailable",async()=>{
  const f=stopFixture();f.io.pause=async()=>{throw new Error("deadline");};
  expect(await stopLocalSession(id,null,f.io,f.clock,30)).toMatchObject({ok:false,refusal:{code:"stop-timeout"}});
  expect(f.signals).toEqual([42]);
 });
});
