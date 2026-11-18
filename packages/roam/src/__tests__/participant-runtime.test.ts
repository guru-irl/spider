const unavailableMove = async (): Promise<never> => { throw new Error("intercom-move-unavailable"); };
const movePort = { broker: unavailableMove, bridge: unavailableMove, settlement: unavailableMove, endpoint: unavailableMove, releaseRollbackFence: unavailableMove,
  intake: { close: unavailableMove, drain: unavailableMove, inspect: unavailableMove, checkGeneration: unavailableMove, abort: unavailableMove, ready: unavailableMove } };
import { afterEach, expect, it, vi } from "vitest";
import { handleAgentOperation } from "../agent";
import { startProductionSupervisor } from "../production-supervisor";
import * as productionSupervisor from "../production-supervisor";
import { readLocalIdentity } from "../runtime";
import * as runtimeModule from "../runtime";
import * as hubModule from "../production-hub";
import * as localDiagnostics from "../local-diagnostics";
import * as intercomRuntime from "../intercom-runtime";
import * as intercomProduction from "../intercom-production";
import * as participantSupervisor from "../participant-supervisor";
import * as launcherModule from "../launcher";
import * as hcModule from "@spider/herdr/client/hc";
import { claimIdLock } from "@spider/herdr/sessions/id-lock";
import { createParticipantSupervisor } from "../participant-supervisor";
import { recordReadiness } from "../session-control";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { recordLocation } from "@spider/db-core/roam/catalog";
import { DEFAULT_LIMITS, disabledIntercom } from "../contracts";
import { openJournal } from "../journal";
import { createMoveControlHandler } from "../adapter-controls";
import { safeControlOutcome, controlText } from "../commands";
import { handleSessionOperation } from "../participant-runtime";
import { createRunningIntentAuthority } from "../session-control";
import { createIntentStore } from "../intent";
import * as intentModule from "../intent";
import { participantLaunchId } from "../participant-launch";

