// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { createInterface } from "node:readline";
import { createReadStream, existsSync, realpathSync, readFileSync, lstatSync, renameSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Db } from "@spider/db-core";
import { parseLocationStores, recordLocation } from "@spider/db-core/roam/catalog";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { storeScope } from "@spider/db-core/roam/codec";
import { seedSession } from "@spider/db-core/roam/seed";
import { readSessionState } from "@spider/db-core/roam/state";
import { parseHubReadiness } from "@spider/db-core/roam/readiness";
import type { Blocker, Home, HubOperationReadiness, JsonObject, Probe, StoreBarrier, StoreKey } from "@spider/db-core/roam/types";
import { isSessionEndpoint, sameAddress, type FederationBlockers, type IntercomIntakeFence, type SessionAddress, type SessionEndpoint } from "@spider/intercom/protocol";
import type { ArtifactManifest, Clock, DestinationObservation, Diagnostic, FreezeAck, GitPorts, IntercomMovePorts, Journal, MoveCheck, MovePorts, MoveRequest, MoveSessionOutcome,
  Operation, Outcome, PaneActionOutcome, PaneTarget, PreparedMove, RoamConfig, SessionManifest, Transport, WorkspaceImportPorts, WorkspaceRestore, WorkspaceSnapshot } from "./contracts";
import type { IntercomFederationClient } from "@spider/intercom/broker/client";
import type { IntercomBridge } from "./intercom-bridge";
import type { FreezeJournal } from "./journal";
import { createMovePower, type PowerPorts } from "./power";
import { controlSession, createRunningIntentAuthority, recordReadiness, startParticipant } from "./session-control";
import { requestSessionControl } from "./session-socket";
import { isRevoked } from "./revocation";
import { isMachineId } from "./machine-id";
import { sessionHome } from "./homes";
import { abortCleanupId, authorizeMoveAbort, recoverIncompleteMoves, rollbackMoveId } from "./move-recovery";
import { forgetMachine, forgottenPresentationComplete, recoveredForgottenHome } from "./forget";
import { inspectRestoredSession, inspectSession, installSession, stageSession, verifyFrozenSession } from "./session-file";
import { cleanupMoveRefs, snapshotWorkspace } from "./workspace";
import { abortWorkspace, prepareWorkspace, verifyWorkspace } from "./workspace-import";
import { bundleWorkspace } from "./git-bundle";
import { pullArtifact, stageArtifact, transferArtifact } from "./artifacts";
import { recoverMirror } from "./mirrors";
import { openOutgoingStaging, openStaging, syncStagingDirectory, sourceChunk, validateManifest } from "./staging";
import { MoveError, validateBlockerId } from "./move";

export interface RollbackEvidence {
  currentHome: Home; forwardReceipt: Home; rollbackReceipt: Home; retirement: DestinationObservation;
  check: MoveCheck; freeze: FreezeAck;
}
export interface MoveEvidenceBindings {
  /** A fresh authoritative hub read; a replica or cached cancellation is never proof. */
  rollback?(operation: Operation): Promise<RollbackEvidence | null>;
  presentation?(operation: Operation): Promise<JsonObject | null>;
  authorizeAbort?(operation: Operation): Promise<{ home: Home; cancelledMoveId: string } | null>;
  authorizeRetire?(operation: Operation): Promise<Home | null>;
  onHubRestored?(listener: () => void): () => void;
  bridge?(address: SessionAddress): FederationBlockers | Promise<FederationBlockers>;
  settlement?(query: { messageId: string; fromSessionId: string | null; toSessionId: string | null; scopeId: string | null }): Promise<{
    messageId: string; fromSessionId: string | null; toSessionId: string | null; scopeId: string | null; kind: "receipt" | "outcome" | "delivered";
  } | null>;
  broker?: { inspectFreezeBlockers(address: SessionAddress): Promise<FederationBlockers> };
}
export type MoveFreezeEvidenceBindings = Required<Pick<MoveEvidenceBindings, (typeof evidenceNames)[number]>>;
/** Host supplies its dormant factory; these types deliberately do not depend on host or Pi. */
export interface DormantMoveContext {
  sessionId: string; file: string; cwd: string; home: Home | null;
  journal: FreezeJournal; stores: readonly Db[]; expectedStores: readonly StoreKey[];
  intercom: { address: SessionAddress; ports: IntercomMovePorts };
  evidence: MoveFreezeEvidenceBindings;
  authorizeAbort(operation: Operation): Promise<{ home: Home; cancelledMoveId: string } | null>;
  authorizeRetire(operation: Operation): Promise<Home | null>;
  onHubRestored(listener: () => void): () => void;
  retryAbort(operation: Operation): Promise<void>;
}
export interface ParticipantLaunchRequest { sessionId: string; operationId: string }
export type ParticipantLaunchResult = { ok: true; launchId: string } | { ok: false; reason: string };
export interface ParticipantReadinessQuery { sessionId: string; launchId: string; epoch: number }
export interface MoveParticipantBindings {
  pi: string | null;
  config: RoamConfig; globalDb: Db; root: string; runtimeRoot: string;
  /** Complete participant roster, including repository and global stores used by freeze. */
  stores: readonly { key: StoreKey; db: Db }[];
  withBothLocks<T>(sessionId: string, effect: (locks?: import("./session-control").HeldSessionLocks) => Promise<T>): Promise<T>;
  probe(sessionId: string): Promise<Probe>;
  exit?: Pick<NonNullable<import("./session-control").SessionControlPorts["exit"]>, "exited" | "wait">;
  git: Omit<GitPorts, "journal" | "limits">;
  writers(root: string): Promise<readonly Blocker[]>;
  sessionTarget(sessionId: string, moveId: string): Promise<string>;
  auth(): Promise<readonly Diagnostic[]>;
  identityCurrent(): Promise<boolean>;
  wake(request: ParticipantLaunchRequest): Promise<ParticipantLaunchResult>;
  readiness(query: ParticipantReadinessQuery): Promise<HubOperationReadiness | null>;
  observation(home: Home, operation: Operation): Promise<DestinationObservation>;
  dormant(context: DormantMoveContext): (operation: Operation) => Promise<Outcome<JsonObject>>;
  /** Failed destination retirement includes durable e+1 activation cancellation, before rollback CAS. */
  retireFailed(home: Home, operation: Operation): Promise<Probe>;
  /** Host reuses the original live owner without releasing ordinary admission before membership advancement. */
  readmitLive(home: Home, operation: Operation, file: string): Promise<HubOperationReadiness | null>;
  /** Remove only the recorded terminal after its existing terminal-removal proof. */
  cleanupTerminal(operation: Operation, locks?: import("./session-control").HeldSessionLocks): Promise<void>;
}
export type HandoffCaptureOutcome =
  | { capture: "durable"; presentation: PaneActionOutcome }
  | { capture: "refused"; reason: string };
export interface MoveAdapterBindings {
  globalDb?: Db; privateDb?: Db; root?: string; clock?: Clock; power?: PowerPorts;
  stores?: { open(key: StoreKey): Db; head(key: StoreKey): StoreBarrier };
  sync?: Pick<MovePorts, "barriers"> & { sync(peer?: string): Promise<readonly Outcome<unknown>[]> };
  /** Mapped paths are local catalog observations, not paths accepted from a foreign manifest. */
  mapping?(request: MoveRequest, location: { file: string; cwd: string; stores: readonly StoreKey[] }): Promise<{
    repoKey: string; workspaceId: string; sourceRoot: string; destinationRoot: string; destinationCwd: string;
  } | null>;
  participant?: MoveParticipantBindings;
  evidence?: MoveEvidenceBindings;
  intercom?: { address: SessionAddress; ports: IntercomMovePorts; destinationEndpoint(home: Home): Promise<SessionEndpoint>;
    rollback: {
      currentFence(sessionId: string, moveId: string): Promise<IntercomIntakeFence | null>;
      /** Compare and reopen this exact fence atomically; a mismatch must never partially reopen intake. */
      reopen(fence: IntercomIntakeFence, home: Home, receipt: Home): Promise<void>;
    } };
  handoff?: {
    prepareHandoff(input: { source: Home; operation: Operation; placementRoot: string }): Promise<HandoffCaptureOutcome>;
    /** Supply the admitted destination locator, including concrete core and terminal identity. */
    readyTarget(home: Home): Promise<PaneTarget | null>;
    presentReadyTarget(target: PaneTarget): Promise<PaneActionOutcome>;
  };
  recovery?: {
    mirrors?: import("./sync").SyncPorts["mirrors"];
    retireOnly?: import("./sync").SyncPorts["retireOnly"];
    supervisorHandshake?(machineId: string): import("./revocation").SyncHandshake;
    workspaceRestores?(): Promise<readonly WorkspaceRestore[]>;
    mirrorRoot: string;
    /** Map and prepare the local restore workspace. Null is missing evidence, never a guessed path. */
    restoreWorkspace(home: Home, mirror: SessionManifest, operation: Operation): Promise<{ cwd: string; parent: string | null } | null>;
    conflicts(sessionId: string): Promise<readonly { machineId: string; owner: Probe }[]>;
  };
}
export class MoveAdapterError extends MoveError {
  constructor(readonly code: string) { super("move-preflight-refused", [validateBlockerId(code)]); this.message = code; this.name = "MoveAdapterError"; }
}
function required<T>(value: T | null | undefined, name: string): T {
  if (value === undefined || value === null) throw new MoveAdapterError(`adapter-unbound:${name}`);
  return value;
}
const dependencies = {
  check: ["globalDb", "mapping", "participant"], power: ["power"], seed: ["stores", "participant", "sync"],
  prepare: ["root", "participant"], freeze: ["participant", "evidence", "intercom", "handoff"],
  transfer: ["root", "participant"], verifySource: ["participant"], barriers: ["sync", "stores"], replicateHome: ["globalDb", "stores", "sync"],
  start: ["participant"], inspect: ["participant"], retire: ["participant", "evidence"], unfreeze: ["participant", "evidence", "intercom"],
  readmitSource: ["globalDb", "participant", "intercom"], abortWorkspace: ["globalDb", "root", "participant"], cleanup: ["globalDb", "root", "participant", "handoff"],
  "intercom.close": ["intercom"], "intercom.drain": ["intercom"], "intercom.inspect": ["intercom"], "intercom.checkGeneration": ["intercom"],
  "intercom.abort": ["intercom"], "intercom.ready": ["globalDb", "intercom", "handoff"], "intercom.destinationEndpoint": ["intercom"],
  "recovery.homes": ["globalDb"], "recovery.mirror": ["recovery"], "recovery.restore": ["participant", "recovery"],
  "recovery.conflicts": ["recovery"], "recovery.presentReadyTarget": ["handoff"], "recovery.workspaceRestores": ["recovery"],
  "participant.pi": ["participant"], globalDb: ["globalDb"], clock: ["clock"], "recovery.revocationDb": ["privateDb"],
} as const satisfies Record<string, readonly (keyof MoveAdapterBindings)[]>;
const evidenceNames = ["authorizeAbort", "authorizeRetire", "onHubRestored", "bridge", "settlement", "broker"] as const;
/** Pure completeness inventory shared by host composition and doctor. Construction performs no IO. */
export function unboundMoveEffects(bindings: MoveAdapterBindings = {}): string[] {
  const missing = new Set<string>();
  for (const [effect, keys] of Object.entries(dependencies)) if (keys.some(key => bindings[key] == null)) missing.add(effect);
  for (const name of evidenceNames) if (!bindings.evidence?.[name]) for (const effect of ["freeze", "unfreeze", "retire"]) missing.add(effect);
  const participant = bindings.participant;
  if (!participant?.pi) {
    for (const effect of ["participant.pi", "start", "readmitSource"]) missing.add(effect);
    if (participant?.config.enabled !== false) missing.add("recovery.restore");
  }
  const participantKeys: readonly (keyof MoveParticipantBindings)[] = ["config", "globalDb", "root", "runtimeRoot", "stores", "withBothLocks", "probe", "git", "writers",
    "sessionTarget", "auth", "identityCurrent", "wake", "readiness", "observation", "dormant", "retireFailed", "readmitLive", "cleanupTerminal"];
  if (participant && participantKeys.some(key => !participant[key])) for (const [effect, keys] of Object.entries(dependencies)) if ((keys as readonly string[]).includes("participant")) missing.add(effect);
  if (bindings.handoff && [bindings.handoff.prepareHandoff, bindings.handoff.readyTarget, bindings.handoff.presentReadyTarget].some(port => !port)) {
    missing.add("freeze"); missing.add("intercom.ready"); missing.add("recovery.presentReadyTarget");
  }
  if (bindings.intercom) {
    for (const name of ["close", "drain", "inspect", "checkGeneration", "abort", "ready"] as const) if (!bindings.intercom.ports?.[name]) missing.add(`intercom.${name}`);
    if (!bindings.intercom.destinationEndpoint) missing.add("intercom.destinationEndpoint");
  }
  if (bindings.intercom && (!bindings.intercom.rollback?.currentFence || !bindings.intercom.rollback.reopen)) missing.add("readmitSource");
  if (!bindings.evidence?.rollback) missing.add("readmitSource");
  for (const name of ["mirrors", "retireOnly", "supervisorHandshake"] as const) if (!bindings.recovery?.[name] || name === "mirrors" && (!bindings.recovery.mirrors?.source || !bindings.recovery.mirrors?.homes || !bindings.recovery.mirrors?.root)) missing.add(`recovery.${name}`);
  if (bindings.recovery && !bindings.recovery.workspaceRestores) missing.add("recovery.workspaceRestores");
  const nested: Record<string, readonly string[]> = {
    power: ["power.spawn", "power.onExit", "power.notice", "power.pid"],
    seed: ["stores.open", "stores.head"], barriers: ["stores.open", "stores.head", "sync.barriers"], replicateHome: ["stores.head", "sync.barriers"],
    prepare: ["participant.git.run", "participant.git.scratch"], transfer: ["participant.git.run", "participant.git.scratch"],
    verifySource: ["globalDb", "participant.git.run"], start: ["participant.git.run"], cleanup: ["participant.git.run"],
    freeze: ["root", "evidence.broker.inspectFreezeBlockers", "intercom.address", "intercom.ports.close", "intercom.ports.drain", "intercom.ports.inspect"],
    unfreeze: ["evidence.broker.inspectFreezeBlockers", "intercom.ports.abort"],
    "recovery.mirror": ["recovery.mirrorRoot"], "recovery.restore": ["recovery.restoreWorkspace", "participant.git.run"],
    "recovery.conflicts": ["recovery.conflicts"], clock: ["clock.now", "clock.later"],
  };
  const valueAt = (path: string): unknown => path.split(".").reduce<unknown>((value, key) => value && (typeof value === "object" || typeof value === "function") ? Reflect.get(value, key) : undefined, bindings);
  for (const [effect, paths] of Object.entries(nested)) if (paths.some(path => valueAt(path) == null)) missing.add(effect);
  if (participant && !participant.stores?.length) for (const effect of ["check", "seed", "freeze", "start", "readmitSource"]) missing.add(effect);
  return [...missing].sort();
}
export function moveEffectReason(effect: string): string { return effect === "participant.pi" ? "participant-pi-unavailable" : `adapter-unbound:${effect}`; }
function guard(bindings: MoveAdapterBindings, effect: keyof typeof dependencies): void {
  if (bindings.evidence && ["freeze", "unfreeze", "retire"].includes(effect)) evidence(bindings);
  if (unboundMoveEffects(bindings).includes(effect)) throw new MoveAdapterError(`adapter-unbound:${effect}`);
}
function evidence(bindings: MoveAdapterBindings): MoveFreezeEvidenceBindings {
  const source = required(bindings.evidence, "evidence");
  for (const name of evidenceNames) required(source[name], `evidence.${name}`);
  return source as MoveFreezeEvidenceBindings;
}
function json(value: unknown): JsonObject { return JSON.parse(JSON.stringify(value)) as JsonObject; }
function sameHome(a: Home | null | "unknown", b: Home): boolean {
  return !!a && a !== "unknown" && a.sessionId === b.sessionId && a.machineId === b.machineId && a.epoch === b.epoch && a.moveId === b.moveId && a.updatedAt === b.updatedAt;
}
function checkedLocation(value: unknown): { file: string; cwd: string; stores: StoreKey[] } {
  const row = value as { file?: unknown; cwd?: unknown; stores?: unknown } | null;
  if (!row || typeof row.file !== "string" || typeof row.cwd !== "string" || !isAbsolute(row.file) || !isAbsolute(row.cwd)) throw new MoveAdapterError("participant-location-unavailable");
  let stores: StoreKey[];
  try { stores = parseLocationStores(row.stores); }
  catch { throw new MoveAdapterError("participant-stores-unavailable"); }
  return { file: row.file, cwd: row.cwd, stores };
}
function location(db: Db, sessionId: string): { file: string; cwd: string; stores: StoreKey[] } {
  const row = db.prepare("SELECT file,cwd,stores_json FROM roam_locations WHERE session_id=?").get(sessionId) as { file: string; cwd: string; stores_json: string } | undefined;
  if (!row) throw new MoveAdapterError("participant-location-unavailable");
  let stores: unknown;
  try { stores = JSON.parse(row.stores_json); }
  catch { throw new MoveAdapterError("participant-stores-unavailable"); }
  return checkedLocation({ ...row, stores });
}
function participantOperation(home: Home, operation: Operation, kind: string, hubMachineId: string, args: JsonObject = {}): Operation {
  return { id: `${operation.id}-${kind}-${home.machineId}`, machineId: home.machineId, expectedEpoch: home.epoch, kind,
    args: { ...args, sessionId: home.sessionId, moveId: operation.args.moveId ?? operation.id, sourceMachine: hubMachineId } };
}
function successful<T>(outcome: Outcome<T>): T {
  if (outcome.code !== 0 || outcome.value === null) {
    let code: string;
    try { code = validateBlockerId(outcome.reason); } catch { code = "participant-operation-refused"; }
    throw new MoveAdapterError(code);
  }
  return outcome.value;
}

