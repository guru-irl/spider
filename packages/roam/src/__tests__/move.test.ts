import { recoverMove, cancelMove } from "../move-recovery";
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createReplica, scratchDbPath } from "@spider/db-core/testutil";
import type { ReplicaFixture } from "@spider/db-core/testutil";
import { seedSession } from "@spider/db-core/roam/seed";
import type { Home, HubOperationReadiness, JsonObject, Probe, StoreBarrier } from "@spider/db-core/roam/types";
import type { IntercomIntakeFence, SessionEndpoint } from "@spider/intercom/protocol";
import type { CoreId, Generation, SessionId, TerminalAddress, TerminalId, TerminalIdentity } from "@spider/herdr/contracts";
import { createTerminalRegistry } from "@spider/herdr/sessions/registry";
import { createSessionLeases } from "@spider/herdr/sessions/lease";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { createBothLocks } from "../session-control";
import { DEFAULT_LIMITS, disabledIntercom } from "../contracts";
import type { GitPorts, MovePorts, MoveRequest, Operation, PreparedMove, PreparedWorkspace, WorkspaceSnapshot } from "../contracts";
import { assignInitialHome, casHome, markInitialConflict, sessionHome } from "../homes";
import { openJournal } from "../journal";
import { snapshotWorkspace } from "../workspace";
import { bundleWorkspace } from "../git-bundle";
import { prepareWorkspace, settingsDigest } from "../workspace-import";
import { inspectSession, installSession, stageSession, verifyFrozenSession } from "../session-file";
import { openOutgoingStaging, sourceChunk } from "../staging";
import { MoveError, moveSession, moveSessionSlot, readMoveReservation, validateBlockerId } from "../move";
import { createMovePower, releaseMovePower, movePowerKey } from "../power";

