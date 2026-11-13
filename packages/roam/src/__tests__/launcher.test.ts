import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import type { Journal } from "../contracts";
import { openJournal } from "../journal";
import * as launcher from "../launcher";
import { createLaunchTracker } from "../launcher";
import { claimIdLock, inspectIdLock } from "@spider/herdr/sessions/id-lock";
import { readLaunchHandoff, removeLaunchHandoff } from "@spider/herdr/sessions/launch-handoff";
import { createSessionLeases, type ProcessInventoryPorts, type ProcessProbe } from "@spider/herdr/sessions/lease";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import type { PiSpawnRequest } from "@spider/herdr/sessions/launcher";
import type { SessionId } from "@spider/herdr";
import type { JsonObject } from "@spider/db-core/roam/types";
import { HerdrError } from "@spider/herdr/client/parse";
import type { IdLockObservation } from "@spider/herdr/sessions/id-lock";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function launcherModule() {
  expect(launcher.createLaunchReconciler).toBeTypeOf("function");
  return launcher;
}

function fixture() {
  let now = 100;
  let core = "core-1";
  let rows: Array<{ id: string; state: "live" | "finished" }> = [];
  let complete = true;
  let lock: IdLockObservation | null = { identity: { pid: 91, startIdentity: "supervisor-start" }, bootId: "boot-1",
    pendingOperationId: "op-1", pendingFile: "/fixture/session.jsonl", pendingCoreId: "core-1", operationId: null };
  const actions: Array<{ action: string; result: JsonObject }> = [
    { action: "exact-core", result: { coreId: "core-1" } },
    { action: "exact-hc-started", result: { pid: 442, startTime: "hc-start", bootId: "boot-1" } },
    { action: "exact-hc-exited", result: { pid: 442, exitedAt: 99 } },
  ];
  const journal: Journal = {
    begin() { return { kind: "new", result: null }; },
    record(_id, action, result) { actions.push({ action, result }); },
    read(id) { return id === "op-1" ? actions : []; },
  };
  const queries: Array<{ operationId: string; includeFinished: boolean; at: number }> = [];
  const ports = {
    journal,
    async inspectLock() { return lock; },
    async coreId(_signal: AbortSignal) { return core; },
    async bootId(_signal: AbortSignal) { return "boot-1"; },
    async terminals(operationId: string, options: { signal: AbortSignal; includeFinished: true; attemptId?: string }) {
      queries.push({ operationId, includeFinished: options.includeFinished, at: now });
      return { complete, terminals: structuredClone(rows) };
    },
    clock: { now: () => now, async wait(ms: number, signal: AbortSignal) {
      if (signal.aborted) throw new Error("aborted"); now += ms;
    } },
  };
  return { ports, actions, queries,
    setCore(value: string) { core = value; }, setRows(value: typeof rows) { rows = value; },
    setComplete(value: boolean) { complete = value; }, setLock(value: IdLockObservation | null) { lock = value; },
  };
}

it("proves no start only after hc exits and two same-core finished-inclusive queries", async () => {
  const module = await launcherModule(); if (!module) return;
  const f = fixture();
  const evidence = await module.createLaunchReconciler(f.ports)("op-1", { signal: new AbortController().signal });
  expect(evidence).toMatchObject({ receipt: "unknown", terminal: "absent", proof: {
    kind: "no-terminal-after-hc-exit", operationId: "op-1", coreIdBefore: "core-1", hcExitedAt: 99,
    first: { coreId: "core-1", issuedAt: 100, terminal: "absent" },
    second: { coreId: "core-1", issuedAt: 350, terminal: "absent" }, confirmationBoundMs: 250,
  } });
  expect(f.queries).toEqual([{ operationId: "op-1", includeFinished: true, at: 100 },
    { operationId: "op-1", includeFinished: true, at: 350 }]);
}, 5000);

