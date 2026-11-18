import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { recordLocation } from "@spider/db-core/roam/catalog";
import type { Readiness } from "@spider/db-core/roam/types";
import type { HcClient, TerminalSummary } from "@spider/herdr";
import * as hcModule from "@spider/herdr/client/hc";
import * as hostReadiness from "../../../host/src/roam/readiness";
import * as runtimeModule from "../runtime";
import * as hubModule from "../production-hub";
import * as launcherModule from "../launcher";
import * as participantModule from "../participant-supervisor";
import { startProductionSupervisor } from "../production-supervisor";
import type { Clock } from "../contracts";
import { createParticipantSupervisor } from "../participant-supervisor";
import { parseConfig } from "../config";
import { openJournal } from "../journal";
import { createIntentStore } from "../intent";
import { createRunningIntentAuthority, recordReadiness } from "../session-control";
import { observeHosting } from "../hosting";
import { enrollFixtureCore } from "./supervisor-core-fixture";

const BOX = "00000000-0000-4000-8000-000000000002", HUB = "00000000-0000-4000-8000-000000000001", OTHER = "00000000-0000-4000-8000-000000000003";
const roots: ReturnType<typeof createReplica>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) root.close(); });
it("reconnect reports new terminal for placement and durable suspension", async () => {
  const f = createReplica("global", BOX); roots.push(f);
  const journal = openJournal(join(f.root, "roam", "journal.db")), authority = createRunningIntentAuthority(f.db), intents = createIntentStore(f.root);
  const intent = { sessionId: "s-1", epoch: 1, file: join(f.root, "s.jsonl"), cwd: f.root, desired: "running" as const, suspended: null, moveId: null };
  f.db.prepare("INSERT INTO session_homes VALUES (?,?,1,NULL,1)").run("s-1", BOX);
  await authority.set(intent, "launch-1", { kind: "box-participant", machineId: BOX, hubMachineId: HUB });
  const ports = { db: f.db, journal, authority, intents, machineId: BOX, hubMachineId: HUB, async live() { return true; }, async terminalOutcome() { return "unknown" as const; } };
  for (const [operationId, terminal] of [["launch-1", "terminal-1"], ["launch-2", "terminal-2"]]) {
    journal.begin({ id: operationId, kind: "exact-session-launch", machineId: BOX, expectedEpoch: 1, args: {} });
    const ready = { origin: "hub-operation" as const, opId: operationId, sessionId: "s-1", epoch: 1, cwd: f.root, file: intent.file, core: "core-1", terminal };
    recordReadiness(journal, ready); writeLocal(f.db, "participant-ready", "s-1", ready);
    expect((await observeHosting(ports)).readiness).toEqual([ready]);
  }
  await intents.update("s-1", null, { intent: { ...intent, suspended: "missing auth" }, failures: [], supervision: { kind: "idle", nextAttemptAt: null } });
  expect(await observeHosting(ports)).toEqual({ readiness: [], suspensions: [{ sessionId: "s-1", epoch: 1 }] });
}, 5000);

it("a box-local owner is observable before sync but not under a foreign home", async () => {
  const f = createReplica("global", BOX); roots.push(f);
  const authority = createRunningIntentAuthority(f.db), journal = openJournal(join(f.root, "roam", "journal.db"));
  const origin = { kind: "box-local", machineId: BOX, epoch: 1, file: join(f.root, "s.jsonl"), cwd: f.root, pid: process.pid, startIdentity: "owner", stopped: false };
  const ready = { origin: "box-local", machineId: BOX, sessionId: "s-1", epoch: 1, file: origin.file, cwd: origin.cwd, core: "core-1", terminal: "term-1" };
  writeLocal(f.db, "participant-origin", "s-1", origin); writeLocal(f.db, "participant-ready", "s-1", ready);
  const ports = { db: f.db, journal, authority, intents: createIntentStore(f.root), machineId: BOX, hubMachineId: HUB, async live() { return true; }, async terminalOutcome() { return "unknown" as const; } };
  expect((await observeHosting(ports)).readiness).toEqual([ready]);
  f.db.prepare("INSERT INTO session_homes VALUES (?,?,1,NULL,1)").run("s-1", OTHER);
  expect((await observeHosting(ports)).readiness).toEqual([]);
}, 5000);

