import { isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { claimIdLock, localBootId } from "@spider/herdr/sessions/id-lock";
import { canonicalSessionFile } from "@spider/herdr/sessions/registry";
import type { ProcessIdentity as LocalProcessIdentity, ProcessInventoryPorts } from "@spider/herdr/sessions/lease";
import type { Db } from "@spider/db-core";
import { recordLocation } from "@spider/db-core/roam/catalog";
import { seedSession } from "@spider/db-core/roam/seed";
import { storeScope } from "@spider/db-core/roam/codec";
import { validateRoamLayout } from "@spider/db-core/roam/layout";
import { localEntries, readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import type { Home, JsonObject, HubOperationReadiness, Probe, ProcessIdentity, StoreKey } from "@spider/db-core/roam/types";
import type { Diagnostic, HostIntent, Journal, Operation, Outcome, RoamConfig } from "./contracts";
import { isMachineId } from "./machine-id";
import { parseHubReadiness, validReadiness } from "@spider/db-core/roam/readiness";
export { validReadiness } from "@spider/db-core/roam/readiness";
import type { RunningIntentSource } from "./supervisor";

export function assertBoxEnrollment(config: RoamConfig): void {
  const reason = config.role !== "box" ? "participant-not-box" : !isMachineId(config.machineId) || !isMachineId(config.hubMachineId) || config.machineId === config.hubMachineId ? "participant-config-unavailable" : null;
  if (reason) throw Object.assign(new Error(reason), { code: reason });
}
export function participantCaptureInitialized(db: Db, machineId: string, key: StoreKey): boolean {
  try {
    const meta = db.prepare("SELECT machine_id,store_key,capture_enabled,importing FROM roam_meta WHERE id=1").get() as { machine_id: string; store_key: string | null; capture_enabled: number; importing: number } | undefined;
    return meta?.machine_id === machineId && meta.store_key === key && meta.capture_enabled === 1 && meta.importing === 0 &&
      validateRoamLayout(db, storeScope(key), "inspect").captureSafe;
  } catch { return false; }
}

export interface BothLocksOptions {
  root: string;
  file(sessionId: string): Promise<string>;
  inventory: ProcessInventoryPorts;
  identity: LocalProcessIdentity;
  bootId?(): Promise<string>;
}

export interface HeldSessionLocks { owns(): Promise<boolean> }

/** An exclusive ID claim precedes the canonical file lease and both span the callback. */
export function createBothLocks(input: BothLocksOptions): <T>(sessionId: string, fn: (locks?: HeldSessionLocks) => Promise<T>) => Promise<T> {
  return async function withBothLocks<T>(sessionId: string, fn: (locks?: HeldSessionLocks) => Promise<T>): Promise<T> {
    if (!text(sessionId) || typeof fn !== "function" || !isAbsolute(input.root) || resolve(input.root) !== resolve(input.inventory.leases.root) ||
        !Number.isSafeInteger(input.identity.pid) || input.identity.pid <= 0 || !text(input.identity.startIdentity)) throw new Error("Session lock evidence unavailable");
    const bootId = (await (input.bootId ?? localBootId)()).trim();
    const current = await input.inventory.probe(input.identity.pid);
    if (!bootId || current.kind !== "live" || current.startIdentity !== input.identity.startIdentity) throw new Error("Session lock identity unavailable");
    const id = await claimIdLock(input.root, sessionId, input.identity, input.inventory.probe, { exclusive: true, bootId: async () => bootId });
    try {
      const file = await input.file(sessionId);
      if (typeof file !== "string" || !isAbsolute(file) || file.includes("\0")) throw new Error("Session file unavailable");
      const canonical = await canonicalSessionFile(file);
      const lease = await input.inventory.leases.claim(canonical, input.identity, input.inventory, { mode: "cutover", bootId });
      try {
        if (await canonicalSessionFile(file) !== canonical) throw new Error("Session file changed during lock acquisition");
        return await fn({ owns: async () => await id.isHeldByClaim?.() === true });
      } finally { await input.inventory.leases.release(canonical, lease.token); }
    } finally { await id.release(); }
  };
}

export interface SessionControlPorts {
  journal: Journal;
  probe(sessionId: string): Promise<Probe>;
  withBothLocks<T>(sessionId: string, fn: () => Promise<T>): Promise<T>;
  live(operation: Operation): Promise<Outcome<JsonObject>>;
  dormant(operation: Operation): Promise<Outcome<JsonObject>>;
  exit?: {
    deadline: number;
    now(): number;
    exited(identity: ProcessIdentity): Promise<boolean>;
    wait?(identity: ProcessIdentity, signal: AbortSignal): Promise<void>;
  };
}

const CONTROL_KINDS = new Set(["session-inspect", "session-freeze", "session-unfreeze", "session-shutdown", "session-retire"]);
/** Validate before probing or touching the journal. Socket shutdown is the live half of retire. */
export function validSessionControl(operation: Operation): boolean {
  return !!operation && text(operation.id) && isMachineId(operation.machineId) && CONTROL_KINDS.has(operation.kind) &&
    Number.isSafeInteger(operation.expectedEpoch) && operation.expectedEpoch! > 0 && !!operation.args &&
    text(operation.args.sessionId) && text(operation.args.moveId);
}
function validProbe(probe: Probe): boolean {
  return !!probe && (probe.kind === "absent" || probe.kind === "uncertain" || probe.kind === "live" &&
    !!probe.identity && text(probe.identity.bootId) && Number.isSafeInteger(probe.identity.pid) && probe.identity.pid > 0 && text(probe.identity.startTime));
}
function validControlOutcome(value: Outcome<JsonObject>, operation: Operation): boolean {
  return !!value && [0, 1, 2, 3].includes(value.code) && text(value.reason) && value.operationId === operation.id &&
    value.epoch === operation.expectedEpoch && (value.value === null || typeof value.value === "object" && !Array.isArray(value.value));
}

/** A dormant handler runs only after a fresh absence proof under both physical locks. */
export async function controlSession(operation: Operation, ports: SessionControlPorts): Promise<Outcome<JsonObject>> {
  const result = (code: 0 | 1 | 2 | 3, reason: string): Outcome<JsonObject> => ({ code, reason,
    operationId: typeof operation?.id === "string" ? operation.id : "", home: null,
    epoch: Number.isSafeInteger(operation?.expectedEpoch) ? operation.expectedEpoch : null, repairCommand: null, value: null });
  if (!validSessionControl(operation)) return result(2, "invalid-session-control");
  const sessionId = operation.args.sessionId as string;
  let owner: Probe;
  try { owner = await ports.probe(sessionId); }
  catch { return result(3, "ownership-unavailable"); }
  if (!validProbe(owner) || owner.kind === "uncertain") return result(3, "ownership-unavailable");
  try {
    if (operation.kind !== "session-inspect") {
      const begun = ports.journal.begin(operation);
      if (operation.kind === "session-retire" && begun.kind === "done") {
        const done = begun.result as unknown as Outcome<JsonObject>;
        return validControlOutcome(done, operation) ? done : result(1, "invalid-retirement-receipt");
      }
    }
    if (owner.kind === "live") {
      const identity = owner.identity;
      const live = await ports.live(operation);
      if (!validControlOutcome(live, operation)) return result(3, "live-control-unavailable");
      if (!["session-retire", "session-shutdown"].includes(operation.kind) || live.code !== 0) return live;
      try {
        const exit = ports.exit;
        if (exit?.wait && exit.now() < exit.deadline) {
          const abort = new AbortController();
          const expired = new Promise<void>(resolve => abort.signal.addEventListener("abort", () => resolve(), { once: true }));
          const timer = setTimeout(() => abort.abort(), exit.deadline - exit.now());
          try { await Promise.race([exit.wait(identity, abort.signal), expired]); }
          finally { clearTimeout(timer); abort.abort(); }
        }
        for (;;) {
          if (exit && exit.now() > exit.deadline) return result(3, "process-exit-unproven");
          const gone = !exit || await exit.exited(identity);
          owner = await ports.probe(sessionId);
          if (gone && validProbe(owner) && owner.kind === "absent" && (!exit || exit.now() <= exit.deadline)) break;
          const remaining = exit ? exit.deadline - exit.now() : 0;
          if (remaining <= 0) return result(3, "process-exit-unproven");
          await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
        }
      } catch { return result(3, "process-exit-unproven"); }
      if (operation.kind === "session-shutdown") return { ...live, reason: "shutdown-complete" };
    }
    return await ports.withBothLocks(sessionId, async () => {
      const current = await ports.probe(sessionId);
      if (!validProbe(current) || current.kind !== "absent") return result(3, "ownership-unavailable");
      if (operation.kind === "session-retire") {
        const begun = ports.journal.begin(operation);
        if (begun.kind === "done") {
          const done = begun.result as unknown as Outcome<JsonObject>;
          return validControlOutcome(done, operation) ? done : result(1, "invalid-retirement-receipt");
        }
      }
      const dormant = await ports.dormant(operation);
      if (!validControlOutcome(dormant, operation)) return result(3, "dormant-control-unavailable");
      if (operation.kind === "session-retire" && dormant.code === 0) ports.journal.record(operation.id, "done", dormant as unknown as JsonObject);
      return dormant;
    });
  } catch { return result(3, "session-control-unavailable"); }
}

export interface ParticipantPorts {
  journal: Journal;
  machineId: string | null;
  hubMachineId: string | null;
  identityCurrent?(): Promise<boolean>;
  activate(home: Home, intent: HostIntent): Promise<void>;
  wake(): Promise<void>;
  readiness(operationId: string): Promise<HubOperationReadiness | null>;
}
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
function validIntent(value: HostIntent): void {
  if (!value || !text(value.sessionId) || !Number.isSafeInteger(value.epoch) || value.epoch < 1 ||
      !["running", "stopped"].includes(value.desired) || !(value.suspended === null || text(value.suspended)) ||
      !text(value.file) || !isAbsolute(value.file) || !text(value.cwd) || !isAbsolute(value.cwd) ||
      !(value.moveId === null || text(value.moveId))) throw new Error("Invalid participant intent");
}
export interface ParticipantAuthorization { hubMachineId: string; machineId: string }
export interface BoxLocalOrigin { kind: "box-local"; machineId: string; epoch: number; file: string; cwd: string; pid: number; startIdentity: string; stopped: boolean }
interface AuthorityRow { intent: HostIntent; operationId: string; authorization?: ParticipantAuthorization; stopToken?: string }
export interface RunningIntentAuthority extends RunningIntentSource {
  set(intent: HostIntent, operationId: string, authorization?: ParticipantAuthorization): Promise<void>;
  authorized(sessionId: string, hubMachineId: string, machineId: string): boolean;
  operationId(sessionId: string): string | null;
  stopToken(sessionId: string): string | null;
  stop(sessionId: string): Promise<void>;
  resume(sessionId: string, doctor: () => Promise<readonly Diagnostic[]>): Promise<void>;
}
/** Local metadata is not replicated. The supervisor's separate intent files are only its crash-recovery view. */
export function createRunningIntentAuthority(db: Db): RunningIntentAuthority {
  const listeners = new Set<() => void>();
  function read(id: string): AuthorityRow | undefined {
    const row = readLocal<AuthorityRow>(db, "participant-intent", id);
    if (row) {
      validIntent(row.intent);
      if (row.intent.sessionId !== id || !text(row.operationId) || row.stopToken !== undefined &&
          (typeof row.stopToken !== "string" || !/^[a-f0-9-]{36}$/.test(row.stopToken) || row.intent.desired !== "stopped")) throw new Error("Invalid participant authority");
    }
    return row;
  }
  async function set(intent: HostIntent, operationId: string, authorization?: ParticipantAuthorization, resume = false, expected?: AuthorityRow): Promise<void> {
    validIntent(intent); if (!text(operationId)) throw new Error("Invalid participant operation");
    db.raw.transaction(() => {
      const previous = read(intent.sessionId);
      if (expected && JSON.stringify(previous) !== JSON.stringify(expected)) throw new Error("Participant changed during doctor");
      if (previous && previous.intent.epoch > intent.epoch) throw new Error("Stale participant epoch");
      if (!resume && previous?.intent.epoch === intent.epoch && intent.desired === "running" &&
          (previous.intent.desired === "stopped" || previous.intent.suspended)) throw new Error("Participant is stopped or suspended");
      if (authorization && (!text(authorization.hubMachineId) || !text(authorization.machineId) || authorization.hubMachineId === authorization.machineId)) throw new Error("Invalid participant authorization");
      const stopToken = intent.desired === "stopped" ? previous?.intent.desired === "stopped" && previous.stopToken || randomUUID() : undefined;
      writeLocal(db, "participant-intent", intent.sessionId, { intent, operationId, ...(authorization ? { authorization } : {}), ...(stopToken ? { stopToken } : {}) });
    }).immediate();
    for (const listener of listeners) listener();
  }
  return {
    async list() { return localEntries<AuthorityRow>(db, "participant-intent").map(row => { read(row.key); return row.key; }); },
    async get(id) { return read(id)?.intent ?? null; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    set, operationId: id => read(id)?.operationId ?? null,
    stopToken(id) { const row = read(id); return row?.intent.desired === "stopped" ? row.stopToken ?? `legacy:${row.operationId}` : null; },
    authorized(id, hubMachineId, machineId) { const row = read(id); return row?.authorization?.hubMachineId === hubMachineId && row.authorization.machineId === machineId; },
    async stop(id) { const row = read(id); if (!row) throw new Error("Participant intent unavailable"); await set({ ...row.intent, desired: "stopped" }, row.operationId, row.authorization); },
    async resume(id, doctor) {
      const row = read(id); if (!row) throw new Error("Participant intent unavailable");
      if ((await doctor()).some(item => item.severity === "block")) throw new Error("Participant doctor refused resume");
      await set({ ...row.intent, desired: "running", suspended: null }, row.operationId, row.authorization, true, row);
    },
  };
}

/** The receipt is immutable for one operation, even if its owner later crashes. */
export function recordReadiness(journal: Journal, ready: HubOperationReadiness): void {
  ready = parseHubReadiness(ready);
  const previous = readReadiness(journal, ready.opId);
  if (previous) {
    if ((Object.keys(ready) as (keyof HubOperationReadiness)[]).some(key => previous[key] !== ready[key])) throw new Error("Readiness owner changed");
    return;
  }
  journal.record(ready.opId, "ready-durable", { ...ready });
}
export function readReadiness(journal: Journal, operationId: string): HubOperationReadiness | null {
  const row = journal.read(operationId).find(item => item.action === "ready-durable");
  if (!row) return null;
  const ready = parseHubReadiness(row.result);
  if (ready.opId !== operationId) throw new Error("Invalid durable readiness");
  return ready;
}

/** hc access is the trust boundary. Pinned enrollment identities prevent misrouting and stale hubs, not impersonation. */
export async function startParticipant(operation: Operation, home: Home, intent: HostIntent, ports: ParticipantPorts): Promise<Outcome<HubOperationReadiness>> {
  const result = (code: 0 | 1 | 2 | 3, reason: string, value: HubOperationReadiness | null = null): Outcome<HubOperationReadiness> =>
    ({ code, reason, operationId: operation.id, home, epoch: home.epoch, repairCommand: null, value });
  if (!ports.machineId || !ports.hubMachineId) return result(1, "participant-config-unavailable");
  const wrongHub = operation.args.sourceMachine !== ports.hubMachineId, wrongTarget = operation.machineId !== ports.machineId;
  if (wrongHub || wrongTarget) return result(1, wrongHub && wrongTarget ? "participant-wrong-hub-and-target" : wrongHub ? "participant-wrong-hub" : "participant-wrong-target");
  try { if (ports.identityCurrent && !await ports.identityCurrent()) return result(1, "participant-config-changed"); }
  catch { return result(1, "participant-config-unavailable"); }
  if (operation.kind !== "session-start" || home.machineId !== ports.machineId || operation.expectedEpoch !== home.epoch || intent.epoch !== home.epoch ||
      intent.sessionId !== home.sessionId || operation.args.sessionId !== home.sessionId || intent.moveId !== home.moveId ||
      intent.desired !== "running" || intent.suspended !== null) return result(1, "participant-start-refused");
  validIntent(intent);
  const bound = { ...operation, args: { ...operation.args, home: { ...home }, intent: { ...intent } } };
  const prior = ports.journal.begin(bound);
  if (prior.kind === "done") {
    const stored = prior.result as unknown as Outcome<HubOperationReadiness>;
    return { ...stored, value: stored.value === null ? null : parseHubReadiness(stored.value) };
  }
  if (!ports.journal.read(operation.id).some(row => row.action === "activated")) {
    await ports.activate(home, intent);
    ports.journal.record(operation.id, "activated", {});
  }
  await ports.wake();
  const ready = await ports.readiness(operation.id);
  if (!ready) return result(3, "readiness-pending");
  if (!validReadiness(ready) || ready.opId !== operation.id || ready.sessionId !== intent.sessionId || ready.epoch !== intent.epoch ||
      ready.file !== intent.file || ready.cwd !== intent.cwd) return result(3, "readiness-mismatch");
  const outcome = result(0, "ready", ready);
  ports.journal.record(operation.id, "done", outcome as unknown as JsonObject);
  return outcome;
}

export function seedNewParticipant(input: { globalDb: Db; machineId: string; sessionId: string; file: string; cwd: string;
  stores: readonly { key: StoreKey; db: Db }[]; limit: number }): void {
  const { globalDb, machineId, sessionId, stores } = input;
  if (!stores.length) throw new Error("Participant stores unavailable");
  if (globalDb.prepare("SELECT 1 FROM session_homes WHERE session_id=?").get(sessionId)) throw new Error("Existing home requires admission");
  for (const { db } of stores) {
    const origin = db.prepare("SELECT origin_machine FROM sessions WHERE id=?").get(sessionId) as { origin_machine: string } | undefined;
    const meta = db.prepare("SELECT machine_id FROM roam_meta WHERE id=1").get() as { machine_id: string };
    const state = db.prepare("SELECT state,epoch FROM roam_sessions WHERE session_id=?").get(sessionId) as { state: string; epoch: number } | undefined;
    if (meta.machine_id !== machineId || origin && origin.origin_machine !== machineId || state && (state.state !== "active" || state.epoch !== 1))
      throw new Error("Conflicting participant origin or state");
  }
  for (const { db, key } of stores) {
    db.raw.transaction(() => {
      if (!db.prepare("SELECT 1 FROM sessions WHERE id=?").get(sessionId))
        db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES (?,?,?)").run(sessionId, Date.now(), machineId);
    }).immediate();
    let seeded;
    do { seeded = seedSession(db, sessionId, 1, key, input.limit); if (seeded.retryable) throw new Error(seeded.reason); } while (!seeded.complete);
  }
  globalDb.raw.transaction(() => recordLocation(globalDb, { sessionId, stores: stores.map(row => row.key), home: null, file: input.file, cwd: input.cwd })).immediate();
}
