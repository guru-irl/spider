import { appendRunEvent, openDb, paths, type Db } from "@spider/db-core";
import { RunStore } from "../run-store";
import { runUsage, sumUsage, safelyReportUsage } from "../usage";
import { RunEventTailer } from "../event-tailer";
import { Runner, type Spawner } from "../runner";
import { PipelineCoordinator } from "../pipeline";
import { getCoordinators, setupEscalationNotifier, type SessionCoordinators } from "../coordinators";
import { runChain } from "../chain";
import { runParallel } from "../parallel";
import { runSingle } from "../single";
import { thinkingFromModel, stripThinkingSuffix } from "../pi-args";
import { qualifyModelProvider, listPiModels, resolveRoleModel, resolveModelThinking } from "../model-resolve";
import { defaultSpawner } from "../spawn-default";
import { latestRunOutput } from "../completion-output";
import { resolveChildIntercom } from "../child-intercom";
import { adoptShared, adoptableFor, getShared, sharedRegistry, type AdoptResult } from "../child-registry";
import { isShutdownReason } from "../shutdown-reason";

/** Async-completion notifier: injects a message the parent agent sees next turn (so it
 *  learns a background subagent finished) + a human toast. Best-effort; never throws. */
export function makeAsyncNotifier(ctx: any): (run: any, status: string, result?: string, steps?: any[]) => void {
  return (run, status, result, steps) => {
    // The caller's own kill result already reported this cancellation.
    const completion = result ?? run.result ?? "";
    if (status === "cancelled" && completion.startsWith("killed by spider kill from this session") && !/\d+ steer\(s\) (?:accepted but not confirmed|no reply yet, delivery unknown)\./.test(completion)) return;
    // Written by shutdownReason() (quit and reload kinds): the pi may be going away, so no model turn.
    const shutdown = status === "cancelled" && isShutdownReason(result ?? run.result ?? "");
    try {
      let output = status === "cancelled" ? result ?? run.result : latestRunOutput(ctx.db, run.id, result);
      // Compatibility notes are notification metadata, never stage deliverables.
      // Unknown versions stay in events/tool details only to avoid noisy completions.
      const notes = new Set<string>();
      for (const [index, step] of (steps ?? [run]).entries()) {
        let warnings: Array<{ payload: string }> = [];
        try { warnings = ctx.db.prepare("SELECT payload FROM run_events WHERE run_id=? AND type='warning'").all(step.id); }
        catch { /* optional diagnostics cannot suppress the cancellation cause */ }
        for (const warning of warnings) {
          try {
            const payload = JSON.parse(warning.payload);
            if ((payload.thinkingNotice === true || payload.reload === true || (payload.launchWarning === true && payload.printFallback === true)) && typeof payload.message === "string") {
              notes.add(steps ? `step ${index + 1}: ${payload.message}` : payload.message);
            }
          } catch { /* malformed diagnostics do not hide completion */ }
        }
      }
      if (notes.size) output = [output, ...notes].filter(Boolean).join("\n\n");
      const name = run?.name ?? run?.agent ?? "subagent";
      const agent = run?.agent ?? "worker";
      // UI standard: italic verb (`subagent`) + italic status, mirroring the tool titles.
      const headline = `🕸 *subagent* "${name}" · ${agent} · *${status}*`;
      ctx.ui?.notify?.(`subagent "${name}" ${status}`, status === "failed" ? "error" : "info");
      // Carry the COMPLETE curated output in the transcript; the registered renderer collapses
      // it and ctrl+o expands the whole thing. triggerTurn wakes an idle main agent so the
      // conversation continues automatically instead of waiting for the user to send a message.
      const completed = steps ?? [run];
      const tokenCount = completed.reduce((n, row) => n + (row.token_count ?? 0), 0);
      let cost: number | undefined;
      try { cost = sumUsage(completed.flatMap(row => runUsage(ctx.db, row.id).map(r => r.usage))).cost.total; }
      catch { /* optional usage cannot suppress a completion or cancellation cause */ }
      const usageLine = `${tokenCount.toLocaleString("en-US")} tokens${cost === undefined ? "" : ` · $${cost.toFixed(2)}`}`;
      const content = `${headline}\n${usageLine}\n\n${output || "(no output)"}`;
      ctx.pi?.sendMessage?.(
        {
          customType: "spider.subagent_done",
          content,
          display: true,
          details: { runId: run?.id, name, agent: run?.agent, model: run?.model, thinking: run?.thinking, status, output, tokenCount, cost },
        },
        shutdown ? { triggerTurn: false, deliverAs: "nextTurn" } : { triggerTurn: true },
      );
    } catch { /* best-effort */ }
  };
}