it.each(["missing-home", "wrong-machine", "new-epoch", "wrong-move", "untrusted-intent"])("does not advertise %s authority", async scenario => {
  const f = createReplica("global", BOX); roots.push(f);
  const journal = openJournal(join(f.root, "roam", "journal.db")), authority = createRunningIntentAuthority(f.db);
  const intent = { sessionId: "s-1", epoch: 1, file: join(f.root, "s.jsonl"), cwd: f.root, desired: "running" as const, suspended: null, moveId: null };
  if (scenario !== "missing-home") f.db.prepare("INSERT INTO session_homes VALUES (?,?,?,?,1)").run("s-1", scenario === "wrong-machine" ? OTHER : BOX, scenario === "new-epoch" ? 2 : 1, scenario === "wrong-move" ? "move-2" : null);
  await authority.set(intent, "launch-1", { kind: "box-participant", machineId: scenario === "untrusted-intent" ? OTHER : BOX, hubMachineId: HUB });
  journal.begin({ id: "launch-1", kind: "exact-session-launch", machineId: BOX, expectedEpoch: 1, args: {} });
  const ready = { origin: "hub-operation" as const, opId: "launch-1", sessionId: "s-1", epoch: 1, cwd: f.root, file: intent.file, core: "core-1", terminal: "term-1" };
  recordReadiness(journal, ready); writeLocal(f.db, "participant-ready", "s-1", ready);
  const ports = { db: f.db, journal, authority, intents: createIntentStore(f.root), machineId: BOX, hubMachineId: HUB, async live() { return true; }, async terminalOutcome() { return "unknown" as const; } };
  expect(await observeHosting(ports)).toEqual({ readiness: [], suspensions: [] });
}, 5000);

it("stopped or unproved owners never advertise an old readiness receipt", async () => {
  const f = createReplica("global", BOX); roots.push(f);
  const authority = createRunningIntentAuthority(f.db), journal = openJournal(join(f.root, "roam", "journal.db"));
  const intent = { sessionId: "s-1", epoch: 1, file: join(f.root, "s.jsonl"), cwd: f.root, desired: "running" as const, suspended: null, moveId: null };
  f.db.prepare("INSERT INTO session_homes VALUES (?,?,1,NULL,1)").run("s-1", BOX);
  await authority.set(intent, "launch-1", { kind: "box-participant", machineId: BOX, hubMachineId: HUB }); journal.begin({ id: "launch-1", kind: "exact-session-launch", machineId: BOX, expectedEpoch: 1, args: {} });
  const ready = { origin: "hub-operation" as const, opId: "launch-1", sessionId: "s-1", epoch: 1, cwd: f.root, file: intent.file, core: "core-1", terminal: "old-terminal" };
  recordReadiness(journal, ready); writeLocal(f.db, "participant-ready", "s-1", ready);
  const ports = { db: f.db, journal, authority, intents: createIntentStore(f.root), machineId: BOX, hubMachineId: HUB, async live() { return false; }, async terminalOutcome() { return "unknown" as const; } };
  expect((await observeHosting(ports)).readiness).toEqual([]);
  await authority.stop("s-1");
  expect((await observeHosting({ ...ports, live: async () => true })).readiness).toEqual([]);
}, 5000);

