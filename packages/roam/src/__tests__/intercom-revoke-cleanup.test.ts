import { afterEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createIntercomBridge, type IntercomBridge } from "../intercom-bridge";
import { provisionIntercomEnrollment, revokeIntercomPair } from "../intercom-enrollment";
import { createProductionIntercomEnrollmentPorts, createProductionIntercomRevocationPorts } from "../intercom-production";
import { createIntercomRegistry } from "../intercom-registry";
import { runIntercomRevokeCli } from "../intercom-cli";
import { runLocalDoctor } from "../local-diagnostics";
import { cleanupPairScenarios, scenario } from "./intercom-pair-fixture";

const HUB = "00000000-0000-4000-8000-000000000001";
const A = "00000000-0000-4000-8000-000000000002", B = "00000000-0000-4000-8000-000000000003";
const bridges: IntercomBridge[] = [];
afterEach(async () => { for (const bridge of bridges.splice(0)) await bridge.stop(); cleanupPairScenarios(); });

async function livePair() {
  const f = await scenario(), endpoints = new Map<string, IntercomBridge>();
  for (const machine of [f.source, f.target]) {
    const bridge = createIntercomBridge({ machineId: machine.machineId, machineAlias: machine.alias, edges: [],
      store: f.queues.get(machine.machineId)!, clock: { now: () => 1000, later: () => () => {} },
      transport: {} as never, localPresence: () => [], authoritativeHome: () => null });
    endpoints.set(machine.machineId, bridge); bridges.push(bridge); await bridge.start();
    const local = f.locals.get(machine.machineId)!;
    local.enrollBridge = async input => {
      const value = input as { peer: string; edgeEpoch: string; operationId: string; graphDigest: string; expectedFenceId: string | null };
      await bridge.enrollPair({ peer: machine.machineId === A ? f.target : f.source, edgeEpoch: value.edgeEpoch, initiator: false }, value);
      return { machineId: machine.machineId, ...value, applied: true };
    };
    local.inspectBridge = async input => {
      const value = input as { peer: string; edgeEpoch: string };
      return { machineId: machine.machineId, ...value, status: f.queues.get(machine.machineId)!.pairFence(value.peer) ? "blocked" : "live", reason: null };
    };
  }
  const transport = { ...f.transport, transport: { ...f.transport.transport, async exec(machine, argv, options) {
    if (argv[2] !== "revoke-local") return f.transport.transport.exec(machine, argv, options);
    // Pinning still uses the fixture's real outage and pair-path controls.
    await f.transport.pinIntercomPeer(machine);
    const input = JSON.parse(options.stdin!.toString());
    const proof = await endpoints.get(machine.machineId)!.revokePair(input.peer, input.edgeEpoch, input.fenceId);
    const registry = createIntercomRegistry(machine.globalRoot);
    await registry.beginRevocation("pair-1", proof.fenceId, proof.edgeEpoch);
    await registry.finishRevocation("pair-1", "intercom-revocation-unconfirmed");
    return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-revoke", ok: true, value: { machineId: machine.machineId, ...proof } }));
  } } } satisfies typeof f.transport;
  const ports = () => createProductionIntercomRevocationPorts({ root: f.root, localMachineId: HUB, hub: true, transport,
    localCore: async () => { throw new Error("not an endpoint"); }, fenceLocal: async () => { throw new Error("not an endpoint"); },
    cleanupLocal: async () => { throw new Error("not an endpoint"); }, notify: async () => {} });
  const enroll = () => provisionIntercomEnrollment(f.request, createProductionIntercomEnrollmentPorts({ root: f.root, journal: f.journal,
    transport, request: f.request, actor: "fixture", now: () => 1000, present: async () => {}, approve: async () => true,
    notify: async () => {}, warn: async () => {} }));
  expect(await enroll()).toMatchObject({ code: 0 }); f.connect();
  const revoke = () => revokeIntercomPair("pair-1", ports());
  const records = () => Promise.all([f.root, f.source.globalRoot, f.target.globalRoot].map(root => createIntercomRegistry(root).get("pair-1")));
  return { ...f, ports, enroll, revoke, records };
}

