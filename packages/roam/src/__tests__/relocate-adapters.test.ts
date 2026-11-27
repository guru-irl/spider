import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { mapWorkspace } from "@spider/db-core/roam/repo-map";
import { replicaPath } from "@spider/db-core/roam/catalog";
import { createSync } from "../sync";
import { captureLocalSession } from "../relocate/transfer";
import { execFileSync } from "node:child_process";
import { afterEach } from "vitest";
import { createReplica } from "@spider/db-core/testutil";
import { writeLocal } from "@spider/db-core/roam/local-state";
import { recordLocation } from "@spider/db-core/roam/catalog";
import { createStorePort } from "../stores";
import { DEFAULT_LIMITS, disabledIntercom } from "../contracts";
import { inspectLocalSource, inspectLocalDestination, seedLocalPlacement } from "../relocate/local";
import type { RelocateAdapterOptions } from "../relocate/types";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openJournal } from "../journal";
import { createRelocateJournal } from "../relocate/journal";
import { createV0SyncTransport, handleRelocateAgent } from "../relocate/remote";
import { createRelocateAdapters } from "../relocate/adapters";
import type { Peer, Transport } from "../contracts";
import type { RelocateCheckpoint, RelocateId, SessionId } from "../relocate/types";
import type { MachineId } from "@spider/db-core/roam/types";
const hub = "11111111-1111-4111-8111-111111111111" as MachineId;
const box = "22222222-2222-4222-8222-222222222222" as MachineId;
const id = "33333333-3333-4333-8333-333333333333" as SessionId;
function checkpoint(): RelocateCheckpoint {
  const source = {sessionId:id,machineId:hub,epoch:1,moveId:null,updatedAt:1,state:"running" as const,destination:null};
  const placement = {sessionId:id,machineId:hub,repoKey:"repo",workspaceId:"workspace",repository:"/source",cwd:"/source/sub",file:"/sessions/source.jsonl",stores:["global" as const],historyMachine:hub};
  return {plan:{moveId:"v0-journal" as RelocateId,source,sourcePlacement:placement,destinationPlacement:{...placement,machineId:box,repository:"/destination",cwd:"/destination/sub",file:"/sessions/destination.jsonl"},destinationPrerequisites:[],startedAt:1},completed:["check"],captured:null,installed:null,terminal:null,result:null};
}
const fixtures: {close():void}[] = [];
afterEach(()=>{for(const f of fixtures.splice(0).reverse())f.close();});
function adapterFixture() {
 const global=createReplica("global",hub),repo=createReplica("repo",hub),worktree=createReplica("worktree",hub);fixtures.push(global,repo,worktree);
 const root=join(global.root,"checkout");mkdirSync(root);
 const run:RelocateAdapterOptions["git"]["run"]=async(cwd,argv,opts)=>execFileSync(argv[0],[...argv.slice(1)],{cwd,input:opts?.stdin,env:{...process.env,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_AUTHOR_NAME:"Fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_NAME:"Fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid",...opts?.env}});
 execFileSync("git",["init","-b","main",root]);writeFileSync(join(root,"file.txt"),"base\n");execFileSync("git",["-C",root,"add","."]);execFileSync("git",["-C",root,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","base"]);
 mkdirSync(join(root,"sub"));const file=join(global.root,"session.jsonl");writeFileSync(file,JSON.stringify({type:"session",version:3,id,cwd:join(root,"sub"),timestamp:"2020-01-01T00:00:00Z"})+"\n"+JSON.stringify({type:"message",id:"entry-1",parentId:null,timestamp:"2020-01-01T00:00:00Z",message:{role:"user",content:[{type:"text",text:"synthetic"}]}})+"\n");
 global.db.prepare("INSERT INTO roam_repo_maps(repo_key,path,worktree_command_json) VALUES ('fixture-repo',?,NULL)").run(root);
 global.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','fixture-workspace',?)").run(root);
 writeLocal(global.db,"mapping-redirect",repo.storeKey,repo.db.raw.name);writeLocal(global.db,"mapping-redirect",worktree.storeKey,worktree.db.raw.name);
 worktree.db.prepare("INSERT INTO sessions(id,name,started_at) VALUES (?, 'synthetic',1)").run(id);worktree.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,1,'active')").run(id);
 recordLocation(global.db,{sessionId:id,stores:["global",repo.storeKey,worktree.storeKey],home:{sessionId:id,machineId:hub,epoch:1,moveId:null,updatedAt:1},file,cwd:join(root,"sub")});
 const config={enabled:true,role:"hub" as const,machineId:hub,hubMachineId:hub,peers:[],discoveryRoots:[],coreUnit:"core",syncMs:10000,limits:DEFAULT_LIMITS,intercom:disabledIntercom()};
 const journal=openJournal(join(global.root,"journal.db")),git={run,journal,limits:DEFAULT_LIMITS,scratch:join(global.root,"git"),worktreeCommand:null};
 const options:RelocateAdapterOptions={root:global.root,config,globalDb:global.db,homes:{read:async()=>null,list:async()=>[],initialize:async()=>({...checkpoint().plan.source,state:"running" as const}),compareAndSwap:async()=>({kind:"conflict",home:null})},journal,sync:{start(){},stop(){},sync:async()=>[],barriers:async()=>true},transport:{resolve:async p=>p,bootstrapProbe:async()=>{throw new Error("unused");},exec:async()=>{throw new Error("unexpected remote");},run:async()=>({terminal:"t"}),read:async()=>Buffer.alloc(0),write:async()=>{}},clock:{now:()=>1,later:()=>()=>{}},git,workspaceImport:{...git,resolveCommonRepository:async()=>root,lastExportedSnapshot:async()=>null,verifiedArtifactPath:async()=>null},limits:DEFAULT_LIMITS};
 return {options,global,repo,worktree,root,file};
}
describe("relocate adapters", () => {
  it("authorizes a revisit past a stale moving replica but rejects newer homes",async()=>{
    const f=adapterFixture(),source=await inspectLocalSource(id,f.options);if(!source.ok)throw new Error("source missing");
    const target=createReplica("global",box);fixtures.push(target);
    target.db.prepare("INSERT INTO roam_repo_maps(repo_key,path,worktree_command_json) VALUES ('fixture-repo',?,NULL)").run(f.root);
    f.options={...f.options,root:target.root,globalDb:target.db,journal:openJournal(join(target.root,"journal.db")),config:{...f.options.config,machineId:box,role:"box"}};
    const plan={...checkpoint().plan,source:{...checkpoint().plan.source,epoch:9},sourcePlacement:source.value.placement,destinationPlacement:{...source.value.placement,machineId:box}};
    const stale={...plan.source,machineId:box,epoch:8,state:"moving" as const,destination:hub,moveId:"v0-prior" as RelocateId};
    f.options.homes.read=async()=>stale;
    expect(await handleRelocateAgent({version:1,kind:"authorize",plan},f.options)).toEqual({ok:true,value:{version:1}});
    expect(await f.options.homes.read(id)).toEqual(stale);
    expect(await handleRelocateAgent({version:1,kind:"data",operation:{id:"stale-home-inventory",machineId:box,expectedEpoch:null,kind:"inventory",args:{storeKey:"worktree:fixture-repo:fixture-workspace"}}},f.options)).toMatchObject({ok:true});
    f.options.homes.read=async()=>({...stale,epoch:9});
    expect(await handleRelocateAgent({version:1,kind:"authorize",plan},f.options)).toMatchObject({ok:false,refusal:{code:"home-conflict"}});
    f.options.homes.read=async()=>({...stale,epoch:11});
    expect(await handleRelocateAgent({version:1,kind:"authorize",plan},f.options)).toMatchObject({ok:false,refusal:{code:"home-conflict"}});
  });
  it("remote forced activation first delivers the authoritative home",async()=>{
    const f=adapterFixture(),global=createReplica("global",box),repo=createReplica("repo",box),worktree=createReplica("worktree",box);fixtures.push(global,repo,worktree);
    global.db.prepare("INSERT INTO roam_repo_maps(repo_key,path,worktree_command_json) VALUES ('fixture-repo',?,NULL)").run(f.root);
    global.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','fixture-workspace',?)").run(f.root);
    writeLocal(global.db,"mapping-redirect",repo.storeKey,repo.db.raw.name);writeLocal(global.db,"mapping-redirect",worktree.storeKey,worktree.db.raw.name);
    const source=await inspectLocalSource(id,f.options);if(!source.ok)throw new Error("source missing");
    const home={...checkpoint().plan.source,state:"running" as const,machineId:box,epoch:16,moveId:"v0-forced" as RelocateId};
    let targetHome:Awaited<ReturnType<RelocateAdapterOptions["homes"]["read"]>>={...home,epoch:14,state:"moving",destination:hub,moveId:"v0-old" as RelocateId};
    const destination:RelocateAdapterOptions={...f.options,root:global.root,globalDb:global.db,journal:openJournal(join(global.root,"journal.db")),config:{...f.options.config,machineId:box,role:"box"},homes:{...f.options.homes,read:async()=>targetHome}};
    const peer:Peer={machineId:box,alias:"peer",node:"node",pi:"pi",cli:"cli",core:"core",globalRoot:global.root};f.options.config={...f.options.config,peers:[peer]};
    let activated=0;
    f.options.transport={...f.options.transport,exec:async(_peer,_argv,input)=>{activated++;return Buffer.from(JSON.stringify(await handleRelocateAgent(JSON.parse(input.stdin!.toString()),destination)));}};
    f.options.sync.sync=async machine=>{if(machine!==box)throw new Error("wrong destination");targetHome=home;return [];};
    const adapters=createRelocateAdapters(f.options),placement={...source.value.placement,machineId:box};
    expect(await adapters.setHome.activate(home,placement)).toEqual({ok:true,value:undefined});
    expect(worktree.db.prepare("SELECT epoch,state FROM roam_sessions WHERE session_id=?").get(id)).toEqual({epoch:16,state:"active"});
    const previous=activated;f.options.sync.sync=async()=>{throw new Error("offline");};
    expect(await adapters.setHome.activate(home,placement)).toMatchObject({ok:false,refusal:{code:"sync-failed"}});
    expect(activated).toBe(previous);
  });
  it("source readiness precedes home initialization",async()=>{
    const f=adapterFixture();
    expect(await inspectLocalSource(id,f.options)).toMatchObject({ok:true,value:{epoch:1,state:"active",placement:{cwd:join(f.root,"sub"),repository:f.root},root:f.root,relativeCwd:"sub"}});
    f.worktree.db.prepare("UPDATE roam_sessions SET state='frozen' WHERE session_id=?").run(id);
    expect(await inspectLocalSource(id,f.options)).toMatchObject({ok:false});
    f.worktree.db.prepare("DELETE FROM roam_sessions").run();expect((await inspectLocalSource(id,f.options)).ok).toBe(false);
    f.global.db.prepare("DELETE FROM roam_locations").run();expect(await inspectLocalSource(id,f.options)).toMatchObject({ok:false,refusal:{code:"session-not-found"}});
  });
  it("source is seeded while active and not during final pull",async()=>{
    const f=adapterFixture(),result=await inspectLocalSource(id,f.options);
    if(!result.ok)throw new Error("source missing");
    await seedLocalPlacement(result.value.placement,1,f.options);
    expect(f.global.db.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({capture_enabled:1});
    expect(f.repo.db.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({capture_enabled:1});
    expect(f.worktree.db.prepare("SELECT entity FROM roam_changes WHERE writer_session=?").all(id)).toEqual([{entity:"sessions"}]);
    f.worktree.db.prepare("UPDATE roam_sessions SET state='frozen'").run();
    await expect(seedLocalPlacement(result.value.placement,1,f.options)).rejects.toThrow();
  });
  it("check requires reachable v0 peers and a mapped normal repo",async()=>{
    const f=adapterFixture(),source=await inspectLocalSource(id,f.options);if(!source.ok)throw new Error("source missing");
    f.options.config={...f.options.config,machineId:box,role:"box"};
    const mapped=await inspectLocalDestination(source.value.placement,"sub",f.options);
    expect(mapped).toMatchObject({ok:true,value:{placement:{machineId:box,repository:f.root,cwd:join(f.root,"sub")}}});
    f.global.db.prepare("UPDATE roam_repo_maps SET worktree_command_json='[\"tool\"]'").run();expect(await inspectLocalDestination(source.value.placement,"sub",f.options)).toMatchObject({ok:false,refusal:{code:"unsupported-workspace"}});
    f.global.db.prepare("UPDATE roam_repo_maps SET worktree_command_json=NULL").run();await f.options.git.run(f.root,["git","config","core.sparseCheckout","true"]);expect(await inspectLocalDestination(source.value.placement,"sub",f.options)).toMatchObject({ok:false,refusal:{code:"unsupported-workspace"}});
    await f.options.git.run(f.root,["git","config","core.sparseCheckout","false"]);f.global.db.prepare("DELETE FROM roam_repo_maps").run();expect(await inspectLocalDestination(source.value.placement,"sub",f.options)).toMatchObject({ok:false,refusal:{code:"repo-unmapped"}});
  });
  it("incoming worktree rows arrive before checkout install",async()=>{
    const f=adapterFixture(),global=createReplica("global",box),repo=createReplica("repo",box);fixtures.push(global,repo);
    const repository=join(global.root,"repo");execFileSync("git",["clone",f.root,repository],{stdio:"pipe"});
    global.db.prepare("INSERT INTO roam_repo_maps(repo_key,path,worktree_command_json) VALUES ('fixture-repo',?,NULL)").run(repository);writeLocal(global.db,"mapping-redirect",repo.storeKey,repo.db.raw.name);
    const peer:Peer={machineId:box,alias:"peer",node:"node",pi:"pi",cli:"cli",core:"core",globalRoot:global.root};f.options.config={...f.options.config,peers:[peer]};
    const localSource=await inspectLocalSource(id,f.options);if(!localSource.ok)throw new Error(JSON.stringify(localSource));
    const destination:RelocateAdapterOptions={...f.options,root:global.root,globalDb:global.db,config:{...f.options.config,role:"box",machineId:box,peers:[{...peer,machineId:hub,globalRoot:f.options.root}]},journal:openJournal(join(global.root,"journal.db"))};
    const localDestination=await inspectLocalDestination(localSource.value.placement,"sub",destination);if(!localDestination.ok)throw new Error(JSON.stringify(localDestination));
    const plan={moveId:"v0-incoming" as RelocateId,source:checkpoint().plan.source,sourcePlacement:localSource.value.placement,destinationPlacement:localDestination.value.placement,destinationPrerequisites:[localDestination.value.head],startedAt:1};
    const moving={...plan.source,state:"moving" as const,epoch:2,moveId:plan.moveId,destination:box};f.options.homes.read=destination.homes.read=async()=>moving;f.options.homes.list=destination.homes.list=async()=>[moving];
    await seedLocalPlacement(localSource.value.placement,1,f.options);f.global.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES (?,?,2,?,1)").run(id,hub,plan.moveId);
    f.worktree.db.prepare("UPDATE roam_sessions SET state='frozen'").run();
    const raw:Transport={...f.options.transport,exec:async(_peer,argv,options)=>{
      if(argv[1]==="agent")return Buffer.from(JSON.stringify(await handleRelocateAgent(JSON.parse(options.stdin!.toString()),destination)));
      if(argv[1]==="artifact"){const result=await handleRelocateAgent({version:1,kind:"artifact",sourceMachine:hub,input:JSON.parse(argv[3]),bytes:options.stdin?.toString("base64")??null},destination);if(!result.ok)throw new Error(JSON.stringify(result));return Buffer.from(JSON.stringify((result.value as {wire:unknown}).wire));}
      throw new Error("unexpected private command");
    },read:async(_peer,file)=>readFileSync(file)};
    f.options.transport=raw;
    const stores=createStorePort(f.options.config,f.global.db);fixtures.push(stores);
    const sync=createSync({config:f.options.config,globalDb:f.global.db,transport:createV0SyncTransport(raw),journal:f.options.journal,clock:f.options.clock,stores});f.options.sync=sync;
    const adapters=createRelocateAdapters(f.options),captured=await captureLocalSession(plan,f.options,async()=>({kind:"free"}));if(!captured.ok)throw new Error(JSON.stringify(captured));
    const sourceBytes=readFileSync(join(f.root,"file.txt")),targetBytes=readFileSync(join(repository,"file.txt"));
    expect(await adapters.ports.pushDestination(plan,captured.value)).toEqual({ok:true,value:undefined});
    const key="worktree:fixture-repo:fixture-workspace" as const;
    expect(existsSync(replicaPath(global.db,key))).toBe(true);expect(existsSync(join(localDestination.value.placement.cwd,".."))).toBe(false);
    const incoming=createStorePort(destination.config,global.db,{unmappedWorktree:key});
    try{expect(incoming.openStore(key).db.prepare("SELECT id FROM sessions WHERE id=?").all(id)).toEqual([{id}]);}finally{incoming.close();}
    expect(await handleRelocateAgent({version:1,kind:"data",operation:{id:"unrelated",machineId:box,expectedEpoch:null,kind:"inventory",args:{storeKey:"worktree:unrelated:other"}}},destination)).toMatchObject({ok:false,refusal:{code:"repo-unmapped"}});
    expect(readFileSync(join(f.root,"file.txt"))).toEqual(sourceBytes);expect(readFileSync(join(repository,"file.txt"))).toEqual(targetBytes);
    const checkout=join(localDestination.value.placement.cwd,"..");execFileSync("git",["-C",repository,"worktree","add","--detach",checkout],{stdio:"pipe"});
    await mapWorkspace(global.db,{repoKey:"fixture-repo",workspaceId:"fixture-workspace",path:checkout});
    const attached=createStorePort(destination.config,global.db);try{expect(attached.openStore(key).db.prepare("SELECT id FROM sessions WHERE id=?").all(id)).toEqual([{id}]);}finally{attached.close();}
    await adapters.dispose();sync.stop();await sync.drain();
  });
  it("remote prerequisites are advertised only when source objects exist",async()=>{
    const f=adapterFixture(),head=(await f.options.git.run(f.root,["git","rev-parse","HEAD"])).toString().trim();
    expect(await handleRelocateAgent({version:1,kind:"prerequisite",sessionId:id,candidate:head},f.options)).toMatchObject({ok:true,value:{version:1,available:true}});
    expect(await handleRelocateAgent({version:1,kind:"prerequisite",sessionId:id,candidate:"0".repeat(40)},f.options)).toMatchObject({ok:true,value:{version:1,available:false}});
  });
  it("stopped-source seeding keeps its writer epoch without launching",async()=>{
    const f=adapterFixture(),source=await inspectLocalSource(id,f.options);if(!source.ok)throw new Error("source missing");
    f.worktree.db.prepare("UPDATE roam_sessions SET state='frozen'").run();f.options.homes.read=async()=>({...checkpoint().plan.source,state:"stopped"});
    expect(await handleRelocateAgent({version:1,kind:"seed",placement:source.value.placement,epoch:1,allowStopped:true},f.options)).toEqual({ok:true,value:{version:1}});
    expect(f.worktree.db.prepare("SELECT epoch,state FROM roam_sessions").get()).toEqual({epoch:1,state:"active"});
  });
  it("private data handler excludes legacy move and recovery",async()=>{
    const f=adapterFixture();
    const operation={id:"data-stores",machineId:hub,expectedEpoch:null,kind:"stores",args:{}};
    expect(await handleRelocateAgent({version:1,kind:"data",operation},f.options)).toMatchObject({ok:true,value:{version:1,outcome:{code:0,operationId:"data-stores",value:{protocol:1,schema:14}}}});
    for(const kind of ["move","retire","mirror-export","sync-handshake","session-freeze","session-retire"])
      expect(await handleRelocateAgent({version:1,kind:"data",operation:{...operation,kind}},f.options)).toMatchObject({ok:false,refusal:{code:"invalid-arguments"}});
  });
  it("publication requires the exact replicated home",async()=>{
    const f=adapterFixture(),peer:Peer={machineId:box,alias:"peer",node:"node",pi:"pi",cli:"cli",core:"core",globalRoot:"/peer"};
    f.options.config={...f.options.config,peers:[peer]};
    const wanted={...checkpoint().plan.source,state:"moving" as const,epoch:2,moveId:"v0-publish" as RelocateId,destination:box};
    let observed:unknown=wanted;
    f.options.transport.exec=async(_peer,_argv,options)=>{const input=JSON.parse(options.stdin!.toString());expect(input.kind).toBe("home");return Buffer.from(JSON.stringify({ok:true,value:{version:1,home:observed}}));};
    f.options.homes.read=async()=>wanted;
    const adapters=createRelocateAdapters(f.options);
    expect(await adapters.ports.publishHome(wanted,hub)).toEqual({ok:true,value:undefined});
    for(const delta of [{epoch:1},{state:"running",destination:null},{destination:hub},{moveId:"v0-other"},{machineId:box},{sessionId:"other"}]){
      observed={...wanted,...delta};expect(await adapters.ports.publishHome(wanted,box)).toMatchObject({ok:false,refusal:{code:"sync-failed"}});
    }
    observed=wanted;expect(await adapters.ports.publishHome(wanted,box)).toEqual({ok:true,value:undefined});await adapters.dispose();
  });
  it("factory preflight refuses unreachable or unprovisioned destinations without effects",async()=>{
    const f=adapterFixture(),peer:Peer={machineId:box,alias:"peer",node:"node",pi:"pi",cli:"cli",core:"core",globalRoot:"/peer"};f.options.config={...f.options.config,peers:[peer]};
    const adapters=createRelocateAdapters(f.options);
    expect(await adapters.ports.initialSource(id)).toEqual({ok:true,value:hub});
    f.options.transport.resolve=async()=>{throw new Error("unreachable");};
    expect(await adapters.ports.check({sessionId:id,destinationMachine:box},checkpoint().plan.source,"v0-check" as RelocateId)).toMatchObject({ok:false,refusal:{code:"destination-unreachable"}});
    f.options.transport.resolve=async p=>p;f.options.transport.exec=async()=>Buffer.from(JSON.stringify({ok:true,value:{version:1,machineId:box,pi:false,spider:true}}));
    expect(await adapters.ports.check({sessionId:id,destinationMachine:box},checkpoint().plan.source,"v0-check" as RelocateId)).toMatchObject({ok:false,refusal:{code:"destination-not-provisioned"}});
    expect(f.options.journal.read("v0-check")).toEqual([]);await adapters.dispose();
  });
  it("v0 sync uses data-only private dispatch", async () => {
    const calls: {argv:readonly string[];options:unknown}[] = [];
    const outcome = {code:0,reason:"complete",operationId:"batch-1",home:null,epoch:null,repairCommand:null,value:{through:2}};
    const peer: Peer = {machineId:box,alias:"peer",node:"node",pi:"pi",cli:"cli",core:"core",globalRoot:"/peer"};
    const base: Transport = {resolve:async p=>p,bootstrapProbe:async()=>{throw new Error("not used");},exec:async(_p,argv,options)=>{calls.push({argv,options});return Buffer.from(JSON.stringify({ok:true,value:{version:1,outcome}}));},run:async()=>({terminal:"t"}),read:async()=>Buffer.alloc(0),write:async()=>{}};
    const transport = createV0SyncTransport(base);
    const operation = {id:"batch-1",machineId:box,expectedEpoch:null,kind:"inventory",args:{key:"global"}};
    const options = {timeoutMs:400,maxBytes:5000};
    expect(JSON.parse((await transport.exec(peer,["roam","agent",JSON.stringify(operation)],options)).toString())).toEqual(outcome);
    expect(calls[0].argv).toEqual(["roam","agent","--v0"]);
    expect(calls[0].options).toMatchObject(options);
    expect(JSON.parse((calls[0].options as {stdin:Buffer}).stdin.toString())).toEqual({version:1,kind:"data",operation});
    await expect(transport.exec(peer,["roam","agent",JSON.stringify({...operation,kind:"move"})],options)).rejects.toThrow();
    expect(calls).toHaveLength(1);
    await transport.exec(peer,["other","command"],options);
    expect(calls[1]).toEqual({argv:["other","command"],options});
  });
  it("journal survives reopen and rejects another plan", async () => {
    const file = join(mkdtempSync(join(tmpdir(),"v0-journal-")),"journal.db");
    const journal = openJournal(file), adapter = createRelocateJournal(journal,hub), value = checkpoint();
    await adapter.save(value);
    await adapter.save(value);
    expect(journal.read(value.plan.moveId).filter(r=>r.action==="relocate-checkpoint")).toHaveLength(1);
    const reopened = createRelocateJournal(openJournal(file),hub);
    expect(await reopened.load(value.plan.moveId)).toEqual(value);
    await expect(reopened.save({...value,plan:{...value.plan,destinationPlacement:{...value.plan.destinationPlacement,machineId:hub}}})).rejects.toThrow();
    await expect(reopened.save({...value,plan:{...value.plan,source:{...value.plan.source,epoch:2}}})).rejects.toThrow();
    journal.record(value.plan.moveId,"relocate-checkpoint",{checkpoint:{plan:{moveId:value.plan.moveId}}});
    await expect(reopened.load(value.plan.moveId)).rejects.toThrow();
  });
});
