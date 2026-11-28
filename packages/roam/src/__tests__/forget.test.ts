// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { openDb } from "@spider/db-core";
import type { Home } from "@spider/db-core/roam/types";
import { readLocal } from "@spider/db-core/roam/local-state";
import { join } from "node:path";
import * as forget from "../forget";
import { createMoveControlHandler } from "../adapter-controls";
import { recordLocation } from "@spider/db-core/roam/catalog";
import type { Operation, Transport } from "../contracts";
import * as revocation from "../revocation";
import * as supervisor from "../supervisor";
import * as recovery from "../move-recovery";
import { assignInitialHome, casHome, sessionHome } from "../homes";
import { appendMirror } from "../mirrors";
import { openJournal } from "../journal";
import { inspectSession } from "../session-file";
import { BOX, HUB, OTHER, recoveryFixture } from "./recovery-fixture";
const cleanups: (() => void)[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const close of cleanups.splice(0)) close(); });
async function fixture() { const f = await recoveryFixture(); cleanups.push(f.close); return f; }
const run = (f: Awaited<ReturnType<typeof fixture>>, confirmation = `destroyed ${BOX}`) => forget.forgetMachine({ machineId: BOX, confirmation }, f.ports);

it("forget requires typed destroyed-machine confirmation", async () => {
  const f = await fixture();
  for (const confirmation of ["yes", BOX, `destroyed ${OTHER}`, `destroyed ${BOX} `]) {
    expect((await run(f, confirmation)).code).toBe(2);
    expect(sessionHome(f.global.db, "session-a")).toEqual(f.oldHome);
    expect(f.events).toEqual([]);
  }
  expect(forget.destroyedMachineWarning(BOX)).toContain(BOX);
  expect(forget.destroyedMachineWarning(BOX)).toContain("two copies");
  expect(forget.destroyedMachineWarning(BOX)).toContain("last mirror");
  expect(forget.destroyedMachineWarning(BOX)).toContain("workspace edits");
}, 5000);

it("revocation survives hub restart and refuses sync forever", async () => {
  const f = await fixture(); expect((await run(f)).code).toBe(0);
  const restarted = openDb(join(f.root, "journal.db"));
  try {
    const handshakeAfterRestart = revocation.syncHandshake(restarted, BOX);
    expect(handshakeAfterRestart.reason).toBe("machine-revoked");
    expect(handshakeAfterRestart).toEqual({ kind: "retire-only", reason: "machine-revoked", machineId: BOX });
    expect(revocation.isRevoked(restarted, BOX)).toBe(true);
    expect(revocation.syncHandshake(restarted, OTHER).kind).toBe("accepted");
    expect((await run(f)).value).toEqual([sessionHome(f.global.db, "session-a")]);
    expect(f.events.filter(x => x === "restore")).toHaveLength(1);
  } finally { restarted.close(); }
}, 5000);

it("reconnecting revoked supervisor stops before sync", async () => {
  const f = await fixture(); await run(f);
  const actionsAfterRevokedReply: string[] = [];
  await supervisor.reconnectSupervisor(revocation.syncHandshake(f.revocationDb, BOX), {
    machineId: BOX, stopSessions: async () => { actionsAfterRevokedReply.push("stop-sessions"); },
    sync: async () => { actionsAfterRevokedReply.push("sync"); },
  });
  expect(actionsAfterRevokedReply).toEqual(["stop-sessions"]);
}, 5000);

it("restore uses last mirrored prefix at higher epoch", async () => {
  const f = await fixture(), oldHome = f.oldHome!, lastMirrorDigest = f.mirror.historySha256;
  appendFileSync(f.file, JSON.stringify({ type: "message", id: "unsent", parentId: "leaf-a", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "post mirror", timestamp: 2 } }) + "\n");
  const outcome = await run(f), restoredHome = outcome.value![0];
  expect(outcome.code).toBe(0);
  expect(restoredHome.epoch).toBe(oldHome.epoch + 1);
  expect(restoredHome.machineId).toBe(HUB);
  const restoredHistoryDigest = createHash("sha256").update(f.bytes().split("\n").slice(1, -2).join("\n") + "\n").digest("hex");
  expect(restoredHistoryDigest).toBe(lastMirrorDigest);
  expect(f.bytes()).not.toContain("unsent");
  expect(f.bytes()).toContain("spider-roam-segment");
  expect(f.events).toEqual(["mirror", "replicate-home", "restore", "present"]);
}, 5000);

