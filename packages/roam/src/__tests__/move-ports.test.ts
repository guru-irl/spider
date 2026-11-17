import * as sessionFiles from "../session-file";
import { readLocal } from "@spider/db-core/roam/local-state";
import { isDeepStrictEqual } from "node:util";
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createReplica, scratchDbPath } from "@spider/db-core/testutil";
import { openDb } from "@spider/db-core";
import { seedSession, enableMemoryCapture } from "@spider/db-core/roam/seed";
import { writeLocal } from "@spider/db-core/roam/local-state";
import { recordLocation } from "@spider/db-core/roam/catalog";
import { createStorePort } from "../stores";
import { createSync } from "../sync";
import { handleAgentOperation } from "../agent";
import { appendMirror } from "../mirrors";
import { forgetMachine } from "../forget";
import { moveSession } from "../move";
import type { Home, HubOperationReadiness, JsonObject, Probe, StoreKey } from "@spider/db-core/roam/types";
import { createSessionLeases } from "@spider/herdr/sessions/lease";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { createBothLocks, createRunningIntentAuthority, readReadiness, recordReadiness } from "../session-control";
import { startSessionControlSocket } from "../session-socket";
import { createDormantControl, serveSessionControl } from "../../../host/src/roam/control";
import { registerAdmission } from "../../../host/src/roam/admission";
import { createHostSessionFixture } from "../../../host/src/__tests__/fixtures/pi-events";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readSessionState } from "@spider/db-core/roam/state";
import { DEFAULT_LIMITS, disabledIntercom } from "../contracts";
import type { FreezeAck, MoveCheck, Operation, PreparedMove, PreparedWorkspace, RoamConfig, Transport } from "../contracts";
import { assignInitialHome, casHome, sessionHome, cancelHomeAction } from "../homes";
import { openFreezeJournal } from "../journal";
import { inspectSession, stageSession, verifyFrozenSession } from "../session-file";
import { snapshotWorkspace } from "../workspace";
import { stageArtifact, handleArtifactRequest } from "../artifacts";
import { openStaging, sourceChunk, openOutgoingStaging } from "../staging";
import { abortCleanupId, cancelMove, recoverMove, rollbackMoveId } from "../move-recovery";
import { createProductionRecoveryPorts } from "../recovery-transport";
import { createMovePorts, handleMoveParticipantOperation, unboundMoveEffects, recoverMoveAdapters, createMoveWorkspacePorts, readRollbackEvidence, createRollbackIntercomPorts, createHubMoveEvidencePorts, createPushedMoveEvidencePorts, forgetMachineWithAdapters } from "../move-ports";
import type { MoveAdapterBindings } from "../move-ports";

const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002";
const REPO = "repo:fixture-repo" as StoreKey;
const SESSION = "session-a", WT = "worktree:fixture-repo:fixture-workspace" as StoreKey;
const roots: string[] = [], closes: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const unused = async (): Promise<never> => { throw new Error("Unexpected external call"); };
function git(cwd: string, argv: readonly string[], options?: { env?: Readonly<NodeJS.ProcessEnv>; stdin?: Buffer }): Buffer {
  return execFileSync("git", argv[0] === "git" ? argv.slice(1) : [...argv], { cwd, input: options?.stdin, env: { ...process.env,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", ...options?.env }, stdio: ["pipe", "pipe", "pipe"] });
}
async function fixture(worktreeMachine = HUB, homeless = false) {
  const root = mkdtempSync(join(dirname(scratchDbPath("move-ports")), "mp-")); roots.push(root);
  const global = createReplica("global", HUB), worktree = createReplica("worktree", worktreeMachine), repository = createReplica("repo", HUB); closes.push(() => global.close(), () => worktree.close(), () => repository.close());
  const repo = join(root, "repo"); mkdirSync(repo); git(repo, ["init", "-q", "--initial-branch=main"]);
  writeFileSync(join(repo, "tracked.txt"), "fixture\n"); git(repo, ["add", "."]); git(repo, ["commit", "-q", "-m", "fixture"]);
  const file = join(root, "original.jsonl"); writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: SESSION, cwd: repo, timestamp: "2026-01-01T00:00:00Z" }) + "\n" +
    JSON.stringify({ type: "message", id: "leaf-a", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "fixture", timestamp: 1 } }) + "\n", { mode: 0o600 });
  worktree.db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES(?,?,?)").run(SESSION, 1, HUB);
  if (!homeless) seedSession(worktree.db, SESSION, 1, WT, 100);
  enableMemoryCapture(global.db, "global"); enableMemoryCapture(repository.db, REPO);
  const home: Home = homeless ? { sessionId: SESSION, machineId: HUB, epoch: 1, moveId: null, updatedAt: 0 } : assignInitialHome(global.db, SESSION, HUB, HUB) as Home;
  recordLocation(global.db, { sessionId: SESSION, stores: ["global", REPO, WT], home: homeless ? null : home, file, cwd: repo });
  const journalFile = join(root, "journal.db"), journal = openFreezeJournal(journalFile), privateDb = openDb(journalFile); closes.push(() => privateDb.close());
  let ready: HubOperationReadiness | null = null, readinessOwner: Probe | null = null;
  let owner: Probe = { kind: "absent" }, activationCancelled = false, retired = false, launchFailure: string | null = null;
  const events: string[] = [], remoteOperations: Operation[] = [], targets: unknown[] = [];
  const config: RoamConfig = { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [{ machineId: BOX, alias: "box-1.invalid", node: "/bin/node", pi: "/bin/pi", cli: "/bin/spider", core: "fixture-core", globalRoot: root }],
    discoveryRoots: [], coreUnit: "fixture-core.service", syncMs: 1000, limits: { ...DEFAULT_LIMITS }, intercom: disabledIntercom() };
  const sourceManifest = await inspectSession(file, SESSION);
  const operation: Operation = { id: "move-a", kind: "move", machineId: HUB, expectedEpoch: 1, args: { sessionId: SESSION, destinationMachine: BOX } };
  journal.begin(operation);
  const address = { sessionId: SESSION, scopeId: "fixture-scope" }, fence = { address, moveId: operation.id, expectedEpoch: home.epoch, generation: "fence-a" };
  let heldFence = fence, reopened = false;
  const inventory = { leases: createSessionLeases(join(root, "herdr")), presence: createProcessPresence(join(root, "herdr")), processes: async () => [],
    probe: async (pid: number) => pid === 900 ? { kind: "live" as const, startIdentity: "fixture-lock" } : { kind: "absent" as const } };
  const withBothLocks = createBothLocks({ root: inventory.leases.root, file: async () => file, inventory,
    identity: { pid: 900, startIdentity: "fixture-lock" }, bootId: async () => "fixture-boot" });
  const authority = createRunningIntentAuthority(global.db);
  const bindings: MoveAdapterBindings = {
    globalDb: global.db, privateDb, root, clock: { now: () => 1, later: () => () => {} },
    power: { pid: 900, spawn: async () => { events.push("power"); return { exited: Promise.resolve(), stop: async () => { events.push("power-release"); } }; }, onExit: () => () => {}, notice: () => {} },
    sync: { sync: async () => { events.push("sync"); return []; }, barriers: async () => true },
    stores: { open: key => key === "global" ? global.db : key === WT ? worktree.db : key === REPO ? repository.db : (() => { throw new Error("Unknown store"); })(),
      head: key => { const db = key === "global" ? global.db : key === REPO ? repository.db : worktree.db; const meta = db.prepare("SELECT stream_id FROM roam_meta WHERE id=1").get() as { stream_id: string }; return { storeKey: key, stream: meta.stream_id, through: 0 }; } },
    mapping: async () => ({ repoKey: "fixture-repo", workspaceId: "fixture-workspace", sourceRoot: repo, destinationRoot: repo, destinationCwd: repo }),
    participant: {
      pi: "/fixture/pi", config, globalDb: global.db, root, runtimeRoot: join(process.cwd(), ".spider", "scratch", "mps"),
      stores: [{ key: "global", db: global.db }, { key: REPO, db: repository.db }, { key: WT, db: worktree.db }], withBothLocks,
      probe: async () => owner,
      git: { async run(cwd, argv, options) { return git(cwd, argv, options); }, scratch: join(root, "git"), worktreeCommand: null },
      writers: async () => [],
      sessionTarget: async () => join(root, "installed", "exact.jsonl"), auth: async () => [],
      identityCurrent: async () => true,
      async wake({ sessionId, operationId }) {
        const intent = await authority.get(sessionId);
        if (!intent || intent.desired !== "running" || intent.suspended || sessionId !== SESSION) return { ok: false, reason: "participant-intent-unavailable" };
        const launchId = `launch-${operationId}`;
        if (!ready) {
          events.push("wake");
          owner = { kind: "live", identity: { bootId: "fixture-boot", pid: 42, startTime: "fixture-owner" } };
          readinessOwner = owner;
          ready = { origin: "hub-operation", opId: launchId, sessionId, epoch: intent.epoch, file: intent.file, cwd: intent.cwd, terminal: "terminal-a", core: "core-a" };
          journal.begin({ id: launchId, kind: "exact-session-launch", machineId: config.machineId, expectedEpoch: intent.epoch, args: { sessionId } });
          recordReadiness(journal, ready);
        }
        return { ok: true, launchId };
      },
      async readiness(query) {
        const intent = await authority.get(query.sessionId);
        return ready && owner.kind === "live" && isDeepStrictEqual(owner, readinessOwner) && query.sessionId === SESSION && ready.opId === query.launchId && ready.epoch === query.epoch && intent?.epoch === query.epoch && intent.file === ready.file && intent.cwd === ready.cwd ? ready : null;
      },
      observation: async h => ({ home: h, owner, readiness: ready && owner.kind === "live" && ready.epoch === h.epoch ? { ...ready, opId: authority.operationId(SESSION)! } : null, launchFailure, retired, activationCancelled }),
      dormant: context => createDormantControl({ ...context, blockerPorts: { sessionId: SESSION, address, activity: { busy: () => false, bashRunning: () => false, promptOpen: () => false },
        broker: a => context.evidence.broker.inspectFreezeBlockers(a), bridge: context.evidence.bridge,
        localRoutes: async () => [], topLevelJobs: async () => [], childJobs: async () => [], localJobs: async () => [] },
        ingestThrough: async () => { events.push("ingest"); } }),
      retireFailed: async () => { events.push("retire-failed"); retired = true; activationCancelled = true; return { kind: "absent" }; },
      readmitLive: async () => { events.push("readmit-live"); return null; },
      cleanupTerminal: async operation => {
        if ((operation.args.presentation as { status?: string } | undefined)?.status !== "complete") throw new Error("destination-presentation-pending");
        events.push("terminal-cleanup");
      },
    },
    evidence: { authorizeAbort: async () => null, onHubRestored: () => () => {}, authorizeRetire: async () => null,
      bridge: async () => ({ asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] }), settlement: async () => null,
      broker: { inspectFreezeBlockers: async () => ({ asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] }) },
      rollback: async op => readRollbackEvidence(global.db, journal, op) },
    intercom: { address, ports: { close: async (_address, _moveId, _epoch, generation) => ({ address: _address, moveId: _moveId, expectedEpoch: _epoch, generation: generation ?? fence.generation }), drain: async () => {}, inspect: async () => ({ blockers: [], cancelledWork: [], warnings: [] }),
      checkGeneration: async () => {}, abort: async () => { events.push("abort-intake"); }, ready: async () => ({ intercomAddress: SESSION, warnings: [] }) },
      destinationEndpoint: async h => ({ address, machineId: h.machineId, homeEpoch: h.epoch, activationEpoch: "endpoint-a" }),
      rollback: { currentFence: async () => heldFence, reopen: async () => { events.push("reopen"); reopened = true; } } },
    handoff: { prepareHandoff: async input => { events.push("handoff"); expect(input.placementRoot).toBe(join(root, "roam", "placement")); return { capture: "durable", presentation: { status: "complete", reason: "captured", presentation: null } }; },
      readyTarget: async h => {
        const launch = journal.read(`${h.moveId}-session-start-${h.machineId}`).find(row => row.action === "participant-launch")?.result as unknown as import("../move-ports").ParticipantReadinessQuery | undefined;
        const ready = launch ? await bindings.participant!.readiness(launch) : null;
        return ready ? { machineId: h.machineId, alias: null, sessionId: ready.sessionId, homeEpoch: ready.epoch, coreId: ready.core, terminalId: ready.terminal } : null;
      },
      presentReadyTarget: async target => { targets.push(target); events.push("present"); return { status: "complete", reason: "presented", presentation: null }; } },
    recovery: { workspaceRestores: async () => [], mirrorRoot: join(root, "mirrors"), restoreWorkspace: async () => null, conflicts: async () => [] },
  };
  const transport: Transport = { resolve: async p => p, bootstrapProbe: unused, run: unused, read: unused, write: unused,
    exec: async (_peer, argv) => {
      const op = JSON.parse(argv[2]) as Operation; remoteOperations.push(op);
      return Buffer.from(JSON.stringify(await handleMoveParticipantOperation(op, journal, op.kind === "move-diagnostics" ? { ...bindings, participant: { ...bindings.participant!, config: { ...config, machineId: op.machineId, role: "box" } } } : bindings)));
    } };
  Object.assign(bindings.recovery!, createProductionRecoveryPorts({ root, config, globalDb: global.db, journal, transport }));
  const ports = createMovePorts(config, transport, journal, bindings);
  bindings.evidence!.presentation = createHubMoveEvidencePorts(ports, bindings.evidence!).presentation;
  global.db.prepare("INSERT OR IGNORE INTO roam_repo_maps(repo_key,path) VALUES(?,?)").run("fixture-repo", repo);
  global.db.prepare("INSERT OR IGNORE INTO roam_workspace_maps(repo_key,workspace_id,path,snapshot_json) VALUES(?,?,?,NULL)").run("fixture-repo", "fixture-workspace", repo);
  const head = git(repo, ["rev-parse", "HEAD"]).toString().trim(), tree = git(repo, ["rev-parse", "HEAD^{tree}"]).toString().trim();
  const sourceWorkspace: PreparedWorkspace = { root: repo, moveId: operation.id, previous: null, adjustments: [], snapshot: {
    root: repo, repoKey: "fixture-repo", workspaceId: "fixture-workspace", moveId: operation.id, stage: "final", head, branch: null,
    objectFormat: "sha1", indexTree: tree, workingTree: tree, relativeCwd: ".", sparsePatterns: null, worktreeConfig: null,
    droppedConfigKeys: [], normalization: { autocrlf: null, eol: null }, sparse: { enabled: false, cone: null }, refs: [], prerequisites: [], bundle: { kind: "unbundled" },
  } };
  const check: MoveCheck = { source: home, destinationMachine: BOX, repoKey: "fixture-repo", workspaceId: "fixture-workspace", sourceRoot: repo,
    sourceFile: file, sourceCwd: repo, destinationRoot: repo, destinationCwd: repo, storeKeys: ["global", REPO, WT], warnings: [] };
  return { root, file, repo, global, worktree, repository, journal, privateDb, sourceManifest, sourceWorkspace, home, operation, config, bindings, transport, ports, check, events, targets, remoteOperations, fence,
    owner(value: Probe) { owner = value; }, failed() { launchFailure = "launch-failed"; }, fenceGeneration(generation: string) { heldFence = { ...fence, generation }; }, reopened: () => reopened };
}

it("move preflight accepts the mixed store list written by the catalog", async () => {
  const f = await fixture();
  expect((await f.ports.check({ operation: f.operation, sessionId: SESSION, destinationMachine: BOX })).storeKeys).toEqual(["global", REPO, WT]);
}, 5000);

it("preflight reads the current remote source location before mapping a return move", async () => {
  const f = await fixture(), remote = { file: "/fixture/remote/session.jsonl", cwd: "/fixture/remote/checkout/nested", stores: ["global", REPO, WT] };
  const home = casHome(f.global.db, f.home, BOX, "outward", HUB);
  f.bindings.mapping = async (_request, location) => {
    expect(location).toEqual(remote);
    return { repoKey: "fixture-repo", workspaceId: "fixture-workspace", sourceRoot: "/fixture/remote/checkout", destinationRoot: f.repo, destinationCwd: join(f.repo, "nested") };
  };
  const requests: Operation[] = [];
  f.transport.exec = async (_peer, argv) => {
    const operation = JSON.parse(argv[2]) as Operation; requests.push(operation);
    const value = operation.kind === "move-location" ? remote : operation.kind === "session-inspect" ? { blockers: [] } : [];
    return Buffer.from(JSON.stringify({ code: 0, reason: "complete", operationId: operation.id, home, epoch: home.epoch, repairCommand: null, value }));
  };
  const check = await f.ports.check({ operation: { ...f.operation, id: "return" }, sessionId: SESSION, destinationMachine: HUB });
  expect(check).toMatchObject({ source: home, sourceRoot: "/fixture/remote/checkout", sourceFile: remote.file, sourceCwd: remote.cwd, destinationCwd: join(f.repo, "nested") });
  expect(requests[0]).toMatchObject({ kind: "move-location", machineId: BOX, expectedEpoch: 2 });
}, 5000);

