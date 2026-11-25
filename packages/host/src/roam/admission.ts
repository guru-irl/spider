import { recordMoveSetupFailure } from "@spider/roam/setup-diagnostics";
import { moveSetupFailure, moveSetupMessage, type MoveSetupFailure, type MoveSetupStage } from "@spider/roam/setup-failure";
import { rollbackMoveId } from "@spider/roam/move-recovery";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Blocker, Home, MachineId, SessionState, StoreKey } from "@spider/db-core/roam/types";
import { getBinding, openDb, openDbReadOnlyAt, openGlobalReadOnly, paths, type Db } from "@spider/db-core";
import { readMachineIdentity } from "@spider/db-core/roam/machine";
import { readLocal } from "@spider/db-core/roam/local-state";
import { readLocalIdentity } from "@spider/roam/runtime";
import { assertBoxEnrollment, createRunningIntentAuthority, participantCaptureInitialized, type ParticipantIntentOwner } from "@spider/roam/session-control";
import { validateRoamLayout } from "@spider/db-core/roam/layout";
import { openRoamStoreReadOnly } from "@spider/db-core/roam/reads";
import { readSessionState } from "@spider/db-core/roam/state";
import { isAbsolute, join, resolve } from "node:path";
import { lockParticipant, type ParticipantLockOptions } from "../herdr/participant-lock.js";
import { ordinaryWorkAllowed as isOrdinaryWorkAllowed } from "./activation.js";
import { AUTO_RELOAD_ARG } from "../auto-reload.js";
import { productionParticipantAdmission, type ParticipantAdmissionHooks } from "./readiness.js";
import { lstatSync } from "node:fs";
import { participantCaptureReady } from "@spider/roam/production-supervisor";
import { isDeepStrictEqual } from "node:util";
import { isMachineId } from "@spider/roam/machine-id";
import { isRevoked } from "@spider/roam/revocation";
import type { HostIntent, RoamConfig } from "@spider/roam/contracts";
import type { HomeAdmission, RunningHome, SessionId } from "@spider/roam/relocate/types";

export interface Admission { kind: "pending" | "ordinary" | "control-only" | "blocked"; home: Home | null; blockers: readonly Blocker[]; setupFailure?: MoveSetupFailure }
export interface AdmissionGate {
  inspect(): Admission;
  refreshInitialHome(): Promise<Admission>;
  whenSettled(): Promise<Admission>;
  close(): Promise<void>;
  freeze(moveId: string, epoch: number): Promise<void>;
  unfreeze(moveId: string, epoch: number): Promise<void>;
  readmit?(moveId: string, source: Home, restored: Home): Promise<void>;
}
export interface AdmissionPorts {
  expectedEpoch: number | null;
  /** Enabled Mac controls claim only local ID/file locks, not portable membership. */
  lockUntracked?(): boolean;
  localMachine(): Promise<MachineId>;
  knownParticipant(sessionId: string): boolean;
  /** Null excludes discovery; unchanged revisions require no admission lookup. */
  captureVersion?(): string | null;
  warnOnce(sessionId: string, reason: string): void;
  setupDiagnostic?(sessionId: string, failure: MoveSetupFailure | null): void;
  load(sessionId: string): Promise<{ home: Home | null; states: readonly SessionState[]; origin: MachineId | null;
    participating: boolean; captureSafe: boolean; unfinishedFreeze: boolean; initialConflict: boolean;
    freezeRecovery?: { moveId: string; epoch: number } }>;
  lock(sessionId: string, file: string): Promise<() => Promise<void>>;
  setContext?(ctx: ExtensionContext): void;
  prepare?: ParticipantAdmissionHooks["prepare"];
  ready?(sessionId: string, file: string, epoch: number, home: Home | null): Promise<void>;
  stopped?(sessionId: string): Promise<void>;
  v0Lookup?(sessionId: SessionId): Promise<HomeAdmission>;
  v0Ready?(sessionId: SessionId, file: string, home: RunningHome): Promise<{ close(): Promise<void> } | void>;
}

const VERIFY = "Cannot verify this session's home. Retry or run /spider roam doctor for details.";
const FROZEN = "This session is frozen for a move. Run /spider roam doctor for details.";
const homeMessage = (machine: string) => `This session is at ${machine}. Run /spider roam doctor for details.`;
const admissionFailure = (error: unknown) => error instanceof Error && ["participant-config-unavailable", "participant-not-box", "participant-capture-uninitialized"].includes(error.message)
  ? `${error.message}. Run /spider roam doctor for details.` : VERIFY;

function initialAdmissionFailure(stage: string, error: unknown, sessionId: string): string {
  const cause = moveSetupFailure("ownership", error).causeCode;
  const code = cause === "setup-unavailable" ? null : cause;
  const resume = code && ["participant-stopped", "participant-hub-intent-required", "participant-launch-provenance-unavailable"].includes(code);
  const session = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(sessionId) ? sessionId : "<session>";
  return `admission-${stage}-failed. ${code ? `${code}. ` : ""}${resume
    ? `Close this copy, then run spider roam resume ${session} on the hub. Resume runs doctor before starting the exact session.` : admissionFailure(error)}`;
}

/** A blocked send must be distinguishable from a delivered message. */
export class AdmissionClosedError extends Error {
  readonly code = "SPIDER_ADMISSION_CLOSED";
  constructor(message: string) { super(message); this.name = "AdmissionClosedError"; }
}