async function executionFixture(epoch = 2) {
  const global = createReplica("global", BOX), worktree = createReplica("worktree", BOX);
  roots.push(global, worktree);
  const config = parseConfig({ role: "box", machineId: BOX, hubMachineId: HUB, coreUnit: "fixture.service" });
  const file = join(worktree.root, "s.jsonl"), cwd = worktree.root;
  writeFileSync(file, '{"type":"session","id":"s-1"}\n', { mode: 0o600 });
  global.db.prepare("UPDATE roam_meta SET capture_enabled=1 WHERE id=1").run();
  worktree.db.prepare("UPDATE roam_meta SET capture_enabled=1 WHERE id=1").run();
  worktree.db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES (?,?,?)").run("s-1", 1, BOX);
  worktree.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,?,'active')").run("s-1", epoch);
  global.db.prepare("INSERT INTO session_homes VALUES (?,?,?,NULL,1)").run("s-1", BOX, epoch);
  recordLocation(global.db, { sessionId: "s-1", stores: [worktree.storeKey], home: null, file, cwd });
  const journal = openJournal(join(global.root, "roam", "journal.db"));
  const authority = createRunningIntentAuthority(global.db), intents = createIntentStore(global.root);
  const intent = { sessionId: "s-1", epoch, file, cwd, desired: "running" as const, suspended: null, moveId: null };
  await authority.set(intent, "start-1", { kind: "box-participant", machineId: BOX, hubMachineId: HUB });
  const ready = { origin: "hub-operation" as const, opId: "launch-current", sessionId: "s-1", epoch, file, cwd, core: "execution-core", terminal: "execution-terminal" };
  journal.begin({ id: ready.opId, kind: "exact-session-launch", machineId: BOX, expectedEpoch: epoch, args: {} });
  recordReadiness(journal, ready); writeLocal(global.db, "participant-ready", "s-1", ready);
  const agent = { config, journal, root: join(global.root, "roam", "staging"), openStore(key: string) {
    if (key === "global") return { db: global.db, effects: {} as never, policy: {} as never };
    if (key === worktree.storeKey) return { db: worktree.db, effects: {} as never, policy: {} as never };
    throw new Error("Unexpected store");
  } };
  const ports = { db: global.db, journal, authority, intents, machineId: BOX, hubMachineId: HUB };
  return { global, worktree, config, agent, ports, authority, intents, journal, intent, ready };
}

function executionTerminal(ready: Extract<Readiness, { origin: "hub-operation" }>, fields: Partial<TerminalSummary> = {}): TerminalSummary {
  return { address: ready.terminal as never, parent: null, state: "finished", status: null, exitCode: null,
    reason: "killed", signal: null, finishedAt: 1,
    labels: { "spider.kind": "session", "spider.session": ready.sessionId, "spider.roam.epoch": String(ready.epoch), "spider.roam.operation": ready.opId },
    ...fields };
}

function outcomeReader(hc: HcClient) {
  return hostReadiness.createNativeHostingOutcomeReader(hc);
}

function fakeHc(core: string, terminals: Record<string, TerminalSummary>): HcClient {
  return { async identity() { return { coreId: core, socket: "/fixture/socket", sessionNamespace: "fixture" }; },
    async get(address: string) { const result = terminals[address]; if (!result) throw new Error("terminal unavailable"); return result; } } as HcClient;
}

it("native killed current execution terminal stops hosting before restart", async () => {
  const f = await executionFixture();
  let launches = 0;
  const supervisor = createParticipantSupervisor({ root: f.global.root, agent: f.agent,
    clock: { now: () => 1, later: () => () => {} }, events: { subscribe: () => () => {} },
    owner: async () => ({ kind: "absent" }), diagnostics: async () => [], stop: async () => ({ kind: "absent" }), notify: async () => {},
    async launch(intent, operationId) { launches++; return { code: 3, reason: "pending", operationId, home: null, epoch: intent.epoch, repairCommand: null, value: null }; } });
  try {
    await observeHosting({ ...f.ports, live: async () => false, terminalOutcome: async () => "killed" });
    await supervisor.reconcile();
    expect(await f.authority.get("s-1")).toMatchObject({ desired: "stopped", epoch: 2 });
    expect(launches).toBe(0);
  } finally { await supervisor.stop(); }
}, 5000);

