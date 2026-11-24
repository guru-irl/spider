import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths, openDbAt, type Db } from "@spider/db-core";
import { createReplica } from "@spider/db-core/testutil";
import { catalogReplica } from "@spider/db-core/roam/catalog";
import { mapRepository, mapWorkspace } from "@spider/db-core/roam/repo-map";
import { enableMemoryCapture, seedSession } from "@spider/db-core/roam/seed";
import { readSessionState } from "@spider/db-core/roam/state";
import type { StoreKey } from "@spider/db-core/roam/types";
import { DEFAULT_LIMITS, disabledIntercom, type Operation, type RoamConfig } from "@spider/roam/contracts";
import { openFreezeJournal } from "@spider/roam/journal";
import { moveEvidence } from "@spider/roam/move";
import type { MoveFreezeEvidenceBindings } from "@spider/roam/move-ports";
import { sessionHome } from "@spider/roam/homes";
import { startMachineMoveSocket } from "@spider/roam/machine-move-socket";
import { createBothLocks } from "@spider/roam/session-control";
import { createSessionLeases } from "@spider/herdr/sessions/lease";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { processStartTime } from "../../../subagents/src/process-identity";
import * as localRuntime from "@spider/roam/runtime";
import * as control from "../roam/control";
import * as sessionSocket from "@spider/roam/session-socket";
import * as usageMount from "../usage/mount";
import { createMoveActivation } from "../roam/move-activation";
import { createHostMoveBindings } from "../roam/move-runtime";
import { freezeParticipant } from "../roam/freeze";
import type { AdmissionGate } from "../roam/admission";
import { fixtureIntercom } from "../roam/__tests__/intercom-move-fixture";

const HUB = "00000000-0000-4000-8000-000000000001";
const BOX = "00000000-0000-4000-8000-000000000002";
// Opaque repository keys can contain colons. Their workspace is the last component.
const REPO = "origin:fixture-repo", WORKSPACE = "fixture-workspace";
const WORKTREE: StoreKey = `worktree:${REPO}:${WORKSPACE}`;
const ROSTER: StoreKey[] = ["global", `repo:${REPO}`, WORKTREE];
const fixtures: ReturnType<typeof createReplica>[] = [], dbs: Db[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const db of dbs.splice(0)) db.close(); for (const f of fixtures.splice(0)) f.close(); });