const presentationRecoveries = new WeakMap<MovePorts, (moveId: string) => Promise<void>>();
const presentationFlights = new WeakMap<Journal, Map<string, Promise<void>>>();
interface SourceViewRequest {
  check: MoveCheck; operation: Operation; proof: MoveCleanupProof;
  originalOperation?: Operation; sourceMoveId?: string;
}
function supersededSourceMoveId(moveId: string): string {
  return `source-cleanup-${createHash("sha256").update(moveId).digest("hex").slice(0, 40)}`;
}

/** Replay only this move's view cleanup through its session-bound adapter. */
export async function recoverMovePresentation(ports: MovePorts, moveId: string): Promise<void> {
  await required(presentationRecoveries.get(ports), "presentation.recover")(moveId);
}

/** All effects are mounted, but an unbound effect refuses before any side effect. No command is mounted here. */
export function createMovePorts(config: RoamConfig, transport: Transport, journal: Journal, bindings: MoveAdapterBindings = {}): MovePorts {
  const call = async <T>(home: Home, operation: Operation, kind: string, args: JsonObject = {}): Promise<Outcome<T>> => {
    let op = participantOperation(home, operation, kind, config.hubMachineId, args);
    const authorityKind = moveAuthorityKind(op);
    if (home.machineId !== config.hubMachineId && config.role === "hub" && authorityKind) {
      const current = sessionHome(required(bindings.globalDb, "globalDb"), home.sessionId);
      const value = await required(bindings.evidence?.[authorityKind], `evidence.${authorityKind}`)(op);
      if (current && current !== "unknown" && value) op = { ...op, args: { ...op.args, hubEvidence: json({ home: current, kind: authorityKind, value }) } };
    }
    if (home.machineId === config.machineId) return await handleMoveParticipantOperation(op, journal, bindings) as unknown as Outcome<T>;
    const peer = config.peers.find(row => row.machineId === home.machineId);
    if (!peer || ![peer.node, peer.pi, peer.cli].every(isAbsolute)) throw new MoveAdapterError("participant-enrollment-unavailable");
    const pinned = await transport.resolve(peer);
    if (pinned.machineId !== peer.machineId) throw new MoveAdapterError("participant-identity-changed");
    const bytes = await transport.exec(pinned, ["roam", "agent", JSON.stringify(op)], { timeoutMs: config.limits.controlMs, maxBytes: config.limits.replyBytes });
    const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Outcome<T>;
    if (!result || result.operationId !== op.id || result.epoch !== home.epoch || ![0, 1, 2, 3].includes(result.code)) throw new MoveAdapterError("participant-reply-invalid");
    return result;
  };
  const importMove = async (check: MoveCheck, operation: Operation, stage: "pre" | "final", ack?: FreezeAck): Promise<PreparedMove> => {
    const destination = { ...check.source, machineId: check.destinationMachine, epoch: check.source.epoch + 1, moveId: operation.id };
    const prerequisites = successful(await call<readonly string[]>(destination, operation, "move-prerequisites", { root: check.destinationRoot, stage }));
    const exported = successful(await call<MoveExport>(check.source, operation, "move-export", { check: json(check), stage, prerequisites: [...prerequisites], parent: json(operation), ack: ack ? json(ack) : null }));
    const root = join(required(bindings.root, stage === "pre" ? "prepare" : "transfer"), "roam", "staging");
    const claims: MoveArtifactClaim[] = [];
    for (const artifact of [exported.workspaceArtifact, exported.sessionArtifact]) {
      if (check.source.machineId !== config.machineId) {
        const peer = required(config.peers.find(row => row.machineId === check.source.machineId), "source-peer");
        const pulled = successful(await pullArtifact(peer, artifact, { transport, journal, limits: config.limits, root, operationId: `${operation.id}-pull-${stage}-${artifact.kind}` }));
        if (check.destinationMachine !== config.machineId) {
          const forwarded = await stageArtifact(pulled.file, artifact.kind, config.limits, { root, artifactId: artifact.id });
          if (!isDeepStrictEqual(forwarded, artifact)) throw new MoveAdapterError("move-relay-artifact-mismatch");
        }
      }
      if (check.destinationMachine !== config.machineId) {
        const peer = required(config.peers.find(row => row.machineId === check.destinationMachine), "destination-peer");
        successful(await transferArtifact(peer, artifact, { transport, journal, limits: config.limits, root, operationId: `${operation.id}-send-${stage}-${artifact.kind}` }));
      }
      claims.push({ artifactId: artifact.id, peer: check.destinationMachine !== config.machineId ? config.machineId : check.source.machineId,
        operationId: `${operation.id}-${check.destinationMachine !== config.machineId ? "send" : "pull"}-${stage}-${artifact.kind}`, sha256: artifact.sha256 });
    }
    return successful(await call<PreparedMove>(destination, operation, "move-import", { check: json(check), exported: json(exported), parent: json(operation), claims: json(claims) }));
  };
  const intercomPorts = (): IntercomMovePorts => required(bindings.intercom, "intercom").ports;
  const intercomEffect = <K extends keyof IntercomMovePorts>(name: K): IntercomMovePorts[K] => required(intercomPorts()[name], `intercom.${name}`);
  const sourceIntake = async <T>(name: "inspect" | "checkGeneration" | "ready", fence: IntercomIntakeFence, endpoint?: SessionEndpoint): Promise<T> => {
    const check = journal.read(fence.moveId).find(row => row.action === "move-action-complete" && row.result.action === "check")?.result.value as unknown as MoveCheck | undefined;
    if (!check || check.source.sessionId !== fence.address.sessionId || check.source.epoch !== fence.expectedEpoch) throw new MoveAdapterError("intercom-fence-unproved");
    return successful(await call<T>(check.source, { id: fence.moveId, kind: "move", machineId: config.hubMachineId, expectedEpoch: check.source.epoch,
      args: { moveId: fence.moveId } }, `move-intercom-${name}`, { fence: json(fence), ...(endpoint ? { endpoint: json(endpoint) } : {}) }));
  };
  const finishPendingPresentation = async (moveId: string): Promise<void> => {
    const taskId = presentationTaskId(moveId), rows = journal.read(taskId);
    if (rows.some(row => row.action === "done")) return;
    const request = rows.find(row => row.action === "source-view-request")?.result as unknown as SourceViewRequest | undefined;
    if (!request) return;
    const db = required(bindings.globalDb, "globalDb"), home = sessionHome(db, request.check.source.sessionId);
    if (request.sourceMoveId) {
      const original = request.originalOperation;
      if (!original || original.id !== request.sourceMoveId || moveId !== supersededSourceMoveId(original.id) ||
          !home || home === "unknown" || !home.moveId || home.moveId === original.id ||
          !sameHome(homeReceipt(db, home.moveId), home) || !validCleanupProof(request.proof, request.check, original.id, db, home.moveId)) return;
      const query: Operation = { ...original, args: { ...original.args, moveId: original.id, check: json(request.check), proof: json(request.proof), presentationMoveId: home.moveId } };
      let presentation = readMovePresentation(journal, query);
      const successorTask = presentationTaskId(home.moveId);
      if (!presentation && !journal.lookupOperation?.(successorTask) && !journal.read(successorTask).length) {
        try {
          const handoff = required(bindings.handoff, "handoff"), target = await handoff.readyTarget(home);
          if (!target || target.sessionId !== home.sessionId || target.machineId !== home.machineId || target.homeEpoch !== home.epoch || target.alias !== null || !target.coreId || !target.terminalId || !sameHome(sessionHome(db, home.sessionId), home)) return;
          const observed = await handoff.presentReadyTarget(target);
          if (observed.status !== "complete" || !sameHome(sessionHome(db, home.sessionId), home)) return;
          presentation = json({ target, ...observed });
        } catch { return; }
      }
      const target = presentation?.target as JsonObject | undefined;
      if (!presentation || presentation.status !== "complete" || target?.sessionId !== home.sessionId || target.machineId !== home.machineId || target.homeEpoch !== home.epoch || target.alias !== null || !target.coreId || !target.terminalId) return;
      if (!rows.some(row => row.action === "successor-presentation" && row.result.moveId === home.moveId && isDeepStrictEqual(row.result.presentation, presentation)))
        journal.record(taskId, "successor-presentation", { moveId: home.moveId, presentation });
      successful(await call(request.check.source, original, "move-cleanup-terminal", { check: json(request.check), proof: json(request.proof), presentation, presentationMoveId: home.moveId }));
      journal.record(taskId, "done", { status: "complete", sourceMoveId: original.id });
      return;
    }
    const destination = request.proof?.destination?.home;
    if (destination && home && home !== "unknown" && home.moveId && home.moveId !== moveId && home.epoch > destination.epoch &&
        sameHome(homeReceipt(db, moveId), destination) && sameHome(homeReceipt(db, home.moveId), home)) {
      // Preserve source cleanup independently; the obsolete target must never replay.
      const deferredId = supersededSourceMoveId(moveId), deferredTask = presentationTaskId(deferredId);
      const deferred: SourceViewRequest = { ...request, operation: { ...request.operation, id: deferredId }, originalOperation: request.operation, sourceMoveId: moveId };
      journal.begin({ id: deferredTask, kind: "move-presentation", machineId: required(bindings.participant, "participant").config.hubMachineId,
        expectedEpoch: destination.epoch, args: { moveId: deferredId, sessionId: request.check.source.sessionId } });
      const existing = journal.read(deferredTask).find(row => row.action === "source-view-request")?.result;
      if (existing && !isDeepStrictEqual(existing, json(deferred))) throw new MoveAdapterError("source-cleanup-mismatch");
      if (!existing) journal.record(deferredTask, "source-view-request", json(deferred));
      journal.record(taskId, "done", { status: "superseded", successorMoveId: home.moveId, cleanupTask: deferredTask });
      await recoverPresentation(deferredId);
      return;
    }
    const presentation = await presentCapturedHandoff(moveId, journal, bindings);
    if (presentation.status !== "complete") return;
    successful(await call(request.check.source, request.operation, "move-cleanup-terminal", { check: json(request.check), proof: json(request.proof), presentation }));
    journal.record(taskId, "done", {});
  };
  const recoverPresentation = (moveId: string): Promise<void> => {
    let flights = presentationFlights.get(journal);
    if (!flights) { flights = new Map(); presentationFlights.set(journal, flights); }
    const running = flights.get(moveId); if (running) return running;
    const active = flights;
    const flight = Promise.resolve().then(() => finishPendingPresentation(moveId)).finally(() => { if (active.get(moveId) === flight) active.delete(moveId); });
    active.set(moveId, flight); return flight;
  };
  const ports: MovePorts = {
    config, journal,
    get globalDb() { return required(bindings.globalDb, "globalDb"); },
    get clock() { return required(bindings.clock, "clock"); },
    intercom: {
      get address() { return required(bindings.intercom, "intercom").address; },
      ports: {
        close: (...args) => intercomEffect("close")(...args), drain: fence => intercomEffect("drain")(fence), inspect: fence => sourceIntake("inspect", fence),
        checkGeneration: async fence => { await sourceIntake("checkGeneration", fence); }, abort: fence => intercomEffect("abort")(fence),
        async ready(fence, endpoint) {
          guard(bindings, "intercom.ready");
          const home = sessionHome(ports.globalDb, endpoint.address.sessionId);
          if (!isSessionEndpoint(endpoint) || !sameAddress(fence.address, endpoint.address) || !home || home === "unknown" || home.machineId !== endpoint.machineId ||
              home.epoch !== endpoint.homeEpoch || home.moveId !== fence.moveId) throw new MoveAdapterError("intercom-endpoint-not-ready");
          const reply = await sourceIntake<{ intercomAddress: string; warnings: readonly string[] }>("ready", fence, endpoint);
          const handoff = required(bindings.handoff, "handoff"), target = await handoff.readyTarget(home);
          if (!target || target.machineId !== home.machineId || target.sessionId !== home.sessionId || target.homeEpoch !== home.epoch || target.alias !== null ||
              !target.coreId || !target.terminalId || !sameHome(sessionHome(ports.globalDb, home.sessionId), home)) throw new MoveAdapterError("presentation-target-unavailable");
          journal.record(fence.moveId, "handoff-presentation-start", json({ status: "pending", target, sourceFence: fence }));
          return reply;
        },
      },
      async destinationEndpoint(home) {
        guard(bindings, "intercom.destinationEndpoint");
        const endpoint = await bindings.intercom!.destinationEndpoint(home);
        if (!isSessionEndpoint(endpoint) || !sameAddress(endpoint.address, ports.intercom.address) || endpoint.machineId !== home.machineId || endpoint.homeEpoch !== home.epoch)
          throw new MoveAdapterError("intercom-endpoint-not-ready");
        return endpoint;
      },
    },
    async check(request) {
      guard(bindings, "check");
      let local = location(ports.globalDb, request.sessionId);
      const marker = ports.globalDb.prepare("SELECT machine_id FROM session_homes WHERE session_id=?").get(request.sessionId) as { machine_id: string } | undefined;
      if (marker?.machine_id === "") throw new MoveError("initial-home-conflict");
      let home = sessionHome(ports.globalDb, request.sessionId);
      if (home === "unknown") throw new MoveAdapterError("move-home-invalid");
      if (!home) {
        const previous = ports.globalDb.prepare("SELECT home_json FROM roam_locations WHERE session_id=?").get(request.sessionId) as { home_json: string | null };
        if (previous.home_json !== null) throw new MoveAdapterError("move-home-invalid");
        const participant = required(bindings.participant, "participant"), origins = new Set<string>();
        for (const row of participant.stores.filter(row => local.stores.includes(row.key) && storeScope(row.key) === "worktree")) {
          const origin = row.db.prepare("SELECT origin_machine FROM sessions WHERE id=?").get(request.sessionId) as { origin_machine: string } | undefined;
          if (origin?.origin_machine) origins.add(origin.origin_machine);
          const state = readSessionState(row.db, request.sessionId);
          if (state && (state.epoch !== 1 || state.state !== "active")) throw new MoveError("move-source-home-mismatch");
        }
        if (origins.size > 1) throw new MoveError("initial-home-conflict");
        if (origins.size !== 1 || !origins.has(config.machineId)) throw new MoveAdapterError("move-home-invalid");
        home = { sessionId: request.sessionId, machineId: config.machineId, epoch: 1, moveId: null, updatedAt: 0 };
      }
      if (home.machineId !== config.machineId) local = checkedLocation(successful(await call<unknown>(home, request.operation, "move-location")));
      const mapped = await bindings.mapping!(request, local);
      if (!mapped) throw new MoveAdapterError("workspace-repository-unmapped");
      const inspection = successful(await call<{ blockers: readonly Blocker[] }>(home, request.operation, "session-inspect"));
      if (!Array.isArray(inspection.blockers)) throw new MoveAdapterError("blocker-source-unavailable");
      if (inspection.blockers.length) throw new MoveError("move-preflight-blocked", inspection.blockers.map(row => validateBlockerId(row.id)));
      const destination = { ...home, machineId: request.destinationMachine };
      const diagnostics = successful(await call<readonly Diagnostic[]>(destination, request.operation, "move-diagnostics"));
      if (!Array.isArray(diagnostics) || diagnostics.some(row => !row || !["warning", "block"].includes(row.severity) || typeof row.reason !== "string")) throw new MoveAdapterError("participant-auth-unavailable");
      if (diagnostics.some(row => row.severity === "block")) throw new MoveAdapterError("participant-auth-unavailable");
      return { source: home, destinationMachine: request.destinationMachine, ...mapped, sourceFile: local.file, sourceCwd: local.cwd, storeKeys: local.stores, warnings: diagnostics.map(row => row.reason) };
    },
    async power() { guard(bindings, "power"); return createMovePower(bindings.power!)(); },
    async seed(check) {
      guard(bindings, "seed");
      const seeded = successful(await call<readonly StoreBarrier[]>(check.source, { id: `seed-${createHash("sha256").update(check.source.sessionId).digest("hex").slice(0, 32)}`, kind: "move", machineId: config.hubMachineId,
        expectedEpoch: check.source.epoch, args: {} }, "move-seed", { keys: [...check.storeKeys] }));
      if (sessionHome(ports.globalDb, check.source.sessionId) === null) {
        await bindings.sync!.sync();
      }
      return seeded;
    },
    async prepare(check, operation) { guard(bindings, "prepare"); return importMove(check, operation, "pre"); },
    async freeze(home, operation) {
      guard(bindings, "freeze"); evidence(bindings);
      const handoff = required(bindings.handoff, "handoff"), capture = await handoff.prepareHandoff({ source: home, operation, placementRoot: join(required(bindings.root, "root"), "roam", "placement") });
      if (capture.capture !== "durable") throw new MoveAdapterError("handoff-capture-unavailable");
      journal.record(String(operation.args.moveId ?? operation.id), "handoff-capture", json({ source: home, presentationStatus: capture.presentation.status, presentation: capture.presentation, placementRoot: join(bindings.root!, "roam", "placement") }));
      const ack = successful(await call<FreezeAck>(home, operation, "session-freeze"));
      if (ack.operationId !== participantOperation(home, operation, "session-freeze", config.hubMachineId).id) throw new MoveAdapterError("participant-reply-invalid");
      return { ...ack, operationId: operation.id };
    },
    async transfer(check, ack, operation) { guard(bindings, "transfer"); return importMove(check, operation, "final", ack); },
    async verifySource(ack, workspace) {
      guard(bindings, "verifySource");
      const home = requiredHome(required(bindings.globalDb, "globalDb"), ack.sessionId);
      if (home.epoch !== ack.epoch) throw new MoveAdapterError("move-home-changed");
      successful(await call<JsonObject>(home, { id: workspace.moveId, machineId: config.hubMachineId, expectedEpoch: ack.epoch, kind: "move", args: {} }, "move-verify", { ack: json(ack), workspace: json(workspace) }));
    },
    async barriers(machine, requiredBarriers) {
      guard(bindings, "barriers");
      if (requiredBarriers.some(barrier => bindings.stores!.head(barrier.storeKey).stream !== barrier.stream)) await bindings.sync!.sync();
      if (machine !== config.machineId) return bindings.sync!.barriers(machine, requiredBarriers);
      for (const barrier of requiredBarriers) {
        const head = bindings.stores!.head(barrier.storeKey);
        if (head.stream === barrier.stream) { if (head.through < barrier.through) return false; continue; }
        const rows = bindings.stores!.open(barrier.storeKey).prepare("SELECT peer_machine,last_seq FROM roam_cursors WHERE peer_stream=?").all(barrier.stream) as { peer_machine: string; last_seq: number }[];
        if (rows.length === 0 && barrier.through === 0) continue;
        if (rows.length !== 1 || !config.peers.some(peer => peer.machineId === rows[0].peer_machine) || rows[0].last_seq < barrier.through) return false;
      }
      return true;
    },
    async replicateHome(home) {
      guard(bindings, "replicateHome");
      if (!sameHome(sessionHome(ports.globalDb, home.sessionId), home)) throw new MoveAdapterError("move-home-changed");
      const barrier = bindings.stores!.head("global");
      for (const machine of new Set([home.machineId, ...config.peers.map(peer => peer.machineId)])) {
        if (machine !== config.machineId && isRevoked(ports.recovery.revocationDb, machine)) continue;
        if (!await ports.barriers(machine, [barrier])) throw new MoveAdapterError("move-barriers-pending");
      }
    },
    async start(home, prepared, operation) {
      guard(bindings, "start");
      const reply = await call<HubOperationReadiness>(home, operation, "session-start", { prepared: json(prepared) });
      return publicReadiness(reply, operation.id);
    },
    async inspect(home, operation) {
      guard(bindings, "inspect");
      const reply = successful(await call<DestinationObservation>(home, operation, "move-observation"));
      if (!reply.readiness) return reply;
      const ready = parseParticipantReadiness(reply.readiness);
      if (home.moveId && ready.opId !== `${home.moveId}-session-start-${home.machineId}` && ready.opId !== home.moveId) throw new MoveAdapterError("participant-readiness-invalid");
      return { ...reply, readiness: { ...ready, opId: home.moveId ?? ready.opId } };
    },
    async retire(home, operation) {
      guard(bindings, "retire"); evidence(bindings);
      const current = sessionHome(ports.globalDb, home.sessionId);
      const failed = sameHome(current, home) && operation.id === `${rollbackMoveId(String(operation.args.moveId ?? home.moveId))}-retire`;
      if (failed) return successful(await call<Probe>(home, operation, "move-retire-failed"));
      successful(await call<JsonObject>(home, operation, "session-retire"));
      return (await ports.inspect(home, operation)).owner;
    },
    async unfreeze(home, operation) { guard(bindings, "unfreeze"); evidence(bindings); successful(await call<JsonObject>(home, operation, "session-unfreeze")); },
    async readmitSource(source, restoredHome, operation) {
      guard(bindings, "readmitSource");
      const reply = await call(restoredHome, operation, "move-readmit", { source: json(source), restoredHome: json(restoredHome) }) as unknown as MoveSessionOutcome;
      return { ...reply, operationId: operation.id };
    },
    async abortWorkspace(check, operation) {
      guard(bindings, "abortWorkspace");
      const cleanupId = abortCleanupId(operation.id);
      const saved = journal.read(cleanupId).find(row => row.action === "abort-cleanup-proof")?.result as unknown as AbortedWorkspaceProof | undefined;
      const proof = saved && validAbortedWorkspaceProof(saved, check, operation.id, ports.globalDb) ? saved : abortedWorkspaceProof(check, operation.id, ports.globalDb, journal);
      if (!proof) throw new MoveAdapterError("move-cleanup-unproved");
      if (!saved) journal.record(cleanupId, "abort-cleanup-proof", json(proof));
      for (const [home, root] of [[proof.home, check.sourceRoot], [{ ...check.source, machineId: check.destinationMachine, epoch: check.source.epoch + 1, moveId: operation.id }, check.destinationRoot]] as const) {
        successful(await call<JsonObject>(home, operation, "move-abort-workspace", { root, check: json(check), proof: json(proof) }));
      }
    },
    async cleanup(check, operation) {
      guard(bindings, "cleanup");
      const rows = journal.read(operation.id), proof: MoveCleanupProof = { source: check.source,
        destination: rows.find(row => row.action === "move-action-complete" && row.result.action === "final-inspect")?.result.value as unknown as DestinationObservation,
        stopped: rows.find(row => row.action === "move-action-complete" && row.result.action === "source-retire")?.result.value as unknown as Probe };
      if (!validCleanupProof(proof, check, operation.id, ports.globalDb)) throw new MoveAdapterError("move-cleanup-unproved");
      const destination = proof.destination.home;
      const presentation = await presentCapturedHandoff(operation.id, journal, bindings);
      const taskId = presentationTaskId(operation.id);
      if (!journal.read(taskId).some(row => row.action === "source-view-request"))
        journal.record(taskId, "source-view-request", json({ check, operation, proof }));
      for (const [home, root] of [[check.source, check.sourceRoot], [destination, check.destinationRoot]] as const) {
        const cleaned = successful(await call<JsonObject>(home, operation, "move-cleanup", { root, check: json(check), proof: json(proof), presentation }));
        if (Array.isArray(cleaned.warnings) && cleaned.warnings.length) journal.record(operation.id, "move-cleanup-warnings", { warnings: cleaned.warnings });
      }
      if (presentation.status === "complete" && !journal.read(taskId).some(row => row.action === "done")) journal.record(taskId, "done", {});
    },
    recovery: {
      blockers() { return unboundMoveEffects(bindings).filter(effect => ["recovery.mirrors", "recovery.retireOnly", "recovery.supervisorHandshake"].includes(effect)).map(effect => `adapter-unbound:${effect}`); },
      get revocationDb() { return required(bindings.privateDb, "recovery.revocationDb"); },
      async workspaceRestores() { return required(bindings.recovery?.workspaceRestores, "recovery.workspaceRestores")(); },
      async presentReadyTarget(target) {
        guard(bindings, "recovery.presentReadyTarget");
        try { return await bindings.handoff!.presentReadyTarget(target); }
        catch { return { status: "pending", reason: "presentation-unavailable", presentation: json({ target }) }; }
      },
      homes(machine) {
        guard(bindings, "recovery.homes");
        return (ports.globalDb.prepare("SELECT session_id FROM session_homes WHERE machine_id=?").all(machine) as { session_id: string }[]).map(row => requiredHome(ports.globalDb, row.session_id));
      },
      async mirror(sessionId, epoch) {
        guard(bindings, "recovery.mirror");
        const current = requiredHome(ports.globalDb, sessionId);
        const source = current.epoch === epoch ? current : current.moveId ? journal.read(current.moveId).find(row => row.action === "forget-home")?.result.source as unknown as Home | undefined : undefined;
        if (!source || source.sessionId !== sessionId || source.epoch !== epoch) return null;
        try { return await recoverMirror({ sessionId, epoch, machineId: source.machineId, root: bindings.recovery!.mirrorRoot, limits: config.limits }); }
        catch (error) {
          if (error && typeof error === "object" && "code" in error && ["mirror-checkpoint-missing", "mirror-no-committed-prefix"].includes(String(error.code))) return null;
          throw error;
        }
      },
      async restore(home, mirror, operation) {
        guard(bindings, "recovery.restore");
        const reply = await call<HubOperationReadiness>(home, operation, "move-restore", { mirror: json(mirror), previousMachine: operation.args.destroyedMachine });
        return publicReadiness(reply, operation.id);
      },
      async conflicts(sessionId) { guard(bindings, "recovery.conflicts"); return bindings.recovery!.conflicts(sessionId); },
    },
  };
  presentationRecoveries.set(ports, recoverPresentation);
  return ports;
}
function requiredHome(db: Db, id: string): Home {
  const home = sessionHome(db, id);
  if (!home || home === "unknown") throw new MoveAdapterError("move-home-invalid");
  return home;
}
interface MoveExport { workspace: WorkspaceSnapshot; session: SessionManifest; workspaceArtifact: ArtifactManifest; sessionArtifact: ArtifactManifest }
function gitPorts(participant: MoveParticipantBindings, journal: Journal): GitPorts {
  return { ...participant.git, journal, limits: participant.config.limits };
}

