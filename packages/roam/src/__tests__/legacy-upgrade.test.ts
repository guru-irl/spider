import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { migrate, openDb } from "@spider/db-core";
import { writeLocal } from "@spider/db-core/roam/local-state";
import { fenceReplicaForMapping } from "@spider/db-core/roam/apply";
import { claimIdLock, localBootId } from "@spider/herdr/sessions/id-lock";
import { createSessionLeases } from "@spider/herdr/sessions/lease";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { processStartIdentity } from "@spider/herdr/jobs/handoff";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../cli";
import { openFreezeJournal, openJournal } from "../journal";
import { createIntentStore } from "../intent";
import { parseDoctorReport } from "../remote-observations";
import * as snapshots from "../diagnostic-snapshot";
import { peerEnabledDiagnostics } from "../peer-enabled";
import { readLocalIdentity } from "../runtime";
import type { Peer, Transport } from "../contracts";

const roots: string[] = [];
const hub = "11111111-1111-4111-8111-111111111111";
const box = "22222222-2222-4222-8222-222222222222";
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "upgrade-"));
  roots.push(root);
  mkdirSync(join(root, "roam"), { mode: 0o700 });
  writeFileSync(join(root, "roam", "config.json"), JSON.stringify({ enabled: false, role: "hub", machineId: hub,
    hubMachineId: hub, coreUnit: "herdr-core.service" }), { mode: 0o600 });
  writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId: hub }), { mode: 0o600 });
  const db = openDb(join(root, "spider.db"));
  try { migrate(db, "global", { machineId: hub, globalRoot: root }); } finally { db.close(); }
  vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
  return { root, journal: openJournal(join(root, "roam", "journal.db")) };
}

