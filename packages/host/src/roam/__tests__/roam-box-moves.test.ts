import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { paths } from "@spider/db-core";
import { claimIdLock, localBootId } from "@spider/herdr/sessions/id-lock";
import { processStartTime } from "../../../../subagents/src/process-identity";
import * as coreRuntime from "@spider/roam/runtime";
import * as supervisor from "@spider/roam/production-supervisor";
import * as hcClient from "@spider/herdr/client/hc";
import * as moveRuntime from "../move-runtime";
import * as liveRuntime from "../live";
import { createMoveActivation } from "../move-activation";
import type { AdmissionGate } from "../admission";
import { writeLocal } from "@spider/db-core/roam/local-state";
import { recordLocation } from "@spider/db-core/roam/catalog";
import { enableMemoryCapture, seedSession } from "@spider/db-core/roam/seed";
import type { Home, HubOperationReadiness, Probe, StoreKey } from "@spider/db-core/roam/types";
import { DEFAULT_LIMITS, disabledIntercom, type Operation, type RoamConfig, type Transport } from "@spider/roam/contracts";
import { openFreezeJournal } from "@spider/roam/journal";
import { assignInitialHome, sessionHome } from "@spider/roam/homes";
import { readLocalIdentity } from "@spider/roam/runtime";
import { createStorePort } from "@spider/roam/stores";
import { handleAgentOperation } from "@spider/roam/agent";
import { handleArtifactRequest } from "@spider/roam/artifacts";
import { openStaging } from "@spider/roam/staging";
import { createBothLocks, createRunningIntentAuthority, recordReadiness } from "@spider/roam/session-control";
import { createSessionLeases } from "@spider/herdr/sessions/lease";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { snapshotWorkspace } from "@spider/roam/workspace";
import { moveSession } from "@spider/roam/move";
import { createRollbackIntercomPorts, readPushedRollbackEvidence } from "@spider/roam/move-ports";
import { cancelMove, recoverMove } from "@spider/roam/move-recovery";
import { createDormantControl } from "../control";
import { createHostMoveBindings, type HostMoveRuntime } from "../move-runtime";

