// packages/host/src/agents/actions.ts
import type { AgentActions } from "@spider/ui";

// `interrupt`/`resume`/`message` still have no per-run control surface in
// @spider/subagents and degrade to a toast. `kill` IS wired: it dispatches the
// spider `kill` action for the selected run.
export function createAgentActions(
  _pi: unknown,
  ctx: {
    ui: { notify(t: string, level: "info" | "error"): void };
    dispatch?: (action: string, args: Record<string, unknown>) => Promise<unknown>;
  },
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
    kill: async (runId: string) => {
      try {
        await ctx.dispatch?.("kill", { id: runId });
        ctx.ui.notify("subagent killed", "info");
      } catch (err) {
        ctx.ui.notify(`kill failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  };
}
