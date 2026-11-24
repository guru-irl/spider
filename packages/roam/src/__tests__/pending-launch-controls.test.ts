import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { migrate, openDb } from "@spider/db-core";
import { createReplica } from "@spider/db-core/testutil";
import { claimIdLock, inspectIdLock, inspectReleasedIdLock } from "@spider/herdr/sessions/id-lock";
import { recordLocation } from "@spider/db-core/roam/catalog";
import { createSessionLeases } from "@spider/herdr/sessions/lease";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { writeLaunchHandoff, removeLaunchHandoff } from "@spider/herdr/sessions/launch-handoff";
import { createRunningIntentAuthority } from "../session-control";
import { createIntentStore } from "../intent";
import { handleSessionOperation } from "../participant-runtime";
import { createLocalExactHc } from "../launcher";
import { main } from "../cli";
import { disabledIntercom } from "../contracts";
import { handleAgentOperation } from "../agent";
import { openJournal } from "../journal";
import { readLocalIdentity } from "../runtime";
import { localPendingLaunchDiagnostics, runLocalDoctor } from "../local-diagnostics";
import * as transportModule from "../transport";
import * as productionHub from "../production-hub";
import { enrollFixtureCore } from "./supervisor-core-fixture";

const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002";
const roots: string[] = [], databases: ReturnType<typeof openDb>[] = [], replicas: ReturnType<typeof createReplica>[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const replica of replicas.splice(0)) replica.close(); for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "pending-controls-")); roots.push(root);
  const release = join(root, "release.js"), bundleUrl = pathToFileURL(release);
  writeFileSync(release, "// SPIDER_BUILD_ID=01234567@2026-01-01T00:00:00.000Z v0.1.0\n", { mode: 0o600 });
  const remote = join(root, "remote"); mkdirSync(join(remote, "roam"), { recursive: true, mode: 0o700 }); mkdirSync(join(root, "roam"), { mode: 0o700 });
  const config = { enabled: false, role: "hub" as const, machineId: HUB, hubMachineId: HUB, peers: [{ machineId: BOX, alias: "box-1.invalid", node: "/home/fixture/node", pi: "/home/fixture/pi", cli: "/home/fixture/spider", core: "/home/fixture/hc", globalRoot: "/home/fixture/global" }], discoveryRoots: [], coreUnit: "fixture.service", intercom: disabledIntercom() };
  const box = { ...config, role: "box" as const, machineId: BOX, peers: [] };
  for (const [directory, value] of [[root, config], [remote, box]] as const) {
    writeFileSync(join(directory, "roam", "config.json"), JSON.stringify(value), { mode: 0o600 });
    writeFileSync(join(directory, "roam", "machine.json"), JSON.stringify({ machineId: value.machineId }), { mode: 0o600 });
  }
  enrollFixtureCore(remote);
  const db = openDb(join(remote, "spider.db")); databases.push(db); migrate(db, "global", { machineId: BOX, globalRoot: remote });
  db.prepare("UPDATE roam_meta SET capture_enabled=1 WHERE id=1").run();
  const owner = { pid: 201, startIdentity: "previous-supervisor" };
  const id = await claimIdLock(join(remote, "herdr"), "session-1", owner, async () => ({ kind: "live", startIdentity: owner.startIdentity }), { bootId: async () => "boot-1" });
  const handoff = await id.prepareHandoff("launch-1", join(remote, "session.jsonl"), "core-1");
  const journal = openJournal(join(remote, "roam", "journal.db"));
  const ports = { config: readLocalIdentity(remote), root: join(remote, "roam", "staging"), journal, openStore() { return { db }; } };
  vi.stubEnv("HOME", root); vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/home/fixture/hc" } } as never);
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ async resolve(peer: unknown) { return peer; }, async exec(_peer: unknown, argv: string[]) {
    if (argv[1] === "agent") return Buffer.from(JSON.stringify(await handleAgentOperation(JSON.parse(argv[2]), ports as never)));
    expect(argv).toEqual(["roam", "observe", "doctor"]);
    return Buffer.from(JSON.stringify({ version: 1, machineId: BOX, kind: "doctor", value: await runLocalDoctor({ root: remote, bundleUrl, currentCore: async () => "core-1", launchRecovery: { bootId: async () => "boot-1", probe: async () => ({ kind: "absent" }) } }) }));
  } } as never);
  const out: string[] = [], err: string[] = [];
  const invoke = async (args: string[]) => { out.length = 0; err.length = 0; const code = await main(args, { out: text => out.push(text), err: text => err.push(text) }, { bundleUrl }); return { code, value: JSON.parse(out.join("")), err: err.join("") }; };
  return { root, remote, invoke, db, handoff, owner, journal, ports, bundleUrl };
}