export function registerAdmission(pi: ExtensionAPI, ports: AdmissionPorts): AdmissionGate {
  let handoffRequired = process.env.SPIDER_HERDR_HANDOFF_FILE !== undefined;
  if (process.env.PI_SUBAGENT_CHILD === "1" && !handoffRequired) {
    const child: Admission = { kind: "ordinary", home: null, blockers: [] };
    return { inspect: () => child, refreshInitialHome: async () => child, whenSettled: async () => child, close: async () => {}, freeze: async () => { throw new Error(VERIFY); }, unfreeze: async () => { throw new Error(VERIFY); } };
  }
  let admission: Admission = { kind: "ordinary", home: null, blockers: [] };
  const ordinaryWorkAllowed = () => isOrdinaryWorkAllowed(admission);
  let sessionId = "", sessionFile = "", epoch: number | null = null, participating = false, generation = 0;
  let ownershipVerified = false;
  let discoverable = false, captureVersion: string | null = null, preparationPending = false;
  let held: { sessionId: string; file: string; release: () => Promise<void>; valid: boolean } | undefined;
  let transition: Promise<void> = Promise.resolve();
  let freeze: { moveId: string; epoch: number } | undefined;
  let lastContext: ExtensionContext | undefined;
  let signalled = false, watchingSignals = false;
  const observed = new Set<string>();
  const observedV0 = new Set<string>();
  let v0Managed = false;
  let v0Control: { close(): Promise<void> } | void;
  async function closeV0Control(): Promise<void> {
    const previous = v0Control;
    v0Control = undefined;
    await previous?.close();
  }
  const noteSignal = () => { signalled = true; };
  const unwatchSignals = () => {
    if (!watchingSignals) return;
    watchingSignals = false;
    process.off("SIGTERM", noteSignal);
    if (process.platform !== "win32") process.off("SIGHUP", noteSignal);
  };
  const watchSignals = () => {
    if (watchingSignals || !ports.stopped) return;
    watchingSignals = true;
    process.on("SIGTERM", noteSignal);
    if (process.platform !== "win32") process.on("SIGHUP", noteSignal);
  };

  function publish(kind: Admission["kind"], home: Home | null, detail?: string, setupFailure?: MoveSetupFailure): void {
    admission = { kind, home, blockers: detail ? [{ kind: "admission", id: sessionId, detail }] : [], ...(setupFailure ? { setupFailure } : {}) };
  }
  function reason(): string {
    const detail = admission.blockers[0]?.detail;
    return detail ?? (admission.home ? homeMessage(admission.home.machineId) : VERIFY);
  }
  // A later activation must not adopt a lock while an earlier release is still in flight.
  function sequence(work: () => Promise<void>): Promise<void> {
    const next = transition.then(work);
    transition = next.catch(() => {});
    return next;
  }
  async function release(): Promise<void> {
    const previous = held;
    if (!previous) return;
    previous.valid = false;
    await previous.release();
    if (held === previous) held = undefined;
  }
  async function start(ctx: ExtensionContext | undefined, reopening = false, late = false): Promise<void> {
    const id = ctx?.sessionManager?.getSessionId?.() ?? "";
    const file = ctx?.sessionManager?.getSessionFile?.() ?? "";
    const ticket = ++generation;
    let result: Admission | undefined, admitted = false, stage = "eligibility";
    let setupFailure: MoveSetupFailure | undefined;
    const setupFailed = (stage: MoveSetupStage, error: unknown) => {
      setupFailure = moveSetupFailure(stage, error);
      try { ports.setupDiagnostic?.(id, setupFailure); } catch { /* Diagnostics cannot close ordinary admission. */ }
      return moveSetupMessage(setupFailure);
    };
    const publishResult = (kind: Admission["kind"], home: Home | null, detail?: string) => {
      if (late) result = { kind, home, blockers: detail ? [{ kind: "admission", id, detail }] : [], ...(setupFailure ? { setupFailure } : {}) };
      else publish(kind, home, detail, setupFailure);
    };
    if (!late) publish("pending", null);
    await sequence(async () => {
      try {
        if (ticket !== generation) return;
        if (ctx) { lastContext = ctx; ports.setContext?.(ctx); }
        try {
          if (v0Control) await closeV0Control();
          if (held && (!held.valid || held.sessionId !== id || held.file !== file)) await release();
        }
        catch { if (ticket === generation) { sessionId = id; publishResult("blocked", null, VERIFY); } return; }
        if (ticket !== generation) return;
        sessionId = id; sessionFile = file; epoch = null; participating = false; ownershipVerified = false; discoverable = false; captureVersion = null;
        if (!id) { publishResult(handoffRequired ? "blocked" : "ordinary", null, handoffRequired ? VERIFY : undefined); return; }
        v0Managed = false;
        if (ports.v0Lookup) {
          const v0Message = "Cannot verify a local running home. Restore the local home before starting this session.";
          let lookup: HomeAdmission;
          try { lookup = await ports.v0Lookup(id as SessionId); }
          catch { lookup = { kind: "unavailable" }; }
          if (ticket !== generation) return;
          if (lookup.kind !== "unmanaged" || observedV0.has(id)) {
            v0Managed = true;
            observedV0.add(id);
            const home = lookup.kind === "managed" ? lookup.home : null;
            try {
              const machine = await ports.localMachine();
              if (!home || home.state !== "running" || home.sessionId !== id || home.machineId !== machine ||
                  ports.expectedEpoch !== null && ports.expectedEpoch !== home.epoch || !file || !isAbsolute(file)) {
                await release(); publishResult("blocked", home, v0Message); return;
              }
              if (!held) held = { sessionId: id, file, release: await ports.lock(id, file), valid: true };
              if (ticket !== generation) { await release(); return; }
              const current = await ports.v0Lookup(id as SessionId);
              if (current.kind !== "managed" || !isDeepStrictEqual(current.home, home)) {
                await release(); publishResult("blocked", home, v0Message); return;
              }
              v0Control = await ports.v0Ready?.(id as SessionId, file, home);
              if (ticket !== generation) { await closeV0Control(); await release(); return; }
              epoch = home.epoch; participating = true; ownershipVerified = true;
              handoffRequired = false; freeze = undefined; admitted = true;
              publishResult("ordinary", home);
              if (!late) watchSignals();
            } catch {
              await closeV0Control(); await release();
              publishResult("blocked", home, v0Message);
            }
            return;
          }
        }
        stage = "prepare";
        let preparationFailed = false, preparationFailure: unknown;
        preparationPending = false;
        try { preparationPending = await ports.prepare?.(id, file, ctx?.sessionManager?.getHeader?.()) === "pending-file"; }
        catch (error) { preparationFailed = true; preparationFailure = error; setupFailed("preparation", error); }
        let state: Awaited<ReturnType<AdmissionPorts["load"]>>;
        stage = "load";
        try {
          state = await ports.load(id);
        } catch (error) {
          if (ticket !== generation) return;
          if (handoffRequired || observed.has(id) || ports.knownParticipant(id)) publishResult("blocked", null, initialAdmissionFailure("load", error, id));
          else { if (!late) ports.warnOnce(id, VERIFY); publishResult("ordinary", null, late ? initialAdmissionFailure("load", error, id) : undefined); }
          return;
        }
        if (ticket !== generation) return;
        stage = "eligibility";
        participating = !late && state.participating;
        if (!state.participating) {
          if (handoffRequired || observed.has(id) || ports.knownParticipant(id)) {
            publishResult("blocked", null, VERIFY);
            return;
          }
          if (preparationFailed) {
            const detail = moveSetupMessage(setupFailure!);
            if (!late) ports.warnOnce(id, detail);
            freeze = undefined; publishResult("ordinary", null, detail); return;
          }
          try {
            if (!late && ports.lockUntracked?.() && ctx?.mode === "tui" && ctx.hasUI && file && isAbsolute(file) && process.env.PI_SUBAGENT_CHILD !== "1" && !held?.valid) {
              held = { sessionId: id, file, release: await ports.lock(id, file), valid: true };
              if (ticket !== generation) { await release(); return; }
            }
          } catch (error) {
            if (ticket !== generation) return;
            ports.warnOnce(id, setupFailed("ownership", error));
          }
          freeze = undefined; publishResult("ordinary", null, setupFailure ? moveSetupMessage(setupFailure) : undefined);
          if (!setupFailure) { try { ports.setupDiagnostic?.(id, null); } catch { /* Best-effort diagnostic cleanup. */ } }
          discoverable = state.captureSafe && Boolean(ctx && file);
          captureVersion = ports.captureVersion?.() ?? null;
          return;
        }
        if (!late) observed.add(id);
        const home = state.home;
        if (preparationFailed || preparationPending) { publishResult("blocked", home, initialAdmissionFailure("prepare", preparationFailure, id)); return; }
        epoch = home?.epoch ?? state.states[0]?.epoch ?? null;
        if (state.initialConflict) { publishResult("blocked", home, "This session has conflicting initial homes. Run /spider roam doctor for details."); return; }
        const frozenState = state.states.find(row => row.state === "frozen");
        const recovered = state.freezeRecovery ?? (frozenState?.moveId ? { moveId: frozenState.moveId, epoch: frozenState.epoch } : undefined);
        if (recovered && (!freeze || freeze.moveId === recovered.moveId && freeze.epoch === recovered.epoch)) freeze = recovered;
        else if (recovered) { publishResult("control-only", home, FROZEN); return; }
        if (!reopening && (freeze || state.unfinishedFreeze || frozenState)) {
          publishResult("control-only", home, FROZEN);
          // Control recovery is safe only while this activation owns the same locks
          // as ordinary work. Incomplete evidence leaves the gate closed.
          if (!freeze || !file || !state.captureSafe || !state.states.length || epoch === null || freeze.epoch !== epoch ||
              ports.expectedEpoch !== null && ports.expectedEpoch !== epoch || state.states.some(row => row.sessionId !== id || row.epoch !== epoch ||
                !(row.state === "active" || row.state === "frozen" && row.moveId === freeze!.moveId))) return;
          try {
            const machine = await ports.localMachine();
            if (ticket !== generation || !machine || (home ? home.sessionId !== id || home.machineId !== machine : state.origin !== machine || epoch !== 1)) return;
            if (!held) {
              const unlock = await ports.lock(id, file);
              held = { sessionId: id, file, release: unlock, valid: true };
              handoffRequired = false;
              if (ticket !== generation) { await release(); return; }
            }
            ownershipVerified = true;
            if (!late) watchSignals();
          } catch { /* Remain control-only; never recover without ownership. */ }
          return;
        }
        if (state.unfinishedFreeze || frozenState) { publishResult("control-only", home, FROZEN); return; }
        if (!state.captureSafe || !state.states.length || state.states.some(row => row.sessionId !== id || row.state !== "active" || row.epoch !== epoch) ||
          epoch === null || ports.expectedEpoch !== null && ports.expectedEpoch !== epoch) {
          publishResult("blocked", home, VERIFY); return;
        }
        stage = "ownership";
        try {
          const machine = await ports.localMachine();
          if (ticket !== generation) return;
          if (!machine || (home ? home.sessionId !== id || home.machineId !== machine : state.origin !== machine || epoch !== 1)) {
            publishResult("blocked", home, home?.machineId ? homeMessage(home.machineId) : VERIFY); return;
          }
          if (!file) { publishResult("blocked", home, VERIFY); return; }
          if (!held) {
            stage = "lock";
            const unlock = await ports.lock(id, file);
            held = { sessionId: id, file, release: unlock, valid: true };
            handoffRequired = false;
            if (ticket !== generation) { await release(); return; }
          }
          ownershipVerified = true;
          stage = "readiness";
          await ports.ready?.(id, file, epoch, home);
          if (ticket !== generation) return;
          if (reopening) freeze = undefined;
          admitted = true;
          try { ports.setupDiagnostic?.(id, null); } catch { /* Best-effort diagnostic cleanup. */ }
          publishResult("ordinary", home);
          if (!late) watchSignals();
        } catch (error) {
          if (ticket === generation) {
            setupFailed(stage === "readiness" ? "socket-publication" : "ownership", error);
            publishResult("blocked", home, initialAdmissionFailure(stage, error, id));
          }
        }
      } finally {
        if (late && ticket === generation) {
          if (admitted && result) {
            participating = true; observed.add(id);
            publish(result.kind, result.home); watchSignals();
          } else if (v0Managed && result) {
            participating = false; ownershipVerified = false; epoch = null; discoverable = false;
            publish(result.kind, result.home, result.blockers[0]?.detail);
          } else if (preparationPending && result?.kind === "ordinary" && !setupFailure) {
            publish("ordinary", null);
          } else {
            let detail = `late-admission-${stage}-failed. ${result?.blockers[0]?.detail ?? VERIFY}`;
            try { await release(); } catch { detail = `late-admission-lock-release-failed. ${detail}`; }
            if (ticket === generation) {
              participating = false; ownershipVerified = false; epoch = null; discoverable = false;
              publish("ordinary", null, detail); ports.warnOnce(id, detail);
            }
          }
        }
      }
    });
  }
  const notify = (ctx: ExtensionContext) => {
    const message = reason();
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    else process.stderr.write(message + "\n");
  };

  pi.on("session_start", async (_event, ctx) => start(ctx));
  pi.on("session_shutdown", async event => {
    // Pi starts shutdown from its prepended signal listener before other listeners run.
    await Promise.resolve();
    unwatchSignals();
    if (v0Control) await closeV0Control();
    if (!v0Managed && !signalled && event.reason !== "reload" && participating && ordinaryWorkAllowed()) await ports.stopped?.(sessionId);
  });
  pi.on("input", (_event, ctx) => {
    if (ordinaryWorkAllowed()) return undefined;
    notify(ctx); return { action: "handled" };
  });
  pi.on("before_agent_start", (_event, ctx) => { if (!ordinaryWorkAllowed()) ctx.abort(); });
  pi.on("turn_start", (_event, ctx) => { if (!ordinaryWorkAllowed()) ctx.abort(); });
  pi.on("tool_call", () => ordinaryWorkAllowed() ? undefined : { block: true, reason: reason() });
  pi.on("user_bash", () => ordinaryWorkAllowed() ? undefined : {
    result: { output: reason(), exitCode: 1, cancelled: false, truncated: false },
  });
  pi.on("cache_warming_decision", () => ordinaryWorkAllowed() ? undefined : { action: "stop" });
  pi.on("session_before_compact", () => ordinaryWorkAllowed() ? undefined : { cancel: true });
  pi.on("session_before_tree", () => ordinaryWorkAllowed() ? undefined : { cancel: true });
  pi.on("session_before_fork", () => ordinaryWorkAllowed() ? undefined : { cancel: true });

  return {
    inspect: () => admission,
    async refreshInitialHome() {
      if (discoverable && !participating && ordinaryWorkAllowed() && admission.home === null && !freeze) {
        const version = ports.captureVersion?.() ?? null;
        if (version === null || version === captureVersion) return admission;
        captureVersion = version;
        if (preparationPending) {
          await start(lastContext, false, true);
          return admission;
        }
        const ticket = generation;
        let state: Awaited<ReturnType<AdmissionPorts["load"]>>;
        try { state = await ports.load(sessionId); }
        catch (error) {
          if (ticket === generation) {
            const detail = `late-${initialAdmissionFailure("load", error, sessionId)}`;
            discoverable = false; publish("ordinary", null, detail); ports.warnOnce(sessionId, detail);
          }
          return admission;
        }
        if (ticket !== generation || !discoverable || !ordinaryWorkAllowed() || freeze || !state.participating) return admission;
        // Late checks never withdraw ordinary admission from a running nonparticipant.
        // Publish participation only after the complete ownership/readiness path succeeds.
        await start(lastContext, false, true);
        return admission;
      }
      const eligible = () => participating && held?.valid && ordinaryWorkAllowed() && admission.home === null && !freeze && epoch !== null;
      const ownedEpoch = epoch;
      if (!eligible() || ownedEpoch === null) return admission;
      const ticket = generation;
      await sequence(async () => {
        if (ticket !== generation || !eligible()) return;
        const state = await ports.load(sessionId), home = state.home;
        if (!home || home.sessionId !== sessionId || home.epoch !== ownedEpoch || home.moveId !== null || !state.participating || !state.captureSafe ||
            state.initialConflict || state.unfinishedFreeze || !state.states.length || state.states.some(row => row.sessionId !== sessionId || row.state !== "active" || row.epoch !== ownedEpoch)) return;
        const machine = await ports.localMachine();
        if (ticket !== generation || !eligible() || home.machineId !== machine || state.origin !== machine) return;
        // The process already holds this epoch and lock. Formalizing its origin
        // must pass the same readiness/ownership path, not advance its fence.
        await ports.ready?.(sessionId, sessionFile, ownedEpoch, home);
        if (ticket === generation && eligible()) publish("ordinary", home);
      });
      return admission;
    },
    async whenSettled() {
      for (;;) {
        const current = transition;
        await current;
        if (current === transition) return admission;
      }
    },
    async close() { unwatchSignals(); ++generation; publish("blocked", admission.home, VERIFY); await sequence(async () => { if (v0Control) await closeV0Control(); await release(); }); },
    async freeze(moveId, expectedEpoch) {
      if (v0Managed) throw new Error("V0 sessions stop without a freeze fence.");
      const sameFreeze = freeze?.moveId === moveId && freeze.epoch === expectedEpoch && admission.kind === "control-only";
      if (!participating || !ownershipVerified || !held?.valid || !moveId || epoch !== expectedEpoch || (!ordinaryWorkAllowed() && !sameFreeze) ||
          freeze && (freeze.moveId !== moveId || freeze.epoch !== expectedEpoch)) throw new Error(VERIFY);
      ++generation; freeze = { moveId, epoch: expectedEpoch }; publish("control-only", admission.home, FROZEN);
      await sequence(async () => {});
    },
    async readmit(moveId, source, restored) {
      if (v0Managed) throw new Error("V0 sessions do not use legacy readmission proofs.");
      const ticket = generation;
      await sequence(async () => {
        if (!participating || !ownershipVerified || !held?.valid || !freeze || freeze.moveId !== moveId || freeze.epoch !== source.epoch ||
            epoch !== source.epoch || source.sessionId !== sessionId || restored.sessionId !== sessionId || restored.machineId !== source.machineId ||
            restored.epoch !== source.epoch + 2 || restored.moveId !== rollbackMoveId(moveId) || admission.kind !== "control-only") throw new Error(VERIFY);
        const state = await ports.load(sessionId), current = state.home;
        if (ticket !== generation || !held?.valid || !current || current.machineId !== restored.machineId || current.epoch !== restored.epoch || current.moveId !== restored.moveId ||
            current.updatedAt !== restored.updatedAt || !state.participating || !state.captureSafe || state.initialConflict || !state.states.length ||
            state.states.some(row => row.sessionId !== sessionId || row.state !== "active" || row.epoch !== restored.epoch || row.moveId !== restored.moveId) ||
            await ports.localMachine() !== restored.machineId) throw new Error(VERIFY);
        epoch = restored.epoch; freeze = undefined; publish("ordinary", restored);
      });
    },
    async unfreeze(moveId, expectedEpoch) {
      if (!freeze || freeze.moveId !== moveId || freeze.epoch !== expectedEpoch || !sessionId) throw new Error(VERIFY);
      const ctx = lastContext ?? { sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile } } as ExtensionContext;
      await start(ctx, true);
      if (!ordinaryWorkAllowed()) throw new Error(VERIFY);
    },
  };
}

