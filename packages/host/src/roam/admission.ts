import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Blocker, Home, MachineId, SessionState, StoreKey } from "@spider/db-core/roam/types";
import { getBinding, openDbReadOnlyAt, openGlobalReadOnly, paths, type Db } from "@spider/db-core";
import { readMachineIdentity } from "@spider/db-core/roam/machine";
import { readLocal } from "@spider/db-core/roam/local-state";
import { readLocalIdentity } from "@spider/roam/runtime";
import { assertBoxEnrollment, participantCaptureInitialized } from "@spider/roam/session-control";
import { validateRoamLayout } from "@spider/db-core/roam/layout";
import { openRoamStoreReadOnly } from "@spider/db-core/roam/reads";
import { readSessionState } from "@spider/db-core/roam/state";
import { join, resolve } from "node:path";
import { lockParticipant, type ParticipantLockOptions } from "../herdr/ports.js";
import { ordinaryWorkAllowed as isOrdinaryWorkAllowed } from "./activation.js";
import { productionParticipantAdmission } from "./readiness.js";

export interface Admission { kind: "pending" | "ordinary" | "control-only" | "blocked"; home: Home | null; blockers: readonly Blocker[] }
export interface AdmissionGate {
  inspect(): Admission;
  whenSettled(): Promise<Admission>;
  close(): Promise<void>;
  freeze(moveId: string, epoch: number): Promise<void>;
  unfreeze(moveId: string, epoch: number): Promise<void>;
}
export interface AdmissionPorts {
  expectedEpoch: number | null;
  localMachine(): Promise<MachineId>;
  knownParticipant(sessionId: string): boolean;
  warnOnce(sessionId: string, reason: string): void;
  load(sessionId: string): Promise<{ home: Home | null; states: readonly SessionState[]; origin: MachineId | null;
    participating: boolean; captureSafe: boolean; unfinishedFreeze: boolean; initialConflict: boolean }>;
  lock(sessionId: string, file: string): Promise<() => Promise<void>>;
  setContext?(ctx: ExtensionContext): void;
  prepare?(sessionId: string, file: string): Promise<void>;
  ready?(sessionId: string, file: string, epoch: number, home: Home | null): Promise<void>;
  stopped?(sessionId: string): Promise<void>;
}

const VERIFY = "Cannot verify this session's home. Retry or run /spider roam doctor for details.";
const FROZEN = "This session is frozen for a move. Run /spider roam doctor for details.";
const homeMessage = (machine: string) => `This session is at ${machine}. Run /spider roam doctor for details.`;
const admissionFailure = (error: unknown) => error instanceof Error && ["participant-config-unavailable", "participant-not-box", "participant-capture-uninitialized"].includes(error.message)
  ? `${error.message}. Run /spider roam doctor for details.` : VERIFY;

/** A blocked send must be distinguishable from a delivered message. */
export class AdmissionClosedError extends Error {
  readonly code = "SPIDER_ADMISSION_CLOSED";
  constructor(message: string) { super(message); this.name = "AdmissionClosedError"; }
}