const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000003", SESSION = "session-a";
const identity = { bootId: "fixture-boot", pid: 42, startTime: "fixture-start" };
const environment: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Snapshot fixture", GIT_AUTHOR_EMAIL: "roam@example.invalid",
  GIT_COMMITTER_NAME: "Snapshot fixture", GIT_COMMITTER_EMAIL: "roam@example.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" };
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_CONFIG", "GIT_CONFIG_COUNT"]) delete environment[key];
function run(cwd: string, argv: readonly string[], options?: { env?: Readonly<NodeJS.ProcessEnv>; stdin?: Buffer }): Buffer {
  return execFileSync("git", argv[0] === "git" ? argv.slice(1) : [...argv], { cwd, env: { ...environment, ...options?.env },
    input: options?.stdin, stdio: ["pipe", "pipe", "pipe"] });
}
function git(cwd: string, ...argv: string[]): string { return run(cwd, argv).toString("utf8").trim(); }
let template: string, previous: WorkspaceSnapshot, shared: string, prestage: WorkspaceSnapshot;
interface FixturePrestage {
  sourceDigest: string; destinationDigest: string; snapshot: WorkspaceSnapshot; prepared: PreparedWorkspace;
  actions: ReturnType<GitPorts["journal"]["read"]>; outgoingRoot: string;
}
const prestages: FixturePrestage[] = [];
function fixtureSourceDigest(root: string): string {
  const hash = createHash("sha256");
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), info = lstatSync(path);
      hash.update(JSON.stringify([path.slice(root.length), info.mode & 0o777, info.isDirectory(), info.isSymbolicLink()]));
      if (info.isDirectory()) walk(path);
      else if (info.isSymbolicLink()) hash.update(JSON.stringify(readlinkSync(path)));
      else {
        const bytes = readFileSync(path);
        // Each clone's origin is local to that fixture. Compare the same config location.
        hash.update(JSON.stringify(path === join(root, ".git", "config")
          ? Buffer.from(bytes.toString("utf8").replaceAll(dirname(root), template)).toString("base64") : bytes.toString("base64")));
      }
    }
  };
  walk(root);
  return hash.digest("hex");
}
async function capturePrestage(source: string, name: string): Promise<FixturePrestage> {
  const directory = join(template, name); mkdirSync(directory);
  const sourceDigest = fixtureSourceDigest(source);
  const destinationDigest = fixtureSourceDigest(join(template, "destination"));
  const captured = join(directory, "source"); cpSync(source, captured, { recursive: true, mode: constants.COPYFILE_FICLONE });
  const capture: GitPorts = { journal: openJournal(join(directory, "source.db")), scratch: join(directory, "outgoing"),
    limits: { ...DEFAULT_LIMITS }, worktreeCommand: null, async run(cwd, argv, options) { return run(cwd, argv, options); } };
  capture.journal.begin({ id: "move-a", machineId: HUB, kind: "move", expectedEpoch: 1, args: {} });
  const snapshot = await snapshotWorkspace({ root: captured, cwd: captured, repoKey: "fixture-repo", workspaceId: "fixture-workspace",
    moveId: "move-a", stage: "pre", writers: [] }, capture);
  const prestage = await bundleWorkspace({ ...snapshot, prerequisites: [shared] }, [shared], capture);
  if (prestage.bundle.kind !== "ready") throw new Error("template bundle not ready");
  const artifact = join(directory, "pre.bundle"), outgoing = openOutgoingStaging(capture.scratch, capture.limits, false);
  try {
    const manifest = outgoing.inspect(prestage.bundle.artifactId).current;
    if (!manifest) throw new Error("missing template artifact");
    writeFileSync(artifact, Buffer.concat(manifest.chunks.map(c => readFileSync(sourceChunk(capture.scratch, manifest.id, c.index, c.sha256)))), { mode: 0o600 });
  } finally { outgoing.close(); }
  const destination = join(directory, "destination"); cpSync(join(template, "destination"), destination, { recursive: true, mode: constants.COPYFILE_FICLONE });
  const journal = openJournal(join(directory, "destination.db"));
  journal.begin({ id: "move-a", machineId: HUB, kind: "move", expectedEpoch: 1, args: {} });
  const preparedPrestage = await prepareWorkspace(prestage, destination, { ...capture, journal, scratch: join(directory, "incoming"),
    async resolveCommonRepository() { return destination; }, async lastExportedSnapshot() { return { ...previous, root: destination }; },
    async verifiedArtifactPath() { return artifact; } });
  return { sourceDigest, destinationDigest, snapshot: prestage, prepared: preparedPrestage, actions: journal.read("move-a"), outgoingRoot: capture.scratch };
}
const roots: string[] = [], replicas: ReplicaFixture[] = [], pendingPower: Array<() => Promise<void>> = [], fixtureIO: Promise<void>[] = [];
beforeAll(async () => {
  template = mkdtempSync(join(dirname(scratchDbPath("move-template")), "move-template-"));
  const source = join(template, "source"); mkdirSync(source);
  git(source, "init", "-q", "--initial-branch=main");
  writeFileSync(join(source, "tracked.txt"), "shared\n"); git(source, "add", "tracked.txt"); git(source, "commit", "-q", "-m", "shared");
  shared = git(source, "rev-parse", "HEAD");
  run(template, ["clone", "--bare", "-q", source, join(template, "origin.git")]);
  run(template, ["clone", "-q", join(template, "origin.git"), join(template, "destination")]);
  const baselineJournal = openJournal(join(template, "capture.db"));
  baselineJournal.begin({ id: "baseline", kind: "workspace-snapshot", machineId: HUB, expectedEpoch: null, args: {} });
  previous = await snapshotWorkspace({ root: join(template, "destination"), cwd: join(template, "destination"), repoKey: "fixture-repo",
    workspaceId: "fixture-workspace", moveId: "baseline", stage: "final", writers: [] }, {
    journal: baselineJournal, scratch: join(template, "capture"), limits: { ...DEFAULT_LIMITS }, worktreeCommand: null, async run(cwd, argv, options) { return run(cwd, argv, options); },
  });
  writeFileSync(join(source, "tracked.txt"), "staged\n"); git(source, "add", "tracked.txt");
  writeFileSync(join(source, "tracked.txt"), "working\n");
  prestages.push(await capturePrestage(source, "plain"));
  prestage = prestages[0].snapshot;
}, 5000);
beforeAll(async () => {
  const source = join(template, "source-with-config"); cpSync(join(template, "source"), source, { recursive: true, mode: constants.COPYFILE_FICLONE });
  git(source, "config", "extensions.worktreeConfig", "true");
  writeFileSync(join(source, ".git", "config.worktree"), "[user]\n\tname = private-identity-sentinel\n");
  prestages.push(await capturePrestage(source, "with-config"));
}, 5000);
afterAll(() => { if (template) rmSync(template, { recursive: true, force: true }); });
afterEach(async () => {
  await Promise.all(fixtureIO.splice(0));
  for (const release of pendingPower.splice(0)) await release();
  for (const f of replicas.splice(0)) f.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(initial = false, sourceMachine = HUB, destinationMachine = BOX) {
  const root = mkdtempSync(join(dirname(scratchDbPath("move")), "move-")); roots.push(root);
  for (const part of ["source", "origin.git", "destination"]) cpSync(join(template, part), join(root, part), { recursive: true, mode: constants.COPYFILE_FICLONE });
  const source = join(root, "source"), destination = join(root, "destination"), file = join(root, "source.jsonl"), target = join(root, "sessions", "session-a.jsonl");
  const configFile = join(destination, ".git", "config");
  writeFileSync(configFile, readFileSync(configFile, "utf8").replaceAll(join(template, "origin.git"), join(root, "origin.git")));
  const history = [
    { type: "message", id: "selected", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "fixture", timestamp: 1 } },
    { type: "message", id: "later", parentId: "selected", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "later", timestamp: 2 } },
  ].map(row => JSON.stringify(row) + "\n").join("");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: SESSION, timestamp: "2026-01-01T00:00:00Z", cwd: source }) + "\n" + history, { mode: 0o600 });
  const global = createReplica("global", HUB), worktree = createReplica("worktree", sourceMachine), bound = createReplica("worktree", sourceMachine), repo = createReplica("repo", sourceMachine);
  replicas.push(global, worktree, bound, repo);
  const boundKey = "worktree:fixture-repo:binding" as const;
  bound.db.prepare("UPDATE roam_meta SET store_key=?").run(boundKey);
  global.db.prepare("UPDATE roam_meta SET capture_enabled=1").run();
  for (const f of [worktree, bound]) f.db.prepare("INSERT INTO sessions(id,started_at) VALUES (?,1)").run(SESSION);
  const assigned = initial ? null : assignInitialHome(global.db, SESSION, sourceMachine, HUB);
  if (assigned === "conflict") throw new Error("unexpected fixture conflict");
  const sourceHome: Home = assigned ?? { sessionId: SESSION, machineId: sourceMachine, epoch: 1, moveId: null, updatedAt: 0 };
  const journal = openJournal(join(root, "journal.db")), sourceJournal = openJournal(join(root, "source-journal.db")), destinationJournal = openJournal(join(root, "destination-journal.db"));
  const request: MoveRequest = { sessionId: SESSION, destinationMachine,
    operation: { id: "move-a", machineId: HUB, kind: "move", expectedEpoch: 1, args: { sessionId: SESSION, destinationMachine } } };
  const events: string[] = [], ownersAtEveryObservation: number[] = [], registryRemovals: Array<{ id: string; provedRemoved: boolean }> = [];
  let sourceActive = true, sourceStopped = false, destinationActive = false, readiness: HubOperationReadiness | null = null;
  let pre: PreparedMove | null = null, final: PreparedMove | null = null, fence: IntercomIntakeFence | null = null, retired = false;
  let terminalRemoval = true, held = false, exitListener: (() => void) | null = null;
  const artifacts = new Map<string, string>();
  const ownershipRoot = join(root, "ownership"), leases = createSessionLeases(ownershipRoot);
  const lockIdentity = { pid: 42, startIdentity: "fixture-start" };
  const withBothLocks = createBothLocks({ root: ownershipRoot, file: async () => target, identity: lockIdentity, bootId: async () => "fixture-boot",
    inventory: { leases, presence: createProcessPresence(ownershipRoot), processes: async () => [],
      probe: async pid => pid === 42 ? { kind: "live", startIdentity: "fixture-start" } : { kind: "absent" } } });
  const registry = createTerminalRegistry(join(root, "registry"));
  const terminal: TerminalIdentity = { coreId: "source-core" as CoreId, terminalId: "source-terminal" as TerminalId, socket: join(root, "core.sock"), address: "source-terminal" as TerminalAddress, sessionNamespace: "fixture" };
  const registered = registry.record({ owner: { sessionId: SESSION as SessionId, generation: "source-activation" as Generation, terminal, cwd: source, name: "fixture", sessionFile: file },
    recordedAt: 1, coreStartedAt: 1, environment: { agentDirectory: join(root, "agent"), extensionArguments: [] } });
  fixtureIO.push(registered);
  let sourceGitCalls = 0, destinationGitCalls = 0;
  const capture: GitPorts = { journal: sourceJournal, scratch: join(root, "outgoing"), limits: { ...DEFAULT_LIMITS }, worktreeCommand: null, async run(cwd, argv, options) { if (cwd === source) sourceGitCalls++; if (cwd === destination) destinationGitCalls++; return run(cwd, argv, options); } };
  const importer = { ...capture, journal: destinationJournal, scratch: join(root, "incoming"),
    async resolveCommonRepository() { return destination; }, async lastExportedSnapshot() { return { ...previous, root: destination }; },
    async verifiedArtifactPath(id: string) { return artifacts.get(id) ?? null; } };
  const stores = [global, repo, worktree, bound];
  const barriers = (): StoreBarrier[] => stores.map(f => {
    const meta = f.db.prepare("SELECT store_key,stream_id FROM roam_meta").get() as { store_key: StoreBarrier["storeKey"]; stream_id: string };
    const seq = f.db.prepare("SELECT coalesce(max(seq),0) AS through FROM roam_changes").get() as { through: number };
    return { storeKey: meta.store_key, stream: meta.stream_id, through: seq.through };
  });
  const power = createMovePower({ pid: 42, notice(message) { events.push(message); }, onExit(listener) { exitListener = listener; return () => { exitListener = null; }; },
    async spawn(argv) {
      if (argv.join(" ") !== "caffeinate -i -w 42") throw new Error("unexpected power arguments");
      events.push("power-acquired"); held = true;
      let exited!: () => void; const exit = new Promise<void>(resolve => { exited = resolve; });
      return { exited: exit, async stop() { events.push("power-released"); held = false; exited(); } };
    } });
  const prepare = async (stage: "pre" | "final", operation: Operation): Promise<PreparedMove> => {
    sourceJournal.begin(operation); destinationJournal.begin(operation);
    // Copy the real capture only before a byte-identical fixture's first prestage.
    // A changed source still goes through snapshotting and bundling against Git.
    const srcDigest = stage === "pre" ? fixtureSourceDigest(source) : null;
    const dstDigest = stage === "pre" ? fixtureSourceDigest(destination) : null;
    const cached = stage === "pre" ? prestages.find(c => c.snapshot.moveId === request.operation.id
      && c.sourceDigest === srcDigest && c.destinationDigest === dstDigest) : undefined;
    let bundled: WorkspaceSnapshot;
    if (cached) {
      for (const part of ["objects", "refs/spider-roam"]) cpSync(join(cached.snapshot.root, ".git", part), join(source, ".git", part), { recursive: true, force: false, mode: constants.COPYFILE_FICLONE });
      bundled = { ...structuredClone(cached.snapshot), root: source };
      if (bundled.bundle.kind !== "ready") throw new Error("template bundle not ready");
      sourceJournal.record(operation.id, "workspace-bundle", { artifactId: bundled.bundle.artifactId, byteLength: bundled.bundle.byteLength, stage });
    } else {
      const snapshot = await snapshotWorkspace({ root: source, cwd: source, repoKey: "fixture-repo", workspaceId: "fixture-workspace", moveId: request.operation.id, stage, writers: [] }, capture);
      const prerequisites = stage === "pre" ? [shared] : [shared, git(source, "rev-parse", pre!.workspace.snapshot.refs[1])];
      bundled = await bundleWorkspace({ ...snapshot, prerequisites }, prerequisites, capture);
    }
    if (bundled.bundle.kind !== "ready") throw new Error("bundle not ready");
    const outgoingRoot = cached?.outgoingRoot ?? capture.scratch;
    const outgoing = openOutgoingStaging(outgoingRoot, capture.limits, false);
    const artifact = join(root, `${stage}.bundle`);
    try {
      const manifest = outgoing.inspect(bundled.bundle.artifactId).current;
      if (!manifest) throw new Error("missing source artifact");
      writeFileSync(artifact, Buffer.concat(manifest.chunks.map(c => readFileSync(sourceChunk(outgoingRoot, manifest.id, c.index, c.sha256)))), { mode: 0o600 });
      chmodSync(artifact, 0o600);
    } finally { outgoing.close(); }
    artifacts.set(bundled.bundle.artifactId, artifact);
    let workspace: PreparedWorkspace;
    if (cached) {
      // The cached checkout and journal were produced by the real importer above.
      // Relocate only fixture paths; snapshot digests intentionally exclude roots.
      rmSync(destination, { recursive: true, force: true });
      cpSync(cached.prepared.root, destination, { recursive: true, mode: constants.COPYFILE_FICLONE });
      writeFileSync(configFile, readFileSync(configFile, "utf8").replaceAll(join(template, "origin.git"), join(root, "origin.git")));
      for (const { action, result } of cached.actions) {
        const relocated = JSON.parse(JSON.stringify(result).replaceAll(cached.snapshot.root, source).replaceAll(cached.prepared.root, destination)) as typeof result;
        if (action === "workspace-settings-transition") {
          type Transition = Parameters<typeof settingsDigest>[0];
          type Modes = Pick<Transition["original"], "worktreeMode" | "sparseMode">;
          const t = relocated as unknown as Transition & { modes: Modes; temporaryModes: Modes | null; targetModes: Modes };
          relocated.checksum = settingsDigest({ ...t, original: { ...t.original, ...t.modes },
            temporary: t.temporary && { ...t.temporary, ...t.temporaryModes }, target: { ...t.target, ...t.targetModes } });
        }
        destinationJournal.record(operation.id, action, relocated);
      }
      workspace = { ...structuredClone(cached.prepared), root: destination, snapshot: bundled,
        previous: { ...structuredClone(previous), root: destination } };
    } else workspace = await prepareWorkspace(bundled, destination, importer);
    const sourceManifest = await inspectSession(file, SESSION, "selected");
    const staged = await stageSession({ source: sourceManifest, destinationCwd: destination, destinationParent: null,
      segment: { version: 1, moveId: request.operation.id, epoch: 2, previousMachine: sourceMachine, nextMachine: destinationMachine, historyMachine: sourceMachine, parentRef: null } }, capture.scratch);
    if (stage === "final") {
      await installSession(staged, target, { journal: destinationJournal, async ownership() { return { kind: "absent" }; },
        withBothLocks });
    }
    return { workspace, session: stage === "final" ? { ...staged, file: target } : staged };
  };
  const ports: MovePorts = {
    config: { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture.service", syncMs: 120000, limits: { ...DEFAULT_LIMITS }, intercom: disabledIntercom() },
    globalDb: global.db, journal, clock: { now: () => 1, later() { throw new Error("no timer expected"); } }, power,
    async check() { await registered; events.push("check"); return { source: sourceHome, destinationMachine: request.destinationMachine,
      repoKey: "fixture-repo", workspaceId: "fixture-workspace", sourceRoot: source, sourceCwd: source, sourceFile: file,
      destinationRoot: destination, destinationCwd: destination, storeKeys: ["global", repo.storeKey, worktree.storeKey, boundKey], warnings: ["tool-signin-unavailable"] }; },
    async seed(check) {
      events.push("seed");
      for (const [f, key] of [[worktree, worktree.storeKey], [bound, boundKey]] as const) {
        const seeded = seedSession(f.db, SESSION, check.source.epoch, key, DEFAULT_LIMITS.targetBatchBytes);
        if (!seeded.complete) throw new Error("fixture seed incomplete");
      }
      return barriers();
    },
    async prepare(_check, operation) { events.push("prestage"); pre = await prepare("pre", operation); return pre; },
    async freeze(home, operation) {
      events.push("freeze"); sourceActive = false;
      fence = { address: { sessionId: SESSION, scopeId: null }, moveId: request.operation.id, expectedEpoch: home.epoch, generation: "fixture-fence" };
      for (const f of [worktree, bound]) f.db.prepare("UPDATE roam_sessions SET state='frozen',move_id=? WHERE session_id=?").run(request.operation.id, SESSION);
      const manifest = await inspectSession(file, SESSION, "selected");
      return { operationId: operation.id, sessionId: SESSION, epoch: home.epoch, owner: identity,
        file, cwd: source, leaf: manifest.leaf, size: manifest.size, sha256: manifest.sha256, barriers: barriers(), intercomGeneration: fence.generation };
    },
    async transfer(_check, _ack, operation) { events.push("transfer"); final = await prepare("final", operation); return final; },
    async verifySource(ack, snapshot) {
      events.push("verify-source");
      const observed = await snapshotWorkspace({ root: source, cwd: source, repoKey: snapshot.repoKey, workspaceId: snapshot.workspaceId,
        moveId: snapshot.moveId, stage: "final", writers: [] }, capture);
      for (const key of ["head", "branch", "indexTree", "workingTree", "sparsePatterns", "worktreeConfig", "normalization", "sparse"] as const) {
        if (JSON.stringify(observed[key]) !== JSON.stringify(snapshot[key])) throw new Error("source-workspace-changed");
      }
      const manifest = await inspectSession(file, SESSION, ack.leaf);
      await verifyFrozenSession({ ...manifest, size: ack.size, sha256: ack.sha256, cwd: ack.cwd });
    },
    async barriers(machine, required) {
      events.push(`barriers:${machine}:${required.length}`);
      // Simulate the ordinary Phase 2 first-sync assignment in this fake port.
      // The never-homed adapter E2E separately runs the actual createSync path.
      if (!global.db.prepare("SELECT 1 FROM session_homes WHERE session_id=?").get(SESSION)) assignInitialHome(global.db, SESSION, sourceMachine, HUB);
      return true;
    },
    async replicateHome() { events.push("replicate-home"); },
    async start(home, prepared, operation) {
      events.push("start");
      if (sourceActive || operation.expectedEpoch !== home.epoch || operation.machineId !== destinationMachine) throw new Error("unsafe start");
      const installed = await inspectSession(prepared.session.file, SESSION, prepared.session.leaf);
      if (installed.sha256 !== prepared.session.sha256) throw new Error("installed file changed");
      readiness = { origin: "hub-operation", opId: operation.id, sessionId: SESSION, epoch: home.epoch, cwd: destination, file: target, core: "destination-core", terminal: "destination-terminal" };
      destinationActive = true;
      return { code: 0, reason: "ready", operationId: operation.id, home, epoch: home.epoch, repairCommand: null, value: readiness };
    },
    async inspect(home) {
      events.push("inspect"); ownersAtEveryObservation.push(Number(sourceActive) + Number(destinationActive));
      return { home, owner: destinationActive || home.machineId === sourceMachine && sourceActive ? { kind: "live", identity } : { kind: "absent" }, readiness: home.machineId === sourceMachine ? null : readiness, launchFailure: null, retired: home.machineId === sourceMachine && retired };
    },
    async retire() { events.push("retire"); sourceStopped = true; retired = true; return { kind: "absent" }; },
    async unfreeze() { throw new Error("forward move must not unfreeze"); },
    async readmitSource() { throw new Error("forward move must not readmit source"); },
    async cleanup() {
      events.push("cleanup");
      if (!sourceStopped || !terminalRemoval) throw new Error("terminal-removal-unproved");
      await registry.remove(terminal, terminalRemoval);
      registryRemovals.push({ id: "source-terminal", provedRemoved: terminalRemoval });
      for (const cwd of [source, destination]) for (const ref of git(cwd, "for-each-ref", "--format=%(refname)", `refs/spider-roam/${request.operation.id}/`).split("\n").filter(Boolean)) git(cwd, "update-ref", "-d", ref);
      const store = openOutgoingStaging(capture.scratch, capture.limits, false);
      try { for (const id of [...artifacts.keys(), request.operation.id]) store.remove(id); } finally { store.close(); }
    },
    intercom: { address: { sessionId: SESSION, scopeId: null },
      async destinationEndpoint(home) {
        if (!destinationActive) throw new Error("intercom-endpoint-not-ready");
        return { address: { sessionId: SESSION, scopeId: null }, machineId: home.machineId, homeEpoch: home.epoch, activationEpoch: "destination-activation" };
      },
      ports: {
        async close() { throw new Error("freeze owns intake closure"); }, async drain() { throw new Error("freeze owns dispatch drain"); },
        async inspect(current) { if (!fence || current.generation !== fence.generation) throw new Error("stale-fence"); return { blockers: [], cancelledWork: [], warnings: ["route-unavailable"] }; },
        async checkGeneration(current) { events.push("generation-check"); if (!fence || current.generation !== fence.generation) throw new Error("stale-fence"); },
        async abort() { throw new Error("forward move must not abort intake"); },
        async ready(current, endpoint) {
          events.push("intercom-ready"); if (!destinationActive || current.generation !== fence?.generation || endpoint.homeEpoch !== 2) throw new Error("unsafe readiness");
          return { intercomAddress: destinationMachine === HUB ? "mac/session-a" : "box-1.invalid/session-a", warnings: ["route-unavailable"] };
        },
      },
    },
    recovery: { blockers: () => [], presentReadyTarget: async () => { throw new Error("not a forward effect"); }, revocationDb: global.db, homes() { return []; }, async mirror() { return null; }, async restore() { throw new Error("not a forward effect"); }, async conflicts() { return []; } },
  };
  pendingPower.push(() => releaseMovePower(movePowerKey(ports, request.operation.id)));
  return { root, source, destination, file, target, ports, request, sourceHome, global, worktree, bound, events, ownersAtEveryObservation,
    registryRemovals, registry, leases, barriers, history, get pre() { return pre; }, get final() { return final; }, get held() { return held; },
    exit() { exitListener?.(); }, setTerminalRemoval(value: boolean) { terminalRemoval = value; },
    sourceGitCalls: () => sourceGitCalls, destinationGitCalls: () => destinationGitCalls,
    states() { return journal.read(request.operation.id).filter(row => row.action === "move-state").map(row => row.result.state); } };
}

