// packages/host/src/agents/actions.ts
import type { AgentActions } from "@spider/ui";

// RECONCILE (Task 16): @spider/subagents exposes NO per-run interrupt/resume/message-by-runId
// control surface, so these degrade to a best-effort "unavailable" toast. `follow` is a
// UI-local no-op (pin handled inside the grid). If Phase 4 later exposes per-run control,
// re-wire the three dispatch calls here — the coupling is isolated to this one file.
export function createAgentActions(
  _pi: unknown,
  ctx: { ui: { notify(t: string, level: "info" | "error"): void } },
): AgentActions {
  const unavailable = (command: string) => {
    try {
      ctx.ui.notify(`agent ${command} unavailable`, "error");
    } catch { /* toast is best-effort; never throw from an interaction key */ }
  };
  return {
    message: () => unavailable("message"),
    interrupt: () => unavailable("interrupt"),
    resume: () => unavailable("resume"),
    follow: () => { /* UI-local pin; no runtime call */ },
  };
}