it("killed Mac proxy cannot stop remote hosting", async () => {
  const f = await executionFixture();
  const proxy = executionTerminal(f.ready, { address: "proxy-terminal" as never, labels: { "spider.kind": "pane-proxy" } });
  const target = executionTerminal(f.ready, { state: "live", reason: null, finishedAt: null });
  const hc = fakeHc(f.ready.core, { [f.ready.terminal]: target, "proxy-terminal": proxy });
  const get = vi.spyOn(hc, "get"), reader = outcomeReader(hc);
  expect(await reader(f.ready)).toBe("live");
  await observeHosting({ ...f.ports, live: async () => true, terminalOutcome: reader });
  expect(await f.authority.get("s-1")).toMatchObject({ desired: "running", epoch: 2 });
  expect(get.mock.calls.map(([address]) => address)).toEqual(["execution-terminal"]);
}, 5000);

it.each(["server_stop", "host_shutdown", "holder_lost"])("core loss retains running intent (%s)", async reason => {
  const f = await executionFixture(), terminal = executionTerminal(f.ready, { reason });
  const reader = outcomeReader(fakeHc(f.ready.core, { [f.ready.terminal]: terminal }));
  expect(await reader(f.ready)).toBe("core-loss");
  await observeHosting({ ...f.ports, live: async () => false, terminalOutcome: reader });
  expect(await f.authority.get("s-1")).toMatchObject({ desired: "running", epoch: 2 });
}, 5000);

it("handoff kill cannot stop successor home", async () => {
  const f = await executionFixture();
  await observeHosting({ ...f.ports, live: async () => false, async terminalOutcome() {
    f.global.db.prepare("UPDATE session_homes SET machine_id=?,epoch=?,move_id=? WHERE session_id=?").run(OTHER, 3, "move-next", "s-1");
    await f.authority.set({ ...f.intent, epoch: 3, moveId: "move-next" }, "start-next", { kind: "box-participant", machineId: OTHER, hubMachineId: HUB });
    return "killed";
  } });
  expect(await f.authority.get("s-1")).toMatchObject({ desired: "running", epoch: 3, moveId: "move-next" });
}, 5000);

it.each([
  { state: "live" as const, reason: null, want: "live" },
  { state: "finished" as const, reason: "killed", want: "killed" },
  { state: "finished" as const, reason: "exited", want: "unexpected-exit" },
  { state: "finished" as const, reason: "signaled", want: "unexpected-exit" },
  { state: "finished" as const, reason: "stopped_by_restart", want: "unexpected-exit" },
  { state: "finished" as const, reason: null, want: "unknown" },
])("classifies a matching execution as $want", async ({ state, reason, want }) => {
  const f = await executionFixture(), terminal = executionTerminal(f.ready, { state, reason, signal: reason === "signaled" ? 9 : null });
  const reader = outcomeReader(fakeHc(f.ready.core, { [f.ready.terminal]: terminal }));
  expect(await reader(f.ready)).toBe(want);
}, 5000);

it("a core change during the terminal read is unknown", async () => {
  const f = await executionFixture(), hc = fakeHc(f.ready.core, { [f.ready.terminal]: executionTerminal(f.ready) });
  vi.spyOn(hc, "identity").mockResolvedValueOnce({ coreId: f.ready.core, socket: "/fixture/socket", sessionNamespace: "fixture" } as never)
    .mockResolvedValueOnce({ coreId: "replacement-core", socket: "/fixture/socket", sessionNamespace: "fixture" } as never);
  const reader = outcomeReader(hc);
  expect(await reader(f.ready)).toBe("unknown");
}, 5000);

it.each(["another-core/execution-terminal", "execution-core/extra/execution-terminal"])("a foreign or malformed qualified terminal %s is unknown", async address => {
  const f = await executionFixture(), ready = { ...f.ready, terminal: address };
  const reader = outcomeReader(fakeHc(ready.core, { [address]: executionTerminal(ready) }));
  expect(await reader(ready)).toBe("unknown");
}, 5000);

it("a stale killed outcome from an earlier launch cannot stop the current launch", async () => {
  const f = await executionFixture(), old = executionTerminal(f.ready, { labels: {
    "spider.kind": "session", "spider.session": "s-1", "spider.roam.epoch": "2", "spider.roam.operation": "launch-previous" } });
  const reader = outcomeReader(fakeHc(f.ready.core, { [f.ready.terminal]: old }));
  expect(await reader(f.ready)).toBe("unknown");
  await observeHosting({ ...f.ports, live: async () => false, terminalOutcome: reader });
  expect(await f.authority.get("s-1")).toMatchObject({ desired: "running", epoch: 2 });
}, 5000);