const BOX = "00000000-0000-4000-8000-000000000002", HUB = "00000000-0000-4000-8000-000000000001";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); vi.restoreAllMocks(); });
function fixture(enabled = true, homed = true) {
  const global = createReplica("global", BOX), worktree = createReplica("worktree", BOX); fixtures.push(global, worktree);
  const config = { enabled, role: "box" as const, machineId: BOX, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture.service", syncMs: 120000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  writeFileSync(join(global.root, "roam", "machine.json"), JSON.stringify({ machineId: BOX }), { mode: 0o600 });
  writeFileSync(join(global.root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
  const file = join(worktree.root, "s.jsonl"); writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "s-1", cwd: worktree.root }) + "\n", { mode: 0o600 });
  global.db.prepare("UPDATE roam_meta SET capture_enabled=1 WHERE id=1").run();
  if (homed) global.db.prepare("INSERT INTO session_homes VALUES (?,?,2,?,1)").run("s-1", BOX, "move-1");
  worktree.db.prepare("INSERT INTO sessions(id,started_at) VALUES (?,1)").run("s-1");
  worktree.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,2,'retired')").run("s-1");
  worktree.db.prepare("UPDATE roam_meta SET capture_enabled=1 WHERE id=1").run();
  recordLocation(global.db, { sessionId: "s-1", stores: [worktree.storeKey], home: null, file, cwd: worktree.root });
  const ports = { config, root: join(global.root, "roam", "staging"), journal: openJournal(join(global.root, "roam", "journal.db")),
    openStore(key: string) { return { db: key === "global" ? global.db : worktree.db, effects: {} as never, policy: {} as never }; } };
  const operation = { id: "start-1", kind: "session-start", machineId: BOX, expectedEpoch: 2, args: { sourceMachine: HUB, sessionId: "s-1" } };
  return { global, worktree, ports, operation };
}
async function waitForHint(signal: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([signal, new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error("Supervisor hint was not observed")), 2000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
it("standalone start activates mapped stores and running intent with no pi process", async () => {
  const f = fixture(); let wakes = 0;
  const result = await handleSessionOperation(f.operation, f.ports, { wake: async () => { wakes++; } });
  expect(result).toMatchObject({ code: 3, reason: "readiness-pending" }); expect(wakes).toBe(1);
  expect(f.worktree.db.prepare("SELECT state FROM roam_sessions").get()).toEqual({ state: "active" });
  expect(await createRunningIntentAuthority(f.global.db).get("s-1")).toMatchObject({ desired: "running", epoch: 2 });
}, 5000);
it("standalone activation accepts the mixed location list written by a move", async () => {
  const f = fixture(), location = f.global.db.prepare("SELECT file,cwd FROM roam_locations WHERE session_id='s-1'").get() as { file: string; cwd: string };
  recordLocation(f.global.db, { sessionId: "s-1", stores: ["global", "repo:fixture-repo", f.worktree.storeKey], home: null, ...location });
  expect(await handleSessionOperation(f.operation, f.ports, { wake: async () => {} })).toMatchObject({ code: 3, reason: "readiness-pending" });
  expect(f.worktree.db.prepare("SELECT state FROM roam_sessions").get()).toEqual({ state: "active" });
  expect(await createRunningIntentAuthority(f.global.db).get("s-1")).toMatchObject({ desired: "running", epoch: 2 });
}, 5000);

it.each(["null", "object", "string", "empty", "non-string", "unknown kind", "missing repository", "missing worktree repository", "missing workspace", "missing separator", "duplicate", "no worktree", "invalid JSON"])(
  "standalone activation refuses a %s location list before changing membership", async kind => {
  const f = fixture(), invalid: Record<string, unknown> = {
    null: null, object: {}, string: "[]", empty: [], "non-string": [1], "unknown kind": ["unknown:fixture"],
    "missing repository": ["repo:"], "missing worktree repository": ["worktree::fixture"], "missing workspace": ["worktree:fixture:"],
    "missing separator": ["worktree:fixture"], duplicate: [f.worktree.storeKey, f.worktree.storeKey], "no worktree": ["global", "repo:fixture-repo"],
  };
  f.global.db.prepare("UPDATE roam_locations SET stores_json=? WHERE session_id='s-1'").run(kind === "invalid JSON" ? "[" : JSON.stringify(invalid[kind]));
  expect(await handleSessionOperation(f.operation, f.ports, { wake: async () => {} })).toMatchObject({ code: 1, reason: "participant-stores-unavailable" });
  expect(f.worktree.db.prepare("SELECT state FROM roam_sessions").get()).toEqual({ state: "retired" });
  expect(await createRunningIntentAuthority(f.global.db).get("s-1")).toBeNull();
}, 5000);

it("retrying activation cannot erase a later durable stop", async () => {
  const f = fixture(), authority = createRunningIntentAuthority(f.global.db), location = f.global.db.prepare("SELECT file,cwd FROM roam_locations WHERE session_id='s-1'").get() as { file: string; cwd: string };
  await authority.set({ sessionId: "s-1", epoch: 2, desired: "running", suspended: null, ...location, moveId: "move-1" }, f.operation.id, { kind: "box-participant", machineId: BOX, hubMachineId: HUB });
  await authority.stop("s-1");
  await expect(handleSessionOperation(f.operation, f.ports, { wake: async () => { throw new Error("must not wake"); } })).rejects.toThrow("stopped");
  expect(await authority.get("s-1")).toMatchObject({ desired: "stopped" });
  expect(f.worktree.db.prepare("SELECT state FROM roam_sessions").get()).toEqual({ state: "retired" });
}, 5000);

it("hub scheduling disabled on a box does not refuse a trusted start", async () => {
  const f = fixture(), file = join(f.global.root, "roam", "config.json");
  writeFileSync(file, JSON.stringify({ ...f.ports.config, enabled: false }), { mode: 0o600 });
  expect(await handleSessionOperation(f.operation, f.ports, { wake: async () => {} })).toMatchObject({ code: 3, reason: "readiness-pending" });
  expect(await createRunningIntentAuthority(f.global.db).get("s-1")).toMatchObject({ desired: "running" });
}, 5000);

it.each(["not-roamable", "importing", "trigger-drift"])("refuses %s global capture before participant effects", async condition => {
  const f = fixture(false); let wakes = 0;
  if (condition === "not-roamable") f.global.db.prepare("UPDATE roam_meta SET roamable=0,problem='fixture issue' WHERE id=1").run();
  else if (condition === "importing") f.global.db.prepare("UPDATE roam_meta SET importing=1 WHERE id=1").run();
  else f.global.db.exec("DROP TRIGGER roam_global_memory_capture_ai");
  const before = f.global.db.prepare("SELECT capture_enabled,importing,roamable,problem FROM roam_meta").get();
  expect(await handleSessionOperation(f.operation, f.ports, { wake: async () => { wakes++; } })).toMatchObject({ code: 1, reason: "participant-capture-uninitialized" });
  expect(f.global.db.prepare("SELECT capture_enabled,importing,roamable,problem FROM roam_meta").get()).toEqual(before);
  expect(f.worktree.db.prepare("SELECT state FROM roam_sessions").get()).toEqual({ state: "retired" }); expect(wakes).toBe(0);
}, 5000);

it.each(["root", "machine"])('refuses mismatched pair platform %s before deferred startup', async mismatch => {
  const f = fixture(), platform = { root: mismatch === 'root' ? join(f.global.root, 'other') : f.global.root,
    machineId: mismatch === 'machine' ? HUB : BOX };
  const outcome = await startProductionSupervisor(f.global.root, { intercomLocalPorts: platform as never }).then(
    async service => { await service.stop(); return 'accepted'; }, error => (error as Error).message);
  expect(outcome).toBe('machine-mismatch');
}, 5000);

it("uninitialized production capture keeps an enrolled service inert", async () => {
  const f = fixture(), file = join(f.global.root, "roam", "config.json"), config = readLocalIdentity(f.global.root);
  writeFileSync(file, JSON.stringify({ ...config, enabled: false, intercom: { ...config.intercom, enabled: true, machineAlias: "box.invalid" } }), { mode: 0o600 });
  const factory = vi.spyOn(intercomRuntime, "createMachineIntercom");
  const service = await startProductionSupervisor(f.global.root, { system: { bootId: async () => { throw new Error("must not probe"); } } as never });
  await service.stop();
  expect(factory).not.toHaveBeenCalled();
  expect(f.worktree.db.prepare("SELECT state FROM roam_sessions").get()).toEqual({ state: "retired" });
}, 5000);

it.each([false, true])("production box owns its bridge with hub scheduling enabled=%s", async enabled => {
  const f = fixture(enabled), file = join(f.global.root, "roam", "config.json"), agentDir = join(f.global.root, "agent");
  mkdirSync(agentDir, { mode: 0o700 });
  const config = { ...f.ports.config, enabled, intercom: { ...disabledIntercom(), enabled: true as const, machineAlias: "box.invalid" } };
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  await f.global.db.raw.backup(join(f.global.root, "spider.db"));
  const order: string[] = [];
  const bridge = { async start() { order.push("bridge-start"); }, async stop() { order.push("bridge-stop"); }, diagnostics() { return []; }, move: movePort, readiness() { return { state: "ready" as const, reason: null }; } };
  const factory = vi.spyOn(intercomRuntime, "createMachineIntercom").mockReturnValue(bridge);
  vi.spyOn(runtimeModule, "openLocalRuntime").mockReturnValue({ config, db: f.global.db, journal: f.ports.journal, agent: { ...f.ports, config }, close() { order.push("runtime-close"); } } as never);
  vi.spyOn(hubModule, "loadHerdrConfig").mockReturnValue({ agentDirectory: agentDir, core: { binary: "/fixture/hc" } } as never);
  vi.spyOn(hcModule, "createHcClient").mockReturnValue({ async identity() { return { coreId: "fixture-core", sessionNamespace: "fixture", socket: "/fixture/socket" }; },
    events() { return { subscribe() { return () => {}; }, dispose() {} }; }, async dispose() {} } as never);
  vi.spyOn(participantSupervisor, "createParticipantSupervisor").mockReturnValue({ reconcile: async () => {},
    start() { order.push("supervisor-start"); }, async stop() { order.push("supervisor-stop"); } });
  const system = { inventory: { async probe() { return { kind: "live" as const, startIdentity: "fixture-process" }; } } } as never;
  const service = await startProductionSupervisor(f.global.root, { system, clock: { now: () => 1, later: () => () => {} } });
  try {
    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0][0]).toMatchObject({ root: f.global.root, agentDir, config: { enabled, machineId: BOX, hubMachineId: HUB } });
    expect(order).toEqual(["bridge-start", "supervisor-start"]);
    expect(vi.mocked(participantSupervisor.createParticipantSupervisor).mock.calls[0][0].connection).toMatchObject({ machineId: BOX, handshake: expect.any(Function), stopSessions: expect.any(Function) });
  } finally { await service.stop(); }
  expect(order).toEqual(["bridge-start", "supervisor-start", "supervisor-stop", "bridge-stop", "runtime-close"]);
}, 5000);

it('passes only pair platform ports to maintenance, never bridge overrides', async () => {
  const f = fixture(), agentDir = join(f.global.root, 'agent'); mkdirSync(agentDir, { mode: 0o700 });
  const config = { ...f.ports.config, intercom: { ...disabledIntercom(), enabled: true as const, machineAlias: 'box.invalid' } };
  writeFileSync(join(f.global.root, 'roam', 'config.json'), JSON.stringify(config), { mode: 0o600 });
  await f.global.db.raw.backup(join(f.global.root, 'spider.db'));
  const bridge = { async start() {}, async stop() {}, diagnostics() { return []; }, move: movePort, readiness() { return { state: 'ready' as const, reason: null }; } };
  vi.spyOn(intercomRuntime, 'createMachineIntercom').mockReturnValue(bridge);
  vi.spyOn(runtimeModule, 'openLocalRuntime').mockReturnValue({ config, db: f.global.db, journal: f.ports.journal, agent: { ...f.ports, config }, close() {} } as never);
  vi.spyOn(hubModule, 'loadHerdrConfig').mockReturnValue({ agentDirectory: agentDir, core: { binary: '/fixture/hc' } } as never);
  vi.spyOn(hcModule, 'createHcClient').mockReturnValue({ async identity() { return { coreId: 'fixture-core', sessionNamespace: 'fixture', socket: '/fixture/socket' }; },
    events() { return { subscribe() { return () => {}; }, dispose() {} }; }, async dispose() {} } as never);
  vi.spyOn(participantSupervisor, 'createParticipantSupervisor').mockReturnValue({ reconcile: async () => {}, start() {}, async stop() {} });
  const maintenance = vi.spyOn(intercomProduction, 'createProductionIntercomMaintenance');
  const platform = { root: f.global.root, machineId: BOX, home: agentDir, node: '/fixture/node', ssh: '/fixture/ssh', keygen: '/fixture/keygen', keyscan: '/fixture/ssh-keyscan',
    run: vi.fn(), enrollBridge: vi.fn(), inspectBridge: vi.fn(), inspectFence: vi.fn() };
  const system = { inventory: { async probe() { return { kind: 'live' as const, startIdentity: 'fixture-process' }; } } } as never;
  const service = await startProductionSupervisor(f.global.root, { system, intercomLocalPorts: platform });
  try {
    expect(maintenance).toHaveBeenCalledOnce();
    const passed = maintenance.mock.calls[0][0].localPorts;
    expect(passed).toMatchObject({ root: f.global.root, machineId: BOX, keyscan: '/fixture/ssh-keyscan', run: platform.run });
    for (const key of ['enrollBridge', 'inspectBridge', 'inspectFence']) expect(passed).not.toHaveProperty(key);
  } finally { await service.stop(); }
}, 5000);

