import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate, openDb } from "@spider/db-core";
import { writeLocal } from "@spider/db-core/roam/local-state";
import type { JsonObject } from "@spider/db-core/roam/types";
import { fenceReplicaForMapping } from "@spider/db-core/roam/apply";
import { claimIdLock, localBootId } from "@spider/herdr/sessions/id-lock";
import { createSessionLeases } from "@spider/herdr/sessions/lease";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { processStartIdentity } from "@spider/herdr/jobs/handoff";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../cli";
import { openFreezeJournal, openJournal } from "../journal";
import * as intents from "../intent";
import { createIntentStore } from "../intent";
import { inspectLegacyUpgrade } from "../legacy-upgrade";
import { parseDoctorReport } from "../remote-observations";
import * as snapshots from "../diagnostic-snapshot";
import { peerEnabledDiagnostics } from "../peer-enabled";
import { readLocalIdentity } from "../runtime";
import { revokeMachine } from "../revocation";
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

it("reports an invalid home-action cancellation state as unverified", async () => {
  const f = fixture(), global = openDb(join(f.root, "spider.db"));
  try { global.prepare("INSERT INTO roam_home_actions(move_id,session_id,expected_epoch,args_digest,cancelled) VALUES (?,?,1,?,2)")
    .run("corrupt-action", "session-corrupt", "a".repeat(64)); } finally { global.close(); }
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-unverified.*corrupt-action/) }),
  ]));
});

it("reports a move reservation whose operation record is missing as unverified", async () => {
  const f = fixture();
  f.journal.begin({ id: "missing-slot", kind: "move-session", machineId: hub, expectedEpoch: null, args: { sessionId: "missing-session" } });
  f.journal.record("missing-slot", "reserved", { moveId: "missing-move", destinationMachine: box });
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-unverified.*missing-slot.*missing-move/) }),
  ]));
});

it.each(["valid", "missing-fields", "wrong-session", "wrong-move", "wrong-epoch", "overflow"] as const)("checks a %s committed home receipt", async condition => {
  const f = fixture(), global = openDb(join(f.root, "spider.db"));
  const home = condition === "missing-fields" ? {} : { sessionId: condition === "wrong-session" ? "other-session" : "session-committed",
    machineId: box, epoch: condition === "wrong-epoch" ? 9 : condition === "overflow" ? Number.MAX_SAFE_INTEGER + 1 : 2,
    moveId: condition === "wrong-move" ? "other-move" : "committed-move", updatedAt: 1 };
  try { global.prepare("INSERT INTO roam_home_actions(move_id,session_id,expected_epoch,args_digest,committed_home_json) VALUES (?,?,?,?,?)")
    .run("committed-move", "session-committed", condition === "overflow" ? Number.MAX_SAFE_INTEGER : 1, "a".repeat(64), JSON.stringify(home)); } finally { global.close(); }
  const io = { out: vi.fn(), err: vi.fn() }, code = await main(["roam", "doctor", "--json"], io);
  expect(code).toBe(condition === "valid" ? 0 : 1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    condition === "valid" ? expect.objectContaining({ severity: "info", reason: expect.stringMatching(/^legacy-upgrade-ready/) })
      : expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-unverified.*committed-move/) }),
  ]));
});

it("reports a lost home-action journal record as unverified without changing evidence", async () => {
  const f = fixture(), globalFile = join(f.root, "spider.db"), journalFile = join(f.root, "roam", "journal.db");
  const global = openDb(globalFile);
  try { global.prepare("INSERT INTO roam_home_actions(move_id,session_id,expected_epoch,args_digest) VALUES (?,?,1,?)")
    .run("lost-action", "session-lost", "a".repeat(64)); } finally { global.close(); }
  const files = [globalFile, journalFile, join(f.root, "roam", "config.json")], before = files.map(file => readFileSync(file));
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-unverified.*session-lost.*lost-action/) }),
  ]));
  expect(files.map(file => readFileSync(file))).toEqual(before);
});

