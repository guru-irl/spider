// SQL captured from revision e732fa07 in the existing writer modules.
export const BASELINE_SQL = {
  sessionUpsert: "INSERT INTO sessions(id, name, reason, started_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET reason=excluded.reason, name=COALESCE(excluded.name,sessions.name), ended_at=NULL",
  todoNext: "SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM todos WHERE session_id = ?",
  todoInsert: "INSERT INTO todos (session_id, seq, text, done, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
  todoFind: "SELECT id, seq, text, done FROM todos WHERE session_id = ? AND seq = ?",
  todoFtsInsert: "INSERT INTO todos_fts(rowid, text) VALUES (?, ?)",
  todoToggle: "UPDATE todos SET done = ?, updated_at = ? WHERE id = ?",
  todoFtsDelete: "INSERT INTO todos_fts(todos_fts, rowid, text) VALUES ('delete', ?, ?)",
  todoRemove: "DELETE FROM todos WHERE id = ?",
  todoClearRows: "SELECT id, text FROM todos WHERE session_id = ? AND (? OR done = 1)",
  todoClear: "DELETE FROM todos WHERE session_id = ? AND (? OR done = 1)",
  runInsert: `INSERT INTO runs (id, session_id, parent_run_id, agent, role, name, status, phase, model, task, thinking, host_pid, step_count, token_count)
         VALUES (@id, @session_id, @parent_run_id, @agent, @role, @name, @status, @phase, @model, @task, @thinking, @host_pid, 0, 0)`,
  runStart: `UPDATE runs SET status = 'running', started_at = @now WHERE id = @id`,
  runProgress: `UPDATE runs SET
           step_count = COALESCE(@stepCount, step_count),
           token_count = COALESCE(@tokenCount, token_count),
           phase = COALESCE(@phase, phase),
           model = COALESCE(@model, model),
           thinking = COALESCE(@thinking, thinking)
         WHERE id = @id`,
  runFinish: `UPDATE runs SET
           status = @status,
           ended_at = @now,
           result = COALESCE(@result, result)
         WHERE id = @id AND status IN ('queued', 'running', 'paused')`,
  runPid: `UPDATE runs SET pid = @pid, host_pid = @hostPid, pid_start_time = @startTime WHERE id = @id`,
  eventAppend: `INSERT INTO run_events (run_id, session_id, ts, type, tool, summary, payload)
       VALUES (@runId, @sessionId, @ts, @type, @tool, @summary, @payload)`,
} as const;
