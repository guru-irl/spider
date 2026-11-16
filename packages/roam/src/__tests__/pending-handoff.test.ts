import { afterEach, expect, it } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { claimIdLock, inspectIdLock } from "@spider/herdr/sessions/id-lock";
import { createSessionLeases, type ProcessInventoryPorts } from "@spider/herdr/sessions/lease";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { writeLaunchHandoff } from "@spider/herdr/sessions/launch-handoff";
import { openFreezeJournal } from "../journal";
import { createBothLocks, createRunningIntentAuthority } from "../session-control";
import { createPendingHandoffControl, pendingHandoffLifecycle, cancelPendingHandoff, type MoveNoStartReceipt } from "../pending-handoff";
const MACHINE = "00000000-0000-4000-8000-000000000001";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
async function fixture() {
  const fixture = createReplica("global", MACHINE); fixtures.push(fixture);
  const root = join(fixture.root, "herdr"), file = join(fixture.root, "session.jsonl"); writeFileSync(file, "fixture\n");
  const identity = { pid: 42, startIdentity: "supervisor-start" }, journal = openFreezeJournal(join(fixture.root, "roam", "journal.db"));
  const inventory: ProcessInventoryPorts = { leases: createSessionLeases(root), presence: createProcessPresence(root), processes: async () => [], probe: async () => ({ kind: "live", startIdentity: identity.startIdentity }) };
  const id = await claimIdLock(root, "session-a", identity, inventory.probe, { bootId: async () => "boot-a" });
  const lease = await inventory.leases.claim(file, identity, inventory, { mode: "cutover", bootId: "boot-a" });
  const handoff = await id.prepareHandoff("launch-a", file, "core-a");
  await writeLaunchHandoff(root, { version: 1, operationId: "launch-a", sessionId: "session-a", sessionFile: file, nonce: handoff.nonce, leaseToken: lease.token });
  const authority = createRunningIntentAuthority(fixture.db);
  await authority.set({ sessionId: "session-a", epoch: 2, file, cwd: fixture.root, desired: "running", suspended: null, moveId: "move-a" }, "participant-a");
  const receipt: MoveNoStartReceipt = { moveId: "move-a", launchId: "launch-a", sessionId: "session-a", epoch: 2, coreId: "core-a", bootId: "boot-a", launchDigest: "fixture-digest",
    evidence: { receipt: "unknown", terminal: "unknown", proof: { kind: "prelaunch-error", operationId: "launch-a", beforeLaunch: true, errorCode: "missing-hc", hcPid: null } } };
  journal.begin({ id: "move-a", machineId: MACHINE, expectedEpoch: 1, kind: "move", args: {} });
  journal.begin({ id: "launch-a", machineId: MACHINE, expectedEpoch: 2, kind: "exact-session-launch", args: {} });
  journal.record("move-a", "move-no-start", receipt as never);
  const control = createPendingHandoffControl({ root, journal, authority, inventory, identity, bootId: async () => "boot-a", launchDigest: () => "fixture-digest" });
  const request = { sessionId: "session-a", moveId: "move-a", launchId: "launch-a", noStartReceipt: receipt };
  return { ...fixture, root, file, journal, inventory, identity, authority, receipt, request, control };
}
it.each(["missing", "move", "launch", "session", "epoch", "core", "boot", "proof", "digest", "owner", "readiness", "receipt-match"])("mismatched %s handoff cancellation refuses without effects", async bad => {
  const f = await fixture(), before = await inspectIdLock(f.root, "session-a"), lease = await f.inventory.leases.get(f.file);
  if (bad === "missing") f.request.noStartReceipt = null as never;
  if (bad === "move") f.request.moveId = "other-move";
  if (bad === "launch") f.request.launchId = "other-launch";
  if (bad === "session") f.request.sessionId = "other-session";
  if (bad === "epoch") f.request.noStartReceipt = { ...f.receipt, epoch: 3 };
  if (bad === "core") f.request.noStartReceipt = { ...f.receipt, coreId: "other-core" };
  if (bad === "boot") f.request.noStartReceipt = { ...f.receipt, bootId: "other-boot" };
  if (bad === "proof") f.request.noStartReceipt = { ...f.receipt, evidence: { receipt: "unknown", terminal: "unknown" } };
  if (bad === "digest") f.request.noStartReceipt = { ...f.receipt, launchDigest: "other-digest" };
  if (bad === "owner") f.identity.pid = 43;
  if (bad === "readiness") f.journal.record("launch-a", "ready-durable", { sessionId: "session-a" });
  if (bad === "receipt-match") f.request.noStartReceipt = { ...f.receipt, evidence: { receipt: "unknown", terminal: "unknown", proof: { kind: "prelaunch-error", operationId: "launch-a", beforeLaunch: true, errorCode: "spawn-error", hcPid: null } } };
  expect(await f.control.cancelPendingHandoff(f.request)).toBe("refused");
  expect(await inspectIdLock(f.root, "session-a")).toEqual(before);
  expect(await f.inventory.leases.get(f.file)).toEqual(lease);
  expect((await f.authority.get("session-a"))?.desired).toBe("running");
});
it("the owning supervisor releases normally, repeats already-released and permits createBothLocks", async () => {
  const f = await fixture();
  expect(await f.control.cancelPendingHandoff(f.request)).toBe("released");
  expect(await f.control.cancelPendingHandoff(f.request)).toBe("already-released");
  expect(await inspectIdLock(f.root, "session-a")).toBeNull();
  expect(await f.inventory.leases.get(f.file)).toBeNull();
  expect((await f.authority.get("session-a"))?.desired).toBe("stopped");
  const both = createBothLocks({ root: f.root, inventory: f.inventory, identity: f.identity, file: async () => f.file, bootId: async () => "boot-a" });
  let entered = false; await both("session-a", async () => { entered = true; }); expect(entered).toBe(true);
});