const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002", OTHER = "00000000-0000-4000-8000-000000000003";
const SESSION = "session-a", WT: StoreKey = "worktree:fixture-repo:fixture-workspace";
const closes: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } }).toString().trim();
}
async function network(destination: string, liveSource = false) {
  const machines = new Map<string, { global: ReturnType<typeof createReplica>; worktree: ReturnType<typeof createReplica>; config: RoamConfig; runtime: HostMoveRuntime; journal: ReturnType<typeof openFreezeJournal>; repo: string; file: string }>();
  const calls: Operation[] = [], boxDials: string[] = [], removedViews: string[] = [];
  const ids = destination === HUB ? [HUB, BOX] : [HUB, BOX, OTHER];
  const initial = new Map<string, { global: ReturnType<typeof createReplica>; worktree: ReturnType<typeof createReplica>; repo: string; file: string }>();
  for (const id of ids) {
    const global = createReplica("global", id), worktree = createReplica("worktree", id), repository = createReplica("repo", id);
    if (liveSource && id === BOX) {
      global.root = mkdtempSync(join(resolve(".spider/scratch"), "b-"));
      closes.push(() => rmSync(global.root, { recursive: true, force: true }));
    }
    closes.push(() => global.close(), () => worktree.close(), () => repository.close());
    const repo = join(global.root, "checkout"), agentDirectory = join(global.root, "agent");
    const sessions = join(agentDirectory, "sessions", `--${repo.replace(/^\//, "").replace(/\//g, "-")}--`);
    const file = join(sessions, "session.jsonl");
    mkdirSync(repo); mkdirSync(sessions, { recursive: true }); mkdirSync(join(global.root, "roam"), { mode: 0o700 });
    mkdirSync(join(global.root, "herdr"), { mode: 0o700 });
    writeFileSync(join(global.root, "herdr", "config.json"), JSON.stringify({ mode: "core-only", globalRoot: global.root,
      core: { binary: "/fixture/hc", config: join(global.root, "core.json") }, agentDirectory,
      shellRc: join(global.root, "rc"), machines: [] }), { mode: 0o600 });
    if (id === HUB) {
      git(repo, ["init", "-q", "--initial-branch=main"]); writeFileSync(join(repo, "tracked.txt"), "fixture\n"); git(repo, ["add", "."]); git(repo, ["commit", "-q", "-m", "fixture"]); git(repo, ["remote", "add", "origin", repo]);
    } else git(repo, ["clone", "-q", initial.get(HUB)!.repo, "."]);
    enableMemoryCapture(global.db, "global"); worktree.db.prepare("UPDATE roam_meta SET store_key=? WHERE id=1").run(WT);
    global.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES(?,?,?,1,1)").run("fixture", repo, worktree.db.raw.name);
    writeLocal(global.db, "mapping-redirect", WT, worktree.db.raw.name);
    repository.db.prepare("UPDATE roam_meta SET store_key='repo:fixture-repo' WHERE id=1").run();
    enableMemoryCapture(repository.db, "repo:fixture-repo");
    writeLocal(global.db, "mapping-redirect", "repo:fixture-repo", repository.db.raw.name);
    global.db.prepare("INSERT INTO roam_repo_maps(repo_key,path) VALUES('fixture-repo',?)").run(repo);
    global.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path,snapshot_json) VALUES('fixture-repo','fixture-workspace',?,NULL)").run(repo);
    initial.set(id, { global, worktree, repo, file });
  }
  const source = initial.get(BOX)!;
  source.worktree.db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES(?,1,?)").run(SESSION, BOX);
  seedSession(source.worktree.db, SESSION, 1, WT, 1);
  writeFileSync(source.file, JSON.stringify({ type: "session", version: 3, id: SESSION, cwd: source.repo, timestamp: "2026-01-01T00:00:00Z" }) + "\n" + JSON.stringify({ type: "message", id: "leaf-a", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "fixture", timestamp: 1 } }) + "\n", { mode: 0o600 });
  const home = assignInitialHome(initial.get(HUB)!.global.db, SESSION, BOX, HUB) as Home;
  for (const row of initial.values()) recordLocation(row.global.db, { sessionId: SESSION, stores: ["global", "repo:fixture-repo", WT], home, file: row.file, cwd: row.repo });
  const peer = (id: string) => ({ machineId: id, alias: id === BOX ? "box-1.invalid" : "box-2.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/spider", core: "/fixture/hc", globalRoot: initial.get(id)!.global.root });
  const transport: Transport = {
    async resolve(peer) { return peer; }, async read(_peer, file) { return readFileSync(file); },
    async write() { throw new Error("unexpected write"); }, async run() { throw new Error("unexpected run"); }, async bootstrapProbe() { throw new Error("unexpected bootstrap"); },
    async exec(peer, argv, options) {
      const target = machines.get(peer.machineId)!;
      if (argv[1] === "artifact") {
        const staging = openStaging(join(target.global.root, "roam", "staging"), HUB, DEFAULT_LIMITS);
        try { return await handleArtifactRequest(JSON.parse(argv[3]), options.stdin, { store: staging, journal: target.runtime.ports.journal, machineId: peer.machineId, limits: DEFAULT_LIMITS }); }
        finally { staging.close(); }
      }
      const operation = JSON.parse(argv[2]) as Operation; calls.push(operation);
      const stores = createStorePort(target.config, target.global.db);
      try { return Buffer.from(JSON.stringify(await handleAgentOperation(operation, { config: target.config, journal: target.runtime.ports.journal, root: join(target.global.root, "roam", "staging"), openStore: stores.openStore, move: op => target.runtime.dispatch(op) }))); }
      finally { stores.close(); }
    },
  };
  for (const [id, row] of initial) {
    const rawConfig: RoamConfig = { enabled: true, role: id === HUB ? "hub" : "box", machineId: id, hubMachineId: HUB, peers: id === HUB ? ids.filter(other => other !== HUB).map(peer) : [], discoveryRoots: [], coreUnit: "fixture.service", syncMs: 120000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
    writeFileSync(join(row.global.root, "roam", "config.json"), JSON.stringify(rawConfig), { mode: 0o600 });
    writeFileSync(join(row.global.root, "roam", "machine.json"), JSON.stringify({ machineId: id }), { mode: 0o600 });
    const config = readLocalIdentity(row.global.root);
    const journal = openFreezeJournal(join(row.global.root, "roam", "journal.db"));
    const runtime = await createHostMoveBindings({ root: row.global.root, globalDb: row.global.db, config, journal, sessionId: SESSION,
      transport: id === HUB ? transport : { ...transport, async resolve() { boxDials.push(id); throw new Error("box cannot dial hub"); } } });
    closes.push(() => runtime.close());
    machines.set(id, { ...row, config, runtime, journal });
    const bindings = runtime.bindings, participant = bindings.participant!, authority = createRunningIntentAuthority(row.global.db);
    let owner: Probe = { kind: "absent" }, ready: HubOperationReadiness | null = null;
    const leases = createSessionLeases(join(row.global.root, "herdr")), inventory = { leases, presence: createProcessPresence(leases.root), processes: async () => [], probe: async () => ({ kind: "live" as const, startIdentity: "fixture-process" }) };
    participant.withBothLocks = createBothLocks({ root: leases.root, inventory, file: async () => row.file, identity: { pid: 900, startIdentity: "fixture-process" }, bootId: async () => "fixture-boot" });
    participant.probe = async () => owner; participant.auth = async () => []; participant.writers = async () => [];
    participant.sessionTarget = async () => row.file;
    participant.cleanupTerminal = async (operation, locks) => {
      if (!await locks?.owns() || (operation.args.presentation as { status?: string })?.status !== "complete") throw new Error("terminal-cleanup-unproved");
      removedViews.push(id);
    };
    participant.dormant = context => createDormantControl({ ...context, blockerPorts: { sessionId: SESSION, address: { sessionId: SESSION, scopeId: null }, activity: { busy: () => false, bashRunning: () => false, promptOpen: () => false }, broker: context.evidence.broker.inspectFreezeBlockers.bind(context.evidence.broker), bridge: context.evidence.bridge, localRoutes: async () => [], topLevelJobs: async () => [], childJobs: async () => [], localJobs: async () => [] }, ingestThrough: async () => {} });
    participant.wake = async request => {
      const intent = await authority.get(request.sessionId); if (!intent || authority.operationId(SESSION) !== request.operationId || intent.desired !== "running") return { ok: false, reason: "participant-intent-unavailable" };
      const launchId = `launch-${request.operationId}`;
      if (!ready) {
        owner = { kind: "live", identity: { pid: 42, startTime: "fixture-session", bootId: "fixture-boot" } };
        ready = { origin: "hub-operation", opId: launchId, sessionId: SESSION, epoch: intent.epoch, file: intent.file, cwd: intent.cwd, core: "fixture-core", terminal: "fixture-terminal" };
        journal.begin({ id: launchId, kind: "exact-session-launch", machineId: id, expectedEpoch: intent.epoch, args: {} }); recordReadiness(journal, ready);
      }
      return { ok: true, launchId };
    };
    participant.readiness = async query => ready && owner.kind === "live" && query.sessionId === SESSION && query.launchId === ready.opId && query.epoch === ready.epoch ? ready : null;
    participant.observation = async observedHome => ({ home: sessionHome(row.global.db, SESSION) as Home, owner, readiness: ready && owner.kind === "live" && ready.epoch === observedHome.epoch ? { ...ready, opId: authority.operationId(SESSION)! } : null, launchFailure: null, retired: (row.worktree.db.prepare("SELECT state FROM roam_sessions WHERE session_id=?").get(SESSION) as { state: string } | undefined)?.state === "retired" });
    const empty = () => ({ asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] });
    bindings.evidence!.bridge = empty; bindings.evidence!.broker = { inspectFreezeBlockers: async () => empty() };
    bindings.intercom!.ports = { close: async (address, moveId, expectedEpoch, generation) => ({ address, moveId, expectedEpoch, generation: generation ?? "fixture-fence" }), drain: async () => {}, inspect: async () => ({ blockers: [], cancelledWork: [], warnings: [] }), checkGeneration: async () => {}, abort: async () => {}, ready: async () => ({ intercomAddress: SESSION, warnings: [] }) };
    bindings.intercom!.destinationEndpoint = async current => ({ address: { sessionId: SESSION, scopeId: null }, machineId: current.machineId, homeEpoch: current.epoch, activationEpoch: "fixture-activation" });
    bindings.power = { pid: 900, onExit: () => () => {}, notice() {}, spawn: async () => ({ exited: Promise.resolve(), stop: async () => {} }) };
    bindings.handoff!.prepareHandoff = async () => ({ capture: "durable", presentation: { status: "pending", reason: "app-absent", presentation: null } });
    bindings.handoff!.presentReadyTarget = async () => ({ status: "complete", reason: "presented", presentation: null });
    bindings.handoff!.readyTarget = async current => {
      const target = machines.get(current.machineId)!, targetAuthority = createRunningIntentAuthority(target.global.db), intent = await targetAuthority.get(SESSION);
      return intent?.epoch === current.epoch ? { machineId: current.machineId, alias: null, sessionId: SESSION, homeEpoch: current.epoch, coreId: "fixture-core", terminalId: "fixture-terminal" } : null;
    };
    journal.begin({ id: "baseline", kind: "workspace-snapshot", machineId: id, expectedEpoch: null, args: {} });
    const snapshot = await snapshotWorkspace({ root: row.repo, cwd: row.repo, repoKey: "fixture-repo", workspaceId: "fixture-workspace", moveId: "baseline", stage: "final", writers: [] }, { ...participant.git, journal, limits: DEFAULT_LIMITS });
    row.global.db.prepare("UPDATE roam_workspace_maps SET snapshot_json=?").run(JSON.stringify(snapshot));
  }
  await machines.get(HUB)!.runtime.bindings.sync!.sync();
  // The hub's local catalog supplies its mapped paths, while participant files remain machine-local.
  const hub = machines.get(HUB)!;
  recordLocation(hub.global.db, { sessionId: SESSION, stores: ["global", "repo:fixture-repo", WT], home, file: source.file, cwd: source.repo });
  hub.runtime.bindings.mapping = async () => ({ repoKey: "fixture-repo", workspaceId: "fixture-workspace", sourceRoot: source.repo, destinationRoot: initial.get(destination)!.repo, destinationCwd: initial.get(destination)!.repo });
  const live = liveSource ? await activateLiveSource(machines.get(BOX)!) : null;
  return { machines, hub, source: machines.get(BOX)!, destination: machines.get(destination)!, boxDials, calls, removedViews, live };
}

