import { appendRunEvent, type Db } from "@spider/db-core";
import { RunStore, type RunRow, type RunStatus } from "./run-store";
import { RunEventTailer } from "./event-tailer";
import { emitStatus } from "./run-events";
import { buildChildSpawnSpec, type ChildSpawnSpec } from "./pi-args";
import { registerChild, unregisterChild } from "./coordinators";
import { genuineCompletion, NO_DELIVERABLE_RESULT } from "./completion-output";

export { NO_DELIVERABLE_RESULT };

export interface ChildHandle {
  pid?: number;
  startTime?: string | null;
  cancellationReason?: string;
  wait(): Promise<{ exitCode: number; result?: string }>;
  kill(reason?: string): void;
  killAsync?(graceMs?: number, reason?: string): Promise<void>;
  steer?(message: string): Promise<import("./rpc-child").SteerAck>;
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
    private deps: { globalDb?: Db; store: RunStore; tailer: RunEventTailer; spawn: Spawner; scratchRoot: string; dbPath: string; childMode?: "rpc" | "print"; intercomExtensions?: string[]; orchestratorTarget?: string; onComplete?: (run: RunRow, status: RunStatus, result?: string) => void }
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
      // Even if both launch status transactions fail, the reaper can find this
      // queued row once its owning host exits. No child has been spawned yet.
      hostPid: process.pid,
    });
    return this.deps.store.get(id)!;
  }

  private spawnFor(run: RunRow, opts: RunOpts): ChildHandle {
    const spec = buildChildSpawnSpec({
      runId: run.id,
      sessionId: this.sessionId,
      agent: opts.agent,
      role: opts.role,
      name: run.name ?? undefined,
      childMode: this.deps.childMode,
      intercomExtensions: this.deps.intercomExtensions,
      task: opts.task,
      model: opts.model,
      thinking: opts.thinking,
      context: opts.context,
      parentSessionId: this.sessionId,
      childIndex: opts.childIndex ?? 0,
      skill: opts.skill,
      dbPath: this.deps.dbPath,
      scratchRoot: this.deps.scratchRoot,
      orchestratorTarget: opts.orchestratorTarget ?? this.deps.orchestratorTarget,
      intercomSessionName: opts.intercomSessionName ?? run.name ?? undefined,
      cwd: this.cwd,
    });
    this.deps.store.setLaunch(run.id, {
      childMode: spec.childMode ?? "print",
      intercomSession: spec.childMode === "rpc" && this.deps.intercomExtensions?.length
        ? spec.env.PI_SUBAGENT_INTERCOM_SESSION_NAME : undefined,
    });
    this.deps.globalDb?.prepare("INSERT INTO run_routes (run_id,session_id,db_path) VALUES (?,?,?)")
      .run(run.id, this.sessionId, this.deps.dbPath);
    spec.onRpcEvent = event => {
      if (["warning", "extension_error", "queue_update", "steer_delivery"].includes(event.type)) {
        appendRunEvent(this.db, { runId: run.id, sessionId: this.sessionId, ts: Date.now(), type: event.type,
          summary: event.message ?? event.error ?? "Child pending queue changed.", payload: event });
      }
    };
    if (spec.launchWarning) spec.onRpcEvent({ type: "warning", message: spec.launchWarning, launchWarning: true, printFallback: spec.childMode === "print" });
    return this.deps.spawn(spec);
  }

  private ownHandle(run: RunRow, handle: ChildHandle): ChildHandle {
    const kill = handle.kill.bind(handle);
    const killAsync = handle.killAsync?.bind(handle);
    let exited = false;
    const exit = handle.wait().then(value => { exited = true; return value; }, error => { exited = true; throw error; });
    handle.wait = () => exit;
    const restore = (reason: string, before: RunRow | undefined, previousReason: string | undefined) => {
      // An exit report is final even if group termination later fails during grace.
      if (exited) { this.removeRoute(run.id); return; }
      handle.cancellationReason = previousReason;
      this.uncancel(run.id, reason, before);
    };
    handle.kill = (reason = "Run killed from another path.") => {
      const previousReason = handle.cancellationReason;
      const before = this.deps.store.get(run.id);
      handle.cancellationReason = reason;
      try { this.deps.store.cancel(run.id, reason); } catch { /* the kill must still run; finalize records the reason */ }
      try { kill(); } catch (error) {
        try { restore(reason, before, previousReason); }
        catch (restoreError) { throw new AggregateError([error, restoreError], `Kill failed: ${String(error)}; restore failed: ${String(restoreError)}`); }
        throw error;
      }
      this.removeRoute(run.id);
    };
    if (killAsync) handle.killAsync = async (graceMs, reason = "Run killed from another path.") => {
      const previousReason = handle.cancellationReason;
      const before = this.deps.store.get(run.id);
      handle.cancellationReason = reason;
      try { this.deps.store.cancel(run.id, reason); } catch { /* the kill must still run; finalize records the reason */ }
      try { await killAsync(graceMs); } catch (error) {
        try { restore(reason, before, previousReason); }
        catch (restoreError) { throw new AggregateError([error, restoreError], `Kill failed: ${String(error)}; restore failed: ${String(restoreError)}`); }
        throw error;
      }
      this.removeRoute(run.id);
    };
    registerChild(this.sessionId, run.id, handle);
    return handle;
  }

  /** Undo only our optimistic cancellation, never a different terminal outcome. */
  private uncancel(runId: string, reason: string, before: RunRow | undefined): void {
    if (!before || !["queued", "running", "paused"].includes(before.status)) return;
    const changed = this.db.transaction(() => {
      const changed = this.db.prepare("UPDATE runs SET status=?, ended_at=?, result=? WHERE id=? AND status='cancelled' AND result IS ?")
        .run(before.status, before.ended_at, before.result, runId, reason).changes;
      if (changed) emitStatus(this.db, { runId, sessionId: this.sessionId, status: before.status, summary: before.name ?? undefined });
      return changed;
    })();
    if (!changed) return;
    this.db.afterCommit(() => {
      this.deps.globalDb?.prepare("INSERT OR REPLACE INTO run_routes (run_id,session_id,db_path) VALUES (?,?,?)")
        .run(runId, this.sessionId, this.deps.dbPath);
    });
  }

  private removeRoute(runId: string): void {
    try { this.deps.globalDb?.prepare("DELETE FROM run_routes WHERE run_id=?").run(runId); } catch { /* cleanup cannot mask the run outcome */ }
  }

  private launch(run: RunRow, opts: RunOpts): ChildHandle | undefined {
    let handle: ChildHandle | undefined;
    try {
      this.db.transaction(() => {
        this.deps.store.start(run.id);
        emitStatus(this.db, { runId: run.id, sessionId: this.sessionId, status: "running", summary: run.name ?? undefined });
      })();
      this.deps.tailer.track(run.id);
      handle = this.spawnFor(run, opts);
      if (handle.pid !== undefined) this.deps.store.setPid(run.id, handle.pid, process.pid, handle.startTime);
      return this.ownHandle(run, handle);
    } catch (error) {
      const result = `Child launch failed: ${String((error as Error)?.message ?? error)}`;
      try {
        this.db.transaction(() => {
          this.deps.store.finish(run.id, { status: "failed", result }, { removeRoute: false });
          emitStatus(this.db, { runId: run.id, sessionId: this.sessionId, status: "failed", summary: result });
        })();
      } finally {
        try { handle?.kill(); } finally { unregisterChild(this.sessionId, run.id); this.removeRoute(run.id); }
      }
      this.deps.onComplete?.(this.deps.store.get(run.id) ?? run, "failed", result);
      return undefined;
    }
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
  private finalize(run: RunRow, exitCode: number, waitResult: string | undefined, cancellationReason?: string): { status: RunStatus; result?: string } {
    const cur = this.deps.store.get(run.id);
    if (cur && (cur.status === "queued" || cur.status === "running" || cur.status === "paused")) {
      const outcome = this.withSteerSummary(run.id, cancellationReason ? { status: "cancelled" as const, result: cancellationReason } : decideOutcome(this.db, run.id, exitCode, waitResult));
      this.db.transaction(() => {
        this.deps.store.finish(run.id, outcome, { removeRoute: false });
        emitStatus(this.db, { runId: run.id, sessionId: this.sessionId, status: outcome.status, summary: run.name ?? undefined });
      })();
      this.db.afterCommit(() => this.removeRoute(run.id));
      return outcome;
    }
    const outcome = this.withSteerSummary(run.id, { status: (cur?.status as RunStatus) ?? (exitCode === 0 ? "done" : "failed"), result: cur?.result ?? undefined });
    if (outcome.result !== cur?.result) this.db.prepare("UPDATE runs SET result=? WHERE id=?").run(outcome.result ?? null, run.id);
    this.db.afterCommit(() => this.removeRoute(run.id));
    return outcome;
  }

  private withSteerSummary(runId: string, outcome: { status: RunStatus; result?: string }): { status: RunStatus; result?: string } {
    const events = this.db.prepare("SELECT payload FROM run_events WHERE run_id=? AND type='steer_delivery'").all(runId) as Array<{ payload: string }>;
    const undelivered = new Set<string>();
    for (const event of events) {
      try { const payload = JSON.parse(event.payload); if (payload.delivered === false) undelivered.add(payload.requestId); } catch { /* malformed diagnostics do not change the outcome */ }
    }
    if (!undelivered.size) return outcome;
    const summary = `${undelivered.size} accepted steer(s) were not delivered.`;
    const result = outcome.result?.includes(summary) ? outcome.result : [outcome.result, summary].filter(Boolean).join("\n\n");
    return { ...outcome, result };
  }

  async runForeground(opts: RunOpts): Promise<RunRow> {
    const run = this.makeRun(opts);
    const handle = this.launch(run, opts);
    if (!handle) return this.deps.store.get(run.id)!;
    try {
      const { exitCode, result } = await handle.wait();
      this.finalize(run, exitCode, result, handle.cancellationReason);
      const finished = this.deps.store.get(run.id)!;
      if (!opts.async && finished.status === "cancelled") this.deps.onComplete?.(finished, finished.status, finished.result ?? undefined);
      return finished;
    } catch (error) {
      const outcome = this.finalize(run, 1, `Child wait failed: ${String(error)}`, handle.cancellationReason);
      this.deps.onComplete?.(this.deps.store.get(run.id) ?? run, outcome.status, outcome.result);
      return this.deps.store.get(run.id)!;
    } finally {
      unregisterChild(this.sessionId, run.id);
    }
  }

  runAsync(opts: RunOpts): RunRow {
    const run = this.makeRun(opts);
    const handle = this.launch(run, opts);
    if (!handle) return this.deps.store.get(run.id)!;
    // Finalize the row on child EXIT even if the child-reporter missed session_shutdown
    // (headless/killed children) — otherwise the run is stuck "running" in the UI.
    void handle.wait().then(({ exitCode, result }) => {
      const outcome = this.finalize(run, exitCode, result, handle.cancellationReason);
      // Async completion notification: let the parent agent (and human) know a background
      // subagent finished. Fired EXACTLY ONCE per child exit, whether the parent or the child
      // finalized the row. Cancellation carries the persisted cause as well.
      this.deps.onComplete?.(this.deps.store.get(run.id) ?? run, outcome.status, outcome.result);
    }).catch(error => {
      const outcome = this.finalize(run, 1, `Child wait failed: ${String(error)}`, handle.cancellationReason);
      this.deps.onComplete?.(this.deps.store.get(run.id) ?? run, outcome.status, outcome.result);
    }).catch(error => {
      // Both atomic finalization attempts failed. Keep row/event atomicity rather
      // than inventing an unlogged terminal outcome. host_pid was saved at create;
      // a later session's reaper reconciles the row after this host exits.
      // Do not notify completion or leave an unhandled rejection.
      try {
        appendRunEvent(this.db, { runId: run.id, sessionId: this.sessionId, ts: Date.now(), type: "warning",
          summary: `Finalization failed; reconciliation requires host exit: ${String(error)}` });
      } catch { /* a broken DB may also reject the diagnostic */ }
    }).finally(() => {
      unregisterChild(this.sessionId, run.id);
    });
    handle.detach();
    return this.deps.store.get(run.id)!;
  }
}