function assertParticipant(operation: Operation, participant: MoveParticipantBindings): void {
  if (operation.machineId !== participant.config.machineId || operation.args.sourceMachine !== participant.config.hubMachineId ||
      !Number.isSafeInteger(operation.expectedEpoch) || operation.expectedEpoch! < 1 || typeof operation.args.sessionId !== "string" || !operation.args.sessionId)
    throw new MoveAdapterError("participant-home-mismatch");
}

/** 4.6b mounts this handler beside the existing agent operations. It performs no command registration. */
export async function handleMoveParticipantOperation(operation: Operation, journal: Journal, bindings: MoveAdapterBindings): Promise<Outcome<JsonObject>> {
  const participant = required(bindings.participant, "participant"); assertParticipant(operation, participant);
  operation = acceptPushedMoveEvidence(operation, participant);
  const authorityKind = moveAuthorityKind(operation);
  if (participant.config.role === "box" && authorityKind && !await required(bindings.evidence?.[authorityKind], `evidence.${authorityKind}`)(operation))
    return { code: 3, reason: "waiting-for-hub-evidence", operationId: operation.id, home: null, epoch: operation.expectedEpoch, repairCommand: `spider roam recover ${operation.args.moveId}`, value: null };
  const id = operation.args.sessionId as string, home = { sessionId: id, machineId: operation.machineId, epoch: operation.expectedEpoch!, moveId: String(operation.args.moveId), updatedAt: 0 };
  const result = (value: unknown): Outcome<JsonObject> => ({ code: 0, reason: "complete", operationId: operation.id, home, epoch: home.epoch, repairCommand: null, value: json(value) });
  if (operation.kind === "move-location") {
    const current = sessionHome(participant.globalDb, id);
    if (!current || current === "unknown" || current.machineId !== home.machineId || current.epoch !== home.epoch) throw new MoveAdapterError("participant-home-mismatch");
    return result(location(participant.globalDb, id));
  }
  if (["session-inspect", "session-freeze", "session-unfreeze", "session-shutdown", "session-retire"].includes(operation.kind)) {
    const feeds = evidence(bindings), intercom = required(bindings.intercom, "intercom"), local = location(participant.globalDb, id);
    const now = bindings.clock?.now ?? Date.now, deadline = now() + participant.config.limits.controlMs;
    const control = async (op: Operation): Promise<Outcome<JsonObject>> => controlSession(op, {
      journal, probe: participant.probe, withBothLocks: participant.withBothLocks,
      exit: participant.exit ? { ...participant.exit, now, deadline } : undefined,
      live: live => requestSessionControl(participant.runtimeRoot, live, { timeoutMs: Math.max(1, deadline - now()) }),
      dormant: async dormant => participant.dormant({ sessionId: id, file: local.file, cwd: local.cwd, home: requiredHome(participant.globalDb, id),
        journal: journal as FreezeJournal, stores: participant.stores.map(row => row.db), expectedStores: local.stores,
        intercom: { address: intercom.address, ports: intercom.ports }, evidence: feeds,
        authorizeAbort: feeds.authorizeAbort, authorizeRetire: feeds.authorizeRetire, onHubRestored: feeds.onHubRestored,
        retryAbort: async retry => { const reply = await control(retry); if (reply.code !== 0) throw new MoveAdapterError(reply.reason); },
      })(dormant),
    });
    return control(operation);
  }
  if (["move-intercom-inspect", "move-intercom-checkGeneration", "move-intercom-ready"].includes(operation.kind)) {
    const fence = operation.args.fence as unknown as IntercomIntakeFence, local = (journal as FreezeJournal).readIntercomFence(id, String(operation.args.moveId));
    if (!local || !isDeepStrictEqual(local, fence) || fence.address.sessionId !== id || fence.expectedEpoch !== operation.expectedEpoch ||
        !sameAddress(fence.address, required(bindings.intercom, "intercom").address)) throw new MoveAdapterError("intercom-fence-unproved");
    const intake = bindings.intercom!.ports;
    if (operation.kind === "move-intercom-inspect") return result(await intake.inspect(fence));
    if (operation.kind === "move-intercom-checkGeneration") { await intake.checkGeneration(fence); return result({}); }
    const endpoint = operation.args.endpoint as unknown as SessionEndpoint;
    const current = sessionHome(participant.globalDb, id);
    if (!isSessionEndpoint(endpoint) || !current || current === "unknown" || current.moveId !== fence.moveId || current.machineId !== endpoint.machineId || current.epoch !== endpoint.homeEpoch ||
        !sameAddress(endpoint.address, fence.address)) throw new MoveAdapterError("intercom-endpoint-not-ready");
    return result(await intake.ready(fence, endpoint));
  }
  if (operation.kind === "move-diagnostics") return result(await participant.auth());
  if (operation.kind === "move-prerequisites") {
    const root = String(operation.args.root), stage = operation.args.stage;
    if (stage !== "pre" && stage !== "final") throw new MoveAdapterError("workspace-stage-invalid");
    if (stage === "pre") {
      try { await participant.git.run(root, ["git", "fetch", "--quiet", "origin"]); }
      catch { throw new MoveAdapterError("workspace-fetch-unavailable"); }
    }
    let head: Buffer;
    try { head = await participant.git.run(root, ["git", "rev-parse", "--verify", "HEAD^{commit}"]); }
    catch { throw new MoveAdapterError("workspace-prerequisite-missing"); }
    const prerequisites = [head.toString("utf8").trim()];
    if (stage === "final") {
      let staged: Buffer;
      try { staged = await participant.git.run(root, ["git", "rev-parse", "--verify", `refs/spider-roam/${operation.args.moveId}/pre/working^{commit}`]); }
      catch { throw new MoveAdapterError("workspace-prerequisite-missing"); }
      prerequisites.push(staged.toString("utf8").trim());
    }
    return result(prerequisites);
  }
  if (operation.kind === "move-seed") {
    const local = location(participant.globalDb, id), keys = operation.args.keys as StoreKey[];
    if (!Array.isArray(keys) || keys.length !== local.stores.length || keys.some(key => !local.stores.includes(key))) throw new MoveAdapterError("participant-stores-unavailable");
    const stores = required(bindings.stores, "stores");
    for (const key of keys) if (storeScope(key) === "worktree") {
      let seeded;
      do {
        seeded = seedSession(stores.open(key), id, home.epoch, key, participant.config.limits.targetBatchBytes);
        if (seeded.retryable) throw new MoveAdapterError("session-too-busy-to-seed");
        if (!seeded.complete) await yieldToLoop();
      } while (!seeded.complete);
    }
    return result(keys.map(key => stores.head(key)));
  }
  if (operation.kind === "session-start") return await activatePrepared(operation, operation.args.prepared as unknown as PreparedMove, participant, journal) as unknown as Outcome<JsonObject>;
  if (operation.kind === "move-observation") return result(await participant.observation(home, operation));
  if (operation.kind === "move-retire-failed") {
    const observed = await participant.observation(home, operation);
    if (!observed.launchFailure || observed.readiness !== null || observed.owner.kind !== "absent" || !sameHome(sessionHome(participant.globalDb, id), observed.home)) throw new MoveAdapterError("move-rollback-proof-missing");
    const stopped = await participant.withBothLocks(id, async () => {
      if ((await participant.probe(id)).kind !== "absent") throw new MoveAdapterError("move-rollback-proof-missing");
      return participant.retireFailed(home, operation);
    });
    const retired = await participant.observation(home, operation);
    if (stopped.kind !== "absent" || retired.owner.kind !== "absent" || !retired.retired || retired.activationCancelled !== true) throw new MoveAdapterError("move-rollback-proof-missing");
    return result(stopped);
  }
  if (operation.kind === "move-export" || operation.kind === "move-import") {
    const parent = operation.args.parent as unknown as Operation;
    if (!parent || parent.id !== operation.args.moveId || parent.machineId !== participant.config.hubMachineId || parent.args.sessionId !== id) throw new MoveAdapterError("move-request-invalid");
    journal.begin(parent);
  }
  if (operation.kind === "move-export") {
    const check = operation.args.check as unknown as MoveCheck, stage = operation.args.stage as "pre" | "final", ack = operation.args.ack as unknown as FreezeAck | null;
    const writers = await participant.writers(check.sourceRoot);
    if (writers.length) throw new MoveError("move-preflight-blocked", writers.map(row => validateBlockerId(row.id)));
    const git = gitPorts(participant, journal), local = location(participant.globalDb, id);
    const session = await inspectSession(local.file, id, ack?.leaf, participant.config.limits);
    if (ack && (session.size !== ack.size || session.sha256 !== ack.sha256 || session.file !== ack.file)) throw new MoveAdapterError("move-freeze-invalid");
    const snapshot = await snapshotWorkspace({ root: check.sourceRoot, cwd: local.cwd, repoKey: check.repoKey, workspaceId: check.workspaceId, moveId: String(operation.args.moveId), stage, writers }, git);
    const workspace = await bundleWorkspace(snapshot, operation.args.prerequisites as string[], git);
    if (workspace.bundle.kind !== "ready") throw new MoveAdapterError("workspace-unbundled");
    const root = join(required(bindings.root, "root"), "roam", "staging"), file = assembleOutgoing(git.scratch, workspace.bundle.artifactId, participant.config.machineId, participant.config.limits);
    const workspaceArtifact = await stageArtifact(file, "workspace", participant.config.limits, { root, artifactId: workspace.bundle.artifactId });
    const sessionArtifact = await stageArtifact(session.file, "session", participant.config.limits, { root, artifactId: `${operation.args.moveId}-session` });
    persistExportedSnapshot(participant.globalDb, workspace);
    return result({ workspace, session, workspaceArtifact, sessionArtifact });
  }
  if (operation.kind === "move-import") {
    const exported = operation.args.exported as unknown as MoveExport, check = operation.args.check as unknown as MoveCheck;
    const root = join(required(bindings.root, "root"), "roam", "staging"), claims = operation.args.claims as unknown as MoveArtifactClaim[];
    const ports = createMoveWorkspacePorts(participant.globalDb, gitPorts(participant, journal), root, claims);
    journal.record(exported.workspace.moveId, "move-import-intent", { root: check.destinationRoot, exported: json(exported), claims: json(claims) });
    const sessionRow = journal.read(exported.workspace.moveId).find(row => row.action === "workspace-session");
    if (sessionRow && sessionRow.result.sessionId !== id) throw new MoveAdapterError("workspace-session-mismatch");
    if (!sessionRow) journal.record(exported.workspace.moveId, "workspace-session", { sessionId: id });
    const workspace = await participant.withBothLocks(id, () => prepareWorkspace(exported.workspace, check.destinationRoot, ports));
    const sourceFile = await ports.verifiedArtifactPath(exported.sessionArtifact.id);
    if (!sourceFile) throw new MoveAdapterError("session-artifact-missing");
    const source = { ...exported.session, file: sourceFile }; await verifyFrozenSession(source, participant.config.limits);
    const session = await stageSession({ source, destinationCwd: check.destinationCwd, destinationParent: null, limits: participant.config.limits,
      segment: { version: 1, moveId: String(operation.args.moveId), epoch: home.epoch, previousMachine: check.source.machineId, nextMachine: home.machineId, historyMachine: await sessionHistoryOrigin(source, check.source.machineId, participant.config.limits), parentRef: null } }, join(required(bindings.root, "root"), "roam", "staging"));
    const target = await participant.sessionTarget(id, String(operation.args.moveId));
    await installSession(session, target, { journal, limits: participant.config.limits, withBothLocks: participant.withBothLocks, ownership: () => participant.probe(id) });
    const installed = { ...session, file: target };
    recordLocation(participant.globalDb, { sessionId: id, stores: check.storeKeys, home: sessionHome(participant.globalDb, id) === "unknown" ? null : sessionHome(participant.globalDb, id) as Home | null, file: target, cwd: check.destinationCwd });
    return result({ workspace, session: installed });
  }
  if (operation.kind === "move-verify") {
    const ack = operation.args.ack as unknown as FreezeAck, snapshot = operation.args.workspace as unknown as WorkspaceSnapshot;
    const session = await inspectSession(ack.file, ack.sessionId, ack.leaf, participant.config.limits);
    if (session.size !== ack.size || session.sha256 !== ack.sha256 || session.cwd !== ack.cwd) throw new MoveAdapterError("move-freeze-invalid");
    await verifyFrozenSession(session, participant.config.limits);
    const observed = await snapshotWorkspace({ root: snapshot.root, cwd: ack.cwd, repoKey: snapshot.repoKey, workspaceId: snapshot.workspaceId, moveId: snapshot.moveId,
      stage: snapshot.stage, writers: await participant.writers(snapshot.root) }, gitPorts(participant, journal));
    if (observed.head !== snapshot.head || observed.indexTree !== snapshot.indexTree || observed.workingTree !== snapshot.workingTree) throw new MoveAdapterError("workspace-source-changed");
    return result({});
  }
  if (operation.kind === "move-readmit") return await readmit(operation, journal, bindings) as unknown as Outcome<JsonObject>;
  if (operation.kind === "move-cleanup-terminal") {
    const check = operation.args.check as unknown as MoveCheck, proof = operation.args.proof as unknown as MoveCleanupProof;
    const successor = operation.args.presentationMoveId;
    const valid = () => (successor === undefined || typeof successor === "string" && !!successor) &&
      validCleanupProof(proof, check, String(operation.args.moveId), participant.globalDb, typeof successor === "string" ? successor : undefined) &&
      participant.config.machineId === check.source.machineId && operation.expectedEpoch === check.source.epoch;
    if (!valid()) throw new MoveAdapterError("move-cleanup-unproved");
    await verifyPresentation(operation, journal, bindings);
    await participant.withBothLocks(id, async locks => {
      if (!valid()) throw new MoveAdapterError("move-cleanup-unproved");
      await verifyPresentation(operation, journal, bindings);
      await participant.cleanupTerminal(operation, locks);
    });
    return result({});
  }
  if (operation.kind === "move-abort-workspace") {
    const check = operation.args.check as unknown as MoveCheck, proof = operation.args.proof as unknown as AbortedWorkspaceProof, root = String(operation.args.root), moveId = String(operation.args.moveId);
    const source = participant.config.machineId === check?.source?.machineId;
    const valid = () => validAbortedWorkspaceProof(proof, check, moveId, participant.globalDb) && operation.expectedEpoch === (source ? proof.home.epoch : check.source.epoch + 1);
    if (!valid()) throw new MoveAdapterError("move-cleanup-unproved");
    const mapped = participant.globalDb.prepare("SELECT path FROM roam_workspace_maps WHERE repo_key=? AND workspace_id=?").get(check.repoKey, check.workspaceId) as { path: string } | undefined;
    if (!mapped || mapped.path !== root || root !== (source ? check.sourceRoot : check.destinationRoot) || !source && participant.config.machineId !== check.destinationMachine) throw new MoveAdapterError("workspace-cleanup-unproved");
    const prior = journal.begin(operation);
    if (prior.kind === "done") return result(prior.result);
    // The original move receipt is immutable. Keep its evidence visible, but put retry checkpoints in this independent cleanup operation.
    const cleanupJournal: Journal = { ...journal,
      begin: value => value.id === moveId ? { kind: "pending", result: null } : journal.begin(value),
      read: id => id === moveId ? [...journal.read(moveId).filter(row => row.action !== "done"), ...journal.read(operation.id)] : journal.read(id),
      record: (id, action, value) => journal.record(id === moveId ? operation.id : id, action, value),
      lookupOperation: id => journal.lookupOperation?.(id === moveId ? operation.id : id) ?? null,
    };
    const effect = async () => {
      if (!valid()) throw new MoveAdapterError("move-cleanup-unproved");
      const git = gitPorts(participant, cleanupJournal), ports = createMoveWorkspacePorts(participant.globalDb, git, join(participant.root, "roam", "staging"), []);
      if (!source) {
        if ((await participant.probe(id)).kind !== "absent") throw new MoveAdapterError("participant-owner-uncertain");
        const rows = cleanupJournal.read(moveId), prepared = rows.filter(row => row.action === "workspace-prepared" && row.result.root === root).at(-1)?.result;
        const importing = rows.filter(row => row.action === "move-import-intent" && row.result.root === root).at(-1)?.result;
        let workspace: import("./contracts").PreparedWorkspace | null = prepared ? { root, snapshot: JSON.parse(String(prepared.snapshotJson)) as WorkspaceSnapshot,
          previous: prepared.previousJson === null ? null : JSON.parse(String(prepared.previousJson)) as WorkspaceSnapshot, moveId, adjustments: [] } : null;
        const exported = importing?.exported as unknown as MoveExport | undefined;
        if (exported && (!workspace || workspace.snapshot.stage !== exported.workspace.stage)) {
          const claims = importing!.claims as unknown as MoveArtifactClaim[];
          workspace = await prepareWorkspace(exported.workspace, root, createMoveWorkspacePorts(participant.globalDb, git, join(participant.root, "roam", "staging"), claims));
        }
        if (workspace) {
          await abortWorkspace(workspace, ports);
          persistExportedSnapshot(participant.globalDb, { ...(workspace.previous ?? workspace.snapshot), root });
        }
        await abortInstalledSession(moveId, id, participant, cleanupJournal, valid);
      }
      const preparedHere = source || cleanupJournal.read(moveId).some(row => ["workspace-prepared", "move-import-intent"].includes(row.action) && row.result.root === root);
      if (preparedHere) {
        const refs = await cleanupMoveRefs(root, moveId, git, valid);
        if (refs.leftovers.length) {
          cleanupJournal.record(moveId, "move-cleanup-leftovers", json({ machineId: participant.config.machineId, leftovers: refs.leftovers }));
          throw new MoveAdapterError(refs.leftovers[0].reason);
        }
      }
      await cleanupMoveStaging(moveId, check, valid, participant, cleanupJournal, true);
      cleanupJournal.record(moveId, "workspace-abort-cleanup-complete", { root });
    };
    if (source) await effect(); else await participant.withBothLocks(id, effect);
    journal.record(operation.id, "done", {});
    return result({});
  }
  if (operation.kind === "move-cleanup") {
    const root = String(operation.args.root), check = operation.args.check as unknown as MoveCheck, proof = operation.args.proof as unknown as MoveCleanupProof;
    const moveId = String(operation.args.moveId), git = gitPorts(participant, journal);
    if (!validCleanupProof(proof, check, moveId, participant.globalDb)) throw new MoveAdapterError("move-cleanup-unproved");
    const mapped = participant.globalDb.prepare("SELECT path FROM roam_workspace_maps WHERE repo_key=? AND workspace_id=?").get(check.repoKey, check.workspaceId) as { path: string } | undefined;
    const source = participant.config.machineId === check.source.machineId;
    if (!mapped || mapped.path !== root || root !== (source ? check.sourceRoot : check.destinationRoot) || operation.expectedEpoch !== (source ? check.source.epoch : proof.destination.home.epoch)) throw new MoveAdapterError("workspace-cleanup-unproved");
    const clean = async (locks?: import("./session-control").HeldSessionLocks) => {
      if (!validCleanupProof(proof, check, moveId, participant.globalDb)) throw new MoveAdapterError("move-cleanup-unproved");
      const refs = await cleanupMoveRefs(root, moveId, git, () => validCleanupProof(proof, check, moveId, participant.globalDb));
      if (refs.leftovers.length) journal.record(moveId, "move-cleanup-leftovers", json({ machineId: participant.config.machineId, leftovers: refs.leftovers }));
      await cleanupMoveStaging(moveId, check, () => validCleanupProof(proof, check, moveId, participant.globalDb), participant, journal);
      if (source && operation.args.presentation && (operation.args.presentation as JsonObject).status === "complete") {
        await verifyPresentation(operation, journal, bindings);
        await participant.cleanupTerminal(operation, locks);
      }
    };
    if (source) await participant.withBothLocks(id, clean);
    else await clean();
    return result({ warnings: journal.read(moveId).filter(row => row.action === "move-cleanup-leftovers").flatMap(row => (row.result.leftovers as JsonObject[]).map(item => `${item.reason}:${item.ref}`)) });
  }
  if (operation.kind === "move-restore") {
    const mirror = operation.args.mirror as unknown as SessionManifest, current = requiredHome(participant.globalDb, id), restore = required(bindings.recovery, "recovery");
    await verifyFrozenSession(mirror, participant.config.limits);
    const workspace = await restore.restoreWorkspace(current, mirror, operation);
    if (!workspace) return { code: 3, reason: "recovery-workspace-unavailable", operationId: operation.id, home: current, epoch: current.epoch, repairCommand: "spider roam doctor", value: null };
    const receipt = journal.read(String(current.moveId)).find(row => row.action === "forget-home")?.result as unknown as { source: Home; home: Home } | undefined;
    if (!receipt || !sameHome(receipt.home, current) || receipt.source.machineId !== operation.args.previousMachine || receipt.source.epoch + 1 !== current.epoch || !isRevoked(required(bindings.privateDb, "privateDb"), receipt.source.machineId)) throw new MoveAdapterError("recovery-home-changed");
    const previous = receipt.source;
    const staged = await stageSession({ source: mirror, destinationCwd: workspace.cwd, destinationParent: workspace.parent,
      segment: { version: 1, moveId: String(current.moveId), epoch: current.epoch, previousMachine: previous.machineId, nextMachine: current.machineId, historyMachine: await sessionHistoryOrigin(mirror, previous.machineId, participant.config.limits), parentRef: null } }, join(required(bindings.root, "root"), "roam", "staging"));
    const target = await participant.sessionTarget(id, String(current.moveId));
    await installSession(staged, target, { journal, withBothLocks: participant.withBothLocks, ownership: () => participant.probe(id) });
    await inspectRestoredSession(target, mirror, previous, current, participant.config.limits);
    const local = location(participant.globalDb, id);
    const mappings = participant.globalDb.prepare("SELECT repo_key,workspace_id,path FROM roam_workspace_maps").all() as { repo_key: string; workspace_id: string; path: string }[];
    const mapped = mappings.filter(row => local.stores.includes(`worktree:${row.repo_key}:${row.workspace_id}` as StoreKey) && withinRoot(row.path, workspace.cwd));
    if (mapped.length !== 1) throw new MoveAdapterError("workspace-repository-unmapped");
    const mapping = mapped[0];
    const snapshot = await snapshotWorkspace({ root: mapping.path, cwd: workspace.cwd, repoKey: mapping.repo_key, workspaceId: mapping.workspace_id, moveId: String(current.moveId), stage: "final", writers: await participant.writers(mapping.path) }, gitPorts(participant, journal));
    recordLocation(participant.globalDb, { sessionId: id, stores: local.stores, home: current, file: target, cwd: workspace.cwd });
    return await activatePrepared(operation, { workspace: { root: mapping.path, snapshot, previous: null, moveId: String(current.moveId), adjustments: [] }, session: { ...staged, file: target } }, participant, journal) as unknown as Outcome<JsonObject>;
  }
  throw new MoveAdapterError("adapter-unbound:participant-operation");
}

