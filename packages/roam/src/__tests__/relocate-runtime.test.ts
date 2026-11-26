import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { dirname, delimiter } from "node:path";
import * as hcApi from "@spider/herdr/client/hc";
import type { CoreIdentity } from "@spider/herdr/contracts";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import type { RelocateAdapterOptions, RunningHome, SessionId, SessionPlacement } from "../relocate/types";
import { DEFAULT_LIMITS, disabledIntercom } from "../contracts";
import { openJournal } from "../journal";
import { createLocalRuntime, createLocalIO, type LocalIO } from "../relocate/local";
const hub = "11111111-1111-4111-8111-111111111111", box = "22222222-2222-4222-8222-222222222222";
const id = "33333333-3333-4333-8333-333333333333" as SessionId;
const fixtures: {close():void}[] = [];
afterEach(()=>{ vi.restoreAllMocks(); vi.unstubAllEnvs(); for(const f of fixtures.splice(0)) f.close(); });
export function runtimeFixture() {
 const db = createReplica("global", box);fixtures.push(db);
 const home: RunningHome = {sessionId:id,machineId:box,epoch:3,state:"running",destination:null,moveId:"v0-run" as RunningHome["moveId"],updatedAt:1};
 const placement: SessionPlacement = {sessionId:id,machineId:box,repoKey:"repo",workspaceId:"workspace",repository:"/mapped",cwd:"/mapped/sub",file:"/sessions/exact.jsonl",stores:["global"],historyMachine:hub};
 let current: typeof home | null = home;
 let lock: Awaited<ReturnType<LocalIO["inspect"]>> = null;
 let probe: Awaited<ReturnType<LocalIO["probe"]>> = {kind:"absent"};
 let terminals: Awaited<ReturnType<LocalIO["terminals"]>> = [];
 const launches: Parameters<LocalIO["launch"]>[0][] = [];
 const signalled: number[]=[];
 let now = 0;
 const journal = openJournal(join(db.root,"journal.db"));
 const run: RelocateAdapterOptions["git"]["run"] = async()=>{throw new Error("unexpected git");};
 const io: LocalIO = {inspect:async()=>lock,probe:async()=>probe,claimFree:async()=>{},signal:async pid=>{signalled.push(pid);},shutdown:async()=>false,pause:async()=>{now+=10;},terminals:async()=>terminals,launch:async request=>{launches.push(request);return {terminal:"core:t"};}};
 const options: RelocateAdapterOptions = {root:db.root,globalDb:db.db,homes:{read:async()=>current,list:async()=>current?[current]:[],initialize:async()=>home,compareAndSwap:async()=>({kind:"conflict",home:current})},journal,config:{enabled:false,role:"box",machineId:box,hubMachineId:hub,peers:[],discoveryRoots:[],coreUnit:"core",syncMs:10000,limits:{...DEFAULT_LIMITS,readyMs:30},intercom:disabledIntercom()},sync:{start(){},stop(){},sync:async()=>[],barriers:async()=>true},transport:{resolve:async p=>p,bootstrapProbe:async()=>{throw new Error("unused");},exec:async()=>{throw new Error("unexpected remote");},run:async()=>({terminal:"t"}),read:async()=>Buffer.alloc(0),write:async()=>{}},clock:{now:()=>now,later:(_ms,_fn)=>()=>{}},git:{run,journal,limits:DEFAULT_LIMITS,scratch:join(db.root,"git"),worktreeCommand:null},workspaceImport:{run,journal,limits:DEFAULT_LIMITS,scratch:join(db.root,"git"),worktreeCommand:null,resolveCommonRepository:async()=>null,lastExportedSnapshot:async()=>null,verifiedArtifactPath:async()=>null},limits:{...DEFAULT_LIMITS,readyMs:30}};
 return {options,io,home,placement,launches,signalled,setHome:(v:typeof current)=>current=v,setLock:(v:typeof lock)=>lock=v,setProbe:(v:typeof probe)=>probe=v,setTerminals:(v:typeof terminals)=>terminals=v};
}
describe("v0 local runtime",()=>{
 it("detached exact-file launch uses the destination environment",async()=>{
  const f=runtimeFixture(),pi=join(f.options.root,"pi");writeFileSync(pi,"#!/bin/sh\n",{mode:0o700});
  vi.stubEnv("SPIDER_ROAM_PI",pi);vi.stubEnv("HC_TERMINAL_ID","inherited");vi.stubEnv("HC_SESSION","foreign");vi.stubEnv("HC_SOCKET","/foreign.sock");vi.stubEnv("SPIDER_HERDR_LEASE_TOKEN","fake-lease");vi.stubEnv("SPIDER_HERDR_HANDOFF_FILE","/foreign-handoff");vi.stubEnv("SPIDER_GLOBAL_ROOT","/foreign-root");vi.stubEnv("AUTH_TOKEN","synthetic-secret");
  vi.spyOn(hcApi,"observeCoreIdentity").mockResolvedValue({coreId:"selected",sessionNamespace:"selected",socket:"/selected.sock"} as CoreIdentity);
  const calls:{argv:readonly string[];env:Readonly<NodeJS.ProcessEnv>}[]=[];
  vi.spyOn(hcApi,"invokeCli").mockImplementation(async(_binary,argv,env)=>{calls.push({argv,env});return {address:"selected:t"};});
  const io=createLocalIO(f.options);expect(await io.launch({home:f.home,placement:f.placement})).toEqual({terminal:"selected:t"});
  expect(calls[0].argv).toEqual(["run","--json","--bg","--no-notify","--outlive-parent","--no-parent","--cwd","/mapped/sub","--label","spider.kind=session","--label",`spider.session=${id}`,"--label",`spider.machine=${box}`,"--label","spider.roam.epoch=3","--",pi,"--session","/sessions/exact.jsonl"]);
  expect(calls[0].env).toMatchObject({HC_SESSION:"selected",HC_SOCKET:"/selected.sock",SPIDER_GLOBAL_ROOT:f.options.root});
  expect(calls[0].env.HC_TERMINAL_ID).toBeUndefined();expect(calls[0].env.SPIDER_HERDR_LEASE_TOKEN).toBeUndefined();expect(calls[0].env.SPIDER_HERDR_HANDOFF_FILE).toBeUndefined();
  expect(calls[0].env.PI_CODING_AGENT_DIR).toBeTruthy();expect(calls[0].env.PATH!.split(delimiter)).toContain(dirname(process.execPath));expect(calls[0].argv.join(" ")).not.toContain("synthetic-secret");
 });
 it("supervisor entries include missing homes",async()=>{
  const f=runtimeFixture(),local=createLocalRuntime(f.options,f.io);
  expect(await local.activate(f.home,f.placement)).toEqual({ok:true,value:undefined});
  f.setHome(null);
  expect(await local.entries()).toEqual([{sessionId:id,home:null,placement:f.placement}]);
 });
 it("preparatory activation never launches pi",async()=>{
  const f=runtimeFixture(),local=createLocalRuntime(f.options,f.io);
  f.setHome({...f.home,machineId:hub,epoch:2,state:"moving",destination:box} as unknown as RunningHome);
  expect(await local.activate(f.home,f.placement)).toEqual({ok:true,value:undefined});expect(f.launches).toHaveLength(0);
  expect((await local.start(f.home,f.placement)).ok).toBe(false);
  expect((await local.activate({...f.home,epoch:4},f.placement)).ok).toBe(false);
 });
 it("launch only for the current local running home",async()=>{
  const f=runtimeFixture(), local=createLocalRuntime(f.options,f.io);
  for(const home of [null,{...f.home,machineId:hub},{...f.home,epoch:4},{...f.home,state:"stopped" as const},{...f.home,state:"moving" as const,destination:hub}]) {
   f.setHome(home as RunningHome|null);
   expect((await local.start(f.home,f.placement)).ok).toBe(false);
  }
  expect(f.launches).toHaveLength(0);
  f.setHome(f.home); f.setLock({identity:{pid:42,startIdentity:"pi-42"},bootId:"boot",pendingOperationId:null,pendingFile:null,pendingCoreId:null,operationId:null}); f.setProbe({kind:"unknown"});
  expect((await local.start(f.home,f.placement)).ok).toBe(false);expect(f.launches).toHaveLength(0);
 });
 it("lost launch reply does not spawn a second pi",async()=>{
  const f=runtimeFixture(),local=createLocalRuntime(f.options,f.io);
  f.io.launch=async request=>{f.launches.push(request);f.setTerminals([{terminal:"core:t",state:"live",pid:null}]);throw new Error("lost reply");};
  expect(await local.start(f.home,f.placement)).toMatchObject({ok:false,refusal:{code:"start-pending"}});
  expect(await local.start(f.home,f.placement)).toMatchObject({ok:false,refusal:{code:"start-pending"}});
  expect(await local.owner(id)).toEqual({kind:"unknown"});expect(f.launches).toHaveLength(1);
  f.setLock({identity:{pid:42,startIdentity:"pi-42"},bootId:"boot",pendingOperationId:null,pendingFile:null,pendingCoreId:null,operationId:null});f.setProbe({kind:"live",startIdentity:"pi-42",pi:true});f.setTerminals([{terminal:"core:t",state:"live",pid:42}]);
  expect(await local.start(f.home,f.placement)).toEqual({ok:true,value:{terminal:"core:t"}});
  expect(await local.confirm(f.home,f.placement)).toEqual({ok:true,value:{terminal:"core:t"}});
  expect(f.launches).toHaveLength(1);
 });
 it("confirm requires a live pi with the matching ID lock",async()=>{
  const f=runtimeFixture(),local=createLocalRuntime(f.options,f.io);
  f.setTerminals([{terminal:"core:t",state:"live",pid:42}]);
  expect((await local.confirm(f.home,f.placement)).ok).toBe(false);
  f.setLock({identity:{pid:42,startIdentity:"pi-42"},bootId:"boot",pendingOperationId:null,pendingFile:null,pendingCoreId:null,operationId:null});f.setProbe({kind:"live",startIdentity:"other",pi:true});
  expect((await local.confirm(f.home,f.placement)).ok).toBe(false);
 });
});
