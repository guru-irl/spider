import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { enableMemoryCapture, seedSession } from "@spider/db-core/roam/seed";
import { writeLocal } from "@spider/db-core/roam/local-state";
import { recordLocation } from "@spider/db-core/roam/catalog";
import { readSessionState } from "@spider/db-core/roam/state";
import type { Home, Probe, StoreKey } from "@spider/db-core/roam/types";
import { DEFAULT_LIMITS, disabledIntercom, type MoveCheck, type Operation, type RoamConfig, type Transport } from "@spider/roam/contracts";
import { assignInitialHome, cancelHomeAction, casHome, sessionHome } from "@spider/roam/homes";
import { openFreezeJournal } from "@spider/roam/journal";
import { moveSessionSlot, readMoveReservation } from "@spider/roam/move";
import { readPendingMoves } from "@spider/roam/pending-moves";
import { createBothLocks } from "@spider/roam/session-control";
import { createSessionLeases } from "@spider/herdr/sessions/lease";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { createIntercomMovePorts } from "@spider/roam/intercom-move";
import { createHostMoveBindings } from "../move-runtime";
import { serveSessionControl } from "../control";
import type { AdmissionGate } from "../admission";
import type { LiveFreezePorts } from "../control";

const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002";
const SESSION = "session-a", MOVE = "partial-freeze", WT: StoreKey = "worktree:fixture:workspace";
const closes: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function fixture(committed = false) {
  const global = createReplica("global", HUB), repo = createReplica("repo", HUB), worktree = createReplica("worktree", HUB);
  closes.push(() => global.close(), () => repo.close(), () => worktree.close());
  const root = global.root, cwd = join(root, "checkout"), file = join(root, "session.jsonl"), journalFile = join(root, "roam", "journal.db");
  mkdirSync(cwd); mkdirSync(join(root, "roam"), { mode: 0o700 }); mkdirSync(join(root, "herdr"), { mode: 0o700 });
  writeFileSync(join(root, "herdr", "config.json"), JSON.stringify({ mode: "core-only", globalRoot: root,
    core: { binary: "/fixture/hc", config: join(root, "core.json") }, agentDirectory: join(root, "agent"), shellRc: join(root, "rc"), machines: [] }), { mode: 0o600 });
  enableMemoryCapture(global.db, "global");
  repo.db.prepare("UPDATE roam_meta SET store_key='repo:fixture' WHERE id=1").run(); enableMemoryCapture(repo.db, "repo:fixture");
  worktree.db.prepare("UPDATE roam_meta SET store_key=? WHERE id=1").run(WT);
  worktree.db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES(?,1,?)").run(SESSION, HUB);
  seedSession(worktree.db, SESSION, 1, WT, 1);
  writeLocal(global.db, "mapping-redirect", "repo:fixture", repo.db.raw.name);
  writeLocal(global.db, "mapping-redirect", WT, worktree.db.raw.name);
  global.db.prepare("INSERT INTO roam_repo_maps(repo_key,path) VALUES('fixture',?)").run(cwd);
  global.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path,snapshot_json) VALUES('fixture','workspace',?,NULL)").run(cwd);
  const keys: StoreKey[] = ["global", "repo:fixture", WT];
  const home = assignInitialHome(global.db, SESSION, HUB, HUB) as Home;
  recordLocation(global.db, { sessionId: SESSION, home, file, cwd, stores: keys });
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: SESSION, cwd }) + "\n" +
    JSON.stringify({ type: "message", id: "leaf-a", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "synthetic", timestamp: 1 } }) + "\n", { mode: 0o600 });
  const config: RoamConfig = { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [],
    coreUnit: "fixture.service", syncMs: 120000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  const journal = openFreezeJournal(journalFile);
  const operation: Operation = { id: MOVE, kind: "move", machineId: HUB, expectedEpoch: 1, args: { sessionId: SESSION, destinationMachine: BOX } };
  const check: MoveCheck = { source: home, destinationMachine: BOX, repoKey: "fixture", workspaceId: "workspace", sourceRoot: cwd,
    sourceFile: file, sourceCwd: cwd, destinationRoot: "/fixture/destination", destinationCwd: "/fixture/destination", storeKeys: keys, warnings: [] };
  journal.begin(operation);
  journal.record(MOVE, "move-request", { sessionId: SESSION, destinationMachine: BOX, operation: { ...operation } });
  journal.record(MOVE, "move-action-complete", { action: "check", value: { ...check, source: { ...home }, storeKeys: [...keys], warnings: [] } });
  journal.record(MOVE, "move-action-start", { action: "freeze" });
  journal.record(MOVE, "move-failure", { code: "unknown", step: "freeze" });
  const slot = moveSessionSlot(SESSION);
  journal.begin({ id: slot, kind: "move-session", machineId: HUB, expectedEpoch: null, args: { sessionId: SESSION } });
  journal.record(slot, "reserved", { moveId: MOVE, destinationMachine: BOX });
  journal.beginFreeze(SESSION, MOVE, 1); journal.bindFreezeRoster(SESSION, MOVE, 1, keys);
  const fence = { address: { sessionId: SESSION, scopeId: null }, moveId: MOVE, expectedEpoch: 1, generation: "exited-source-generation" };
  journal.bindIntercomFence(fence);
  const abort: Operation = { id: `abort-${MOVE}-session-unfreeze-${HUB}`, kind: "session-unfreeze", machineId: HUB, expectedEpoch: 1,
    args: { sessionId: SESSION, moveId: MOVE, sourceMachine: HUB } };
  if (!committed) {
    cancelHomeAction(global.db, home, BOX, MOVE, HUB);
    journal.record(MOVE, "move-abort-start", {}); journal.record(MOVE, "move-abort-cancelled", {});
    journal.begin(abort); journal.record(abort.id, "partial-freeze-abort", {});
    journal.advanceFreeze(SESSION, MOVE, 1, "aborting");
    journal.record(abort.id, "abort-authorized", { sessionId: SESSION, moveId: MOVE, epoch: 1 });
    journal.advanceFreeze(SESSION, MOVE, 1, "aborted");
  } else casHome(global.db, home, BOX, MOVE, HUB);
  const unreachable = async (): Promise<never> => { throw new Error("unexpected destination access"); };
  const transport: Transport = { resolve: unreachable, read: unreachable, write: unreachable, run: unreachable, exec: unreachable, bootstrapProbe: unreachable };
  const runtime = await createHostMoveBindings({ root, globalDb: global.db, config, journal, sessionId: SESSION, storeKeys: keys, transport });
  closes.push(() => runtime.close());
  runtime.bindings.power = { pid: 900, onExit: () => () => {}, notice() {},
    spawn: async () => ({ exited: Promise.resolve(), stop: async () => {} }) };
  const participant = runtime.bindings.participant!;
  let owner: Probe = { kind: "absent" };
  participant.probe = async () => owner;
  const leases = createSessionLeases(join(root, "herdr"));
  const inventory = { leases, presence: createProcessPresence(leases.root), processes: async () => [],
    probe: async () => ({ kind: "live" as const, startIdentity: "fixture-control" }) };
  participant.withBothLocks = createBothLocks({ root: leases.root, inventory, file: async () => file,
    identity: { pid: 900, startIdentity: "fixture-control" }, bootId: async () => "fixture-boot" });
  const brokerActions: string[] = [];
  runtime.bindings.intercom!.ports = createIntercomMovePorts({ journal,
    // The old broker activation disappeared with the owner. No closure can be checked or reopened.
    broker: { async intake(action) { brokerActions.push(action); throw new Error("intercom-fence-unsupported"); },
      async inspectFreezeBlockers() { return { asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] }; } },
    bridge: { async drainIntake() {}, inspectMoveBlockers: () => ({ asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] }),
      undispatched: () => [], rebindMove() { throw new Error("unexpected rebind"); }, resumeIntake() { throw new Error("dead owner must not resume"); } },
    owns: async () => false, endpoint: () => null, home: async () => sessionHome(global.db, SESSION) as Home,
    admitted: () => false, presence: () => null, warnings: () => [] });
  return { runtime, global, worktree, file, cwd, journal, journalFile, home, abort, brokerActions, participant, setOwner(value: Probe) { owner = value; } };
}

