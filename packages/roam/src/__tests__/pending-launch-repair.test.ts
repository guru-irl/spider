import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { openDb } from "@spider/db-core";
import { recordLocation } from "@spider/db-core/roam/catalog";
import { writeLocal } from "@spider/db-core/roam/local-state";
import { claimIdLock, inspectIdLock } from "@spider/herdr/sessions/id-lock";
import { createSessionLeases, type ProcessProbe } from "@spider/herdr/sessions/lease";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { launchHandoffPath, writeLaunchHandoff } from "@spider/herdr/sessions/launch-handoff";
import { access } from "node:fs/promises";
import { DEFAULT_LIMITS, disabledIntercom } from "../contracts";
import { openJournal } from "../journal";
import { createIntentStore } from "../intent";
import * as intentModule from "../intent";
import { createRunningIntentAuthority } from "../session-control";
import { handleSessionOperation } from "../participant-runtime";
import { handleAgentOperation } from "../agent";
import { createParticipantSupervisor } from "../participant-supervisor";
import { createDurableLaunchPort } from "../supervisor";
import { runLocalDoctor } from "../local-diagnostics";
import { createLocalExactHc, type LocalExactHc } from "../launcher";
import * as launcherModule from "../launcher";
import * as localDiagnostics from "../local-diagnostics";
import { participantLaunchId } from "../participant-launch";
import { enrollFixtureCore } from "./supervisor-core-fixture";
import * as participantSupervisor from "../participant-supervisor";
import * as productionSupervisor from "../production-supervisor";
import * as runtimeModule from "../runtime";
import * as productionHub from "../production-hub";
import * as hcModule from "@spider/herdr/client/hc";
import * as cliTransport from "@spider/herdr/client/cli-transport";
import * as transportModule from "../transport";
import { main } from "../cli";
import { pathToFileURL, fileURLToPath } from "node:url";
import * as fsModule from "node:fs";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});