it.each(["core", "address", "session", "epoch", "proxy"] as const)("unverified %s never grants an execution stop", async mismatch => {
  const f = await executionFixture(), terminal = executionTerminal(f.ready);
  if (mismatch === "address") terminal.address = "different-terminal" as never;
  if (mismatch === "session") terminal.labels = { ...terminal.labels, "spider.session": "other-session" };
  if (mismatch === "epoch") terminal.labels = { ...terminal.labels, "spider.roam.epoch": "1" };
  if (mismatch === "proxy") terminal.labels = { ...terminal.labels, "spider.kind": "pane-proxy" };
  const hc = fakeHc(mismatch === "core" ? "another-core" : f.ready.core, { [f.ready.terminal]: terminal });
  const reader = outcomeReader(hc);
  expect(await reader(f.ready)).toBe("unknown");
  await observeHosting({ ...f.ports, live: async () => false, terminalOutcome: reader });
  expect(await f.authority.get("s-1")).toMatchObject({ desired: "running", epoch: 2 });
}, 5000);

it("a resumed box-local session without a launch ID retains unknown and restart policy", async () => {
  const f = await executionFixture(1);
  const ready = { origin: "box-local" as const, machineId: BOX, sessionId: "s-1", epoch: 1,
    file: f.intent.file, cwd: f.intent.cwd, core: f.ready.core, terminal: f.ready.terminal };
  const origin = { kind: "box-local" as const, machineId: BOX, epoch: 1, file: ready.file, cwd: ready.cwd,
    pid: process.pid, startIdentity: "local-owner", stopped: false };
  writeLocal(f.global.db, "participant-origin", "s-1", origin);
  writeLocal(f.global.db, "participant-ready", "s-1", ready);
  await f.authority.set(f.intent, "resume-1", { kind: "box-participant", machineId: BOX, hubMachineId: HUB });
  const terminal = executionTerminal(f.ready, { labels: { "spider.kind": "session", "spider.session": "s-1" } });
  const reader = outcomeReader(fakeHc(ready.core, { [ready.terminal]: terminal }));
  expect(await reader(ready)).toBe("unknown");
  await observeHosting({ ...f.ports, live: async () => false, terminalOutcome: reader });
  let launches = 0;
  const supervisor = createParticipantSupervisor({ root: f.global.root, agent: f.agent,
    clock: { now: () => 1, later: () => () => {} }, events: { subscribe: () => () => {} },
    owner: async () => ({ kind: "absent" }), diagnostics: async () => [], stop: async () => ({ kind: "absent" }), notify: async () => {},
    async launch(intent, operationId) { launches++; return { code: 3, reason: "pending", operationId, home: null, epoch: intent.epoch, repairCommand: null, value: null }; } });
  try {
    await supervisor.reconcile();
    expect(await f.authority.get("s-1")).toMatchObject({ desired: "running", suspended: null, epoch: 1 });
    expect(launches).toBe(1);
  } finally { await supervisor.stop(); }
}, 5000);

it("a new launch reservation cannot be stopped by the old terminal", async () => {
  const f = await executionFixture();
  let observed = false;
  await observeHosting({ ...f.ports, live: async () => false, async terminalOutcome() {
    observed = true;
    await f.intents.update("s-1", null, { intent: f.intent, failures: [], supervision: { kind: "launching", operationId: "launch-next", phase: "invoking" } });
    return "killed";
  } });
  expect(observed).toBe(true);
  expect(await f.authority.get("s-1")).toMatchObject({ desired: "running", epoch: 2 });
}, 5000);

it("a newer same-epoch authority during liveness checking cannot be stopped by an older launch", async () => {
  const f = await executionFixture();
  await observeHosting({ ...f.ports, async live() {
    await f.authority.set(f.intent, "start-next", { kind: "box-participant", machineId: BOX, hubMachineId: HUB }); return false;
  }, terminalOutcome: async () => "killed" });
  expect(f.authority.operationId("s-1")).toBe("start-next");
  expect(await f.authority.get("s-1")).toMatchObject({ desired: "running", epoch: 2 });
}, 5000);

