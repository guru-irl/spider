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
      if (!ctx.dispatch) throw new Error("kill unavailable");
      const result = await ctx.dispatch("kill", { id: runId });
      if (!result || typeof result !== "object") return;
      const response = result as { error?: unknown; isError?: unknown; content?: unknown; details?: { error?: unknown } };
      if (typeof response.error === "string" && response.error) throw new Error(response.error);
      if (response.isError === true) {
        const message = typeof response.content === "string" && response.content ? response.content
          : typeof response.details?.error === "string" && response.details.error ? response.details.error : "kill failed";
        throw new Error(message);
      }
    },
  };
}