const BOX = "00000000-0000-4000-8000-000000000002", HUB = "00000000-0000-4000-8000-000000000001";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function participantFixture() {
  const global = createReplica("global", BOX), worktree = createReplica("worktree", BOX); fixtures.push(global, worktree);
  const root = global.root, stateRoot = join(root, "herdr"), file = join(worktree.root, "session.jsonl");
  const config = { enabled: false, role: "box" as const, machineId: BOX, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture.service", syncMs: 120000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  mkdirSync(join(root, "roam"), { mode: 0o700 });
  writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId: BOX }), { mode: 0o600 });
  writeFileSync(join(root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
  enrollFixtureCore(root, "core-1");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: worktree.root }) + "\n", { mode: 0o600 });
  global.db.prepare("UPDATE roam_meta SET capture_enabled=1 WHERE id=1").run();
  global.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES (?,?,1,NULL,1)").run("session-1", BOX);
  worktree.db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES (?,1,?)").run("session-1", BOX);
  worktree.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,1,'active')").run("session-1");
  worktree.db.prepare("UPDATE roam_meta SET capture_enabled=1 WHERE id=1").run();
  recordLocation(global.db, { sessionId: "session-1", stores: [worktree.storeKey], home: null, file, cwd: worktree.root });
  const journal = openJournal(join(root, "roam", "journal.db")), authority = createRunningIntentAuthority(global.db), intents = createIntentStore(root);
  const intent = { sessionId: "session-1", epoch: 1, desired: "running" as const, suspended: null, file, cwd: worktree.root, moveId: null };
  await authority.set(intent, "resume-1", { kind: "box-participant", machineId: BOX, hubMachineId: HUB });
  const ports = { config, root: join(root, "roam", "staging"), journal, openStore(key: string) { return { db: key === "global" ? global.db : worktree.db, effects: {} as never, policy: {} as never }; } };
  const operation = { id: "stop-1", kind: "session-stop", machineId: BOX, expectedEpoch: 1, args: { sourceMachine: HUB, sessionId: "session-1" } };
  return { root, stateRoot, file, global, ports, operation, authority, intents, intent };
}
// Keep reservation, exact launcher, ownership files and stop real. Only the
// native core transport and process inventory are external doubles.
async function productionLaunchFixture(boundary?: "crash" | "stale" | "lost-invoking-reply") {
  const f = await participantFixture();
  const agentDirectory = join(f.root, "agent"); mkdirSync(agentDirectory, { mode: 0o700 });
  writeFileSync(join(agentDirectory, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "fixture-only" } }), { mode: 0o600 });
  await f.global.db.raw.backup(join(f.root, "spider.db"));
  let preflightFails = !boundary, spawns = 0, faulted = false, processIdentity = "supervisor-1";
  let coreProbe: (() => Promise<string>) | undefined, nativeRun: LocalExactHc["run"] | undefined;
  const prepared: Array<{ phase: string; operationId: string }> = [], reservations: string[] = [];
  const realIntentStore = intentModule.createIntentStore;
  vi.spyOn(intentModule, "createIntentStore").mockImplementation(root => {
    const store = realIntentStore(root);
    return { ...store, async update(id, version, next) {
      if (next.supervision.kind === "launching" && next.supervision.phase === "reserved" && (await store.get(id))?.value.supervision.kind === "idle") {
        reservations.push(next.supervision.operationId);
      }
      if (boundary && next.supervision.kind === "launching" && next.supervision.phase === "invoking" && !faulted) {
        faulted = true;
        const current = (await store.get(id))!;
        const lock = await inspectIdLock(f.stateRoot, id);
        expect(lock?.pendingOperationId).toBe(next.supervision.operationId);
        await access(launchHandoffPath(f.stateRoot, next.supervision.operationId));
        if (current.value.supervision.kind !== "launching") throw new Error("missing-reservation");
        prepared.push({ phase: current.value.supervision.phase, operationId: next.supervision.operationId });
        if (boundary === "lost-invoking-reply") await store.update(id, version, next);
        if (boundary === "stale") return { kind: "stale", currentVersion: current.version };
        throw new Error("fixture-boundary-crash");
      }
      return store.update(id, version, next);
    } };
  });
  const leases = createSessionLeases(f.stateRoot);
  const inventory = { leases, presence: createProcessPresence(f.stateRoot), processes: async () => [],
    probe: async (pid: number): Promise<ProcessProbe> => pid === process.pid ? { kind: "live", startIdentity: processIdentity } : { kind: "absent" } };
  const hc: LocalExactHc = { async coreId() { if (coreProbe) return coreProbe(); if (preflightFails) throw new Error("fixture-preflight-failed"); return "core-1"; },
    async terminals() { return { complete: true, terminals: [] }; }, async run(request, observer) { spawns++; if (nativeRun) return nativeRun(request, observer); throw new Error("unexpected-spawn"); } };
  vi.stubEnv("SPIDER_ROAM_PI", "/home/fixture/pi");
  vi.spyOn(cliTransport, "invokeCli").mockResolvedValue({ version: "0.1.16", core: { id: "core-1" }, pid: 4321 });
  vi.spyOn(hcModule, "createHcClient").mockReturnValue({ events() { return { subscribe() { return () => {}; }, dispose() {} }; }, async dispose() {} } as never);
  vi.spyOn(runtimeModule, "openLocalRuntime").mockReturnValue({ config: f.ports.config, db: f.global.db, journal: f.ports.journal, agent: f.ports, close() {} } as never);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ agentDirectory, core: { binary: "/home/fixture/hc" } } as never);
  vi.spyOn(launcherModule, "createProductionLocalExactHc").mockReturnValue({ ...hc, async dispose() {} });
  const realAdapter = launcherModule.createExactLaunchAdapter;
  vi.spyOn(launcherModule, "createExactLaunchAdapter").mockImplementation(input => {
    let now = 100;
    return realAdapter({ ...input, base: { ...input.base, now: () => now, wait: async () => { now += 60_000; } } });
  });
  const realSupervisor = participantSupervisor.createParticipantSupervisor;
  let supervisor!: ReturnType<typeof createParticipantSupervisor>;
  vi.spyOn(participantSupervisor, "createParticipantSupervisor").mockImplementation(input => {
    supervisor = realSupervisor(input);
    // Drive reconciliation explicitly; no background scheduler races the fault.
    return { ...supervisor, start() {} };
  });
  const start = () => productionSupervisor.startProductionSupervisor(f.root, { clock: { now: () => 100, later: () => () => {} },
    system: { inventory, bootId: async () => "boot-1", limits: async () => ({ soft: 1024, hard: 1024 }), shell: "/bin/sh" } });
  let service = await start();
  const recovery = { hc: { ...hc, coreId: async () => "core-1" }, bootId: async () => "boot-1", probe: inventory.probe,
    clock: { now: () => 100, wait: async () => {} } };
  const hub = createReplica("global", HUB); fixtures.push(hub);
  mkdirSync(join(hub.root, "roam"), { mode: 0o700 });
  const hubConfig = { ...f.ports.config, role: "hub", machineId: HUB, peers: [{ machineId: BOX, alias: "box-1.invalid", node: "/home/fixture/node",
    pi: "/home/fixture/pi", cli: "/home/fixture/spider", core: "/home/fixture/hc", globalRoot: "/home/fixture/global" }] };
  writeFileSync(join(hub.root, "roam", "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  writeFileSync(join(hub.root, "roam", "config.json"), JSON.stringify(hubConfig), { mode: 0o600 });
  hub.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES (?,?,1,NULL,1)").run("session-1", BOX);
  await hub.db.raw.backup(join(hub.root, "spider.db"));
  const release = join(hub.root, "release.js");
  writeFileSync(release, "// SPIDER_BUILD_ID=01234567@2026-01-01T00:00:00.000Z v0.1.0\n", { mode: 0o600 });
  const bundleUrl = pathToFileURL(release);
  vi.stubEnv("SPIDER_GLOBAL_ROOT", hub.root);
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ async resolve(peer: unknown) { return peer; }, async exec(_peer: unknown, argv: string[]) {
    if (argv[1] === "agent") {
      const operation = JSON.parse(argv[2]);
      return Buffer.from(JSON.stringify(await (operation.kind.startsWith("session-") ?
        handleSessionOperation(operation, f.ports, { wake: async () => {}, launchRecovery: recovery }) : handleAgentOperation(operation, f.ports))));
    }
    expect(argv).toEqual(["roam", "observe", "doctor"]);
    return Buffer.from(JSON.stringify({ version: 1, machineId: BOX, kind: "doctor", value: await runLocalDoctor({ root: f.root, bundleUrl, currentCore: async () => "core-1", launchRecovery: recovery }) }));
  } } as never);
  const invokeHub = async (command: "stop" | "enable") => {
    const out: string[] = [], err: string[] = [];
    const lifecycle = { resolveCli: () => release, launchd: { plistDir: join(hub.root, "LaunchAgents"), serviceHome: hub.root, async launchctl() {} } };
    const pi = process.env.SPIDER_ROAM_PI;
    if (command === "enable") vi.stubEnv("SPIDER_ROAM_PI", process.execPath);
    try {
      const code = await main(["roam", command, ...(command === "stop" ? ["session-1"] : []), "--json"], { out: text => out.push(text), err: text => err.push(text) }, { bundleUrl, v0: { lifecycle } });
      expect(err).toEqual([]);
      return { code, result: JSON.parse(out.join("")) };
    } finally { if (command === "enable") vi.stubEnv("SPIDER_ROAM_PI", pi); }
  };
  return { ...f, leases, release, invokeHub, nativeRun(run: LocalExactHc["run"]) { nativeRun = run; }, coreProbe(probe: () => Promise<string>) { coreProbe = probe; }, get supervisor() { return supervisor; }, get service() { return service; }, recovery, prepared, reservations, spawns: () => spawns,
    allowPreflight() { preflightFails = false; },
    async restart() { await service.stop(); processIdentity = "supervisor-2"; service = await start(); } };
}

