import { expect, it } from "vitest";
import { createMachineIntercom } from "../intercom-runtime";
import { DEFAULT_LIMITS, type RoamConfig } from "../contracts";

const HUB = "00000000-0000-4000-8000-000000000001";
const config: RoamConfig = { enabled: false, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS,
  intercom: { enabled: false, mode: "hub-only", machineAlias: "hub.invalid", protocolFeature: "federation-v1", routes: [], limits: { queueMessages: 500, queueBytes: 5242880 } } };
it("machine move port exposes only named guarded operations without raw objects", async () => {
  const machine = createMachineIntercom({ config, root: "/fixture/root", agentDir: "/fixture/agent", globalDb: {} as never, clock: { now: () => 0, later: () => () => {} }, transport: {} as never });
  expect(Object.keys(machine.move).sort()).toEqual(["bridge", "endpoint", "intake", "releaseRollbackFence", "settlement"]);
  expect(machine.move).not.toHaveProperty("broker");
  expect(machine.move).not.toHaveProperty("store");
  expect(typeof machine.move.bridge).toBe("function");
  const address = { sessionId: "session-a", scopeId: "scope-a" };
  await expect(machine.move.bridge(address)).rejects.toThrow("intercom-move-unavailable");
  await expect(machine.move.endpoint(address)).rejects.toThrow("intercom-move-unavailable");
  await expect(machine.move.settlement({ messageId: "message-a", fromSessionId: "sender-a", toSessionId: "session-a", scopeId: "scope-a" })).rejects.toThrow("intercom-move-unavailable");
  const home = { sessionId: "session-a", machineId: HUB, epoch: 3, moveId: "rollback-a", updatedAt: 0 };
  await expect(machine.move.releaseRollbackFence({ address, moveId: "move-a", expectedEpoch: 1, generation: "generation-a" }, home, home)).rejects.toThrow("intercom-move-unavailable");
  expect(Object.keys(machine.move.intake).sort()).toEqual(["abort", "checkGeneration", "close", "drain", "inspect", "ready"]);
  const fence = { address, moveId: "move-a", expectedEpoch: 1, generation: "generation-a" };
  await expect(machine.move.intake.close(address, "move-a", 1)).rejects.toThrow("intercom-move-unavailable");
  for (const verb of ["drain", "inspect", "checkGeneration", "abort"] as const) await expect(machine.move.intake[verb](fence)).rejects.toThrow("intercom-move-unavailable");
  await expect(machine.move.intake.ready(fence, { address, machineId: HUB, homeEpoch: 2, activationEpoch: "activation-a" })).rejects.toThrow("intercom-move-unavailable");
  await machine.stop();
}, 5000);
