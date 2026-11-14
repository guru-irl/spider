import { expect, it } from "vitest";
import type { Home, Probe, SessionState } from "@spider/db-core/roam/types";
import type { HostIntent } from "../contracts";
import type { IntentState, IntentStore, VersionedIntent } from "../intent";
import { createDurableLaunchPort, type SupervisorPorts } from "../supervisor";

const local = "10e674f6-9567-4109-a66c-a6870586c3e1";
const remote = "cc675f62-57b4-4c33-9a9d-cd2d3e711fa3";
const intent: HostIntent = { sessionId: "session-1", epoch: 1, desired: "running", suspended: null,
  file: "/fixture/session.jsonl", cwd: "/fixture/work", moveId: null };
const active: SessionState = { sessionId: "session-1", epoch: 1, state: "active", moveId: null, freezeSeq: null };
const ready = { origin: "hub-operation" as const, opId: "launch-1", sessionId: "session-1", epoch: 1, cwd: intent.cwd, file: intent.file,
  core: "core-1", terminal: "terminal-1" };

async function supervisorModule() {
  const name = "../supervisor";
  const module = await import(name).catch(() => undefined);
  expect(module?.createSupervisor).toBeTypeOf("function");
  return module;
}

function fixture() {
  let now = 1_000_000;
  const timers: Array<{ at: number; delay: number; fn(): void; cancelled: boolean }> = [];
  const clock = { now: () => now, later(delay: number, fn: () => void) {
    const timer = { at: now + delay, delay, fn, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; };
  } };
  const rows = new Map<string, VersionedIntent>();
  rows.set(intent.sessionId, { version: 1, value: { intent: { ...intent }, failures: [], supervision: { kind: "idle", nextAttemptAt: null } } });
  const intents: IntentStore = {
    async list() { return [...rows.keys()].sort(); },
    async get(id) { return structuredClone(rows.get(id) ?? null); },
    async update(id, expected, next) {
      const currentVersion = rows.get(id)?.version ?? null;
      if (currentVersion !== expected) return { kind: "stale", currentVersion };
      const version = (currentVersion ?? 0) + 1;
      rows.set(id, { version, value: structuredClone(next) }); return { kind: "updated", version };
    },
  };
  const listeners = new Set<() => void>(), intentListeners = new Set<() => void>();
  let home: Home | null | "unknown" | "conflict" = { sessionId: intent.sessionId, machineId: local, epoch: 1, moveId: null, updatedAt: 1 };
  let origin = local, states: readonly SessionState[] = [active], unfinishedFreeze = false;
  let authoritative: HostIntent | null = { ...intent }, sequence = 0;
  let owner: Probe = { kind: "absent" };
  let diagnostics: Array<{ reason: string; severity: "warning" | "block"; repairCommand: string | null }> = [];
  const launches: Array<{ intent: HostIntent; at: number }> = [], notices: string[] = [], stops: string[] = [];
  const ports: SupervisorPorts = {
    clock, intents, runningIntents: {
      async list() { return authoritative ? [authoritative.sessionId] : []; },
      async get(id: string) { return authoritative?.sessionId === id ? { ...authoritative } : null; },
      subscribe(listener: () => void) { intentListeners.add(listener); return () => intentListeners.delete(listener); },
    }, events: { subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); } },
    journal: { begin() { return { kind: "new" as const, result: null }; }, record() {}, read() { return []; } },
    async inspect(id: string) { const row = await intents.get(id); if (!row) throw new Error("missing intent");
      if (!authoritative) throw new Error("missing authoritative intent");
      return { home, origin, localMachine: local, states, unfinishedFreeze, intent: { ...authoritative }, owner, diagnostics }; },
    launch: async () => { throw new Error("launch port is not initialized"); },
    async stop(id: string): Promise<Probe> { stops.push(id); owner = { kind: "absent" }; return owner; },
    async notify(_id: string, reason: string) { notices.push(reason); },
  };
  ports.launch = createDurableLaunchPort({ intents, operationId: () => `launch-${++sequence}`,
    async authorize(value) { return JSON.stringify(authoritative) === JSON.stringify(value); },
    async invoke({ intent: value, reservation }) {
      launches.push({ intent: value, at: now });
      owner = { kind: "live", identity: { bootId: "boot-1", pid: 100 + launches.length, startTime: `start-${launches.length}` } };
      return { code: 0, reason: "ready", operationId: reservation.operationId, home: typeof home === "object" ? home : null,
        epoch: value.epoch, repairCommand: null, value: { ...ready, opId: reservation.operationId } };
    },
  });
  return { ports, intents, launches, notices, stops, timers, listeners,
    now() { return now; },
    advance(ms: number) { now += ms; },
    fire(delay: number) {
      const timer = timers.find(item => !item.cancelled && item.delay === delay);
      if (!timer) throw new Error(`Missing timer ${delay}`);
      timer.cancelled = true; now = timer.at; timer.fn();
    },
    setHome(value: typeof home) { home = value; }, setOrigin(value: string) { origin = value; },
    setStates(value: readonly SessionState[]) { states = value; }, setFreeze(value: boolean) { unfinishedFreeze = value; },
    setOwner(value: Probe) { owner = value; }, setDiagnostics(value: typeof diagnostics) { diagnostics = value; },
    setAuthoritative(value: HostIntent | null) { authoritative = value; },
    deleteView() { rows.delete(intent.sessionId); },
    emitIntent() { for (const listener of [...intentListeners]) listener(); },
    intentListeners,
    emit() { for (const listener of [...listeners]) listener(); },
    state: async (): Promise<IntentState> => (await intents.get(intent.sessionId))!.value,
  };
}

