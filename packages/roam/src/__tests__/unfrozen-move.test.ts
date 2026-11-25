import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { seedSession, enableMemoryCapture } from "@spider/db-core/roam/seed";
import type { Home } from "@spider/db-core/roam/types";
import { DEFAULT_LIMITS, disabledIntercom, type MovePorts, type MoveCheck, type Operation, type PreparedMove } from "../contracts";
import { assignInitialHome, sessionHome } from "../homes";
import { openFreezeJournal } from "../journal";
import { moveSession, cancelMove, authorizeMoveAbort, readMoveReservation } from "../move";
import { freezeParticipant, unfreezeParticipant, type FreezePorts } from "../../../host/src/roam/freeze";
import type { SessionAddress } from "@spider/intercom/protocol";
import { MoveAdapterError } from "../move-ports";
import { runLocalDoctor } from "../local-diagnostics";
import * as localDiagnostics from "../local-diagnostics";
import { disableRoaming } from "../production-controls";
import { main } from "../cli";
import { movePowerKey, releaseMovePower } from "../power";

const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002";
const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const fn of cleanup.splice(0)) fn(); });

function fixture() {
  const global = createReplica("global", HUB), store = createReplica("worktree", HUB), repo = createReplica("repo", HUB);
  cleanup.push(() => { repo.close(); store.close(); global.close(); });
  const root = global.root, file = join(root, "session.jsonl");
  mkdirSync(join(root, "roam"), { mode: 0o700 });
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "session-a", cwd: root }) + "\n" + JSON.stringify({ type: "message", id: "leaf-a", parentId: null, timestamp: "2026-01-01T00:00:00Z" }) + "\n");
  store.db.prepare("INSERT INTO sessions(id,started_at) VALUES ('session-a',1)").run();
  seedSession(store.db, "session-a", 1, store.storeKey, DEFAULT_LIMITS.targetBatchBytes);
  enableMemoryCapture(global.db, "global"); enableMemoryCapture(repo.db, repo.storeKey);
  const home = assignInitialHome(global.db, "session-a", HUB, HUB) as Home;
  const journalFile = join(root, "roam", "journal.db"), journal = openFreezeJournal(journalFile);
  const participant = openFreezeJournal(join(root, "roam", "participant.db"));
  const config = { enabled: true, role: "hub" as const, machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 1, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  writeFileSync(join(root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  const [repoKey, workspaceId] = store.storeKey.split(":").slice(1);
  const check: MoveCheck = { source: home, destinationMachine: BOX, repoKey, workspaceId, sourceRoot: root, sourceFile: file, sourceCwd: root, destinationRoot: root, destinationCwd: root, storeKeys: ["global", `repo:${repoKey}`, store.storeKey], warnings: [] };
  let admissionOpen = true, intakeOpen = true, resumed = 0;
  const intercom = { address: { scopeId: "global", sessionId: "session-a" }, ports: {
    async close(address: SessionAddress, moveId: string, expectedEpoch: number, generation = "generation-a") { intakeOpen = false; return { address, moveId, expectedEpoch, generation }; },
    async drain() {}, async inspect() { return { blockers: [], warnings: [], cancelledWork: [] }; }, async checkGeneration() {}, async abort() { intakeOpen = true; }, async ready() { throw new Error("not ready"); },
  }, async destinationEndpoint() { throw new Error("not ready"); } } as MovePorts["intercom"];
  const gate: FreezePorts["gate"] = {
    inspect: () => ({ kind: admissionOpen ? "ordinary" : "control-only", home, blockers: [] }),
    refreshInitialHome: async () => gate.inspect(), whenSettled: async () => gate.inspect(),
    async close() { admissionOpen = false; }, async freeze() { admissionOpen = false; }, async unfreeze() { admissionOpen = true; },
  };
  const freezePorts: FreezePorts = { gate, journal: participant, stores: [global.db, repo.db, store.db], expectedStores: ["global", repo.storeKey, store.storeKey], intercom,
    async drain() {}, async resume() { resumed++; }, async ingestThrough() {},
    async inspect() { return { blockers: [], file, cwd: root, leaf: "leaf-a", owner: null }; },
    authorizeAbort: operation => authorizeMoveAbort(operation, ports), onHubRestored: () => () => {},
  };
  const operation: Operation = { id: "move-a", kind: "move", machineId: HUB, expectedEpoch: 1, args: { sessionId: "session-a", destinationMachine: BOX } };
  const prepared = { workspace: { root, moveId: "move-a", snapshot: { moveId: "move-a", stage: "pre", repoKey, workspaceId, root } }, session: { file, sessionId: "session-a", cwd: root, size: 1, leaf: "leaf-a", sha256: "a".repeat(64), historySha256: "a".repeat(64), artifactId: "artifact-a" } } as PreparedMove;
  const ports = { config, globalDb: global.db, journal, intercom, clock: { now: () => 1, later: () => () => {} },
    async check() { return check; }, async power() { return async () => {}; },
    async seed() { return check.storeKeys.map(storeKey => ({ storeKey, stream: "stream-a", through: 1 })); },
    async barriers() { return true; }, async replicateHome() {}, async prepare() { return prepared; }, freeze: (source: Home, op: Operation) => freezeParticipant({ ...op, kind: "session-freeze" }, freezePorts),
    unfreeze: (_source: Home, op: Operation) => unfreezeParticipant(op, freezePorts),
    async transfer() { throw new Error("transfer unavailable"); }, async abortWorkspace() {},
  } as unknown as MovePorts;
  const request = { sessionId: "session-a", destinationMachine: BOX, operation };
  return { root, journalFile, global, store, home, journal, participant, ports, freezePorts, request,
    get admissionOpen() { return admissionOpen; }, get intakeOpen() { return intakeOpen; }, get resumed() { return resumed; } };
}

it("cancel completes when freeze refused before participant progress existed", async () => {
  const f = fixture();
  f.ports.freeze = async () => { throw new MoveAdapterError("session-control-refused"); };
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 3, failure: { step: "freeze" } });
  const result = await cancelMove("move-a", f.ports);
  expect(result).toMatchObject({ code: 0, reason: "cancelled", home: f.home });
  expect(sessionHome(f.global.db, "session-a")).toEqual(f.home);
  expect(f.journal.lookupOperation("move-a")?.state).toBe("done");
  expect(readMoveReservation("session-a", f.journal)).toBeNull();
  expect(await cancelMove("move-a", f.ports)).toEqual(result);
});

