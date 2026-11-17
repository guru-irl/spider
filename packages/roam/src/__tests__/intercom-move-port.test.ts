import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import type { MachineIntercomOptions } from "../intercom-runtime";
import { parseConfig } from "../config";
import { createMachineIntercom } from "../intercom-runtime";
import { DEFAULT_LIMITS, type RoamConfig } from "../contracts";

const HUB = "00000000-0000-4000-8000-000000000001";
const config: RoamConfig = { enabled: false, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS,
  intercom: { enabled: false, mode: "hub-only", machineAlias: "hub.invalid", protocolFeature: "federation-v1", routes: [], limits: { queueMessages: 500, queueBytes: 5242880 } } };
it("machine move port exposes only named guarded operations without raw objects", async () => {
  const machine = createMachineIntercom({ config, root: "/fixture/root", agentDir: "/fixture/agent", globalDb: {} as never, clock: { now: () => 0, later: () => () => {} }, transport: {} as never });
  expect(Object.keys(machine.move).sort()).toEqual(["bridge", "broker", "endpoint", "intake", "releaseRollbackFence", "settlement"]);
  expect(typeof machine.move.broker).toBe("function");
  expect(machine.move).not.toHaveProperty("store");
  expect(typeof machine.move.bridge).toBe("function");
  const address = { sessionId: "session-a", scopeId: "scope-a" };
  await expect(machine.move.bridge(address)).rejects.toThrow("intercom-move-unavailable");
  await expect(machine.move.broker(address)).rejects.toThrow("intercom-move-unavailable");
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

it("broker evidence is an owned-address snapshot with no reachable broker capability", async () => {
  const global = createReplica("global", HUB), agentDir = mkdtempSync(join(resolve(".spider/scratch"), "mp-"));
  const address = { sessionId: "owned-session", scopeId: "owned-scope" }, from = { sessionId: "sender", scopeId: "owned-scope" };
  const mutate = vi.fn(), raw = { asks: [{ id: "ask-a", from: { ...from, register: mutate }, to: address, deliver: mutate }],
    pendingDispatch: ["message-a"], unknownOutcomes: [], unobservedReceipts: [], send: mutate };
  const read = vi.fn(async () => raw);
  class Broker extends EventEmitter {
    async connect() { this.emit("presence", []); }
    async enableHelpers() {}
    publishPresence() {}
    async deliver() { throw new Error("unexpected delivery"); }
    deliverReceipt() {}
    async deliverRevocationNotice() { return true; }
    deliverControl() {}
    async inspectFreezeBlockers() { return read(); }
    async inspectBlockers() { return { asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] }; }
    async close() {}
  }
  const broker = new Broker(); let owns = true;
  const machine = createMachineIntercom({ config: parseConfig({ enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, coreUnit: "fixture.service", intercom: { enabled: true, mode: "peers", machineAlias: "hub.invalid" } }), root: global.root,
    agentDir, globalDb: global.db, clock: { now: () => 1000, later: () => () => {} }, transport: {} as never,
    broker: broker as unknown as MachineIntercomOptions["broker"], env: { ...process.env, PI_SUBAGENT_CHILD: "0" }, generationKnown: () => true,
    moveOwns: async endpoint => owns && endpoint.address.sessionId === address.sessionId && endpoint.activationEpoch === "owned-generation",
    async ensureBroker() {} });
  try {
    await expect(machine.move.broker(address)).rejects.toThrow("intercom-move-unavailable");
    await machine.start();
    expect(machine.readiness()).toEqual({ state: "ready", reason: null });
    broker.emit("presence", [{ address, activationEpoch: "owned-generation", homeEpoch: null, cwd: "/fixture", model: "fixture", startedAt: 1, lastActivity: 1 }]);
    await expect(machine.move.broker({ ...address, scopeId: "unowned-scope" })).rejects.toThrow("intercom-owner-unproved");
    expect(read).not.toHaveBeenCalled();
    const result = await machine.move.broker(address);
    expect(result).toEqual({ asks: [{ id: "ask-a", from, to: address }], pendingDispatch: ["message-a"], unknownOutcomes: [], unobservedReceipts: [] });
    expect(result).not.toBe(raw);
    raw.pendingDispatch.push("later-message");
    expect(result.pendingDispatch).toEqual(["message-a"]);
    for (const key of ["send", "deliver", "register", "close", "intake", "broker", "store"]) expect(result).not.toHaveProperty(key);
    const pending: unknown[] = [machine.move, result];
    while (pending.length) {
      const value = pending.pop(); expect(value).not.toBe(broker);
      if (value && typeof value === "object") pending.push(...Object.values(value));
    }
    owns = false;
    await expect(machine.move.broker(address)).rejects.toThrow("intercom-owner-unproved");
    expect(read).toHaveBeenCalledTimes(1);
    owns = true; read.mockImplementationOnce(async () => { owns = false; return raw; });
    await expect(machine.move.broker(address)).rejects.toThrow("intercom-owner-unproved");
    expect(read).toHaveBeenCalledTimes(2);
    expect(mutate).not.toHaveBeenCalled();
  } finally { await machine.stop(); global.close(); rmSync(agentDir, { recursive: true, force: true }); }
}, 5000);