it("missing mirror or invalid workspace prevents hosting", async () => {
  const missing = await fixture(); missing.ports.recovery.mirror = async () => null;
  expect((await run(missing)).reason).toBe("recovery-mirror-missing");
  expect(sessionHome(missing.global.db, "session-a")).toEqual(missing.oldHome);
  expect(missing.events).toEqual([]);
  const invalid = await fixture();
  invalid.ports.recovery.restore = async (home, _mirror, operation) => ({ code: 1, reason: "workspace-invalid", operationId: operation.id, home, epoch: home.epoch, value: null, repairCommand: null });
  expect((await run(invalid)).reason).toBe("workspace-invalid");
  expect(invalid.targets).toEqual([]);
}, 5000);

it("revocation persistence failure precedes home changes", async () => {
  const f = await fixture(); f.revocationDb.pragma("query_only = ON");
  expect((await run(f)).reason).toBe("revocation-persistence-failed");
  expect(sessionHome(f.global.db, "session-a")).toEqual(f.oldHome);
  expect(f.events).toEqual([]);
}, 5000);

it("durable revocation precedes mirror validation and restore", async () => {
  const f = await fixture(), mirror = f.ports.recovery.mirror;
  f.ports.recovery.mirror = async (id, epoch) => { expect(revocation.isRevoked(f.revocationDb, BOX)).toBe(true); return mirror(id, epoch); };
  expect((await run(f)).code).toBe(0);
}, 5000);

it("invalid mirror bytes refuse restoration", async () => {
  const f = await fixture(); chmodSync(f.mirror.file, 0o600); appendFileSync(f.mirror.file, "broken\n");
  f.ports.recovery.mirror = async () => f.mirror;
  expect((await run(f)).reason).toBe("recovery-mirror-invalid");
  expect(sessionHome(f.global.db, "session-a")).toEqual(f.oldHome);
  expect(f.targets).toEqual([]);
}, 5000);

it("forget reconciles interrupted moves against new homes", async () => {
  const f = await fixture();
  f.journal.begin({ id: "move-a", kind: "move", machineId: HUB, expectedEpoch: 1, args: { sessionId: "session-a", destinationMachine: OTHER } });
  f.journal.record("move-a", "move-request", { sessionId: "session-a", destinationMachine: OTHER, operation: { id: "move-a", kind: "move", machineId: HUB, expectedEpoch: 1, args: { sessionId: "session-a", destinationMachine: OTHER } } });
  f.journal.record("move-a", "move-action-complete", JSON.parse(JSON.stringify({ action: "check", value: { source: f.oldHome } })));
  await run(f);
  const result = await recovery.recoverMove("move-a", f.ports);
  expect(result.code).toBe(0);
  expect(result.reason).toBe("destroyed-machine-recovered");
  expect(result.home).toEqual(sessionHome(f.global.db, "session-a"));
  expect(f.events.filter(x => x === "restore")).toHaveLength(1);
}, 5000);

it("restored home retains Mac slot and visible intent", async () => {
  const f = await fixture(), slot = { space: "usual-space", tab: "usual-tab" };
  let presentation = { slot, visibility: "visible", mode: "proxy" };
  f.ports.recovery.presentReadyTarget = async target => { f.targets.push(target); presentation = { ...presentation, mode: "native" }; return { status: "complete", reason: "presented", presentation }; };
  expect((await run(f)).code).toBe(0);
  expect(presentation).toEqual({ slot, visibility: "visible", mode: "native" });
  expect(f.targets[0]).toMatchObject({ machineId: HUB, alias: null, sessionId: "session-a", homeEpoch: 2, coreId: "fixture-core", terminalId: "fixture-terminal" });
}, 5000);

it("parked revoked home remains parked", async () => {
  const f = await fixture(); const parked = { slot: { space: "usual-space", tab: "usual-tab" }, visibility: "parked" };
  f.ports.recovery.presentReadyTarget = async target => { f.targets.push(target); return { status: "complete", reason: "parked", presentation: parked }; };
  expect((await run(f)).code).toBe(0);
  expect(f.targets).toHaveLength(1);
  expect(parked.visibility).toBe("parked");
}, 5000);