it("a later launch published while a kill is observed keeps running", async () => {
  const f = await executionFixture(), successor = { ...f.ready, opId: "launch-next" };
  f.journal.begin({ id: successor.opId, kind: "exact-session-launch", machineId: BOX, expectedEpoch: 2, args: {} });
  recordReadiness(f.journal, successor);
  await observeHosting({ ...f.ports, live: async () => false, async terminalOutcome() {
    writeLocal(f.global.db, "participant-ready", "s-1", successor); return "killed";
  } });
  expect(readLocal(f.global.db, "participant-ready", "s-1")).toEqual(successor);
  expect(await f.authority.get("s-1")).toMatchObject({ desired: "running", epoch: 2 });
}, 5000);

async function productionFixture(f: Awaited<ReturnType<typeof executionFixture>>, terminal: TerminalSummary, clock: Clock = { now: () => 1, later: () => () => {} }, events = true) {
  mkdirSync(join(f.global.root, "roam"), { recursive: true, mode: 0o700 });
  writeFileSync(join(f.global.root, "roam", "machine.json"), JSON.stringify({ machineId: BOX }), { mode: 0o600 });
  writeFileSync(join(f.global.root, "roam", "config.json"), JSON.stringify(f.config), { mode: 0o600 });
  enrollFixtureCore(f.global.root, f.ready.core);
  await f.global.db.raw.backup(join(f.global.root, "spider.db"));
  const agentDir = join(f.global.root, "agent"); mkdirSync(agentDir, { mode: 0o700 });
  writeFileSync(join(agentDir, "auth.json"), '{"fixture":true}', { mode: 0o600 });
  const hc = { ...fakeHc(f.ready.core, { [f.ready.terminal]: terminal }),
    events() { return { subscribe() { return () => {}; }, dispose() {} }; }, async dispose() {} };
  vi.spyOn(runtimeModule, "openLocalRuntime").mockReturnValue({ config: f.config, db: f.global.db, journal: f.journal, agent: f.agent, close() {} } as never);
  vi.spyOn(hubModule, "loadHerdrConfig").mockReturnValue({ agentDirectory: agentDir, core: { binary: "/fixture/hc" } } as never);
  vi.spyOn(hcModule, "createHcClient").mockReturnValue(hc as never);
  const restart = vi.fn(async () => { throw new Error("unexpected restart"); });
  vi.spyOn(launcherModule, "createProductionLocalExactHc").mockReturnValue({ coreId: restart, async dispose() {} } as never);
  const system = { inventory: { async probe() { return { kind: "live" as const, startIdentity: "fixture-process" }; } } } as never;
  let supervisor: ReturnType<typeof createParticipantSupervisor> | undefined;
  const create = participantModule.createParticipantSupervisor;
  vi.spyOn(participantModule, "createParticipantSupervisor").mockImplementation(input => supervisor = create(events ? input : { ...input, events: { subscribe: () => () => {} } }));
  const service = await startProductionSupervisor(f.global.root, { system, clock });
  if (!supervisor) throw new Error("Supervisor did not start");
  return { service, supervisor, restart };
}

it("production supervisor classifies a killed execution before a restart", async () => {
  const f = await executionFixture(), runtime = await productionFixture(f, executionTerminal(f.ready));
  try {
    await runtime.supervisor.reconcile();
    expect(await f.authority.get("s-1")).toMatchObject({ desired: "stopped", epoch: 2 });
    expect(runtime.restart).not.toHaveBeenCalled();
  } finally { await runtime.service.stop(); }
}, 5000);

