// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { hostingWarningText } from "./hosting-warning";
import { safeCauseCode } from "./cause-codes";
import { safeMoveCause } from "./move-failure";
import { writeLocal } from "@spider/db-core/roam/local-state";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Home, JsonObject } from "@spider/db-core/roam/types";
import type { DestinationObservation, FreezeAck, MoveCheck, MovePorts, MoveRequest, MoveSessionOutcome, Operation, PreparedMove, WorkspaceRestore } from "./contracts";
import { recoveredForgottenHome } from "./forget";
import { recoverInterruptedWorkspace } from "./workspace-import";
import { cancelHomeAction, casHome, sessionHome } from "./homes";
import { MoveError, validateBlockerId, moveEvidence as evidence, moveSessionSlot, readMoveReservation, resumeMove, withMoveLock } from "./move";
import { acquireMovePower, movePowerKey, releaseMovePower } from "./power";

function requestFor(id: string, ports: MovePorts): MoveRequest {
  const request = ports.journal.read(id).find(row => row.action === "move-request")?.result as unknown as MoveRequest;
  if (!request || request.operation?.id !== id || request.operation.kind !== "move" || !request.sessionId ||
      request.operation.args.sessionId !== request.sessionId || request.operation.args.destinationMachine !== request.destinationMachine ||
      request.operation.machineId !== ports.config.hubMachineId) throw new MoveError("move-journal-invalid");
  // begin rechecks the argument digest against the immutable original operation.
  ports.journal.begin(request.operation);
  return request;
}
function actionValue<T>(ports: MovePorts, id: string, action: string): T | null {
  const row = evidence.actionReceipt(ports.journal.read(id), action);
  return row ? structuredClone(row.result.value) as T : null;
}
function recordAction(ports: MovePorts, id: string, action: string, value: unknown): void {
  const prior = evidence.actionReceipt(ports.journal.read(id), action), next = evidence.json(value);
  if (prior) {
    if (action !== "start") return;
    if ((prior.result.value as JsonObject).code !== 3) {
      if (!isDeepStrictEqual(prior.result.value, next)) throw new MoveError("move-journal-invalid");
      return;
    }
  }
  ports.journal.record(id, "move-action-complete", { action, value: next });
}
function receipt(ports: MovePorts, id: string): Home | null {
  const row = ports.globalDb.prepare("SELECT committed_home_json FROM roam_home_actions WHERE move_id=?").get(id) as { committed_home_json: string | null } | undefined;
  return row?.committed_home_json ? JSON.parse(row.committed_home_json) as Home : null;
}
function cancelled(ports: MovePorts, id: string): boolean {
  return !!(ports.globalDb.prepare("SELECT cancelled FROM roam_home_actions WHERE move_id=?").get(id) as { cancelled: number } | undefined)?.cancelled;
}
export function rollbackMoveId(id: string): string { return `rollback-${createHash("sha256").update(id).digest("hex").slice(0,40)}`; }

/** Fresh hub proof for Task 4.3b's authorizeAbort. Unavailability never authorizes an abort. */
export async function authorizeMoveAbort(operation: Operation, ports: MovePorts): Promise<{ home: Home; cancelledMoveId: string } | null> {
  try {
    const id = operation.args.moveId;
    if (typeof id !== "string" || operation.kind !== "session-unfreeze") return null;
    const request = requestFor(id, ports), current = sessionHome(ports.globalDb, request.sessionId);
    if (!current || current === "unknown" || operation.args.sessionId !== request.sessionId ||
        operation.machineId !== current.machineId || operation.expectedEpoch !== current.epoch || !cancelled(ports, id)) return null;
    const check = actionValue<MoveCheck>(ports, id, "check");
    if (!check || !evidence.sameHome(current, check.source)) return null;
    return { home: current, cancelledMoveId: id };
  } catch { return null; }
}

export async function recoverMove(moveId: string, ports: MovePorts): Promise<MoveSessionOutcome> { return reconcile(moveId, ports, false); }
export async function cancelMove(moveId: string, ports: MovePorts): Promise<MoveSessionOutcome> {
  const result = await reconcile(moveId, ports, true);
  if (!result.ok && !result.refusal.blockers.length) result.refusal.blockers = [validateBlockerId(result.reason)];
  return result;
}

