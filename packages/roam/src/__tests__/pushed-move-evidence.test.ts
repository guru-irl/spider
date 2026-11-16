import { afterEach, expect, it } from "vitest";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { openDb } from "@spider/db-core";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { DEFAULT_LIMITS, disabledIntercom, type Operation, type RoamConfig } from "../contracts";
import { openFreezeJournal } from "../journal";
import { createPushedMoveEvidencePorts, handleMoveParticipantOperation, type MoveAdapterBindings } from "../move-ports";
import { machineMoveEvidence } from "../machine-move-evidence";
import { rollbackMoveId } from "../move-recovery";
const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
it("pushed rollback proof survives reopen and binds live and broker lookups to the same rollback identity", async () => {
  const f = createReplica("global", BOX); fixtures.push(f);
  const config: RoamConfig = { enabled: true, role: "box", machineId: BOX, hubMachineId: HUB, peers: [], discoveryRoots: [], coreUnit: "fixture", syncMs: 120000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  const journal = openFreezeJournal(join(f.root, "roam", "journal.db"));
  const source = { sessionId: "s-1", machineId: BOX, epoch: 1, moveId: null, updatedAt: 1 }, restored = { ...source, epoch: 3, moveId: rollbackMoveId("move-a"), updatedAt: 2 };
  f.db.prepare("INSERT INTO session_homes VALUES(?,?,?,?,?)").run(restored.sessionId, BOX, restored.epoch, restored.moveId, restored.updatedAt);
  const operation: Operation = { id: "readmit-a", kind: "move-readmit", machineId: BOX, expectedEpoch: 3, args: { sourceMachine: HUB, sessionId: "s-1", moveId: "move-a", source, restoredHome: restored } };
  const proof = { currentHome: restored, rollbackReceipt: restored, check: { source } };
  const feeds = createPushedMoveEvidencePorts(f.db, config);
  const bindings = { participant: { config, globalDb: f.db, identityCurrent: async () => true }, evidence: feeds, intercom: { rollback: { currentFence: async () => null } } } as unknown as MoveAdapterBindings;
  expect(await handleMoveParticipantOperation({ ...operation, args: { ...operation.args, hubEvidence: { kind: "rollback", home: restored, value: proof } } }, journal, bindings)).toMatchObject({ code: 3, reason: "move-rollback-proof-missing" });
  await expect(handleMoveParticipantOperation({ ...operation, args: { ...operation.args, hubEvidence: { kind: "rollback", home: { ...restored, epoch: 2 }, value: proof } } }, journal, bindings)).rejects.toThrow("hub-evidence-mismatch");
  const reopened = openDb(f.db.raw.name, { fileMustExist: true, checkpointOnClose: false });
  try {
    const pushed = createPushedMoveEvidencePorts(reopened, config);
    const live: Operation = { ...operation, kind: "session-readmit", args: { ...operation.args, file: "/fixture/session.jsonl" } };
    expect(await pushed.rollback(live)).toEqual(proof);
    expect(await pushed.rollback(operation)).toEqual(proof);
    for (const changed of [
      { ...live, id: "other-operation" },
      { ...live, machineId: HUB },
      { ...live, expectedEpoch: 2 },
      { ...live, args: { ...live.args, moveId: "other-move" } },
      { ...live, args: { ...live.args, sessionId: "other-session" } },
      { ...live, args: { ...live.args, sourceMachine: BOX } },
    ]) expect(await pushed.rollback(changed)).toBeNull();
    expect(await pushed.rollback({ ...live, kind: "session-unfreeze" })).toBeNull();
    expect(await pushed.rollback({ ...operation, id: "other-operation" })).toBeNull();
    expect(await pushed.rollback({ ...operation, expectedEpoch: 2 })).toBeNull();
    expect(await pushed.rollback({ ...operation, args: { ...operation.args, sourceMachine: BOX } })).toBeNull();
    const requests: string[] = [], machine = machineMoveEvidence({ db: reopened, config, journal, transport: { async resolve() { requests.push("dial"); throw new Error("box cannot dial"); } } as never });
    const internal: Operation = { id: restored.moveId, kind: "session-readmit", machineId: BOX, expectedEpoch: 3, args: { sessionId: "s-1", moveId: "move-a" } };
    expect(await machine.moveRollbackProof(internal)).toEqual(proof);
    expect(await pushed.rollback(internal)).toBeNull();
    expect(await machine.moveRollbackProof(live)).toBeNull();
    const saved = readLocal<{ operation: Operation }>(reopened, "move-hub-evidence", operation.id)!;
    for (const changed of [
      { ...operation, id: "other-operation" },
      { ...operation, machineId: HUB },
      { ...operation, expectedEpoch: 2 },
      { ...operation, args: { ...operation.args, moveId: "other-move" } },
      { ...operation, args: { ...operation.args, sessionId: "other-session" } },
      { ...operation, args: { ...operation.args, sourceMachine: BOX } },
    ]) {
      writeLocal(reopened, "move-hub-evidence", operation.id, { ...saved, operation: changed });
      expect(await pushed.rollback(live)).toBeNull();
      expect(await machine.moveRollbackProof(internal)).toBeNull();
    }
    writeLocal(reopened, "move-hub-evidence", operation.id, saved);
    const indexKey = JSON.stringify([restored.sessionId, restored.moveId]);
    writeLocal(reopened, "move-hub-rollback", indexKey, undefined);
    expect(await pushed.rollback(live)).toBeNull();
    expect(await machine.moveRollbackProof(internal)).toBeNull();
    writeLocal(reopened, "move-hub-rollback", indexKey, operation.id);
    writeLocal(reopened, "move-hub-evidence", operation.id, undefined);
    expect(await pushed.rollback(live)).toBeNull();
    expect(await machine.moveRollbackProof(internal)).toBeNull();
    writeLocal(reopened, "move-hub-evidence", operation.id, saved);
    reopened.prepare("UPDATE session_homes SET updated_at=3 WHERE session_id='s-1'").run();
    expect(await pushed.rollback(live)).toBeNull();
    expect(await machine.moveRollbackProof(internal)).toBeNull();
    reopened.prepare("UPDATE session_homes SET epoch=4 WHERE session_id='s-1'").run();
    expect(await pushed.rollback(operation)).toBeNull(); expect(await machine.moveRollbackProof(internal)).toBeNull();
    expect(requests).toEqual([]);
  } finally { reopened.close(); }
});
