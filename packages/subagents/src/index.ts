export * from "./run-store";
export * from "./run-events";
export * from "./usage";
export * from "./pi-args";
export * from "./pi-spawn";
export * from "./child-reporter";
export * from "./event-tailer";
export * from "./runner";
export * from "./modes-index";
export * from "./intercom";
export * from "./child-intercom";
export * from "./schemas";
export * from "./pipeline";
export * from "./coordinators";
export * from "./spawn-default";
export * from "./kill";
export * from "./kill-process";
export * from "./reaper";
export * from "./child-registry";
export * from "./shutdown-reason";

import { attachChildReporter, isSubagentChild } from "./child-reporter";
import { makeRunHandler, adoptReloadedChildren } from "./actions/run";
import { makeMessageHandler } from "./actions/message";
import { makeKillHandler } from "./actions/kill";
import { listChildSessions, teardownSessionAsync, detachForReload } from "./coordinators";

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
  // reload keeps THAT session's async children running for the reloaded activation to adopt; every
  // other reason (quit, new, resume, fork, or an unknown/absent one) kills them, as before. Other
  // sessions in this process are never touched. With no usable ctx the sessions this activation
  // itself coordinates are used, never the whole process.
  try {
    pi?.on?.("session_shutdown", async (event?: { reason?: string }, ctx?: unknown) => {
      const id = sessionIdFromCtx(ctx);
      const sessions = id ? [id] : listChildSessions();
      await Promise.all(sessions.map(s => event?.reason === "reload" ? detachForReload(s) : teardownSessionAsync(s)));
    });
  } catch { /* best-effort */ }
}
