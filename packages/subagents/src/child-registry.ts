// Process-wide child registry that lets running subagents outlive a /reload.
//
// Why globalThis: a rebuilt bundle is a different module instance, so a module-level Map
// dies with the old build. The OS process (and with it every ChildProcess and its pipes)
// survives, so the live handles are parked on globalThis under a VERSIONED Symbol.for key.
//
// Contract (version 1) is plain data plus one method:
//   { version: 1, entries: Map<runId, SharedChildEntry>, tailCursors: Map<sessionId, number>,
//     disposeSession(sessionId, reason): Promise<void> }
// All behaviour lives in the module functions below and operates on that shared data, so a
// different build with the same version reads and writes the same structure. Anything that
// changes the data semantics MUST bump CHILD_REGISTRY_VERSION (new key). A build never
// reads a version it does not implement; foreign versions are only ever cleaned up through
// their own `disposeSession` (see disposeSessionRegistries) and their own build's TTL sweeper.
//
// Session scope: the registry is process-wide but every operation names ONE session (park on
// reload, adopt, dispose on quit/new/resume/fork, the TTL). A reload or quit of session A never
// touches session B's children. The closures an older build left on an entry (`deliver`, the
// expiry timer) keep running after a newer build adopts it, so their behaviour is part of the
// contract too, not only the shape of the data.
import { commandEnv, openDb, type Db } from "@spider/db-core";
import { execFileSync } from "node:child_process";
import { PERSISTED_EVENT_TYPES, type SteerAck } from "./rpc-child";
import { RunStore } from "./run-store";
import { emitStatus } from "./run-events";
import { decideOutcome, summarizeCompletionEvents } from "./completion-output";
import { shutdownReason } from "./shutdown-reason";
import { checkProcessIdentity } from "./process-identity";

export const CHILD_REGISTRY_VERSION = 1;
const KEY_PREFIX = "spider.childRegistry.v";
export const CHILD_REGISTRY_KEY: symbol = Symbol.for(`${KEY_PREFIX}${CHILD_REGISTRY_VERSION}`);

/** A detached child that nobody adopts within this window is killed and its run cancelled. */
export const DEFAULT_DETACH_TTL_MS = 60_000;
const DEFAULT_GRACE_MS = 250;

export interface ExitInfo { exitCode: number; result?: string }

/** Structural subset of the runner's ChildHandle that must survive across builds. */
export interface SharedHandle {
  pid?: number;
  startTime?: string | null;
  wait(): Promise<ExitInfo>;
  kill(reason?: string): void;
  killAsync?(graceMs?: number, reason?: string): Promise<void>;
  steer?(message: string): Promise<SteerAck>;
  /** Route RPC events to `sink` and flush anything buffered while unbound. */
  bindEvents?(sink: (event: Record<string, any>) => void): void;
  /** Start buffering RPC events instead of calling the (dead) previous sink. */
  unbindEvents?(): void;
}

export type CompletionSink = (entry: SharedChildEntry, exit: ExitInfo) => unknown;

export interface SharedChildEntry {
  runId: string;
  sessionId: string;
  dbPath: string;
  mode: "rpc" | "print";
  intercomSession?: string;
  pid?: number;
  startTime?: string | null;
  handle: SharedHandle;
  /** False for chain steps: their continuation lives in the activation, so reload kills them. */
  survivable: boolean;
  state: "attached" | "detached";
  detachedAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  /** How the current TTL timer was armed, so a failed adoption can re-arm it identically. */
  detachOpts?: DetachOpts;
  /** Set once, by the registry's single wait() observer. */
  exit?: ExitInfo;
  /** True once the completion was handed to a sink. Never reset: that is the exactly-once guard. */
  claimed: boolean;
  sink?: CompletionSink;
}

export interface ChildRegistryV1 {
  version: 1;
  entries: Map<string, SharedChildEntry>;
  /** Last event id a stopped tailer had read, per session, so the next tailer misses nothing. */
  tailCursors: Map<string, number>;
  /** Minimum contract every version must offer: kill what this registry holds for ONE session. */
  disposeSession(sessionId: string, reason: string): Promise<void>;
}

