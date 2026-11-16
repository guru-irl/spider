import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import type { Home } from "@spider/db-core/roam/types";
import { readSessionState } from "@spider/db-core/roam/state";
import { DEFAULT_LIMITS, type Operation } from "@spider/roam/contracts";
import { rollbackMoveId } from "@spider/roam/move-recovery";
import { openFreezeJournal } from "@spider/roam/journal";
import { inspectSession } from "@spider/roam/session-file";
import { startSessionControlSocket, requestSessionControl } from "@spider/roam/session-socket";
import { readmitLiveSession, type LiveReadmitInput } from "../readmit";
import type { RollbackEvidence } from "@spider/roam/move-ports";
const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002";
const fixtures: ReturnType<typeof createReplica>[] = [], servers: Array<{ close(): Promise<void> }> = [], roots: string[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const fixture of fixtures.splice(0)) fixture.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const global = createReplica("global", HUB), worktree = createReplica("worktree", HUB); fixtures.push(global, worktree);
  const id = "session-a", moveId = "move-a", file = join(worktree.root, "session.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, cwd: worktree.root, timestamp: "2026-01-01T00:00:00Z" }) + "\n" + JSON.stringify({ type: "message", id: "leaf-a", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "CONVERSATION-SENTINEL", timestamp: 1 } }) + "\n", { mode: 0o600 });
  const manifest = await inspectSession(file, id, "leaf-a", DEFAULT_LIMITS);
  const source: Home = { sessionId: id, machineId: HUB, epoch: 2, moveId: null, updatedAt: 1 }, committed: Home = { ...source, machineId: BOX, epoch: 3, moveId, updatedAt: 2 }, restored: Home = { ...source, epoch: 4, moveId: rollbackMoveId(moveId), updatedAt: 3 };
  global.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES (?,?,?,?,?)").run(id, HUB, 4, restored.moveId, 3);
  worktree.db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES (?,1,?)").run(id, HUB);
  worktree.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state,move_id) VALUES (?,2,'frozen',?)").run(id, moveId);
  const journal = openFreezeJournal(join(worktree.root, "roam", "journal.db")), address = { sessionId: id, scopeId: null }, fence = { address, moveId, expectedEpoch: 2, generation: "generation-a" };
  journal.beginFreeze(id, moveId, 2); journal.bindIntercomFence(fence); journal.advanceFreeze(id, moveId, 2, "frozen");
  const owner = { bootId: "fixture-boot", pid: process.pid, startTime: "fixture-start" };
  const proof: RollbackEvidence = { currentHome: restored, forwardReceipt: committed, rollbackReceipt: restored,
    retirement: { home: committed, owner: { kind: "absent" }, readiness: null, launchFailure: "proved-launch-failure", retired: true, activationCancelled: true },
    freeze: { ...manifest, operationId: "freeze-a", epoch: 2, owner, barriers: [], intercomGeneration: "generation-a" },
    check: { source, destinationMachine: BOX, repoKey: "fixture", workspaceId: "workspace", sourceRoot: worktree.root, sourceFile: file, sourceCwd: worktree.root, destinationRoot: worktree.root, destinationCwd: worktree.root, storeKeys: [worktree.storeKey], warnings: [] } };
  const operation: Operation = { id: "readmit-a", kind: "session-readmit", machineId: HUB, expectedEpoch: 4, args: { sessionId: id, moveId, sourceMachine: HUB, source: { ...source }, restoredHome: { ...restored }, file } };
  const effects: string[] = [];
  const input: LiveReadmitInput = { globalDb: global.db, stores: [{ key: worktree.storeKey, db: worktree.db }], machineId: HUB, journal, limits: DEFAULT_LIMITS,
    proof: async () => proof, owner: async () => ({ kind: "live", identity: owner }),
    async readmit(home) { effects.push("readmit"); return { origin: "hub-operation", opId: operation.id, sessionId: id, epoch: home.epoch, file, cwd: worktree.root, core: "core-a", terminal: "terminal-a" }; },
    async reopen() { effects.push("reopen"); }, async resume() { effects.push("resume"); } };
  const runtimeRoot = mkdtempSync(join(resolve(".spider/scratch"), "rr-")); roots.push(runtimeRoot);
  servers.push(await startSessionControlSocket(runtimeRoot, id, async ({ op, operation }) => op === "readmit" ? readmitLiveSession(operation, input) : { code: 2, reason: "invalid-session-control", operationId: operation.id, home: null, epoch: operation.expectedEpoch, repairCommand: null, value: null }));
  return { global, worktree, proof, operation, input, effects, runtimeRoot, file };
}
it.each(["restored-machine", "restored-epoch", "hub-home", "rollback-receipt", "forward-receipt", "retirement", "stopped-owner", "activation-cancellation", "readiness", "move-id", "fence-generation", "source-file", "source-owner", "missing-proof", "frozen-bytes"])("live readmit refuses %s without effects and stays frozen", async kind => {
  const f = await fixture();
  if (kind === "restored-machine") (f.operation.args.restoredHome as unknown as Home).machineId = BOX;
  if (kind === "restored-epoch") (f.operation.args.restoredHome as unknown as Home).epoch = 3;
  if (kind === "hub-home") f.proof.currentHome = { ...f.proof.currentHome, updatedAt: 4 };
  if (kind === "rollback-receipt") f.proof.rollbackReceipt = { ...f.proof.rollbackReceipt, moveId: "forward-is-not-rollback" };
  if (kind === "forward-receipt") f.proof.forwardReceipt = { ...f.proof.forwardReceipt, epoch: 2 };
  if (kind === "retirement") f.proof.retirement.retired = false;
  if (kind === "stopped-owner") f.proof.retirement.owner = { kind: "uncertain" };
  if (kind === "activation-cancellation") f.proof.retirement.activationCancelled = false;
  if (kind === "readiness") f.proof.retirement.readiness = { origin: "hub-operation", opId: "ready", sessionId: "session-a", epoch: 3, file: f.file, cwd: f.worktree.root, core: "core", terminal: "terminal" };
  if (kind === "move-id") f.operation.args.moveId = "other-move";
  if (kind === "fence-generation") f.proof.freeze.intercomGeneration = "other-generation";
  if (kind === "source-file") f.proof.check.sourceFile = join(f.worktree.root, "different.jsonl");
  if (kind === "source-owner") f.input.owner = async () => ({ kind: "uncertain" });
  if (kind === "missing-proof") f.input.proof = async () => null;
  if (kind === "frozen-bytes") writeFileSync(f.file, readFileSync(f.file, "utf8").replace("CONVERSATION-SENTINEL", "CONVERSATION-SENTINEZ"));
  const result = await requestSessionControl(f.runtimeRoot, f.operation);
  expect(result.code).toBe(3);
  expect(result.reason).toBe("move-rollback-proof-missing");
  expect(f.effects).toEqual([]);
  expect(readSessionState(f.worktree.db, "session-a")).toMatchObject({ state: "frozen", epoch: 2 });
  expect(f.input.journal.read(f.operation.id)).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("CONVERSATION-SENTINEL");
}, 5000);
it("live readmit advances membership before admission and reopens the exact fence once", async () => {
  const f = await fixture();
  const original = f.input.readmit;
  f.input.readmit = async (...args) => { expect(readSessionState(f.worktree.db, "session-a")).toMatchObject({ state: "active", epoch: 4, moveId: rollbackMoveId("move-a") }); return original(...args); };
  const first = await requestSessionControl(f.runtimeRoot, f.operation), repeat = await requestSessionControl(f.runtimeRoot, f.operation);
  expect(first.code).toBe(0);
  expect(first.value).toMatchObject({ opId: "readmit-a", epoch: 4, file: f.file });
  expect(repeat).toEqual(first);
  expect(f.effects).toEqual(["readmit", "reopen", "resume"]);
  expect(f.input.journal.readFreeze("session-a", "move-a")?.state).toBe("complete");
}, 5000);

it("live socket readmission does not conflict with its move operation journal", async () => {
  const f = await fixture();
  f.input.journal.begin({ ...f.operation, kind: "move-readmit" });
  const result = await requestSessionControl(f.runtimeRoot, f.operation);
  expect(result.code).toBe(0);
  expect(f.effects).toEqual(["readmit", "reopen", "resume"]);
}, 5000);