async function participantLaunch(operation: Operation, home: Home, participant: MoveParticipantBindings, journal: Journal): Promise<ParticipantReadinessQuery> {
  const prior = journal.read(operation.id).find(row => row.action === "participant-launch")?.result as unknown as ParticipantReadinessQuery | undefined;
  if (prior) {
    if (prior.sessionId !== home.sessionId || prior.epoch !== home.epoch || !prior.launchId || prior.launchId === operation.id) throw new MoveAdapterError("participant-launch-mismatch");
    return prior;
  }
  const result = await participant.wake({ sessionId: home.sessionId, operationId: operation.id });
  if (!result.ok) throw new MoveAdapterError(result.reason);
  if (!result.launchId || result.launchId === operation.id) throw new MoveAdapterError("participant-launch-mismatch");
  const query = { sessionId: home.sessionId, launchId: result.launchId, epoch: home.epoch };
  journal.record(operation.id, "participant-launch", json(query));
  return query;
}
async function participantReady(operation: Operation, home: Home, participant: MoveParticipantBindings, journal: Journal): Promise<HubOperationReadiness | null> {
  const query = await participantLaunch(operation, home, participant, journal), ready = await participant.readiness(query);
  if (!ready) return null;
  if (ready.opId !== query.launchId || ready.sessionId !== query.sessionId || ready.epoch !== query.epoch) throw new MoveAdapterError("participant-readiness-invalid");
  return { ...ready, opId: operation.id };
}
async function activatePrepared(operation: Operation, prepared: PreparedMove, participant: MoveParticipantBindings, journal: Journal): Promise<Outcome<HubOperationReadiness>> {
  const home = requiredHome(participant.globalDb, operation.args.sessionId as string), authority = createRunningIntentAuthority(participant.globalDb);
  const localAuthority = participant.config.role === "hub" && participant.config.machineId === participant.config.hubMachineId;
  if (!localAuthority && (participant.config.role !== "box" || participant.config.machineId === participant.config.hubMachineId)) throw new MoveAdapterError("participant-config-unavailable");
  if (home.machineId !== participant.config.machineId || home.epoch !== operation.expectedEpoch || !await participant.identityCurrent()) throw new MoveAdapterError("participant-home-mismatch");
  const manifest = prepared.session;
  if (localAuthority && (home.moveId !== operation.args.moveId || location(participant.globalDb, home.sessionId).file !== manifest.file)) throw new MoveAdapterError("participant-file-mismatch");
  const exact = await inspectSession(manifest.file, home.sessionId, manifest.leaf, participant.config.limits);
  if (exact.cwd !== manifest.cwd || exact.sha256 !== manifest.sha256 || exact.size !== manifest.size || !isAbsolute(prepared.workspace.root) || relative(prepared.workspace.root, manifest.cwd).startsWith("..")) throw new MoveAdapterError("participant-file-mismatch");
  const launchPending = !participant.config.enabled && operation.kind === "move-restore";
  if (!participant.config.enabled && !launchPending) throw new MoveAdapterError("roaming-disabled");
  if (!launchPending && (await participant.auth()).some(row => row.severity === "block")) throw new MoveAdapterError("participant-auth-unavailable");
  const intent = { sessionId: home.sessionId, epoch: home.epoch, desired: "running" as const, suspended: null, file: manifest.file, cwd: manifest.cwd, moveId: home.moveId };
  const started = await startParticipant({ ...operation, kind: "session-start" }, home, intent, { journal, machineId: participant.config.machineId, hubMachineId: participant.config.hubMachineId,
    identityCurrent: participant.identityCurrent,
    wake: async () => { if (!launchPending) await participantLaunch(operation, home, participant, journal); },
    readiness: async () => launchPending ? null : participantReady(operation, home, participant, journal),
    async activate() {
      if ((await participant.probe(home.sessionId)).kind !== "absent") throw new MoveAdapterError("participant-owner-uncertain");
      await participant.withBothLocks(home.sessionId, async () => {
        if ((await participant.probe(home.sessionId)).kind !== "absent" || !sameHome(sessionHome(participant.globalDb, home.sessionId), home)) throw new MoveAdapterError("participant-owner-uncertain");
        await verifyWorkspace(prepared.workspace, createMoveWorkspacePorts(participant.globalDb, gitPorts(participant, journal), join(participant.root, "roam", "staging"), []));
        const atLaunch = await inspectSession(manifest.file, home.sessionId, manifest.leaf, participant.config.limits);
        if (atLaunch.sha256 !== manifest.sha256 || atLaunch.size !== manifest.size || atLaunch.cwd !== manifest.cwd) throw new MoveAdapterError("participant-file-mismatch");
        if (!sameHome(sessionHome(participant.globalDb, home.sessionId), home) || !await participant.identityCurrent()) throw new MoveAdapterError("participant-home-mismatch");
        journal.record(operation.id, "participant-file-verified", json(atLaunch));
        for (const { key, db } of participant.stores) if (storeScope(key) === "worktree") db.raw.transaction(() => {
          const state = db.prepare("SELECT state,epoch FROM roam_sessions WHERE session_id=?").get(home.sessionId) as { state: string; epoch: number } | undefined;
          if (!state || state.state === "frozen" || state.epoch > home.epoch) throw new MoveAdapterError("participant-store-mismatch");
          db.prepare("UPDATE roam_sessions SET state='active',epoch=?,move_id=?,freeze_seq=NULL WHERE session_id=?").run(home.epoch, home.moveId, home.sessionId);
        }).immediate();
        persistExportedSnapshot(participant.globalDb, { ...prepared.workspace.snapshot, root: prepared.workspace.root });
        await authority.set(intent, operation.id, participant.config.role === "hub" && participant.config.machineId === participant.config.hubMachineId
          ? undefined : { machineId: participant.config.machineId, hubMachineId: participant.config.hubMachineId });
      });
    },
  }).catch((error: unknown): Outcome<HubOperationReadiness> => {
    if (!(error instanceof MoveAdapterError) || error.code !== "participant-launch-conflict") throw error;
    return { code: 1, reason: error.code, operationId: operation.id, home, epoch: home.epoch, repairCommand: null, value: null };
  });
  if (!launchPending || started.code !== 3 || started.reason !== "readiness-pending") return started;
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const repairCommand = `cd ${quote(manifest.cwd)} && ${quote(participant.pi ?? "pi")} --session ${quote(manifest.file)}`;
  if (!journal.read(operation.id).some(row => row.action === "recovery-launch-pending")) journal.record(operation.id, "recovery-launch-pending", json({ home, file: manifest.file, cwd: manifest.cwd, repairCommand }));
  return { ...started, code: 3, reason: "recovery-launch-pending", home, epoch: home.epoch, repairCommand, value: null };
}
function homeReceipt(db: Db, moveId: string): Home | null {
  const row = db.prepare("SELECT cancelled,committed_home_json FROM roam_home_actions WHERE move_id=?").get(moveId) as { cancelled: number; committed_home_json: string | null } | undefined;
  return row && row.cancelled === 0 && row.committed_home_json ? JSON.parse(row.committed_home_json) as Home : null;
}
/** Read only on the hub. Box composition injects an authenticated call to this entry point. */
export function readRollbackEvidence(db: Db, journal: Journal, operation: Operation): RollbackEvidence | null {
  try {
    const moveId = String(operation.args.moveId), sessionId = String(operation.args.sessionId), rows = journal.read(moveId);
    const currentHome = requiredHome(db, sessionId), forwardReceipt = homeReceipt(db, moveId), rollbackReceipt = homeReceipt(db, rollbackMoveId(moveId));
    const retirement = rows.find(row => row.action === "move-rollback-retired")?.result as unknown as DestinationObservation | undefined;
    const freeze = rows.find(row => row.action === "move-action-complete" && row.result.action === "freeze")?.result.value as unknown as FreezeAck | undefined;
    const check = rows.find(row => row.action === "move-action-complete" && row.result.action === "check")?.result.value as unknown as MoveCheck | undefined;
    return forwardReceipt && rollbackReceipt && retirement && freeze && check ? structuredClone({ currentHome, forwardReceipt, rollbackReceipt, retirement, freeze, check }) : null;
  } catch { return null; }
}
export function validRollbackProof(proof: RollbackEvidence, source: Home, restored: Home, moveId: string, fence: IntercomIntakeFence | null, address: SessionAddress): boolean {
  const { currentHome, forwardReceipt: committed, rollbackReceipt: receipt, retirement, freeze: frozen, check } = proof;
  return sameHome(currentHome, restored) && sameHome(receipt, restored) &&
    restored.machineId === source.machineId && restored.epoch === source.epoch + 2 && restored.moveId === rollbackMoveId(moveId) &&
    committed.sessionId === source.sessionId && committed.machineId !== source.machineId && committed.epoch === source.epoch + 1 && committed.moveId === moveId &&
    sameHome(retirement.home, committed) && retirement.owner.kind === "absent" && retirement.readiness === null && retirement.retired === true && retirement.activationCancelled === true &&
    frozen.sessionId === source.sessionId && frozen.epoch === source.epoch && sameHome(check.source, source) && check.sourceFile === frozen.file &&
    !!fence && fence.moveId === moveId && fence.expectedEpoch === source.epoch && sameAddress(fence.address, address) && fence.address.sessionId === source.sessionId && fence.generation === frozen.intercomGeneration;
}
async function readmit(operation: Operation, journal: Journal, bindings: MoveAdapterBindings): Promise<MoveSessionOutcome> {
  const source = operation.args.source as unknown as Home, restored = operation.args.restoredHome as unknown as Home, participant = required(bindings.participant, "participant");
  const refusal = (blockers: string[] = []): MoveSessionOutcome => ({ code: 3, ok: false, reason: "move-rollback-proof-missing", operationId: operation.id, home: restored, epoch: restored.epoch, repairCommand: null, value: null,
    refusal: { code: "move-rollback-proof-missing", blockers: blockers.map(validateBlockerId), message: "Rollback readmission proof is missing." } });
  try {
    const moveId = String(operation.args.moveId), intercom = required(bindings.intercom, "intercom"), rollback = required(intercom.rollback, "intercom.rollback");
    const readProof = required(bindings.evidence?.rollback, "evidence.rollback");
    if (!sameHome(sessionHome(participant.globalDb, source.sessionId), restored) || !await participant.identityCurrent()) return refusal();
    const prior = journal.begin(operation);
    if (prior.kind === "done") return prior.result as unknown as MoveSessionOutcome;
    const proof = await readProof(operation), fence = await rollback.currentFence(source.sessionId, moveId);
    if (!proof || !validRollbackProof(proof, source, restored, moveId, fence, intercom.address) || operation.expectedEpoch !== restored.epoch ||
        !sameHome(sessionHome(participant.globalDb, source.sessionId), restored) || !await participant.identityCurrent()) return refusal();
    const frozen = proof.freeze;
    const validReady = (value: HubOperationReadiness | null | undefined, launchId: string): value is HubOperationReadiness => {
      if (!value) return false;
      const ready = parseParticipantReadiness(value);
      return ready.file === frozen.file && ready.cwd === frozen.cwd && ready.sessionId === source.sessionId && ready.epoch === restored.epoch && ready.opId === launchId;
    };
    const currentProof = async () => {
      const current = await readProof(operation), currentFence = await rollback.currentFence(source.sessionId, moveId);
      if (!current || !validRollbackProof(current, source, restored, moveId, currentFence, intercom.address) || !isDeepStrictEqual(currentFence, fence) || !await participant.identityCurrent() || !sameHome(sessionHome(participant.globalDb, source.sessionId), restored)) throw new MoveAdapterError("move-rollback-proof-missing");
      return current;
    };
    const verifyOriginal = async () => {
      const original = await inspectSession(frozen.file, source.sessionId, frozen.leaf, participant.config.limits);
      if (original.size !== frozen.size || original.sha256 !== frozen.sha256 || original.cwd !== frozen.cwd) throw new MoveAdapterError("participant-file-mismatch");
    };
    let rows = journal.read(operation.id), cached = rows.find(row => row.action === "readmit-ready")?.result as unknown as HubOperationReadiness | undefined;
    let prepared = rows.some(row => row.action === "readmit-prepared"), owner = await participant.probe(source.sessionId);
    const originalOwner = (value: Probe) => value.kind === "live" && !!frozen.owner && isDeepStrictEqual(value.identity, frozen.owner);
    if (owner.kind === "uncertain") return refusal(["participant-owner-uncertain"]);
    if (!prepared) {
      if (owner.kind === "live" && !originalOwner(owner)) return refusal(["participant-owner-uncertain"]);
      const prepare = async () => {
        await currentProof(); await verifyOriginal();
        owner = await participant.probe(source.sessionId);
        if (owner.kind !== "absent" && !originalOwner(owner)) throw new MoveAdapterError("participant-owner-uncertain");
        advanceMembership(participant, source, restored, moveId);
        const authority = createRunningIntentAuthority(participant.globalDb);
        const intent = { sessionId: source.sessionId, epoch: restored.epoch, desired: "running" as const, suspended: null, file: frozen.file, cwd: frozen.cwd, moveId: restored.moveId };
        await authority.set(intent, operation.id, participant.config.role === "hub" && participant.config.machineId === participant.config.hubMachineId
          ? undefined : { machineId: participant.config.machineId, hubMachineId: participant.config.hubMachineId });
        journal.record(operation.id, "readmit-prepared", { file: frozen.file, epoch: restored.epoch }); prepared = true;
      };
      if (owner.kind === "absent") await participant.withBothLocks(source.sessionId, prepare); else await prepare();
    }
    await currentProof(); await verifyOriginal();
    rows = journal.read(operation.id);
    let launchId = rows.find(row => row.action === "readmit-launch")?.result.launchId;
    if (!cached) {
      if (originalOwner(owner) && launchId === undefined) {
        cached = await participant.readmitLive(restored, operation, frozen.file) ?? undefined;
        if (!validReady(cached, operation.id)) throw new MoveAdapterError("readiness-pending");
      } else {
        // Ownership locks have been released. Wake is idempotent even if its first reply was lost.
        if (launchId === undefined) {
          const launched = await participant.wake({ sessionId: source.sessionId, operationId: operation.id });
          if (!launched.ok) throw new MoveAdapterError(launched.reason);
          if (!launched.launchId || launched.launchId === operation.id) throw new MoveAdapterError("participant-launch-invalid");
          launchId = launched.launchId;
          journal.record(operation.id, "readmit-launch", { launchId });
        }
        if (typeof launchId !== "string") throw new MoveAdapterError("participant-launch-invalid");
        cached = await participant.readiness({ sessionId: source.sessionId, launchId, epoch: restored.epoch }) ?? undefined;
        if (!validReady(cached, launchId)) throw new MoveAdapterError("readiness-pending");
      }
      journal.record(operation.id, "readmit-ready", json(cached));
    } else if (typeof launchId === "string") {
      const observed = await participant.readiness({ sessionId: source.sessionId, launchId, epoch: restored.epoch });
      if (!validReady(observed, launchId) || !isDeepStrictEqual(observed, cached)) throw new MoveAdapterError("readiness-pending");
    } else if (!originalOwner(await participant.probe(source.sessionId)) || !validReady(cached, operation.id)) throw new MoveAdapterError("participant-owner-uncertain");
    const current = await currentProof();
    await rollback.reopen(fence!, restored, current.rollbackReceipt);
    const outcome: MoveSessionOutcome = { code: 0, ok: true, reason: "rollback-readmitted", operationId: operation.id, home: restored, epoch: restored.epoch, repairCommand: null,
      value: { home: restored, terminal: cached.terminal, intercomAddress: source.sessionId, warnings: [] } };
    journal.record(operation.id, "done", json(outcome)); return outcome;
  } catch (error) { return refusal(error instanceof MoveAdapterError ? [error.code] : []); }
}
/** One attached-database transaction advances the whole affected membership roster before admission opens. */
export function advanceMembership(participant: Pick<MoveParticipantBindings, "stores">, source: Home, restored: Home, moveId: string): void {
  const stores = participant.stores.filter(row => storeScope(row.key) === "worktree");
  if (!stores.length) throw new MoveAdapterError("participant-stores-unavailable");
  const coordinator = stores[0].db, aliases = stores.map((row, index) => index === 0 ? "main" : `member_${index}`);
  const attached: string[] = [];
  try {
    for (let index = 1; index < stores.length; index++) { coordinator.prepare(`ATTACH DATABASE ? AS ${aliases[index]}`).run(stores[index].db.raw.name); attached.push(aliases[index]); }
    coordinator.raw.transaction(() => {
      for (const alias of aliases) {
        const state = coordinator.prepare(`SELECT state,epoch,move_id FROM ${alias}.roam_sessions WHERE session_id=?`).get(source.sessionId) as { state: string; epoch: number; move_id: string | null } | undefined;
        if (!state || !(state.epoch === source.epoch && state.state === "frozen" && state.move_id === moveId || state.epoch === restored.epoch && state.move_id === restored.moveId)) throw new MoveAdapterError("participant-store-mismatch");
      }
      for (const alias of aliases) coordinator.prepare(`UPDATE ${alias}.roam_sessions SET epoch=?,state='active',move_id=?,freeze_seq=NULL WHERE session_id=?`).run(restored.epoch, restored.moveId, source.sessionId);
    }).immediate();
  } finally { for (const alias of attached.reverse()) coordinator.exec(`DETACH DATABASE ${alias}`); }
}
/** Await before publishing controls. Restore recovery runs even when the move operation list is empty. */
export async function recoverMoveAdapters(ports: MovePorts, bindings: MoveAdapterBindings): Promise<readonly MoveSessionOutcome[]> {
  required(bindings.recovery?.workspaceRestores, "recovery.workspaceRestores");
  const privateDb = required(bindings.privateDb, "privateDb");
  const revoked = privateDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='roam_machine_revocations'").get()
    ? (privateDb.prepare("SELECT machine_id FROM roam_machine_revocations").all() as { machine_id: string }[]).map(row => row.machine_id) : [];
  for (const machineId of revoked) await forgetMachineWithAdapters({ machineId, confirmation: `destroyed ${machineId}` }, ports);
  const ids = new Set((privateDb.prepare("SELECT operation_id FROM roam_operations WHERE kind='move' AND result_json IS NULL").all() as { operation_id: string }[]).map(row => row.operation_id));
  const slots = privateDb.prepare("SELECT operation_id FROM roam_operations WHERE kind='move-session'").all() as { operation_id: string }[];
  for (const slot of slots) {
    let active: string | null = null;
    for (const row of ports.journal.read(slot.operation_id)) {
      if (row.action === "reserved") active = String(row.result.moveId);
      if (row.action === "released" && row.result.moveId === active) active = null;
    }
    if (active) ids.add(active);
  }
  const pending = privateDb.prepare("SELECT operation_id FROM roam_operations WHERE kind='move-presentation' AND result_json IS NULL").all() as { operation_id: string }[];
  const results = await recoverIncompleteMoves([...ids], ports);
  for (const row of pending) {
    const request = ports.journal.read(row.operation_id).find(item => item.action === "source-view-request")?.result.operation as JsonObject | undefined;
    if (!request) continue;
    try { await recoverMovePresentation(ports, String(request.id)); } catch { /* The durable task retries after presentation or source reconnects. */ }
  }
  return results;
}

