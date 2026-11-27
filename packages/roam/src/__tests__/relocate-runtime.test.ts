import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, delimiter } from "node:path";
import * as hcApi from "@spider/herdr/client/hc";
import type { CoreIdentity } from "@spider/herdr/contracts";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { recordLocation } from "@spider/db-core/roam/catalog";
import * as seedApi from "@spider/db-core/roam/seed";
import { writeLocal } from "@spider/db-core/roam/local-state";
import type { RelocateAdapterOptions, RunningHome, SessionId, SessionPlacement } from "../relocate/types";
import { DEFAULT_LIMITS, disabledIntercom } from "../contracts";
import { openJournal } from "../journal";
import { createLocalRuntime, createLocalIO, localLaunchEnvironment, seedLocalPlacement, type LocalIO } from "../relocate/local";
import { createHomeSupervisor } from "../relocate/supervisor";
const hub = "11111111-1111-4111-8111-111111111111", box = "22222222-2222-4222-8222-222222222222";
const id = "33333333-3333-4333-8333-333333333333" as SessionId;
const fixtures: {close():void}[] = [];
afterEach(()=>{ vi.restoreAllMocks(); vi.unstubAllEnvs(); for(const f of fixtures.splice(0)) f.close(); });
function runtimeFixture() {
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
 const io: LocalIO = {inspect:async()=>lock,probe:async()=>probe,claimFree:async()=>{},signal:async pid=>{signalled.push(pid);},shutdown:async()=>false,pause:async()=>{now+=10;},terminals:async()=>terminals,tree:async()=>({descendants:[],groups:[]}),groupBlockers:async()=>[],writerBlockers:async()=>[],launch:async request=>{launches.push(request);return {terminal:"core:t"};}};
 const options: RelocateAdapterOptions = {root:db.root,globalDb:db.db,homes:{read:async()=>current,list:async()=>current?[current]:[],initialize:async()=>home,compareAndSwap:async()=>({kind:"conflict",home:current})},journal,config:{enabled:false,role:"box",machineId:box,hubMachineId:hub,peers:[],discoveryRoots:[],coreUnit:"core",syncMs:10000,limits:{...DEFAULT_LIMITS,readyMs:30},intercom:disabledIntercom()},sync:{start(){},stop(){},sync:async()=>[],barriers:async()=>true},transport:{resolve:async p=>p,bootstrapProbe:async()=>{throw new Error("unused");},exec:async()=>{throw new Error("unexpected remote");},run:async()=>({terminal:"t"}),read:async()=>Buffer.alloc(0),write:async()=>{}},clock:{now:()=>now,later:(_ms,_fn)=>()=>{}},git:{run,journal,limits:DEFAULT_LIMITS,scratch:join(db.root,"git"),worktreeCommand:null},workspaceImport:{run,journal,limits:DEFAULT_LIMITS,scratch:join(db.root,"git"),worktreeCommand:null,resolveCommonRepository:async()=>null,lastExportedSnapshot:async()=>null,verifiedArtifactPath:async()=>null},limits:{...DEFAULT_LIMITS,readyMs:30}};
 return {options,io,home,placement,launches,signalled,setHome:(v:typeof current)=>current=v,setLock:(v:typeof lock)=>lock=v,setProbe:(v:typeof probe)=>probe=v,setTerminals:(v:typeof terminals)=>terminals=v};
}
function localCheckout(f: ReturnType<typeof runtimeFixture>) {
 const file = join(f.options.root, "ordinary.jsonl");
 const placement = {...f.placement, file, cwd: f.options.root};
 const moving = {...f.home, state: "moving" as const, destination: hub, moveId: f.home.moveId!};
 f.options.homes.read = async () => moving;
 f.options.git.run = async (_cwd, argv) => {
  if (argv.join(" ") === "git rev-parse --show-toplevel") return Buffer.from(f.options.root);
  throw new Error("unexpected git");
 };
 recordLocation(f.options.globalDb, {sessionId: id, stores: placement.stores, home: moving, file, cwd: placement.cwd});
 writeFileSync(file, JSON.stringify({type: "session", version: 3, id, cwd: placement.cwd, timestamp: "2000-01-01T00:00:00.000Z"}) + "\n");
 vi.spyOn(hcApi, "invokeCli").mockImplementation(async (_binary, argv) => {
  if (argv[0] !== "ls") throw new Error("unexpected hc call");
  return {terminals: []};
 });
 return {file, placement, moving};
}
describe("v0 local runtime",()=>{
 it.each(["open", "idle"])("refuses to acknowledge stop for a lockless unlabelled pi with an %s transcript", async mode => {
  const f = runtimeFixture();
  const {file, placement, moving} = localCheckout(f);
  const child = spawn(process.execPath, ["-e", `
    const fs = require("node:fs");
    const [file, mode] = process.argv.slice(1);
    process.title = "pi";
    const fd = fs.openSync(file, "a");
    if (mode === "idle") fs.closeSync(fd);
    const exit = () => { if (mode === "open") fs.closeSync(fd); process.exit(0); };
    process.once("message", exit);
    process.once("disconnect", exit);
    process.send("ready");
  `, file, mode], {cwd: placement.cwd, stdio: ["ignore", "ignore", "ignore", "ipc"]});
  const exited = once(child, "exit");
  try {
   const [ready] = await Promise.race([once(child, "message"), exited]);
   expect(ready).toBe("ready");
   const local = createLocalRuntime(f.options);
   const stopped = await local.stop(id, moving);
   expect(child.exitCode).toBeNull();
   expect(stopped).toMatchObject({ok: false, refusal: {code: "session-busy",
    message: expect.stringContaining(`PID ${child.pid} (pi)`), nextStep: "Close these, then rerun relocate."}});
   expect(await local.owner(id)).toEqual({kind: "unknown"});
   f.options.homes.read = async () => f.home;
   expect(await local.start(f.home, placement)).toMatchObject({ok: false, refusal: {code: "session-busy"}});
  } finally {
   if (child.connected) child.send("exit");
   await exited;
  }
 });
 it("does not report a session stopped while its subagent run is active", async () => {
  const f = runtimeFixture(), {moving, file} = localCheckout(f);
  const runs = createReplica("worktree", box); fixtures.push(runs);
  f.options.globalDb.prepare("INSERT INTO roam_workspace_maps (repo_key,workspace_id,path) VALUES ('fixture-repo','fixture-workspace',?)").run(f.options.root);
  writeLocal(f.options.globalDb, "mapping-redirect", runs.storeKey, runs.db.raw.name);
  recordLocation(f.options.globalDb, {sessionId: id, stores: ["global", runs.storeKey], home: moving, file, cwd: f.options.root});
  runs.db.prepare("INSERT INTO runs (id,session_id,agent,status,pid) VALUES ('run-a',?,'worker','running',4242)").run(id);
  const local = createLocalRuntime(f.options);
  expect(await local.stop(id, moving)).toMatchObject({ok: false, refusal: {code: "session-busy", message: expect.stringContaining("PID 4242 (pi)"), nextStep: "Close these, then rerun relocate."}});
  runs.db.prepare("UPDATE runs SET status='done' WHERE id='run-a'").run();
  expect(await local.stop(id, moving)).toEqual({ok: true, value: undefined});
 });
 it("does not report a session stopped while a background exec may still be live", async () => {
  const f = runtimeFixture(), {moving} = localCheckout(f);
  const dir = join(f.options.root, ".spider", "scratch", "bg", "job-a");
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, "job.json"), JSON.stringify({schema: 1, id: "job-a", cwd: f.options.root, ownerSessionId: id, argv: ["node", "fixture.cjs"]}));
  const local = createLocalRuntime(f.options);
  expect(await local.stop(id, moving)).toMatchObject({ok: false, refusal: {code: "session-busy", message: expect.stringContaining("job-a")}});
  writeFileSync(join(dir, "exit.json"), JSON.stringify({schema: 1, state: "exited", exitCode: 0, signal: null}));
  expect(await local.stop(id, moving)).toEqual({ok: true, value: undefined});
 });
 it("refuses retryable seed rollback without calling the seeder again", async () => {
  const f = runtimeFixture(), tree = createReplica("worktree",box); fixtures.push(tree);
  f.options.globalDb.prepare("INSERT INTO roam_repo_maps (repo_key,path,worktree_command_json) VALUES ('fixture-repo',?,NULL)").run(tree.root);
  f.options.globalDb.prepare("INSERT INTO roam_workspace_maps (repo_key,workspace_id,path) VALUES ('fixture-repo','fixture-workspace',?)").run(tree.root);
  writeLocal(f.options.globalDb,"mapping-redirect",tree.storeKey,tree.db.raw.name);
  tree.db.prepare("INSERT INTO runs (id,session_id,agent,status,task) VALUES ('busy-run',?,'worker','running',?)").run(id,"x".repeat(16*1024*1024+1));
  const placement = {...f.placement,repoKey:"fixture-repo",workspaceId:"fixture-workspace",stores:[tree.storeKey]};
  const realSeed = seedApi.seedSession;
  let retriable = false;
  vi.spyOn(seedApi,"seedSession").mockImplementation((...args) => {
   if (retriable) throw new Error("the synchronous loop called a rolled-back seed again");
   const seeded = realSeed(...args);
   retriable = seeded.retryable === true;
   return seeded;
  });
  await expect(seedLocalPlacement(placement,f.home.epoch,f.options)).rejects.toMatchObject({code:"session-busy"});
  expect(retriable).toBe(true);
  expect(tree.db.prepare("SELECT * FROM roam_seed_progress").all()).toEqual([]);
 });
 it("resumed pi does not inherit worker or offline execution context",()=>{
  const env=localLaunchEnvironment({PATH:"/local/bin",PI_SUBAGENT_CHILD:"1",PI_SPIDER_SESSION:"old",PI_OFFLINE:"1",SPIDER_GLOBAL_ROOT:"/old",SPIDER_SUBAGENT_ID:"old",NODE_OPTIONS:"--inspect",HC_TERMINAL_ID:"remote",AUTH_TOKEN:"local-auth"});
  expect(env.PI_SUBAGENT_CHILD).toBe("0");
  expect(env.PI_SPIDER_SESSION).toBeUndefined();expect(env.PI_OFFLINE).toBeUndefined();
  expect(env.SPIDER_SUBAGENT_ID).toBeUndefined();expect(env.SPIDER_GLOBAL_ROOT).toBeUndefined();
  expect(env.NODE_OPTIONS).toBeUndefined();expect(env.HC_TERMINAL_ID).toBeUndefined();
  expect(env.AUTH_TOKEN).toBe("local-auth");expect(env.PI_CODING_AGENT_DIR).toBeTruthy();
 });
 it("uses the configured hc binary and keeps the service's pinned core", async () => {
  const f = runtimeFixture(), root = f.options.root, binary = join(root,"bin","hc");
  mkdirSync(join(root,"herdr"));
  writeFileSync(join(root,"herdr","config.json"), JSON.stringify({mode:"core-only",core:{binary,config:join(root,"core.toml")},
   globalRoot:root,agentDirectory:join(root,"agent"),shellRc:join(root,"shell.rc"),machines:[]}));
  vi.stubEnv("SPIDER_ROAM_HC",undefined);
  vi.stubEnv("PI_CODING_AGENT_DIR",undefined);
  vi.stubEnv("HC_SESSION","work");
  vi.stubEnv("HC_SOCKET",join(root,"work.sock"));
  vi.stubEnv("HC_TERMINAL_ID","foreign:terminal");
  const calls = vi.spyOn(hcApi,"invokeCli").mockResolvedValue({terminals:[]});
  await createLocalIO(f.options).terminals(id);
  expect(calls.mock.calls[0][0]).toBe(binary);
  expect(calls.mock.calls[0][2]).toMatchObject({HC_SESSION:"work",HC_SOCKET:join(root,"work.sock"),PI_CODING_AGENT_DIR:join(root,"agent")});
  expect(calls.mock.calls[0][2].HC_TERMINAL_ID).toBeUndefined();
 });
 it("resolves live process identity from terminal details when summaries omit pid",async()=>{
  const f=runtimeFixture();
  vi.spyOn(hcApi,"invokeCli").mockImplementation(async(_binary,argv)=>{
    if(argv[0]==="ls")return {terminals:[{address:"core:t",state:"live",agent:"pi"}]};
    if(argv[0]==="get" && argv[1]==="core:t")return {address:"core:t",state:"live",pid:42};
    throw new Error("unexpected native request");
  });
  expect(await createLocalIO(f.options).terminals(id)).toEqual([{terminal:"core:t",state:"live",pid:42}]);
 });
 it("verifies Spider ownership from terminal details even if the summary supplies a pid", async () => {
  const f = runtimeFixture();
  vi.spyOn(hcApi,"invokeCli").mockImplementation(async (_binary,argv) => argv[0] === "ls"
   ? {terminals:[{address:"core:t",state:"live",pid:42}]}
   : {address:"core:t",state:"live",pid:42,labels:{"spider.kind":"session","spider.session":id,"spider.machine":box,"spider.roam.epoch":"3"}});
  expect(await createLocalIO(f.options).terminals(id)).toEqual([{terminal:"core:t",state:"live",pid:42,owned:true}]);
 });
 it("does not mark a legacy launch as owned by v0", async () => {
  const f = runtimeFixture();
  vi.spyOn(hcApi,"invokeCli").mockImplementation(async (_binary,argv) => argv[0] === "ls"
   ? {terminals:[{address:"core:t",state:"live",pid:42}]}
   : {address:"core:t",state:"live",pid:42,labels:{"spider.kind":"session","spider.session":id,"spider.machine":box,"spider.roam.epoch":"3","spider.roam.operation":"legacy"}});
  expect(await createLocalIO(f.options).terminals(id)).toEqual([{terminal:"core:t",state:"live",pid:42}]);
 });
 it.each([{address:"other:t",state:"live",pid:42},{address:"core:t",state:"live",pid:-1},{address:"core:t",state:"finished",pid:42}])("refuses changed live terminal details %j",async detail=>{
  const f=runtimeFixture();
  vi.spyOn(hcApi,"invokeCli").mockImplementation(async(_binary,argv)=>argv[0]==="ls"?{terminals:[{address:"core:t",state:"live"}]}:detail);
  await expect(createLocalIO(f.options).terminals(id)).rejects.toThrow();
 });
 it("accepts a matching finished detail when the compact list still shows live", async () => {
  const f = runtimeFixture();
  vi.spyOn(hcApi,"invokeCli").mockImplementation(async (_binary,argv) => argv[0] === "ls"
   ? {terminals:[{address:"core:t",state:"live",pid:42}]}
   : {address:"core:t",state:"finished",reason:"exited",exit_code:0});
  expect(await createLocalIO(f.options).terminals(id)).toEqual([{terminal:"core:t",state:"finished",pid:null}]);
 });
 it("accepts native signal exits and ignores remote terminal summaries",async()=>{
  const f=runtimeFixture();
  vi.spyOn(hcApi,"invokeCli").mockResolvedValue({terminals:[{address:"t7",state:"finished",reason:"exited",signal:15},{address:"peer/t1",state:"live"}]});
  expect(await createLocalIO(f.options).terminals(id)).toEqual([{terminal:"t7",state:"finished",pid:null}]);
 });
 it("does not let a finished core-restart terminal block ownership checks", async () => {
  const f = runtimeFixture();
  const {moving} = localCheckout(f);
  vi.mocked(hcApi.invokeCli).mockResolvedValue({terminals:[{address:"t7",state:"finished",reason:"stopped_by_restart",exit_code:null,signal:null}]});
  const local = createLocalRuntime(f.options);
  expect(await local.owner(id)).toEqual({kind:"free"});
  expect(await local.stop(id,moving)).toEqual({ok:true,value:undefined});
 });
 it.each([0,-1,1.5])("rejects an invalid native exit signal %s",async signal=>{
  const f=runtimeFixture();
  vi.spyOn(hcApi,"invokeCli").mockResolvedValue({terminals:[{address:"t7",state:"finished",reason:"exited",signal}]});
  await expect(createLocalIO(f.options).terminals(id)).rejects.toThrow();
 });
 it("detached exact-file launch uses the destination environment",async()=>{
  const f=runtimeFixture(),pi=join(f.options.root,"pi");writeFileSync(pi,"#!/bin/sh\n",{mode:0o700});
  vi.stubEnv("SPIDER_ROAM_PI",pi);vi.stubEnv("HC_TERMINAL_ID","inherited");vi.stubEnv("HC_SESSION","foreign");vi.stubEnv("HC_SOCKET","/foreign.sock");vi.stubEnv("SPIDER_HERDR_LEASE_TOKEN","fake-lease");vi.stubEnv("SPIDER_HERDR_HANDOFF_FILE","/foreign-handoff");vi.stubEnv("SPIDER_GLOBAL_ROOT","/foreign-root");vi.stubEnv("AUTH_TOKEN","synthetic-secret");
  vi.stubEnv("SSH_AUTH_SOCK",undefined);
  vi.spyOn(hcApi,"observeCoreIdentity").mockResolvedValue({coreId:"selected",sessionNamespace:"selected",socket:"/selected.sock"} as CoreIdentity);
  const calls:{argv:readonly string[];env:Readonly<NodeJS.ProcessEnv>}[]=[];
  vi.spyOn(hcApi,"invokeCli").mockImplementation(async(_binary,argv,env)=>{calls.push({argv,env});return {address:"selected:t"};});
  const io=createLocalIO(f.options);expect(await io.launch({home:f.home,placement:f.placement})).toEqual({terminal:"selected:t"});
  expect(calls[0].argv).toEqual(["run","--json","--bg","--no-notify","--outlive-parent","--no-parent","--cwd","/mapped/sub","--label","spider.kind=session","--label",`spider.session=${id}`,"--label",`spider.machine=${box}`,"--label","spider.roam.epoch=3","--","/usr/bin/env",`PATH=${calls[0].env.PATH}`,`PI_CODING_AGENT_DIR=${calls[0].env.PI_CODING_AGENT_DIR}`,`SPIDER_GLOBAL_ROOT=${f.options.root}`,"PI_SUBAGENT_CHILD=0",pi,"--session","/sessions/exact.jsonl"]);
  expect(calls[0].env).toMatchObject({HC_SESSION:"selected",HC_SOCKET:"/selected.sock",SPIDER_GLOBAL_ROOT:f.options.root});
  expect(calls[0].env.HC_TERMINAL_ID).toBeUndefined();expect(calls[0].env.SPIDER_HERDR_LEASE_TOKEN).toBeUndefined();expect(calls[0].env.SPIDER_HERDR_HANDOFF_FILE).toBeUndefined();
  expect(calls[0].env.PI_CODING_AGENT_DIR).toBeTruthy();expect(calls[0].env.PATH!.split(delimiter)).toContain(dirname(process.execPath));expect(calls[0].argv.join(" ")).not.toContain("synthetic-secret");
 });
 it("passes tool PATH, agent settings, and a local ssh socket to pi without client environment forwarding", async () => {
  const f = runtimeFixture(), pi = join(f.options.root,"pi"), agent = join(f.options.root,"agent"), sock = join(f.options.root,"ssh.sock");
  writeFileSync(pi,"#!/bin/sh\nprintf '%s\\n' \"$PATH\" \"$PI_CODING_AGENT_DIR\" \"$SPIDER_GLOBAL_ROOT\" \"$PI_SUBAGENT_CHILD\" \"$SSH_AUTH_SOCK\" \"$FAKE_PROVIDER_KEY\" \"$@\"\n",{mode:0o700});
  vi.stubEnv("SPIDER_ROAM_PI",pi); vi.stubEnv("PI_CODING_AGENT_DIR",agent); vi.stubEnv("SSH_AUTH_SOCK",sock);
  vi.stubEnv("PATH","/fixture/login/bin:/usr/bin:/bin"); vi.stubEnv("FAKE_PROVIDER_KEY","must-not-be-forwarded");
  vi.spyOn(hcApi,"observeCoreIdentity").mockResolvedValue({coreId:"selected",sessionNamespace:"selected",socket:"/selected.sock"} as CoreIdentity);
  let program: readonly string[] = [];
  vi.spyOn(hcApi,"invokeCli").mockImplementation(async (_binary,argv) => {program = argv.slice(argv.indexOf("--")+1); return {address:"selected:t"};});
  await createLocalIO(f.options).launch({home:f.home,placement:f.placement});
  const [toolPath,agentDir,root,child,ssh,secret,...args] = execFileSync(program[0],[...program.slice(1)],{encoding:"utf8",env:{PATH:"/usr/bin:/bin"}}).trimEnd().split("\n");
  expect(toolPath.split(delimiter)).toContain("/fixture/login/bin");
  expect([agentDir,root,child,ssh,secret]).toEqual([agent,f.options.root,"0",sock,""]);
  expect(args).toEqual(["--session",f.placement.file]);
  expect(program.join(" ")).not.toContain("must-not-be-forwarded");
 });
 it("supervisor entries include missing homes",async()=>{
  const f=runtimeFixture(),local=createLocalRuntime(f.options,f.io);
  expect(await local.activate(f.home,f.placement)).toEqual({ok:true,value:undefined});
  f.setHome(null);
  expect(await local.entries()).toEqual([{sessionId:id,home:null,placement:f.placement}]);
 });
 it("a stale supervisor tick does not stop the pi that already has a local running home", async () => {
  const f = runtimeFixture(), local = createLocalRuntime(f.options,f.io);
  writeLocal(f.options.globalDb,"relocate-managed",id,f.placement);
  f.options.homes.list = async () => [{...f.home,machineId:hub,epoch:2,state:"moving",destination:box,moveId:f.home.moveId!}];
  f.setLock({identity:{pid:42,startIdentity:"pi-42"},bootId:"boot",pendingOperationId:null,pendingFile:null,pendingCoreId:null,operationId:null});
  f.setProbe({kind:"live",startIdentity:"pi-42",pi:true});
  f.setTerminals([{terminal:"core:t",state:"live",pid:42,owned:true}]);
  const signal = f.io.signal;
  f.io.signal = async pid => { await signal(pid); f.setLock(null); f.setProbe({kind:"absent"}); f.setTerminals([]); };
  const loop = createHomeSupervisor({...local,machineId:box,clock:f.options.clock,report() {}}, () => {});
  await loop.tick();
  expect(f.signalled).toEqual([]);
  expect(await local.owner(id)).toEqual({kind:"live",pid:42,terminal:"core:t"});
 });
 it("reports one malformed placement and still restarts the healthy session", async () => {
  const f = runtimeFixture(), local = createLocalRuntime(f.options,f.io);
  writeLocal(f.options.globalDb,"relocate-managed",id,f.placement);
  const report = vi.fn(), stop = vi.fn(local.stop);
  const loop = createHomeSupervisor({...local,stop,machineId:box,clock:f.options.clock,report}, () => {});
  await loop.tick();
  expect(f.launches).toHaveLength(1);
  const broken = "old-placement" as SessionId;
  writeLocal(f.options.globalDb,"relocate-managed",broken,{sessionId:broken,file:"/old/s.jsonl"});
  // The home of the healthy session still authorizes a restart. The malformed
  // other placement must neither put that session in the stop path nor start it.
  await loop.tick();
  expect(f.launches.map(request => request.home.sessionId)).toEqual([id,id]);
  expect(stop).not.toHaveBeenCalled();
  expect(report).toHaveBeenCalledExactlyOnceWith(broken,expect.objectContaining({code:"destination-copy-missing",nextStep:expect.stringContaining("Restore")}));
 });
 it("activation waits for an in-flight supervisor stop before updating membership",async()=>{
  const f=runtimeFixture(),worktree=createReplica("worktree",box);fixtures.push(worktree);
  const placement={...f.placement,repoKey:"fixture-repo",workspaceId:"fixture-workspace",stores:["global",worktree.storeKey]} as SessionPlacement;
  f.options.globalDb.prepare("INSERT INTO roam_repo_maps(repo_key,path,worktree_command_json) VALUES ('fixture-repo',?,NULL)").run(worktree.root);
  f.options.globalDb.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','fixture-workspace',?)").run(worktree.root);
  writeLocal(f.options.globalDb,"mapping-redirect",worktree.storeKey,worktree.db.raw.name);
  worktree.db.prepare("INSERT INTO sessions(id,started_at) VALUES (?,1)").run(id);
  worktree.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,1,'frozen')").run(id);
  const moving={...f.home,machineId:hub,epoch:2,state:"moving",destination:box} as unknown as RunningHome;
  f.setHome(moving);
  recordLocation(f.options.globalDb,{sessionId:id,stores:placement.stores,home:moving,file:placement.file,cwd:placement.cwd});
  let entered!:()=>void,release!:()=>void;
  const stopping=new Promise<void>(done=>entered=done),gate=new Promise<void>(done=>release=done);
  f.io.claimFree=async()=>{entered();await gate;};
  const installer=createLocalRuntime(f.options,f.io),supervisor=createLocalRuntime(f.options,f.io);
  const stop=supervisor.stop(id);await stopping;
  const activate=installer.activate(f.home,placement);
  // Keep native stop pending while the competing actor completes its lock I/O.
  await new Promise<void>(done=>setTimeout(done,100));release();
  expect(await stop).toEqual({ok:true,value:undefined});expect(await activate).toEqual({ok:true,value:undefined});
  expect(worktree.db.prepare("SELECT epoch,state FROM roam_sessions WHERE session_id=?").get(id)).toEqual({epoch:3,state:"active"});
  expect(f.launches).toHaveLength(0);
 });
 it("does not acknowledge a moving source stop while the local launch is in flight", async () => {
  const f = runtimeFixture(), starter = createLocalRuntime(f.options,f.io), stopper = createLocalRuntime(f.options,f.io);
  const moving = {...f.home,epoch:4,state:"moving" as const,destination:hub,moveId:f.home.moveId!};
  let entered!: () => void, release!: () => void;
  const inLaunch = new Promise<void>(resolve => { entered = resolve; });
  const finish = new Promise<void>(resolve => { release = resolve; });
  f.io.launch = async () => { entered(); await finish; return {terminal:"core:t"}; };
  const started = starter.start(f.home,f.placement);
  await inLaunch;
  f.options.homes.read = async () => moving;
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});
  try {
   const stopped = stopper.stop(id,moving);
   await vi.advanceTimersByTimeAsync(5000); // Existing process-lock wait, not a real sleep.
   expect(await stopped).toMatchObject({ok:false,refusal:{code:"session-busy"}});
  } finally {
   vi.useRealTimers(); release(); await started;
  }
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
