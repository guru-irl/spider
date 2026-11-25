import { afterEach, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { createReplica } from "@spider/db-core/testutil";
import { migrate, openDb } from "@spider/db-core";
import { mapRepository, mapWorkspace } from "@spider/db-core/roam/repo-map";
import { recordLocation } from "@spider/db-core/roam/catalog";
import { roamStorePath } from "@spider/db-core/roam/reads";
import { enableMemoryCapture } from "@spider/db-core/roam/seed";
import type { HubOperationReadiness, Probe, StoreKey } from "@spider/db-core/roam/types";
import { createRunningIntentAuthority, recordReadiness } from "@spider/roam/session-control";
import { createDormantControl } from "../control";
import { DEFAULT_LIMITS, disabledIntercom, type Operation, type RoamConfig, type Transport } from "@spider/roam/contracts";
import { openFreezeJournal } from "@spider/roam/journal";
import { createStorePort } from "@spider/roam/stores";
import { handleAgentOperation } from "@spider/roam/agent";
import { handleArtifactRequest } from "@spider/roam/artifacts";
import { openStaging } from "@spider/roam/staging";
import { controlSessionCatalog } from "@spider/roam/adapter-controls";
import { safeControlOutcome, controlText } from "@spider/roam/commands";
import type { HubControlReply } from "@spider/roam/control-socket";
import { assignInitialHome, sessionHome } from "@spider/roam/homes";
import { readLocalIdentity } from "@spider/roam/runtime";
import { createHostMoveBindings, type HostMoveRuntime } from "../move-runtime";

const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002";
const REPO = "fixture-repo", WORKSPACE = "12345678-0000-4000-8000-000000000003", SESSION = "checkout-session";
const WT: StoreKey = `worktree:${REPO}:${WORKSPACE}`;
const closes: Array<() => void | Promise<void>> = [];
function publicOutcome(reply: HubControlReply) {
  return safeControlOutcome({ ...reply, operationId: reply.operationId ?? "", home: reply.home ?? null, epoch: reply.epoch ?? null, repairCommand: reply.repairCommand ?? null });
}
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } }).toString().trim();
}
function initializeStore(global: ReturnType<typeof createReplica>, key: StoreKey) {
  const file = roamStorePath(global.db, key); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = openDb(file); migrate(db, key.startsWith("worktree:") ? "worktree" : "repo", { machineId: global.machineId, globalRoot: global.root });
  db.prepare("UPDATE roam_meta SET store_key=? WHERE id=1").run(key);
  closes.push(() => db.close()); return db;
}
async function fixture(mappedRepository: boolean, occupied = false, complete = false) {
  const source = createReplica("global", HUB), destination = createReplica("global", BOX);
  closes.push(() => source.close(), () => destination.close());
  const sourceRoot = join(source.root, "source-checkout"), repository = join(destination.root, "mapped-repo"), nativeRoot = join(destination.root, "native-checkout");
  mkdirSync(sourceRoot); mkdirSync(repository);
  git(sourceRoot, ["init", "-q", "--initial-branch=main"]); writeFileSync(join(sourceRoot, "tracked.txt"), "original\n");
  git(sourceRoot, ["add", "."]); git(sourceRoot, ["commit", "-qm", "fixture"]); git(sourceRoot, ["remote", "add", "origin", sourceRoot]);
  git(repository, ["clone", "-q", sourceRoot, "."]); git(repository, ["worktree", "add", "-q", "--detach", nativeRoot]);
  await mapRepository(source.db, { repoKey: REPO, path: sourceRoot }); await mapWorkspace(source.db, { repoKey: REPO, workspaceId: WORKSPACE, path: sourceRoot });
  const worktree = initializeStore(source, WT); initializeStore(source, `repo:${REPO}`);
  if (mappedRepository) { await mapRepository(destination.db, { repoKey: REPO, path: repository }); initializeStore(destination, `repo:${REPO}`); }
  await mapWorkspace(destination.db, { repoKey: "native-repo", workspaceId: "native-workspace", path: nativeRoot });
  initializeStore(destination, "worktree:native-repo:native-workspace");
  worktree.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES(?,1,?)").run(SESSION, HUB);
  const file = join(source.root, "agent", "sessions", "project", "session.jsonl");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: SESSION, cwd: sourceRoot, timestamp: "2026-01-01T00:00:00Z" }) + "\n" +
    JSON.stringify({ type: "model_change", id: "leaf-a", parentId: null, timestamp: "2026-01-01T00:00:00Z", provider: "fixture", modelId: "fixture" }) + "\n", { mode: 0o600 });
  enableMemoryCapture(source.db, "global");
  const home = assignInitialHome(source.db, SESSION, HUB, HUB);
  if (home === "conflict") throw Error("initial-home-conflict");
  recordLocation(source.db, { sessionId: SESSION, stores: ["global", `repo:${REPO}`, WT], home, file, cwd: sourceRoot });
  const checkout = join(destination.root, "roam", "checkouts", `mapped-repo-${createHash("sha256").update(REPO).digest("hex").slice(0, 12)}`, "source-checkout-12345678");
  if (occupied) { mkdirSync(checkout, { recursive: true, mode: 0o700 }); writeFileSync(join(checkout, "private.txt"), "untouched\n"); }
  const config = (machineId: string): RoamConfig => ({ enabled: true, role: machineId === HUB ? "hub" : "box", machineId, hubMachineId: HUB,
    peers: machineId === HUB ? [{ machineId: BOX, alias: "box.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/spider", core: "/fixture/hc", globalRoot: destination.root }] : [],
    discoveryRoots: [], coreUnit: "fixture", syncMs: 120000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() });
  const configs = new Map([[HUB, config(HUB)], [BOX, config(BOX)]]), journals = new Map<string, ReturnType<typeof openFreezeJournal>>();
  for (const global of [source, destination]) {
    mkdirSync(join(global.root, "roam"), { recursive: true, mode: 0o700 });
    mkdirSync(join(global.root, "herdr"), { recursive: true, mode: 0o700 });
    writeFileSync(join(global.root, "herdr", "config.json"), JSON.stringify({ mode: "core-only", globalRoot: global.root,
      core: { binary: join(global.root, "hc"), config: join(global.root, "core.json") }, agentDirectory: join(global.root, "agent"), shellRc: join(global.root, "shell.rc"), machines: [] }), { mode: 0o600 });
    writeFileSync(join(global.root, "roam", "config.json"), JSON.stringify(configs.get(global.machineId)), { mode: 0o600 });
    writeFileSync(join(global.root, "roam", "machine.json"), JSON.stringify({ machineId: global.machineId }), { mode: 0o600 });
    configs.set(global.machineId, readLocalIdentity(global.root));
    journals.set(global.machineId, openFreezeJournal(join(global.root, "roam", "journal.db"))); enableMemoryCapture(global.db, "global");
  }
  const calls: Operation[] = [];
  let owner: Probe = { kind: "absent" }, ready: HubOperationReadiness | null = null;
  const empty = () => ({ asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] });
  const transport: Transport = { resolve: async peer => peer, read: async (_peer, path) => readFileSync(path),
    run: async () => { throw Error("unexpected run"); }, write: async () => { throw Error("unexpected write"); }, bootstrapProbe: async () => { throw Error("unexpected bootstrap"); },
    async exec(peer, argv, options) {
      const target = peer.machineId === BOX ? destination : source, targetConfig = configs.get(peer.machineId)!, journal = journals.get(peer.machineId)!;
      if (argv[1] === "artifact") {
        const staging = openStaging(join(target.root, "roam", "staging"), HUB, DEFAULT_LIMITS);
        try { return await handleArtifactRequest(JSON.parse(argv[3]), options.stdin, { store: staging, journal, machineId: peer.machineId, limits: DEFAULT_LIMITS }); }
        finally { staging.close(); }
      }
      const operation = JSON.parse(argv[2]) as Operation; calls.push(operation);
      const stores = createStorePort(targetConfig, target.db);
      let mounted: HostMoveRuntime | undefined;
      try {
        const reply = await handleAgentOperation(operation, { config: targetConfig, journal, root: join(target.root, "roam", "staging"), openStore: stores.openStore,
          async move(op) {
            mounted = await createHostMoveBindings({ root: target.root, globalDb: target.db, config: targetConfig, journal, sessionId: SESSION, transport, operation: op });
            mounted.bindings.participant!.auth = async () => [];
            mounted.bindings.participant!.writers = async () => [];
            mounted.bindings.participant!.sessionTarget = async () => join(destination.root, "incoming.jsonl");
            mounted.bindings.participant!.withBothLocks = async (_id, effect) => effect();
            mounted.bindings.participant!.probe = async () => owner;
            mounted.bindings.participant!.wake = async request => {
              const authority = createRunningIntentAuthority(target.db), intent = await authority.get(SESSION);
              if (!intent || authority.operationId(SESSION) !== request.operationId) return { ok: false, reason: "fixture-intent-missing" };
              const launchId = `launch-${request.operationId}`;
              owner = { kind: "live", identity: { pid: 900, bootId: "fixture-boot", startTime: "fixture-owner" } };
              ready = { origin: "hub-operation", opId: launchId, sessionId: SESSION, epoch: intent.epoch, file: intent.file, cwd: intent.cwd, core: "fixture-core", terminal: "fixture-terminal" };
              journal.begin({ id: launchId, kind: "exact-session-launch", machineId: BOX, expectedEpoch: intent.epoch, args: {} }); recordReadiness(journal, ready);
              return { ok: true, launchId };
            };
            mounted.bindings.participant!.readiness = async query => ready && query.epoch === ready.epoch && query.launchId === ready.opId ? ready : null;
            mounted.bindings.participant!.observation = async home => ({ home: sessionHome(target.db, SESSION) as typeof home, owner,
              readiness: ready && home.epoch === ready.epoch ? { ...ready, opId: createRunningIntentAuthority(target.db).operationId(SESSION)! } : null, launchFailure: null, retired: false });
            return mounted.dispatch(op);
          } });
        return Buffer.from(JSON.stringify(reply));
      } finally { await mounted?.close(); stores.close(); }
    } };
  controlSessionCatalog(source.db);
  const runtime = await createHostMoveBindings({ root: source.root, globalDb: source.db, config: configs.get(HUB)!, journal: journals.get(HUB)!, sessionId: SESSION, transport });
  closes.push(() => runtime.close());
  runtime.bindings.participant!.probe = async () => ({ kind: "absent" }); runtime.bindings.participant!.writers = async () => [];
  runtime.bindings.participant!.withBothLocks = async (_id, effect) => effect();
  runtime.bindings.participant!.dormant = context => {
    const dormant = createDormantControl({ ...context, blockerPorts: { sessionId: SESSION, address: { sessionId: SESSION, scopeId: null },
      activity: { busy: () => false, bashRunning: () => false, promptOpen: () => false }, broker: async () => empty(), bridge: async () => empty(),
      localRoutes: async () => [], topLevelJobs: async () => [], childJobs: async () => [], localJobs: async () => [] }, ingestThrough: async () => {} });
    return async op => op.kind === "session-inspect" ? { code: 0, reason: "inspected", operationId: op.id, home: context.home,
      epoch: op.expectedEpoch, repairCommand: null, value: { blockers: [] } } : dormant(op);
  };
  runtime.bindings.evidence!.bridge = empty; runtime.bindings.evidence!.broker = { inspectFreezeBlockers: async () => empty() };
  runtime.bindings.intercom!.ports = { close: async (address, moveId, expectedEpoch, generation) => ({ address, moveId, expectedEpoch, generation: generation ?? "fixture-fence" }),
    drain: async () => {}, inspect: async () => ({ blockers: [], cancelledWork: [], warnings: [] }), checkGeneration: async () => {}, abort: async () => {}, ready: async () => ({ intercomAddress: "checkout-session@box.invalid", warnings: [] }) };
  runtime.bindings.intercom!.destinationEndpoint = async home => ({ address: { sessionId: SESSION, scopeId: null }, machineId: home.machineId, homeEpoch: home.epoch, activationEpoch: "fixture-activation" });
  runtime.bindings.participant!.observation = async home => ({ home: sessionHome(source.db, SESSION) as typeof home, owner: { kind: "absent" }, readiness: null,
    launchFailure: null, retired: (worktree.prepare("SELECT state FROM roam_sessions WHERE session_id=?").get(SESSION) as { state: string } | undefined)?.state === "retired" });
  runtime.bindings.participant!.cleanupTerminal = async () => {};
  runtime.bindings.power = { pid: 900, onExit: () => () => {}, notice() {}, spawn: async () => ({ exited: Promise.resolve(), stop: async () => {} }) };
  runtime.bindings.handoff!.prepareHandoff = async () => ({ capture: "durable", presentation: { status: "pending", reason: "app-absent", presentation: null } });
  // Stop at the external freeze boundary. Preparation, mappings, snapshots, and sync remain real.
  if (!complete) runtime.ports.freeze = async () => { throw Error("fixture-freeze-stop"); };
  runtime.bindings.handoff!.readyTarget = async home => ({ machineId: home.machineId, alias: null, sessionId: SESSION, homeEpoch: home.epoch, coreId: "fixture-core", terminalId: "fixture-terminal" });
  runtime.bindings.handoff!.presentReadyTarget = async () => ({ status: "complete", reason: "presented", presentation: null });
  return { source, destination, runtime, worktree, checkout, nativeRoot, repository, calls, journals, transport };
}
let current: Awaited<ReturnType<typeof fixture>>, pendingOperation: string;
beforeEach(async context => { current = await fixture(!context.task.name.includes("unmapped repository"), context.task.name.includes("occupied"), context.task.name.includes("completed")); }, 5000);
for (const checkpoint of ["prestage", "transfer"]) beforeEach(async context => {
  if (!context.task.name.includes("completed")) return;
  const journal = current.journals.get(HUB)!, record = journal.record;
  journal.record = (id, action, value) => { record(id, action, value); if (action === "move-action-complete" && value.action === checkpoint) throw Error("fixture-checkpoint-stop"); };
  try {
    const reply = checkpoint === "prestage" ? await current.runtime.control({ op: "move", session: SESSION, machine: "box.invalid" })
      : await current.runtime.control({ op: "recover", operationId: pendingOperation });
    pendingOperation = reply.operationId!;
  } finally { journal.record = record; }
}, 5000);