async function releasedControlsFixture() {
  const f = await fixture(), file = join(f.remote, "session.jsonl"), stateRoot = join(f.remote, "herdr");
  const intent = { sessionId: "session-1", epoch: 1, desired: "stopped" as const, suspended: null, file, cwd: f.remote, moveId: null };
  f.db.prepare("UPDATE roam_meta SET store_key='global' WHERE id=1").run();
  f.db.prepare("INSERT INTO session_homes VALUES (?,?,1,NULL,1)").run("session-1", BOX);
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: f.remote }) + "\n", { mode: 0o600 });
  const authority = createRunningIntentAuthority(f.db), intents = createIntentStore(f.remote);
  await authority.set(intent, "start-1", { kind: "box-participant", machineId: BOX, hubMachineId: HUB });
  await intents.update("session-1", null, { intent, failures: [], supervision: { kind: "launching", phase: "invoking", operationId: "launch-1" } });
  const leases = createSessionLeases(stateRoot), child = { pid: 202, startIdentity: "child-start" };
  const lease = await leases.claim(file, f.owner, { leases, presence: createProcessPresence(stateRoot), probe: async () => ({ kind: "absent" }), processes: async () => [] }, { mode: "cutover", bootId: "boot-1" });
  await writeLaunchHandoff(stateRoot, { version: 1, operationId: "launch-1", sessionId: "session-1", sessionFile: file, nonce: f.handoff.nonce, leaseToken: lease.token });
  const adopted = await claimIdLock(stateRoot, "session-1", child, async () => ({ kind: "live", startIdentity: child.startIdentity }), { bootId: async () => "boot-1", handoff: f.handoff });
  await leases.adopt(file, lease.token, child);
  await removeLaunchHandoff(stateRoot, "launch-1");
  await leases.release(file, lease.token, { mode: "cutover" });
  await adopted.release();
  f.journal.begin({ id: "launch-1", kind: "exact-session-launch", machineId: BOX, expectedEpoch: 1, args: { sessionId: "session-1" } });
  f.journal.record("launch-1", "exact-attempt", { attemptId: "attempt-1" });
  f.journal.record("launch-1", "exact-core", { coreId: "core-1" });
  f.journal.record("launch-1", "exact-hc-started", { pid: 301, startTime: "hc-start", bootId: "boot-1" });
  f.journal.record("launch-1", "exact-hc-exited", { pid: 301, exitedAt: 50 });
  f.journal.record("launch-1", "exact-terminal", { terminalId: "terminal-1" });
  return { ...f, file, stateRoot, authority, intents, leases, child };
}

it("stop settles a consumed handoff only after the released adopted owner exits", async () => {
  const f = await releasedControlsFixture(), history = f.journal.read("launch-1"); let alive = true;
  expect(await inspectIdLock(f.stateRoot, "session-1")).toBeNull();
  expect(await inspectReleasedIdLock(f.stateRoot, "session-1", "launch-1")).toMatchObject({ identity: f.child });
  expect(await f.leases.get(f.file)).toBeNull();
  const recovery = { bootId: async () => "boot-1", probe: async () => alive ? { kind: "live" as const, startIdentity: f.child.startIdentity } : { kind: "absent" as const },
    hc: createLocalExactHc({ coreId: async () => "core-1", async invoke() { throw new Error("released adoption needs no terminal listing"); }, async invokeTracked() { throw new Error("stop cannot launch"); } }) };
  const operation = { id: "stop-released", kind: "session-stop", machineId: BOX, expectedEpoch: 1, args: { sourceMachine: HUB, sessionId: "session-1" } };
  expect(await handleSessionOperation(operation, f.ports as never, { wake: async () => {}, launchRecovery: recovery })).toMatchObject({ code: 3, reason: "launch-reconciliation-required" });
  expect(f.journal.read("launch-1")).toEqual(history);
  expect((await f.intents.get("session-1"))?.value.supervision.kind).toBe("launching");
  alive = false;
  const stopped = await handleSessionOperation(operation, f.ports as never, { wake: async () => {}, launchRecovery: recovery });
  expect(stopped).toMatchObject({ code: 0, reason: "stopped-intent" });
  expect(await f.authority.get("session-1")).toMatchObject({ desired: "stopped" });
  expect((await f.intents.get("session-1"))?.value.supervision).toEqual({ kind: "idle", nextAttemptAt: null });
  const settled = f.journal.read("launch-1");
  expect(settled.slice(0, history.length)).toEqual(history);
  expect(settled.filter(row => row.action === "exact-launch-settled")).toHaveLength(1);
  expect(await handleSessionOperation(operation, f.ports as never, { wake: async () => {}, launchRecovery: recovery })).toEqual(stopped);
  expect(await handleSessionOperation({ ...operation, id: "stop-released-again" }, f.ports as never, { wake: async () => {}, launchRecovery: recovery })).toMatchObject({ code: 0, reason: "stopped-intent" });
  expect(f.journal.read("launch-1")).toEqual(settled);
});

