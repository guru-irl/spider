import type { Db } from "@spider/db-core";
import { randomUUID } from "node:crypto";
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
  started_at: number | null;
  ended_at: number | null;
  step_count: number;
  token_count: number;
  result: string | null;
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
  };
}

export class RunStore {
  constructor(private db: Db) {}

  create(r: NewRun): { id: string; name: string } {
    const id = randomUUID();
    const name = r.name ?? deriveRunName({ agent: r.agent, role: r.role, task: r.task });
    const row = toRow({ ...r, id, name, status: "queued" });
    this.db
      .prepare(
        `INSERT INTO runs (id, session_id, parent_run_id, agent, role, name, status, phase, model, task, step_count, token_count)
         VALUES (@id, @session_id, @parent_run_id, @agent, @role, @name, @status, @phase, @model, @task, 0, 0)`
      )
      .run(row);
    return { id, name };
  }

  start(id: string): void {
    this.db
      .prepare(`UPDATE runs SET status = 'running', started_at = @now WHERE id = @id`)
      .run({ id, now: Date.now() });
  }

  updateProgress(id: string, patch: { stepCount?: number; tokenCount?: number; phase?: string }): void {
    this.db
      .prepare(
        `UPDATE runs SET
           step_count = COALESCE(@stepCount, step_count),
           token_count = COALESCE(@tokenCount, token_count),
           phase = COALESCE(@phase, phase)
         WHERE id = @id`
      )
      .run({
        id,
        stepCount: patch.stepCount ?? null,
        tokenCount: patch.tokenCount ?? null,
        phase: patch.phase ?? null,
      });
  }

  finish(id: string, patch: { status: RunStatus; result?: string }): void {
    this.db
      .prepare(
        `UPDATE runs SET
           status = @status,
           ended_at = @now,
           result = COALESCE(@result, result)
         WHERE id = @id`
      )
      .run({ id, status: patch.status, now: Date.now(), result: patch.result ?? null });
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
