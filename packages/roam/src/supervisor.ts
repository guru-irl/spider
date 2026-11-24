import { randomUUID } from "node:crypto";
import type { ExactLaunchAdmission } from "@spider/herdr/sessions/launcher";
import type { Home, MachineId, Probe, HubOperationReadiness, SessionState } from "@spider/db-core/roam/types";
import type { Clock, Diagnostic, HostIntent, Journal, Outcome } from "./contracts";
import type { IntentState, IntentStore, VersionedIntent } from "./intent";
import type { SyncHandshake } from "./revocation";
import { LEGACY_AUTOMATIC_READ_SUSPENSION } from "./intent";
import { HOSTING_WARNING_CODE, type HostingCheck, type HostingWarning } from "./hosting-warning";
import { isMachineId } from "./machine-id";

export interface SupervisorReconnectPorts {
  machineId: MachineId;
  /** Stop and durably retire every local session before resolving. Failure remains retire-only. */
  stopSessions(): Promise<void>;
  sync(): Promise<void>;
}
export async function reconnectSupervisor(reply: SyncHandshake, ports: SupervisorReconnectPorts): Promise<boolean> {
  if (!reply || !isMachineId(reply.machineId) || reply.machineId !== ports.machineId || !(reply.kind === "accepted" && reply.reason === "ok" || reply.kind === "retire-only" && reply.reason === "machine-revoked"))
    throw new Error("Invalid sync handshake");
  if (reply.kind === "retire-only") { await ports.stopSessions(); return false; }
  await ports.sync();
  return true;
}

export interface SupervisorObservation {
  home: Home | null | "unknown" | "conflict";
  origin: MachineId | null;
  localMachine: MachineId;
  states: readonly SessionState[];
  unfinishedFreeze: boolean;
  intent: HostIntent;
  owner: Probe;
  diagnostics: readonly Diagnostic[];
}
export const RUNNING_INTENT_SOURCE_UNAVAILABLE = "running-intent-source-unavailable";

/** Task 3.4 owns the writer. It durably lists running and stopped sessions with exact epoch, file and mapped cwd.
 * The writer persists stop or user quit, preserves intent on reload, and permits resume only after doctor. It must
 * coordinate intent changes with launch admission. Missing or unreadable data never permits launch; notifications
 * are hints and may be missed, duplicated or reordered. */
export interface RunningIntentSource {
  list(): Promise<readonly string[]>;
  get(sessionId: string): Promise<HostIntent | null>;
  subscribe(listener: () => void): () => void;
}
export interface LaunchReservation { operationId: string }
export interface LaunchInvocation {
  intent: HostIntent; mode: "initial" | "reconcile"; reservation: LaunchReservation;
  /** Called only after the exact handoff is durable, immediately before spawn. */
  beforeSpawn(): Promise<ExactLaunchAdmission>;
}
export type SupervisorLaunch = { intent: HostIntent; mode: "fresh" } |
  { intent: HostIntent; mode: "reconcile"; reservation: LaunchReservation };
export interface SupervisorPorts {
  clock: Clock;
  journal: Journal;
  intents: IntentStore;
  runningIntents: RunningIntentSource;
  events: { subscribe(listener: () => void): () => void };
  connection?: SupervisorReconnectPorts & { handshake(): Promise<SyncHandshake> };
  inspect(sessionId: string): Promise<SupervisorObservation>;
  launch(request: SupervisorLaunch): Promise<Outcome<HubOperationReadiness>>;
  stop(sessionId: string): Promise<Probe>;
  cancelStop?(sessionId: string): void;
  restart?(intent: HostIntent, previous: IntentState["supervision"]): Promise<void>;
  notify(sessionId: string, reason: string): Promise<void>;
  hostingWarning?(sessionId: string, warning: HostingWarning | null): Promise<void>;
}

