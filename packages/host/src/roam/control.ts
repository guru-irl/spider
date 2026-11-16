import { storeScope } from "@spider/db-core/roam/codec";
import { safeError } from "@spider/organism";
import { readSessionState } from "@spider/db-core/roam/state";
import type { Home, JsonObject, StoreKey } from "@spider/db-core/roam/types";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Operation, Outcome } from "@spider/roam/contracts";
import { startSessionControlSocket } from "@spider/roam/session-socket";
import { AbortAuthorizationPendingError, FreezeBlockedError, disposeFreezePorts, freezeParticipant, inspectDormantTranscript, retireDormantParticipant, unfreezeParticipant, type FreezePorts } from "./freeze.js";
import { inspectBlockers, type BlockerPorts } from "./blockers.js";
import type { AdmissionGate } from "./admission.js";
import { IntercomFenceError } from "./intercom.js";

export interface DormantControlInput {
  sessionId: string; file: string; cwd: string; home: Home | null;
  journal: FreezePorts["journal"]; stores: FreezePorts["stores"]; expectedStores: FreezePorts["expectedStores"];
  blockerPorts: BlockerPorts;
  intercom?: FreezePorts["intercom"];
  ingestThrough: FreezePorts["ingestThrough"];
  authorizeAbort: FreezePorts["authorizeAbort"];
  authorizeRetire(operation: Operation): Promise<Home | null>;
  onHubRestored: FreezePorts["onHubRestored"];
  /** Retry must go back through controlSession and reacquire both locks. */
  retryAbort(operation: Operation): Promise<void>;
}

/** Called by controlSession only while both dormant locks and an absence proof are held. */
export function createDormantControl(input: DormantControlInput): (operation: Operation) => Promise<Outcome<JsonObject>> {
  return async operation => {
    const result = (code: 0 | 1 | 2 | 3, reason: string, value: JsonObject | null = null): Outcome<JsonObject> => ({
      code, reason, operationId: operation.id, home: input.home, epoch: operation.expectedEpoch, repairCommand: null, value,
    });
    let restricted = true;
    const gate: AdmissionGate = {
      inspect: () => ({ kind: restricted ? "control-only" : "ordinary", home: input.home, blockers: [] }),
      refreshInitialHome: async () => gate.inspect(), whenSettled: async () => gate.inspect(), close: async () => { restricted = true; },
      async freeze(moveId, epoch) {
        if (operation.args.sessionId !== input.sessionId || operation.args.moveId !== moveId || operation.expectedEpoch !== epoch)
          throw new Error("Dormant control identity changed");
        validateTarget(operation, ports); restricted = true;
      },
      async unfreeze(moveId, epoch) {
        if (operation.args.moveId !== moveId || operation.expectedEpoch !== epoch) throw new Error("Dormant control identity changed");
        restricted = false;
      },
    };
    const ctx = { mode: "print", hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => input.sessionId, getSessionFile: () => input.file } } as unknown as ExtensionContext;
    const ports: FreezePorts & { authorizeRetire(operation: Operation): Promise<Home | null> } = {
      gate, journal: input.journal, stores: input.stores, expectedStores: input.expectedStores, intercom: input.intercom,
      async drain() {}, async resume() {}, ingestThrough: input.ingestThrough,
      authorizeAbort: input.authorizeAbort, authorizeRetire: input.authorizeRetire, onHubRestored: input.onHubRestored, retryAbort: input.retryAbort,
      async inspect(fence) {
        const transcript = await inspectDormantTranscript(input.file, input.sessionId);
        return { blockers: await inspectBlockers(ctx, input.stores, fence && input.intercom ? { ...input.blockerPorts,
          intercom: async () => (await input.intercom!.ports.inspect(fence)).blockers } : input.blockerPorts), file: input.file, cwd: input.cwd, leaf: transcript.leaf, owner: null };
      },
    };
    try {
      if (operation.args.sessionId !== input.sessionId) return result(2, "invalid-session-control");
      if ((operation.kind === "session-freeze" || operation.kind === "session-unfreeze") &&
          (!input.home || input.home.sessionId !== input.sessionId || input.home.machineId !== operation.machineId || input.home.epoch !== operation.expectedEpoch))
        return result(3, "participant-home-mismatch");
      if (operation.kind === "session-retire") { await retireDormantParticipant(operation, ports); return result(0, "retired", {}); }
      validateTarget(operation, ports);
      if (operation.kind === "session-inspect") return result(0, "inspected", await ports.inspect() as unknown as JsonObject);
      if (operation.kind === "session-freeze") return result(0, "frozen", await freezeParticipant(operation, ports) as unknown as JsonObject);
      if (operation.kind === "session-unfreeze") { await unfreezeParticipant(operation, ports); return result(0, "unfrozen", {}); }
      if (operation.kind === "session-shutdown") return result(0, "already-stopped", {});
      return result(2, "invalid-session-control");
    } catch (error) {
      if (error instanceof FreezeBlockedError || error instanceof IntercomFenceError) return result(3, "freeze-blocked", { blockers: error.blockers as unknown as JsonObject[] });
      if (error instanceof AbortAuthorizationPendingError) return result(3, error.message);
      return result(3, "dormant-control-refused");
    }
  };
}