export interface MoveArtifactClaim { artifactId: string; peer: string; operationId: string; sha256: string }
/** Repository and baseline authority comes only from the local global catalog. */
export function createMoveWorkspacePorts(globalDb: Db, git: GitPorts, stagingRoot: string, claims: readonly MoveArtifactClaim[]): WorkspaceImportPorts {
  return {
    ...git,
    async resolveCommonRepository(mapping) {
      const repo = globalDb.prepare("SELECT path FROM roam_repo_maps WHERE repo_key=?").get(mapping.repoKey) as { path: string } | undefined;
      const workspace = globalDb.prepare("SELECT path FROM roam_workspace_maps WHERE repo_key=? AND workspace_id=?").get(mapping.repoKey, mapping.workspaceId) as { path: string } | undefined;
      if (!repo || !workspace || !isAbsolute(repo.path) || !isAbsolute(workspace.path) || resolve(workspace.path) !== resolve(mapping.destination)) return null;
      const common = (await git.run(repo.path, ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"])).toString().trim();
      if (!isAbsolute(common)) throw new MoveAdapterError("workspace-repository-unavailable");
      realpathSync(common);
      return realpathSync(repo.path);
    },
    async lastExportedSnapshot(checkout) {
      const row = globalDb.prepare("SELECT path,snapshot_json FROM roam_workspace_maps WHERE repo_key=? AND workspace_id=?").get(checkout.repoKey, checkout.workspaceId) as { path: string; snapshot_json: string | null } | undefined;
      if (!row || row.path !== checkout.root || row.snapshot_json === null) return null;
      try {
        const snapshot = JSON.parse(row.snapshot_json) as WorkspaceSnapshot;
        if (snapshot.repoKey !== checkout.repoKey || snapshot.workspaceId !== checkout.workspaceId || snapshot.root !== checkout.root || !snapshot.head || !snapshot.indexTree || !snapshot.workingTree) throw new Error("Invalid snapshot");
        return snapshot;
      } catch { throw new MoveAdapterError("workspace-baseline-invalid"); }
    },
    async verifiedArtifactPath(artifactId) {
      const matches = claims.filter(claim => claim.artifactId === artifactId);
      if (!matches.length) return null;
      if (matches.length !== 1) throw new MoveAdapterError("workspace-artifact-unavailable");
      const claim = matches[0]; let store: ReturnType<typeof openStaging> | undefined;
      try {
        store = openStaging(stagingRoot, claim.peer, git.limits);
        const manifest = store.manifestFor(claim.operationId);
        if (manifest.id !== artifactId || manifest.sha256 !== claim.sha256) throw new Error("Wrong artifact claim");
        validateManifest(manifest, git.limits);
        return store.assemble(manifest);
      } catch { throw new MoveAdapterError("workspace-artifact-unavailable"); }
      finally { store?.close(); }
    },
  };
}

function assembleOutgoing(root: string, artifactId: string, machine: string, limits: RoamConfig["limits"]): string {
  const outgoing = openOutgoingStaging(root, limits, false), incoming = openStaging(root, machine, limits);
  try {
    const manifest = outgoing.inspect(artifactId).current;
    if (!manifest) throw new MoveAdapterError("workspace-artifact-missing");
    incoming.declare(manifest, `local-${artifactId}`);
    for (const chunk of manifest.chunks) incoming.receive(manifest, chunk.index, readFileSync(sourceChunk(root, artifactId, chunk.index, chunk.sha256)));
    return incoming.assemble(manifest);
  } finally { outgoing.close(); incoming.close(); }
}

/** Higher-epoch release is separate from ordinary abort/ready and never bypasses their guards. */
export function createRollbackIntercomPorts(input: {
  journal: FreezeJournal; address: SessionAddress;
  proof(operation: Operation): Promise<RollbackEvidence | null>;
  broker: Pick<IntercomFederationClient, "intake">;
  bridge: Pick<IntercomBridge, "resumeIntake">;
}): NonNullable<MoveAdapterBindings["intercom"]>["rollback"] {
  return {
    async currentFence(sessionId, moveId) { return input.journal.readIntercomFence(sessionId, moveId); },
    async reopen(fence, home, receipt) {
      const original = input.journal.readIntercomFence(fence.address.sessionId, fence.moveId);
      if (!original || !sameAddress(original.address, fence.address) || original.expectedEpoch !== fence.expectedEpoch || original.generation !== fence.generation || original.moveId !== fence.moveId)
        throw new MoveAdapterError("move-rollback-proof-missing");
      const operation: Operation = { id: receipt.moveId!, machineId: home.machineId, expectedEpoch: home.epoch, kind: "session-readmit", args: { sessionId: home.sessionId, moveId: fence.moveId } };
      const proof = await input.proof(operation);
      if (!proof || !sameHome(receipt, proof.rollbackReceipt) || !validRollbackProof(proof, proof.check.source, home, fence.moveId, original, input.address))
        throw new MoveAdapterError("move-rollback-proof-missing");
      // The broker atomically compares the original generation, including idempotent open retries.
      if (await input.broker.intake("open", original) !== original.generation) throw new MoveAdapterError("move-rollback-proof-missing");
      input.bridge.resumeIntake(original);
    },
  };
}

function persistExportedSnapshot(globalDb: Db, snapshot: WorkspaceSnapshot): void {
  const changed = globalDb.prepare("UPDATE roam_workspace_maps SET snapshot_json=? WHERE repo_key=? AND workspace_id=? AND path=?")
    .run(JSON.stringify(snapshot), snapshot.repoKey, snapshot.workspaceId, snapshot.root).changes;
  if (changed !== 1) throw new MoveAdapterError("workspace-repository-unmapped");
}

export type HubMoveEvidenceBindings = MoveEvidenceBindings & Required<Pick<MoveEvidenceBindings, "authorizeAbort" | "authorizeRetire" | "rollback">>;
type MoveAuthorityKind = "authorizeAbort" | "authorizeRetire" | "rollback" | "presentation";
function moveAuthorityKind(operation: Operation): MoveAuthorityKind | null {
  if (operation.kind === "session-unfreeze") return "authorizeAbort";
  if (["session-retire", "session-shutdown"].includes(operation.kind)) return "authorizeRetire";
  if (operation.kind === "move-readmit") return "rollback";
  if (["move-cleanup", "move-cleanup-terminal"].includes(operation.kind) && (operation.args.presentation as JsonObject | undefined)?.status === "complete") return "presentation";
  return null;
}
interface PushedMoveEvidence { operation: Operation; home: Home; kind: MoveAuthorityKind; value: JsonObject }
function acceptPushedMoveEvidence(operation: Operation, participant: MoveParticipantBindings): Operation {
  const { hubEvidence, ...args } = operation.args;
  if (hubEvidence === undefined) return operation;
  const clean = { ...operation, args }, evidence = hubEvidence as unknown as Omit<PushedMoveEvidence, "operation">;
  if (participant.config.role !== "box" || !evidence || evidence.kind !== moveAuthorityKind(clean) || !evidence.value ||
      typeof evidence.value !== "object" || !evidence.home || evidence.home.sessionId !== args.sessionId ||
      !sameHome(sessionHome(participant.globalDb, String(args.sessionId)), evidence.home)) throw new MoveAdapterError("hub-evidence-mismatch");
  writeLocal(participant.globalDb, "move-hub-evidence", operation.id, json({ ...evidence, operation: clean }));
  if (evidence.kind === "rollback") writeLocal(participant.globalDb, "move-hub-rollback", JSON.stringify([args.sessionId, evidence.home.moveId]), operation.id);
  return clean;
}
/** Evidence arrives on the authenticated hub-to-box operation and survives both processes restarting. */
export function createPushedMoveEvidencePorts(globalDb: Db, config: RoamConfig): Required<Pick<MoveEvidenceBindings, MoveAuthorityKind>> {
  const read = <T>(kind: MoveAuthorityKind, operation: Operation): T | null => {
    const saved = readLocal<PushedMoveEvidence>(globalDb, "move-hub-evidence", operation.id);
    return config.role === "box" && operation.machineId === config.machineId && operation.args.sourceMachine === config.hubMachineId &&
      saved?.kind === kind && isDeepStrictEqual(saved.operation, operation) && sameHome(sessionHome(globalDb, String(operation.args.sessionId)), saved.home)
      ? saved.value as T : null;
  };
  return { authorizeAbort: op => Promise.resolve(read("authorizeAbort", op)), authorizeRetire: op => Promise.resolve(read("authorizeRetire", op)),
    rollback: op => Promise.resolve(readIndexedRollbackEvidence(globalDb, config, op, "participant")), presentation: op => Promise.resolve(read("presentation", op)) };
}
/** The machine broker asks by committed rollback receipt, not the participant RPC's id. */
export async function readPushedRollbackEvidence(globalDb: Db, config: RoamConfig, operation: Operation): Promise<RollbackEvidence | null> {
  return readIndexedRollbackEvidence(globalDb, config, operation, "broker");
}
function readIndexedRollbackEvidence(globalDb: Db, config: RoamConfig, operation: Operation, caller: "participant" | "broker"): RollbackEvidence | null {
  const current = sessionHome(globalDb, String(operation.args.sessionId)), moveId = operation.args.moveId;
  if (config.role !== "box" || !["move-readmit", "session-readmit"].includes(operation.kind) || operation.machineId !== config.machineId || typeof moveId !== "string" ||
      !current || current === "unknown" || current.machineId !== config.machineId || current.epoch !== operation.expectedEpoch || current.moveId !== rollbackMoveId(moveId)) return null;
  const id = readLocal<string>(globalDb, "move-hub-rollback", JSON.stringify([current.sessionId, current.moveId]));
  const saved = id ? readLocal<PushedMoveEvidence>(globalDb, "move-hub-evidence", id) : undefined;
  if (!saved || saved.kind !== "rollback" || saved.operation.kind !== "move-readmit" || saved.operation.id !== id ||
      saved.operation.machineId !== config.machineId || saved.operation.expectedEpoch !== current.epoch || saved.operation.args.sourceMachine !== config.hubMachineId ||
      saved.operation.args.sessionId !== current.sessionId || saved.operation.args.moveId !== moveId || !sameHome(current, saved.home)) return null;
  const participant = operation.id === id && operation.args.sourceMachine === config.hubMachineId;
  const broker = operation.kind === "session-readmit" && operation.id === current.moveId && operation.args.sourceMachine === undefined;
  return (caller === "participant" ? participant : broker) ? saved.value as unknown as RollbackEvidence : null;
}
/** Bind hub-owned facts here; the hub pushes them through its authenticated participant channel. */
export function createHubMoveEvidencePorts(ports: MovePorts, feeds: Omit<MoveEvidenceBindings, "authorizeAbort" | "authorizeRetire" | "rollback">): HubMoveEvidenceBindings {
  const authoritative = () => {
    const meta = ports.globalDb.prepare("SELECT store_key,machine_id FROM roam_meta WHERE id=1").get() as { store_key: string; machine_id: string } | undefined;
    return ports.config.role === "hub" && ports.config.machineId === ports.config.hubMachineId && meta?.store_key === "global" && meta.machine_id === ports.config.hubMachineId;
  };
  return {
    ...feeds,
    async presentation(operation) { return authoritative() ? readMovePresentation(ports.journal, operation) : null; },
    async authorizeAbort(operation) { return authoritative() ? authorizeMoveAbort(operation, ports) : null; },
    async authorizeRetire(operation) {
      if (!authoritative() || !["session-retire", "session-shutdown"].includes(operation.kind)) return null;
      const moveId = operation.args.moveId;
      if (typeof moveId !== "string" || typeof operation.args.sessionId !== "string") return null;
      const current = sessionHome(ports.globalDb, operation.args.sessionId), receipt = homeReceipt(ports.globalDb, moveId);
      return current && current !== "unknown" && receipt && sameHome(current, receipt) && receipt.sessionId === operation.args.sessionId &&
        receipt.machineId !== operation.machineId && receipt.epoch === operation.expectedEpoch! + 1 && receipt.moveId === moveId ? current : null;
    },
    async rollback(operation) { return authoritative() ? readRollbackEvidence(ports.globalDb, ports.journal, operation) : null; },
  };
}

function withinRoot(root: string, cwd: string): boolean {
  const path = relative(root, cwd);
  return isAbsolute(root) && isAbsolute(cwd) && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}
/** The absence of a marker is a verified first move, not missing origin evidence. */
async function sessionHistoryOrigin(manifest: SessionManifest, previousMachine: string, limits: RoamConfig["limits"]): Promise<string> {
  await verifyFrozenSession(manifest, limits);
  const stream = createReadStream(manifest.file), lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const entry = JSON.parse(line) as { type?: string; customType?: string; data?: { historyMachine?: unknown } };
      if (entry.type === "custom" && entry.customType === "spider-roam-segment") {
        if (!isMachineId(entry.data?.historyMachine)) throw new MoveAdapterError("session-history-invalid");
        return entry.data.historyMachine;
      }
    }
    return previousMachine;
  } finally { lines.close(); stream.destroy(); }
}