it.each([
  ["core-unavailable", undefined, false], ["core-mismatch", undefined, false],
  ["missing-hc", { pid: undefined }, true], ["spawn-error", { pid: undefined }, true],
] as const)("records a proven pre-call failure: %s", async (code, details, needsPid) => {
  const module = await launcherModule(); if (!module) return;
  const f = fixture(); f.actions.splice(0);
  expect(module.createLaunchTracker).toBeTypeOf("function");
  if (!module.createLaunchTracker) return;
  const tracker = module.createLaunchTracker({ journal: f.ports.journal, machineId: "10e674f6-9567-4109-a66c-a6870586c3e1",
    coreId: "core-1", bootId: "boot-1" });
  tracker.begin("op-1", 1);
  expect(tracker.failed("op-1", new HerdrError(code, "fixture", details))).toBe(true);
  const evidence = await module.createLaunchReconciler(f.ports)("op-1", { signal: new AbortController().signal });
  expect(evidence.proof).toMatchObject({ kind: "prelaunch-error", operationId: "op-1", beforeLaunch: true, errorCode: code,
    ...(needsPid ? { hcPid: null } : {}) });
  expect(f.queries).toEqual([]);
}, 5000);

it.each([
  ["core-mismatch", { pid: undefined }], ["missing-hc", undefined], ["spawn-error", {}],
  ["spawn-error", { pid: 44 }], ["cli-timeout", { pid: 44 }],
] as const)("keeps ambiguous launch failure pending: %s", async (code, details) => {
  const module = await launcherModule(); if (!module) return;
  const f = fixture(); f.actions.splice(0);
  const tracker = module.createLaunchTracker({ journal: f.ports.journal, machineId: "10e674f6-9567-4109-a66c-a6870586c3e1",
    coreId: "core-1", bootId: "boot-1" });
  tracker.begin("op-1", 1);
  expect(tracker.failed("op-1", new HerdrError(code, "fixture", details))).toBe(false);
  expect((await module.createLaunchReconciler(f.ports)("op-1", { signal: new AbortController().signal })).proof).toBeUndefined();
}, 5000);

it("proves a labelled terminal exited without ever adopting the pending lock", async () => {
  const module = await launcherModule(); if (!module) return;
  const f = fixture(); f.actions.splice(2, 1); f.setRows([{ id: "terminal-1", state: "finished" }]);
  const evidence = await module.createLaunchReconciler(f.ports)("op-1", { signal: new AbortController().signal });
  expect(evidence.proof).toEqual({ kind: "terminal-exited-without-adoption", operationId: "op-1", coreId: "core-1",
    terminalId: "terminal-1", terminalExited: true, lockNeverAdopted: true });
  expect(f.queries).toHaveLength(1);
}, 5000);

it("a missing or adopted lock cannot prove that a finished terminal never adopted", async () => {
  const module = await launcherModule(); if (!module) return;
  const f = fixture(); f.actions.splice(2, 1); f.setRows([{ id: "terminal-1", state: "finished" }]);
  const query = f.ports.terminals;
  f.ports.terminals = async (id, options) => { const result = await query(id, options); f.setLock(null); return result; };
  const evidence = await module.createLaunchReconciler(f.ports)("op-1", { signal: new AbortController().signal });
  expect(evidence.proof).toBeUndefined();
}, 5000);

it("does not prove absence when the hc reply arrives during confirmation", async () => {
  const module = await launcherModule(); if (!module) return;
  const f = fixture(), wait = f.ports.clock.wait;
  f.ports.clock.wait = async (ms, signal) => {
    f.actions.push({ action: "exact-terminal", result: { terminalId: "terminal-1" } });
    await wait(ms, signal);
  };
  const evidence = await module.createLaunchReconciler(f.ports)("op-1", { signal: new AbortController().signal });
  expect(evidence.proof).toBeUndefined();
}, 5000);

it("does not use an exit recorded before the corresponding process start", async () => {
  const module = await launcherModule(); if (!module) return;
  const f = fixture();
  const start = f.actions.splice(1, 1)[0]; f.actions.push(start);
  const evidence = await module.createLaunchReconciler(f.ports)("op-1", { signal: new AbortController().signal });
  expect(evidence.proof).toBeUndefined();
}, 5000);

