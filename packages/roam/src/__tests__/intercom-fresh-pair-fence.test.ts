import { paths } from "@spider/db-core";
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createIntercomRegistry } from "../intercom-registry";
import { createLocalPairRegistry } from "../intercom-local-ops";
import { pairResources } from "../intercom-pair-resources";
import { openIntercomStore } from "../intercom-store";
import type { IntercomStore } from "../intercom-contracts";
import type { IntercomEnrollmentPair } from "../provision-contracts";

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003", FENCE = "00000000-0000-4000-8000-000000000004";
const OTHER_FENCE = "00000000-0000-4000-8000-000000000005";
const roots: string[] = [], queues: IntercomStore[] = [];
afterEach(() => {
  for (const queue of queues.splice(0)) queue.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(backend: "live" | "snapshot", machineId = A) {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "fresh-pair-fence-")); roots.push(root);
  const peer = (machineId: string) => ({ machineId, alias: `peer-${machineId.slice(-1)}.invalid`, globalRoot: root,
    node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc" });
  const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]);
  const pair: IntercomEnrollmentPair = { pairId: "pair-old", edgeEpoch: "edge-old", source: peer(A), target: peer(B), sshUser: "fixture",
    hostKey: { type: "ssh-ed25519", base64: blob.toString("base64") }, hostKeyAlias: `spider-${"a".repeat(32)}`,
    connector: { tunnelId: "tunnel", remotePort: 22, session: "default" } };
  const { sshUser: _user, hostKey: _key, hostKeyAlias: _alias, ...plan } = pair;
  const state = createIntercomRegistry(root);
  await state.register(plan, "approval-old", "a".repeat(64)); await state.bind(pair, "approval-old");
  await state.bindResources(pair.pairId, "approval-old", pairResources(pair, "core-old"));
  const unit = { name: machineId === A ? "spider-pair-pair-old-connect.service" : "spider-pair-pair-old-host.service",
    file: join(root, "unit.service"), contents: "synthetic unit", localPort: 22, main: null, closedFenceId: FENCE };
  await state.recordUnit(pair.pairId, unit);
  const queue = openIntercomStore({ file: join(root, "roam", "intercom", "queue.db"), machineId, clock: { now: () => 1000 } }); queues.push(queue);
  const other = machineId === A ? B : A, fence = queue.fencePair(other, "edge-old", FENCE).fence;
  await state.beginRevocation(pair.pairId, FENCE, "edge-old"); await state.finishRevocation(pair.pairId, null);
  const registry = backend === "snapshot" ? state : createLocalPairRegistry({ root, machineId, async inspectFence(input) {
    const request = input as { machineId: string; peer: string }, value = queue.pairFence(request.peer);
    return { machineId, peer: request.peer, fence: value ? { fenceId: value.fenceId, edgeEpoch: value.edgeEpoch } : null };
  } });
  const fresh = { ...plan, pairId: "pair-fresh", edgeEpoch: "edge-fresh" };
  const file = join(root, "roam", "intercom", "enrollments", "pair-old.json");
  return { root, state, registry, queue, other, fence, pair, fresh, file };
}