it("same-home request is a verified no-op", async () => {
  const f = fixture(); f.request.destinationMachine = HUB; f.request.operation.args.destinationMachine = HUB;
  const before = sessionHome(f.global.db, SESSION), result = await moveSession(f.request, f.ports);
  expect(result).toMatchObject({ code: 0, reason: "same-home", home: before });
  expect(f.events).toEqual(["check", "inspect"]);
  expect(sessionHome(f.global.db, SESSION)).toEqual(before);
}, 5000);

it("second destination conflicts per session", async () => {
  const f = fixture(); const prepare = f.ports.prepare;
  let entered!: () => void, resume!: () => void;
  const waiting = new Promise<void>(resolve => { resume = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  f.ports.prepare = async (...args) => { entered(); await waiting; return prepare(...args); };
  const first = moveSession(f.request, f.ports); await started;
  const other: MoveRequest = { ...f.request, destinationMachine: OTHER, operation: { ...f.request.operation, id: "move-b", args: { sessionId: SESSION, destinationMachine: OTHER } } };
  const conflict = await moveSession(other, f.ports); resume();
  const completed = await first;
  expect(conflict).toMatchObject({ code: 1, reason: "move-session-conflict" });
  expect(completed.code).toBe(0);
  expect(f.states()).toEqual(["checked", "frozen", "transferred", "home-committed", "destination-ready", "source-stopped", "done"]);
}, 5000);

it("seeds and prestages before freeze", async () => {
  const f = fixture(), result = await moveSession(f.request, f.ports);
  const states = f.states(), sourceHome = f.sourceHome, homeAfterMove = sessionHome(f.global.db, SESSION);
  expect(result.code, JSON.stringify({ result, events: f.events, journal: f.ports.journal.read(f.request.operation.id).slice(-3) })).toBe(0);
  expect(states).toEqual(["checked", "frozen", "transferred", "home-committed", "destination-ready", "source-stopped", "done"]);
  if (!homeAfterMove || homeAfterMove === "unknown") throw new Error("missing home");
  expect(homeAfterMove.epoch).toBe(sourceHome.epoch + 1);
  expect(f.events).toContain("power-acquired");
  expect(f.events.indexOf("power-acquired")).toBeLessThan(f.events.indexOf("seed"));
  expect(f.events.filter(event => event === "replicate-home")).toHaveLength(2);
  expect(f.events.lastIndexOf("replicate-home")).toBeLessThan(f.events.indexOf("start"));
  expect(f.events.indexOf("intercom-ready")).toBeLessThan(f.events.indexOf("retire"));
  expect(f.events.indexOf("seed")).toBeLessThan(f.events.indexOf("prestage"));
  expect(f.events.indexOf("prestage")).toBeLessThan(f.events.indexOf("freeze"));
  expect(f.ownersAtEveryObservation.every(n => n <= 1)).toBe(true);
  expect(f.worktree.db.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 1 });
  expect(f.bound.db.prepare("SELECT state FROM roam_sessions WHERE session_id=?").get(SESSION)).toEqual({ state: "frozen" });
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("working\n");
  expect(git(f.destination, "show", ":tracked.txt")).toBe("staged");
  expect(JSON.parse(readFileSync(f.target, "utf8").trim().split("\n").at(-1)!).parentId).toBe("selected");
  expect(result.value).toMatchObject({ intercomAddress: "box-1.invalid/session-a", warnings: ["tool-signin-unavailable", "route-unavailable"] });
}, 5000);

it("first move verifies synthetic source home after seed sync", async () => {
  const f = fixture(true); const freeze = f.ports.freeze;
  let observed: Home | null | "unknown" = null;
  f.ports.freeze = async (...args) => { observed = sessionHome(f.global.db, SESSION); return freeze(...args); };
  expect((await moveSession(f.request, f.ports)).code).toBe(0);
  expect(observed).toMatchObject({ machineId: HUB, epoch: 1, moveId: null });
  expect(sessionHome(f.global.db, SESSION)).toMatchObject({ machineId: BOX, epoch: 2, moveId: "move-a" });
}, 5000);

it("power assertion spans recovery", async () => {
  const f = fixture(); f.ports.transfer = async () => { throw new Error("fixture transfer interrupted"); };
  const result = await moveSession(f.request, f.ports);
  expect(result).toMatchObject({ code: 3, reason: "move-pending" });
  expect(f.held).toBe(true);
  expect(f.events.filter(event => event.startsWith("power-"))).toEqual(["power-acquired"]);
  expect((await moveSession(f.request, f.ports)).code).toBe(3);
  expect(f.events.filter(event => event.startsWith("power-"))).toEqual(["power-acquired"]);
  await releaseMovePower(movePowerKey(f.ports, f.request.operation.id));
  expect(f.held).toBe(false);
  expect(f.events).toContain("Keep the Mac awake until the move finishes.");
}, 5000);

it("requires every store barrier", async () => {
  const f = fixture(), freeze = f.ports.freeze;
  f.ports.freeze = async (...args) => { const ack = await freeze(...args); return { ...ack, barriers: ack.barriers.filter(row => !row.storeKey.endsWith(":binding")) }; };
  const result = await moveSession(f.request, f.ports);
  expect(result).toMatchObject({ code: 3, reason: "move-barrier-missing" });
  expect(sessionHome(f.global.db, SESSION)).toEqual(f.sourceHome);
  expect(f.events).not.toContain("start");
  expect(f.held).toBe(true);
}, 5000);

it("source cleanup uses proved terminal removal", async () => {
  const f = fixture(), result = await moveSession(f.request, f.ports);
  const registryRemovals = f.registryRemovals, sourceTerminal = "source-terminal";
  expect(result.code).toBe(0);
  expect(registryRemovals).toEqual([{ id: sourceTerminal, provedRemoved: true }]);
  expect(await f.registry.list()).toEqual([]);
  expect(await f.leases.get(f.target)).toBeNull();
  expect(f.events.indexOf("retire")).toBeLessThan(f.events.indexOf("cleanup"));
  expect(f.events.indexOf("cleanup")).toBeLessThan(f.events.indexOf("power-released"));
  expect(f.held).toBe(false);
  expect(git(f.source, "for-each-ref", "--format=%(refname)", "refs/spider-roam/move-a/")).toBe("");
  expect(git(f.destination, "for-each-ref", "--format=%(refname)", "refs/spider-roam/move-a/")).toBe("");
}, 5000);


it("returns typed exact intercom blockers without exposing adapter text", async () => {
  const f = fixture();
  f.ports.intercom.ports.inspect = async () => ({ blockers: [{ kind: "ask", id: "ask-1", detail: "unsettled" },
    { kind: "receipt", id: "receipt-2", detail: "unobserved" }], cancelledWork: [], warnings: [] });
  const result = await moveSession(f.request, f.ports);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unexpected move success");
  expect(result.refusal).toEqual({ code: "move-intercom-blocked", blockers: ["ask-1", "receipt-2"],
    message: "Unsettled intercom work blocks this move." });
  expect(f.events).not.toContain("transfer");
  expect(sessionHome(f.global.db, SESSION)).toEqual(f.sourceHome);
}, 5000);

it("maps arbitrary adapter failures to a fixed typed message", async () => {
  const f = fixture(); f.ports.check = async () => { throw new Error("private-transcript-sentinel"); };
  const result = await moveSession(f.request, f.ports);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unexpected move success");
  expect(result.refusal).toEqual({ code: "move-preflight-refused", blockers: [], message: "Move preflight could not be verified." });
  expect(JSON.stringify(result)).not.toContain("private-transcript-sentinel");
  expect(f.events).toEqual([]);
}, 5000);

it("rechecks the source inside the final home action", async () => {
  const f = fixture(), record = f.ports.journal.record.bind(f.ports.journal);
  f.ports.journal.record = (id, action, result) => {
    record(id, action, result);
    if (action === "move-action-start" && result.action === "home-commit") {
      appendFileSync(f.file, JSON.stringify({ type: "custom", id: "metadata", parentId: "later", timestamp: "2026-01-01T00:00:00Z", customType: "fixture", data: {} }) + "\n");
    }
  };
  const result = await moveSession(f.request, f.ports);
  expect(result.code).toBe(3);
  expect(sessionHome(f.global.db, SESSION)).toEqual(f.sourceHome);
  expect(f.events).not.toContain("start");
  expect(f.held).toBe(true);
}, 5000);

it("a failed home receipt rolls back home before any start", async () => {
  const f = fixture();
  f.global.db.exec("CREATE TRIGGER reject_move_receipt BEFORE INSERT ON roam_home_actions BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END");
  const result = await moveSession(f.request, f.ports);
  expect(result.code).toBe(3);
  expect(sessionHome(f.global.db, SESSION)).toEqual(f.sourceHome);
  expect(f.global.db.prepare("SELECT count(*) AS n FROM roam_home_actions").get()).toEqual({ n: 0 });
  expect(f.events).not.toContain("start");
}, 5000);

it("the committed home and receipt are durable before destination start", async () => {
  const f = fixture(), start = f.ports.start;
  let receipt: unknown;
  f.ports.start = async (...args) => {
    receipt = f.global.db.prepare("SELECT expected_epoch,committed_home_json FROM roam_home_actions WHERE move_id=?").get("move-a");
    return start(...args);
  };
  expect((await moveSession(f.request, f.ports)).code).toBe(0);
  expect(receipt).toMatchObject({ expected_epoch: 1, committed_home_json: expect.any(String) });
  const stored = receipt as { committed_home_json: string };
  expect(JSON.parse(stored.committed_home_json)).toMatchObject({ machineId: BOX, epoch: 2, moveId: "move-a" });
  expect(f.global.db.prepare("SELECT count(*) AS n FROM roam_home_actions").get()).toEqual({ n: 1 });
}, 5000);

it("a completed operation returns its receipt without repeating effects", async () => {
  const f = fixture(), first = await moveSession(f.request, f.ports), events = [...f.events];
  expect(first.code).toBe(0);
  expect(await moveSession(f.request, f.ports)).toEqual(first);
  expect(f.events).toEqual(events);
  expect(f.global.db.prepare("SELECT count(*) AS n FROM roam_home_actions").get()).toEqual({ n: 1 });
}, 5000);

it("refuses a reused operation ID with changed destination arguments", async () => {
  const f = fixture(); expect((await moveSession(f.request, f.ports)).code).toBe(0);
  const events = [...f.events];
  const changed = { ...f.request, destinationMachine: OTHER, operation: { ...f.request.operation, args: { sessionId: SESSION, destinationMachine: OTHER } } };
  expect(await moveSession(changed, f.ports)).toMatchObject({ code: 2, reason: "move-operation-conflict", ok: false });
  expect(f.events).toEqual(events);
}, 5000);

it("a corrupt completed journal cannot invent a successful move", async () => {
  const f = fixture(), begin = f.ports.journal.begin.bind(f.ports.journal);
  f.ports.journal.begin = operation => operation.id === f.request.operation.id
    ? { kind: "done", result: { code: 0, ok: true, value: null } } : begin(operation);
  const result = await moveSession(f.request, f.ports);
  expect(result).toMatchObject({ code: 3, reason: "move-journal-invalid", ok: false });
  expect(f.events).toEqual([]);
}, 5000);

it.each(["foreign", "conflict"] as const)("a synthetic initial home refuses %s seed evidence before freeze", async kind => {
  const f = fixture(true), seed = f.ports.seed;
  f.ports.seed = async (...args) => {
    const result = await seed(...args);
    if (kind === "conflict") markInitialConflict(f.global.db, SESSION, HUB);
    else assignInitialHome(f.global.db, SESSION, OTHER, HUB);
    return result;
  };
  const result = await moveSession(f.request, f.ports);
  expect(result).toMatchObject({ code: 1, reason: kind === "conflict" ? "initial-home-conflict" : "move-source-home-mismatch" });
  expect(f.events).not.toContain("prestage");
  expect(f.events).not.toContain("replicate-home");
  expect(f.events).toContain("power-released");
  expect(readMoveReservation(SESSION, f.ports.journal)).toBeNull();
  const powerEvents = f.events.filter(event => event.startsWith("power-"));
  expect((await recoverMove(f.request.operation.id, f.ports)).code).toBe(1);
  expect((await cancelMove(f.request.operation.id, f.ports)).code).toBe(1);
  expect(f.events.filter(event => event.startsWith("power-"))).toEqual(powerEvents);
  expect(f.events).not.toContain("freeze");
  expect(f.worktree.db.prepare("SELECT state FROM roam_sessions WHERE session_id=?").get(SESSION)).toEqual({ state: "active" });
}, 5000);

it("a pending destination barrier cannot commit the home", async () => {
  const f = fixture(); f.ports.barriers = async machine => machine !== BOX;
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 3, reason: "move-barriers-pending" });
  expect(sessionHome(f.global.db, SESSION)).toEqual(f.sourceHome);
  expect(f.events).not.toContain("start");
}, 5000);