it.each(["file", "cwd", "stores"])("remote source location refuses malformed %s before mapping or effects", async field => {
  const f = await fixture(), home = casHome(f.global.db, f.home, BOX, "outward", HUB);
  const value = { file: "/fixture/session.jsonl", cwd: "/fixture/checkout", stores: ["global", REPO, WT], [field]: field === "stores" ? ["unknown:store"] : "relative-path" };
  f.bindings.mapping = async () => { throw new Error("mapping must not run"); };
  f.transport.exec = async (_peer, argv) => {
    const operation = JSON.parse(argv[2]) as Operation;
    return Buffer.from(JSON.stringify({ code: 0, operationId: operation.id, epoch: home.epoch, value }));
  };
  await expect(f.ports.check({ operation: f.operation, sessionId: SESSION, destinationMachine: HUB })).rejects.toMatchObject({ code: field === "stores" ? "participant-stores-unavailable" : "participant-location-unavailable" });
  expect(f.events).toEqual([]);
}, 5000);

it("the location query returns only the current participant's authoritative location", async () => {
  const f = await fixture();
  const operation: Operation = { ...f.operation, kind: "move-location", args: { sessionId: SESSION, sourceMachine: HUB, moveId: "next-move" } };
  expect(await handleMoveParticipantOperation(operation, f.journal, f.bindings)).toMatchObject({ code: 0, epoch: 1, value: { file: f.file, cwd: f.repo, stores: ["global", REPO, WT] } });
  casHome(f.global.db, f.home, BOX, "outward", HUB);
  await expect(handleMoveParticipantOperation(operation, f.journal, f.bindings)).rejects.toMatchObject({ code: "participant-home-mismatch" });
}, 5000);

it.each(["null", "object", "string", "empty", "non-string", "unknown kind", "missing repository", "missing worktree repository", "missing workspace", "missing separator", "duplicate", "invalid JSON"])(
  "move preflight refuses a %s location list before effects", async kind => {
  const f = await fixture(), invalid: Record<string, unknown> = {
    null: null, object: {}, string: "[]", empty: [], "non-string": [1], "unknown kind": ["unknown:fixture"],
    "missing repository": ["repo:"], "missing worktree repository": ["worktree::fixture"], "missing workspace": ["worktree:fixture:"],
    "missing separator": ["worktree:fixture"], duplicate: [WT, WT],
  };
  f.global.db.prepare("UPDATE roam_locations SET stores_json=? WHERE session_id=?").run(kind === "invalid JSON" ? "[" : JSON.stringify(invalid[kind]), SESSION);
  await expect(f.ports.check({ operation: f.operation, sessionId: SESSION, destinationMachine: BOX })).rejects.toMatchObject({ code: "participant-stores-unavailable" });
  expect(f.events).toEqual([]);
  expect(sessionHome(f.global.db, SESSION)).toEqual(f.home);
}, 5000);

it("real adapters preserve expected epoch and exact file", async () => {
  const f = await fixture(BOX);
  const home = casHome(f.global.db, f.home, BOX, f.operation.id, HUB);
  f.bindings.participant!.config = { ...f.config, role: "box", machineId: BOX };
  const manifest = { ...f.sourceManifest, file: f.file };
  const prepared = { session: manifest, workspace: f.sourceWorkspace } as PreparedMove;
  // Installation has already produced the manifest's exact local file. Start must never pick a newer file.
  writeFileSync(join(f.root, "newer.jsonl"), readFileSync(f.file));
  f.worktree.db.prepare("UPDATE roam_sessions SET state='retired'").run();
  const result = await f.ports.start(home, prepared, f.operation);
  const remoteOperation = f.remoteOperations[0];
  const installedFile = result.value?.file;
  expect(remoteOperation.expectedEpoch).toBe(home.epoch);
  expect(installedFile).toBe(manifest.file);
  expect(result.code).toBe(0);
  expect((await createRunningIntentAuthority(f.global.db).get(SESSION))?.file).toBe(f.file);
  expect(readLocal<{ owner: unknown }>(f.global.db, "participant-intent", SESSION)?.owner).toEqual({ kind: "box-participant", machineId: BOX, hubMachineId: HUB });
}, 5000);

it.each(["local", "remote"] as const)("keeps a %s wake launch conflict as a typed refusal", async side => {
  const f = await fixture(side === "remote" ? BOX : HUB);
  const outgoing = casHome(f.global.db, f.home, BOX, "outgoing", HUB);
  const home = side === "remote" ? outgoing : casHome(f.global.db, outgoing, HUB, f.operation.id, HUB);
  if (side === "remote") f.bindings.participant!.config = { ...f.config, role: "box", machineId: BOX };
  f.bindings.participant!.wake = async () => ({ ok: false, reason: "participant-launch-conflict" });
  f.transport.exec = async (_peer, argv) => {
    const operation = JSON.parse(argv[2]) as Operation;
    return Buffer.from(JSON.stringify(await handleAgentOperation(operation, {
      config: f.bindings.participant!.config, root: f.root, journal: f.journal, openStore: () => { throw new Error("unexpected store read"); },
      move: op => handleMoveParticipantOperation(op, f.journal, f.bindings),
    })));
  };
  expect(await f.ports.start(home, { session: f.sourceManifest, workspace: f.sourceWorkspace } as PreparedMove, f.operation))
    .toMatchObject({ code: 1, reason: "participant-launch-conflict", operationId: f.operation.id, epoch: home.epoch, value: null });
  expect(f.journal.read(`${f.operation.id}-session-start-${home.machineId}`).some(row => row.action === "participant-launch")).toBe(false);
}, 5000);

it("start before pi uses roaming participant ports not socket", async () => {
  const f = await fixture();
  const prepared = { session: f.sourceManifest, workspace: f.sourceWorkspace } as PreparedMove;
  const outgoing = casHome(f.global.db, f.home, BOX, "outgoing", HUB), home = casHome(f.global.db, outgoing, HUB, f.operation.id, HUB);
  const result = await f.ports.start(home, prepared, f.operation);
  expect(result.code).toBe(0);
  expect(f.events).toEqual(["wake"]);
  expect(result.value?.file).toBe(f.file);
  expect(f.worktree.db.prepare("SELECT state,epoch FROM roam_sessions WHERE session_id=?").get(SESSION)).toEqual({ state: "active", epoch: 3 });
}, 5000);

it("live freeze uses session socket", async () => {
  const f = await fixture(), identity = { bootId: "fixture-boot", pid: 42, startTime: "fixture-start" };
  f.owner({ kind: "live", identity });
  let socketOperation: Operation | null = null;
  const socket = await startSessionControlSocket(f.bindings.participant!.runtimeRoot, SESSION, async ({ operation }) => {
    socketOperation = operation;
    return { code: 0, reason: "frozen", operationId: operation.id, home: f.home, epoch: f.home.epoch, repairCommand: null,
      value: { operationId: operation.id, sessionId: SESSION, epoch: f.home.epoch, owner: identity, file: f.file, cwd: f.repo,
        leaf: f.sourceManifest.leaf, size: f.sourceManifest.size, sha256: f.sourceManifest.sha256, barriers: [], intercomGeneration: "fence-a" } };
  }); closes.push(() => socket.close());
  const ack = await f.ports.freeze(f.home, f.operation);
  expect((socketOperation as Operation | null)?.kind).toBe("session-freeze");
  expect((socketOperation as Operation | null)?.expectedEpoch).toBe(1);
  expect(ack.owner).toEqual(identity);
  expect(f.events).toEqual(["handoff"]);
}, 5000);

it("all MovePorts effects have real composition", async () => {
  const f = await fixture();
  const requiredEffectNames = ["check", "power", "seed", "prepare", "freeze", "transfer", "verifySource", "barriers", "replicateHome", "start", "inspect", "retire", "unfreeze", "readmitSource", "cleanup", "abortWorkspace"];
  const composedEffectNames = Object.keys(f.ports).filter(key => typeof (f.ports as unknown as Record<string, unknown>)[key] === "function");
  expect(composedEffectNames.sort()).toEqual(requiredEffectNames.sort());
  expect(unboundMoveEffects(f.bindings)).toEqual([]);
  const hostImports = readFileSync(join(import.meta.dirname, "../move-ports.ts"), "utf8").split("\n").filter(line => /^import .*(@spider\/host|host\/src)/.test(line));
  expect(hostImports).toEqual([]);
  expect(f.ports.recovery.revocationDb).toBe(f.privateDb);
}, 5000);

it("three argument composition refuses every unbound effect without opening state", async () => {
  const f = await fixture(), ports = createMovePorts(f.config, f.transport, f.journal);
  expect(unboundMoveEffects()).toContain("freeze");
  await expect(ports.power()).rejects.toMatchObject({ code: "adapter-unbound:power" });
  await expect(ports.freeze(f.home, f.operation)).rejects.toMatchObject({ code: "adapter-unbound:freeze" });
  expect(f.events).toEqual([]);
}, 5000);

it("dormant freeze uses real control under both ownership locks", async () => {
  const f = await fixture();
  const ack = await f.ports.freeze(f.home, f.operation);
  expect(ack.file).toBe(f.file);
  expect(ack.owner).toBeNull();
  expect(ack.barriers.map(b => b.storeKey)).toEqual(["global", REPO, WT]);
  expect(f.worktree.db.prepare("SELECT state,epoch FROM roam_sessions WHERE session_id=?").get(SESSION)).toEqual({ state: "frozen", epoch: 1 });
  expect(f.events).toEqual(["handoff", "ingest"]);
}, 5000);

it.each(["bridge", "settlement", "onHubRestored", "authorizeAbort", "authorizeRetire"] as const)("missing %s evidence stays fail closed", async name => {
  const f = await fixture(); delete f.bindings.evidence![name];
  await expect(f.ports.freeze(f.home, f.operation)).rejects.toMatchObject({ code: `adapter-unbound:evidence.${name}` });
  expect(f.worktree.db.prepare("SELECT state FROM roam_sessions WHERE session_id=?").get(SESSION)).toEqual({ state: "active" });
  expect(f.events).toEqual([]);
}, 5000);

it("non-durable handoff refuses before freeze and never creates a target", async () => {
  const f = await fixture(); f.bindings.handoff!.prepareHandoff = async () => ({ capture: "refused", reason: "capture-unavailable" });
  await expect(f.ports.freeze(f.home, f.operation)).rejects.toMatchObject({ code: "handoff-capture-unavailable" });
  expect(f.targets).toEqual([]);
  expect(f.worktree.db.prepare("SELECT state FROM roam_sessions WHERE session_id=?").get(SESSION)).toEqual({ state: "active" });
}, 5000);

it("presentation waits for a valid destination and observes it before source view retirement", async () => {
  const { f, operation } = interruptedFixture, actions: string[] = [];
  f.bindings.handoff!.presentReadyTarget = async target => { actions.push("present"); f.events.push("present"); f.targets.push(target); return { status: "complete", reason: "screen-observed", presentation: null }; };
  const results = await recoverMoveAdapters(f.ports, f.bindings);
  expect(results.find(row => row.operationId === operation.id)).toMatchObject({ code: 0 });
  expect(actions).toEqual(["present"]);
  expect(f.events).toContain("terminal-cleanup");
  expect(f.events.indexOf("present")).toBeLessThan(f.events.indexOf("terminal-cleanup"));
  expect(f.targets).toEqual([{ machineId: BOX, alias: null, sessionId: SESSION, homeEpoch: 2, coreId: "core-a", terminalId: "terminal-a" }]);
  const home = sessionHome(f.global.db, SESSION) as Home, endpoint = await f.ports.intercom.destinationEndpoint(home), fence = { ...f.fence, moveId: operation.id };
  await expect(f.ports.intercom.ports.ready(fence, { ...endpoint, homeEpoch: 3 })).rejects.toMatchObject({ code: "intercom-endpoint-not-ready" });
  expect(f.targets).toHaveLength(1);
}, 5000);

async function rollbackFixture() {
  const f = await fixture();
  const committed = casHome(f.global.db, f.home, BOX, f.operation.id, HUB), restored = casHome(f.global.db, committed, HUB, rollbackMoveId(f.operation.id), HUB);
  f.journal.record(f.operation.id, "move-request", { operation: f.operation as unknown as JsonObject, sessionId: SESSION, destinationMachine: BOX });
  f.journal.record(f.operation.id, "move-action-complete", { action: "check", value: f.check as unknown as JsonObject });
  f.journal.record(f.operation.id, "move-action-complete", { action: "freeze", value: { operationId: "move-a", sessionId: SESSION, epoch: 1, owner: null,
    file: f.file, cwd: f.repo, leaf: f.sourceManifest.leaf, size: f.sourceManifest.size, sha256: f.sourceManifest.sha256, barriers: [], intercomGeneration: "fence-a" } });
  f.journal.record(f.operation.id, "move-rollback-retired", { home: committed as unknown as JsonObject, owner: { kind: "absent" }, readiness: null,
    retired: true, activationCancelled: true, launchFailure: "launch-failed" });
  f.worktree.db.prepare("UPDATE roam_sessions SET state='frozen',move_id=?").run(f.operation.id);
  return { ...f, committed, restored };
}

it("readmitSource checks both receipts, advances membership and reuses untouched exact file", async () => {
  const f = await rollbackFixture(), before = readFileSync(f.file, "utf8");
  const result = await f.ports.readmitSource(f.home, f.restored, f.operation);
  expect(result.code).toBe(0);
  expect(result.home).toEqual(f.restored);
  expect(f.worktree.db.prepare("SELECT state,epoch FROM roam_sessions WHERE session_id=?").get(SESSION)).toEqual({ state: "active", epoch: 3 });
  expect(readFileSync(f.file, "utf8")).toBe(before);
  expect((await createRunningIntentAuthority(f.global.db).get(SESSION))?.file).toBe(f.file);
  expect(f.events).toEqual(["wake", "reopen"]);
  const repeated = await f.ports.readmitSource(f.home, f.restored, f.operation);
  expect(repeated).toEqual(result);
  expect(f.events).toEqual(["wake", "reopen"]);
}, 5000);

it.each(["home", "commit", "rollback", "ownership", "retirement", "cancellation", "generation", "move", "receipt"])("readmitSource refuses missing or mismatched %s proof without effects", async bad => {
  const f = await rollbackFixture();
  if (bad === "home") casHome(f.global.db, f.restored, BOX, "later-move", HUB);
  if (bad === "commit") f.global.db.prepare("DELETE FROM roam_home_actions WHERE move_id=?").run(f.operation.id);
  if (bad === "rollback" || bad === "receipt") f.global.db.prepare("DELETE FROM roam_home_actions WHERE move_id=?").run(rollbackMoveId(f.operation.id));
  if (["ownership", "retirement", "cancellation"].includes(bad)) {
    // A separate operation cannot overwrite immutable journal evidence. Use a reader that hides the missing proof.
    const original = f.journal.read.bind(f.journal);
    f.journal.read = id => original(id).map(row => row.action !== "move-rollback-retired" ? row : { ...row, result: { ...row.result,
      ...(bad === "ownership" ? { owner: { kind: "uncertain" } } : bad === "retirement" ? { retired: false } : { activationCancelled: false }) } });
  }
  if (bad === "generation") f.fenceGeneration("other-fence");
  if (bad === "move") f.operation.args.moveId = "another-move";
  const result = await f.ports.readmitSource(f.home, f.restored, f.operation);
  expect(result.code).toBe(3);
  expect(result.ok).toBe(false);
  expect(f.events).toEqual([]);
  expect(f.reopened()).toBe(false);
  expect(f.worktree.db.prepare("SELECT state,epoch FROM roam_sessions WHERE session_id=?").get(SESSION)).toEqual({ state: "frozen", epoch: 1 });
}, 5000);

it("unknown original process stays fenced during rollback", async () => {
  const f = await rollbackFixture(); f.owner({ kind: "uncertain" });
  const result = await f.ports.readmitSource(f.home, f.restored, f.operation);
  expect(result.code).toBe(3);
  expect(f.events).toEqual([]);
  expect(f.reopened()).toBe(false);
}, 5000);

it("rollback release rechecks home after readmission before reopening", async () => {
  const f = await rollbackFixture();
  f.bindings.participant!.wake = async () => { casHome(f.global.db, f.restored, BOX, "late-move", HUB); return { ok: true, launchId: "local-readmit" }; };
  const result = await f.ports.readmitSource(f.home, f.restored, f.operation);
  expect(result.code).toBe(3);
  expect(f.reopened()).toBe(false);
}, 5000);

it("startup restore roster is required even with no pending moves", async () => {
  const f = await fixture(); delete f.bindings.recovery!.workspaceRestores;
  await expect(recoverMoveAdapters(f.ports, f.bindings)).rejects.toMatchObject({ code: "adapter-unbound:recovery.workspaceRestores" });
}, 5000);