it("reports a corrupt journal as unverified without repairing it", async () => {
  const f = fixture(), file = join(f.root, "roam", "journal.db");
  writeFileSync(file, "corrupt fixture journal", { mode: 0o600 });
  const before = readFileSync(file), io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/^legacy-upgrade-unverified/) }),
  ]));
  expect(readFileSync(file)).toEqual(before);
});

it("classifies a v0-shaped operation ID by its legacy journal kind", async () => {
  const f = fixture(), id = "v0-33333333-3333-4333-8333-333333333333";
  f.journal.begin({ id, kind: "move", machineId: hub, expectedEpoch: 1, args: {} });
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(new RegExp(`legacy-upgrade-blocked.*${id}`)) }),
  ]));
});

it("enabled local doctor includes the same pending legacy inventory", async () => {
  const f = fixture(), config = join(f.root, "roam", "config.json");
  const current = JSON.parse(readFileSync(config, "utf8")); current.enabled = true;
  writeFileSync(config, JSON.stringify(current), { mode: 0o600 });
  f.journal.begin({ id: "enabled-move", kind: "move", machineId: hub, expectedEpoch: 1, args: {} });
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-blocked.*enabled-move/) }),
  ]));
});

it("reports lost roaming identity as unverified even when a pending move is visible", async () => {
  const f = fixture();
  f.journal.begin({ id: "known-move", kind: "move", machineId: hub, expectedEpoch: 1, args: {} });
  rmSync(join(f.root, "roam", "config.json")); rmSync(join(f.root, "roam", "machine.json"));
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0])).toMatchObject({ reason: "legacy-upgrade-unverified", value: { enabled: null,
    diagnostics: [expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-unverified.*known-move/) })] } });
  expect(await main(["roam", "status", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0])).toMatchObject({ reason: "status-unavailable", code: 1 });
});

async function withActivityDuringInventory(root: string, activity: () => void | Promise<void>) {
  const original = intents.inspectIntentViews;
  let ran = false;
  const spy = vi.spyOn(intents, "inspectIntentViews").mockImplementation(async path => {
    if (!ran) { ran = true; await activity(); }
    return original(path);
  });
  try {
    const inventory = await inspectLegacyUpgrade(root);
    expect(ran).toBe(true);
    return inventory;
  } finally { spy.mockRestore(); }
}

it.each([false, true])("keeps upgrade ready after a concurrent read-only SELECT (open writer: %s)", async writerOpen => {
  const { root } = fixture(), file = join(root, "spider.db");
  const writer = writerOpen ? openDb(file) : undefined;
  try {
    expect((await inspectLegacyUpgrade(root)).status).toBe("legacy-upgrade-ready");
    const result = await withActivityDuringInventory(root, () => {
      const reader = new DatabaseSync(file, { readOnly: true });
      try { reader.prepare("SELECT count(*) FROM sqlite_master").get(); } finally { reader.close(); }
    });
    expect(result).toEqual({ status: "legacy-upgrade-ready", findings: [] });
  } finally { writer?.close(); }
});

it("keeps upgrade ready after a concurrent insert into an unrelated table", async () => {
  const { root } = fixture(), writer = openDb(join(root, "spider.db"));
  try {
    writer.exec("CREATE TABLE fixture_unrelated (value INTEGER)");
    expect((await inspectLegacyUpgrade(root)).status).toBe("legacy-upgrade-ready");
    const result = await withActivityDuringInventory(root, () => { writer.exec("INSERT INTO fixture_unrelated VALUES (1)"); });
    expect(result).toEqual({ status: "legacy-upgrade-ready", findings: [] });
  } finally { writer.close(); }
});

it("notices a changed legacy receipt even though it remains settled", async () => {
  const { root, journal } = fixture();
  journal.begin({ id: "settled-launch", kind: "exact-session-launch", machineId: hub, expectedEpoch: 1, args: {} });
  journal.record("settled-launch", "done", { code: 0, reason: "ready" });
  expect((await inspectLegacyUpgrade(root)).status).toBe("legacy-upgrade-ready");
  const result = await withActivityDuringInventory(root, () => {
    const writer = openDb(join(root, "roam", "journal.db"));
    try { writer.prepare("UPDATE roam_operations SET result_json=? WHERE operation_id=?").run('{"code":1,"reason":"launch-ended"}', "settled-launch"); }
    finally { writer.close(); }
  });
  expect(result).toEqual({ status: "legacy-upgrade-unverified", findings: ["local evidence changed during inspection"] });
  expect((await inspectLegacyUpgrade(root)).status).toBe("legacy-upgrade-ready");
});

