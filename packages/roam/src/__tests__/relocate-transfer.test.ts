import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import * as childProcess from "node:child_process";
import { once } from "node:events";
import * as handoff from "@spider/herdr/jobs/handoff";
import * as hcApi from "@spider/herdr/client/hc";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { recordLocation } from "@spider/db-core/roam/catalog";
import { DEFAULT_LIMITS, disabledIntercom, type Transport } from "../contracts";
import { openJournal } from "../journal";
import { transferArtifact, handleArtifactRequest } from "../artifacts";
import { openStaging } from "../staging";
import type { ArtifactManifest } from "../contracts";
import { captureLocalSession, installLocalSession, resolveVerifiedArtifact } from "../relocate/transfer";
import { handleRelocateAgent } from "../relocate/remote";
import { createRelocateAdapters } from "../relocate/adapters";
import type { RelocateAdapterOptions, RelocateId, RelocatePlan, RunningHome } from "../relocate/types";
import { createLocalIO, createLocalRuntime, probeLocalProcess, stopLocalSession, type LocalIO } from "../relocate/local";
import type { SessionId } from "../relocate/types";
vi.mock("node:child_process", async importOriginal => {
 const original = await importOriginal<typeof import("node:child_process")>();
 return {...original, execFileSync: vi.fn(original.execFileSync)};
});
const id="33333333-3333-4333-8333-333333333333" as SessionId;
function stopFixture() {
 let now=0, exits=false, probes=0;
 const owner={identity:{pid:42,startIdentity:"pi-42"},bootId:"boot",pendingOperationId:null,pendingFile:null,pendingCoreId:null,operationId:null};
 const signals:number[]=[];
 const events:string[]=[];
 const io:LocalIO={inspect:async()=>exits?null:owner,probe:async()=>{probes++;return exits?{kind:"absent"}:{kind:"live",startIdentity:"pi-42",pi:true};},claimFree:async()=>{events.push("lock-free");},signal:async pid=>{signals.push(pid);events.push("signal");},shutdown:async()=>{events.push("shutdown");return false;},pause:async()=>{events.push("wait");now+=10;if(now>=20)exits=true;},terminals:async()=>exits?[]:[{terminal:"t",state:"live",pid:42,owned:true}],tree:async()=>({descendants:[],groups:[]}),groupBlockers:async()=>[],writerBlockers:async()=>[],launch:async()=>({terminal:"t"})};
 return {io,signals,events,clock:{now:()=>now,later:()=>()=>{}},owner,get probes(){return probes;}};
}
const fixtures: {close():void}[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const f of fixtures.splice(0).reverse())f.close();});
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
async function receiveArtifactLocally(manifest:ArtifactManifest,source:RelocateAdapterOptions,destination:RelocateAdapterOptions,fault?:"lost"|"corrupt") {
 let injected=false;
 const transport:Transport={...source.transport,exec:async(_peer,argv,options)=>{
   if(argv[0]!=="roam"||argv[1]!=="artifact"||argv[2]!=="receive")throw new Error("unexpected argv");
   const store=openStaging(join(destination.root,"roam","staging"),source.config.machineId,destination.limits);
   try{
    const input=JSON.parse(argv[3]);let bytes=options.stdin;
    const inject=!injected && input.action==="chunk" && bytes;
    if(inject && fault==="corrupt"){bytes=Buffer.from(bytes!);bytes[0]^=1;injected=true;}
    const reply=await handleArtifactRequest(input,bytes,{store,journal:destination.journal,machineId:destination.config.machineId,limits:destination.limits});
    if(inject && fault==="lost"){injected=true;throw new Error("lost chunk acknowledgement");}
    return reply;
   }finally{store.close();}
 }};
 const peer={machineId:destination.config.machineId,alias:"peer",node:"node",pi:"pi",cli:"cli",core:"core",globalRoot:destination.root};
 const result=await transferArtifact(peer,manifest,{transport,journal:source.journal,root:join(source.root,"roam","staging"),limits:source.limits,operationId:`${manifest.id}-push`});
 if(result.code!==0)throw new Error(JSON.stringify(result));
}
describe("v0 real transfer",()=>{
 it.each(["authorize", "install"] as const)("a box disabled before moving-home replication refuses %s", async kind => {
  const f = transferFixture(), captured = await captureLocalSession(f.plan, f.options, async () => ({ kind: "free" }));
  if (!captured.ok) throw new Error(JSON.stringify(captured));
  f.destination.homes.read = async () => f.plan.source;
  const request = kind === "authorize" ? { version: 1, kind, plan: f.plan } : { version: 1, kind, plan: f.plan, captured: captured.value, home: f.home };
  expect(await handleRelocateAgent(request, f.destination)).toMatchObject({ ok: false, refusal: {
    code: "replication-disabled", nextStep: expect.stringContaining("spider roam enable"),
  } });
  expect(f.destination.journal.read(f.plan.moveId)).toEqual([]);
 });
 it("chunk retries preserve verified bytes",async()=>{
  const f=transferFixture(),captured=await captureLocalSession(f.plan,f.options,async()=>({kind:"free"}));
  if(!captured.ok)throw new Error(JSON.stringify(captured));
  for(const manifest of [captured.value.transcriptArtifact,captured.value.bundleArtifact]){
   await receiveArtifactLocally(manifest,f.options,f.destination,"lost");
   await receiveArtifactLocally(manifest,f.options,f.destination);
   const bytes=readFileSync(await resolveVerifiedArtifact(manifest,hub,f.destination));
   expect(bytes.length).toBe(manifest.byteLength);
   expect(createHash("sha256").update(bytes).digest("hex")).toBe(manifest.sha256);
  }
  const bad=transferFixture(),result=await captureLocalSession(bad.plan,bad.options,async()=>({kind:"free"}));
  if(!result.ok)throw new Error(JSON.stringify(result));
  await expect(receiveArtifactLocally(result.value.transcriptArtifact,bad.options,bad.destination,"corrupt")).rejects.toThrow();
  await expect(resolveVerifiedArtifact(result.value.transcriptArtifact,hub,bad.destination)).rejects.toThrow();
 });
 it.each([false,true])("capture preserves staged unstaged and untracked work (linked=%s)",async(linked)=>{
  const f=transferFixture(linked),head=f.git(f.sourceRoot,"rev-parse","HEAD"),branch=f.git(f.sourceRoot,"symbolic-ref","HEAD"),index=f.git(f.sourceRoot,"write-tree"),body=readFileSync(f.file);
  const result=await captureLocalSession(f.plan,f.options,async()=>({kind:"free"}));
  expect(result.ok).toBe(true);if(!result.ok)return;
  expect(result.value.workspace).toMatchObject({root:f.sourceRoot,head,branch,indexTree:index,relativeCwd:"sub",stage:"final",bundle:{kind:"ready"}});
  expect(f.git(f.sourceRoot,"rev-parse","HEAD")).toBe(head);expect(f.git(f.sourceRoot,"symbolic-ref","HEAD")).toBe(branch);expect(f.git(f.sourceRoot,"write-tree")).toBe(index);
  expect(readFileSync(join(f.sourceRoot,"file.txt"),"utf8")).toBe("unstaged\n");expect(readFileSync(join(f.sourceRoot,"untracked.txt"),"utf8")).toBe("untracked\n");expect(readFileSync(f.file)).toEqual(body);
  expect(await captureLocalSession(f.plan,f.options,async()=>({kind:"free"}))).toEqual(result);
 });
 it.each([false,true])("install rewrites only the header and preserves the exact body (linked=%s)",async(linked)=>{
  const f=transferFixture(linked),captured=await captureLocalSession(f.plan,f.options,async()=>({kind:"free"}));if(!captured.ok)throw new Error(JSON.stringify(captured));
  for(const manifest of [captured.value.transcriptArtifact,captured.value.bundleArtifact])await receiveArtifactLocally(manifest,f.options,f.destination);
  const installed=await installLocalSession(f.plan,captured.value,f.home,f.destination,undefined,async()=>({kind:"free"}));
  expect(installed).toMatchObject({ok:true});if(!installed.ok)throw new Error(JSON.stringify(installed));
  const bytes=readFileSync(f.plan.destinationPlacement.file),lines=bytes.toString().trimEnd().split("\n"),header=JSON.parse(lines[0]);
  expect(header.id).toBe(id);expect(header.cwd).toBe(join(f.checkout,"sub"));expect(lines[1]).toBe(readFileSync(f.file,"utf8").trimEnd().split("\n")[1]);
  const original=readFileSync(f.file);
  expect(bytes.subarray(bytes.indexOf(10)+1)).toEqual(original.subarray(original.indexOf(10)+1));
  expect(installed.value.session.leaf).toBe(captured.value.session.leaf);
  expect(installed.value.session.historySha256).toBe(captured.value.session.historySha256);
  if(linked) {
   expect(f.git(f.checkout,"symbolic-ref","HEAD")).toBe(captured.value.workspace.branch);
   expect(installed.value.branchDetached).toBeUndefined();
  } else {
   expect(f.destination.journal.read(f.plan.moveId)).toEqual(expect.arrayContaining([expect.objectContaining({action:"workspace-branch-conflict"})]));
   expect(installed.value.branchDetached).toBe(true);
  }
  expect(f.git(f.checkout,"rev-parse","HEAD")).toBe(captured.value.workspace.head);expect(f.git(f.checkout,"write-tree")).toBe(captured.value.workspace.indexTree);expect(readFileSync(join(f.checkout,"file.txt"),"utf8")).toBe("unstaged\n");expect(readFileSync(join(f.checkout,"untracked.txt"),"utf8")).toBe("untracked\n");
  expect(await installLocalSession(f.plan,captured.value,f.home,f.destination,undefined,async()=>({kind:"free"}))).toEqual(installed);expect(readFileSync(f.plan.destinationPlacement.file)).toEqual(bytes);
 });
 it("relocating a fork rewrites the cwd and keeps every other transcript byte",async()=>{
  const f=transferFixture(true);
  const original=readFileSync(f.file,"utf8").replace('"cwd":',String.raw`"parentSession" : "\u002fprivate\u002fparent.jsonl",  "cwd":`);
  writeFileSync(f.file,original);
  const captured=await captureLocalSession(f.plan,f.options,async()=>({kind:"free"}));
  if(!captured.ok)throw new Error(JSON.stringify(captured));
  for(const manifest of [captured.value.transcriptArtifact,captured.value.bundleArtifact])await receiveArtifactLocally(manifest,f.options,f.destination);
  const installed=await installLocalSession(f.plan,captured.value,f.home,f.destination,undefined,async()=>({kind:"free"}));
  expect(installed).toMatchObject({ok:true});
  const expected=original.replace(JSON.stringify(f.plan.sourcePlacement.cwd),JSON.stringify(f.plan.destinationPlacement.cwd));
  expect(readFileSync(f.plan.destinationPlacement.file,"utf8")).toBe(expected);
  expect(await installLocalSession(f.plan,captured.value,f.home,f.destination,undefined,async()=>({kind:"free"}))).toEqual(installed);
  expect(readFileSync(f.plan.destinationPlacement.file,"utf8")).toBe(expected);
 });
 it.each([true, false])("checks ownership after catalog-only replication (checkout exists: %s)", async exists => {
  const f=transferFixture();
  recordLocation(f.destination.globalDb,{sessionId:id,stores:["worktree:fixture-repo:fixture-workspace"],home:f.plan.source});
  vi.spyOn(hcApi,"invokeCli").mockResolvedValue({terminals:[]});
  const captured=await captureLocalSession(f.plan,f.options,async()=>({kind:"free"}));
  if(!captured.ok)throw new Error(JSON.stringify(captured));
  for(const manifest of [captured.value.transcriptArtifact,captured.value.bundleArtifact])await receiveArtifactLocally(manifest,f.options,f.destination);
  if (!exists) {
   const installed=await installLocalSession(f.plan,captured.value,f.home,f.destination);
   expect(installed.ok,installed.ok ? undefined : installed.refusal.message).toBe(true);
   return;
  }
  f.git(f.plan.destinationPlacement.repository,"worktree","add","--detach",f.checkout);
  mkdirSync(f.plan.destinationPlacement.cwd);
  const child=spawn(process.execPath,["-e",`process.title = "pi";
    process.once("message", () => process.exit(0)); process.send("ready");`],
    {cwd:f.plan.destinationPlacement.cwd,stdio:["ignore","ignore","ignore","ipc"]});
  const exited=once(child,"exit");
  try {
   expect((await Promise.race([once(child,"message"),exited]))[0]).toBe("ready");
   const adapters=createRelocateAdapters(f.destination);
   expect(await adapters.ports.installDestination(f.plan,captured.value,f.home)).toMatchObject({ok:false,refusal:{code:"install-failed",message:expect.stringContaining("occupied or uncertain")}});
   expect(child.exitCode).toBeNull();
   expect(readFileSync(join(f.checkout,"file.txt"),"utf8")).toBe("base\n");
  } finally {
   if(child.connected)child.send("exit");
   await exited;
  }
 });
 it("does not install when a local transcript is catalogued without its checkout", async () => {
  const f=transferFixture();
  vi.spyOn(hcApi,"invokeCli").mockResolvedValue({terminals:[]});
  const file=f.plan.destinationPlacement.file;
  writeFileSync(file,"unverified local transcript\n");
  recordLocation(f.destination.globalDb,{sessionId:id,stores:["worktree:fixture-repo:fixture-workspace"],home:f.plan.source,file});
  const captured=await captureLocalSession(f.plan,f.options,async()=>({kind:"free"}));
  if(!captured.ok)throw new Error(JSON.stringify(captured));
  for(const manifest of [captured.value.transcriptArtifact,captured.value.bundleArtifact])await receiveArtifactLocally(manifest,f.options,f.destination);
  expect(await installLocalSession(f.plan,captured.value,f.home,f.destination)).toMatchObject({ok:false,refusal:{code:"install-failed",message:expect.stringContaining("occupied or uncertain")}});
  expect(readFileSync(file,"utf8")).toBe("unverified local transcript\n");
 });
 it("does not prove a moving source stopped from only its catalog row", async () => {
  const f=transferFixture();
  vi.spyOn(hcApi,"invokeCli").mockResolvedValue({terminals:[]});
  recordLocation(f.destination.globalDb,{sessionId:id,stores:["worktree:fixture-repo:fixture-workspace"],home:f.plan.source});
  const moving={...f.home,state:"moving" as const,epoch:4,destination:hub,moveId:f.plan.moveId};
  f.destination.homes.read=async()=>moving;
  await expect(createLocalIO(f.destination).writerBlockers(id,undefined,true)).rejects.toThrow("The session has no verifiable checkout");
  expect(await createLocalRuntime(f.destination).stop(id,moving)).toMatchObject({ok:false,refusal:{code:"stop-timeout"}});
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
describe("local process probe", () => {
 it.each([
  {name: "exited", next: null, expected: {kind: "absent"}},
  {name: "reused its PID", next: "replacement", expected: {kind: "absent"}},
  {name: "remained unreadable", next: "original", expected: {kind: "unknown"}},
 ])("classifies a process that $name after a failed command read", async ({next, expected}) => {
  vi.spyOn(handoff, "processStartIdentity").mockReturnValueOnce("original").mockReturnValueOnce(next);
  vi.mocked(childProcess.execFileSync).mockImplementationOnce(() => { throw new Error("ps failed"); });

  expect(await probeLocalProcess(44)).toEqual(expected);
 });
 it("keeps an unreadable identity unknown after a failed command read", async () => {
  vi.spyOn(handoff, "processStartIdentity")
   .mockReturnValueOnce("original")
   .mockImplementationOnce(() => { throw new Error("identity unavailable"); });
  vi.mocked(childProcess.execFileSync).mockImplementationOnce(() => { throw new Error("ps failed"); });

  expect(await probeLocalProcess(44)).toEqual({kind: "unknown"});
 });
});
describe("v0 transfer stop boundary",()=>{
 it("refuses before signalling when any descendant is unreadable", async () => {
  const f = stopFixture();
  const first = {pid: 43, startIdentity: "tool-43", command: "bash"};
  const unreadable = {pid: 44, startIdentity: "tool-44", command: "worker"};
  f.io.tree = async () => ({descendants: [first, unreadable], groups: []});
  const probe = f.io.probe;
  f.io.probe = async pid => pid === first.pid
   ? {kind: "live", startIdentity: first.startIdentity, pi: false}
   : pid === unreadable.pid ? {kind: "unknown"} : probe(pid);

  expect(await stopLocalSession(id, null, f.io, f.clock, 30)).toMatchObject({
   ok: false, refusal: {code: "session-busy", message: expect.stringContaining("PID 44")},
  });
  expect(f.signals).toEqual([]);
 });
 it("stops when signalling a descendant makes its child exit", async () => {
  const f = stopFixture();
  const parent = {pid: 43, startIdentity: "parent-43", command: "wrapper"};
  const child = {pid: 44, startIdentity: "child-44", command: "tool"};
  let parentLive = true, childLive = true, childWasProbed = false;
  f.io.tree = async () => ({descendants: [parent, child], groups: []});
  const probe = f.io.probe;
  f.io.probe = async pid => {
   if (pid === parent.pid) return parentLive ? {kind: "live", startIdentity: parent.startIdentity, pi: false} : {kind: "absent"};
   if (pid === child.pid) {
    if (!childLive) return childWasProbed ? {kind: "absent"} : {kind: "unknown"};
    childWasProbed = true;
    return {kind: "live", startIdentity: child.startIdentity, pi: false};
   }
   return probe(pid);
  };
  f.io.signal = async pid => {
   if (pid === child.pid && !childLive) throw Object.assign(new Error("process exited"), {code: "ESRCH"});
   f.signals.push(pid);
   if (pid === parent.pid) parentLive = childLive = false;
  };

  expect(await stopLocalSession(id, null, f.io, f.clock, 30)).toEqual({ok: true, value: undefined});
  expect(f.signals).toEqual([43, 42]);
 });
 it("does not signal a descendant PID reused during shutdown", async () => {
  const f = stopFixture();
  const first = {pid: 43, startIdentity: "first-43", command: "wrapper"};
  const child = {pid: 44, startIdentity: "child-44", command: "tool"};
  let firstLive = true, childIdentity = child.startIdentity;
  f.io.tree = async () => ({descendants: [first, child], groups: []});
  const probe = f.io.probe;
  f.io.probe = async pid => {
   if (pid === first.pid) return firstLive ? {kind: "live", startIdentity: first.startIdentity, pi: false} : {kind: "absent"};
   if (pid === child.pid) return {kind: "live", startIdentity: childIdentity, pi: false};
   return probe(pid);
  };
  f.io.signal = async pid => {
   f.signals.push(pid);
   if (pid === first.pid) { firstLive = false; childIdentity = "replacement-44"; }
  };

  expect(await stopLocalSession(id, null, f.io, f.clock, 30)).toEqual({ok: true, value: undefined});
  expect(f.signals).toEqual([43, 42]);
 });
 it("ignores a descendant that is already absent", async () => {
  const f = stopFixture();
  const child = {pid: 43, startIdentity: "child-43", command: "tool"};
  f.io.tree = async () => ({descendants: [child], groups: []});
  const probe = f.io.probe;
  f.io.probe = async pid => pid === child.pid ? {kind: "absent"} : probe(pid);

  expect(await stopLocalSession(id, null, f.io, f.clock, 30)).toEqual({ok: true, value: undefined});
  expect(f.signals).toEqual([42]);
 });
 it("accepts a descendant exiting between its final check and signal", async () => {
  const f = stopFixture();
  const child = {pid: 43, startIdentity: "child-43", command: "tool"};
  let childLive = true;
  f.io.tree = async () => ({descendants: [child], groups: []});
  const probe = f.io.probe;
  f.io.probe = async pid => pid === child.pid
   ? childLive ? {kind: "live", startIdentity: child.startIdentity, pi: false} : {kind: "absent"}
   : probe(pid);
  f.io.signal = async pid => {
   if (pid === child.pid) {
    childLive = false;
    throw Object.assign(new Error("process exited"), {code: "ESRCH"});
   }
   f.signals.push(pid);
  };

  expect(await stopLocalSession(id, null, f.io, f.clock, 30)).toEqual({ok: true, value: undefined});
  expect(f.signals).toEqual([42]);
 });
 it("does not ignore a denied descendant signal", async () => {
  const f = stopFixture();
  const child = {pid: 43, startIdentity: "child-43", command: "tool"};
  f.io.tree = async () => ({descendants: [child], groups: []});
  const probe = f.io.probe;
  f.io.probe = async pid => pid === child.pid ? {kind: "live", startIdentity: child.startIdentity, pi: false} : probe(pid);
  f.io.signal = async pid => {
   if (pid === child.pid) throw Object.assign(new Error("permission denied"), {code: "EPERM"});
   f.signals.push(pid);
  };

  expect(await stopLocalSession(id, null, f.io, f.clock, 30)).toMatchObject({ok: false, refusal: {code: "stop-timeout"}});
  expect(f.signals).toEqual([]);
 });
 it("counts an unreadable descendant as alive until the deadline", async () => {
  const f = stopFixture();
  const child = {pid: 43, startIdentity: "child-43", command: "tool"};
  let signalled = false;
  f.io.tree = async () => ({descendants: [child], groups: []});
  const probe = f.io.probe;
  f.io.probe = async pid => pid === child.pid
   ? signalled ? {kind: "unknown"} : {kind: "live", startIdentity: child.startIdentity, pi: false}
   : probe(pid);
  f.io.signal = async pid => { f.signals.push(pid); if (pid === child.pid) signalled = true; };

  expect(await stopLocalSession(id, null, f.io, f.clock, 30)).toMatchObject({
   ok: false, refusal: {code: "session-busy", message: expect.stringContaining("PID 43")},
  });
  expect(f.signals).toEqual([43, 42]);
  expect(f.events).not.toContain("lock-free");
  expect(f.clock.now()).toBe(30);
 });
 it("waits for verified tool descendants even after the locked pi exits", async () => {
  const f = stopFixture();
  const child = {pid: 43, startIdentity: "tool-43", command: "bash"};
  f.io.tree = async () => ({descendants:[child],groups:[]});
  f.io.terminals = async () => (await f.io.inspect(id)) ? [{state: "live", terminal: "t", pid: 42, owned: true}] : [];
  const probe = f.io.probe;
  let ticks = 0;
  f.io.probe = async pid => pid === child.pid
   ? ticks < 3 ? {kind: "live", startIdentity: child.startIdentity, pi: false} : {kind: "absent"}
   : probe(pid);
  const pause = f.io.pause;
  f.io.pause = async ms => { ticks++; await pause(ms); };
  expect(await stopLocalSession(id, null, f.io, f.clock, 30)).toEqual({ok: true, value: undefined});
  expect(f.signals).toEqual([43, 42]);
  expect(ticks).toBe(3);
 });
 it("does not acknowledge stop while an observed tool process group still has a writer", async () => {
  const f = stopFixture();
  f.io.tree = async () => ({descendants: [], groups: [43]});
  f.io.groupBlockers = async groups => groups.includes(43) ? ["PID 44 (bash)"] : [];
  const result = await stopLocalSession(id, null, f.io, f.clock, 30);
  expect(result).toMatchObject({ok: false, refusal: {code: "session-busy", message: expect.stringContaining("PID 44 (bash)"), nextStep: "Close these, then rerun relocate."}});
  expect(f.signals).toEqual([42]);
 });
 it("refuses to signal an ordinary pi even when it owns the session ID lock", async () => {
  const f = stopFixture();
  f.io.terminals = async () => [];
  expect(await stopLocalSession(id, null, f.io, f.clock, 30)).toMatchObject({ok: false, refusal: {code: "session-busy", message: expect.stringContaining("PID 42 (pi)")}});
  expect(f.signals).toEqual([]);
 });
 it("stops a blocked Spider launch that never acquired the ID lock", async () => {
  const f = stopFixture();
  let live = true;
  f.io.inspect = async () => null;
  f.io.terminals = async () => live ? [{terminal:"t",state:"live",pid:42,owned:true}] : [];
  f.io.probe = async () => live ? {kind:"live",startIdentity:"pi-42",pi:true} : {kind:"absent"};
  f.io.signal = async pid => { f.signals.push(pid); live = false; };
  const moving = {sessionId:id,machineId:hub,epoch:2,state:"moving" as const,destination:box,moveId:"v0-blocked" as RelocateId,updatedAt:1};
  expect(await stopLocalSession(id,moving,f.io,f.clock,30)).toEqual({ok:true,value:undefined});
  expect(f.signals).toEqual([42]);
 });
 it.each(["reused pid", "other lock", "unowned terminal"])("does not signal a lockless launch when it finds %s", async fault => {
  const f = stopFixture();
  let checked = false;
  f.io.inspect = async () => checked && fault === "other lock" ? {...f.owner,identity:{pid:99,startIdentity:"other"}} : null;
  f.io.terminals = async () => [{terminal:"t",state:"live",pid:42,owned: fault === "unowned terminal" ? undefined : true}];
  f.io.probe = async () => ({kind:"live",startIdentity:checked && fault === "reused pid" ? "other" : "pi-42",pi:true});
  f.io.tree = async () => { checked = true; return {descendants:[],groups:[]}; };
  expect(await stopLocalSession(id,null,f.io,f.clock,30)).toMatchObject({ok:false,refusal:{code:"session-busy"}});
  expect(f.signals).toEqual([]);
 });
 it("shutdown fallback waits for the ID lock",async()=>{
  const f=stopFixture();let capture=false;
  const done=stopLocalSession(id,null,f.io,f.clock,30).then(r=>{if(r.ok){capture=true;f.events.push("capture");}return r;});
  expect(capture).toBe(false);
  expect(await done).toEqual({ok:true,value:undefined});
  expect(f.signals).toEqual([42]);
  expect(f.events.indexOf("capture")).toBeGreaterThan(f.events.indexOf("lock-free"));
  expect(f.events.filter(e=>e==="wait")).toHaveLength(2);
 });
 it.each([true,false])("waits for the stopped terminal to clear within the deadline (clears=%s)",async clears=>{
  const f = stopFixture();
  const pause = f.io.pause;
  let ticks = 0;
  f.io.pause = async ms => { ticks++; await pause(ms); };
  f.io.terminals = async () => clears && ticks >= 3 ? [] : [{terminal:"t",state:"live",pid:42,owned:true}];
  const result = await stopLocalSession(id,null,f.io,f.clock,30);
  if (clears) expect(result).toEqual({ok:true,value:undefined});
  else expect(result).toMatchObject({ok:false,refusal:{code:"session-busy",message:expect.stringContaining("PID 42")}});
  expect(f.signals).toEqual([42]);
  expect(ticks).toBe(3);
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
