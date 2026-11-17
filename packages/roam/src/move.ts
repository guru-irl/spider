// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { withProcessLock } from "@spider/herdr/sessions/registry";
import { storeScope } from "@spider/db-core/roam/codec";
import type { Home, HubOperationReadiness, JsonObject, Probe, StoreBarrier } from "@spider/db-core/roam/types";
import type { IntercomIntakeFence, SessionEndpoint } from "@spider/intercom/protocol";
import { MOVE_REFUSAL_MESSAGES } from "./contracts";
import type { DestinationObservation, FreezeAck, Journal, MoveCheck, MovePorts, MoveRequest, MoveResult, SourceCleanup, MoveRefusal, MoveRefusalCode, MoveSessionOutcome, ValidatedBlockerId, Operation, Outcome, PreparedMove } from "./contracts";
import { casHome, sessionHome } from "./homes";
import { isMachineId } from "./machine-id";
import { acquireMovePower, movePowerKey, releaseMovePower } from "./power";

export const MOVE_STATES = ["checked", "frozen", "transferred", "home-committed", "destination-ready", "source-stopped", "done"] as const;
export type MoveState = typeof MOVE_STATES[number];
export class MoveError extends Error {
  readonly refusal: MoveRefusal;
  constructor(code: MoveRefusalCode, blockers: readonly ValidatedBlockerId[] = []) {
    super(MOVE_REFUSAL_MESSAGES[code]);
    this.refusal = { code, blockers, message: MOVE_REFUSAL_MESSAGES[code] };
  }
}
function refuse(code: MoveRefusalCode, blockers: readonly ValidatedBlockerId[] = []): never { throw new MoveError(code, blockers); }
export function validateBlockerId(value: unknown): ValidatedBlockerId {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/.test(value)) refuse("move-blockers-invalid");
  return value as ValidatedBlockerId;
}
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !/[\u0000-\u001f]/.test(value);
const epoch = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
function sameHome(actual: Home | null | "unknown", expected: Home): boolean {
  return !!actual && actual !== "unknown" && actual.sessionId === expected.sessionId && actual.machineId === expected.machineId &&
    actual.epoch === expected.epoch && actual.moveId === expected.moveId;
}
function home(value: Home): void {
  if (!value || !text(value.sessionId) || !isMachineId(value.machineId) || !epoch(value.epoch) ||
      !(value.moveId === null || text(value.moveId)) || !Number.isSafeInteger(value.updatedAt)) refuse("move-home-invalid");
}
function probe(value: Probe): void {
  if (!value || !["absent", "live", "uncertain"].includes(value.kind)) refuse("move-owner-invalid");
  if (value.kind === "live" && (!value.identity || !epoch(value.identity.pid) || !text(value.identity.bootId) || !text(value.identity.startTime))) refuse("move-owner-invalid");
}
function warnings(value: readonly string[]): void {
  if (!Array.isArray(value) || value.some(item => !text(item))) refuse("move-warnings-invalid");
}
function checkReply(check: MoveCheck, request: MoveRequest): void {
  if (!check) refuse("move-check-invalid");
  home(check.source); warnings(check.warnings);
  if (check.source.sessionId !== request.sessionId || check.destinationMachine !== request.destinationMachine ||
      request.operation.expectedEpoch !== null && check.source.epoch !== request.operation.expectedEpoch ||
      !text(check.repoKey) || !text(check.workspaceId) ||
      ![check.sourceRoot, check.sourceCwd, check.sourceFile, check.destinationRoot, check.destinationCwd].every(value => text(value) && isAbsolute(value)) ||
      !Array.isArray(check.storeKeys) || !check.storeKeys.length || new Set(check.storeKeys).size !== check.storeKeys.length || !check.storeKeys.includes("global") ||
      !check.storeKeys.includes(`repo:${check.repoKey}`) || !check.storeKeys.includes(`worktree:${check.repoKey}:${check.workspaceId}`)) refuse("move-check-invalid");
  try { check.storeKeys.forEach(storeScope); } catch { refuse("move-check-invalid"); }
}
function storeBarriers(check: MoveCheck, required: readonly StoreBarrier[]): void {
  if (!Array.isArray(required) || required.some(row => !row || !text(row.stream) || !Number.isSafeInteger(row.through) || row.through < 0 ||
      !check.storeKeys.includes(row.storeKey)) || new Set(required.map(row => row.storeKey)).size !== required.length) refuse("move-barrier-invalid");
  if (check.storeKeys.some(key => !required.some(row => row.storeKey === key))) refuse("move-barrier-missing");
}
function freezeReply(check: MoveCheck, ack: FreezeAck, operation: Operation): void {
  if (!ack || ack.operationId !== operation.id || ack.sessionId !== check.source.sessionId || ack.epoch !== check.source.epoch ||
      ack.file !== check.sourceFile || ack.cwd !== check.sourceCwd || !text(ack.leaf) || !epoch(ack.size) ||
      !/^[a-f0-9]{64}$/.test(ack.sha256) || !text(ack.intercomGeneration)) refuse("move-freeze-invalid");
  if (ack.owner !== null) probe({ kind: "live", identity: ack.owner });
  storeBarriers(check, ack.barriers);
}
function preparedReply(check: MoveCheck, prepared: PreparedMove, operation: Operation, stage: "pre" | "final"): void {
  if (!prepared?.workspace?.snapshot || !prepared.session) refuse("move-prepared-invalid");
  const { workspace, session } = prepared, snapshot = workspace.snapshot;
  if (workspace.root !== check.destinationRoot || workspace.moveId !== operation.id || snapshot.moveId !== operation.id || snapshot.stage !== stage ||
      snapshot.repoKey !== check.repoKey || snapshot.workspaceId !== check.workspaceId || snapshot.root !== check.sourceRoot ||
      session.sessionId !== check.source.sessionId || session.cwd !== check.destinationCwd || !isAbsolute(session.file) ||
      !epoch(session.size) || !text(session.leaf) || !/^[a-f0-9]{64}$/.test(session.sha256) || !/^[a-f0-9]{64}$/.test(session.historySha256) ||
      !text(session.artifactId)) refuse("move-prepared-invalid");
}
function readinessReply(value: HubOperationReadiness | null, home: Home, prepared: PreparedMove, operation: Operation): HubOperationReadiness {
  if (!value || value.origin !== "hub-operation" || value.opId !== operation.id || value.sessionId !== home.sessionId || value.epoch !== home.epoch ||
      value.cwd !== prepared.session.cwd || value.file !== prepared.session.file || !text(value.core) || !text(value.terminal)) refuse("move-readiness-invalid");
  return value;
}
function observationReply(value: DestinationObservation, current: Home): void {
  if (!value || !sameHome(value.home, current) || typeof value.retired !== "boolean" || !(value.launchFailure === null || text(value.launchFailure))) refuse("move-observation-invalid");
  probe(value.owner);
}
function endpointReply(endpoint: SessionEndpoint, fence: IntercomIntakeFence, current: Home): void {
  if (!endpoint || endpoint.address?.sessionId !== fence.address.sessionId || endpoint.address.scopeId !== fence.address.scopeId ||
      endpoint.machineId !== current.machineId || endpoint.homeEpoch !== current.epoch || !text(endpoint.activationEpoch)) refuse("intercom-endpoint-not-ready");
}
function json(value: unknown): JsonObject { return JSON.parse(JSON.stringify(value)) as JsonObject; }
function outcome(request: MoveRequest, ports: MovePorts, code: Outcome<MoveResult>["code"], reason: MoveRefusalCode | "moved" | "same-home", value: MoveResult | null = null, blockers: readonly ValidatedBlockerId[] = []): MoveSessionOutcome {
  const current = sessionHome(ports.globalDb, request?.sessionId ?? "");
  const envelope = { code, reason, operationId: text(request?.operation?.id) ? request.operation.id : "invalid-move", home: current === "unknown" ? null : current,
    epoch: current && current !== "unknown" ? current.epoch : null, repairCommand: reason === "initial-home-conflict" ? "spider roam claim" : code === 3 && text(request?.operation?.id) ? `spider roam recover ${request.operation.id}` : null };
  if (code === 0 && value) return { ...envelope, code: 0, ok: true, value };
  if (code === 0 || reason === "moved" || reason === "same-home") refuse("move-journal-invalid");
  return { ...envelope, code, ok: false, value: null, refusal: { code: reason, blockers, message: MOVE_REFUSAL_MESSAGES[reason] } };
}
export function parseSourceCleanup(value: unknown): SourceCleanup {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('status' in value)) refuse('move-journal-invalid');
  switch (value.status) {
    case 'done': return { status: 'done' };
    case 'pending': {
      if (!('blockers' in value) || !Array.isArray(value.blockers) || !value.blockers.length) refuse('move-journal-invalid');
      if (!('reason' in value) || typeof value.reason !== 'string' || !Object.hasOwn(MOVE_REFUSAL_MESSAGES, value.reason)) refuse('move-journal-invalid');
      return { status: 'pending', reason: value.reason as MoveRefusalCode, blockers: value.blockers.map(validateBlockerId) };
    }
    default: return refuse('move-journal-invalid');
  }
}