function isRegistryV1(value: unknown): value is ChildRegistryV1 {
  const v = value as Partial<ChildRegistryV1> | null | undefined;
  return !!v && v.version === CHILD_REGISTRY_VERSION && v.entries instanceof Map
    && v.tailCursors instanceof Map && typeof v.disposeSession === "function";
}

export async function killSharedEntry(entry: SharedChildEntry, reason: string, graceMs?: number): Promise<void> { await killEntry(entry, reason, graceMs); }

async function killEntry(entry: SharedChildEntry, reason: string, graceMs = DEFAULT_GRACE_MS): Promise<void> {
  try {
    if (entry.handle.killAsync) await entry.handle.killAsync(graceMs, reason);
    else entry.handle.kill(reason);
  } catch { /* best-effort: the TTL path and the reaper are the backstops */ }
}

function makeRegistry(): ChildRegistryV1 {
  const registry: ChildRegistryV1 = {
    version: 1,
    entries: new Map(),
    tailCursors: new Map(),
    disposeSession: (sessionId, reason) => disposeOwnSession(registry, sessionId, reason),
  };
  return registry;
}

/** The v1 registry, created on first use. A malformed object at our key is replaced, not trusted. */
export function sharedRegistry(): ChildRegistryV1 {
  const g = globalThis as Record<symbol, unknown>;
  const existing = g[CHILD_REGISTRY_KEY];
  if (isRegistryV1(existing)) return existing;
  const fresh = makeRegistry();
  g[CHILD_REGISTRY_KEY] = fresh;
  return fresh;
}

export function getShared(runId: string): SharedChildEntry | undefined {
  return sharedRegistry().entries.get(runId);
}

export interface SharedInit {
  runId: string;
  sessionId: string;
  dbPath: string;
  mode: "rpc" | "print";
  intercomSession?: string;
  handle: SharedHandle;
  survivable: boolean;
}

function deliver(entry: SharedChildEntry): void {
  if (entry.claimed || !entry.sink || entry.state !== "attached" || !entry.exit) return;
  entry.claimed = true;
  const sink = entry.sink;
  const exit = entry.exit;
  try {
    const out = sink(entry, exit);
    if (out && typeof (out as Promise<unknown>).catch === "function") (out as Promise<unknown>).catch(() => {});
  } catch { /* a sink failure must not break the observer */ }
}

/** Register a live child and attach the ONE exit observer. */
export function registerShared(init: SharedInit): SharedChildEntry {
  const reg = sharedRegistry();
  const entry: SharedChildEntry = {
    ...init, pid: init.handle.pid, startTime: init.handle.startTime, state: "attached", claimed: false,
  };
  reg.entries.set(init.runId, entry);
  const settle = (exit: ExitInfo) => { entry.exit = exit; deliver(entry); };
  let wait: Promise<ExitInfo>;
  try { wait = init.handle.wait(); } catch (error) { wait = Promise.reject(error); }
  wait.then(settle, error => settle({ exitCode: 1, result: `Child wait failed: ${String(error)}` }));
  return entry;
}

/** Install (or replace) the completion sink of an attached entry. */
export function setSink(runId: string, sink: CompletionSink | undefined): void {
  const entry = sharedRegistry().entries.get(runId);
  if (!entry) return;
  entry.sink = sink;
  deliver(entry);
}

export function releaseShared(runId: string): void {
  const reg = sharedRegistry();
  const entry = reg.entries.get(runId);
  if (!entry) return;
  clearTimeout(entry.timer);
  reg.entries.delete(runId);
}

export interface DetachOpts {
  ttlMs?: number;
  graceMs?: number;
  /** Replaces the default "finalize the run row by DB path" expiry step. Used by tests. */
  onExpire?: (entry: SharedChildEntry) => void | Promise<void>;
}

const TTL_REASON = "Run detached by a reload and never re-adopted by the reloaded extension; child terminated.";
const ACTIVE = ["queued", "running", "paused"];