/** Hub startup awaits these reconciliations before publishing move handlers. Pending reservations remain occupied. */
export async function recoverIncompleteMoves(moveIds: readonly string[], ports: MovePorts): Promise<readonly MoveSessionOutcome[]> {
  await recoverWorkspaceRestores(await ports.recovery.workspaceRestores?.() ?? []);
  const results: MoveSessionOutcome[] = [];
  for (const id of new Set(moveIds)) results.push(await recoverMove(id, ports));
  return results;
}
/** Completed settings transitions never reach filesystem or ownership checks during startup. */
export function pendingWorkspaceTransitions(db: import("@spider/db-core").Db, journal: import("./contracts").Journal, sessionId?: string): { operationId: string; sessionId: string | null; value: import("@spider/db-core/roam/types").JsonObject }[] {
  const rows = db.prepare(`SELECT t.operation_id,t.result_json FROM roam_operation_actions t
    WHERE t.action='workspace-settings-transition' AND NOT EXISTS (
      SELECT 1 FROM roam_operation_actions c WHERE c.operation_id=t.operation_id
      AND c.action IN ('workspace-settings-transition-complete','workspace-settings-recovery-complete')
      AND json_extract(c.result_json,'$.transitionId')=json_extract(t.result_json,'$.transitionId'))`).all() as { operation_id: string; result_json: string }[];
  return rows.flatMap(row => {
    const actions = journal.read(row.operation_id), saved = actions.find(action => action.action === "workspace-session")?.result.sessionId ?? actions.find(action => action.action === "move-request")?.result.sessionId;
    const owner = typeof saved === "string" && saved ? saved : null;
    return sessionId !== undefined && owner !== sessionId ? [] : [{ operationId: row.operation_id, sessionId: owner, value: JSON.parse(row.result_json) as import("@spider/db-core/roam/types").JsonObject }];
  });
}
/** The public workspace entry point takes its checkout lock inside the participant ownership locks. */
export async function recoverWorkspaceRestores(restores: readonly WorkspaceRestore[]): Promise<readonly { destination: string; reason: string }[]> {
  const failures: { destination: string; reason: string }[] = [];
  for (const restore of restores) {
    try { await restore.withBothLocks(() => recoverInterruptedWorkspace(restore.snapshot, restore.destination, restore.repository, restore.ports)); }
    catch { failures.push({ destination: restore.destination, reason: "workspace-recovery-pending" }); }
  }
  return failures;
}
async function reconcile(id: string, ports: MovePorts, cancel: boolean): Promise<MoveSessionOutcome> {
  let pendingWarning: DestinationObservation["hostingWarning"];
  let failureReason: "move-journal-unavailable" | "move-lock-failed" = "move-journal-unavailable";
  let request: MoveRequest = { sessionId: "", destinationMachine: "", operation: { id, kind: "move", machineId: ports.config.hubMachineId, expectedEpoch: null, args: {} } };
  try {
    if (!ports.config.enabled) return evidence.outcome(request, ports, 1, "roaming-disabled");
    if (ports.config.role !== "hub" || ports.config.machineId !== ports.config.hubMachineId) return evidence.outcome(request, ports, 1, "move-requires-hub");
    request = requestFor(id, ports);
    failureReason = "move-lock-failed";
    return await withMoveLock(request.sessionId, ports, async () => {
      const rows = ports.journal.read(id);
      try {
        const unfrozenCancel = cancel && !evidence.actionReceipt(rows, "freeze") &&
          !rows.some(row => row.action === "move-action-start" && row.result.action === "transfer") && !receipt(ports, id);
        if (!unfrozenCancel && !rows.some(row => row.action === "done") && rows.some(row => row.action === "move-action-start" && row.result.action === "freeze")) {
          try { await acquireMovePower(movePowerKey(ports, id), ports.power); }
          catch { throw new MoveError("move-power-pending"); }
        }
        return await locked(request, ports, cancel, warning => { pendingWarning = warning; });
      }
      catch (error) {
        const reason = error instanceof MoveError ? error.refusal.code : cancel ? "move-abort-pending" : "move-pending";
        const code = error && typeof error === "object" && "code" in error ? error.code : null;
        const cause = code === "abort-authorization-pending" ? code : safeCauseCode(code) ?? safeMoveCause(code);
        const blockers = error instanceof MoveError ? error.refusal.blockers : cause ? [validateBlockerId(cause)] : [];
        const result = evidence.outcome(request, ports, 3, cancel && reason === "move-preflight-refused" ? "move-abort-pending" : reason, null, blockers);
        if (!result.ok && result.reason === "move-destination-pending" && pendingWarning) {
          result.refusal.hostingWarning = pendingWarning;
          result.refusal.message += ` ${hostingWarningText(pendingWarning)}`;
        }
        return result;
      }
    });
  } catch (error) {
    const occupied = error instanceof Error && error.name === "HerdrError" && "code" in error && error.code === "lock-occupied";
    return evidence.outcome(request, ports, 3, error instanceof MoveError ? error.refusal.code : occupied ? "move-lock-pending" : failureReason);
  }
}
async function complete(request: MoveRequest, ports: MovePorts, result: MoveSessionOutcome): Promise<MoveSessionOutcome> {
  await releaseMovePower(movePowerKey(ports, request.operation.id));
  const begun = ports.journal.begin(request.operation);
  if (begun.kind !== "done") ports.journal.record(request.operation.id, "done", evidence.json(result));
  if (readMoveReservation(request.sessionId, ports.journal)?.moveId === request.operation.id)
    ports.journal.record(moveSessionSlot(request.sessionId), "released", { moveId: request.operation.id });
  writeLocal(ports.globalDb, "recovery-diagnostic", request.operation.id, undefined);
  return result;
}
async function locked(request: MoveRequest, ports: MovePorts, cancel: boolean, warn: (warning: DestinationObservation["hostingWarning"]) => void): Promise<MoveSessionOutcome> {
  const id = request.operation.id, rows = ports.journal.read(id), done = rows.find(row => row.action === "done");
  evidence.actionReceipt(rows, "start");
  if (done) {
    await retryAbortedWorkspace(id, ports);
    return complete(request, ports, evidence.completedOutcome(done.result, id));
  }
  const reservation = readMoveReservation(request.sessionId, ports.journal);
  if (reservation && reservation.moveId !== id) throw new MoveError("move-session-conflict");
  const check = actionValue<MoveCheck>(ports, id, "check");
  const recovered = recoveredForgottenHome(request.sessionId, ports);
  const sourceEpoch = check?.source?.epoch ?? request.operation.expectedEpoch;
  if (recovered && sourceEpoch != null && sourceEpoch < recovered.home.epoch) return complete(request, ports, { code: 0, ok: true, reason: "destroyed-machine-recovered", operationId: id,
    home: recovered.home, epoch: recovered.home.epoch, repairCommand: null, value: recovered });
  if (!check) {
    if (cancel) throw new MoveError("move-journal-invalid");
    return resumeMove(request, ports);
  }
  evidence.checkReply(check, request);
  const current = sessionHome(ports.globalDb, request.sessionId);
  if ((!current || current === "unknown" || !evidence.sameHome(current, check.source)) &&
      !rows.some(row => row.action === "move-action-start" && row.result.action === "freeze"))
    return complete(request, ports, evidence.outcome(request, ports, 1, "move-source-home-mismatch"));
  if (!current || current === "unknown") throw new MoveError("move-home-changed");
  const committed = receipt(ports, id), restored = receipt(ports, rollbackMoveId(id));
  if (restored) return finishRollback(request, check, restored, ports);
  if (!committed) {
    if (!evidence.sameHome(current, check.source)) throw new MoveError("move-home-changed");
    if (cancel || cancelled(ports, id) || rows.some(row => row.action === "move-abort-start")) return abort(request, check, ports);
    return resumeMove(request, ports);
  }
  if (!evidence.sameHome(current, committed) || committed.machineId !== request.destinationMachine ||
      committed.epoch !== check.source.epoch + 1 || committed.moveId !== id) throw new MoveError("move-home-changed");
  // A home transaction may have committed before its journal reply. Never reverify retired source bytes.
  recordAction(ports, id, "home-commit", committed);
  const prepared = actionValue<PreparedMove>(ports, id, "transfer"), ack = actionValue<FreezeAck>(ports, id, "freeze");
  if (!prepared || !ack) throw new MoveError("move-journal-invalid");
  evidence.preparedReply(check, prepared, request.operation, "final");
  evidence.freezeReply(check, ack, evidence.participantOperation(request, check.source));
  const operation = evidence.participantOperation(request, committed);
  const observation = await ports.inspect(committed, { ...operation, kind: "session-inspect" });
  evidence.observationReply(observation, committed);
  warn(observation.hostingWarning);
  if (!evidence.sameHome(sessionHome(ports.globalDb, request.sessionId), committed)) throw new MoveError("move-home-changed");
  // Either a hub receipt or a participant receipt permanently prohibits rollback.
  const ready = rows.some(row => row.action === "move-state" && row.result.state === "destination-ready") ||
    actionValue<{ code: number; value: unknown }>(ports, id, "start")?.code === 0 || observation.readiness !== null;
  if (ready) {
    if (observation.readiness) evidence.readinessReply(observation.readiness, committed, prepared, operation);
    if (!observation.readiness || observation.owner.kind !== "live" || observation.retired) throw new MoveError("move-destination-pending");
    if (actionValue<{ code: number }>(ports, id, "start")?.code !== 0)
      recordAction(ports, id, "start", { code: 0, reason: "ready", operationId: id, home: committed, epoch: committed.epoch, repairCommand: null, value: observation.readiness });
    return resumeMove(request, ports);
  }
  if (observation.launchFailure !== null) return rollback(request, check, committed, observation, ports);
  const startAttempted = rows.some(row => row.action === "move-action-start" && row.result.action === "start");
  if (cancel || startAttempted || observation.owner.kind !== "absent" || observation.retired) throw new MoveError("move-destination-pending");
  return resumeMove(request, ports);
}
async function abort(request: MoveRequest, check: MoveCheck, ports: MovePorts): Promise<MoveSessionOutcome> {
  const id = request.operation.id;
  ports.journal.record(id, "move-abort-start", {});
  // Home verification and cancellation are one synchronous hub transaction, before any await or unfreeze.
  ports.globalDb.raw.transaction(() => {
    if (!evidence.sameHome(sessionHome(ports.globalDb, request.sessionId), check.source)) throw new MoveError("move-home-changed");
    cancelHomeAction(ports.globalDb, check.source, request.destinationMachine, id, ports.config.hubMachineId);
  }).immediate();
  ports.journal.record(id, "move-abort-cancelled", {});
  if (ports.journal.read(id).some(row => row.action === "move-action-start" && row.result.action === "freeze")) {
    const operation = { ...evidence.participantOperation(request, check.source), id: `abort-${id}`, kind: "session-unfreeze" };
    if (!await authorizeMoveAbort(operation, ports)) throw new MoveError("move-abort-pending");
    await ports.unfreeze(check.source, operation);
  }
  await queueAbortedWorkspace(request, check, ports);
  // Cleanup has its own durable retry operation and cannot hold source admission hostage.
  const result = { code: 0 as const, ok: true as const, reason: "cancelled", operationId: id, home: check.source, epoch: check.source.epoch, repairCommand: null,
    value: { sourceCleanup: { status: "done" as const }, home: check.source, terminal: null, intercomAddress: ports.intercom.address.sessionId, warnings: check.warnings } };
  return complete(request, ports, result);
}
async function rollback(request: MoveRequest, check: MoveCheck, committed: Home, observation: DestinationObservation, ports: MovePorts): Promise<MoveSessionOutcome> {
  if (typeof ports.readmitSource !== "function" || !observation.launchFailure || observation.readiness !== null || observation.owner.kind !== "absent") throw new MoveError("move-rollback-proof-missing");
  const id = request.operation.id, rollbackId = rollbackMoveId(id);
  ports.journal.record(id, "move-rollback-start", { home: evidence.json(committed) });
  const operation = { ...evidence.participantOperation(request, committed), id: `${rollbackId}-retire`, kind: "session-retire" };
  const stopped = await ports.retire(committed, operation);
  if (stopped.kind !== "absent") throw new MoveError("move-source-stop-pending");
  const retired = await ports.inspect(committed, { ...operation, id: `${rollbackId}-inspect`, kind: "session-inspect" });
  evidence.observationReply(retired, committed);
  if (!retired.launchFailure || retired.readiness !== null || retired.owner.kind !== "absent" || !retired.retired || retired.activationCancelled !== true)
    throw new MoveError("move-rollback-proof-missing");
  ports.journal.record(id, "move-rollback-retired", evidence.json(retired));
  const restored = casHome(ports.globalDb, committed, check.source.machineId, rollbackId, ports.config.hubMachineId);
  ports.journal.record(id, "move-rollback-home", { home: evidence.json(restored) });
  return finishRollback(request, check, restored, ports);
}
async function finishRollback(request: MoveRequest, check: MoveCheck, restored: Home, ports: MovePorts): Promise<MoveSessionOutcome> {
  const id = request.operation.id;
  if (restored.epoch !== check.source.epoch + 2 || restored.machineId !== check.source.machineId ||
      restored.moveId !== rollbackMoveId(id) || !evidence.sameHome(sessionHome(ports.globalDb, request.sessionId), restored)) throw new MoveError("move-home-changed");
  const retired = ports.journal.read(id).find(row => row.action === "move-rollback-retired")?.result as unknown as DestinationObservation;
  if (!retired || retired.readiness !== null || !retired.launchFailure || retired.owner?.kind !== "absent" || !retired.retired || retired.activationCancelled !== true)
    throw new MoveError("move-rollback-proof-missing");
  await ports.replicateHome(restored);
  if (!evidence.sameHome(sessionHome(ports.globalDb, request.sessionId), restored)) throw new MoveError("move-home-changed");
  const operation = { ...evidence.participantOperation(request, restored), id: `${rollbackMoveId(id)}-readmit`, kind: "session-readmit" };
  const result = await ports.readmitSource(check.source, restored, operation);
  if (result.code !== 0) return evidence.outcome(request, ports, 3, result.ok ? "move-rollback-proof-missing" : result.refusal.code);
  if (!evidence.sameHome(result.home, restored) || !evidence.sameHome(result.value.home, restored) || result.epoch !== restored.epoch || result.operationId !== operation.id)
    throw new MoveError("move-rollback-proof-missing");
  await queueAbortedWorkspace(request, check, ports);
  return complete(request, ports, { ...result, operationId: id, reason: "rolled-back" });
}

