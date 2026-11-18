import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
  expect(await registry.get("pair-1")).toMatchObject({ state: "cancelled", fenceId: null });
  expect(await main(["roam", "intercom", "cancel", "pair-1"], f.io, { intercomOptions: { journal: f.journal } })).toBe(0);
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
it("names revocation after a core change once the pair is bound", async () => {
  const f = await fixture(), registry = createIntercomRegistry(f.root);
  f.enrollment.hostConnector = async () => "unhosted";
  expect(await provisionIntercomEnrollment(f.request, f.enrollment)).toMatchObject({ reason: "intercom-tunnel-unhosted" });
  const record = (await registry.get("pair-1"))!;
  await expect(registry.cancelPending("pair-1", record.operationId, record.graphDigest)).rejects.toThrow("intercom-enrollment-bound");
  const pin = f.transport.pinIntercomPeer.bind(f.transport);
  vi.spyOn(f.transport, "pinIntercomPeer").mockImplementation(async peer => ({ ...await pin(peer), coreId: `restarted-${peer.machineId}` }));
  expect(await provisionIntercomEnrollment(f.request, f.enrollment)).toMatchObject({ reason: "core-changed", repairCommand: "spider roam intercom revoke pair-1" });
}, 10000);

it("keeps a predecessor fence recoverable after revoke, re-enrollment, core change, and cancel", async () => {
  const f = await fixture(), root = f.source.globalRoot, machineId = f.source.machineId;
  vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
  const request = f.request;
  const ports = (request: typeof f.request) => createProductionIntercomEnrollmentPorts({ root, journal: f.journal, request, transport: f.transport,
    actor: "fixture", now: () => 2000, present: async () => {}, approve: async () => true, notify: async () => {}, warn: async () => {} });
  const installed = await provisionIntercomEnrollment(request, f.enrollment);
  expect(installed, JSON.stringify(installed)).toMatchObject({ code: 0 });
  expect(await main(["roam", "intercom", "revoke", "pair-1"], f.io, { intercomOptions: { journal: f.journal, revokePorts: f.revokePorts } })).toBe(0);
  const fence = f.queues.get(machineId)!.pairFence(f.target.machineId)!;
  const next = { ...request, operation: { ...request.operation, id: "second-enrollment" }, pairs: request.pairs.map(pair => ({ ...pair, edgeEpoch: "edge-2" })) };
  const interrupted = ports(next); interrupted.checkConnector = async () => "not-signed-in";
  expect(await provisionIntercomEnrollment(next, interrupted)).toMatchObject({ reason: "intercom-connector-sign-in-required" });
  const registry = createIntercomRegistry(root);
  expect(await registry.get("pair-1")).toMatchObject({ state: "pending", fenceId: fence.fenceId });
  const pin = f.transport.pinIntercomPeer.bind(f.transport);
  const changed = vi.spyOn(f.transport, "pinIntercomPeer").mockImplementation(async peer => ({ ...await pin(peer), coreId: `changed-${peer.machineId}` }));
  expect(await provisionIntercomEnrollment(next, interrupted)).toMatchObject({ reason: "core-changed" });
  const retained = (await registry.get("pair-1"))!;
  await registry.cancelPending("pair-1", retained.operationId, retained.graphDigest);
  await registry.cancelPending("pair-1", retained.operationId, retained.graphDigest);
  expect(await registry.get("pair-1")).toMatchObject({ state: "cancelled", fenceId: fence.fenceId });
  expect(f.queues.get(machineId)!.pairFence(f.target.machineId)).toEqual(fence);
  expect(await registry.revocationPending("pair-1")).toBe(false);
  const { runLocalDoctor } = await import("../local-diagnostics");
  const health = await runLocalDoctor({ root });
  expect(health.diagnostics.filter(row => row.reason.startsWith("intercom-fence-mismatch") || row.reason.startsWith("intercom-revocation-unconfirmed"))).toEqual([]);
  await expect(registry.register(request.pairs[0], "old-epoch", "b".repeat(64))).rejects.toThrow("revocation-pending");
  expect(await registry.get("pair-1")).toMatchObject({ state: "cancelled", fenceId: fence.fenceId });
  changed.mockRestore();
  const fresh = { ...next, operation: { ...next.operation, id: "third-enrollment" }, pairs: next.pairs.map(pair => ({ ...pair, edgeEpoch: "edge-3" })) };
  expect(await provisionIntercomEnrollment(fresh, ports(fresh)), f.errors()).toMatchObject({ code: 0 });
  expect(await registry.get("pair-1")).toMatchObject({ state: "active" });
  expect(f.queues.get(machineId)!.pairFence(f.target.machineId)).toBeNull();
}, 10000);

