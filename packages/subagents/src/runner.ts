import type { Db } from "@spider/db-core";
import { RunStore, type RunRow, type RunStatus } from "./run-store";
import { RunEventTailer } from "./event-tailer";
import { emitStatus } from "./run-events";
import { buildChildSpawnSpec, type ChildSpawnSpec } from "./pi-args";
import { registerChild, unregisterChild } from "./coordinators";
import { genuineCompletion, NO_DELIVERABLE_RESULT } from "./completion-output";

export { NO_DELIVERABLE_RESULT };

export interface ChildHandle {
  pid?: number;
  wait(): Promise<{ exitCode: number; result?: string }>;
  kill(): void;
  detach(): void;
}

export type Spawner = (spec: ChildSpawnSpec) => ChildHandle;

/** A missing/blank result: no deliverable, not even an empty-but-intentional string. */
function isBlankResult(result: string | null | undefined): boolean {
  return result == null || result.trim().length === 0;
}

/**
 * Decide a child's terminal status + result from its raw exit outcome.
 *
 * The production spawner (`spawn-default.ts`) NEVER resolves `wait()` with a `result` —
 * only test/fake spawners do. So the real deliverable must come from `run_events`
 * (`genuineCompletion`, sourced from the child's own `message`/`escalation` events), not
 * from `waitResult`. A clean exit code is necessary but NOT sufficient for success: a
 * child that escalates/blocks and then exits 0 without ever producing a deliverable must
 * not be recorded "done" — that hides the escalation from anything keying on status alone.
 *
 * `waitResult`, when a spawner does supply one (tests, or a future spawner), is honored
 * as-is — it is an explicit, non-blank claim of a result and takes precedence.
 *
 * A single function so BOTH call sites (the sync runForeground path and the async
 * runAsync parent-finalizes path) apply the same rule via `Runner.finalize` — fixing
 * only one is a half-fix.
 */
function decideOutcome(db: Db, runId: string, exitCode: number, waitResult: string | null | undefined): { status: RunStatus; result?: string } {
  if (!isBlankResult(waitResult)) {
    return { status: exitCode === 0 ? "done" : "failed", result: waitResult ?? undefined };
  }
  const completion = genuineCompletion(db, runId);
  if (exitCode !== 0) {
    const detail = completion.done ? completion.result : completion.reason;
    return { status: "failed", result: `Child process exited with code ${exitCode}.${detail ? `\n\n${detail}` : ""}` };
  }
  return completion.done
    ? { status: "done", result: completion.result }
    : { status: "failed", result: completion.reason ?? NO_DELIVERABLE_RESULT };
}


export interface RunOpts {
  agent: string;
  role?: string;
  name?: string;
  task: string;
  model?: string;
  skill?: string;
  thinking?: string;
  context: "fresh" | "fork";
  phase?: string;
  parentRunId?: string;
  async?: boolean;
  orchestratorTarget?: string;
  childIndex?: number;
  intercomSessionName?: string;
}

export class Runner {
  constructor(
    private db: Db,
    private sessionId: string,
    private cwd: string,
    private deps: { store: RunStore; tailer: RunEventTailer; spawn: Spawner; scratchRoot: string; dbPath: string; onComplete?: (run: RunRow, status: RunStatus, result?: string) => void }
  ) {}

  private makeRun(opts: RunOpts): RunRow {
    const { id } = this.deps.store.create({
      sessionId: this.sessionId,
      parentRunId: opts.parentRunId,
      agent: opts.agent,
      role: opts.role,
      name: opts.name,
      phase: opts.phase,
      model: opts.model,
      task: opts.task,
      thinking: opts.thinking,
    });
    return this.deps.store.get(id)!;
  }

  private spawnFor(run: RunRow, opts: RunOpts): ChildHandle {
    const spec = buildChildSpawnSpec({
      runId: run.id,
      sessionId: this.sessionId,
      agent: opts.agent,
      role: opts.role,
      task: opts.task,
      model: opts.model,
      thinking: opts.thinking,
      context: opts.context,
      parentSessionId: this.sessionId,
      childIndex: opts.childIndex ?? 0,
      skill: opts.skill,
      dbPath: this.deps.dbPath,
      scratchRoot: this.deps.scratchRoot,
      orchestratorTarget: opts.orchestratorTarget,
      intercomSessionName: opts.intercomSessionName ?? run.name ?? undefined,
      cwd: this.cwd,
    });
    return this.deps.spawn(spec);
  }