function sameIntent(a: HostIntent, b: HostIntent): boolean {
  return sameAuthority(a, b) && a.suspended === b.suspended;
}
function sameAuthority(a: HostIntent, b: HostIntent): boolean {
  return a.sessionId === b.sessionId && a.epoch === b.epoch && a.desired === b.desired &&
    a.file === b.file && a.cwd === b.cwd && a.moveId === b.moveId;
}
/** Reserve before any call; a persisted reservation can only enter the reconciliation path. */
export function createDurableLaunchPort(input: {
  intents: IntentStore;
  authorize(intent: HostIntent): Promise<boolean>;
  invoke(request: LaunchInvocation): Promise<Outcome<HubOperationReadiness>>;
  operationId?: (intent: HostIntent) => string;
}): SupervisorPorts["launch"] {
  const result = (intent: HostIntent, reason: string, operationId = ""): Outcome<HubOperationReadiness> =>
    ({ code: 2, reason, operationId, home: null, epoch: intent.epoch, repairCommand: null, value: null });
  return async request => {
    const { intent } = request;
    let row = await input.intents.get(intent.sessionId);
    if (!row) return result(intent, "launch-intent-unavailable");
    if (request.mode === "fresh") {
      if (row.value.supervision.kind === "launching") return result(intent, "launch-reservation-exists", row.value.supervision.operationId);
      if (row.value.supervision.kind !== "idle" || !sameIntent(row.value.intent, intent) || intent.desired !== "running" || intent.suspended !== null) {
        return result(intent, "launch-intent-stale");
      }
      const operationId = input.operationId ? input.operationId(intent) : randomUUID();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId)) throw new Error("Invalid launch operation ID");
      const reserved: IntentState = { ...row.value, supervision: { kind: "launching", operationId, phase: "reserved" } };
      if ((await input.intents.update(intent.sessionId, row.version, reserved)).kind !== "updated") return result(intent, "launch-intent-stale", operationId);
      row = await input.intents.get(intent.sessionId);
      if (!row || row.value.supervision.kind !== "launching" || row.value.supervision.operationId !== operationId || row.value.supervision.phase !== "reserved") {
        return result(intent, "launch-intent-stale", operationId);
      }
    } else if (row.value.supervision.kind !== "launching" || row.value.supervision.operationId !== request.reservation.operationId) {
      return result(intent, "launch-reservation-mismatch", request.reservation.operationId);
    }
    const pending = row.value.supervision;
    if (pending.kind !== "launching" || !sameIntent(row.value.intent, intent) || intent.desired !== "running" || intent.suspended !== null) {
      return result(intent, "launch-intent-stale");
    }
    let mode: LaunchInvocation["mode"] = "reconcile";
    if (pending.phase === "reserved") {
      if (await input.authorize(intent)) mode = "initial";
      else if (request.mode === "fresh") return result(intent, "launch-pending", pending.operationId);
      // A live owner forbids another spawn, not recovery of the reserved operation.
      const current = await input.intents.get(intent.sessionId);
      if (!current || current.version !== row.version) return result(intent, "launch-intent-stale", pending.operationId);
    }
    const admitted = row;
    return input.invoke({ intent, mode,
      reservation: { operationId: pending.operationId }, async beforeSpawn() {
        if (!await input.authorize(intent)) return "cancelled";
        const next: IntentState = { ...admitted.value, supervision: { ...pending, phase: "invoking" } };
        return (await input.intents.update(intent.sessionId, admitted.version, next)).kind === "updated" ? "admitted" : "pending";
      } });
  };
}

function permitted(observation: SupervisorObservation, id: string): boolean {
  const { home, origin, localMachine, states, intent } = observation;
  if (intent.sessionId !== id || !states.length || states.some(state => state.sessionId !== id || state.state !== "active" || state.epoch !== intent.epoch)) return false;
  if (home === "unknown" || home === "conflict") return false;
  return home === null ? origin === localMachine && intent.epoch === 1
    : home.sessionId === id && home.machineId === localMachine && home.epoch === intent.epoch;
}