it.each(["same-process", "restart", "lost-stop-reply"] as const)("production preflight failure stays stoppable while disabled: %s", async state => {
  const f = await productionLaunchFixture();
  try {
    await f.supervisor.reconcile();
    const row = (await f.intents.get("session-1"))!;
    expect(row.value.supervision).toMatchObject({ kind: "launching", phase: "reserved" });
    const launchId = participantLaunchId(BOX, "session-1", 1, "resume-1");
    expect(row.value.supervision).toMatchObject({ operationId: launchId });
    expect(f.ports.journal.lookupOperation(launchId)).toBeNull();
    expect(await inspectIdLock(f.stateRoot, "session-1")).toBeNull();
    if (state === "restart") { await f.restart(); await f.supervisor.reconcile(); }
    expect(f.reservations).toEqual([launchId]);
    const options = { wake: async () => {}, launchRecovery: f.recovery };
    if (state === "lost-stop-reply") {
      const record = f.ports.journal.record;
      let lost = false;
      f.ports.journal.record = (id, action, result) => {
        record(id, action, result);
        if (id === "stop-1" && action === "done" && !lost) { lost = true; throw new Error("lost-stop-reply"); }
      };
      await expect(handleSessionOperation(f.operation, f.ports, options)).rejects.toThrow("lost-stop-reply");
    }
    const beforeEnable = await f.invokeHub("enable");
    expect(beforeEnable.code).toBe(0);
    if (state !== "lost-stop-reply") expect(beforeEnable.result.value.issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "warning", reason: expect.stringContaining("exact-launch") })]));
    expect(await f.invokeHub("stop")).toMatchObject({ code: 0, result: { reason: "stopped-intent" } });
    expect((await f.intents.get("session-1"))?.value).toMatchObject({ intent: { desired: "stopped" }, supervision: { kind: "idle", nextAttemptAt: null } });
    expect(await f.authority.get("session-1")).toMatchObject({ desired: "stopped" });
    await f.supervisor.reconcile();
    expect(f.spawns()).toBe(0);
    const report = await runLocalDoctor({ root: f.root, currentCore: async () => "core-1", launchRecovery: f.recovery });
    expect(report.diagnostics.filter(row => /exact launch.*pending/i.test(row.reason))).toEqual([]);
    const enable = await f.invokeHub("enable");
    expect((enable.result.value?.issues ?? []).filter((row: { reason: string }) => row.reason.includes("exact-launch"))).toEqual([]);
  } finally { await f.service.stop(); }
});

it.each(["crash", "stale", "lost-invoking-reply"] as const)("prepared production handoff survives %s without a late or duplicate spawn", async fault => {
  const f = await productionLaunchFixture(fault);
  try {
    await f.supervisor.reconcile();
    const launchId = participantLaunchId(BOX, "session-1", 1, "resume-1");
    expect(f.prepared).toEqual([{ phase: "reserved", operationId: launchId }]);
    expect(f.spawns()).toBe(0);
    expect(await inspectIdLock(f.stateRoot, "session-1")).toMatchObject({ pendingOperationId: launchId, pendingCoreId: "core-1" });
    await access(launchHandoffPath(f.stateRoot, launchId));
    expect(f.ports.journal.lookupOperation(launchId)).toEqual({ machineId: BOX, state: "pending" });
    // Recreate both the durable port and the production launcher from disk.
    await f.restart();
    await f.supervisor.reconcile();
    expect(f.reservations).toEqual([launchId]);
    expect(f.ports.journal.read(launchId).filter(row => row.action === "exact-launch-prepared")).toHaveLength(1);
    expect((await f.intents.get("session-1"))?.value.supervision).toMatchObject({ kind: "launching", operationId: launchId });
    const beforeEnable = await f.invokeHub("enable");
    expect(beforeEnable.code).toBe(0);
    expect(beforeEnable.result.value.issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "warning", reason: expect.stringContaining("exact-launch") })]));
    expect(await f.invokeHub("stop")).toMatchObject({ code: 0, result: { reason: "stopped-intent" } });
    expect(await inspectIdLock(f.stateRoot, "session-1")).toBeNull();
    expect(await f.leases.get(f.file)).toBeNull();
    expect((await f.intents.get("session-1"))?.value).toMatchObject({ intent: { desired: "stopped" }, supervision: { kind: "idle" } });
    expect(f.ports.journal.read(launchId).filter(row => row.action === "exact-launch-settled")).toHaveLength(1);
    expect(f.ports.journal.lookupOperation(launchId)).toEqual({ machineId: BOX, state: "done" });
    expect(f.spawns()).toBe(0);
  } finally { await f.service.stop(); }
});

