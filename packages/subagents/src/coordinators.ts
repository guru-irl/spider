import { bus } from "@spider/db-core";
import type { RunEvent } from "@spider/db-core";
import type { RunEventTailer } from "./event-tailer";
import type { PipelineCoordinator } from "./pipeline";
import type { ChildHandle } from "./runner";
import type { RunStore } from "./run-store";
import { cancelPendingIntercom } from "./intercom";
import { disposeSessionRegistries, killSharedEntry, parkSession, releaseShared, sharedRegistry, sharedSessionIds } from "./child-registry";
import { shutdownReason } from "./shutdown-reason";

export interface SessionCoordinators {
  tailer: RunEventTailer;
  pipelines: PipelineCoordinator[];
  /** Live child handles by runId — the in-process fast path for kill, and what
   *  session_shutdown iterates so quitting the session kills its subagents. */
  children: Map<string, ChildHandle>;
  /** Cleanup function for the escalation notifier (watches bus for escalation events). */
  escalationNotifierCleanup?: () => void;
  /** Extra run DBs opened at their recorded paths during adoption after a binding change. */
  adoptionCleanup?: () => void;
}

// Module-scoped registry — one extension activation owns it. The ONLY cross-build state is the
// versioned child registry in child-registry.ts (live child handles that survive /reload).
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
  cancelPendingIntercom(sessionId);
  const c = registry.get(sessionId);
  if (!c) return;
  // Kill children FIRST: the tailer is what surfaces their final events, and a
  // stopped tailer would swallow them.
  for (const [runId, h] of c.children ?? []) { try { h.kill(shutdownReason("quit")); } catch {} releaseShared(runId); }
  c.children?.clear();
  try { c.tailer?.stop(); } catch {}
  for (const p of c.pipelines) { try { p.dispose(); } catch {} }
  try { c.escalationNotifierCleanup?.(); } catch {}
  try { c.adoptionCleanup?.(); } catch {}
  registry.delete(sessionId);
}

export function teardownAll(): void {
  cancelPendingIntercom();
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

/** Quit, new, resume or fork of ONE session: kill that session's children, await a bounded grace,
 *  then SIGKILL survivors. Children this session left detached by an earlier reload (never adopted)
 *  are killed and their rows finalized too. Other sessions are never touched.
 *  Escalation is parallel (N children take ~graceMs total, not N*graceMs). Best-effort: never throws. */
export async function teardownSessionAsync(sessionId: string, opts: TeardownAsyncOpts = {}): Promise<void> {
  cancelPendingIntercom(sessionId);
  const graceMs = opts.graceMs ?? SESSION_EXIT_GRACE_MS;
  const reason = shutdownReason("quit");
  const killed = new Set<string>();
  try {
    const c = registry.get(sessionId);
    const kills: Promise<void>[] = [];
    // Kill children FIRST: the tailer surfaces their final events
    for (const [runId, h] of c?.children ?? []) {
      killed.add(runId);
      try {
        if (typeof h.killAsync === "function") kills.push(h.killAsync(graceMs, reason).catch(() => { /* best-effort */ }));
        else h.kill(reason); // no escalation guarantee
      } catch { /* best-effort */ }
    }
    await Promise.all(kills);
    // Whatever the shared registry still holds for this session (children detached by an earlier
    // reload and never adopted, or parked by another build version) must not outlive it either.
    await disposeSessionRegistries(sessionId, reason, { exclude: killed });
    for (const runId of killed) releaseShared(runId);
    if (c) {
      c.children?.clear();
      try { c.tailer?.stop(); } catch {}
      for (const p of c.pipelines) { try { p.dispose(); } catch {} }
      try { c.escalationNotifierCleanup?.(); } catch {}
      try { c.adoptionCleanup?.(); } catch {}
      registry.delete(sessionId);
    }
  } catch {
    // Best-effort: never let cleanup errors block session exit
  }
}

/** Every session this process knows (this activation's coordinators and the shared registry).
 *  An explicit all-sessions helper for tests and process-wide teardown; the session_shutdown
 *  hook never uses it when the ending session is known. */
export async function teardownAllAsync(opts: TeardownAsyncOpts = {}): Promise<void> {
  cancelPendingIntercom();
  const ids = [...new Set([...registry.keys(), ...sharedSessionIds()])];
  await Promise.all(ids.map(id => teardownSessionAsync(id, opts)));
}

export interface DetachForReloadOpts extends TeardownAsyncOpts {
  /** Overrides the unadopted-child TTL (tests). */
  ttlMs?: number;
}

/**
 * session_shutdown{reason:"reload"} for ONE session: keep its async children running and hand them
 * to the reloaded activation (see child-registry.ts). Everything that calls back into this
 * activation is detached: the tailer stops (its position is saved), pipelines end, the notifier is
 * removed, and each child's completion sink and RPC event sink are dropped. Children that cannot
 * survive (foreground chain steps) are killed with the shutdown reason, so the notifier starts no
 * model turn for them. Other sessions are untouched. Best-effort; never throws.
 */
export async function detachForReload(sessionId: string, opts: DetachForReloadOpts = {}): Promise<void> {
  cancelPendingIntercom(sessionId);
  const graceMs = opts.graceMs ?? SESSION_EXIT_GRACE_MS;
  const reason = shutdownReason("reload");
  try {
    const shared = sharedRegistry();
    // Park first and synchronously: from here no old sink can fire for a survivable child, even if
    // it exits while the foreground kills below are still waiting out their grace period.
    const doomed = parkSession(sessionId, { ttlMs: opts.ttlMs, graceMs });
    const c = registry.get(sessionId);
    const kills: Promise<void>[] = [];
    // Foreground children through their activation-owned handles (cancel bookkeeping).
    const viaHandle = new Set<string>();
    for (const [runId, h] of c?.children ?? []) {
      if (!doomed.some(e => e.runId === runId)) continue;
      viaHandle.add(runId);
      try {
        if (typeof h.killAsync === "function") kills.push(h.killAsync(graceMs, reason).catch(() => {}));
        else h.kill(reason);
      } catch { /* best-effort */ }
    }
    // Any doomed entry without an activation handle is killed through the registry.
    for (const e of doomed) if (!viaHandle.has(e.runId)) kills.push(killSharedEntry(e, reason, graceMs));
    await Promise.all(kills);
    if (c) {
      if (c.tailer) shared.tailCursors.set(sessionId, c.tailer.cursor);
      try { c.tailer?.stop(); } catch {}
      for (const p of c.pipelines) { try { (p as { abandonForReload?: () => void }).abandonForReload?.() ?? p.dispose(); } catch {} }
      try { c.escalationNotifierCleanup?.(); } catch {}
      c.children?.clear();
      try { c.adoptionCleanup?.(); } catch {}
      registry.delete(sessionId);
    }
  } catch {
    // Best-effort: the TTL timers, the exit sweep and the reaper are the backstops.
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