it("startup discovers done moves with unreleased reservations", async () => {
  const f = await fixture();
  f.journal.record(f.operation.id, "move-request", { operation: f.operation as unknown as JsonObject, sessionId: SESSION, destinationMachine: BOX });
  f.journal.record(f.operation.id, "done", { code: 0, ok: true, reason: "moved", operationId: f.operation.id, home: f.home as unknown as JsonObject,
    epoch: 1, repairCommand: null, value: { home: f.home as unknown as JsonObject, terminal: null, intercomAddress: SESSION, warnings: [], sourceCleanup: { status: "done" } } });
  const { moveSessionSlot, readMoveReservation } = await import("../move");
  const slot = moveSessionSlot(SESSION); f.journal.begin({ id: slot, kind: "move-session", machineId: HUB, expectedEpoch: null, args: { sessionId: SESSION } });
  f.journal.record(slot, "reserved", { moveId: f.operation.id, destinationMachine: BOX });
  await recoverMoveAdapters(f.ports, f.bindings);
  expect(readMoveReservation(SESSION, f.journal)).toBeNull();
}, 5000);

it.each(["epoch", "file"])("hub start refuses a different %s before local authority", async bad => {
  const f = await fixture(), outgoing = casHome(f.global.db, f.home, BOX, "outgoing", HUB), home = casHome(f.global.db, outgoing, HUB, f.operation.id, HUB);
  const other = join(f.root, "other.jsonl"); writeFileSync(other, readFileSync(f.file));
  const prepared = { session: { ...f.sourceManifest, file: bad === "file" ? other : f.file }, workspace: f.sourceWorkspace } as PreparedMove;
  await expect(f.ports.start(bad === "epoch" ? { ...home, epoch: 2 } : home, prepared, f.operation)).rejects.toMatchObject({ code: bad === "epoch" ? "participant-home-mismatch" : "participant-file-mismatch" });
  expect(await createRunningIntentAuthority(f.global.db).get(SESSION)).toBeNull();
  expect(f.events).toEqual([]);
}, 5000);

it("box participant cannot take the local authority path", async () => {
  const f = await fixture();
  f.bindings.participant!.config = { ...f.config, role: "box", hubMachineId: HUB };
  const prepared = { session: f.sourceManifest, workspace: f.sourceWorkspace } as PreparedMove;
  await expect(f.ports.start(f.home, prepared, f.operation)).rejects.toMatchObject({ code: "participant-config-unavailable" });
  expect(await createRunningIntentAuthority(f.global.db).get(SESSION)).toBeNull();
  expect(f.events).toEqual([]);
}, 5000);

it("workspace lookups use mapped common repository and persisted cross-move baseline", async () => {
  const f = await fixture(), gitPorts = { ...f.bindings.participant!.git, journal: f.journal, limits: f.config.limits };
  f.journal.begin({ id: "baseline", kind: "workspace-snapshot", machineId: HUB, expectedEpoch: null, args: {} });
  const snapshot = await snapshotWorkspace({ root: f.repo, cwd: f.repo, repoKey: f.check.repoKey, workspaceId: f.check.workspaceId, moveId: "baseline", stage: "final", writers: [] }, gitPorts);
  f.global.db.prepare("INSERT OR IGNORE INTO roam_repo_maps(repo_key,path) VALUES(?,?)").run(f.check.repoKey, f.repo);
  f.global.db.prepare("UPDATE roam_workspace_maps SET snapshot_json=? WHERE repo_key=? AND workspace_id=? AND path=?").run(JSON.stringify(snapshot), f.check.repoKey, f.check.workspaceId, f.repo);
  const ports = createMoveWorkspacePorts(f.global.db, gitPorts, f.root, []);
  expect(await ports.resolveCommonRepository({ repoKey: f.check.repoKey, workspaceId: f.check.workspaceId, destination: f.repo })).toBe(f.repo);
  expect(await ports.lastExportedSnapshot({ repoKey: f.check.repoKey, workspaceId: f.check.workspaceId, root: f.repo })).toEqual(snapshot);
  expect(await ports.resolveCommonRepository({ repoKey: f.check.repoKey, workspaceId: f.check.workspaceId, destination: join(f.root, "unmapped") })).toBeNull();
  expect(await ports.lastExportedSnapshot({ repoKey: f.check.repoKey, workspaceId: "missing", root: f.repo })).toBeNull();
}, 5000);

it("verified artifact lookup requires the exact peer operation and manifest version", async () => {
  const f = await fixture(), manifest = await stageArtifact(f.file, "session", f.config.limits, { root: f.root, artifactId: "session-artifact" });
  const incoming = openStaging(f.root, BOX, f.config.limits); closes.push(() => incoming.close());
  incoming.declare(manifest, "receive-a");
  for (const chunk of manifest.chunks) incoming.receive(manifest, chunk.index, readFileSync(sourceChunk(f.root, manifest.id, chunk.index, chunk.sha256)));
  const gitPorts = { ...f.bindings.participant!.git, journal: f.journal, limits: f.config.limits };
  const ports = createMoveWorkspacePorts(f.global.db, gitPorts, f.root, [{ artifactId: manifest.id, peer: BOX, operationId: "receive-a", sha256: manifest.sha256 }]);
  expect(readFileSync((await ports.verifiedArtifactPath(manifest.id))!, "utf8")).toBe(readFileSync(f.file, "utf8"));
  const wrong = createMoveWorkspacePorts(f.global.db, gitPorts, f.root, [{ artifactId: manifest.id, peer: BOX, operationId: "foreign-operation", sha256: manifest.sha256 }]);
  await expect(wrong.verifiedArtifactPath(manifest.id)).rejects.toMatchObject({ code: "workspace-artifact-unavailable" });
  expect(await ports.verifiedArtifactPath("unknown-artifact")).toBeNull();
}, 5000);

it("public start and freeze replies preserve the caller operation identity", async () => {
  const f = await fixture(), outgoing = casHome(f.global.db, f.home, BOX, "outgoing", HUB), home = casHome(f.global.db, outgoing, HUB, f.operation.id, HUB);
  const prepared = { session: f.sourceManifest, workspace: f.sourceWorkspace } as PreparedMove;
  const started = await f.ports.start(home, prepared, f.operation);
  expect(started.operationId).toBe(f.operation.id);
  expect(started.value?.opId).toBe(f.operation.id);
  // The admitted owner exited; the freeze now exercises the real dormant control path.
  f.owner({ kind: "absent" });
  const ack = await f.ports.freeze(home, f.operation);
  expect(ack.operationId).toBe(f.operation.id);
}, 5000);

it("completeness inventory detects nested missing intercom and workspace ports", async () => {
  const f = await fixture();
  const incomplete = { ...f.bindings, intercom: { ...f.bindings.intercom!, ports: { ...f.bindings.intercom!.ports, ready: undefined } } } as unknown as MoveAdapterBindings;
  expect(unboundMoveEffects(incomplete)).toContain("intercom.ready");
  await expect(createMovePorts(f.config, f.transport, f.journal, incomplete).intercom.ports.ready(f.fence, await f.ports.intercom.destinationEndpoint(f.home)))
    .rejects.toMatchObject({ code: "adapter-unbound:intercom.ready" });
}, 5000);

async function transferFixture(homeless = false) {
  const f = await fixture(HUB, homeless), destination = join(f.root, "destination"), target = join(f.root, "destination-session.jsonl"), remoteRoot = join(f.root, "remote");
  git(f.root, ["clone", "-q", f.repo, destination]);
  const remoteGlobal = createReplica("global", BOX), remoteWorktree = createReplica("worktree", BOX), remoteRepository = createReplica("repo", BOX); closes.push(() => remoteGlobal.close(), () => remoteWorktree.close(), () => remoteRepository.close());
  enableMemoryCapture(remoteGlobal.db, "global"); enableMemoryCapture(remoteRepository.db, REPO);
  remoteGlobal.db.prepare("INSERT OR IGNORE INTO roam_repo_maps(repo_key,path) VALUES(?,?)").run(f.check.repoKey, destination);
  remoteGlobal.db.prepare("INSERT OR IGNORE INTO roam_workspace_maps(repo_key,workspace_id,path,snapshot_json) VALUES(?,?,?,NULL)").run(f.check.repoKey, f.check.workspaceId, destination);
  f.global.db.prepare("INSERT OR IGNORE INTO roam_repo_maps(repo_key,path) VALUES(?,?)").run(f.check.repoKey, f.repo);
  f.global.db.prepare("INSERT OR IGNORE INTO roam_workspace_maps(repo_key,workspace_id,path,snapshot_json) VALUES(?,?,?,NULL)").run(f.check.repoKey, f.check.workspaceId, f.repo);
  f.config.peers[0].globalRoot = remoteRoot;
  const remoteJournal = openFreezeJournal(join(remoteRoot, "journal.db"));
  const config = { ...f.config, machineId: BOX, role: "box" as const };
  const leases = createSessionLeases(join(remoteRoot, "herdr")), inventory = { leases, presence: createProcessPresence(leases.root), processes: async () => [], probe: async () => ({ kind: "live" as const, startIdentity: "fixture-lock" }) };
  const withBothLocks = createBothLocks({ root: leases.root, inventory, identity: { pid: 900, startIdentity: "fixture-lock" }, file: async () => target, bootId: async () => "fixture-boot" });
  const remote: MoveAdapterBindings = { ...f.bindings, root: remoteRoot, globalDb: remoteGlobal.db,
    participant: { ...f.bindings.participant!, root: remoteRoot, config, globalDb: remoteGlobal.db, stores: [{ key: "global", db: remoteGlobal.db }, { key: REPO, db: remoteRepository.db }, { key: WT, db: remoteWorktree.db }], withBothLocks,
      git: { ...f.bindings.participant!.git, scratch: join(remoteRoot, "git") }, sessionTarget: async () => target },
  };
  const localTarget = f.bindings.handoff!.readyTarget;
  f.bindings.handoff!.readyTarget = async home => {
    if (home.machineId === HUB) return localTarget(home);
    const launch = remoteJournal.read(`${home.moveId}-session-start-${home.machineId}`).find(row => row.action === "participant-launch")?.result as unknown as import("../move-ports").ParticipantReadinessQuery | undefined;
    const ready = launch ? await remote.participant!.readiness(launch) : null;
    return ready ? { machineId: home.machineId, alias: null, sessionId: ready.sessionId, homeEpoch: ready.epoch, coreId: ready.core, terminalId: ready.terminal } : null;
  };
  remoteJournal.begin({ id: "baseline", kind: "workspace-snapshot", machineId: BOX, expectedEpoch: null, args: {} });
  const baseline = await snapshotWorkspace({ root: destination, cwd: destination, repoKey: f.check.repoKey, workspaceId: f.check.workspaceId, moveId: "baseline", stage: "final", writers: [] }, { ...remote.participant!.git, journal: remoteJournal, limits: config.limits });
  remoteGlobal.db.prepare("UPDATE roam_workspace_maps SET snapshot_json=? WHERE repo_key=? AND workspace_id=?").run(JSON.stringify(baseline), f.check.repoKey, f.check.workspaceId);
  const incoming = openStaging(join(remoteRoot, "roam", "staging"), HUB, config.limits); closes.push(() => incoming.close());
  f.transport.exec = async (_peer, argv, options) => {
    if (argv[1] === "artifact") return handleArtifactRequest(JSON.parse(argv[3]), options.stdin, { store: incoming, journal: remoteJournal, machineId: BOX, limits: config.limits });
    return Buffer.from(JSON.stringify(await handleMoveParticipantOperation(JSON.parse(argv[2]), remoteJournal, remote)));
  };
  const check = { ...f.check, destinationRoot: destination, destinationCwd: destination };
  return { ...f, remote, remoteGlobal, remoteWorktree, remoteRepository, remoteJournal, remoteRoot, destination, target, check };
}

let preparedFixture: Awaited<ReturnType<typeof transferFixture>>;
let interruptedFixture: Awaited<ReturnType<typeof appAbsentFixture>>;
let interruptedSetup: Awaited<ReturnType<typeof prepareAppAbsentFixture>>;
let mirrorPrepared: PreparedMove;
const appCases = ["presentation waits", "app absence records", "app-absent end-to-end", "app presentation failure", "cleanup retries", "destination cleanup while"];
beforeEach(async context => {
  if (context.task.name.startsWith("real Git artifacts") || context.task.name.startsWith("destroyed mirror")) preparedFixture = await transferFixture();
  if (appCases.some(prefix => context.task.name.startsWith(prefix))) interruptedSetup = await prepareAppAbsentFixture();
}, 5000);
let transferArtifacts: string[] = [];
beforeEach(async context => {
  if (appCases.some(prefix => context.task.name.startsWith(prefix))) interruptedFixture = await interruptedSetup.run();
  if (context.task.name.startsWith("real Git artifacts")) {
    const f = preparedFixture, exec = f.transport.exec; transferArtifacts = [];
    f.transport.exec = async (peer, argv, options) => {
      if (argv[1] === "agent") { const op = JSON.parse(argv[2]); if (op.kind === "move-import") transferArtifacts.push(op.args.exported.sessionArtifact.id); }
      return exec(peer, argv, options);
    };
  }
  if (context.task.name.startsWith("destroyed mirror") || context.task.name.startsWith("real Git artifacts")) mirrorPrepared = await preparedFixture.ports.prepare(preparedFixture.check, preparedFixture.operation);
}, 5000);
beforeEach(async context => {
  if (!appCases.some(prefix => context.task.name.startsWith(prefix))) return;
  const { f } = interruptedFixture, record = f.journal.record;
  let interrupted = false;
  f.journal.record = (id, action, value) => {
    record(id, action, value);
    if (!interrupted && action === "move-action-complete" && value.action === "prestage") { interrupted = true; throw new Error("fixture-crash-after-prestage"); }
  };
  await recoverMoveAdapters(f.ports, f.bindings);
  f.journal.record = record;
}, 5000);
beforeEach(async context => {
  if (!appCases.some(prefix => context.task.name.startsWith(prefix))) return;
  const { f, operation } = interruptedFixture, record = f.journal.record;
  let interrupted = false;
  f.journal.record = (id, action, value) => {
    record(id, action, value);
    if (!interrupted && action === "move-action-complete" && value.action === "transfer") { interrupted = true; throw new Error("fixture-crash-after-transfer"); }
  };
  const outcomes = await recoverMoveAdapters(f.ports, f.bindings);
  f.journal.record = record;
  interruptedFixture.initial = outcomes.find(row => row.operationId === operation.id)!;
}, 5000);


it("real Git artifacts prepare and transfer into the exact installed manifest file", async () => {
  const f = preparedFixture, { check, target } = f;
  const artifactIds = transferArtifacts, prepared = mirrorPrepared;
  const installedFile = prepared.session.file, manifest = prepared.session;
  expect(installedFile).toBe(manifest.file);
  expect(installedFile).toBe(target);
  expect((await inspectSession(target, SESSION)).sha256).toBe(manifest.sha256);
  const ack = await f.ports.freeze(f.home, f.operation);
  const final = await f.ports.transfer(check, ack, f.operation);
  expect(final.workspace.snapshot.stage).toBe("final");
  expect(final.session.file).toBe(target);
  expect(artifactIds).toEqual(["move-a-session", "move-a-session"]);
  expect(final.workspace.snapshot.prerequisites).toContain(git(f.repo, ["rev-parse", prepared.workspace.snapshot.refs[1]]).toString().trim());
  const saved = f.global.db.prepare("SELECT snapshot_json FROM roam_workspace_maps WHERE repo_key=? AND workspace_id=?").get(check.repoKey, check.workspaceId) as { snapshot_json: string };
  expect(typeof saved.snapshot_json).toBe("string");
  expect(JSON.parse(saved.snapshot_json).stage).toBe("final");
  await f.ports.verifySource(ack, final.workspace.snapshot);
  expect(readFileSync(f.file, "utf8")).not.toContain("spider-roam-segment");
  const original = readFileSync(f.file);
  writeFileSync(f.file, original.toString() + JSON.stringify({ type: "message", id: "after-freeze", parentId: "leaf-a", timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "late", timestamp: 2 } }) + "\n");
  await expect(f.ports.verifySource(ack, final.workspace.snapshot)).rejects.toMatchObject({ code: "move-freeze-invalid" });
  writeFileSync(f.file, original);
  writeFileSync(join(f.repo, "tracked.txt"), "late workspace change\n");
  await expect(f.ports.verifySource(ack, final.workspace.snapshot)).rejects.toThrow();
}, 5000);

it("app absence records pending presentation but does not delay ownership handoff", async () => {
  const { f, operation } = interruptedFixture;
  const freeze = f.journal.read(operation.id).find(row => row.action === "move-action-complete" && row.result.action === "freeze")?.result.value as unknown as FreezeAck;
  expect(freeze.file).toBe(f.file);
  const result = (await recoverMoveAdapters(f.ports, f.bindings)).find(row => row.operationId === operation.id)!;
  expect(result.value?.intercomAddress).toBe(SESSION);
  expect(f.journal.read(operation.id).filter(row => row.action === "handoff-capture").map(row => row.result.presentationStatus)).toEqual(["pending"]);
  expect(f.journal.read(operation.id).filter(row => row.action === "handoff-presentation").map(row => row.result.status)).toEqual(["pending"]);
  expect(f.events).not.toContain("view-close");
}, 5000);

