import type { Db } from "@spider/db-core";
import { safeReviewError } from "../review-diagnostics";

interface DrainState { lastAttemptAt?: number; lastDrainAt?: number; lastErrorAt?: number; lastError?: string; errors: number; itemErrors?: Record<string, string> }
const states = new Map<string, DrainState>();
const listeners = new Set<(message: string, db?: Db) => void>();
export function onEmbeddingDiagnostic(listener: (message: string, db?: Db) => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
export function embeddingDiagnostic(message: string, db?: Db): void {
  for (const listener of listeners) { try { listener(message, db); } catch { /* diagnostics never prevent FTS fallback */ } }
}
function stateFor(db: Db): DrainState {
  const key = db.raw.name;
  let state = states.get(key);
  if (!state) {
    if (states.size >= 128) states.delete(states.keys().next().value!);
    state = { errors: 0 }; states.set(key, state);
  }
  return state;
}
export function markEmbedDrainAttempt(db: Db): void { stateFor(db).lastAttemptAt = Date.now(); }
export function markEmbedDrained(db: Db): void { stateFor(db).lastDrainAt = Date.now(); }
export function recordEmbedDrainError(db: Db, error: unknown, item?: string): void {
  const state = stateFor(db);
  state.lastError = safeReviewError(error); state.lastErrorAt = Date.now(); state.errors++;
  if (item) {
    state.itemErrors ??= {};
    if (Object.keys(state.itemErrors).length >= 32) delete state.itemErrors[Object.keys(state.itemErrors)[0]];
    state.itemErrors[item] = state.lastError;
  }
  embeddingDiagnostic(`embedding drain${item ? ` item ${item}` : ""}: ${state.lastError}`, db);
}
export function getEmbedDrainState(db: Db): Readonly<DrainState> & { oldestQueuedAt?: number; oldestPendingAt?: number } {
  const queued = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'embed_queue'").get();
  const oldest = queued ? (db.prepare("SELECT MIN(enqueued_at) AS at FROM embed_queue WHERE COALESCE(tries, 0) < 5").get() as { at: number | null }).at : null;
  const pending = queued ? (db.prepare("SELECT MIN(enqueued_at) AS at FROM embed_queue WHERE COALESCE(tries, 0) = 0").get() as { at: number | null }).at : null;
  return { ...(states.get(db.raw.name) ?? { errors: 0 }), ...(oldest == null ? {} : { oldestQueuedAt: oldest }), ...(pending == null ? {} : { oldestPendingAt: pending }) };
}

/** Only shutdown cancels inference. A cadence deadline must not discard completed vectors. */
export function abortableEmbeddingTask<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("embedding drain cancelled"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