it("a public move retains the remote workspace-plan error code", async () => {
  const f = current, exec = f.transport.exec;
  f.transport.exec = async (peer, argv, options) => {
    const operation = JSON.parse(argv[2]) as Operation;
    if (operation.kind !== "move-workspace-map") return exec(peer, argv, options);
    return Buffer.from(JSON.stringify({ code: 1, reason: "move-adapter-unavailable", causeCode: "move-adapter-unavailable",
      operationId: operation.id, epoch: operation.expectedEpoch, value: null,
      failure: { step: "workspace-plan", code: "connection-refused" } }));
  };
  const result = publicOutcome(await f.runtime.control({ op: "move", session: SESSION, machine: "box.invalid" }));
  expect(result).toMatchObject({ code: 1, reason: "move-preflight-refused", causeCode: "move-adapter-unavailable",
    failure: { step: "workspace-plan", code: "connection-refused" } });
  expect(controlText(result)).toContain("workspace-plan: connection-refused");
});

it("a public move refuses an unmapped repository before seed or freeze with the workspace cause and repo-map repair", async () => {
  const f = current, before = sessionHome(f.source.db, SESSION);
  const result = publicOutcome(await f.runtime.control({ op: "move", session: SESSION, machine: "box.invalid" }));
  expect(result).toMatchObject({ code: 1, reason: "move-preflight-refused", causeCode: "move-workspace-unmapped", home: before });
  expect(controlText(result)).toContain("spider roam repo map <repo> <path>");
  expect(f.worktree.prepare("SELECT count(*) AS count FROM roam_seed_progress").get()).toEqual({ count: 0 });
  expect(f.worktree.prepare("SELECT count(*) AS count FROM roam_sessions").get()).toEqual({ count: 0 });
  expect(sessionHome(f.source.db, SESSION)).toEqual(before); expect(existsSync(f.checkout)).toBe(false);
}, 5000);

