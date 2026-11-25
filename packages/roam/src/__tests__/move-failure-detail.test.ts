import { expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { DEFAULT_LIMITS, disabledIntercom, type MovePorts } from "../contracts";
import { safeControlOutcome, controlText } from "../commands";
import { openFreezeJournal } from "../journal";
import { moveEvidence, moveSession } from "../move";

const HUB = "00000000-0000-4000-8000-000000000001", DESTINATION = "00000000-0000-4000-8000-000000000002";

it.each([
  ["coded", "transport-refused", "transport-refused"],
  ["uncoded", undefined, "unknown"],
  ["unsafe", "/fixture/private-file", "unknown"],
  ["uppercase", "EACCES", "unknown"],
  ["too long", "a".repeat(65), "unknown"],
  ["maximum length", "a".repeat(64), "a".repeat(64)],
])("names a %s preflight error without changing the public fallback", async (_name, code, detailCode) => {
  const global = createReplica("global", HUB);
  try {
    mkdirSync(join(global.root, "roam"), { mode: 0o700 });
    const journal = openFreezeJournal(join(global.root, "roam", "journal.db"));
    const ports = { globalDb: global.db, journal,
      config: { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [],
        coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() },
      intercom: { address: { sessionId: "session-a", scopeId: null }, destinationEndpoint: async () => null,
        ports: Object.fromEntries(["close", "drain", "inspect", "checkGeneration", "abort", "ready"].map(name => [name, async () => {}])) },
      check: async () => { throw Object.assign(new Error("PRIVATE-ERROR-SENTINEL"), { code }); },
    } as unknown as MovePorts;
    const request = { sessionId: "session-a", destinationMachine: DESTINATION,
      operation: { id: "move-a", kind: "move", machineId: HUB, expectedEpoch: null,
        args: { sessionId: "session-a", destinationMachine: DESTINATION } } };
    const result = await moveSession(request, ports);
    expect(result).toMatchObject({ code: 1, reason: "move-preflight-refused", causeCode: "move-adapter-unavailable",
      failure: { step: "preflight", code: detailCode } });
    const safe = safeControlOutcome(result);
    expect(safe).toMatchObject({ causeCode: "move-adapter-unavailable", failure: { step: "preflight", code: detailCode } });
    expect(safeControlOutcome(safe)).toEqual(safe);
    expect(controlText(safe)).toContain(`preflight: ${detailCode}`);
    expect(JSON.stringify(safe)).not.toContain("PRIVATE-ERROR-SENTINEL");
    expect(JSON.stringify(safe)).not.toContain("/fixture/private-file");
    expect(journal.read(request.operation.id)).toContainEqual(expect.objectContaining({ action: "move-failure",
      result: { step: "preflight", code: detailCode } }));
    expect(await moveSession(request, ports)).toEqual(result);
    expect(moveEvidence.completedOutcome(JSON.parse(JSON.stringify(result)), request.operation.id)).toEqual(result);
    expect(() => moveEvidence.completedOutcome({ ...result, failure: { step: "preflight", code: "unsafe\ncode" } }, request.operation.id)).toThrow();
  } finally { global.close(); }
});

it.each([
  { step: "untrusted-step", code: "transport-refused" },
  { step: "preflight", code: "unsafe\ncode" },
  { step: "/fixture/private", code: "transport-refused" },
])("does not serialize forged move failure details: %j", failure => {
  const safe = safeControlOutcome({ code: 1, reason: "move-preflight-refused", operationId: "move-a", home: null,
    epoch: null, repairCommand: null, value: null, causeCode: "move-adapter-unavailable", failure } as never);
  expect(safe).not.toHaveProperty("failure");
});