it("stale intercom generation cannot commit the home", async () => {
  const f = fixture(); f.ports.intercom.ports.checkGeneration = async () => { throw new Error("generation-changed"); };
  expect((await moveSession(f.request, f.ports)).code).toBe(3);
  expect(sessionHome(f.global.db, SESSION)).toEqual(f.sourceHome);
  expect(f.events).not.toContain("start");
}, 5000);

it.each(["uncertain", "live"] as const)("source stop proof %s retains pending cleanup and the new home", async kind => {
  const f = fixture(); f.ports.retire = async () => kind === "live" ? { kind, identity } : { kind };
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 0, reason: "moved", value: { sourceCleanup: { status: 'pending', blockers: ['move-source-stop-pending'] } } });
  expect(sessionHome(f.global.db, SESSION)).toMatchObject({ machineId: BOX, epoch: 2 });
  expect(f.registryRemovals).toEqual([]);
  expect(f.held).toBe(true);
}, 5000);

it("unproved terminal removal remains pending cleanup without rollback", async () => {
  const f = fixture(); f.setTerminalRemoval(false);
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 0, reason: 'moved', value: { sourceCleanup: { status: 'pending' } } });
  expect(sessionHome(f.global.db, SESSION)).toMatchObject({ machineId: BOX, epoch: 2 });
  expect(f.registryRemovals).toEqual([]);
  expect(f.states().at(-1)).toBe("source-stopped");
  expect((await f.registry.list()).map(row => row.owner.terminal.terminalId)).toEqual(["source-terminal"]);
  expect(f.held).toBe(true);
}, 5000);