it("launch requires local home and active state in every store", async () => {
  const module = await supervisorModule(); if (!module) return;
  const good = fixture(); await module.createSupervisor(good.ports).reconcile();
  expect(good.launches).toHaveLength(1);
  for (const mode of ["foreign", "retired", "wrong-epoch", "no-stores", "conflict", "unknown"] as const) {
    const f = fixture();
    if (mode === "foreign") f.setHome({ sessionId: intent.sessionId, machineId: remote, epoch: 1, moveId: null, updatedAt: 1 });
    if (mode === "retired") f.setStates([active, { ...active, state: "retired" }]);
    if (mode === "wrong-epoch") f.setStates([active, { ...active, epoch: 2 }]);
    if (mode === "no-stores") f.setStates([]);
    if (mode === "conflict") f.setHome("conflict");
    if (mode === "unknown") f.setHome("unknown");
    await module.createSupervisor(f.ports).reconcile();
    expect(f.launches, mode).toHaveLength(0);
  }
}, 5000);

it("never launches when authoritative intent is stopped but its local view is stale", async () => {
  const module = await supervisorModule(); if (!module) return;
  const f = fixture(); f.setAuthoritative({ ...intent, desired: "stopped" });
  await module.createSupervisor(f.ports).reconcile();
  expect(f.launches).toHaveLength(0);
  expect((await f.state()).intent.desired).toBe("stopped");
}, 5000);

it("reconciles other sessions when one authoritative intent is unreadable", async () => {
  const module = await supervisorModule(); if (!module) return;
  const f = fixture(), get = f.ports.runningIntents.get;
  f.ports.runningIntents.list = async () => ["unreadable", intent.sessionId];
  f.ports.runningIntents.get = async id => { if (id === "unreadable") throw new Error("fixture read failed"); return get(id); };
  await expect(module.createSupervisor(f.ports).reconcile()).resolves.toBeUndefined();
  expect(f.launches).toHaveLength(1);
}, 5000);

it("does not launch if authority becomes suspended during admission", async () => {
  const module = await supervisorModule(); if (!module) return;
  const f = fixture(); let reads = 0;
  f.ports.runningIntents.get = async () => ++reads === 1 ? { ...intent } : { ...intent, suspended: "doctor required" };
  await module.createSupervisor(f.ports).reconcile();
  expect(f.launches).toHaveLength(0);
}, 5000);

it("rebuilds a missing supervisor view only from authoritative intent", async () => {
  const module = await supervisorModule(); if (!module) return;
  const f = fixture(); f.deleteView();
  await module.createSupervisor(f.ports).reconcile();
  expect(f.launches).toHaveLength(1);
  expect((await f.state()).intent).toEqual(intent);
}, 5000);

it("does not launch a local view whose authoritative intent is missing", async () => {
  const module = await supervisorModule(); if (!module) return;
  const f = fixture(); f.setAuthoritative(null);
  await module.createSupervisor(f.ports).reconcile();
  expect(f.launches).toHaveLength(0);
}, 5000);

