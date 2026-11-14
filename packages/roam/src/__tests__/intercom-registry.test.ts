import { paths } from "@spider/db-core";
import { hash } from "@spider/herdr/sessions/registry";
import { afterEach, expect, it } from "vitest";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openIntercomStore } from "../intercom-store";
import type { IntercomEnrollmentPair } from "../provision-contracts";
const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "pair-registry-")); roots.push(root);
  const peer = (machineId: string, alias: string) => ({ machineId, alias, node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot: "/fixture/global" });
  const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]);
  const pair: IntercomEnrollmentPair = { pairId: "pair-1", edgeEpoch: "edge-1", source: peer(A, "box-1.invalid"), target: peer(B, "box-2.invalid"),
    sshUser: "fixture", hostKey: { type: "ssh-ed25519", base64: blob.toString("base64") }, hostKeyAlias: `spider-${"a".repeat(32)}`,
    connector: { tunnelId: "tunnel", remotePort: 22, session: "default" } };
  const { sshUser: _user, hostKey: _key, hostKeyAlias: _alias, ...plan } = pair;
  return { root, pair, plan };
}
async function registry(root: string) {
  const api = await import("../intercom-registry").catch(() => ({})) as typeof import("../intercom-registry");
  expect(api.createIntercomRegistry).toBeTypeOf("function"); return api.createIntercomRegistry(root);
}

it("inspection of a missing registry is read-only", async () => {
  const f = fixture(), state = await registry(f.root);
  expect(await state.list()).toEqual([]); expect(await state.get("pair-1")).toBeNull();
  expect(existsSync(join(f.root, "roam"))).toBe(false);
}, 5000);

it("persists pair identities and a named cleanup obligation without changing other pairs", async () => {
  const f = fixture(), state = await registry(f.root), fenceId = "00000000-0000-4000-8000-000000000004";
  await state.register(f.plan, "approval-1", "a".repeat(64)); await state.bind(f.pair, "approval-1"); await state.activate("pair-1", "approval-1");
  await expect(state.bind(f.pair, "approval-1")).resolves.toBeUndefined();
  await state.beginRevocation("pair-1", fenceId); await state.finishRevocation("pair-1", "intercom-revocation-peer-unreachable");
  const reopened = await registry(f.root);
  expect(await reopened.get("pair-1")).toMatchObject({ pair: f.pair, state: "revoked", fenceId, cleanupReason: "intercom-revocation-peer-unreachable" });
  expect(await reopened.fences([f.plan])).toEqual({ "pair-1": fenceId });
  const file = join(f.root, "roam", "intercom", "enrollments", "pair-1.json"), before = readFileSync(file);
  await reopened.finishRevocation("pair-1", "intercom-revocation-peer-unreachable");
  expect(readFileSync(file)).toEqual(before); expect(lstatSync(file).mode & 0o777).toBe(0o600);
}, 5000);

it("local doctor reports persisted remote cleanup without changing the registry", async () => {
  const f = fixture(), state = await registry(f.root), fenceId = "00000000-0000-4000-8000-000000000004";
  await state.register(f.plan, "approval-1", "a".repeat(64)); await state.bind(f.pair, "approval-1"); await state.activate("pair-1", "approval-1");
  await state.beginRevocation("pair-1", fenceId); await state.finishRevocation("pair-1", "intercom-revocation-peer-unreachable");
  const file = join(f.root, "roam", "intercom", "enrollments", "pair-1.json"), before = readFileSync(file);
  const { runLocalDoctor } = await import("../local-diagnostics");
  const report = await runLocalDoctor({ root: f.root });
  expect(report.diagnostics).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("intercom-revocation-peer-unreachable") }));
  expect(report.diagnostics.find(item => item.reason.includes("intercom-revocation-peer-unreachable"))?.reason).toContain("pair-1");
  expect(readFileSync(file)).toEqual(before);
}, 5000);