it("reused alias cannot capture a presentation or close its restored target", async () => {
  const f = await fixture(); await run(f);
  f.ports.config.peers = [{ ...f.ports.config.peers[0], machineId: OTHER }];
  expect(revocation.syncHandshake(f.revocationDb, BOX).kind).toBe("retire-only");
  expect(revocation.syncHandshake(f.revocationDb, OTHER).kind).toBe("accepted");
  expect(f.targets).toHaveLength(1);
  expect(f.targets[0].machineId).toBe(HUB);
  expect(f.targets[0].alias).toBeNull();
  expect(f.targets[0].homeEpoch).toBe(2);
}, 5000);

it("accepted supervisor reconnect performs sync", async () => {
  const actions: string[] = [];
  expect(await supervisor.reconnectSupervisor({ kind: "accepted", reason: "ok", machineId: BOX }, {
    machineId: BOX, stopSessions: async () => { actions.push("stop-sessions"); }, sync: async () => { actions.push("sync"); },
  })).toBe(true);
  expect(actions).toEqual(["sync"]);
}, 5000);

it("revoked supervisor retries failed retirement without syncing", async () => {
  const actions: string[] = [];
  await expect(supervisor.reconnectSupervisor({ kind: "retire-only", reason: "machine-revoked", machineId: BOX }, {
    machineId: BOX, stopSessions: async () => { actions.push("stop-sessions"); throw new Error("retirement pending"); }, sync: async () => { actions.push("sync"); },
  })).rejects.toThrow("retirement pending");
  expect(actions).toEqual(["stop-sessions"]);
}, 5000);

it("malformed restored readiness never invokes presentation", async () => {
  const f = await fixture(), restore = f.ports.recovery.restore;
  f.ports.recovery.restore = async (...args) => { const result = await restore(...args); return { ...result, value: { ...result.value!, epoch: 1 } }; };
  expect((await run(f)).reason).toBe("recovery-readiness-invalid");
  expect(f.targets).toEqual([]);
}, 5000);

it("interrupted restore resumes at next recovery start without another home CAS", async () => {
  const f = await fixture(), restore = f.ports.recovery.restore;
  f.ports.recovery.restore = async () => { throw new Error("interrupted restore"); };
  expect((await run(f)).code).toBe(3);
  const home = sessionHome(f.global.db, "session-a");
  f.ports.recovery.restore = restore;
  expect((await forget.recoverForgottenMachines([BOX], f.ports))[0].code).toBe(0);
  expect(sessionHome(f.global.db, "session-a")).toEqual(home);
  expect(f.targets).toHaveLength(1);
}, 5000);

it.each(["nextMachine", "previousMachine", "epoch", "moveId", "history"])("restored session rejects incorrect %s evidence before presentation", async field => {
  const f = await fixture(), restore = f.ports.recovery.restore;
  f.ports.recovery.restore = async (...args) => {
    const result = await restore(...args), file = result.value!.file;
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    if (field === "history") { const history = JSON.parse(lines[1]); history.message.content = "changed history"; lines[1] = JSON.stringify(history); }
    else { const marker = JSON.parse(lines[lines.length - 1]); marker.data[field] = field === "epoch" ? 3 : field === "moveId" ? "wrong-operation" : OTHER; lines[lines.length - 1] = JSON.stringify(marker); }
    writeFileSync(file, lines.join("\n") + "\n");
    return result;
  };
  expect((await run(f)).reason).toBe("recovery-readiness-invalid");
  expect(f.targets).toEqual([]);
}, 5000);

it("pending presentation retries without another restore or home increment", async () => {
  const f = await fixture();
  let calls = 0;
  f.ports.recovery.presentReadyTarget = async target => { f.targets.push(target); return { status: ++calls === 1 ? "pending" : "complete", reason: "presentation", presentation: null }; };
  expect(await run(f)).toMatchObject({ code: 0, results: [{ presentation: "pending" }] });
  const home = sessionHome(f.global.db, "session-a");
  expect((await run(f)).code).toBe(0);
  expect(sessionHome(f.global.db, "session-a")).toEqual(home);
  expect(f.events.filter(x => x === "restore")).toHaveLength(1);
  expect(f.targets[0]).toEqual(f.targets[1]);
}, 5000);

