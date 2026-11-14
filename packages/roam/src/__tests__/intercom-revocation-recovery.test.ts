import { afterEach, expect, it } from "vitest";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { openIntercomStore } from "../intercom-store";
import { provisionIntercomEnrollment, revokeIntercomPair } from "../intercom-enrollment";
import { createIntercomRegistry } from "../intercom-registry";
import { createProductionIntercomRevocationPorts } from "../intercom-production";
import { runLocalPairCleanup } from "../intercom-local-ops";
import { scenario, cleanupPairScenarios } from "./intercom-pair-fixture";
const A = "00000000-0000-4000-8000-000000000002", B = "00000000-0000-4000-8000-000000000003";
afterEach(cleanupPairScenarios);

it("automatically completes an unconfirmed revocation when B returns", async () => {
  const f = await scenario(); expect((await provisionIntercomEnrollment(f.request, f.enrollment)).code).toBe(0); f.offline(true);
  expect(await revokeIntercomPair("pair-1", f.revokePorts)).toMatchObject({ code: 3, reason: "intercom-revocation-unconfirmed" });
  const { reconcileIntercomRevocations } = await import("../intercom-production");
  f.offline(false);
  expect(await reconcileIntercomRevocations({ root: f.source.globalRoot, machineId: A, store: f.queues.get(A)!, ports: () => f.revokePorts })).toMatchObject([{ code: 0, value: { cleanupReason: null } }]);
  expect(await createIntercomRegistry(f.source.globalRoot).get("pair-1")).toMatchObject({ state: "revoked", cleanupReason: null });
  expect(f.machines()).toEqual([]);
}, 5000);

it("reconciles a crash after the queue fence but before the pair registry changed", async () => {
  const f = await scenario(); expect((await provisionIntercomEnrollment(f.request, f.enrollment)).code).toBe(0);
  const previousQueue = f.queues.get(A)!, fence = previousQueue.fencePair(B, "edge-1").fence; previousQueue.close();
  const queue = openIntercomStore({ file: join(f.source.globalRoot, "roam", "intercom", "queue.db"), machineId: A, clock: { now: () => 1000 } }); f.queues.set(A, queue);
  expect(queue.pairFence(B)?.fenceId).toBe(fence.fenceId);
  expect(await createIntercomRegistry(f.source.globalRoot).get("pair-1")).toMatchObject({ state: "active", fenceId: null });
  const { reconcileIntercomRevocations } = await import("../intercom-production");
  const results = await reconcileIntercomRevocations({ root: f.source.globalRoot, machineId: A, store: f.queues.get(A)!, ports: () => f.revokePorts });
  expect(results).toMatchObject([{ code: 0, value: { cleanupReason: null } }]);
  expect(await createIntercomRegistry(f.source.globalRoot).get("pair-1")).toMatchObject({ state: "revoked", fenceId: fence.fenceId, cleanupReason: null });
}, 5000);

it("B enforces a persisted fence and removes its key even while A is unreachable", async () => {
  const f = await scenario(); expect((await provisionIntercomEnrollment(f.request, f.enrollment)).code).toBe(0); f.connect();
  const keyRecord = (await createIntercomRegistry(f.target.globalRoot).get("pair-1"))!;
  if (!("sshUser" in keyRecord.pair)) throw new Error("Missing bound fixture pair");
  const { pairPaths } = await import("../intercom-pair-files"); unlinkSync(pairPaths(keyRecord.pair).publicKey);
  const queue = f.queues.get(B)!, fence = queue.fencePair(A, "edge-1").fence;
  const ports = createProductionIntercomRevocationPorts({ root: f.target.globalRoot, localMachineId: B, transport: { pinIntercomPeer: async () => { throw new Error("A unreachable"); } } as never,
    localCore: async () => "core-b", fenceLocal: async input => ({ machineId: B, peer: A, edgeEpoch: input.edgeEpoch, fenceId: fence.fenceId, exchanges: "closed", inFlight: 0 }),
    cleanupLocal: input => runLocalPairCleanup(input, f.locals.get(B)!), notify: async () => {} });
  const { reconcileIntercomRevocations } = await import("../intercom-production");
  expect(await reconcileIntercomRevocations({ root: f.target.globalRoot, machineId: B, store: queue, ports: () => ports })).toMatchObject([{ code: 0, value: { cleanupReason: "intercom-revocation-cleanup-pending" } }]);
  expect(f.connected()).toBe(false); expect(f.calls.some(call => call.includes("stop spider-pair-pair-1-host.service"))).toBe(true);
  const { pairKeyAbsent } = await import("../intercom-pair-files"), record = await createIntercomRegistry(f.target.globalRoot).get("pair-1");
  expect(pairKeyAbsent(f.locals.get(B)!.home, record!.pair as never, f.publicKey)).toBe(true);
}, 5000);

it("the hub revokes through independent management routes after the pair host drops its connection", async () => {
  const f = await scenario(); expect((await provisionIntercomEnrollment(f.request, f.enrollment)).code).toBe(0); f.connect();
  const ports = createProductionIntercomRevocationPorts({ root: f.root, localMachineId: "00000000-0000-4000-8000-000000000001", hub: true, transport: f.transport as never,
    localCore: async () => "core-hub", fenceLocal: async () => { throw new Error("the hub is not a pair endpoint"); }, cleanupLocal: async () => { throw new Error("no local pair resources on hub"); }, notify: async () => {} });
  expect(await revokeIntercomPair("pair-1", ports)).toMatchObject({ code: 0, value: { cleanupReason: null } });
  expect(f.connected()).toBe(false); expect(f.machines()).toEqual([]);
}, 5000);

it("the hub reconciles B's durable fence when its own pair record is still active", async () => {
  const f = await scenario(); expect((await provisionIntercomEnrollment(f.request, f.enrollment)).code).toBe(0); f.queues.get(B)!.fencePair(A, "edge-1");
  const ports = createProductionIntercomRevocationPorts({ root: f.root, localMachineId: "00000000-0000-4000-8000-000000000001", hub: true, transport: f.transport as never,
    localCore: async () => "core-hub", fenceLocal: async () => { throw new Error("not a pair endpoint"); }, cleanupLocal: async () => { throw new Error("not a pair endpoint"); }, notify: async () => {} });
  const { reconcileIntercomRevocations } = await import("../intercom-production");
  expect(await reconcileIntercomRevocations({ root: f.root, machineId: "00000000-0000-4000-8000-000000000001", store: { pairFence: () => null }, ports: () => ports,
    remoteFence: async () => f.queues.get(B)!.pairFence(A) })).toMatchObject([{ code: 0, value: { cleanupReason: null } }]);
  expect(await createIntercomRegistry(f.root).get("pair-1")).toMatchObject({ state: "revoked", cleanupReason: null });
}, 5000);

it("a failed recovery never clears a fence or reports confirmed access closure", async () => {
  const f = await scenario(); expect((await provisionIntercomEnrollment(f.request, f.enrollment)).code).toBe(0); f.queues.get(A)!.fencePair(B, "edge-1"); f.offline(true);
  const { reconcileIntercomRevocations } = await import("../intercom-production");
  expect(await reconcileIntercomRevocations({ root: f.source.globalRoot, machineId: A, store: f.queues.get(A)!, ports: () => f.revokePorts })).toMatchObject([{ code: 3, reason: "intercom-revocation-unconfirmed" }]);
  expect(f.queues.get(A)!.pairFence(B)).not.toBeNull();
  expect(await createIntercomRegistry(f.source.globalRoot).get("pair-1")).toMatchObject({ state: "revoked", cleanupReason: "intercom-revocation-unconfirmed" });
}, 5000);