it.each(["an ID lock", "a lease"] as const)("keeps upgrade ready when an ordinary session takes %s", async kind => {
  const { root } = fixture(), stateRoot = join(root, "herdr"), file = join(root, "ordinary.jsonl");
  writeFileSync(file, "fixture transcript\n", { mode: 0o600 });
  const bootId = await localBootId(), startIdentity = processStartIdentity(process.pid);
  expect(bootId).toBeTruthy(); expect(startIdentity).toBeTruthy();
  const owner = { pid: process.pid, startIdentity: startIdentity! };
  const probe = async () => ({ kind: "live" as const, startIdentity: owner.startIdentity });
  expect((await inspectLegacyUpgrade(root)).status).toBe("legacy-upgrade-ready");
  const result = await withActivityDuringInventory(root, async () => {
    if (kind === "an ID lock") await claimIdLock(stateRoot, "ordinary-session", owner, probe, { bootId: async () => bootId });
    else {
      const leases = createSessionLeases(stateRoot);
      await leases.claim(file, owner, { leases, presence: createProcessPresence(stateRoot), processes: async () => [], probe }, { mode: "cutover", bootId });
    }
  });
  expect(result).toEqual({ status: "legacy-upgrade-ready", findings: [] });
});

it("reports an inventory as unverified and names the new move when its journal changes between snapshots", async () => {
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
      expect.objectContaining({ severity: "block", reason: expect.stringMatching(/^legacy-upgrade-unverified: local evidence changed during inspection, move operation concurrent-move\./) }),
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
    sourceCleanup: { status: "pending", reason: "move-cleanup-pending", blockers: ["move-cleanup-pending"] } });
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  const report = JSON.parse(io.out.mock.calls.at(-1)![0]);
  expect(report.value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-blocked.*legacy-move-1.*source cleanup.*session-1.*legacy-move-1/) }),
  ]));
});

it.each([
  { name: "pending", cleanup: { status: "pending", reason: "move-cleanup-pending", blockers: ["move-cleanup-pending"] }, status: "legacy-upgrade-blocked" },
  { name: "missing", cleanup: undefined, status: "legacy-upgrade-unverified" },
  { name: "malformed pending", cleanup: { status: "pending" }, status: "legacy-upgrade-unverified" },
  { name: "invalid state", cleanup: { status: "unknown" }, status: "legacy-upgrade-unverified" },
])("checks a terminal move's $name source-cleanup receipt", async ({ cleanup, status }) => {
  const f = fixture(), id = "terminal-cleanup";
  f.journal.begin({ id, kind: "move", machineId: hub, expectedEpoch: 1, args: { sessionId: "terminal-session" } });
  const value: JsonObject = { home: { sessionId: "terminal-session" } };
  if (cleanup) value.sourceCleanup = cleanup as JsonObject;
  f.journal.record(id, "done", { code: 0, reason: "moved", value });
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(new RegExp(`${status}.*source cleanup.*${id}`)) }),
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
    if (kind === "move-abort-cleanup") f.journal.record(id, "abort-cleanup-request", { moveId: "settled-move", sessionId: "session-slot", check: { storeKeys: ["global"] } });
    const io = { out: vi.fn(), err: vi.fn() };
    expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
    const report = JSON.parse(io.out.mock.calls.at(-1)![0]);
    expect(report.value.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "block", reason: expect.stringContaining(id) }),
    ]));
    expect(report.value.diagnostics.some((row: { reason: string }) => row.reason.startsWith("legacy-upgrade-blocked:"))).toBe(true);
  },
);

it.each(["forget-machine", "restore-destroyed-home"] as const)("blocks a pending %s operation", async kind => {
  const { root, journal } = fixture(), id = `${kind}-fixture`;
  journal.begin({ id, kind, machineId: hub, expectedEpoch: kind === "forget-machine" ? null : 2,
    args: kind === "forget-machine" ? { destroyedMachine: box } : { destroyedMachine: box, sessionId: "destroyed-session" } });
  expect(await inspectLegacyUpgrade(root)).toEqual({ status: "legacy-upgrade-blocked", findings: [`${kind} operation ${id}`] });
});

