import { abortCleanupId } from "../move-recovery";
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from "vitest";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { controlText, safeControlOutcome } from "../commands";
import type { HostingWarning } from "../hosting-warning";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createReplica, scratchDbPath } from "@spider/db-core/testutil";
import { seedSession } from "@spider/db-core/roam/seed";
import type { Home, HubOperationReadiness, JsonObject, Probe, StoreBarrier } from "@spider/db-core/roam/types";
import type { IntercomIntakeFence } from "@spider/intercom/protocol";
import { DEFAULT_LIMITS, disabledIntercom } from "../contracts";
import type { MoveCheck, MovePorts, MoveRequest, Operation, PreparedMove, WorkspaceSnapshot } from "../contracts";
import { assignInitialHome, casHome, sessionHome } from "../homes";
import { openJournal } from "../journal";
import * as moves from "../move";
import { movePowerKey, releaseMovePower } from "../power";
import { createIntentStore } from "../intent";
import { createDurableLaunchPort, createSupervisor } from "../supervisor";

const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002";
const identity = { bootId: "fake-boot", pid: 42, startTime: "fake-birth" };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const encode = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value));
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

// Effects use real home transactions, membership rows, files and durable journals.
// Only process, power, participant transport and boot identity are synthetic.
function fixture(fault = "") {
  const global = createReplica("global", HUB), stores = [createReplica("worktree", HUB), createReplica("worktree", HUB)];
  const root = mkdtempSync(join(dirname(scratchDbPath("move-fault")), "move-fault-")), file = join(root, "original.jsonl"), target = join(root, "installed.jsonl");
  mkdirSync(root, { recursive: true });
  const original = JSON.stringify({ type: "session", version: 3, id: "session-a", cwd: root }) + "\n" + JSON.stringify({ type: "message", id: "leaf-a", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "fixture", timestamp: 1 } }) + "\n";
  writeFileSync(file, original, { mode: 0o600 });
  stores[1].db.prepare("UPDATE roam_meta SET store_key='worktree:fixture-repo:binding'").run();
  for (const store of stores) {
    store.db.prepare("INSERT INTO sessions(id,started_at) VALUES ('session-a',1)").run();
    seedSession(store.db, "session-a", 1, store === stores[0] ? store.storeKey : "worktree:fixture-repo:binding", DEFAULT_LIMITS.targetBatchBytes);
  }
  const sourceHome = assignInitialHome(global.db, "session-a", HUB, HUB) as Home;
  const request: MoveRequest = { sessionId: "session-a", destinationMachine: BOX,
    operation: { id: "move-a", kind: "move", machineId: HUB, expectedEpoch: 1, args: { sessionId: "session-a", destinationMachine: BOX } } };
  const journal = openJournal(join(root, "move-journal.db")), participant = openJournal(join(root, "destination-journal.db"));
  const ownersAtEveryObservation: number[] = [], events: string[] = [], sourceLaunches: string[] = [];
  let hit = false, sourceActive = true, sourceAlive = true, destinationActive = false, reachable = true;
  let readiness: HubOperationReadiness | null = null, failure: string | null = null, retired = false, activationCancelled = false, held = false;
  let intakeOpen = true;
  const release = { generation: "fake-generation", moveId: "move-a", rollbackReceiptId: null as string | null };
  let fence: IntercomIntakeFence | null = null, readmitResult: Awaited<ReturnType<MovePorts["readmitSource"]>> | null = null;
  const observe = () => { ownersAtEveryObservation.push(Number(sourceActive) + Number(destinationActive)); };
  const crash = (point: string) => { observe(); if (!hit && fault === point) { hit = true; throw new Error("fake power loss after durable effect"); } };
  const wrappedJournal = { ...journal, record(id: string, action: string, value: JsonObject) {
    if (action === "move-action-complete") crash(`effect:${value.action}`);
    journal.record(id, action, value);
    if (action === "move-state") crash(`state:${value.state}`);
    if (action === "move-action-complete") crash(`reply:${value.action}`);
    if (action === "move-action-start") crash(`before:${value.action}`);
    if (action === "done") crash("done-receipt");
    if (action === "released") crash("reservation-release");
    if (action.startsWith("move-abort-") || action.startsWith("move-rollback-")) crash(action);
  } };
  const barriers: StoreBarrier[] = ["global", "repo:fixture-repo", stores[0].storeKey, "worktree:fixture-repo:binding"].map(storeKey => ({ storeKey: storeKey as StoreBarrier["storeKey"], stream: "fixture-stream", through: 1 }));
  const check: MoveCheck = { source: sourceHome, destinationMachine: BOX, repoKey: "fixture-repo", workspaceId: "fixture-workspace",
    sourceRoot: root, sourceFile: file, sourceCwd: root, destinationRoot: root, destinationCwd: root,
    storeKeys: barriers.map(row => row.storeKey), warnings: [] };
  // createReplica uses a stable synthetic workspace key; bind the check to it.
  check.workspaceId = stores[0].storeKey.split(":")[2];
  check.repoKey = stores[0].storeKey.split(":")[1];
  const snapshot = (stage: "pre" | "final"): WorkspaceSnapshot => ({ root, repoKey: check.repoKey, workspaceId: check.workspaceId, moveId: "move-a", stage,
    head: "a".repeat(40), branch: null, objectFormat: "sha1", indexTree: "b".repeat(40), workingTree: "c".repeat(40), relativeCwd: "",
    sparsePatterns: null, worktreeConfig: null, normalization: { autocrlf: "false", eol: "native" }, sparse: { enabled: false, cone: false },
    droppedConfigKeys: [], refs: [], prerequisites: [], bundle: { kind: "unbundled" } });
  const prepared = (stage: "pre" | "final"): PreparedMove => ({ workspace: { root, snapshot: snapshot(stage), previous: null, moveId: "move-a", adjustments: [] },
    session: { file: target, sessionId: "session-a", cwd: root, leaf: "leaf-a", size: readFileSync(target).length, sha256: digest(target), historySha256: digest(file), artifactId: "session-artifact" } });
  const ensureReachable = () => { if (!reachable) throw new Error("fake disconnection"); };
  const ports: MovePorts = {
    config: { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1, limits: DEFAULT_LIMITS, intercom: disabledIntercom() },
    globalDb: global.db, journal: wrappedJournal, clock: { now: () => 1, later: () => () => {} },
    async check() { return check; },
    async power() { held = true; events.push("power"); return async () => { held = false; }; },
    async seed() { return barriers; },
    async prepare() { ensureReachable(); writeFileSync(target, original); crash("workspace-prepared"); return prepared("pre"); },
    async freeze(home, operation) {
      sourceActive = false; intakeOpen = false;
      fence = { address: ports.intercom.address, moveId: "move-a", expectedEpoch: 1, generation: "fake-generation" };
      crash("intake-closed");
      for (let i = 0; i < stores.length; i++) {
        stores[i].db.prepare("UPDATE roam_sessions SET state='frozen',move_id='move-a' WHERE session_id='session-a'").run();
        crash(`store-freeze:${i}`);
      }
      for (const row of barriers) crash(`freeze-barrier:${row.storeKey}`);
      return { operationId: operation.id, sessionId: "session-a", epoch: home.epoch, owner: sourceAlive ? identity : null,
        file, cwd: root, leaf: "leaf-a", size: readFileSync(file).length, sha256: digest(file), barriers, intercomGeneration: "fake-generation" };
    },
    async transfer() { ensureReachable(); writeFileSync(target, original + JSON.stringify({ type: "custom", customType: "spider-roam-segment", id: "segment", parentId: "leaf-a" }) + "\n"); crash("file-install"); return prepared("final"); },
    async verifySource(ack) { if (digest(file) !== ack.sha256 || readFileSync(file).length !== ack.size) throw new Error("source metadata changed"); },
    async barriers(machine, rows) { for (const row of rows) crash(`barrier:${machine === HUB ? "source" : "destination"}:${row.storeKey}`); return true; },
    async replicateHome() { crash("home-replicated"); },
    async start(home, _prepared, operation) {
      ensureReachable();
      participant.begin({ ...operation, kind: "session-start" });
      if (activationCancelled || retired) throw new Error("activation permanently cancelled");
      if (!readiness && !failure) {
        destinationActive = true; crash("process-start");
        readiness = { origin: "hub-operation", opId: operation.id, sessionId: "session-a", epoch: home.epoch, cwd: root, file: target, core: "fake-core", terminal: "fake-terminal" };
        participant.record(operation.id, "readiness", encode(readiness)); crash("readiness-receipt");
      }
      return { code: failure ? 1 : 0, reason: failure ? "launch-failed" : "ready", operationId: operation.id, home, epoch: home.epoch, repairCommand: null, value: readiness };
    },
    async inspect(home) { ensureReachable(); observe(); return { home, owner: (home.machineId === HUB ? sourceAlive : destinationActive) ? { kind: "live", identity } : { kind: "absent" }, readiness: home.machineId === BOX ? readiness : null, launchFailure: failure, retired, activationCancelled }; },
    async retire(home, operation) {
      if (home.machineId === HUB) { sourceAlive = false; crash("source-shutdown"); crash("source-retirement"); }
      else {
        ensureReachable(); destinationActive = false; crash("destination-shutdown");
        retired = true; activationCancelled = true;
        participant.begin({ ...operation, kind: "session-retire" });
        participant.record(operation.id, "retired", { activationCancelled: true }); crash("destination-retirement");
      }
      return { kind: "absent" };
    },
    async unfreeze(home, operation) {
      events.push("unfreeze");
      const current = sessionHome(global.db, "session-a"), cancelled = global.db.prepare("SELECT cancelled FROM roam_home_actions WHERE move_id='move-a'").get() as { cancelled: number } | undefined;
      if (!current || current === "unknown" || current.epoch !== 1 || current.machineId !== HUB || !cancelled?.cancelled || operation.args.moveId !== "move-a") throw new Error("abort authorization pending");
      for (const store of stores) store.db.prepare("UPDATE roam_sessions SET state='active',move_id=NULL WHERE session_id='session-a' AND epoch=1").run();
      sourceActive = true; crash("source-unfreeze");
      if (fence) await ports.intercom.ports.abort(fence);
    },
    async readmitSource(source, restoredHome, operation) {
      if (readmitResult) return readmitResult;
      const current = sessionHome(global.db, "session-a"), receipt = global.db.prepare("SELECT committed_home_json FROM roam_home_actions WHERE move_id=?").get(restoredHome.moveId) as { committed_home_json: string } | undefined;
      if (source.machineId !== HUB || source.sessionId !== "session-a" || restoredHome.sessionId !== source.sessionId || operation.machineId !== source.machineId || operation.expectedEpoch !== restoredHome.epoch || restoredHome.machineId !== HUB || restoredHome.epoch !== source.epoch + 2 || JSON.stringify(current) !== JSON.stringify(restoredHome) || !receipt || JSON.stringify(JSON.parse(receipt.committed_home_json)) !== JSON.stringify(restoredHome) || readiness !== null || destinationActive || !retired || !activationCancelled ||
          !fence || fence.generation !== release.generation || fence.moveId !== release.moveId || fence.moveId !== operation.args.moveId ||
          fence.expectedEpoch !== source.epoch || release.rollbackReceiptId !== null && release.rollbackReceiptId !== restoredHome.moveId) {
        return { code: 1, ok: false, reason: "move-rollback-proof-missing", operationId: operation.id, home: current === "unknown" ? null : current, epoch: current && current !== "unknown" ? current.epoch : null, repairCommand: null, value: null,
          refusal: { code: "move-rollback-proof-missing", blockers: [], message: "Rollback readmission proof is missing." } };
      }
      let advanced = false;
      for (const store of stores) store.db.raw.transaction(() => {
        const state = store.db.prepare("SELECT epoch,state FROM roam_sessions WHERE session_id='session-a'").get() as { epoch: number; state: string };
        if (state.epoch === 3 && state.state === "active") return;
        if (state.epoch !== 1 || state.state !== "frozen") throw new Error("membership changed");
        store.db.prepare("UPDATE roam_sessions SET epoch=3,state='active',move_id=NULL WHERE session_id='session-a'").run(); advanced = true;
      }).immediate();
      if (advanced) events.push("membership-advanced");
      if (!sourceAlive) sourceLaunches.push(file);
      if (!sourceActive) events.push("source-readmitted");
      sourceActive = true; sourceAlive = true; observe(); crash("source-readmit");
      crash("before-intake-rollback-release");
      if (!intakeOpen) { intakeOpen = true; events.push("rollback-intercom-open"); }
      crash("intake-rollback-release");
      readmitResult = { code: 0, ok: true, reason: "rolled-back", operationId: operation.id, home: restoredHome, epoch: 3, repairCommand: null,
        value: { sourceCleanup: { status: "done" }, home: restoredHome, terminal: sourceAlive ? "original-terminal" : null, intercomAddress: "mac/session-a", warnings: [] } };
      return readmitResult;
    },
    async cleanup() { crash("cleanup"); },
    intercom: { address: { sessionId: "session-a", scopeId: null },
      async destinationEndpoint(home) { ensureReachable(); return { address: ports.intercom.address, machineId: home.machineId, homeEpoch: home.epoch, activationEpoch: "fake-activation" }; },
      ports: { async close() { throw new Error("freeze owns closure"); }, async drain() {}, async inspect() { return { blockers: [], cancelledWork: [], warnings: [] }; },
        async checkGeneration() {}, async abort() { events.push("intercom-abort"); intakeOpen = true; crash("intake-release"); },
        async ready() { return { intercomAddress: "box-1.invalid/session-a", warnings: [] }; } } },
    recovery: { blockers: () => [], presentReadyTarget: async () => { throw new Error("not a forward effect"); }, revocationDb: global.db, homes: () => [], mirror: async () => null, restore: async () => { throw new Error("not used"); }, conflicts: async () => [] },
  };
  cleanups.push(async () => { await releaseMovePower(movePowerKey(ports, "move-a")); global.close(); stores.forEach(store => store.close()); rmSync(root, { recursive: true, force: true }); });
  return { ports, request, sourceHome, file, target, original, journal, stores, ownersAtEveryObservation, events,
    get hit() { return hit; }, get held() { return held; }, get sourceActive() { return sourceActive; }, get destinationActive() { return destinationActive; }, get retired() { return retired; }, get intakeOpen() { return intakeOpen; }, release, sourceLaunches,
    closeSource() { sourceActive = false; }, openSource() { sourceActive = true; },
    disconnect() { reachable = false; }, reconnect() { reachable = true; }, failLaunch() { failure = "proved-before-launch"; destinationActive = false; },
    crashDestination() { destinationActive = false; }, crashSource() { sourceAlive = false; },
    current() { const home = sessionHome(global.db, "session-a"); if (!home || home === "unknown") throw new Error("home unavailable"); return home; } };
}