async function activateLiveSource(source: { global: ReturnType<typeof createReplica>; runtime: HostMoveRuntime; journal: ReturnType<typeof openFreezeJournal>; repo: string; file: string }) {
  const root = source.global.root, participant = source.runtime.bindings.participant!;
  const identity = { pid: process.pid, startIdentity: processStartTime(process.pid)! }, bootId = await localBootId();
  const leases = createSessionLeases(join(root, "herdr")), inventory = { leases, presence: createProcessPresence(leases.root), processes: async () => [], probe: async () => ({ kind: "live" as const, startIdentity: identity.startIdentity }) };
  const lease = await leases.claim(source.file, identity, inventory, { mode: "cutover", bootId });
  const lock = await claimIdLock(leases.root, SESSION, identity, inventory.probe, { bootId: async () => bootId });
  closes.push(async () => { await lock.release(); await leases.release(source.file, lease.token); });
  const owner = await liveRuntime.inspectLiveOwner(leases.root, SESSION, source.file);
  participant.probe = async () => ({ kind: "live", identity: owner });
  participant.wake = async () => { throw new Error("live source must not relaunch"); };
  const intercom = source.runtime.bindings.intercom!;
  intercom.rollback = createRollbackIntercomPorts({ journal: source.journal, address: intercom.address,
    proof: operation => readPushedRollbackEvidence(source.global.db, participant.config, operation),
    broker: { intake: async (_action, fence) => fence.generation }, bridge: { resumeIntake() {} } });
  let admitted = true;
  const gate: AdmissionGate = {
    inspect: () => ({ kind: admitted ? "ordinary" : "control-only", home: sessionHome(source.global.db, SESSION) as Home, blockers: [] }),
    refreshInitialHome: async () => gate.inspect(), whenSettled: async () => gate.inspect(), close: async () => { admitted = false; },
    freeze: async () => { admitted = false; }, unfreeze: async () => { admitted = true; }, readmit: async () => { admitted = true; },
  };
  const context = { cwd: source.repo, mode: "print", hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => SESSION, getSessionFile: () => source.file, getLeafId: () => "leaf-a" } };
  for (const directory of [paths.scratch("project", source.repo), paths.scratch("global"), join(root, "herdr", "jobs")]) mkdirSync(directory, { recursive: true });
  // Reuse the fixture stores and already production-composed runtime for the in-process pi.
  const open = vi.spyOn(coreRuntime, "openLocalCore").mockReturnValue({ db: source.global.db, close() {} } as never);
  const capture = vi.spyOn(supervisor, "participantCaptureReady").mockReturnValue(true);
  const mount = vi.spyOn(moveRuntime, "createHostMoveBindings").mockResolvedValue(source.runtime);
  const createLive = liveRuntime.createLiveFreezePorts;
  const live = vi.spyOn(liveRuntime, "createLiveFreezePorts").mockImplementation(input => ({ ...createLive({ ...input, routeStores: input.routeStores.filter(db => db.prepare("SELECT 1 FROM sqlite_master WHERE name='message_mirror'").get()), usageRoots: {
    registryDb: join(root, "spider.db"), ledgerFile: join(root, "usage.db"), sessionsDir: join(root, "agent", "sessions"), authPath: join(root, "agent", "auth.json"), leaseDir: join(root, "usage-leases"),
  } }), ingestThrough: async () => {} }));
  const caller = vi.spyOn(hcClient, "createHcClient").mockReturnValue({ caller: async () => ({ coreId: "fixture-core", address: "fixture-terminal" }), dispose: async () => {} } as never);
  const producer = { pause() {}, resume() {} };
  let activation: Awaited<ReturnType<typeof createMoveActivation>>;
  try { activation = await createMoveActivation({ root, sessionId: SESSION, file: source.file, context: () => context as never, gate,
    activity: { busy: () => false, bashRunning: () => false, promptOpen: () => false }, usage: producer, embeddings: producer, organism: producer, others: [] }); }
  finally { open.mockRestore(); capture.mockRestore(); mount.mockRestore(); live.mockRestore(); }
  if (!activation) throw new Error("live activation unavailable");
  closes.push(async () => { await activation.close(); caller.mockRestore(); });
  return { admitted: () => admitted, owner };
}