it.each(["legacy and v0", "v0 only", "no remaining"] as const)("checks a revoked machine with %s homes", async homes => {
  const { root } = fixture();
  // Revocation commits before the old hub begins a recovery operation.
  const journal = openDb(join(root, "roam", "journal.db"));
  try { revokeMachine(journal, box); } finally { journal.close(); }
  const global = openDb(join(root, "spider.db"));
  try {
    const home = global.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,updated_at,move_id,state) VALUES (?,?,2,1,?,?)");
    home.run("restored-session", hub, "forget-completed", null);
    if (homes === "legacy and v0") home.run("unrestored-session", box, null, null);
    if (homes !== "no remaining") home.run("v0-session", box, null, "running");
  } finally { global.close(); }
  expect(await inspectLegacyUpgrade(root)).toEqual(homes === "legacy and v0"
    ? { status: "legacy-upgrade-blocked", findings: [`revoked machine ${box} has unrestored legacy session unrestored-session`] }
    : { status: "legacy-upgrade-ready", findings: [] });
});

it("settled destroyed-machine recovery and unfinished presentation do not block upgrade", async () => {
  const { root, journal } = fixture();
  journal.begin({ id: "forget-machine-settled", kind: "forget-machine", machineId: hub, expectedEpoch: null, args: { destroyedMachine: box } });
  journal.record("forget-machine-settled", "done", { code: 0, reason: "destroyed-machine-recovered", results: [] });
  journal.begin({ id: "restore-settled", kind: "restore-destroyed-home", machineId: hub, expectedEpoch: 2, args: { destroyedMachine: box, sessionId: "restored-session" } });
  journal.record("restore-settled", "done", { home: { sessionId: "restored-session", machineId: hub, epoch: 2, moveId: "restore-settled", updatedAt: 1 } });
  journal.begin({ id: "restore-settled-presentation", kind: "forget-presentation", machineId: hub, expectedEpoch: 2,
    args: { restoreOperationId: "restore-settled", sessionId: "restored-session" } });
  expect(await inspectLegacyUpgrade(root)).toEqual({ status: "legacy-upgrade-ready", findings: [] });
});

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

it("names the unfinished freeze when the freeze roster table is missing", async () => {
  const { root } = fixture(), file = join(root, "roam", "journal.db");
  const freeze = openFreezeJournal(file);
  freeze.beginFreeze("session-missing-roster", "move-missing-roster", 1);
  freeze.bindFreezeRoster("session-missing-roster", "move-missing-roster", 1, ["global"]);
  freeze.advanceFreeze("session-missing-roster", "move-missing-roster", 1, "frozen");
  const db = openDb(file);
  try { db.exec("DROP TABLE freeze_store_rosters"); } finally { db.close(); }
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/^legacy-upgrade-unverified:.*session-missing-roster.*move-missing-roster.*roster table unavailable/) }),
  ]));
});

it("reports a lost store named by an unfinished freeze roster as unverified", async () => {
  const f = fixture(), key = "worktree:fixture-repo:lost-store";
  const freeze = openFreezeJournal(join(f.root, "roam", "journal.db"));
  freeze.beginFreeze("session-lost-store", "freeze-lost-store", 1);
  freeze.bindFreezeRoster("session-lost-store", "freeze-lost-store", 1, ["global", key]);
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-unverified.*worktree:fixture-repo:lost-store/) }),
  ]));
});

it("reports a missing abort-cleanup request as unverified", async () => {
  const f = fixture();
  f.journal.begin({ id: "orphan-abort", kind: "move-abort-cleanup", machineId: hub, expectedEpoch: 1, args: {} });
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-unverified.*orphan-abort/) }),
  ]));
});