async function prepareAppAbsentFixture(options: { homeless?: boolean; skipCrash?: boolean; beforeMove?(f: Awaited<ReturnType<typeof transferFixture>>, operation: Operation): Promise<void> } = {}) {
  const f = await transferFixture(options.homeless);
  f.global.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES(?,?,?,1,1)").run("source", f.worktree.root, f.worktree.db.raw.name);
  f.remoteGlobal.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES(?,?,?,1,1)").run("destination", f.remoteWorktree.root, f.remoteWorktree.db.raw.name);
  f.global.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES(?,?,?,1,1)").run("source-repo", f.repository.root, f.repository.db.raw.name);
  f.remoteGlobal.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES(?,?,?,1,1)").run("destination-repo", f.remoteRepository.root, f.remoteRepository.db.raw.name);
  writeLocal(f.global.db, "mapping-redirect", WT, f.worktree.db.raw.name);
  writeLocal(f.global.db, "mapping-redirect", REPO, f.repository.db.raw.name);
  writeLocal(f.remoteGlobal.db, "mapping-redirect", WT, f.remoteWorktree.db.raw.name);
  writeLocal(f.remoteGlobal.db, "mapping-redirect", REPO, f.remoteRepository.db.raw.name);
  const sourceStores = createStorePort(f.config, f.global.db), destinationStores = createStorePort(f.remote.participant!.config, f.remoteGlobal.db);
  closes.push(() => sourceStores.close(), () => destinationStores.close());
  f.bindings.stores = { open: k => sourceStores.openStore(k).db, head: k => sourceStores.head(k) };
  f.remote.stores = { open: k => destinationStores.openStore(k).db, head: k => destinationStores.head(k) };
  let destinationOwner: Probe = { kind: "absent" };
  const destAuthority = createRunningIntentAuthority(f.remoteGlobal.db);
  f.remote.participant!.probe = async () => destinationOwner;
  let destinationReady: HubOperationReadiness | null = null;
  f.remote.participant!.wake = async ({ sessionId, operationId }) => {
    const intent = await destAuthority.get(sessionId);
    if (!intent || sessionId !== SESSION || intent.desired !== "running" || intent.suspended) return { ok: false, reason: "participant-intent-unavailable" };
    const launchId = `launch-${operationId}`;
    if (!destinationReady) {
      destinationOwner = { kind: "live", identity: { pid: 42, startTime: "fixture-start", bootId: "fixture-boot" } };
      destinationReady = { origin: "hub-operation", opId: launchId, sessionId, epoch: intent.epoch, file: intent.file, cwd: intent.cwd, core: "core-a", terminal: "terminal-a" };
      f.remoteJournal.begin({ id: launchId, kind: "exact-session-launch", machineId: BOX, expectedEpoch: intent.epoch, args: { sessionId } });
      recordReadiness(f.remoteJournal, destinationReady);
    }
    return { ok: true, launchId };
  };
  f.remote.participant!.readiness = async ({ sessionId, launchId, epoch }) => destinationReady && destinationOwner.kind === "live" && destinationReady.sessionId === sessionId && destinationReady.opId === launchId && destinationReady.epoch === epoch ? destinationReady : null;
  f.remote.participant!.observation = async (home, operation) => {
    const participantId = `${operation.args.moveId}-session-start-${BOX}`;
    const launch = f.remoteJournal.read(participantId).find(row => row.action === "participant-launch")?.result as unknown as import("../move-ports").ParticipantReadinessQuery | undefined;
    const exact = launch ? await f.remote.participant!.readiness(launch) : null;
    const ready = exact ? { ...exact, opId: participantId } : null;
    return { home: sessionHome(f.remoteGlobal.db, SESSION) as Home, owner: destinationOwner, readiness: ready ?? null, launchFailure: null, retired: false };
  };
  f.bindings.participant!.observation = async home => ({ home, owner: { kind: "absent" }, readiness: null, launchFailure: null,
    retired: (f.worktree.db.prepare("SELECT state FROM roam_sessions WHERE session_id=?").get(SESSION) as { state: string }).state === "retired" });
  f.bindings.evidence!.authorizeRetire = async () => sessionHome(f.global.db, SESSION) as Home;
  f.bindings.handoff!.prepareHandoff = async () => ({ capture: "durable", presentation: { status: "pending", reason: "app-absent", presentation: { sourceView: "view-a" } } });
  const presentationSourceStates: string[] = [];
  f.bindings.handoff!.presentReadyTarget = async () => { presentationSourceStates.push((f.worktree.db.prepare("SELECT state FROM roam_sessions WHERE session_id=?").get(SESSION) as { state: string }).state); return { status: "pending", reason: "app-absent", presentation: { sourceView: "view-a" } }; };
  f.bindings.mapping = async () => ({ repoKey: f.check.repoKey, workspaceId: f.check.workspaceId, sourceRoot: f.repo, destinationRoot: f.destination, destinationCwd: f.destination });
  const moveTransport = f.transport.exec;
  f.transport.exec = async (peer, argv, options) => {
    if (argv[1] !== "agent") return moveTransport(peer, argv, options);
    const op = JSON.parse(argv[2]) as Operation;
    if (op.kind.startsWith("move-") || op.kind.startsWith("session-")) return moveTransport(peer, argv, options);
    return Buffer.from(JSON.stringify(await handleAgentOperation(op, { config: f.remote.participant!.config, root: join(f.remoteRoot, "roam", "staging"), journal: f.remoteJournal, openStore: destinationStores.openStore })));
  };
  f.transport.read = async (_peer, file) => readFileSync(file);
  const sync = createSync({ config: f.config, globalDb: f.global.db, transport: f.transport, journal: f.journal, clock: f.bindings.clock!, stores: sourceStores, revocationDb: f.privateDb });
  f.bindings.sync = sync;
  const operation = { ...f.operation, id: "app-absent" }, before = readFileSync(f.file), record = f.journal.record;
  let interrupted = false;
  f.journal.record = (id, action, value) => {
    record(id, action, value);
    if (!options.skipCrash && !interrupted && action === "move-action-complete" && value.action === "seed") { interrupted = true; throw new Error("fixture-crash-after-seed"); }
  };
  await options.beforeMove?.(f, operation);
  return { async run() {
    const initial = await moveSession({ operation, sessionId: SESSION, destinationMachine: BOX }, f.ports);
    f.journal.record = record;
    return { f, operation, before, initial, presentationSourceStates };
  } };
}
async function appAbsentFixture(options: Parameters<typeof prepareAppAbsentFixture>[0] = {}) {
  return (await prepareAppAbsentFixture(options)).run();
}

it("app-absent end-to-end move retires source ownership and preserves pending pane intent", async () => {
  const { f, operation, before, initial, presentationSourceStates } = interruptedFixture;
  expect(initial.code).toBe(3);
  expect(f.journal.read(operation.id).some(row => row.action === "move-action-complete" && row.result.action === "transfer")).toBe(true);
  const outcomes = await recoverMoveAdapters(f.ports, f.bindings), result = outcomes.find(row => row.operationId === operation.id)!;
  expect(result.code).toBe(0);
  expect(sessionHome(f.global.db, SESSION)).toMatchObject({ machineId: BOX, epoch: 2, moveId: operation.id });
  expect(f.worktree.db.prepare("SELECT state,epoch FROM roam_sessions WHERE session_id=?").get(SESSION)).toEqual({ state: "retired", epoch: 1 });
  expect(f.remoteWorktree.db.prepare("SELECT state,epoch FROM roam_sessions WHERE session_id=?").get(SESSION)).toEqual({ state: "active", epoch: 2 });
  expect(f.journal.read(operation.id).filter(row => row.action === "handoff-presentation").map(row => row.result.status)).toEqual(["pending"]);
  expect(readFileSync(f.file)).toEqual(before);
  expect(presentationSourceStates).toEqual(["retired"]);
  const artifacts = f.journal.read(operation.id).filter(row => row.action === "workspace-bundle").map(row => String(row.result.artifactId));
  for (const id of [...artifacts, `${operation.id}-session`]) {
    expect(existsSync(join(f.root, "roam", "staging", "outgoing", id))).toBe(false);
    expect(existsSync(join(f.remoteRoot, "roam", "staging", "incoming", HUB, "artifacts", id))).toBe(false);
  }
  expect(git(f.repo, ["for-each-ref", "--format=%(refname)", `refs/spider-roam/${operation.id}/`]).toString().trim()).toBe("");
  expect(git(f.destination, ["for-each-ref", "--format=%(refname)", `refs/spider-roam/${operation.id}/`]).toString().trim()).toBe("");
  expect(existsSync(f.target)).toBe(true);
  expect(f.events).not.toContain("view-close");
}, 5000);

it("readmission refuses unavailable fresh authoritative rollback evidence", async () => {
  const f = await rollbackFixture(); f.bindings.evidence!.rollback = async () => null;
  const result = await f.ports.readmitSource(f.home, f.restored, f.operation);
  expect(result.code).toBe(3);
  expect(f.events).toEqual([]);
  expect(f.reopened()).toBe(false);
}, 5000);

it("rollback readmission preserves the caller epoch and operation id", async () => {
  const f = await rollbackFixture(), operation = { ...f.operation, id: "readmit-a", kind: "session-readmit", expectedEpoch: 3, args: { sessionId: SESSION, moveId: "move-a" } };
  const result = await f.ports.readmitSource(f.home, f.restored, operation);
  expect(result.code).toBe(0);
  expect(result.operationId).toBe(operation.id);
  expect(result.epoch).toBe(f.restored.epoch);
}, 5000);

it("readmission replay after source readiness does not wake or admit a second owner", async () => {
  const f = await rollbackFixture();
  let fail = true;
  f.bindings.intercom!.rollback.reopen = async () => { if (fail) { fail = false; throw new Error("Interrupted release"); } f.events.push("reopen"); };
  const first = await f.ports.readmitSource(f.home, f.restored, f.operation);
  expect(first.code).toBe(3);
  const retry = await f.ports.readmitSource(f.home, f.restored, f.operation);
  expect(retry.code).toBe(0);
  expect(f.events).toEqual(["wake", "reopen"]);
}, 5000);

it("local barriers use real heads rather than asking sync for a peer named hub", async () => {
  const f = await fixture();
  f.bindings.sync!.barriers = async () => false;
  const required = f.bindings.stores!.head(WT);
  expect(await f.ports.barriers(HUB, [required])).toBe(true);
  expect(await f.ports.barriers(HUB, [{ ...required, through: required.through + 100 }])).toBe(false);
}, 5000);

it("destination start retains the enrolled hub even when the caller targets the box", async () => {
  const f = await fixture(), home = casHome(f.global.db, f.home, BOX, f.operation.id, HUB);
  f.bindings.participant!.config = { ...f.config, role: "box", machineId: BOX };
  f.worktree.db.prepare("UPDATE roam_sessions SET state='retired'").run();
  const start = f.ports.start(home, { session: f.sourceManifest, workspace: f.sourceWorkspace } as PreparedMove, { ...f.operation, machineId: BOX });
  await expect(start).resolves.toMatchObject({ code: 0 });
  const reply = await start;
  expect(reply.code).toBe(0);
  expect(f.remoteOperations[0].args.sourceMachine).toBe(HUB);
}, 5000);

it.each(["valid", "generation", "move", "home", "receipt", "broker"])("production rollback release checks %s evidence and opens only the original fence", async bad => {
  const f = await rollbackFixture(); f.journal.beginFreeze(SESSION, f.operation.id, f.home.epoch); f.journal.bindIntercomFence(f.fence);
  const actions: string[] = [];
  const rollback = createRollbackIntercomPorts({ journal: f.journal, address: f.fence.address,
    proof: async op => readRollbackEvidence(f.global.db, f.journal, op),
    broker: { intake: async (_action, fence) => { actions.push("broker-open"); return bad === "broker" ? null : fence.generation; } },
    bridge: { resumeIntake: () => { actions.push("bridge-open"); } },
  });
  const fence = bad === "generation" ? { ...f.fence, generation: "foreign-generation" } : bad === "move" ? { ...f.fence, moveId: "foreign-move" } : f.fence;
  const home = bad === "home" ? { ...f.restored, epoch: 4 } : f.restored, receipt = bad === "receipt" ? { ...f.restored, moveId: "foreign-receipt" } : f.restored;
  if (bad === "valid") {
    await rollback.reopen(fence, home, receipt); await rollback.reopen(fence, home, receipt);
    expect(actions).toEqual(["broker-open", "bridge-open", "broker-open", "bridge-open"]);
  } else {
    await expect(rollback.reopen(fence, home, receipt)).rejects.toMatchObject({ code: "move-rollback-proof-missing" });
    expect(actions).toEqual(bad === "broker" ? ["broker-open"] : []);
  }
}, 5000);

it("start rechecks the real prepared workspace before admitting ownership", async () => {
  const f = await fixture(), home = casHome(f.global.db, f.home, HUB, f.operation.id, HUB);
  writeFileSync(join(f.repo, "tracked.txt"), "a late destination edit\n");
  await expect(f.ports.start(home, { session: f.sourceManifest, workspace: f.sourceWorkspace } as PreparedMove, f.operation)).rejects.toThrow("workspace-verification-failed");
  expect(readFileSync(join(f.repo, "tracked.txt"), "utf8")).toBe("a late destination edit\n");
  expect(f.events).not.toContain("wake");
}, 5000);

it("hub evidence binds real abort cancellation and fresh retirement receipts", async () => {
  const f = await fixture(), request = { operation: f.operation, sessionId: SESSION, destinationMachine: BOX };
  f.journal.record(f.operation.id, "move-request", JSON.parse(JSON.stringify(request)));
  f.journal.record(f.operation.id, "move-action-complete", { action: "check", value: JSON.parse(JSON.stringify(f.check)) });
  const feeds = createHubMoveEvidencePorts(f.ports, f.bindings.evidence!);
  const abort = { ...f.operation, kind: "session-unfreeze", args: { sessionId: SESSION, moveId: f.operation.id } };
  expect(await feeds.authorizeAbort(abort)).toBeNull();
  cancelHomeAction(f.global.db, f.home, BOX, f.operation.id, HUB);
  expect(await feeds.authorizeAbort(abort)).toEqual({ home: f.home, cancelledMoveId: f.operation.id });
  f.config.role = "box";
  expect(await feeds.authorizeAbort(abort)).toBeNull();
}, 5000);

it("hub retirement authorization refuses a restored or unbound home", async () => {
  const f = await fixture(), committed = casHome(f.global.db, f.home, BOX, f.operation.id, HUB);
  const feeds = createHubMoveEvidencePorts(f.ports, f.bindings.evidence!);
  const retire = { ...f.operation, kind: "session-retire", args: { sessionId: SESSION, moveId: f.operation.id } };
  expect(await feeds.authorizeRetire(retire)).toEqual(committed);
  casHome(f.global.db, committed, HUB, rollbackMoveId(f.operation.id), HUB);
  expect(await feeds.authorizeRetire(retire)).toBeNull();
}, 5000);

it.each(["power", "stores", "git"])("incomplete nested %s binding is listed and refuses with a named blocker", async missing => {
  const f = await fixture();
  if (missing === "power") Reflect.deleteProperty(f.bindings.power!, "spawn");
  if (missing === "stores") Reflect.deleteProperty(f.bindings.stores!, "head");
  if (missing === "git") Reflect.deleteProperty(f.bindings.participant!.git, "run");
  const effect = missing === "power" ? "power" : missing === "stores" ? "barriers" : "prepare";
  expect(unboundMoveEffects(f.bindings)).toContain(effect);
  const call = missing === "power" ? f.ports.power() : missing === "stores" ? f.ports.barriers(HUB, []) : f.ports.prepare(f.check, f.operation);
  await expect(call).rejects.toMatchObject({ code: `adapter-unbound:${effect}` });
}, 5000);

it("app presentation failure persists pending intent without reversing ownership", async () => {
  const { f, operation } = interruptedFixture;
  f.bindings.handoff!.presentReadyTarget = async () => { throw new Error("app-absent"); };
  const outcomes = await recoverMoveAdapters(f.ports, f.bindings), result = outcomes.find(row => row.operationId === operation.id)!;
  expect(result.code).toBe(0);
  expect(f.journal.read(operation.id).find(row => row.action === "handoff-presentation")?.result.status).toBe("pending");
  expect(f.worktree.db.prepare("SELECT state FROM roam_sessions WHERE session_id=?").get(SESSION)).toEqual({ state: "retired" });
  expect(sessionHome(f.global.db, SESSION)).toMatchObject({ machineId: BOX, epoch: 2 });
  expect(f.events).not.toContain("view-close");
}, 5000);