it.each(["in-flight", "core-changed", "incomplete", "early-second", "changed-boot", "wrong-operation"] as const)(
  "keeps incomplete launch evidence pending: %s", async mode => {
    const module = await launcherModule(); if (!module) return;
    const f = fixture();
    if (mode === "in-flight") f.actions.splice(2, 1);
    if (mode === "core-changed") {
      let observations = 0;
      f.ports.coreId = async () => ++observations === 4 ? "core-2" : "core-1";
    }
    if (mode === "incomplete") f.setComplete(false);
    if (mode === "early-second") f.ports.clock.wait = async () => {};
    if (mode === "changed-boot") f.ports.bootId = async () => "boot-2";
    const op = mode === "wrong-operation" ? "op-2" : "op-1";
    const evidence = await module.createLaunchReconciler(f.ports)(op, { signal: new AbortController().signal });
    expect(evidence.proof).toBeUndefined();
    if (mode === "in-flight") expect(f.queries).toHaveLength(1);
  }, 5000);

it("cancels a stalled query without clearing the pending operation", async () => {
  const module = await launcherModule(); if (!module) return;
  const f = fixture(), abort = new AbortController();
  let queried!: () => void;
  const queryStarted = new Promise<void>(resolve => { queried = resolve; });
  f.ports.terminals = async (_id, options) => {
    queried();
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  };
  const pending = module.createLaunchReconciler(f.ports)("op-1", { signal: abort.signal });
  await queryStarted; abort.abort();
  expect((await pending).proof).toBeUndefined();
  expect((await f.ports.inspectLock())?.pendingOperationId).toBe("op-1");
}, 5000);

async function exactFixture() {
  const parent = resolve(".spider/scratch/roam-launch-adapter");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, "case-")); roots.push(root);
  const globalRoot = join(root, "global"), cwd = join(root, "work"), agent = join(root, "agent");
  await Promise.all([globalRoot, cwd, agent].map(path => mkdir(path, { mode: 0o700 })));
  const stateRoot = join(globalRoot, "herdr"), file = join(root, "session.jsonl");
  const body = JSON.stringify({ type: "session", version: 3, id: "session-1", cwd }) + "\n";
  await writeFile(file, body, { mode: 0o600 });
  const launcher = { pid: 101, startIdentity: "supervisor-start" }, child = { pid: 102, startIdentity: "child-start" };
  const probes = new Map<number, ProcessProbe>([[101, { kind: "live", startIdentity: launcher.startIdentity }],
    [102, { kind: "live", startIdentity: child.startIdentity }]]);
  const probe = async (pid: number) => probes.get(pid) ?? { kind: "absent" as const };
  const leases = createSessionLeases(stateRoot);
  const inventory: ProcessInventoryPorts = { leases, presence: createProcessPresence(stateRoot), processes: async () => [], probe };
  const journalRows = new Map<string, Array<{ action: string; result: JsonObject }>>();
  const openFixtureJournal = (): Journal => ({
    begin(operation) {
      if (journalRows.has(operation.id)) return { kind: "pending", result: null };
      journalRows.set(operation.id, []); return { kind: "new", result: null };
    },
    record(id, action, result) {
      const rows = journalRows.get(id); if (!rows) throw new Error("Operation has not begun");
      rows.push({ action, result: structuredClone(result) });
    },
    read(id) { return structuredClone(journalRows.get(id) ?? []); },
  });
  const journal = openFixtureJournal();
  let now = 100;
  let wake!: () => void;
  const changed = new Promise<void>(resolve => { wake = resolve; });
  let childLock: Awaited<ReturnType<typeof claimIdLock>> | undefined;
  let nonce = "";
  const adopt = async (request: PiSpawnRequest) => {
    const operationId = request.terminal!.labels["spider.roam.operation"];
    const handoff = await readLaunchHandoff(stateRoot, join(stateRoot, "handoffs", `${operationId}.json`), request.sessionId, request.sessionFile);
    nonce = handoff.nonce;
    childLock = await claimIdLock(stateRoot, "session-1", child, probe, { bootId: async () => "boot-1",
      handoff: { operationId, nonce, file: request.sessionFile } });
    await leases.adopt(file, handoff.leaseToken, child);
    await removeLaunchHandoff(stateRoot, operationId);
  };
  const calls: PiSpawnRequest[] = [];
  const hc = {
    async coreId(_signal: AbortSignal) { return "core-1"; },
    async terminals(_operationId: string, _options: { signal: AbortSignal; includeFinished: true }) { return { complete: true, terminals: [] }; },
    async run(request: PiSpawnRequest, observer: { started(pid: number, startTime: string): void; exited(pid: number): void }) {
      calls.push(request); observer.started(201, "hc-start");
      try { await adopt(request); } finally { wake(); }
      observer.exited(201); return { terminal: "terminal-1" };
    },
  };
  const base = { leases, processInventory: inventory, processIdentity: launcher,
    env: { SPIDER_GLOBAL_ROOT: globalRoot, PI_CODING_AGENT_DIR: agent, HC_SESSION: "unrelated", HC_SOCKET: "/fixture/unrelated.sock" },
    bootId: async () => "boot-1", limits: async () => ({ soft: 1024, hard: 100_000 }), shell: "/bin/sh",
    machineId: "10e674f6-9567-4109-a66c-a6870586c3e1", core: { session: "fixture", socket: join(root, "core.sock"), coreId: "core-1" },
    launchMs: 1000, reconcileMs: 1000, now: () => now, wait: async (ms: number) => { await changed; now += Math.max(ms, 1000); },
  };
  const clock = { now: () => now, async wait(ms: number, signal: AbortSignal) { if (signal.aborted) throw new Error("aborted"); now += ms; } };
  return { root, stateRoot, file, cwd, leases, journal, openFixtureJournal, base, hc, clock, calls, wake, adopt, nonce: () => nonce,
    request: { sessionId: "session-1", file, cwd, sha256: createHash("sha256").update(body).digest("hex"),
      epoch: 1, moveId: null, pi: join(root, "bin", "pi") },
    setProbe(pid: number, result: ProcessProbe) { probes.set(pid, result); },
    async release() { await childLock?.release(); },
  };
}