it("reports a missing store named by unfinished abort cleanup as unverified", async () => {
  const f = fixture(), key = "worktree:fixture-repo:abort-store", checkout = join(f.root, "missing-abort-store");
  f.journal.begin({ id: "old-aborted-move", kind: "move", machineId: hub, expectedEpoch: 1, args: {} });
  f.journal.record("old-aborted-move", "done", { code: 1, reason: "cancelled" });
  f.journal.begin({ id: "abort-pending", kind: "move-abort-cleanup", machineId: hub, expectedEpoch: 1, args: {} });
  f.journal.record("abort-pending", "abort-cleanup-request", { moveId: "old-aborted-move", sessionId: "session-abort-store", check: { storeKeys: ["global", key] } });
  const global = openDb(join(f.root, "spider.db"));
  try { global.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES (?,?,?)").run("fixture-repo", "abort-store", checkout); }
  finally { global.close(); }
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-unverified.*worktree:fixture-repo:abort-store/) }),
  ]));
});

it("reports a missing store named by an unfinished move check as unverified", async () => {
  const f = fixture(), key = "worktree:fixture-repo:move-store", checkout = join(f.root, "missing-move-store");
  f.journal.begin({ id: "pending-with-store", kind: "move", machineId: hub, expectedEpoch: 1, args: { sessionId: "session-move-store" } });
  f.journal.record("pending-with-store", "move-action-complete", { action: "check", value: { storeKeys: ["global", key] } });
  const global = openDb(join(f.root, "spider.db"));
  try { global.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES (?,?,?)").run("fixture-repo", "move-store", checkout); }
  finally { global.close(); }
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-unverified.*worktree:fixture-repo:move-store/) }),
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
    project.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,1,'frozen')").run("session-v0-ordinary");
  } finally { project.close(); }
  const global = openDb(join(f.root, "spider.db"));
  try {
    global.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES (?,?,?)").run("fixture-repo", "workspace-1", checkout);
    global.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?,?,2,?,1,'running',NULL)")
      .run("session-v0-frozen", box, "v0-33333333-3333-4333-8333-333333333333");
    global.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?,?,2,?,1,'running',NULL)")
      .run("session-v0-ordinary", box, "v0-33333333-3333-4333-8333-333333333333");
  } finally { global.close(); }
  const freeze = openFreezeJournal(join(f.root, "roam", "journal.db"));
  freeze.beginFreeze("session-v0-frozen", "old-settled-move", 1);
  freeze.bindFreezeRoster("session-v0-frozen", "old-settled-move", 1, ["global", key]);
  freeze.advanceFreeze("session-v0-frozen", "old-settled-move", 1, "frozen");
  freeze.advanceFreeze("session-v0-frozen", "old-settled-move", 1, "complete");
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(0);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "info", reason: expect.stringMatching(/^legacy-upgrade-ready/) }),
  ]));
});

it("does not infer a lost legacy freeze is settled from a v0 home alone", async () => {
  const f = fixture(), checkout = join(f.root, "worktree"), projectDir = join(checkout, ".spider"), key = "worktree:fixture-repo:workspace-1";
  mkdirSync(projectDir, { recursive: true });
  const project = openDb(join(projectDir, "project.db"));
  try {
    migrate(project, "worktree", { machineId: hub, globalRoot: f.root });
    project.prepare("UPDATE roam_meta SET machine_id=?,store_key=? WHERE id=1").run(hub, key);
    project.prepare("INSERT INTO roam_sessions(session_id,epoch,state,move_id,freeze_seq) VALUES (?,1,'frozen',?,0)")
      .run("session-v0-lost", "old-lost-move");
  } finally { project.close(); }
  const global = openDb(join(f.root, "spider.db"));
  try {
    global.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES (?,?,?)").run("fixture-repo", "workspace-1", checkout);
    global.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?,?,2,?,1,'running',NULL)")
      .run("session-v0-lost", box, "v0-33333333-3333-4333-8333-333333333333");
  } finally { global.close(); }
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-unverified.*session-v0-lost.*worktree:fixture-repo:workspace-1/) }),
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