function completedOutcome(value: unknown, id: string): MoveSessionOutcome {
  const result = value as Outcome<MoveResult> & { ok: boolean; refusal?: MoveRefusal };
  if (!result || ![0, 1, 2, 3].includes(result.code) || result.operationId !== id || !text(result.reason) ||
      !(result.repairCommand === null || text(result.repairCommand))) refuse("move-journal-invalid");
  if (result.home !== null) { try { home(result.home); } catch { refuse("move-journal-invalid"); } }
  if (result.epoch !== (result.home?.epoch ?? null)) refuse("move-journal-invalid");
  if (result.ok === true) {
    if (result.code !== 0 || !result.home || !result.value || !sameHome(result.value.home, result.home) ||
        !(result.value.terminal === null || text(result.value.terminal)) || !text(result.value.intercomAddress)) refuse("move-journal-invalid");
    try { home(result.value.home); warnings(result.value.warnings); parseSourceCleanup(result.value.sourceCleanup); } catch { refuse("move-journal-invalid"); }
  } else if (result.ok === false) {
    if (result.code === 0 || result.value !== null || !result.refusal || !Object.hasOwn(MOVE_REFUSAL_MESSAGES, result.refusal.code) ||
        result.reason !== result.refusal.code || result.refusal.message !== MOVE_REFUSAL_MESSAGES[result.refusal.code] || !Array.isArray(result.refusal.blockers)) refuse("move-journal-invalid");
    try { result.refusal.blockers.forEach(validateBlockerId); } catch { refuse("move-journal-invalid"); }
  } else refuse("move-journal-invalid");
  return result as MoveSessionOutcome;
}
function participantOperation(request: MoveRequest, current: Home): Operation {
  return { ...request.operation, machineId: current.machineId, expectedEpoch: current.epoch,
    args: { ...request.operation.args, sessionId: request.sessionId, moveId: request.operation.id } };
}
/** The session reservation is machine-local journal metadata, never a second home authority. */
export function moveSessionSlot(sessionId: string): string { return `move-session-${createHash("sha256").update(sessionId).digest("hex")}`; }
/** Reservation metadata is not a second home authority. Recovery reads it under the session move lock. */
export function readMoveReservation(sessionId: string, journal: Journal): { moveId: string; destinationMachine: string } | null {
  const rows = journal.read(moveSessionSlot(sessionId));
  let reservation: { moveId: string; destinationMachine: string } | null = null;
  for (const row of rows) {
    if (row.action === "reserved" && !reservation && text(row.result.moveId) && isMachineId(row.result.destinationMachine)) {
      reservation = { moveId: row.result.moveId, destinationMachine: row.result.destinationMachine };
    } else if (row.action === "released" && reservation && row.result.moveId === reservation.moveId) reservation = null;
    else refuse("move-journal-invalid");
  }
  return reservation;
}
function reserve(request: MoveRequest, ports: MovePorts): string {
  const id = moveSessionSlot(request.sessionId);
  ports.journal.begin({ id, machineId: ports.config.hubMachineId, expectedEpoch: null, kind: "move-session", args: { sessionId: request.sessionId } });
  const reservation = readMoveReservation(request.sessionId, ports.journal);
  if (reservation && (reservation.moveId !== request.operation.id || reservation.destinationMachine !== request.destinationMachine)) refuse("move-session-conflict");
  if (!reservation) ports.journal.record(id, "reserved", { moveId: request.operation.id, destinationMachine: request.destinationMachine });
  return id;
}
export { recoverMove, cancelMove, recoverIncompleteMoves, authorizeMoveAbort } from "./move-recovery";