it("destroyed mirror restores through real adapters and preserves original segment history", async () => {
  const f = preparedFixture, moved = mirrorPrepared;
  casHome(f.global.db, f.home, BOX, f.operation.id, HUB);
  const mirrorOperation = { id: "mirror-on-box", kind: "session-mirror", machineId: BOX, expectedEpoch: 2, args: { sessionId: SESSION } };
  f.journal.begin(mirrorOperation);
  const mirror = await appendMirror({ sessionId: SESSION, epoch: 2, source: moved.session, root: f.bindings.recovery!.mirrorRoot, operationId: mirrorOperation.id }, f.journal);
  f.bindings.recovery!.restoreWorkspace = async () => ({ cwd: f.repo, parent: null });
  const result = await forgetMachine({ machineId: BOX, confirmation: `destroyed ${BOX}` }, f.ports);
  expect(result.code).toBe(0);
  const home = sessionHome(f.global.db, SESSION) as Home, file = (await createRunningIntentAuthority(f.global.db).get(SESSION))!.file;
  const restored = await inspectSession(file, SESSION);
  expect(home).toMatchObject({ machineId: HUB, epoch: 3 });
  const markers = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.customType === "spider-roam-segment");
  expect(markers.map(row => row.data.historyMachine)).toEqual([HUB, HUB]);
  expect(markers.at(-1).data).toMatchObject({ previousMachine: BOX, nextMachine: HUB, epoch: 3 });
  expect(readFileSync(f.file, "utf8")).not.toContain("spider-roam-segment");
  expect(restored.cwd).toBe(f.repo);
  expect(await f.ports.recovery.mirror(SESSION, 2)).toMatchObject({ file: mirror.file, sha256: mirror.sha256, size: mirror.size, leaf: mirror.leaf });
}, 5000);

it.each([false, true])("recovery without a workspace is named and pending (enabled=%s)", async enabled => {
  const f = await fixture(); f.config.enabled = enabled;
  f.global.db.prepare("UPDATE session_homes SET machine_id=? WHERE session_id=?").run(BOX, SESSION);
  f.journal.begin({ id: "missing-workspace-mirror", kind: "sync-mirror", machineId: BOX, expectedEpoch: 1, args: {} });
  await appendMirror({ sessionId: SESSION, epoch: 1, source: f.sourceManifest, root: f.bindings.recovery!.mirrorRoot, operationId: "missing-workspace-mirror" }, f.journal);
  const result = await forgetMachine({ machineId: BOX, confirmation: `destroyed ${BOX}` }, f.ports);
  expect(result).toMatchObject({ code: 3, reason: "recovery-workspace-unavailable", results: [{ sessionId: SESSION, code: 3, reason: "recovery-workspace-unavailable" }] });
  expect(sessionHome(f.global.db, SESSION)).toMatchObject({ machineId: HUB, epoch: 2 });
  expect(f.events).not.toContain("wake");
}, 5000);

it("disabled forget installs an active recovered home but durably defers launch and prints the exact resume command", async () => {
  const f = await fixture(); f.config.enabled = false; f.bindings.participant!.pi = null;
  f.global.db.prepare("UPDATE session_homes SET machine_id=? WHERE session_id=?").run(BOX, SESSION);
  f.journal.begin({ id: "disabled-mirror", kind: "sync-mirror", machineId: BOX, expectedEpoch: 1, args: {} });
  await appendMirror({ sessionId: SESSION, epoch: 1, source: f.sourceManifest, root: f.bindings.recovery!.mirrorRoot, operationId: "disabled-mirror" }, f.journal);
  f.bindings.recovery!.restoreWorkspace = async () => ({ cwd: f.repo, parent: null });
  const request = { machineId: BOX, confirmation: `destroyed ${BOX}` };
  const result = await forgetMachine(request, f.ports);
  expect(result).toMatchObject({ code: 3, reason: "recovery-launch-pending", results: [{ sessionId: SESSION, code: 3, reason: "recovery-launch-pending", repairCommand: expect.stringContaining("--session") }] });
  const intent = await createRunningIntentAuthority(f.global.db).get(SESSION);
  expect(intent).toMatchObject({ desired: "running", epoch: 2 });
  expect(readFileSync(intent!.file, "utf8")).toContain("spider-roam-segment");
  expect(f.worktree.db.prepare("SELECT state,epoch FROM roam_sessions WHERE session_id=?").get(SESSION)).toEqual({ state: "active", epoch: 2 });
  expect(result.results[0].repairCommand).toContain(intent!.file);
  expect(f.events).not.toContain("wake"); expect(f.targets).toEqual([]);
  expect(f.journal.read(`${(sessionHome(f.global.db, SESSION) as Home).moveId}-move-restore-${HUB}`).filter(row => row.action === "recovery-launch-pending")).toHaveLength(1);
  expect(await forgetMachine(request, f.ports)).toMatchObject({ code: 3, reason: "recovery-launch-pending" });
  expect(f.events).not.toContain("wake");
}, 5000);

it("disabled restore preserves a changed-identity refusal instead of printing an unsafe resume command", async () => {
  const f = await fixture(); f.config.enabled = false;
  f.global.db.prepare("UPDATE session_homes SET machine_id=? WHERE session_id=?").run(BOX, SESSION);
  f.journal.begin({ id: "identity-mirror", kind: "sync-mirror", machineId: BOX, expectedEpoch: 1, args: {} });
  await appendMirror({ sessionId: SESSION, epoch: 1, source: f.sourceManifest, root: f.bindings.recovery!.mirrorRoot, operationId: "identity-mirror" }, f.journal);
  f.bindings.recovery!.restoreWorkspace = async () => ({ cwd: f.repo, parent: null });
  let checks = 0; f.bindings.participant!.identityCurrent = async () => ++checks === 1;
  const result = await forgetMachine({ machineId: BOX, confirmation: `destroyed ${BOX}` }, f.ports);
  expect(result).toMatchObject({ code: 1, reason: "participant-config-changed", results: [{ repairCommand: "spider roam doctor" }] });
  expect(await createRunningIntentAuthority(f.global.db).get(SESSION)).toBeNull();
  expect(f.events).not.toContain("wake");
}, 5000);

it("startup recovers real interrupted workspace settings even without pending move ids", async () => {
  const f = await fixture(), config = "[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = true\n", patterns = "/*\n!/*/\n", common = join(f.repo, ".git");
  const index = join(f.root, "private-index"), realIndex = readFileSync(join(common, "index"));
  copyFileSync(join(common, "index"), index); git(f.repo, ["config", "--local", "extensions.worktreeConfig", "true"]);
  writeFileSync(join(common, "config.worktree"), config, { mode: 0o600 }); writeFileSync(join(common, "info", "sparse-checkout"), patterns, { mode: 0o600 });
  git(f.repo, ["read-tree", "-m", "-u", f.sourceWorkspace.snapshot.workingTree, f.sourceWorkspace.snapshot.workingTree], { env: { GIT_INDEX_FILE: index } });
  const snapshot = { ...f.sourceWorkspace.snapshot, moveId: "interrupted-settings", stage: "pre" as const, worktreeConfig: config, sparsePatterns: patterns,
    sparse: { enabled: true, cone: true }, refs: ["refs/spider-roam/interrupted-settings/pre/index", "refs/spider-roam/interrupted-settings/pre/working"], bundle: { kind: "ready" as const, artifactId: "interrupted-bundle", byteLength: 1 } };
  const previous = { ...snapshot, moveId: "previous", stage: "final", sparsePatterns: null, worktreeConfig: null, sparse: { enabled: false, cone: null } };
  const snapshotJson = JSON.stringify(snapshot), digest = createHash("sha256").update(JSON.stringify([snapshot.repoKey, snapshot.workspaceId, snapshot.moveId, snapshot.stage,
    snapshot.head, snapshot.branch, snapshot.objectFormat, snapshot.indexTree, snapshot.workingTree, snapshot.relativeCwd, snapshot.sparsePatterns, snapshot.worktreeConfig,
    snapshot.normalization, snapshot.sparse, snapshot.refs, snapshot.prerequisites, snapshot.bundle])).digest("hex");
  const transitionId = HUB, before = { head: snapshot.head, indexTree: snapshot.indexTree, workingTree: snapshot.workingTree }, original = { worktreeConfig: null, sparsePatterns: null }, modes = { worktreeMode: null, sparseMode: null };
  const target = { worktreeConfig: config, sparsePatterns: patterns }, targetModes = { worktreeMode: 0o600, sparseMode: 0o600 }, beforeView = { objectFormat: "sha1", workingTree: snapshot.workingTree, sparse: { enabled: false, cone: null }, sparsePatterns: null };
  const checksum = createHash("sha256").update(JSON.stringify([1, transitionId, f.repo, common, "pre", digest, snapshotJson, [null, null, null, null], null,
    [config, patterns, 0o600, 0o600], [snapshot.head, snapshot.indexTree, snapshot.workingTree], false, ["sha1", snapshot.workingTree, false, null, null]])).digest("hex");
  f.journal.begin({ id: snapshot.moveId, kind: "restore-destroyed-home", machineId: HUB, expectedEpoch: 2, args: {} });
  f.journal.record(snapshot.moveId, "workspace-prepare-start", { root: f.repo, stage: "pre", digest, snapshotJson, previousJson: JSON.stringify(previous), settingsJournalVersion: 1 });
  f.journal.record(snapshot.moveId, "workspace-settings-transition", { version: 1, transitionId, root: f.repo, common, stage: "pre", digest, snapshotJson, original, modes,
    temporary: null, temporaryModes: null, target, targetModes, before, beforeApplied: false, beforeView, checksum });
  f.journal.record(snapshot.moveId, "workspace-config-target", { root: f.repo, digest, ...target });
  for (const step of ["target-sparse", "target-config"]) {
    f.journal.record(snapshot.moveId, "workspace-settings-write-start", { root: f.repo, transitionId, step });
    f.journal.record(snapshot.moveId, "workspace-settings-write-complete", { root: f.repo, transitionId, step });
  }
  f.journal.record(f.operation.id, "done", JSON.parse(JSON.stringify({ code: 0, reason: "fixture-closed", operationId: f.operation.id, home: f.home, epoch: 1, repairCommand: null, value: {} })));
  const workspacePorts = createMoveWorkspacePorts(f.global.db, { ...f.bindings.participant!.git, journal: f.journal, limits: f.config.limits }, join(f.root, "roam", "staging"), []);
  f.bindings.recovery!.workspaceRestores = async () => [{ snapshot, destination: f.repo, repository: f.repo, ports: workspacePorts,
    withBothLocks: action => f.bindings.participant!.withBothLocks(SESSION, action) }];
  expect(await recoverMoveAdapters(f.ports, f.bindings)).toEqual([]);
  expect(existsSync(join(common, "config.worktree"))).toBe(false);
  expect(existsSync(join(common, "info", "sparse-checkout"))).toBe(false);
  expect(readFileSync(join(common, "index"))).toEqual(realIndex);
  expect(readFileSync(join(f.repo, "tracked.txt"), "utf8")).toBe("fixture\n");
}, 5000);

it("foreign readiness cannot be normalized into this move's receipt", async () => {
  const f = await fixture(), home = casHome(f.global.db, f.home, BOX, f.operation.id, HUB);
  f.bindings.participant!.config = { ...f.config, role: "box", machineId: BOX };
  f.bindings.participant!.observation = async () => ({ home, owner: { kind: "absent" }, launchFailure: null, retired: false,
    readiness: { origin: "hub-operation", opId: "another-move", sessionId: SESSION, epoch: home.epoch, file: f.file, cwd: f.repo, core: "core-a", terminal: "terminal-a" } });
  await expect(f.ports.inspect(home, f.operation)).rejects.toMatchObject({ code: "participant-readiness-invalid" });
}, 5000);

it("foreign freeze acknowledgement cannot be normalized into this operation", async () => {
  const f = await fixture(), source = { ...f.home, machineId: BOX };
  f.transport.exec = async (_peer, argv) => { const op = JSON.parse(argv[2]); return Buffer.from(JSON.stringify({ code: 0, reason: "frozen", operationId: op.id, home: source, epoch: source.epoch,
    repairCommand: null, value: { ...f.sourceManifest, operationId: "another-move", epoch: source.epoch, owner: null, barriers: [], intercomGeneration: "fence-a" } })); };
  await expect(f.ports.freeze(source, f.operation)).rejects.toMatchObject({ code: "participant-reply-invalid" });
  expect(f.worktree.db.prepare("SELECT state FROM roam_sessions WHERE session_id=?").get(SESSION)).toEqual({ state: "active" });
}, 5000);

it("file mutation during workspace readiness cannot reach running intent", async () => {
  const f = await fixture(), home = casHome(f.global.db, f.home, HUB, f.operation.id, HUB), run = f.bindings.participant!.git.run;
  let edited = false;
  f.bindings.participant!.git.run = async (cwd, argv, options) => {
    if (!edited && argv.includes("write-tree")) { edited = true; writeFileSync(f.file, readFileSync(f.file, "utf8") + JSON.stringify({ type: "message", id: "late-entry", parentId: "leaf-a", timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "late", timestamp: 2 } }) + "\n"); }
    return run(cwd, argv, options);
  };
  await expect(f.ports.start(home, { session: f.sourceManifest, workspace: f.sourceWorkspace } as PreparedMove, f.operation)).rejects.toMatchObject({ code: "participant-file-mismatch" });
  expect(await createRunningIntentAuthority(f.global.db).get(SESSION)).toBeNull();
  expect(f.events).not.toContain("wake");
}, 5000);

it("move engine retains the named missing-evidence blocker", async () => {
  const f = await fixture(); delete f.bindings.evidence!.bridge;
  const operation = { ...f.operation, id: "missing-evidence" };
  const result = await moveSession({ operation, sessionId: SESSION, destinationMachine: BOX }, f.ports);
  expect(result.code).toBe(1);
  if (result.ok) throw new Error("Expected missing-evidence refusal");
  expect(result.refusal.blockers).toEqual(["adapter-unbound:evidence.bridge"]);
  expect(f.events).toEqual([]);
}, 5000);

it("cleanup requires durable destination readiness and source absence before deleting refs", async () => {
  const f = await fixture(), ref = `refs/spider-roam/${f.operation.id}/keep`;
  git(f.repo, ["update-ref", ref, "HEAD"]);
  await expect(f.ports.cleanup(f.check, f.operation)).rejects.toMatchObject({ code: "move-cleanup-unproved" });
  expect(git(f.repo, ["rev-parse", ref]).toString().trim()).toBe(f.sourceWorkspace.snapshot.head);
  expect(f.events).toEqual([]);
}, 5000);

it("cleanup retries recognize their removed staging without changing installed files", async () => {
  const { f, operation } = interruptedFixture;
  let first = true;
  f.bindings.handoff!.presentReadyTarget = async () => ({ status: "complete", reason: "presented", presentation: null });
  f.bindings.participant!.cleanupTerminal = async operation => {
    expect((operation.args.presentation as JsonObject).status).toBe("complete");
    if (first) { first = false; throw new Error("fixture-terminal-pending"); }
  };
  const pending = (await recoverMoveAdapters(f.ports, f.bindings)).find(row => row.operationId === operation.id)!;
  expect(pending).toMatchObject({ code: 0, ok: true, reason: "moved", value: { sourceCleanup: { status: "pending", blockers: ["move-pending"] } } });
  const { readMoveReservation } = await import("../move");
  expect(readMoveReservation(SESSION, f.journal)).toMatchObject({ moveId: operation.id });
  expect(f.journal.read(operation.id).some(row => row.action === "done")).toBe(false);
  expect(f.worktree.db.prepare("SELECT state FROM roam_sessions WHERE session_id=?").get(SESSION)).toEqual({ state: "retired" });
  const installed = readFileSync(f.target), retry = (await recoverMoveAdapters(f.ports, f.bindings)).find(row => row.operationId === operation.id)!;
  expect(retry).toMatchObject({ code: 0, ok: true, value: { sourceCleanup: { status: "done" } } });
  expect(readMoveReservation(SESSION, f.journal)).toBeNull();
  expect(readFileSync(f.target)).toEqual(installed);
  expect(sessionHome(f.global.db, SESSION)).toMatchObject({ machineId: BOX, epoch: 2 });
}, 5000);

