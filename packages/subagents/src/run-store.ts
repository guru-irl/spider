import type { Db } from "@spider/db-core";
import { randomUUID } from "node:crypto";
import { emitStatus } from "./run-events";
import { deriveRunName } from "./self-name";

export { deriveRunName };

export type RunStatus = "queued" | "running" | "paused" | "done" | "failed" | "cancelled";

export interface NewRun {
  sessionId: string;
  parentRunId?: string;
  agent: string;
  role?: string;
  name?: string;
  phase?: string;
  model?: string;
  task?: string;
  thinking?: string;
  hostPid?: number;
}

export interface RunRow {
  id: string;
  session_id: string;
  parent_run_id: string | null;
  agent: string;
  role: string | null;
  name: string | null;
  status: RunStatus;
  phase: string | null;
  model: string | null;
  task: string | null;
  thinking: string | null;
  started_at: number | null;
  ended_at: number | null;
  step_count: number;
  token_count: number;
  result: string | null;
  pid: number | null;
  host_pid: number | null;
  pid_start_time?: string | null;
  child_mode?: "rpc" | "print";
  intercom_session?: string | null;
}

function toRow(r: NewRun & { id: string; name: string; status: RunStatus }) {
  return {
    id: r.id,
    session_id: r.sessionId,
    parent_run_id: r.parentRunId ?? null,
    agent: r.agent,
    role: r.role ?? null,
    name: r.name,
    status: r.status,
    phase: r.phase ?? null,
    model: r.model ?? null,
    task: r.task ?? null,
    thinking: r.thinking ?? null,
    host_pid: r.hostPid ?? null,
  };
}

export class RunStore {
  constructor(private db: Db, private globalDb?: Db) {}

  private removeRoute(id: string): void {
    try { this.globalDb?.prepare("DELETE FROM run_routes WHERE run_id=?").run(id); } catch { /* outcome persistence takes priority over locator cleanup */ }
  }

  create(r: NewRun): { id: string; name: string } {
    const id = randomUUID();
    const name = r.name ?? deriveRunName({ agent: r.agent, role: r.role, task: r.task });
    const row = toRow({ ...r, id, name, status: "queued" });
    this.db
      .prepare(
        `INSERT INTO runs (id, session_id, parent_run_id, agent, role, name, status, phase, model, task, thinking, host_pid, step_count, token_count)
         VALUES (@id, @session_id, @parent_run_id, @agent, @role, @name, @status, @phase, @model, @task, @thinking, @host_pid, 0, 0)`
      )
      .run(row);
    return { id, name };
  }

  start(id: string): void {
    this.db
      .prepare(`UPDATE runs SET status = 'running', started_at = @now WHERE id = @id`)
      .run({ id, now: Date.now() });
  }

  updateProgress(id: string, patch: { stepCount?: number; tokenCount?: number; phase?: string; model?: string; thinking?: string }): void {
    this.db
      .prepare(
        `UPDATE runs SET
           step_count = COALESCE(@stepCount, step_count),
           token_count = COALESCE(@tokenCount, token_count),
           phase = COALESCE(@phase, phase),
           model = COALESCE(@model, model),
           thinking = COALESCE(@thinking, thinking)
         WHERE id = @id`
      )
      .run({
        id,
        stepCount: patch.stepCount ?? null,
        tokenCount: patch.tokenCount ?? null,
        phase: patch.phase ?? null,
        model: patch.model ?? null,
        thinking: patch.thinking ?? null,
      });
  }

  finish(id: string, patch: { status: RunStatus; result?: string }, opts: { removeRoute?: boolean } = {}): void {
    this.db
      .prepare(
        `UPDATE runs SET
           status = @status,
           ended_at = @now,
           result = COALESCE(@result, result)
         WHERE id = @id AND status IN ('queued', 'running', 'paused')`
      )
      .run({ id, status: patch.status, now: Date.now(), result: patch.result ?? null });
    if (opts.removeRoute !== false && ["done", "failed", "cancelled"].includes(patch.status)) this.db.afterCommit(() => this.removeRoute(id));
  }

  setLaunch(id: string, launch: { childMode: "rpc" | "print"; intercomSession?: string }): void {
    this.db.prepare("UPDATE runs SET child_mode=?, intercom_session=? WHERE id=?")
      .run(launch.childMode, launch.intercomSession ?? null, id);
  }

  setPid(id: string, pid: number, hostPid: number, startTime?: string | null): void {
    this.db
      .prepare(`UPDATE runs SET pid = @pid, host_pid = @hostPid, pid_start_time = @startTime WHERE id = @id`)
      .run({ id, pid, hostPid, startTime: startTime ?? null });
  }

  /** Terminal-cancel a run. No-op if it already reached a terminal status, so a
   *  kill racing a natural exit never rewrites the real outcome or fabricates a
   *  cancellation event. Returns whether this call changed the row. */
  cancel(id: string, reason?: string): boolean {
    const changed = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE runs SET status = 'cancelled', ended_at = @now, result = COALESCE(@reason, result)
           WHERE id = @id AND status IN ('queued', 'running', 'paused')`
        )
        .run({ id, now: Date.now(), reason: reason ?? null });
      if (result.changes === 0) return false;

      const row = this.get(id)!;
      emitStatus(this.db, {
        runId: id,
        sessionId: row.session_id,
        status: "cancelled",
        summary: row.name ?? undefined,
      });
      return true;
    })();
    if (changed) this.db.afterCommit(() => this.removeRoute(id));
    return changed;
  }

  get(id: string): RunRow | undefined {
    return this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
  }

  listActive(sessionId: string): RunRow[] {
    return this.db
      .prepare(
        `SELECT * FROM runs WHERE session_id = ? AND status IN ('queued', 'running', 'paused')
         ORDER BY started_at, id`
      )
      .all(sessionId) as RunRow[];
  }

  listForSession(sessionId: string): RunRow[] {
    return this.db
      .prepare(`SELECT * FROM runs WHERE session_id = ? ORDER BY started_at, id`)
      .all(sessionId) as RunRow[];
  }

  linkChild(childId: string, parentRunId: string): void {
    this.db
      .prepare(`UPDATE runs SET parent_run_id = @parentRunId WHERE id = @childId`)
      .run({ childId, parentRunId });
  }
}
