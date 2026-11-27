import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { processStartIdentity } from "@spider/herdr/jobs/handoff";
import { claimIdLock, type IdLockHandle } from "@spider/herdr/sessions/id-lock";
import { createConnection } from "node:net";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_LIMITS, disabledIntercom, type RoamConfig } from "../contracts";
import type { RelocateId, RunningHome, SessionId, V0ControlServices } from "../relocate/types";
import { createHomeStore } from "../relocate/home";
import { parseV0Control, runV0Control, readV0Confirmation } from "../relocate/cli";
import { serveV0Control, requestV0Services, runV0Service } from "../relocate/service";
import { parsePublicControl } from "../commands";
import { main } from "../cli";
import * as legacySocket from "../control-socket";
import * as productionHub from "../production-hub";
import * as productionSupervisor from "../production-supervisor";
import * as controls from "../production-controls";
import * as diagnostics from "../local-diagnostics";
import { createReplica } from "@spider/db-core/testutil";
import { openDbAt, registerProject, setGlobalDbPathForTests } from "@spider/db-core";
import { writeLocal } from "@spider/db-core/roam/local-state";
import { createV0Runtime, startV0Hub, startV0Supervisor } from "../relocate/runtime";
import { callV0, handleRelocateAgent } from "../relocate/remote";
import * as hcApi from "@spider/herdr/client/hc";
import type { CoreIdentity } from "@spider/herdr/contracts";
import type { Transport } from "../contracts";
import { main as supervisorMain } from "../supervisor-main";
import * as v0RuntimeApi from "../relocate/runtime";

