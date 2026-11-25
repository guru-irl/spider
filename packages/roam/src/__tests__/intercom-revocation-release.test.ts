import { afterEach, expect, it } from "vitest";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "../config";
import { runIntercomRevokeCli } from "../intercom-cli";
import { provisionIntercomEnrollment, revokeIntercomPair } from "../intercom-enrollment";
import { createProductionIntercomMaintenance, createProductionIntercomRevocationPorts } from "../intercom-production";
import { createIntercomRegistry } from "../intercom-registry";
import { cleanupPairScenarios, scenario } from "./intercom-pair-fixture";

const HUB = "00000000-0000-4000-8000-000000000001";
const A = "00000000-0000-4000-8000-000000000002", B = "00000000-0000-4000-8000-000000000003";
const CURRENT_CLI = "/fixture/current/cli";
afterEach(cleanupPairScenarios);

async function retainedPair() {
  const f = await scenario();
  expect(await provisionIntercomEnrollment(f.request, { ...f.enrollment, async connect(pair, pins) {
    await f.enrollment.connect(pair, pins); return "peer-port-unreachable";
  } })).toMatchObject({ code: 3, reason: "intercom-peer-port-unreachable" });
  const ports = () => createProductionIntercomRevocationPorts({ root: f.root, localMachineId: HUB, hub: true, transport: f.transport,
    localCore: async () => { throw new Error("not an endpoint"); }, fenceLocal: async () => { throw new Error("not an endpoint"); },
    cleanupLocal: async () => { throw new Error("not an endpoint"); }, notify: async () => {} });
  for (const [machine, side] of [[f.source, "connect"], [f.target, "host"]] as const) {
    const name = `spider-pair-pair-1-${side}.service`, key = `${machine.machineId}/${name}`, unit = f.units.get(key)!;
    await f.locals.get(machine.machineId)!.run(["/fixture/systemctl", "--user", "stop", name], { timeoutMs: 1000, maxBytes: 1024 });
    unlinkSync(unit.file); f.units.delete(key);
  }
  expect(await revokeIntercomPair("pair-1", { ...ports(), removeAuthorizedKey: async () => { throw new Error("interrupted"); } }))
    .toMatchObject({ code: 3, reason: "intercom-revocation-unconfirmed" });
  const source = await createIntercomRegistry(f.source.globalRoot).get("pair-1"), registry = createIntercomRegistry(f.target.globalRoot);
  await registry.finishRevocation("pair-1", "intercom-revocation-cleanup-pending");
  expect(source?.unit?.closedFenceId).toBeNull();
  expect(await registry.get("pair-1")).toMatchObject({ state: "revoked", fenceId: source!.fenceId,
    cleanupReason: "intercom-revocation-cleanup-pending", unit: { closedFenceId: source!.fenceId } });
  expect(source?.resources?.route.targetCoreId).toBe("core-b");
  expect(source?.resources?.publicKey).toBeUndefined();
  expect(f.machines()).toEqual([]);

  const config = parseConfig({ enabled: false, role: "hub", machineId: HUB, hubMachineId: HUB, coreUnit: "fixture.service",
    peers: [f.source, f.target].map(peer => ({ ...peer, cli: CURRENT_CLI })),
    intercom: { enabled: true, mode: "peers", machineAlias: "hub.invalid" } });
  writeFileSync(join(f.root, "roam", "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  const saveConfig = () => writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
  saveConfig();
  const exec = f.transport.transport.exec;
  f.transport.transport.exec = async (machine, argv, options) => {
    const input = JSON.parse(options.stdin!.toString());
    // The old release can fence but cannot prove cleanup of a missing unit.
    if (argv[2] === "cleanup-local" && input.action === "stop-host" && machine.cli !== CURRENT_CLI)
      return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-cleanup", ok: false, reason: "intercom-revocation-cleanup-pending" }));
    return exec(machine, argv, options);
  };
  const run = async (entry: "cli" | "maintenance") => {
    if (entry === "maintenance") {
      const maintenance = createProductionIntercomMaintenance({ root: f.root, config, binary: "/fixture/hc", env: {}, transport: f.transport });
      const [result] = await maintenance.recoverRevocations({ pairFence: () => null }); return result;
    }
    let output = "";
    const code = await runIntercomRevokeCli({ root: f.root, pairId: "pair-1", json: true },
      { out: text => { output += text; }, err: () => {} }, { transport: f.transport });
    return { ...JSON.parse(output), code };
  };
  return { ...f, config, saveConfig, run };
}

it.each(["cli", "maintenance"] as const)("%s uses the selected cleanup release for an old pair with absent units", async entry => {
  const f = await retainedPair(), before = f.calls.length;
  expect(await f.run(entry)).toMatchObject({ code: 0, value: { cleanupReason: null } });
  for (const root of [f.root, f.source.globalRoot, f.target.globalRoot]) {
    const record = await createIntercomRegistry(root).get("pair-1");
    expect(record).toMatchObject({ state: "revoked", cleanupReason: null });
    // Choosing an upgraded executable must not rewrite enrollment consent.
    expect(record!.pair.target.cli).toBe("/fixture/cli");
    expect(record!.resources?.publicKey).toBeUndefined();
  }
  expect(f.machines()).toEqual([]);
  expect(f.calls.slice(before).some(call => /(?:--user (?:start|stop|disable)|machine add|keygen)/.test(call))).toBe(false);
}, 10_000);

it.each(["cli", "maintenance"] as const)("%s will not select an upgraded helper from a different cleanup root", async entry => {
  const f = await retainedPair();
  f.config.peers.find(peer => peer.machineId === B)!.globalRoot = f.otherSource.globalRoot; f.saveConfig();
  expect(await f.run(entry)).toMatchObject({ code: 3 });
  for (const root of [f.root, f.target.globalRoot]) expect((await createIntercomRegistry(root).get("pair-1"))?.cleanupReason).toBeTruthy();
  expect(await createIntercomRegistry(f.otherSource.globalRoot).get("pair-1")).toBeNull();
}, 10_000);

it("a source with no pair route cannot replace target acknowledgment with its stored identity", async () => {
  const f = await retainedPair(), queue = f.queues.get(A)!;
  const config = parseConfig(JSON.parse(readFileSync(join(f.source.globalRoot, "roam", "config.json"), "utf8")));
  const maintenance = createProductionIntercomMaintenance({ root: f.source.globalRoot, config, binary: "/fixture/hc", env: {},
    localPorts: f.locals.get(A), localCore: async () => "core-a",
    transport: { ...f.transport, async pinIntercomPeer(peer) {
      if (peer.alias === "spider-pair-pair-1" && f.machines().length === 0) throw Object.assign(new Error("unavailable"), { code: "machine-not-found" });
      return f.transport.pinIntercomPeer(peer);
    } },
    fenceLocal: async input => ({ machineId: A, peer: B, edgeEpoch: input.edgeEpoch,
      fenceId: queue.fencePair(B, input.edgeEpoch, input.fenceId).fence.fenceId, exchanges: "closed", inFlight: 0 }) });
  expect(await maintenance.recoverRevocations(queue)).toMatchObject([{ code: 3, reason: "intercom-revocation-unconfirmed",
    revocationGates: [{ side: "target", gate: "identity-pin-unavailable", causeCode: "machine-not-found" }] }]);
  expect(await createIntercomRegistry(f.source.globalRoot).get("pair-1")).toMatchObject({ cleanupReason: "intercom-revocation-unconfirmed",
    unit: { closedFenceId: null } });
});
