import { isDeepStrictEqual } from "node:util";
import type { Db } from "@spider/db-core";
import type { Home, HubOperationReadiness, JsonObject, Probe, StoreKey } from "@spider/db-core/roam/types";
import type { Limits, Operation, Outcome } from "@spider/roam/contracts";
import { advanceMembership, validRollbackProof, type RollbackEvidence } from "@spider/roam/move-ports";
import type { FreezeJournal } from "@spider/roam/journal";
import { sessionHome } from "@spider/roam/homes";
import { inspectSession } from "@spider/roam/session-file";
import type { IntercomIntakeFence } from "@spider/intercom/protocol";

export interface LiveReadmitInput {
  globalDb: Db; stores: readonly { key: StoreKey; db: Db }[]; machineId: string; journal: FreezeJournal; limits: Limits;
  proof(operation: Operation): Promise<RollbackEvidence | null>;
  owner(): Promise<Probe>;
  readmit(home: Home, operation: Operation): Promise<HubOperationReadiness>;
  reopen(fence: IntercomIntakeFence, home: Home, receipt: Home): Promise<void>;
  resume(): Promise<void>;
}
export async function readmitLiveSession(operation: Operation, input: LiveReadmitInput): Promise<Outcome<JsonObject>> {
  const refuse = (): Outcome<JsonObject> => ({ code: 3, reason: "move-rollback-proof-missing", operationId: operation.id, home: null, epoch: operation.expectedEpoch, repairCommand: null, value: null });
  try {
    const source = operation.args.source as unknown as Home, restored = operation.args.restoredHome as unknown as Home;
    const sessionId = operation.args.sessionId as string, moveId = operation.args.moveId as string;
    if (!source || !restored || operation.kind !== "session-readmit" || operation.machineId !== input.machineId || source.machineId !== input.machineId ||
        source.sessionId !== sessionId || restored.sessionId !== sessionId || operation.expectedEpoch !== restored.epoch) return refuse();
    const proof = await input.proof(operation), fence = input.journal.readIntercomFence(sessionId, moveId);
    if (!proof || !fence || !validRollbackProof(proof, source, restored, moveId, fence, fence.address) ||
        !isDeepStrictEqual(sessionHome(input.globalDb, sessionId), restored) || operation.args.file !== proof.freeze.file) return refuse();
    const owner = await input.owner();
    if (owner.kind !== "live" || !proof.freeze.owner || !isDeepStrictEqual(owner.identity, proof.freeze.owner)) return refuse();
    const exact = await inspectSession(proof.freeze.file, sessionId, proof.freeze.leaf, input.limits);
    if (exact.size !== proof.freeze.size || exact.sha256 !== proof.freeze.sha256 || exact.cwd !== proof.freeze.cwd) return refuse();
    const receiptOperation = { ...operation, id: `${operation.id}-live-readmit` };
    const prior = input.journal.begin(receiptOperation);
    if (prior.kind === "done") return prior.result as unknown as Outcome<JsonObject>;
    const fresh = await input.proof(operation);
    if (!fresh || !validRollbackProof(fresh, source, restored, moveId, input.journal.readIntercomFence(sessionId, moveId), fence.address)) return refuse();
    advanceMembership({ stores: input.stores }, source, restored, moveId);
    const ready = await input.readmit(restored, operation);
    if (ready.opId !== operation.id || ready.sessionId !== sessionId || ready.epoch !== restored.epoch || ready.file !== exact.file || ready.cwd !== exact.cwd) return refuse();
    await input.reopen(fence, restored, fresh.rollbackReceipt);
    input.journal.advanceFreeze(sessionId, moveId, source.epoch, "complete");
    await input.resume();
    const result: Outcome<JsonObject> = { code: 0, reason: "rollback-readmitted", operationId: operation.id, home: restored, epoch: restored.epoch, repairCommand: null, value: { ...ready } };
    input.journal.record(receiptOperation.id, "done", result as unknown as JsonObject);
    return result;
  } catch { return refuse(); }
}
