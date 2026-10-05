import { appendRunEvent, type Db } from "@spider/db-core";
import { RunStore, type RunRow, type RunStatus } from "./run-store";
import { RunEventTailer } from "./event-tailer";
import { emitStatus } from "./run-events";
import { buildChildSpawnSpec, type ChildSpawnSpec } from "./pi-args";
import { registerChild, unregisterChild } from "./coordinators";
import { resolveModelThinking } from "./model-resolve";
import { registerShared, releaseShared, setSink, type CompletionSink, type SharedChildEntry, type SharedHandle } from "./child-registry";
import { decideOutcome, NO_DELIVERABLE_RESULT, summarizeCompletionEvents } from "./completion-output";
import { isHandledPrompt, PERSISTED_EVENT_TYPES } from "./rpc-child";
import { recordRunUsage, safelyReportUsage, warnUsage } from "./usage";

export { NO_DELIVERABLE_RESULT };

export interface ChildHandle {
  pid?: number;
  startTime?: string | null;
  cancellationReason?: string;
  wait(): Promise<{ exitCode: number; result?: string }>;
  kill(reason?: string): void;
  killAsync?(graceMs?: number, reason?: string): Promise<void>;
  steer?(message: string): Promise<import("./rpc-child").SteerAck>;
  /** Route RPC events to a new sink (flushing the reload buffer). Absent on print-mode children. */
  bindEvents?(sink: (event: Record<string, any>) => void): void;
  /** Buffer RPC events instead of calling the previous activation's sink (reload). */
  unbindEvents?(): void;
  detach(): void;
}

