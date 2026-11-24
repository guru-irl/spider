import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { installBoxEnrollment, setBoxRoamingEnabled } from "../enrollment";
import { loadConfig } from "../config";
import { expect, it, vi } from "vitest";
import { handleAgentOperation } from "../agent";
import { DEFAULT_LIMITS, disabledIntercom, type AgentPorts, type Operation, type RoamConfig } from "../contracts";
const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002";
const config: RoamConfig = { enabled: true, role: "box", machineId: BOX, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
const kinds = ["session-inspect", "session-freeze", "session-unfreeze", "session-shutdown", "session-retire", "session-readmit", "move-diagnostics", "move-prerequisites", "move-seed", "move-observation", "move-retire-failed", "move-export", "move-import", "move-verify", "move-readmit", "move-cleanup", "move-workspace-map", "move-owner-observation", "move-abort-authority", "move-retire-authority", "move-rollback-authority"];
function fixture(kind = "session-freeze") {
  const operation: Operation = { id: "operation-a", kind, machineId: BOX, expectedEpoch: 1, args: { sessionId: "session-a", moveId: "move-a", sourceMachine: HUB, requesterMachine: BOX } };
  const move = vi.fn(async () => ({ code: 0 as const, reason: "complete", operationId: operation.id, home: null, epoch: 1, repairCommand: null, value: null }));
  const unexpected = () => { throw new Error("Unexpected state access"); };
  const ports: AgentPorts = { config: { ...config }, root: "/fixture", journal: { begin: unexpected, record: unexpected, read: unexpected }, openStore: unexpected, move };
  return { operation, ports, move };
}
it.each(kinds)("disabled %s refuses before journal or host effects", async kind => {
  const f = fixture(kind); f.ports.config.enabled = false;
  const result = await handleAgentOperation(f.operation, f.ports);
  expect(result.reason).toBe("roaming-disabled"); expect(result.code).toBe(1); expect(f.move).not.toHaveBeenCalled();
});
it.each(["epoch", "machine", "source", "session", "move", "unknown-kind"])("agent refuses malformed or foreign %s before host effects", async bad => {
  const f = fixture();
  if (bad === "epoch") f.operation.expectedEpoch = 0;
  if (bad === "machine") f.operation.machineId = HUB;
  if (bad === "source") f.operation.args.sourceMachine = BOX;
  if (bad === "session") f.operation.args.sessionId = "../foreign";
  if (bad === "move") f.operation.args.moveId = "../foreign";
  if (bad === "unknown-kind") f.operation.kind = "move-execute-shell";
  expect((await handleAgentOperation(f.operation, f.ports)).code).not.toBe(0); expect(f.move).not.toHaveBeenCalled();
});
it("guarded agent forwards the immutable typed operation without exposing a model action", async () => {
  const f = fixture(); expect((await handleAgentOperation(f.operation, f.ports)).code).toBe(0);
  expect(f.move).toHaveBeenCalledExactlyOnceWith(f.operation);
});

it.each([
  ["participant-pi-unavailable", "participant-pi-unavailable"],
  ["private-cause", "move-adapter-unavailable"],
] as const)("a validated adapter failure retains only the allowlisted %s cause", async (code, expected) => {
  const f = fixture("move-workspace-map"); f.operation.expectedEpoch = null;
  f.ports.move = async () => { throw Object.assign(new Error("private path and prompt must not escape"), { code }); };
  const result = await handleAgentOperation(f.operation, f.ports);
  expect(result).toMatchObject({ code: 1, reason: expected, causeCode: expected, repairCommand: "spider roam doctor", operationId: f.operation.id });
  expect(JSON.stringify(result)).not.toContain("private");
});

it("real enrollment stays disabled until explicit provision enables it, then only its enrolled hub is accepted", async () => {
  const replica = createReplica("global", BOX), file = join(replica.root, "roam/config.json");
  try {
    mkdirSync(join(replica.root, "roam"), { mode: 0o700 });
    writeFileSync(join(replica.root, "roam/machine.json"), JSON.stringify({ machineId: BOX }), { mode: 0o600 });
    installBoxEnrollment(replica.root, BOX, HUB, "herdr-core.service");
    const f = fixture(); f.ports.config = loadConfig(file);
    expect(f.ports.config.enabled).toBe(false);
    expect((await handleAgentOperation(f.operation, f.ports)).reason).toBe("roaming-disabled"); expect(f.move).not.toHaveBeenCalled();
    setBoxRoamingEnabled(replica.root, BOX, HUB, true); f.ports.config = loadConfig(file);
    f.operation.args.sourceMachine = BOX;
    expect((await handleAgentOperation(f.operation, f.ports)).code).not.toBe(0); expect(f.move).not.toHaveBeenCalled();
    f.operation.args.sourceMachine = HUB;
    expect((await handleAgentOperation(f.operation, f.ports)).code).toBe(0); expect(f.move).toHaveBeenCalledOnce();
    setBoxRoamingEnabled(replica.root, BOX, HUB, false); f.ports.config = loadConfig(file);
    expect((await handleAgentOperation(f.operation, f.ports)).reason).toBe("roaming-disabled"); expect(f.move).toHaveBeenCalledOnce();
  } finally { replica.close(); }
});