it.each([
  { error: Object.assign(new Error("fixture-private /home/fixture/not-public"), { code: "ENOENT" }), code: "ENOENT", codeSource: "code" },
  { error: Object.assign(new Error("fixture-private /home/fixture/not-public"), { code: 2 }), code: "2", codeSource: "code" },
  { error: new Error("workspace-prerequisite-missing: fixture-private /home/fixture/not-public"), code: "workspace-prerequisite-missing", codeSource: "message-prefix" },
  { error: Object.assign(new Error("fixture-private /home/fixture/not-public"), { code: "unsafe code\n/home/fixture/not-public" }), code: "untyped-error", codeSource: "untyped" },
  { error: new moves.MoveError("move-prepared-invalid"), code: "move-prepared-invalid", codeSource: "refusal" },
])("keeps private transfer diagnostics local for $codeSource $code", async ({ error, code, codeSource }) => {
  const f = fixture();
  f.ports.transfer = async () => { throw error; };
  const outcome = await moves.moveSession(f.request, f.ports);
  expect(outcome).toMatchObject({ code: 3, reason: codeSource === "refusal" ? "move-prepared-invalid" : "move-pending", value: null });
  expect(f.current()).toEqual(f.sourceHome);
  const diagnostic = f.journal.read(f.request.operation.id).filter(row => row.action === "move-transfer-diagnostic").map(row => row.result);
  expect(diagnostic).toEqual([{ phase: "result", code, codeSource,
    fingerprint: createHash("sha256").update(error.message).digest("hex") }]);
  const publicOutput = JSON.stringify(safeControlOutcome(outcome)) + controlText(safeControlOutcome(outcome));
  for (const text of ["fixture-private", "/home/fixture/not-public", "ENOENT", "fingerprint", "message-prefix"]) {
    expect(publicOutput).not.toContain(text);
  }
  expect(JSON.stringify(diagnostic)).not.toContain("/home/fixture/not-public");
  expect(JSON.stringify(diagnostic)).not.toContain("fixture-private");
});

