import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@spider/db-core";
import { createIntercomRegistry } from "../intercom-registry";
import { revokeIntercomPair } from "../intercom-enrollment";
import type { IntercomEnrollmentPair, IntercomRevocationPorts } from "../provision-contracts";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const FENCE = "00000000-0000-4000-8000-000000000003";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "revoke-gates-")); roots.push(root);
  const peer = (machineId: string, alias: string) => ({ machineId, alias, node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/core", globalRoot: root });
  const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]);
  const pair: IntercomEnrollmentPair = { pairId: "pair-1", edgeEpoch: "edge-1", source: peer(A, "source.invalid"), target: peer(B, "target.invalid"),
    sshUser: "fixture", hostKey: { type: "ssh-ed25519", base64: blob.toString("base64") }, hostKeyAlias: `spider-${"a".repeat(32)}`,
    connector: { tunnelId: "tunnel", remotePort: 22, session: "default" } };
  const registry = createIntercomRegistry(root);
  await registry.register(pair, "enroll-1", "a".repeat(64)); await registry.bind(pair, "enroll-1"); await registry.activate(pair.pairId, "enroll-1");
  const ports: IntercomRevocationPorts = {
    async withLock(work) { return work(); },
    async getPair(id) { return await registry.get(id) as Awaited<ReturnType<IntercomRevocationPorts["getPair"]>>; },
    async fenceAndClose() { return { sourceMachineId: A, targetMachineId: B, localMachineId: A, edgeEpoch: "edge-1", fenceId: FENCE, fenceDurable: true, exchanges: "closed", inFlight: 0 }; },
    async fenceRemote() { return { sourceMachineId: A, targetMachineId: B, localMachineId: B, edgeEpoch: "edge-1", fenceId: FENCE, fenceDurable: true, exchanges: "closed", inFlight: 0 }; },
    async beginRevocation() { await registry.beginRevocation(pair.pairId, FENCE); },
    async notify() {},
    async pinMachine(machine) { return { machineId: machine.machineId, coreId: `core-${machine.machineId}` }; },
    async stopPairHost() { return { machineId: B, unit: "spider-pair-pair-1-host.service", activeState: "inactive", mainPid: 123, mainStartIdentity: "start-1", mainProcess: "exited", controlGroup: "empty", killMode: "control-group" }; },
    async removeAuthorizedKey() {},
    async removeMachineIfIdle() { return "removed"; },
    async verifyRevocation() { return { sourceMachineId: A, targetMachineId: B, edgeEpoch: "edge-1", keyAbsent: true, routeAbsent: true, exchanges: "closed", authenticatedConnections: "closed" }; },
    async finishRevocation(_pair, reason, gates) { await registry.finishRevocation(pair.pairId, reason, gates); },
  };
  return { root, pair, registry, ports };
}

type Setup = (ports: IntercomRevocationPorts) => void;
const denied = () => Object.assign(new Error("private error detail"), { code: "EACCES" });

