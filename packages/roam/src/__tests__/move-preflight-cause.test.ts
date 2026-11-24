import { expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { DEFAULT_LIMITS, disabledIntercom, type MovePorts } from "../contracts";
import { openFreezeJournal } from "../journal";
import { moveEvidence, resumeMove } from "../move";
import { MoveAdapterError } from "../move-ports";
import { MoveCompositionError } from "../move-failure";

it("a failed workspace preflight names the missing Pi and its repair", async () => {
  const global = createReplica("global", "00000000-0000-4000-8000-000000000001");
  try {
    mkdirSync(join(global.root, "roam"), { mode: 0o700 });
    const ports = { globalDb: global.db, config: { enabled: true, role: "hub", machineId: global.machineId, hubMachineId: global.machineId,
      peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() },
      journal: openFreezeJournal(join(global.root, "roam", "journal.db")),
      check: async () => { throw new MoveCompositionError("participant-pi-unavailable"); } } as unknown as MovePorts;
    const request = { sessionId: "session-a", destinationMachine: "00000000-0000-4000-8000-000000000002",
      operation: { id: "move-a", kind: "move", machineId: global.machineId, expectedEpoch: null,
        args: { sessionId: "session-a", destinationMachine: "00000000-0000-4000-8000-000000000002" } } };
    const result = await resumeMove(request, ports);
    expect(result).toMatchObject({ code: 1, reason: "move-preflight-refused", causeCode: "participant-pi-unavailable",
      repairCommand: "spider roam doctor", refusal: { blockers: ["participant-pi-unavailable"] } });
    if (result.ok) throw new Error("Expected a move refusal");
    expect(result.refusal.message).toContain("SPIDER_ROAM_PI");
    expect(await resumeMove(request, ports)).toEqual(result);
    ports.check = async () => { throw new MoveAdapterError("participant-pi-unavailable"); };
    expect(await resumeMove({ ...request, operation: { ...request.operation, id: "move-b" } }, ports))
      .toMatchObject({ code: 1, causeCode: "participant-pi-unavailable", repairCommand: "spider roam doctor",
        refusal: { blockers: ["participant-pi-unavailable"] } });
    expect(moveEvidence.outcome(request, ports, 3, "move-pending", null, [], "participant-pi-unavailable").repairCommand)
      .toBe("spider roam recover move-a");
    expect(() => moveEvidence.completedOutcome({ ...result, causeCode: "private-forged-cause",
      refusal: { ...result.refusal, message: "Move preflight could not be verified." } }, request.operation.id)).toThrow();
  } finally { global.close(); }
});
