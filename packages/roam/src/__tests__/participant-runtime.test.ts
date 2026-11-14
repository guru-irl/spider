import { afterEach, expect, it, vi } from "vitest";
import { handleAgentOperation } from "../agent";
import { startProductionSupervisor } from "../production-supervisor";
import * as productionSupervisor from "../production-supervisor";
import { readLocalIdentity } from "../runtime";
import * as runtimeModule from "../runtime";
import * as hubModule from "../production-hub";
import * as localDiagnostics from "../local-diagnostics";
import * as hcModule from "@spider/herdr/client/hc";
import { claimIdLock } from "@spider/herdr/sessions/id-lock";
import { createParticipantSupervisor } from "../participant-supervisor";
import { recordReadiness } from "../session-control";
import { writeLocal } from "@spider/db-core/roam/local-state";
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { recordLocation } from "@spider/db-core/roam/catalog";
import { DEFAULT_LIMITS } from "../contracts";
import { openJournal } from "../journal";
import { handleSessionOperation } from "../participant-runtime";
import { createRunningIntentAuthority } from "../session-control";

const BOX = "00000000-0000-4000-8000-000000000002", HUB = "00000000-0000-4000-8000-000000000001";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); vi.restoreAllMocks(); });
function fixture(enabled = true) {
  const global = createReplica("global", BOX), worktree = createReplica("worktree", BOX); fixtures.push(global, worktree);
  const config = { enabled, role: "box" as const, machineId: BOX, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture.service", syncMs: 120000, limits: DEFAULT_LIMITS };
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  writeFileSync(join(global.root, "roam", "machine.json"), JSON.stringify({ machineId: BOX }), { mode: 0o600 });
  writeFileSync(join(global.root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
  const file = join(worktree.root, "s.jsonl"); writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "s-1", cwd: worktree.root }) + "\n", { mode: 0o600 });
  global.db.prepare("UPDATE roam_meta SET capture_enabled=1 WHERE id=1").run();
  global.db.prepare("INSERT INTO session_homes VALUES (?,?,2,?,1)").run("s-1", BOX, "move-1");
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
it("retrying activation cannot erase a later durable stop", async () => {
  const f = fixture(), authority = createRunningIntentAuthority(f.global.db), location = f.global.db.prepare("SELECT file,cwd FROM roam_locations WHERE session_id='s-1'").get() as { file: string; cwd: string };
  await authority.set({ sessionId: "s-1", epoch: 2, desired: "running", suspended: null, ...location, moveId: "move-1" }, f.operation.id);
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

it("uninitialized production capture keeps an enrolled service inert", async () => {
  const f = fixture(), file = join(f.global.root, "roam", "config.json"), config = readLocalIdentity(f.global.root);
  writeFileSync(file, JSON.stringify({ ...config, enabled: false }), { mode: 0o600 });
  const service = await startProductionSupervisor(f.global.root, { system: { bootId: async () => { throw new Error("must not probe"); } } as never });
  await service.stop();
  expect(f.worktree.db.prepare("SELECT state FROM roam_sessions").get()).toEqual({ state: "retired" });
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

it("hub readiness is advertised only for the matching live launch owner", async () => {
  const f = fixture(), location = f.global.db.prepare("SELECT file,cwd FROM roam_locations WHERE session_id='s-1'").get() as { file: string; cwd: string };
  const authority = createRunningIntentAuthority(f.global.db);
  await authority.set({ sessionId: "s-1", epoch: 2, desired: "running", suspended: null, ...location, moveId: "move-1" }, "start-1", { machineId: BOX, hubMachineId: HUB });
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
  await createRunningIntentAuthority(f.global.db).set({ sessionId: "s-1", epoch: 2, desired: "running", suspended: null, ...location, moveId: "move-1" }, "unproved-intent");
  await supervisor.reconcile(); expect(launches).toBe(0); await supervisor.stop();
}, 5000);

it("resume reports a blocking doctor and leaves the stopped intent unchanged", async () => {
  const f = fixture(false), authority = createRunningIntentAuthority(f.global.db), location = f.global.db.prepare("SELECT file,cwd FROM roam_locations WHERE session_id='s-1'").get() as { file: string; cwd: string };
  await authority.set({ sessionId: "s-1", epoch: 2, desired: "stopped", suspended: null, ...location, moveId: "move-1" }, "stop-1", { machineId: BOX, hubMachineId: HUB });
  const doctor = vi.spyOn(localDiagnostics, "runLocalDoctor").mockResolvedValue({ enabled: false, diagnostics: [{ severity: "block", reason: "fixture prerequisite", repairCommand: null }], consumers: [] });
  const result = await handleAgentOperation({ ...f.operation, id: "resume-1", kind: "session-resume" }, f.ports);
  expect(result).toMatchObject({ code: 1, reason: "participant-doctor-refused" });
  expect(await authority.get("s-1")).toMatchObject({ desired: "stopped", epoch: 2 });
  expect(doctor).toHaveBeenCalledOnce();
}, 5000);

it("resume refuses an unavailable doctor and can retry after it succeeds", async () => {
  const f = fixture(false), authority = createRunningIntentAuthority(f.global.db), location = f.global.db.prepare("SELECT file,cwd FROM roam_locations WHERE session_id='s-1'").get() as { file: string; cwd: string };
  await authority.set({ sessionId: "s-1", epoch: 2, desired: "stopped", suspended: null, ...location, moveId: "move-1" }, "stop-1", { machineId: BOX, hubMachineId: HUB });
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
  await authority.set({ sessionId: "s-1", epoch: 1, desired, suspended: null, ...location, moveId: null }, "old-op", { machineId: BOX, hubMachineId: HUB });
  const doctor = vi.spyOn(localDiagnostics, "runLocalDoctor").mockResolvedValue({ enabled: false, diagnostics: [], consumers: [] });
  let wakes = 0;
  expect(await handleSessionOperation({ ...f.operation, id: `${kind}-2`, kind }, f.ports, { wake: async () => { wakes++; } })).toMatchObject({ code: 1, reason: "participant-intent-home-mismatch" });
  expect(await authority.get("s-1")).toMatchObject({ desired, epoch: 1 });
  expect(wakes).toBe(0); expect(doctor).not.toHaveBeenCalled();
}, 5000);

it("a non-box machine with an intent refuses before effects", async () => {
  const f = fixture(false), authority = createRunningIntentAuthority(f.global.db), location = f.global.db.prepare("SELECT file,cwd FROM roam_locations WHERE session_id='s-1'").get() as { file: string; cwd: string };
  await authority.set({ sessionId: "s-1", epoch: 2, desired: "running", suspended: null, ...location, moveId: "move-1" }, f.operation.id, { machineId: BOX, hubMachineId: HUB });
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
