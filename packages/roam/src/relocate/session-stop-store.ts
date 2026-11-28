import type { Db } from "@spider/db-core";
import { isRoamUuid } from "@spider/db-core/roam/codec";
import { validUnicode } from "@spider/db-core/roam/hlc";
import { localEntries, readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import type { MachineId } from "@spider/db-core/roam/types";
import { decodeManagedHome, sameManagedHome } from "./home";
import type { OperationBinding, SessionStatus, SessionStopStore, SessionTransition, StopBlocker, StopMode, StopObservation } from "./session-stop-types";
import type { RelocateHome, SessionId, StoppedHome } from "./types";

const TRANSITION = "session-transition";
const OPERATION = "session-transition-operation";

function invalid(): never {
  throw new Error("Invalid stored session transition or operation binding");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) invalid();
  return value;
}
function text(value: unknown): string {
  if (!validUnicode(value) || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}
function integer(value: unknown, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) invalid();
  return value;
}
function timestamp(value: unknown): number | null {
  return value === null ? null : integer(value, 0);
}
function machine(value: unknown): string {
  if (!isRoamUuid(value)) invalid();
  return value;
}
function mode(value: unknown): StopMode {
  if (value !== "graceful" && value !== "hard") invalid();
  return value;
}
function parseBlocker(value: unknown): StopBlocker {
  const b = object(value);
  if (b.kind === "check") return { kind: b.kind, reason: text(b.reason) };
  if (b.kind === "job" && typeof b.cancelFromOwner === "boolean")
    return { kind: b.kind, id: text(b.id), cancelFromOwner: b.cancelFromOwner };
  return invalid();
}
function parseObservation(value: unknown, sessionId: SessionId): StopObservation {
  const o = object(value);
  const home = o.home === null ? null : decodeManagedHome(object(o.home));
  if (o.sessionId !== sessionId || (home && home.sessionId !== sessionId)) invalid();
  const fields = { sessionId, machineId: machine(o.machineId), home, observedAt: timestamp(o.observedAt),
    bootId: o.bootId === null ? null : text(o.bootId) };
  const e = object(o.evidence);
  switch (e.kind) {
    case "checking": return { ...fields, evidence: { kind: e.kind } };
    case "pending": return { ...fields, evidence: { kind: e.kind, reason: text(e.reason), blockers: array(e.blockers).map(parseBlocker) } };
    case "confirmed": {
      const p = e.owner === null ? null : object(e.owner);
      const owner = p && { pid: integer(p.pid, 1), startIdentity: text(p.startIdentity), bootId: text(p.bootId) };
      return { ...fields, evidence: { kind: e.kind, owner } };
    }
    default: return invalid();
  }
}
function parseTransition(value: unknown, key: string): SessionTransition {
  const r = object(value);
  const expected = decodeManagedHome(object(r.expected));
  const committed = decodeManagedHome(object(r.committed));
  if (committed.sessionId !== key || expected.sessionId !== key || expected.epoch > committed.epoch) invalid();
  const fields = { operationId: text(r.operationId), expected, contactReason: r.contactReason === null ? null : text(r.contactReason) };
  if (r.action === "start" && committed.state === "running") {
    return { ...fields, action: r.action, committed, observedAt: timestamp(r.observedAt) };
  }
  if ((r.action === "stop" || r.action === "relocate" || r.action === "force") && committed.state === "stopped") {
    const displaced = array(r.displaced).map(machine);
    const observations = array(r.observations).map(o => parseObservation(o, committed.sessionId));
    const unseenObservers = new Set(displaced);
    if (unseenObservers.size !== displaced.length) invalid();
    // Force can return the home to a machine that has not yet proved exit.
    unseenObservers.add(committed.machineId);
    if (observations.some(o => !unseenObservers.delete(o.machineId))) invalid();
    return { ...fields, action: r.action, committed, mode: mode(r.mode), displaced, observations };
  }
  return invalid();
}
function parseBinding(value: unknown, key: string): OperationBinding {
  const b = object(value), r = object(b.request);
  const committed = decodeManagedHome(object(b.committed));
  const operationId = text(r.operationId);
  const homeEpoch = integer(r.homeEpoch, 1);
  if (operationId !== key || r.sessionId !== committed.sessionId || homeEpoch > committed.epoch) invalid();
  const request = { operationId, sessionId: committed.sessionId, machineId: machine(r.machineId), homeEpoch };
  if (b.action === "start" && committed.state === "running") return { action: b.action, request, committed };
  if (b.action === "stop" && committed.state === "stopped") return { action: b.action, request: { ...request, mode: mode(r.mode) }, committed };
  return invalid();
}
function sameBinding(a: OperationBinding, b: OperationBinding): boolean {
  return a.action === b.action && a.request.operationId === b.request.operationId &&
    a.request.sessionId === b.request.sessionId && a.request.machineId === b.request.machineId &&
    a.request.homeEpoch === b.request.homeEpoch && sameManagedHome(a.committed, b.committed) &&
    (a.action === "start" || (b.action === "stop" && a.request.mode === b.request.mode));
}