it.each<[string, Setup, { side: string; gate: string; causeCode?: string }]>([
  ["target pin absent", p => { p.pinMachine = async m => m.machineId === B ? null : { machineId: A, coreId: "core-a" }; }, { side: "target", gate: "identity-pin-unavailable" }],
  ["target pin throws", p => { p.pinMachine = async m => { if (m.machineId === B) throw denied(); return { machineId: A, coreId: "core-a" }; }; }, { side: "target", gate: "identity-pin-unavailable", causeCode: "EACCES" }],
  ["target pin invalid", p => { p.pinMachine = async m => ({ machineId: m.machineId, coreId: m.machineId === B ? "" : "core-a" }); }, { side: "target", gate: "identity-pin-invalid" }],
  ["source pin invalid", p => { p.pinMachine = async m => ({ machineId: m.machineId, coreId: m.machineId === A ? "" : "core-b" }); }, { side: "source", gate: "identity-pin-invalid" }],
  ["remote closure invalid", p => { p.fenceRemote = async () => ({ sourceMachineId: A, targetMachineId: B, localMachineId: B, edgeEpoch: "edge-1", fenceId: FENCE, fenceDurable: true, exchanges: "active", inFlight: 1 }); }, { side: "target", gate: "fence-closure-unproven" }],
  ["remote closure throws", p => { p.fenceRemote = async () => { throw denied(); }; }, { side: "target", gate: "fence-closure-unproven", causeCode: "EACCES" }],
  ["host closure invalid", p => { p.stopPairHost = async () => null; }, { side: "target", gate: "host-closure-unproven" }],
  ["host closure throws", p => { p.stopPairHost = async () => { throw denied(); }; }, { side: "target", gate: "host-closure-unproven", causeCode: "EACCES" }],
  ["explicit host error code", p => { p.stopPairHost = async () => { throw Object.assign(new Error("unsafe-pair-key"), { code: "unexpected-revoke-host" }); }; }, { side: "target", gate: "host-closure-unproven", causeCode: "unexpected-revoke-host" }],
  ["authorization removal throws", p => { p.removeAuthorizedKey = async () => { throw denied(); }; }, { side: "target", gate: "authorization-removal-unproven", causeCode: "EACCES" }],
  ["authorization reports a named error", p => { p.removeAuthorizedKey = async () => { throw new Error("unsafe-pair-key"); }; }, { side: "target", gate: "authorization-removal-unproven", causeCode: "unsafe-pair-key" }],
  ["authorization absence unproven", p => { p.verifyRevocation = async () => ({ sourceMachineId: A, targetMachineId: B, edgeEpoch: "edge-1", keyAbsent: false, routeAbsent: true, exchanges: "closed", authenticatedConnections: "closed" }); }, { side: "target", gate: "authorization-absence-unproven" }],
])("names %s in the reply and the durable record", async (_name, setup, gate) => {
  const f = await fixture(); setup(f.ports);
  const result = await revokeIntercomPair(f.pair.pairId, f.ports);
  expect(result).toMatchObject({ code: 3, reason: "intercom-revocation-unconfirmed", revocationGates: [gate], repairCommand: "spider roam intercom revoke pair-1" });
  expect(await createIntercomRegistry(f.root).get(f.pair.pairId)).toMatchObject({ state: "revoked", cleanupReason: "intercom-revocation-unconfirmed", revocationGates: [gate] });
});

it("reports both identities when both returned pins are invalid", async () => {
  const f = await fixture(); f.ports.pinMachine = async m => ({ machineId: m.machineId, coreId: "" });
  const gates = [{ side: "target", gate: "identity-pin-invalid" }, { side: "source", gate: "identity-pin-invalid" }];
  expect(await revokeIntercomPair(f.pair.pairId, f.ports)).toMatchObject({ code: 3, revocationGates: gates });
  expect(await createIntercomRegistry(f.root).get(f.pair.pairId)).toMatchObject({ revocationGates: gates });
});

it.each(["source unavailable", "remote fence throws"])("keeps target-local proof sufficient when %s", async scenario => {
  const f = await fixture();
  f.ports.fenceAndClose = async () => ({ sourceMachineId: A, targetMachineId: B, localMachineId: B, edgeEpoch: "edge-1", fenceId: FENCE, fenceDurable: true, exchanges: "closed", inFlight: 0 });
  if (scenario === "source unavailable") f.ports.pinMachine = async m => m.machineId === A ? null : { machineId: B, coreId: "core-b" };
  else f.ports.fenceRemote = async () => { throw denied(); };
  expect(await revokeIntercomPair(f.pair.pairId, f.ports)).toMatchObject({ code: 0, reason: "intercom-revoked", value: { cleanupReason: null } });
  expect((await f.registry.get(f.pair.pairId))?.revocationGates).toBeUndefined();
});

