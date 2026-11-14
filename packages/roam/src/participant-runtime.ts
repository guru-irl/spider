import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import type { JsonObject, Readiness, StoreKey } from "@spider/db-core/roam/types";
import { parseReadiness } from "@spider/db-core/roam/readiness";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { readSessionHeader } from "@spider/herdr/sessions/launcher";
import { createIntentStore } from "./intent";
import { sessionHome } from "./homes";
import type { AgentPorts, Operation, Outcome } from "./contracts";
import { assertBoxEnrollment, participantCaptureInitialized, createRunningIntentAuthority, readReadiness, recordReadiness, startParticipant } from "./session-control";
import { readLocalIdentity } from "./runtime";
import { runLocalDoctor } from "./local-diagnostics";

export function wakeSupervisor(systemctl: (argv: readonly string[]) => Promise<void> = argv => new Promise((done, reject) => {
  execFile("systemctl", [...argv], { timeout: 5000, maxBuffer: 4096 }, error => error ? reject(new Error("supervisor-wake-failed")) : done());
})): Promise<void> { return systemctl(["--user", "start", "spider-roam-supervisor.service"]); }

/** Enrollment is loaded independently of the request. hc provides access control; these checks reject misrouting. */
export async function handleSessionOperation(operation: Operation, ports: AgentPorts, options: { wake?(): Promise<void> } = {}): Promise<Outcome<JsonObject>> {
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
    const doctor = async () => (await (checked ??= runLocalDoctor({ root }))).diagnostics;
    if (operation.kind === "session-resume") {
      try { if ((await doctor()).some(row => row.severity === "block")) return result(1, "participant-doctor-refused"); }
      catch { return result(1, "participant-doctor-unavailable"); }
    }
    if (!existing) {
      const location = db.prepare("SELECT file,cwd FROM roam_locations WHERE session_id=?").get(id) as { file: string | null; cwd: string | null } | undefined;
      if (!location?.file || !location.cwd) return result(1, "participant-location-unavailable");
      const header = await readSessionHeader(location.file);
      if (header.id !== id || header.cwd !== location.cwd) return result(1, "participant-file-mismatch");
      await authority.set({ sessionId: id, epoch: home.epoch, file: location.file, cwd: location.cwd, moveId: home.moveId,
        desired: operation.kind === "session-stop" ? "stopped" : "running", suspended: null }, operation.id, { hubMachineId: pinned.hubMachineId, machineId: pinned.machineId });
    }
    if (operation.kind === "session-stop") await authority.stop(id);
    else {
      await authority.resume(id, doctor);
      const intents = createIntentStore(root), current = await intents.get(id);
      if (current) {
        if (current.value.supervision.kind === "launching") return result(3, "launch-reconciliation-required");
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
  const keys: unknown = JSON.parse(location.stores_json);
  if (!Array.isArray(keys) || !keys.length || keys.some(key => typeof key !== "string" || !key.startsWith("worktree:"))) return result(1, "participant-stores-unavailable");
  const stores = [...new Set(keys as StoreKey[])].map(key => {
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
      await authority.set(intent, operation.id, { hubMachineId: pinned.hubMachineId, machineId: pinned.machineId });
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