it("composes exact Herdr launch with durable local hc process observations", async () => {
  const module = await launcherModule(); if (!module) return;
  expect(module.createExactLaunchAdapter).toBeTypeOf("function");
  if (!module.createExactLaunchAdapter) return;
  const f = await exactFixture();
  try {
    const adapter = module.createExactLaunchAdapter({ base: f.base, journal: f.journal, hc: f.hc, clock: f.clock });
    const result = await adapter.launch(f.request);
    expect(result).toMatchObject({ pid: 102, startIdentity: "child-start", sessionId: "session-1", sessionFile: f.file });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].terminal).toMatchObject({ background: true, noNotify: true, outliveParent: true, parent: null });
    expect(f.calls[0].argv.slice(-3)).toEqual([f.request.pi, "--session", f.file]);
    expect(f.calls[0].argv.join("\n")).not.toContain(f.nonce());
    expect(JSON.stringify(f.calls[0].terminal?.labels)).not.toContain(f.nonce());
    expect(f.journal.read(result.operationId!).map(item => item.action)).toEqual(expect.arrayContaining(["exact-core", "exact-hc-started", "exact-hc-exited"]));
  } finally { await f.release(); }
}, 5000);

it("lost hc reply releases both locks only after a real exit and two absence queries", async () => {
  const module = await launcherModule(); if (!module) return;
  const f = await exactFixture();
  f.hc.run = async (request, observer) => {
    f.calls.push(request); observer.started(201, "hc-start"); observer.exited(201); f.wake();
    throw new Error("lost reply");
  };
  const adapter = module.createExactLaunchAdapter({ base: f.base, journal: f.journal, hc: f.hc, clock: f.clock });
  await expect(adapter.launch(f.request)).rejects.toMatchObject({ code: "launch-not-started" });
  expect(f.calls).toHaveLength(1);
  expect(await inspectIdLock(f.stateRoot, "session-1")).toBeNull();
  expect(await f.leases.get(f.file)).toBeNull();
  const operation = f.calls[0].terminal!.labels["spider.roam.operation"];
  expect(await lstat(join(f.stateRoot, "handoffs", `${operation}.json`)).catch(() => null)).toBeNull();
}, 5000);