/**
 * Finalize a run row from outside its activation, through a fresh connection by path (nothing the
 * old activation owns is touched). `finished` says the child had already exited when we decided:
 * then the row gets its REAL outcome from the exit and its recorded events, never "cancelled".
 * Otherwise it is cancelled with `cancelReason`. Synchronous, so it also works in a process
 * 'exit' hook. No-op when the row is already terminal.
 */
function finalizeRowByPath(entry: SharedChildEntry, cancelReason: string, finished: boolean): void {
  let db;
  try {
    db = openDb(entry.dbPath, { fileMustExist: true });
    const store = new RunStore(db);
    const row = store.get(entry.runId);
    if (!row || !ACTIVE.includes(row.status)) return;
    const notes = bufferedLossNotes(db, entry);
    if (finished && entry.exit) {
      const outcome = decideOutcome(db, entry.runId, entry.exit.exitCode, entry.exit.result);
      if (notes.length) outcome.result = [outcome.result, ...notes].filter(Boolean).join("\n\n");
      const runDb = db;
      runDb.transaction(() => {
        // Write first, with the same active-row guard as parent finalization. A sibling
        // may have finished since preflight; only the winning write emits a status.
        if (store.finish(entry.runId, outcome)) {
          emitStatus(runDb, { runId: entry.runId, sessionId: entry.sessionId, status: outcome.status, summary: row.name ?? undefined });
        }
      })();
    } else store.cancel(entry.runId, [cancelReason, ...notes].join("\n\n"));
  } catch (error) {
    try { console.warn(`Could not finalize detached run ${entry.runId}: ${String(error)}`); } catch { /* exiting */ }
    // Leave the original row for the reaper, never recreate a removed worktree's DB.
  }
  finally { try { db?.close(); } catch { /* best-effort */ } }
}

/** Never-adopted entries lose their gate on disposal. Drain to counts, not to a dead sink or
 *  event payloads, so the final row records that loss without copying steer or event bodies. */
function bufferedLossNotes(db: Db, entry: SharedChildEntry): string[] {
  let buffered = 0;
  const events: Record<string, any>[] = [];
  try {
    entry.handle.bindEvents?.(event => {
      if (!PERSISTED_EVENT_TYPES.includes(event.type)) return;
      events.push(event);
      if (typeof event.eventsLost !== "number") buffered++;
    });
  } catch { /* diagnostics cannot prevent finalization */ }
  const { steerSummary, eventsLost } = summarizeCompletionEvents(db, entry.runId, events);
  const notes: string[] = [];
  if (steerSummary) notes.push(steerSummary);
  if (buffered) notes.push(`${buffered} buffered child event(s) were not recorded because this run was never re-adopted.`);
  if (eventsLost) notes.push(`${eventsLost} child event(s) were lost during reload; this run's recorded history is incomplete.`);
  return notes;
}

function armTimer(entry: SharedChildEntry, opts: DetachOpts): void {
  clearTimeout(entry.timer);
  entry.detachOpts = opts;
  entry.timer = setTimeout(() => { void expire(entry, opts); }, opts.ttlMs ?? DEFAULT_DETACH_TTL_MS);
  entry.timer.unref?.();
}

async function expire(entry: SharedChildEntry, opts: DetachOpts): Promise<void> {
  const reg = sharedRegistry();
  if (reg.entries.get(entry.runId) !== entry || entry.state !== "detached" || entry.claimed) return;
  reg.entries.delete(entry.runId);
  const finished = !!entry.exit;
  if (!finished) await killEntry(entry, "Detached child was not re-adopted after reload.", opts.graceMs);
  try { await (opts.onExpire ? opts.onExpire(entry) : finalizeRowByPath(entry, TTL_REASON, finished)); } catch { /* best-effort */ }
}

/**
 * Reload, step one (synchronous): park this session's survivable children (sink dropped, events
 * unbound, TTL armed). Entries that cannot survive (foreground chain steps) are removed and
 * returned for the caller to kill. Other sessions' entries are never touched, and an entry that is
 * already detached keeps its original TTL.
 */
