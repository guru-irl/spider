import { afterEach, expect, it } from "vitest";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "@spider/db-core";
import { assignInitialHome, casHome } from "../homes";
import { createMovePorts, createHubMoveEvidencePorts, createPushedMoveEvidencePorts, handleMoveParticipantOperation, presentationTaskId, recoverMovePresentation, type MoveAdapterBindings } from "../move-ports";
import { appendMirror } from "../mirrors";
import { inspectSession } from "../session-file";
import { openFreezeJournal } from "../journal";
import { recoverWorkspaceRestores, pendingWorkspaceTransitions, abortCleanupId } from "../move-recovery";
import type { WorkspaceRestore } from "../contracts";
import { withProcessLock } from "@spider/herdr/sessions/registry";
import { createMoveRuntimeService } from "../move-runtime-service";
import { recoveryFixture, BOX, HUB, OTHER } from "./recovery-fixture";
import type { MoveRuntime, MoveRuntimeFactory } from "../move-runtime-contracts";
import type { Operation, Transport } from "../contracts";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
async function fixture() {
  const f = await recoveryFixture(); cleanups.push(f.close);
  mkdirSync(join(f.root, "roam"));
  cpSync(f.mirrorRoot, join(f.root, "roam", "mirrors"), { recursive: true });
  const journal = openFreezeJournal(join(f.root, "roam", "journal.db")), db = openDb(join(f.root, "roam", "journal.db"));
  cleanups.unshift(() => db.close());
  f.ports.journal = journal; f.ports.recovery.revocationDb = db;
  const mounted: string[] = [], restored: string[] = [], replayed: string[] = [], cleaned: string[] = [];
  const factory: MoveRuntimeFactory = async input => {
    mounted.push(input.sessionId);
    return { ports: { ...f.ports, async abortWorkspace(check) { cleaned.push(`${input.sessionId}:${check.source.sessionId}`); }, recovery: { ...f.ports.recovery,
      async restore(home) { restored.push(`${input.sessionId}:${home.sessionId}`); throw new Error("fixture restore stopped"); },
      async workspaceRestores() { replayed.push(input.sessionId); return []; },
    } }, bindings: {}, control: async () => ({ code: 1, reason: "wrong-dispatch", value: null }),
      async recover() { throw new Error("global recovery must not run through a bound session"); }, async close() {} } satisfies MoveRuntime;
  };
  const service = createMoveRuntimeService({ root: f.root, globalDb: f.global.db, config: f.ports.config, journal, transport: {} as Transport }, factory);
  return { ...f, journal, db, service, mounted, restored, replayed, cleaned, factory };
}
it("forget restores every home through that session's own runtime", async () => {
  const f = await fixture(); assignInitialHome(f.global.db, "session-b", BOX, HUB);
  const file = join(f.root, "session-b.jsonl");
  writeFileSync(file, readFileSync(f.file, "utf8").replaceAll("session-a", "session-b"), { mode: 0o600 });
  f.journal.begin({ id: "mirror-b", machineId: BOX, expectedEpoch: 1, kind: "sync-mirror", args: {} });
  await appendMirror({ sessionId: "session-b", epoch: 1, source: await inspectSession(file, "session-b"), root: join(f.root, "roam", "mirrors"), operationId: "mirror-b" }, f.journal);
  f.journal.record("mirror-b", "done", {});
  const result = await f.service.control({ op: "forget", machine: BOX, confirmation: `destroyed ${BOX}` });
  expect(result.reason).not.toBe("wrong-dispatch");
  expect(f.mounted).not.toContain("machine-recovery");
  expect(f.restored).toEqual(["session-a:session-a", "session-b:session-b"]);
}, 5000);
it("startup recovers pending moves by their journaled sessions, not every catalog row", async () => {
  const f = await fixture();
  for (const sessionId of ["session-a", "session-b"]) {
    const operation = { id: `move-${sessionId}`, kind: "move", machineId: HUB, expectedEpoch: null, args: { sessionId, destinationMachine: OTHER } };
    f.journal.begin(operation); f.journal.record(operation.id, "move-request", { sessionId, destinationMachine: OTHER, operation });
  }
  await expect(f.service.recover()).resolves.toBeUndefined();
  expect(f.mounted).toEqual(["session-a", "session-b"]);
  expect(f.replayed).toEqual([]);
}, 5000);
it("peer recovery mounts only pending moves involving that source or destination", async () => {
  const f = await fixture();
  for (const [sessionId, source, destination] of [["session-a", HUB, BOX], ["session-b", BOX, OTHER], ["session-c", HUB, OTHER]] as const) {
    const operation = { id: `move-${sessionId}`, kind: "move", machineId: HUB, expectedEpoch: 1, args: { sessionId, destinationMachine: destination } };
    f.journal.begin(operation);
    f.journal.record(operation.id, "move-request", { sessionId, destinationMachine: destination, operation });
    f.journal.record(operation.id, "move-action-complete", { action: "check", value: { source: { sessionId, machineId: source }, destinationMachine: destination } });
  }
  await f.service.recover(BOX);
  expect(f.mounted).toEqual(["session-a", "session-b"]);
}, 5000);

