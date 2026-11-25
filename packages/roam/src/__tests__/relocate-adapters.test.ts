import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openJournal } from "../journal";
import { createRelocateJournal } from "../relocate/journal";
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