it.each(["normal", "lost-cancel-reply"] as const)("hub stop during production preflight fences the delayed launcher: %s", async reply => {
  const f = await productionLaunchFixture();
  let enter!: () => void, release!: (core: string) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), core = new Promise<string>(resolve => { release = resolve; });
  f.coreProbe(async () => { enter(); return core; });
  if (reply === "lost-cancel-reply") {
    const record = f.ports.journal.record, launchId = participantLaunchId(BOX, "session-1", 1, "resume-1");
    let lost = false;
    f.ports.journal.record = (id, action, result) => {
      record(id, action, result);
      if (id === launchId && action === "done" && !lost) { lost = true; throw new Error("lost-cancel-reply"); }
    };
  }
  const launching = f.supervisor.reconcile();
  try {
    await entered;
    expect(await f.invokeHub("stop")).toMatchObject({ code: 0, result: { reason: "stopped-intent" } });
    release("core-1"); await launching;
    expect(f.spawns()).toBe(0);
    expect(await inspectIdLock(f.stateRoot, "session-1")).toBeNull();
    expect(await f.leases.get(f.file)).toBeNull();
    expect((await f.intents.get("session-1"))?.value).toMatchObject({ intent: { desired: "stopped" }, supervision: { kind: "idle" } });
    const enable = await f.invokeHub("enable");
    expect((enable.result.value?.issues ?? []).filter((row: { reason: string }) => row.reason.includes("exact-launch"))).toEqual([]);
  } finally { release("core-1"); await launching; await f.service.stop(); }
});

it("production spawns only with an invoking reservation and a durable exact handoff", async () => {
  const f = await productionLaunchFixture();
  f.allowPreflight();
  const observed: unknown[] = [];
  let spawned!: () => void;
  const spawnObserved = new Promise<void>(resolve => { spawned = resolve; });
  f.nativeRun(async request => {
    const current = (await f.intents.get("session-1"))!;
    observed.push(current.value.supervision);
    const operationId = request.terminal!.labels["spider.roam.operation"];
    expect(await inspectIdLock(f.stateRoot, "session-1")).toMatchObject({ pendingOperationId: operationId });
    await access(launchHandoffPath(f.stateRoot, operationId));
    spawned();
    throw new Error("fixture-unknown-launch-reply");
  });
  try {
    await f.supervisor.reconcile();
    const launchId = participantLaunchId(BOX, "session-1", 1, "resume-1");
    await spawnObserved;
    expect(observed).toEqual([{ kind: "launching", phase: "invoking", operationId: launchId }]);
    expect(f.reservations).toEqual([launchId]);
    expect(f.spawns()).toBe(1);
    await f.restart();
    expect(await f.invokeHub("stop")).toMatchObject({ code: 3, result: { reason: "launch-reconciliation-required" } });
    expect(await inspectIdLock(f.stateRoot, "session-1")).toMatchObject({ pendingOperationId: launchId });
    expect(f.ports.journal.read(launchId).some(row => row.action === "exact-launch-settled")).toBe(false);
    expect(f.spawns()).toBe(1);
  } finally { await f.service.stop(); }
});

it("hub stop repeats a prepared-only settlement after its committed reply is lost", async () => {
  const f = await productionLaunchFixture("crash");
  try {
    await f.supervisor.reconcile(); await f.restart();
    const launchId = participantLaunchId(BOX, "session-1", 1, "resume-1"), record = f.ports.journal.record;
    let lost = false;
    f.ports.journal.record = (id, action, result) => {
      record(id, action, result);
      if (id === launchId && action === "done" && !lost) { lost = true; throw new Error("lost-settlement-reply"); }
    };
    expect(await f.invokeHub("stop")).toMatchObject({ code: 3, result: { reason: "launch-reconciliation-required" } });
    expect(await inspectIdLock(f.stateRoot, "session-1")).toMatchObject({ pendingOperationId: launchId });
    expect(await f.invokeHub("stop")).toMatchObject({ code: 0, result: { reason: "stopped-intent" } });
    expect(f.ports.journal.read(launchId).filter(row => row.action === "exact-launch-settled")).toHaveLength(1);
    expect((await f.intents.get("session-1"))?.value).toMatchObject({ intent: { desired: "stopped" }, supervision: { kind: "idle" } });
    expect(await f.leases.get(f.file)).toBeNull();
    expect(f.spawns()).toBe(0);
  } finally { await f.service.stop(); }
});

it("prepared-only proof refuses contradictory recorded core identity", async () => {
  const f = await productionLaunchFixture("crash");
  try {
    await f.supervisor.reconcile(); await f.restart();
    const launchId = participantLaunchId(BOX, "session-1", 1, "resume-1");
    f.ports.journal.record(launchId, "exact-core", { coreId: "core-2" });
    expect(await f.invokeHub("stop")).toMatchObject({ code: 3, result: { reason: "launch-reconciliation-required" } });
    expect(await inspectIdLock(f.stateRoot, "session-1")).toMatchObject({ pendingOperationId: launchId });
    expect(f.ports.journal.read(launchId).some(row => row.action === "exact-launch-settled")).toBe(false);
    expect(f.spawns()).toBe(0);
  } finally { await f.service.stop(); }
});