export function registerAdmission(pi: ExtensionAPI, ports: AdmissionPorts): AdmissionGate {
  let handoffRequired = process.env.SPIDER_HERDR_HANDOFF_FILE !== undefined;
  if (process.env.PI_SUBAGENT_CHILD === "1" && !handoffRequired) {
    const child: Admission = { kind: "ordinary", home: null, blockers: [] };
    return { inspect: () => child, whenSettled: async () => child, close: async () => {}, freeze: async () => { throw new Error(VERIFY); }, unfreeze: async () => { throw new Error(VERIFY); } };
  }
  let admission: Admission = { kind: "ordinary", home: null, blockers: [] };
  const ordinaryWorkAllowed = () => isOrdinaryWorkAllowed(admission);
  let sessionId = "", sessionFile = "", epoch: number | null = null, participating = false, generation = 0;
  let held: { sessionId: string; file: string; release: () => Promise<void>; valid: boolean } | undefined;
  let transition: Promise<void> = Promise.resolve();
  let freeze: { moveId: string; epoch: number } | undefined;
  let lastContext: ExtensionContext | undefined;
  const observed = new Set<string>();

  function publish(kind: Admission["kind"], home: Home | null, detail?: string): void {
    admission = { kind, home, blockers: detail ? [{ kind: "admission", id: sessionId, detail }] : [] };
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
  async function start(ctx: ExtensionContext | undefined, reopening = false): Promise<void> {
    const id = ctx?.sessionManager?.getSessionId?.() ?? "";
    const file = ctx?.sessionManager?.getSessionFile?.() ?? "";
    const ticket = ++generation;
    publish("pending", null);
    await sequence(async () => {
      if (ticket !== generation) return;
      if (ctx) { lastContext = ctx; ports.setContext?.(ctx); }
      try { if (held && (!held.valid || held.sessionId !== id || held.file !== file)) await release(); }
      catch { if (ticket === generation) { sessionId = id; publish("blocked", null, VERIFY); } return; }
      if (ticket !== generation) return;
      sessionId = id; sessionFile = file; epoch = null; participating = false;
      if (!id) { publish(handoffRequired ? "blocked" : "ordinary", null, handoffRequired ? VERIFY : undefined); return; }
      try { await ports.prepare?.(id, file); }
      catch (error) { if (ticket === generation) publish("blocked", null, admissionFailure(error)); return; }
      let state: Awaited<ReturnType<AdmissionPorts["load"]>>;
      try {
        state = await ports.load(id);
      } catch (error) {
        if (ticket !== generation) return;
        if (handoffRequired || observed.has(id) || ports.knownParticipant(id)) publish("blocked", null, admissionFailure(error));
        else { ports.warnOnce(id, VERIFY); publish("ordinary", null); }
        return;
      }
      if (ticket !== generation) return;
      participating = state.participating;
      if (!state.participating) {
        if (handoffRequired || observed.has(id) || ports.knownParticipant(id)) publish("blocked", null, VERIFY);
        else { freeze = undefined; publish("ordinary", null); }
        return;
      }
      observed.add(id);
      const home = state.home;
      epoch = home?.epoch ?? state.states[0]?.epoch ?? null;
      if (state.initialConflict) { publish("blocked", home, "This session has conflicting initial homes. Run /spider roam doctor for details."); return; }
      const frozenState = state.states.find(row => row.state === "frozen");
      if (frozenState?.moveId) freeze ??= { moveId: frozenState.moveId, epoch: frozenState.epoch };
      if (!reopening && (freeze || state.unfinishedFreeze || frozenState)) {
        publish("control-only", home, FROZEN); return;
      }
      if (state.unfinishedFreeze || frozenState) { publish("control-only", home, FROZEN); return; }
      if (!state.captureSafe || !state.states.length || state.states.some(row => row.sessionId !== id || row.state !== "active" || row.epoch !== epoch) ||
        epoch === null || ports.expectedEpoch !== null && ports.expectedEpoch !== epoch) {
        publish("blocked", home, VERIFY); return;
      }
      try {
        const machine = await ports.localMachine();
        if (ticket !== generation) return;
        if (!machine || (home ? home.sessionId !== id || home.machineId !== machine : state.origin !== machine || epoch !== 1)) {
          publish("blocked", home, home?.machineId ? homeMessage(home.machineId) : VERIFY); return;
        }
        if (!file) { publish("blocked", home, VERIFY); return; }
        if (!held) {
          const unlock = await ports.lock(id, file);
          held = { sessionId: id, file, release: unlock, valid: true };
          handoffRequired = false;
          if (ticket !== generation) { await release(); return; }
        }
        await ports.ready?.(id, file, epoch, home);
        if (ticket !== generation) return;
        if (reopening) freeze = undefined;
        publish("ordinary", home);
      } catch {
        if (ticket === generation) publish("blocked", home, VERIFY);
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
    if (event.reason !== "reload" && participating && ordinaryWorkAllowed()) await ports.stopped?.(sessionId);
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
    async whenSettled() {
      for (;;) {
        const current = transition;
        await current;
        if (current === transition) return admission;
      }
    },
    async close() { ++generation; publish("blocked", admission.home, VERIFY); await sequence(release); },
    async freeze(moveId, expectedEpoch) {
      const sameFreeze = freeze?.moveId === moveId && freeze.epoch === expectedEpoch && admission.kind === "control-only";
      if (!participating || !held?.valid || !moveId || epoch !== expectedEpoch || (!ordinaryWorkAllowed() && !sameFreeze) ||
          freeze && (freeze.moveId !== moveId || freeze.epoch !== expectedEpoch)) throw new Error(VERIFY);
      ++generation; freeze = { moveId, epoch: expectedEpoch }; publish("control-only", admission.home, FROZEN);
      await sequence(async () => {});
    },
    async unfreeze(moveId, expectedEpoch) {
      if (!freeze || freeze.moveId !== moveId || freeze.epoch !== expectedEpoch || !sessionId) throw new Error(VERIFY);
      const ctx = lastContext ?? { sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile } } as ExtensionContext;
      await start(ctx, true);
      if (!ordinaryWorkAllowed()) throw new Error(VERIFY);
    },
  };
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
        if (ordinaryWorkAllowed() || readOnlyDoctor) return command.handler(...args);
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

/** Production ports perform read-only discovery before resolving identity or claiming locks. */
export function createAdmissionPorts(options: ParticipantLockOptions = {}): AdmissionPorts & { setContext(ctx: ExtensionContext): void } {
  let context: ExtensionContext | undefined;
  let machineIds: string[] = [];
  const cache = () => participantCache(paths.globalRoot);
  return {
    ...productionParticipantAdmission(() => context?.cwd),
    expectedEpoch: null,
    setContext(ctx) { context = ctx; },
    knownParticipant(id) { return cache().known.has(id); },
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
        let captureSafe = true, unfinishedFreeze = false;
        machineIds = [];
        if (participating) {
          if (global && hasTable(global, "roam_cursors") && global.withRetry(() =>
            readLocal(global, "participant-origin", id) !== undefined || readLocal(global, "participant-intent", id) !== undefined)) {
            let config;
            try { config = readLocalIdentity(paths.globalRoot); } catch { throw new Error("participant-config-unavailable"); }
            assertBoxEnrollment(config);
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
              }
            } finally { journal.close(); }
          }
        }
        return { home, states, origin: origins.size === 1 ? [...origins][0] : null, participating, captureSafe, unfinishedFreeze,
          initialConflict: Boolean(homeRow && !homeRow.machine_id) || origins.size > 1 };
      } finally {
        for (const db of opened.values()) db.close();
        global?.close();
      }
    },
  };
}