async function fixture(beforeMapping = true, bound = false) {
  const global = createReplica("global", HUB); fixtures.push(global);
  vi.stubEnv("HC_SOCKET", join(process.cwd(), ".spider/scratch/move-roster.sock"));
  vi.stubEnv("HC_TERMINAL_SOCKET", join(process.cwd(), ".spider/scratch/move-roster.sock"));
  vi.stubEnv("HC_SESSION", "move-roster");
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  const config: RoamConfig = { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB,
    peers: [{ machineId: BOX, alias: "box.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/spider", core: "/fixture/core", globalRoot: "/fixture/global" }],
    discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  for (const [name, value] of [["config", config], ["machine", { machineId: HUB }]] as const)
    writeFileSync(join(global.root, "roam", `${name}.json`), JSON.stringify(value), { mode: 0o600 });
  expect(localRuntime.readLocalIdentity(global.root)).toEqual(config);
  for (const directory of [join(global.root, "herdr", "jobs"), join(global.root, "jobs"), join(global.root, "scratch")])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(global.root, "herdr", "config.json"), JSON.stringify({ mode: "core-only", globalRoot: global.root,
    core: { binary: join(global.root, "hc"), config: join(global.root, "core.json") }, agentDirectory: join(global.root, "agent"),
    shellRc: join(global.root, "shell.rc"), machines: [] }), { mode: 0o600 });
  const cwd = join(global.root, "checkout"); mkdirSync(cwd);
  execFileSync("git", ["init", "-q", cwd]);
  expect(paths.projectRoot(cwd)).toBe(join(cwd, ".spider"));
  const repository = openDbAt(join(cwd, ".git", "spider", "repo.db"), "repo"); dbs.push(repository);
  repository.prepare("UPDATE roam_meta SET machine_id=? WHERE id=1").run(HUB);
  enableMemoryCapture(repository, `repo:${REPO}`);
  const worktree = openDbAt(join(cwd, ".spider", "project.db"), "worktree"); dbs.push(worktree);
  worktree.prepare("UPDATE roam_meta SET machine_id=? WHERE id=1").run(HUB);
  const sessionId = "ordinary-source", file = join(cwd, "session.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd }) + "\n" +
    JSON.stringify({ type: "model_change", id: "leaf-1", parentId: null, timestamp: "2026-01-01T00:00:00Z" }) + "\n");
  const insert = (db: Db) => db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES(?,1,?)").run(sessionId, HUB);
  if (beforeMapping) insert(worktree);
  await mapRepository(global.db, { repoKey: REPO, path: cwd });
  await mapWorkspace(global.db, { repoKey: REPO, workspaceId: WORKSPACE, path: cwd });
  if (!beforeMapping) insert(worktree);
  const boundKeys: StoreKey[] = [], boundDbs: Db[] = [];
  if (bound) {
    const boundCwd = join(global.root, "bound"); mkdirSync(boundCwd);
    execFileSync("git", ["init", "-q", boundCwd]);
    // A separately bound repository must contribute its own memory barrier.
    const boundRepo = "bound-repo", boundKey: StoreKey = `worktree:${boundRepo}:bound-workspace`;
    const repoDb = openDbAt(join(boundCwd, ".git", "spider", "repo.db"), "repo"); dbs.push(repoDb);
    repoDb.prepare("UPDATE roam_meta SET machine_id=? WHERE id=1").run(HUB);
    enableMemoryCapture(repoDb, `repo:${boundRepo}`);
    const db = openDbAt(join(boundCwd, ".spider", "project.db"), "worktree"); dbs.push(db);
    db.prepare("UPDATE roam_meta SET machine_id=? WHERE id=1").run(HUB); insert(db);
    await mapRepository(global.db, { repoKey: boundRepo, path: boundCwd });
    await mapWorkspace(global.db, { repoKey: boundRepo, workspaceId: "bound-workspace", path: boundCwd });
    catalogReplica(global.db, boundKey, db);
    boundKeys.push(`repo:${boundRepo}`, boundKey); boundDbs.push(db);
  }
  const location = () => {
    const row = global.db.prepare("SELECT stores_json FROM roam_locations WHERE session_id=?").get(sessionId) as { stores_json: string } | undefined;
    return row ? JSON.parse(row.stores_json) as StoreKey[] : null;
  };
  // Memory capture is existing hub setup, not portable session membership.
  enableMemoryCapture(global.db, "global");
  const journal = openFreezeJournal(join(global.root, "roam", "journal.db"));
  const snapshot = { asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] };
  const machine = await startMachineMoveSocket(global.root, () => true, { broker: async () => snapshot, bridge: async () => snapshot, settlement: async () => null, intake: fixtureIntercom(sessionId).ports } as never);
  vi.spyOn(localRuntime, "openLocalCore").mockReturnValue({ root: global.root, config, db: global.db, close() {} });
  vi.spyOn(usageMount, "resolveUsageRoots").mockReturnValue({ registryDb: join(global.root, "spider.db"), ledgerFile: join(global.root, "usage.db"), sessionsDir: join(global.root, "sessions"), authPath: join(global.root, "auth.json"), leaseDir: join(global.root, "usage-leases") });
  vi.spyOn(paths, "scratch").mockImplementation(scope => join(global.root, scope === "global" ? "scratch" : "project-scratch"));
  const gate: AdmissionGate = {
    inspect: () => ({ kind: admitted ? "ordinary" : "control-only", home: (() => { const home = sessionHome(global.db, sessionId); return home === "unknown" ? null : home; })(), blockers: [] }),
    refreshInitialHome: async () => gate.inspect(), whenSettled: async () => gate.inspect(), close: async () => { admitted = false; },
    freeze: async () => { admitted = false; }, unfreeze: async () => { admitted = true; },
  };
  let admitted = true, live!: control.LiveFreezePorts;
  let handler!: Parameters<typeof sessionSocket.startSessionControlSocket>[2];
  vi.spyOn(sessionSocket, "startSessionControlSocket").mockImplementation(async (_root, _id, mounted) => { handler = mounted; return { async close() {} }; });
  vi.spyOn(sessionSocket, "requestSessionControl").mockImplementation(async (_root, operation) => {
    if (operation.kind !== "session-inspect") throw new Error(`Unexpected socket operation: ${operation.kind}`);
    return handler({ op: "inspect", operation });
  });
  const serve = control.serveSessionControl;
  vi.spyOn(control, "serveSessionControl").mockImplementation(async input => { live = input.ports; return serve(input); });
  const context = { cwd, mode: "tui", hasUI: true, ui: { getEditorText: () => "" }, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => file, getLeafId: () => "leaf-1", getHeader: () => ({ id: sessionId }) } };
  const inert = { async pause() {}, async resume() {} };
  const activate = () => createMoveActivation({ root: global.root, sessionId, file, context: () => context, gate, usage: inert, embeddings: inert, organism: inert, others: [], activity: { busy: () => false, bashRunning: () => false, promptOpen: () => false } } as never);
  const transport = { async resolve(peer: unknown) { return peer; }, async exec(_peer: unknown, argv: string[]) {
    const op: Operation = JSON.parse(argv[2]);
    const value = op.kind === "move-workspace-map" ? "/fixture/destination" : op.kind === "move-diagnostics" ? [] : (() => { throw new Error(`Unexpected remote operation: ${op.kind}`); })();
    return Buffer.from(JSON.stringify({ operationId: op.id, code: 0, epoch: op.expectedEpoch, value }));
  } };
  const compose = () => createHostMoveBindings({ root: global.root, globalDb: global.db, config, journal, sessionId, transport: transport as never, sync: { async sync() { return []; }, async barriers() { throw new Error("Unexpected remote barrier request"); } } });
  const startIdentity = processStartTime(process.pid)!, leases = createSessionLeases(join(global.root, "herdr"));
  const inventory = { presence: createProcessPresence(leases.root), leases, processes: async () => [], probe: async () => ({ kind: "live" as const, startIdentity }) };
  const locks = createBothLocks({ root: leases.root, file: async () => file, inventory, identity: { pid: process.pid, startIdentity } });
  return { global, config, worktree, sessionId, file, cwd, location, boundKeys, boundDbs, journal, machine, activate, compose, live: () => live, locks };
}

