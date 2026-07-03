export * from "./run-store.js";
export * from "./run-events.js";
export * from "./pi-args.js";
export * from "./pi-spawn.js";
export * from "./child-reporter.js";
export * from "./event-tailer.js";
export * from "./runner.js";
export * from "./modes-index.js";
export * from "./intercom.js";
export * from "./schemas.js";
export * from "./pipeline.js";
export * from "./wait.js";
export * from "./coordinators.js";
export * from "./spawn-default.js";

import { attachChildReporter, isSubagentChild } from "./child-reporter.js";
import { makeRunHandler } from "./actions/run.js";
import { makeWaitHandler } from "./actions/wait.js";
import { makeMessageHandler } from "./actions/message.js";
import { teardownAll } from "./coordinators.js";

export { makeRunHandler, makeWaitHandler, makeMessageHandler };

/**
 * Register the `run`/`wait`/`message` actions on a structural host (`host.registerAction`).
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
  host.registerAction("wait", makeWaitHandler());
  host.registerAction("message", makeMessageHandler());
  try { pi?.on?.("session_shutdown", () => teardownAll()); } catch { /* best-effort */ }
}
