export * from "./run-store";
export * from "./run-events";
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

import { attachChildReporter, isSubagentChild } from "./child-reporter";
import { makeRunHandler } from "./actions/run";
import { makeMessageHandler } from "./actions/message";
import { makeKillHandler } from "./actions/kill";
import { teardownAll } from "./coordinators";

export { makeRunHandler, makeMessageHandler, makeKillHandler };

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
  try { pi?.on?.("session_shutdown", () => teardownAll()); } catch { /* best-effort */ }
}
