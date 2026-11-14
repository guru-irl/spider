import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli";
import { provisionIntercomEnrollment, revokeIntercomPair } from "../intercom-enrollment";
import { createProductionIntercomEnrollmentPorts, createProductionIntercomRevocationPorts } from "../intercom-production";
import { createIntercomRegistry } from "../intercom-registry";
import { runLocalDoctor } from "../local-diagnostics";
import { scenario, cleanupPairScenarios } from "./intercom-pair-fixture";
const HUB = "00000000-0000-4000-8000-000000000001", A = "00000000-0000-4000-8000-000000000002", B = "00000000-0000-4000-8000-000000000003";

describe.sequential("explicit historical fence recovery", () => {
  let f: Awaited<ReturnType<typeof scenario>>, oldFence: string;
  const revocation = (fenceEpoch?: string) => createProductionIntercomRevocationPorts({ root: f.root, localMachineId: HUB, hub: true, fenceEpoch, transport: f.transport,
    localCore: async () => "core-hub", fenceLocal: async () => { throw new Error("not a pair endpoint"); }, cleanupLocal: async () => { throw new Error("not a pair endpoint"); }, notify: async () => {} });
  const enrollment = (epoch: string, id: string, approve: () => Promise<boolean> = async () => true) => {
    const request = { ...f.request, operation: { ...f.request.operation, id }, pairs: [{ ...f.request.pairs[0], edgeEpoch: epoch }] };
    return { request, ports: createProductionIntercomEnrollmentPorts({ root: f.root, journal: f.journal, transport: f.transport, request, actor: "fixture", now: () => 1000,
      present: async () => {}, approve, notify: async () => {}, warn: async () => {} }) };
  };
  beforeAll(async () => {
    f = await scenario(); mkdirSync(join(f.root, "roam"), { recursive: true, mode: 0o700 });
    writeFileSync(join(f.root, "roam", "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
    writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: false, role: "hub", machineId: HUB, hubMachineId: HUB, coreUnit: "fixture.service", peers: [f.source, f.target] }), { mode: 0o600 });
    expect(await provisionIntercomEnrollment(f.request, f.enrollment)).toMatchObject({ code: 0 });
  }, 5000);
  afterAll(cleanupPairScenarios);
  it("completes the predecessor revocation", async () => {
    expect(await revokeIntercomPair("pair-1", revocation())).toMatchObject({ code: 0, value: { cleanupReason: null } });
    oldFence = f.queues.get(A)!.pairFence(B)!.fenceId;
  }, 5000);
  it("leaves a partial new enrollment behind the unchanged predecessor fence", async () => {
    const original = f.locals.get(B)!.enrollBridge;
    f.locals.get(B)!.enrollBridge = async () => { throw new Error("interrupted enrollment"); };
    try { const e = enrollment("edge-2", "enroll-2"); expect(await provisionIntercomEnrollment(e.request, e.ports)).toMatchObject({ code: 3 }); }
    finally { f.locals.get(B)!.enrollBridge = original; }
    expect(await createIntercomRegistry(f.target.globalRoot).get("pair-1")).toMatchObject({ state: "pending", pair: { edgeEpoch: "edge-2" }, fenceId: oldFence });
    expect(f.units.get(`${B}/spider-pair-pair-1-host.service`)!.state).toBe("active");
  }, 5000);
  it("fails closed and doctor names the explicit historical-epoch command", async () => {
    expect(await revokeIntercomPair("pair-1", f.revokePorts)).toMatchObject({ code: 3 });
    const doctor = await runLocalDoctor({ root: f.source.globalRoot });
    expect(doctor.diagnostics).toContainEqual(expect.objectContaining({ severity: "block", reason: expect.stringContaining("intercom-fence-mismatch"),
      repairCommand: "spider roam intercom revoke pair-1 --fence-epoch edge-1" }));
    expect(f.queues.get(B)!.pairFence(A)).toMatchObject({ edgeEpoch: "edge-1", fenceId: oldFence });
    const e = enrollment("edge-3", "enroll-3"); expect(await provisionIntercomEnrollment(e.request, e.ports)).toMatchObject({ code: 3, reason: "revocation-pending" });
  }, 5000);
  it("refuses a wrong historical epoch without changing resources or the obligation", async () => {
    const before = readFileSync(join(f.root, "roam", "intercom", "enrollments", "pair-1.json")), units = structuredClone(f.units);
    expect(await revokeIntercomPair("pair-1", revocation("wrong-epoch"))).toMatchObject({ code: 3 });
    expect(readFileSync(join(f.root, "roam", "intercom", "enrollments", "pair-1.json"))).toEqual(before); expect(f.units).toEqual(units);
  }, 5000);
  it("the explicit command proves B closure and completes cleanup without retargeting", async () => {
    f.connect(); let output = "";
    expect(await main(["--global-root", f.root, "roam", "intercom", "revoke", "pair-1", "--fence-epoch", "edge-1"],
      { out: text => { output += text; }, err: text => { output += text; } }, { intercomOptions: { transport: f.transport } })).toBe(0);
    expect(output).toContain("intercom-revoked"); expect(f.connected()).toBe(false); expect(f.machines()).toEqual([]);
    for (const [machine, peer] of [[A, B], [B, A]]) {
      expect(f.queues.get(machine)!.pairFence(peer)).toMatchObject({ edgeEpoch: "edge-1", fenceId: oldFence });
      const registry = createIntercomRegistry(f.locals.get(machine)!.root);
      expect(await registry.get("pair-1")).toMatchObject({ state: "revoked", cleanupReason: null, revocationEpoch: "edge-1", pair: { edgeEpoch: "edge-2" } });
      expect(await registry.revocationPending("pair-1")).toBe(false);
    }
    expect((await runLocalDoctor({ root: f.target.globalRoot })).diagnostics.some(row => row.reason.includes("intercom-fence-mismatch"))).toBe(false);
  }, 5000);
  it("requires new consent before clearing the historical fence for a fresh enrollment", async () => {
    const refused = enrollment("edge-3", "enroll-fresh", async () => false);
    expect(await provisionIntercomEnrollment(refused.request, refused.ports)).toMatchObject({ code: 1, reason: "peer-consent-required" });
    expect(f.queues.get(B)!.pairFence(A)!.fenceId).toBe(oldFence);
    let consent = 0; const fresh = enrollment("edge-3", "enroll-fresh", async () => { consent++; return true; });
    expect(await provisionIntercomEnrollment(fresh.request, fresh.ports)).toMatchObject({ code: 0, reason: "intercom-enrolled" }); expect(consent).toBe(1);
    for (const [machine, peer] of [[A, B], [B, A]]) { expect(f.queues.get(machine)!.pairFence(peer)).toBeNull(); expect(await createIntercomRegistry(f.locals.get(machine)!.root).get("pair-1")).toMatchObject({ state: "active", pair: { edgeEpoch: "edge-3" } }); }
  }, 5000);
});
