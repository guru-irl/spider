import { isDeepStrictEqual } from "node:util";
import { participantLaunchId, participantLaunchSuccessor, recordParticipantRestart } from "./participant-launch";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import type { JsonObject, Readiness, StoreKey } from "@spider/db-core/roam/types";
import { parseReadiness } from "@spider/db-core/roam/readiness";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { parseLocationStores } from "@spider/db-core/roam/catalog";
import { readSessionHeader } from "@spider/herdr/sessions/launcher";
import { localBootId, inspectIdLock } from "@spider/herdr/sessions/id-lock";
import { createSessionLeases } from "@spider/herdr/sessions/lease";
import { observeCoreIdentity } from "@spider/herdr/client/hc";
import { createIntentStore } from "./intent";
import { sessionHome } from "./homes";
import type { AgentPorts, Operation, Outcome } from "./contracts";
import { assertBoxEnrollment, participantCaptureInitialized, createRunningIntentAuthority, readReadiness, recordReadiness, startParticipant } from "./session-control";
import { readLocalIdentity } from "./runtime";
import { createLocalDiagnosticPorts, runLocalDoctor } from "./local-diagnostics";
import { adoptedOwnerExited, createProductionLocalExactHc, settlePendingLaunch, settleReleasedAdoptedOwner, type PendingLaunchRecovery } from "./launcher";
import { readSupervisorCorePin, supervisorCoreEnvironment } from "./enrollment";

export function wakeSupervisor(systemctl: (argv: readonly string[]) => Promise<void> = argv => new Promise((done, reject) => {
  execFile("systemctl", [...argv], { timeout: 5000, maxBuffer: 4096 }, error => error ? reject(new Error("supervisor-wake-failed")) : done());
})): Promise<void> { return systemctl(["--user", "start", "spider-roam-supervisor.service"]); }

