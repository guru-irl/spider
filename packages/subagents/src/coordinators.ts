import type { RunEventTailer } from "./event-tailer";
import type { PipelineCoordinator } from "./pipeline";
import type { ChildHandle } from "./runner";

export interface SessionCoordinators {
  tailer: RunEventTailer;
  pipelines: PipelineCoordinator[];
  /** Live child handles by runId — the in-process fast path for kill, and what
   *  session_shutdown iterates so quitting the session kills its subagents. */
  children: Map<string, ChildHandle>;
}

// Module-scoped registry — one extension activation owns it; NO globalThis singletons.
const registry = new Map<string, SessionCoordinators>();

export function getCoordinators(sessionId: string, make: () => SessionCoordinators): SessionCoordinators {
  let c = registry.get(sessionId);
  if (!c) {
    c = make();
    c.children ??= new Map();
    registry.set(sessionId, c);
    return c;
  }
  // A slot() created by registerChild() before the first `run` has NO tailer. Returning it
  // as-is would permanently suppress tailer creation for the session (make() is never called
  // again), silently killing the live agent feed. Upgrade the slot in place instead, keeping
  // any children already registered against it.
  if (!c.tailer) {
    const made = make();
    c.tailer = made.tailer;
    if (made.pipelines.length) c.pipelines.push(...made.pipelines);
  }
  c.children ??= new Map();
  return c;
}

/** Coordinators for a session that may not have a tailer yet — used by the child
 *  registry, which must work even before the first `run` builds a full coordinator.
 *  Any slot this creates is upgraded by the next getCoordinators() call. */
function slot(sessionId: string): SessionCoordinators {
  let c = registry.get(sessionId);
  if (!c) {
    c = { tailer: undefined as unknown as RunEventTailer, pipelines: [], children: new Map() };
    registry.set(sessionId, c);
  }
  c.children ??= new Map();
  return c;
}

export function registerChild(sessionId: string, runId: string, handle: ChildHandle): void {
  slot(sessionId).children.set(runId, handle);
}

export function unregisterChild(sessionId: string, runId: string): void {
  registry.get(sessionId)?.children?.delete(runId);
}

export function getChild(sessionId: string, runId: string): ChildHandle | undefined {
  return registry.get(sessionId)?.children?.get(runId);
}

export function listChildSessions(): string[] {
  return [...registry.keys()];
}

export function teardownCoordinators(sessionId: string): void {
  const c = registry.get(sessionId);
  if (!c) return;
  // Kill children FIRST: the tailer is what surfaces their final events, and a
  // stopped tailer would swallow them.
  for (const [, h] of c.children ?? []) { try { h.kill(); } catch {} }
  c.children?.clear();
  try { c.tailer?.stop(); } catch {}
  for (const p of c.pipelines) { try { p.dispose(); } catch {} }
  registry.delete(sessionId);
}

export function teardownAll(): void {
  for (const id of [...registry.keys()]) teardownCoordinators(id);
}
