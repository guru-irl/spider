import { paths } from "@spider/db-core";
import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createIntercomRegistry } from "../intercom-registry";
import { pairResources } from "../intercom-pair-resources";
import { openIntercomStore } from "../intercom-store";
import { runLocalDoctor } from "../local-diagnostics";
import type { IntercomStore } from "../intercom-contracts";
import type { IntercomEnrollmentPair } from "../provision-contracts";

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const HUB = "00000000-0000-4000-8000-000000000003";
const OLD_FENCE = "00000000-0000-4000-8000-000000000004", NEW_FENCE = "00000000-0000-4000-8000-000000000005";
const roots: string[] = [], queues: IntercomStore[] = [];
afterEach(() => {
  for (const queue of queues.splice(0)) queue.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(machineId = A) {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "enable-history-")); roots.push(root);
  mkdirSync(join(root, "roam"), { mode: 0o700 });
  writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId }), { mode: 0o600 });
  writeFileSync(join(root, "roam", "config.json"), JSON.stringify({ enabled: false, role: "box", machineId, hubMachineId: HUB,
    peers: [], coreUnit: "fixture.service" }), { mode: 0o600 });
  const peer = (machineId: string) => ({ machineId, alias: `peer-${machineId.slice(-1)}.invalid`, globalRoot: root,
    node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc" });
  const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]);
  const base: IntercomEnrollmentPair = { pairId: "pair-old", edgeEpoch: "edge-old", source: peer(A), target: peer(B), sshUser: "fixture",
    hostKey: { type: "ssh-ed25519", base64: blob.toString("base64") }, hostKeyAlias: `spider-${"a".repeat(32)}`,
    connector: { tunnelId: "tunnel", remotePort: 22, session: "default" } };
  const registry = createIntercomRegistry(root), other = machineId === A ? B : A;
  const queue = openIntercomStore({ file: join(root, "roam", "intercom", "queue.db"), machineId, clock: { now: () => 1000 } }); queues.push(queue);
  for (const [pairId, edgeEpoch, fenceId, expectedFenceId] of [
    ["pair-old", "edge-old", OLD_FENCE, null], ["pair-new", "edge-new", NEW_FENCE, OLD_FENCE],
  ] as const) {
    const pair = { ...base, pairId, edgeEpoch }, operationId = `approval-${pairId}`, graphDigest = "a".repeat(64);
    const { sshUser: _user, hostKey: _key, hostKeyAlias: _alias, ...plan } = pair;
    await registry.register(plan, operationId, graphDigest); await registry.bind(pair, operationId);
    await registry.bindResources(pairId, operationId, pairResources(pair, "core-fixture"));
    const side = machineId === A ? "connect" : "host";
    const unit = { name: `spider-pair-${pairId}-${side}.service`, file: join(root, `${pairId}.service`),
      contents: "synthetic unit", localPort: 22, main: null, closedFenceId: null };
    await registry.recordUnit(pairId, unit);
    expect(queue.approvePair(other, { expectedFenceId, operationId, graphDigest, edgeEpoch })).toBe(true);
    await registry.activate(pairId, operationId);
    expect(queue.fencePair(other, edgeEpoch, fenceId).fence).toMatchObject({ fenceId, edgeEpoch });
    await registry.beginRevocation(pairId, fenceId, edgeEpoch);
    await registry.recordUnit(pairId, { ...unit, closedFenceId: fenceId });
    await registry.finishRevocation(pairId, null);
  }
  const file = (pairId: string) => join(root, "roam", "intercom", "enrollments", `${pairId}.json`);
  return { root, registry, queue, other, file };
}

async function fenceDiagnostics(root: string) {
  return (await runLocalDoctor({ root })).diagnostics.filter(row =>
    row.reason.startsWith("intercom-fence-mismatch:") || row.reason.startsWith("intercom-revocation-unconfirmed:"));
}

it.each([A, B])("enable diagnostics accept two completed revocations on the same peer from %s", async machineId => {
  const f = await fixture(machineId), before = await f.registry.list(), fence = f.queue.pairFence(f.other);
  expect(await fenceDiagnostics(f.root)).toEqual([]);
  expect(await f.registry.list()).toEqual(before); expect(f.queue.pairFence(f.other)).toEqual(fence);
});

it.each(["revoking", "unconfirmed", "cleanup-pending", "open-fence", "wrong-closed-fence", "missing-unit", "missing-epoch"] as const)(
  "enable diagnostics name the unsettled historical pair: %s", async failure => {
    const f = await fixture(), file = f.file("pair-old"), record = JSON.parse(readFileSync(file, "utf8"));
    if (failure === "revoking") record.state = "revoking";
    if (failure === "unconfirmed") record.cleanupReason = "intercom-revocation-unconfirmed";
    if (failure === "cleanup-pending") record.cleanupReason = "intercom-revocation-cleanup-pending";
    if (failure === "open-fence") record.unit.closedFenceId = null;
    if (failure === "wrong-closed-fence") record.unit.closedFenceId = NEW_FENCE;
    if (failure === "missing-unit") delete record.unit;
    if (failure === "missing-epoch") delete record.revocationEpoch;
    writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
    const before = readFileSync(file), diagnostics = await fenceDiagnostics(f.root);
    expect(diagnostics).toContainEqual(expect.objectContaining({ severity: "block", reason: expect.stringContaining("intercom-fence-mismatch: Pair pair-old"),
      repairCommand: "spider roam intercom revoke pair-old --fence-epoch edge-new" }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ severity: "block", reason: expect.stringMatching(/intercom-revocation-unconfirmed:.*pair-old/),
      repairCommand: "spider roam intercom revoke pair-old" }));
    expect(diagnostics.some(row => row.reason.includes("pair-new"))).toBe(false);
    expect(readFileSync(file)).toEqual(before);
  });

it.each(["active", "pending"] as const)("enable diagnostics still reject a %s current pair with the wrong fence epoch", async state => {
  const f = await fixture(), file = f.file("pair-new"), record = JSON.parse(readFileSync(file, "utf8"));
  record.state = state; record.fenceId = null; record.pair.edgeEpoch = "edge-current";
  record.resources = pairResources(record.pair, "core-fixture");
  delete record.revocationEpoch; record.unit.closedFenceId = null;
  writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  const diagnostics = await fenceDiagnostics(f.root);
  expect(diagnostics).toContainEqual(expect.objectContaining({ severity: "block", reason: expect.stringContaining("intercom-fence-mismatch: Pair pair-new") }));
  expect(diagnostics).toContainEqual(expect.objectContaining({ severity: "block", reason: expect.stringMatching(/intercom-revocation-unconfirmed:.*pair-new/) }));
  expect(diagnostics.some(row => row.reason.includes("pair-old"))).toBe(false);
});

it("enable diagnostics still reject a current pair whose epoch matches but fence ID differs", async () => {
  const f = await fixture(), file = f.file("pair-new"), record = JSON.parse(readFileSync(file, "utf8"));
  record.state = "active"; record.fenceId = null; record.unit.closedFenceId = null;
  delete record.revocationEpoch;
  writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  expect(await fenceDiagnostics(f.root)).toContainEqual(expect.objectContaining({ severity: "block",
    reason: expect.stringMatching(/intercom-revocation-unconfirmed:.*pair-new/) }));
});