it("cancel does not require capture readiness that prevented the freeze", async () => {
  const f = fixture();
  f.store.db.prepare("UPDATE roam_meta SET capture_enabled=0 WHERE id=1").run();
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 3, failure: { step: "freeze" } });
  expect(f.participant.readFreeze("session-a", "move-a")).toBeNull();
  expect(await cancelMove("move-a", f.ports)).toMatchObject({ code: 0, reason: "cancelled", home: f.home });
  expect(f.store.db.prepare("SELECT state FROM roam_sessions WHERE session_id='session-a'").get()).toEqual({ state: "active" });
});

it.each(["no-fence", "fenced"])("cancel clears a partial %s freeze without rerunning its failed step", async mode => {
  const f = fixture();
  if (mode === "no-fence") {
    f.ports.freeze = async (_home, op) => { f.participant.beginFreeze("session-a", "move-a", 1); await f.freezePorts.gate.close(); throw new Error("freeze interrupted"); };
  } else f.freezePorts.inspect = async () => { throw new Error("inspection unavailable"); };
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 3, failure: { step: "freeze" } });
  expect(await cancelMove("move-a", f.ports)).toMatchObject({ code: 0, reason: "cancelled" });
  expect(f.admissionOpen).toBe(true); expect(f.intakeOpen).toBe(true);
  expect(f.participant.readFreeze("session-a", "move-a")?.state).toBe("aborted");
  expect(f.store.db.prepare("SELECT state,move_id FROM roam_sessions WHERE session_id='session-a'").get()).toEqual({ state: "active", move_id: null });
  expect(sessionHome(f.global.db, "session-a")).toEqual(f.home);
  expect(readMoveReservation("session-a", f.journal)).toBeNull();
});

it("a completed freeze still requires abort authorization and preserves its fence on refusal", async () => {
  const f = fixture();
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 3, failure: { step: "transfer" } });
  expect(f.participant.readFreeze("session-a", "move-a")?.state).toBe("frozen");
  f.freezePorts.authorizeAbort = async () => null;
  expect(await cancelMove("move-a", f.ports)).toMatchObject({ code: 3, reason: "move-abort-pending", refusal: { blockers: ["abort-authorization-pending"] } });
  expect(f.admissionOpen).toBe(false); expect(f.intakeOpen).toBe(false);
  expect(f.store.db.prepare("SELECT state FROM roam_sessions WHERE session_id='session-a'").get()).toEqual({ state: "frozen" });
});

it("cancel retains the adapter cause instead of an empty preflight refusal", async () => {
  const f = fixture(); f.ports.freeze = async () => { throw new MoveAdapterError("session-control-refused"); };
  await moveSession(f.request, f.ports);
  f.ports.unfreeze = async () => { throw new MoveAdapterError("ownership-unavailable"); };
  expect(await cancelMove("move-a", f.ports)).toMatchObject({ code: 3, refusal: { blockers: ["ownership-unavailable"] } });
});