it("recovery completes a pending start from durable readiness without a second start", async () => {
  const f = fixture(), start = f.ports.start, endpoint = f.ports.intercom.destinationEndpoint;
  f.ports.start = async (...args) => ({ ...await start(...args), code: 3, reason: "readiness-pending", value: null });
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 3, reason: "move-destination-pending" });
  const saved = f.ports.journal.read(f.request.operation.id).filter(row => row.action === "move-action-complete" && row.result.action === "start");
  expect(saved).toHaveLength(1);
  expect(saved[0].result.value).toMatchObject({ code: 3 });
  f.ports.intercom.destinationEndpoint = async () => { throw new Error("intercom-endpoint-not-ready"); };
  expect(await recoverMove(f.request.operation.id, f.ports)).toMatchObject({ code: 3, reason: "intercom-endpoint-not-ready" });
  const proved = f.ports.journal.read(f.request.operation.id).filter(row => row.action === "move-action-complete" && row.result.action === "start");
  expect(proved).toHaveLength(2);
  expect(proved[0]).toEqual(saved[0]);
  expect(proved[1].result.value).toMatchObject({ code: 0, reason: "ready" });
  expect(await recoverMove(f.request.operation.id, f.ports)).toMatchObject({ code: 3, reason: "intercom-endpoint-not-ready" });
  expect(f.ports.journal.read(f.request.operation.id).filter(row => row.action === "move-action-complete" && row.result.action === "start")).toEqual(proved);
  f.ports.intercom.destinationEndpoint = endpoint;
  expect(await recoverMove(f.request.operation.id, f.ports)).toMatchObject({ code: 0, reason: "moved", value: { home: { machineId: BOX, epoch: 2 } } });
  expect(f.events.filter(event => event === "start")).toHaveLength(1);
}, 5000);

it.each([3, 1] as const)("recovery never retries a saved start with code %s without readiness", async code => {
  const f = fixture(); let starts = 0;
  f.ports.start = async (home, _prepared, operation) => {
    starts++;
    return { code, reason: code === 3 ? "readiness-pending" : "participant-start-refused", operationId: operation.id,
      home, epoch: home.epoch, repairCommand: null, value: null };
  };
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 3, reason: "move-destination-pending" });
  const saved = f.ports.journal.read(f.request.operation.id).filter(row => row.action === "move-action-complete" && row.result.action === "start");
  expect(saved[0].result.value).toMatchObject({ code, reason: code === 3 ? "readiness-pending" : "participant-start-refused" });
  expect(await recoverMove(f.request.operation.id, f.ports)).toMatchObject({ code: 3, reason: "move-destination-pending" });
  expect(f.ports.journal.read(f.request.operation.id).filter(row => row.action === "move-action-complete" && row.result.action === "start")).toEqual(saved);
  expect(starts).toBe(1);
  expect(sessionHome(f.global.db, SESSION)).toMatchObject({ machineId: BOX, epoch: 2 });
}, 5000);

it("recovery reuses a saved successful start", async () => {
  const f = fixture(), endpoint = f.ports.intercom.destinationEndpoint;
  f.ports.intercom.destinationEndpoint = async () => { throw new Error("intercom-endpoint-not-ready"); };
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 3, reason: "intercom-endpoint-not-ready" });
  const saved = f.ports.journal.read(f.request.operation.id).filter(row => row.action === "move-action-complete" && row.result.action === "start");
  expect(saved[0].result.value).toMatchObject({ code: 0 });
  f.ports.intercom.destinationEndpoint = endpoint;
  expect(await recoverMove(f.request.operation.id, f.ports)).toMatchObject({ code: 0, reason: "moved" });
  expect(f.events.filter(event => event === "start")).toHaveLength(1);
  expect(f.ports.journal.read(f.request.operation.id).filter(row => row.action === "move-action-complete" && row.result.action === "start")).toEqual(saved);
}, 5000);

it.each(["readiness", "refusal"] as const)("recovery refuses conflicting final start %s results as corrupt", async conflict => {
  const f = fixture();
  f.ports.intercom.destinationEndpoint = async () => { throw new Error("intercom-endpoint-not-ready"); };
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 3, reason: "intercom-endpoint-not-ready" });
  const prior = f.ports.journal.read(f.request.operation.id).find(row => row.action === "move-action-complete" && row.result.action === "start")!;
  const value = structuredClone(prior.result.value) as JsonObject;
  if (conflict === "refusal") { value.code = 1; value.reason = "participant-start-refused"; value.value = null; }
  else (value.value as JsonObject).terminal = "different-terminal";
  f.ports.journal.record(f.request.operation.id, "move-action-complete", { action: "start", value: JSON.parse(JSON.stringify(value)) });
  const saved = f.ports.journal.read(f.request.operation.id);
  expect(await recoverMove(f.request.operation.id, f.ports)).toMatchObject({ code: 3, reason: "move-journal-invalid" });
  expect(f.ports.journal.read(f.request.operation.id)).toEqual(saved);
  expect(f.events.filter(event => event === "start")).toHaveLength(1);
}, 5000);

it("missing destination endpoint stays pending after durable readiness", async () => {
  const f = fixture(); f.ports.intercom.destinationEndpoint = async () => { throw new Error("intercom-endpoint-not-ready"); };
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 3, reason: "intercom-endpoint-not-ready" });
  expect(f.states().at(-1)).toBe("destination-ready");
  expect(f.events).not.toContain("retire");
  expect(sessionHome(f.global.db, SESSION)).toMatchObject({ machineId: BOX, epoch: 2 });
}, 5000);

it("roaming disabled performs no move effects", async () => {
  const f = fixture(); f.ports.config.enabled = false;
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 1, reason: "roaming-disabled" });
  expect(f.events).toEqual([]);
  expect(f.ports.journal.lookupOperation?.(f.request.operation.id)).toBeNull();
}, 5000);


it("caller mutation cannot change the reserved destination during preparation", async () => {
  const f = fixture(), prepare = f.ports.prepare;
  f.ports.prepare = async (...args) => {
    const prepared = await prepare(...args);
    f.request.destinationMachine = OTHER; f.request.operation.args.destinationMachine = OTHER;
    return prepared;
  };
  expect((await moveSession(f.request, f.ports)).code).toBe(0);
  expect(sessionHome(f.global.db, SESSION)).toMatchObject({ machineId: BOX, epoch: 2 });
}, 5000);

it("transfer cannot alter the immutable frozen observation", async () => {
  const f = fixture(), transfer = f.ports.transfer;
  f.ports.transfer = async (check, ack, operation) => {
    const prepared = await transfer(check, ack, operation);
    appendFileSync(f.file, JSON.stringify({ type: "custom", id: "metadata", parentId: "later", timestamp: "2026-01-01T00:00:00Z", customType: "fixture", data: {} }) + "\n");
    const changed = await inspectSession(f.file, SESSION, ack.leaf);
    ack.size = changed.size; ack.sha256 = changed.sha256;
    return prepared;
  };
  expect((await moveSession(f.request, f.ports)).code).toBe(3);
  expect(sessionHome(f.global.db, SESSION)).toEqual(f.sourceHome);
  expect(f.events).not.toContain("start");
}, 5000);

it("same-home request checks authoritative home after owner observation", async () => {
  const f = fixture(); f.request.destinationMachine = HUB; f.request.operation.args.destinationMachine = HUB;
  const inspect = f.ports.inspect;
  f.ports.inspect = async (...args) => {
    const result = await inspect(...args);
    casHome(f.global.db, f.sourceHome, BOX, "other-move", HUB);
    return result;
  };
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 1, reason: "move-source-home-mismatch" });
  expect(f.events).toEqual(["check", "inspect"]);
}, 5000);

it.each(["session", "epoch", "file", "cwd", "operation", "origin"] as const)("refuses a mismatched readiness %s", async field => {
  const f = fixture(), start = f.ports.start;
  f.ports.start = async (...args) => {
    const result = await start(...args);
    const value = { ...result.value! };
    if (field === "session") value.sessionId = "session-b";
    if (field === "epoch") value.epoch = 3;
    if (field === "file") value.file = join(f.root, "other.jsonl");
    if (field === "cwd") value.cwd = f.source;
    if (field === "operation") value.opId = "other-operation";
    if (field === "origin") Object.assign(value, { origin: "box-local", machineId: BOX });
    return { ...result, value };
  };
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 3, reason: "move-readiness-invalid" });
  expect(f.events).not.toContain("intercom-ready");
  expect(f.events).not.toContain("retire");
  expect(sessionHome(f.global.db, SESSION)).toMatchObject({ machineId: BOX, epoch: 2 });
}, 5000);