const actionFaults = ["check", "power", "seed", "seed-barriers", "initial-home", "source-home-replicate", "prestage", "freeze", "intercom-inspect", "transfer", "final-barriers", "generation-check", "home-commit", "home-replicate", "start", "destination-inspect", "destination-endpoint", "intercom-ready", "source-retire", "final-inspect", "cleanup", "power-release"];
const forwardFaults = [...actionFaults.map(action => `reply:${action}`), ...actionFaults.map(action => `effect:${action}`), ...actionFaults.map(action => `before:${action}`), ...["checked", "frozen", "transferred", "home-committed", "destination-ready", "source-stopped", "done"].map(state => `state:${state}`),
  "intake-closed", "store-freeze:0", "store-freeze:1", "workspace-prepared", "file-install", "readiness-receipt", "source-shutdown", "source-retirement", "cleanup", "done-receipt", "reservation-release",
  ...["global", "repo:fixture-repo", "worktree:fixture-repo:fixture-workspace", "worktree:fixture-repo:binding"].flatMap(key => [`freeze-barrier:${key}`, `barrier:source:${key}`, `barrier:destination:${key}`])];
it.each(forwardFaults)("restart after action and before reply at %s", async point => {
  const f = fixture(point); await moves.moveSession(f.request, f.ports);
  expect(f.hit).toBe(true);
  await releaseMovePower(movePowerKey(f.ports, "move-a"));
  const recovered = await moves.recoverMove("move-a", f.ports);
  const expectedCode = point === "before:check" || point === "effect:check" ? 1 : point === "before:start" ? 3 : 0;
  expect(recovered.code, JSON.stringify(recovered)).toBe(expectedCode);
  expect(f.current()).toMatchObject(point === "before:check" || point === "effect:check" ? { machineId: HUB, epoch: 1 } : { machineId: BOX, epoch: 2 });
  if (point === "before:start") expect(f.sourceActive).toBe(false);
  const ownersAtEveryObservation = f.ownersAtEveryObservation;
  expect(ownersAtEveryObservation.every(n => n <= 1)).toBe(true);
  expect(readFileSync(f.file, "utf8")).toBe(f.original);
}, 5000);

