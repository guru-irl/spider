import { paths } from "@spider/db-core";
import { RunStore } from "../run-store.js";
import { RunEventTailer } from "../event-tailer.js";
import { Runner, type Spawner } from "../runner.js";
import { PipelineCoordinator } from "../pipeline.js";
import { getCoordinators, type SessionCoordinators } from "../coordinators.js";
import { runChain } from "../chain.js";
import { runParallel } from "../parallel.js";
import { runSingle } from "../single.js";
import { defaultSpawner } from "../spawn-default.js";

interface RunDeps {
  makeStore?: (db: any) => RunStore;
  makeRunner?: (db: any, sessionId: string, cwd: string, deps: any) => any;
  makePipeline?: (deps: any) => any;
  spawner?: Spawner;
  getCoordinators?: (ctx: any) => SessionCoordinators;
}

/** The `run` action handler. Routes by args shape: pipeline > chain > tasks > single. */
export function makeRunHandler(overrides: RunDeps = {}) {
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
    const runner = overrides.makeRunner
      ? overrides.makeRunner(ctx.db, ctx.sessionId, ctx.cwd, { store, tailer, spawn, scratchRoot, dbPath })
      : new Runner(ctx.db, ctx.sessionId, ctx.cwd, { store, tailer, spawn, scratchRoot, dbPath });

    if (Array.isArray(args.pipeline)) {
      const coord = overrides.makePipeline
        ? overrides.makePipeline({ db: ctx.db, globalDb: ctx.globalDb, store, runner, pi: ctx.pi, sessionId: ctx.sessionId })
        : new PipelineCoordinator({ db: ctx.db, globalDb: ctx.globalDb, store, runner, pi: ctx.pi, sessionId: ctx.sessionId });
      coords.pipelines.push(coord);
      const { pipelineId, firstRunId } = coord.start({ pipeline: args.pipeline, handoff: args.handoff ?? "intercom", async: true });
      return { content: `pipeline ${pipelineId} started (${args.pipeline.length} stages), first run ${firstRunId}`, details: { pipelineId, firstRunId } };
    }
    if (Array.isArray(args.chain)) {
      const rows = await runChain(runner, args.chain, { task: args.task ?? "", context: args.context ?? "fresh" });
      return { content: `chain complete: ${rows.length} steps`, details: { runs: rows } };
    }
    if (Array.isArray(args.tasks)) {
      const rows = await runParallel(runner, args.tasks, { concurrency: args.concurrency, context: args.context ?? "fresh" });
      return { content: `parallel complete: ${rows.length} runs`, details: { runs: rows } };
    }
    const row: any = await runSingle(runner, { agent: args.agent ?? "worker", task: args.task, model: args.model, skill: args.skill, context: args.context ?? "fresh", async: args.async });
    return { content: `run ${row?.id} ${row?.status}`, details: { run: row } };
  };
}
