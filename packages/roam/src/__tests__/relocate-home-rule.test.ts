import { expect, it } from "vitest";
import type { MachineId } from "@spider/db-core/roam/types";
import { canRunHome } from "../relocate/home-rule";
import type { RelocateHome, RelocateId, SessionId } from "../relocate/types";

const LOCAL = "11111111-1111-4111-8111-111111111111" as MachineId;
const FOREIGN = "22222222-2222-4222-8222-222222222222" as MachineId;
const base = { sessionId:"session-1" as SessionId,machineId:LOCAL,epoch:1,moveId:null,updatedAt:10 };
it("only a local running home admits", () => {
  const homes: Array<[RelocateHome | null, boolean]> = [
    [{...base,state:"running",destination:null},true],
    [{...base,machineId:FOREIGN,state:"running",destination:null},false],
    [{...base,machineId:FOREIGN,state:"moving",destination:LOCAL,moveId:"v0-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as RelocateId},false],
    [{...base,state:"moving",destination:FOREIGN,moveId:"v0-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as RelocateId},false],
    [{...base,state:"stopped",destination:null},false],
    [null,false],
  ];
  for (const [home,want] of homes) expect(canRunHome(home,LOCAL),JSON.stringify(home)).toBe(want);
});