it("revocation cannot be stored in a portable descriptor database", async () => {
  const f = await fixture();
  expect(() => revocation.revokeMachine(f.global.db, BOX)).toThrow("private hub journal");
  expect(f.global.db.prepare("SELECT name FROM sqlite_master WHERE name='roam_machine_revocations'").all()).toEqual([]);
}, 5000);

it("later moves from a restored home are not superseded by old forget receipts", async () => {
  const f = await fixture(); await run(f);
  f.journal.begin({ id: "later-move", kind: "move", machineId: HUB, expectedEpoch: 2, args: { sessionId: "session-a", destinationMachine: OTHER } });
  f.journal.record("later-move", "move-request", { sessionId: "session-a", destinationMachine: OTHER, operation: { id: "later-move", kind: "move", machineId: HUB, expectedEpoch: 2, args: { sessionId: "session-a", destinationMachine: OTHER } } });
  const result = await recovery.recoverMove("later-move", f.ports);
  expect(result.code).not.toBe(0);
  expect(result.reason).not.toBe("destroyed-machine-recovered");
}, 5000);

it("completed recovery receipts survive pruning without leaving pending operations", async () => {
  const f = await fixture(); expect((await run(f)).code).toBe(0);
  const home = sessionHome(f.global.db, "session-a");
  if (!home || home === "unknown" || !home.moveId) throw new Error("missing restored home");
  expect(f.journal.lookupOperation(home.moveId)?.state).toBe("done");
  f.journal.prune(Date.now() + 8 * 24 * 60 * 60 * 1000, 1);
  const restarted = openJournal(join(f.root, "journal.db"));
  const next = await forget.forgetMachine({ machineId: BOX, confirmation: `destroyed ${BOX}` }, { ...f.ports, journal: restarted });
  expect(next.value).toEqual([home]);
  expect(f.events.filter(x => x === "restore")).toHaveLength(1);
  expect(revocation.syncHandshake(f.revocationDb, BOX).reason).toBe("machine-revoked");
}, 5000);

it("malformed reconnect replies grant neither sync nor hosting", async () => {
  const actions: string[] = [];
  await expect(supervisor.reconnectSupervisor({ kind: "unexpected", reason: "ok", machineId: BOX } as unknown as revocation.SyncHandshake, {
    machineId: BOX, stopSessions: async () => { actions.push("stop-sessions"); }, sync: async () => { actions.push("sync"); },
  })).rejects.toThrow("Invalid sync handshake");
  expect(actions).toEqual([]);
}, 5000);

it("unreadable revocation evidence returns an outcome rather than escaping", async () => {
  const f = await fixture(); f.ports.config.peers = [];
  f.revocationDb.close();
  await expect(run(f)).resolves.toMatchObject({ code: 3, reason: "revocation-evidence-unavailable" });
}, 5000);

it("reused aliases cannot admit a reconnect reply for a different enrolled UUID", async () => {
  const actions: string[] = [];
  await expect(supervisor.reconnectSupervisor({ kind: "accepted", reason: "ok", machineId: OTHER }, {
    machineId: BOX, stopSessions: async () => { actions.push("stop-sessions"); }, sync: async () => { actions.push("sync"); },
  })).rejects.toThrow("Invalid sync handshake");
  expect(actions).toEqual([]);
}, 5000);

it("restored readiness accepts Pi metadata appended after its recovery marker", async () => {
  const f = await fixture(), restore = f.ports.recovery.restore;
  f.ports.recovery.restore = async (...args) => {
    const result = await restore(...args);
    appendFileSync(result.value!.file, JSON.stringify({ type: "thinking_level_change", id: "metadata", parentId: f.restored()!.leaf, timestamp: "2026-01-01T00:00:00Z", thinkingLevel: "off" }) + "\n");
    return result;
  };
  expect((await run(f)).code).toBe(0);
  expect(f.targets).toHaveLength(1);
  const lines = f.bytes().trimEnd().split("\n"), markerIndex = lines.findIndex(line => JSON.parse(line).customType === "spider-roam-segment");
  const digest = createHash("sha256").update(lines.slice(1, markerIndex).join("\n") + "\n").digest("hex");
  expect(digest).toBe(f.mirror.historySha256);
}, 5000);

