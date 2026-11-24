import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli";
import { parseConfig } from "../config";
import { provisionIntercomEnrollment, revokeIntercomPair } from "../intercom-enrollment";
import { createProductionIntercomEnrollmentPorts, createProductionIntercomMaintenance } from "../intercom-production";
import { createIntercomRegistry } from "../intercom-registry";
import { runLocalDoctor } from "../local-diagnostics";
import { scenario, cleanupPairScenarios } from "./intercom-pair-fixture";
const HUB = "00000000-0000-4000-8000-000000000001", A = "00000000-0000-4000-8000-000000000002", B = "00000000-0000-4000-8000-000000000003";
describe("pending enrollment refusal", () => {
afterEach(cleanupPairScenarios);
it.each([A, B])("refuses enrollment on either endpoint with a named reason and a next step %s", async machine => {
  const f = await scenario(); expect(await provisionIntercomEnrollment(f.request, f.enrollment)).toMatchObject({ code: 0, reason: "intercom-enrolled" });
  const root = f.locals.get(machine)!.root, registry = createIntercomRegistry(root), peer = machine === A ? B : A, fence = f.queues.get(machine)!.fencePair(peer, "edge-1").fence;
  await registry.beginRevocation("pair-1", fence.fenceId); await registry.finishRevocation("pair-1", machine === A ? "intercom-revocation-unconfirmed" : "intercom-revocation-cleanup-pending");
  const file = join(root, "roam", "intercom", "enrollments", "pair-1.json"), before = readFileSync(file), units = structuredClone(f.units), request = { ...f.request, operation: { ...f.request.operation, id: "enroll-2" }, pairs: [{ ...f.request.pairs[0], edgeEpoch: "edge-2" }] };
  let consent = 0;
  const ports = createProductionIntercomEnrollmentPorts({ root: f.root, journal: f.journal, transport: f.transport, request, actor: "fixture", now: () => 1000,
    present: async () => {}, approve: async () => { consent++; return true; }, notify: async () => {}, warn: async () => {} });
  expect(await provisionIntercomEnrollment(request, ports)).toMatchObject({ code: 3, reason: "revocation-pending" });
  expect(consent).toBe(0); expect(readFileSync(file)).toEqual(before); expect(f.units).toEqual(units); expect(f.queues.get(machine)!.pairFence(peer)?.fenceId).toBe(fence.fenceId);
  const doctor = await runLocalDoctor({ root });
  expect(doctor.diagnostics).toContainEqual(expect.objectContaining({ repairCommand: "spider roam intercom revoke pair-1", reason: expect.stringContaining("Keep both boxes reachable") }));
  expect(doctor.diagnostics.some(row => row.reason.includes("Bring B back"))).toBe(false);
}, 5000);
it.each([A, B])("refuses a delayed setup write after a crash committed only the queue fence %s", async machine => {
  const f = await scenario(); expect(await provisionIntercomEnrollment(f.request, f.enrollment)).toMatchObject({ code: 0, reason: "intercom-enrolled" });
  const root = f.locals.get(machine)!.root, record = (await createIntercomRegistry(root).get("pair-1"))!, approval = { approved: true, actor: "fixture", at: 1000, operationId: record.operationId, graphDigest: record.graphDigest, pairs: f.request.pairs };
  expect(await createIntercomRegistry(root).revocationPending("pair-1")).toBe(false);
  const peer = machine === A ? B : A, fence = f.queues.get(machine)!.fencePair(peer, "edge-1").fence, file = join(root, "roam", "intercom", "enrollments", "pair-1.json"), before = readFileSync(file), calls = f.calls.length;
  let out = "";
  expect(await main(["--global-root", root, "roam", "intercom", "setup-local"], { out: text => { out += text; }, err: () => {} },
    { stdin: Buffer.from(JSON.stringify({ action: "register-pair", pair: record.pair, approval, targetCoreId: "core-b" })), pairPorts: f.locals.get(machine)! })).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ ok: false, reason: "revocation-pending" });
  expect(readFileSync(file)).toEqual(before); expect(f.queues.get(machine)!.pairFence(peer)?.fenceId).toBe(fence.fenceId); expect(f.calls).toHaveLength(calls);
}, 5000);
});

