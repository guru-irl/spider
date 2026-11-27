import { describe, expect, it, vi } from "vitest";
import type { MachineId } from "@spider/db-core/roam/types";
import { setHome } from "../relocate/set-home";
import type { HomeStore, RelocateHome, RelocateId, RunningHome, SessionId, SessionPlacement, SetHomePorts, SetHomeRequest, V0Result } from "../relocate/types";

const HUB = "11111111-1111-4111-8111-111111111111" as MachineId;
const TARGET = "22222222-2222-4222-8222-222222222222" as MachineId;
const OTHER = "33333333-3333-4333-8333-333333333333" as MachineId;
const ID = "session-1" as SessionId;
const MOVE = "v0-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as RelocateId;
const INITIAL: RunningHome = {sessionId:ID,machineId:HUB,epoch:7,state:"running",destination:null,moveId:null,updatedAt:91};
const COPY: SessionPlacement = {sessionId:ID,machineId:TARGET,repoKey:"repo",workspaceId:"workspace",repository:"/copy/repo",cwd:"/copy/repo",file:"/copy/session.jsonl",stores:[],historyMachine:HUB};
const REQUEST: SetHomeRequest = {sessionId:ID,destinationMachine:TARGET,force:true,confirmation:`reassign ${ID} to ${TARGET}; source will not run`};
const ok = <T>(value:T): V0Result<T> => ({ok:true,value});
function fake() {
  let home: RelocateHome | null = structuredClone(INITIAL);
  const calls: string[] = [];
  const homes: HomeStore = {
    read: vi.fn(async () => home), list: vi.fn(async () => home ? [home] : []),
    initialize: vi.fn(async () => { throw new Error("must not initialize"); }),
    compareAndSwap: vi.fn<HomeStore["compareAndSwap"]>(async (expected,next) => {
      calls.push("cas"); expect(expected).toEqual(INITIAL);
      home = structuredClone(next); return {kind:"applied",home};
    }),
  };
  const ports: SetHomePorts = {
    homes,
    newMoveId:vi.fn(()=>MOVE),
    withSession:vi.fn(async (_id,run)=> { calls.push("lock"); return run(); }),
    locate:vi.fn(async (machine,id)=> { calls.push("locate"); expect([machine,id]).toEqual([TARGET,ID]); return ok(COPY); }),
    activate:vi.fn(async (assigned,placement)=> { calls.push("activate"); expect(assigned).toEqual(home); expect(placement).toEqual(COPY); return ok(undefined); }),
    publishHome:vi.fn(async (assigned,machine)=> {calls.push("publish");expect(assigned).toEqual(home);expect(machine).toBe(TARGET);return ok(undefined);}),
    start:vi.fn(async ()=> {throw new Error("must not start");}),
    confirm:vi.fn(async ()=> {throw new Error("must not confirm");}),
  };
  const source = { probe:vi.fn(), freeze:vi.fn(), intercom:vi.fn(), recover:vi.fn() };
  // Disabled replication and unavailable source capabilities are deliberately not preflight ports.
  const injected = {...ports, enabled:false, source};
  return {ports:injected,homes,calls,source,current:()=>home,winner:(value:RelocateHome)=>{home=value;}};
}

describe("forced v0 reassignment", () => {
  it("force requires exact human confirmation", async () => {
    for (const request of [
      {...REQUEST,force:false}, {...REQUEST,confirmation:""},
      {...REQUEST,confirmation:`reassign another to ${TARGET}; source will not run`},
      {...REQUEST,confirmation:`reassign ${ID} to ${OTHER}; source will not run`},
      {...REQUEST,confirmation:"yes"}, {...REQUEST,confirmation:REQUEST.confirmation+" "},
    ]) {
      const f = fake(), result = await setHome(request,f.ports);
      expect(result).toMatchObject({ok:false,refusal:{code:"confirmation-required"}});
      if (!result.ok) {
        expect(result.refusal.message).toMatch(/source.*never run|source.*not run/i);
        expect(result.refusal.message).toMatch(/unsynced.*lost/i);
      }
      expect(f.current()).toEqual(INITIAL); expect(f.calls).toEqual([]);
      expect(f.homes.compareAndSwap).not.toHaveBeenCalled(); expect(f.homes.initialize).not.toHaveBeenCalled();
    }
  });

  it("force without a destination copy leaves home unchanged", async () => {
    const f=fake();
    vi.mocked(f.ports.locate).mockImplementation(async () => { f.calls.push("locate"); return {ok:false,refusal:{code:"destination-copy-missing",message:"No destination copy.",nextStep:"Choose a machine with a copy."}}; });
    const result=await setHome(REQUEST,f.ports);
    expect(result).toMatchObject({ok:false,refusal:{code:"destination-copy-missing"}});
    expect(f.current()).toEqual(INITIAL); expect(f.calls).toEqual(["lock","locate"]);
    expect(f.homes.compareAndSwap).not.toHaveBeenCalled();
    expect(f.ports.activate).not.toHaveBeenCalled();expect(f.ports.publishHome).not.toHaveBeenCalled();
    for (const call of Object.values(f.source)) expect(call).not.toHaveBeenCalled();
  });

  it("confirmed force does not contact the source", async () => {
    const f=fake(), result=await setHome(REQUEST,f.ports);
    expect(result).toMatchObject({ok:true,value:{sessionId:ID,machineId:TARGET,epoch:8,state:"running",destination:null,moveId:MOVE}});
    expect(f.calls).toEqual(["lock","locate","cas","activate","publish"]);
    expect(f.ports.withSession).toHaveBeenCalledWith(ID,expect.any(Function));
    expect(f.homes.initialize).not.toHaveBeenCalled();
    expect(f.ports.start).not.toHaveBeenCalled();expect(f.ports.confirm).not.toHaveBeenCalled();
    for (const call of Object.values(f.source)) expect(call).not.toHaveBeenCalled();
  });

  it("disabled replication refuses an away assignment before looking up the copy or changing the home", async () => {
    const f = fake();
    const result = await setHome(REQUEST, f.ports, { enabled: false, machineId: HUB });
    expect(result).toMatchObject({ok:false,refusal:{code:"replication-disabled",nextStep:expect.stringContaining("spider roam enable")}});
    expect(f.current()).toEqual(INITIAL);
    expect(f.ports.locate).not.toHaveBeenCalled();
    expect(f.homes.compareAndSwap).not.toHaveBeenCalled();
    expect(f.ports.activate).not.toHaveBeenCalled();
    expect(f.ports.publishHome).not.toHaveBeenCalled();
  });

  it("forced CAS conflict does not activate", async () => {
    const f=fake(), winner:RunningHome={...INITIAL,epoch:8,machineId:OTHER,updatedAt:99};
    vi.mocked(f.homes.compareAndSwap).mockImplementation(async ()=>{f.winner(winner);f.calls.push("cas");return {kind:"conflict",home:winner};});
    expect(await setHome(REQUEST,f.ports)).toMatchObject({ok:false,refusal:{code:"home-conflict"}});
    expect(f.current()).toEqual(winner);expect(f.calls).toEqual(["lock","locate","cas"]);
    expect(f.ports.activate).not.toHaveBeenCalled();expect(f.ports.publishHome).not.toHaveBeenCalled();
  });
});