it.each(["missing", "mode", "hub"])("refuses %s enrollment before effects", async kind => {
  const f = fixture(), file = join(f.global.root, "roam", "config.json");
  if (kind === "missing") unlinkSync(file);
  else if (kind === "hub") { const { hubMachineId: _hub, ...config } = f.ports.config; writeFileSync(file, JSON.stringify(config)); }
  else chmodSync(file, 0o644);
  expect(await handleAgentOperation(f.operation, f.ports)).toMatchObject({ code: 1, reason: "participant-config-unavailable" });
  expect(f.worktree.db.prepare("SELECT state FROM roam_sessions").get()).toEqual({ state: "retired" });
}, 5000);

it.each([false, true])("core restart recreates one exact-file owner with enabled=%s", async enabled => {
  const f = fixture(enabled);
  await handleSessionOperation(f.operation, f.ports, { wake: async () => {} });
  let owner: import("@spider/db-core/roam/types").Probe = { kind: "absent" }, launches = 0, now = 100;
  const supervisor = createParticipantSupervisor({ root: f.global.root, agent: f.ports,
    clock: { now: () => now, later: () => () => {} }, events: { subscribe: () => () => {} },
    owner: async () => owner, diagnostics: async () => [], stop: async () => ({ kind: "absent" }), notify: async () => {},
    async launch(intent, operationId) {
      launches++; owner = { kind: "live", identity: { bootId: "boot-1", pid: 90 + launches, startTime: "start-" + launches } };
      const ready = { origin: "hub-operation" as const, opId: operationId, sessionId: intent.sessionId, epoch: intent.epoch, file: intent.file, cwd: intent.cwd, core: "core-1", terminal: "term-" + launches };
      f.ports.journal.begin({ id: operationId, kind: "exact-session-launch", machineId: BOX, expectedEpoch: 2, args: {} });
      recordReadiness(f.ports.journal, ready); writeLocal(f.global.db, "participant-ready", intent.sessionId, ready);
      return { code: 0, reason: "ready", operationId, home: null, epoch: intent.epoch, repairCommand: null, value: ready };
    } });
  await supervisor.reconcile(); await supervisor.reconcile(); expect(launches).toBe(1);
  const first = await handleSessionOperation(f.operation, f.ports, { wake: async () => {} });
  expect(first).toMatchObject({ code: 0, operationId: f.operation.id, value: { origin: "hub-operation", opId: f.operation.id, terminal: "term-1" } });
  owner = { kind: "absent" }; await supervisor.reconcile(); now += 5000;
  await supervisor.reconcile(); await supervisor.reconcile();
  expect(launches).toBe(2); expect(owner.kind).toBe("live");
  expect(await handleSessionOperation(f.operation, f.ports, { wake: async () => {} })).toEqual(first);
  await supervisor.stop();
}, 5000);

it("supervises the mixed location store list written by a move", async () => {
  const f = fixture(); await handleSessionOperation(f.operation, f.ports, { wake: async () => {} });
  const location = f.global.db.prepare("SELECT file,cwd FROM roam_locations WHERE session_id='s-1'").get() as { file: string; cwd: string };
  recordLocation(f.global.db, { sessionId: "s-1", stores: ["global", "repo:fixture-repo", f.worktree.storeKey], home: null, ...location });
  let owner: import("@spider/db-core/roam/types").Probe = { kind: "absent" };
  const supervisor = createParticipantSupervisor({ root: f.global.root, agent: f.ports,
    clock: { now: () => 1, later: () => () => {} }, events: { subscribe: () => () => {} },
    owner: async () => owner, diagnostics: async () => [], stop: async () => ({ kind: "absent" }), notify: async () => {},
    async launch(intent, operationId) {
      owner = { kind: "live", identity: { bootId: "boot-1", pid: 90, startTime: "start-1" } };
      const ready = { origin: "hub-operation" as const, opId: operationId, sessionId: intent.sessionId, epoch: intent.epoch,
        file: intent.file, cwd: intent.cwd, core: "core-1", terminal: "term-1" };
      f.ports.journal.begin({ id: operationId, kind: "exact-session-launch", machineId: BOX, expectedEpoch: 2, args: {} });
      recordReadiness(f.ports.journal, ready); writeLocal(f.global.db, "participant-ready", intent.sessionId, ready);
      return { code: 0, reason: "ready", operationId, home: null, epoch: intent.epoch, repairCommand: null, value: ready };
    } });
  try {
    await supervisor.reconcile();
    expect((await createIntentStore(f.global.root).get("s-1"))?.value).toMatchObject({ intent: { suspended: null }, supervision: { kind: "live" } });
  } finally { await supervisor.stop(); }
}, 5000);

it.each(["null", "object", "string", "empty", "non-string", "unknown kind", "missing repository", "missing worktree repository", "missing workspace", "missing separator", "duplicate", "no worktree", "invalid JSON"])(
  "supervision refuses a %s location list before reserving a launch", async kind => {
  const f = fixture(); await handleSessionOperation(f.operation, f.ports, { wake: async () => {} });
  const invalid: Record<string, unknown> = {
    null: null, object: {}, string: "[]", empty: [], "non-string": [1], "unknown kind": ["unknown:fixture"],
    "missing repository": ["repo:"], "missing worktree repository": ["worktree::fixture"], "missing workspace": ["worktree:fixture:"],
    "missing separator": ["worktree:fixture"], duplicate: [f.worktree.storeKey, f.worktree.storeKey], "no worktree": ["global", "repo:fixture-repo"],
  };
  f.global.db.prepare("UPDATE roam_locations SET stores_json=? WHERE session_id='s-1'").run(kind === "invalid JSON" ? "[" : JSON.stringify(invalid[kind]));
  let launches = 0;
  const supervisor = createParticipantSupervisor({ root: f.global.root, agent: f.ports,
    clock: { now: () => 1, later: () => () => {} }, events: { subscribe: () => () => {} }, owner: async () => ({ kind: "absent" }),
    diagnostics: async () => [], stop: async () => ({ kind: "absent" }), notify: async () => {}, async launch() { launches++; throw new Error("must not launch"); } });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    for (let pass = 1; pass <= 4; pass++) {
      await supervisor.reconcile();
      expect((await createIntentStore(f.global.root).get("s-1"))?.value).toMatchObject({
        intent: { suspended: null }, supervision: { kind: "idle", nextAttemptAt: null } });
      expect(readLocal(f.global.db, "supervisor-hosting-error", "s-1") ?? null).toEqual(pass < 3 ? null
        : { code: "supervisor-hosting-error", check: "inspection", since: 1, count: 3 });
    }
    expect(launches).toBe(0);
    expect(log.mock.calls.map(args => JSON.parse(String(args[0])))).toEqual([{
      event: "supervisor-hosting-error", sessionId: "s-1", code: "supervisor-hosting-error", check: "inspection",
    }]);
  } finally { await supervisor.stop(); log.mockRestore(); }
}, 5000);