/** Enrollment is loaded independently of the request. hc provides access control; these checks reject misrouting. */
export async function handleSessionOperation(operation: Operation, ports: AgentPorts, options: { wake?(): Promise<void>;
  launchRecovery?: PendingLaunchRecovery } = {}): Promise<Outcome<JsonObject>> {
  const result = (code: 0 | 1 | 2 | 3, reason: string): Outcome<JsonObject> => ({ code, reason, operationId: operation?.id ?? "", home: null, epoch: null, repairCommand: null, value: null });
  if (!operation || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operation.id) || !operation.args ||
      Object.keys(operation.args).sort().join() !== "sessionId,sourceMachine" || typeof operation.args.sessionId !== "string" || !operation.args.sessionId ||
      !["session-start", "session-stop", "session-resume"].includes(operation.kind)) return result(2, "invalid-session-operation");
  const db = ports.openStore("global").db, root = dirname(db.raw.name);
  let pinned;
  try { pinned = readLocalIdentity(root); } catch { return result(1, "participant-config-unavailable"); }
  if (pinned.machineId !== ports.config.machineId || pinned.hubMachineId !== ports.config.hubMachineId) return result(1, "participant-config-changed");
  const wrongHub = operation.args.sourceMachine !== pinned.hubMachineId, wrongTarget = operation.machineId !== pinned.machineId;
  if (wrongHub || wrongTarget) return result(1, wrongHub && wrongTarget ? "participant-wrong-hub-and-target" : wrongHub ? "participant-wrong-hub" : "participant-wrong-target");
  try { assertBoxEnrollment(pinned); } catch (error) { return result(1, (error as Error).message); }
  if (!participantCaptureInitialized(db, pinned.machineId, "global")) return result(1, "participant-capture-uninitialized");
  const id = operation.args.sessionId, home = sessionHome(db, id);
  if (!home || home === "unknown" || home.machineId !== pinned.machineId || home.epoch !== operation.expectedEpoch) return result(1, "participant-home-mismatch");
  const authority = createRunningIntentAuthority(db);
  const identityCurrent = async () => { const current = readLocalIdentity(root); return JSON.stringify(current) === JSON.stringify(pinned); };
  if (operation.kind !== "session-start") {
    if (!await identityCurrent()) return result(1, "participant-config-changed");
    const prior = ports.journal.begin(operation); if (prior.kind === "done") return prior.result as unknown as Outcome<JsonObject>;
    const existing = await authority.get(id);
    if (existing && !authority.authorized(id, pinned.hubMachineId, pinned.machineId)) return result(1, "participant-intent-untrusted");
    if (existing && (existing.epoch !== home.epoch || existing.moveId !== home.moveId)) return result(1, "participant-intent-home-mismatch");
    let checked: Promise<Awaited<ReturnType<typeof runLocalDoctor>>> | undefined;
    const doctor = async () => (await (checked ??= runLocalDoctor({ root, launchRecovery: options.launchRecovery, async currentCore() {
      const pin = readSupervisorCorePin(root);
      const identity = await observeCoreIdentity(pin.binary, supervisorCoreEnvironment(pin, process.env), { timeoutMs: 5000 });
      return identity.coreId === pin.coreId && isDeepStrictEqual(pin, readSupervisorCorePin(root)) ? identity.coreId : null;
    } }))).diagnostics;
    if (operation.kind === "session-resume") {
      try {
        const blocking = (await doctor()).filter(row => row.severity === "block");
        if (blocking.length) return { ...result(1, "participant-doctor-refused"), repairCommand: `spider roam doctor ${pinned.machineId}`,
          value: { diagnostics: blocking.map(row => ({ severity: row.severity, reason: row.reason, repairCommand: row.repairCommand })) } };
      } catch { return { ...result(1, "participant-doctor-unavailable"), repairCommand: `spider roam doctor ${pinned.machineId}` }; }
    }
    if (!existing) {
      const location = db.prepare("SELECT file,cwd FROM roam_locations WHERE session_id=?").get(id) as { file: string | null; cwd: string | null } | undefined;
      if (!location?.file || !location.cwd) return result(1, "participant-location-unavailable");
      const header = await readSessionHeader(location.file);
      if (header.id !== id || header.cwd !== location.cwd) return result(1, "participant-file-mismatch");
      await authority.set({ sessionId: id, epoch: home.epoch, file: location.file, cwd: location.cwd, moveId: home.moveId,
        desired: operation.kind === "session-stop" ? "stopped" : "running", suspended: null }, operation.id, { kind: "box-participant", hubMachineId: pinned.hubMachineId, machineId: pinned.machineId });
    }
    if (operation.kind === "session-stop") {
      await authority.stop(id);
      const intents = createIntentStore(root);
      let current = await intents.get(id);
      const lock = await inspectIdLock(join(root, "herdr"), id);
      if (lock?.pendingOperationId) {
        if (current?.value.supervision.kind !== "launching" || current.value.supervision.operationId !== lock.pendingOperationId)
          return { ...result(3, "launch-reconciliation-required"), repairCommand: `spider roam doctor ${pinned.machineId}` };
        const local = { machineId: pinned.machineId, label: "local machine", peer: null };
        const recovery = options.launchRecovery ?? { bootId: localBootId, probe: (pid: number) => createLocalDiagnosticPorts(root, []).probeProcess(local, pid) };
        let hc = options.launchRecovery?.hc, dispose: (() => Promise<void>) | undefined, settled = false;
        try {
          if (!hc) {
            const pin = readSupervisorCorePin(root);
            const transport = createProductionLocalExactHc({ binary: pin.binary, env: supervisorCoreEnvironment(pin, process.env), probe: recovery.probe });
            dispose = () => transport.dispose();
            hc = { ...transport, async coreId(signal) {
              const core = await transport.coreId(signal);
              if (core !== pin.coreId || !isDeepStrictEqual(pin, readSupervisorCorePin(root))) throw new Error("core-pin-changed");
              return core;
            } };
          }
          const file = (await authority.get(id))?.file;
          if (file) settled = await settlePendingLaunch({ root: join(root, "herdr"), sessionId: id, operationId: lock.pendingOperationId, file,
            journal: ports.journal, leases: createSessionLeases(join(root, "herdr")), recovery: { ...recovery, hc,
              clock: options.launchRecovery?.clock ?? { now: Date.now, wait: (ms, signal) => new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
              }) } } });
        } catch { /* Missing terminal or process proof must preserve pending ownership. */ }
        finally { await dispose?.(); }
        if (!settled) return { ...result(3, "launch-reconciliation-required"), repairCommand: `spider roam doctor ${pinned.machineId}` };
        current = await intents.get(id);
      }
      const launchHistory = current?.value.supervision.kind === "launching" ? ports.journal.read(current.value.supervision.operationId) : [];
      let released = current?.value.supervision.kind === "launching" && launchHistory.some(row =>
        row.action === "exact-launch-settled" && row.result.sessionId === id && row.result.file === current.value.intent.file);
      if (current?.value.supervision.kind === "launching" && current.value.supervision.phase === "invoking" &&
          (!released || !launchHistory.some(row => row.action === "done"))) {
        const local = { machineId: pinned.machineId, label: "local machine", peer: null };
        const recovery = options.launchRecovery ?? { bootId: localBootId, probe: (pid: number) => createLocalDiagnosticPorts(root, []).probeProcess(local, pid) };
        try {
          if ((await authority.get(id))?.file === current.value.intent.file) released = await settleReleasedAdoptedOwner({
            root: join(root, "herdr"), sessionId: id, operationId: current.value.supervision.operationId,
            file: current.value.intent.file, journal: ports.journal, leases: createSessionLeases(join(root, "herdr")), ...recovery });
        }
        catch { /* Missing adopted-owner proof must preserve the reservation. */ }
        if (!released) return { ...result(3, "launch-reconciliation-required"), repairCommand: `spider roam doctor ${pinned.machineId}` };
      }
      const reserved = !lock && current?.value.supervision.kind === "launching" && current.value.supervision.phase === "reserved";
      if (current && (released || reserved)) {
        const intent = await authority.get(id), operationId = authority.operationId(id);
        if (!intent || !operationId) return { ...result(3, "intent-reconciliation-required"), repairCommand: `spider roam stop ${id}` };
        if (released) recordParticipantRestart(ports.journal, pinned.machineId, intent, operationId, current.value.supervision);
        if ((await intents.update(id, current.version, { intent, failures: [], supervision: { kind: "idle", nextAttemptAt: null } })).kind !== "updated")
          return { ...result(3, "intent-reconciliation-required"), repairCommand: `spider roam stop ${id}` };
      }
    } else {
      const intents = createIntentStore(root), current = await intents.get(id);
      if (current?.value.supervision.kind === "launching") {
        const local = { machineId: pinned.machineId, label: "local machine", peer: null };
        const recovery = options.launchRecovery ?? { bootId: localBootId, probe: (pid: number) => createLocalDiagnosticPorts(root, []).probeProcess(local, pid) };
        let exited = false;
        try { exited = await adoptedOwnerExited({ root: join(root, "herdr"), sessionId: id, operationId: current.value.supervision.operationId,
          file: current.value.intent.file, leases: createSessionLeases(join(root, "herdr")), ...recovery }); } catch { /* Unavailable proof keeps the reservation. */ }
        if (!exited) return result(3, "launch-reconciliation-required");
      }
      await authority.resume(id, doctor);
      if (current) {
        const intent = await authority.get(id);
        if (!intent || (await intents.update(id, current.version, { intent, failures: [], supervision: { kind: "idle", nextAttemptAt: null } })).kind !== "updated") return result(3, "intent-reconciliation-required");
      }
    }
    await (options.wake ?? wakeSupervisor)();
    const outcome = result(0, operation.kind === "session-stop" ? "stopped-intent" : "resumed-intent");
    ports.journal.record(operation.id, "done", outcome as unknown as JsonObject); return outcome;
  }
  const location = db.prepare("SELECT stores_json,file,cwd FROM roam_locations WHERE session_id=?").get(id) as { stores_json: string; file: string | null; cwd: string | null } | undefined;
  if (!location?.file || !location.cwd) return result(1, "participant-location-unavailable");
  let keys: StoreKey[];
  try { keys = parseLocationStores(JSON.parse(location.stores_json)).filter(key => key.startsWith("worktree:")); }
  catch { return result(1, "participant-stores-unavailable"); }
  if (!keys.length) return result(1, "participant-stores-unavailable");
  const stores = keys.map(key => {
    const store = ports.openStore(key).db;
    if (!participantCaptureInitialized(store, pinned.machineId, key)) throw new Error("Participant capture is not initialized");
    return store;
  });
  const intent = { sessionId: id, epoch: home.epoch, desired: "running" as const, suspended: null, file: location.file, cwd: location.cwd, moveId: home.moveId };
  const outcome = await startParticipant(operation, home, intent, { journal: ports.journal, machineId: pinned.machineId, hubMachineId: pinned.hubMachineId, identityCurrent,
    async activate() {
      const previous = await authority.get(id);
      if (previous?.epoch === intent.epoch && (previous.desired === "stopped" || previous.suspended)) throw new Error("Participant is stopped or suspended");
      const header = await readSessionHeader(intent.file);
      if (header.id !== id || header.cwd !== intent.cwd) throw new Error("Participant exact file mismatch");
      for (const store of stores) {
        const state = store.prepare("SELECT state,epoch FROM roam_sessions WHERE session_id=?").get(id) as { state: string; epoch: number } | undefined;
        if (!state || state.state === "frozen" || state.epoch > home.epoch) throw new Error("Participant store state mismatch");
      }
      for (const store of stores) store.raw.transaction(() => {
        const currentHome = sessionHome(db, id);
        if (!currentHome || currentHome === "unknown" || currentHome.epoch !== home.epoch || currentHome.machineId !== home.machineId) throw new Error("Participant home changed");
        store.prepare("UPDATE roam_sessions SET epoch=?,state='active',move_id=?,freeze_seq=NULL WHERE session_id=?").run(home.epoch, home.moveId, id);
      }).immediate();
      await authority.set(intent, operation.id, { kind: "box-participant", hubMachineId: pinned.hubMachineId, machineId: pinned.machineId });
    },
    wake: options.wake ?? wakeSupervisor,
    async readiness(operationId) {
      const direct = readReadiness(ports.journal, operationId); if (direct) return direct;
      const stored = readLocal<unknown>(db, "participant-ready", id);
      const ready = stored === undefined || stored === null ? null : parseReadiness(stored);
      if (!ready || ready.origin !== "hub-operation" || ready.sessionId !== id || ready.epoch !== home.epoch || ready.file !== intent.file || ready.cwd !== intent.cwd || authority.operationId(id) !== operationId) return null;
      const receipt = readReadiness(ports.journal, ready.opId);
      if (!receipt || (Object.keys(ready) as (keyof import("@spider/db-core/roam/types").HubOperationReadiness)[]).some(key => receipt[key] !== ready[key])) return null;
      // A start operation can outlive several child launch operations. Preserve its first observed owner;
      // the separate participant-ready pointer continues to identify the newest live launch for placement.
      const bound = { ...ready, opId: operationId };
      ports.journal.record(operationId, "launch-readiness", { launchOperationId: ready.opId });
      recordReadiness(ports.journal, bound);
      return bound;
    },
  });
  return outcome as unknown as Outcome<JsonObject>;
}