it("cancelling one pending pair does not prevent its sibling from finishing", async () => {
  const f = await fixture(), second = { ...f.request.pairs[0], pairId: "pair-2", source: f.otherSource };
  const request = { ...f.request, pairs: [...f.request.pairs, second] };
  const ports = createProductionIntercomEnrollmentPorts({ root: f.root, journal: f.journal, request, transport: f.transport,
    actor: "fixture", now: () => 2000, present: async () => {}, approve: async () => true, notify: async () => {}, warn: async () => {} });
  const checkConnector = ports.checkConnector;
  ports.checkConnector = async (machine, pin) => machine.machineId === f.source.machineId ? "not-signed-in" : checkConnector(machine, pin);
  ports.hostConnector = async () => "unhosted";
  expect(await provisionIntercomEnrollment(request, ports)).toMatchObject({ code: 3 });
  expect(await createIntercomRegistry(f.root).get("pair-2")).toMatchObject({ state: "pending", pair: { sshUser: "fixture" } });
  const pin = f.transport.pinIntercomPeer.bind(f.transport);
  vi.spyOn(f.transport, "pinIntercomPeer").mockImplementation(async peer => ({ ...await pin(peer), ...(peer.machineId === f.source.machineId ? { coreId: "changed-core" } : {}) }));
  expect(await provisionIntercomEnrollment(request, ports)).toMatchObject({ value: { pending: expect.arrayContaining([{ pairId: "pair-1", reason: "core-changed" }]) } });
  expect(await main(["roam", "intercom", "cancel", "pair-2"], f.io, { intercomOptions: { journal: f.journal } })).toBe(1);
  expect(await main(["roam", "intercom", "cancel", "pair-1"], f.io, { intercomOptions: { journal: f.journal } })).toBe(0);
  const real = createProductionIntercomEnrollmentPorts({ root: f.root, journal: f.journal, request, transport: f.transport,
    actor: "fixture", now: () => 2000, present: async () => {}, approve: async () => true, notify: async () => {}, warn: async () => {} });
  const result = await provisionIntercomEnrollment(request, real);
  expect(result).toMatchObject({ code: 3, value: { pairs: ["pair-2"], pending: [{ pairId: "pair-1", reason: "intercom-enrollment-cancelled" }] } });
  expect((await createIntercomRegistry(f.root).get("pair-2"))?.state).toBe("active");
}, 10000);

it("treats a previously removed cancelled record as an already-complete no-op", async () => {
  const f = await fixture();
  f.enrollment.checkConnector = async () => "not-signed-in";
  await provisionIntercomEnrollment(f.request, f.enrollment);
  expect(await main(["roam", "intercom", "cancel", "pair-1"], f.io, { intercomOptions: { journal: f.journal } })).toBe(0);
  unlinkSync(join(f.root, "roam", "intercom", "enrollments", "pair-1.json"));
  const before = f.calls.length;
  expect(await main(["roam", "intercom", "cancel", "pair-1"], f.io, { intercomOptions: { journal: f.journal } })).toBe(0);
  expect(f.output()).toContain("intercom-pair-absent");
  expect(f.calls).toHaveLength(before);
}, 10000);

it("names predecessor cleanup rather than claiming the pending operation owns resources", async () => {
  const f = await fixture(), registry = createIntercomRegistry(f.root);
  f.enrollment.checkConnector = async () => "not-signed-in";
  await provisionIntercomEnrollment(f.request, f.enrollment);
  const file = join(f.root, "roam", "intercom", "enrollments", "pair-1.json");
  const retained = { ...JSON.parse(readFileSync(file, "utf8")), cleanupReason: "intercom-revocation-cleanup-pending" };
  writeFileSync(file, JSON.stringify(retained), { mode: 0o600 });
  expect(await main(["roam", "intercom", "cancel", "pair-1"], f.io, { intercomOptions: { journal: f.journal } })).toBe(1);
  expect(f.errors()).toContain("intercom-predecessor-cleanup-pending");
  expect(f.errors()).toContain("spider roam doctor");
  await expect(registry.cancelPending("pair-1", retained.operationId, retained.graphDigest)).rejects.toThrow("intercom-predecessor-cleanup-pending");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(retained);
}, 10000);

it("preserves recorded resources on an unbound record and unrelated keys", async () => {
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