it("a killed live execution never schedules a crash retry", async () => {
  const f = await executionFixture(), delays: number[] = [];
  await f.intents.update("s-1", null, { intent: f.intent, failures: [], supervision: {
    kind: "live", identity: { bootId: "boot-1", pid: 123, startTime: "start-1" }, stableSince: 1 } });
  const runtime = await productionFixture(f, executionTerminal(f.ready), { now: () => 10, later(delay) { delays.push(delay); return () => {}; } });
  try {
    await runtime.supervisor.reconcile();
    expect(await f.authority.get("s-1")).toMatchObject({ desired: "stopped", epoch: 2 });
    expect(delays).not.toContain(5000);
    expect(runtime.restart).not.toHaveBeenCalled();
  } finally { await runtime.service.stop(); }
}, 5000);

it("a native stop cancels a pending crash retry before another launch", async () => {
  const f = await executionFixture(), terminal = executionTerminal(f.ready, { reason: "exited" });
  const timers: { delay: number; cancelled: boolean }[] = [];
  await f.intents.update("s-1", null, { intent: f.intent, failures: [], supervision: {
    kind: "live", identity: { bootId: "boot-1", pid: 123, startTime: "start-1" }, stableSince: 1 } });
  const runtime = await productionFixture(f, terminal, { now: () => 10, later(delay) {
    const timer = { delay, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; };
  } }, false);
  try {
    await runtime.supervisor.reconcile();
    const retry = timers.find(timer => timer.delay === 5000);
    expect(retry).toMatchObject({ cancelled: false });
    terminal.reason = "killed";
    await runtime.supervisor.reconcile();
    expect(await f.authority.get("s-1")).toMatchObject({ desired: "stopped", epoch: 2 });
    expect(retry?.cancelled).toBe(true);
    expect(runtime.restart).not.toHaveBeenCalled();
  } finally { await runtime.service.stop(); }
}, 5000);

it.each(["exited", "signaled", "stopped_by_restart", "server_stop", "host_shutdown", "holder_lost", null])("production restart policy is unchanged for %s", async reason => {
  const f = await executionFixture(), runtime = await productionFixture(f, executionTerminal(f.ready, { reason, signal: reason === "signaled" ? 9 : null }));
  try {
    await runtime.supervisor.reconcile();
    expect(runtime.restart).toHaveBeenCalled();
    expect(await f.authority.get("s-1")).toMatchObject({ desired: "running", epoch: 2 });
  } finally { await runtime.service.stop(); }
}, 5000);

it("roaming is disabled by default and an ordinary session stays unchanged", async () => {
  const f = createReplica("global", BOX); roots.push(f);
  const config = parseConfig({ role: "box", machineId: BOX, hubMachineId: HUB, coreUnit: "fixture.service" });
  const terminal = vi.fn(async () => { throw new Error("ordinary session must not inspect hc"); });
  const stores = vi.fn(async () => { throw new Error("ordinary session must not create roaming stores"); });
  const hooks = hostReadiness.createParticipantAdmission({ cwd: () => f.root, terminal,
    async open() { return hostReadiness.openAdmissionRuntime(f.root, stores); } });
  await hooks.prepare("ordinary", join(f.root, "ordinary.jsonl"));
  await hooks.ready("ordinary", join(f.root, "ordinary.jsonl"), 1, null);
  await hooks.stopped("ordinary");
  expect(config.enabled).toBe(false);
  expect(existsSync(join(f.root, "roam", "config.json"))).toBe(false);
  expect(terminal).not.toHaveBeenCalled();
  expect(stores).not.toHaveBeenCalled();
}, 5000);


it("reports hosting warnings even when the intent view cannot be read, then clears them", async () => {
  const f = await executionFixture(), warning = { code: "supervisor-hosting-error", check: "inspection", since: 1, count: 3 };
  writeLocal(f.global.db, "supervisor-hosting-error", "s-1", warning);
  const get = vi.spyOn(f.ports.intents, "get").mockRejectedValue(new Error("unreadable"));
  const ports = { ...f.ports, live: async () => false, terminalOutcome: async () => "unknown" as const };
  const observed = await observeHosting(ports);
  expect(observed).toMatchObject({ warnings: [{ sessionId: "s-1", ...warning }], readiness: [], suspensions: [] });
  get.mockRestore();
  writeLocal(f.global.db, "supervisor-hosting-error", "s-1", undefined);
  expect((await observeHosting(ports)).warnings ?? []).toEqual([]);
});