export function createBoxParticipantWake(input: { root: string; db: import("@spider/db-core").Db; config: import("./contracts").RoamConfig;
  journal: import("./contracts").Journal; wake?(): Promise<void> }): (request: import("./move-ports").ParticipantLaunchRequest) => Promise<import("./move-ports").ParticipantLaunchResult> {
  const authority = createRunningIntentAuthority(input.db), intents = createIntentStore(input.root);
  return async ({ sessionId, operationId }) => {
    try {
      assertBoxEnrollment(input.config);
      const intent = await authority.get(sessionId);
      if (!intent || authority.operationId(sessionId) !== operationId || intent.desired !== "running" || intent.suspended || !authority.authorized(sessionId, input.config.hubMachineId, input.config.machineId))
        return { ok: false, reason: "participant-intent-unavailable" };
      const launchId = participantLaunchId(input.config.machineId, sessionId, intent.epoch, operationId);
      const saved = readLocal<{ sessionId: string; launchId: string; epoch: number }>(input.db, "participant-launch", operationId);
      if (saved && (saved.sessionId !== sessionId || saved.launchId !== launchId || saved.epoch !== intent.epoch)) return { ok: false, reason: "participant-launch-mismatch" };
      if (!saved) {
        for (;;) {
          const previous = await intents.get(sessionId);
          const same = previous && isDeepStrictEqual(previous.value.intent, intent);
          if (same && (previous.value.supervision.kind === "launching" && previous.value.supervision.operationId === launchId || previous.value.supervision.kind === "live")) break;
          if (previous && (previous.value.supervision.kind !== "idle" || previous.value.intent.epoch >= intent.epoch && !same)) return { ok: false, reason: "participant-launch-conflict" };
          const next = { intent, failures: [], supervision: { kind: "launching" as const, phase: "reserved" as const, operationId: launchId } };
          if ((await intents.update(sessionId, previous?.version ?? null, next)).kind === "updated") break;
        }
        writeLocal(input.db, "participant-launch", operationId, { sessionId, launchId, epoch: intent.epoch });
      }
      await (input.wake ?? wakeSupervisor)();
      const lock = await inspectIdLock(join(input.root, "herdr"), sessionId), supervision = (await intents.get(sessionId))?.value.supervision;
      const actual = lock?.pendingOperationId ?? lock?.operationId ?? (supervision?.kind === "launching" ? supervision.operationId : launchId);
      if (!participantLaunchSuccessor(input.journal, input.config.machineId, intent, operationId, launchId, actual))
        return { ok: false, reason: "participant-launch-conflict" };
      return { ok: true, launchId: actual };
    } catch { return { ok: false, reason: "participant-launch-unavailable" }; }
  };
}
