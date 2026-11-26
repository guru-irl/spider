import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnection } from "node:net";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_LIMITS, disabledIntercom, type RoamConfig } from "../contracts";
import type { RunningHome, SessionId, V0ControlServices } from "../relocate/types";
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
import { writeLocal } from "@spider/db-core/roam/local-state";
import { createV0Runtime, startV0Hub, startV0Supervisor } from "../relocate/runtime";
import { handleRelocateAgent } from "../relocate/remote";
import * as hcApi from "@spider/herdr/client/hc";
import type { CoreIdentity } from "@spider/herdr/contracts";
import type { Transport } from "../contracts";

const mac = "11111111-1111-4111-8111-111111111111", box = "22222222-2222-4222-8222-222222222222";
const config: RoamConfig = { enabled: true, role: "hub", machineId: mac, hubMachineId: mac, peers: [{ machineId: box, alias: "box-a", node: "/node", pi: "/pi", cli: "/spider", core: "/core", globalRoot: "/root" }], discoveryRoots: [], coreUnit: "core", syncMs: 10_000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
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
  it("production v0 runtime composes only approved ports", async () => {
    const source=createReplica("global",mac),target=createReplica("global",box);
    const sourceConfig={...config,peers:[{...config.peers[0],globalRoot:target.root}]};
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
      const file=join(source.root,"session.jsonl"),pi=join(source.root,"pi");
      writeFileSync(file,JSON.stringify({type:"session",version:3,id:sid,cwd:source.root,timestamp:"2020-01-01T00:00:00Z"})+"\n"+JSON.stringify({type:"message",id:"entry",parentId:null,timestamp:"2020-01-01T00:00:00Z",message:{role:"user",content:[{type:"text",text:"synthetic"}]}})+"\n");
      writeFileSync(pi,"#!/bin/sh\n",{mode:0o700});vi.stubEnv("SPIDER_ROAM_PI",pi);
      writeLocal(source.db,"relocate-managed",sid,{sessionId:sid,machineId:mac,repoKey:"repo",workspaceId:"ws",repository:source.root,cwd:source.root,file,stores:["global"],historyMachine:mac});
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
  it("v0 hub and supervisor entries drain on shutdown",async()=>{
    const source=createReplica("global",mac),target=createReplica("global",box);
    const idle={now:()=>1,later:()=>()=>{}};
    const hub=await startV0Hub(source.root,{openCore:()=>({root:source.root,config:{...config,enabled:false,peers:[]},db:source.db,close:vi.fn()}),clock:idle});
    const supervisor=await startV0Supervisor(target.root,{openCore:()=>({root:target.root,config:{...config,role:"box",machineId:box,enabled:false,peers:[]},db:target.db,close:vi.fn()}),clock:idle});
    try {expect(await requestV0Services(source.root).setHome({sessionId:"missing" as SessionId,destinationMachine:mac,force:true,confirmation:"bad"})).toMatchObject({ok:false,refusal:{code:"confirmation-required"}});}
    finally {await hub.stop();await hub.stop();await supervisor.stop();await supervisor.stop();source.close();target.close();}
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
  it("parse relocate and forced set-home without changing move", () => {
    expect(parseV0Control(["roam", "relocate", "session-abc", "box-a", "--json"])).toEqual({ kind: "relocate", session: "session-abc", machine: "box-a" });
    expect(parseV0Control(["roam", "set-home", "first", "mac", "--force"])).toEqual({ kind: "set-home", session: "first", machine: "mac", force: true, confirmation: null });
    for (const args of [["roam", "relocate"], ["roam", "relocate", "bad/id", "box-a"], ["roam", "relocate", "first", "-box"], ["roam", "relocate", "first", "box-a", "--yes"], ["roam", "set-home", "first", "mac"], ["roam", "set-home", "first", "mac", "--force", "--confirm", "yes"], ["move", "first", "mac"], ["roam", "move", "first", "mac"]]) expect(parseV0Control(args)).toBeNull();
    expect(parsePublicControl(["move", "first", "mac"])).toEqual({ kind: "move", session: "first", machine: "mac" });
    expect(parsePublicControl(["roam", "relocate", "first", "mac"])).toBeNull();
  });
  it("resolve session and machine with existing rules", async () => {
    for (const [target, expected] of [["first", "first"], ["session-abc", "session-abc"], ["session-abc", "session-abc"], ["second", "session-abd"]]) {
      const f = fixture(); expect(await runV0Control({ kind: "relocate", session: target, machine: "box-a" }, config, catalog, f.services, f.io)).toBe(0);
      expect(f.services.relocate).toHaveBeenCalledWith({ sessionId: expected, destinationMachine: box });
    }
    const macTarget = fixture(); await runV0Control({ kind: "relocate", session: "session-abc", machine: "mac" }, config, catalog, macTarget.services, macTarget.io);
    expect(macTarget.services.relocate).toHaveBeenCalledWith({ sessionId: "session-abc", destinationMachine: mac });
    const ambiguous = fixture(); expect(await runV0Control({ kind: "relocate", session: "session-ab", machine: "box-a" }, config, catalog, ambiguous.services, ambiguous.io)).toBe(1);
    expect(ambiguous.services.relocate).not.toHaveBeenCalled(); expect(ambiguous.err.join("")).toContain("session-abc"); expect(ambiguous.err.join("")).toContain("session-abd");
    const duplicate = fixture(); await runV0Control({ kind: "relocate", session: "first", machine: "box-a" }, { ...config, peers: [...config.peers, { ...config.peers[0], machineId: mac }] }, catalog, duplicate.services, duplicate.io);
    expect(duplicate.services.relocate).not.toHaveBeenCalled();
  });
  it("relocate from a box is one actionable refusal", async () => {
    const f = fixture(); expect(await runV0Control({ kind: "relocate", session: "first", machine: "mac" }, { ...config, role: "box", machineId: box }, catalog, f.services, f.io, { json: true })).toBe(1);
    expect(JSON.parse(f.out.join(""))).toMatchObject({ ok: false, refusal: { code: "mac-required", message: expect.any(String), nextStep: expect.stringContaining("Mac") } });
    expect(f.out).toHaveLength(1); expect(f.services.relocate).not.toHaveBeenCalled();
    const disabled = fixture(); await runV0Control({ kind: "relocate", session: "first", machine: "mac" }, { ...config, enabled: false }, catalog, disabled.services, disabled.io);
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
      const f = fixture(value); expect(await runV0Control({ kind: "set-home", session: "session-abc", machine: "box-a", force: true, confirmation: null }, config, catalog, f.services, f.io, { json: true })).toBe(1);
      expect(f.services.setHome).not.toHaveBeenCalled(); expect(JSON.parse(f.out.join("")).refusal.code).toBe("confirmation-required");
      expect(f.prompts[0]).toContain(phrase); expect(f.prompts[0]).toMatch(/unsynced conversation.*lost/i);
    }
    const f = fixture(phrase); expect(await runV0Control({ kind: "set-home", session: "session-abc", machine: "box-a", force: true, confirmation: null }, { ...config, enabled: false }, catalog, f.services, f.io, { json: true })).toBe(0);
    expect(f.services.setHome).toHaveBeenCalledWith({ sessionId: "session-abc", destinationMachine: box, force: true, confirmation: phrase });
  });
  it("v0 controls bypass legacy hub and deferred gates", async () => {
    const f = fixture(); const root = mkdtempSync(join(resolve(".spider/scratch"), "dv0-")); roots.push(root); mkdirSync(join(root, "roam"), { mode: 0o700 });
    writeFileSync(join(root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 }); writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId: mac }), { mode: 0o600 }); vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
    const forbidden = [vi.spyOn(legacySocket, "requestHubControl"), vi.spyOn(productionHub, "startProductionHub"), vi.spyOn(productionSupervisor, "startProductionSupervisor"), vi.spyOn(controls, "enableRoaming"), vi.spyOn(diagnostics, "runLocalDoctor")];
    expect(await main(["roam", "relocate", "session-abc", "box-a", "--json"], f.io, { v0: { services: f.services, catalog, confirmation: f.io.confirmation } })).toBe(0);
    expect(JSON.parse(f.out.join(""))).toMatchObject({ ok: true as const, value: { home: { machineId: box }, terminal: "core:term" } });
    for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
    vi.mocked(f.services.relocate).mockResolvedValueOnce({ ok: false, refusal: { code: "start-pending", message: "The session has not started.", nextStep: "Retry relocation on the Mac." }, step: "confirm", home, moveId: null });
    f.out.length = 0; expect(await main(["roam", "relocate", "session-abc", "box-a", "--json"], f.io, { v0: { services: f.services, catalog } })).toBe(1);
    expect(JSON.parse(f.out.join(""))).toMatchObject({ step: "confirm", refusal: { code: "start-pending", nextStep: "Retry relocation on the Mac." } });
    for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
  });
});