it.each(["hub-home", "forward-epoch", "receipt-machine", "retirement-home", "readiness", "freeze-epoch", "freeze-file", "check-source"])("rollback refuses mismatched fresh %s evidence even with a matching local home", async bad => {
  const f = await rollbackFixture(), read = f.bindings.evidence!.rollback!, other = join(f.root, "other-source.jsonl");
  copyFileSync(f.file, other);
  f.bindings.evidence!.rollback = async operation => {
    const proof = await read(operation); if (!proof) return null;
    if (bad === "hub-home") proof.currentHome = { ...proof.currentHome, epoch: 4 };
    if (bad === "forward-epoch") { proof.forwardReceipt = { ...proof.forwardReceipt, epoch: 9 }; proof.retirement = { ...proof.retirement, home: proof.forwardReceipt }; }
    if (bad === "receipt-machine") proof.rollbackReceipt = { ...proof.rollbackReceipt, machineId: BOX };
    if (bad === "retirement-home") proof.retirement = { ...proof.retirement, home: { ...proof.retirement.home, updatedAt: proof.retirement.home.updatedAt + 1 } };
    if (bad === "readiness") proof.retirement = { ...proof.retirement, readiness: { origin: "hub-operation", opId: f.operation.id, sessionId: SESSION, epoch: 2, file: other, cwd: f.repo, core: "core-a", terminal: "terminal-a" } };
    if (bad === "freeze-epoch") proof.freeze = { ...proof.freeze, epoch: 2 };
    if (bad === "freeze-file") proof.freeze = { ...proof.freeze, file: other };
    if (bad === "check-source") proof.check = { ...proof.check, source: { ...proof.check.source, updatedAt: proof.check.source.updatedAt + 1 } };
    return proof;
  };
  const reply = await f.ports.readmitSource(f.home, f.restored, f.operation);
  expect(reply.code).toBe(3);
  expect(f.events).toEqual([]);
  expect(f.reopened()).toBe(false);
  expect(sessionHome(f.global.db, SESSION)).toEqual(f.restored);
  expect(f.worktree.db.prepare("SELECT state,epoch FROM roam_sessions WHERE session_id=?").get(SESSION)).toEqual({ state: "frozen", epoch: 1 });
}, 5000);

it("recovery adapter records app absence as pending presentation rather than claiming completion", async () => {
  const f = await fixture(); f.bindings.handoff!.presentReadyTarget = async () => { throw new Error("app-absent"); };
  const target = { machineId: HUB, alias: null, sessionId: SESSION, homeEpoch: 1, coreId: "core-a", terminalId: "terminal-a" };
  const present = f.ports.recovery.presentReadyTarget(target);
  await expect(present).resolves.toMatchObject({ status: "pending" });
  const presented = await present;
  expect(presented.status).toBe("pending");
  expect(presented.reason).toBe("presentation-unavailable");
  expect(sessionHome(f.global.db, SESSION)).toEqual(f.home);
}, 5000);

it("destroyed mirror with pending presentation returns typed recovery success without another commit", async () => {
  const f = preparedFixture, moved = mirrorPrepared;
  casHome(f.global.db, f.home, BOX, f.operation.id, HUB);
  const mirrorOperation = { id: "pending-mirror", kind: "session-mirror", machineId: BOX, expectedEpoch: 2, args: { sessionId: SESSION } };
  f.journal.begin(mirrorOperation);
  await appendMirror({ sessionId: SESSION, epoch: 2, source: moved.session, root: f.bindings.recovery!.mirrorRoot, operationId: mirrorOperation.id }, f.journal);
  f.bindings.recovery!.restoreWorkspace = async () => ({ cwd: f.repo, parent: null });
  f.bindings.handoff!.presentReadyTarget = async () => { throw new Error("app-absent"); };
  const input = { machineId: BOX, confirmation: `destroyed ${BOX}` }, recovered = await forgetMachineWithAdapters(input, f.ports);
  expect(recovered.ok).toBe(true);
  if (!recovered.ok) throw new Error("Expected committed recovery success");
  expect(recovered.code).toBe(0);
  expect(recovered.presentation).toBe("pending");
  expect(recovered.value).toHaveLength(1);
  expect(recovered.value[0]).toMatchObject({ machineId: HUB, epoch: 3 });
  expect((await createRunningIntentAuthority(f.global.db).get(SESSION))?.epoch).toBe(3);
  expect(readLocal<{ owner: unknown }>(f.global.db, "participant-intent", SESSION)?.owner).toEqual({ kind: "hub-restoration", machineId: HUB, moveId: recovered.value[0].moveId, revokedMachineId: BOX });
  expect(await forgetMachineWithAdapters(input, f.ports)).toEqual(recovered);
  expect(f.global.db.prepare("SELECT COUNT(*) AS count FROM roam_home_actions WHERE session_id=? AND expected_epoch=2").get(SESSION)).toEqual({ count: 1 });
}, 5000);

it("destroyed mirror partial recovery never reports uncommitted homes as success", async () => {
  const f = preparedFixture, moved = mirrorPrepared;
  casHome(f.global.db, f.home, BOX, f.operation.id, HUB);
  assignInitialHome(f.global.db, "session-b", BOX, HUB);
  const mirrorOperation = { id: "partial-mirror", kind: "session-mirror", machineId: BOX, expectedEpoch: 2, args: { sessionId: SESSION } };
  f.journal.begin(mirrorOperation);
  await appendMirror({ sessionId: SESSION, epoch: 2, source: moved.session, root: f.bindings.recovery!.mirrorRoot, operationId: mirrorOperation.id }, f.journal);
  f.bindings.recovery!.restoreWorkspace = async () => ({ cwd: f.repo, parent: null });
  f.bindings.handoff!.presentReadyTarget = async () => { throw new Error("app-absent"); };
  const result = await forgetMachineWithAdapters({ machineId: BOX, confirmation: `destroyed ${BOX}` }, f.ports);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("An uncommitted home cannot be recovered");
  expect(result.code).toBe(1);
  expect(result.reason).toBe("recovery-mirror-missing");
  expect(result.recovered).toHaveLength(1);
  expect(result.recovered[0]).toMatchObject({ ok: true, presentation: "pending", home: { sessionId: SESSION, machineId: HUB, epoch: 3 } });
  expect(sessionHome(f.global.db, "session-b")).toMatchObject({ machineId: BOX, epoch: 1 });
}, 5000);

async function mountFirstMoveSource(f: Awaited<ReturnType<typeof transferFixture>>, order: string[]) {
  const record = f.journal.record; f.journal.record = (id, action, value) => { if (process.env.SPIDER_FIRST_MOVE_TRACE) console.error("first-move", action, value.action ?? value.state ?? ""); record(id, action, value); };
  const identity = { bootId: "source-boot", pid: process.pid, startTime: "fixture-source" };
  f.owner({ kind: "live", identity });
  const host = createHostSessionFixture({ cwd: f.repo, sessionId: SESSION, sessionFile: f.file });
  Object.assign(host.ctx.sessionManager, { getLeafId: () => f.sourceManifest.leaf, getHeader: () => ({ type: "session", id: SESSION, cwd: f.repo }) });
  const gate = registerAdmission(host.pi as unknown as ExtensionAPI, {
    expectedEpoch: null, knownParticipant: () => !!readSessionState(f.worktree.db, SESSION), localMachine: async () => HUB,
    captureVersion: () => { const home = sessionHome(f.global.db, SESSION); return `${readSessionState(f.worktree.db, SESSION)?.epoch ?? "none"}:${home && home !== "unknown" ? home.epoch : "none"}`; },
    lockUntracked: () => true, warnOnce() {},
    async load() { const state = readSessionState(f.worktree.db, SESSION), home = sessionHome(f.global.db, SESSION); return { home: home === "unknown" ? null : home,
      states: state ? [state] : [], origin: HUB, participating: !!state || !!home, captureSafe: true, unfinishedFreeze: false, initialConflict: false }; },
    async ready() { order.push("admit"); },
    async lock() {
      const socket = await serveSessionControl({ sessionId: SESSION, runtimeRoot: f.bindings.participant!.runtimeRoot, ports: {
        gate, journal: f.journal, stores: f.bindings.participant!.stores.map(row => row.db), expectedStores: ["global", REPO, WT], intercom: { address: f.bindings.intercom!.address, ports: f.bindings.intercom!.ports },
        async drain() {}, async resume() {}, async ingestThrough() {}, authorizeAbort: async () => null, onHubRestored: () => () => {},
        initialInspect: async operation => {
          if (operation.expectedEpoch !== 1 || sessionHome(f.global.db, SESSION) !== null || readSessionState(f.worktree.db, SESSION)) throw new Error("Not an unassigned origin");
          return { blockers: [], owner: identity, file: f.file, cwd: f.repo, leaf: f.sourceManifest.leaf };
        },
        async inspect() { return { blockers: [], owner: identity, file: f.file, cwd: f.repo, leaf: f.sourceManifest.leaf }; },
        async shutdown() { await gate.close(); f.owner({ kind: "absent" }); },
      } }); closes.push(() => socket.close()); return async () => {};
    },
  }); closes.push(() => gate.close());
  for (const handler of host.hooks.get("session_start") ?? []) await handler({ reason: "startup" }, host.ctx);
  expect(gate.inspect()).toMatchObject({ kind: "ordinary", home: null });
  const seed = f.ports.seed;
  f.ports.seed = async check => { order.push("seed"); expect(gate.inspect().kind).toBe("ordinary"); const result = await seed(check); expect(readSessionState(f.worktree.db, SESSION)?.state).toBe("active"); return result; };
  const sync = f.bindings.sync!;
  const syncCall = sync.sync.bind(sync);
  sync.sync = async peer => { order.push("sync"); const result = await syncCall(peer); const home = sessionHome(f.global.db, SESSION); if (home && home !== "unknown" && home.epoch === 1) order.push("hub-epoch1"); return result; };
  sync.barriers = async (_peer, barriers) => {
    const reached = () => barriers.every(barrier => { if (barrier.through === 0) return true; const db = f.remote.stores!.open(barrier.storeKey); const row = db.prepare("SELECT last_seq FROM roam_cursors WHERE peer_machine=? AND peer_stream=?").get(HUB, barrier.stream) as { last_seq: number } | undefined; return !!row && row.last_seq >= barrier.through; });
    if (!reached()) await sync.sync(BOX);
    return reached();
  };
  const freeze = f.ports.freeze, retire = f.ports.retire, wake = f.remote.participant!.wake, readiness = f.remote.participant!.readiness;
  f.ports.freeze = async (...args) => { const result = await freeze(...args); order.push("freeze"); return result; };
  f.remote.participant!.wake = async request => { order.push("start"); return wake(request); };
  f.remote.participant!.readiness = async id => { const ready = await readiness(id); if (ready) order.push("ready"); return ready; };
  f.ports.retire = async (...args) => { const result = await retire(...args); order.push("retire"); return result; };
  return gate;
}
let firstOrder: string[] = [];
let firstSetup: Awaited<ReturnType<typeof prepareAppAbsentFixture>>;
beforeEach(async context => {
  if (!context.task.name.startsWith("never-homed persistent")) return;
  const order = firstOrder = [];
  firstSetup = await prepareAppAbsentFixture({ homeless: true, skipCrash: true, beforeMove: async (f, operation) => {
    await mountFirstMoveSource(f, order);
    // The fake box already has the identical fixture checkout. Keep this test on
    // first-home ownership; real Git transfer is exercised by the adapter tests above.
    const prepared = async (stage: "pre" | "final"): Promise<PreparedMove> => {
      const session = await stageSession({ source: f.sourceManifest, destinationCwd: f.destination, destinationParent: null, limits: f.config.limits,
        segment: { version: 1, moveId: operation.id, epoch: 2, previousMachine: HUB, nextMachine: BOX, historyMachine: HUB, parentRef: null } }, join(f.root, "first-stage"));
      copyFileSync(session.file, f.target);
      const installed = { ...session, file: f.target };
      recordLocation(f.remoteGlobal.db, { sessionId: SESSION, stores: ["global", REPO, WT], home: null, file: f.target, cwd: f.destination });
      return { session: installed, workspace: { ...f.sourceWorkspace, root: f.destination, moveId: operation.id,
        snapshot: { ...f.sourceWorkspace.snapshot, root: f.repo, moveId: operation.id, stage } } };
    };
    f.ports.prepare = () => prepared("pre"); f.ports.transfer = () => prepared("final");
    f.ports.verifySource = async ack => { const actual = await inspectSession(ack.file, ack.sessionId, ack.leaf, f.config.limits); expect(actual.size).toBe(ack.size); expect(actual.sha256).toBe(ack.sha256); expect(actual.historySha256).toBe(f.sourceManifest.historySha256); await verifyFrozenSession(actual, f.config.limits); };
    f.ports.cleanup = async () => {};
  } });
}, 5000);
it("never-homed persistent Mac session seeds syncs admits freezes and moves to a fake box", async () => {
  const order = firstOrder, { f, initial } = await firstSetup.run();
  expect(initial.code).toBe(0);
  expect([...new Set(order)]).toEqual(["seed", "sync", "hub-epoch1", "admit", "freeze", "start", "ready", "retire"]);
  const check = f.journal.read("app-absent").find(row => row.action === "move-action-complete" && row.result.action === "check")!.result.value as unknown as MoveCheck;
  expect(check.source).toMatchObject({ machineId: HUB, epoch: 1, moveId: null });
  expect(sessionHome(f.global.db, SESSION)).toMatchObject({ machineId: BOX, epoch: 2 });
  expect(readSessionState(f.worktree.db, SESSION)).toMatchObject({ state: "retired", epoch: 1 });
  expect(readSessionState(f.remoteWorktree.db, SESSION)).toMatchObject({ state: "active", epoch: 2 });
}, 5000);
it("a conflict marker refuses the first move and names explicit claim before seeding or freeze", async () => {
  const f = await fixture(HUB, true);
  f.global.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES (?,'',1,NULL,1)").run(SESSION);
  const result = await moveSession({ operation: { ...f.operation, id: "conflict-first" }, sessionId: SESSION, destinationMachine: BOX }, f.ports);
  expect(result.reason).toBe("initial-home-conflict");
  expect(result.repairCommand).toContain("spider roam claim");
  expect(f.events).toEqual([]);
  expect(readSessionState(f.worktree.db, SESSION)).toBeNull();
}, 5000);
it.each(["missing-seed", "missing-sync", "stale-seed"])("first move refuses %s before freeze without assigning a home itself", async mode => {
  const order: string[] = [];
  const { f, initial } = await appAbsentFixture({ homeless: true, skipCrash: true, beforeMove: async f => {
    await mountFirstMoveSource(f, order);
    if (mode === "missing-seed") f.ports.seed = async () => ["global", REPO, WT].map(key => f.bindings.stores!.head(key as StoreKey));
    if (mode === "missing-sync") f.bindings.sync!.sync = async () => [];
    if (mode === "stale-seed") seedSession(f.worktree.db, SESSION, 2, WT, 100);
  } });
  expect(initial.code).not.toBe(0);
  expect(order).not.toContain("freeze");
  expect(order).not.toContain("start");
  expect(sessionHome(f.global.db, SESSION)).toBeNull();
}, 5000);

it.each(["pi-auth-missing", "tool-auth-missing"])("destination %s is checked before freeze and tool warnings remain nonblocking", async reason => {
  const f = await fixture();
  f.bindings.participant!.auth = async () => [{ reason, severity: reason === "pi-auth-missing" ? "block" : "warning", repairCommand: null }];
  if (reason === "pi-auth-missing") await expect(f.ports.check({ operation: f.operation, sessionId: SESSION, destinationMachine: BOX })).rejects.toMatchObject({ code: "participant-auth-unavailable" });
  else expect((await f.ports.check({ operation: f.operation, sessionId: SESSION, destinationMachine: BOX })).warnings).toContain(reason);
  expect(f.events).toEqual([]);
}, 5000);

it("freeze completeness requires the handoff dependency", async () => {
  const f = await fixture(); delete f.bindings.handoff;
  expect(unboundMoveEffects(f.bindings)).toContain("freeze");
  await expect(f.ports.freeze(f.home, f.operation)).rejects.toMatchObject({ code: "adapter-unbound:freeze" });
  expect(f.events).toEqual([]);
}, 5000);

it("ready refuses a foreign move binding before any intake operation", async () => {
  const f = await fixture();
  const home = casHome(f.global.db, f.home, BOX, "foreign-move", HUB);
  let called = false; f.bindings.intercom!.ports.ready = async () => { called = true; return { intercomAddress: SESSION, warnings: [] }; };
  await expect(f.ports.intercom.ports.ready(f.fence, await f.ports.intercom.destinationEndpoint(home))).rejects.toMatchObject({ code: "intercom-endpoint-not-ready" });
  expect(called).toBe(false);
}, 5000);

