import { RunStore } from "../run-store";
import { resolveKillTargets, killRun, type KillResult } from "../kill";

export interface KillDetails { killed: KillResult[]; requested: string }

/** The `kill` action handler. Resolves a target to runs and terminates each. */
export function makeKillHandler(): (args: any, ctx: any) => Promise<{ content: string; isError?: boolean; details: KillDetails }> {
  return async function killHandler(args: any, ctx: any) {
    const store = new RunStore(ctx.db);
    const requested = String(args?.id ?? "");
    let targets;
    try {
      targets = resolveKillTargets(store, ctx.sessionId, requested);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: message, isError: true, details: { killed: [], requested } };
    }
    if (targets.length === 0) {
      return { content: "no active subagents to kill", details: { killed: [], requested } };
    }
    const killed: KillResult[] = [];
    for (const run of targets) {
      killed.push(await killRun({ store, db: ctx.db }, ctx.sessionId, run));
    }
    const lines = killed.map((k) => `  • ${k.name} — ${k.outcome}${k.via !== "none" ? ` (via ${k.via})` : ""}`).join("\n");
    return { content: `killed ${killed.length} subagent(s)\n${lines}`, details: { killed, requested } };
  };
}