const mac = "11111111-1111-4111-8111-111111111111", box = "22222222-2222-4222-8222-222222222222";
// The public CLI's built-in local selector, not a remote hostname.
const macSelector = "mac";
const config: RoamConfig = { enabled: true, role: "hub", machineId: mac, hubMachineId: mac, peers: [{ machineId: box, alias: "box-a.invalid", node: "/node", pi: "/pi", cli: "/spider", core: "/core", globalRoot: "/root" }], discoveryRoots: [], coreUnit: "core", syncMs: 10_000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
const catalog = [{ id: "session-abc", name: "first" }, { id: "session-abd", name: "second" }, { id: "first", name: null }];
const home: RunningHome = { sessionId: "session-abc" as SessionId, machineId: box, epoch: 3, updatedAt: 1, state: "running", destination: null, moveId: null };
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(confirmation: string | null = null) {
  const out: string[] = [], err: string[] = [], prompts: string[] = [];
  const services: V0ControlServices = {
    relocate: vi.fn(async () => ({ ok: true as const, value: { moveId: null, home, terminal: "core:term", disposition: "relocated" as const, placement: { sessionId: home.sessionId, machineId: box, repoKey: "repo", workspaceId: "ws", repository: "/repo", cwd: "/repo", file: "/session.jsonl", stores: [], historyMachine: mac } } })),
    setHome: vi.fn(async () => ({ ok: true as const, value: home })),
  };
  const io = { out: (text: string) => out.push(text), err: (text: string) => err.push(text), confirmation: vi.fn(async (prompt: string) => { prompts.push(prompt); return confirmation; }) };
  return { out, err, prompts, services, io };
}
describe("v0 controls", () => {
  it("production runtime confirms a supervisor-first pending start", async () => {
    vi.stubEnv("HC_SOCKET",undefined);vi.stubEnv("HC_SESSION",undefined);vi.stubEnv("HC_TERMINAL_SOCKET",undefined);
    vi.stubEnv("XDG_RUNTIME_DIR",resolve(".spider/outside-fixture-runtime"));
    const herdrRoot=mkdtempSync(join(resolve(".spider/scratch"),"v0hc-"));roots.push(herdrRoot);
    vi.stubEnv("HC_SOCKET",join(herdrRoot,"hc.sock"));vi.stubEnv("HC_SESSION","production-race");
    const source=createReplica("global",mac), sid="production-race" as SessionId;
    const child=spawn(process.execPath,["-e",`process.title="pi";process.once("message",()=>process.exit(0));process.send("ready");`],{stdio:["ignore","ignore","ignore","ipc"]});
    const exited=once(child,"exit");
    let held:IdLockHandle|undefined, runtime:ReturnType<typeof createV0Runtime>|undefined;
    try {
      const [ready]=await Promise.race([once(child,"message"),exited]);expect(ready).toBe("ready");
      const pid=child.pid!, startIdentity=processStartIdentity(pid);
      if(!startIdentity)throw new Error("fixture process identity unavailable");
      const checkout=join(source.root,"checkout"), file=join(checkout,"session.jsonl");mkdirSync(checkout);
      writeFileSync(file,JSON.stringify({type:"session",version:3,id:sid,cwd:checkout,timestamp:"2020-01-01T00:00:00Z"})+"\n"+
        JSON.stringify({type:"message",id:"entry",parentId:null,timestamp:"2020-01-01T00:00:00Z",message:{role:"user",content:[{type:"text",text:"synthetic"}]}})+"\n");
      const placement={sessionId:sid,machineId:mac,repoKey:"repo",workspaceId:"ws",repository:checkout,cwd:checkout,file,stores:["global" as const],historyMachine:mac};
      let listings=0, launches=0;
      vi.spyOn(hcApi,"invokeCli").mockImplementation(async(_binary,argv)=>{
        if(argv[0]==="ls") {
          listings++;
          if(listings===2)held=await claimIdLock(join(source.root,"herdr"),sid,{pid,startIdentity},async()=>({kind:"unknown"}));
          return {terminals:[{address:"core:t",state:"live",pid}]};
        }
        if(argv[0]==="get")return {address:"core:t",state:"live",pid,cwd:checkout,argv:["pi","--session",file],
          labels:{"spider.kind":"session","spider.session":sid,"spider.machine":mac,"spider.roam.epoch":"1"}};
        if(argv[0]==="run"){launches++;return {address:"core:other"};}
        throw new Error("unexpected terminal request");
      });
      const sourceConfig={...config,peers:[],limits:{...config.limits,readyMs:1_000}};
      runtime=createV0Runtime(source.root,{openCore:()=>({root:source.root,config:sourceConfig,db:source.db,close(){}})});
      const initial=await runtime.homes.initialize(sid,mac);
      writeLocal(source.db,"relocate-managed",sid,placement);
      expect(await runtime.services.relocate({sessionId:sid,destinationMachine:mac})).toMatchObject({ok:true,value:{home:initial,terminal:"core:t",disposition:"already-home"}});
      expect(listings).toBeGreaterThanOrEqual(2);expect(launches).toBe(0);expect(child.exitCode).toBeNull();
    } finally {
      await runtime?.close();await held?.release();
      if(child.connected)child.send("exit");await exited;source.close();
    }
  });
  it("production v0 runtime composes only approved ports", async () => {
    const source=createReplica("global",mac),target=createReplica("global",box);
    const sourceConfig={...config,limits:{...config.limits,readyMs:20},peers:[{...config.peers[0],globalRoot:target.root}]};
    const targetConfig:RoamConfig={...config,role:"box",machineId:box,peers:[{...config.peers[0],machineId:mac,globalRoot:source.root}]};
    const calls:string[][]=[];
    let remote:ReturnType<typeof createV0Runtime>;
    const raw:Transport={resolve:async p=>p,bootstrapProbe:async()=>{throw new Error("unused provisioning");},run:async()=>{throw new Error("hub-side remote launch forbidden");},read:async()=>{throw new Error("unused read");},write:async()=>{throw new Error("unused write");},exec:async(_p,argv,options)=>{
      calls.push([...argv]);expect(argv).toEqual(["roam","agent","--v0"]);
      return Buffer.from(JSON.stringify(await handleRelocateAgent(JSON.parse(options.stdin!.toString()),remote.options)));
    }};
    const forbidden=[vi.spyOn(productionHub,"startProductionHub"),vi.spyOn(productionSupervisor,"startProductionSupervisor"),vi.spyOn(controls,"enableRoaming"),vi.spyOn(diagnostics,"runLocalDoctor")];
    const local=createV0Runtime(source.root,{openCore:()=>({root:source.root,config:sourceConfig,db:source.db,close(){}}),transport:raw});
    remote=createV0Runtime(target.root,{openCore:()=>({root:target.root,config:targetConfig,db:target.db,close(){}}),transport:raw});
    try {
      const sid="production-v0" as SessionId,home=await local.homes.initialize(sid,mac);
      const checkout=join(source.root,"checkout"),file=join(checkout,"session.jsonl"),pi=join(source.root,"pi");
      execFileSync("git",["init","--quiet",checkout],{cwd:source.root});
      writeFileSync(file,JSON.stringify({type:"session",version:3,id:sid,cwd:checkout,timestamp:"2020-01-01T00:00:00Z"})+"\n"+JSON.stringify({type:"message",id:"entry",parentId:null,timestamp:"2020-01-01T00:00:00Z",message:{role:"user",content:[{type:"text",text:"synthetic"}]}})+"\n");
      writeFileSync(pi,"#!/bin/sh\n",{mode:0o700});vi.stubEnv("SPIDER_ROAM_PI",pi);
      writeLocal(source.db,"relocate-managed",sid,{sessionId:sid,machineId:mac,repoKey:"repo",workspaceId:"ws",repository:checkout,cwd:checkout,file,stores:["global"],historyMachine:mac});
      vi.spyOn(hcApi,"observeCoreIdentity").mockResolvedValue({coreId:"local",sessionNamespace:"local",socket:"/local.sock"} as CoreIdentity);
      const launches:string[][]=[];
      vi.spyOn(hcApi,"invokeCli").mockImplementation(async(_bin,argv)=>{if(argv[0]==="ls")return {terminals:[]};launches.push([...argv]);return {address:"local:t"};});
      // Runtime captures executable selection at creation, before the command.
      const active=createV0Runtime(source.root,{openCore:()=>({root:source.root,config:sourceConfig,db:source.db,close(){}}),transport:raw});
      try {
        expect(await active.services.relocate({sessionId:sid,destinationMachine:mac})).toMatchObject({ok:false,step:"confirm",refusal:{code:"start-pending"}});
        expect(launches).toHaveLength(1);expect(launches[0].slice(-3)).toEqual([pi,"--session",file]);
        expect(await active.homes.read(sid)).toEqual(home);
        expect(await active.services.setHome({sessionId:sid,destinationMachine:mac,force:true,confirmation:`reassign ${sid} to ${mac}; source will not run`})).toMatchObject({ok:true,value:{epoch:2,machineId:mac,state:"running"}});
        expect((await active.sync.sync(box)).every(result=>result.code===0)).toBe(true);
        expect(await remote.homes.read(sid)).toEqual(await active.homes.read(sid));expect(calls.length).toBeGreaterThan(0);
      } finally {await active.close();}
      for(const spy of forbidden)expect(spy).not.toHaveBeenCalled();
    } finally {await local.close();await remote.close();source.close();target.close();}
  });
  it("v0 sync contacts peers through the installed Herdr executable and pinned core",async()=>{
    const source=createReplica("global",mac);
    const root=mkdtempSync(join(resolve(".spider/scratch"),"hr-"));roots.push(root);
    const binary=join(root,"bin","hc"), socket=join(root,"work.sock"), agentDirectory=join(root,"agent");
    mkdirSync(join(root,"herdr"));
    writeFileSync(join(root,"herdr","config.json"),JSON.stringify({mode:"core-only",core:{binary,config:join(root,"core.toml")},
      globalRoot:root,agentDirectory,shellRc:join(root,"shell.rc"),machines:[]}));
    vi.stubEnv("SPIDER_ROAM_HC",undefined);vi.stubEnv("PI_CODING_AGENT_DIR",undefined);
    vi.stubEnv("HC_SESSION","work");vi.stubEnv("HC_SOCKET",socket);vi.stubEnv("HC_TERMINAL_ID","foreign:t");
    const hc=vi.spyOn(hcApi,"invokeCli").mockRejectedValue(new Error("synthetic offline core"));
    const runtime=createV0Runtime(root,{openCore:()=>({root,config,db:source.db,close(){}})});
    try {
      await runtime.sync.sync(box);
      const request=hc.mock.calls.find(([,argv])=>argv.join(" ")==="server status --json");
      expect(request?.[0]).toBe(binary);
      expect(request?.[2]).toMatchObject({HC_SESSION:"work",HC_SOCKET:socket,PI_CODING_AGENT_DIR:agentDirectory});
      expect(request?.[2].HC_TERMINAL_ID).toBeUndefined();
    } finally {await runtime.close();source.close();}
  });
  it("v0 hub and supervisor entries drain on shutdown",async()=>{
    const source=createReplica("global",mac),target=createReplica("global",box);
    const idle={now:()=>1,later:()=>()=>{}};
    const unused=async()=>{throw new Error("Idle services must not call transport");};
    const transport:Transport={resolve:unused,bootstrapProbe:unused,exec:unused,run:unused,read:unused,write:unused};
    const hubRoot=mkdtempSync(join(resolve(".spider/scratch"),"dvh-")),boxRoot=mkdtempSync(join(resolve(".spider/scratch"),"dvb-"));roots.push(hubRoot,boxRoot);
    const hub=await startV0Hub(hubRoot,{openCore:()=>({root:hubRoot,config:{...config,enabled:false,peers:[]},db:source.db,close:vi.fn()}),transport,clock:idle});
    const supervisor=await startV0Supervisor(boxRoot,{openCore:()=>({root:boxRoot,config:{...config,role:"box",machineId:box,enabled:false,peers:[]},db:target.db,close:vi.fn()}),transport,clock:idle});
    try {expect(await requestV0Services(hubRoot).setHome({sessionId:"missing" as SessionId,destinationMachine:mac,force:true,confirmation:"bad"})).toMatchObject({ok:false,refusal:{code:"confirmation-required"}});}
    finally {await hub.stop();await hub.stop();await supervisor.stop();await supervisor.stop();source.close();target.close();}
  });
  it("the private hub refuses remote reassignment when its live replication flag is off",async()=>{
    const source=createReplica("global",mac);
    const root=mkdtempSync(join(resolve(".spider/scratch"),"sr-"));roots.push(root);
    const initial={...config,peers:[{...config.peers[0]}]};
    let current=initial;
    const network=vi.fn(async()=>{throw new Error("unexpected network contact");});
    const transport:Transport={resolve:network,bootstrapProbe:network,exec:network,run:network,read:network,write:network};
    const runtime={openCore:()=>({root,config:initial,db:source.db,close(){}}),readConfig:()=>current,transport,clock:{now:()=>1,later:()=>()=>{}}};
    const hub=await startV0Hub(root,runtime);
    try {
      source.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,updated_at,state) VALUES (?,?,1,1,'running')").run(home.sessionId,mac);
      current={...initial,enabled:false};
      const request={sessionId:home.sessionId,destinationMachine:box,force:true,confirmation:`reassign ${home.sessionId} to ${box}; source will not run`} as const;
      expect(await requestV0Services(root).setHome(request)).toMatchObject({ok:false,refusal:{code:"replication-disabled",nextStep:expect.stringContaining("spider roam enable")}});
      expect(network).not.toHaveBeenCalled();
      expect(source.db.prepare("SELECT machine_id,epoch FROM session_homes").get()).toEqual({machine_id:mac,epoch:1});
    } finally {await hub.stop();source.close();}
  });
  it("v0 CLI and supervisor entrypoints bypass legacy services",async()=>{
    const f=fixture(),hubStop=vi.fn(async()=>{}),supervisorStop=vi.fn(async()=>{});
    const hub=vi.fn(async()=>{queueMicrotask(()=>process.emit("SIGTERM"));return {stop:hubStop};});
    const supervisor=vi.fn(async()=>{queueMicrotask(()=>process.emit("SIGTERM"));return {stop:supervisorStop};});
    const oldHub=vi.spyOn(productionHub,"startProductionHub"),oldSupervisor=vi.spyOn(productionSupervisor,"startProductionSupervisor");
    expect(await main(["roam","hub-v0"],f.io,{v0:{hub}})).toBe(0);
    expect(await supervisorMain(["--v0"],f.io,{startV0:supervisor})).toBe(0);
    expect(hubStop).toHaveBeenCalledOnce();expect(supervisorStop).toHaveBeenCalledOnce();expect(oldHub).not.toHaveBeenCalled();expect(oldSupervisor).not.toHaveBeenCalled();
    const agent=vi.spyOn(v0RuntimeApi,"runV0Agent").mockResolvedValue({ok:true,value:{version:1}});
    expect(await main(["--global-root","/fixture/root","roam","agent","--v0"],f.io,{stdin:Buffer.from('{"version":1,"kind":"hello"}')})).toBe(0);
    expect(agent).toHaveBeenCalledWith({version:1,kind:"hello"},"/fixture/root");
  });
  it("v0 service signal handling drains and removes its listeners", async () => {
    let entered!: () => void, release!: () => void;
    const starting = new Promise<void>(done => { entered = done; });
    const drain = new Promise<void>(done => { release = done; });
    const stop = vi.fn(async () => { await drain; });
    const before = process.listenerCount("SIGTERM");
    let finished = false;
    const running = runV0Service(async () => { entered(); return { stop }; }).then(() => { finished = true; });
    await starting; process.emit("SIGTERM"); await Promise.resolve();
    expect(finished).toBe(false); release(); await running;
    expect(stop).toHaveBeenCalledOnce(); expect(process.listenerCount("SIGTERM")).toBe(before);
  });
  it("the private v0 socket dispatches only the new services", async () => {
    const f = fixture(); const root = mkdtempSync(join(resolve(".spider/scratch"), "dvs-")); roots.push(root);
    const socket = await serveV0Control(root, f.services);
    try {
      const client = requestV0Services(root);
      expect(await client.relocate({ sessionId: home.sessionId, destinationMachine: box })).toMatchObject({ ok: true as const, value: { terminal: "core:term" } });
      expect(f.services.relocate).toHaveBeenCalledWith({ sessionId: home.sessionId, destinationMachine: box });
      const confirmation = `reassign session-abc to ${box}; source will not run`;
      expect(await client.setHome({ sessionId: home.sessionId, destinationMachine: box, force: true, confirmation })).toMatchObject({ ok: true as const, value: home });
      expect(f.services.setHome).toHaveBeenCalledWith({ sessionId: home.sessionId, destinationMachine: box, force: true, confirmation });
    } finally { await socket.close(); await socket.close(); }
  });
  it("v0 control drains the current request and rejects requests arriving during stop", async () => {
    const f = fixture(); const root = mkdtempSync(join(resolve(".spider/scratch"), "dvd-")); roots.push(root);
    let release!: () => void, entered!: () => void;
    const pending = new Promise<void>(done => { entered = done; });
    const success = await f.services.relocate({ sessionId: home.sessionId, destinationMachine: box });
    vi.mocked(f.services.relocate).mockClear().mockImplementationOnce(async () => { entered(); await new Promise<void>(done => { release = done; }); return success; });
    const server = await serveV0Control(root, f.services);
    const first = requestV0Services(root).relocate({ sessionId: home.sessionId, destinationMachine: box }); await pending;
    const late = createConnection(join(root, "roam", "relocate.sock")); late.on("error", () => {}); late.resume();
    await new Promise<void>(done => late.once("connect", done));
    let stopped = false; const stopping = server.close().then(() => { stopped = true; });
    const lateClosed = new Promise<void>(done => late.once("close", () => done()));
    late.write(JSON.stringify({ version: 1, kind: "relocate", request: { sessionId: home.sessionId, destinationMachine: box } }) + "\n");
    await lateClosed;
    const calls = vi.mocked(f.services.relocate).mock.calls.length;
    expect(stopped).toBe(false); release();
    expect(await first).toMatchObject({ ok: true as const }); await stopping;
    expect(calls).toBe(1);
  });
  it("private v0 agent parses bounded UTF-8 stdin before forwarding", async () => {
    const f = fixture(); const agent = vi.fn(async (_input: unknown, _root: string) => ({ ok: true as const, value: { version: 1 } }));
    expect(await main(["--global-root", "/fixture/root", "roam", "agent", "--v0"], f.io, { stdin: Buffer.from('{"version":1,"kind":"version"}'), v0: { agent } })).toBe(0);
    expect(agent).toHaveBeenCalledWith({ version: 1, kind: "version" }, "/fixture/root");
    const chunkRequest = { version: 1, kind: "chunk", data: Buffer.alloc(DEFAULT_LIMITS.chunkBytes, 7).toString("base64") };
    expect(await main(["roam", "agent", "--v0"], f.io, { stdin: Buffer.from(JSON.stringify(chunkRequest)), v0: { agent } })).toBe(0);
    expect(agent).toHaveBeenLastCalledWith(chunkRequest, expect.any(String));
    for (const stdin of [Buffer.from("{"), Buffer.from([0xff]), Buffer.alloc(4 * 1024 * 1024 + 1)]) {
      f.out.length = 0; expect(await main(["roam", "agent", "--v0"], f.io, { stdin, v0: { agent } })).toBe(2);
      expect(JSON.parse(f.out.join("")).refusal.code).toBe("invalid-arguments");
    }
    expect(agent).toHaveBeenCalledTimes(2);
  });
  it("preserves a private agent refusal across an exit-checking transport", async () => {
    const result = { ok: false as const, refusal: { code: "session-not-found" as const, message: "The session has no local location.", nextStep: "Select a locally captured session." } };
    const transport: Transport = {
      resolve: async peer => peer,
      bootstrapProbe: async () => { throw new Error("unused"); },
      run: async () => { throw new Error("unused"); },
      read: async () => { throw new Error("unused"); },
      write: async () => { throw new Error("unused"); },
      async exec(peer, argv, options) {
        let stdout = "";
        const exit = await main(["--global-root", peer.globalRoot, ...argv], { out: text => { stdout += text; }, err: () => {} }, {
          stdin: options.stdin,
          v0: { agent: async () => result },
        });
        // The real command transport rejects nonzero exits before returning bytes.
        if (exit !== 0) throw new Error(`CLI exited with ${exit}`);
        return Buffer.from(stdout);
      },
    };
    expect(await callV0(transport, config.peers[0], { version: 1, kind: "source", sessionId: "missing" }, DEFAULT_LIMITS)).toEqual(result);
  });
  it("parse relocate and forced set-home without changing move", () => {
    expect(parseV0Control(["roam", "relocate", "session-abc", "box-a.invalid", "--json"])).toEqual({ kind: "relocate", session: "session-abc", machine: "box-a.invalid" });
    expect(parseV0Control(["roam", "set-home", "first", "mac", "--force"])).toEqual({ kind: "set-home", session: "first", machine: macSelector, force: true, confirmation: null });
    for (const args of [["roam", "relocate"], ["roam", "relocate", "bad/id", "box-a.invalid"], ["roam", "relocate", "first", "-box"], ["roam", "relocate", "first", "box-a.invalid", "--yes"], ["roam", "set-home", "first", "mac"], ["roam", "set-home", "first", "mac", "--force", "--confirm", "yes"], ["move", "first", "mac"], ["roam", "move", "first", "mac"]]) expect(parseV0Control(args)).toBeNull();
    expect(parsePublicControl(["move", "first", "mac"])).toEqual({ kind: "move", session: "first", machine: macSelector });
    expect(parsePublicControl(["roam", "relocate", "first", "mac"])).toBeNull();
  });
  it("resolve session and machine with existing rules", async () => {
    for (const [target, expected] of [["first", "first"], ["session-abc", "session-abc"], ["session-abc", "session-abc"], ["second", "session-abd"]]) {
      const f = fixture(); expect(await runV0Control({ kind: "relocate", session: target, machine: "box-a.invalid" }, config, catalog, f.services, f.io)).toBe(0);
      expect(f.services.relocate).toHaveBeenCalledWith({ sessionId: expected, destinationMachine: box });
    }
    const macTarget = fixture(); await runV0Control({ kind: "relocate", session: "session-abc", machine: macSelector }, config, catalog, macTarget.services, macTarget.io);
    expect(macTarget.services.relocate).toHaveBeenCalledWith({ sessionId: "session-abc", destinationMachine: mac });
    const ambiguous = fixture(); expect(await runV0Control({ kind: "relocate", session: "session-ab", machine: "box-a.invalid" }, config, catalog, ambiguous.services, ambiguous.io)).toBe(1);
    expect(ambiguous.services.relocate).not.toHaveBeenCalled(); expect(ambiguous.err.join("")).toContain("session-abc"); expect(ambiguous.err.join("")).toContain("session-abd");
    const duplicate = fixture(); await runV0Control({ kind: "relocate", session: "first", machine: "box-a.invalid" }, { ...config, peers: [...config.peers, { ...config.peers[0], machineId: mac }] }, catalog, duplicate.services, duplicate.io);
    expect(duplicate.services.relocate).not.toHaveBeenCalled();
  });
  it.each([true, false])("set-home to the Mac explains how to start the session (enabled=%s)", async enabled => {
    const f = fixture(`reassign session-abc to ${mac}; source will not run`);
    vi.mocked(f.services.setHome).mockResolvedValue({ ok: true, value: { ...home, machineId: mac } });
    expect(await runV0Control({ kind: "set-home", session: "session-abc", machine: macSelector, force: true, confirmation: null },
      { ...config, enabled }, catalog, f.services, f.io)).toBe(0);
    const advice = f.out.join("");
    expect(advice).toContain("spider roam relocate session-abc mac");
    expect(advice.includes("spider roam enable")).toBe(!enabled);
  });
  it("prints the branch recovery command on successful relocate", async () => {
    const f = fixture();
    const result = await f.services.relocate({ sessionId: home.sessionId, destinationMachine: box });
    if (!result.ok) throw new Error("fixture expects success");
    const command = "git switch -c spider-relocated-3-111111111111 1111111111111111111111111111111111111111";
    vi.mocked(f.services.relocate).mockResolvedValue({ ok: true, value: { ...result.value, branchRecovery: { savedBranch: "main", command } } });
    expect(await runV0Control({ kind: "relocate", session: "session-abc", machine: "box-a.invalid" }, config, catalog, f.services, f.io)).toBe(0);
    expect(f.out.join("")).toContain(command);
    expect(f.out.join("")).toMatch(/detached.*main/i);
    expect(f.out.join("")).toContain("Processes started outside Spider in this folder keep running.\n");
  });
  it("relocate from a box is one actionable refusal", async () => {
    const f = fixture(); expect(await runV0Control({ kind: "relocate", session: "first", machine: macSelector }, { ...config, role: "box", machineId: box }, catalog, f.services, f.io, { json: true })).toBe(1);
    expect(JSON.parse(f.out.join(""))).toMatchObject({ ok: false, refusal: { code: "mac-required", message: expect.any(String), nextStep: expect.stringContaining("Mac") } });
    expect(f.out).toHaveLength(1); expect(f.services.relocate).not.toHaveBeenCalled();
    const disabled = fixture(); await runV0Control({ kind: "relocate", session: "first", machine: macSelector }, { ...config, enabled: false }, catalog, disabled.services, disabled.io);
    expect(disabled.services.relocate).not.toHaveBeenCalled(); expect(disabled.err.join("")).toContain("replication");
  });
  it("real confirmation requires a TTY and resolves EOF without writing JSON stdout", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = Object.assign(new PassThrough(), { isTTY: true }); let prompt = "";
    output.on("data", chunk => { prompt += chunk.toString(); });
    const eof = readV0Confirmation("Source loss risk. Type exactly the phrase: ", { input, output });
    input.end(); expect(await eof).toBeNull(); expect(prompt).toContain("Source loss risk");
    const plain = new PassThrough(), plainOutput = new PassThrough(); const data = vi.fn(); plainOutput.on("data", data);
    expect(await readV0Confirmation("No prompt", { input: plain, output: plainOutput })).toBeNull(); expect(data).not.toHaveBeenCalled();
    plain.destroy(); plainOutput.destroy(); output.destroy();
  });
  it("force prompts for the exact phrase", async () => {
    const phrase = `reassign session-abc to ${box}; source will not run`;
    for (const value of [null, "", "yes", phrase + " ", phrase.toUpperCase()]) {
      const f = fixture(value); expect(await runV0Control({ kind: "set-home", session: "session-abc", machine: "box-a.invalid", force: true, confirmation: null }, config, catalog, f.services, f.io, { json: true })).toBe(1);
      expect(f.services.setHome).not.toHaveBeenCalled(); expect(JSON.parse(f.out.join("")).refusal.code).toBe("confirmation-required");
      expect(f.prompts[0]).toContain(phrase); expect(f.prompts[0]).toMatch(/unsynced conversation.*lost/i);
      expect(f.prompts[0]).toContain("systemctl --user disable --now spider-roam-supervisor-v0.service");
      expect(f.prompts[0]).toContain("systemctl --user disable --now spider-roam-supervisor.service");
      expect(f.prompts[0]).toMatch(/before.*reconnect/i);
    }
    const f = fixture(phrase); expect(await runV0Control({ kind: "set-home", session: "session-abc", machine: "box-a.invalid", force: true, confirmation: null }, config, catalog, f.services, f.io, { json: true })).toBe(0);
    expect(f.services.setHome).toHaveBeenCalledWith({ sessionId: "session-abc", destinationMachine: box, force: true, confirmation: phrase });
  });
  it("recovers a verified Mac copy without the disabled hub service",async()=>{
    const root=mkdtempSync(join(resolve(".spider/scratch"),"of-"));roots.push(root);
    mkdirSync(join(root,"roam"),{mode:0o700});
    writeFileSync(join(root,"roam","config.json"),JSON.stringify({...config,enabled:false}),{mode:0o600});
    writeFileSync(join(root,"roam","machine.json"),JSON.stringify({machineId:mac}),{mode:0o600});
    const file=join(root,"backup.jsonl"), sid=home.sessionId, dbPath=join(root,"spider.db");
    writeFileSync(file, JSON.stringify({type:"session",version:3,id:sid,cwd:root,timestamp:"2020-01-01T00:00:00Z"})+"\n"+
      JSON.stringify({type:"message",id:"entry",parentId:null,timestamp:"2020-01-01T00:00:00Z",message:{role:"user",content:[{type:"text",text:"backup"}]}})+"\n");
    const db=openDbAt(dbPath,"global");
    try {
      db.prepare("UPDATE roam_meta SET machine_id=?,store_key='global' WHERE id=1").run(mac);
      const homes=createHomeStore({db,localMachineId:mac,hubMachineId:mac});
      const original=await homes.initialize(sid,mac);
      expect(await homes.compareAndSwap(original,{...original,machineId:box,epoch:2,moveId:"v0-33333333-3333-4333-8333-333333333333" as RelocateId})).toMatchObject({kind:"applied"});
      db.prepare("INSERT INTO roam_locations(session_id,stores_json,file,cwd) VALUES (?,'[\"global\"]',?,?)").run(sid,file,root);
      writeLocal(db,"relocate-managed",sid,{sessionId:sid,machineId:mac,repoKey:"repo",workspaceId:"ws",repository:root,cwd:root,file,stores:["global"],historyMachine:mac});
    } finally {db.close();}
    vi.stubEnv("SPIDER_GLOBAL_ROOT",root);vi.stubEnv("HC_SESSION","fixture");vi.stubEnv("HC_SOCKET",join(root,"hc.sock"));
    const f=fixture(`reassign ${sid} to ${mac}; source will not run`);
    const code=await main(["roam","set-home",sid,"mac","--force","--json"],f.io,{v0:{confirmation:f.io.confirmation}});
    expect(JSON.parse(f.out.join("")),f.out.join("")).toMatchObject({ok:true,value:{machineId:mac,epoch:3,state:"running"}});
    expect(code).toBe(0);
    const saved=openDbAt(dbPath,"global");
    try {expect(saved.prepare("SELECT machine_id,epoch FROM session_homes WHERE session_id=?").get(sid)).toEqual({machine_id:mac,epoch:3});}
    finally {saved.close();}
  });
  it("refuses a disabled remote assignment before confirm but allows recovery to the Mac", async () => {
    const disabled = { ...config, enabled: false }, remote = fixture();
    const request = { kind: "set-home", session: "session-abc", machine: "box-a.invalid", force: true, confirmation: null } as const;
    expect(await runV0Control(request, disabled, catalog, remote.services, remote.io, { json: true })).toBe(1);
    expect(remote.io.confirmation).not.toHaveBeenCalled();
    expect(remote.services.setHome).not.toHaveBeenCalled();
    expect(JSON.parse(remote.out.join(""))).toMatchObject({ ok: false, refusal: { code: "replication-disabled", nextStep: expect.stringContaining("spider roam enable") } });

    const phrase = `reassign session-abc to ${mac}; source will not run`, local = fixture(phrase);
    expect(await runV0Control({ ...request, machine: macSelector }, disabled, catalog, local.services, local.io)).toBe(0);
    expect(local.services.setHome).toHaveBeenCalledWith({ sessionId: "session-abc", destinationMachine: mac, force: true, confirmation: phrase });
  });
  it.each(["healthy", "stale", "unsafe"] as const)("looks up a fresh session with %s project registrations", async scenario => {
    const f = fixture();
    const root = mkdtempSync(join(resolve(".spider/scratch"), "fresh-cli-")); roots.push(root);
    mkdirSync(join(root, "roam"), { mode: 0o700 });
    writeFileSync(join(root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
    const globalPath = join(root, "spider.db");
    const global = openDbAt(globalPath, "global");
    const projectRoot = join(root, "project"); mkdirSync(projectRoot);
    const projectPath = join(projectRoot, "project.db");
    const project = openDbAt(projectPath, "worktree");
    setGlobalDbPathForTests(globalPath);
    try {
      // Session startup registers the project before inserting its session row.
      registerProject({ projectKey: projectRoot, realPath: projectRoot, dbPath: projectPath });
      if (scenario === "stale") {
        const missing = join(root, "removed-worktree"), unreadable = join(root, "unreadable-worktree");
        mkdirSync(unreadable);
        writeFileSync(join(unreadable, "project.db"), "not a SQLite database\n");
        for (const path of [missing, unreadable]) {
          registerProject({ projectKey: path, realPath: path, dbPath: join(path, "project.db") });
        }
      } else if (scenario === "unsafe") {
        const unsafe = join(root, "unsafe.db");
        symlinkSync(projectPath, unsafe);
        registerProject({ projectKey: unsafe, realPath: root, dbPath: unsafe });
      }
      project.prepare("INSERT INTO sessions(id,name,started_at) VALUES (?,?,?)").run("session-abc", "fresh", 1);
      expect(global.prepare("SELECT name FROM sqlite_master WHERE name='sessions'").get()).toBeUndefined();
      expect(global.prepare("SELECT session_id FROM roam_locations").all()).toEqual([]);
      if (scenario === "stale") {
        global.prepare("INSERT INTO roam_locations(session_id,stores_json) VALUES (?,?)").run("moved-session", '["global"]');
      }
      expect(project.prepare("SELECT store_key FROM roam_meta WHERE id=1").get()).toEqual({ store_key: null });
      global.prepare("UPDATE roam_meta SET machine_id=? WHERE id=1").run(mac);
      writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId: mac }), { mode: 0o600 });
      // Publish both WALs before the CLI's independent read-only handles open.
      project.close(); global.close();
      vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
      if (scenario === "unsafe") {
        expect(await main(["roam", "relocate", "fresh", "box-a.invalid", "--json"], f.io, { v0: { services: f.services } })).toBe(1);
        expect(JSON.parse(f.out.join(""))).toMatchObject({ ok: false, refusal: {
          message: expect.stringContaining("session catalog"), nextStep: expect.stringContaining("spider roam doctor"),
        } });
        expect(f.services.relocate).not.toHaveBeenCalled();
        return;
      }
      for (const target of ["session-abc", "session-ab", "fresh"]) {
        f.out.length = 0;
        f.err.length = 0;
        const code = await main(["roam", "relocate", target, "box-a.invalid", "--json"], f.io, { v0: { services: f.services } });
        expect(JSON.parse(f.out.join(""))).toMatchObject({ ok: true, value: { home: { sessionId: "session-abc", machineId: box } } });
        expect(code).toBe(0);
        expect(f.services.relocate).toHaveBeenLastCalledWith({ sessionId: "session-abc", destinationMachine: box });
        if (scenario === "stale") expect(f.err.join("")).toMatch(/skipped 2 project databases/i);
        else expect(f.err).toEqual([]);
      }
      if (scenario === "stale") {
        f.out.length = 0;
        f.err.length = 0;
        const confirmation = `reassign moved-session to ${mac}; source will not run`;
        vi.mocked(f.services.setHome).mockResolvedValueOnce({ ok: true, value: { ...home, sessionId: "moved-session" as SessionId, machineId: mac } });
        const code = await main(["roam", "set-home", "moved-session", "mac", "--force"], f.io, { v0: { services: f.services, confirmation: async () => confirmation } });
        expect(code).toBe(0);
        expect(f.services.setHome).toHaveBeenCalledWith({ sessionId: "moved-session", destinationMachine: mac, force: true, confirmation });
        expect(f.err.join("")).toMatch(/skipped 2 project databases/i);
      }
    } finally { setGlobalDbPathForTests(null); project.close(); global.close(); }
  });
  it("v0 controls bypass legacy hub and deferred gates", async () => {
    const f = fixture(); const root = mkdtempSync(join(resolve(".spider/scratch"), "dv0-")); roots.push(root); mkdirSync(join(root, "roam"), { mode: 0o700 });
    writeFileSync(join(root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 }); writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId: mac }), { mode: 0o600 }); vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
    const forbidden = [vi.spyOn(legacySocket, "requestHubControl"), vi.spyOn(productionHub, "startProductionHub"), vi.spyOn(productionSupervisor, "startProductionSupervisor"), vi.spyOn(controls, "enableRoaming"), vi.spyOn(diagnostics, "runLocalDoctor")];
    expect(await main(["roam", "relocate", "session-abc", "box-a.invalid", "--json"], f.io, { v0: { services: f.services, catalog, confirmation: f.io.confirmation } })).toBe(0);
    expect(JSON.parse(f.out.join(""))).toMatchObject({ ok: true as const, value: { home: { machineId: box }, terminal: "core:term" } });
    for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
    vi.mocked(f.services.relocate).mockResolvedValueOnce({ ok: false, refusal: { code: "start-pending", message: "The session has not started.", nextStep: "Retry relocation on the Mac." }, step: "confirm", home, moveId: null });
    f.out.length = 0; expect(await main(["roam", "relocate", "session-abc", "box-a.invalid", "--json"], f.io, { v0: { services: f.services, catalog } })).toBe(1);
    expect(JSON.parse(f.out.join(""))).toMatchObject({ step: "confirm", refusal: { code: "start-pending", nextStep: "Retry relocation on the Mac." } });
    for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
  });
});
