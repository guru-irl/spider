import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { recordLocation } from "@spider/db-core/roam/catalog";
import { claimIdLock, inspectIdLock } from "@spider/herdr/sessions/id-lock";
import { createSessionLeases, type ProcessProbe } from "@spider/herdr/sessions/lease";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { launchHandoffPath, writeLaunchHandoff } from "@spider/herdr/sessions/launch-handoff";
import { access } from "node:fs/promises";
import { DEFAULT_LIMITS, disabledIntercom } from "../contracts";
import { openJournal } from "../journal";
import { createIntentStore } from "../intent";
import { createRunningIntentAuthority } from "../session-control";
import { handleSessionOperation } from "../participant-runtime";
import { createParticipantSupervisor } from "../participant-supervisor";
import { runLocalDoctor } from "../local-diagnostics";
import type { LocalExactHc } from "../launcher";
import * as launcherModule from "../launcher";
import * as localDiagnostics from "../local-diagnostics";
import { participantLaunchId } from "../participant-launch";
import { enrollFixtureCore } from "./supervisor-core-fixture";

const BOX = "00000000-0000-4000-8000-000000000002", HUB = "00000000-0000-4000-8000-000000000001";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); vi.restoreAllMocks(); });
async function fixture(launchId = "launch-1") {
  const global = createReplica("global", BOX), worktree = createReplica("worktree", BOX); fixtures.push(global, worktree);
  const root = global.root, stateRoot = join(root, "herdr"), file = join(worktree.root, "session.jsonl");
  const config = { enabled: false, role: "box" as const, machineId: BOX, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture.service", syncMs: 120000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  mkdirSync(join(root, "roam"), { mode: 0o700 });
  writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId: BOX }), { mode: 0o600 });
  writeFileSync(join(root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
  enrollFixtureCore(root, "core-1");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: worktree.root }) + "\n", { mode: 0o600 });
  global.db.prepare("UPDATE roam_meta SET capture_enabled=1 WHERE id=1").run();
  global.db.prepare("INSERT INTO session_homes VALUES (?,?,1,NULL,1)").run("session-1", BOX);
  worktree.db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES (?,1,?)").run("session-1", BOX);
  worktree.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,1,'active')").run("session-1");
  worktree.db.prepare("UPDATE roam_meta SET capture_enabled=1 WHERE id=1").run();
  recordLocation(global.db, { sessionId: "session-1", stores: [worktree.storeKey], home: null, file, cwd: worktree.root });
  const journal = openJournal(join(root, "roam", "journal.db")), authority = createRunningIntentAuthority(global.db), intents = createIntentStore(root);
  const intent = { sessionId: "session-1", epoch: 1, desired: "running" as const, suspended: null, file, cwd: worktree.root, moveId: null };
  await authority.set(intent, "resume-1", { kind: "box-participant", machineId: BOX, hubMachineId: HUB });
  await authority.stop("session-1");
  await intents.update("session-1", null, { intent, failures: [], supervision: { kind: "launching", phase: "invoking", operationId: launchId } });
  const parent = { pid: 201, startIdentity: "previous-supervisor" };
  const leases = createSessionLeases(stateRoot), inventory = { leases, presence: createProcessPresence(stateRoot), processes: async () => [], probe: async (): Promise<ProcessProbe> => ({ kind: "live", startIdentity: parent.startIdentity }) };
  const lock = await claimIdLock(stateRoot, "session-1", parent, inventory.probe, { bootId: async () => "boot-1" });
  const lease = await leases.claim(file, parent, inventory, { mode: "cutover", bootId: "boot-1" });
  const handoff = await lock.prepareHandoff(launchId, file, "core-1");
  await writeLaunchHandoff(stateRoot, { version: 1, operationId: launchId, sessionId: "session-1", sessionFile: file, nonce: handoff.nonce, leaseToken: lease.token });
  journal.begin({ id: launchId, kind: "exact-session-launch", machineId: BOX, expectedEpoch: 1, args: { sessionId: "session-1" } });
  journal.record(launchId, "exact-attempt", { attemptId: "attempt-1" });
  journal.record(launchId, "exact-core", { coreId: "core-1" });
  journal.record(launchId, "exact-hc-started", { pid: 301, startTime: "hc-start", bootId: "boot-1" });
  journal.record(launchId, "exact-hc-exited", { pid: 301, exitedAt: 50 });
  journal.record(launchId, "exact-terminal", { terminalId: "terminal-1" });
  let terminal: "live" | "finished" | "unknown" = "finished", process: ProcessProbe = { kind: "absent" }, boot = "boot-1", now = 100, spawns = 0;
  const hc: LocalExactHc = { coreId: async () => "core-1", async terminals(id, options) {
    expect(id).toBe(launchId); expect(options.attemptId).toBe("attempt-1"); expect(options.terminalId).toBe("terminal-1");
    if (terminal === "unknown") throw new Error("terminal-unavailable");
    return { complete: true, terminals: [{ id: "terminal-1", state: terminal }] };
  }, async run() { spawns++; throw new Error("repair must never spawn"); } };
  const recovery = { bootId: async () => boot, probe: async () => process, hc, clock: { now: () => now, wait: async (ms: number) => { now += ms; } } };
  const ports = { config, root: join(root, "roam", "staging"), journal, openStore(key: string) { return { db: key === "global" ? global.db : worktree.db, effects: {} as never, policy: {} as never }; } };
  const operation = { id: "stop-1", kind: "session-stop", machineId: BOX, expectedEpoch: 1, args: { sourceMachine: HUB, sessionId: "session-1" } };
  return { root, stateRoot, file, global, ports, operation, authority, intents, leases, hc, recovery, handoff, lock,
    terminal(value: typeof terminal) { terminal = value; }, process(value: ProcessProbe) { process = value; }, boot(value: string) { boot = value; }, spawns: () => spawns };
}