const running = new Map<string, { request: MoveRequest; promise: Promise<MoveSessionOutcome> }>();

/** Forward-only. Unknown effects remain pending for explicit recovery, never timeout rollback. */
export async function moveSession(request: MoveRequest, ports: MovePorts): Promise<MoveSessionOutcome> {
  if (!ports.config.enabled) return outcome(request, ports, 1, "roaming-disabled");
  if (ports.config.role !== "hub" || ports.config.machineId !== ports.config.hubMachineId) return outcome(request, ports, 1, "move-requires-hub");
  if (!request || !text(request.sessionId) || !isMachineId(request.destinationMachine) || !request.operation ||
      !text(request.operation.id) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.operation.id) || request.operation.id.includes("..") || request.operation.id.endsWith(".") || request.operation.id.endsWith(".lock") || request.operation.kind !== "move" ||
      request.operation.machineId !== ports.config.hubMachineId ||
      !(request.operation.expectedEpoch === null || epoch(request.operation.expectedEpoch)) ||
      !request.operation.args || request.operation.args.sessionId !== request.sessionId || request.operation.args.destinationMachine !== request.destinationMachine) return outcome(request, ports, 2, "move-request-invalid");
  const intercom = ports.intercom;
  if (!intercom?.address || intercom.address.sessionId !== request.sessionId || !(intercom.address.scopeId === null || text(intercom.address.scopeId)) ||
      typeof intercom.destinationEndpoint !== "function" || !intercom.ports ||
      ["close", "drain", "inspect", "checkGeneration", "abort", "ready"].some(name => typeof intercom.ports[name as keyof typeof intercom.ports] !== "function")) return outcome(request, ports, 1, "intercom-fence-unsupported");
  request = structuredClone(request);
  const key = JSON.stringify([resolve(ports.globalDb.raw.name), request.sessionId]), prior = running.get(key);
  if (prior) {
    if (prior.request.operation.id !== request.operation.id) return outcome(request, ports, 1, "move-session-conflict");
    if (JSON.stringify(prior.request) !== JSON.stringify(request)) return outcome(request, ports, 2, "move-operation-conflict");
    return prior.promise;
  }
  const promise = withProcessLock(join(dirname(resolve(ports.globalDb.raw.name)), "roam", "moves"), request.sessionId,
    () => forward(request, ports)).catch(() => outcome(request, ports, 3, "move-lock-pending"));
  running.set(key, { request: structuredClone(request), promise });
  try { return await promise; }
  finally { if (running.get(key)?.promise === promise) running.delete(key); }
}