it("sanitizes an unknown thrown code and updates the gate on retry", async () => {
  const f = await fixture();
  f.ports.stopPairHost = async () => { throw Object.assign(new Error("private detail"), { code: "/private/path" }); };
  const first = await revokeIntercomPair(f.pair.pairId, f.ports);
  expect(first).toMatchObject({ revocationGates: [{ side: "target", gate: "host-closure-unproven", causeCode: "unexpected-revoke-host" }] });
  f.ports.stopPairHost = async () => null;
  await revokeIntercomPair(f.pair.pairId, f.ports);
  expect(await createIntercomRegistry(f.root).get(f.pair.pairId)).toMatchObject({ revocationGates: [{ side: "target", gate: "host-closure-unproven" }] });
  expect(JSON.stringify(await f.registry.get(f.pair.pairId))).not.toContain("private");
});

it("reads old records without gates and renders persisted gates in doctor", async () => {
  const f = await fixture();
  await f.registry.beginRevocation(f.pair.pairId, FENCE);
  await f.registry.finishRevocation(f.pair.pairId, "intercom-revocation-unconfirmed");
  expect(await createIntercomRegistry(f.root).get(f.pair.pairId)).toMatchObject({ cleanupReason: "intercom-revocation-unconfirmed" });
  f.ports.stopPairHost = async () => null;
  await revokeIntercomPair(f.pair.pairId, f.ports);
  const file = join(f.root, "roam", "intercom", "enrollments", "pair-1.json"), before = readFileSync(file);
  const { runLocalDoctor } = await import("../local-diagnostics");
  const report = await runLocalDoctor({ root: f.root });
  const diagnosis = report.diagnostics.find(d => d.reason.includes("intercom-revocation-unconfirmed"));
  expect(diagnosis?.reason).toContain("target:host-closure-unproven");
  expect(readFileSync(file)).toEqual(before);
});

it("retains the last diagnosed gate across an intermediate unconfirmed marker", async () => {
  const f = await fixture(); f.ports.stopPairHost = async () => null;
  await revokeIntercomPair(f.pair.pairId, f.ports);
  await f.registry.beginRevocation(f.pair.pairId, FENCE);
  await f.registry.finishRevocation(f.pair.pairId, "intercom-revocation-unconfirmed");
  expect(await createIntercomRegistry(f.root).get(f.pair.pairId)).toMatchObject({ revocationGates: [{ side: "target", gate: "host-closure-unproven" }] });
});

it("clears the old gate when a retry confirms revocation", async () => {
  const f = await fixture(), stop = f.ports.stopPairHost!;
  f.ports.stopPairHost = async () => null;
  await revokeIntercomPair(f.pair.pairId, f.ports);
  f.ports.stopPairHost = stop;
  expect(await revokeIntercomPair(f.pair.pairId, f.ports)).toMatchObject({ code: 0, reason: "intercom-revoked" });
  const record = await createIntercomRegistry(f.root).get(f.pair.pairId);
  expect(record?.cleanupReason).toBeNull(); expect(record?.revocationGates).toBeUndefined();
});

it("rejects unsafe gates in stored records", async () => {
  const f = await fixture();
  await f.registry.beginRevocation(f.pair.pairId, FENCE);
  await f.registry.finishRevocation(f.pair.pairId, "intercom-revocation-unconfirmed");
  const file = join(f.root, "roam", "intercom", "enrollments", "pair-1.json");
  const record = JSON.parse(readFileSync(file, "utf8"));
  record.revocationGates = [{ side: "target", gate: "host-closure-unproven", causeCode: "/private/path" }];
  writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  await expect(createIntercomRegistry(f.root).get(f.pair.pairId)).rejects.toThrow("invalid-intercom-registry");
});