it("hub readiness is advertised only for the matching live launch owner", async () => {
  const f = fixture(), location = f.global.db.prepare("SELECT file,cwd FROM roam_locations WHERE session_id='s-1'").get() as { file: string; cwd: string };
  const authority = createRunningIntentAuthority(f.global.db);
  await authority.set({ sessionId: "s-1", epoch: 2, desired: "running", suspended: null, ...location, moveId: "move-1" }, "start-1", { kind: "box-participant", machineId: BOX, hubMachineId: HUB });
  f.ports.journal.begin({ id: "launch-1", kind: "exact-session-launch", machineId: BOX, expectedEpoch: 2, args: {} });
  const ready = { origin: "hub-operation" as const, opId: "launch-1", sessionId: "s-1", epoch: 2, ...location, core: "core-1", terminal: "term-1" };
  recordReadiness(f.ports.journal, ready); writeLocal(f.global.db, "participant-ready", "s-1", ready);
  vi.spyOn(runtimeModule, "openLocalRuntime").mockReturnValue({ config: f.ports.config, db: f.global.db, journal: f.ports.journal, close() {} } as never);
  vi.spyOn(hubModule, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  vi.spyOn(hcModule, "createHcClient").mockReturnValue({ async identity() { return { coreId: "core-1" }; }, async get() { return { state: "live" }; }, async dispose() {} } as never);
  const owner = { pid: process.pid, startIdentity: "fixture-owner" }, probe = async () => ({ kind: "live" as const, startIdentity: owner.startIdentity });
  const system = { bootId: async () => "boot-1", inventory: { probe } } as never, root = join(f.global.root, "herdr");
  const local = await claimIdLock(root, "s-1", owner, probe, { bootId: async () => "boot-1" });
  try { expect((await productionSupervisor.observeLocalHosting(f.global.root, { system })).readiness).toEqual([]); }
  finally { await local.release(); }
  const launcher = await claimIdLock(root, "s-1", { pid: process.pid + 1, startIdentity: "launcher" }, probe, { bootId: async () => "boot-1" });
  const handoff = await launcher.prepareHandoff("launch-1", location.file, "core-1");
  const adopted = await claimIdLock(root, "s-1", owner, probe, { bootId: async () => "boot-1", handoff });
  try { expect((await productionSupervisor.observeLocalHosting(f.global.root, { system })).readiness).toEqual([ready]); }
  finally { await adopted.release(); await launcher.release(); }
}, 5000);

it("durable intent writes wake supervision before the periodic sweep", async () => {
  const createEvents = productionSupervisor.createSupervisorEvents;
  expect(createEvents).toBeTypeOf("function");
  const f = fixture(); await handleSessionOperation(f.operation, f.ports, { wake: async () => {} });
  const listeners = new Set<(event: never) => void>();
  const core = { events() { return { subscribe(listener: (event: never) => void) { listeners.add(listener); return () => listeners.delete(listener); }, dispose() {} }; } };
  let finish!: () => void, owned = true; const stopped = new Promise<void>(resolve => { finish = resolve; });
  const stops: string[] = [];
  const supervisor = createParticipantSupervisor({ root: f.global.root, agent: f.ports, events: createEvents(f.global.db.raw.name, core as never),
    clock: { now: () => 1, later: () => () => {} },
    owner: async () => owned ? { kind: "live", identity: { bootId: "boot-1", pid: 123, startTime: "start-1" } } : { kind: "absent" },
    diagnostics: async () => [], async stop(id) { stops.push(id); owned = false; finish(); return { kind: "absent" }; }, notify: async () => {},
    async launch() { throw new Error("must not launch"); } });
  try {
    supervisor.start(); await supervisor.reconcile();
    await createRunningIntentAuthority(f.global.db).stop("s-1");
    await expect(waitForHint(stopped)).resolves.toBeUndefined();
    expect(stops).toEqual(["s-1"]);
  } finally { await supervisor.stop(); }
  expect(listeners.size).toBe(0);
}, 5000);

it("core events trigger crash reconciliation without waiting for the sweep", async () => {
  const createEvents = productionSupervisor.createSupervisorEvents;
  expect(createEvents).toBeTypeOf("function");
  const f = fixture(); await handleSessionOperation(f.operation, f.ports, { wake: async () => {} });
  const listeners = new Set<(event: never) => void>();
  const core = { events() { return { subscribe(listener: (event: never) => void) { listeners.add(listener); return () => listeners.delete(listener); }, dispose() {} }; } };
  let now = 1, owner: import("@spider/db-core/roam/types").Probe = { kind: "live", identity: { bootId: "boot-1", pid: 123, startTime: "start-1" } };
  let scheduled!: () => void, launched!: () => void;
  const crashScheduled = new Promise<void>(resolve => { scheduled = resolve; }), didLaunch = new Promise<void>(resolve => { launched = resolve; });
  let launches = 0;
  const supervisor = createParticipantSupervisor({ root: f.global.root, agent: f.ports, events: createEvents(f.global.db.raw.name, core as never),
    clock: { now: () => now, later(delay) { if (delay === 5000) scheduled(); return () => {}; } }, owner: async () => owner,
    diagnostics: async () => [], stop: async () => ({ kind: "absent" }), notify: async () => {},
    async launch(intent, operationId) { launches++; launched(); return { code: 3, reason: "pending", operationId, home: null, epoch: intent.epoch, repairCommand: null, value: null }; } });
  try {
    supervisor.start(); await supervisor.reconcile(); owner = { kind: "absent" };
    for (const listener of listeners) listener({ type: "finished" } as never);
    await expect(waitForHint(crashScheduled)).resolves.toBeUndefined(); now += 5000;
    for (const listener of listeners) listener({ type: "snapshot" } as never);
    await expect(waitForHint(didLaunch)).resolves.toBeUndefined();
    expect(launches).toBe(1);
  } finally { await supervisor.stop(); }
  expect(listeners.size).toBe(0);
}, 5000);

it("an initialized provisioned box without a hub intent launches nothing", async () => {
  const f = fixture(false); let launches = 0;
  const supervisor = createParticipantSupervisor({ root: f.global.root, agent: f.ports, clock: { now: () => 1, later: () => () => {} }, events: { subscribe: () => () => {} },
    owner: async () => ({ kind: "absent" }), diagnostics: async () => [], stop: async () => ({ kind: "absent" }), notify: async () => {},
    async launch() { launches++; throw new Error("must not launch"); } });
  await supervisor.reconcile(); expect(launches).toBe(0);
  const location = f.global.db.prepare("SELECT file,cwd FROM roam_locations WHERE session_id='s-1'").get() as { file: string; cwd: string };
  f.worktree.db.prepare("UPDATE roam_sessions SET state='active' WHERE session_id='s-1'").run();
  await createRunningIntentAuthority(f.global.db).set({ sessionId: "s-1", epoch: 2, desired: "running", suspended: null, ...location, moveId: "move-1" }, "unproved-intent", { kind: "box-participant", machineId: BOX, hubMachineId: "00000000-0000-4000-8000-000000000003" });
  await supervisor.reconcile(); expect(launches).toBe(0); await supervisor.stop();
}, 5000);

it.each(["absent", "live", "unknown"] as const)("resume clears an adopted reservation only when its owner is %s", async presence => {
  const f = fixture(false), authority = createRunningIntentAuthority(f.global.db), location = f.global.db.prepare("SELECT file,cwd FROM roam_locations WHERE session_id='s-1'").get() as { file: string; cwd: string };
  const intent = { sessionId: "s-1", epoch: 2, desired: "stopped" as const, suspended: null, ...location, moveId: "move-1" };
  await authority.set(intent, "stop-1", { kind: "box-participant", machineId: BOX, hubMachineId: HUB });
  const store = createIntentStore(f.global.root);
  await store.update("s-1", null, { intent, failures: [1], supervision: { kind: "launching", operationId: "launch-1", phase: "invoking" } });
  const root = join(f.global.root, "herdr"), old = { pid: 201, startIdentity: "old-launcher" }, child = { pid: 202, startIdentity: "child" };
  const launcher = await claimIdLock(root, "s-1", old, async () => ({ kind: "live", startIdentity: old.startIdentity }), { bootId: async () => "boot-1" });
  const handoff = await launcher.prepareHandoff("launch-1", location.file, "core-1");
  const adopted = await claimIdLock(root, "s-1", child, async () => ({ kind: "live", startIdentity: child.startIdentity }), { bootId: async () => "boot-1", handoff });
  await adopted.release();
  vi.spyOn(localDiagnostics, "runLocalDoctor").mockResolvedValue({ enabled: false, diagnostics: [], consumers: [] });
  let wakes = 0;
  const result = await handleSessionOperation({ ...f.operation, id: `resume-${presence}`, kind: "session-resume" }, f.ports,
    { wake: async () => { wakes++; }, launchRecovery: { bootId: async () => "boot-1", probe: async () => presence === "live"
      ? { kind: "live" as const, startIdentity: child.startIdentity } : { kind: presence } } });
  if (presence === "absent") {
    expect(result).toMatchObject({ code: 0, reason: "resumed-intent" });
    expect(await authority.get("s-1")).toMatchObject({ desired: "running" });
    expect((await store.get("s-1"))?.value.supervision).toEqual({ kind: "idle", nextAttemptAt: null });
    expect(wakes).toBe(1);
  } else {
    expect(result).toMatchObject({ code: 3, reason: "launch-reconciliation-required" });
    expect(await authority.get("s-1")).toMatchObject({ desired: "stopped" });
    expect((await store.get("s-1"))?.value.supervision.kind).toBe("launching");
    expect(wakes).toBe(0);
  }
}, 5000);

it("resume reports a blocking doctor and leaves the stopped intent unchanged", async () => {
  const f = fixture(false), authority = createRunningIntentAuthority(f.global.db), location = f.global.db.prepare("SELECT file,cwd FROM roam_locations WHERE session_id='s-1'").get() as { file: string; cwd: string };
  await authority.set({ sessionId: "s-1", epoch: 2, desired: "stopped", suspended: null, ...location, moveId: "move-1" }, "stop-1", { kind: "box-participant", machineId: BOX, hubMachineId: HUB });
  const doctor = vi.spyOn(localDiagnostics, "runLocalDoctor").mockResolvedValue({ enabled: false, diagnostics: [{ severity: "block", reason: "fixture prerequisite", repairCommand: null }], consumers: [] });
  const result = await handleAgentOperation({ ...f.operation, id: "resume-1", kind: "session-resume" }, f.ports);
  expect(result).toMatchObject({ code: 1, reason: "participant-doctor-refused" });
  expect(await authority.get("s-1")).toMatchObject({ desired: "stopped", epoch: 2 });
  expect(doctor).toHaveBeenCalledOnce();
}, 5000);

it("resume refuses an unavailable doctor and can retry after it succeeds", async () => {
  const f = fixture(false), authority = createRunningIntentAuthority(f.global.db), location = f.global.db.prepare("SELECT file,cwd FROM roam_locations WHERE session_id='s-1'").get() as { file: string; cwd: string };
  await authority.set({ sessionId: "s-1", epoch: 2, desired: "stopped", suspended: null, ...location, moveId: "move-1" }, "stop-1", { kind: "box-participant", machineId: BOX, hubMachineId: HUB });
  const doctor = vi.spyOn(localDiagnostics, "runLocalDoctor").mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValue({ enabled: false, diagnostics: [], consumers: [] });
  const operation = { ...f.operation, id: "resume-2", kind: "session-resume" }; let wakes = 0;
  expect(await handleSessionOperation(operation, f.ports, { wake: async () => { wakes++; } })).toMatchObject({ code: 1, reason: "participant-doctor-unavailable" });
  expect(await authority.get("s-1")).toMatchObject({ desired: "stopped" }); expect(wakes).toBe(0);
  expect(await handleSessionOperation(operation, f.ports, { wake: async () => { wakes++; } })).toMatchObject({ code: 0, reason: "resumed-intent" });
  expect(await authority.get("s-1")).toMatchObject({ desired: "running" }); expect(wakes).toBe(1); expect(doctor).toHaveBeenCalledTimes(2);
}, 5000);

it.each(["session-stop", "session-resume"])("%s refuses an intent from a different home epoch", async kind => {
  const f = fixture(false), authority = createRunningIntentAuthority(f.global.db), location = f.global.db.prepare("SELECT file,cwd FROM roam_locations WHERE session_id='s-1'").get() as { file: string; cwd: string };
  const desired = kind === "session-stop" ? "running" : "stopped";
  await authority.set({ sessionId: "s-1", epoch: 1, desired, suspended: null, ...location, moveId: null }, "old-op", { kind: "box-participant", machineId: BOX, hubMachineId: HUB });
  const doctor = vi.spyOn(localDiagnostics, "runLocalDoctor").mockResolvedValue({ enabled: false, diagnostics: [], consumers: [] });
  let wakes = 0;
  expect(await handleSessionOperation({ ...f.operation, id: `${kind}-2`, kind }, f.ports, { wake: async () => { wakes++; } })).toMatchObject({ code: 1, reason: "participant-intent-home-mismatch" });
  expect(await authority.get("s-1")).toMatchObject({ desired, epoch: 1 });
  expect(wakes).toBe(0); expect(doctor).not.toHaveBeenCalled();
}, 5000);

it("a non-box machine with an intent refuses before effects", async () => {
  const f = fixture(false), authority = createRunningIntentAuthority(f.global.db), location = f.global.db.prepare("SELECT file,cwd FROM roam_locations WHERE session_id='s-1'").get() as { file: string; cwd: string };
  await authority.set({ sessionId: "s-1", epoch: 2, desired: "running", suspended: null, ...location, moveId: "move-1" }, f.operation.id, { kind: "box-participant", machineId: BOX, hubMachineId: HUB });
  expect(() => createParticipantSupervisor({ root: f.global.root, agent: { ...f.ports, config: { ...f.ports.config, role: "hub" } },
    clock: { now: () => 1, later: () => () => {} }, events: { subscribe: () => () => {} }, owner: async () => { throw new Error("must not inspect"); },
    diagnostics: async () => [], stop: async () => ({ kind: "absent" }), notify: async () => {}, async launch() { throw new Error("must not launch"); } })).toThrow("participant-not-box");
}, 5000);

it("standalone start rechecks persisted enrollment before effects", async () => {
  const f = fixture();
  writeFileSync(join(f.global.root, "roam", "config.json"), JSON.stringify({ ...f.ports.config, hubMachineId: "00000000-0000-4000-8000-000000000003" }), { mode: 0o600 });
  expect(await handleSessionOperation(f.operation, f.ports, { wake: async () => { throw new Error("must not wake"); } })).toMatchObject({ code: 1, reason: "participant-config-changed" });
  expect(f.worktree.db.prepare("SELECT state FROM roam_sessions").get()).toEqual({ state: "retired" });
}, 5000);

it("box wake reserves exactly the requested session with an idempotent local launch id and no readiness wait", async () => {
  const { createBoxParticipantWake } = await import("../participant-runtime");
  const f = fixture(), authority = createRunningIntentAuthority(f.global.db);
  const location = f.global.db.prepare("SELECT file,cwd FROM roam_locations WHERE session_id='s-1'").get() as { file: string; cwd: string };
  await authority.set({ sessionId: "s-1", epoch: 2, desired: "running", suspended: null, ...location, moveId: "move-1" }, "start-1", { kind: "box-participant", machineId: BOX, hubMachineId: HUB });
  let wakes = 0;
  const wake = createBoxParticipantWake({ root: f.global.root, db: f.global.db, config: f.ports.config, journal: f.ports.journal, wake: async () => { wakes++; } });
  const first = await wake({ sessionId: "s-1", operationId: "start-1" });
  expect(first).toMatchObject({ ok: true, launchId: expect.any(String) });
  if (!first.ok) throw new Error(first.reason);
  expect(first.launchId).not.toBe("start-1");
  expect(await wake({ sessionId: "s-1", operationId: "start-1" })).toEqual(first);
  expect((await createIntentStore(f.global.root).get("s-1"))?.value.supervision).toEqual({ kind: "launching", phase: "reserved", operationId: first.launchId });
  expect(await wake({ sessionId: "different-session", operationId: "start-1" })).toMatchObject({ ok: false });
  expect(await createIntentStore(f.global.root).get("different-session")).toBeNull();
  expect(wakes).toBe(2);
}, 5000);

it.each(["same", "launch", "epoch", "file"] as const)("box wake recovers only its own complete reserved launch after a crash (%s)", async changed => {
  const { createBoxParticipantWake } = await import("../participant-runtime"), f = fixture(), authority = createRunningIntentAuthority(f.global.db);
  const location = f.global.db.prepare("SELECT file,cwd FROM roam_locations WHERE session_id='s-1'").get() as { file: string; cwd: string };
  const intent = { sessionId: "s-1", epoch: 2, desired: "running" as const, suspended: null, ...location, moveId: "move-1" };
  await authority.set(intent, "start-1", { kind: "box-participant", machineId: BOX, hubMachineId: HUB });
  const launchId = participantLaunchId(BOX, "s-1", 2, "start-1"), intents = createIntentStore(f.global.root);
  await intents.update("s-1", null, { intent: { ...intent, ...(changed === "epoch" ? { epoch: 1 } : {}), ...(changed === "file" ? { file: join(f.global.root, "other.jsonl") } : {}) }, failures: [], supervision: { kind: "launching", phase: "reserved", operationId: changed === "launch" ? "other-launch" : launchId } });
  let wakes = 0;
  const wake = createBoxParticipantWake({ root: f.global.root, db: f.global.db, config: f.ports.config, journal: f.ports.journal, wake: async () => { wakes++; } });
  const result = await wake({ sessionId: "s-1", operationId: "start-1" });
  expect(result).toEqual(changed === "same" ? { ok: true, launchId } : { ok: false, reason: "participant-launch-conflict" });
  expect(wakes).toBe(changed === "same" ? 1 : 0);
}, 5000);

it.each(["supervisor-first", "wake-first"] as const)("the same intent joins one launch when %s", async order => {
  const { createBoxParticipantWake } = await import("../participant-runtime"), f = fixture();
  await handleSessionOperation(f.operation, f.ports, { wake: async () => {} });
  let launches = 0, live = false;
  const launchIds: string[] = [];
  const supervisor = createParticipantSupervisor({ root: f.global.root, agent: f.ports,
    clock: { now: () => 1000, later: () => () => {} }, events: { subscribe: () => () => {} },
    owner: async () => live ? { kind: "live", identity: { bootId: "boot-1", pid: 123, startTime: "start-1" } } : { kind: "absent" },
    diagnostics: async () => [], stop: async () => ({ kind: "absent" }), notify: async () => {},
    async launch(intent, operationId) {
      launches++; launchIds.push(operationId); live = true;
      return { code: 0, reason: "ready", operationId, epoch: intent.epoch, home: null, repairCommand: null,
        value: { origin: "hub-operation", opId: operationId, sessionId: intent.sessionId, epoch: intent.epoch, file: intent.file,
          cwd: intent.cwd, core: "core-1", terminal: "terminal-1" } };
    },
  });
  const wake = createBoxParticipantWake({ root: f.global.root, db: f.global.db, config: f.ports.config, journal: f.ports.journal, wake: () => supervisor.reconcile() });
  try {
    if (order === "supervisor-first") await supervisor.reconcile();
    const result = await wake({ sessionId: "s-1", operationId: f.operation.id });
    expect(result).toEqual({ ok: true, launchId: participantLaunchId(BOX, "s-1", 2, f.operation.id) });
    await supervisor.reconcile();
    expect(launches).toBe(1);
    expect(launchIds).toEqual([result.ok ? result.launchId : "refused"]);
    expect(await wake({ sessionId: "s-1", operationId: f.operation.id })).toEqual(result);
    expect(launches).toBe(1);
    expect(await wake({ sessionId: "s-1", operationId: "different-operation" })).toEqual({ ok: false, reason: "participant-intent-unavailable" });
    expect(launches).toBe(1);
  } finally { await supervisor.stop(); }
}, 5000);

it("wake joins when supervision creates the same idle intent before its reservation", async () => {
  const { createBoxParticipantWake } = await import("../participant-runtime"), f = fixture();
  await handleSessionOperation(f.operation, f.ports, { wake: async () => {} });
  const store = createIntentStore(f.global.root);
  let raced = false, wakes = 0;
  vi.spyOn(intentModule, "createIntentStore").mockReturnValue({ ...store, async update(id, version, next) {
    if (!raced && version === null) {
      raced = true;
      await store.update(id, null, { ...next, supervision: { kind: "idle", nextAttemptAt: null } });
    }
    return store.update(id, version, next);
  } });
  const wake = createBoxParticipantWake({ root: f.global.root, db: f.global.db, config: f.ports.config, journal: f.ports.journal, wake: async () => { wakes++; } });
  const result = await wake({ sessionId: "s-1", operationId: f.operation.id });
  expect(raced).toBe(true);
  expect(result).toMatchObject({ ok: true });
  expect(wakes).toBe(1);
  expect((await store.get("s-1"))?.value.supervision).toMatchObject({ kind: "launching", phase: "reserved" });
}, 5000);

it("a confirmed crash gets one durable restart across a supervisor crash", async () => {
  const f = fixture();
  await handleSessionOperation(f.operation, f.ports, { wake: async () => {} });
  let now = 1000, launches = 0, crashReply = true;
  const liveOwners = new Set<string>(), saved = new Map<string, import("../contracts").Outcome<import("@spider/db-core/roam/types").HubOperationReadiness>>();
  const calls: Array<{ id: string; mode: string }> = [];
  const create = () => createParticipantSupervisor({ root: f.global.root, agent: f.ports,
    clock: { now: () => now, later: () => () => {} }, events: { subscribe: () => () => {} },
    owner: async () => liveOwners.size ? { kind: "live", identity: { bootId: "boot-1", pid: 123, startTime: [...liveOwners][0] } } : { kind: "absent" },
    diagnostics: async () => [], stop: async () => ({ kind: "absent" }), notify: async () => {},
    async launch(intent, operationId, mode) {
      calls.push({ id: operationId, mode });
      const prior = saved.get(operationId);
      if (prior) return liveOwners.has(operationId) ? prior : { ...prior, code: 1, reason: "adopted-exited", value: null };
      launches++; liveOwners.add(operationId);
      const result = { code: 0 as const, reason: "ready", operationId, epoch: intent.epoch, home: null, repairCommand: null,
        value: { origin: "hub-operation" as const, opId: operationId, sessionId: intent.sessionId, epoch: intent.epoch, file: intent.file,
          cwd: intent.cwd, core: "core-1", terminal: `terminal-${launches}` } };
      saved.set(operationId, result);
      if (launches === 2 && crashReply) { crashReply = false; throw new Error("supervisor stopped before saving readiness"); }
      return result;
    },
  });
  let supervisor = create();
  try {
    await supervisor.reconcile(); expect(launches).toBe(1);
    const initialId = calls[0].id; liveOwners.clear();
    await supervisor.reconcile(); now += 5000;
    await supervisor.reconcile();
    expect(launches).toBe(2);
    const pending = await createIntentStore(f.global.root).get("s-1");
    expect(pending?.value.supervision.kind).toBe("launching");
    const restartId = calls.at(-1)!.id;
    expect(restartId).not.toBe(initialId);
    await supervisor.stop(); supervisor = create();
    await supervisor.reconcile(); await supervisor.reconcile();
    expect(calls.at(-1)).toEqual({ id: restartId, mode: "reconcile" });
    expect(launches).toBe(2);
    expect([...liveOwners]).toEqual([restartId]);
    expect((await createIntentStore(f.global.root).get("s-1"))?.value.supervision.kind).toBe("live");
  } finally { await supervisor.stop(); }
}, 5000);

it("retire-only durably stops every local session through the bounded stop port", async () => {
  const f = fixture();
  await handleSessionOperation(f.operation, f.ports, { wake: async () => {} });
  const stopped: string[] = [];
  await participantSupervisor.retireParticipantSessions(f.ports, async id => { stopped.push(id); return { kind: "absent" }; });
  expect(stopped).toEqual(["s-1"]);
  expect(await createRunningIntentAuthority(f.global.db).get("s-1")).toMatchObject({ desired: "stopped" });
  expect(f.worktree.db.prepare("SELECT state FROM roam_sessions WHERE session_id='s-1'").get()).toEqual({ state: "retired" });
}, 5000);

it("an enabled production box launches and restarts a reserved session without dialing the hub", async () => {
  const f = fixture(), agentDir = join(f.global.root, "agent");
  mkdirSync(agentDir, { mode: 0o700 }); writeFileSync(join(agentDir, "auth.json"), '{"fixture":{}}', { mode: 0o600 });
  await handleSessionOperation(f.operation, f.ports, { wake: async () => {} });
  await f.global.db.raw.backup(join(f.global.root, "spider.db"));
  vi.stubEnv("SPIDER_ROAM_PI", "/fixture/pi");
  vi.spyOn(runtimeModule, "openLocalRuntime").mockReturnValue({ config: f.ports.config, db: f.global.db, journal: f.ports.journal, agent: f.ports, close() {} } as never);
  vi.spyOn(hubModule, "loadHerdrConfig").mockReturnValue({ agentDirectory: agentDir, core: { binary: "/fixture/hc" } } as never);
  vi.spyOn(hcModule, "createHcClient").mockReturnValue({ async identity() { return { coreId: "core-1", sessionNamespace: "fixture", socket: "/fixture/socket" }; },
    events() { return { subscribe() { return () => {}; }, dispose() {} }; }, async dispose() {} } as never);
  vi.spyOn(launcherModule, "createProductionLocalExactHc").mockReturnValue({ async coreId() { return "core-1"; }, async dispose() {} } as never);
  let now = 100, launches = 0, lock: Awaited<ReturnType<typeof claimIdLock>> | undefined;
  const identity = { pid: 987, startIdentity: "session-start" }, probe = async () => ({ kind: "live" as const, startIdentity: identity.startIdentity });
  vi.spyOn(launcherModule, "createExactLaunchAdapter").mockImplementation(() => ({ async launch(request: { operationId: string; sessionId: string; epoch: number; file: string; cwd: string }) {
    launches++;
    lock = await claimIdLock(join(f.global.root, "herdr"), "s-1", identity, probe, { bootId: async () => "boot-1" });
    f.ports.journal.begin({ id: request.operationId, kind: "exact-session-launch", machineId: BOX, expectedEpoch: 2, args: {} });
    recordReadiness(f.ports.journal, { origin: "hub-operation", opId: request.operationId, sessionId: request.sessionId, epoch: request.epoch, file: request.file, cwd: request.cwd, core: "core-1", terminal: `term-${launches}` });
    return {};
  } }) as never);
  const original = participantSupervisor.createParticipantSupervisor;
  let supervisor!: ReturnType<typeof original>;
  vi.spyOn(participantSupervisor, "createParticipantSupervisor").mockImplementation(input => supervisor = original(input));
  const service = await startProductionSupervisor(f.global.root, { system: { bootId: async () => "boot-1", inventory: { probe } } as never,
    clock: { now: () => now, later: () => () => {} } });
  try {
    await supervisor.reconcile(); expect(launches).toBe(1);
    expect((await createIntentStore(f.global.root).get("s-1"))?.value.supervision.kind).toBe("live");
    await lock!.release(); lock = undefined;
    await supervisor.reconcile(); now += 5000;
    await supervisor.reconcile(); expect(launches).toBe(2);
    expect((await createIntentStore(f.global.root).get("s-1"))?.value.supervision.kind).toBe("live");
  } finally { await service.stop(); await lock?.release(); vi.unstubAllEnvs(); }
}, 5000);

it.each([false, true])("production connection preserves ordinary hosting without contacting a hub when enabled=%s", async enabled => {
  const { createProductionSupervisorConnection } = await import("../production-supervisor");
  const f = fixture(enabled);
  let requests = 0;
  const connection = createProductionSupervisorConnection({ root: f.global.root, config: f.ports.config, globalDb: f.global.db,
    transport: { resolve: async () => { requests++; throw new Error("must not contact hub"); } } as never, stopSessions: async () => {} });
  expect(await connection.handshake()).toEqual({ kind: "accepted", machineId: BOX, reason: "ok" });
  expect(requests).toBe(0);
}, 5000);

it("retire-only durably stops a never-homed local session as well as homed sessions", async () => {
  const f = fixture(true, false), stopped: string[] = [];
  await participantSupervisor.retireParticipantSessions(f.ports, async id => { stopped.push(id); return { kind: "absent" }; });
  expect(stopped).toEqual(["s-1"]);
  expect(await createRunningIntentAuthority(f.global.db).get("s-1")).toMatchObject({ desired: "stopped", epoch: 2 });
}, 5000);

it.each(["restart", "foreign"] as const)("box wake reports only a proved live launch for the current intent: %s", async mode => {
  const { createBoxParticipantWake } = await import("../participant-runtime"), f = fixture();
  await handleSessionOperation(f.operation, f.ports, { wake: async () => {} });
  const authority = createRunningIntentAuthority(f.global.db), intent = (await authority.get("s-1"))!;
  const base = participantLaunchId(BOX, "s-1", 2, f.operation.id), launchId = mode === "restart" ? `${base}-restart-1` : "foreign-launch";
  f.ports.journal.begin({ id: `${base}-restarts`, kind: "participant-restarts", machineId: BOX, expectedEpoch: 2,
    args: { sessionId: "s-1", operationId: f.operation.id, file: intent.file, cwd: intent.cwd, moveId: intent.moveId } });
  f.ports.journal.record(`${base}-restarts`, "restart", { sequence: 1, previousLaunchId: base });
  const store = createIntentStore(f.global.root);
  await store.update("s-1", null, { intent, failures: [], supervision: { kind: "live", identity: { bootId: "boot-a", pid: 43, startTime: "adopted" }, stableSince: 1 } });
  const root = join(f.global.root, "herdr"), probe = async () => ({ kind: "live" as const, startIdentity: "launcher" });
  const owner = await claimIdLock(root, "s-1", { pid: 42, startIdentity: "launcher" }, probe, { bootId: async () => "boot-a" });
  const handoff = await owner.prepareHandoff(launchId, intent.file, "core-a");
  const adopted = await claimIdLock(root, "s-1", { pid: 43, startIdentity: "adopted" }, probe, { bootId: async () => "boot-a", handoff: { ...handoff, file: intent.file } });
  try {
    const wake = createBoxParticipantWake({ root: f.global.root, db: f.global.db, config: f.ports.config, journal: f.ports.journal, wake: async () => {} });
    expect(await wake({ sessionId: "s-1", operationId: f.operation.id })).toEqual(mode === "restart" ? { ok: true, launchId } : { ok: false, reason: "participant-launch-conflict" });
  } finally { await adopted.release(); }
}, 5000);


it("reports a corrupt restart journal even when crash history cannot advance", async () => {
  const f = fixture(); await handleSessionOperation(f.operation, f.ports, { wake: async () => {} });
  const intent = (await createRunningIntentAuthority(f.global.db).get("s-1"))!;
  const launchId = participantLaunchId(BOX, "s-1", 2, f.operation.id), id = `${launchId}-restarts`;
  f.ports.journal.begin({ id, kind: "participant-restarts", machineId: BOX, expectedEpoch: 2,
    args: { sessionId: "s-1", operationId: f.operation.id, file: intent.file, cwd: intent.cwd, moveId: intent.moveId } });
  f.ports.journal.record(id, "restart", { sequence: 2 });
  const intents = createIntentStore(f.global.root);
  const state = { intent, failures: [], supervision: { kind: "live" as const, identity: { bootId: "boot", pid: 9, startTime: "start" }, stableSince: 1 } };
  await intents.update("s-1", null, state);
  let launches = 0;
  const supervisor = createParticipantSupervisor({ root: f.global.root, agent: f.ports,
    clock: { now: () => 100, later: () => () => {} }, events: { subscribe: () => () => {} }, owner: async () => ({ kind: "absent" }),
    diagnostics: async () => [], stop: async () => ({ kind: "absent" }), notify: async () => {}, async launch() { launches++; throw new Error("must not launch"); } });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    for (let pass = 0; pass < 5; pass++) await supervisor.reconcile();
    expect(readLocal(f.global.db, "supervisor-hosting-error", "s-1")).toEqual({ code: "supervisor-hosting-error", check: "restart", since: 100, count: 3 });
    expect((await intents.get("s-1"))?.value).toEqual(state);
    expect(launches).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
  } finally { await supervisor.stop(); log.mockRestore(); }
});


