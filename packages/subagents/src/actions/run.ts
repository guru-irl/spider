import { paths } from "@spider/db-core";
import { RunStore } from "../run-store";
import { RunEventTailer } from "../event-tailer";
import { Runner, type Spawner } from "../runner";
import { PipelineCoordinator } from "../pipeline";
import { getCoordinators, type SessionCoordinators } from "../coordinators";
import { runChain } from "../chain";
import { runParallel } from "../parallel";
import { runSingle } from "../single";
import { thinkingFromModel, stripThinkingSuffix } from "../pi-args";
import { defaultSpawner } from "../spawn-default";
import { latestRunOutput } from "../completion-output";

/** Async-completion notifier: injects a message the parent agent sees next turn (so it
 *  learns a background subagent finished) + a human toast. Best-effort; never throws. */
export function makeAsyncNotifier(ctx: any): (run: any, status: string, result?: string) => void {
  return (run, status, result) => {
    try {
      const output = latestRunOutput(ctx.db, run.id, result);
      const name = run?.name ?? run?.agent ?? "subagent";
      const headline = `🕸 subagent "${name}" (${run?.agent ?? "worker"}) finished: ${status}`;
      ctx.ui?.notify?.(headline, status === "failed" ? "error" : "info");
      const content = `${headline}\n\n${output || "(no output)"}`;      
      ctx.pi?.sendMessage?.(
        {
          customType: "spider.subagent_done",
          content,
          display: true,
          details: { runId: run?.id, name, agent: run?.agent, status, output },
        },
        { deliverAs: "nextTurn" },
      );
    } catch { /* best-effort */ }
  };
}

interface RunDeps {
  makeStore?: (db: any) => RunStore;
  makeRunner?: (db: any, sessionId: string, cwd: string, deps: any) => any;
  makePipeline?: (deps: any) => any;
  spawner?: Spawner;
  getCoordinators?: (ctx: any) => SessionCoordinators;
}

/** The `run` action handler. Routes by args shape: pipeline > chain > tasks > single. */
export function makeRunHandler(overrides: RunDeps = {}): (args: any, ctx: any) => Promise<{ content: string; details: any }> {
  return async function runHandler(args: any, ctx: any) {
    const store = overrides.makeStore?.(ctx.db) ?? new RunStore(ctx.db);
    const coords =
      overrides.getCoordinators?.(ctx) ??
      getCoordinators(ctx.sessionId, () => {
        const t = new RunEventTailer(ctx.db);
        t.start();
        return { tailer: t, pipelines: [] };
      });
    const tailer = coords.tailer;
    const spawn = overrides.spawner ?? defaultSpawner;
    const scratchRoot = paths.scratch("project", ctx.cwd);
    const dbPath = ctx.project?.dbPath ?? "";
    const onComplete = makeAsyncNotifier(ctx);
    const runnerDeps = { store, tailer, spawn, scratchRoot, dbPath, onComplete };
    const runner = overrides.makeRunner
      ? overrides.makeRunner(ctx.db, ctx.sessionId, ctx.cwd, runnerDeps)
      : new Runner(ctx.db, ctx.sessionId, ctx.cwd, runnerDeps);

    // Stamp the parent's current model + thinking level on runs that don't name one, so the
    // (static) run block and footer show them immediately instead of "—". Thinking is often
    // encoded as a model suffix (e.g. "prov/opus:high"); split it out so the model column stays
    // clean and the thinking level renders as its own segment. spawnFor re-applies the suffix.
    const parentModel: string | undefined = ctx.model?.id;
    const resolveMT = (m?: string, th?: string): { model?: string; thinking?: string } => {
      const full = m ?? parentModel;
      return { model: stripThinkingSuffix(full), thinking: th ?? thinkingFromModel(full) };
    };

    if (Array.isArray(args.pipeline)) {
      const coord = overrides.makePipeline
        ? overrides.makePipeline({ db: ctx.db, globalDb: ctx.globalDb, store, runner, pi: ctx.pi, sessionId: ctx.sessionId })
        : new PipelineCoordinator({ db: ctx.db, globalDb: ctx.globalDb, store, runner, pi: ctx.pi, sessionId: ctx.sessionId });
      coords.pipelines.push(coord);
      const { pipelineId, firstRunId } = coord.start({ pipeline: args.pipeline, handoff: args.handoff ?? "intercom", async: true });
      return { content: `pipeline ${pipelineId} started (${args.pipeline.length} stages), first run ${firstRunId}`, details: { pipelineId, firstRunId } };
    }
    if (Array.isArray(args.chain)) {
      const chain = args.chain.map((c: any) => ({ ...c, ...resolveMT(c.model, c.thinking) }));
      const rows = await runChain(runner, chain, { task: args.task ?? "", context: args.context ?? "fresh" });
      const list = rows.map((r: any) => `  • ${r.name ?? r.agent} — ${r.id} (${r.status})`).join("\n");
      return { content: `chain complete: ${rows.length} step(s)\n${list}`, details: { runs: rows } };
    }
    if (Array.isArray(args.tasks)) {
      const tasks = args.tasks.map((t: any) => ({ ...t, ...resolveMT(t.model, t.thinking) }));
      const rows = await runParallel(runner, tasks, { concurrency: args.concurrency, context: args.context ?? "fresh", async: args.async });
      const list = rows.map((r: any) => `  • ${r.name ?? r.agent} — ${r.id} (${r.status})`).join("\n");
      return { content: `parallel ${args.async ? "started" : "complete"}: ${rows.length} run(s)\n${list}`, details: { runs: rows } };
    }
    const { model: singleModel, thinking: singleThinking } = resolveMT(args.model, args.thinking);
    const row: any = await runSingle(runner, { agent: args.agent ?? "worker", task: args.task, name: args.name as string | undefined, model: singleModel, skill: args.skill, thinking: singleThinking, context: args.context ?? "fresh", async: args.async });
    return { content: `run "${row?.name ?? row?.agent}" — ${row?.id} (${row?.status})`, details: { run: row } };
  };
}