it("an in-flight hc call retains the handoff and never launches a duplicate", async () => {
  const module = await launcherModule(); if (!module) return;
  const f = await exactFixture();
  f.hc.run = async (request, observer) => {
    f.calls.push(request); observer.started(201, "hc-start"); f.wake();
    return new Promise(() => {});
  };
  const adapter = module.createExactLaunchAdapter({ base: f.base, journal: f.journal, hc: f.hc, clock: f.clock });
  await expect(adapter.launch(f.request)).rejects.toMatchObject({ code: "launch-pending" });
  await expect(adapter.launch(f.request)).rejects.toMatchObject({ code: "launch-pending" });
  expect(f.calls).toHaveLength(1);
  const operation = f.calls[0].terminal!.labels["spider.roam.operation"];
  expect(await inspectIdLock(f.stateRoot, "session-1")).toMatchObject({ pendingOperationId: operation, pendingCoreId: "core-1" });
  expect(await f.leases.get(f.file)).not.toBeNull();
  expect((await lstat(join(f.stateRoot, "handoffs", `${operation}.json`))).mode & 0o777).toBe(0o600);
}, 5000);

it("keeps a launch pending when start recording fails before a later error", async () => {
  const module = await launcherModule(); if (!module) return;
  const f = await exactFixture();
  const journal = { ...f.journal, record(id: string, action: string, result: JsonObject) {
    if (action === "exact-hc-started") throw new Error("fixture journal failure");
    f.journal.record(id, action, result);
  } };
  f.hc.run = async (request, observer) => {
    f.calls.push(request); observer.started(201, "hc-start"); f.wake();
    throw new HerdrError("core-unavailable", "after the process started");
  };
  const adapter = module.createExactLaunchAdapter({ base: f.base, journal, hc: f.hc, clock: f.clock });
  await expect(adapter.launch(f.request)).rejects.toMatchObject({ code: "launch-pending" });
  const operation = f.calls[0].terminal!.labels["spider.roam.operation"];
  expect(f.journal.read(operation).map(item => item.action)).not.toContain("exact-prelaunch-error");
  expect((await inspectIdLock(f.stateRoot, "session-1"))?.pendingOperationId).toBe(operation);
}, 5000);

it("continues a proved reservation under the same operation with a distinct attempt", async () => {
  const actions: string[] = []; let exists = false;
  const journal: Journal = { begin() { const kind = exists ? "pending" : "new"; exists = true; return { kind, result: null }; },
    record(_id, action) { actions.push(action); }, read() { return []; } };
  const tracker = createLaunchTracker({ journal, machineId: "machine-1", coreId: "core-1", bootId: "boot-1" });
  expect(tracker.begin("operation-1", 1, { attemptId: "first", resume: false })).toBe(true);
  expect(tracker.begin("operation-1", 1, { attemptId: "second", resume: true })).toBe(true);
  expect(actions).toEqual(["exact-attempt", "exact-core", "exact-attempt", "exact-core"]);
}, 5000);

it("ignores a prior attempt's finished terminal while a later attempt is unresolved", async () => {
  const f = fixture();
  f.actions.unshift({ action: "exact-attempt", result: { attemptId: "first" } });
  f.actions.push({ action: "exact-attempt", result: { attemptId: "second" } }, { action: "exact-core", result: { coreId: "core-1" } });
  const queries: string[] = [];
  f.ports.terminals = async (_operationId, options) => {
    queries.push(options.attemptId ?? "missing");
    return { complete: true, terminals: options.attemptId === "first" ? [{ id: "old-terminal", state: "finished" as const }] : [] };
  };
  const { createLaunchReconciler } = await import("../launcher");
  expect(await createLaunchReconciler(f.ports)("op-1", { signal: new AbortController().signal })).not.toHaveProperty("proof");
  expect(queries).toEqual(["second"]);
}, 5000);