it("full peer recovery and cleanup share one writer and coalesce concurrent requests", async () => {
  const f = await fixture();
  const operation = { id: "move-session-a", kind: "move", machineId: HUB, expectedEpoch: 1, args: { sessionId: "session-a", destinationMachine: OTHER } };
  f.journal.begin(operation);
  f.journal.record(operation.id, "move-request", { sessionId: "session-a", destinationMachine: OTHER, operation });
  let entered!: () => void, release!: () => void, active = 0, maximum = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const service = createMoveRuntimeService({ root: f.root, globalDb: f.global.db, config: f.ports.config, journal: f.journal, transport: {} as Transport }, async input => {
    active++; maximum = Math.max(maximum, active); entered(); await hold;
    const mounted = await f.factory(input);
    return { ...mounted, async close() { active--; await mounted.close(); } };
  });
  const first = service.recover(OTHER); await started;
  const second = service.recover(OTHER), cleanup = service.recoverCleanup(OTHER);
  expect(active).toBe(1);
  release(); await Promise.all([first, second, cleanup]);
  expect(maximum).toBe(1);
  expect(f.mounted).toEqual(["session-a"]);
}, 5000);

it("a running full peer pass queues exactly one follow-up snapshot", async () => {
  const f = await fixture();
  const add = (sessionId: string) => {
    const operation = { id: `move-${sessionId}`, kind: "move", machineId: HUB, expectedEpoch: 1, args: { sessionId, destinationMachine: OTHER } };
    f.journal.begin(operation); f.journal.record(operation.id, "move-request", { sessionId, destinationMachine: OTHER, operation });
  };
  add("session-a");
  let entered!: () => void, release!: () => void, active = 0, maximum = 0;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const service = createMoveRuntimeService({ root: f.root, globalDb: f.global.db, config: f.ports.config, journal: f.journal, transport: {} as Transport }, async input => {
    active++; maximum = Math.max(maximum, active); calls.push(input.sessionId);
    try { if (calls.length === 1) { entered(); await held; } throw new Error("synthetic participant still pending"); }
    finally { active--; }
  });
  const first = service.recover(OTHER); await started;
  add("session-b");
  const second = service.recover(OTHER), third = service.recover(OTHER), fourth = service.recover(OTHER);
  release(); await Promise.all([first, second, third, fourth]);
  expect(calls).toEqual(["session-a", "session-a", "session-b"]);
  expect(maximum).toBe(1);
}, 5000);