it.each([false, true])("move recovery reconciles a reserved destination only after hosting reads succeed; persistent=%s", async persistent => {
  const f = fixture(), start = f.ports.start, intents = createIntentStore(dirname(f.target));
  let unreadable = true, supervisor: ReturnType<typeof createSupervisor> | undefined;
  const launches: string[] = [], evidence = vi.spyOn(console, "error").mockImplementation(() => {});
  const inspect = f.ports.inspect;
  f.ports.inspect = async (...args) => ({ ...await inspect(...args),
    hostingWarning: readLocal<HostingWarning>(f.ports.globalDb, "supervisor-hosting-error", args[0].sessionId) });
  f.ports.start = async (home, prepared, operation) => {
    const intent = { sessionId: home.sessionId, epoch: home.epoch, desired: "running" as const, suspended: null,
      file: prepared.session.file, cwd: prepared.session.cwd, moveId: home.moveId };
    await intents.update(home.sessionId, null, { intent, failures: [],
      supervision: { kind: "launching", operationId: operation.id, phase: "reserved" } });
    supervisor = createSupervisor({ intents, journal: f.journal,
      async hostingWarning(id, warning) { writeLocal(f.ports.globalDb, "supervisor-hosting-error", id, warning ?? undefined); }, clock: { now: () => 1, later: () => () => {} },
      runningIntents: { list: async () => [home.sessionId], async get() {
        if (unreadable) throw new Error("Unsafe hosting state file"); return intent;
      }, subscribe: () => () => {} }, events: { subscribe: () => () => {} },
      async inspect() {
        const observed = await f.ports.inspect(home, operation);
        return { home, intent, localMachine: BOX, origin: HUB, owner: observed.owner, diagnostics: [], unfinishedFreeze: false,
          states: [{ sessionId: home.sessionId, epoch: home.epoch, state: "active", moveId: home.moveId, freezeSeq: null }] };
      },
      launch: createDurableLaunchPort({ intents, authorize: async () => !unreadable, async invoke(request) {
        launches.push(request.reservation.operationId);
        return start(home, prepared, { ...operation, id: request.reservation.operationId });
      } }), stop: async () => { throw new Error("Recovery must not stop the destination"); }, notify: async () => {},
    });
    await supervisor.reconcile();
    return { code: 3, reason: "readiness-pending", operationId: operation.id, home, epoch: home.epoch, repairCommand: null, value: null };
  };
  try {
    expect(await moves.moveSession(f.request, f.ports)).toMatchObject({ code: 3, reason: "move-destination-pending" });
    expect(await moves.recoverMove("move-a", f.ports)).toMatchObject({ code: 3, reason: "move-destination-pending" });
    expect(launches).toEqual([]);
    expect(f.sourceActive).toBe(false);
    unreadable = persistent;
    await supervisor!.reconcile();
    await supervisor!.reconcile();
    const recovered = await moves.recoverMove("move-a", f.ports);
    expect(recovered).toMatchObject(persistent ? { code: 3, reason: "move-destination-pending" } : { code: 0, reason: "moved" });
    if (persistent) {
      expect(recovered).toMatchObject({ refusal: { message: expect.stringMatching(/supervisor-hosting-error.*running-intent/) } });
      expect(readLocal(f.ports.globalDb, "supervisor-hosting-error", "session-a")).toMatchObject({ count: 3 });
      expect(controlText(safeControlOutcome(recovered))).toMatch(/supervisor-hosting-error.*running-intent/);
    }
    expect(launches).toEqual(persistent ? [] : ["move-a"]);
    expect(f.destinationActive).toBe(!persistent);
    expect(f.current()).toMatchObject({ machineId: BOX, epoch: 2 });
    expect(f.sourceActive).toBe(false);
    expect(f.ownersAtEveryObservation.every(n => n <= 1)).toBe(true);
  } finally { await supervisor?.stop(); evidence.mockRestore(); }
}, 5000);

