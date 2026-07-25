import { bus } from "@spider/db-core";
import type { RunEvent } from "@spider/db-core";
import type { RunEventTailer } from "./event-tailer";
import type { PipelineCoordinator } from "./pipeline";
import type { ChildHandle } from "./runner";
import type { RunStore } from "./run-store";

export interface SessionCoordinators {
  tailer: RunEventTailer;
  pipelines: PipelineCoordinator[];
  /** Live child handles by runId — the in-process fast path for kill, and what
   *  session_shutdown iterates so quitting the session kills its subagents. */
  children: Map<string, ChildHandle>;
  /** Cleanup function for the escalation notifier (watches bus for escalation events). */
  escalationNotifierCleanup?: () => void;
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
    // IMPORTANT 3: Preserve escalationNotifierCleanup on upgrade path
    if (made.escalationNotifierCleanup) c.escalationNotifierCleanup = made.escalationNotifierCleanup;
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
  try { c.escalationNotifierCleanup?.(); } catch {}
  registry.delete(sessionId);
}

export function teardownAll(): void {
  for (const id of [...registry.keys()]) teardownCoordinators(id);
}

/** Grace period for async teardown (session_shutdown path). Short enough to not
 *  hang user exit, long enough for well-behaved processes to clean up.
 *  250ms is a common convention for short-lived services (much less than systemd's
 *  90s DefaultTimeoutStopSec but appropriate for interactive tools). */
const SESSION_EXIT_GRACE_MS = 250;

export interface TeardownAsyncOpts {
  /** Per-child grace period between SIGTERM and SIGKILL. */
  graceMs?: number;
}

/** Async teardown: kill children, await a bounded grace, then SIGKILL survivors.
 *  Used by session_shutdown to ensure wedged processes don't survive exit.
 *  Escalation is parallel (N children take ~graceMs total, not N*graceMs).
 *  Best-effort: never throws. */
export async function teardownAllAsync(opts: TeardownAsyncOpts = {}): Promise<void> {
  const graceMs = opts.graceMs ?? SESSION_EXIT_GRACE_MS;
  const sessions = [...registry.keys()];
  
  try {
    // Kill all children in parallel across all sessions
    const killPromises: Promise<void>[] = [];
    
    for (const id of sessions) {
      const c = registry.get(id);
      if (!c) continue;
      
      // Kill children FIRST: the tailer surfaces their final events
      for (const [, h] of c.children ?? []) {
        try {
          // Check if handle supports async kill with escalation
          if (typeof (h as any).killAsync === "function") {
            killPromises.push(
              (h as any).killAsync(graceMs).catch(() => { /* best-effort */ })
            );
          } else {
            // Fallback: sync kill (no escalation guarantee)
            h.kill();
          }
        } catch { /* best-effort */ }
      }
    }
    
    // Wait for all kills to complete (parallel, bounded by graceMs)
    await Promise.all(killPromises);
    
    // Clean up coordinators
    for (const id of sessions) {
      const c = registry.get(id);
      if (!c) continue;
      
      c.children?.clear();
      try { c.tailer?.stop(); } catch {}
      for (const p of c.pipelines) { try { p.dispose(); } catch {} }
      // IMPORTANT 3: Call escalation disposer through production path
      try { c.escalationNotifierCleanup?.(); } catch {}
      registry.delete(id);
    }
  } catch {
    // Best-effort: never let cleanup errors block session exit
  }
}

/** Set up an escalation notifier that watches the bus for escalation events and
 *  notifies the orchestrator. Returns a cleanup function. Best-effort; never throws. */
export function setupEscalationNotifier(ctx: any, store: RunStore): () => void {
  const off = bus.on((e: RunEvent) => {
    if (e.type !== "escalation") return;
    if (!e.runId) return;
    // IMPORTANT 3: Filter by sessionId to avoid cross-session escalations
    if (e.sessionId && e.sessionId !== ctx.sessionId) return;
    
    try {
      // Check if the run is cancelled — don't notify for deliberately killed runs
      const run = store.get(e.runId);
      if (!run || run.status === "cancelled") return;
      
      // Extract severity from payload
      const severity = (e.payload as any)?.severity ?? "warning";
      const summary = e.summary ?? "Escalation";
      const runName = run.name ?? run.agent;
      
      // Notify the orchestrator with a themed card
      ctx.pi?.sendMessage?.(
        {
          customType: "spider.escalation",
          content: `🚨 *escalation* "${runName}" · ${run.agent} · *${severity}*\n\n${summary}`,
          display: true,
          details: {
            runId: e.runId,
            severity,
            summary,
            agent: run.agent,
            name: runName,
            payload: e.payload,
          },
        },
        { triggerTurn: true },
      );
      
      // Also send a UI notification
      ctx.ui?.notify?.(summary, severity === "blocked" ? "error" : "warning");
    } catch {
      // Best-effort: never let notification failures break the tailer
    }
  });
  
  return off;
}