it.each(["live", "unknown", "probe-unavailable", "pid-reused", "different-boot"] as const)(
  "doctor explains a released adopted owner's %s status without inventing a core failure", async state => {
  const f = await releasedControlsFixture();
  const rows = await localPendingLaunchDiagnostics({ root: f.remote, machineId: BOX, currentCore: async () => "core-1",
    launchRecovery: { bootId: async () => state === "different-boot" ? "boot-2" : "boot-1", probe: async () => {
      if (state === "probe-unavailable") throw new Error("probe unavailable");
      return state === "live" ? { kind: "live", startIdentity: f.child.startIdentity }
        : state === "pid-reused" ? { kind: "live", startIdentity: "new-start" }
        : state === "different-boot" ? { kind: "absent" } : { kind: "unknown" };
    } } });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ severity: "block", repairCommand: null });
  expect(rows[0].reason).toMatch(state === "live" ? /adopted owner is still running/i : /owner's status is unavailable/i);
  expect(rows[0].reason).not.toMatch(/core.*unavailable|spider roam doctor/i);
  expect(rows[0].reason).toMatch(state === "live" ? /supported shutdown path.*spider roam stop session-1/i : /process.*boot.*inspection.*spider roam stop session-1/i);
  expect((await f.intents.get("session-1"))?.value.supervision.kind).toBe("launching");
  expect(f.journal.read("launch-1").some(row => row.action === "exact-launch-settled")).toBe(false);
});

it.each(["live", "unknown", "absent"] as const)("disabled doctor retains the released-owner %s diagnosis in its public report", async state => {
  const f = await releasedControlsFixture(), history = f.journal.read("launch-1");
  const report = await runLocalDoctor({ root: f.remote, bundleUrl: f.bundleUrl, currentCore: async () => "core-1",
    launchRecovery: { bootId: async () => "boot-1", probe: async () => state === "live" ? { kind: "live", startIdentity: f.child.startIdentity } : { kind: state } } });
  expect(report.enabled).toBe(false);
  expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
    severity: state === "absent" ? "warning" : "block",
    reason: expect.stringMatching(state === "live" ? /adopted owner is still running/i : state === "unknown" ? /owner's status is unavailable/i : /exited before readiness/i),
    repairCommand: state === "absent" ? "spider roam stop session-1" : null,
  })]));
  expect(f.journal.read("launch-1")).toEqual(history);
});

