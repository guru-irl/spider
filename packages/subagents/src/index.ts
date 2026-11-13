export * from "./run-store";
export * from "./roam-origin";
export * from "./blockers";
export * from "./run-events";
export * from "./usage";
export * from "./pi-args";
export * from "./pi-spawn";
export * from "./child-reporter";
export * from "./event-tailer";
export * from "./runner";
export * from "./modes-index";
export * from "./intercom";
export * from "./schemas";
export * from "./pipeline";
export * from "./coordinators";
export * from "./spawn-default";
export * from "./kill";
export * from "./kill-process";
export * from "./reaper";
export * from "./child-registry";
export { diagnoseDurableChildren } from './durable-adoption';
export * from "./shutdown-reason";

import { attachChildReporter, isSubagentChild } from "./child-reporter";
import { makeRunHandler, adoptReloadedChildren } from "./actions/run";
import { makeMessageHandler } from "./actions/message";
import { makeKillHandler } from "./actions/kill";
import { listChildSessions, detachForReload } from "./coordinators";

/** The session a pi event context belongs to ("" when the context does not say). */
export function sessionIdFromCtx(ctx: unknown): string {
  const id = (ctx as { sessionManager?: { getSessionId?: () => unknown } } | undefined)?.sessionManager?.getSessionId?.();
  return typeof id === "string" ? id : "";
}

export { makeRunHandler, makeMessageHandler, makeKillHandler, adoptReloadedChildren };

/**
 * Register the `run`/`message`/`kill` actions on a structural host (`host.registerAction`).
 * In a subagent CHILD process (PI_SUBAGENT_CHILD=1) the orchestration surface is NOT
 * registered — the child only attaches the run_events reporter (preserves pi-subagents
 * early-out semantics + avoids recursive orchestration). NO @spider/host import (host is
 * passed structurally so host->subagents stays a one-way DAG).
 */
export function registerSubagentActions(host: { registerAction: (name: string, handler: (a: any, c: any) => any) => void }, pi: any): void {
  if (isSubagentChild()) {
    try { attachChildReporter(pi); } catch { /* best-effort */ }
    return;
  }
  host.registerAction("run", makeRunHandler());
  host.registerAction("message", makeMessageHandler());
  host.registerAction("kill", makeKillHandler());
  // The ending session is named by ctx (pi passes the session's own context to session_shutdown).
  // Reload preserves every survivable handle. Other shutdowns preserve supervised children and
  // stop only legacy direct-stdio children. Other sessions in this process are never touched.
  // Without a usable ctx, use only sessions coordinated by this activation.
  try {
    pi?.on?.("session_shutdown", async (event?: { reason?: string }, ctx?: unknown) => {
      const id = sessionIdFromCtx(ctx);
      const sessions = id ? [id] : listChildSessions();
      await Promise.all(sessions.map(s => detachForReload(s, { durableOnly: event?.reason !== 'reload' })));
    });
  } catch { /* best-effort */ }
}
