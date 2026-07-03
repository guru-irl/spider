import { randomUUID } from "node:crypto";
import { bus } from "@spider/db-core";
import type { Db, RunEvent } from "@spider/db-core";
import { RunStore, type RunRow } from "./run-store.js";
import { emitHandoff } from "./run-events.js";
import { sendIntercom } from "./intercom.js";
import type { PipelineStage, RunPipelineArgs } from "./schemas.js";

/**
 * First-class pipeline auto-wake coordinator for `run {pipeline, handoff:"intercom"}`.
 * Spawns stage 0 async, then advances stage-by-stage when the previous stage's run
 * reaches a terminal status on the bus: records a `handoff` run_event edge, wakes the
 * next stage via intercom (message_mirror observability), and spawns it pre-wired with
 * the prior result as {previous}/{handoff}. No blocking wait.
 *
 * NOTE: `stage.count > 1` fan-out (advance only when ALL N terminal) and
 * `wakeOn:"accepted"` (acceptance ledger, Phase 8) are deferred — the single-worker
 * path is implemented; `wakeOn:"accepted"` is treated as `"done"`.
 */
export class PipelineCoordinator {
  private off: (() => void) | null = null;
  private stageIndex = 0;
  private pipelineId = randomUUID();
  private stages: PipelineStage[] = [];
  private lastRun: RunRow | null = null;
  private baseTask = "";
  constructor(private deps: { db: Db; globalDb: Db; store: RunStore; runner: any; pi: any; sessionId: string }) {}

  private intercomName(stage: PipelineStage, runId: string): string {
    return `${stage.role ?? stage.agent}-${runId.slice(0, 8)}`;
  }
  private interpolate(tmpl: string, previous: string): string {
    return tmpl.replace(/\{task\}/g, this.baseTask).replace(/\{previous\}/g, previous).replace(/\{handoff\}/g, previous);
  }

  start(args: RunPipelineArgs): { pipelineId: string; firstRunId: string } {
    this.stages = args.pipeline;
    this.stageIndex = 0;
    this.baseTask = args.pipeline[0]?.task ?? "";
    const first = this.spawnStage(0, "");
    this.off = bus.on((e: RunEvent) => {
      if (e.type !== "status") return;
      const status = (e.payload as any)?.status;
      if (e.runId && e.runId === this.lastRun?.id && (status === "done" || status === "failed" || status === "cancelled")) {
        this.onRunTerminal(e.runId);
      }
    });
    return { pipelineId: this.pipelineId, firstRunId: first.id };
  }

  private spawnStage(index: number, previous: string): RunRow {
    const stage = this.stages[index];
    const task = this.interpolate(stage.task ?? (index === 0 ? "{task}" : "{previous}"), previous);
    const parentRunId = this.lastRun?.id;
    const row: RunRow = this.deps.runner.runAsync({
      agent: stage.agent, role: stage.role, task, model: stage.model, skill: stage.skill,
      context: stage.context ?? "fresh", phase: stage.phase ?? `stage-${index}`, parentRunId,
      orchestratorTarget: undefined, intercomSessionName: undefined, async: true,
    });
    this.lastRun = row;
    this.stageIndex = index;
    return row;
  }

  onRunTerminal(runId: string): void {
    const finished = this.deps.store.get(runId);
    const nextIndex = this.stageIndex + 1;
    if (!finished || nextIndex >= this.stages.length) { this.dispose(); return; }
    const previous = finished.result ?? "";
    const nextStage = this.stages[nextIndex];
    // spawn next stage first so we have its run id for the handoff edge + wake target
    const next = this.spawnStage(nextIndex, previous);
    emitHandoff(this.deps.db, { runId: finished.id, sessionId: this.deps.sessionId, toRunId: next.id, phase: nextStage.phase, summary: `${finished.role ?? finished.agent}\u2192${nextStage.role ?? nextStage.agent}` });
    void sendIntercom(this.deps.pi, this.deps.globalDb, { to: this.intercomName(nextStage, next.id), message: previous, fromSession: this.deps.sessionId, kind: "handoff" });
  }

  dispose(): void { this.off?.(); this.off = null; }
}