interface ObservableStopStore extends SessionStopStore {
  subscribe(id: SessionId, changed: () => void): () => void;
}

/** Hub global store only. Call write under the session operation lock, on the same connection as the home CAS. */
export function createSessionStopStore(db: Db): ObservableStopStore {
  const listeners = new Map<SessionId, Set<() => void>>();
  function operation(id: string): OperationBinding | null {
    const saved = readLocal<unknown>(db, OPERATION, id);
    return saved === undefined ? null : parseBinding(saved, id);
  }
  return {
    current(id) {
      const saved = readLocal<unknown>(db, TRANSITION, id);
      return saved === undefined ? null : parseTransition(saved, id);
    },
    list() {
      const seen = new Set<string>();
      return localEntries<unknown>(db, TRANSITION).map(({ key, value }) => {
        if (seen.has(key)) invalid();
        seen.add(key);
        return parseTransition(value, key);
      });
    },
    operation,
    subscribe(id, changed) {
      let group = listeners.get(id);
      if (!group) listeners.set(id, group = new Set());
      group.add(changed);
      return () => { if (group.delete(changed) && group.size === 0) listeners.delete(id); };
    },
    write(record, binding) {
      const id = record.committed.sessionId;
      const saved = parseTransition(record, id);
      // In a CAS hook this is a savepoint. Without a CAS it takes the write lock itself.
      db.withRetry(() => db.raw.transaction(() => {
        if (!binding) {
          writeLocal(db, TRANSITION, id, saved);
          return;
        }
        const opId = binding.request.operationId;
        const next = parseBinding(binding, opId);
        if (!sameManagedHome(saved.committed, next.committed)) invalid();
        const existing = operation(opId);
        if (existing && !sameBinding(existing, next)) throw new Error("Session operation ID is already bound");
        writeLocal(db, TRANSITION, id, saved);
        if (!existing) writeLocal(db, OPERATION, opId, next);
      }).immediate());
      // A CAS hook uses a savepoint. Notify after the outer synchronous transaction unwinds.
      if (listeners.has(id)) queueMicrotask(() => { for (const changed of listeners.get(id) ?? []) changed(); });
      return undefined;
    },
  };
}

function confirmedExit(observation: StopObservation | undefined): boolean {
  return observation?.evidence.kind === "confirmed" && observation.observedAt !== null && observation.bootId !== null &&
    (observation.evidence.owner === null || observation.evidence.owner.bootId === observation.bootId);
}

export function hasStopProof(home: StoppedHome, observer: string, record: { observations: readonly StopObservation[] }): boolean {
  const observation = record.observations.find(item => item.machineId === observer);
  return !!observation && observation.sessionId === home.sessionId && sameManagedHome(observation.home, home) && confirmedExit(observation);
}