interface RunDeps {
  makeStore?: (db: any) => RunStore;
  makeRunner?: (db: any, sessionId: string, cwd: string, deps: any) => any;
  makePipeline?: (deps: any) => any;
  spawner?: Spawner;
  resolveIntercom?: (cwd: string) => Promise<string[]>;
  getCoordinators?: (ctx: any) => SessionCoordinators;
}

/** The `run` action handler. Routes by args shape: pipeline > chain > tasks > single. */
export function makeRunHandler(overrides: RunDeps = {}): (args: any, ctx: any) => Promise<{ content: string; details: any }> {
  return async function runHandler(args: any, ctx: any) {
    const store = overrides.makeStore?.(ctx.db) ?? new RunStore(ctx.db, ctx.globalDb);
    const coords =
      overrides.getCoordinators?.(ctx) ??
      getCoordinators(ctx.sessionId, () => {
        const t = new RunEventTailer(ctx.db);
        t.start();
        const escalationNotifierCleanup = setupEscalationNotifier(ctx, store);
        return { tailer: t, pipelines: [], children: new Map(), escalationNotifierCleanup };
      });
    const tailer = coords.tailer;
    const spawn = overrides.spawner ?? defaultSpawner;
    const scratchRoot = paths.scratch("project", ctx.cwd);
    const dbPath = ctx.runDbPath ?? ctx.project?.dbPath ?? "";
    const onComplete = makeAsyncNotifier(ctx);
    const childMode = ctx.childMode ?? "rpc";
    let intercomExtensions: string[] = [], warning: string | undefined;
    if (childMode === "rpc" && ((!overrides.spawner && !overrides.makeRunner) || overrides.resolveIntercom)) {
      try { intercomExtensions = await (overrides.resolveIntercom ?? resolveChildIntercom)(ctx.cwd); }
      catch (error) { warning = `Cross-session steering unavailable: ${String((error as Error)?.message ?? error)}`; }
    }
    const thinkingDiagnostics: Array<{ model?: string; requested?: string; effective?: string; notice?: string; step?: number }> = [];
    const withWarning = (details: any) => ({ ...details, ...(warning ? { warning } : {}), ...(thinkingDiagnostics.length ? { thinkingDiagnostics } : {}) });
    const orchestratorTarget = childMode === "rpc" ? process.env.PI_INTERCOM_SESSION_ID ?? ctx.sessionId : undefined;
    const runnerDeps = { modelRegistry: ctx.modelRegistry ?? {}, globalDb: ctx.globalDb, store, tailer, spawn: (spec: Parameters<Spawner>[0]) => {
      if (spec.launchWarning) warning = [...new Set([warning, spec.launchWarning].filter(Boolean))].join("\n");
      return spawn(spec);
    }, scratchRoot, dbPath, onComplete, reportUsage: (run: import("../run-store").RunRow) => safelyReportUsage(ctx.db, run, row => ctx.reportUsage?.(ctx.db, row)), childMode, subagentOnlyExtensions: ctx.subagentOnlyExtensions, intercomExtensions, orchestratorTarget };
    const runner = overrides.makeRunner
      ? overrides.makeRunner(ctx.db, ctx.sessionId, ctx.cwd, runnerDeps)
      : new Runner(ctx.db, ctx.sessionId, ctx.cwd, runnerDeps);

    // Stamp the parent's current model + thinking level on runs that don't name one, so the
    // (static) run block and footer show them immediately instead of "—". Thinking is often
    // encoded as a model suffix (e.g. "prov/opus:high"); split it out so the model column stays
    // clean and the thinking level renders as its own segment. spawnFor uses the explicit --thinking flag.
    const parentModel: string | undefined = ctx.model?.id;
    // pi resolves a BARE model id (e.g. "claude-sonnet-5") to its default provider, which may
    // be unauthenticated in the child (→ silent "No API key" death). Qualify to the provider
    // pi lists as available (e.g. "github-copilot/claude-sonnet-5"). Already-qualified refs pass through.
    const piModels = listPiModels((ctx as { modelRegistry?: unknown }).modelRegistry);
    // models.defaults[<role>] (control models set), threaded in via ActionCtx because
    // subagents cannot import @spider/host to read config directly. Precedence: explicit
    // model: on the call -> the role's configured default -> inherit the parent (last
    // resort, so nothing regresses when no default is configured).
    const modelDefaults = (ctx as { modelDefaults?: Record<string, string> }).modelDefaults;
    const resolveMT = (m?: string, th?: string, role?: string, step?: number): { model?: string; thinking?: string } => {
      const full = resolveRoleModel(m, role, modelDefaults, parentModel);
      const model = qualifyModelProvider(stripThinkingSuffix(full), piModels);
      const thinking = th ?? thinkingFromModel(full);
      const resolution = resolveModelThinking(ctx.modelRegistry, model, thinking);
      if (resolution.notice) thinkingDiagnostics.push({ model, ...resolution, ...(step !== undefined ? { step } : {}) });
      return { model, thinking };
    };

    if (Array.isArray(args.pipeline)) {
      const coord = overrides.makePipeline
        ? overrides.makePipeline({ db: ctx.db, globalDb: ctx.globalDb, store, runner, pi: ctx.pi, sessionId: ctx.sessionId })
        : new PipelineCoordinator({ db: ctx.db, globalDb: ctx.globalDb, store, runner, pi: ctx.pi, sessionId: ctx.sessionId });
      coords.pipelines.push(coord);
      const pipeline = args.pipeline.map((stage: any) => ({ ...stage, ...resolveMT(stage.model, stage.thinking, stage.agent ?? "worker") }));
      const { pipelineId, firstRunId } = coord.start({ pipeline, handoff: args.handoff ?? "intercom", async: true });
      return { content: `pipeline ${pipelineId} started (${args.pipeline.length} stages), first run ${firstRunId}`, details: withWarning({ pipelineId, firstRunId }) };
    }
    if (Array.isArray(args.chain)) {
      // Async by design: kick the chain off in the background and report back when the last
      // step finishes (each step feeds the next). The tool returns immediately.
      const chain = args.chain.map((c: any, index: number) => ({ ...c, ...resolveMT(c.model, c.thinking, c.agent ?? "worker", index + 1) }));
      void runChain(runner, chain, { task: args.task ?? "", context: args.context ?? "fresh" })
        .then((rows: any[]) => {
          const last = rows[rows.length - 1];
          if (last) onComplete(last, last.status, last.result ?? undefined, rows);
        })
        .catch(() => { /* best-effort */ });
      const first = chain[0] ?? {};
      return { content: [`chain started: ${chain.length} step(s)`, ...thinkingDiagnostics.map(info => `step ${info.step}: ${info.notice}`)].join("\n"), details: withWarning({ chain: chain.length, first: first.name ?? first.agent }) };
    }
    if (Array.isArray(args.tasks)) {
      const tasks = args.tasks.map((t: any) => ({ ...t, ...resolveMT(t.model, t.thinking, t.agent) }));
      const rows = await runParallel(runner, tasks, { concurrency: args.concurrency, context: args.context ?? "fresh", async: true });
      const list = rows.map((r: any) => `  • ${r.name ?? r.agent} — ${r.id} (${r.status})`).join("\n");
      return { content: `parallel started: ${rows.length} run(s)\n${list}`, details: withWarning({ runs: rows }) };
    }
    const { model: singleModel, thinking: singleThinking } = resolveMT(args.model, args.thinking, args.agent ?? "worker");
    const row: any = await runSingle(runner, { agent: args.agent ?? "worker", task: args.task, name: args.name as string | undefined, model: singleModel, skill: args.skill, thinking: singleThinking, context: args.context ?? "fresh", async: true });
    return { content: `run "${row?.name ?? row?.agent}" — ${row?.id} (${row?.status})`, details: withWarning({ run: row }) };
  };
}