it("lost readiness reply never allows rollback", async () => {
  const f = fixture("readiness-receipt"); await moves.moveSession(f.request, f.ports); f.failLaunch();
  const result = await moves.cancelMove("move-a", f.ports);
  expect(result.code).toBe(3); expect(f.current()).toMatchObject({ machineId: BOX, epoch: 2 }); expect(f.sourceActive).toBe(false); expect(f.retired).toBe(false);
}, 5000);
it("disconnection is not launch failure", async () => {
  const f = fixture("reply:home-commit"); await moves.moveSession(f.request, f.ports); f.disconnect();
  const result = await moves.cancelMove("move-a", f.ports);
  expect(result.code).toBe(3); expect(f.current().epoch).toBe(2); expect(f.sourceActive).toBe(false);
}, 5000);
it.each(["intake-closed", "store-freeze:0", "store-freeze:1", "file-install", "reply:check"])("precommit abort needs no destination at %s", async point => {
  const f = fixture(point); await moves.moveSession(f.request, f.ports); f.disconnect();
  const result = await moves.cancelMove("move-a", f.ports);
  expect(result.code).toBe(0); expect(f.current()).toEqual(f.sourceHome); expect(f.sourceActive).toBe(true);
  expect(() => casHome(f.ports.globalDb, f.sourceHome, BOX, "move-a", HUB)).toThrow(/cancelled/);
  expect(f.ownersAtEveryObservation.every(n => n <= 1)).toBe(true);
}, 5000);
it("post-readiness crash belongs to supervisor", async () => {
  const f = fixture("state:destination-ready"); await moves.moveSession(f.request, f.ports); f.crashDestination();
  const result = await moves.recoverMove("move-a", f.ports);
  expect(result.code).toBe(3); expect(f.current()).toMatchObject({ machineId: BOX, epoch: 2 }); expect(f.sourceActive).toBe(false);
}, 5000);
it("source metadata append invalidates commit", async () => {
  const f = fixture("reply:transfer"); await moves.moveSession(f.request, f.ports); appendFileSync(f.file, '{"type":"session_info","name":"edit"}\n');
  const result = await moves.recoverMove("move-a", f.ports);
  expect(result.code).toBe(3); expect(f.current()).toEqual(f.sourceHome); expect(f.sourceActive).toBe(false);
}, 5000);
it.each([true, false])("rollback reuses untouched original file with live source %s", async live => {
  const f = fixture("before:start"); await moves.moveSession(f.request, f.ports); f.failLaunch(); if (!live) f.crashSource();
  const result = await moves.cancelMove("move-a", f.ports), homeAfterRollback = f.current(), sourceHome = f.sourceHome;
  expect(result.code, JSON.stringify(result)).toBe(0);
  expect(homeAfterRollback.epoch).toBe(sourceHome.epoch + 2);
  expect(homeAfterRollback.machineId).toBe(HUB); expect(f.sourceActive).toBe(true); expect(f.destinationActive).toBe(false);
  expect(readFileSync(f.file, "utf8")).toBe(f.original); expect(readFileSync(f.file, "utf8")).not.toContain("spider-roam-segment");
  expect(f.sourceLaunches).toEqual(live ? [] : [f.file]);
  expect(f.ownersAtEveryObservation.every(n => n <= 1)).toBe(true);
  const repeated = await moves.cancelMove("move-a", f.ports); expect(repeated).toEqual(result);
}, 5000);
it("process start without readiness stays unknown", async () => {
  const f = fixture("process-start"); await moves.moveSession(f.request, f.ports);
  const result = await moves.recoverMove("move-a", f.ports);
  expect(result.code).toBe(3); expect(f.current().epoch).toBe(2); expect(f.sourceActive).toBe(false); expect(f.destinationActive).toBe(true);
}, 5000);