export function displacedByForce(expected: RelocateHome, home: StoppedHome, record: SessionTransition | null): MachineId[] {
  const prior = record && record.action !== "start" ? record : null;
  const displaced = new Set(prior?.displaced.filter(machine => !hasStopProof(prior.committed, machine, prior)));
  const sourceConfirmed = expected.state === "stopped" && prior && sameManagedHome(prior.committed, expected) &&
    hasStopProof(expected, expected.machineId, prior);
  if (expected.machineId !== home.machineId && !sourceConfirmed) displaced.add(expected.machineId);
  return [...displaced];
}

function describeBlocker(blocker: StopBlocker): string {
  if (blocker.kind === "check") return "Exit checks could not verify absence.";
  const job = `Job ${JSON.stringify(blocker.id)} is still running or unverified.`;
  return blocker.cancelFromOwner ? `${job} Run \`spider kill id:${JSON.stringify(blocker.id)}\` from the owning session.` : job;
}

export function projectSessionStatus(home: RelocateHome | null, record: SessionTransition | null, id: SessionId, now: number): SessionStatus {
  const base: SessionStatus = {
    sessionId: id,
    machineId: home?.machineId ?? null,
    homeEpoch: home?.epoch ?? null,
    homeState: home?.state ?? null,
    status: null,
    reason: null,
    observedAt: null,
  };
  if (!home) return base;
  if (home.state === "moving") return { ...base, status: "moving" };
  const matching = record && sameManagedHome(home, record.committed) ? record : null;
  if (home.state === "running") {
    if (matching?.action !== "start") return base;
    return matching.observedAt === null
      ? { ...base, status: "starting", reason: matching.contactReason }
      : { ...base, status: "running", observedAt: matching.observedAt };
  }
  const pending: SessionStatus = { ...base, status: "stop-pending", reason: "Exit has not been confirmed." };
  if (!matching || matching.action === "start") return pending;

  const observations = new Map(matching.observations.filter(o => o.sessionId === id).map(o => [o.machineId, o]));
  const observation = observations.get(home.machineId);
  const observedAt = observation?.observedAt ?? null;
  const exact = (machine: string) => {
    const o = observations.get(machine);
    return o && sameManagedHome(o.home, home) ? o : undefined;
  };
  const local = exact(home.machineId);
  const homeConfirmed = confirmedExit(local);
  const unverified = matching.displaced.filter(machine => !confirmedExit(exact(machine)));
  if (homeConfirmed && unverified.length === 0) return { ...base, status: "stopped", observedAt };

  const reasons = new Set<string>();
  if (unverified.length > 0) {
    const displaced = `${unverified.join(", ")} may still be running.`;
    reasons.add(homeConfirmed ? `Stopped on ${home.machineId}. ${displaced}` : displaced);
  }
  for (const machine of [home.machineId, ...matching.displaced]) {
    const evidence = exact(machine)?.evidence;
    if (evidence?.kind !== "pending") continue;
    if (!evidence.blockers.length) reasons.add("Exit checks could not verify absence.");
    for (const blocker of evidence.blockers) reasons.add(describeBlocker(blocker));
  }
  if (matching.contactReason !== null) reasons.add(matching.contactReason);
  if (observation && !local) reasons.add(observation.home === null ? "The stopped replica is missing." : "The replica does not match the stopped home.");
  if (reasons.size > 0) return { ...pending, reason: [...reasons].join(" "), observedAt };
  if (local?.evidence.kind === "checking" && observedAt !== null) {
    // Stopping assumes the box and Mac wall clocks agree within the 10-second
    // window. A future or stale timestamp stays pending. Confirmation does not expire.
    const age = now - observedAt;
    if (age >= 0 && age < 10_000) return { ...base, status: "stopping", observedAt };
    return { ...pending, reason: "The exit check is not current.", observedAt };
  }
  return { ...pending, observedAt };
}
