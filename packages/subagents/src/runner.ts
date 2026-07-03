import type { Db } from "@spider/db-core";
import { RunStore, type RunRow, type RunStatus } from "./run-store";
import { RunEventTailer } from "./event-tailer";
import { emitStatus } from "./run-events";
import { buildChildSpawnSpec, type ChildSpawnSpec } from "./pi-args";

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
    // Finalize the row on child EXIT even if the child-reporter missed session_shutdown
    // (headless/killed children) — otherwise the run is stuck "running" in the UI.
    void handle.wait().then(({ exitCode, result }) => {
      const cur = this.deps.store.get(run.id);
      if (cur && (cur.status === "running" || cur.status === "queued")) {
        const status: RunStatus = exitCode === 0 ? "done" : "failed";
        this.deps.store.finish(run.id, { status, result });
        emitStatus(this.db, { runId: run.id, sessionId: this.sessionId, status, summary: run.name ?? undefined });
        // Async completion notification: let the parent agent (and human) know a
        // background subagent finished, since async runs return before completing.
        this.deps.onComplete?.(this.deps.store.get(run.id) ?? run, status, result);
      }
    }).catch(() => { /* best-effort finalize */ });
    handle.detach();
    return this.deps.store.get(run.id)!;
  }
}
