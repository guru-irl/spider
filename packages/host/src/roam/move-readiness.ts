import { participantLaunchSuccessor } from "@spider/roam/participant-launch";
import type { Db } from "@spider/db-core";
import { writeLocal } from "@spider/db-core/roam/local-state";
import type { Home, HubOperationReadiness, Probe } from "@spider/db-core/roam/types";
import type { IdLockObservation } from "@spider/herdr/sessions/id-lock";
import type { FreezeJournal } from "@spider/roam/journal";
import { createRunningIntentAuthority, readReadiness, recordReadiness } from "@spider/roam/session-control";
import { sessionHome } from "@spider/roam/homes";
import type { ParticipantReadinessQuery } from "@spider/roam/move-ports";

/** Use the same tuple and owned-process checks for fresh launches and replay. */
export async function readOwnedLaunchReadiness(ports: {
  db: Db; journal: FreezeJournal; machineId: string;
  lock(sessionId: string): Promise<IdLockObservation | null>;
  probe(sessionId: string): Promise<Probe>;
}, { sessionId, launchId, epoch }: ParticipantReadinessQuery): Promise<HubOperationReadiness | null> {
  const authority = createRunningIntentAuthority(ports.db), intent = await authority.get(sessionId), home = sessionHome(ports.db, sessionId);
  const lock = await ports.lock(sessionId), intentOperationId = authority.operationId(sessionId);
  if (!intent || !intentOperationId || !lock?.operationId || lock.pendingOperationId !== null || !participantLaunchSuccessor(ports.journal, ports.machineId, intent, intentOperationId, launchId, lock.operationId)) return null;
  const ready = readReadiness(ports.journal, lock.operationId);
  if (!ready || ready.sessionId !== sessionId || ready.epoch !== epoch) return null;
  const owner = await ports.probe(sessionId);
  if (!intent || intent.desired !== "running" || intent.suspended || !home || home === "unknown" || home.machineId !== ports.machineId || home.epoch !== epoch ||
      ready.file !== intent.file || ready.cwd !== intent.cwd || intent.epoch !== epoch || !lock || lock.pendingOperationId !== null || lock.operationId !== ready.opId ||
      owner.kind !== "live" || lock.identity.pid !== owner.identity.pid || lock.identity.startIdentity !== owner.identity.startTime) return null;
  return ready;
}

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
  const lock = await input.lock(), id = input.readmitOperationId ?? lock?.operationId, intentOperationId = authority.operationId(input.sessionId);
  if (!id || !intentOperationId || !lock || !lock.operationId && !input.readmitOperationId || lock.pendingOperationId || lock.identity.pid !== owner.pid || lock.identity.startIdentity !== owner.startTime) throw new Error("participant-launch-provenance-unavailable");
  const terminal = await input.caller();
  const result: HubOperationReadiness = { origin: "hub-operation", opId: id, sessionId: input.sessionId, epoch: input.epoch, file: input.file, cwd: input.cwd, core: terminal.coreId, terminal: terminal.address };
  if (!input.journal.read(id).some(row => row.action === "readiness-intent" && row.result.intentOperationId === intentOperationId &&
      row.result.sessionId === input.sessionId && row.result.epoch === input.epoch))
    input.journal.record(id, "readiness-intent", { sessionId: input.sessionId, epoch: input.epoch, intentOperationId });
  recordReadiness(input.journal, result); writeLocal(input.db, "participant-ready", input.sessionId, result); return result;
}