it.each(["session", "core", "boot", "file", "launcher"] as const)("prepared settlement refuses changed %s authority", async field => {
  const f = await productionLaunchFixture("crash");
  try {
    await f.supervisor.reconcile(); await f.restart();
    const launchId = participantLaunchId(BOX, "session-1", 1, "resume-1");
    const proof = f.ports.journal.read(launchId).find(row => row.action === "exact-launch-prepared")!.result;
    const changed = { ...proof, ...(field === "session" ? { sessionId: "session-2" } : field === "core" ? { coreId: "core-2" } :
      field === "boot" ? { bootId: "boot-2" } : field === "file" ? { file: "/home/fixture/other.jsonl" } : { launcher: { pid: 9999, startIdentity: "other-launcher" } }) };
    const db = openDb(join(f.root, "roam", "journal.db"));
    try { db.prepare("UPDATE roam_operation_actions SET result_json=? WHERE operation_id=? AND action='exact-launch-prepared'").run(JSON.stringify(changed), launchId); }
    finally { db.close(); }
    expect(await f.invokeHub("stop")).toMatchObject({ code: 3, result: { reason: "launch-reconciliation-required" } });
    expect(await inspectIdLock(f.stateRoot, "session-1")).toMatchObject({ pendingOperationId: launchId });
    expect(await f.leases.get(f.file)).not.toBeNull();
    expect(f.spawns()).toBe(0);
  } finally { await f.service.stop(); }
});

it("a failed preparation record cannot leave an unreconcilable reserved handoff", async () => {
  const f = await productionLaunchFixture(); f.allowPreflight();
  const record = f.ports.journal.record;
  let interrupted = false;
  f.ports.journal.record = (id, action, result) => {
    if (action === "exact-launch-prepared" && !interrupted) { interrupted = true; throw new Error("preparation-record-failed"); }
    record(id, action, result);
  };
  try {
    await f.supervisor.reconcile();
    const launchId = participantLaunchId(BOX, "session-1", 1, "resume-1");
    expect((await f.intents.get("session-1"))?.value.supervision).toEqual({ kind: "launching", operationId: launchId, phase: "reserved" });
    expect(interrupted).toBe(true);
    await f.restart(); await f.supervisor.reconcile();
    expect(f.reservations).toEqual([launchId]);
    expect(f.spawns()).toBe(0);
    expect(await f.invokeHub("stop")).toMatchObject({ code: 0, result: { reason: "stopped-intent" } });
    expect(await inspectIdLock(f.stateRoot, "session-1")).toBeNull();
    expect(await f.leases.get(f.file)).toBeNull();
    expect((await f.intents.get("session-1"))?.value.supervision.kind).toBe("idle");
  } finally { await f.service.stop(); }
});

it("supported participant resume reaches the durable production boundary before disabled hub stop", async () => {
  const f = await productionLaunchFixture();
  // Keep the doctor's real service discovery inside the fixture on every host.
  vi.stubEnv("HOME", f.root);
  try {
    await f.authority.stop("session-1");
    await f.global.db.raw.backup(join(f.root, "spider.db"));
    vi.spyOn(hcModule, "observeCoreIdentity").mockResolvedValue({ coreId: "core-1", socket: join(f.root, "core.sock"), sessionNamespace: "fixture" } as never);
    // Redirect only the packaged build read. Doctor's checks remain real.
    const packagedBuild = fileURLToPath(new URL("../../extension.js", import.meta.url));
    const open = (await vi.importActual<typeof import("node:fs")>("node:fs")).openSync;
    vi.spyOn(fsModule, "openSync").mockImplementation((file, flags, mode) => open(file === packagedBuild ? f.release : file, flags, mode));
    const resumed = await handleSessionOperation({ ...f.operation, id: "resume-2", kind: "session-resume" }, f.ports, { wake: async () => {}, launchRecovery: f.recovery });
    expect(resumed).toEqual(expect.objectContaining({ code: 0, reason: "resumed-intent" }));
    await f.supervisor.reconcile();
    // Resume retains the participant's original admission operation.
    const launchId = participantLaunchId(BOX, "session-1", 1, "resume-1");
    expect(f.reservations).toEqual([launchId]);
    expect((await f.intents.get("session-1"))?.value.supervision).toMatchObject({ kind: "launching", operationId: launchId, phase: "reserved" });
    expect(await f.invokeHub("stop")).toMatchObject({ code: 0, result: { reason: "stopped-intent" } });
    expect((await f.intents.get("session-1"))?.value).toMatchObject({ intent: { desired: "stopped" }, supervision: { kind: "idle" } });
    expect(f.spawns()).toBe(0);
  } finally { await f.service.stop(); }
});

async function fixture(launchId = "launch-1") {
  const f = await participantFixture(), { root, stateRoot, file, journal, authority, intents, intent } = { ...f, journal: f.ports.journal };
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
  return { ...f, leases, hc, recovery, handoff, lock,
    terminal(value: typeof terminal) { terminal = value; }, process(value: ProcessProbe) { process = value; }, boot(value: string) { boot = value; }, spawns: () => spawns };
}

async function missingStartedTerminalFixture() {
  const f = await fixture();
  let sample = 0, currentCore = "core-1", incomplete = false, failed = false;
  const rows: Array<{ address: string; state: "live" | "finished"; labels: Record<string, string>; reason: string | null; exit_code: number | null }> = [];
  const queries: Array<{ argv: readonly string[]; at: number }> = [];
  const local = createLocalExactHc({ coreId: async () => currentCore, async invoke(argv) {
    queries.push({ argv, at: f.recovery.clock.now() });
    if (failed) throw new Error("core-unavailable");
    if (incomplete) return {};
    expect(argv.slice(0, 3)).toEqual(["ls", "--all", "--json"]);
    const labels = argv.flatMap((value, index) => value === "--label" ? [argv[index + 1]] : []);
    if (labels.length === 1 && labels[0] === "spider.roam.operation=launch-1") sample++;
    return { terminals: rows.filter(row => labels.every(label => {
      const index = label.indexOf("="); return row.labels[label.slice(0, index)] === label.slice(index + 1);
    })).map(({ labels: _labels, ...row }) => row) };
  }, async invokeTracked() { throw new Error("stop must not invoke hc run"); } });
  f.recovery.hc = local;
  return { ...f, rows, queries, samples: () => sample, core(value: string) { currentCore = value; },
    incomplete() { incomplete = true; }, failed() { failed = true; } };
}