it("finds frozen legacy evidence in a registered project without a workspace map", async () => {
  const f = fixture(), directory = join(f.root, "registered"), file = join(directory, "project.db"), key = "worktree:fixture-repo:workspace-1";
  mkdirSync(directory);
  const project = openDb(file);
  try {
    migrate(project, "worktree", { machineId: hub, globalRoot: f.root });
    project.prepare("UPDATE roam_meta SET machine_id=?,store_key=? WHERE id=1").run(hub, key);
    project.prepare("INSERT INTO roam_sessions(session_id,epoch,state,move_id,freeze_seq) VALUES (?,1,'frozen',?,0)")
      .run("session-registered-frozen", "lost-project-move");
  } finally { project.close(); }
  const global = openDb(join(f.root, "spider.db"));
  try { global.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES (?,?,?,1,1)")
    .run("fixture-project", directory, file); } finally { global.close(); }
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-unverified.*session-registered-frozen.*worktree:fixture-repo:workspace-1/) }),
  ]));
});

it("finds frozen legacy evidence in a retained replica after its mapping is published", async () => {
  const f = fixture(), key = "worktree:fixture-repo:workspace-1", file = replica(f.root, key);
  const source = openDb(file);
  try {
    source.prepare("INSERT INTO roam_sessions(session_id,epoch,state,move_id,freeze_seq) VALUES (?,1,'frozen',?,0)")
      .run("session-replica-frozen", "lost-replica-move");
    fenceReplicaForMapping(source, key);
  } finally { source.close(); }
  const checkout = join(f.root, "checkout"), directory = join(checkout, ".spider"), target = join(directory, "project.db");
  mkdirSync(directory, { recursive: true });
  const project = openDb(target);
  try { migrate(project, "worktree", { machineId: hub, globalRoot: f.root });
    project.prepare("UPDATE roam_meta SET machine_id=?,store_key=? WHERE id=1").run(hub, key); } finally { project.close(); }
  const global = openDb(join(f.root, "spider.db"));
  try {
    global.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES (?,?,?)").run("fixture-repo", "workspace-1", checkout);
    writeLocal(global, "mapping-redirect", key, target);
  } finally { global.close(); }
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-unverified.*session-replica-frozen.*worktree:fixture-repo:workspace-1/) }),
  ]));
});

it("reports an orphaned mapping redirect as unverified", async () => {
  const f = fixture(), key = "worktree:fixture-repo:workspace-1", checkout = join(f.root, "missing-checkout"), target = join(checkout, ".spider", "project.db");
  const global = openDb(join(f.root, "spider.db"));
  try {
    writeLocal(global, "mapping-redirect", key, target);
  } finally { global.close(); }
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-unverified.*worktree:fixture-repo:workspace-1/) }),
  ]));
});

it("does not block a published mapping's retained replica fence", async () => {
  const f = fixture(), key = "worktree:fixture-repo:workspace-1", file = replica(f.root, key);
  const source = openDb(file);
  try { fenceReplicaForMapping(source, key); } finally { source.close(); }
  const checkout = join(f.root, "checkout"), directory = join(checkout, ".spider"), target = join(directory, "project.db");
  mkdirSync(directory, { recursive: true });
  const project = openDb(target);
  try { migrate(project, "worktree", { machineId: hub, globalRoot: f.root });
    project.prepare("UPDATE roam_meta SET machine_id=?,store_key=? WHERE id=1").run(hub, key); } finally { project.close(); }
  const global = openDb(join(f.root, "spider.db"));
  try {
    global.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES (?,?,?)").run("fixture-repo", "workspace-1", checkout);
    writeLocal(global, "mapping-redirect", key, target);
  } finally { global.close(); }
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(0);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "info", reason: expect.stringMatching(/^legacy-upgrade-ready/) }),
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
  const store = openDb(replica(f.root, key));
  try { store.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,1,'frozen')").run("session-v0"); }
  finally { store.close(); }
  expect(await main(["roam", "doctor", "--json"], io)).toBe(0);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "info", reason: expect.stringMatching(/^legacy-upgrade-ready/) }),
  ]));
  if (origin === "incoming") {
    const stale = openDb(join(f.root, "spider.db"));
    try { stale.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?,?,10,?,1,'running',NULL)")
      .run("session-v0", box, "v0-44444444-4444-4444-8444-444444444444"); } finally { stale.close(); }
    expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
    expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-blocked.*worktree:fixture-repo:workspace-1/) }),
    ]));
    const restore = openDb(join(f.root, "spider.db"));
    try { restore.prepare("DELETE FROM session_homes WHERE session_id=?").run("session-v0"); } finally { restore.close(); }
  }
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

