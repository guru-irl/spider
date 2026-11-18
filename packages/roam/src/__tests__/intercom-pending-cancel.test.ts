import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli";
import { provisionIntercomEnrollment } from "../intercom-enrollment";
import { createProductionIntercomEnrollmentPorts } from "../intercom-production";
import { createIntercomRegistry } from "../intercom-registry";
import { pairResources } from "../intercom-pair-resources";
import { cleanupPairScenarios, scenario } from "./intercom-pair-fixture";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); cleanupPairScenarios(); });
async function fixture() {
  const f = await scenario(), machineId = f.request.operation.machineId;
  mkdirSync(join(f.root, "roam"), { recursive: true, mode: 0o700 });
  writeFileSync(join(f.root, "roam", "machine.json"), JSON.stringify({ machineId }), { mode: 0o600 });
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ enabled: false, role: "hub", machineId, hubMachineId: machineId,
    coreUnit: "fixture.service", peers: [f.source, f.target], intercom: { enabled: true, mode: "peers", machineAlias: "hub.invalid", routes: [] } }), { mode: 0o600 });
  vi.stubEnv("SPIDER_GLOBAL_ROOT", f.root);
  let output = "", errors = "";
  const io = { out(text: string) { output += text; }, err(text: string) { errors += text; } };
  return { ...f, io, output: () => output, errors: () => errors };
}
it("cancels the unbound operation after a core change, then enrolls with fresh approval", async () => {
  const f = await fixture(), registry = createIntercomRegistry(f.root);
  f.enrollment.checkConnector = async () => "not-signed-in";
  expect(await provisionIntercomEnrollment(f.request, f.enrollment)).toMatchObject({ reason: "intercom-connector-sign-in-required" });
  const pin = f.transport.pinIntercomPeer.bind(f.transport);
  vi.spyOn(f.transport, "pinIntercomPeer").mockImplementation(async peer => ({ ...await pin(peer), coreId: `restarted-${peer.machineId}` }));
  expect(await provisionIntercomEnrollment(f.request, f.enrollment)).toMatchObject({ reason: "core-changed", repairCommand: "spider roam intercom cancel pair-1" });
  expect(await main(["roam", "intercom", "cancel", "pair-1"], f.io, { intercomOptions: { journal: f.journal, transport: f.transport } })).toBe(0);
  expect(await registry.get("pair-1")).toBeNull();
  expect(f.units.size).toBe(0); expect(f.machines()).toEqual([]);
  expect(await provisionIntercomEnrollment(f.request, f.enrollment)).toMatchObject({ code: 1, reason: "intercom-enrollment-cancelled" });
  vi.restoreAllMocks();
  const request = { ...f.request, operation: { ...f.request.operation, id: "fresh-enrollment" } };
  const ports = createProductionIntercomEnrollmentPorts({ root: f.root, journal: f.journal, request, transport: f.transport,
    actor: "fixture", now: () => 2000, present: async () => {}, approve: async () => true, notify: async () => {}, warn: async () => {} });
  expect(await provisionIntercomEnrollment(request, ports)).toMatchObject({ code: 0, reason: "intercom-enrolled" });
  expect((await registry.get("pair-1"))?.state).toBe("active");
  expect(await main(["roam", "intercom", "cancel", "pair-1"], f.io, { intercomOptions: { journal: f.journal } })).toBe(1);
  expect(f.errors()).toContain("intercom-enrollment-bound");
  expect((await registry.get("pair-1"))?.state).toBe("active");
}, 10000);
it("preserves bound records, recorded resources, and unrelated keys", async () => {
  const f = await fixture(), registry = createIntercomRegistry(f.root), pair = f.request.pairs[0];
  const digest = createHash("sha256").update(JSON.stringify(f.request.pairs)).digest("hex");
  f.journal.begin({ ...f.request.operation, args: { graphDigest: digest } });
  await registry.register(pair, f.request.operation.id, digest);
  await registry.bindResources(pair.pairId, f.request.operation.id, pairResources({ ...pair, sshUser: "fixture", hostKey: { type: "ssh-ed25519", base64: f.publicKey.split(" ")[1] }, hostKeyAlias: `spider-${"a".repeat(32)}` }, "core-b"));
  const file = join(f.root, "roam", "intercom", "enrollments", "pair-1.json"), before = readFileSync(file);
  const ssh = join(f.locals.get(f.target.machineId)!.home, ".ssh"); mkdirSync(ssh, { mode: 0o700 });
  const keep = join(ssh, "authorized_keys"), original = `restrict ${f.publicKey} unmanaged\n`; writeFileSync(keep, original, { mode: 0o600 });
  expect(await main(["roam", "intercom", "cancel", "pair-1"], f.io, { intercomOptions: { journal: f.journal } })).toBe(1);
  expect(f.errors()).toContain("intercom-pending-resources-present"); expect(readFileSync(file)).toEqual(before);
  expect(readFileSync(keep, "utf8")).toBe(original); expect(f.calls).toEqual([]);
  expect(f.journal.read(f.request.operation.id).filter(row => row.action === "intercom-enrollment-cancelled")).toEqual([]);
}, 10000);