it.each(["empty", "finished"])("plain revoke with %s terminal inventory closes a live pair and permits fresh enrollment", async inventory => {
  const f = await livePair();
  if (inventory === "finished") f.terminals([{ address: "spider-pair-pair-1/t1", state: "finished" }]);
  expect(await f.revoke()).toMatchObject({ code: 0, value: { cleanupReason: null } });
  expect(f.connected()).toBe(false); expect(f.machines()).toEqual([]);
  expect(readFileSync(join(f.locals.get(B)!.home, ".ssh", "authorized_keys"), "utf8")).not.toContain("spider-intercom:pair-1");
  for (const record of await f.records()) expect(record).toMatchObject({ state: "revoked", cleanupReason: null });
  for (const unit of f.units.values()) expect(unit).toMatchObject({ state: "inactive", pid: 0, members: [] });
  const calls = f.calls.length;
  expect(await f.revoke()).toMatchObject({ code: 0, value: { cleanupReason: null } });
  expect(await f.revoke()).toMatchObject({ code: 0, value: { cleanupReason: null } });
  expect(f.calls).toHaveLength(calls);
  f.request.operation.id = "enroll-2"; f.request.pairs[0].edgeEpoch = "edge-2";
  expect(await f.enroll()).toMatchObject({ code: 0 });
  expect(await f.revoke()).toMatchObject({ code: 0, value: { cleanupReason: null } });
  for (const record of await f.records()) expect(record).toMatchObject({ state: "revoked", cleanupReason: null, revocationEpoch: "edge-2" });
}, 10_000);

it("reachable live terminals are distinguished from an unavailable host and retry once finished", async () => {
  const f = await livePair(); f.terminals([{ address: "spider-pair-pair-1/t1", state: "live" }]);
  expect(await f.revoke()).toMatchObject({ code: 0, repairCommand: "spider roam intercom revoke pair-1", value: { cleanupReason: "intercom-revocation-shared-jobs" } });
  expect(f.connected()).toBe(false); expect(f.machines()).toHaveLength(1);
  const report = await runLocalDoctor({ root: f.root });
  const issue = report.diagnostics.find(issue => issue.reason.startsWith("intercom-revocation-shared-jobs:"));
  expect(issue).toMatchObject({ repairCommand: "spider roam intercom revoke pair-1" });
  expect(issue?.reason).toContain("terminal"); expect(issue?.reason).not.toMatch(/until B is back|Bring B back/);
  f.terminals([{ address: "spider-pair-pair-1/t1", state: "finished" }]);
  expect(await f.revoke()).toMatchObject({ code: 0, value: { cleanupReason: null } });
  for (const record of await f.records()) expect(record).toMatchObject({ state: "revoked", cleanupReason: null });
}, 10_000);

it("an unreachable target retains the fence and provides a plain retry that completes when it returns", async () => {
  const f = await livePair(); f.offline(true);
  expect(await f.revoke()).toMatchObject({ code: 3, reason: "intercom-revocation-unconfirmed", repairCommand: "spider roam intercom revoke pair-1" });
  expect(f.queues.get(A)!.pairFence(B)).not.toBeNull();
  expect(f.machines()).toHaveLength(1); expect(f.connected()).toBe(true);
  let err = "";
  expect(await runIntercomRevokeCli({ root: f.source.globalRoot, pairId: "pair-1" }, { out: () => {}, err: text => { err += text; } }, { revokePorts: f.ports() })).toBe(3);
  expect(err).toContain("spider roam intercom revoke pair-1");
  f.offline(false);
  expect(await f.revoke()).toMatchObject({ code: 0, value: { cleanupReason: null } });
  expect(f.machines()).toEqual([]);
  for (const record of await f.records()) expect(record).toMatchObject({ state: "revoked", cleanupReason: null });
}, 10_000);