it("doctor lists every pending move with its failed step and safe repair", async () => {
  const a = fixture(), b = fixture();
  a.ports.freeze = async () => { throw new MoveAdapterError("session-control-refused"); };
  await moveSession(a.request, a.ports); await moveSession(b.request, b.ports);
  for (const [f, step, command] of [[a, "freeze", "cancel"], [b, "transfer", "recover"]] as const) {
    const report = await runLocalDoctor({ root: f.root, hubService: async () => ({ running: true, socketAvailable: true, lastExitCode: null }) });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ reason: expect.stringMatching(new RegExp(`move-a.*${step}`)), repairCommand: `spider roam ${command} move-a` }));
    await cancelMove("move-a", f.ports);
  }
});

it.each([false, true])("disable names the pending move and cancel repair after frozen=%s", async frozen => {
  vi.spyOn(localDiagnostics, "createLocalDiagnosticPorts").mockReturnValue({ async probeProcess() { return { kind: "live", startIdentity: "process-a" }; } } as never);
  const f = fixture();
  if (!frozen) f.ports.freeze = async () => { throw new MoveAdapterError("session-control-refused"); };
  await moveSession(f.request, f.ports);
  const result = await disableRoaming(f.root);
  expect(result).toMatchObject({ code: 1, reason: "move-in-progress:move-a", operationId: "move-a", repairCommand: "spider roam cancel move-a" });
  expect(result.message).toContain("move-a");
  vi.stubEnv("SPIDER_GLOBAL_ROOT", f.root);
  const out: string[] = [], err: string[] = [];
  expect(await main(["roam", "disable", "--json"], { out: text => out.push(text), err: text => err.push(text) })).toBe(1);
  expect(JSON.parse(out.join(""))).toMatchObject({ reason: "move-in-progress:move-a", operationId: "move-a", repairCommand: "spider roam cancel move-a" });
});

it("unfrozen cancel does not reacquire a forward move power assertion", async () => {
  const f = fixture();
  f.ports.freeze = async () => { throw new MoveAdapterError("session-control-refused"); };
  await moveSession(f.request, f.ports);
  await releaseMovePower(movePowerKey(f.ports, "move-a"));
  f.ports.power = async () => { throw new Error("power unavailable"); };
  expect(await cancelMove("move-a", f.ports)).toMatchObject({ code: 0, reason: "cancelled", home: f.home });
});

it("disabled public doctor still lists pending moves", async () => {
  const f = fixture(); f.ports.freeze = async () => { throw new MoveAdapterError("session-control-refused"); };
  await moveSession(f.request, f.ports);
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify({ ...f.ports.config, enabled: false }), { mode: 0o600 });
  vi.stubEnv("SPIDER_GLOBAL_ROOT", f.root);
  const out: string[] = [], err: string[] = [];
  await main(["roam", "doctor", "--json"], { out: text => out.push(text), err: text => err.push(text) });
  expect(JSON.parse(out.join("")).value.diagnostics).toContainEqual(expect.objectContaining({ reason: expect.stringMatching(/move-a.*freeze/), repairCommand: "spider roam cancel move-a" }));
});

it("doctor lists two pending moves and removes only the completed one", async () => {
  const f = fixture(); f.ports.freeze = async () => { throw new MoveAdapterError("session-control-refused"); };
  await moveSession(f.request, f.ports);
  f.journal.begin({ id: "move-b", kind: "move", machineId: HUB, expectedEpoch: 1, args: { sessionId: "session-b" } });
  f.journal.record("move-b", "move-action-start", { action: "transfer" });
  const report = () => runLocalDoctor({ root: f.root, hubService: async () => ({ running: true, socketAvailable: true, lastExitCode: null }) });
  expect((await report()).diagnostics.filter(row => row.reason.startsWith("move-pending:"))).toEqual([
    expect.objectContaining({ reason: expect.stringMatching(/move-a.*freeze/), repairCommand: "spider roam cancel move-a" }),
    expect.objectContaining({ reason: expect.stringMatching(/move-b.*transfer/), repairCommand: "spider roam recover move-b" }),
  ]);
  await cancelMove("move-a", f.ports);
  expect((await report()).diagnostics.filter(row => row.reason.startsWith("move-pending:"))).toEqual([
    expect.objectContaining({ reason: expect.stringMatching(/move-b.*transfer/), repairCommand: "spider roam recover move-b" }),
  ]);
});