function parseParticipantReadiness(value: unknown): HubOperationReadiness {
  try { return parseHubReadiness(value); }
  catch { throw new MoveAdapterError("participant-readiness-invalid"); }
}
function publicReadiness(reply: Outcome<HubOperationReadiness>, publicId: string): Outcome<HubOperationReadiness> {
  if (reply.code !== 0) return { ...reply, operationId: publicId };
  const ready = parseParticipantReadiness(reply.value);
  if (ready.opId !== reply.operationId) throw new MoveAdapterError("participant-readiness-invalid");
  return { ...reply, operationId: publicId, value: { ...ready, opId: publicId } };
}

interface MoveCleanupProof { source: Home; destination: DestinationObservation; stopped: Probe }
function validCleanupProof(proof: MoveCleanupProof | undefined, check: MoveCheck | undefined, moveId: string, globalDb: Db, successorMoveId?: string): boolean {
  if (!proof?.destination?.home || !check?.source || proof.stopped?.kind !== "absent" || proof.destination.owner?.kind !== "live" || proof.destination.retired || !proof.destination.readiness) return false;
  const home = proof.destination.home, ready = parseParticipantReadiness(proof.destination.readiness), current = sessionHome(globalDb, home.sessionId);
  const currentHome = sameHome(current, home) || !!successorMoveId && !!current && current !== "unknown" && current.moveId === successorMoveId &&
    current.epoch > home.epoch && current.machineId !== check.source.machineId;
  return currentHome && sameHome(proof.source, check.source) && home.sessionId === check.source.sessionId &&
    home.machineId === check.destinationMachine && home.epoch === check.source.epoch + 1 && home.moveId === moveId && ready.opId === moveId && ready.epoch === home.epoch && ready.sessionId === home.sessionId;
}
/** Only this move's verified, no-longer-used staging is removed; installed and original files stay intact. */
async function cleanupMoveStaging(moveId: string, check: MoveCheck, valid: () => boolean, participant: MoveParticipantBindings, journal: Journal, partial = false): Promise<void> {
  const rows = journal.read(moveId), bundles = rows.filter(row => ["workspace-bundle", "workspace-prepared"].includes(row.action));
  const workspaceIds = [...new Set(bundles.map(row => String(row.result.artifactId)))];
  if (!partial && (workspaceIds.length !== 2 || !bundles.some(row => row.result.stage === "pre") || !bundles.some(row => row.result.stage === "final"))) throw new MoveAdapterError("move-cleanup-unproved");
  const root = join(participant.root, "roam", "staging");
  const cleanIncoming = (directory: string, peer: string, operations: readonly string[]) => {
    const store = openStaging(directory, peer, participant.config.limits);
    try {
      const manifests = operations.map(operationId => {
        const cached = journal.read(moveId).find(row => row.action === "move-cleanup-manifest" && row.result.directory === directory && row.result.peer === peer && row.result.operationId === operationId);
        if (cached) return cached.result.manifest as unknown as ArtifactManifest;
        let manifest: ArtifactManifest;
        try { manifest = store.manifestFor(operationId); }
        catch (error) { if (partial && error instanceof Error && error.message === "Artifact operation has not begun") return null; throw error; }
        journal.record(moveId, "move-cleanup-manifest", json({ directory, peer, operationId, manifest }));
        return manifest;
      });
      for (const manifest of manifests) {
        if (!manifest) continue;
        validateManifest(manifest, participant.config.limits);
        if (!workspaceIds.includes(manifest.id) && manifest.id !== `${moveId}-session`) throw new MoveAdapterError("move-cleanup-unproved");
        store.discard(manifest.id, valid);
      }
    } finally { store.close(); }
  };
  if (participant.config.machineId === check.source.machineId) cleanIncoming(participant.git.scratch, participant.config.machineId, workspaceIds.map(id => `local-${id}`));
  if (participant.config.machineId === check.destinationMachine) {
    const local = participant.config.machineId === participant.config.hubMachineId, peer = local ? check.source.machineId : participant.config.hubMachineId;
    cleanIncoming(root, peer, ["pre", "final"].flatMap(stage => ["workspace", "session"].map(kind => `${moveId}-${local ? "pull" : "send"}-${stage}-${kind}`)));
  }
  for (const directory of new Set([participant.git.scratch, root])) if (existsSync(join(directory, "outgoing"))) {
    const outgoing = openOutgoingStaging(directory, participant.config.limits, false);
    try { for (const id of [...workspaceIds, `${moveId}-session`, moveId]) { if (!valid()) throw new MoveAdapterError("move-cleanup-unproved"); outgoing.remove(id); } }
    finally { outgoing.close(); }
  }
}
export function presentationTaskId(moveId: string): string { return `presentation-${createHash("sha256").update(moveId).digest("hex").slice(0, 40)}`; }
export function readMovePresentation(journal: Journal, operation: Operation): JsonObject | null {
  const moveId = String(operation.args.moveId), successor = operation.args.presentationMoveId;
  let saved: JsonObject | undefined;
  if (successor !== undefined) {
    if (typeof successor !== "string" || !successor || successor === moveId) return null;
    const deferredId = supersededSourceMoveId(moveId), deferred = journal.read(presentationTaskId(deferredId));
    const request = deferred.find(row => row.action === "source-view-request")?.result as unknown as SourceViewRequest | undefined;
    if (!request || request.sourceMoveId !== moveId || request.originalOperation?.id !== moveId || request.operation.id !== deferredId ||
        request.originalOperation.args.sessionId !== operation.args.sessionId || request.check.source.sessionId !== operation.args.sessionId ||
        !isDeepStrictEqual(request.check, operation.args.check) || !isDeepStrictEqual(request.proof, operation.args.proof)) return null;
    saved = deferred.filter(row => row.action === "successor-presentation" && row.result.moveId === successor).at(-1)?.result.presentation as JsonObject | undefined;
  }
  const taskId = presentationTaskId(typeof successor === "string" ? successor : moveId), rows = journal.read(taskId);
  const latest = rows.filter(row => row.action === "presentation").at(-1)?.result;
  // Saved evidence survives pruning, but a newly claimed task may supersede it.
  const value = latest ?? (rows.length === 0 && !journal.lookupOperation?.(taskId) ? saved : undefined);
  return value && (value.target as JsonObject | undefined)?.sessionId === operation.args.sessionId ? value : null;
}
async function verifyPresentation(operation: Operation, journal: Journal, bindings: MoveAdapterBindings): Promise<void> {
  const participant = required(bindings.participant, "participant");
  const observed = participant.config.machineId === participant.config.hubMachineId ? readMovePresentation(journal, operation)
    : await required(bindings.evidence?.presentation, "evidence.presentation")(operation);
  const supplied = operation.args.presentation;
  if (!observed || observed.status !== "complete" || !isDeepStrictEqual(observed, supplied)) throw new MoveAdapterError("destination-presentation-unproved");
  const target = observed.target as JsonObject, current = sessionHome(participant.globalDb, String(operation.args.sessionId));
  const presentationMoveId = operation.args.presentationMoveId ?? operation.args.moveId;
  if (!current || current === "unknown" || current.moveId !== presentationMoveId || current.machineId !== target.machineId || current.epoch !== target.homeEpoch)
    throw new MoveAdapterError("destination-presentation-unproved");
}
async function presentCapturedHandoff(moveId: string, journal: Journal, bindings: MoveAdapterBindings): Promise<JsonObject> {
  const captured = journal.read(moveId).find(row => row.action === "handoff-presentation-start")?.result as unknown as { target: PaneTarget; sourceFence: IntercomIntakeFence } | undefined;
  if (!captured) throw new MoveAdapterError("handoff-intent-unavailable");
  const taskId = presentationTaskId(moveId), participant = required(bindings.participant, "participant");
  journal.begin({ id: taskId, kind: "move-presentation", machineId: participant.config.hubMachineId, expectedEpoch: captured.target.homeEpoch,
    args: { moveId, sessionId: captured.target.sessionId } });
  const prior = journal.read(taskId).filter(row => row.action === "presentation").at(-1)?.result;
  if (prior?.status === "complete") return prior;
  const home = sessionHome(required(bindings.globalDb, "globalDb"), captured.target.sessionId);
  let presented: PaneActionOutcome;
  if (!home || home === "unknown" || home.moveId !== moveId || home.machineId !== captured.target.machineId || home.epoch !== captured.target.homeEpoch) presented = { status: "pending", reason: "presentation-target-stale", presentation: json(captured) };
  else {
    try { presented = await required(bindings.handoff, "handoff").presentReadyTarget(captured.target); }
    catch { presented = { status: "pending", reason: "presentation-unavailable", presentation: json(captured) }; }
  }
  const value = json({ ...captured, ...presented });
  if (!prior || !isDeepStrictEqual(prior, value)) journal.record(taskId, "presentation", value);
  const moveRows = journal.read(moveId), previous = moveRows.filter(row => row.action === "handoff-presentation").at(-1)?.result;
  if (!moveRows.some(row => row.action === "done") && !isDeepStrictEqual(previous, value)) journal.record(moveId, "handoff-presentation", value);
  return value;
}