export function createSupervisor(ports: SupervisorPorts): { reconcile(): Promise<void>; start(): void; stop(): Promise<void> } {
  let working: Promise<void> | null = null, requested = false, started = false;
  let unsubscribe: (() => void) | undefined, unsubscribeIntent: (() => void) | undefined, cancelSweep: (() => void) | undefined;
  const failures = new Map<string, HostingWarning>();
  const retries = new Map<string, { at: number; cancel(): void }>();
  const trigger = () => { if (started) void reconcile().catch(() => {}); };
  function cancelRetry(id: string): void { retries.get(id)?.cancel(); retries.delete(id); }
  function retryAt(id: string, at: number): void {
    if (!started || retries.get(id)?.at === at) return;
    cancelRetry(id);
    const cancel = ports.clock.later(Math.max(0, at - ports.clock.now()), () => { retries.delete(id); trigger(); });
    retries.set(id, { at, cancel });
  }
  async function save(id: string, current: VersionedIntent, value: IntentState): Promise<boolean> {
    return (await ports.intents.update(id, current.version, value)).kind === "updated";
  }
  async function suspend(id: string, current: VersionedIntent, reason: string): Promise<void> {
    if (current.value.intent.suspended !== null) return;
    if (await save(id, current, { ...current.value, intent: { ...current.value.intent, suspended: reason } })) {
      await ports.notify(id, reason);
    }
  }
  async function hostingFailure(id: string, check: HostingCheck): Promise<void> {
    const previous = failures.get(id);
    if (!previous) console.error(JSON.stringify({ event: HOSTING_WARNING_CODE, sessionId: id, code: HOSTING_WARNING_CODE, check }));
    const warning: HostingWarning = { code: HOSTING_WARNING_CODE, check, since: previous?.since ?? ports.clock.now(), count: Math.min(3, (previous?.count ?? 0) + 1) };
    // Three consecutive failed passes tolerate a transient replacement without hiding a persistent failure.
    if (warning.count === 3 && (previous?.count !== 3 || previous.check !== check)) await ports.hostingWarning?.(id, warning);
    failures.set(id, warning);
  }
  async function recordCrash(id: string, current: VersionedIntent, attempt: { check: HostingCheck }, stableSince?: number): Promise<void> {
    const state = current.value, now = ports.clock.now();
    if (stableSince !== undefined && now < stableSince || state.failures.some(at => at > now)) {
      await suspend(id, current, "Cannot verify the crash history clock"); return;
    }
    const failures = [...state.failures.filter(at => now - at <= 600_000), now];
    if (failures.length >= 5) {
      const reason = "Repeated session crashes need review";
      if (await save(id, current, { ...state, failures, intent: { ...state.intent, suspended: reason },
        supervision: { kind: "idle", nextAttemptAt: null } })) await ports.notify(id, reason);
    } else {
      const delay = [5_000, 15_000, 60_000, 300_000][failures.length - 1];
      const nextAttemptAt = now + delay;
      attempt.check = "restart";
      await ports.restart?.(state.intent, state.supervision);
      attempt.check = "intent-view";
      if (await save(id, current, { ...state, failures, supervision: { kind: "idle", nextAttemptAt } })) retryAt(id, nextAttemptAt);
    }
  }
  async function visit(id: string, attempt: { check: HostingCheck }): Promise<void> {
    const authoritative = await ports.runningIntents.get(id);
    if (!authoritative || authoritative.sessionId !== id) return;
    attempt.check = "intent-view";
    let current = await ports.intents.get(id);
    if (!current) {
      const initial: IntentState = { intent: authoritative, failures: [], supervision: { kind: "idle", nextAttemptAt: null } };
      if ((await ports.intents.update(id, null, initial)).kind !== "updated") return;
      current = await ports.intents.get(id);
      if (!current) return;
    }
    if (!sameAuthority(current.value.intent, authoritative) || authoritative.suspended && !current.value.intent.suspended) {
      const previous = current.value.intent;
      if (current.value.supervision.kind === "launching" && (previous.epoch !== authoritative.epoch || previous.file !== authoritative.file ||
          previous.cwd !== authoritative.cwd || previous.moveId !== authoritative.moveId)) return;
      let next: IntentState;
      if (authoritative.epoch > previous.epoch) {
        attempt.check = "inspection";
        const observed = await ports.inspect(id);
        if (!sameIntent(observed.intent, authoritative) || observed.owner.kind !== "absent" || observed.unfinishedFreeze ||
            observed.diagnostics.some(row => row.severity === "block") || !permitted(observed, id)) return;
        next = { intent: authoritative, failures: [], supervision: { kind: "idle", nextAttemptAt: null } };
      } else {
        next = { ...current.value, intent: { ...authoritative, suspended: previous.suspended ?? authoritative.suspended } };
      }
      if (!await save(id, current, next)) return;
      current = await ports.intents.get(id);
      if (!current) return;
    }
    const state = current.value;
    attempt.check = "inspection";
    const observation = await ports.inspect(id);
    if (!sameAuthority(state.intent, observation.intent)) return;
    if (state.intent.desired === "stopped") {
      cancelRetry(id);
      if (observation.owner.kind === "live") await ports.stop(id);
      else if (observation.owner.kind === "absent") ports.cancelStop?.(id);
      return;
    }
    ports.cancelStop?.(id);
    if (state.intent.suspended !== null) {
      cancelRetry(id);
      // Older failed observations persisted this local fence. Clear only that fence after a good read;
      // keep the reservation and re-enter normal admission with fresh authoritative evidence.
      if (state.intent.suspended === LEGACY_AUTOMATIC_READ_SUSPENSION && authoritative.suspended === null && observation.intent.suspended === null &&
          await save(id, current, { ...state, intent: { ...state.intent, suspended: null } })) requested = true;
      return;
    }
    if (observation.unfinishedFreeze) { await suspend(id, current, "An unfinished freeze needs review"); return; }
    if (observation.owner.kind === "uncertain") { await suspend(id, current, "Cannot prove the session owner absent"); return; }
    if (observation.diagnostics.some(item => item.severity === "block")) { await suspend(id, current, "Hosting prerequisites need review"); return; }
    if (!permitted(observation, id)) return;
    if (observation.owner.kind === "live" && state.supervision.kind !== "launching") {
      cancelRetry(id);
      if (state.supervision.kind !== "live" || JSON.stringify(state.supervision.identity) !== JSON.stringify(observation.owner.identity)) {
        await save(id, current, { ...state, supervision: { kind: "live", identity: observation.owner.identity, stableSince: ports.clock.now() } });
      } else if (state.failures.length && ports.clock.now() - state.supervision.stableSince >= 600_000) {
        await save(id, current, { ...state, failures: [] });
      }
      return;
    }
    if (state.supervision.kind === "live") {
      await recordCrash(id, current, attempt, state.supervision.stableSince);
      return;
    }
    if (state.supervision.kind === "idle" && state.supervision.nextAttemptAt !== null && state.supervision.nextAttemptAt > ports.clock.now()) {
      retryAt(id, state.supervision.nextAttemptAt); return;
    }
    if (state.supervision.kind !== "idle" && state.supervision.kind !== "launching") return;
    cancelRetry(id);
    const request: SupervisorLaunch = state.supervision.kind === "launching"
      ? { intent: state.intent, mode: "reconcile", reservation: { operationId: state.supervision.operationId } }
      : { intent: state.intent, mode: "fresh" };
    attempt.check = "inspection";
    const check = await ports.inspect(id);
    attempt.check = "running-intent";
    const rechecked = await ports.runningIntents.get(id);
    if (!rechecked || rechecked.suspended !== null || check.intent.suspended !== null || !sameAuthority(state.intent, rechecked) || !sameAuthority(state.intent, check.intent) || check.owner.kind === "uncertain" || request.mode === "fresh" && check.owner.kind !== "absent" ||
        check.unfinishedFreeze || check.diagnostics.some(item => item.severity === "block") || !permitted(check, id)) return;
    attempt.check = "launch";
    const outcome = await ports.launch(request);
    attempt.check = "intent-view";
    const latest = await ports.intents.get(id);
    if (!latest || !sameIntent(latest.value.intent, state.intent) || latest.value.supervision.kind !== "launching") return;
    if (request.mode === "reconcile" && outcome.code === 1 && outcome.reason === "adopted-exited" &&
        outcome.operationId === latest.value.supervision.operationId) {
      attempt.check = "inspection";
      const after = await ports.inspect(id), authorityAfter = await ports.runningIntents.get(id);
      if (after.owner.kind === "absent" && authorityAfter && authorityAfter.suspended === null && after.intent.suspended === null &&
          sameAuthority(latest.value.intent, authorityAfter) && sameAuthority(latest.value.intent, after.intent)) await recordCrash(id, latest, attempt);
      return;
    }
    if (outcome.code === 1 && ["missing-auth", "session-file-invalid", "process-identity-unavailable", "session-may-be-live"].includes(outcome.reason)) {
      await suspend(id, latest, "Hosting prerequisites need review"); return;
    }
    if (outcome.code === 0 && outcome.value && outcome.operationId === latest.value.supervision.operationId &&
        outcome.value.opId === latest.value.supervision.operationId && outcome.value.sessionId === id && outcome.value.epoch === state.intent.epoch &&
        outcome.value.file === state.intent.file && outcome.value.cwd === state.intent.cwd) {
      attempt.check = "inspection";
      const after = await ports.inspect(id);
      const authorityAfter = await ports.runningIntents.get(id);
      if (authorityAfter && authorityAfter.suspended === null && after.intent.suspended === null && sameAuthority(latest.value.intent, authorityAfter) && after.owner.kind === "live" && sameAuthority(latest.value.intent, after.intent) && permitted(after, id) &&
          !after.unfinishedFreeze && !after.diagnostics.some(item => item.severity === "block")) {
        await save(id, latest, { ...latest.value, supervision: { kind: "live", identity: after.owner.identity, stableSince: ports.clock.now() } });
      }
    }
  }
  async function reconcile(): Promise<void> {
    requested = true;
    if (!working) {
      working = (async () => {
        while (requested) {
          requested = false;
          if (ports.connection && !await reconnectSupervisor(await ports.connection.handshake(), ports.connection)) continue;
          for (const id of await ports.runningIntents.list()) {
            const attempt: { check: HostingCheck } = { check: "running-intent" };
            try {
              await visit(id, attempt);
              await ports.hostingWarning?.(id, null);
              failures.delete(id);
            } catch { await hostingFailure(id, attempt.check); }
          }
        }
      })();
      void working.finally(() => { working = null; }).catch(() => {});
    }
    return working;
  }
  function sweep(): void {
    cancelSweep = ports.clock.later(10_000, () => { cancelSweep = undefined; if (started) { sweep(); trigger(); } });
  }
  return {
    reconcile,
    start() {
      if (started) return;
      started = true;
      try {
        unsubscribe = ports.events.subscribe(trigger);
        unsubscribeIntent = ports.runningIntents.subscribe(trigger);
        sweep(); trigger();
      } catch (error) { started = false; unsubscribe?.(); unsubscribe = undefined; throw error; }
    },
    async stop() {
      started = false;
      unsubscribe?.(); unsubscribe = undefined;
      unsubscribeIntent?.(); unsubscribeIntent = undefined;
      cancelSweep?.(); cancelSweep = undefined;
      for (const id of retries.keys()) cancelRetry(id);
      if (working) await working;
    },
  };
}