it.each(["move-abort-start", "move-abort-cancelled", "source-unfreeze", "intake-release", "done-receipt", "reservation-release"])("cancel restart after action and before reply at %s", async point => {
  const f = fixture(point), freeze = f.ports.freeze;
  f.ports.freeze = async (...args) => { await freeze(...args); throw new Error("initial freeze reply lost"); };
  await moves.moveSession(f.request, f.ports);
  f.disconnect();
  await moves.cancelMove("move-a", f.ports);
  expect(f.hit).toBe(true);
  const result = await moves.recoverMove("move-a", f.ports);
  expect(result.code).toBe(0); expect(f.current()).toEqual(f.sourceHome); expect(f.sourceActive).toBe(true);
  expect(f.events).toContain("intercom-abort");
  expect(f.ownersAtEveryObservation.every(n => n <= 1)).toBe(true);
}, 5000);
it.each(["move-rollback-start", "destination-shutdown", "destination-retirement", "move-rollback-retired", "move-rollback-home", "source-readmit", "before-intake-rollback-release", "intake-rollback-release", "done-receipt", "reservation-release"])("rollback restart after action and before reply at %s", async point => {
  const f = fixture(point), start = f.ports.start;
  f.ports.start = async (...args) => { f.failLaunch(); return start(...args); };
  await moves.moveSession(f.request, f.ports);
  await moves.cancelMove("move-a", f.ports);
  expect(f.hit).toBe(true);
  const result = await moves.recoverMove("move-a", f.ports), homeAfterRollback = f.current(), sourceHome = f.sourceHome;
  expect(result.code, JSON.stringify(result)).toBe(0); expect(homeAfterRollback.epoch).toBe(sourceHome.epoch + 2);
  expect(f.sourceActive).toBe(true); expect(readFileSync(f.file, "utf8")).toBe(f.original);
  expect(f.ownersAtEveryObservation.every(n => n <= 1)).toBe(true);
}, 5000);
it.each(["launch-proof", "owner-uncertain", "owner-live", "retirement", "activation-cancellation", "readiness"])("rollback refuses missing %s", async missing => {
  const f = fixture("before:start"); await moves.moveSession(f.request, f.ports); f.failLaunch();
  const inspect = f.ports.inspect;
  f.ports.inspect = async (...args) => {
    const observation = await inspect(...args);
    if (missing === "launch-proof") observation.launchFailure = null;
    if (missing === "owner-uncertain") observation.owner = { kind: "uncertain" };
    if (missing === "owner-live") observation.owner = { kind: "live", identity };
    if (missing === "retirement") observation.retired = false;
    if (missing === "activation-cancellation") observation.activationCancelled = false;
    if (missing === "readiness") observation.readiness = { origin: "hub-operation", opId: "move-a", sessionId: "session-a", epoch: 2, cwd: dirname(f.file), file: f.target, core: "fake-core", terminal: "fake-terminal" };
    return observation;
  };
  const result = await moves.cancelMove("move-a", f.ports);
  expect(result.code).toBe(3); expect(f.current()).toMatchObject({ machineId: BOX, epoch: 2 }); expect(f.sourceActive).toBe(false);
}, 5000);
it("rollback CAS refuses a home changed during destination retirement", async () => {
  const f = fixture("before:start"); await moves.moveSession(f.request, f.ports); f.failLaunch();
  const retire = f.ports.retire;
  f.ports.retire = async (...args) => {
    const stopped = await retire(...args);
    casHome(f.ports.globalDb, f.current(), BOX, "new-home-action", HUB);
    return stopped;
  };
  const result = await moves.cancelMove("move-a", f.ports);
  expect(result.code).toBe(3); expect(f.current()).toMatchObject({ machineId: BOX, epoch: 3 }); expect(f.sourceActive).toBe(false);
}, 5000);
it("precommit cancellation is durable before any source producer resumes", async () => {
  const f = fixture("store-freeze:0"); await moves.moveSession(f.request, f.ports);
  const unfreeze = f.ports.unfreeze;
  let delayedCommitRefused = false, authorization: Awaited<ReturnType<typeof moves.authorizeMoveAbort>> = null;
  f.ports.unfreeze = async (home, operation) => {
    authorization = await moves.authorizeMoveAbort(operation, f.ports);
    try { casHome(f.ports.globalDb, f.sourceHome, BOX, "move-a", HUB); } catch { delayedCommitRefused = true; }
    if (!delayedCommitRefused) throw new Error("unsafe delayed commit");
    await unfreeze(home, operation);
  };
  const result = await moves.cancelMove("move-a", f.ports);
  expect(result.code).toBe(0); expect(delayedCommitRefused).toBe(true);
  expect(authorization).toEqual({ home: f.sourceHome, cancelledMoveId: "move-a" }); expect(f.sourceActive).toBe(true);
}, 5000);
it("precommit cancellation refuses a stale source epoch without unfreezing", async () => {
  const f = fixture("store-freeze:0"); await moves.moveSession(f.request, f.ports);
  casHome(f.ports.globalDb, f.sourceHome, HUB, "changed-source", HUB);
  const result = await moves.cancelMove("move-a", f.ports);
  expect(result.code).toBe(3); expect(f.sourceActive).toBe(false); expect(f.events).not.toContain("unfreeze");
  expect(f.ports.globalDb.prepare("SELECT cancelled FROM roam_home_actions WHERE move_id='move-a'").get()).toBeUndefined();
}, 5000);
it("pending placement never rolls back a successful move", async () => {
  const f = fixture("cleanup"); await moves.moveSession(f.request, f.ports);
  const result = await moves.cancelMove("move-a", f.ports);
  expect(result.code).toBe(0); expect(f.current()).toMatchObject({ machineId: BOX, epoch: 2 }); expect(f.sourceActive).toBe(false);
}, 5000);
it("startup reconciles incomplete moves before accepting another move for the session", async () => {
  const f = fixture("file-install"); await moves.moveSession(f.request, f.ports);
  const other = { ...f.request, operation: { ...f.request.operation, id: "move-b" } };
  expect((await moves.moveSession(other, f.ports)).code).toBe(1);
  const recovered = await moves.recoverIncompleteMoves(["move-a", "move-a"], f.ports);
  expect(recovered).toHaveLength(1); expect(recovered[0].code).toBe(0);
  const check = f.ports.check;
  f.ports.check = async request => ({ ...await check(request), source: f.current() });
  other.operation = { ...other.operation, id: "move-c", expectedEpoch: 2 };
  expect((await moves.moveSession(other, f.ports)).code).toBe(0);
}, 5000);
it("restart reacquires power before observing uncertain ownership", async () => {
  const f = fixture("before:start"); await moves.moveSession(f.request, f.ports);
  await releaseMovePower(movePowerKey(f.ports, "move-a"));
  let heldAtInspection = false;
  const inspect = f.ports.inspect;
  f.ports.inspect = async (...args) => { heldAtInspection = f.held; return inspect(...args); };
  const result = await moves.recoverMove("move-a", f.ports);
  expect(result.code).toBe(3); expect(heldAtInspection).toBe(true); expect(f.held).toBe(true);
}, 5000);

