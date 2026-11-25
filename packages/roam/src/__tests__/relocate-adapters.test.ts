import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openJournal } from "../journal";
import { createRelocateJournal } from "../relocate/journal";
import { createV0SyncTransport } from "../relocate/remote";
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
describe("relocate adapters", () => {
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