it("a public move creates a separate detached checkout during pre-stage and retries reuse its mapping", async () => {
  const f = current, nativeHead = git(f.nativeRoot, ["rev-parse", "HEAD"]), nativeIndex = git(f.nativeRoot, ["write-tree"]);
  const journal = f.journals.get(HUB)!, record = journal.record;
  journal.record = (id, action, value) => { record(id, action, value); if (action === "move-action-complete" && value.action === "prestage") throw Error("fixture-prestage-stop"); };
  const reply = await f.runtime.control({ op: "move", session: SESSION, machine: "box.invalid" });
  const operationId = reply.operationId!;
  expect(existsSync(join(f.checkout, ".git"))).toBe(true);
  expect(f.destination.db.prepare("SELECT path FROM roam_workspace_maps WHERE repo_key=? AND workspace_id=?").get(REPO, WORKSPACE)).toEqual({ path: f.checkout });
  expect(git(f.checkout, ["rev-parse", "--git-common-dir"])).toContain(join(f.repository, ".git"));
  expect(git(f.checkout, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
  expect(readFileSync(join(f.checkout, "tracked.txt"), "utf8")).toBe("original\n");
  for (const path of [dirname(f.checkout), dirname(dirname(f.checkout))]) expect(statSync(path).mode & 0o777).toBe(0o700);
  expect(git(f.nativeRoot, ["rev-parse", "HEAD"])).toBe(nativeHead); expect(git(f.nativeRoot, ["write-tree"])).toBe(nativeIndex);
  expect(f.destination.db.prepare("SELECT path FROM roam_workspace_maps WHERE repo_key='native-repo'").get()).toEqual({ path: f.nativeRoot });
  const inode = statSync(f.checkout).ino;
  expect(f.destination.db.prepare("SELECT count(*) AS count FROM roam_workspace_maps WHERE repo_key=? AND workspace_id=?").get(REPO, WORKSPACE)).toEqual({ count: 1 });
  expect(await f.runtime.control({ op: "cancel", operationId })).toMatchObject({ code: 0, reason: "cancelled" });
  const cleanup = f.calls.find(op => op.kind === "move-abort-workspace" && op.machineId === BOX)!;
  expect(f.journals.get(BOX)!.read(cleanup.id)).toContainEqual(expect.objectContaining({ action: "workspace-aborted", result: { root: f.checkout, retained: true } }));
  const retry = await f.runtime.control({ op: "move", session: SESSION, machine: "box.invalid" });
  expect(f.journals.get(HUB)!.read(retry.operationId!).some(row => row.action === "move-action-complete" && row.result.action === "prestage")).toBe(true);
  expect(statSync(f.checkout).ino).toBe(inode);
}, 5000);

it("a completed public move reports the created checkout in JSON and text", async () => {
  const f = current;
  const reply = await f.runtime.control({ op: "recover", operationId: pendingOperation });
  const result = publicOutcome(reply);
  expect(result).toMatchObject({ code: 0, reason: "moved", value: { destinationRoot: f.checkout } });
  expect(controlText(result, "box.invalid")).toContain(f.checkout);
  expect(safeControlOutcome(result)).toEqual(result);
}, 5000);

it("an occupied checkout path refuses before seed and never overwrites private files", async () => {
  const f = current;
  const result = publicOutcome(await f.runtime.control({ op: "move", session: SESSION, machine: "box.invalid" }));
  expect(result).toMatchObject({ code: 1, causeCode: "move-checkout-conflict" });
  expect(readFileSync(join(f.checkout, "private.txt"), "utf8")).toBe("untouched\n");
  expect(f.worktree.prepare("SELECT count(*) AS count FROM roam_seed_progress").get()).toEqual({ count: 0 });
}, 5000);