it("a completed presentation replay is a no-op without a second presentation or journal error", async () => {
  const f = await fixture();
  f.ports.recovery.presentReadyTarget = async target => { f.targets.push(target); return { status: "pending", reason: "app-absent", presentation: null }; };
  expect(await run(f)).toMatchObject({ code: 0, results: [{ presentation: "pending" }] });
  const home = sessionHome(f.global.db, "session-a") as Home, receipt = f.journal.read(home.moveId!);
  expect(f.journal.lookupOperation?.(home.moveId!)?.state).toBe("done");
  let errors = 0;
  const record = f.journal.record;
  f.journal.record = (...args) => { try { record(...args); } catch (error) { errors++; throw error; } };
  f.ports.recovery.presentReadyTarget = async target => { f.targets.push(target); return { status: "complete", reason: "presented", presentation: null }; };
  await expect(forget.replayForgottenPresentations(f.ports)).resolves.toBeUndefined();
  await expect(forget.replayForgottenPresentations(f.ports)).resolves.toBeUndefined();
  expect(f.targets).toHaveLength(2); expect(errors).toBe(0);
  expect(f.journal.read(home.moveId!)).toEqual(receipt);
  expect(await run(f)).toMatchObject({ code: 0, results: [{ presentation: "complete" }] });
  expect(f.targets).toHaveLength(2); expect(errors).toBe(0);
}, 5000);

it("pending presentation revalidates cached readiness before another target call", async () => {
  const f = await fixture();
  f.ports.recovery.presentReadyTarget = async target => { f.targets.push(target); return { status: "pending", reason: "waiting", presentation: null }; };
  expect(await run(f)).toMatchObject({ code: 0, results: [{ presentation: "pending" }] });
  const read = f.journal.read;
  f.journal.read = id => read(id).map(row => row.action === "forget-ready" ? { ...row, result: { ...row.result, ready: { ...(row.result.ready as object), epoch: 1 } } } : row);
  expect((await run(f)).code).toBe(0);
  expect(f.targets).toHaveLength(1);
  const home = sessionHome(f.global.db, "session-a") as Home;
  expect(readLocal(f.global.db, "recovery-diagnostic", home.moveId!)).toEqual({ reason: "recovery-readiness-invalid" });
  const rows = read(home.moveId!);
  await run(f);
  expect(readLocal(f.global.db, "recovery-diagnostic", home.moveId!)).toEqual({ reason: "recovery-readiness-invalid" });
  expect(read(home.moveId!)).toEqual(rows);
}, 5000);