/** Admission validates and closes synchronously before intake can close. */
export async function freezeAdmissionAndIntake<T>(gate: AdmissionGate, moveId: string, epoch: number, closeIntake: () => Promise<T>): Promise<T> {
  await gate.freeze(moveId, epoch);
  return closeIntake();
}

/** Pi dispatches extension commands before input hooks, so host-owned commands need the same gate. */
export function protectAdmissionApi<T extends ExtensionAPI>(pi: T, gate: AdmissionGate): T {
  const ordinaryWorkAllowed = () => isOrdinaryWorkAllowed(gate.inspect());
  return new Proxy(pi, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    if (key === "registerCommand" || key === "registerShortcut") return (name: string, command: { handler: (...args: unknown[]) => unknown }) => value.call(target, name, {
      ...command, handler: (...args: unknown[]) => {
        const arg = typeof args[0] === "string" ? args[0].trim() : "";
        const readOnlyDoctor = key === "registerCommand" && (name === "doctor" && arg === "" || name === "spider" && arg === "roam doctor");
        // The automatic handler validates its token and rechecks admission itself.
        // It must see a refusal so it can clear the queued attempt without a toast.
        const queuedReload = key === "registerCommand" && name === "spider-reload" && arg.startsWith(AUTO_RELOAD_ARG);
        if (ordinaryWorkAllowed() || readOnlyDoctor || queuedReload) return command.handler(...args);
        const detail = gate.inspect().blockers[0]?.detail ?? VERIFY;
        const ctx = args[key === "registerCommand" ? 1 : 0] as ExtensionContext | undefined;
        if (ctx?.hasUI) ctx.ui.notify(detail, "warning"); else process.stderr.write(detail + "\n");
        return undefined;
      },
    });
    if (key === "exec") return (...args: unknown[]) => ordinaryWorkAllowed()
      ? value.apply(target, args) : Promise.reject(new Error(gate.inspect().blockers[0]?.detail ?? VERIFY));
    if (key === "sendMessage") return (...args: unknown[]) => {
      if (!ordinaryWorkAllowed()) throw new AdmissionClosedError(gate.inspect().blockers[0]?.detail ?? VERIFY);
      return value.apply(target, args);
    };
    if (key === "sendUserMessage" || key === "appendEntry") return (...args: unknown[]) =>
      ordinaryWorkAllowed() ? value.apply(target, args) : undefined;
    return value.bind(target);
  } });
}