/** Recovery calls this only while holding the same session move lock and after reconciling unknown ownership. */
export async function resumeMove(request: MoveRequest, ports: MovePorts): Promise<MoveSessionOutcome> { return forward(request, ports, true); }

export function withMoveLock<T>(sessionId: string, ports: MovePorts, effect: () => Promise<T>): Promise<T> {
  return withProcessLock(join(dirname(resolve(ports.globalDb.raw.name)), "roam", "moves"), sessionId, effect);
}

function actionReceipt(rows: ReturnType<Journal["read"]>, name: string): ReturnType<Journal["read"]>[number] | undefined {
  const completed = rows.filter(row => row.action === "move-action-complete" && row.result.action === name);
  if (name === 'source-retire') return completed.find(row => {
    const value = row.result.value;
    return value && typeof value === 'object' && !Array.isArray(value) && value.kind === 'absent';
  });
  if (name !== "start") return completed[0];
  const final = completed.filter(row => {
    const value = row.result.value;
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.code !== "number" || ![0, 1, 2, 3].includes(value.code)) refuse("move-journal-invalid");
    return value.code !== 3;
  });
  if (final.some(row => !isDeepStrictEqual(row.result.value, final[0].result.value))) refuse("move-journal-invalid");
  // Retain a pending reply when no final proof exists; it must never replay the start effect.
  return final[0] ?? completed[0];
}

/** Shared journal-boundary parsers; recovery uses the same validation as the initial move. */
export const moveEvidence: {
  sameHome: typeof sameHome; checkReply: typeof checkReply; freezeReply: typeof freezeReply;
  preparedReply: typeof preparedReply; readinessReply: typeof readinessReply; observationReply: typeof observationReply;
  completedOutcome: typeof completedOutcome; participantOperation: typeof participantOperation; json: typeof json; outcome: typeof outcome;
  actionReceipt: typeof actionReceipt;
} = { sameHome, checkReply, freezeReply, preparedReply, readinessReply, observationReply, completedOutcome, participantOperation, json, outcome, actionReceipt };