function replica(root: string, key: string) {
  const directory = join(root, "roam", "stores");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${createHash("sha256").update(key).digest("hex")}.db`);
  const db = openDb(file);
  try {
    migrate(db, "worktree", { machineId: hub, globalRoot: root });
    db.prepare("UPDATE roam_meta SET store_key=? WHERE id=1").run(key);
  } finally { db.close(); }
  return file;
}

it("reports lost roaming identity as unverified even when a pending move is visible", async () => {
  const f = fixture();
  f.journal.begin({ id: "known-move", kind: "move", machineId: hub, expectedEpoch: 1, args: {} });
  rmSync(join(f.root, "roam", "config.json")); rmSync(join(f.root, "roam", "machine.json"));
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0])).toMatchObject({ reason: "legacy-upgrade-unverified", value: { enabled: null,
    diagnostics: [expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-unverified.*known-move/) })] } });
});

it("reports an inventory as unverified when its journal changes between snapshots", async () => {
  const f = fixture(), journalFile = join(f.root, "roam", "journal.db"), original = snapshots.openDiagnosticSnapshot;
  let changed = false;
  const spy = vi.spyOn(snapshots, "openDiagnosticSnapshot").mockImplementation(file => {
    const db = original(file);
    if (file === journalFile && !changed) {
      changed = true;
      f.journal.begin({ id: "concurrent-move", kind: "move", machineId: hub, expectedEpoch: 1, args: {} });
    }
    return db;
  });
  try {
    const io = { out: vi.fn(), err: vi.fn() };
    expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
    expect(changed).toBe(true);
    expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "block", reason: expect.stringMatching(/^legacy-upgrade-unverified/) }),
    ]));
  } finally { spy.mockRestore(); }
});

it("treats a null remote doctor enabled state as unavailable, not disabled", async () => {
  const f = fixture(), peer: Peer = { machineId: box, alias: "fixture-box", node: "/fixture/node", pi: "/fixture/pi",
    cli: "/fixture/spider", core: "/fixture/hc", globalRoot: "/fixture/global" };
  const value = { enabled: null, diagnostics: [], consumers: [] };
  expect(() => parseDoctorReport(value)).toThrow(/invalid remote doctor report/i);
  const transport = { async resolve() { return peer; }, async exec() {
    return Buffer.from(JSON.stringify({ version: 1, machineId: box, kind: "doctor", value }));
  } } as unknown as Transport;
  const findings = await peerEnabledDiagnostics({ ...readLocalIdentity(f.root), peers: [peer] }, transport);
  expect(findings).toEqual([expect.objectContaining({ severity: "warning", reason: `peer-enabled-unavailable:${box}` })]);
  expect(findings.some(row => row.reason.startsWith("peer-enabled-mismatch:"))).toBe(false);
});

it("disabled doctor reports the unfinished legacy move and source cleanup by operation ID", async () => {
  const f = fixture();
  f.journal.begin({ id: "legacy-move-1", machineId: hub, expectedEpoch: 1, kind: "move", args: { sessionId: "session-1" } });
  f.journal.record("legacy-move-1", "move-source-cleanup-pending", { sessionId: "session-1", sourceMachine: hub,
    sourceCleanup: { status: "pending", reason: "move-cleanup-pending", blockers: [] } });
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  const report = JSON.parse(io.out.mock.calls.at(-1)![0]);
  expect(report.value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-blocked.*legacy-move-1/) }),
  ]));
});

it.each(["move-session", "move-abort-cleanup", "exact-session-launch"] as const)(
  "doctor blocks an unfinished %s journal record as the only pending operation", async kind => {
    const f = fixture(), id = `${kind}-fixture`;
    if (kind === "move-session") {
      f.journal.begin({ id: "settled-move", kind: "move", machineId: hub, expectedEpoch: 1, args: {} });
      f.journal.record("settled-move", "done", { code: 0, reason: "moved", value: { sourceCleanup: { status: "done" } } });
    }
    f.journal.begin({ id, kind, machineId: hub, expectedEpoch: 1, args: { sessionId: "session-slot" } });
    if (kind === "move-session") f.journal.record(id, "reserved", { moveId: "settled-move", destinationMachine: hub });
    const io = { out: vi.fn(), err: vi.fn() };
    expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
    const report = JSON.parse(io.out.mock.calls.at(-1)![0]);
    expect(report.value.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "block", reason: expect.stringContaining(id) }),
    ]));
    expect(report.value.diagnostics.some((row: { reason: string }) => row.reason.startsWith("legacy-upgrade-blocked:"))).toBe(true);
  },
);

it("doctor blocks an uncommitted legacy home action even after the move receipt is terminal", async () => {
  const f = fixture();
  f.journal.begin({ id: "home-action-1", kind: "move", machineId: hub, expectedEpoch: 1, args: {} });
  f.journal.record("home-action-1", "done", { code: 1, reason: "move-preflight-refused" });
  const db = openDb(join(f.root, "spider.db"));
  try {
    db.prepare("INSERT INTO roam_home_actions(move_id,session_id,expected_epoch,args_digest) VALUES (?,?,1,?)")
      .run("home-action-1", "session-home", "a".repeat(64));
  } finally { db.close(); }
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-blocked.*home-action-1/) }),
  ]));
});

it("doctor blocks an unresolved legacy freeze roster even without a pending move", async () => {
  const f = fixture(), key = "worktree:fixture-repo:fixture-workspace";
  replica(f.root, key);
  const freeze = openFreezeJournal(join(f.root, "roam", "journal.db"));
  freeze.beginFreeze("session-freeze", "freeze-move-1", 1);
  freeze.bindFreezeRoster("session-freeze", "freeze-move-1", 1, ["global", key]);
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  const report = JSON.parse(io.out.mock.calls.at(-1)![0]);
  expect(report.value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-blocked.*session-freeze.*freeze-move-1/) }),
  ]));
});

it("doctor reports frozen worktree membership with a missing freeze record as unverified", async () => {
  const f = fixture(), checkout = join(f.root, "worktree"), projectDir = join(checkout, ".spider"), key = "worktree:fixture-repo:workspace-1";
  mkdirSync(projectDir, { recursive: true });
  const project = openDb(join(projectDir, "project.db"));
  try {
    migrate(project, "worktree", { machineId: hub, globalRoot: f.root });
    project.prepare("UPDATE roam_meta SET machine_id=?,store_key=? WHERE id=1").run(hub, key);
    project.prepare("INSERT INTO roam_sessions(session_id,epoch,state,move_id,freeze_seq) VALUES (?,1,'frozen',?,0)")
      .run("session-frozen", "lost-move-1");
  } finally { project.close(); }
  const global = openDb(join(f.root, "spider.db"));
  try { global.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES (?,?,?)").run("fixture-repo", "workspace-1", checkout); }
  finally { global.close(); }
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-unverified.*session-frozen.*worktree:fixture-repo:workspace-1/) }),
  ]));
});

it("does not block settled legacy receipts, released reservations, or stale map failure text", async () => {
  const f = fixture();
  f.journal.begin({ id: "settled-move", kind: "move", machineId: hub, expectedEpoch: 1, args: {} });
  f.journal.record("settled-move", "done", { code: 0, reason: "moved", value: { sourceCleanup: { status: "done" } } });
  f.journal.begin({ id: "settled-slot", kind: "move-session", machineId: hub, expectedEpoch: 1, args: { sessionId: "settled-session" } });
  f.journal.record("settled-slot", "reserved", { moveId: "settled-move", destinationMachine: box });
  f.journal.record("settled-slot", "released", { moveId: "settled-move" });
  const freeze = openFreezeJournal(join(f.root, "roam", "journal.db"));
  freeze.beginFreeze("settled-session", "settled-move", 1);
  freeze.bindFreezeRoster("settled-session", "settled-move", 1, ["global"]);
  freeze.advanceFreeze("settled-session", "settled-move", 1, "frozen");
  freeze.advanceFreeze("settled-session", "settled-move", 1, "complete");
  const db = openDb(join(f.root, "spider.db"));
  try { writeLocal(db, "mapping-failure", "stale", "legacy map failed long ago"); } finally { db.close(); }
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(0);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "info", reason: expect.stringMatching(/^legacy-upgrade-ready/) }),
  ]));
});

it("does not block frozen membership governed by a settled v0 home", async () => {
  const f = fixture(), checkout = join(f.root, "worktree"), projectDir = join(checkout, ".spider"), key = "worktree:fixture-repo:workspace-1";
  mkdirSync(projectDir, { recursive: true });
  const project = openDb(join(projectDir, "project.db"));
  try {
    migrate(project, "worktree", { machineId: hub, globalRoot: f.root });
    project.prepare("UPDATE roam_meta SET machine_id=?,store_key=? WHERE id=1").run(hub, key);
    project.prepare("INSERT INTO roam_sessions(session_id,epoch,state,move_id,freeze_seq) VALUES (?,1,'frozen',?,0)")
      .run("session-v0-frozen", "old-settled-move");
  } finally { project.close(); }
  const global = openDb(join(f.root, "spider.db"));
  try {
    global.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES (?,?,?)").run("fixture-repo", "workspace-1", checkout);
    global.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?,?,2,?,1,'running',NULL)")
      .run("session-v0-frozen", box, "v0-33333333-3333-4333-8333-333333333333");
  } finally { global.close(); }
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(0);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "info", reason: expect.stringMatching(/^legacy-upgrade-ready/) }),
  ]));
});

it("doctor blocks an unfinished legacy workspace preparation even after a terminal receipt", async () => {
  const f = fixture(), id = "workspace-move-1", checkout = join(f.root, "checkout"), oid = "a".repeat(40);
  mkdirSync(checkout);
  const snapshot = { root: checkout, repoKey: "fixture-repo", workspaceId: "fixture-workspace", moveId: id, stage: "final",
    head: oid, branch: null, objectFormat: "sha1", indexTree: oid, workingTree: oid, relativeCwd: "", sparsePatterns: null,
    worktreeConfig: null, droppedConfigKeys: [], normalization: { autocrlf: null, eol: null }, sparse: { enabled: false, cone: null },
    refs: [`refs/spider-roam/${id}/final/index`, `refs/spider-roam/${id}/final/working`], prerequisites: [],
    bundle: { kind: "ready", artifactId: "fixture-bundle", byteLength: 1 } };
  const digest = createHash("sha256").update(JSON.stringify([snapshot.repoKey, snapshot.workspaceId, snapshot.moveId, snapshot.stage,
    snapshot.head, snapshot.branch, snapshot.objectFormat, snapshot.indexTree, snapshot.workingTree, snapshot.relativeCwd,
    snapshot.sparsePatterns, snapshot.worktreeConfig, snapshot.normalization, snapshot.sparse, snapshot.refs, snapshot.prerequisites, snapshot.bundle])).digest("hex");
  f.journal.begin({ id, kind: "move", machineId: hub, expectedEpoch: 1, args: {} });
  f.journal.record(id, "workspace-prepare-start", { root: checkout, stage: "final", digest, snapshotJson: JSON.stringify(snapshot), previousJson: null, settingsJournalVersion: 1 });
  f.journal.record(id, "done", { code: 1, reason: "cancelled" });
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-blocked.*workspace-move-1.*worktree:fixture-repo:fixture-workspace/) }),
  ]));
});

it("reports a replica filename and store identity mismatch as unverified", async () => {
  const f = fixture(), expected = "worktree:fixture-repo:expected", recorded = "worktree:fixture-repo:recorded", file = replica(f.root, expected);
  const db = openDb(file);
  try { db.prepare("UPDATE roam_meta SET store_key=? WHERE id=1").run(recorded); } finally { db.close(); }
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-unverified.*worktree:fixture-repo:recorded/) }),
  ]));
});

it("doctor blocks an unpublished replica mapping fence with no map intent", async () => {
  const f = fixture(), key = "worktree:fixture-repo:fenced-workspace", file = replica(f.root, key);
  const store = openDb(file);
  try { fenceReplicaForMapping(store, key); } finally { store.close(); }
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-blocked.*worktree:fixture-repo:fenced-workspace/) }),
  ]));
});

it("doctor blocks an interrupted repository map by its store key", async () => {
  const f = fixture(), directory = join(f.root, "repository");
  mkdirSync(directory);
  const db = openDb(join(f.root, "spider.db"));
  try {
    writeLocal(db, "mapping-intent", JSON.stringify(["repo", "fixture-repo"]), { kind: "repo", identity: "fixture-repo",
      target_path: directory, store_key: "repo:fixture-repo", command_json: null, attempt_id: "attempt-1" });
  } finally { db.close(); }
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  const report = JSON.parse(io.out.mock.calls.at(-1)![0]);
  expect(report.value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-blocked.*repo:fixture-repo/) }),
  ]));
});

it.each(["checkpoint", "incoming"] as const)("does not classify a %s-owned v0 workspace map as legacy", async origin => {
  const f = fixture(), checkout = join(f.root, "checkout"), other = join(f.root, "other"), id = "v0-33333333-3333-4333-8333-333333333333";
  mkdirSync(join(checkout, "src"), { recursive: true }); mkdirSync(other);
  mkdirSync(join(checkout, ".git"));
  const localIsSource = origin === "checkpoint", sourceMachine = localIsSource ? hub : box, destinationMachine = localIsSource ? box : hub;
  const placement = (machineId: string, root: string) => ({ sessionId: "session-v0", machineId, historyMachine: sourceMachine,
    repoKey: "fixture-repo", workspaceId: "workspace-1", repository: root, cwd: join(root, "src"),
    file: join(root, "session.jsonl"), stores: ["global", "repo:fixture-repo", "worktree:fixture-repo:workspace-1"] });
  const plan = { moveId: id, source: { sessionId: "session-v0", machineId: sourceMachine, epoch: 1, updatedAt: 1,
    state: "running", destination: null, moveId: null }, sourcePlacement: placement(sourceMachine, localIsSource ? checkout : other),
    destinationPlacement: placement(destinationMachine, localIsSource ? other : checkout), destinationPrerequisites: [], startedAt: 1 };
  const key = "worktree:fixture-repo:workspace-1", identity = JSON.stringify(["fixture-repo", "workspace-1"]);
  f.journal.begin({ id, kind: "relocate-v0", machineId: hub, expectedEpoch: 1, args: { plan } });
  if (origin === "checkpoint") f.journal.record(id, "relocate-checkpoint", { checkpoint: { plan, completed: [], captured: null, installed: null, terminal: null, result: null } });
  else f.journal.record(id, "relocate-incoming", { plan, expectedKey: key });
  const db = openDb(join(f.root, "spider.db"));
  try {
    writeLocal(db, "mapping-intent", JSON.stringify(["workspace", identity]), { kind: "workspace", identity,
      target_path: checkout, store_key: key, command_json: null, attempt_id: "attempt-v0" });
    if (origin === "incoming") writeLocal(db, "relocate-incoming", key, { moveId: id });
    else db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?,?,2,?,1,'moving',?)")
      .run("session-v0", sourceMachine, id, destinationMachine);
  } finally { db.close(); }
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(0);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "info", reason: expect.stringMatching(/^legacy-upgrade-ready/) }),
  ]));
  const changed = openDb(join(f.root, "spider.db"));
  try { writeLocal(changed, "mapping-intent", JSON.stringify(["workspace", identity]), { kind: "workspace", identity,
    target_path: other, store_key: key, command_json: null, attempt_id: "attempt-not-v0" }); } finally { changed.close(); }
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-blocked.*worktree:fixture-repo:workspace-1/) }),
  ]));
});

it("reports a pending handoff with an unverifiable owner as unverified", async () => {
  const f = fixture(), stateRoot = join(f.root, "herdr"), file = join(f.root, "session.jsonl"), pid = 98765;
  writeFileSync(file, "fixture transcript\n", { mode: 0o600 });
  const boot = await localBootId(); expect(boot).toBeTruthy();
  const identity = { pid, startIdentity: "fixture-owner" };
  const lock = await claimIdLock(stateRoot, "session-unknown", identity,
    async () => ({ kind: "live" as const, startIdentity: identity.startIdentity }), { bootId: async () => boot });
  await lock.prepareHandoff("launch-unknown", file, "fixture-core");
  const realKill = process.kill;
  const spy = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
    if (target === pid) throw Object.assign(new Error("unavailable"), { code: "EPERM" });
    return realKill.call(process, target, signal);
  });
  try {
    const io = { out: vi.fn(), err: vi.fn() };
    expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
    expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-unverified.*session-unknown.*launch-unknown/) }),
    ]));
  } finally { spy.mockRestore(); }
});

it("doctor blocks live legacy hosting even after its launch reservation is settled", async () => {
  const f = fixture(), stateRoot = join(f.root, "herdr"), file = join(f.root, "live-session.jsonl");
  writeFileSync(file, "fixture transcript\n", { mode: 0o600 });
  const boot = await localBootId(), startIdentity = processStartIdentity(process.pid);
  expect(boot).toBeTruthy(); expect(startIdentity).toBeTruthy();
  const owner = { pid: process.pid, startIdentity: startIdentity! };
  const probe = async () => ({ kind: "live" as const, startIdentity: owner.startIdentity });
  await claimIdLock(stateRoot, "session-live", owner, probe, { bootId: async () => boot });
  const leases = createSessionLeases(stateRoot);
  await leases.claim(file, owner, { leases, presence: createProcessPresence(stateRoot), processes: async () => [], probe },
    { mode: "cutover", bootId: boot });
  await createIntentStore(f.root).update("session-live", null, {
    intent: { sessionId: "session-live", epoch: 1, desired: "running", suspended: null, file, cwd: f.root, moveId: null },
    failures: [], supervision: { kind: "live", identity: { bootId: boot!, pid: process.pid, startTime: startIdentity! }, stableSince: 1 },
  });
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-blocked.*session-live/) }),
  ]));
});

it("doctor blocks an adopted launch that still has an unreconciled reservation", async () => {
  const f = fixture(), stateRoot = join(f.root, "herdr"), file = join(f.root, "session.jsonl");
  writeFileSync(file, "fixture transcript\n", { mode: 0o600 });
  await createIntentStore(f.root).update("session-adopted", null, {
    intent: { sessionId: "session-adopted", epoch: 1, desired: "running", suspended: null, file, cwd: f.root, moveId: null },
    failures: [], supervision: { kind: "launching", operationId: "launch-adopted", phase: "invoking" },
  });
  f.journal.begin({ id: "launch-adopted", kind: "exact-session-launch", machineId: hub, expectedEpoch: 1, args: { sessionId: "session-adopted" } });
  f.journal.record("launch-adopted", "done", { code: 0, reason: "ready" });
  const boot = await localBootId(), startIdentity = processStartIdentity(process.pid);
  expect(boot).toBeTruthy(); expect(startIdentity).toBeTruthy();
  const launcher = { pid: 98765, startIdentity: "fixture-launcher" }, adopted = { pid: process.pid, startIdentity: startIdentity! };
  const probe = async (pid: number) => pid === launcher.pid ? { kind: "live" as const, startIdentity: launcher.startIdentity }
    : { kind: "live" as const, startIdentity: adopted.startIdentity };
  const lock = await claimIdLock(stateRoot, "session-adopted", launcher, probe, { bootId: async () => boot });
  const handoff = await lock.prepareHandoff("launch-adopted", file, "fixture-core");
  await claimIdLock(stateRoot, "session-adopted", adopted, probe, { bootId: async () => boot, handoff });
  const leases = createSessionLeases(stateRoot);
  await leases.claim(file, adopted, { leases, presence: createProcessPresence(stateRoot), processes: async () => [], probe },
    { mode: "cutover", bootId: boot });
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  const report = JSON.parse(io.out.mock.calls.at(-1)![0]);
  expect(report.value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-blocked.*session-adopted.*launch-adopted/) }),
  ]));
});
