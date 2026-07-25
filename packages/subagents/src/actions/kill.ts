import { RunStore } from "../run-store";
import { resolveKillTargets, killRun, type KillResult } from "../kill";

export interface KillDetails { killed: KillResult[]; requested: string; error?: string }

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
      return { content: message, isError: true, details: { killed: [], requested, error: message } };
    }
    if (targets.length === 0) {
      return { content: "no active subagents to kill", details: { killed: [], requested } };
    }
    const killed: KillResult[] = [];
    let anyFailed = false;
    for (const run of targets) {
      try {
        killed.push(await killRun({ store, db: ctx.db }, ctx.sessionId, run));
      } catch (err: unknown) {
        anyFailed = true;
        const message = err instanceof Error ? err.message : String(err);
        // Push a failure entry so the partial report includes this run
        killed.push({
          runId: run.id,
          name: run.name ?? run.id.slice(0, 7),
          outcome: "no-process", // reuse existing outcome; lastActivity records the error
          via: "none",
          lastActivity: `kill failed: ${message}`,
        });
      }
    }
    const lines = killed.map((k) => `  • ${k.name} — ${k.outcome}${k.via !== "none" ? ` (via ${k.via})` : ""}${k.lastActivity ? ` (${k.lastActivity})` : ""}`).join("\n");
    return { content: `killed ${killed.length} subagent(s)\n${lines}`, isError: anyFailed, details: { killed, requested } };
  };
}