it.each(["wrong-machine", "wrong-epoch", "wrong-current-home", "missing-receipt", "destination-not-retired"])("readmitSource contract refuses %s without membership or file effects", async missing => {
  const f = fixture("before:start"); await moves.moveSession(f.request, f.ports); f.failLaunch();
  const before = f.stores.map(store => store.db.prepare("SELECT * FROM roam_sessions").all());
  const rollbackId = "rollback-contract", committed = f.current();
  let restored = missing === "missing-receipt" || missing === "destination-not-retired"
    ? { ...committed, machineId: HUB, epoch: 3, moveId: rollbackId }
    : casHome(f.ports.globalDb, committed, HUB, rollbackId, HUB);
  if (missing === "wrong-machine") restored = { ...restored, machineId: BOX };
  if (missing === "wrong-epoch") restored = { ...restored, epoch: 4 };
  if (missing === "wrong-current-home") casHome(f.ports.globalDb, restored, BOX, "newer-contract-home", HUB);
  const operation: Operation = { id: "readmit-contract", machineId: HUB, kind: "session-readmit", expectedEpoch: 3, args: { sessionId: "session-a", moveId: "move-a" } };
  const result = await f.ports.readmitSource(f.sourceHome, restored, operation);
  expect(result).toMatchObject({ code: 1, ok: false, refusal: { code: "move-rollback-proof-missing" } });
  expect(f.stores.map(store => store.db.prepare("SELECT * FROM roam_sessions").all())).toEqual(before);
  expect(f.sourceActive).toBe(false); expect(readFileSync(f.file, "utf8")).toBe(f.original);
}, 5000);
it("rollback retains both receipts and permanently refuses a delayed old activation", async () => {
  const f = fixture("before:start"); await moves.moveSession(f.request, f.ports); f.failLaunch();
  const committed = f.current();
  expect((await moves.cancelMove("move-a", f.ports)).code).toBe(0);
  expect(casHome(f.ports.globalDb, f.sourceHome, BOX, "move-a", HUB)).toEqual(committed);
  expect(f.ports.globalDb.prepare("SELECT committed_home_json FROM roam_home_actions WHERE cancelled=0").all()).toHaveLength(2);
  const prepared = f.journal.read("move-a").find(row => row.action === "move-action-complete" && row.result.action === "transfer")!.result.value as unknown as PreparedMove;
  await expect(f.ports.start(committed, prepared, { ...f.request.operation, machineId: BOX, expectedEpoch: 2 })).rejects.toThrow("activation permanently cancelled");
  expect(f.destinationActive).toBe(false); expect(f.current()).toMatchObject({ machineId: HUB, epoch: 3 });
}, 5000);
it("readmitSource rejects a pending adapter proof without reopening source", async () => {
  const f = fixture("before:start"); await moves.moveSession(f.request, f.ports); f.failLaunch();
  const readmit = f.ports.readmitSource;
  f.ports.readmitSource = async (source, restored, operation) => readmit(source, { ...restored, epoch: 4 }, operation);
  const result = await moves.cancelMove("move-a", f.ports);
  expect(result).toMatchObject({ code: 3, refusal: { code: "move-rollback-proof-missing" } });
  expect(f.sourceActive).toBe(false); expect(f.current()).toMatchObject({ machineId: HUB, epoch: 3 });
}, 5000);
it("home lookup changed after rollback replication prevents readmission", async () => {
  const f = fixture("before:start"); await moves.moveSession(f.request, f.ports); f.failLaunch();
  f.ports.replicateHome = async home => { if (home.epoch === 3) casHome(f.ports.globalDb, home, BOX, "late-home", HUB); };
  const result = await moves.cancelMove("move-a", f.ports);
  expect(result.code).toBe(3); expect(f.sourceActive).toBe(false); expect(f.intakeOpen).toBe(false); expect(f.current()).toMatchObject({ machineId: BOX, epoch: 4 });
}, 5000);
it("abort proof unavailable keeps source frozen until the authorized retry", async () => {
  const f = fixture("store-freeze:0"); await moves.moveSession(f.request, f.ports);
  const unfreeze = f.ports.unfreeze;
  f.ports.unfreeze = async () => { throw new Error("waiting for the hub to confirm the cancelled move"); };
  expect((await moves.cancelMove("move-a", f.ports)).code).toBe(3); expect(f.sourceActive).toBe(false);
  f.ports.unfreeze = unfreeze;
  expect((await moves.recoverMove("move-a", f.ports)).code).toBe(0); expect(f.sourceActive).toBe(true);
}, 5000);

it("cancel routes real partial freeze through hub authorization and intercom fence release", async () => {
  const f = fixture();
  const { freezeParticipant, unfreezeParticipant } = await import("../../../host/src/roam/freeze");
  const { openFreezeJournal } = await import("../journal");
  const journal = openFreezeJournal(join(dirname(f.file), "source-freeze.db"));
  const gate = {
    inspect: () => ({ kind: f.sourceActive ? "ordinary" as const : "control-only" as const, home: f.sourceHome, blockers: [] }),
    refreshInitialHome: async () => gate.inspect(), whenSettled: async () => gate.inspect(),
    async close() { f.closeSource(); }, async freeze() { f.closeSource(); }, async unfreeze() { f.openSource(); },
  };
  let intakeClosed = false, resumed = 0;
  f.ports.intercom.ports.close = async (address, moveId, expectedEpoch, generation = "fake-generation") => { intakeClosed = true; return { address, moveId, expectedEpoch, generation }; };
  f.ports.intercom.ports.abort = async () => { intakeClosed = false; };
  const freezePorts = {
    gate, journal, stores: f.stores.map(store => store.db), expectedStores: f.stores.map(store => store === f.stores[0] ? store.storeKey : "worktree:fixture-repo:binding" as const),
    intercom: { address: f.ports.intercom.address, ports: f.ports.intercom.ports },
    async drain() {}, async resume() { resumed++; },
    async inspect() { return { file: f.file, cwd: dirname(f.file), leaf: "leaf-a", owner: identity, blockers: [] }; }, async ingestThrough() {},
    authorizeAbort: (operation: Operation) => moves.authorizeMoveAbort(operation, f.ports), onHubRestored: () => () => {},
  };
  f.ports.freeze = async (home, operation) => {
    const ack = await freezeParticipant({ ...operation, id: "source-freeze", kind: "session-freeze" }, freezePorts);
    // Lose the reply after the real local freeze and roster are durable.
    expect(ack.epoch).toBe(home.epoch); throw new Error("lost freeze reply");
  };
  f.ports.unfreeze = async (_home, operation) => unfreezeParticipant(operation, freezePorts);
  await moves.moveSession(f.request, f.ports);
  expect(intakeClosed).toBe(true); expect(f.sourceActive).toBe(false);
  f.disconnect();
  const result = await moves.cancelMove("move-a", f.ports);
  expect(result.code, JSON.stringify(result)).toBe(0); expect(f.sourceActive).toBe(true); expect(intakeClosed).toBe(false);
  expect(f.stores.map(store => (store.db.prepare("SELECT state FROM roam_sessions").get() as { state: string }).state)).toEqual(["active", "active"]);
  expect(journal.readFreeze("session-a", "move-a")?.state).toBe("aborted"); expect(resumed).toBe(1);
}, 5000);