it("adopts a child that acquired the reserved operation while the supervisor was down", async () => {
  const module = await launcherModule(); if (!module) return;
  const f = await exactFixture(), request = { ...f.request, operationId: "reserved-operation" };
  f.hc.run = async (spawn, observer) => { f.calls.push(spawn); observer.started(201, "hc-start"); f.wake(); return new Promise(() => {}); };
  const first = module.createExactLaunchAdapter({ base: f.base, journal: f.journal, hc: f.hc, clock: f.clock });
  await expect(first.launch(request, { mode: "fresh" })).rejects.toMatchObject({ code: "launch-pending" });
  await f.adopt(f.calls[0]);
  f.setProbe(101, { kind: "absent" }); f.setProbe(103, { kind: "live", startIdentity: "replacement" });
  const second = module.createExactLaunchAdapter({ base: { ...f.base, processIdentity: { pid: 103, startIdentity: "replacement" } }, journal: f.journal, hc: f.hc, clock: f.clock });
  try {
    expect(await second.launch(request, { mode: "reconcile" })).toMatchObject({ operationId: request.operationId, pid: 102 });
    expect(f.calls).toHaveLength(1);
  } finally { await f.release(); }
}, 5000);

it("refuses fresh launch and stays fenced when the old call lacks no-start proof", async () => {
  const module = await launcherModule(); if (!module) return;
  const f = await exactFixture(), request = { ...f.request, operationId: "reserved-operation" };
  f.hc.run = async (spawn, observer) => { f.calls.push(spawn); observer.started(201, "hc-start"); f.wake(); return new Promise(() => {}); };
  const first = module.createExactLaunchAdapter({ base: f.base, journal: f.journal, hc: f.hc, clock: f.clock });
  await expect(first.launch(request, { mode: "fresh" })).rejects.toMatchObject({ code: "launch-pending" });
  f.setProbe(101, { kind: "absent" }); f.setProbe(103, { kind: "live", startIdentity: "replacement" });
  const second = module.createExactLaunchAdapter({ base: { ...f.base, processIdentity: { pid: 103, startIdentity: "replacement" } }, journal: f.journal, hc: f.hc, clock: f.clock });
  await expect(second.launch(request, { mode: "fresh" })).rejects.toMatchObject({ code: "launch-reservation-exists" });
  await expect(second.launch(request, { mode: "reconcile" })).rejects.toMatchObject({ code: "launch-pending" });
  expect(f.calls).toHaveLength(1);
  expect((await inspectIdLock(f.stateRoot, "session-1"))?.pendingOperationId).toBe(request.operationId);
}, 5000);

it("keeps a proved no-start handoff for a durable reservation until reconciliation", async () => {
  const module = await launcherModule(); if (!module) return;
  const f = await exactFixture(), request = { ...f.request, operationId: "reserved-operation" };
  f.hc.run = async (spawn, observer) => { f.calls.push(spawn); observer.started(201, "hc-start"); observer.exited(201); f.wake(); throw new Error("lost reply"); };
  const adapter = module.createExactLaunchAdapter({ base: f.base, journal: f.journal, hc: f.hc, clock: f.clock });
  await expect(adapter.launch(request, { mode: "fresh" })).rejects.toMatchObject({ code: "launch-pending" });
  expect((await inspectIdLock(f.stateRoot, "session-1"))?.pendingOperationId).toBe(request.operationId);
  expect(await f.leases.get(f.file)).not.toBeNull();
}, 5000);

it("persists launch process evidence when the SQLite journal is reopened", async () => {
  const parent = resolve(".spider/scratch/roam-launch-adapter"); await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, "journal-")); roots.push(root);
  const file = join(root, "journal.db"), tracker = createLaunchTracker({ journal: openJournal(file), machineId: "10e674f6-9567-4109-a66c-a6870586c3e1", coreId: "core-1", bootId: "boot-1", sessionId: "session-1" });
  expect(tracker.begin("operation-1", 1, { attemptId: "attempt-1", resume: false })).toBe(true);
  tracker.started("operation-1", 201, "start-1"); tracker.exited("operation-1", 201, 10);
  expect(openJournal(file).read("operation-1").map(item => item.action)).toEqual(["exact-attempt", "exact-core", "exact-hc-started", "exact-hc-exited"]);
  const other = createLaunchTracker({ journal: openJournal(file), machineId: "10e674f6-9567-4109-a66c-a6870586c3e1", coreId: "core-1", bootId: "boot-1", sessionId: "other-session" });
  expect(() => other.begin("operation-1", 1, { attemptId: "attempt-2", resume: true })).toThrow(/different arguments/i);
}, 5000);