it.each(["live", "idle"] as const)("doctor blocks live legacy hosting when its intent view is %s", async supervision => {
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
    failures: [], supervision: supervision === "live"
      ? { kind: "live", identity: { bootId: boot!, pid: process.pid, startTime: startIdentity! }, stableSince: 1 }
      : { kind: "idle", nextAttemptAt: null },
  });
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await main(["roam", "doctor", "--json"], io)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-blocked.*session-live/) }),
  ]));
});

it.each(["matching", "wrong-file", "stale-epoch", "legacy-launch", "legacy-home-id"] as const)("checks %s v0 ownership against an idle legacy intent", async evidence => {
  const f = fixture(), stateRoot = join(f.root, "herdr"), file = join(f.root, "session-v0.jsonl"), cwd = join(f.root, "checkout"), id = "session-v0-owner";
  writeFileSync(file, "fixture transcript\n", { mode: 0o600 });
  const boot = await localBootId(), startIdentity = processStartIdentity(process.pid);
  expect(boot).toBeTruthy(); expect(startIdentity).toBeTruthy();
  const owner = { pid: process.pid, startIdentity: startIdentity! };
  const probe = async () => ({ kind: "live" as const, startIdentity: owner.startIdentity });
  if (evidence === "legacy-launch") {
    const launcher = { pid: 98765, startIdentity: "fixture-launcher" };
    const probeBoth = async (pid: number) => ({ kind: "live" as const, startIdentity: pid === launcher.pid ? launcher.startIdentity : owner.startIdentity });
    const lock = await claimIdLock(stateRoot, id, launcher, probeBoth, { bootId: async () => boot });
    const handoff = await lock.prepareHandoff("old-launch", file, "old-core");
    await claimIdLock(stateRoot, id, owner, probeBoth, { bootId: async () => boot, handoff });
    f.journal.begin({ id: "old-launch", kind: "exact-session-launch", machineId: hub, expectedEpoch: 1, args: { sessionId: id } });
    f.journal.record("old-launch", "done", { code: 0, reason: "ready" });
  } else await claimIdLock(stateRoot, id, owner, probe, { bootId: async () => boot });
  const leases = createSessionLeases(stateRoot);
  await leases.claim(file, owner, { leases, presence: createProcessPresence(stateRoot), processes: async () => [], probe },
    { mode: "cutover", bootId: boot });
  await createIntentStore(f.root).update(id, null, {
    intent: { sessionId: id, epoch: evidence === "stale-epoch" ? 2 : 1, moveId: null, desired: "running", file, cwd, suspended: null },
    failures: [], supervision: { kind: "idle", nextAttemptAt: null },
  });
  const global = openDb(join(f.root, "spider.db"));
  try {
    global.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?,?,1,?,1,'running',NULL)")
      .run(id, hub, evidence === "legacy-home-id" ? "old-legacy-move" : null);
    writeLocal(global, "relocate-managed", id, { sessionId: id, machineId: hub, historyMachine: hub, repoKey: "fixture-repo", workspaceId: "workspace-1", repository: cwd, cwd, file: evidence === "wrong-file" ? join(f.root, "other.jsonl") : file, stores: ["global", "worktree:fixture-repo:workspace-1"] });
  } finally { global.close(); }
  const io = { out: vi.fn(), err: vi.fn() };
  await main(["roam", "doctor", "--json"], io);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0]).value.diagnostics).toEqual(expect.arrayContaining([
    evidence === "matching" ? expect.objectContaining({ severity: "info", reason: expect.stringMatching(/^legacy-upgrade-ready/) })
      : evidence === "legacy-home-id" ? expect.objectContaining({ severity: "block", reason: expect.stringMatching(/^legacy-upgrade-unverified/) })
      : expect.objectContaining({ severity: "block", reason: expect.stringMatching(/legacy-upgrade-blocked.*session-v0-owner/) }),
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