it.each(["live", "pid-reused", "unknown"] as const)("doctor reports the file lease holder's %s identity without blaming the exited owner", async state => {
  const f = await releasedControlsFixture();
  await f.leases.claim(f.file, { pid: 401, startIdentity: "lease-start" }, { leases: f.leases, presence: createProcessPresence(f.stateRoot),
    probe: async () => ({ kind: "absent" }), processes: async () => [] }, { mode: "cutover", bootId: "boot-1" });
  const rows = await localPendingLaunchDiagnostics({ root: f.remote, machineId: BOX, currentCore: async () => "core-1", launchRecovery: {
    bootId: async () => "boot-1", probe: async pid => pid !== 401 ? { kind: "absent" } : state === "unknown" ? { kind: "unknown" }
      : { kind: "live", startIdentity: state === "live" ? "lease-start" : "reused-start" },
  } });
  expect(rows).toEqual([expect.objectContaining({ severity: "block", reason: expect.stringMatching(state === "live"
    ? /file lease.*live process.*supported shutdown path.*stop session-1/i : /owner's status is unavailable.*restore local process and boot identity inspection/i), repairCommand: null })]);
  expect(rows[0].reason).not.toMatch(/adopted owner is still running|core.*unavailable/i);
});

it("doctor offers stop for an uninvoked reservation without consulting core or inventing an owner", async () => {
  const f = await releasedControlsFixture();
  rmSync(join(f.stateRoot, "id-lock-releases"), { recursive: true });
  const current = (await f.intents.get("session-1"))!;
  await f.intents.update("session-1", current.version, { ...current.value, supervision: { kind: "launching", phase: "reserved", operationId: "launch-1" } });
  const rows = await localPendingLaunchDiagnostics({ root: f.remote, machineId: BOX, currentCore: async () => { throw new Error("uninvoked reservation needs no core check"); } });
  expect(rows).toEqual([expect.objectContaining({ severity: "block", reason: expect.stringMatching(/launch has not been invoked/i), repairCommand: "spider roam stop session-1" })]);
});

it("doctor offers stop when a released adopted owner has positively exited", async () => {
  const f = await releasedControlsFixture();
  expect(await localPendingLaunchDiagnostics({ root: f.remote, machineId: BOX, currentCore: async () => "core-1",
    launchRecovery: { bootId: async () => "boot-1", probe: async () => ({ kind: "absent" }) } })).toEqual([
    expect.objectContaining({ severity: "warning", reason: expect.stringMatching(/exited before readiness/i), repairCommand: "spider roam stop session-1" }),
  ]);
});

it.each(["core-unavailable", "pin-required", "core-available"] as const)(
  "doctor checks actual %s evidence for an invoking reservation without an adopted owner", async state => {
  const f = await releasedControlsFixture();
  rmSync(join(f.stateRoot, "id-lock-releases"), { recursive: true });
  if (state === "pin-required") rmSync(join(f.remote, "roam", "core.json"));
  const rows = await localPendingLaunchDiagnostics({ root: f.remote, machineId: BOX,
    currentCore: async () => state === "core-unavailable" ? null : "fixture-core",
    launchRecovery: { bootId: async () => "boot-1", probe: async () => ({ kind: "absent" }) } });
  expect(rows).toHaveLength(1);
  expect(rows[0].severity).toBe("block");
  expect(rows[0].reason).not.toMatch(/spider roam doctor/i);
  if (state === "pin-required") {
    expect(rows[0]).toMatchObject({ reason: expect.stringMatching(/core-pin-required/i), repairCommand: `spider roam provision ${BOX}` });
  } else {
    expect(rows[0].repairCommand).toBeNull();
    expect(rows[0].reason).toMatch(state === "core-unavailable" ? /core identity is unavailable.*start the pinned core/i : /adopted-owner evidence is unavailable.*core is available/i);
  }
});

it("disabled remote doctor and enable agree on the pending launch and its stop repair", async () => {
  const f = await fixture();
  const doctor = await f.invoke(["roam", "doctor", "box-1.invalid", "--json"]);
  expect(doctor.code).toBe(1);
  expect(doctor.value.value).toMatchObject({ enabled: false, consumers: [] });
  expect(doctor.value.value.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "block", reason: expect.stringMatching(/session-1.*launch-1.*pending/i), repairCommand: "spider roam stop session-1" })]));
  const enable = await f.invoke(["roam", "enable", "--json"]);
  expect(enable.code).toBe(1);
  expect(enable.value.value.issues).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining("exact-launch"), repairCommand: "spider roam stop session-1" })]));
  expect(JSON.stringify(enable.value)).not.toContain("spider roam provision");
});