export interface RecoveredAdapterHome { ok: true; home: Home; presentation: "complete" | "pending" }
export type AdapterMachineRecoveryOutcome =
  | { ok: true; code: 0; operationId: string; reason: "destroyed-machine-recovered"; presentation: "complete" | "pending"; value: readonly Home[]; results: readonly import("./forget").ForgottenHomeResult[] }
  | { ok: false; code: 1 | 2 | 3; operationId: string; reason: string; value: null; recovered: readonly RecoveredAdapterHome[]; results: readonly import("./forget").ForgottenHomeResult[] };
/** Ownership recovery and presentation have independent durable outcomes. */
export async function forgetMachineWithAdapters(input: { machineId: string; confirmation: string }, ports: MovePorts): Promise<AdapterMachineRecoveryOutcome> {
  const result = await forgetMachine(input, ports);
  const results = result.results.map(row => ({ ...row, presentation: row.home?.moveId && forgottenPresentationComplete(row.home.moveId, ports.journal) ? "complete" as const : row.presentation }));
  const recovered: RecoveredAdapterHome[] = results.flatMap(row => row.code === 0 && row.home ? [{ ok: true as const, home: row.home, presentation: row.presentation ?? "pending" }] : []);
  if (result.code === 0 && result.value !== null) return { ok: true, code: 0, operationId: result.operationId, reason: "destroyed-machine-recovered", presentation: results.some(row => row.presentation === "pending") ? "pending" : "complete", value: result.value, results };
  return { ok: false, code: result.code === 0 ? 3 : result.code, operationId: result.operationId, reason: result.reason, value: null, recovered, results };
}