it.each([true, false])("activation completes the roster when the source exists before mapping: %s", async beforeMapping => {
  const f = await fixture(beforeMapping);
  let activation: Awaited<ReturnType<typeof f.activate>>;
  try {
    expect(f.location()).toEqual(beforeMapping ? [WORKTREE] : null);
    activation = await f.activate();
    expect(activation !== null).toBe(true);
    expect(f.location()).toEqual(ROSTER);
    expect(f.live().expectedStores).toEqual(ROSTER);
    expect(f.live().stores.map(db => (db.prepare("SELECT store_key FROM roam_meta WHERE id=1").get() as { store_key: string }).store_key)).toEqual(ROSTER);
    expect(readSessionState(f.worktree, f.sessionId)).toBeNull();
    expect(sessionHome(f.global.db, f.sessionId)).toBeNull();
  } finally { await activation!?.close(); await f.machine.close(); }
}, 10000);

it.each([true, false])("creation before mapping %s passes composed preflight, seed and complete freeze with a bound worktree", async beforeMapping => {
  const f = await fixture(beforeMapping, true);
  let activation: Awaited<ReturnType<typeof f.activate>>, mounted: Awaited<ReturnType<typeof f.compose>>;
  try {
    activation = await f.activate(); mounted = await f.compose();
    const expected = [...ROSTER, ...f.boundKeys];
    expect(f.location()!.toSorted()).toEqual(expected.toSorted());
    expect(f.live().expectedStores).toEqual(f.location());
    await f.locks(f.sessionId, async () => {
      const request = { sessionId: f.sessionId, destinationMachine: BOX, operation: { id: "first-move", kind: "move", machineId: HUB, expectedEpoch: 1, args: { sessionId: f.sessionId } } };
      expect((await f.live().inspect()).blockers).toEqual([]);
      const check = await mounted!.ports.check(request);
      expect(() => moveEvidence.checkReply(check, request)).not.toThrow();
      expect(check.storeKeys.toSorted()).toEqual(expected.toSorted());
      const barriers = await mounted!.ports.seed(check);
      expect(barriers.map(row => row.storeKey).toSorted()).toEqual(expected.toSorted());
      expect(await mounted!.ports.barriers(HUB, barriers)).toBe(true);
      for (const db of [f.worktree, ...f.boundDbs]) {
        expect(readSessionState(db, f.sessionId)).toMatchObject({ state: "active", epoch: 1 });
        expect(db.prepare("SELECT count(*) AS n FROM roam_seed_progress WHERE session_id=? AND complete=1").get(f.sessionId)).toEqual({ n: 4 });
        expect(db.prepare("SELECT count(*) AS n FROM roam_seed_progress WHERE session_id=? AND complete=0").get(f.sessionId)).toEqual({ n: 0 });
      }
      // Keep production freeze and stores; replace only the external intake and usage boundary.
      const live = f.live(); live.ingestThrough = async () => {};
      const op: Operation = { id: "freeze-source", kind: "session-freeze", machineId: HUB, expectedEpoch: 1, args: { sessionId: f.sessionId, moveId: "first-move" } };
      const ack = await freezeParticipant(op, live);
      expect(ack.barriers.map(row => row.storeKey).toSorted()).toEqual(expected.toSorted());
      expect(() => moveEvidence.freezeReply(check, { ...ack, barriers: ack.barriers.filter(row => row.storeKey !== "global") }, op)).toThrowError(expect.objectContaining({ refusal: expect.objectContaining({ code: "move-barrier-missing" }) }));
      for (const db of live.stores) {
        const key = (db.prepare("SELECT store_key FROM roam_meta WHERE id=1").get() as { store_key: StoreKey }).store_key;
        if (key.startsWith("worktree:")) expect(readSessionState(db, f.sessionId)?.state).toBe("frozen");
        else expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='roam_sessions'").all()).toEqual([]);
      }
    });
  } finally { await mounted!?.close(); await activation!?.close(); await f.machine.close(); }
}, 10000);