export function parkSession(sessionId: string, opts: DetachOpts = {}): SharedChildEntry[] {
  const reg = sharedRegistry();
  const doomed: SharedChildEntry[] = [];
  let parked = false;
  for (const entry of [...reg.entries.values()]) {
    if (entry.sessionId !== sessionId) continue;
    if (!entry.survivable) { clearTimeout(entry.timer); doomed.push(entry); reg.entries.delete(entry.runId); continue; }
    if (entry.state === "detached") continue;
    entry.sink = undefined;
    entry.state = "detached";
    entry.detachedAt = Date.now();
    try { entry.handle.unbindEvents?.(); } catch { /* best-effort */ }
    armTimer(entry, opts);
    parked = true;
  }
  if (parked) installExitHook();
  return doomed;
}

/** Reload for one session: park survivable children and kill the rest (see parkSession). */
export async function detachShared(sessionId: string, opts: DetachOpts = {}): Promise<void> {
  const doomed = parkSession(sessionId, opts);
  await Promise.all(doomed.map(e => killEntry(e, shutdownReason("reload"), opts.graceMs)));
}

export interface AdoptResult { adopted: string[]; refused: Array<{ runId: string; reason: string }> }

/**
 * Re-adopt this session's detached children. `claim` receives each adoptable entry (already
 * marked attached, TTL cleared) and must install the new sink and rebind events. Entries owned
 * by another session or already attached are refused and left untouched. If `claim` throws, the
 * entry goes back to detached with its TTL RE-ARMED (a refused child is never left running without
 * a time limit) and the refusal carries the error.
 */
export function adoptShared(sessionId: string, claim: (entry: SharedChildEntry) => void): AdoptResult {
  const reg = sharedRegistry();
  const result: AdoptResult = { adopted: [], refused: [] };
  for (const entry of [...reg.entries.values()]) {
    if (entry.state === "attached") { result.refused.push({ runId: entry.runId, reason: "already attached" }); continue; }
    if (entry.sessionId !== sessionId) { result.refused.push({ runId: entry.runId, reason: "owned by another session" }); continue; }
    const opts = entry.detachOpts ?? {};
    clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.state = "attached";
    entry.detachedAt = undefined;
    try { claim(entry); } catch (error) {
      entry.state = "detached";
      entry.detachedAt = Date.now();
      entry.sink = undefined;
      try { entry.handle.unbindEvents?.(); } catch { /* best-effort */ }
      armTimer(entry, opts);
      result.refused.push({ runId: entry.runId, reason: `adoption failed: ${String((error as Error)?.message ?? error)}` });
      continue;
    }
    result.adopted.push(entry.runId);
    deliver(entry);
  }
  return result;
}

export function adoptableFor(sessionId: string): SharedChildEntry[] {
  return [...sharedRegistry().entries.values()].filter(e => e.state === "detached" && e.sessionId === sessionId);
}

/** Kill one session's children in this registry and finalize the rows nobody else will. */
async function disposeOwnSession(reg: ChildRegistryV1, sessionId: string, reason: string, exclude?: ReadonlySet<string>): Promise<void> {
  const mine = [...reg.entries.values()].filter(e => e.sessionId === sessionId && !exclude?.has(e.runId));
  const finished = new Set(mine.filter(e => e.exit).map(e => e.runId));
  await Promise.all(mine.map(e => finished.has(e.runId) ? Promise.resolve() : killEntry(e, reason)));
  for (const e of mine) {
    clearTimeout(e.timer);
    if (reg.entries.get(e.runId) === e) reg.entries.delete(e.runId);
    // An attached entry's sink finalizes its row when the exit arrives. A detached one has no sink,
    // so without this its row would stay `running` until the next reaper pass guessed a false cause.
    if (e.state === "detached") finalizeRowByPath(e, reason, finished.has(e.runId));
  }
  reg.tailCursors.delete(sessionId);
}