it("unknown start outcome stays frozen without a second launch", async () => {
  const f = fixture(); let launches = 0;
  f.ports.start = async (home, _prepared, operation) => {
    launches++;
    return { code: 3, reason: "unknown", operationId: operation.id, home, epoch: home.epoch, repairCommand: null, value: null };
  };
  expect((await moveSession(f.request, f.ports)).code).toBe(3);
  expect((await moveSession(f.request, f.ports)).code).toBe(3);
  expect(launches).toBe(1);
  expect(f.worktree.db.prepare("SELECT state FROM roam_sessions WHERE session_id=?").get(SESSION)).toEqual({ state: "frozen" });
  expect(f.events).not.toContain("retire");
}, 5000);

it("lost home state recording retains the CAS receipt and never starts on retry", async () => {
  const f = fixture(), record = f.ports.journal.record.bind(f.ports.journal);
  f.ports.journal.record = (id, action, result) => {
    if (action === "move-state" && result.state === "home-committed") throw new Error("fixture journal interruption");
    record(id, action, result);
  };
  expect((await moveSession(f.request, f.ports)).code).toBe(3);
  expect((await moveSession(f.request, f.ports)).code).toBe(3);
  expect(f.global.db.prepare("SELECT count(*) AS n FROM roam_home_actions WHERE committed_home_json IS NOT NULL").get()).toEqual({ n: 1 });
  expect(sessionHome(f.global.db, SESSION)).toMatchObject({ machineId: BOX, epoch: 2 });
  expect(f.events).not.toContain("start");
  expect(f.held).toBe(true);
}, 5000);

it("a late home change cannot publish the old destination endpoint", async () => {
  const f = fixture(), start = f.ports.start;
  f.ports.start = async (...args) => {
    const result = await start(...args);
    casHome(f.global.db, result.home!, OTHER, "other-move", HUB);
    return result;
  };
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 3, reason: "move-home-changed" });
  expect(f.events).not.toContain("intercom-ready");
  expect(f.events).not.toContain("retire");
}, 5000);


it("maps typed preflight blockers without cancelling their work", async () => {
  const f = fixture(); f.ports.check = async () => { throw new MoveError("move-preflight-blocked", [validateBlockerId("run-a"), validateBlockerId("job-b")]); };
  const result = await moveSession(f.request, f.ports);
  expect(result).toMatchObject({ code: 1, ok: false, refusal: { code: "move-preflight-blocked", blockers: ["run-a", "job-b"], message: "Unsettled work blocks this move." } });
  expect(f.events).toEqual([]);
}, 5000);

it("missing intercom ports refuse before preparation or freezing", async () => {
  const f = fixture(); Object.assign(f.ports, { intercom: null });
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 1, reason: "intercom-fence-unsupported" });
  expect(f.events).toEqual([]);
  expect(f.ports.journal.lookupOperation?.(f.request.operation.id)).toBeNull();
}, 5000);

it("an intercom address for another session refuses before preparation", async () => {
  const f = fixture(); f.ports.intercom.address.sessionId = "session-b";
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 1, reason: "intercom-fence-unsupported" });
  expect(f.events).toEqual([]);
}, 5000);

it("malformed intercom inventory cannot count as an empty blocker set", async () => {
  const f = fixture(); f.ports.intercom.ports.inspect = async () => ({ blockers: [], warnings: [], cancelledWork: {} as never });
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 3, reason: "move-blockers-invalid" });
  expect(sessionHome(f.global.db, SESSION)).toEqual(f.sourceHome);
  expect(f.events).not.toContain("transfer");
}, 5000);

it("reports dropped worktree keys without their private values", async () => {
  const f = fixture(); git(f.source, "config", "extensions.worktreeConfig", "true");
  writeFileSync(join(f.source, ".git", "config.worktree"), "[user]\n\tname = private-identity-sentinel\n");
  const result = await moveSession(f.request, f.ports);
  expect(result.code).toBe(0);
  expect(result.value?.warnings).toEqual(["tool-signin-unavailable", "route-unavailable", "user.name"]);
  expect(JSON.stringify(result)).not.toContain("private-identity-sentinel");
}, 5000);

it("power release failure keeps completion and session reservation pending", async () => {
  const f = fixture(), acquire = f.ports.power;
  f.ports.power = async () => {
    const release = await acquire(); let fail = true;
    return async () => { if (fail) { fail = false; throw new Error("fixture release failure"); } await release(); };
  };
  expect((await moveSession(f.request, f.ports)).code).toBe(3);
  expect(f.ports.journal.lookupOperation?.("move-a")?.state).toBe("pending");
  const other = { ...f.request, operation: { ...f.request.operation, id: "move-b" } };
  expect(await moveSession(other, f.ports)).toMatchObject({ code: 1, reason: "move-session-conflict" });
  expect(f.held).toBe(true);
}, 5000);

it.each(["exit-hook", "notice"] as const)("power acquisition cleans up when the %s adapter fails", async failure => {
  let stops = 0, subscriptions = 0;
  const acquire = createMovePower({ pid: 42,
    async spawn() { return { exited: Promise.resolve(), async stop() { stops++; } }; },
    onExit() { if (failure === "exit-hook") throw new Error("fixture hook failure"); subscriptions++; return () => { subscriptions--; }; },
    notice() { if (failure === "notice") throw new Error("fixture notice failure"); } });
  await expect(acquire()).rejects.toThrow(/fixture/);
  expect(stops).toBe(1);
  expect(subscriptions).toBe(0);
}, 5000);

it("power release waits for exit and retries a failed stop", async () => {
  let finish!: () => void, stopped = 0, unsubscribed = false;
  const exit = new Promise<void>(resolve => { finish = resolve; });
  const acquire = createMovePower({ pid: 42, notice() {}, onExit() { return () => { unsubscribed = true; }; },
    async spawn() { return { exited: exit, async stop() { if (++stopped === 1) throw new Error("fixture stop failure"); } }; } });
  const release = await acquire(); await expect(release()).rejects.toThrow("fixture stop failure");
  let released = false; const completion = release().then(() => { released = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(released).toBe(false); expect(unsubscribed).toBe(false);
  finish(); await completion;
  expect(unsubscribed).toBe(true); expect(stopped).toBe(2);
  await release(); expect(stopped).toBe(2);
}, 5000);


it("a durable session reservation rejects another move and records its refusal", async () => {
  const f = fixture(), slot = moveSessionSlot(SESSION);
  f.ports.journal.begin({ id: slot, machineId: HUB, expectedEpoch: null, kind: "move-session", args: { sessionId: SESSION } });
  f.ports.journal.record(slot, "reserved", { moveId: "earlier-move", destinationMachine: OTHER });
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 1, reason: "move-session-conflict" });
  expect(f.ports.journal.lookupOperation?.("move-a")?.state).toBe("done");
  expect(f.ports.journal.read(slot).at(-1)?.result.moveId).toBe("earlier-move");
  expect(f.events).toEqual([]);
}, 5000);

it("an invalid session reservation stays fenced instead of authorizing a move", async () => {
  const f = fixture(), slot = moveSessionSlot(SESSION);
  f.ports.journal.begin({ id: slot, machineId: HUB, expectedEpoch: null, kind: "move-session", args: { sessionId: SESSION } });
  f.ports.journal.record(slot, "unknown", { moveId: "earlier-move", destinationMachine: OTHER });
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 3, reason: "move-journal-invalid" });
  expect(f.events).toEqual([]);
  expect(sessionHome(f.global.db, SESSION)).toEqual(f.sourceHome);
}, 5000);

it.each(["null-args", "unsafe-ref-id", "missing-id"] as const)("invalid request %s returns a typed refusal before effects", async kind => {
  const f = fixture();
  if (kind === "null-args") Object.assign(f.request.operation, { args: null });
  else if (kind === "missing-id") Object.assign(f.request.operation, { id: undefined });
  else f.request.operation.id = "move..a";
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 2, reason: "move-request-invalid", ok: false });
  expect(f.events).toEqual([]);
}, 5000);


it.each(["source-session", "destination", "source-epoch", "source-root", "store-global", "store-repo", "store-worktree", "store-format", "stores-duplicate", "warning"] as const)("invalid preflight %s refuses before power and seed", async field => {
  const f = fixture(), check = f.ports.check;
  f.ports.check = async request => {
    const result = await check(request);
    if (field === "source-session") result.source = { ...result.source, sessionId: "other-session" };
    if (field === "destination") result.destinationMachine = OTHER;
    if (field === "source-epoch") result.source = { ...result.source, epoch: 2 };
    if (field === "source-root") result.sourceRoot = "relative";
    if (field === "store-global") result.storeKeys = result.storeKeys.filter(key => key !== "global");
    if (field === "store-repo") result.storeKeys = result.storeKeys.filter(key => !key.startsWith("repo:"));
    if (field === "store-worktree") result.storeKeys = result.storeKeys.filter(key => key !== "worktree:fixture-repo:fixture-workspace");
    if (field === "store-format") Object.assign(result, { storeKeys: [...result.storeKeys, "invalid"] });
    if (field === "stores-duplicate") result.storeKeys = [...result.storeKeys, "global"];
    if (field === "warning") result.warnings = ["invalid\nwarning"];
    return result;
  };
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 1, reason: field === "warning" ? "move-warnings-invalid" : "move-check-invalid" });
  expect(f.events).toEqual(["check"]);
}, 5000);