export function abortCleanupId(moveId: string): string { return `abort-cleanup-${createHash("sha256").update(moveId).digest("hex").slice(0,40)}`; }
async function queueAbortedWorkspace(request: MoveRequest, check: MoveCheck, ports: MovePorts): Promise<void> {
  const operation: Operation = { id: abortCleanupId(request.operation.id), kind: "move-abort-cleanup", machineId: ports.config.hubMachineId, expectedEpoch: check.source.epoch,
    args: { moveId: request.operation.id, sessionId: request.sessionId } };
  const prior = ports.journal.begin(operation);
  if (prior.kind === "done") return;
  if (!ports.journal.read(operation.id).some(row => row.action === "abort-cleanup-request")) ports.journal.record(operation.id, "abort-cleanup-request", { moveId: request.operation.id, sessionId: request.sessionId, check: evidence.json(check) });
  await retryAbortedWorkspace(request.operation.id, ports);
}
export async function retryAbortedWorkspace(moveId: string, ports: MovePorts): Promise<void> {
  const id = abortCleanupId(moveId), rows = ports.journal.read(id), request = rows.find(row => row.action === "abort-cleanup-request")?.result;
  if (!request || rows.some(row => row.action === "done")) return;
  try {
    if (!ports.abortWorkspace) throw new Error("adapter-unbound:abortWorkspace");
    const check = request.check as unknown as MoveCheck;
    await ports.abortWorkspace(check, { id: moveId, kind: "move-abort-workspace", machineId: ports.config.hubMachineId, expectedEpoch: check.source.epoch, args: { sessionId: check.source.sessionId, moveId } });
    ports.journal.record(id, "done", { moveId });
  } catch { if (!rows.some(row => row.action === "cleanup-pending")) ports.journal.record(id, "cleanup-pending", { moveId }); }
}