/**
 * Quit, new, resume or fork of ONE session: dispose that session's children in every registry
 * version found in this process. Our own version is handled directly so `exclude` can skip runs a
 * caller already killed; foreign versions are asked through their minimal `disposeSession`.
 */
export async function disposeSessionRegistries(sessionId: string, reason: string, opts: { exclude?: ReadonlySet<string> } = {}): Promise<void> {
  await disposeOwnSession(sharedRegistry(), sessionId, reason, opts.exclude);
  const g = globalThis as Record<symbol, unknown>;
  for (const sym of Object.getOwnPropertySymbols(globalThis)) {
    if (sym === CHILD_REGISTRY_KEY || !sym.description?.startsWith(KEY_PREFIX)) continue;
    const foreign = g[sym] as { disposeSession?: unknown } | undefined;
    if (typeof foreign?.disposeSession !== "function") continue;
    try { await (foreign.disposeSession as (s: string, r: string) => Promise<void>).call(foreign, sessionId, reason); } catch { /* best-effort */ }
  }
}

/** Session ids that currently have entries in our registry (used by the test/teardown-all helper). */
export function sharedSessionIds(): string[] {
  return [...new Set([...sharedRegistry().entries.values()].map(e => e.sessionId))];
}

const EXIT_HOOK = Symbol.for(`${KEY_PREFIX}${CHILD_REGISTRY_VERSION}.exitHook`);

export interface ExitSweepProbes {
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  identity?: (pid: number, startTime: string) => boolean;
}

/**
 * Last resort for a host that exits while children are still detached (the reloaded bundle never
 * loaded, or pi quit before any adoption): terminate their process groups and finalize their rows.
 * Synchronous, so it can run from process 'exit'. A group is only signalled if the recorded start
 * time still matches the pid, so a recycled pid is never hit.
 */
export function sweepDetachedOnExit(probes: ExitSweepProbes = {}): void {
  const kill = probes.kill ?? ((pid, signal) => process.kill(pid, signal));
  const matches = probes.identity ?? ((pid, start) => checkProcessIdentity(pid, start).matches);
  // On POSIX a child pid is also its group id. Never signal the host's group, even if the
  // registry or identity probe is wrong. If the host group cannot be read, fail closed.
  let ownGroup: number | undefined;
  if (process.platform !== "win32") {
    try {
      ownGroup = Number(execFileSync("ps", ["-p", String(process.pid), "-o", "pgid="], {
        encoding: "utf8", timeout: 1000, env: commandEnv(), stdio: ["ignore", "pipe", "ignore"],
      }).trim());
    } catch { /* no safe group signalling without the host's group id */ }
  }
  for (const e of [...sharedRegistry().entries.values()]) {
    if (e.state !== "detached") continue;
    const finished = !!e.exit;
    if (!finished && e.pid !== undefined && Number.isInteger(e.pid) && e.pid > 1 && e.pid !== process.pid
      && (process.platform === "win32" || (Number.isInteger(ownGroup) && ownGroup! > 0 && e.pid !== ownGroup))
      && e.startTime && matches(e.pid, e.startTime)) {
      try { kill(process.platform === "win32" ? e.pid : -e.pid, "SIGTERM"); }
      catch { try { kill(e.pid, "SIGTERM"); } catch { /* already gone */ } }
    }
    finalizeRowByPath(e, shutdownReason("quit"), finished);
  }
}

function installExitHook(): void {
  const g = globalThis as Record<symbol, unknown>;
  if (g[EXIT_HOOK]) return;
  g[EXIT_HOOK] = true;
  process.once("exit", () => { try { sweepDetachedOnExit(); } catch { /* exiting */ } });
}

/** Test helper: drop every timer and entry without killing anything. */
export function resetSharedRegistryForTests(): void {
  const g = globalThis as Record<symbol, unknown>;
  const existing = g[CHILD_REGISTRY_KEY];
  if (isRegistryV1(existing)) for (const e of existing.entries.values()) clearTimeout(e.timer);
  delete g[CHILD_REGISTRY_KEY];
}