it.each(["machine", "epoch", "timestamp"] as const)("invalid home %s refuses before any preparation", async field => {
  const f = fixture(), check = f.ports.check;
  f.ports.check = async request => {
    const result = await check(request); result.source = { ...result.source };
    if (field === "machine") result.source.machineId = "invalid";
    if (field === "epoch") result.source.epoch = 1.5;
    if (field === "timestamp") result.source.updatedAt = Number.NaN;
    return result;
  };
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 1, reason: "move-home-invalid" });
  expect(f.events).toEqual(["check"]);
}, 5000);

it.each(["operation", "session", "epoch", "file", "cwd", "leaf", "size", "digest", "generation", "owner"] as const)("invalid freeze %s leaves the source fenced", async field => {
  const f = fixture(), freeze = f.ports.freeze;
  f.ports.freeze = async (...args) => {
    const ack = await freeze(...args);
    if (field === "operation") ack.operationId = "another-operation";
    if (field === "session") ack.sessionId = "another-session";
    if (field === "epoch") ack.epoch = 2;
    if (field === "file") ack.file = join(f.root, "other.jsonl");
    if (field === "cwd") ack.cwd = f.destination;
    if (field === "leaf") ack.leaf = "";
    if (field === "size") ack.size = 0;
    if (field === "digest") ack.sha256 = "bad";
    if (field === "generation") ack.intercomGeneration = "";
    if (field === "owner") ack.owner = { ...identity, pid: 0 };
    return ack;
  };
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 3, reason: field === "owner" ? "move-owner-invalid" : "move-freeze-invalid" });
  expect(f.events).not.toContain("transfer");
  expect(sessionHome(f.global.db, SESSION)).toEqual(f.sourceHome);
}, 5000);

it.each(["duplicate", "negative", "unsafe-integer", "missing-stream"] as const)("invalid seed barrier %s prevents freezing", async field => {
  const f = fixture(), seed = f.ports.seed;
  f.ports.seed = async (...args) => {
    const barriers = [...await seed(...args)];
    if (field === "duplicate") barriers.push(barriers[0]);
    if (field === "negative") barriers[0].through = -1;
    if (field === "unsafe-integer") barriers[0].through = Number.MAX_SAFE_INTEGER + 1;
    if (field === "missing-stream") barriers[0].stream = "";
    return barriers;
  };
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 1, reason: "move-barrier-invalid" });
  expect(f.events).not.toContain("freeze");
}, 5000);

it.each(["root", "move", "stage", "session", "cwd", "file", "digest"] as const)("invalid prepared %s prevents freezing", async field => {
  const f = fixture(), prepare = f.ports.prepare;
  f.ports.prepare = async (...args) => {
    const prepared = await prepare(...args);
    if (field === "root") prepared.workspace.root = f.source;
    if (field === "move") prepared.workspace.moveId = "other-move";
    if (field === "stage") prepared.workspace.snapshot.stage = "final";
    if (field === "session") prepared.session.sessionId = "other-session";
    if (field === "cwd") prepared.session.cwd = f.source;
    if (field === "file") prepared.session.file = "relative";
    if (field === "digest") prepared.session.sha256 = "invalid";
    return prepared;
  };
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 1, reason: "move-prepared-invalid" });
  expect(f.events).not.toContain("freeze");
}, 5000);

it("working edits after final transfer invalidate the home commit", async () => {
  const f = fixture(), transfer = f.ports.transfer;
  f.ports.transfer = async (...args) => { const prepared = await transfer(...args); writeFileSync(join(f.source, "tracked.txt"), "late edit\n"); return prepared; };
  expect((await moveSession(f.request, f.ports)).code).toBe(3);
  expect(sessionHome(f.global.db, SESSION)).toEqual(f.sourceHome);
  expect(f.events).not.toContain("start");
}, 5000);

it("an uncertain destination owner cannot publish readiness or retire the source", async () => {
  const f = fixture(), inspect = f.ports.inspect;
  f.ports.inspect = async (...args) => ({ ...await inspect(...args), owner: { kind: "uncertain" } });
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 3, reason: "move-destination-pending" });
  expect(f.events).not.toContain("intercom-ready");
  expect(f.events).not.toContain("retire");
}, 5000);


it("a refused replay cannot carry a successful move value", async () => {
  const f = fixture(); f.ports.check = async () => { throw new MoveError("move-preflight-refused"); };
  const refused = await moveSession(f.request, f.ports), begin = f.ports.journal.begin.bind(f.ports.journal);
  f.ports.journal.begin = operation => operation.id === "move-a" ? { kind: "done", result: JSON.parse(JSON.stringify({ ...refused,
    value: { home: f.sourceHome, terminal: null, intercomAddress: SESSION, warnings: [] } })) } : begin(operation);
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 3, reason: "move-journal-invalid", ok: false });
}, 5000);


it("a box-origin first move returns locally through the same hub CAS", async () => {
  const f = fixture(true, BOX, HUB), freeze = f.ports.freeze, start = f.ports.start;
  const targets: Array<{ machine: string; epoch: number | null }> = [];
  f.ports.freeze = async (home, operation) => { targets.push({ machine: operation.machineId, epoch: operation.expectedEpoch }); return freeze(home, operation); };
  f.ports.start = async (home, prepared, operation) => { targets.push({ machine: operation.machineId, epoch: operation.expectedEpoch }); return start(home, prepared, operation); };
  const result = await moveSession(f.request, f.ports);
  expect(result).toMatchObject({ code: 0, ok: true, value: { intercomAddress: "mac/session-a", home: { machineId: HUB, epoch: 2 } } });
  expect(targets).toEqual([{ machine: BOX, epoch: 1 }, { machine: HUB, epoch: 2 }]);
  expect(f.global.db.prepare("SELECT origin_machine FROM roam_changes WHERE entity='session_homes'").all()).toEqual([{ origin_machine: HUB }, { origin_machine: HUB }]);
  const marker = JSON.parse(readFileSync(f.target, "utf8").trim().split("\n").at(-1)!);
  expect(marker.data).toMatchObject({ previousMachine: BOX, nextMachine: HUB, historyMachine: BOX });
  expect(f.ownersAtEveryObservation.every(n => n <= 1)).toBe(true);
}, 5000);


it.each(["operation-done", "session-release"] as const)("a lost final %s write keeps recovery power and never replays effects", async failure => {
  const f = fixture(), record = f.ports.journal.record.bind(f.ports.journal); let failed = false;
  f.ports.journal.record = (id, action, value) => {
    if (!failed && ((failure === "operation-done" && id === "move-a" && action === "done") ||
      (failure === "session-release" && id === moveSessionSlot(SESSION) && action === "released"))) {
      failed = true; throw new Error("fixture final write failure");
    }
    record(id, action, value);
  };
  expect((await moveSession(f.request, f.ports)).code).toBe(3);
  expect(f.held).toBe(true);
  const starts = f.events.filter(event => event === "start").length, cleanups = f.events.filter(event => event === "cleanup").length;
  expect(starts).toBe(1);
  expect((await moveSession(f.request, f.ports)).code).toBe(3);
  expect(f.events.filter(event => event === "start")).toHaveLength(starts);
  expect(f.events.filter(event => event === "cleanup")).toHaveLength(cleanups);
  expect(f.held).toBe(true);
}, 5000);


it("same-home verified dormancy is a no-op without starting a process", async () => {
  const f = fixture(); f.request.destinationMachine = HUB; f.request.operation.args.destinationMachine = HUB;
  f.ports.inspect = async home => ({ home, owner: { kind: "absent" }, readiness: null, launchFailure: null, retired: true });
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 0, ok: true, reason: "same-home", value: { terminal: null } });
  expect(f.events).toEqual(["check"]);
  expect(f.events.filter(event => event === "start")).toHaveLength(0);
}, 5000);

it("same-home absence without a dormancy proof refuses the no-op", async () => {
  const f = fixture(); f.request.destinationMachine = HUB; f.request.operation.args.destinationMachine = HUB;
  f.ports.inspect = async home => ({ home, owner: { kind: "absent" }, readiness: null, launchFailure: null, retired: false });
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 1, reason: "move-source-owner-uncertain" });
  expect(f.events).toEqual(["check"]);
}, 5000);


it("mutable preflight and preparation arguments cannot redirect the move", async () => {
  const f = fixture(), check = f.ports.check, prepare = f.ports.prepare;
  f.ports.check = async request => { const value = await check(request); request.destinationMachine = OTHER; request.operation.args.destinationMachine = OTHER; return value; };
  f.ports.prepare = async (check, operation) => { const value = await prepare(check, operation); check.destinationRoot = join(f.root, "redirected"); operation.id = "redirected-move"; return value; };
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 0, operationId: "move-a", home: { machineId: BOX, epoch: 2 } });
  expect(f.request.destinationMachine).toBe(BOX);
  expect(f.request.operation.id).toBe("move-a");
}, 5000);

it("a home change during endpoint lookup cannot publish stale readiness", async () => {
  const f = fixture(), endpoint = f.ports.intercom.destinationEndpoint;
  f.ports.intercom.destinationEndpoint = async home => { const value = await endpoint(home); casHome(f.global.db, home, OTHER, "other-move", HUB); return value; };
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 3, reason: "move-home-changed" });
  expect(f.events).not.toContain("intercom-ready");
  expect(f.events).not.toContain("retire");
}, 5000);

it("a home change during final owner inspection prevents cleanup", async () => {
  const f = fixture(), inspect = f.ports.inspect; let calls = 0;
  f.ports.inspect = async (...args) => { const value = await inspect(...args); if (++calls === 2) casHome(f.global.db, args[0], OTHER, "other-move", HUB); return value; };
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 3, reason: "move-home-changed" });
  expect(f.events).not.toContain("cleanup");
  expect(f.held).toBe(true);
}, 5000);


it("an inconsistent destination observation cannot authorize readiness", async () => {
  const f = fixture(), inspect = f.ports.inspect;
  f.ports.inspect = async (...args) => { const value = await inspect(...args); return { ...value, home: { ...value.home, epoch: 999 } }; };
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 3, reason: "move-observation-invalid" });
  expect(f.events).not.toContain("intercom-ready");
}, 5000);