it("a replacement supervisor reuses durable exit evidence before launching once", async () => {
  const module = await launcherModule(); if (!module) return;
  const f = await exactFixture(); let complete = false;
  const request = { ...f.request, operationId: "reserved-operation" }, nonces: string[] = [];
  let finishSecond!: () => void;
  const secondAdopted = new Promise<void>(resolve => { finishSecond = resolve; });
  f.hc.terminals = async () => ({ complete, terminals: [] });
  f.hc.run = async (request, observer) => {
    f.calls.push(request); observer.started(200 + f.calls.length, `hc-${f.calls.length}`);
    const handoff = await readLaunchHandoff(f.stateRoot, join(f.stateRoot, "handoffs", `${request.terminal!.labels["spider.roam.operation"]}.json`), request.sessionId, request.sessionFile);
    nonces.push(handoff.nonce);
    if (f.calls.length === 1) { observer.exited(201); f.wake(); throw new Error("reply lost"); }
    try { await f.adopt(request); observer.exited(202); return { terminal: "terminal-2" }; }
    finally { finishSecond(); }
  };
  const first = module.createExactLaunchAdapter({ base: f.base, journal: f.journal, hc: f.hc, clock: f.clock });
  await expect(first.launch(request, { mode: "fresh" })).rejects.toMatchObject({ code: "launch-pending" });
  const operation = f.calls[0].terminal!.labels["spider.roam.operation"];
  expect(operation).toBe("reserved-operation");
  expect(f.journal.read(operation).map(item => item.action)).toContain("exact-hc-exited");
  f.setProbe(101, { kind: "absent" }); f.setProbe(103, { kind: "live", startIdentity: "replacement" }); complete = true;
  const second = module.createExactLaunchAdapter({ base: { ...f.base, processIdentity: { pid: 103, startIdentity: "replacement" },
    wait: async (ms: number) => { await secondAdopted; await f.clock.wait(Math.max(ms, 1000), new AbortController().signal); } },
    journal: f.openFixtureJournal(), hc: f.hc, clock: f.clock });
  try {
    const result = await second.launch(request, { mode: "reconcile" });
    expect(result).toMatchObject({ pid: 102, sessionId: "session-1", operationId: operation });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].terminal!.labels["spider.roam.operation"]).toBe(operation);
    expect(nonces).toHaveLength(2);
    expect(nonces[1]).not.toBe(nonces[0]);
    expect(f.calls[1].terminal!.labels["spider.roam.attempt"]).not.toBe(f.calls[0].terminal!.labels["spider.roam.attempt"]);
  } finally { await f.release(); }
}, 5000);

it("runs only on the selected local core and queries finished terminals by operation label", async () => {
  const module = await launcherModule(); if (!module) return;
  expect(module.createLocalExactHc).toBeTypeOf("function");
  if (!module.createLocalExactHc) return;
  const calls: Array<{ argv: readonly string[]; env?: Readonly<NodeJS.ProcessEnv> }> = [];
  const local = module.createLocalExactHc({
    coreId: async () => "core-1",
    async invoke(argv: readonly string[]) {
      calls.push({ argv });
      return { terminals: [{ address: "terminal-1", parent: null, labels: { "spider.roam.operation": "op-1" },
        state: "finished", status: null, exit_code: 0, reason: null, signal: null, finished_ms: 20 }] };
    },
    async invokeTracked(argv: readonly string[], env: Readonly<NodeJS.ProcessEnv>, observer: { started(pid: number, startTime: string): void; exited(pid: number): void }) {
      calls.push({ argv, env }); observer.started(41, "hc-start"); observer.exited(41); return { address: "terminal-1" };
    },
  });
  const request: PiSpawnRequest = { sessionFile: "/fixture/session.jsonl", sessionId: "session-1" as SessionId, cwd: "/fixture/work",
    environment: { agentDirectory: "/fixture/agent", extensionArguments: [] }, argv: ["/bin/sh", "-c", "exec \"$@\"", "shell", "/fixture/pi", "--session", "/fixture/session.jsonl"],
    env: { HC_SESSION: "selected", HC_SOCKET: "/fixture/core.sock", PATH: "/fixture/bin" },
    terminal: { background: true, noNotify: true, outliveParent: true, parent: null, labels: { "spider.roam.operation": "op-1" } } };
  const observed: string[] = [];
  expect(await local.run(request, { started(pid: number, startTime: string) { observed.push(`${pid}:${startTime}`); }, exited(pid: number) { observed.push(`exit:${pid}`); } })).toEqual({ terminal: "terminal-1" });
  expect(calls[0].argv).toEqual(["run", "--json", "--bg", "--no-notify", "--outlive-parent", "--no-parent", "--cwd", "/fixture/work",
    "--label", "spider.roam.operation=op-1", "--", ...request.argv]);
  expect(calls[0].env).toEqual(request.env);
  expect(observed).toEqual(["41:hc-start", "exit:41"]);
  expect(await local.terminals("op-1", { signal: new AbortController().signal, includeFinished: true })).toEqual({ complete: true, terminals: [{ id: "terminal-1", state: "finished" }] });
  expect(calls[1].argv).toEqual(["ls", "--all", "--json", "--label", "spider.roam.operation=op-1"]);
}, 5000);