async function forward(request: MoveRequest, ports: MovePorts, recovering = false): Promise<MoveSessionOutcome> {
  const id = request.operation.id, powerKey = movePowerKey(ports, id);
  let checked = false, begunNew = false, slot: string | null = null;
  let moved: { source: Home; value: MoveResult } | null = null;
  const action = async <T>(name: string, effect: () => Promise<T> | T): Promise<T> => {
    if (recovering) {
      const completed = actionReceipt(ports.journal.read(id), name);
      if (completed) return structuredClone(completed.result.value) as T;
    }
    const cleanupRetry = recovering && (name === "source-retire" || name === "cleanup");
    if (!cleanupRetry || !ports.journal.read(id).some(row => row.action === "move-action-start" && row.result.action === name))
      ports.journal.record(id, "move-action-start", { action: name });
    const value = await effect(), receipt = { action: name, value: value === undefined ? null : json(value) };
    const previous = cleanupRetry ? ports.journal.read(id).filter(row => row.action === "move-action-complete" && row.result.action === name).at(-1) : null;
    if (!previous || !isDeepStrictEqual(previous.result, receipt)) ports.journal.record(id, "move-action-complete", receipt);
    return value;
  };
  const state = (state: MoveState, evidence: JsonObject) => {
    if (!recovering || !ports.journal.read(id).some(row => row.action === "move-state" && row.result.state === state)) ports.journal.record(id, "move-state", { state, ...evidence });
  };
  try {
    actionReceipt(ports.journal.read(id), "start");
    let begun;
    try { begun = ports.journal.begin(request.operation); }
    catch (error) { refuse(error instanceof Error && error.message === "Operation ID already has different arguments" ? "move-operation-conflict" : "move-journal-unavailable"); }
    if (begun.kind === "done") {
      const result = completedOutcome(begun.result, id);
      if (readMoveReservation(request.sessionId, ports.journal)?.moveId === id) {
        checked = ports.journal.read(id).some(row => row.action === "move-state" && row.result.state === "checked");
        if (checked) await acquireMovePower(powerKey, ports.power);
        return outcome(request, ports, 3, "move-pending");
      }
      return result;
    }
    begunNew = begun.kind === "new";
    if (begunNew) ports.journal.record(id, "move-request", json(request));
    slot = reserve(request, ports);
    if (begun.kind === "pending" && !recovering) {
      checked = ports.journal.read(id).some(row => row.action === "move-state" && row.result.state === "checked");
      if (checked) await acquireMovePower(powerKey, ports.power);
      return outcome(request, ports, 3, "move-pending");
    }
    const check = await action("check", async () => { const reply = await ports.check(structuredClone(request)); checkReply(reply, request); return reply; });
    const current = sessionHome(ports.globalDb, request.sessionId);
    checkReply(check, request);
    const committedBefore = recovering && ports.journal.read(id).some(row => row.action === "move-action-complete" && row.result.action === "home-commit");
    if (!committedBefore && (current === "unknown" || current && !sameHome(current, check.source) ||
        current === null && (check.source.epoch !== 1 || check.source.moveId !== null))) refuse("move-source-home-mismatch");
    if (check.source.machineId === request.destinationMachine) {
      if (!sameHome(current, check.source)) refuse("move-source-home-mismatch");
      const observation = await action("same-home-inspect", () => ports.inspect(check.source, participantOperation(request, check.source)));
      observationReply(observation, check.source);
      if (observation.owner.kind === "uncertain" || observation.owner.kind === "live" && observation.retired ||
          observation.owner.kind === "absent" && !observation.retired) refuse("move-source-owner-uncertain");
      if (!sameHome(sessionHome(ports.globalDb, request.sessionId), check.source)) refuse("move-source-home-mismatch");
      const result = outcome(request, ports, 0, "same-home", { sourceCleanup: { status: "done" }, home: check.source, terminal: observation.readiness?.terminal ?? null, intercomAddress: ports.intercom.address.sessionId, warnings: check.warnings });
      ports.journal.record(id, "done", json(result)); ports.journal.record(slot, "released", { moveId: id });
      return result;
    }
    state("checked", { check: json(check) }); checked = true;
    await action("power", () => acquireMovePower(powerKey, ports.power));
    const seeded = await action("seed", async () => { const value = await ports.seed(check); storeBarriers(check, value); return value; });
    await action("seed-barriers", async () => {
      if (!await ports.barriers(check.source.machineId, seeded)) refuse("move-barriers-pending");
    });
    if (!committedBefore) {
      const initial = sessionHome(ports.globalDb, request.sessionId);
      const marker = ports.globalDb.prepare("SELECT machine_id FROM session_homes WHERE session_id=?").get(request.sessionId) as { machine_id: string } | undefined;
      if (marker?.machine_id === "") refuse("initial-home-conflict");
      if (!initial || initial === "unknown" || !sameHome(initial, check.source)) refuse("move-source-home-mismatch");
      await action("initial-home", () => initial);
      await action("source-home-replicate", () => ports.replicateHome(initial));
    }
    const pre = await action("prestage", async () => { const value = await ports.prepare(structuredClone(check), structuredClone(request.operation)); preparedReply(check, value, request.operation, "pre"); return value; });
    if (!committedBefore && !sameHome(sessionHome(ports.globalDb, request.sessionId), check.source)) refuse("move-source-home-mismatch");
    const sourceOperation = participantOperation(request, check.source);
    const ack = await action("freeze", async () => { const value = await ports.freeze(check.source, sourceOperation); freezeReply(check, value, sourceOperation); return value; });
    freezeReply(check, ack, sourceOperation);
    const fence: IntercomIntakeFence = { address: ports.intercom.address, moveId: id, expectedEpoch: check.source.epoch, generation: ack.intercomGeneration };
    state("frozen", { ack: json(ack), fence: json(fence), pre: json(pre) });
    const inspection = await action("intercom-inspect", () => ports.intercom.ports.inspect(fence));
    if (!inspection || !Array.isArray(inspection.blockers) || !Array.isArray(inspection.cancelledWork) || inspection.cancelledWork.length ||
        Array.from(inspection.blockers).some(row => !row || !text(row.kind) || typeof row.detail !== "string")) refuse("move-blockers-invalid");
    warnings(inspection.warnings);
    if (inspection.blockers.length) refuse("move-intercom-blocked", inspection.blockers.map(row => validateBlockerId(row.id)));
    const prepared = await action("transfer", async () => { const value = await ports.transfer(structuredClone(check), structuredClone(ack), structuredClone(request.operation)); preparedReply(check, value, request.operation, "final"); return value; });
    preparedReply(check, prepared, request.operation, "final");
    await action("final-barriers", async () => { if (!await ports.barriers(request.destinationMachine, ack.barriers)) refuse("move-barriers-pending"); });
    state("transferred", { prepared: json(prepared) });
    await action("generation-check", () => ports.intercom.ports.checkGeneration(fence));
    const committed = await action("home-commit", async () => {
      await ports.verifySource(ack, prepared.workspace.snapshot);
      return casHome(ports.globalDb, check.source, request.destinationMachine, id, ports.config.hubMachineId);
    });
    if (!sameHome(sessionHome(ports.globalDb, request.sessionId), committed)) refuse("move-home-changed");
    state("home-committed", { home: json(committed) });
    await action("home-replicate", () => ports.replicateHome(committed));
    const destinationOperation = participantOperation(request, committed);
    const started = await action("start", () => ports.start(committed, prepared, destinationOperation));
    if (started.code !== 0) refuse("move-destination-pending");
    if (started.operationId !== destinationOperation.id || !sameHome(started.home, committed) || started.epoch !== committed.epoch) refuse("move-readiness-invalid");
    const readiness = readinessReply(started.value, committed, prepared, destinationOperation);
    state("destination-ready", { readiness: json(readiness) });
    const observation = await action("destination-inspect", () => ports.inspect(committed, destinationOperation));
    observationReply(observation, committed);
    if (observation.owner.kind !== "live" || observation.retired) refuse("move-destination-pending");
    readinessReply(observation.readiness, committed, prepared, destinationOperation);
    const endpoint = await action("destination-endpoint", async () => {
      try { return await ports.intercom.destinationEndpoint(committed); }
      catch { return refuse("intercom-endpoint-not-ready"); }
    });
    endpointReply(endpoint, fence, committed);
    if (!sameHome(sessionHome(ports.globalDb, request.sessionId), committed)) refuse("move-home-changed");
    const intercom = await action("intercom-ready", () => ports.intercom.ports.ready(fence, endpoint));
    if (!text(intercom.intercomAddress)) refuse("intercom-endpoint-not-ready"); warnings(intercom.warnings);
    moved = { source: check.source, value: { sourceCleanup: { status: 'done' }, home: committed, terminal: readiness.terminal, intercomAddress: intercom.intercomAddress,
      warnings: [...new Set([...check.warnings, ...inspection.warnings, ...intercom.warnings, ...prepared.workspace.snapshot.droppedConfigKeys, ...prepared.workspace.adjustments])] } };
    const stopped = await action("source-retire", () => ports.retire(check.source, sourceOperation));
    probe(stopped); if (stopped.kind !== "absent") refuse("move-source-stop-pending");
    state("source-stopped", {});
    const finalObservation = await action("final-inspect", () => ports.inspect(committed, destinationOperation));
    observationReply(finalObservation, committed);
    if (finalObservation.owner.kind !== "live" || finalObservation.retired) refuse("move-destination-pending");
    readinessReply(finalObservation.readiness, committed, prepared, destinationOperation);
    if (!sameHome(sessionHome(ports.globalDb, request.sessionId), committed)) refuse("move-home-changed");
    await action("cleanup", () => ports.cleanup(check, request.operation));
    const value: MoveResult = { sourceCleanup: { status: "done" }, home: committed, terminal: readiness.terminal, intercomAddress: intercom.intercomAddress,
      warnings: [...new Set([...check.warnings, ...inspection.warnings, ...intercom.warnings, ...prepared.workspace.snapshot.droppedConfigKeys,
        ...prepared.workspace.adjustments, ...ports.journal.read(id).filter(row => row.action === "move-cleanup-warnings").flatMap(row => row.result.warnings as string[])])] };
    state("done", { result: json(value) });
    const result = outcome(request, ports, 0, "moved", value);
    await action("power-release", () => releaseMovePower(powerKey));
    ports.journal.record(id, "done", json(result));
    ports.journal.record(slot, "released", { moveId: id });
    return result;
  } catch (error) {
    const rows = ports.journal.read(id), failedAction = rows.filter(row => row.action === 'move-action-start').at(-1)?.result.action;
    if (moved && (failedAction === 'source-retire' || failedAction === 'cleanup')) {
      const blockers = error instanceof MoveError && error.refusal.blockers.length ? error.refusal.blockers
        : [validateBlockerId(error instanceof MoveError ? error.refusal.code : failedAction === 'source-retire' ? 'move-source-stop-pending' : 'move-pending')];
      const sourceCleanup: SourceCleanup = { status: 'pending', reason: failedAction === 'cleanup' ? 'move-cleanup-pending' : 'move-source-stop-pending', blockers };
      const pending = { sessionId: moved.source.sessionId, sourceMachine: moved.source.machineId, sourceCleanup: json(sourceCleanup) };
      const previous = rows.filter(row => row.action === 'move-source-cleanup-pending').at(-1);
      if (!previous || !isDeepStrictEqual(previous.result, pending)) ports.journal.record(id, 'move-source-cleanup-pending', pending);
      await releaseMovePower(powerKey);
      return outcome(request, ports, 0, 'moved', { ...moved.value, sourceCleanup });
    }
    const freezeStarted = ports.journal.read(id).some(row => row.action === "move-action-start" && row.result.action === "freeze");
    if (!freezeStarted && error instanceof MoveError) checked = false;
    checked ||= !(error instanceof MoveError) && ports.journal.read(id).some(row => row.action === "move-action-complete" && row.result.action === "check");
    const committed = ports.globalDb.prepare('SELECT committed_home_json FROM roam_home_actions WHERE move_id=?').get(id) as { committed_home_json: string | null } | undefined;
    const reason = error instanceof MoveError && error.refusal.code !== 'move-preflight-refused' ? error.refusal.code
      : committed?.committed_home_json ? 'move-destination-pending' : freezeStarted ? 'move-pending' : 'move-preflight-refused';
    const code = checked || ["move-journal-invalid", "move-journal-unavailable"].includes(reason) ? 3 : reason === "move-operation-conflict" ? 2 : 1;
    const result = outcome(request, ports, code, reason, null, error instanceof MoveError ? error.refusal.blockers : []);
    if (!checked && (begunNew || recovering) && code !== 3) {
      ports.journal.record(id, "done", json(result));
      if (slot) ports.journal.record(slot, "released", { moveId: id });
      await releaseMovePower(powerKey);
    }
    if (checked) await acquireMovePower(powerKey, ports.power).catch(() => {});
    return result;
  }
}