it("doctor and enable clear the missing started terminal block after stop settles", async () => {
  const f = await fixture(), file = join(f.remote, "session.jsonl"), stateRoot = join(f.remote, "herdr");
  const intent = { sessionId: "session-1", epoch: 1, desired: "running" as const, suspended: null, file, cwd: f.remote, moveId: null };
  f.db.prepare("UPDATE roam_meta SET store_key='global' WHERE id=1").run();
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: f.remote }) + "\n", { mode: 0o600 });
  f.db.prepare("INSERT INTO session_homes VALUES (?,?,1,NULL,1)").run("session-1", BOX);
  const worktree = createReplica("worktree", BOX); replicas.push(worktree);
  worktree.db.prepare("UPDATE roam_meta SET capture_enabled=1 WHERE id=1").run();
  worktree.db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES (?,1,?)").run("session-1", BOX);
  worktree.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,1,'active')").run("session-1");
  recordLocation(f.db, { sessionId: "session-1", stores: [worktree.storeKey], home: null, file, cwd: f.remote });
  const authority = createRunningIntentAuthority(f.db), intents = createIntentStore(f.remote);
  await authority.set(intent, "resume-1", { kind: "box-participant", machineId: BOX, hubMachineId: HUB });
  await authority.stop("session-1");
  await intents.update("session-1", null, { intent, failures: [], supervision: { kind: "launching", phase: "invoking", operationId: "launch-1" } });
  const leases = createSessionLeases(stateRoot), probe = async () => ({ kind: "live" as const, startIdentity: f.owner.startIdentity });
  const lease = await leases.claim(file, f.owner, { leases, presence: createProcessPresence(stateRoot), probe, processes: async () => [] }, { mode: "cutover", bootId: "boot-1" });
  const handoff = f.handoff;
  await writeLaunchHandoff(stateRoot, { version: 1, operationId: "launch-1", sessionId: "session-1", sessionFile: file, nonce: handoff.nonce, leaseToken: lease.token });
  f.journal.begin({ id: "launch-1", kind: "exact-session-launch", machineId: BOX, expectedEpoch: 1, args: { sessionId: "session-1" } });
  f.journal.record("launch-1", "exact-attempt", { attemptId: "attempt-1" });
  f.journal.record("launch-1", "exact-core", { coreId: "core-1" });
  f.journal.record("launch-1", "exact-hc-started", { pid: 301, startTime: "hc-start", bootId: "boot-1" });
  f.journal.record("launch-1", "exact-hc-exited", { pid: 301, exitedAt: 50 });
  f.journal.record("launch-1", "exact-terminal", { terminalId: "terminal-1" });
  const beforeDoctor = await f.invoke(["roam", "doctor", "box-1.invalid", "--json"]), beforeEnable = await f.invoke(["roam", "enable", "--json"]);
  expect(beforeDoctor.value.value.diagnostics.some((row: { reason: string }) => /exact launch.*pending/i.test(row.reason))).toBe(true);
  expect(beforeEnable.value.value.issues.some((row: { reason: string }) => row.reason.includes("exact-launch"))).toBe(true);
  let now = 100;
  const hc = createLocalExactHc({ coreId: async () => "core-1", async invoke() { return { terminals: [] }; }, async invokeTracked() { throw new Error("stop cannot launch"); } });
  expect(await handleSessionOperation({ id: "stop-1", kind: "session-stop", machineId: BOX, expectedEpoch: 1, args: { sourceMachine: HUB, sessionId: "session-1" } }, { ...f.ports, openStore(key: string) { return { db: key === "global" ? f.db : worktree.db }; } } as never,
    { wake: async () => {}, launchRecovery: { hc, bootId: async () => "boot-1", probe: async () => ({ kind: "absent" }), clock: { now: () => now, wait: async ms => { now += ms; } } } })).toMatchObject({ code: 0, reason: "stopped-intent" });
  const afterDoctor = await f.invoke(["roam", "doctor", "box-1.invalid", "--json"]), afterEnable = await f.invoke(["roam", "enable", "--json"]);
  expect(afterDoctor.value.value.diagnostics.filter((row: { reason: string }) => /exact launch.*pending/i.test(row.reason))).toEqual([]);
  expect(afterEnable.value.reason).not.toContain("exact-launch");
  expect((afterEnable.value.value?.issues ?? []).filter((row: { reason: string }) => row.reason.includes("exact-launch"))).toEqual([]);
  expect(await authority.get("session-1")).toMatchObject({ desired: "stopped" });
  expect((await intents.get("session-1"))?.value).toMatchObject({ intent: { desired: "stopped" }, supervision: { kind: "idle" } });
});

it("enable prescribes stop rather than provision for the persisted pending launch", async () => {
  const f = await fixture(), enable = await f.invoke(["roam", "enable", "--json"]);
  expect(enable.code).toBe(1);
  expect(enable.value.value.issues).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining("exact-launch"), repairCommand: "spider roam stop session-1" })]));
  expect(JSON.stringify(enable.value)).not.toContain("spider roam provision");
});

it("disabled local box doctor still returns a pending-launch block", async () => {
  const f = await fixture(); vi.stubEnv("SPIDER_GLOBAL_ROOT", f.remote);
  const doctor = await f.invoke(["roam", "doctor", "--json"]);
  expect(doctor.code).toBe(1);
  expect(doctor.value.reason).toBe("doctor-blocked");
  expect(doctor.value.value.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "block", reason: expect.stringMatching(/session-1.*launch-1.*pending/i), repairCommand: "spider roam stop session-1" })]));
});