it.each([true, false])("box source view cleanup requires hub presentation, not its local journal (proved %s)", async proved => {
  const { presentationTaskId } = await import("../move-ports");
  const f = await fixture(), source = casHome(f.global.db, f.home, BOX, "previous", HUB);
  const destination = casHome(f.global.db, source, HUB, f.operation.id, HUB), check = { ...f.check, source, destinationMachine: HUB };
  const target = { machineId: HUB, alias: null, sessionId: SESSION, homeEpoch: destination.epoch, coreId: "core-a", terminalId: "terminal-a" };
  const presentation = { status: "complete", reason: "presented", target, presentation: null };
  const taskId = presentationTaskId(f.operation.id);
  f.journal.begin({ id: taskId, kind: "move-presentation", machineId: HUB, expectedEpoch: destination.epoch, args: {} });
  f.journal.record(taskId, "presentation", presentation);
  const sourceJournal = openFreezeJournal(join(f.root, "source-journal.db"));
  const ready = { origin: "hub-operation", opId: f.operation.id, sessionId: SESSION, epoch: destination.epoch, file: f.file, cwd: f.repo, core: "core-a", terminal: "terminal-a" };
  const proof = { source, stopped: { kind: "absent" }, destination: { home: destination, owner: { kind: "live", identity: { bootId: "boot", pid: 42, startTime: "start" } }, readiness: ready, retired: false, launchFailure: null } };
  const op: Operation = { id: "source-view-cleanup", kind: "move-cleanup-terminal", machineId: BOX, expectedEpoch: source.epoch,
    args: JSON.parse(JSON.stringify({ sessionId: SESSION, sourceMachine: HUB, moveId: f.operation.id, check, proof, presentation })) };
  let hubQueries = 0;
  const boxConfig = { ...f.config, machineId: BOX, role: "box" as const };
  const bindings = { ...f.bindings, participant: { ...f.bindings.participant!, config: boxConfig },
    evidence: { ...f.bindings.evidence!, ...createPushedMoveEvidencePorts(f.global.db, boxConfig) } };
  if (!proved) {
    expect(await handleMoveParticipantOperation(op, sourceJournal, bindings)).toMatchObject({ code: 3, reason: "waiting-for-hub-evidence" });
    expect(f.events).toEqual([]);
  }
  const hubPresentation = f.bindings.evidence!.presentation!;
  const queryHub = async (operation: Operation) => { hubQueries++; return hubPresentation(operation); };
  const observed = await queryHub(op);
  if (!observed) throw new Error("fixture hub presentation missing");
  const pushed = { ...op, args: { ...op.args, hubEvidence: { kind: "presentation", home: JSON.parse(JSON.stringify(destination)),
    value: proved ? observed : { ...observed, status: "pending" } } } };
  const result = handleMoveParticipantOperation(pushed, sourceJournal, bindings);
  if (proved) { expect((await result).code).toBe(0); expect(f.events).toEqual(["terminal-cleanup"]); }
  else { await expect(result).rejects.toMatchObject({ code: "destination-presentation-unproved" }); expect(f.events).toEqual([]); }
  expect(hubQueries).toBe(1); expect(sourceJournal.read(f.operation.id)).toEqual([]);
}, 5000);

it("box source fence inspection and readiness use only the broker that closed it", async () => {
  const f = await fixture(), source = casHome(f.global.db, f.home, BOX, "previous", HUB);
  const check = { ...f.check, source, destinationMachine: HUB };
  f.journal.record(f.operation.id, "move-action-complete", { action: "check", value: check as unknown as JsonObject });
  const sourceJournal = openFreezeJournal(join(f.root, "box-fence.db"));
  sourceJournal.beginFreeze(SESSION, f.operation.id, source.epoch);
  const fence = { ...f.fence, expectedEpoch: source.epoch }; sourceJournal.bindIntercomFence(fence);
  const calls: string[] = [], closed = new Set([fence.generation]);
  const sourceBindings = { ...f.bindings, participant: { ...f.bindings.participant!, config: { ...f.config, machineId: BOX, role: "box" as const } },
    intercom: { ...f.bindings.intercom!, ports: { ...f.bindings.intercom!.ports,
      async inspect(value: typeof fence) { if (!closed.has(value.generation)) throw new Error("wrong-broker"); calls.push("inspect"); return { blockers: [], cancelledWork: [], warnings: [] }; },
      async checkGeneration(value: typeof fence) { if (!closed.has(value.generation)) throw new Error("wrong-broker"); calls.push("check"); },
      async ready(value: typeof fence) { if (!closed.has(value.generation)) throw new Error("wrong-broker"); calls.push("ready"); return { intercomAddress: SESSION, warnings: [] }; },
    } } };
  f.transport.exec = async (_peer, argv) => Buffer.from(JSON.stringify(await handleMoveParticipantOperation(JSON.parse(argv[2]), sourceJournal, sourceBindings)));
  f.bindings.intercom!.ports.inspect = async () => { throw new Error("hub-never-closed-this-fence"); };
  f.bindings.intercom!.ports.checkGeneration = async () => { throw new Error("hub-never-closed-this-fence"); };
  f.bindings.intercom!.ports.ready = async () => { throw new Error("hub-never-closed-this-fence"); };
  expect((await f.ports.intercom.ports.inspect(fence)).blockers).toEqual([]);
  await f.ports.intercom.ports.checkGeneration(fence);
  const destination = casHome(f.global.db, source, HUB, f.operation.id, HUB);
  await f.ports.start(destination, { session: f.sourceManifest, workspace: f.sourceWorkspace } as PreparedMove, f.operation);
  await f.ports.intercom.ports.ready(fence, await f.ports.intercom.destinationEndpoint(destination));
  expect(calls).toEqual(["inspect", "check", "ready"]);
}, 5000);

it("pending readiness reuses the same session-bound local launch without relaunching", async () => {
  const f = await fixture(), away = casHome(f.global.db, f.home, BOX, "outgoing", HUB), home = casHome(f.global.db, away, HUB, f.operation.id, HUB);
  const prepared = { session: f.sourceManifest, workspace: f.sourceWorkspace } as PreparedMove;
  const wakes: unknown[] = [], queries: unknown[] = [];
  f.bindings.participant!.wake = async request => {
    wakes.push(request); f.journal.begin({ id: "local-launch-a", kind: "exact-session-launch", machineId: HUB, expectedEpoch: home.epoch, args: { sessionId: request.sessionId } });
    f.owner({ kind: "live", identity: { bootId: "fixture-boot", pid: 42, startTime: "fixture-start" } });
    return { ok: true, launchId: "local-launch-a" };
  };
  f.bindings.participant!.readiness = async query => {
    queries.push(query); const ready = readReadiness(f.journal, query.launchId);
    return ready?.sessionId === query.sessionId && ready.epoch === query.epoch ? ready : null;
  };
  expect(await f.ports.start(home, prepared, f.operation)).toMatchObject({ code: 3, reason: "readiness-pending" });
  recordReadiness(f.journal, { origin: "hub-operation", opId: "local-launch-a", sessionId: SESSION, epoch: home.epoch, file: f.file, cwd: f.repo, core: "core-a", terminal: "terminal-a" });
  expect(await f.ports.start(home, prepared, f.operation)).toMatchObject({ code: 0, value: { opId: f.operation.id, sessionId: SESSION } });
  expect(wakes).toEqual([{ sessionId: SESSION, operationId: `${f.operation.id}-session-start-${HUB}` }]);
  expect(queries).toEqual(Array(2).fill({ sessionId: SESSION, launchId: "local-launch-a", epoch: home.epoch }));
}, 5000);

it("first seed uses bounded configured batches and yields while historical rows remain", async () => {
  const f = await fixture(HUB, true), open = f.bindings.stores!.open; let batches = 0, tick = false, rowsAtYield = 0;
  f.config.limits = { ...f.config.limits, targetBatchBytes: 64 * 1024 };
  const insert = f.worktree.db.prepare("INSERT INTO runs(id,session_id,agent,status,task) VALUES(?,?,'worker','done',?)");
  f.worktree.db.raw.transaction(() => { for (let n = 0; n < 64; n++) insert.run(`history-${n}`, SESSION, "x".repeat(2048)); })();
  let yielded: Promise<void> | null = null;
  f.bindings.stores!.open = key => {
    if (key === WT && ++batches === 2) yielded = new Promise<void>(resolve => setImmediate(() => { tick = true; rowsAtYield = (f.worktree.db.prepare("SELECT count(*) AS n FROM roam_versions WHERE entity='runs'").get() as { n: number }).n; resolve(); }));
    return open(key);
  };
  await f.ports.seed(f.check);
  const returnedBeforeYield = !tick; await yielded;
  expect(returnedBeforeYield).toBe(false); expect(rowsAtYield).toBeGreaterThan(0); expect(rowsAtYield).toBeLessThanOrEqual(32); expect(batches).toBeLessThanOrEqual(5);
  expect(f.worktree.db.prepare("SELECT count(*) AS n FROM roam_versions WHERE entity='runs'").get()).toEqual({ n: 64 });
}, 5000);

it("busy first seed exposes a valid named retryable blocker", async () => {
  const f = await fixture(HUB, true);
  f.worktree.db.prepare("INSERT INTO runs(id,session_id,agent,status,task) VALUES('busy',?,'worker','running',?)").run(SESSION, "x".repeat(17 * 1024 * 1024));
  await expect(f.ports.seed(f.check)).rejects.toMatchObject({ code: "session-too-busy-to-seed" });
}, 5000);

it("an unrelated offline sync peer cannot reject an exactly established initial home", async () => {
  const f = await fixture(HUB, true);
  f.bindings.sync!.sync = async () => { assignInitialHome(f.global.db, SESSION, HUB, HUB); return [{ code: 1, reason: "peer-unreachable", operationId: "sync-other", home: null, epoch: null, repairCommand: null, value: null }]; };
  expect(await f.ports.seed(f.check)).toHaveLength(3);
  expect(sessionHome(f.global.db, SESSION)).toMatchObject({ machineId: HUB, epoch: 1, moveId: null });
}, 5000);

it("destination cleanup while its owner is live preserves concurrent session and checkout writes", async () => {
  const { claimIdLock } = await import("@spider/herdr/sessions/id-lock");
  const { f, operation } = interruptedFixture, identity = { pid: 42, startIdentity: "fixture-lock" };
  const lockRoot = join(f.remoteRoot, "herdr");
  let lock: Awaited<ReturnType<typeof claimIdLock>> | undefined, lockFile = "", lockBytes: Buffer | undefined;
  const wake = f.remote.participant!.wake;
  f.remote.participant!.wake = async request => {
    const result = await wake(request);
    lock = await claimIdLock(lockRoot, SESSION, identity, async () => ({ kind: "live", startIdentity: identity.startIdentity }), { bootId: async () => "fixture-boot" });
    lockFile = join(lockRoot, "id-locks", readdirSync(join(lockRoot, "id-locks")).find(name => name.endsWith(".json"))!); lockBytes = readFileSync(lockFile);
    return result;
  };
  const preserved = [join(f.destination, ".git", "index"), join(f.destination, ".git", "config")], before = preserved.map(file => readFileSync(file));
  const content = Buffer.concat([readFileSync(f.target), Buffer.from(JSON.stringify({ type: "message", id: "live-write", parentId: "leaf-a", message: { role: "user", content: "synthetic" } }) + "\n")]);
  f.bindings.handoff!.presentReadyTarget = async () => {
    await new Promise<void>(resolve => setImmediate(() => {
      writeFileSync(f.target, content); writeFileSync(join(f.destination, "tracked.txt"), "concurrent user edit\n"); resolve();
    }));
    return { status: "pending", reason: "app-absent", presentation: null };
  };
  try {
    const result = (await recoverMoveAdapters(f.ports, f.bindings)).find(row => row.operationId === operation.id)!;
    expect(result).toMatchObject({ code: 0, reason: "moved" });
    expect(readFileSync(f.target)).toEqual(content);
    expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("concurrent user edit\n");
    expect(preserved.map(file => readFileSync(file))).toEqual(before);
    expect(readFileSync(lockFile)).toEqual(lockBytes);
    expect(f.remoteWorktree.db.prepare("SELECT state,epoch FROM roam_sessions WHERE session_id=?").get(SESSION)).toEqual({ state: "active", epoch: 2 });
  } finally { await lock?.release(); }
}, 5000);

it("pending presentation survives completed ownership and retires the source view once", async () => {
  const { presentationTaskId } = await import("../move-ports"), f = await fixture();
  const source = casHome(f.global.db, f.home, BOX, "previous", HUB), home = casHome(f.global.db, source, HUB, f.operation.id, HUB);
  const check = { ...f.check, source, destinationMachine: HUB }, target = { machineId: HUB, alias: null, sessionId: SESSION, homeEpoch: home.epoch, coreId: "core-a", terminalId: "terminal-a" };
  const ready = { origin: "hub-operation", opId: f.operation.id, sessionId: SESSION, epoch: home.epoch, file: f.file, cwd: f.repo, core: "core-a", terminal: "terminal-a" };
  const proof = { source, stopped: { kind: "absent" }, destination: { home, owner: { kind: "live", identity: { bootId: "boot", pid: 42, startTime: "start" } }, readiness: ready, retired: false, launchFailure: null } };
  const taskId = presentationTaskId(f.operation.id);
  f.journal.record(f.operation.id, "handoff-presentation-start", { target, sourceFence: { machineId: BOX, sessionId: SESSION, scopeId: null, epoch: source.epoch, moveId: f.operation.id, brokerGeneration: "before" } });
  f.journal.begin({ id: taskId, kind: "move-presentation", machineId: HUB, expectedEpoch: home.epoch, args: { moveId: f.operation.id, sessionId: SESSION } });
  f.journal.record(taskId, "source-view-request", JSON.parse(JSON.stringify({ operation: f.operation, check, proof })));
  f.journal.record(f.operation.id, "done", { code: 0 });
  const sourceJournal = openFreezeJournal(join(f.root, "source-journal.db")), sourceBindings = { ...f.bindings,
    participant: { ...f.bindings.participant!, config: { ...f.config, machineId: BOX, role: "box" as const } },
    evidence: { ...f.bindings.evidence!, ...createPushedMoveEvidencePorts(f.global.db, { ...f.config, machineId: BOX, role: "box" }) } };
  f.transport.exec = async (_peer, argv) => Buffer.from(JSON.stringify(await handleMoveParticipantOperation(JSON.parse(argv[2]), sourceJournal, sourceBindings)));
  f.bindings.handoff!.presentReadyTarget = async () => ({ status: "pending", reason: "app-absent", presentation: null });
  expect(await recoverMoveAdapters(f.ports, f.bindings)).toEqual([]);
  expect(f.events).toEqual([]);
  f.bindings.handoff!.presentReadyTarget = async () => ({ status: "complete", reason: "presented", presentation: null });
  expect(await recoverMoveAdapters(f.ports, f.bindings)).toEqual([]);
  expect(f.events).toEqual(["terminal-cleanup"]);
  expect(f.journal.lookupOperation(taskId)?.state).toBe("done");
  await recoverMoveAdapters(f.ports, f.bindings);
  expect(f.events).toEqual(["terminal-cleanup"]);
}, 5000);

it("cleanup presents the destination before a remote source removes its view", async () => {
  const f = await fixture(), THIRD = "00000000-0000-4000-8000-000000000003";
  f.config.peers = [...f.config.peers, { ...f.config.peers[0], machineId: THIRD, alias: "box-2.invalid" }];
  const source = casHome(f.global.db, f.home, BOX, "previous", HUB), home = casHome(f.global.db, source, THIRD, f.operation.id, HUB);
  const check = { ...f.check, source, destinationMachine: THIRD }, target = { machineId: THIRD, alias: null, sessionId: SESSION, homeEpoch: home.epoch, coreId: "core-a", terminalId: "terminal-a" };
  const ready = { origin: "hub-operation", opId: f.operation.id, sessionId: SESSION, epoch: home.epoch, file: f.file, cwd: f.repo, core: "core-a", terminal: "terminal-a" };
  f.journal.record(f.operation.id, "handoff-presentation-start", { target, sourceFence: { machineId: BOX, sessionId: SESSION, scopeId: null, epoch: source.epoch, moveId: f.operation.id, brokerGeneration: "before" } });
  f.journal.record(f.operation.id, "move-action-complete", { action: "source-retire", value: { kind: "absent" } });
  f.journal.record(f.operation.id, "move-action-complete", { action: "final-inspect", value: JSON.parse(JSON.stringify({ home, owner: { kind: "live", identity: { bootId: "boot", pid: 42, startTime: "start" } }, readiness: ready, retired: false, launchFailure: null })) });
  const sourceJournal = openFreezeJournal(join(f.root, "source-journal.db")), sourceBindings = { ...f.bindings,
    participant: { ...f.bindings.participant!, config: { ...f.config, machineId: BOX, role: "box" as const } },
    evidence: { ...f.bindings.evidence!, ...createPushedMoveEvidencePorts(f.global.db, { ...f.config, machineId: BOX, role: "box" }) } };
  f.transport.exec = async (peer, argv) => {
    const operation = JSON.parse(argv[2]) as Operation;
    if (peer.machineId === BOX) return Buffer.from(JSON.stringify(await handleMoveParticipantOperation({ ...operation, kind: "move-cleanup-terminal" }, sourceJournal, sourceBindings)));
    expect(operation.kind).toBe("move-cleanup"); expect(peer.machineId).toBe(THIRD);
    return Buffer.from(JSON.stringify({ operationId: operation.id, code: 0, epoch: operation.expectedEpoch, value: {} }));
  };
  await f.ports.cleanup(check, f.operation);
  expect(f.events).toEqual(["present", "terminal-cleanup"]);
  expect(sourceJournal.read(f.operation.id)).toEqual([]);
}, 5000);

it.each(["mirrors", "retireOnly", "supervisorHandshake"] as const)("missing recovery %s is diagnosed and forget refuses before revocation", async port => {
  const f = await fixture();
  delete f.bindings.recovery![port];
  expect(unboundMoveEffects(f.bindings)).toContain(`recovery.${port}`);
  expect(await forgetMachine({ machineId: BOX, confirmation: `destroyed ${BOX}` }, f.ports)).toMatchObject({ code: 1, reason: `adapter-unbound:recovery.${port}` });
  expect(f.privateDb.prepare("SELECT 1 FROM sqlite_master WHERE name='roam_machine_revocations'").get()).toBeUndefined();
}, 5000);