let current: Awaited<ReturnType<typeof network>>;
const operation: Operation = { id: "move-box", kind: "move", machineId: HUB, expectedEpoch: 1, args: { sessionId: SESSION } };
beforeEach(async context => { current = await network(context.task.name.includes("another box") ? OTHER : HUB, context.task.name.includes("live original")); }, 5000);
// Crash checkpoints keep each real-artifact phase below the unit-test ceiling.
for (const checkpoint of ["seed", "prestage", "transfer"]) beforeEach(async () => {
  const journal = current.hub.runtime.ports.journal, record = journal.record;
  journal.record = (id, action, value) => { record(id, action, value); if (action === "move-action-complete" && value.action === checkpoint) throw new Error("fixture-interrupted"); };
  try {
    if (checkpoint === "seed") await moveSession({ operation: { ...operation, args: { sessionId: SESSION, destinationMachine: current.destination.config.machineId } }, sessionId: SESSION, destinationMachine: current.destination.config.machineId }, current.hub.runtime.ports);
    else await recoverMove(operation.id, current.hub.runtime.ports);
  } finally { journal.record = record; }
}, 5000);

// A configuration change after the recorded check must not strand a frozen move.
// Keep the transcript in place so all freeze hashes and ownership proofs stay valid.
beforeEach(async context => {
  const f = current.source;
  if (!context.task.name.endsWith("with changed folder policy")) {
    await expect(f.runtime.bindings.checkSessionFile!(f.file)).resolves.toBeUndefined();
    return;
  }
  const file = join(f.global.root, "herdr", "config.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  config.agentDirectory = join(f.global.root, "replacement-agent");
  mkdirSync(join(config.agentDirectory, "sessions"), { recursive: true });
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  await expect(f.runtime.bindings.checkSessionFile!(f.file)).rejects.toMatchObject({ code: "move-session-dir-unsupported" });
});

it.each(["unchanged", "changed"])("a production-composed box source rolls back to its live original process with %s folder policy", async () => {
  const f = current, participant = f.destination.runtime.bindings.participant!, before = readFileSync(f.source.file, "utf8");
  participant.wake = async () => ({ ok: false, reason: "fixture-proved-no-start" });
  const observe = participant.observation;
  participant.observation = async (...args) => {
    const observation = await observe(...args);
    return { ...observation, launchFailure: "proved-no-start:fixture-launch", activationCancelled: observation.retired };
  };
  expect(f.live!.admitted()).toBe(false);
  expect((await recoverMove(operation.id, f.hub.runtime.ports)).code).toBe(3);
  const result = await recoverMove(operation.id, f.hub.runtime.ports);
  expect(result).toMatchObject({ code: 0, reason: "rolled-back" });
  expect(sessionHome(f.hub.global.db, SESSION)).toMatchObject({ machineId: BOX, epoch: 3 });
  expect(f.source.worktree.db.prepare("SELECT state,epoch FROM roam_sessions WHERE session_id=?").get(SESSION)).toEqual({ state: "active", epoch: 3 });
  expect(f.live!.admitted()).toBe(true);
  expect(await f.source.runtime.bindings.participant!.probe(SESSION)).toEqual({ kind: "live", identity: f.live!.owner });
  expect(readFileSync(f.source.file, "utf8")).toBe(before);
  expect(f.boxDials).toEqual([]);
}, 5000);

it.each(["unchanged", "changed"])("a production-composed frozen box source cancels without dialing the hub with %s folder policy", async () => {
  const f = current;
  expect(await cancelMove(operation.id, f.hub.runtime.ports)).toMatchObject({ code: 0, reason: "cancelled" });
  expect(sessionHome(f.hub.global.db, SESSION)).toMatchObject({ machineId: BOX, epoch: 1 });
  expect(f.source.worktree.db.prepare("SELECT state,epoch FROM roam_sessions WHERE session_id=?").get(SESSION)).toEqual({ state: "active", epoch: 1 });
  expect(f.calls.some(op => op.kind === "session-unfreeze" && op.args.hubEvidence)).toBe(true);
  expect(f.boxDials).toEqual([]);
}, 5000);

it.each([
  ["the hub", "unchanged"], ["another box", "unchanged"],
  ["the hub", "changed"], ["another box", "changed"],
])("a production-composed box source completes a move to %s without outbound peers with %s folder policy", async () => {
  const f = current;
  const result = await recoverMove(operation.id, f.hub.runtime.ports);
  expect(result).toMatchObject({ code: 0, reason: "moved" });
  expect(sessionHome(f.hub.global.db, SESSION)).toMatchObject({ machineId: f.destination.config.machineId, epoch: 2 });
  expect(f.source.worktree.db.prepare("SELECT state,epoch FROM roam_sessions WHERE session_id=?").get(SESSION)).toEqual({ state: "retired", epoch: 1 });
  expect(f.destination.worktree.db.prepare("SELECT state,epoch FROM roam_sessions WHERE session_id=?").get(SESSION)).toEqual({ state: "active", epoch: 2 });
  expect(readFileSync(f.destination.file, "utf8")).toContain("spider-roam-segment");
  expect(f.calls.some(op => op.kind === "session-retire" && op.args.hubEvidence)).toBe(true);
  expect(f.calls.some(op => op.kind === "move-cleanup" && op.machineId === BOX && op.args.hubEvidence)).toBe(true);
  expect(f.removedViews).toEqual([BOX]);
  expect(f.boxDials).toEqual([]);
}, 5000);