it.each(["cancel", "recover"] as const)("%s completes an aborted partial freeze after the source owner exited", async op => {
  const f = await fixture();
  expect(f.journal.readFreeze(SESSION, MOVE)?.state).toBe("aborted");
  expect(f.journal.read(f.abort.id).map(row => row.action)).toEqual(["partial-freeze-abort", "abort-authorized"]);
  expect(readPendingMoves(f.journalFile)).toEqual([{ operationId: MOVE, step: "cancel", repairCommand: `spider roam cancel ${MOVE}` }]);
  const result = await f.runtime.control({ op, operationId: MOVE });
  expect(result, JSON.stringify(result)).toMatchObject({ code: 0, reason: "cancelled", home: f.home, repairCommand: null });
  expect(f.journal.lookupOperation(MOVE)?.state).toBe("done");
  expect(f.journal.lookupOperation(f.abort.id)?.state).toBe("done");
  expect(f.journal.read(f.abort.id).filter(row => row.action === "done")).toHaveLength(1);
  expect(readSessionState(f.worktree.db, SESSION)).toMatchObject({ epoch: 1, state: "active", moveId: null });
  expect(readMoveReservation(SESSION, f.journal)).toBeNull();
  expect(readPendingMoves(f.journalFile)).toEqual([]);
  expect(f.brokerActions).toEqual([]);
  const before = [f.journal.read(MOVE), f.journal.read(f.abort.id), f.journal.read(moveSessionSlot(SESSION))];
  expect(await f.runtime.control({ op: "cancel", operationId: MOVE })).toMatchObject({ code: 0, reason: "cancelled" });
  expect([f.journal.read(MOVE), f.journal.read(f.abort.id), f.journal.read(moveSessionSlot(SESSION))]).toEqual(before);
  expect(() => casHome(f.global.db, f.home, BOX, MOVE, HUB)).toThrow(/cancelled/);
});