it.each(["launcher-lease", "absent-lease", "reused-pid"] as const)("stop settles a started launch whose terminal history is gone: %s", async ownership => {
  const f = await missingStartedTerminalFixture();
  if (ownership === "absent-lease") { const lease = (await f.leases.get(f.file))!; await f.leases.release(f.file, lease.token, { mode: "cutover" }); }
  if (ownership === "reused-pid") f.process({ kind: "live", startIdentity: "reused-process" });
  await f.global.db.raw.backup(join(f.root, "spider.db"));
  expect((await runLocalDoctor({ root: f.root, currentCore: async () => "core-1", launchRecovery: f.recovery })).diagnostics)
    .toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringMatching(/exact launch.*pending/i) })]));
  expect(await handleSessionOperation(f.operation, f.ports, { wake: async () => {}, launchRecovery: f.recovery })).toMatchObject({ code: 0, reason: "stopped-intent" });
  expect(await inspectIdLock(f.stateRoot, "session-1")).toBeNull();
  expect(await f.leases.get(f.file)).toBeNull();
  await expect(access(launchHandoffPath(f.stateRoot, "launch-1"))).rejects.toMatchObject({ code: "ENOENT" });
  const actions = f.ports.journal.read("launch-1");
  expect(actions.filter(row => row.action === "exact-started-launch-ended")).toEqual([{ action: "exact-started-launch-ended", result: {
    kind: "started-launch-ended", operationId: "launch-1", attemptId: "attempt-1", terminalId: "terminal-1", coreId: "core-1", bootId: "boot-1",
    launcher: { pid: 201, startIdentity: "previous-supervisor" },
    first: { coreId: "core-1", issuedAt: 100, terminal: "absent" }, second: { coreId: "core-1", issuedAt: 350, terminal: "absent" }, confirmationBoundMs: 250,
  } }]);
  expect(actions.find(row => row.action === "done")?.result).toMatchObject({ reason: "launch-ended", value: null });
  expect(f.ports.journal.lookupOperation("launch-1")).toEqual({ machineId: BOX, state: "done" });
  expect((await f.intents.get("session-1"))?.value).toMatchObject({ intent: { desired: "stopped" }, supervision: { kind: "idle", nextAttemptAt: null } });
  expect(await f.authority.get("session-1")).toMatchObject({ desired: "stopped" });
  expect((await runLocalDoctor({ root: f.root, currentCore: async () => "core-1", launchRecovery: f.recovery })).diagnostics.filter(row => /exact launch.*pending/i.test(row.reason))).toEqual([]);
  expect(f.spawns()).toBe(0);
  expect(await handleSessionOperation({ ...f.operation, id: "stop-2" }, f.ports, { wake: async () => {}, launchRecovery: f.recovery })).toMatchObject({ code: 0 });
  expect(f.ports.journal.read("launch-1").filter(row => row.action === "exact-started-launch-ended")).toHaveLength(1);
});

it.each(["unrelated-live", "old-finished-history", "recorded-finished"] as const)("stop handles missing started terminal listings with %s", async state => {
  const f = await missingStartedTerminalFixture();
  f.rows.push({ address: state === "recorded-finished" ? "terminal-1" : "other-terminal", state: state === "unrelated-live" ? "live" : "finished", reason: "exited", exit_code: 0,
    labels: state === "unrelated-live" ? { "spider.session": "other-session" } : { "spider.session": "session-1" } });
  expect(await handleSessionOperation(f.operation, f.ports, { wake: async () => {}, launchRecovery: f.recovery })).toMatchObject({ code: 0, reason: "stopped-intent" });
  const actions = f.ports.journal.read("launch-1");
  expect(actions.some(row => row.action === "exact-started-launch-ended")).toBe(state !== "recorded-finished");
  expect(actions.find(row => row.action === "done")?.result.reason).toBe(state === "recorded-finished" ? "launch-not-started" : "launch-ended");
  expect(await inspectIdLock(f.stateRoot, "session-1")).toBeNull();
  expect(f.spawns()).toBe(0);
});

it.each(["operation", "attempt", "session"] as const)("stop refuses a live terminal carrying only the %s label on the second absence sample", async label => {
  const f = await missingStartedTerminalFixture(), wait = f.recovery.clock.wait;
  f.recovery.clock.wait = async ms => {
    f.rows.push({ address: "other-terminal", state: "live", reason: null, exit_code: null, labels: {
      [label === "operation" ? "spider.roam.operation" : label === "attempt" ? "spider.roam.attempt" : "spider.session"]:
        label === "operation" ? "launch-1" : label === "attempt" ? "attempt-1" : "session-1",
    } });
    await wait(ms);
  };
  const before = await inspectIdLock(f.stateRoot, "session-1"), lease = await f.leases.get(f.file);
  expect(await handleSessionOperation(f.operation, f.ports, { wake: async () => {}, launchRecovery: f.recovery })).toMatchObject({ code: 3, reason: "launch-reconciliation-required" });
  expect(f.queries.some(query => query.at >= 350)).toBe(true);
  expect(await inspectIdLock(f.stateRoot, "session-1")).toEqual(before);
  expect(await f.leases.get(f.file)).toEqual(lease);
  expect(f.ports.journal.read("launch-1").some(row => row.action === "exact-started-launch-ended")).toBe(false);
  expect(f.spawns()).toBe(0);
});