export interface LiveFreezePorts extends FreezePorts {
  /** Request shutdown; retirement is persisted only by the move owner after exit proof. */
  shutdown(): Promise<void>;
  readmit?(operation: Operation): Promise<Outcome<JsonObject>>;
  /** Read-only unassigned-origin inspection under admission-owned ID/file locks. */
  initialInspect?(operation: Operation): Promise<Awaited<ReturnType<FreezePorts["inspect"]>>>;
}

/** Validate every participant store before dispatch, including control-only reloads. */
function validateTarget(operation: Operation, ports: FreezePorts): void {
  if (!Array.isArray(ports.stores) || !ports.stores.length || !Array.isArray(ports.expectedStores) || !ports.expectedStores.length)
    throw new Error("Participant store evidence unavailable");
  const keys = new Set<string>(); let worktrees = 0;
  for (const db of ports.stores) {
    const meta = db.prepare("SELECT machine_id,store_key FROM roam_meta WHERE id=1").get() as { machine_id: string; store_key: StoreKey } | undefined;
    if (!meta || meta.machine_id !== operation.machineId || !meta.store_key || keys.has(meta.store_key)) throw new Error("Participant identity changed");
    keys.add(meta.store_key);
    if (storeScope(meta.store_key) !== "worktree") continue;
    worktrees++;
    const state = readSessionState(db, operation.args.sessionId as string);
    if (!state || state.epoch !== operation.expectedEpoch || state.state === "retired" ||
        state.state === "frozen" && state.moveId !== operation.args.moveId) throw new Error("Participant epoch or move does not match");
  }
  if (!worktrees || keys.size !== ports.expectedStores.length || new Set(ports.expectedStores).size !== ports.expectedStores.length ||
      ports.expectedStores.some(key => !keys.has(key))) throw new Error("Participant store roster changed");
}

function controlFailure(operation: Operation, ports: FreezePorts, error: unknown): JsonObject {
  const rawCode = error && typeof error === "object" && "code" in error ? error.code : null;
  const diagnostic = { code: typeof rawCode === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(rawCode) ||
    typeof rawCode === "number" && Number.isSafeInteger(rawCode) ? rawCode : null,
    message: safeError(error instanceof Error || typeof error === "string" ? error : "Unknown session control failure") };
  const evidence: JsonObject = { diagnostic };
  try {
    const moveId = operation.args.moveId;
    const id = typeof moveId === "string" && ports.journal.lookupOperation(moveId)?.state === "pending" ? moveId : operation.id;
    if (id === operation.id) ports.journal.begin(operation);
    ports.journal.record(id, "session-control-refused", { operationId: operation.id, diagnostic });
  } catch (journalError) { evidence.journalError = safeError(journalError); }
  return evidence;
}

/** The caller owns the session's ID and canonical-file locks before starting this service. */
export async function serveSessionControl(input: { sessionId: string; runtimeRoot: string; ports: LiveFreezePorts }): Promise<{ close(): Promise<void> }> {
  const { sessionId, runtimeRoot, ports } = input;
  const socket = await startSessionControlSocket(runtimeRoot, sessionId, async ({ op, operation }) => {
    const result = (code: 0 | 1 | 2 | 3, reason: string, value: JsonObject | null = null): Outcome<JsonObject> => ({
      code, reason, operationId: operation.id, home: ports.gate.inspect().home, epoch: operation.expectedEpoch, repairCommand: null, value,
    });
    try {
      if (op === "readmit") return ports.readmit ? await ports.readmit(operation) : result(3, "move-rollback-proof-missing");
      if (op === "inspect" && ports.gate.inspect().kind === "ordinary" && ports.gate.inspect().home === null && ports.initialInspect) {
        const evidence = await ports.initialInspect(operation);
        if (!evidence.owner || evidence.owner.pid !== process.pid) throw new Error("Initial owner evidence unavailable");
        return result(0, "inspected", evidence as unknown as JsonObject);
      }
      if (op === "freeze") { await ports.gate.refreshInitialHome(); await ports.gate.whenSettled(); }
      validateTarget(operation, ports);
      if (op === "inspect") {
        const evidence = await ports.inspect();
        if (!evidence || !Array.isArray(evidence.blockers) || !evidence.owner || evidence.owner.pid !== process.pid)
          throw new Error("Live owner evidence unavailable");
        return result(0, "inspected", evidence as unknown as JsonObject);
      }
      if (op === "freeze") return result(0, "frozen", await freezeParticipant(operation, ports) as unknown as JsonObject);
      if (op === "unfreeze") { await unfreezeParticipant(operation, ports); return result(0, "unfrozen", {}); }
      const progress = ports.journal.readFreeze(sessionId, operation.args.moveId as string);
      if (ports.gate.inspect().kind !== "control-only" || !progress || progress.state !== "frozen" || progress.epoch !== operation.expectedEpoch)
        throw new Error("Participant is not frozen for shutdown");
      await ports.shutdown();
      return result(0, "shutdown-requested", {});
    } catch (error) {
      if (error instanceof FreezeBlockedError || error instanceof IntercomFenceError) return result(3, "freeze-blocked", { blockers: error.blockers as unknown as JsonObject[] });
      if (error instanceof AbortAuthorizationPendingError) return result(3, error.message);
      return result(1, "session-control-refused", controlFailure(operation, ports, error));
    }
  });
  return { async close() { disposeFreezePorts(ports); await socket.close(); } };
}