for (const backend of ["live", "snapshot"] as const) {
  it.each([A, B])(`a completed predecessor permits a fresh pair through ${backend} on %s`, async machineId => {
    const f = await fixture(backend, machineId), before = readFileSync(f.file);
    expect(await f.registry.get("pair-fresh")).toBeNull();
    expect(await f.registry.revocationPending("pair-fresh", f.other)).toBe(false);
    expect(readFileSync(f.file)).toEqual(before); expect(f.queue.pairFence(f.other)).toEqual(f.fence);
    await expect(f.registry.register(f.fresh, "approval-fresh", "b".repeat(64))).resolves.toBeUndefined();
    expect(await f.registry.get("pair-fresh")).toMatchObject({ state: "pending", fenceId: FENCE, pair: f.fresh });
    await f.registry.bind({ ...f.pair, ...f.fresh }, "approval-fresh");
    await expect(f.registry.approveCommands("pair-fresh", { operationId: "approval-fresh", graphDigest: "b".repeat(64),
      edgeEpoch: "edge-fresh", expectedFenceId: FENCE })).resolves.toBeUndefined();
    expect(await f.registry.get("pair-fresh")).toMatchObject({ state: "pending", commandApprovalFenceId: FENCE });
    expect(readFileSync(f.file)).toEqual(before); expect(f.queue.pairFence(f.other)).toEqual(f.fence);
  });

  it(`a fresh pair cannot reuse its predecessor's revoked epoch through ${backend}`, async () => {
    const f = await fixture(backend), before = await f.state.list();
    await expect(f.registry.register({ ...f.fresh, edgeEpoch: "edge-old" }, "approval-fresh", "b".repeat(64)))
      .rejects.toThrow("fresh-peer-consent-required");
    expect(await f.registry.get("pair-fresh")).toBeNull(); expect(await f.state.list()).toEqual(before);
    expect(f.queue.pairFence(B)).toEqual(f.fence);
  });

  it.each(["cleanup-pending", "unconfirmed", "revoking", "wrong-closed-fence", "missing-unit", "wrong-fence", "wrong-epoch", "missing-epoch", "missing-owner", "wrong-peer"] as const)(
    `an incomplete predecessor (%s) blocks a fresh pair through ${backend}`, async failure => {
      const f = await fixture(backend), record = JSON.parse(readFileSync(f.file, "utf8"));
      if (failure === "cleanup-pending") record.cleanupReason = "intercom-revocation-cleanup-pending";
      if (failure === "unconfirmed") record.cleanupReason = "intercom-revocation-unconfirmed";
      if (failure === "revoking") record.state = "revoking";
      if (failure === "wrong-closed-fence") record.unit.closedFenceId = OTHER_FENCE;
      if (failure === "missing-unit") delete record.unit;
      if (failure === "wrong-fence") record.fenceId = OTHER_FENCE;
      if (failure === "wrong-epoch") record.revocationEpoch = "edge-other";
      if (failure === "missing-epoch") delete record.revocationEpoch;
      if (failure === "wrong-peer") record.pair.target.machineId = C;
      if (failure === "missing-owner") rmSync(f.file);
      else writeFileSync(f.file, JSON.stringify(record), { mode: 0o600 });
      const before = await f.state.list();
      expect(await f.registry.revocationPending("pair-fresh", B)).toBe(true);
      await expect(f.registry.register(f.fresh, "approval-fresh", "b".repeat(64))).rejects.toThrow("revocation-pending");
      expect(await f.registry.get("pair-fresh")).toBeNull(); expect(await f.state.list()).toEqual(before);
      expect(f.queue.pairFence(B)).toEqual(f.fence);
    });

  it.each(["missing-owner", "renamed-owner", "wrong-epoch", "wrong-fence", "wrong-closed-fence", "cleanup-pending", "unconfirmed"] as const)(
    `the fresh pair cannot replace its predecessor's completion proof (%s) through ${backend}`, async failure => {
      const f = await fixture(backend);
      await f.registry.register(f.fresh, "approval-fresh", "b".repeat(64));
      const record = JSON.parse(readFileSync(f.file, "utf8"));
      if (failure === "wrong-epoch") record.revocationEpoch = "edge-other";
      if (failure === "wrong-fence") record.fenceId = OTHER_FENCE;
      if (failure === "wrong-closed-fence") record.unit.closedFenceId = OTHER_FENCE;
      if (failure === "cleanup-pending") record.cleanupReason = "intercom-revocation-cleanup-pending";
      if (failure === "unconfirmed") record.cleanupReason = "intercom-revocation-unconfirmed";
      if (failure === "missing-owner" || failure === "renamed-owner") rmSync(f.file);
      else writeFileSync(f.file, JSON.stringify(record), { mode: 0o600 });
      if (failure === "renamed-owner") {
        record.pair.pairId = "pair-decoy"; record.resources = pairResources(record.pair, "core-old");
        record.unit.name = "spider-pair-pair-decoy-connect.service";
        writeFileSync(join(f.root, "roam", "intercom", "enrollments", "pair-decoy.json"), JSON.stringify(record), { mode: 0o600 });
      }
      const before = await f.state.list();
      expect(await f.registry.revocationPending("pair-fresh", B)).toBe(true);
      await expect(f.registry.register(f.fresh, "approval-fresh", "b".repeat(64))).rejects.toThrow("revocation-pending");
      expect(await f.state.list()).toEqual(before); expect(f.queue.pairFence(B)).toEqual(f.fence);
    });

  it(`an outstanding predecessor obligation still blocks beside a completed receipt through ${backend}`, async () => {
    const f = await fixture(backend), record = JSON.parse(readFileSync(f.file, "utf8"));
    record.pair.pairId = "pair-older"; record.pair.edgeEpoch = "edge-older"; record.revocationEpoch = "edge-older";
    record.fenceId = OTHER_FENCE; record.unit.closedFenceId = OTHER_FENCE; record.cleanupReason = "intercom-revocation-cleanup-pending";
    record.resources = pairResources(record.pair, "core-older"); record.unit.name = "spider-pair-pair-older-connect.service";
    writeFileSync(join(f.root, "roam", "intercom", "enrollments", "pair-older.json"), JSON.stringify(record), { mode: 0o600 });
    const before = await f.state.list();
    expect(await f.registry.revocationPending("pair-fresh", B)).toBe(true);
    await expect(f.registry.register(f.fresh, "approval-fresh", "b".repeat(64))).rejects.toThrow("revocation-pending");
    expect(await f.registry.get("pair-fresh")).toBeNull(); expect(await f.state.list()).toEqual(before);
    expect(f.queue.pairFence(B)).toEqual(f.fence);
  });
}