it("an endpoint for another scope cannot publish readiness", async () => {
  const f = fixture(), lookup = f.ports.intercom.destinationEndpoint;
  f.ports.intercom.destinationEndpoint = async home => { const value = await lookup(home); return { ...value, address: { ...value.address, scopeId: "other-scope" } }; };
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 3, reason: "intercom-endpoint-not-ready" });
  expect(f.events).not.toContain("intercom-ready");
}, 5000);

it("same-home invalid process evidence cannot prove a no-op", async () => {
  const f = fixture(); f.request.destinationMachine = HUB; f.request.operation.args.destinationMachine = HUB;
  f.ports.inspect = async home => ({ home, owner: { kind: "alien" } as never, readiness: null, launchFailure: null, retired: false });
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 1, reason: "move-owner-invalid" });
  expect(f.events).toEqual(["check"]);
}, 5000);


it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("invalid power pid %s never spawns an assertion", async pid => {
  let spawned = false;
  const acquire = createMovePower({ pid, notice() {}, onExit() { return () => {}; }, async spawn() { spawned = true; throw new Error("unexpected spawn"); } });
  await expect(acquire()).rejects.toThrow("power-pid-invalid");
  expect(spawned).toBe(false);
}, 5000);

it.each([null, 1, "", "bad\nidentifier", "bad\u001bidentifier", "x".repeat(257)])("invalid blocker identifier %# has a fixed refusal", value => {
  expect(() => validateBlockerId(value)).toThrow("Blocker identities could not be verified.");
}, 5000);

it("process exit releases its power assertion exactly once", async () => {
  let callback!: () => void, stopped = 0, unsubscribed = 0;
  const acquire = createMovePower({ pid: 42, notice() {}, onExit(fn) { callback = fn; return () => { unsubscribed++; }; },
    async spawn() { return { exited: Promise.resolve(), async stop() { stopped++; } }; } });
  const release = await acquire(); callback();
  expect(stopped).toBe(1);
  await release(); await release();
  expect(stopped).toBe(1); expect(unsubscribed).toBe(1);
}, 5000);


it("an unknown start status requires reconciliation before publication", async () => {
  const f = fixture(), start = f.ports.start;
  f.ports.start = async (...args) => ({ ...await start(...args), code: 3 });
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 3, reason: "move-destination-pending" });
  expect(f.events).not.toContain("intercom-ready");
  expect(f.events).not.toContain("retire");
}, 5000);

it("uncertain final ownership prevents cleanup and completion", async () => {
  const f = fixture(), inspect = f.ports.inspect; let calls = 0;
  f.ports.inspect = async (...args) => { const value = await inspect(...args); return ++calls === 2 ? { ...value, owner: { kind: "uncertain" } } : value; };
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 3, reason: "move-destination-pending" });
  expect(f.events).not.toContain("cleanup");
  expect(f.held).toBe(true);
}, 5000);


it("a pending source cursor prevents initial assignment and freezing", async () => {
  const f = fixture(true); f.ports.barriers = async () => false;
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 1, reason: "move-barriers-pending" });
  expect(sessionHome(f.global.db, SESSION)).toBeNull();
  expect(f.events).not.toContain("prestage");
  expect(f.events).not.toContain("freeze");
  expect(f.worktree.db.prepare("SELECT state FROM roam_sessions WHERE session_id=?").get(SESSION)).toEqual({ state: "active" });
}, 5000);

it("a box role cannot move homes through a borrowed hub DB", async () => {
  const f = fixture(); f.ports.config.role = "box"; f.ports.config.machineId = BOX;
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 1, reason: "move-requires-hub" });
  expect(f.events).toEqual([]);
  expect(sessionHome(f.global.db, SESSION)).toEqual(f.sourceHome);
}, 5000);


it.each(["epoch", "move-id"] as const)("a synthetic source with invalid %s cannot seed capture", async field => {
  const f = fixture(true), check = f.ports.check; f.request.operation.expectedEpoch = null;
  f.ports.check = async request => { const value = await check(request); value.source = { ...value.source, epoch: field === "epoch" ? 2 : 1, moveId: field === "move-id" ? "earlier-move" : null }; return value; };
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 1, reason: "move-source-home-mismatch" });
  expect(f.events).not.toContain("seed");
  expect(f.worktree.db.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 0 });
}, 5000);


it("unchanged prestaging reuses the file's real Git capture in independent checkouts", async () => {
  const first = fixture(), second = fixture();
  const a = await first.ports.prepare(await first.ports.check(first.request), first.request.operation);
  const b = await second.ports.prepare(await second.ports.check(second.request), second.request.operation);
  expect(first.sourceGitCalls()).toBe(0);
  expect(second.sourceGitCalls()).toBe(0);
  expect(first.destinationGitCalls()).toBe(0);
  expect(second.destinationGitCalls()).toBe(0);
  expect(a.workspace.root).not.toBe(b.workspace.root);
  expect(a.workspace.snapshot).not.toBe(b.workspace.snapshot);
  for (const f of [first, second]) {
    expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("working\n");
    expect(git(f.destination, "show", ":tracked.txt")).toBe("staged");
    expect(git(f.source, "rev-parse", "refs/spider-roam/move-a/pre/working^{tree}")).toBe(a.workspace.snapshot.workingTree);
  }
  writeFileSync(join(first.destination, "tracked.txt"), "first checkout only\n");
  a.workspace.snapshot.workingTree = "0".repeat(40);
  expect(readFileSync(join(second.destination, "tracked.txt"), "utf8")).toBe("working\n");
  expect(b.workspace.snapshot.workingTree).toBe(prestage.workingTree);
}, 5000);

it("a changed fixture source gets a fresh real prestage capture", async () => {
  const f = fixture();
  writeFileSync(join(f.source, "tracked.txt"), "case-specific working bytes\n");
  const prepared = await f.ports.prepare(await f.ports.check(f.request), f.request.operation);
  expect(f.sourceGitCalls()).toBeGreaterThan(0);
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("case-specific working bytes\n");
  expect(git(f.destination, "show", ":tracked.txt")).toBe("staged");
  expect(git(f.destination, "write-tree")).toBe(prepared.workspace.snapshot.indexTree);
}, 5000);


it("a changed fixture destination still refuses a real Git divergence", async () => {
  const f = fixture();
  writeFileSync(join(f.destination, "tracked.txt"), "destination edit\n");
  await expect(f.ports.prepare(await f.ports.check(f.request), f.request.operation)).rejects.toThrow(/workspace-diverged/);
  expect(f.destinationGitCalls()).toBeGreaterThan(0);
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("destination edit\n");
}, 5000);


it("the worktree-config fixture reuses a real sanitized prestage", async () => {
  const f = fixture();
  git(f.source, "config", "extensions.worktreeConfig", "true");
  writeFileSync(join(f.source, ".git", "config.worktree"), "[user]\n\tname = private-identity-sentinel\n");
  const prepared = await f.ports.prepare(await f.ports.check(f.request), f.request.operation);
  expect(f.sourceGitCalls()).toBe(0);
  expect(f.destinationGitCalls()).toBe(0);
  expect(prepared.workspace.snapshot.droppedConfigKeys).toEqual(["user.name"]);
  expect(readFileSync(join(f.destination, "tracked.txt"), "utf8")).toBe("working\n");
  expect(git(f.destination, "show", ":tracked.txt")).toBe("staged");
  expect(readFileSync(join(f.source, ".git", "config.worktree"), "utf8")).toContain("private-identity-sentinel");
  expect(readFileSync(join(f.destination, ".git", "config.worktree"), "utf8")).not.toContain("private-identity-sentinel");
}, 5000);

it("a pre-freeze refusal during recovery aborts without retaining power or the reservation", async () => {
  const f = fixture(); f.ports.seed = async () => { throw new Error("interrupted-before-seed"); };
  expect((await moveSession(f.request, f.ports)).code).toBe(3);
  f.ports.seed = async () => { throw new MoveError("move-source-home-mismatch"); };
  expect(await recoverMove(f.request.operation.id, f.ports)).toMatchObject({ code: 1, reason: "move-source-home-mismatch" });
  expect(readMoveReservation(SESSION, f.ports.journal)).toBeNull();
  expect(f.events).toContain("power-released");
  const powerEvents = f.events.filter(event => event.startsWith("power-"));
  await recoverMove(f.request.operation.id, f.ports);
  expect(f.events.filter(event => event.startsWith("power-"))).toEqual(powerEvents);
}, 5000);


it('a committed move keeps unproved source exit pending, then retires once', async () => {
  const f = fixture(), retire = f.ports.retire;
  let proved = false;
  f.ports.retire = async (...args) => {
    if (!proved) throw new MoveError('move-preflight-refused', [validateBlockerId('process-exit-unproven')]);
    return retire(...args);
  };
  const moved = await moveSession(f.request, f.ports);
  expect(moved).toMatchObject({ code: 0, ok: true, reason: 'moved', value: { sourceCleanup: { status: 'pending', blockers: ['process-exit-unproven'] } } });
  expect(sessionHome(f.global.db, SESSION)).toMatchObject({ machineId: BOX, epoch: 2 });
  expect(f.events).not.toContain('retire');
  expect(f.registryRemovals).toEqual([]);
  expect(f.held).toBe(true);
  proved = true;
  expect(await recoverMove(f.request.operation.id, f.ports)).toMatchObject({ code: 0, reason: 'moved', value: { sourceCleanup: { status: 'done' } } });
  expect(await recoverMove(f.request.operation.id, f.ports)).toMatchObject({ code: 0, value: { sourceCleanup: { status: 'done' } } });
  expect(f.events.filter(event => event === 'retire')).toHaveLength(1);
  expect(f.events.filter(event => event === 'start')).toHaveLength(1);
}, 5000);