it.each(["child-lease", "ready-durable", "changed-core", "recorded-core-changed", "incomplete", "failed-listing", "live-launcher", "unknown-launcher", "lease-adopted-during-samples", "ready-during-samples", "boot-during-samples", "incomplete-second", "failed-second", "core-changed-second", "early-second"] as const)("stop preserves a missing started terminal with %s", async state => {
  const f = await missingStartedTerminalFixture();
  const adopt = async () => { const lease = (await f.leases.get(f.file))!; await f.leases.transfer(f.file, lease.token, { pid: 202, startIdentity: "child-start" }); };
  if (state === "child-lease") await adopt();
  if (state === "ready-durable") f.ports.journal.record("launch-1", "ready-durable", { sessionId: "session-1" });
  if (state === "changed-core") f.core("core-2");
  if (state === "recorded-core-changed") f.ports.journal.record("launch-1", "exact-core", { coreId: "core-2" });
  if (state === "incomplete") f.incomplete();
  if (state === "failed-listing") f.failed();
  if (state === "live-launcher") f.process({ kind: "live", startIdentity: "previous-supervisor" });
  if (state === "unknown-launcher") f.process({ kind: "unknown" });
  const wait = f.recovery.clock.wait;
  f.recovery.clock.wait = async ms => {
    if (state === "lease-adopted-during-samples") await adopt();
    if (state === "ready-during-samples") f.ports.journal.record("launch-1", "ready-durable", { sessionId: "session-1" });
    if (state === "boot-during-samples") f.boot("boot-2");
    if (state === "incomplete-second") f.incomplete();
    if (state === "failed-second") f.failed();
    if (state === "core-changed-second") f.core("core-2");
    if (state !== "early-second") await wait(ms);
  };
  const before = await inspectIdLock(f.stateRoot, "session-1");
  expect(await handleSessionOperation(f.operation, f.ports, { wake: async () => {}, launchRecovery: f.recovery })).toMatchObject({ code: 3, reason: "launch-reconciliation-required" });
  expect(await inspectIdLock(f.stateRoot, "session-1")).toEqual(before);
  expect(await f.leases.get(f.file)).not.toBeNull();
  expect(f.ports.journal.lookupOperation("launch-1")).toEqual({ machineId: BOX, state: "pending" });
  expect(f.ports.journal.read("launch-1").some(row => row.action === "exact-started-launch-ended")).toBe(false);
  expect(f.spawns()).toBe(0);
});

it.each([false, true])("stop clears a reservation before authorization completes: %s", async authorized => {
  const f = await participantFixture();
  await f.intents.update("session-1", null, { intent: f.intent, failures: [], supervision: { kind: "idle", nextAttemptAt: null } });
  let invocations = 0;
  const launch = createDurableLaunchPort({ intents: f.intents, operationId: () => "reserved-1", async authorize() {
    await f.global.db.raw.backup(join(f.root, "spider.db"));
    const before = await runLocalDoctor({ root: f.root });
    expect(before.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "block", repairCommand: "spider roam stop session-1" })]));
    expect(await handleSessionOperation(f.operation, f.ports, { wake: async () => {} })).toMatchObject({ code: 0, reason: "stopped-intent" });
    return authorized;
  }, async invoke() { invocations++; throw new Error("stopped reservation cannot launch"); } });
  expect(await launch({ intent: f.intent, mode: "fresh" })).toMatchObject({ code: 2, reason: authorized ? "launch-intent-stale" : "launch-pending" });
  expect((await f.intents.get("session-1"))?.value).toMatchObject({ intent: { desired: "stopped" }, supervision: { kind: "idle", nextAttemptAt: null } });
  expect(await f.authority.get("session-1")).toMatchObject({ desired: "stopped" });
  expect(f.ports.journal.lookupOperation("reserved-1")).toBeNull();
  expect(f.ports.journal.read(`${participantLaunchId(BOX, "session-1", 1, "resume-1")}-restarts`)).toEqual([]);
  const after = await runLocalDoctor({ root: f.root });
  expect(after.diagnostics.filter(row => /exact launch.*pending/i.test(row.reason))).toEqual([]);
  expect(invocations).toBe(0);
  expect(await handleSessionOperation({ ...f.operation, id: "stop-2" }, f.ports, { wake: async () => {} })).toMatchObject({ code: 0 });
});

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

it("stop preserves a move launch that is not the participant's reservation", async () => {
  const f = await fixture("move-launch-1"), current = (await f.intents.get("session-1"))!;
  await f.intents.update("session-1", current.version, { ...current.value, supervision: { kind: "launching", phase: "invoking", operationId: "launch-1" } });
  const before = await inspectIdLock(f.stateRoot, "session-1"), lease = await f.leases.get(f.file);
  expect(await handleSessionOperation(f.operation, f.ports, { wake: async () => {}, launchRecovery: f.recovery })).toMatchObject({ code: 3, reason: "launch-reconciliation-required", repairCommand: `spider roam doctor ${BOX}` });
  expect(await inspectIdLock(f.stateRoot, "session-1")).toEqual(before);
  expect(await f.leases.get(f.file)).toEqual(lease);
  expect(f.ports.journal.lookupOperation("move-launch-1")).toEqual({ machineId: BOX, state: "pending" });
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

it("doctor does not prescribe stop for an invoking reservation without a handoff", async () => {
  const f = await fixture(); await f.lock.cancelHandoff("launch-1");
  await f.global.db.raw.backup(join(f.root, "spider.db"));
  const report = await runLocalDoctor({ root: f.root, currentCore: async () => "core-1", launchRecovery: f.recovery });
  expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "block",
    reason: expect.stringMatching(/session-1.*launch-1.*pending.*adopted-owner evidence is unavailable.*pinned core is available.*restore ownership evidence/i), repairCommand: null })]));
  expect(await handleSessionOperation(f.operation, f.ports, { wake: async () => {}, launchRecovery: f.recovery })).toMatchObject({ code: 3, reason: "launch-reconciliation-required" });
  expect((await f.intents.get("session-1"))?.value.supervision.kind).toBe("launching");
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