it("reports exact doctor blockers and resumes a stopped origin without prior hub intent", async () => {
  const f = fixture(), authority = createRunningIntentAuthority(f.global.db);
  f.worktree.db.prepare("UPDATE roam_sessions SET state='active' WHERE session_id='s-1'").run();
  const location = f.global.db.prepare("SELECT file,cwd FROM roam_locations WHERE session_id='s-1'").get() as { file: string; cwd: string };
  const origin = { kind: "box-local", machineId: BOX, epoch: 2, ...location, pid: 123, startIdentity: "previous-owner", stopped: true };
  writeLocal(f.global.db, "participant-origin", "s-1", origin);
  const diagnostic = { severity: "block" as const, reason: "global: roaming capture is not initialized.", repairCommand: "spider roam doctor" };
  const doctor = vi.spyOn(localDiagnostics, "runLocalDoctor").mockResolvedValue({ enabled: true, diagnostics: [diagnostic], consumers: [] });
  const operation = { ...f.operation, id: "resume-origin", kind: "session-resume" }; let wakes = 0;
  expect(await handleSessionOperation(operation, f.ports, { wake: async () => { wakes++; } })).toMatchObject({ code: 1, reason: "participant-doctor-refused",
    repairCommand: `spider roam doctor ${BOX}`, value: { diagnostics: [diagnostic] } });
  expect(await authority.get("s-1")).toBeNull(); expect(wakes).toBe(0);
  doctor.mockResolvedValue({ enabled: true, diagnostics: [], consumers: [] });
  expect(await handleSessionOperation(operation, f.ports, { wake: async () => { wakes++; } })).toMatchObject({ code: 0, reason: "resumed-intent" });
  expect(await authority.get("s-1")).toMatchObject({ desired: "running", file: location.file, epoch: 2 });
  expect(readLocal(f.global.db, "participant-origin", "s-1")).toEqual(origin); expect(wakes).toBe(1);
}, 5000);