async function twoHomes() {
  const f = await fixture(), cwd = f.source.cwd, file = join(f.root, "source-b.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "session-b", timestamp: "2026-01-01T00:00:00Z", cwd }) + "\n" +
    JSON.stringify({ type: "message", id: "leaf-b", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "other history", timestamp: 1 } }) + "\n", { mode: 0o600 });
  const source = await inspectSession(file, "session-b");
  f.journal.begin({ id: "mirror-b", kind: "sync", machineId: BOX, expectedEpoch: 1, args: {} });
  await appendMirror({ sessionId: "session-b", epoch: 1, source, root: f.mirrorRoot, operationId: "mirror-b" }, f.journal);
  f.journal.record("mirror-b", "done", {});
  assignInitialHome(f.global.db, "session-b", BOX, HUB);
  return f;
}
it("app absence never prevents restoring a later home", async () => {
  const f = await twoHomes();
  f.ports.recovery.presentReadyTarget = async target => { f.targets.push(target); return { status: "pending", reason: "app-absent", presentation: null }; };
  const outcome = await run(f);
  expect(outcome.code).toBe(0);
  expect(outcome.value?.map(home => home.sessionId)).toEqual(["session-a", "session-b"]);
  expect(["session-a", "session-b"].map(id => sessionHome(f.global.db, id))).toEqual([
    expect.objectContaining({ machineId: HUB, epoch: 2 }), expect.objectContaining({ machineId: HUB, epoch: 2 }),
  ]);
  expect(f.targets).toHaveLength(2);
}, 5000);
it.each(["mirror", "restore"])("a permanent %s refusal is per home and later homes still restore", async kind => {
  const f = await twoHomes(), mirror = f.ports.recovery.mirror, restore = f.ports.recovery.restore;
  if (kind === "mirror") f.ports.recovery.mirror = (id, epoch) => id === "session-a" ? Promise.resolve(null) : mirror(id, epoch);
  else f.ports.recovery.restore = (home, ...args) => home.sessionId === "session-a" ? Promise.resolve({ code: 1, reason: "workspace-invalid", operationId: args[1].id, home, epoch: home.epoch, value: null, repairCommand: null }) : restore(home, ...args);
  const outcome = await run(f);
  expect(outcome.code).toBe(1);
  expect(sessionHome(f.global.db, "session-b")).toMatchObject({ machineId: HUB, epoch: 2 });
  expect(outcome).toMatchObject({ results: [
    { sessionId: "session-a", code: 1, reason: kind === "mirror" ? "recovery-mirror-missing" : "workspace-invalid" },
    { sessionId: "session-b", code: 0, presentation: "complete" },
  ] });
}, 5000);
it("retry skips finished homes after a normal later move", async () => {
  const f = await twoHomes(), mirror = f.ports.recovery.mirror;
  f.ports.recovery.mirror = async (id, epoch) => { if (id === "session-b") throw new Error("offline"); return mirror(id, epoch); };
  expect((await run(f)).code).toBe(3);
  const restored = sessionHome(f.global.db, "session-a");
  if (!restored || restored === "unknown") throw new Error("restore missing");
  const later = casHome(f.global.db, restored, OTHER, "later-move", HUB);
  f.ports.recovery.mirror = async (id, epoch) => { if (id === "session-a") throw new Error("finished home must not read its mirror"); return mirror(id, epoch); };
  expect((await run(f)).code).toBe(0);
  expect(sessionHome(f.global.db, "session-a")).toEqual(later);
  expect(sessionHome(f.global.db, "session-b")).toMatchObject({ machineId: HUB, epoch: 2 });
}, 5000);
it.each(["recover", "cancel"])("%s reconciles a forgotten move with a null requested epoch", async method => {
  const f = await fixture();
  const operation = { id: "null-epoch-move", kind: "move", machineId: HUB, expectedEpoch: null, args: { sessionId: "session-a", destinationMachine: OTHER } };
  f.journal.begin(operation);
  f.journal.record(operation.id, "move-request", { sessionId: "session-a", destinationMachine: OTHER, operation });
  f.journal.record(operation.id, "move-action-complete", JSON.parse(JSON.stringify({ action: "check", value: { source: f.oldHome } })));
  await run(f);
  const outcome = await (method === "recover" ? recovery.recoverMove : recovery.cancelMove)(operation.id, f.ports);
  expect(outcome).toMatchObject({ code: 0, reason: "destroyed-machine-recovered", home: { machineId: HUB, epoch: 2 } });
}, 5000);

it("confirmed forget repairs homes while roaming is off without acquiring move power", async () => {
  const f = await fixture(); f.ports.config.enabled = false;
  f.ports.power = async () => { throw new Error("must not acquire move power"); };
  expect(await run(f)).toMatchObject({ code: 0, reason: "destroyed-machine-recovered" });
  expect(f.ports.config.enabled).toBe(false);
}, 5000);

it("a null-epoch move created by the private hub handler reconciles after forget", async () => {
  const f = await fixture();
  recordLocation(f.global.db, { sessionId: "session-a", file: f.file, cwd: f.source.cwd, stores: ["global"], home: f.oldHome });
  f.ports.check = async request => ({ source: f.oldHome!, destinationMachine: request.destinationMachine, repoKey: "fixture-repo", workspaceId: "fixture-workspace",
    sourceRoot: f.source.cwd, sourceFile: f.file, sourceCwd: f.source.cwd, destinationRoot: f.source.cwd, destinationCwd: f.source.cwd,
    storeKeys: ["global", "repo:fixture-repo", "worktree:fixture-repo:fixture-workspace"], warnings: [] });
  f.ports.seed = async () => { throw new Error("fixture disconnect after checked source"); };
  const control = createMoveControlHandler({ config: f.ports.config, globalDb: f.global.db, journal: f.journal, transport: {} as Transport, ports: f.ports });
  const result = await control({ op: "move", session: "session-a", machine: OTHER });
  expect(result.code).toBe(3); const operationId = result.operationId!;
  expect((f.journal.read(operationId).find(row => row.action === "move-request")?.result.operation as unknown as Operation).expectedEpoch).toBeNull();
  expect((await run(f)).code).toBe(0);
  expect(await control({ op: "recover", operationId })).toMatchObject({ code: 0, reason: "destroyed-machine-recovered", home: { machineId: HUB, epoch: 2 } });
}, 5000);