it("hub readiness receipt forbids retirement even if the destination loses its reply", async () => {
  const f = fixture("state:destination-ready"); await moves.moveSession(f.request, f.ports); f.failLaunch();
  const inspect = f.ports.inspect;
  f.ports.inspect = async (...args) => ({ ...await inspect(...args), readiness: null });
  const result = await moves.cancelMove("move-a", f.ports);
  expect(result.code).toBe(3); expect(f.retired).toBe(false); expect(f.current()).toMatchObject({ machineId: BOX, epoch: 2 }); expect(f.sourceActive).toBe(false);
}, 5000);
it("retired source metadata is not reverified after a lost committed-home reply", async () => {
  const f = fixture("effect:home-commit"); await moves.moveSession(f.request, f.ports); appendFileSync(f.file, '{"type":"session_info","name":"discarded"}\n');
  const result = await moves.recoverMove("move-a", f.ports);
  expect(result.code).toBe(0); expect(f.current()).toMatchObject({ machineId: BOX, epoch: 2 }); expect(readFileSync(f.target, "utf8")).not.toContain("discarded");
}, 5000);

it("missing readmission adapter refuses rollback before any retirement or home change", async () => {
  const f = fixture("before:start"); await moves.moveSession(f.request, f.ports); f.failLaunch();
  f.ports.readmitSource = undefined as unknown as MovePorts["readmitSource"];
  const result = await moves.cancelMove("move-a", f.ports);
  expect(result).toMatchObject({ code: 3, refusal: { code: "move-rollback-proof-missing" } });
  expect(f.current()).toMatchObject({ machineId: BOX, epoch: 2 }); expect(f.retired).toBe(false); expect(f.sourceActive).toBe(false);
}, 5000);

it.each(["generation", "move", "receipt"])("readmitSource refuses rollback intercom %s mismatch without reopening", async mismatch => {
  const f = fixture("before:start"); await moves.moveSession(f.request, f.ports); f.failLaunch();
  if (mismatch === "generation") f.release.generation = "unrelated-generation";
  if (mismatch === "move") f.release.moveId = "unrelated-move";
  if (mismatch === "receipt") f.release.rollbackReceiptId = "unrelated-rollback";
  const before = f.stores.map(store => store.db.prepare("SELECT epoch,state FROM roam_sessions").all());
  const result = await moves.cancelMove("move-a", f.ports);
  expect(result).toMatchObject({ code: 3, refusal: { code: "move-rollback-proof-missing" } });
  expect(f.intakeOpen).toBe(false); expect(f.sourceActive).toBe(false);
  expect(f.stores.map(store => store.db.prepare("SELECT epoch,state FROM roam_sessions").all())).toEqual(before);
}, 5000);
it("readmitSource opens only the original fence after membership and readmission", async () => {
  const f = fixture("before:start"); await moves.moveSession(f.request, f.ports); f.failLaunch();
  expect((await moves.cancelMove("move-a", f.ports)).code).toBe(0);
  expect(f.intakeOpen).toBe(true); expect(f.events.slice(-3)).toEqual(["membership-advanced", "source-readmitted", "rollback-intercom-open"]);
  const events = f.events.filter(event => event !== "power");
  expect((await moves.recoverMove("move-a", f.ports)).code).toBe(0); expect(f.events.filter(event => event !== "power")).toEqual(events);
}, 5000);

it("precommit abort needs no destination", async () => {
  const f = fixture("file-install"); await moves.moveSession(f.request, f.ports); f.disconnect();
  const result = await moves.cancelMove("move-a", f.ports);
  expect(result.code).toBe(0); expect(f.current()).toEqual(f.sourceHome); expect(f.sourceActive).toBe(true);
  expect(() => casHome(f.ports.globalDb, f.sourceHome, BOX, "move-a", HUB)).toThrow(/cancelled/);
}, 5000);
it("rollback reuses untouched original file", async () => {
  const f = fixture("before:start"); await moves.moveSession(f.request, f.ports); f.failLaunch(); f.crashSource();
  const result = await moves.cancelMove("move-a", f.ports), homeAfterRollback = f.current(), sourceHome = f.sourceHome;
  const ownersAtEveryObservation = f.ownersAtEveryObservation;
  expect(result.code).toBe(0); expect(homeAfterRollback.epoch).toBe(sourceHome.epoch + 2);
  expect(ownersAtEveryObservation.every(n => n <= 1)).toBe(true);
  expect(f.sourceLaunches).toEqual([f.file]); expect(readFileSync(f.file, "utf8")).toBe(f.original);
  expect(readFileSync(f.file, "utf8")).not.toContain("spider-roam-segment");
}, 5000);

it("rollback admits the source before independently retrying aborted workspace cleanup", async () => {
  const f = fixture("reply:home-commit"); await moves.moveSession(f.request, f.ports); f.failLaunch();
  let attempts = 0;
  f.ports.abortWorkspace = async (check, operation) => {
    expect(check.source.sessionId).toBe("session-a"); expect(operation.id).toBe("move-a");
    expect(f.current()).toMatchObject({ machineId: HUB, epoch: 3 });
    expect(f.sourceActive).toBe(true); expect(f.retired).toBe(true);
    if (++attempts === 1) throw new Error("destination disconnected after rollback");
  };
  expect(await moves.cancelMove("move-a", f.ports)).toMatchObject({ code: 0, reason: "rolled-back" });
  expect(attempts).toBe(1);
  expect(f.ports.journal.lookupOperation?.(abortCleanupId("move-a"))?.state).toBe("pending");
  expect(await moves.recoverMove("move-a", f.ports)).toMatchObject({ code: 0, reason: "rolled-back" });
  expect(attempts).toBe(2);
  expect(f.ports.journal.lookupOperation?.(abortCleanupId("move-a"))?.state).toBe("done");
}, 5000);