interface ParticipantCache { known: Set<string>; warned: Set<string> }
const CACHE = Symbol.for("spider.roam.admission-cache.v1");
const host = globalThis as typeof globalThis & { [CACHE]?: Map<string, ParticipantCache> };
const caches = host[CACHE] ??= new Map<string, ParticipantCache>();
function participantCache(root: string): ParticipantCache {
  const key = resolve(root);
  let cache = caches.get(key);
  if (!cache) { cache = { known: new Set(), warned: new Set() }; caches.set(key, cache); }
  return cache;
}
function hasTable(db: Db, name: string): boolean {
  return Boolean(db.withRetry(() => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)));
}

function assertIntentOwner(global: Db, home: Home | null, intent: HostIntent, owner: ParticipantIntentOwner, config: RoamConfig): void {
  const refuse = () => { throw new Error("participant-owner-unproved"); };
  if (!home || home.sessionId !== intent.sessionId || home.epoch !== intent.epoch || home.moveId !== intent.moveId ||
      home.machineId !== owner.machineId || owner.machineId !== config.machineId) return refuse();
  switch (owner.kind) {
    case "box-participant":
      assertBoxEnrollment(config);
      if (owner.hubMachineId !== config.hubMachineId) return refuse();
      return;
    case "hub-return":
    case "hub-restoration": {
      if (config.role !== "hub" || owner.machineId !== config.hubMachineId || !home.moveId) return refuse();
      const privateDb = openDbReadOnlyAt(join(paths.globalRoot, "roam", "journal.db"));
      if (!privateDb) return refuse();
      try {
        const operation = privateDb.prepare("SELECT kind,machine_id,expected_epoch FROM roam_operations WHERE operation_id=?").get(owner.moveId) as
          { kind: string; machine_id: string; expected_epoch: number | null } | undefined;
        const committed = global.prepare("SELECT committed_home_json FROM roam_home_actions WHERE move_id=?").get(home.moveId) as { committed_home_json: string | null } | undefined;
        if (!operation || operation.machine_id !== owner.machineId || !committed?.committed_home_json ||
            !isDeepStrictEqual(JSON.parse(committed.committed_home_json), home)) return refuse();
        if (owner.kind === "hub-restoration") {
          const record = privateDb.prepare("SELECT result_json FROM roam_operation_actions WHERE operation_id=? AND action='forget-home'").get(owner.moveId) as { result_json: string } | undefined;
          const proof = record ? JSON.parse(record.result_json) as { source: Home; home: Home } : null;
          if (operation.kind !== "restore-destroyed-home" || operation.expected_epoch !== home.epoch || owner.moveId !== home.moveId ||
              !proof?.source || proof.source.sessionId !== home.sessionId || proof.source.machineId !== owner.revokedMachineId ||
              proof.source.epoch + 1 !== home.epoch || !isDeepStrictEqual(proof.home, home) || !isRevoked(privateDb, owner.revokedMachineId)) return refuse();
        } else {
          if (operation.kind !== "move") return refuse();
          const records = privateDb.prepare("SELECT result_json FROM roam_operation_actions WHERE operation_id=? AND action='move-action-complete'").all(owner.moveId) as { result_json: string }[];
          const check = records.map(row => JSON.parse(row.result_json) as { action: string; value?: { source?: Home } }).find(row => row.action === "check");
          const source = check?.value?.source, rollback = home.moveId === rollbackMoveId(owner.moveId);
          if (!source || !isMachineId(source.machineId) || source.sessionId !== home.sessionId || source.epoch + (rollback ? 2 : 1) !== home.epoch ||
              (rollback ? source.machineId !== owner.machineId : home.moveId !== owner.moveId)) return refuse();
        }
      } finally { privateDb.close(); }
      return;
    }
    default: {
      const unknown: never = owner;
      throw new Error(`Unknown participant intent owner: ${String(unknown)}`);
    }
  }
}