it("requires a fresh operation and edge epoch before a revoked pair can be repinned", async () => {
  const f = fixture(), state = await registry(f.root), fenceId = "00000000-0000-4000-8000-000000000004";
  await state.register(f.plan, "approval-1", "a".repeat(64)); await state.bind(f.pair, "approval-1"); await state.activate("pair-1", "approval-1");
  await state.beginRevocation("pair-1", fenceId); await state.finishRevocation("pair-1", null);
  await expect(state.register(f.plan, "approval-1", "a".repeat(64))).rejects.toThrow("fresh-peer-consent-required");
  await expect(state.register(f.plan, "approval-2", "b".repeat(64))).rejects.toThrow("fresh-peer-consent-required");
  const next = { ...f.plan, edgeEpoch: "edge-2" };
  await state.register(next, "approval-2", "b".repeat(64));
  expect(await state.fences([next])).toEqual({ "pair-1": fenceId });
  await state.bind({ ...f.pair, edgeEpoch: "edge-2", hostKeyAlias: `spider-${"b".repeat(32)}` }, "approval-2");
  await state.activate("pair-1", "approval-2"); expect(await state.fences([next])).toEqual({ "pair-1": null });
}, 5000);

it.each(["intercom-revocation-unconfirmed", "intercom-revocation-cleanup-pending"] as const)("never replaces a pending revocation obligation %s", async reason => {
  const f = fixture(), state = await registry(f.root), fenceId = "00000000-0000-4000-8000-000000000004";
  await state.register(f.plan, "approval-1", "a".repeat(64)); await state.bind(f.pair, "approval-1"); await state.beginRevocation("pair-1", fenceId); await state.finishRevocation("pair-1", reason);
  const file = join(f.root, "roam", "intercom", "enrollments", "pair-1.json"), before = readFileSync(file);
  await expect(state.register({ ...f.plan, edgeEpoch: "edge-2" }, "approval-2", "b".repeat(64))).rejects.toThrow("revocation-pending");
  expect(readFileSync(file)).toEqual(before); expect(await state.get("pair-1")).toMatchObject({ state: "revoked", fenceId, cleanupReason: reason });
  await state.finishRevocation("pair-1", null); await state.register({ ...f.plan, edgeEpoch: "edge-2" }, "approval-2", "b".repeat(64));
  expect(await state.get("pair-1")).toMatchObject({ state: "pending", operationId: "approval-2", cleanupReason: null });
}, 5000);
it("rechecks the durable queue fence at the write boundary after a preflight-to-write crash", async () => {
  const f = fixture(), state = await registry(f.root); await state.register(f.plan, "approval-1", "a".repeat(64)); await state.bind(f.pair, "approval-1");
  const queue = openIntercomStore({ file: join(f.root, "roam", "intercom", "queue.db"), machineId: A, clock: { now: () => 1000 } });
  try {
    expect(await state.revocationPending("pair-1")).toBe(false);
    const fence = queue.fencePair(B, "edge-1").fence, file = join(f.root, "roam", "intercom", "enrollments", "pair-1.json"), before = readFileSync(file);
    const reopened = await registry(f.root);
    await expect(reopened.register(f.plan, "approval-1", "a".repeat(64))).rejects.toThrow("revocation-pending");
    expect(readFileSync(file)).toEqual(before); expect(queue.pairFence(B)?.fenceId).toBe(fence.fenceId); expect(await reopened.revocationPending("pair-1")).toBe(true);
  } finally { queue.close(); }
}, 5000);