it("startup replays a completed move's pending source view through only its recorded session", async () => {
  const f = await fixture(), moveId = "present-move-a", taskId = presentationTaskId(moveId);
  f.ports.config.peers = f.ports.config.peers.map(peer => ({ ...peer, node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/spider" }));
  const source = f.oldHome!, home = casHome(f.global.db, source, HUB, moveId, HUB);
  const target = { machineId: HUB, alias: null, sessionId: home.sessionId, homeEpoch: home.epoch, coreId: "fixture-core", terminalId: "fixture-terminal" };
  const operation = { id: moveId, kind: "move", machineId: HUB, expectedEpoch: source.epoch, args: { sessionId: home.sessionId } };
  f.journal.begin(operation);
  f.journal.record(moveId, "handoff-presentation-start", { target });
  f.journal.record(moveId, "done", {});
  f.journal.begin({ id: taskId, kind: "move-presentation", machineId: HUB, expectedEpoch: home.epoch, args: { moveId, sessionId: home.sessionId } });
  f.journal.record(taskId, "source-view-request", { check: { source: { ...source } }, operation, proof: {} });
  const cleaned: string[] = [], presented: string[] = [], mounted: string[] = [];
  const unavailable = async (): Promise<never> => { throw new Error("must not run ownership effects"); };
  const transport: Transport = {
    resolve: async peer => ({ ...peer, core: peer.core! }),
    async exec(_peer, argv) {
      const op = JSON.parse(argv[2]);
      expect(op.kind).toBe("move-cleanup-terminal");
      cleaned.push(op.args.sessionId);
      return Buffer.from(JSON.stringify({ operationId: op.id, code: 0, epoch: source.epoch, value: {} }));
    }, bootstrapProbe: unavailable, run: unavailable, read: unavailable, write: unavailable,
  };
  const factory: MoveRuntimeFactory = async input => {
    mounted.push(input.sessionId);
    const bindings: MoveAdapterBindings = {
      globalDb: f.global.db,
      participant: { pi: "/fixture/pi", config: f.ports.config, globalDb: f.global.db, root: f.root, runtimeRoot: f.root, stores: [],
        withBothLocks: unavailable, probe: unavailable, git: { run: unavailable, scratch: f.root, worktreeCommand: null }, writers: unavailable,
        sessionTarget: unavailable, auth: unavailable, identityCurrent: unavailable, wake: unavailable, readiness: unavailable, observation: unavailable,
        dormant: () => unavailable, retireFailed: unavailable, readmitLive: unavailable, cleanupTerminal: unavailable },
      handoff: { prepareHandoff: unavailable, readyTarget: unavailable, async presentReadyTarget(value) {
        expect(value.sessionId).toBe(input.sessionId); presented.push(value.sessionId);
        return { status: "complete", reason: "presented", presentation: null };
      } },
    };
    const ports = createMovePorts(f.ports.config, transport, f.journal, bindings);
    bindings.evidence = createHubMoveEvidencePorts(ports, {});
    return { bindings, ports, control: unavailable, recover: unavailable, async close() {} };
  };
  const service = createMoveRuntimeService({ root: f.root, config: f.ports.config, globalDb: f.global.db, journal: f.journal, transport }, factory);
  await service.recover();
  expect(mounted).toEqual([home.sessionId]);
  expect(presented).toEqual([home.sessionId]);
  expect(cleaned).toEqual([home.sessionId]);
  expect(f.journal.lookupOperation(taskId)?.state).toBe("done");
  await service.recover();
  expect(mounted).toHaveLength(1);
}, 5000);

it.each(["ready", "pending", "successor-pending", "successor-revoked", "successor-started", "successor-claimed", "source-home", "pruned", "source-offline", "concurrent", "home-changes-under-lock", "home-changes-during-presentation"] as const)("superseded source cleanup converges when the successor is %s", async scenario => {
  const f = await fixture(), sessionId = "session-b", firstMove = "move-first", nextMove = "move-second";
  f.ports.config.peers = f.ports.config.peers.map(peer => ({ ...peer, node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/spider" }));
  const source = assignInitialHome(f.global.db, sessionId, HUB, HUB);
  if (source === "conflict") throw new Error("Initial home conflict");
  const firstHome = casHome(f.global.db, source, BOX, firstMove, HUB);
  let current = casHome(f.global.db, firstHome, scenario === "source-home" ? HUB : OTHER, nextMove, HUB);
  const first: Operation = { id: firstMove, kind: "move", machineId: HUB, expectedEpoch: source.epoch, args: { sessionId, destinationMachine: BOX } };
  const next: Operation = { id: nextMove, kind: "move", machineId: HUB, expectedEpoch: firstHome.epoch, args: { sessionId, destinationMachine: current.machineId } };
  const locator = (home: typeof current, terminalId: string) => ({ machineId: home.machineId, alias: null, sessionId, homeEpoch: home.epoch, coreId: "fixture-core", terminalId });
  const oldTarget = locator(firstHome, "first-terminal"), oldTask = presentationTaskId(firstMove);
  const check = { source, destinationMachine: BOX };
  const proof = { source, stopped: { kind: "absent" }, destination: { home: firstHome, owner: { kind: "live", identity: { bootId: "boot", pid: 42, startTime: "start" } },
    readiness: { origin: "hub-operation", opId: firstMove, sessionId, epoch: firstHome.epoch, file: f.file, cwd: f.root, core: "fixture-core", terminal: "first-terminal" }, retired: false, launchFailure: null } };
  f.journal.begin(first);
  f.journal.record(firstMove, "handoff-presentation-start", { target: oldTarget, sourceFence: { moveId: firstMove } });
  f.journal.record(firstMove, "done", {});
  f.journal.begin({ id: oldTask, kind: "move-presentation", machineId: HUB, expectedEpoch: firstHome.epoch, args: { moveId: firstMove, sessionId } });
  f.journal.record(oldTask, "source-view-request", JSON.parse(JSON.stringify({ operation: first, check, proof })));
  f.journal.begin(next);
  if (scenario === "successor-pending") f.journal.record(nextMove, "handoff-presentation-start", { target: locator(current, `terminal-${current.epoch}`), sourceFence: { moveId: nextMove } });
  f.journal.record(nextMove, "done", {});
  if (scenario === "successor-pending") {
    const nextTask = presentationTaskId(nextMove), nextCheck = { source: firstHome, destinationMachine: current.machineId };
    const nextProof = { source: firstHome, stopped: { kind: "absent" }, destination: { home: current, owner: { kind: "live", identity: { bootId: "boot", pid: 43, startTime: "start" } },
      readiness: { origin: "hub-operation", opId: nextMove, sessionId, epoch: current.epoch, file: f.file, cwd: f.root, core: "fixture-core", terminal: `terminal-${current.epoch}` }, retired: false, launchFailure: null } };
    f.journal.begin({ id: nextTask, kind: "move-presentation", machineId: HUB, expectedEpoch: current.epoch, args: { moveId: nextMove, sessionId } });
    f.journal.record(nextTask, "source-view-request", JSON.parse(JSON.stringify({ operation: next, check: nextCheck, proof: nextProof })));
  }
  let ready = scenario === "successor-started" || scenario === "successor-claimed";
  const markReady = (moveId: string, home: typeof current, finish = true) => {
    ready = true;
    const task = presentationTaskId(moveId), target = locator(home, `terminal-${home.epoch}`);
    f.journal.begin({ id: task, kind: "move-presentation", machineId: HUB, expectedEpoch: home.epoch, args: { moveId, sessionId } });
    f.journal.record(task, "presentation", { status: "complete", reason: "presented", target, presentation: null });
    if (finish) f.journal.record(task, "done", {});
  };
  if (scenario !== "pending" && scenario !== "successor-pending" && scenario !== "successor-started" && scenario !== "successor-claimed" && scenario !== "pruned" && scenario !== "concurrent" && scenario !== "home-changes-during-presentation") markReady(nextMove, current, scenario !== "successor-revoked");
  const terminals = new Set(["source-terminal"]), removed: string[] = [], presented: string[] = [];
  let sourceAvailable = scenario !== "source-offline" && scenario !== "successor-revoked" && scenario !== "successor-started" && scenario !== "successor-claimed", cleanupCalls = 0, changeHome = scenario === "home-changes-under-lock", changeDuringPresentation = scenario === "home-changes-during-presentation";
  let successorCleanups = 0;
  const transport: Transport = { resolve: async peer => ({ ...peer, core: peer.core! }),
    exec: async (_peer, argv) => { const op = JSON.parse(argv[2]) as Operation; if (op.kind !== "move-cleanup-terminal" || op.args.moveId !== nextMove) throw new Error("Unexpected cleanup"); successorCleanups++; return Buffer.from(JSON.stringify({ operationId: op.id, code: 0, epoch: op.expectedEpoch, value: {} })); },
    bootstrapProbe: async () => { throw new Error("Unexpected probe"); }, run: async () => { throw new Error("Unexpected run"); }, read: async () => { throw new Error("Unexpected read"); }, write: async () => { throw new Error("Unexpected write"); } };
  const factory: MoveRuntimeFactory = async input => {
    const bindings: MoveAdapterBindings = {
      globalDb: f.global.db,
      participant: { config: f.ports.config, globalDb: f.global.db,
        withBothLocks: async (_id: string, effect: () => Promise<unknown>) => {
          if (changeHome) { changeHome = false; current = casHome(f.global.db, current, HUB, "returned-home", HUB); }
          return effect();
        },
        cleanupTerminal: async (operation: Operation) => {
          cleanupCalls++;
          expect(operation.args.moveId).toBe(firstMove);
          expect(operation.args.presentation).toMatchObject({ status: "complete", target: { machineId: current.machineId, homeEpoch: current.epoch } });
          if (!sourceAvailable) throw new Error("Source is unavailable");
          if (!terminals.delete("source-terminal")) throw new Error("Source terminal removed twice");
          removed.push("source-terminal");
        } } as never,
      handoff: { prepareHandoff: async () => { throw new Error("Unexpected capture"); }, readyTarget: async home => ready ? locator(home, `terminal-${home.epoch}`) : null,
        presentReadyTarget: async target => {
          presented.push(target.terminalId);
          if (changeDuringPresentation) { changeDuringPresentation = false; current = casHome(f.global.db, current, HUB, "returned-home", HUB); }
          return { status: ready ? "complete" : "pending", reason: ready ? "presented" : "not-ready", presentation: null };
        } },
    };
    const ports = createMovePorts(f.ports.config, transport, f.journal, bindings);
    bindings.evidence = createHubMoveEvidencePorts(ports, {});
    return { bindings, ports, control: async () => ({ code: 1, reason: "unexpected", value: null }), recover: async () => [], async close() {} };
  };
  const service = createMoveRuntimeService({ root: f.root, config: f.ports.config, globalDb: f.global.db, journal: f.journal, transport }, factory);
  const count = () => (f.db.prepare("SELECT COUNT(*) AS n FROM roam_operation_actions").get() as { n: number }).n;
  await service.recover();
  expect(f.journal.lookupOperation(oldTask)?.state).toBe("done");
  expect(f.journal.read(oldTask).filter(row => row.action === "done")).toHaveLength(1);
  if (scenario === "ready") expect(removed).toEqual(["source-terminal"]);
  else expect(terminals.has("source-terminal")).toBe(true);
  const afterFirst = count();
  await service.recover(); await service.recover();
  expect(count()).toBe(afterFirst);
  if (scenario === "pending" || scenario === "pruned" || scenario === "concurrent" || scenario === "home-changes-during-presentation") markReady(nextMove, current);
  if (scenario === "successor-pending") ready = true;
  if (scenario === "successor-started" || scenario === "successor-claimed") {
    const nextTask = presentationTaskId(nextMove);
    f.journal.begin({ id: nextTask, kind: "move-presentation", machineId: HUB, expectedEpoch: current.epoch, args: { moveId: nextMove, sessionId } });
    if (scenario === "successor-started") f.journal.record(nextTask, "source-view-request", JSON.parse(JSON.stringify({ operation: next, check: { source: firstHome }, proof: {} })));
    sourceAvailable = true;
    const afterStart = count();
    await service.recover();
    expect(removed).toEqual([]);
    expect(count()).toBe(afterStart);
    markReady(nextMove, current);
  }
  if (scenario === "successor-revoked") {
    const nextTask = presentationTaskId(nextMove), target = locator(current, `terminal-${current.epoch}`);
    f.journal.record(nextTask, "presentation", { status: "pending", reason: "presentation-disconnected", target, presentation: null });
    sourceAvailable = true;
    const afterPending = count();
    await service.recover();
    expect(removed).toEqual([]);
    expect(count()).toBe(afterPending);
    f.journal.record(nextTask, "presentation", { status: "complete", reason: "presented", target, presentation: null });
    f.journal.record(nextTask, "done", {});
  }
  if (scenario === "pruned" || scenario === "source-offline" || scenario === "home-changes-during-presentation") {
    expect(f.journal.prune(Date.now() + 8 * 24 * 60 * 60 * 1000, 1)).toContain(oldTask);
    expect(f.journal.lookupOperation(presentationTaskId(nextMove))).toBeNull();
    sourceAvailable = true;
  }
  if (scenario === "home-changes-during-presentation") {
    await service.recover();
    expect(removed).toEqual([]);
    expect(terminals.has("source-terminal")).toBe(true);
    const afterChange = count();
    await service.recover(); await service.recover();
    expect(count()).toBe(afterChange);
  }
  if (scenario === "source-home" || scenario === "home-changes-under-lock" || scenario === "home-changes-during-presentation") {
    current = casHome(f.global.db, current, OTHER, "move-third", HUB);
    markReady("move-third", current);
  }
  if (scenario === "concurrent") await Promise.all([service.recover(), service.recover(), service.recover()]);
  else await service.recover();
  expect(removed).toEqual(["source-terminal"]);
  expect(terminals.has("source-terminal")).toBe(false);
  if (scenario === "concurrent") expect(cleanupCalls).toBe(1);
  if (scenario === "successor-pending") { expect(presented.length).toBeGreaterThan(0); expect(presented.every(id => id === "terminal-3")).toBe(true); expect(successorCleanups).toBe(1); }
  else expect(presented).toEqual(scenario === "pruned" || scenario === "successor-started" || scenario === "successor-claimed" || scenario === "home-changes-during-presentation" ? ["terminal-3"] : []);
  const afterCleanup = count();
  await service.recover(); await service.recover();
  expect(count()).toBe(afterCleanup);
  expect(removed).toEqual(["source-terminal"]);
}, 5000);

it("a superseded remote source accepts only the current hub presentation and original cleanup proof", async () => {
  const f = await fixture(), sessionId = "session-a", firstMove = "remote-first", nextMove = "remote-second", source = f.oldHome!;
  f.ports.config.peers = f.ports.config.peers.map(peer => ({ ...peer, node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/spider" }));
  const firstHome = casHome(f.global.db, source, HUB, firstMove, HUB), current = casHome(f.global.db, firstHome, OTHER, nextMove, HUB);
  const operation: Operation = { id: firstMove, kind: "move", machineId: HUB, expectedEpoch: source.epoch, args: { sessionId, destinationMachine: HUB } };
  const check = { source, destinationMachine: HUB }, oldTarget = { machineId: HUB, alias: null, sessionId, homeEpoch: firstHome.epoch, coreId: "core-hub", terminalId: "old-terminal" };
  const target = { machineId: OTHER, alias: null, sessionId, homeEpoch: current.epoch, coreId: "core-remote", terminalId: "new-terminal" };
  const proof = { source, stopped: { kind: "absent" }, destination: { home: firstHome, owner: { kind: "live", identity: { bootId: "boot", pid: 42, startTime: "start" } },
    readiness: { origin: "hub-operation", opId: firstMove, sessionId, epoch: firstHome.epoch, file: f.file, cwd: f.root, core: "core-hub", terminal: "old-terminal" }, retired: false, launchFailure: null } };
  f.journal.begin(operation); f.journal.record(firstMove, "handoff-presentation-start", { target: oldTarget }); f.journal.record(firstMove, "done", {});
  const oldTask = presentationTaskId(firstMove), nextTask = presentationTaskId(nextMove);
  f.journal.begin({ id: oldTask, kind: "move-presentation", machineId: HUB, expectedEpoch: firstHome.epoch, args: { moveId: firstMove, sessionId } });
  f.journal.record(oldTask, "source-view-request", JSON.parse(JSON.stringify({ operation, check, proof })));
  f.journal.begin({ id: nextTask, kind: "move-presentation", machineId: HUB, expectedEpoch: current.epoch, args: { moveId: nextMove, sessionId } });
  f.journal.record(nextTask, "presentation", { status: "complete", reason: "presented", target, presentation: null }); f.journal.record(nextTask, "done", {});
  const sourceJournal = openFreezeJournal(join(f.root, "source-journal.db")), boxConfig = { ...f.ports.config, role: "box" as const, machineId: BOX };
  let removals = 0, forwarded: Operation | null = null;
  const sourceBindings: MoveAdapterBindings = { globalDb: f.global.db, participant: { config: boxConfig, globalDb: f.global.db,
    withBothLocks: async (_id: string, effect: () => Promise<unknown>) => effect(), cleanupTerminal: async () => { removals++; } } as never,
    evidence: createPushedMoveEvidencePorts(f.global.db, boxConfig) };
  const transport: Transport = { resolve: async peer => ({ ...peer, core: peer.core! }), bootstrapProbe: async () => { throw new Error("Unexpected probe"); },
    run: async () => { throw new Error("Unexpected run"); }, read: async () => { throw new Error("Unexpected read"); }, write: async () => { throw new Error("Unexpected write"); },
    exec: async (_peer, argv) => { forwarded = JSON.parse(argv[2]) as Operation; return Buffer.from(JSON.stringify(await handleMoveParticipantOperation(forwarded, sourceJournal, sourceBindings))); } };
  const bindings: MoveAdapterBindings = { globalDb: f.global.db, participant: { config: f.ports.config } as never };
  const ports = createMovePorts(f.ports.config, transport, f.journal, bindings);
  bindings.evidence = createHubMoveEvidencePorts(ports, {});
  const service = createMoveRuntimeService({ root: f.root, config: f.ports.config, globalDb: f.global.db, journal: f.journal, transport },
    async () => ({ ports, bindings, control: async () => ({ code: 1, reason: "unexpected", value: null }), recover: async () => [], async close() {} }));
  await service.recover();
  expect(removals).toBe(1);
  expect(f.journal.lookupOperation(oldTask)?.state).toBe("done");
  const sent = forwarded as Operation | null;
  if (!sent) throw new Error("Cleanup was not sent");
  expect(sent.args.hubEvidence).toMatchObject({ kind: "presentation", home: current, value: { status: "complete", target } });
  const clean = { ...sent, args: { ...sent.args } }; delete clean.args.hubEvidence;
  expect(await bindings.evidence.presentation!(clean)).toMatchObject({ status: "complete", target });
  expect(await bindings.evidence.presentation!({ ...clean, args: { ...clean.args, proof: JSON.parse(JSON.stringify({ ...proof, stopped: { kind: "live" } })) } })).toBeNull();
  expect(await bindings.evidence.presentation!({ ...clean, args: { ...clean.args, presentationMoveId: "unrelated" } })).toBeNull();
  const count = (f.db.prepare("SELECT COUNT(*) AS n FROM roam_operation_actions").get() as { n: number }).n;
  await service.recover(); await service.recover();
  expect((f.db.prepare("SELECT COUNT(*) AS n FROM roam_operation_actions").get() as { n: number }).n).toBe(count);
  expect(removals).toBe(1);
}, 5000);

it("a pending presentation repairs an interrupted move journal write without repeated rows", async () => {
  const f = await fixture(), source = f.oldHome!, moveId = "interrupted-presentation", sessionId = source.sessionId;
  const home = casHome(f.global.db, source, HUB, moveId, HUB), task = presentationTaskId(moveId);
  const operation: Operation = { id: moveId, kind: "move", machineId: HUB, expectedEpoch: source.epoch, args: { sessionId } };
  const target = { machineId: HUB, alias: null, sessionId, homeEpoch: home.epoch, coreId: "fixture-core", terminalId: "fixture-terminal" };
  const sourceFence = { moveId }, value = { target, sourceFence, status: "pending", reason: "app-unavailable", presentation: null };
  f.journal.begin(operation); f.journal.record(moveId, "handoff-presentation-start", { target, sourceFence });
  f.journal.begin({ id: task, kind: "move-presentation", machineId: HUB, expectedEpoch: home.epoch, args: { moveId, sessionId } });
  f.journal.record(task, "source-view-request", JSON.parse(JSON.stringify({ check: { source }, operation, proof: {} })));
  f.journal.record(task, "presentation", value);
  const bindings: MoveAdapterBindings = { globalDb: f.global.db, participant: { config: f.ports.config } as never,
    handoff: { prepareHandoff: async () => { throw new Error("Unexpected capture"); }, readyTarget: async () => null,
      presentReadyTarget: async () => ({ status: "pending", reason: "app-unavailable", presentation: null }) } };
  const ports = createMovePorts(f.ports.config, {} as Transport, f.journal, bindings), before = f.journal.read(task).length;
  await recoverMovePresentation(ports, moveId);
  expect(f.journal.read(task)).toHaveLength(before);
  expect(f.journal.read(moveId).filter(row => row.action === "handoff-presentation").map(row => row.result)).toEqual([value]);
  await recoverMovePresentation(ports, moveId);
  expect(f.journal.read(task)).toHaveLength(before);
  expect(f.journal.read(moveId).filter(row => row.action === "handoff-presentation")).toHaveLength(1);
}, 5000);

it("forget with no affected homes revokes without mounting a placeholder runtime", async () => {
  const f = await fixture();
  const result = await f.service.control({ op: "forget", machine: OTHER, confirmation: `destroyed ${OTHER}` });
  expect(result).toMatchObject({ code: 0, reason: "destroyed-machine-recovered" });
  expect(f.mounted).toEqual([]);
}, 5000);

it("one interrupted checkout reports a diagnostic and does not prevent later restore replay", async () => {
  const attempts: string[] = [];
  const restores = ["missing", "available"].map(destination => ({ destination,
    async withBothLocks(effect: () => Promise<void>) { attempts.push(destination); throw new Error("checkout-unavailable"); },
  } as unknown as WorkspaceRestore));
  const result = await recoverWorkspaceRestores(restores);
  expect(attempts).toEqual(["missing", "available"]);
  expect(result).toEqual([{ destination: "missing", reason: "workspace-recovery-pending" }, { destination: "available", reason: "workspace-recovery-pending" }]);
}, 5000);

it("disabled service allows only forget among move controls", async () => {
  const f = await fixture(); f.ports.config.enabled = false;
  expect(await f.service.control({ op: "forget", machine: OTHER, confirmation: `destroyed ${OTHER}` })).toMatchObject({ code: 0 });
  for (const request of [{ op: "move", session: "session-a", machine: OTHER }, { op: "cancel", operationId: "move-a" }, { op: "recover", operationId: "move-a" }, { op: "claim", session: "session-a", machine: OTHER }] as const) {
    expect(await f.service.control(request)).toMatchObject({ code: 1, reason: "roaming-disabled" });
  }
  expect(f.mounted).toEqual([]);
}, 5000);

it("restore inventory excludes completed transitions before any path or ownership lock", async () => {
  const f = await fixture();
  for (const [id, sessionId, complete] of [["move-a", "session-a", true], ["move-b", "session-b", false]] as const) {
    f.journal.begin({ id, kind: "move", machineId: HUB, expectedEpoch: null, args: { sessionId } });
    f.journal.record(id, "workspace-session", { sessionId });
    f.journal.record(id, "workspace-settings-transition", { transitionId: id, root: "/missing.invalid/workspace", snapshotJson: "not read until session mount" });
    if (complete) f.journal.record(id, "workspace-settings-transition-complete", { transitionId: id });
  }
  expect(pendingWorkspaceTransitions(f.db, f.journal).map(row => row.sessionId)).toEqual(["session-b"]);
  expect(pendingWorkspaceTransitions(f.db, f.journal, "session-a")).toEqual([]);
  await f.service.recover();
  expect(f.replayed).toEqual(["session-b"]);
}, 5000);

it("reconnect retries a completed move's queued cleanup under its own session", async () => {
  const f = await fixture(), id = abortCleanupId("move-a");
  f.journal.begin({ id, kind: "move-abort-cleanup", machineId: HUB, expectedEpoch: 1, args: { moveId: "move-a", sessionId: "session-a" } });
  f.journal.record(id, "abort-cleanup-request", { moveId: "move-a", sessionId: "session-a", check: { source: { ...f.oldHome! }, destinationMachine: OTHER } });
  await f.service.recoverCleanup(OTHER);
  expect(f.cleaned).toEqual(["session-a:session-a"]);
  expect(f.journal.lookupOperation(id)?.state).toBe("done");
  await f.service.recoverCleanup(OTHER);
  expect(f.cleaned).toHaveLength(1);
}, 5000);


it('sync cleanup does no work without pending operations and joins overlapping runs', async () => {
  const f = await fixture();
  await f.service.recoverCleanup();
  expect(f.mounted).toEqual([]);
  const operation = { id: 'cleanup-move', machineId: HUB, kind: 'move', expectedEpoch: 1, args: { sessionId: 'session-a', destinationMachine: OTHER } };
  f.journal.begin(operation);
  f.journal.record(operation.id, 'move-request', { operation, sessionId: 'session-a', destinationMachine: OTHER });
  f.journal.record(operation.id, 'move-source-cleanup-pending', { sessionId: 'session-a', sourceMachine: BOX, sourceCleanup: { status: 'pending', reason: 'move-source-stop-pending', blockers: ['process-exit-unproven'] } });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const service = createMoveRuntimeService({ root: f.root, globalDb: f.global.db, config: f.ports.config, journal: f.journal, transport: {} as Transport }, async input => {
    calls++; await held; return f.factory(input);
  });
  const first = service.recoverCleanup(), second = service.recoverCleanup();
  await Promise.resolve();
  expect(calls).toBe(1);
  release(); await Promise.all([first, second]);
  expect(calls).toBe(1);
  expect(f.journal.lookupOperation(operation.id)?.state).toBe('done');
  await service.recoverCleanup();
  expect(calls).toBe(1);
});

it("source cleanup ignores synchronization with a different machine", async () => {
  const f = await fixture(), operation = { id: "source-only", machineId: HUB, kind: "move", expectedEpoch: 1, args: { sessionId: "session-a", destinationMachine: OTHER } };
  f.journal.begin(operation);
  f.journal.record(operation.id, "move-request", { operation, sessionId: "session-a", destinationMachine: OTHER });
  f.journal.record(operation.id, "move-source-cleanup-pending", { sessionId: "session-a", sourceMachine: BOX, sourceCleanup: { status: "pending", reason: "move-source-stop-pending", blockers: ["process-exit-unproven"] } });
  await f.service.recoverCleanup(OTHER);
  expect(f.mounted).toEqual([]);
  await f.service.recoverCleanup(BOX);
  expect(f.mounted).toEqual(["session-a"]);
}, 5000);

it("cleanup coalesces evidence arriving during a flight into one trailing run", async () => {
  const f = await fixture();
  const add = (id: string) => {
    const operation = { id, machineId: HUB, kind: "move", expectedEpoch: 1, args: { sessionId: "session-a", destinationMachine: OTHER } };
    f.journal.begin(operation); f.journal.record(id, "move-request", { operation, sessionId: "session-a", destinationMachine: OTHER });
    f.journal.record(id, "move-source-cleanup-pending", { sessionId: "session-a", sourceMachine: BOX, sourceCleanup: { status: "pending", reason: "move-source-stop-pending", blockers: ["process-exit-unproven"] } });
  };
  add("first-cleanup");
  let entered!: () => void, release!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const service = createMoveRuntimeService({ root: f.root, globalDb: f.global.db, config: f.ports.config, journal: f.journal, transport: {} as Transport }, async input => {
    if (++calls === 1) { entered(); await held; }
    return f.factory(input);
  });
  const first = service.recoverCleanup(BOX); await started;
  add("second-cleanup");
  const second = service.recoverCleanup(BOX), third = service.recoverCleanup(BOX);
  release(); await Promise.all([first, second, third]);
  expect(f.journal.lookupOperation("second-cleanup")?.state).toBe("done");
  expect(calls).toBe(2);
}, 5000);

it.each(["outcome", "throw"] as const)("source cleanup exposes its %s reason in cached diagnostics", async mode => {
  const { readLocal } = await import("@spider/db-core/roam/local-state"), { readStatus } = await import("../diagnostics"), f = await fixture();
  const operation = { id: "diagnostic-cleanup", machineId: HUB, kind: "move", expectedEpoch: 1, args: { sessionId: "session-a", destinationMachine: OTHER } };
  f.journal.begin(operation); f.journal.record(operation.id, "move-request", { operation, sessionId: "session-a", destinationMachine: OTHER });
  f.journal.record(operation.id, "move-source-cleanup-pending", { sessionId: "session-a", sourceMachine: BOX, sourceCleanup: { status: "pending", reason: "move-source-stop-pending", blockers: ["process-exit-unproven"] } });
  if (mode === "outcome") f.journal.record(operation.id, "move-action-complete", { action: "start", value: { code: "invalid-fixture-code" } });
  const service = createMoveRuntimeService({ root: f.root, globalDb: f.global.db, config: f.ports.config, journal: f.journal, transport: {} as Transport }, async input => {
    if (mode === "throw") throw Object.assign(new Error("unavailable /fixture/private secret=private-value"), { reason: "fixture-transport-unavailable" });
    return f.factory(input);
  });
  await service.recoverCleanup(BOX);
  const reason = mode === "outcome" ? "move-journal-invalid" : "fixture-transport-unavailable";
  expect(readLocal(f.global.db, "recovery-diagnostic", operation.id)).toEqual({ reason });
  const status = readStatus(f.ports.config, { globalDb: f.global.db, journalDb: f.db, stores: [], now: 10, observations: [] });
  expect(status.diagnostics).toContainEqual({ severity: "warning", reason: `Move recovery pending: ${reason}.`, repairCommand: `spider roam recover ${operation.id}` });
}, 5000);

it("cleanup does not lose a request at the final microtask boundary of its flight", async () => {
  const f = await fixture(), operation = { id: "last-flight-request", machineId: HUB, kind: "move", expectedEpoch: 1, args: { sessionId: "session-a", destinationMachine: OTHER } };
  f.journal.begin(operation); f.journal.record(operation.id, "move-request", { operation, sessionId: "session-a", destinationMachine: OTHER });
  f.journal.record(operation.id, "move-source-cleanup-pending", { sessionId: "session-a", sourceMachine: BOX, sourceCleanup: { status: "pending", reason: "move-source-stop-pending", blockers: ["process-exit-unproven"] } });
  f.journal.record(operation.id, "move-action-complete", { action: "start", value: { code: "invalid-fixture-code" } });
  let calls = 0, trailing!: Promise<void>, requested!: () => void;
  const requestArrived = new Promise<void>(resolve => { requested = resolve; });
  const service = createMoveRuntimeService({ root: f.root, globalDb: f.global.db, config: f.ports.config, journal: f.journal, transport: {} as Transport }, async input => {
    calls++; const mounted = await f.factory(input);
    return { ...mounted, async close() {
      if (calls === 1) queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => { trailing = service.recoverCleanup(BOX); requested(); })));
    } };
  });
  const first = service.recoverCleanup(BOX); await requestArrived;
  await Promise.all([first, trailing]);
  expect(calls).toBe(2);
}, 5000);