/**
 * Re-adopt this session's children that survived a /reload. Call from the NEW activation's
 * session_start with a fresh action context (its db, pi and session id). Nothing is created
 * unless there is something to adopt. Children owned by another session, or already attached,
 * are refused and left untouched (the registry's TTL reaps anything nobody adopts).
 */
export function adoptReloadedChildren(ctx: any, overrides: RunDeps = {}): AdoptResult {
  if (!adoptableFor(ctx.sessionId).length) return adoptShared(ctx.sessionId, () => {});
  const store = overrides.makeStore?.(ctx.db) ?? new RunStore(ctx.db, ctx.globalDb);
  const reg = sharedRegistry();
  const cursor = reg.tailCursors.get(ctx.sessionId);
  const coords = getCoordinators(ctx.sessionId, () => {
    const t = new RunEventTailer(ctx.db, cursor === undefined ? {} : { sinceId: cursor });
    t.start();
    return { tailer: t, pipelines: [], children: new Map(), escalationNotifierCleanup: setupEscalationNotifier(ctx, store) };
  });
  reg.tailCursors.delete(ctx.sessionId);
  const currentPath = ctx.runDbPath ?? ctx.project?.dbPath ?? "";
  const resources = new Map<string, { db: Db; store: RunStore; tailer: RunEventTailer }>();
  resources.set(currentPath, { db: ctx.db, store, tailer: coords.tailer });
  const cleanups: Array<() => void> = [];
  const previousCleanup = coords.adoptionCleanup;
  coords.adoptionCleanup = () => {
    previousCleanup?.();
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
  const result = adoptShared(ctx.sessionId, entry => {
    let resource = resources.get(entry.dbPath);
    if (!resource) {
      // /bind or /unbind may have changed the session DB. The live child's recorded path is
      // authoritative; never move its history or cancel bookkeeping into the new session DB.
      const db = openDb(entry.dbPath, { fileMustExist: true });
      try {
        const ownStore = overrides.makeStore?.(db) ?? new RunStore(db, ctx.globalDb);
        const tailer = new RunEventTailer(db, cursor === undefined ? {} : { sinceId: cursor });
        const off = setupEscalationNotifier(ctx, ownStore);
        tailer.start();
        resource = { db, store: ownStore, tailer };
        resources.set(entry.dbPath, resource);
        cleanups.push(() => { tailer.stop(); off(); db.close(); });
      } catch (error) { db.close(); throw error; }
    }
    const runner = new Runner(resource.db, ctx.sessionId, ctx.cwd, {
      globalDb: ctx.globalDb, store: resource.store, tailer: resource.tailer,
      // Adoption never launches; a spawn here is a bug, not a silent child.
      spawn: () => { throw new Error("adopted runner cannot spawn"); },
      scratchRoot: paths.scratch("project", ctx.cwd), dbPath: entry.dbPath,
      onComplete: makeAsyncNotifier({ ...ctx, db: resource.db }), reportUsage: run => safelyReportUsage(resource!.db, run, row => ctx.reportUsage?.(resource!.db, row)), childMode: entry.mode,
    });
    runner.adopt(entry);
  });
  reportAdoptionFailures(ctx, result);
  return result;
}

/** A child this session owns that could not be re-adopted stays under its TTL, but the user and the
 *  run's own history must hear about it: it will be stopped, and nothing else says why. */
function reportAdoptionFailures(ctx: any, result: AdoptResult): void {
  for (const { runId, reason } of result.refused) {
    if (!reason.startsWith("adoption failed")) continue;
    const message = `Subagent run ${runId} could not be re-adopted after the reload (${reason}). It is no longer reported and will be stopped if it is not re-adopted soon.`;
    try { ctx.ui?.notify?.(message, "warning"); } catch { /* best-effort */ }
    let db: Db | undefined;
    try {
      const entry = getShared(runId);
      if (!entry) continue;
      db = openDb(entry.dbPath, { fileMustExist: true });
      // A deleted row is not a run history. Never leave orphan diagnostics in any DB.
      if (!new RunStore(db).get(runId)) continue;
      appendRunEvent(db, { runId, sessionId: entry.sessionId, ts: Date.now(), type: "warning", summary: message, payload: { type: "warning", message, adoptionFailed: true } });
    } catch { /* missing or inaccessible run DB: the UI warning above is still visible */ }
    finally { try { db?.close(); } catch { /* best-effort */ } }
  }
}
