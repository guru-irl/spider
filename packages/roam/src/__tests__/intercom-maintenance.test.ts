import { afterEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "../config";
import { createProductionIntercomMaintenance } from "../intercom-production";
import { provisionIntercomEnrollment, revokeIntercomPair } from "../intercom-enrollment";
import { createIntercomRegistry } from "../intercom-registry";
import { scenario, cleanupPairScenarios } from "./intercom-pair-fixture";
const HUB = "00000000-0000-4000-8000-000000000001", A = "00000000-0000-4000-8000-000000000002", B = "00000000-0000-4000-8000-000000000003";
afterEach(cleanupPairScenarios);
it("a dropped pair path stays unconfirmed until B-local enforcement and hub management recovery converge", async () => {
  const f = await scenario(); expect((await provisionIntercomEnrollment(f.request, f.enrollment)).code).toBe(0);
  const config = parseConfig(JSON.parse(readFileSync(join(f.source.globalRoot, "roam", "config.json"), "utf8"))), queue = f.queues.get(A)!;
  const maintenance = createProductionIntercomMaintenance({ root: f.source.globalRoot, config, binary: "/fixture/hc", env: {}, localPorts: f.locals.get(A), transport: f.transport,
    localCore: async () => "core-a", fenceLocal: async input => ({ machineId: A, peer: B, edgeEpoch: input.edgeEpoch, fenceId: queue.fencePair(B, input.edgeEpoch, input.fenceId).fence.fenceId, exchanges: "closed", inFlight: 0 }) });
  expect(await maintenance.pairScopedHostReady("pair-1")).toBe(true);
  f.offline(true); expect(await revokeIntercomPair("pair-1", f.revokePorts)).toMatchObject({ code: 3, reason: "intercom-revocation-unconfirmed" });
  const before = f.calls.length; f.offline(false);
  expect(await maintenance.recoverRevocations(queue)).toMatchObject([{ code: 3, reason: "intercom-revocation-unconfirmed" }]);
  const bQueue = f.queues.get(B)!, bConfig = parseConfig(JSON.parse(readFileSync(join(f.target.globalRoot, "roam", "config.json"), "utf8")));
  const bMaintenance = createProductionIntercomMaintenance({ root: f.target.globalRoot, config: bConfig, binary: "/fixture/hc", env: {}, localPorts: f.locals.get(B), localCore: async () => "core-b",
    transport: { pinIntercomPeer: async () => { throw new Error("A unreachable"); } } as never,
    fenceLocal: async input => ({ machineId: B, peer: A, edgeEpoch: input.edgeEpoch, fenceId: bQueue.fencePair(A, input.edgeEpoch, input.fenceId).fence.fenceId, exchanges: "closed", inFlight: 0 }) });
  expect(await bMaintenance.recoverRevocations(bQueue)).toMatchObject([{ code: 0, value: { cleanupReason: "intercom-revocation-cleanup-pending" } }]);
  const { pairKeyAbsent } = await import("../intercom-pair-files"), bRecord = await createIntercomRegistry(f.target.globalRoot).get("pair-1");
  expect(pairKeyAbsent(f.locals.get(B)!.home, bRecord!.pair as never, f.publicKey)).toBe(true);
  const hubConfig = parseConfig({ role: "hub", machineId: HUB, hubMachineId: HUB, coreUnit: "fixture.service", peers: [f.source, f.target], intercom: { enabled: true, mode: "peers", machineAlias: "hub.invalid" } });
  const hub = createProductionIntercomMaintenance({ root: f.root, config: hubConfig, binary: "/fixture/hc", env: {}, transport: f.transport });
  expect(await hub.recoverRevocations({ pairFence: () => null })).toMatchObject([{ code: 0, value: { cleanupReason: null } }]);
  expect(f.calls.slice(before).some(call => /(?:start|machine add|keygen)/.test(call))).toBe(false);
  expect(await maintenance.pairScopedHostReady("pair-1")).toBe(false);
  expect(await maintenance.recoverRevocations(queue)).toEqual([]);
}, 5000);
it("the production hub adapter discovers and reconciles B's queue fence after a crash", async () => {
  const f = await scenario(); expect((await provisionIntercomEnrollment(f.request, f.enrollment)).code).toBe(0); f.queues.get(B)!.fencePair(A, "edge-1");
  const config = parseConfig({ role: "hub", machineId: HUB, hubMachineId: HUB, coreUnit: "fixture.service", peers: [f.source, f.target], intercom: { enabled: true, mode: "peers", machineAlias: "hub.invalid" } });
  const maintenance = createProductionIntercomMaintenance({ root: f.root, config, binary: "/fixture/hc", env: {}, transport: f.transport });
  expect(await maintenance.recoverRevocations({ pairFence: () => null })).toMatchObject([{ code: 0, value: { cleanupReason: null } }]);
  expect(await createIntercomRegistry(f.root).get("pair-1")).toMatchObject({ state: "revoked", cleanupReason: null });
  const before = f.calls.length; expect(await maintenance.recoverRevocations({ pairFence: () => null })).toEqual([]); expect(f.calls).toHaveLength(before);
}, 5000);