it("stop settles a disabled stopped participant's exited exact launch without relaunching", async () => {
  const f = await fixture();
  const before = await inspectIdLock(f.stateRoot, "session-1");
  expect(before).toMatchObject({ operationId: null, pendingOperationId: "launch-1", pendingCoreId: "core-1" });
  let launches = 0;
  const supervisor = createParticipantSupervisor({ root: f.root, agent: f.ports, clock: { now: () => 100, later: () => () => {} }, events: { subscribe: () => () => {} },
    owner: async () => ({ kind: "absent" }), diagnostics: async () => [], stop: async () => ({ kind: "absent" }), notify: async () => {}, async launch() { launches++; throw new Error("stopped session cannot launch"); } });
  await supervisor.reconcile();
  expect(launches).toBe(0);
  expect(await inspectIdLock(f.stateRoot, "session-1")).toEqual(before);
  expect(await handleSessionOperation(f.operation, f.ports, { wake: async () => {}, launchRecovery: f.recovery })).toMatchObject({ code: 0, reason: "stopped-intent" });
  expect(await inspectIdLock(f.stateRoot, "session-1")).toBeNull();
  expect(await f.leases.get(f.file)).toBeNull();
  await expect(access(launchHandoffPath(f.stateRoot, "launch-1"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await f.intents.get("session-1"))?.value).toMatchObject({ intent: { desired: "stopped" }, supervision: { kind: "idle" } });
  expect((await f.authority.get("session-1"))?.desired).toBe("stopped");
  await supervisor.reconcile();
  expect(launches).toBe(0);
  await f.global.db.raw.backup(join(f.root, "spider.db"));
  const report = await runLocalDoctor({ root: f.root, currentCore: async () => "core-1", launchRecovery: f.recovery });
  expect(report.diagnostics.filter(row => /exact launch.*pending/i.test(row.reason))).toEqual([]);
  expect(f.spawns()).toBe(0);
  expect(f.ports.journal.lookupOperation("launch-1")).toEqual({ machineId: BOX, state: "done" });
  expect(await handleSessionOperation({ ...f.operation, id: "stop-2" }, f.ports, { wake: async () => {}, launchRecovery: f.recovery })).toMatchObject({ code: 0 });
});

it.each(["live-owner", "live-terminal", "unknown-terminal", "unknown-process", "missing-boot", "redirected-file", "lease-changed", "ready-durable"] as const)("stop preserves an unsafe pending launch: %s", async state => {
  const f = await fixture();
  if (state === "live-owner") f.process({ kind: "live", startIdentity: "previous-supervisor" });
  if (state === "live-terminal") f.terminal("live");
  if (state === "unknown-terminal") f.terminal("unknown");
  if (state === "unknown-process") f.process({ kind: "unknown" });
  if (state === "missing-boot") f.boot("");
  if (state === "redirected-file") { renameSync(f.file, `${f.file}.old`); symlinkSync(`${f.file}.old`, f.file); }
  if (state === "lease-changed") { const lease = (await f.leases.get(f.file))!; await f.leases.transfer(f.file, lease.token, { pid: 202, startIdentity: "other-child" }); }
  if (state === "ready-durable") f.ports.journal.record("launch-1", "ready-durable", { sessionId: "session-1" });
  const before = await inspectIdLock(f.stateRoot, "session-1"), lease = await f.leases.get(f.file);
  expect(await handleSessionOperation(f.operation, f.ports, { wake: async () => {}, launchRecovery: f.recovery })).toMatchObject({ code: 3, reason: "launch-reconciliation-required", repairCommand: `spider roam doctor ${BOX}` });
  expect(await inspectIdLock(f.stateRoot, "session-1")).toEqual(before);
  expect(await f.leases.get(f.file)).toEqual(lease);
  expect(f.spawns()).toBe(0);
});

it("resume after a stop repair launches one new journaled successor", async () => {
  const launchId = participantLaunchId(BOX, "session-1", 1, "resume-1"), f = await fixture(launchId), options = { wake: async () => {}, launchRecovery: f.recovery };
  expect(await handleSessionOperation(f.operation, f.ports, options)).toMatchObject({ code: 0 });
  vi.spyOn(localDiagnostics, "runLocalDoctor").mockResolvedValue({ enabled: false, diagnostics: [], consumers: [] });
  expect(await handleSessionOperation({ ...f.operation, id: "resume-2", kind: "session-resume" }, f.ports, options)).toMatchObject({ code: 0, reason: "resumed-intent" });
  const launches: string[] = [], begins: string[] = [];
  let live = false;
  const supervisor = createParticipantSupervisor({ root: f.root, agent: f.ports, clock: { now: () => 100, later: () => () => {} }, events: { subscribe: () => () => {} },
    owner: async () => live ? { kind: "live", identity: { pid: 202, startTime: "new-child", bootId: "boot-1" } } : { kind: "absent" }, diagnostics: async () => [],
    stop: async () => ({ kind: "absent" }), notify: async () => {}, async launch(intent, operationId) {
      launches.push(operationId);
      const begun = f.ports.journal.begin({ id: operationId, kind: "exact-session-launch", machineId: BOX, expectedEpoch: 1, args: { sessionId: "session-1" } });
      begins.push(begun.kind);
      if (begun.kind !== "new") throw new Error("completed launch ID reused");
      live = true;
      const ready = { origin: "hub-operation" as const, opId: operationId, sessionId: intent.sessionId, epoch: intent.epoch, file: intent.file, cwd: intent.cwd, core: "core-1", terminal: "terminal-2" };
      f.ports.journal.record(operationId, "ready-durable", ready);
      return { code: 0, reason: "ready", operationId, home: null, epoch: intent.epoch, repairCommand: null, value: ready };
    } });
  await supervisor.reconcile(); await supervisor.reconcile();
  expect(launches).toEqual([`${launchId}-restart-1`]);
  expect(begins).toEqual(["new"]);
  expect((await f.intents.get("session-1"))?.value.supervision.kind).toBe("live");
});

it("stop refuses to declare an invoking reservation settled when its ID lock is missing", async () => {
  const f = await fixture(); await f.lock.cancelHandoff("launch-1");
  const options = { wake: async () => {}, launchRecovery: f.recovery };
  expect(await handleSessionOperation(f.operation, f.ports, options)).toMatchObject({ code: 3, reason: "launch-reconciliation-required", repairCommand: `spider roam doctor ${BOX}` });
  expect((await f.intents.get("session-1"))?.value.supervision.kind).toBe("launching");
  expect(await f.leases.get(f.file)).not.toBeNull();
  expect(f.spawns()).toBe(0);
});

it.each(["matches", "changed", "unavailable", "pin-changed"] as const)("production stop checks the pinned core when its identity %s", async state => {
  const f = await fixture();
  const dispose = vi.fn(async () => {});
  const factory = vi.spyOn(launcherModule, "createProductionLocalExactHc").mockReturnValue({ ...f.hc, dispose, async coreId() {
    if (state === "unavailable") throw new Error("core-unavailable");
    if (state === "pin-changed") {
      const file = join(f.root, "roam", "core.json"), pin = JSON.parse(readFileSync(file, "utf8"));
      writeFileSync(file, JSON.stringify({ ...pin, socket: join(f.root, "other-core.sock") }), { mode: 0o600 });
    }
    return state === "changed" ? "other-core" : "core-1";
  } });
  const result = await handleSessionOperation(f.operation, f.ports, { wake: async () => {}, launchRecovery: { bootId: f.recovery.bootId, probe: f.recovery.probe, clock: f.recovery.clock } });
  expect(result).toMatchObject(state === "matches" ? { code: 0, reason: "stopped-intent" } : { code: 3, reason: "launch-reconciliation-required" });
  expect(factory.mock.calls[0][0]).toMatchObject({ binary: join(f.root, "hc"), env: { HC_SESSION: "fixture", HC_SOCKET: join(f.root, "core.sock") } });
  expect(await inspectIdLock(f.stateRoot, "session-1")).toEqual(state === "matches" ? null : expect.objectContaining({ pendingOperationId: "launch-1" }));
  expect(dispose).toHaveBeenCalledOnce();
  expect(f.spawns()).toBe(0);
});

it.each(["exact-launch-settled", "done", "done-reply-lost"])("stop repairs an interrupted %s journal step", async action => {
  const f = await fixture(), record = f.ports.journal.record;
  let crash = true;
  f.ports.journal.record = (id, step, value) => {
    if (id === "launch-1" && step === (action === "done-reply-lost" ? "done" : action) && crash) {
      crash = false;
      if (action === "done-reply-lost") record(id, step, value);
      throw new Error("interrupted cleanup");
    }
    return record(id, step, value);
  };
  const options = { wake: async () => {}, launchRecovery: f.recovery };
  expect(await handleSessionOperation(f.operation, f.ports, options)).toMatchObject({ code: 3, reason: "launch-reconciliation-required" });
  expect((await inspectIdLock(f.stateRoot, "session-1"))?.pendingOperationId).toBe("launch-1");
  expect(await handleSessionOperation(f.operation, f.ports, options)).toMatchObject({ code: 0, reason: "stopped-intent" });
  expect(await inspectIdLock(f.stateRoot, "session-1")).toBeNull();
  expect(await f.leases.get(f.file)).toBeNull();
  expect(f.ports.journal.lookupOperation("launch-1")).toEqual({ machineId: BOX, state: "done" });
  expect(f.spawns()).toBe(0);
});

it("stop repeats one committed restart proof after a lost reply", async () => {
  const f = await fixture(), record = f.ports.journal.record;
  let crash = true;
  f.ports.journal.record = (id, step, value) => {
    record(id, step, value);
    if (step === "restart" && crash) { crash = false; throw new Error("lost restart reply"); }
  };
  const options = { wake: async () => {}, launchRecovery: f.recovery };
  await expect(handleSessionOperation(f.operation, f.ports, options)).rejects.toThrow("lost restart reply");
  expect(await inspectIdLock(f.stateRoot, "session-1")).toBeNull();
  expect((await f.intents.get("session-1"))?.value.supervision.kind).toBe("launching");
  expect(await handleSessionOperation(f.operation, f.ports, options)).toMatchObject({ code: 0, reason: "stopped-intent" });
  const history = `${participantLaunchId(BOX, "session-1", 1, "resume-1")}-restarts`;
  expect(f.ports.journal.read(history).filter(row => row.action === "restart")).toHaveLength(1);
  expect((await f.intents.get("session-1"))?.value.supervision.kind).toBe("idle");
  expect(f.spawns()).toBe(0);
});

it("disabled doctor reports the same pending-launch block that enable must refuse", async () => {
  const f = await fixture();
  await f.global.db.raw.backup(join(f.root, "spider.db"));
  const report = await runLocalDoctor({ root: f.root, currentCore: async () => "core-1", launchRecovery: f.recovery });
  expect(report.enabled).toBe(false);
  expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "block", reason: expect.stringMatching(/session-1.*launch-1.*pending/i), repairCommand: "spider roam stop session-1" })]));
  expect(JSON.stringify(report)).not.toContain(f.handoff.nonce);
});