it("renders the gate in peer doctor observations", async () => {
  const { intercomDiagnostics } = await import("../resource-doctor");
  const report = intercomDiagnostics({ connector: "ready", login: "ready", tunnel: "hosted", peerPort: "reachable", hostKey: "match", key: "ready", route: "ready", extension: "ready", broker: "ready", feature: "ready", link: "live",
    pendingRevocations: [{ pairId: "pair-1", reason: "intercom-revocation-unconfirmed", revocationGates: [{ side: "target", gate: "host-closure-unproven", causeCode: "EACCES" }] }] });
  expect(report).toContainEqual(expect.objectContaining({ severity: "block", reason: expect.stringContaining("target:host-closure-unproven [EACCES]") }));
  const unsafe = { connector: "ready", login: "ready", tunnel: "hosted", peerPort: "reachable", hostKey: "match", key: "ready", route: "ready", extension: "ready", broker: "ready", feature: "ready", link: "live",
    pendingRevocations: [{ pairId: "pair-1", reason: "intercom-revocation-unconfirmed", revocationGates: [{ side: "target", gate: "/private/path" }] }] };
  expect(() => intercomDiagnostics(unsafe as never)).toThrow("intercom-diagnostics-invalid");
});

it("registers the fallback cause codes used for caught revocation failures", async () => {
  const { safeCauseCode } = await import("../cause-codes");
  for (const code of ["unexpected-revoke-pin", "unexpected-revoke-remote-fence", "unexpected-revoke-host", "unexpected-revoke-authorization", "unexpected-revoke-remote-cleanup"]) expect(safeCauseCode(code)).toBe(code);
  expect(safeCauseCode("/private/path")).toBeUndefined();
});

it.each([["intercom-pair-unit-missing", "intercom-pair-unit-missing"], ["/private/path", "unexpected-revoke-remote-cleanup"]])("sanitizes cleanup helper error %s", async (code, expected) => {
  const f = await fixture();
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: true, role: "box", machineId: A, hubMachineId: B, coreUnit: "fixture.service" }), { mode: 0o600 });
  writeFileSync(join(f.root, "roam", "machine.json"), JSON.stringify({ machineId: A }), { mode: 0o600 });
  const { main } = await import("../cli"); let out = "";
  expect(await main(["--global-root", f.root, "roam", "intercom", "cleanup-local"], { out: text => { out += text; }, err: () => {} }, {
    stdin: Buffer.from(JSON.stringify({ action: "stop-host", pairId: "pair-1", fenceId: FENCE })),
    get pairPorts(): never { throw Object.assign(new Error("private detail"), { code }); },
  })).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ ok: false, reason: "intercom-revocation-cleanup-pending", cause: { code: expected } });
  expect(out).not.toContain("private");
});

it.each([["intercom-pair-unit-missing", "intercom-pair-unit-missing"], ["/private/path", "intercom-revocation-cleanup-pending"]])("sanitizes remote cause %s in the production reply and registry", async (remoteCode, expectedCode) => {
  const f = await fixture();
  await f.registry.bindResources(f.pair.pairId, "enroll-1", { hostUnit: "spider-pair-pair-1-host.service", connectUnit: "spider-pair-pair-1-connect.service",
    route: { name: "spider-pair-pair-1", targetCoreId: "core-b", via: join(f.root, "roam", "intercom", "pairs", "pair-1", "edge-1", "via"), session: "default", temporary: false } });
  const { createProductionIntercomRevocationPorts } = await import("../intercom-production");
  const ports = createProductionIntercomRevocationPorts({ root: f.root, localMachineId: A,
    transport: { async pinIntercomPeer(machine: IntercomEnrollmentPair["target"]) { return { handle: machine, machineId: machine.machineId, coreId: "core-b" }; },
      transport: { async exec(_machine: IntercomEnrollmentPair["target"], argv: readonly string[], options: { stdin?: Buffer }) {
        const input = JSON.parse(options.stdin!.toString());
        if (argv[2] === "revoke-local") return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-revoke", ok: true, value: { machineId: B, peer: A, edgeEpoch: "edge-1", fenceId: FENCE, exchanges: "closed", inFlight: 0 } }));
        if (input.action === "stop-host") return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-cleanup", ok: false, reason: "intercom-revocation-cleanup-pending", cause: { code: remoteCode } }));
        return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-cleanup", ok: true, machineId: B, value: { recorded: true } }));
      } } } as never,
    async localCore() { return "core-a"; }, async fenceLocal() { return { machineId: A, peer: B, edgeEpoch: "edge-1", fenceId: FENCE, exchanges: "closed", inFlight: 0 }; },
    async cleanupLocal() { throw new Error("unexpected local cleanup"); }, async notify() {} });
  const gate = { side: "target", gate: "host-closure-unproven", causeCode: expectedCode };
  const result = await revokeIntercomPair(f.pair.pairId, ports);
  expect(result).toMatchObject({ code: 3, revocationGates: [gate] });
  expect(await createIntercomRegistry(f.root).get(f.pair.pairId)).toMatchObject({ revocationGates: [gate] });
  expect(JSON.stringify(result)).not.toContain("/private/path");
});