it("retains resume diagnostics through hub control routing", async () => {
  const f = fixture(), diagnostic = { severity: "block" as const, reason: "global: roaming capture is not initialized.", repairCommand: "spider roam doctor" };
  vi.spyOn(localDiagnostics, "runLocalDoctor").mockResolvedValue({ enabled: true, diagnostics: [diagnostic], consumers: [] });
  const peer = { machineId: BOX, alias: "box-1.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/core", globalRoot: "/fixture/state" };
  const config = { ...f.ports.config, role: "hub" as const, machineId: HUB, peers: [peer] };
  const transport = { async resolve() { return peer; }, async exec(_peer: unknown, argv: readonly string[]) {
    const result = await handleSessionOperation(JSON.parse(argv[2]), f.ports, { wake: async () => { throw new Error("must not wake"); } });
    return Buffer.from(JSON.stringify(result));
  } };
  const handler = createMoveControlHandler({ config, globalDb: f.global.db, journal: f.ports.journal, transport: transport as never, ports: {} as never });
  const result = await handler({ op: "resume", session: "s-1" });
  expect(result).toMatchObject({ code: 1, reason: "participant-doctor-refused", value: { diagnostics: [diagnostic] } });
  const safe = safeControlOutcome({ ...result, operationId: result.operationId ?? "", home: result.home ?? null, epoch: result.epoch ?? null, repairCommand: result.repairCommand ?? null });
  expect(controlText(safe)).toContain(diagnostic.reason); expect(controlText(safe)).toContain(`spider roam doctor ${BOX}`);
}, 5000);