export type Spawner = (spec: ChildSpawnSpec) => ChildHandle;

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
    private deps: { modelRegistry?: unknown; globalDb?: Db; store: RunStore; tailer: RunEventTailer; spawn: Spawner; scratchRoot: string; dbPath: string; childMode?: "rpc" | "print"; subagentOnlyExtensions?: string[]; intercomExtensions?: string[]; orchestratorTarget?: string; reportUsage?: (run: RunRow) => void; onComplete?: (run: RunRow, status: RunStatus, result?: string) => void }
  ) {}

  private makeRun(opts: RunOpts): RunRow {
    const thinking = this.deps.modelRegistry === undefined ? undefined : resolveModelThinking(this.deps.modelRegistry, opts.model, opts.thinking);
    const { id } = this.deps.store.create({
      sessionId: this.sessionId,
      parentRunId: opts.parentRunId,
      agent: opts.agent,
      role: opts.role,
      name: opts.name,
      phase: opts.phase,
      model: opts.model,
      task: opts.task,
      thinking: thinking ? thinking.effective : opts.thinking,
      // Even if both launch status transactions fail, the reaper can find this
      // queued row once its owning host exits. No child has been spawned yet.
      hostPid: process.pid,
    });
    if (thinking?.notice) appendRunEvent(this.db, { runId: id, sessionId: this.sessionId, ts: Date.now(), type: "warning", summary: thinking.notice, payload: { thinkingNotice: true, ...thinking, message: thinking.notice } });
    return this.deps.store.get(id)!;
  }

  private spawnFor(run: RunRow, opts: RunOpts): { handle: ChildHandle; mode: "rpc" | "print"; intercomSession?: string } {
    const spec = buildChildSpawnSpec({
      runId: run.id,
      sessionId: this.sessionId,
      agent: opts.agent,
      role: opts.role,
      name: run.name ?? undefined,
      childMode: this.deps.childMode,
      subagentOnlyExtensions: this.deps.subagentOnlyExtensions,
      intercomExtensions: this.deps.intercomExtensions,
      task: opts.task,
      model: opts.model,
      // The run row holds only the verified level. Unknown models pass the request to pi.
      thinking: run.thinking ?? opts.thinking,
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
    const intercomSession = spec.childMode === "rpc" && this.deps.intercomExtensions?.length
      ? spec.env.PI_SUBAGENT_INTERCOM_SESSION_NAME : undefined;
    this.deps.store.setLaunch(run.id, { childMode: spec.childMode ?? "print", intercomSession });
    this.deps.globalDb?.prepare("INSERT INTO run_routes (run_id,session_id,db_path) VALUES (?,?,?)")
      .run(run.id, this.sessionId, this.deps.dbPath);
    spec.onRpcEvent = this.rpcSink(run);
    for (const message of spec.extensionWarnings ?? []) spec.onRpcEvent({ type: "warning", message });
    if (spec.launchWarning) spec.onRpcEvent({ type: "warning", message: spec.launchWarning, launchWarning: true, printFallback: spec.childMode === "print" });
    return { handle: this.deps.spawn(spec), mode: spec.childMode === "rpc" ? "rpc" : "print", intercomSession };
  }

  /** Persist the RPC events worth keeping. Rebuilt per activation so a reload rebinds it to the new DB. */
  private rpcSink(run: RunRow): (event: Record<string, any>) => void {
    return event => {
      if (event.type === "spider_usage") {
        try { recordRunUsage(this.db, run.id, { provider: event.provider, model: event.model, usage: event.usage }, event.purpose, event.compactionCount); }
        catch (error) { warnUsage(this.db, run, error); }
      } else if (PERSISTED_EVENT_TYPES.includes(event.type)) {
        appendRunEvent(this.db, { runId: run.id, sessionId: this.sessionId, ts: Date.now(), type: event.type,
          summary: event.message ?? event.error ?? (event.type === "spider_compaction" ? "Child compacted." : "Child pending queue changed."), payload: event });
        if (event.type === "warning" && isHandledPrompt(event)) {
          // This sink runs before stdin EOF. Reuse the normal finalizer so the
          // child's shutdown reporter sees a terminal row, with its guards intact.
          // Usage and the completion notice still belong to the child-exit path.
          this.finalize(run, 1, event.message, undefined, { handledPrompt: true, deferUsage: true });
        }
      }
    };
  }

  /** `shared` registers the child in the process-wide registry (new launches). Adoption omits it:
   *  the entry already exists and `handle` is a fresh object over the entry's raw handle. */
  private ownHandle(run: RunRow, handle: ChildHandle, shared?: { mode: "rpc" | "print"; intercomSession?: string; survivable: boolean }): ChildHandle {
    const kill = handle.kill.bind(handle);
    const killAsync = handle.killAsync?.bind(handle);
    let exited = false;
    const exit = handle.wait().then(value => { exited = true; return value; }, error => { exited = true; throw error; });
    handle.wait = () => exit;
    // Snapshot BEFORE the cancel bookkeeping below is bound to this activation's DB: a reloaded
    // activation re-wraps the raw handle with its own store instead of calling into ours.
    const raw: SharedHandle = {
      pid: handle.pid, startTime: handle.startTime, wait: () => exit,
      kill: () => kill(), ...(killAsync ? { killAsync: (graceMs?: number) => killAsync(graceMs) } : {}),
      ...(handle.steer ? { steer: handle.steer.bind(handle) } : {}),
      ...(handle.bindEvents ? { bindEvents: handle.bindEvents.bind(handle) } : {}),
      ...(handle.unbindEvents ? { unbindEvents: handle.unbindEvents.bind(handle) } : {}),
    };
    if (shared) registerShared({ runId: run.id, sessionId: this.sessionId, dbPath: this.deps.dbPath, handle: raw, ...shared });
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

  private launch(run: RunRow, opts: RunOpts, survivable: boolean): ChildHandle | undefined {
    let handle: ChildHandle | undefined;
    try {
      this.db.transaction(() => {
        this.deps.store.start(run.id);
        emitStatus(this.db, { runId: run.id, sessionId: this.sessionId, status: "running", summary: run.name ?? undefined });
      })();
      this.deps.tailer.track(run.id);
      const spawned = this.spawnFor(run, opts);
      handle = spawned.handle;
      if (handle.pid !== undefined) this.deps.store.setPid(run.id, handle.pid, process.pid, handle.startTime);
      return this.ownHandle(run, handle, { mode: spawned.mode, intercomSession: spawned.intercomSession, survivable });
    } catch (error) {
      const result = `Child launch failed: ${String((error as Error)?.message ?? error)}`;
      try {
        this.db.transaction(() => {
          this.deps.store.finish(run.id, { status: "failed", result }, { removeRoute: false });
          emitStatus(this.db, { runId: run.id, sessionId: this.sessionId, status: "failed", summary: result });
        })();
      } finally {
        try { handle?.kill(); } finally { unregisterChild(this.sessionId, run.id); releaseShared(run.id); this.removeRoute(run.id); }
      }
      safelyReportUsage(this.db, this.deps.store.get(run.id) ?? run, this.deps.reportUsage);
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
   * A handled initial prompt may refine a failed child's generic shutdown result,
   * without another terminal transition. Cancellation still takes precedence.
   *
   * Only when the row is still non-terminal (queued/running/paused — the child never
   * finalized: headless/killed) does the parent compute + persist + emit the outcome,
   * via `decideOutcome` (which itself defers to `genuineCompletion`/run_events rather
   * than the production spawner's always-absent `waitResult`).
   */
  private finalize(run: RunRow, exitCode: number, waitResult: string | undefined, cancellationReason?: string, options: { handledPrompt?: boolean; deferUsage?: boolean } = {}): { status: RunStatus; result?: string } {
    let cur = this.deps.store.get(run.id);
    if (cur && (cur.status === "queued" || cur.status === "running" || cur.status === "paused")) {
      const outcome = this.withSteerSummary(run.id, cancellationReason ? { status: "cancelled" as const, result: cancellationReason } : decideOutcome(this.db, run.id, exitCode, waitResult));
      const changed = this.db.transaction(() => {
        const changed = this.deps.store.finish(run.id, outcome, { removeRoute: false });
        if (changed) emitStatus(this.db, { runId: run.id, sessionId: this.sessionId, status: outcome.status, summary: run.name ?? undefined });
        return changed;
      })();
      if (changed) {
        this.db.afterCommit(() => this.removeRoute(run.id));
        if (!options.deferUsage) safelyReportUsage(this.db, this.deps.store.get(run.id) ?? run, this.deps.reportUsage);
        return outcome;
      }
      // A live child's reporter can commit between our read and guarded finish.
      cur = this.deps.store.get(run.id);
    }
    const genericResult = this.withSteerSummary(run.id, { status: "failed", result: NO_DELIVERABLE_RESULT }).result;
    const refine = options.handledPrompt && cur?.status === "failed" && !cancellationReason
      && (cur.result === NO_DELIVERABLE_RESULT || cur.result === genericResult);
    const result = refine ? waitResult : cur?.result ?? undefined;
    let outcome = this.withSteerSummary(run.id, { status: (cur?.status as RunStatus) ?? (exitCode === 0 ? "done" : "failed"), result });
    if (outcome.result !== cur?.result) {
      if (refine) {
        const changed = this.db.prepare("UPDATE runs SET result=? WHERE id=? AND status='failed' AND result=?")
          .run(outcome.result ?? null, run.id, cur!.result).changes;
        if (!changed) {
          const latest = this.deps.store.get(run.id);
          outcome = { status: latest?.status ?? outcome.status, result: latest?.result ?? undefined };
        }
      } else this.db.prepare("UPDATE runs SET result=? WHERE id=?").run(outcome.result ?? null, run.id);
    }
    this.db.afterCommit(() => this.removeRoute(run.id));
    if (!options.deferUsage) safelyReportUsage(this.db, this.deps.store.get(run.id) ?? run, this.deps.reportUsage);
    return outcome;
  }

  private withSteerSummary(runId: string, outcome: { status: RunStatus; result?: string }): { status: RunStatus; result?: string } {
    const { steerSummary, eventsLost } = summarizeCompletionEvents(this.db, runId);
    if (!steerSummary && !eventsLost) return outcome;
    const notes = [steerSummary];
    if (eventsLost) notes.push(`${eventsLost} child event(s) were lost during reload; this run's recorded history is incomplete.`);
    let result = outcome.result;
    for (const note of notes) if (note && !result?.includes(note)) result = [result, note].filter(Boolean).join("\n\n");
    return { ...outcome, result };
  }

  async runForeground(opts: RunOpts): Promise<RunRow> {
    const run = this.makeRun(opts);
    const handle = this.launch(run, opts, false);
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
      releaseShared(run.id);
    }
  }

  /**
   * The completion path for an async child: finalize the row, notify once, release. It is installed
   * as the registry entry's sink, so a reload can drop it (the old activation is dead) and the
   * reloaded activation installs its own. The registry hands over the exit exactly once.
   * Fired EXACTLY ONCE per child exit, whether the parent or the child finalized the row.
   * Cancellation carries the persisted cause as well.
   */
  private completionSink(run: RunRow, handle: ChildHandle): CompletionSink {
    return (_entry, { exitCode, result }) => {
      try {
        const outcome = this.finalize(run, exitCode, result, handle.cancellationReason);
        this.deps.onComplete?.(this.deps.store.get(run.id) ?? run, outcome.status, outcome.result);
      } catch (error) {
        try {
          const outcome = this.finalize(run, 1, `Child wait failed: ${String(error)}`, handle.cancellationReason);
          this.deps.onComplete?.(this.deps.store.get(run.id) ?? run, outcome.status, outcome.result);
        } catch (finalizeError) {
          // Both atomic finalization attempts failed. Keep the row/event unchanged
          // and leave reconciliation to the reaper after the recorded host exits.
          try {
            appendRunEvent(this.db, { runId: run.id, sessionId: this.sessionId, ts: Date.now(), type: "warning",
              summary: `Finalization failed; reconciliation requires host exit: ${String(finalizeError)}` });
          } catch { /* a broken DB may also reject the diagnostic */ }
        }
      } finally {
        unregisterChild(this.sessionId, run.id);
        releaseShared(run.id);
      }
    };
  }

  runAsync(opts: RunOpts): RunRow {
    const run = this.makeRun(opts);
    const handle = this.launch(run, opts, true);
    if (!handle) return this.deps.store.get(run.id)!;
    // Finalize the row on child EXIT even if the child-reporter missed session_shutdown
    // (headless/killed children) — otherwise the run is stuck "running" in the UI.
    setSink(run.id, this.completionSink(run, handle));
    handle.detach();
    return this.deps.store.get(run.id)!;
  }

  /**
   * Take over a child that survived a /reload (see child-registry.ts). Builds a fresh handle over
   * the entry's raw handle so cancel bookkeeping targets THIS activation's DB, rebinds the RPC
   * event sink (flushing what was buffered in the gap), and installs this activation's sink. If
   * the child already exited, the registry delivers that exit to the sink right after this returns.
   */
  adopt(entry: SharedChildEntry): void {
    const run = this.deps.store.get(entry.runId);
    if (!run) throw new Error(`run ${entry.runId} has no row in this session's DB`);
    const raw = entry.handle;
    const handle: ChildHandle = {
      pid: raw.pid, startTime: raw.startTime,
      wait: () => raw.wait(),
      kill: reason => raw.kill(reason),
      ...(raw.killAsync ? { killAsync: (graceMs?: number, reason?: string) => raw.killAsync!(graceMs, reason) } : {}),
      ...(raw.steer ? { steer: (message: string) => raw.steer!(message) } : {}),
      detach: () => {},
    };
    this.ownHandle(run, handle);
    this.deps.tailer.track(run.id);
    raw.bindEvents?.(this.rpcSink(run));
    entry.sink = this.completionSink(run, handle);
  }
}