it("observes the actual local fake-hc process through the production adapter", async () => {
  const { createProductionLocalExactHc } = await import("../launcher.js");
  await mkdir(resolve(".spider/scratch/h"), { recursive: true });
  const dir = await mkdtemp(resolve(".spider/scratch/h/roam-hc-")); roots.push(dir);
  const socket = join(dir, "core.sock"), binary = join(dir, "hc"), log = join(dir, "calls.jsonl");
  const server = createServer(connection => connection.end());
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(socket, ok); });
  const script = `#!${process.execPath}\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.FAKE_HC_LOG, JSON.stringify({args, session: process.env.HC_SESSION}) + '\\n');\nif (args[0] === 'server') console.log(JSON.stringify({version:'0.1.16',core:{id:'core-1'}}));\nelse if (args[0] === 'ls') console.log(JSON.stringify({terminals:[]}));\nelse if (args[0] === 'run') console.log(JSON.stringify({address:'terminal-1'}));\nelse process.exit(1);\n`;
  await writeFile(binary, script, { mode: 0o700 }); await chmod(binary, 0o700);
  const env = { ...process.env, HC_SESSION: "fixture", HC_SOCKET: socket, FAKE_HC_LOG: log };
  let hc: ReturnType<typeof createProductionLocalExactHc> | undefined;
  const observed: Array<{ phase: string; pid: number; startTime?: string }> = [];
  try {
    hc = createProductionLocalExactHc({ binary, env, probe: async () => ({ kind: "live", startIdentity: "fixture-start" }) });
    const signal = new AbortController().signal;
    expect(await hc.coreId(signal)).toBe("core-1");
    expect(await hc.terminals("op-1", { signal, includeFinished: true })).toEqual({ complete: true, terminals: [] });
    const request = { sessionFile: "/fixture/session.jsonl", sessionId: "session-1" as SessionId, cwd: "/fixture/work",
      environment: { agentDirectory: "/fixture/agent", extensionArguments: [] }, argv: ["/fixture/pi", "--session", "/fixture/session.jsonl"], env,
      terminal: { background: true as const, noNotify: true as const, outliveParent: true as const, parent: null,
        labels: { "spider.roam.operation": "op-1" } } };
    expect(await hc.run(request, { started(pid, startTime) { observed.push({ phase: "started", pid, startTime }); },
      exited(pid) { observed.push({ phase: "exited", pid }); } })).toEqual({ terminal: "terminal-1" });
    expect(observed).toEqual([{ phase: "started", pid: expect.any(Number), startTime: "fixture-start" },
      { phase: "exited", pid: observed[0].pid }]);
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { args: string[]; session: string });
    expect(calls.map(call => call.args[0])).toEqual(["server", "ls", "run"]);
    expect(calls.every(call => call.session === "fixture")).toBe(true);
    expect(calls[2].args).not.toContain("--on");
  } finally { await hc?.dispose(); await new Promise<void>(ok => server.close(() => ok())); }
}, 5000);