it("returns JSON for invalid revoke arguments and a missing pair", async () => {
  const f = await fixture();
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: true, role: "box", machineId: A, hubMachineId: B, coreUnit: "fixture.service" }), { mode: 0o600 });
  writeFileSync(join(f.root, "roam", "machine.json"), JSON.stringify({ machineId: A }), { mode: 0o600 });
  const { main } = await import("../cli"); let out = "", err = "";
  const io = { out: (text: string) => { out += text; }, err: (text: string) => { err += text; } };
  expect(await main(["--global-root", f.root, "roam", "intercom", "revoke", "bad/id", "--json"], io)).toBe(2);
  expect(JSON.parse(out)).toMatchObject({ code: 2, reason: "invalid-arguments" }); expect(err).toBe("");
  out = "";
  expect(await main(["--global-root", f.root, "roam", "intercom", "revoke", "missing", "--json"], io)).toBe(1);
  expect(JSON.parse(out)).toMatchObject({ code: 1, reason: "intercom-pair-not-found" }); expect(err).toBe("");
});

it("returns named gates and the repair hint in revoke JSON", async () => {
  const f = await fixture(); f.ports.stopPairHost = async () => null;
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: true, role: "box", machineId: A, hubMachineId: B, coreUnit: "fixture.service" }), { mode: 0o600 });
  writeFileSync(join(f.root, "roam", "machine.json"), JSON.stringify({ machineId: A }), { mode: 0o600 });
  const { main } = await import("../cli"); let out = "", err = "";
  const code = await main(["--global-root", f.root, "roam", "intercom", "revoke", "pair-1", "--json"], { out: text => { out += text; }, err: text => { err += text; } }, { intercomOptions: { revokePorts: f.ports } });
  expect(code).toBe(3); expect(err).toBe("");
  expect(JSON.parse(out)).toMatchObject({ reason: "intercom-revocation-unconfirmed", revocationGates: [{ side: "target", gate: "host-closure-unproven" }], repairCommand: "spider roam intercom revoke pair-1" });
  out = ""; err = "";
  expect(await main(["--global-root", f.root, "roam", "intercom", "revoke", "pair-1"], { out: text => { out += text; }, err: text => { err += text; } }, { intercomOptions: { revokePorts: f.ports } })).toBe(3);
  expect(err).toContain("target:host-closure-unproven"); expect(err).toContain("spider roam intercom revoke pair-1");
  out = ""; err = ""; f.ports.fenceEpoch = "edge-1";
  expect(await main(["--global-root", f.root, "roam", "intercom", "revoke", "pair-1", "--fence-epoch", "edge-1", "--json"], { out: text => { out += text; }, err: text => { err += text; } }, { intercomOptions: { revokePorts: f.ports } })).toBe(3);
  expect(JSON.parse(out)).toMatchObject({ repairCommand: "spider roam intercom revoke pair-1 --fence-epoch edge-1", revocationGates: [{ side: "target", gate: "host-closure-unproven" }] }); expect(err).toBe("");
});
