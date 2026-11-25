import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { DEFAULT_LIMITS, disabledIntercom, type Transport } from "../contracts";
import { openJournal } from "../journal";
import { transferArtifact, handleArtifactRequest } from "../artifacts";
import { openStaging } from "../staging";
import type { ArtifactManifest } from "../contracts";
import { captureLocalSession, installLocalSession } from "../relocate/transfer";
import type { RelocateAdapterOptions, RelocateId, RelocatePlan, RunningHome } from "../relocate/types";
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
const fixtures: {close():void}[]=[];
afterEach(()=>{for(const f of fixtures.splice(0).reverse())f.close();});
const hub="11111111-1111-4111-8111-111111111111",box="22222222-2222-4222-8222-222222222222";
function transferFixture(linked=false) {
 const global=createReplica("global",hub),target=createReplica("global",box);fixtures.push(global,target);
 const base=join(global.root,"source"),repository=join(target.root,"repo");mkdirSync(base);mkdirSync(repository);
 const env={...process.env,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_AUTHOR_NAME:"Fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_NAME:"Fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid"};
 const run:RelocateAdapterOptions["git"]["run"]=async(cwd,argv,opts)=>execFileSync(argv[0],[...argv.slice(1)],{cwd,env:{...env,...opts?.env},input:opts?.stdin});
 const git=(cwd:string,...args:string[])=>execFileSync("git",args,{cwd,env}).toString().trim();
 git(base,"init","-b","main");writeFileSync(join(base,"file.txt"),"base\n");git(base,"add",".");git(base,"commit","-m","base");git(repository,"clone",base,".");
 let sourceRoot=base;
 if(linked){sourceRoot=join(global.root,"linked");git(base,"worktree","add","-b","feature",sourceRoot);}
 mkdirSync(join(sourceRoot,"sub"));writeFileSync(join(sourceRoot,"file.txt"),"staged\n");git(sourceRoot,"add","file.txt");writeFileSync(join(sourceRoot,"file.txt"),"unstaged\n");writeFileSync(join(sourceRoot,"untracked.txt"),"untracked\n");
 const file=join(global.root,"session.jsonl");writeFileSync(file,JSON.stringify({type:"session",version:3,id,cwd:join(sourceRoot,"sub"),timestamp:"2020-01-01T00:00:00Z"})+"\n"+JSON.stringify({type:"message",id:"entry-1",parentId:null,timestamp:"2020-01-01T00:00:00Z",message:{role:"user",content:[{type:"text",text:"synthetic"}]}})+"\n");
 const journal=openJournal(join(global.root,"journal.db")),targetJournal=openJournal(join(target.root,"journal.db"));
 const limits={...DEFAULT_LIMITS,chunkBytes:512,retryDelaysMs:[0]};
 const sourceHome={sessionId:id,machineId:hub,epoch:1,state:"running" as const,destination:null,moveId:null,updatedAt:1};
 const sourcePlacement={sessionId:id,machineId:hub,repoKey:"fixture-repo",workspaceId:"fixture-workspace",repository:base,cwd:join(sourceRoot,"sub"),file,stores:["global" as const],historyMachine:hub};
 const checkout=join(target.root,"checkout");
 const plan:RelocatePlan={moveId:"v0-transfer" as RelocateId,source:sourceHome,sourcePlacement,destinationPlacement:{...sourcePlacement,machineId:box,repository,cwd:join(checkout,"sub"),file:join(target.root,"installed.jsonl"),stores:["global","worktree:fixture-repo:fixture-workspace"]},destinationPrerequisites:[git(base,"rev-parse","HEAD")],startedAt:1};
 const moving={...sourceHome,state:"moving" as const,epoch:2,moveId:plan.moveId,destination:box};
 const home:RunningHome={...sourceHome,machineId:box,epoch:3,moveId:plan.moveId};
 const transport:Transport={resolve:async p=>p,bootstrapProbe:async()=>{throw new Error("unused");},exec:async()=>{throw new Error("unused");},run:async()=>({terminal:"t"}),read:async()=>Buffer.alloc(0),write:async()=>{}};
 const make=(replica:typeof global,machine:string,j:typeof journal):RelocateAdapterOptions=>({root:replica.root,globalDb:replica.db,config:{enabled:false,role:machine===hub?"hub":"box",machineId:machine,hubMachineId:hub,peers:[],discoveryRoots:[],coreUnit:"core",syncMs:10000,limits,intercom:disabledIntercom()},homes:{read:async()=>moving,list:async()=>[moving],initialize:async()=>sourceHome,compareAndSwap:async()=>({kind:"conflict",home:moving})},journal:j,sync:{start(){},stop(){},sync:async()=>[],barriers:async()=>true},transport,clock:{now:()=>1,later:()=>()=>{}},git:{run,journal:j,limits,scratch:join(replica.root,"roam","staging"),worktreeCommand:null},workspaceImport:{run,journal:j,limits,scratch:join(replica.root,"roam","staging"),worktreeCommand:null,resolveCommonRepository:async()=>repository,lastExportedSnapshot:async()=>null,verifiedArtifactPath:async()=>null},limits});
 const options=make(global,hub,journal),destination=make(target,box,targetJournal);
 target.db.prepare("INSERT INTO roam_repo_maps(repo_key,path,worktree_command_json) VALUES ('fixture-repo',?,NULL)").run(repository);
 return {options,destination,plan,home,git,base,sourceRoot,checkout,file};
}
async function receiveArtifactLocally(manifest:ArtifactManifest,source:RelocateAdapterOptions,destination:RelocateAdapterOptions) {
 const transport:Transport={...source.transport,exec:async(_peer,argv,options)=>{
   if(argv[0]!=="roam"||argv[1]!=="artifact"||argv[2]!=="receive")throw new Error("unexpected argv");
   const store=openStaging(join(destination.root,"roam","staging"),source.config.machineId,destination.limits);
   try{return await handleArtifactRequest(JSON.parse(argv[3]),options.stdin,{store,journal:destination.journal,machineId:destination.config.machineId,limits:destination.limits});}finally{store.close();}
 }};
 const peer={machineId:destination.config.machineId,alias:"peer",node:"node",pi:"pi",cli:"cli",core:"core",globalRoot:destination.root};
 const result=await transferArtifact(peer,manifest,{transport,journal:source.journal,root:join(source.root,"roam","staging"),limits:source.limits,operationId:`${manifest.id}-push`});
 if(result.code!==0)throw new Error(JSON.stringify(result));
}
describe("v0 real transfer",()=>{
 it.each([false,true])("capture preserves staged unstaged and untracked work (linked=%s)",async(linked)=>{
  const f=transferFixture(linked),head=f.git(f.sourceRoot,"rev-parse","HEAD"),branch=f.git(f.sourceRoot,"symbolic-ref","HEAD"),index=f.git(f.sourceRoot,"write-tree"),body=readFileSync(f.file);
  const result=await captureLocalSession(f.plan,f.options,async()=>({kind:"free"}));
  expect(result.ok).toBe(true);if(!result.ok)return;
  expect(result.value.workspace).toMatchObject({root:f.sourceRoot,head,branch,indexTree:index,relativeCwd:"sub",stage:"final",bundle:{kind:"ready"}});
  expect(f.git(f.sourceRoot,"rev-parse","HEAD")).toBe(head);expect(f.git(f.sourceRoot,"symbolic-ref","HEAD")).toBe(branch);expect(f.git(f.sourceRoot,"write-tree")).toBe(index);
  expect(readFileSync(join(f.sourceRoot,"file.txt"),"utf8")).toBe("unstaged\n");expect(readFileSync(join(f.sourceRoot,"untracked.txt"),"utf8")).toBe("untracked\n");expect(readFileSync(f.file)).toEqual(body);
  expect(await captureLocalSession(f.plan,f.options,async()=>({kind:"free"}))).toEqual(result);
 });
 it("install rewrites cwd and appends one segment",async()=>{
  const f=transferFixture(),captured=await captureLocalSession(f.plan,f.options,async()=>({kind:"free"}));if(!captured.ok)throw new Error(JSON.stringify(captured));
  for(const manifest of [captured.value.transcriptArtifact,captured.value.bundleArtifact])await receiveArtifactLocally(manifest,f.options,f.destination);
  const installed=await installLocalSession(f.plan,captured.value,f.home,f.destination,undefined,async()=>({kind:"free"}));
  expect(installed).toMatchObject({ok:true});if(!installed.ok)throw new Error(JSON.stringify(installed));
  const bytes=readFileSync(f.plan.destinationPlacement.file),lines=bytes.toString().trimEnd().split("\n"),header=JSON.parse(lines[0]);
  expect(header.id).toBe(id);expect(header.cwd).toBe(join(f.checkout,"sub"));expect(lines[1]).toBe(readFileSync(f.file,"utf8").trimEnd().split("\n")[1]);
  expect(bytes.toString().match(/"spider-roam-segment"/g)).toHaveLength(1);expect(bytes.toString()).toContain('"epoch":3');
  expect(f.git(f.checkout,"rev-parse","HEAD")).toBe(captured.value.workspace.head);expect(f.git(f.checkout,"write-tree")).toBe(captured.value.workspace.indexTree);expect(readFileSync(join(f.checkout,"file.txt"),"utf8")).toBe("unstaged\n");expect(readFileSync(join(f.checkout,"untracked.txt"),"utf8")).toBe("untracked\n");
  expect(await installLocalSession(f.plan,captured.value,f.home,f.destination,undefined,async()=>({kind:"free"}))).toEqual(installed);expect(readFileSync(f.plan.destinationPlacement.file)).toEqual(bytes);
 });
 it("dirty unrelated destination is unchanged",async()=>{
  const f=transferFixture();f.git(f.plan.destinationPlacement.repository,"worktree","add","--detach",f.checkout);
  writeFileSync(join(f.checkout,"file.txt"),"unrelated\n");writeFileSync(join(f.checkout,"new.txt"),"keep\n");writeFileSync(f.plan.destinationPlacement.file,"unrelated transcript\n");
  const before={head:f.git(f.checkout,"rev-parse","HEAD"),index:f.git(f.checkout,"write-tree"),file:readFileSync(join(f.checkout,"file.txt")),transcript:readFileSync(f.plan.destinationPlacement.file)};
  const captured=await captureLocalSession(f.plan,f.options,async()=>({kind:"free"}));if(!captured.ok)throw new Error(JSON.stringify(captured));
  for(const manifest of [captured.value.transcriptArtifact,captured.value.bundleArtifact])await receiveArtifactLocally(manifest,f.options,f.destination);
  expect(await installLocalSession(f.plan,captured.value,f.home,f.destination,undefined,async()=>({kind:"free"}))).toMatchObject({ok:false,refusal:{code:"destination-dirty"}});
  expect(f.git(f.checkout,"rev-parse","HEAD")).toBe(before.head);expect(f.git(f.checkout,"write-tree")).toBe(before.index);expect(readFileSync(join(f.checkout,"file.txt"))).toEqual(before.file);expect(readFileSync(f.plan.destinationPlacement.file)).toEqual(before.transcript);expect(readFileSync(join(f.checkout,"new.txt"),"utf8")).toBe("keep\n");
 });
});
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
