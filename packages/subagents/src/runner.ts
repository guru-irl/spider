import type { Db } from "@spider/db-core";
import { RunStore, type RunRow, type RunStatus } from "./run-store";
import { RunEventTailer } from "./event-tailer";
import { emitStatus } from "./run-events";
import { buildChildSpawnSpec, type ChildSpawnSpec } from "./pi-args";
import { registerChild, unregisterChild } from "./coordinators";

export interface ChildHandle {
  pid?: number;
  wait(): Promise<{ exitCode: number; result?: string }>;
  kill(): void;
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
    });
    return this.deps.spawn(spec);
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
    const status: RunStatus = exitCode === 0 ? "done" : "failed";
    this.deps.store.finish(run.id, { status, result });
    emitStatus(this.db, { runId: run.id, sessionId: this.sessionId, status, summary: run.name ?? undefined });
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
      const cur = this.deps.store.get(run.id);
      let status: RunStatus;
      if (cur && (cur.status === "running" || cur.status === "queued")) {
        // Child never finalized its own row (headless/killed) — the parent finalizes it.
        status = exitCode === 0 ? "done" : "failed";
        this.deps.store.finish(run.id, { status, result });
        emitStatus(this.db, { runId: run.id, sessionId: this.sessionId, status, summary: run.name ?? undefined });
      } else {
        // Child already finalized the row (fast clean exit, or a kill that cancelled it)
        // — honour its terminal status.
        status = (cur?.status as RunStatus) ?? (exitCode === 0 ? "done" : "failed");
      }
      // Async completion notification: let the parent agent (and human) know a background
      // subagent finished. Fired EXACTLY ONCE per child exit, whether the parent or the child
      // finalized the row. A CANCELLED run is a deliberate stop — the notifier suppresses it
      // (see makeAsyncNotifier), so killing an agent does not wake the orchestrator.
      this.deps.onComplete?.(this.deps.store.get(run.id) ?? run, status, result);
    }).catch(() => { /* best-effort finalize */ }).finally(() => {
      unregisterChild(this.sessionId, run.id);
    });
    handle.detach();
    return this.deps.store.get(run.id)!;
  }
}