it("uncertain source ownership cannot complete a partial-freeze cancellation", async () => {
  const f = await fixture(); f.setOwner({ kind: "uncertain" });
  expect(await f.runtime.control({ op: "cancel", operationId: MOVE })).toMatchObject({ code: 3 });
  expect(f.journal.lookupOperation(MOVE)?.state).toBe("pending");
  expect(f.journal.lookupOperation(f.abort.id)?.state).toBe("pending");
  expect(f.brokerActions).toEqual([]);
});

it("a source that becomes live under the locks is not treated as absent", async () => {
  const f = await fixture(); let probes = 0;
  f.participant.probe = async () => ++probes === 1 ? { kind: "absent" } : { kind: "live", identity: { bootId: "fixture-boot", pid: 42, startTime: "new-owner" } };
  expect(await f.runtime.control({ op: "cancel", operationId: MOVE })).toMatchObject({ code: 3 });
  expect(f.journal.lookupOperation(f.abort.id)?.state).toBe("pending");
  expect(f.brokerActions).toEqual([]);
});

it("a live source must release its own intercom fence before cancellation completes", async () => {
  const f = await fixture();
  const identity = { bootId: "fixture-boot", pid: 42, startTime: "live-owner" };
  f.setOwner({ kind: "live", identity });
  let admitted = false, resumed = false;
  const gate: AdmissionGate = {
    inspect: () => ({ kind: admitted ? "ordinary" : "control-only", home: f.home, blockers: [] }),
    refreshInitialHome: async () => gate.inspect(), whenSettled: async () => gate.inspect(),
    async close() { admitted = false; }, async freeze() { admitted = false; }, async unfreeze() { admitted = true; },
  };
  const ports: LiveFreezePorts = { gate, journal: f.journal, stores: f.participant.stores.map(row => row.db),
    expectedStores: ["global", "repo:fixture", WT], intercom: f.runtime.bindings.intercom!,
    async drain() {}, async resume() { resumed = true; }, async shutdown() {}, async ingestThrough() {},
    async inspect() { return { blockers: [], file: f.file, cwd: f.cwd, leaf: "leaf-a", owner: identity }; },
    authorizeAbort: f.runtime.bindings.evidence!.authorizeAbort!, onHubRestored: () => () => {},
  };
  const socketRoot = mkdtempSync(join(resolve(".spider/scratch"), "l-"));
  closes.push(() => rmSync(socketRoot, { recursive: true, force: true }));
  f.participant.runtimeRoot = socketRoot;
  const server = await serveSessionControl({ sessionId: SESSION, runtimeRoot: socketRoot, ports });
  closes.push(() => server.close());
  expect(await f.runtime.control({ op: "cancel", operationId: MOVE })).toMatchObject({ code: 3, reason: "move-abort-pending" });
  expect(admitted).toBe(false); expect(resumed).toBe(false);
  expect(f.journal.lookupOperation(MOVE)?.state).toBe("pending");
  expect(f.journal.lookupOperation(f.abort.id)?.state).toBe("pending");
  expect(f.brokerActions).toContain("check");
});

it("a committed destination home cannot be cancelled as a partial source freeze", async () => {
  const f = await fixture(true), before = sessionHome(f.global.db, SESSION);
  expect(await f.runtime.control({ op: "cancel", operationId: MOVE })).toMatchObject({ code: 3 });
  expect(sessionHome(f.global.db, SESSION)).toEqual(before);
  expect(f.journal.read(MOVE).some(row => row.action === "move-abort-cancelled")).toBe(false);
  expect(f.journal.read(f.abort.id)).toEqual([]);
  expect(f.brokerActions).toEqual([]);
});