it("stop bounds a hung reconciliation without treating timeout as exit proof", async () => {
  const f = await fixture(), before = await inspectIdLock(f.stateRoot, "session-1"), lease = await f.leases.get(f.file);
  let enter!: () => void, release!: (core: string) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const core = new Promise<string>(resolve => { release = resolve; });
  f.hc.coreId = async () => { enter(); return core; };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // Node's timeout signal uses native timers; route only that timer through the fake clock.
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const abort = new AbortController(); setTimeout(() => abort.abort(), ms); return abort.signal;
  });
  let outcome: Awaited<ReturnType<typeof handleSessionOperation>> | undefined;
  const stop = handleSessionOperation(f.operation, f.ports, { wake: async () => {}, launchRecovery: f.recovery }).then(value => { outcome = value; });
  try {
    await entered;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(outcome).toMatchObject({ code: 3, reason: "launch-reconciliation-required", repairCommand: `spider roam doctor ${BOX}` }));
    expect(await inspectIdLock(f.stateRoot, "session-1")).toEqual(before);
    expect(await f.leases.get(f.file)).toEqual(lease);
    expect(f.ports.journal.lookupOperation("launch-1")).toEqual({ machineId: BOX, state: "pending" });
    expect(f.spawns()).toBe(0);
  } finally { release("core-1"); await stop; vi.useRealTimers(); }
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

it("first stop uses the current intent version after a supervisor sync during settlement", async () => {
  const f = await fixture(), terminals = f.hc.terminals;
  let synced = false;
  f.hc.terminals = async (id, options) => {
    if (!synced) {
      synced = true;
      const current = (await f.intents.get("session-1"))!;
      await f.intents.update("session-1", current.version, { ...current.value, intent: { ...current.value.intent, desired: "stopped" } });
    }
    return terminals(id, options);
  };
  expect(await handleSessionOperation(f.operation, f.ports, { wake: async () => {}, launchRecovery: f.recovery })).toMatchObject({ code: 0, reason: "stopped-intent" });
  expect(await inspectIdLock(f.stateRoot, "session-1")).toBeNull();
  expect(await f.leases.get(f.file)).toBeNull();
  expect((await f.intents.get("session-1"))?.value).toMatchObject({ intent: { desired: "stopped" }, supervision: { kind: "idle" } });
  expect(f.spawns()).toBe(0);
});

it.each(["stale-cas", "authority-lost"] as const)("settled stop includes a repair when intent reconciliation fails: %s", async state => {
  const f = await fixture();
  if (state === "stale-cas") {
    vi.spyOn(intentModule, "createIntentStore").mockReturnValue({ ...f.intents, async update(id, version, next) {
      const current = (await f.intents.get(id))!;
      await f.intents.update(id, current.version, current.value);
      return f.intents.update(id, version, next);
    } });
  } else {
    const terminals = f.hc.terminals;
    f.hc.terminals = async (id, options) => {
      writeLocal(f.global.db, "participant-intent", "session-1", undefined);
      return terminals(id, options);
    };
  }
  expect(await handleSessionOperation(f.operation, f.ports, { wake: async () => {}, launchRecovery: f.recovery })).toMatchObject({ code: 3, reason: "intent-reconciliation-required", repairCommand: "spider roam stop session-1" });
  expect(await inspectIdLock(f.stateRoot, "session-1")).toBeNull();
  expect(await f.leases.get(f.file)).toBeNull();
  expect((await f.intents.get("session-1"))?.value.supervision.kind).toBe("launching");
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

it.each(["unprobed", "matches", "unavailable", "changed"] as const)("disabled pending-launch doctor reports only observed core state: %s", async state => {
  const f = await fixture();
  const report = await localDiagnostics.localPendingLaunchDiagnostics({ root: f.root, machineId: BOX, launchRecovery: f.recovery,
    ...(state === "unprobed" ? {} : { currentCore: async () => state === "unavailable" ? null : state === "changed" ? "other-core" : "core-1" }) });
  const pending = report.find(row => /session-1.*launch-1.*pending/i.test(row.reason));
  expect(pending).toMatchObject({ severity: "block", repairCommand: "spider roam stop session-1" });
  const detail = { unprobed: "core identity has not been checked", matches: "awaiting reconciliation", unavailable: "core identity is unavailable", changed: "destination core changed" }[state];
  expect(pending?.reason).toContain(detail);
  if (state !== "unavailable") expect(pending?.reason).not.toContain("core identity is unavailable");
});

it("disabled doctor reports the same pending-launch block that enable must refuse", async () => {
  const f = await fixture();
  await f.global.db.raw.backup(join(f.root, "spider.db"));
  const report = await runLocalDoctor({ root: f.root, currentCore: async () => "core-1", launchRecovery: f.recovery });
  expect(report.enabled).toBe(false);
  expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "block", reason: expect.stringMatching(/session-1.*launch-1.*pending/i), repairCommand: "spider roam stop session-1" })]));
  expect(JSON.stringify(report)).not.toContain(f.handoff.nonce);
});
