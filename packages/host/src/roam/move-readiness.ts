import type { Db } from "@spider/db-core";
import { writeLocal } from "@spider/db-core/roam/local-state";
import type { Home, HubOperationReadiness } from "@spider/db-core/roam/types";
import type { IdLockObservation } from "@spider/herdr/sessions/id-lock";
import type { FreezeJournal } from "@spider/roam/journal";
import { createRunningIntentAuthority, recordReadiness } from "@spider/roam/session-control";
export interface OwnedMoveReadinessInput {
  db: Db; journal: FreezeJournal; sessionId: string; machineId: string; file: string; cwd: string; epoch: number; home: Home | null;
  /** Supplied only by the distinct full-proof live readmission handler. */
  readmitOperationId?: string;
  owner(): Promise<{ pid: number; startTime: string }>;
  lock(): Promise<IdLockObservation | null>;
  caller(): Promise<{ coreId: string; address: string }>;
}
export async function publishOwnedMoveReadiness(input: OwnedMoveReadinessInput): Promise<HubOperationReadiness | null> {
  const authority = createRunningIntentAuthority(input.db), intent = await authority.get(input.sessionId);
  if (!intent && !input.readmitOperationId) return null;
  const owner = await input.owner(), home = input.home;
  if (!home || home.machineId !== input.machineId || home.epoch !== input.epoch || !intent || intent.file !== input.file || intent.cwd !== input.cwd || intent.epoch !== input.epoch || intent.desired !== "running" || intent.suspended) throw new Error("participant-readiness-unavailable");
  const lock = await input.lock(), id = input.readmitOperationId ?? authority.operationId(input.sessionId);
  if (!id || !lock || !lock.operationId && !input.readmitOperationId || lock.pendingOperationId || lock.identity.pid !== owner.pid || lock.identity.startIdentity !== owner.startTime) throw new Error("participant-launch-provenance-unavailable");
  const terminal = await input.caller();
  const result: HubOperationReadiness = { origin: "hub-operation", opId: id, sessionId: input.sessionId, epoch: input.epoch, file: input.file, cwd: input.cwd, core: terminal.coreId, terminal: terminal.address };
  recordReadiness(input.journal, result); writeLocal(input.db, "participant-ready", input.sessionId, result); return result;
}