it("reconciles an invoking reservation on restart without creating a fresh one", async () => {
  const module = await supervisorModule(); if (!module) return;
  const f = fixture(), row = (await f.intents.get(intent.sessionId))!;
  await f.intents.update(intent.sessionId, row.version, { ...row.value, supervision: { kind: "launching", operationId: "launch-1", phase: "invoking" } });
  const modes: string[] = [];
  f.ports.launch = async request => { modes.push(`${request.mode}:${request.mode === "reconcile" ? request.reservation.operationId : ""}`);
    return { code: 2, reason: "launch-pending", operationId: "launch-1", home: null, epoch: 1, repairCommand: null, value: null }; };
  await module.createSupervisor(f.ports).reconcile();
  expect(modes).toEqual(["reconcile:launch-1"]);
  expect((await f.state()).supervision).toEqual({ kind: "launching", operationId: "launch-1", phase: "invoking" });
}, 5000);

it("checks adoption of the reserved operation before accepting a live owner", async () => {
  const module = await supervisorModule(); if (!module) return;
  const f = fixture(), row = (await f.intents.get(intent.sessionId))!;
  await f.intents.update(intent.sessionId, row.version, { ...row.value, supervision: { kind: "launching", operationId: "launch-1", phase: "invoking" } });
  const identity = { bootId: "boot-1", pid: 101, startTime: "child" }; f.setOwner({ kind: "live", identity });
  const modes: string[] = [];
  f.ports.launch = async request => { modes.push(request.mode); return { code: 0, reason: "ready", operationId: "launch-1",
    home: null, epoch: 1, repairCommand: null, value: ready }; };
  await module.createSupervisor(f.ports).reconcile();
  expect(modes).toEqual(["reconcile"]);
  expect((await f.state()).supervision).toEqual({ kind: "live", identity, stableSince: f.now() });
  expect(f.launches).toHaveLength(0);
}, 5000);

it("new box origin restarts before first sync with hub offline", async () => {
  const module = await supervisorModule(); if (!module) return;
  const f = fixture(); f.setHome(null);
  await module.createSupervisor(f.ports).reconcile();
  expect(f.launches).toHaveLength(1);
  const foreign = fixture(); foreign.setHome(null); foreign.setOrigin(remote);
  await module.createSupervisor(foreign.ports).reconcile();
  expect(foreign.launches).toHaveLength(0);
}, 5000);

it("unfinished freeze and uncertain owner suspend without launching", async () => {
  const module = await supervisorModule(); if (!module) return;
  for (const kind of ["freeze", "owner"] as const) {
    const f = fixture();
    if (kind === "freeze") f.setFreeze(true); else f.setOwner({ kind: "uncertain" });
    await module.createSupervisor(f.ports).reconcile();
    expect(f.launches).toHaveLength(0);
    expect((await f.state()).intent.suspended).not.toBeNull();
    expect(f.notices).toHaveLength(1);
  }
}, 5000);

it("crash backoff suspends at five in ten minutes", async () => {
  const module = await supervisorModule(); if (!module) return;
  const f = fixture(), supervisor = module.createSupervisor(f.ports);
  f.setOwner({ kind: "live", identity: { bootId: "boot-1", pid: 91, startTime: "original" } });
  await supervisor.reconcile();
  const restartDelays: number[] = [];
  for (let failure = 0; failure < 5; failure++) {
    f.setOwner({ kind: "absent" });
    await supervisor.reconcile();
    const state = await f.state();
    if (failure === 4) {
      expect(state.intent.suspended).not.toBeNull();
      break;
    }
    expect(state.supervision.kind).toBe("idle");
    if (state.supervision.kind !== "idle" || state.supervision.nextAttemptAt === null) throw new Error("Missing restart deadline");
    const delay = state.supervision.nextAttemptAt - f.now(); restartDelays.push(delay);
    f.advance(delay - 1); await supervisor.reconcile(); expect(f.launches).toHaveLength(failure);
    f.advance(1); await supervisor.reconcile(); expect(f.launches).toHaveLength(failure + 1);
  }
  expect(restartDelays).toEqual([5_000, 15_000, 60_000, 300_000]);
  expect(f.notices).toHaveLength(1);
  await supervisor.reconcile(); expect(f.launches).toHaveLength(4);
}, 5000);

it("ten stable minutes clear failures", async () => {
  const module = await supervisorModule(); if (!module) return;
  const f = fixture(), supervisor = module.createSupervisor(f.ports);
  f.setOwner({ kind: "live", identity: { bootId: "boot-1", pid: 91, startTime: "original" } });
  await supervisor.reconcile(); f.setOwner({ kind: "absent" }); await supervisor.reconcile();
  f.advance(5_000); await supervisor.reconcile();
  expect((await f.state()).failures).toHaveLength(1);
  f.advance(600_000); await supervisor.reconcile();
  expect((await f.state()).failures).toEqual([]);
  f.setOwner({ kind: "absent" }); await supervisor.reconcile();
  const state = await f.state();
  expect(state.supervision).toEqual({ kind: "idle", nextAttemptAt: f.now() + 5_000 });
}, 5000);