/** Production ports perform read-only discovery before resolving identity or claiming locks. */
export function createAdmissionPorts(options: ParticipantLockOptions = {}): AdmissionPorts & { setContext(ctx: ExtensionContext): void } {
  let context: ExtensionContext | undefined;
  let machineIds: string[] = [];
  let discoveryAllowed = false, discoveryFiles: string[] = [];
  let configVersion: string | undefined, config: RoamConfig | null = null;
  let participantVersion: string | undefined, participantReady = false;
  const fileVersion = (file: string): string => {
    try {
      const stat = lstatSync(file, { bigint: true });
      return `${file}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch { return `${file}:unavailable`; }
  };
  const dbVersion = (file: string) => `${fileVersion(file)}|${fileVersion(`${file}-wal`)}`;
  const cache = () => participantCache(paths.globalRoot);
  return {
    ...productionParticipantAdmission(() => context?.cwd),
    expectedEpoch: null,
    lockUntracked() { try { const current = readLocalIdentity(paths.globalRoot); return current.enabled && current.role === "hub"; } catch { return false; } },
    setContext(ctx) { context = ctx; },
    knownParticipant(id) { return cache().known.has(id); },
    captureVersion() {
      if (!discoveryAllowed || !context) return null;
      const root = paths.globalRoot;
      const observed = `${fileVersion(join(root, 'roam', 'config.json'))}|${fileVersion(join(root, 'roam', 'machine.json'))}`;
      if (configVersion !== observed) {
        configVersion = observed;
        try { config = readLocalIdentity(root); } catch { config = null; }
      }
      if (!config || config.role === 'hub' && !config.enabled) return null;
      // A box's enabled flag controls the hub scheduler, not participation.
      // Its configured global capture is the existing participation boundary.
      if (config.role === 'box') {
        const version = dbVersion(join(root, 'spider.db'));
        if (participantVersion !== version) {
          participantVersion = version;
          participantReady = participantCaptureReady(root, config.machineId);
        }
        if (!participantReady) return null;
      }
      const file = context.sessionManager.getSessionFile();
      return `${observed}|${file ? fileVersion(file) : 'no-session-file'}|${discoveryFiles.map(dbVersion).join('|')}`;
    },
    setupDiagnostic(id, failure) {
      const db = openDb(join(paths.globalRoot, "spider.db"), { fileMustExist: true, checkpointOnClose: false });
      try { recordMoveSetupFailure(db, id, failure); } finally { db.close(); }
    },
    warnOnce(id, reason) {
      if (cache().warned.has(id)) return;
      cache().warned.add(id);
      if (context?.hasUI) context.ui.notify(reason, "warning");
      else process.stderr.write(reason + "\n");
    },
    async localMachine() {
      const machine = readMachineIdentity(paths.globalRoot);
      if (machineIds.some(id => id !== machine)) throw new Error("Recorded machine identity does not match local stores");
      return machine;
    },
    async lock(id, file) { return lockParticipant(join(paths.globalRoot, "herdr"), id, file, options); },
    async load(id) {
      discoveryAllowed = false;
      let failed = false, failure: unknown;
      const attempt = <T>(read: () => T): T | undefined => {
        try { return read(); } catch (error) { if (!failed) failure = error; failed = true; return undefined; }
      };
      const global = attempt(() => openGlobalReadOnly());
      const opened = new Map<string, Db>();
      const states: SessionState[] = [];
      const origins = new Set<string>();
      let missing = 0;
      const addStore = (db: Db | undefined) => {
        if (!db) { missing++; return; }
        const name = resolve(db.raw.name);
        if (opened.has(name)) { db.close(); return; }
        opened.set(name, db);
        if (!hasTable(db, "roam_sessions")) return;
        const state = readSessionState(db, id);
        if (state) { states.push(state); cache().known.add(id); }
        if (hasTable(db, "sessions")) {
          const row = db.withRetry(() => db.prepare("SELECT origin_machine FROM sessions WHERE id = ?").get(id)) as { origin_machine: string } | undefined;
          if (row?.origin_machine) origins.add(row.origin_machine);
        }
      };
      try {
        // Independent reads still run after one failure, so an accessible participant row is not hidden.
        attempt(() => {
          if (!context?.cwd) throw new Error("Session working directory is unavailable");
          addStore(openDbReadOnlyAt(join(paths.projectRoot(context.cwd), "project.db")));
        });
        type HomeRow = { session_id: string; machine_id: string; epoch: number; move_id: string | null; updated_at: number };
        const homeRow = global ? attempt(() => {
          const row = hasTable(global, "session_homes")
            ? global.withRetry(() => global.prepare("SELECT session_id, machine_id, epoch, move_id, updated_at FROM session_homes WHERE session_id = ?").get(id)) as HomeRow | undefined
            : undefined;
          if (row) cache().known.add(id);
          if (row && (row.session_id !== id || typeof row.machine_id !== "string" || !Number.isSafeInteger(row.epoch) || row.epoch < 1 ||
            !(row.move_id === null || typeof row.move_id === "string") || !Number.isSafeInteger(row.updated_at))) throw new Error("Invalid session home");
          return row;
        }) : undefined;
        if (global) {
          const binding = attempt(() => hasTable(global, "session_bindings") ? global.withRetry(() => getBinding(global, id)) : undefined);
          if (binding) attempt(() => addStore(openDbReadOnlyAt(join(paths.projectRoot(binding), "project.db"))));
          const keys = attempt(() => {
            const location = hasTable(global, "roam_locations")
              ? global.withRetry(() => global.prepare("SELECT stores_json FROM roam_locations WHERE session_id = ?").get(id)) as { stores_json: string } | undefined
              : undefined;
            if (!location) return [];
            const value: unknown = JSON.parse(location.stores_json);
            if (!Array.isArray(value) || value.some(key => typeof key !== "string")) throw new Error("Invalid session store roster");
            return [...new Set(value.filter((key): key is StoreKey => typeof key === "string" && key.startsWith("worktree:")))];
          });
          for (const key of keys ?? []) attempt(() => addStore(global.withRetry(() => openRoamStoreReadOnly(global, key))));
        }
        if (failed) throw failure ?? new Error("Session ownership read failed");
        const home: Home | null = homeRow?.machine_id ? { sessionId: id, machineId: homeRow.machine_id, epoch: homeRow.epoch, moveId: homeRow.move_id, updatedAt: homeRow.updated_at } : null;
        const participating = Boolean(homeRow || states.length);
        if (!participating) {
          discoveryAllowed = [...opened.values()].every(db => {
            if (!hasTable(db, 'roam_meta')) return false;
            const meta = db.withRetry(() => db.prepare('SELECT roamable,problem FROM roam_meta WHERE id=1').get()) as { roamable: number; problem: string | null } | undefined;
            return meta?.roamable === 1 && meta.problem === null;
          });
          discoveryFiles = [...new Set([join(paths.globalRoot, 'spider.db'),
            ...(context?.cwd ? [join(paths.projectRoot(context.cwd), 'project.db')] : []), ...opened.keys()])];
        }
        let captureSafe = true, unfinishedFreeze = false;
        let freezeRecovery: { moveId: string; epoch: number } | undefined;
        machineIds = [];
        if (participating) {
          if (global && hasTable(global, "roam_cursors") && global.withRetry(() =>
            readLocal(global, "participant-origin", id) !== undefined || readLocal(global, "participant-intent", id) !== undefined)) {
            let config;
            try { config = readLocalIdentity(paths.globalRoot); } catch { throw new Error("participant-config-unavailable"); }
            const authority = createRunningIntentAuthority(global), owned = authority.owned(id);
            if (owned) assertIntentOwner(global, home, owned.intent, owned.owner, config);
            else assertBoxEnrollment(config);
            if (!participantCaptureInitialized(global, config.machineId, "global")) throw new Error("participant-capture-uninitialized");
          }
          captureSafe = Boolean(global) && missing === 0 && states.length === opened.size;
          for (const db of opened.values()) {
            const meta = db.withRetry(() => db.prepare("SELECT machine_id, store_key, capture_enabled, importing, roamable, problem FROM roam_meta WHERE id = 1").get()) as
              { machine_id: string; store_key: string | null; capture_enabled: number; importing: number; roamable: number; problem: string | null } | undefined;
            if (!meta || !meta.machine_id || !meta.store_key || meta.capture_enabled !== 1 || meta.importing !== 0 || meta.roamable !== 1 || meta.problem !== null ||
              !db.withRetry(() => validateRoamLayout(db, "worktree")).captureSafe) captureSafe = false;
            if (meta?.machine_id) machineIds.push(meta.machine_id);
          }
          if (global) {
            const meta = hasTable(global, "roam_meta")
              ? global.withRetry(() => global.prepare("SELECT machine_id FROM roam_meta WHERE id = 1").get()) as { machine_id: string } | undefined
              : undefined;
            if (meta?.machine_id) machineIds.push(meta.machine_id); else captureSafe = false;
          }
          const journal = openDbReadOnlyAt(join(paths.globalRoot, "roam", "journal.db"));
          if (journal) {
            try {
              const entry = journal.withRetry(() => journal.prepare("SELECT type FROM sqlite_master WHERE name = ? COLLATE NOCASE").get("freeze_journal")) as { type: string } | undefined;
              if (entry) {
                if (entry.type !== "table") throw new Error("Invalid freeze journal");
                const columns = journal.withRetry(() => journal.prepare("PRAGMA table_info(freeze_journal)").all()) as { name: string; type: string }[];
                if (!["session_id", "state"].every(name => columns.some(column => column.name.toLowerCase() === name && column.type.trim().toUpperCase() === "TEXT"))) {
                  throw new Error("Invalid freeze journal");
                }
                unfinishedFreeze = Boolean(journal.withRetry(() => journal.prepare(
                  "SELECT 1 FROM freeze_journal WHERE session_id COLLATE BINARY = ? AND (state IS NULL OR state COLLATE BINARY NOT IN ('complete', 'aborted')) LIMIT 1",
                ).get(id)));
                if (unfinishedFreeze && ["move_id", "epoch"].every(name => columns.some(column => column.name.toLowerCase() === name))) {
                  const rows = journal.withRetry(() => journal.prepare(
                    "SELECT move_id,epoch,state FROM freeze_journal WHERE session_id COLLATE BINARY = ? AND (state IS NULL OR state COLLATE BINARY NOT IN ('complete', 'aborted')) LIMIT 2",
                  ).all(id)) as { move_id: unknown; epoch: unknown; state: unknown }[];
                  const row = rows[0];
                  if (rows.length === 1 && typeof row.move_id === "string" && row.move_id.length > 0 &&
                      Number.isSafeInteger(row.epoch) && (row.epoch as number) > 0 && ["freezing", "frozen", "aborting"].includes(String(row.state)))
                    freezeRecovery = { moveId: row.move_id, epoch: row.epoch as number };
                }
              }
            } finally { journal.close(); }
          }
        }
        return { home, states, origin: origins.size === 1 ? [...origins][0] : null, participating, captureSafe, unfinishedFreeze,
          ...(freezeRecovery ? { freezeRecovery } : {}), initialConflict: Boolean(homeRow && !homeRow.machine_id) || origins.size > 1 };
      } finally {
        for (const db of opened.values()) db.close();
        global?.close();
      }
    },
  };
}