it("unactivated source composition completes a catalog roster without reopening or seeding", async () => {
  const f = await fixture(); let mounted: Awaited<ReturnType<typeof f.compose>>;
  try {
    expect(f.location()).toEqual([WORKTREE]); mounted = await f.compose();
    expect(mounted.bindings.participant!.stores.map(row => row.key)).toEqual(ROSTER);
    expect(f.location()).toEqual(ROSTER);
    expect(readSessionState(f.worktree, f.sessionId)).toBeNull();
    expect(sessionHome(f.global.db, f.sessionId)).toBeNull();
  } finally { await mounted!?.close(); await f.machine.close(); }
}, 10000);

it("dormant source composition completes a catalog roster before mounting its control", async () => {
  const f = await fixture(); let mounted: Awaited<ReturnType<typeof f.compose>>;
  try {
    f.global.db.prepare("INSERT INTO session_homes VALUES(?,?,1,NULL,1)").run(f.sessionId, HUB);
    mounted = await f.compose();
    const bindings = mounted.bindings, participant = bindings.participant!;
    expect(participant.stores.map(row => row.key)).toEqual(ROSTER);
    expect(f.location()).toEqual(ROSTER);
    expect(readSessionState(f.worktree, f.sessionId)).toBeNull();
    const home = sessionHome(f.global.db, f.sessionId);
    if (!home || home === "unknown") throw new Error("Fixture home unavailable");
    expect(seedSession(f.worktree, f.sessionId, 1, WORKTREE, f.config.limits.targetBatchBytes).complete).toBe(true);
    const evidence = bindings.evidence as MoveFreezeEvidenceBindings;
    const dormant = participant.dormant({ sessionId: f.sessionId, file: f.file, cwd: f.cwd, home, journal: f.journal,
      stores: participant.stores.map(row => row.db), expectedStores: f.location()!,
      intercom: { address: bindings.intercom!.address, ports: bindings.intercom!.ports }, evidence,
      authorizeAbort: evidence.authorizeAbort, authorizeRetire: evidence.authorizeRetire, onHubRestored: evidence.onHubRestored,
      retryAbort: async () => { throw new Error("Unexpected dormant abort"); } });
    expect(await dormant({ id: "dormant-inspect", kind: "session-inspect", machineId: HUB, expectedEpoch: 1,
      args: { sessionId: f.sessionId, moveId: "dormant-move", sourceMachine: HUB } })).toMatchObject({ code: 0, value: { blockers: [], owner: null } });
  } finally { await mounted!?.close(); await f.machine.close(); }
}, 10000);

it.each([
  ["activation", '["worktree:broken:"]'], ["composition", '["worktree:broken:"]'],
  ["activation", '["global","global"]'], ["composition", '["global","global"]'],
  ["activation", '[]'], ["composition", '[]'],
])("%s refuses invalid catalog keys: %s", async (path, stores) => {
  const f = await fixture();
  try {
    f.global.db.prepare("UPDATE roam_locations SET stores_json=? WHERE session_id=?").run(stores, f.sessionId);
    let reason: unknown;
    try { const mounted = await (path === "activation" ? f.activate() : f.compose()); await mounted?.close(); } catch (error) { reason = error; }
    expect(reason).toBeInstanceOf(Error);
    expect(readSessionState(f.worktree, f.sessionId)).toBeNull();
  } finally { await f.machine.close(); }
}, 10000);

it.each(["activation", "composition"])("%s refuses an unavailable required repository store before seed", async path => {
  const f = await fixture();
  try {
    f.global.db.prepare("DELETE FROM roam_repo_maps WHERE repo_key=?").run(REPO);
    let reason: unknown;
    try { const mounted = await (path === "activation" ? f.activate() : f.compose()); await mounted?.close(); } catch (error) { reason = error; }
    expect(reason).toBeInstanceOf(Error);
    expect((reason as Error).message).toBe("participant-stores-unavailable");
    expect(f.location()).toEqual([WORKTREE]);
    expect(readSessionState(f.worktree, f.sessionId)).toBeNull();
  } finally { await f.machine.close(); }
}, 10000);