it("the private typed port reaches the owning supervisor and repeats idempotently", async () => {
  const f = await fixture(), socketRoot = join(process.cwd(), ".spider/scratch", `ph-${randomUUID().slice(0, 8)}`);
  const lifecycle = pendingHandoffLifecycle(socketRoot, f.control);
  try {
    await lifecycle.start();
    expect(await cancelPendingHandoff(socketRoot, { ...f.request, launchId: "wrong-launch" })).toBe("refused");
    expect((await f.authority.get("session-a"))?.desired).toBe("running");
    expect(await cancelPendingHandoff(socketRoot, f.request)).toBe("released");
    expect(await cancelPendingHandoff(socketRoot, f.request)).toBe("already-released");
  } finally { await lifecycle.stop(); rmSync(socketRoot, { recursive: true, force: true }); }
});

it("pending cancellation retries after the lease release succeeded but its reply was lost", async () => {
  const f = await fixture(), release = f.inventory.leases.release.bind(f.inventory.leases);
  let first = true;
  f.inventory.leases.release = async (...args) => { await release(...args); if (first) { first = false; throw new Error("lost release reply"); } };
  expect(await f.control.cancelPendingHandoff(f.request)).toBe("refused");
  expect(await f.inventory.leases.get(f.file)).toBeNull();
  expect(await f.control.cancelPendingHandoff(f.request)).toBe("released");
  expect(await inspectIdLock(f.root, "session-a")).toBeNull();
  expect(await f.control.cancelPendingHandoff(f.request)).toBe("already-released");
}, 5000);
it.each(["lease-released", "handoff-removed", "lock-cancelled"])("pending cancellation resumes after a crash before recording %s", async checkpoint => {
  const f = await fixture(), record = f.journal.record;
  let first = true;
  f.journal.record = (id, action, result) => { if (first && action === checkpoint) { first = false; throw new Error("crash"); } return record(id, action, result); };
  expect(await f.control.cancelPendingHandoff(f.request)).toBe("refused");
  expect(await f.control.cancelPendingHandoff(f.request)).toBe("released");
  expect(await inspectIdLock(f.root, "session-a")).toBeNull();
  expect(await f.inventory.leases.get(f.file)).toBeNull();
}, 5000);
it("a restarted supervisor resumes a begun cancellation through normal stale-owner lock APIs", async () => {
  const f = await fixture(), release = f.inventory.leases.release.bind(f.inventory.leases);
  f.inventory.leases.release = async (...args) => { await release(...args); throw new Error("crash"); };
  expect(await f.control.cancelPendingHandoff(f.request)).toBe("refused");
  f.inventory.leases.release = release;
  f.inventory.probe = async pid => pid === 43 ? { kind: "live", startIdentity: "restarted" } : { kind: "absent" };
  const restarted = createPendingHandoffControl({ root: f.root, journal: f.journal, authority: f.authority, inventory: f.inventory,
    identity: { pid: 43, startIdentity: "restarted" }, bootId: async () => "boot-a", launchDigest: () => "fixture-digest" });
  expect(await restarted.cancelPendingHandoff(f.request)).toBe("released");
  expect(await inspectIdLock(f.root, "session-a")).toBeNull();
}, 5000);
it("a different pending launch cannot be cancelled even with another durable valid receipt", async () => {
  const f = await fixture();
  const pending = await import("@spider/herdr/sessions/launch-handoff").then(module => module.readLaunchHandoff(f.root, module.launchHandoffPath(f.root, "launch-a"), "session-a", f.file));
  await writeLaunchHandoff(f.root, { ...pending, operationId: "launch-b" });
  const receipt: MoveNoStartReceipt = { ...f.receipt, launchId: "launch-b", evidence: { ...f.receipt.evidence, proof: { kind: "prelaunch-error" as const, operationId: "launch-b", beforeLaunch: true as const, errorCode: "missing-hc", hcPid: null } } };
  const read = f.journal.read;
  f.journal.read = id => id === "move-a" ? read(id).map(row => row.action === "move-no-start" ? { ...row, result: receipt as never } : row) : read(id);
  expect(await f.control.cancelPendingHandoff({ ...f.request, launchId: "launch-b", noStartReceipt: receipt })).toBe("refused");
  expect((await f.authority.get("session-a"))?.desired).toBe("running");
  expect((await inspectIdLock(f.root, "session-a"))?.pendingOperationId).toBe("launch-a");
}, 5000);