  /**
   * Single shared finalization path for BOTH the sync (runForeground) and async
   * (runAsync) call sites — fixing only one is a half-fix.
   *
   * If the child already finalized its own row (self-reported terminal status via
   * `child-reporter`'s `onShutdown`, or it was cancelled by a kill racing the exit),
   * that status/result is the single source of truth: it is honored VERBATIM, never
   * recomputed or re-emitted. Recomputing here was the C2 regression — every
   * successful chain step got a bogus "failed" status event appended even though the
   * DB row stayed "done" (the row write is guarded; the status-event emit was not).
   *
   * Only when the row is still non-terminal (queued/running/paused — the child never
   * finalized: headless/killed) does the parent compute + persist + emit the outcome,
   * via `decideOutcome` (which itself defers to `genuineCompletion`/run_events rather
   * than the production spawner's always-absent `waitResult`).
   */
  private finalize(run: RunRow, exitCode: number, waitResult: string | undefined): { status: RunStatus; result?: string } {
    const cur = this.deps.store.get(run.id);
    if (cur && (cur.status === "queued" || cur.status === "running" || cur.status === "paused")) {
      const outcome = decideOutcome(this.db, run.id, exitCode, waitResult);
      this.deps.store.finish(run.id, outcome);
      emitStatus(this.db, { runId: run.id, sessionId: this.sessionId, status: outcome.status, summary: run.name ?? undefined });
      return outcome;
    }
    return { status: (cur?.status as RunStatus) ?? (exitCode === 0 ? "done" : "failed"), result: cur?.result ?? undefined };
  }

  async runForeground(opts: RunOpts): Promise<RunRow> {
    const run = this.makeRun(opts);
    this.deps.store.start(run.id);
    // Track even foreground runs so the child's tool activity (written to the DB in the
    // child process) is tailed back onto the in-process bus → the live UI feed.
    this.deps.tailer.track(run.id);
    emitStatus(this.db, { runId: run.id, sessionId: this.sessionId, status: "running", summary: run.name ?? undefined });
    const handle = this.spawnFor(run, opts);
    const { exitCode, result } = await handle.wait();
    this.finalize(run, exitCode, result);
    return this.deps.store.get(run.id)!;
  }

  runAsync(opts: RunOpts): RunRow {
    const run = this.makeRun(opts);
    this.deps.store.start(run.id);
    this.deps.tailer.track(run.id);
    emitStatus(this.db, { runId: run.id, sessionId: this.sessionId, status: "running", summary: run.name ?? undefined });
    const handle = this.spawnFor(run, opts);
    // Retain the handle (in-process fast path for kill + session_shutdown teardown) and
    // persist the pid (fallback path after a host reload, when the map is empty but the
    // child is still alive). Previously the handle was detached and DROPPED, which is
    // why killing a subagent meant hunting the pi process by hand.
    registerChild(this.sessionId, run.id, handle);
    if (handle.pid !== undefined) {
      try { this.deps.store.setPid(run.id, handle.pid, process.pid); } catch { /* best-effort */ }
    }
    // Finalize the row on child EXIT even if the child-reporter missed session_shutdown
    // (headless/killed children) — otherwise the run is stuck "running" in the UI.
    void handle.wait().then(({ exitCode, result }) => {
      const outcome = this.finalize(run, exitCode, result);
      // Async completion notification: let the parent agent (and human) know a background
      // subagent finished. Fired EXACTLY ONCE per child exit, whether the parent or the child
      // finalized the row. A CANCELLED run is a deliberate stop — the notifier suppresses it
      // (see makeAsyncNotifier), so killing an agent does not wake the orchestrator.
      this.deps.onComplete?.(this.deps.store.get(run.id) ?? run, outcome.status, outcome.result);
    }).catch(() => { /* best-effort finalize */ }).finally(() => {
      unregisterChild(this.sessionId, run.id);
    });
    handle.detach();
    return this.deps.store.get(run.id)!;
  }
}
