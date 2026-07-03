import type { RunEventTailer } from "./event-tailer";
import type { PipelineCoordinator } from "./pipeline";

export interface SessionCoordinators { tailer: RunEventTailer; pipelines: PipelineCoordinator[]; }

// Module-scoped registry — one extension activation owns it; NO globalThis singletons.
const registry = new Map<string, SessionCoordinators>();

export function getCoordinators(sessionId: string, make: () => SessionCoordinators): SessionCoordinators {
  let c = registry.get(sessionId);
  if (!c) { c = make(); registry.set(sessionId, c); }
  return c;
}

export function teardownCoordinators(sessionId: string): void {
  const c = registry.get(sessionId);
  if (!c) return;
  try { c.tailer.stop(); } catch {}
  for (const p of c.pipelines) { try { p.dispose(); } catch {} }
  registry.delete(sessionId);
}

export function teardownAll(): void {
  for (const id of [...registry.keys()]) teardownCoordinators(id);
}
