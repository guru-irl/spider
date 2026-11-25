import { afterEach, expect, it } from "vitest";
import { mkdirSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { recordLocation } from "@spider/db-core/roam/catalog";
import { readSessionState } from "@spider/db-core/roam/state";
import { assignInitialHome, sessionHome } from "@spider/roam/homes";
import { DEFAULT_LIMITS, disabledIntercom, type MoveRequest, type PreparedMove, type RoamConfig } from "@spider/roam/contracts";
import type { StoreBarrier } from "@spider/db-core/roam/types";
import { startSessionControlSocket } from "@spider/roam/session-socket";
import { moveSession, readMoveReservation } from "@spider/roam/move";
import { createMovePorts, handleMoveParticipantOperation } from "@spider/roam/move-ports";
import { openFreezeJournal } from "@spider/roam/journal";
import { safeControlOutcome, controlText } from "@spider/roam/commands";
import { createHostMoveBindings } from "../move-runtime";
import { createUsageIngestThrough } from "../usage-ingest";
import { discoverUsageSources } from "../../usage/discovery";
import { openUsageLedger } from "../../usage/ledger";

const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002";
const SESSION = "folder-session";
const closes: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

async function fixture(layout: "standard" | "custom" | "prefix" | "symlink" | "root-symlink" | "escape" | "missing-root") {
  const global = createReplica("global", HUB), worktree = createReplica("worktree", HUB), repository = createReplica("repo", HUB);
  closes.push(() => global.close(), () => worktree.close(), () => repository.close());
  const sessionsDir = join(global.root, "agent", "sessions"), standardDir = join(sessionsDir, "project");
  if (layout !== "missing-root") mkdirSync(standardDir, { recursive: true });
  if (layout === "root-symlink") {
    const physical = join(global.root, "physical-sessions"); renameSync(sessionsDir, physical); symlinkSync(physical, sessionsDir);
  }
  let dir = standardDir;
  if (layout === "custom" || layout === "missing-root") dir = join(global.root, "custom-sessions");
  if (layout === "prefix") dir = `${sessionsDir}-other`;
  if (layout === "symlink") { dir = join(global.root, "session-alias"); symlinkSync(standardDir, dir); }
  if (layout === "escape") {
    const outside = join(global.root, "outside"); mkdirSync(outside);
    dir = join(sessionsDir, "escape"); symlinkSync(outside, dir);
  }
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.jsonl"), timestamp = "2026-01-01T00:00:00Z";
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: SESSION, cwd: worktree.root, timestamp }) + "\n" +
    JSON.stringify({ type: "message", id: "leaf-a", parentId: null, timestamp, message: { role: "assistant", provider: "fixture", model: "fixture", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } } }) + "\n", { mode: 0o600 });
  worktree.db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES (?,1,?)").run(SESSION, HUB);
  global.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES (?,?,?,1,1)")
    .run("fixture-project", worktree.root, worktree.db.raw.name);
  const WT = worktree.storeKey, REPO = `repo:${WT.slice(9, WT.lastIndexOf(":"))}` as const;
  const config: RoamConfig = { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [],
    coreUnit: "fixture", syncMs: 120000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  mkdirSync(join(global.root, "roam"), { recursive: true }); mkdirSync(join(global.root, "herdr"), { recursive: true });
  writeFileSync(join(global.root, "herdr", "config.json"), JSON.stringify({ mode: "core-only", globalRoot: global.root,
    core: { binary: join(global.root, "hc"), config: join(global.root, "core.json") }, agentDirectory: join(global.root, "agent"), shellRc: join(global.root, "shell.rc"), machines: [] }), { mode: 0o600 });
  const journal = openFreezeJournal(join(global.root, "roam", "journal.db"));
  const transport = { async exec() { return Buffer.from(JSON.stringify({ code: 0, operationId: "folder-move-move-diagnostics-" + BOX, epoch: 1, value: [] })); }, async resolve(peer: unknown) { return peer; } };
  const mounted = await createHostMoveBindings({ root: global.root, globalDb: global.db, config, journal, sessionId: SESSION, transport: transport as never });
  closes.push(() => mounted.close());
  // The production folder boundary is retained. External workspace and peer effects are bounded doubles.
  config.peers = [{ machineId: BOX, alias: "box.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot: "/fixture/global" }];
  const bindings = mounted.bindings;
  bindings.participant!.stores = [{ key: "global", db: global.db }, { key: REPO, db: repository.db }, { key: WT, db: worktree.db }];
  bindings.participant!.pi = "/fixture/pi";
  bindings.participant!.probe = async () => ({ kind: "live", identity: { pid: 900, bootId: "fixture-boot", startTime: "fixture-start" } });
  bindings.participant!.runtimeRoot = join(process.cwd(), ".spider", "scratch", "sf");
  const socket = await startSessionControlSocket(bindings.participant!.runtimeRoot, SESSION, async ({ operation }) => ({ code: 0,
    reason: "inspected", operationId: operation.id, home: null, epoch: operation.expectedEpoch, repairCommand: null, value: { blockers: [] } }));
  closes.push(() => socket.close());
  bindings.participant!.withBothLocks = async (_id, effect) => effect();
  bindings.participant!.dormant = context => async op => ({ code: 0, reason: "inspected", operationId: op.id, home: context.home, epoch: op.expectedEpoch, repairCommand: null, value: { blockers: [] } });
  const dbFor = (key: string) => key === "global" ? global.db : key === WT ? worktree.db : repository.db;
  const head = (key: StoreBarrier["storeKey"]): StoreBarrier => {
    const db = dbFor(key), meta = db.prepare("SELECT stream_id FROM roam_meta WHERE id=1").get() as { stream_id: string };
    return { storeKey: key, stream: meta.stream_id, through: (db.prepare("SELECT coalesce(max(seq),0) AS seq FROM roam_changes").get() as { seq: number }).seq };
  };
  bindings.stores = { open: dbFor, head };
  bindings.mapping = async () => ({ repoKey: WT.slice(9, WT.lastIndexOf(":")), workspaceId: WT.slice(WT.lastIndexOf(":") + 1), sourceRoot: worktree.root,
    destinationRoot: worktree.root, destinationCwd: worktree.root });
  bindings.sync = { barriers: async () => true, async sync() { assignInitialHome(global.db, SESSION, HUB, HUB); return []; } };
  bindings.power = { pid: 900, onExit: () => () => {}, notice() {}, spawn: async () => ({ exited: Promise.resolve(), stop: async () => {} }) };
  bindings.evidence!.bridge = async () => ({ asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] });
  bindings.evidence!.broker = { inspectFreezeBlockers: async address => bindings.evidence!.bridge!(address) };
  recordLocation(global.db, { sessionId: SESSION, stores: ["global", REPO, WT], home: null, file, cwd: worktree.root });
  const ports = createMovePorts(config, transport as never, journal, bindings);
  const request: MoveRequest = { sessionId: SESSION, destinationMachine: BOX, operation: { id: "folder-move", kind: "move", machineId: HUB,
    expectedEpoch: null, args: { sessionId: SESSION, destinationMachine: BOX } } };
  return { global, worktree, journal, file, sessionsDir, ports, request, bindings, WT };
}

it.each(["custom", "prefix", "escape", "missing-root"] as const)("refuses %s session folders before home, fence or pending move", async layout => {
  const f = await fixture(layout);
  const result = await moveSession(f.request, f.ports), publicResult = safeControlOutcome(result);
  expect(publicResult).toMatchObject({ code: 1, reason: "move-preflight-refused", causeCode: "move-session-dir-unsupported", home: null, epoch: null });
  expect(controlText(publicResult)).toMatch(/agent.*sessions.*folder/i);
  expect(controlText(publicResult)).toContain("without --session-dir");
  expect(sessionHome(f.global.db, SESSION)).toBeNull();
  expect(readSessionState(f.worktree.db, SESSION)).toBeNull();
  expect(f.worktree.db.prepare("SELECT count(*) AS count FROM roam_seed_progress").get()).toEqual({ count: 0 });
  expect(f.journal.readIntercomFence(SESSION, f.request.operation.id)).toBeNull();
  expect(readMoveReservation(SESSION, f.journal)).toBeNull();
  expect(f.journal.lookupOperation(f.request.operation.id)?.state).toBe("done");
  expect(f.journal.read(f.request.operation.id).filter(row => row.action === "move-action-start").map(row => row.result.action)).toEqual(["check"]);
});

it.each(["standard", "symlink", "root-symlink"] as const)("allows %s session paths at preflight", async layout => {
  const f = await fixture(layout);
  await expect(f.ports.check(f.request)).resolves.toMatchObject({ sourceFile: f.file, source: { machineId: HUB, epoch: 1 } });
  expect(sessionHome(f.global.db, SESSION)).toBeNull();
});

it("remote location preflight refuses an unsupported transcript on its source machine", async () => {
  const f = await fixture("custom");
  assignInitialHome(f.global.db, SESSION, HUB, HUB);
  const before = sessionHome(f.global.db, SESSION);
  await expect(handleMoveParticipantOperation({ id: "remote-location", kind: "move-location", machineId: HUB, expectedEpoch: 1,
    args: { sourceMachine: HUB, sessionId: SESSION, moveId: "folder-move" } }, f.journal, f.bindings)).rejects.toMatchObject({ code: "move-session-dir-unsupported" });
  expect(sessionHome(f.global.db, SESSION)).toEqual(before);
  expect(readSessionState(f.worktree.db, SESSION)).toBeNull();
});

it("a standard first-home move reaches the real frozen usage ledger with local machine identity", async () => {
  const f = await fixture("standard"), paths = { registryDb: f.global.db.raw.name, sessionsDir: f.sessionsDir,
    ledgerFile: join(f.global.root, "usage.db"), authPath: join(f.global.root, "auth.json"), leaseDir: join(f.global.root, "leases") };
  const size = statSync(f.file).size;
  expect(sessionHome(f.global.db, SESSION)).toBeNull();
  let ingested = false;
  f.ports.prepare = async check => ({ session: { sessionId: SESSION, file: f.file, cwd: check.destinationCwd, size, leaf: "leaf-a", sha256: "a".repeat(64), historySha256: "b".repeat(64), artifactId: "fixture-artifact" },
    workspace: { root: check.destinationRoot, moveId: f.request.operation.id, snapshot: { repoKey: check.repoKey, workspaceId: check.workspaceId, root: check.sourceRoot, moveId: f.request.operation.id, stage: "pre" } } } as PreparedMove);
  f.ports.freeze = async () => {
    expect(f.journal.read(f.request.operation.id).some(row => row.action === "move-action-complete" && row.result.action === "initial-home")).toBe(true);
    expect(sessionHome(f.global.db, SESSION)).toMatchObject({ machineId: HUB, epoch: 1, moveId: null });
    const discovery = await discoverUsageSources(paths);
    expect(discovery.sources.find(source => source.path === realpathSync(f.file))?.roaming).toMatchObject({ localMachine: HUB, originMachine: HUB });
    await createUsageIngestThrough(paths, SESSION, HUB)(f.file, size);
    const ledger = openUsageLedger(paths.ledgerFile);
    try { expect(ledger.getImportState(f.file)).toMatchObject({ offset: size, size }); expect(ledger.health().calls).toBe(1); }
    finally { ledger.close(); }
    ingested = true;
    throw new Error("fixture-stop-after-usage");
  };
  const result = await moveSession(f.request, f.ports);
  expect(ingested, JSON.stringify(result)).toBe(true);
});