interface AbortedWorkspaceProof { source: Home; home: Home; moveId: string; kind: "cancelled" | "rolled-back"; forward: Home | null; retirement: DestinationObservation | null }
function abortedWorkspaceProof(check: MoveCheck, moveId: string, db: Db, journal: Journal): AbortedWorkspaceProof | null {
  const action = db.prepare("SELECT session_id,expected_epoch,cancelled FROM roam_home_actions WHERE move_id=?").get(moveId) as { session_id: string; expected_epoch: number; cancelled: number } | undefined;
  if (!action || action.session_id !== check.source.sessionId || action.expected_epoch !== check.source.epoch) return null;
  const home = sessionHome(db, check.source.sessionId); if (!home || home === "unknown") return null;
  if (action.cancelled === 1 && sameHome(home, check.source)) return { source: check.source, home, moveId, kind: "cancelled", forward: null, retirement: null };
  const forward = homeReceipt(db, moveId), restored = homeReceipt(db, rollbackMoveId(moveId));
  const retirement = journal.read(moveId).find(row => row.action === "move-rollback-retired")?.result as unknown as DestinationObservation | undefined;
  const proof: AbortedWorkspaceProof = { source: check.source, home, moveId, kind: "rolled-back", forward, retirement: retirement ?? null };
  return restored && sameHome(home, restored) && validAbortedWorkspaceProof(proof, check, moveId, db) ? proof : null;
}
function validAbortedWorkspaceProof(proof: AbortedWorkspaceProof | undefined, check: MoveCheck | undefined, moveId: string, db: Db): boolean {
  if (!proof || !check || proof.moveId !== moveId || !sameHome(proof.source, check.source) || !sameHome(sessionHome(db, check.source.sessionId), proof.home)) return false;
  if (proof.kind === "cancelled") return sameHome(proof.home, check.source) && proof.forward === null && proof.retirement === null;
  const forward = proof.forward, retired = proof.retirement;
  return proof.kind === "rolled-back" && proof.home.machineId === check.source.machineId && proof.home.epoch === check.source.epoch + 2 && proof.home.moveId === rollbackMoveId(moveId) &&
    !!forward && forward.sessionId === check.source.sessionId && forward.epoch === check.source.epoch + 1 && forward.machineId === check.destinationMachine && forward.moveId === moveId &&
    !!retired && sameHome(retired.home, forward) && retired.owner.kind === "absent" && !retired.readiness && !!retired.launchFailure && retired.retired && retired.activationCancelled === true;
}
async function abortInstalledSession(moveId: string, sessionId: string, participant: MoveParticipantBindings, journal: Journal, valid: () => boolean): Promise<void> {
  const rows = journal.read(moveId);
  if (rows.some(row => row.action === "session-install-aborted")) return;
  const first = rows.find(row => row.action === "session-install-publish")?.result, last = rows.filter(row => row.action === "session-install-intent").at(-1)?.result;
  if (!first || !last) return;
  const target = await participant.sessionTarget(sessionId, moveId);
  if (first.file !== target || last.file !== target) throw new MoveAdapterError("session-abort-unproved");
  const backup = typeof first.backup === "string" ? first.backup : null;
  const old = backup ? rows.find(row => row.action === "session-backup-complete" && row.result.file === backup)?.result : null;
  if (backup && !old) throw new MoveAdapterError("session-abort-unproved");
  let exists = true;
  try { lstatSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false; else throw error; }
  if (exists) {
    const installed = await inspectSession(target, sessionId, undefined, participant.config.limits);
    if (old && installed.sha256 === old.sha256) { journal.record(moveId, "session-install-aborted", { file: target }); return; }
    if (installed.sha256 !== last.sha256) throw new MoveAdapterError("session-abort-diverged");
    if (backup) {
      const saved = await inspectSession(backup, sessionId, undefined, participant.config.limits);
      if (saved.sha256 !== old!.sha256) throw new MoveAdapterError("session-abort-unproved");
    }
    if (!valid()) throw new MoveAdapterError("move-cleanup-unproved");
    if (backup) renameSync(backup, target); else unlinkSync(target);
    syncStagingDirectory(dirname(target));
  } else if (backup) throw new MoveAdapterError("session-abort-diverged");
  journal.record(moveId, "session-install-aborted", { file: target });
}