it("dormant rollback waits for observed readiness and retries the same launch after its owner becomes live", async () => {
  const f = await rollbackFixture(), identity = { bootId: "fixture-boot", pid: 4242, startTime: "readmitted-owner" };
  let ready: HubOperationReadiness | null = null, launches = 0;
  f.bindings.participant!.wake = async input => {
    expect(input).toEqual({ sessionId: SESSION, operationId: `${f.operation.id}-move-readmit-${HUB}` });
    launches++; f.owner({ kind: "live", identity });
    return { ok: true, launchId: "local-readmit-launch" };
  };
  f.bindings.participant!.readiness = async query => {
    expect(query).toEqual({ sessionId: SESSION, launchId: "local-readmit-launch", epoch: 3 });
    return ready;
  };
  f.bindings.participant!.observation = async () => ({ home: f.restored, owner: { kind: "live", identity }, readiness: ready, retired: false, launchFailure: null });
  expect(await f.ports.readmitSource(f.home, f.restored, f.operation)).toMatchObject({ code: 3, refusal: { blockers: ["readiness-pending"] } });
  expect(await f.ports.readmitSource(f.home, f.restored, f.operation)).toMatchObject({ code: 3, refusal: { blockers: ["readiness-pending"] } });
  expect(f.reopened()).toBe(false);
  ready = { origin: "hub-operation", opId: "local-readmit-launch", sessionId: SESSION, epoch: 3, file: f.file, cwd: f.repo, core: "core-a", terminal: "terminal-a" };
  f.journal.begin({ id: ready.opId, kind: "exact-session-launch", machineId: HUB, expectedEpoch: 3, args: {} });
  recordReadiness(f.journal, ready);
  const outcome = await f.ports.readmitSource(f.home, f.restored, f.operation);
  expect(outcome).toMatchObject({ code: 0, reason: "rollback-readmitted" });
  expect(f.reopened()).toBe(true);
  expect(launches).toBe(1);
  expect(await f.ports.readmitSource(f.home, f.restored, f.operation)).toEqual(outcome);
  expect(readFileSync(f.file, "utf8")).not.toContain("spider-roam-segment");
}, 5000);
it("hub-role rollback launches only after releasing the real ID and file locks", async () => {
  const f = await rollbackFixture();
  let ready: HubOperationReadiness | null = null;
  f.bindings.participant!.wake = async () => {
    await f.bindings.participant!.withBothLocks(SESSION, async () => { f.events.push("launch-locks-acquired"); });
    f.owner({ kind: "live", identity: { bootId: "fixture-boot", pid: 4242, startTime: "hub-readmit-owner" } });
    ready = { origin: "hub-operation", opId: "hub-readmit-launch", sessionId: SESSION, epoch: 3, file: f.file, cwd: f.repo, core: "core-a", terminal: "terminal-a" };
    return { ok: true, launchId: ready.opId };
  };
  f.bindings.participant!.readiness = async () => ready;
  expect(await f.ports.readmitSource(f.home, f.restored, f.operation)).toMatchObject({ code: 0 });
  expect(f.events).toContain("launch-locks-acquired");
}, 5000);
it("a same-generation fence changed during readmission never reopens intake", async () => {
  const f = await rollbackFixture(), fence = f.bindings.intercom!.rollback.currentFence;
  let reads = 0;
  f.bindings.intercom!.rollback.currentFence = async (...args) => { const current = await fence(...args); return ++reads === 1 ? current : { ...current!, address: { ...current!.address, scopeId: "changed-scope" } }; };
  expect(await f.ports.readmitSource(f.home, f.restored, f.operation)).toMatchObject({ code: 3 });
  expect(f.reopened()).toBe(false);
}, 5000);

it("readmission cannot reopen a replaced fence even when a fresh proof now names its generation", async () => {
  const f = await rollbackFixture(), proof = f.bindings.evidence!.rollback!, fence = f.bindings.intercom!.rollback.currentFence;
  let replaced = false;
  const wake = f.bindings.participant!.wake;
  f.bindings.participant!.wake = async input => { const result = await wake(input); replaced = true; return result; };
  f.bindings.evidence!.rollback = async operation => {
    const value = await proof(operation);
    return replaced && value ? { ...value, freeze: { ...value.freeze, intercomGeneration: "replacement-generation" } } : value;
  };
  f.bindings.intercom!.rollback.currentFence = async (...args) => { const value = await fence(...args); return replaced && value ? { ...value, generation: "replacement-generation" } : value; };
  expect(await f.ports.readmitSource(f.home, f.restored, f.operation)).toMatchObject({ code: 3 });
  expect(f.events).toContain("wake");
  expect(f.reopened()).toBe(false);
}, 5000);

let abortPrepared: Awaited<ReturnType<typeof transferFixture>>;
let resumeAbortPrepare: () => void;
beforeEach(async context => {
  if (!context.task.name.startsWith("cancel aborts") && !context.task.name.startsWith("fresh move after cancel") && !context.task.name.startsWith("cancel cleanup")) return;
  abortPrepared = await transferFixture();
  const f = abortPrepared;
  f.remoteGlobal.db.prepare("INSERT INTO session_homes VALUES (?,?,?,?,?)").run(SESSION, HUB, f.home.epoch, null, f.home.updatedAt);
  writeFileSync(join(f.repo, "tracked.txt"), "local edit\n");
}, 5000);
beforeEach(async context => {
  if (!context.task.name.startsWith("cancel aborts") && !context.task.name.startsWith("fresh move after cancel") && !context.task.name.startsWith("cancel cleanup")) return;
  const f = abortPrepared;
  const exec = f.transport.exec;
  f.transport.exec = async (peer, argv, options) => {
    if (argv[1] === "agent" && JSON.parse(argv[2]).kind === "move-import") throw new Error("fixture-paused-before-import");
    return exec(peer, argv, options);
  };
  resumeAbortPrepare = () => { f.transport.exec = exec; };
  await expect(f.ports.prepare(f.check, f.operation)).rejects.toThrow("fixture-paused-before-import");
}, 5000);
beforeEach(async context => {
  if (!context.task.name.startsWith("cancel aborts") && !context.task.name.startsWith("fresh move after cancel") && !context.task.name.startsWith("cancel cleanup")) return;
  const f = abortPrepared;
  resumeAbortPrepare();
  await f.ports.prepare(f.check, f.operation);
  f.journal.record(f.operation.id, "move-request", { sessionId: SESSION, destinationMachine: BOX, operation: f.operation as unknown as JsonObject });
  f.journal.record(f.operation.id, "move-action-complete", { action: "check", value: f.check as unknown as JsonObject });
}, 5000);
beforeEach(async context => {
  if (context.task.name.startsWith("fresh move after cancel")) expect(await cancelMove(abortPrepared.operation.id, abortPrepared.ports)).toMatchObject({ code: 0 });
}, 5000);
it("cancel aborts a prestaged destination and removes snapshot refs and staging", async () => {
  const f = abortPrepared;
  expect(await cancelMove(f.operation.id, f.ports)).toMatchObject({ code: 0, reason: "cancelled" });
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("fixture\n");
  for (const root of [f.repo, f.destination]) expect(git(root, ["for-each-ref", "--format=%(refname)", "refs/spider-roam/move-a/"]).toString().trim()).toBe("");
  const pool = openOutgoingStaging(join(f.root, "roam", "staging"), f.config.limits, false);
  try { expect(pool.inspect("move-a-session").current).toBeNull(); } finally { pool.close(); }
  expect(existsSync(f.target)).toBe(false);
}, 5000);
it("fresh move after cancel prepares the same destination successfully", async () => {
  const f = abortPrepared, operation = { ...f.operation, id: "move-after-cancel" }; f.journal.begin(operation);
  const next = await f.ports.prepare(f.check, operation);
  expect(next.workspace.snapshot.moveId).toBe(operation.id);
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("local edit\n");
}, 5000);

it("an absent production mirror is reported as lost history, not a forever-pending transfer", async () => {
  const f = await fixture();
  expect(await f.ports.recovery.mirror(SESSION, f.home.epoch)).toBeNull();
}, 5000);

it("completed readmission returns the same receipt after its original fence has opened", async () => {
  const f = await rollbackFixture(), first = await f.ports.readmitSource(f.home, f.restored, f.operation);
  expect(first.code).toBe(0);
  f.bindings.intercom!.rollback.currentFence = async () => null;
  expect(await f.ports.readmitSource(f.home, f.restored, f.operation)).toEqual(first);
  expect(f.events.filter(value => value === "wake")).toHaveLength(1);
}, 5000);

it.each(["file", "cwd", "sessionId", "epoch", "opId", "origin"] as const)("readmission refuses an observed readiness with a mismatched %s", async field => {
  const f = await rollbackFixture(), observe = f.bindings.participant!.readiness;
  f.bindings.participant!.readiness = async query => {
    const ready = await observe(query);
    return ready ? { ...ready, [field]: field === "epoch" ? 99 : field === "origin" ? "box-local" : "wrong-readiness" } as HubOperationReadiness : null;
  };
  expect(await f.ports.readmitSource(f.home, f.restored, f.operation)).toMatchObject({ code: 3 });
  expect(f.reopened()).toBe(false);
}, 5000);
it("cached readmission readiness cannot reopen intake after a different owner takes the session", async () => {
  const f = await rollbackFixture(); let reopenCalls = 0;
  f.bindings.intercom!.rollback.reopen = async () => { reopenCalls++; throw new Error("release reply unavailable"); };
  expect(await f.ports.readmitSource(f.home, f.restored, f.operation)).toMatchObject({ code: 3 });
  f.owner({ kind: "live", identity: { bootId: "fixture-boot", pid: 88, startTime: "unrelated-owner" } });
  expect(await f.ports.readmitSource(f.home, f.restored, f.operation)).toMatchObject({ code: 3 });
  expect(reopenCalls).toBe(1);
}, 5000);

it("cancel before destination preparation completes cleanup without accessing an absent checkout", async () => {
  const f = await transferFixture();
  f.remoteGlobal.db.prepare("INSERT INTO session_homes VALUES (?,?,?,?,?)").run(SESSION, HUB, f.home.epoch, null, f.home.updatedAt);
  rmSync(f.destination, { recursive: true });
  f.journal.record(f.operation.id, "move-request", { sessionId: SESSION, destinationMachine: BOX, operation: f.operation as unknown as JsonObject });
  f.journal.record(f.operation.id, "move-action-complete", { action: "check", value: f.check as unknown as JsonObject });
  expect(await cancelMove(f.operation.id, f.ports)).toMatchObject({ code: 0 });
  expect(f.journal.lookupOperation?.(abortCleanupId(f.operation.id))?.state).toBe("done");
  expect(existsSync(f.destination)).toBe(false);
}, 5000);

it("cancel cleanup retries after the original receipt is complete and the destination reconnects", async () => {
  const f = abortPrepared, exec = f.transport.exec; let connected = false;
  f.transport.exec = async (peer, argv, options) => {
    if (argv[1] === "agent" && JSON.parse(argv[2]).kind === "move-abort-workspace" && !connected) throw new Error("destination disconnected");
    return exec(peer, argv, options);
  };
  expect(await cancelMove(f.operation.id, f.ports)).toMatchObject({ code: 0 });
  expect(f.journal.lookupOperation?.(f.operation.id)?.state).toBe("done");
  expect(f.journal.lookupOperation?.(abortCleanupId(f.operation.id))?.state).toBe("pending");
  await recoverMove(f.operation.id, f.ports);
  expect(f.journal.read(abortCleanupId(f.operation.id)).filter(row => row.action === "cleanup-pending")).toHaveLength(1);
  connected = true;
  expect(await recoverMove(f.operation.id, f.ports)).toMatchObject({ code: 0 });
  expect(f.journal.lookupOperation?.(abortCleanupId(f.operation.id))?.state).toBe("done");
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("fixture\n");
}, 5000);

it("cancel cleanup resumes its source checkpoint after the original receipt is immutable", async () => {
  const f = abortPrepared, record = f.journal.record; let lost = false;
  f.journal.record = (id, action, value) => {
    if (!lost && action === "workspace-abort-cleanup-complete") { lost = true; throw new Error("lost cleanup checkpoint"); }
    record(id, action, value);
  };
  expect(await cancelMove(f.operation.id, f.ports)).toMatchObject({ code: 0 });
  expect(lost).toBe(true);
  expect(f.journal.lookupOperation?.(f.operation.id)?.state).toBe("done");
  expect(await recoverMove(f.operation.id, f.ports)).toMatchObject({ code: 0 });
  expect(f.journal.lookupOperation?.(abortCleanupId(f.operation.id))?.state).toBe("done");
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("fixture\n");
}, 5000);


it("records normal hub-return provenance tied to the committed move", async () => {
  const f = await fixture(), outgoing = casHome(f.global.db, f.home, BOX, "outgoing-owner", HUB);
  const home = casHome(f.global.db, outgoing, HUB, f.operation.id, HUB);
  const prepared = { session: f.sourceManifest, workspace: f.sourceWorkspace } as PreparedMove;
  expect((await f.ports.start(home, prepared, f.operation)).code).toBe(0);
  expect(readLocal<{ owner: unknown }>(f.global.db, "participant-intent", SESSION)?.owner).toEqual({ kind: "hub-return", machineId: HUB, moveId: f.operation.id });
}, 5000);


it.each(['ready', 'gone', 'owner-changed', 'home-changed'] as const)('destroyed mirror restoration replay %s checks durable ownership before installation', async mode => {
  const f = preparedFixture;
  casHome(f.global.db, f.home, BOX, f.operation.id, HUB);
  const mirrorOperation = { id: 'restore-replay-mirror', kind: 'session-mirror', machineId: BOX, expectedEpoch: 2, args: { sessionId: SESSION } };
  f.journal.begin(mirrorOperation);
  await appendMirror({ sessionId: SESSION, epoch: 2, source: mirrorPrepared.session, root: f.bindings.recovery!.mirrorRoot, operationId: mirrorOperation.id }, f.journal);
  const p = f.bindings.participant!, readiness = p.readiness;
  p.readiness = async () => null;
  f.bindings.recovery!.restoreWorkspace = async () => ({ cwd: f.repo, parent: null });
  const request = { machineId: BOX, confirmation: `destroyed ${BOX}` };
  expect(await forgetMachine(request, f.ports)).toMatchObject({ code: 3 });
  const home = sessionHome(f.global.db, SESSION) as Home;
  const child = `${home.moveId}-move-restore-${HUB}`;
  const launch = f.journal.read(child).find(row => row.action === 'participant-launch')!.result.launchId as string;
  p.readiness = readiness;
  if (mode === 'owner-changed') {
    const row = readLocal<JsonObject>(f.global.db, 'participant-intent', SESSION)!;
    writeLocal(f.global.db, 'participant-intent', SESSION, { ...row, owner: { kind: 'hub-return', machineId: HUB, moveId: 'forged' } });
  }
  if (mode === 'home-changed') casHome(f.global.db, home, BOX, 'changed-home', HUB);
  if (mode === 'gone') {
    f.owner({ kind: 'absent' }); f.failed();
    p.wake = async () => {
      const intent = (await createRunningIntentAuthority(f.global.db).get(SESSION))!, launchId = `${launch}-restart-1`;
      f.owner({ kind: 'live', identity: { bootId: 'fixture-boot', pid: 43, startTime: 'fixture-restarted' } });
      f.journal.begin({ id: launchId, kind: 'exact-session-launch', machineId: HUB, expectedEpoch: home.epoch, args: { sessionId: SESSION } });
      recordReadiness(f.journal, { origin: 'hub-operation', opId: launchId, sessionId: SESSION, epoch: home.epoch, file: intent.file, cwd: intent.cwd, core: 'core-a', terminal: 'terminal-restarted' });
      return { ok: true, launchId };
    };
    p.readiness = async query => { const ready = readReadiness(f.journal, query.launchId), owner = await p.probe(SESSION); return owner.kind === 'live' && owner.identity.startTime === 'fixture-restarted' && query.launchId === `${launch}-restart-1` && ready?.sessionId === query.sessionId && ready.epoch === query.epoch ? ready : null; };
  }
  const install = vi.spyOn(sessionFiles, 'installSession');
  try {
    const result = await forgetMachine(request, f.ports);
    expect(result.code === 0).toBe(mode === 'ready' || mode === 'gone');
    expect(install).toHaveBeenCalledTimes(mode === 'gone' ? 1 : 0);
    if (mode === 'ready' || mode === 'gone') {
      expect(await forgetMachine(request, f.ports)).toMatchObject({ code: 0 });
      expect(install).toHaveBeenCalledTimes(mode === 'gone' ? 1 : 0);
    }
  } finally { install.mockRestore(); }
}, 5000);
