import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { migrate, openDb } from "@spider/db-core";
import { writeLocal } from "@spider/db-core/roam/local-state";
import { claimIdLock, localBootId } from "@spider/herdr/sessions/id-lock";
import { createSessionLeases } from "@spider/herdr/sessions/lease";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { processStartIdentity } from "@spider/herdr/jobs/handoff";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../cli";
import { openFreezeJournal, openJournal } from "../journal";
import { createIntentStore } from "../intent";

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