describe.sequential("pair ID reassignment after completed revocation", () => {
  let f: Awaited<ReturnType<typeof scenario>>;
  beforeAll(async () => {
    f = await scenario();
    expect(await provisionIntercomEnrollment(f.request, f.enrollment)).toMatchObject({ code: 0 });
  }, 5000);
  afterAll(cleanupPairScenarios);
  it("completes endpoint cleanup before pair ID reassignment", async () => {
    expect(await revokeIntercomPair("pair-1", f.revokePorts)).toMatchObject({ code: 0, value: { cleanupReason: null } });
  }, 5000);
  it("records completed cleanup on the hub before pair ID reassignment", async () => {
    const config = parseConfig({ role: "hub", machineId: HUB, hubMachineId: HUB, coreUnit: "fixture.service", peers: [f.source, f.target], intercom: { enabled: true, mode: "peers", machineAlias: "hub.invalid" } });
    expect(await createProductionIntercomMaintenance({ root: f.root, config, binary: "/fixture/hc", env: {}, transport: f.transport }).recoverRevocations({ pairFence: () => null })).toMatchObject([{ code: 0, value: { cleanupReason: null } }]);
  }, 5000);
  it("enrolls a new endpoint pair without clearing the retired peer's fence", async () => {
    const retiredFence = f.queues.get(B)!.pairFence(A), request = { ...f.request, operation: { ...f.request.operation, id: "enroll-new-pair" },
      pairs: [{ ...f.request.pairs[0], source: f.otherSource, edgeEpoch: "edge-2" }] };
    expect(retiredFence).not.toBeNull();
    let consents = 0;
    const ports = createProductionIntercomEnrollmentPorts({ root: f.root, journal: f.journal, transport: f.transport, request, actor: "fixture", now: () => 1000,
      present: async () => {}, approve: async () => { consents++; return true; }, notify: async () => {}, warn: async () => {} });
    expect(await ports.readPairFences(request.pairs)).toEqual({ "pair-1": null });
    expect(await provisionIntercomEnrollment(request, ports)).toMatchObject({ code: 0, reason: "intercom-enrolled" });
    expect(consents).toBe(1); expect(f.queues.get(B)!.pairFence(A)).toEqual(retiredFence);
    expect(f.queues.get(B)!.pairFence(f.otherSource.machineId)).toBeNull();
    for (const root of [f.root, f.otherSource.globalRoot, f.target.globalRoot]) {
      expect(await createIntercomRegistry(root).get("pair-1")).toMatchObject({ state: "active", fenceId: null, pair: { source: { machineId: f.otherSource.machineId }, edgeEpoch: "edge-2" } });
    }
  }, 5000);
});

describe.sequential("fresh enrollment after completed revocation", () => {
  let f: Awaited<ReturnType<typeof scenario>>;
  beforeAll(async () => {
    f = await scenario();
    expect(await provisionIntercomEnrollment(f.request, f.enrollment)).toMatchObject({ code: 0, reason: "intercom-enrolled" });
  }, 5000);
  afterAll(cleanupPairScenarios);
  it("confirms closure and endpoint cleanup before fresh enrollment", async () => {
    expect(await revokeIntercomPair("pair-1", f.revokePorts)).toMatchObject({ code: 0, value: { cleanupReason: null } });
  }, 5000);
  it("records completed cleanup on the hub", async () => {
  const config = parseConfig({ role: "hub", machineId: HUB, hubMachineId: HUB, coreUnit: "fixture.service", peers: [f.source, f.target], intercom: { enabled: true, mode: "peers", machineAlias: "hub.invalid" } });
  expect(await createProductionIntercomMaintenance({ root: f.root, config, binary: "/fixture/hc", env: {}, transport: f.transport }).recoverRevocations({ pairFence: () => null })).toMatchObject([{ code: 0, value: { cleanupReason: null } }]);
  }, 5000);
  it("fresh consent enrolls both endpoints after closure and every cleanup receipt are complete", async () => {
  const request = { ...f.request, operation: { ...f.request.operation, id: "enroll-2" }, pairs: [{ ...f.request.pairs[0], edgeEpoch: "edge-2" }] }; let consent = 0;
  const ports = createProductionIntercomEnrollmentPorts({ root: f.root, journal: f.journal, transport: f.transport, request, actor: "fixture", now: () => 1000,
    present: async () => {}, approve: async () => { consent++; return true; }, notify: async () => {}, warn: async () => {} });
  expect(await provisionIntercomEnrollment(request, ports)).toMatchObject({ code: 0, reason: "intercom-enrolled" }); expect(consent).toBe(1);
  for (const machine of [A, B]) { expect(await createIntercomRegistry(f.locals.get(machine)!.root).get("pair-1")).toMatchObject({ state: "active", fenceId: null, pair: { edgeEpoch: "edge-2" } }); expect(f.queues.get(machine)!.pairFence(machine === A ? B : A)).toBeNull(); }
  }, 5000);
});