it("enroll and revoke racing on the same peer finish without deadlock or a fence-to-write gap", async () => {
  const f = fixture(), state = await registry(f.root), { withIntercomPeerLock } = await import("../intercom-registry");
  const queue = openIntercomStore({ file: join(f.root, "roam", "intercom", "queue.db"), machineId: A, clock: { now: () => 1000 } });
  const events: string[] = []; let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const enroll = withIntercomPeerLock(f.root, A, B, async () => { await state.register(f.plan, "approval-1", "a".repeat(64)); await state.bind(f.pair, "approval-1"); events.push("enrolled"); entered(); await gate; });
  await ready;
  const revoke = withIntercomPeerLock(f.root, B, A, async () => { events.push("revoking"); const { fence } = queue.fencePair(B, "edge-1"); await state.beginRevocation("pair-1", fence.fenceId); });
  try { expect(events).toEqual(["enrolled"]); expect(queue.pairFence(B)).toBeNull(); }
  finally { release(); await Promise.all([enroll, revoke]); }
  try {
    expect(events).toEqual(["enrolled", "revoking"]); expect(await state.revocationPending("pair-1")).toBe(true);
    await expect(state.register(f.plan, "approval-1", "a".repeat(64))).rejects.toThrow("revocation-pending");
  } finally { queue.close(); }
}, 5000);

it("the peer lock reclaims a predecessor ticket after its PID is reused", async () => {
  const f = fixture(), { withIntercomPeerLock } = await import("../intercom-registry");
  await withIntercomPeerLock(f.root, A, B, async () => {});
  const directory = join(f.root, "roam", "intercom", "locks", hash(`intercom-peer:${A}:${B}`)), ticket = join(directory, "predecessor.json");
  writeFileSync(ticket, JSON.stringify({ version: 1, pid: process.pid, startIdentity: "old-generation", number: 1 }), { mode: 0o600 });
  let ran = false;
  await expect(withIntercomPeerLock(f.root, B, A, async () => { ran = true; })).resolves.toBeUndefined();
  expect(ran).toBe(true); expect(existsSync(ticket)).toBe(false);
}, 5000);

it("an older revoked record never overrides a newer fence", async () => {
  const f = fixture(), state = await registry(f.root), old = "00000000-0000-4000-8000-000000000004";
  await state.register(f.plan, "approval-1", "a".repeat(64)); await state.bind(f.pair, "approval-1"); await state.beginRevocation("pair-1", old); await state.finishRevocation("pair-1", null);
  const queue = openIntercomStore({ file: join(f.root, "roam", "intercom", "queue.db"), machineId: A, clock: { now: () => 1000 } });
  try {
    const fence = queue.fencePair(B, "edge-2").fence, file = join(f.root, "roam", "intercom", "enrollments", "pair-1.json"), before = readFileSync(file);
    expect(await state.revocationPending("pair-1")).toBe(true);
    await expect(state.register({ ...f.plan, edgeEpoch: "edge-3" }, "approval-3", "c".repeat(64))).rejects.toThrow("revocation-pending");
    expect(readFileSync(file)).toEqual(before); expect(queue.pairFence(B)).toEqual(fence);
  } finally { queue.close(); }
}, 5000);

it("a fence without a registry record blocks a different enrollment epoch", async () => {
  const f = fixture(), state = await registry(f.root), queue = openIntercomStore({ file: join(f.root, "roam", "intercom", "queue.db"), machineId: A, clock: { now: () => 1000 } });
  try {
    const fence = queue.fencePair(B, "edge-1").fence;
    await expect(state.register({ ...f.plan, edgeEpoch: "edge-2" }, "approval-2", "b".repeat(64))).rejects.toThrow("revocation-pending");
    expect(await state.get("pair-1")).toBeNull(); expect(queue.pairFence(B)).toEqual(fence);
  } finally { queue.close(); }
}, 5000);

it("refuses a symlinked registry record without changing its target", async () => {
  const f = fixture(), state = await registry(f.root); await state.register(f.plan, "approval-1", "a".repeat(64));
  const file = join(f.root, "roam", "intercom", "enrollments", "pair-1.json"), target = join(f.root, "unrelated");
  writeFileSync(target, "untouched", { mode: 0o600 }); rmSync(file); symlinkSync(target, file);
  await expect(state.get("pair-1")).rejects.toThrow();
  await expect(state.register(f.plan, "approval-1", "a".repeat(64))).rejects.toThrow();
  expect(readFileSync(target, "utf8")).toBe("untouched");
}, 5000);