it("deliberate stop survives restart", async () => {
  const module = await supervisorModule(); if (!module) return;
  const f = fixture(), first = module.createSupervisor(f.ports);
  f.setOwner({ kind: "live", identity: { bootId: "boot-1", pid: 91, startTime: "original" } });
  await first.reconcile();
  const row = (await f.intents.get(intent.sessionId))!;
  expect(await f.intents.update(intent.sessionId, row.version, { ...row.value, intent: { ...row.value.intent, desired: "stopped" } })).toMatchObject({ kind: "updated" });
  f.setAuthoritative({ ...intent, desired: "stopped" });
  await first.reconcile(); await first.stop();
  expect(f.stops).toEqual([intent.sessionId]);
  await module.createSupervisor(f.ports).reconcile();
  expect((await f.state()).intent.desired).toBe("stopped");
  expect(f.launches).toHaveLength(0);
}, 5000);

it("reload preserves one terminal", async () => {
  const module = await supervisorModule(); if (!module) return;
  const f = fixture(), first = module.createSupervisor(f.ports);
  await first.reconcile(); await first.stop();
  await module.createSupervisor(f.ports).reconcile();
  expect(f.launches).toHaveLength(1);
}, 5000);

it("missed, duplicate, and reordered hints converge and stop removes timers", async () => {
  const module = await supervisorModule(); if (!module) return;
  const f = fixture(); f.setHome("unknown");
  let launched!: () => void;
  const launchedPromise = new Promise<void>(resolve => { launched = resolve; });
  const launch = f.ports.launch;
  f.ports.launch = async value => { const result = await launch(value); launched(); return result; };
  const supervisor = module.createSupervisor(f.ports);
  supervisor.start(); await supervisor.reconcile();
  expect(f.intentListeners.size).toBe(1);
  expect(f.launches).toHaveLength(0);
  f.setHome({ sessionId: intent.sessionId, machineId: local, epoch: 1, moveId: null, updatedAt: 1 });
  f.fire(10_000); await launchedPromise; await supervisor.reconcile();
  f.emit(); f.emit(); f.emitIntent();
  f.setHome("unknown"); f.emit();
  f.setHome({ sessionId: intent.sessionId, machineId: local, epoch: 1, moveId: null, updatedAt: 1 }); f.emit();
  await supervisor.reconcile();
  expect(f.launches).toHaveLength(1);
  await supervisor.stop();
  expect(f.listeners.size).toBe(0);
  expect(f.intentListeners.size).toBe(0);
  expect(f.timers.filter(timer => !timer.cancelled)).toEqual([]);
}, 5000);

it("releases an unused reservation when home changes before the launch call", async () => {
  const module = await supervisorModule(); if (!module) return;
  const f = fixture(), supervisor = module.createSupervisor(f.ports), inspect = f.ports.inspect;
  let inspections = 0;
  f.ports.inspect = async id => { if (++inspections === 2) f.setHome("unknown"); return inspect(id); };
  await supervisor.reconcile();
  expect(f.launches).toHaveLength(0);
  f.ports.inspect = inspect;
  f.setHome({ sessionId: intent.sessionId, machineId: local, epoch: 1, moveId: null, updatedAt: 1 });
  await supervisor.reconcile();
  expect(f.launches).toHaveLength(1);
}, 5000);

it("missing authentication suspends immediately and never retries", async () => {
  const module = await supervisorModule(); if (!module) return;
  const f = fixture(); let attempts = 0;
  f.ports.launch = createDurableLaunchPort({ intents: f.intents, operationId: () => "launch-1", authorize: async () => true,
    async invoke({ intent: value }) { attempts++; return { code: 1, reason: "missing-auth", operationId: "launch-1",
      home: null, epoch: value.epoch, repairCommand: null, value: null }; } });
  const supervisor = module.createSupervisor(f.ports);
  await supervisor.reconcile();
  expect((await f.state()).intent.suspended).not.toBeNull();
  f.advance(600_000); await supervisor.reconcile();
  expect(attempts).toBe(1);
  expect(f.notices).toHaveLength(1);
}, 5000);
