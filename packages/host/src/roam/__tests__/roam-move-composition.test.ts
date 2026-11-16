import { readLocal } from "@spider/db-core/roam/local-state";
import { readMoveBindingDiagnostics } from "@spider/roam/move-diagnostics";
import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { createReplica } from "@spider/db-core/testutil";
import { DEFAULT_LIMITS, disabledIntercom, type RoamConfig } from "@spider/roam/contracts";
import { openFreezeJournal } from "@spider/roam/journal";
import { unboundMoveEffects, moveEffectReason } from "@spider/roam/move-ports";
import { createHostMoveBindings, moveBindingDiagnostics } from "../move-runtime";
import * as hostConfig from "@spider/roam/host-config";
import * as presentationPorts from "../../herdr/roam-presentations";
import * as sessionSocket from "@spider/roam/session-socket";
import { parsePaneTarget, parsePaneSlot } from "@spider/herdr/panes/codec";
import { createPanePlacementStore } from "@spider/herdr/panes/store";
import { createRoamPresentationOperations } from "@spider/herdr/roam-placement";
import * as runtime from "@spider/roam/runtime";
import { createMoveActivation } from "../move-activation";
import { createHostRoamPresentationPorts } from "../readiness";
import { openDb } from "@spider/db-core";
import { revokeMachine } from "@spider/roam/revocation";
const HUB = "00000000-0000-4000-8000-000000000001";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const fixture of fixtures.splice(0)) fixture.close(); });
it("a disabled hub does not open a move runtime or control socket", async () => {
  const global = createReplica("global", HUB); fixtures.push(global);
  const config: RoamConfig = { enabled: false, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  writeFileSync(join(global.root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(global.root, "roam", "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  const open = vi.spyOn(runtime, "openLocalCore").mockImplementation(() => { throw new Error("unexpected runtime open"); });
  const activation = await createMoveActivation({ root: global.root, sessionId: "ordinary", file: "/fixture/session.jsonl", context: () => undefined } as never).catch(() => "opened");
  expect(open).not.toHaveBeenCalled();
  expect(activation).toBeNull();
}, 5000);

it("production composition leaves zero unbound effects", async () => {
  const global = createReplica("global", HUB); fixtures.push(global);
  const config: RoamConfig = { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  writeFileSync(join(global.root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(global.root, "roam", "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  const journal = openFreezeJournal(join(global.root, "roam", "journal.db"));
  const runtime = await createHostMoveBindings({ root: global.root, globalDb: global.db, config, journal, sessionId: "session-a", transport: {} as never });
  try {
    expect(unboundMoveEffects(runtime.bindings)).toEqual([]);
    expect(moveBindingDiagnostics(runtime.bindings)).toEqual([]);
    expect(readMoveBindingDiagnostics(global.root, join(global.root, "store.db"))).toEqual([]);
    expect(runtime.bindings.participant!.config).toBe(config);
    expect(runtime.bindings.globalDb).toBe(global.db);
    expect(await runtime.bindings.recovery!.workspaceRestores!()).toEqual([]);
  } finally { await runtime.close(); }
}, 5000);
it("the import lock is not a session owner, but other observers still see the claim", async () => {
  const inventoryModule = await import("../../herdr/process-inventory");
  const { recordLocation } = await import("@spider/db-core/roam/catalog");
  const global = createReplica("global", HUB); fixtures.push(global);
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  const config: RoamConfig = { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  const file = join(global.root, "session.jsonl"), sessionId = "import-session";
  recordLocation(global.db, { sessionId, stores: ["global"], home: null, file, cwd: global.root });
  const inventory = inventoryModule.createProcessInventory(join(global.root, "herdr"));
  const processes = vi.fn(async () => [] as Awaited<ReturnType<typeof inventory.processes>>);
  vi.spyOn(inventoryModule, "createProcessInventory").mockReturnValue({ ...inventory, processes });
  const mounted = await createHostMoveBindings({ root: global.root, globalDb: global.db, config, journal: openFreezeJournal(join(global.root, "roam", "journal.db")), sessionId, transport: {} as never });
  const participant = mounted.bindings.participant!;
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let locked: Promise<void> | undefined;
  try {
    expect(await participant.probe(sessionId)).toEqual({ kind: "absent" });
    locked = participant.withBothLocks(sessionId, async () => {
      entered(); await hold;
      expect(await participant.probe(sessionId)).toEqual({ kind: "absent" });
      const current = await inventory.probe(process.pid);
      if (current.kind !== "live") throw new Error("test process identity unavailable");
      processes.mockResolvedValue([{ pid: process.pid, startIdentity: current.startIdentity, classification: "pi" }]);
      expect(await participant.probe(sessionId)).toEqual({ kind: "uncertain" });
      processes.mockResolvedValue([]);
    });
    await Promise.race([ready, locked]);
    expect(await participant.probe(sessionId)).toMatchObject({ kind: "live", identity: { pid: process.pid } });
    release(); await locked;
    expect(await participant.probe(sessionId)).toEqual({ kind: "absent" });
  } finally { release(); await locked?.catch(() => {}); await mounted.close(); }
}, 5000);

it("production move evidence queries the connected machine service broker", async () => {
  const { startMachineMoveSocket } = await import("@spider/roam/machine-move-socket");
  const global = createReplica("global", HUB); fixtures.push(global);
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  const config: RoamConfig = { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  const snapshot = { asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] }, observed: unknown[] = [];
  let connected = true;
  const service = await startMachineMoveSocket(global.root, () => true, { async broker(address: unknown) {
    if (!connected) throw new Error("intercom-broker-unavailable");
    observed.push(address); return snapshot;
  } } as never);
  const mounted = await createHostMoveBindings({ root: global.root, globalDb: global.db, config, journal: openFreezeJournal(join(global.root, "roam", "journal.db")), sessionId: "session-a", transport: {} as never });
  try {
    const address = { sessionId: "session-a", scopeId: null };
    expect(await mounted.bindings.evidence!.broker!.inspectFreezeBlockers(address)).toEqual(snapshot);
    expect(observed).toEqual([address]);
    connected = false;
    await expect(mounted.bindings.evidence!.broker!.inspectFreezeBlockers(address)).rejects.toThrow("intercom-broker-unavailable");
  } finally { await mounted.close(); await service.close(); }
}, 5000);

async function inspectProductionActivation(initializeScratch: boolean) {
  const { paths } = await import("@spider/db-core"), control = await import("../control");
  const { createBothLocks } = await import("@spider/roam/session-control");
  const { startMachineMoveSocket } = await import("@spider/roam/machine-move-socket");
  const { createSessionLeases } = await import("@spider/herdr/sessions/lease");
  const { createProcessPresence } = await import("@spider/herdr/sessions/presence");
  const { processStartTime } = await import("../../../../subagents/src/process-identity");
  const { recordLocation } = await import("@spider/db-core/roam/catalog");
  const { spawn } = await import("node:child_process");
  const global = createReplica("global", HUB), worktree = createReplica("worktree", HUB); fixtures.push(global, worktree);
  vi.stubEnv("HC_SOCKET", join(process.cwd(), ".spider/scratch/move-composition.sock"));
  vi.stubEnv("HC_TERMINAL_SOCKET", join(process.cwd(), ".spider/scratch/move-composition.sock"));
  vi.stubEnv("HC_SESSION", "move-composition");
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  const config: RoamConfig = { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  mkdirSync(join(global.root, "herdr", "jobs"), { recursive: true, mode: 0o700 });
  writeFileSync(join(global.root, "herdr", "config.json"), JSON.stringify({ mode: "core-only", globalRoot: global.root, core: { binary: join(global.root, "hc"), config: join(global.root, "core.json") }, agentDirectory: join(global.root, "agent"), shellRc: join(global.root, "shell.rc"), machines: [] }), { mode: 0o600 });
  vi.spyOn(runtime, "readLocalIdentity").mockReturnValue(config);
  vi.spyOn(runtime, "openLocalCore").mockReturnValue({ root: global.root, config, db: global.db, close() {} });
  vi.spyOn(await import("../../usage/mount"), "resolveUsageRoots").mockReturnValue({ registryDb: join(global.root, "spider.db"), ledgerFile: join(global.root, "usage.db"), sessionsDir: join(global.root, "sessions"), authPath: join(global.root, "auth.json"), leaseDir: join(global.root, "usage-leases") });
  const scratch = [join(worktree.root, ".spider", "scratch"), join(global.root, "scratch")];
  vi.spyOn(paths, "scratch").mockImplementation(scope => scratch[scope === "global" ? 1 : 0]);
  if (initializeScratch) for (const root of scratch) mkdirSync(root, { recursive: true });
  const file = join(worktree.root, "session.jsonl"), sessionId = "clean-session";
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: worktree.root }) + "\n" + JSON.stringify({ type: "model_change", id: "leaf-1", parentId: null }) + "\n");
  worktree.db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES(?,1,?)").run(sessionId, HUB);
  worktree.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES(?,1,'active')").run(sessionId);
  global.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES(?,?,?,1,1)").run("fixture", worktree.root, worktree.db.raw.name);
  global.db.prepare("INSERT INTO session_homes VALUES(?,?,1,NULL,1)").run(sessionId, HUB);
  const home = { sessionId, machineId: HUB, epoch: 1, moveId: null, updatedAt: 1 };
  recordLocation(global.db, { sessionId, stores: ["global", worktree.storeKey], home, file, cwd: worktree.root });
  const snapshot = { asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [] };
  const machine = await startMachineMoveSocket(global.root, () => true, { broker: async () => snapshot, bridge: async () => snapshot, settlement: async () => null } as never);
  let live!: Parameters<typeof control.serveSessionControl>[0]["ports"];
  vi.spyOn(control, "serveSessionControl").mockImplementation(async input => { live = input.ports; return { async close() {} }; });
  const context = { cwd: worktree.root, mode: "rpc", hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => file, getLeafId: () => "leaf-1" } };
  const inert = { async pause() {}, async resume() {} }, activity = { busy: () => false, bashRunning: () => false, promptOpen: () => false };
  const gate = { inspect: () => ({ kind: "ordinary", home, blockers: [] }) };
  let activation: Awaited<ReturnType<typeof createMoveActivation>>;
  try {
    activation = await createMoveActivation({ root: global.root, sessionId, file, context: () => context, gate, activity, usage: inert, embeddings: inert, organism: inert, others: [] } as never);
    expect(activation).not.toBeNull();
    const startIdentity = processStartTime(process.pid)!, leases = createSessionLeases(join(global.root, "herdr"));
    const inventory = { presence: createProcessPresence(leases.root), leases, processes: async () => [], probe: async () => ({ kind: "live" as const, startIdentity }) };
    await createBothLocks({ root: leases.root, file: async () => file, inventory, identity: { pid: process.pid, startIdentity } })(sessionId, async () => {
      expect((await live.inspect()).blockers).toEqual([]);
      const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
      await once(child, "spawn");
      const job = join(scratch[0], "bg", "active-job"); mkdirSync(job, { recursive: true });
      writeFileSync(join(job, "job.json"), JSON.stringify({ schema: 1, id: "active-job", ownerSessionId: sessionId, childPid: child.pid }), { mode: 0o600 });
      try { expect((await live.inspect()).blockers).toEqual([{ kind: "local-job", id: "active-job", detail: "A local job is running or its status is unknown." }]); }
      finally { const exited = once(child, "exit"); child.stdin!.end(); await exited; }
    });
  } finally { await activation!?.close(); await machine.close(); }
}

it("production activation inspects the route-owning store and still blocks real local jobs", async () => {
  await inspectProductionActivation(true);
}, 5000);

it("production activation initializes first-use scratch roots and still blocks real local jobs", async () => {
  await inspectProductionActivation(false);
}, 5000);

it("the real participant auth port blocks missing pi auth and warns that tools were not checked", async () => {
  const global = createReplica("global", HUB); fixtures.push(global);
  const config: RoamConfig = { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  const agentDir = join(global.root, "agent"); mkdirSync(agentDir, { mode: 0o700 });
  vi.spyOn(hostConfig, "loadHerdrConfig").mockReturnValue({ agentDirectory: agentDir } as never);
  const journal = openFreezeJournal(join(global.root, "roam", "journal.db"));
  const runtime = await createHostMoveBindings({ root: global.root, globalDb: global.db, config, journal, sessionId: "session-a", transport: {} as never });
  try {
    expect(await runtime.bindings.participant!.auth()).toEqual([expect.objectContaining({ reason: "pi-auth-missing", severity: "block" })]);
    writeFileSync(join(agentDir, "auth.json"), '{"fixture-provider":{"type":"oauth"}}', { mode: 0o600 });
    expect(await runtime.bindings.participant!.auth()).toEqual([expect.objectContaining({ reason: "tool-auth-unverified", severity: "warning" })]);
  } finally { await runtime.close(); }
}, 5000);

it("a production box waits locally for pushed move evidence and never dials the hub", async () => {
  const BOX = "00000000-0000-4000-8000-000000000002", global = createReplica("global", BOX); fixtures.push(global);
  const config: RoamConfig = { enabled: true, role: "box", machineId: BOX, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  const journal = openFreezeJournal(join(global.root, "roam", "journal.db")), calls: string[] = [];
  const runtime = await createHostMoveBindings({ root: global.root, globalDb: global.db, config, journal, sessionId: "session-a", transport: { async resolve() { calls.push("resolve"); throw new Error("box cannot dial"); } } as never });
  const operation = { id: "retire-a", kind: "session-retire", machineId: BOX, expectedEpoch: 1, args: { sourceMachine: HUB, sessionId: "session-a", moveId: "move-a" } };
  try {
    for (const [name, kind] of [["authorizeAbort", "session-unfreeze"], ["authorizeRetire", "session-retire"], ["rollback", "move-readmit"], ["presentation", "move-cleanup-terminal"]] as const) {
      const request = { ...operation, id: name, kind, args: { ...operation.args, presentation: { status: "complete" } } };
      expect(await runtime.bindings.evidence![name]!(request)).toBeNull();
      expect(await runtime.dispatch(request)).toMatchObject({ code: 3, reason: "waiting-for-hub-evidence" });
      expect(journal.read(request.id)).toEqual([]);
    }
    expect(calls).toEqual([]);
  } finally { await runtime.close(); }
}, 5000);

it("doctor reports every unbound effect", () => {
  const diagnostics = moveBindingDiagnostics({});
  expect(diagnostics.map(item => item.reason)).toEqual(unboundMoveEffects({}).map(effect => moveEffectReason(effect)));
  expect(diagnostics.every(item => item.severity === "block")).toBe(true);
}, 5000);

it("read-only doctor summarizes missing inventory before a production runtime mounts", () => {
  const global = createReplica("global", HUB); fixtures.push(global);
  expect(readMoveBindingDiagnostics(global.root)).toEqual([{ reason: "move-binding-inventory-unavailable", severity: "warning", repairCommand: "spider roam doctor" }]);
  expect(readLocal(global.db, "move-bindings", "inventory")).toBeUndefined();
}, 5000);

it("composition refuses a missing pi instead of launching its own CLI argv", async () => {
  const global = createReplica("global", HUB); fixtures.push(global);
  const config: RoamConfig = { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  const journal = openFreezeJournal(join(global.root, "roam", "journal.db"));
  vi.stubEnv("SPIDER_ROAM_PI", join(global.root, "missing-pi"));
  await expect(createHostMoveBindings({ root: global.root, globalDb: global.db, config, journal, sessionId: "session-a", transport: {} as never })).rejects.toThrow("participant-pi-unavailable");
  expect(readMoveBindingDiagnostics(global.root, join(global.root, "store.db"))).toContainEqual(expect.objectContaining({ reason: "participant-pi-unavailable" }));
}, 5000);

it("disabled restore composes without pi but still advertises launch effects as unavailable", async () => {
  const global = createReplica("global", HUB); fixtures.push(global);
  const config: RoamConfig = { enabled: false, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  const journal = openFreezeJournal(join(global.root, "roam", "journal.db"));
  vi.stubEnv("SPIDER_ROAM_PI", join(global.root, "missing-pi"));
  const runtime = await createHostMoveBindings({ root: global.root, globalDb: global.db, config, journal, sessionId: "session-a", transport: {} as never,
    operation: { id: "restore-a", kind: "restore-destroyed-home", machineId: HUB, expectedEpoch: 2, args: { sessionId: "session-a" } } });
  try { expect(unboundMoveEffects(runtime.bindings)).toEqual(["participant.pi", "readmitSource", "start"]); }
  finally { await runtime.close(); }
}, 5000);

it("source terminal cleanup rejects a same-pid foreign lock with another start identity", async () => {
  const { claimIdLock } = await import("@spider/herdr/sessions/id-lock");
  const global = createReplica("global", HUB); fixtures.push(global);
  const config: RoamConfig = { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  const journal = openFreezeJournal(join(global.root, "roam", "journal.db"));
  const runtime = await createHostMoveBindings({ root: global.root, globalDb: global.db, config, journal, sessionId: "session-a", transport: {} as never });
  const lock = await claimIdLock(join(global.root, "herdr"), "session-a", { pid: 42, startIdentity: "cleanup-start" }, async () => ({ kind: "live", startIdentity: "cleanup-start" }), { bootId: async () => "boot-a" });
  try {
    expect(await lock.isHeldByClaim!()).toBe(true);
    const directory = join(global.root, "herdr", "id-locks"), file = join(directory, readdirSync(directory).find(name => name.endsWith(".json"))!);
    const record = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...record, identity: { ...record.identity, startIdentity: "foreign-start" } }), { mode: 0o600 });
    const operation = { id: "cleanup-a", kind: "move-cleanup-terminal", machineId: HUB, expectedEpoch: 1, args: { sessionId: "session-a", moveId: "move-a", presentation: { status: "complete" } } };
    await expect(runtime.bindings.participant!.cleanupTerminal(operation, { owns: () => lock.isHeldByClaim!() })).rejects.toThrow("source-cleanup-lock-changed");
  } finally { await lock.release(); await runtime.close(); }
}, 5000);

it("the hub obtains a box presentation target from that box's guarded readiness", async () => {
  const BOX = "00000000-0000-4000-8000-000000000002", global = createReplica("global", HUB); fixtures.push(global);
  const config: RoamConfig = { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [{ machineId: BOX, alias: "box-1.invalid", node: "/bin/node", pi: "/bin/pi", cli: "/bin/spider", core: "core-a", globalRoot: "/fixture/global" }], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  const journal = openFreezeJournal(join(global.root, "roam", "journal.db")), home = { sessionId: "session-a", machineId: BOX, epoch: 2, moveId: "move-a", updatedAt: 1 };
  global.db.prepare("INSERT INTO session_homes VALUES(?,?,?,?,?)").run(home.sessionId, BOX, home.epoch, home.moveId, home.updatedAt);
  const target = { machineId: BOX, alias: null, sessionId: home.sessionId, homeEpoch: home.epoch, coreId: "box-core", terminalId: "box-terminal" }, calls: string[] = [];
  const unused = async (): Promise<never> => { throw new Error("unused transport method"); };
  const transport: import("@spider/roam/contracts").Transport = { resolve: async peer => peer, bootstrapProbe: unused, run: unused, read: unused, write: unused, async exec(peer, argv) {
    const op = JSON.parse(argv[2]); calls.push(op.kind);
    expect(peer.machineId).toBe(BOX); expect(op.args.sessionId).toBe(home.sessionId); expect(op.expectedEpoch).toBe(2);
    return Buffer.from(JSON.stringify({ operationId: op.id, code: 0, epoch: 2, value: target }));
  } };
  const runtime = await createHostMoveBindings({ root: global.root, globalDb: global.db, config, journal, sessionId: "session-a", transport });
  try { expect(await runtime.bindings.handoff!.readyTarget(home)).toEqual(target); expect(calls).toEqual(["move-ready-target"]); }
  finally { await runtime.close(); }
}, 5000);

it("production handoff captures before freeze and presents only a current ready target", async () => {
  const global = createReplica("global", HUB); fixtures.push(global);
  const config: RoamConfig = { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  const journal = openFreezeJournal(join(global.root, "roam", "journal.db"));
  const home = { sessionId: "session-a", machineId: HUB, epoch: 1, moveId: null, updatedAt: 1 };
  global.db.prepare("INSERT INTO session_homes VALUES(?,?,?,?,?)").run(home.sessionId, HUB, 1, null, 1);
  const source = parsePaneTarget({ coreId: "core-a", terminalId: "t1", address: "core-a/t1", createdMs: 10, identityLabels: { "spider.session": "session-a", "spider.generation": "gen-1" }, alias: null, machineId: HUB, kind: "session", sessionId: "session-a", generation: "gen-1", homeEpoch: 1, runId: null, consoleId: null, name: null, cwd: "/example" });
  const store = createPanePlacementStore(join(global.root, "roam", "placement")), calls: string[] = [];
  let captureAvailable = true;
  const operations = createRoamPresentationOperations({ stateRoot: join(global.root, "roam", "placement"), hc: { identity: async () => ({ coreId: "core-a" }) } as never,
    app: { ownerPlacement: async () => ({ space: "space-1", tab: "tab-1", pane: "pane-1" }) } as never,
    async request(request) { calls.push(request.op); if (request.op === 'prepare-handoff' && !captureAvailable) throw Error('service unavailable'); return { version: 1, kind: "outcome", outcome: { status: "complete", reason: request.op, presentation: (await store.read()).presentations[0] } }; },
  });
  const open = vi.spyOn(presentationPorts, "createProductionRoamPresentationPorts").mockReturnValue({ ...operations, resolveTarget: async () => source, dispose: async () => {} });
  vi.spyOn(sessionSocket, "requestSessionControl").mockImplementation(async (_root, operation) => { calls.push(operation.kind); return { code: 0, reason: "frozen", operationId: operation.id, epoch: 1, home, repairCommand: null, value: { operationId: operation.id, sessionId: home.sessionId, epoch: 1 } } as never; });
  const runtime = await createHostMoveBindings({ root: global.root, globalDb: global.db, config, journal, sessionId: home.sessionId, transport: {} as never });
  try {
    global.db.prepare("INSERT INTO roam_locations(session_id,stores_json,home_json,file,cwd) VALUES(?,?,?,?,?)").run(home.sessionId, '["global"]', JSON.stringify(home), "/example/session.jsonl", "/example");
    runtime.bindings.participant!.probe = async () => ({ kind: "live", identity: { pid: 123, bootId: "source-boot", startTime: "source-start" } });
    journal.begin({ id: "move-a", kind: "move", machineId: HUB, expectedEpoch: 1, args: { sessionId: home.sessionId, moveId: "move-a" } });
    await runtime.ports.freeze(home, { id: "move-a", kind: "move", machineId: HUB, expectedEpoch: 1, args: { sessionId: home.sessionId, moveId: "move-a" } });
    expect(calls).toEqual(["prepare-handoff", "session-freeze"]);
    expect(open).toHaveBeenCalledWith(global.root);
    const locator = { machineId: HUB, alias: null, sessionId: home.sessionId, homeEpoch: 2, coreId: "core-a", terminalId: "t1" } as const;
    expect(await runtime.bindings.handoff!.presentReadyTarget(locator)).toMatchObject({ status: "refused", reason: "presentation-home-changed" });
    expect(calls).toEqual(["prepare-handoff", "session-freeze"]);
    global.db.prepare("UPDATE session_homes SET epoch=2,move_id='move-a' WHERE session_id=?").run(home.sessionId);
    expect(await runtime.bindings.handoff!.presentReadyTarget({ ...locator, homeEpoch: 1 })).toMatchObject({ status: "refused" });
    expect(calls).toEqual(["prepare-handoff", "session-freeze"]);
    const resolved = { ...source, homeEpoch: 2 };
    vi.mocked(open).mock.results[0].value.resolveTarget = async () => resolved;
    expect(await runtime.bindings.handoff!.presentReadyTarget(locator)).toMatchObject({ status: "complete" });
    expect(calls).toEqual(["prepare-handoff", "session-freeze", "present-ready"]);
  } finally { await runtime.close(); }
}, 5000);

it.each(['box-to-box without a Mac view', 'app closed', 'service down', 'core-only'] as const)('production freeze proceeds with %s', async scenario => {
  const BOX = '00000000-0000-4000-8000-000000000002', global = createReplica('global', HUB); fixtures.push(global);
  mkdirSync(join(global.root, 'roam'), { mode: 0o700 });
  const config: RoamConfig = { enabled: true, role: 'hub', machineId: HUB, hubMachineId: HUB, peers: [{ machineId: BOX, alias: 'box-1.invalid', core: 'box-core', node: '/bin/node', pi: '/bin/pi', cli: '/bin/spider', globalRoot: '/example' }], discoveryRoots: [], coreUnit: 'fixture', syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  const home = { sessionId: 'session-a', machineId: scenario === 'box-to-box without a Mac view' ? BOX : HUB, epoch: 1, moveId: null, updatedAt: 1 };
  global.db.prepare('INSERT INTO session_homes VALUES(?,?,?,?,?)').run(home.sessionId, home.machineId, 1, null, 1);
  const source = parsePaneTarget({ coreId: home.machineId === BOX ? 'box-core' : 'core-a', terminalId: 't1', address: home.machineId === BOX ? 'box-core/t1' : 't1', createdMs: 10, identityLabels: { 'spider.session': 'session-a', 'spider.generation': 'gen-1' }, alias: home.machineId === BOX ? 'box-1.invalid' : null, machineId: home.machineId, kind: 'session', sessionId: 'session-a', generation: 'gen-1', homeEpoch: 1, runId: null, consoleId: null, name: null, cwd: '/example' });
  const stateRoot = join(global.root, 'roam', 'placement'), calls: string[] = [];
  if (scenario === 'app closed') await createPanePlacementStore(stateRoot).update(state => ({ ...state,
    presentations: [{ id: 'presentation-a', revision: 1, mode: 'native', role: 'agent', target: source, proxy: null, slot: parsePaneSlot({ space: 'space-1', tab: 'tab-1', pane: 'pane-1' }), visibility: 'visible', launch: 'acknowledged', closeOperationId: null, conversion: null }] }));
  const operations = createRoamPresentationOperations({ stateRoot, hc: { identity: async () => ({ coreId: 'core-a' }) } as never,
    app: scenario === 'core-only' ? null : { ownerPlacement: async () => { calls.push('placement'); if (scenario === 'app closed') throw Error('app disconnected'); return { space: 'space-1', tab: 'tab-1', pane: 'pane-1' }; } } as never,
    request: async () => { calls.push('service'); throw Error('service unavailable'); } });
  vi.spyOn(presentationPorts, 'createProductionRoamPresentationPorts').mockReturnValue({ ...operations, resolveTarget: async () => source, dispose: async () => {} });
  vi.spyOn(sessionSocket, 'requestSessionControl').mockImplementation(async (_root, operation) => { calls.push(operation.kind); return { code: 0, reason: 'frozen', operationId: operation.id, epoch: 1, home, repairCommand: null, value: { operationId: operation.id, sessionId: home.sessionId, epoch: 1 } } as never; });
  const journal = openFreezeJournal(join(global.root, 'roam', 'journal.db'));
  const transport = { resolve: async (peer: unknown) => peer, async exec(_peer: unknown, argv: string[]) {
    const operation = JSON.parse(argv[2]); calls.push(operation.kind);
    return Buffer.from(JSON.stringify({ operationId: operation.id, code: 0, epoch: 1, value: { operationId: operation.id, sessionId: home.sessionId, epoch: 1 } }));
  } };
  const runtime = await createHostMoveBindings({ root: global.root, globalDb: global.db, config, journal, sessionId: home.sessionId, transport: transport as never });
  try {
    global.db.prepare('INSERT INTO roam_locations(session_id,stores_json,home_json,file,cwd) VALUES(?,?,?,?,?)').run(home.sessionId, '["global"]', JSON.stringify(home), '/example/session.jsonl', '/example');
    runtime.bindings.participant!.probe = async () => ({ kind: 'live', identity: { pid: 123, bootId: 'source-boot', startTime: 'source-start' } });
    const operation = { id: 'move-a', kind: 'move', machineId: HUB, expectedEpoch: 1, args: { sessionId: home.sessionId, moveId: 'move-a' } };
    journal.begin(operation);
    expect(await runtime.bindings.handoff!.prepareHandoff({ source: home, operation, placementRoot: stateRoot })).toMatchObject({ capture: 'durable', presentation: { status: 'pending' } });
    await runtime.ports.freeze(home, operation);
    expect(calls.filter(call => call === 'session-freeze')).toEqual(['session-freeze']);
    expect(journal.read(operation.id)).toContainEqual(expect.objectContaining({ action: 'host-handoff-captured', result: expect.objectContaining({ kind: ['service down', 'app closed'].includes(scenario) ? 'app-absent' : 'nothing-to-capture' }) }));
    const state = await createPanePlacementStore(stateRoot).read();
    if (scenario === 'service down' || scenario === 'app closed') {
      expect(state.slots).toEqual([{ session: 'session-a', space: 'space-1', tab: 'tab-1' }]);
      expect(state.presentations).toHaveLength(1);
    } else expect(state.presentations).toEqual([]);
    expect(calls.every(call => ['placement', 'service', 'session-freeze'].includes(call))).toBe(true);
  } finally { await runtime.close(); }
}, 5000);

it("revoked alias reuse and a home change during readiness cannot reach presentation effects", async () => {
  const BOX = '00000000-0000-4000-8000-000000000002', global = createReplica('global', HUB); fixtures.push(global);
  mkdirSync(join(global.root, 'roam'), { mode: 0o700 });
  const config: RoamConfig = { enabled: true, role: 'hub', machineId: HUB, hubMachineId: HUB, peers: [{ machineId: BOX, alias: 'reused.invalid', core: 'core-remote', node: '/bin/node', pi: '/bin/pi', cli: '/bin/spider', globalRoot: '/example' }], discoveryRoots: [], coreUnit: 'synthetic', syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  openFreezeJournal(join(global.root, 'roam', 'journal.db'));
  const revocationDb = openDb(join(global.root, 'roam', 'journal.db'));
  const target = parsePaneTarget({ coreId: 'core-remote', terminalId: 't1', address: 'core-remote/t1', createdMs: 10, identityLabels: { 'spider.session': 'session-a' }, alias: 'reused.invalid', machineId: null, kind: 'session', sessionId: 'session-a', generation: 'gen-2', homeEpoch: 2, runId: null, consoleId: null, name: null, cwd: '/example' });
  const calls: unknown[] = [];
  const concrete = { prepareHandoff: async () => { calls.push('capture'); return { status: 'complete' as const, reason: 'captured', presentation: null }; },
    presentReadyTarget: async () => { calls.push('present'); return { status: 'complete' as const, reason: 'presented', presentation: null }; },
    resolveTarget: async () => { global.db.prepare("UPDATE session_homes SET epoch=3 WHERE session_id='session-a'").run(); return target; }, dispose: async () => {} };
  vi.spyOn(presentationPorts, 'createProductionRoamPresentationPorts').mockReturnValue(concrete);
  const ports = createHostRoamPresentationPorts({ root: global.root, globalDb: global.db, revocationDb, config });
  const locator = { machineId: BOX, alias: null, sessionId: 'session-a', homeEpoch: 2, coreId: 'core-remote', terminalId: 't1' } as const;
  global.db.prepare('INSERT INTO session_homes VALUES(?,?,?,?,?)').run('session-a', BOX, 2, 'move-a', 1);
  try {
    expect(await ports.presentReadyTarget(locator)).toMatchObject({ status: 'pending', reason: 'presentation-readiness-unavailable' });
    expect(calls).toEqual([]);
    global.db.prepare("UPDATE session_homes SET epoch=2 WHERE session_id='session-a'").run();
    revokeMachine(revocationDb, BOX);
    expect(await ports.presentReadyTarget(locator)).toMatchObject({ status: 'refused', reason: 'presentation-home-changed' });
    expect(await ports.prepareHandoff({ sessionId: 'session-a', machineId: BOX, epoch: 2, moveId: 'move-a', updatedAt: 1 })).toMatchObject({ status: 'refused', reason: 'presentation-home-changed' });
    expect(calls).toEqual([]);
    expect((global.db.prepare("SELECT epoch FROM session_homes WHERE session_id='session-a'").get() as { epoch: number }).epoch).toBe(2);
    const unknown = '00000000-0000-4000-8000-000000000003';
    global.db.prepare("UPDATE session_homes SET machine_id=? WHERE session_id='session-a'").run(unknown);
    concrete.resolveTarget = async () => target;
    expect(await ports.prepareHandoff({ sessionId: 'session-a', machineId: unknown, epoch: 2, moveId: 'move-a', updatedAt: 1 })).toMatchObject({ status: 'refused' });
    expect(calls).toEqual([]);
  } finally { await ports.dispose(); revocationDb.close(); }
}, 5000);

it("source cleanup rejects a replacement lock token even for the same process identity", async () => {
  const { claimIdLock } = await import("@spider/herdr/sessions/id-lock"), global = createReplica("global", HUB); fixtures.push(global);
  const identity = { pid: 82, startIdentity: "source-start" }, probe = async () => ({ kind: "live" as const, startIdentity: identity.startIdentity });
  const lock = await claimIdLock(join(global.root, "herdr"), "session-a", identity, probe, { bootId: async () => "source-boot" });
  expect(await lock.isHeldByClaim!()).toBe(true); await lock.release();
  const replacement = await claimIdLock(join(global.root, "herdr"), "session-a", identity, probe, { bootId: async () => "source-boot" });
  try { expect(await lock.isHeldByClaim!()).toBe(false); expect(await replacement.isHeldByClaim!()).toBe(true); }
  finally { await replacement.release(); }
}, 5000);
