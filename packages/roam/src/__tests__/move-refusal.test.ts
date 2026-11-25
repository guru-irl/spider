import { expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDbReadOnly } from "@spider/db-core";
import { createReplica } from "@spider/db-core/testutil";
import { DEFAULT_LIMITS, disabledIntercom, type MovePorts, type MoveRequest } from "../contracts";
import { controlText, safeControlOutcome } from "../commands";
import { openFreezeJournal } from "../journal";
import { moveSession } from "../move";

const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002";

it.each([
  ["disabled", "roaming-disabled", 1],
  ["box", "move-requires-hub", 1],
  ["invalid", "move-request-invalid", 2],
  ["intercom", "intercom-fence-unsupported", 1],
] as const)("names and journals the %s refusal without reserving the session", async (mode, reason, code) => {
  const global = createReplica("global", HUB);
  try {
    mkdirSync(join(global.root, "roam"), { mode: 0o700 });
    const file = join(global.root, "roam", "journal.db"), journal = openFreezeJournal(file);
    const request: MoveRequest = { sessionId: "session-a", destinationMachine: BOX,
      operation: { id: "move-refused", kind: "move", machineId: HUB, expectedEpoch: null,
        args: { sessionId: "session-a", destinationMachine: BOX } } };
    if (mode === "invalid") request.operation.kind = "not-move";
    const ports = { globalDb: global.db, journal,
      config: { enabled: mode !== "disabled", role: mode === "box" ? "box" : "hub", machineId: HUB, hubMachineId: HUB,
        peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() },
      intercom: null,
      check: async () => { throw new Error("Unexpected check"); },
    } as unknown as MovePorts;
    const result = await moveSession(request, ports);
    expect(result).toMatchObject({ code, reason, failure: { step: "preflight", code: reason } });
    expect(safeControlOutcome(result)).toHaveProperty("failure", { step: "preflight", code: reason });
    expect(controlText(safeControlOutcome(result))).toContain(`preflight: ${reason}`);
    expect(await moveSession(request, ports)).toEqual(result);
    expect(journal.read(request.operation.id)).toEqual([]);
    const reader = openDbReadOnly(file)!;
    try {
      const rows = reader.prepare("SELECT result_json FROM roam_operation_actions WHERE action='move-failure'").all() as { result_json: string }[];
      expect(rows.map(row => JSON.parse(row.result_json))).toEqual([{ step: "preflight", code: reason }]);
      expect(reader.prepare("SELECT 1 FROM roam_operations WHERE kind='move-session'").all()).toEqual([]);
    } finally { reader.close(); }
  } finally { global.close(); }
});

it("journals a conflicting request separately without changing the original operation", async () => {
  const global = createReplica("global", HUB);
  try {
    mkdirSync(join(global.root, "roam"), { mode: 0o700 });
    const journal = openFreezeJournal(join(global.root, "roam", "journal.db"));
    const request: MoveRequest = { sessionId: "session-a", destinationMachine: BOX, operation: { id: "move-conflict", kind: "move", machineId: HUB,
      expectedEpoch: null, args: { sessionId: "session-a", destinationMachine: BOX } } };
    journal.begin(request.operation);
    journal.record(request.operation.id, "move-request", JSON.parse(JSON.stringify(request)));
    const before = journal.read(request.operation.id);
    const ports = { globalDb: global.db, journal, config: { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB,
      peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() },
      intercom: { address: { sessionId: "session-a", scopeId: null }, destinationEndpoint: async () => null,
        ports: Object.fromEntries(["close", "drain", "inspect", "checkGeneration", "abort", "ready"].map(name => [name, async () => {}])) },
    } as unknown as MovePorts;
    const result = await moveSession({ ...request, operation: { ...request.operation, expectedEpoch: 2 } }, ports);
    expect(result).toMatchObject({ code: 2, reason: "move-operation-conflict", failure: { step: "preflight", code: "move-operation-conflict" } });
    expect(journal.read(request.operation.id)).toEqual(before);
  } finally { global.close(); }
});

it("adds a failure diagnostic when replaying a legacy completed first-home refusal", async () => {
  const global = createReplica("global", HUB);
  try {
    mkdirSync(join(global.root, "roam"), { mode: 0o700 });
    const journal = openFreezeJournal(join(global.root, "roam", "journal.db"));
    const request: MoveRequest = { sessionId: "session-a", destinationMachine: BOX, operation: { id: "move-legacy", kind: "move", machineId: HUB,
      expectedEpoch: null, args: { sessionId: "session-a", destinationMachine: BOX } } };
    journal.begin(request.operation);
    journal.record(request.operation.id, "move-request", JSON.parse(JSON.stringify(request)));
    journal.record(request.operation.id, "done", { code: 1, ok: false, reason: "move-source-home-mismatch", operationId: request.operation.id,
      home: null, epoch: null, repairCommand: "spider roam doctor", value: null, causeCode: "move-first-home-withheld", refusal: {
        code: "move-source-home-mismatch", blockers: [],
        message: "Seed and sync did not confirm the expected source home. Restore the reported store on the named machine, then retry the move.",
        firstHomeWithheld: { machineId: BOX, storeKind: "worktree" },
      } });
    const before = journal.read(request.operation.id);
    const ports = { globalDb: global.db, journal, config: { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB,
      peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() },
      intercom: { address: { sessionId: "session-a", scopeId: null }, destinationEndpoint: async () => null,
        ports: Object.fromEntries(["close", "drain", "inspect", "checkGeneration", "abort", "ready"].map(name => [name, async () => {}])) },
    } as unknown as MovePorts;
    const result = await moveSession(request, ports);
    expect(result).toMatchObject({ code: 1, causeCode: "move-first-home-withheld", failure: { step: "initial-home", code: "move-first-home-withheld" } });
    expect(journal.read(request.operation.id)).toEqual(before);
    expect(await moveSession(request, ports)).toEqual(result);
  } finally { global.close(); }
});
