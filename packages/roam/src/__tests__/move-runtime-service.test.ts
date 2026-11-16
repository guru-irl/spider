import { afterEach, expect, it } from "vitest";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "@spider/db-core";
import { assignInitialHome, casHome } from "../homes";
import { createMovePorts, createHubMoveEvidencePorts, presentationTaskId, type MoveAdapterBindings } from "../move-ports";
import { appendMirror } from "../mirrors";
import { inspectSession } from "../session-file";
import { openFreezeJournal } from "../journal";
import { recoverWorkspaceRestores, pendingWorkspaceTransitions, abortCleanupId } from "../move-recovery";
import type { WorkspaceRestore } from "../contracts";
import { withProcessLock } from "@spider/herdr/sessions/registry";
import { createMoveRuntimeService } from "../move-runtime-service";
import { recoveryFixture, BOX, HUB, OTHER } from "./recovery-fixture";
import type { MoveRuntime, MoveRuntimeFactory } from "../move-runtime-contracts";
import type { Transport } from "../contracts";
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
