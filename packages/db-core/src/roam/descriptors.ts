import type { Descriptor, Entity } from "./types";

export const DESCRIPTORS: Readonly<Record<Entity, Descriptor>> = {
  global_memory: {
    scope: "global", table: "global_memory", key: "uuid", sessionColumn: null, immutable: ["uuid"],
    columns: ["uuid", "category", "content", "link", "scope", "status", "source", "confidence", "created_at", "updated_at", "justification", "evidence", "machine_id"],
  },
  memory: {
    scope: "repo", table: "memory", key: "uuid", sessionColumn: null, immutable: ["uuid"],
    columns: ["uuid", "category", "content", "link", "status", "source", "confidence", "session_id", "created_at", "updated_at", "justification", "evidence", "machine_id"],
  },
  sessions: {
    scope: "worktree", table: "sessions", key: "id", sessionColumn: "id", immutable: ["id", "origin_machine"],
    columns: ["id", "parent_session_id", "name", "reason", "started_at", "ended_at", "summary", "origin_machine"],
  },
  todos: {
    scope: "worktree", table: "todos", key: "uuid", sessionColumn: "session_id", immutable: ["uuid", "session_id"],
    columns: ["uuid", "session_id", "seq", "text", "done", "created_at", "updated_at"],
  },
  runs: {
    scope: "worktree", table: "runs", key: "id", sessionColumn: "session_id", immutable: ["id", "session_id", "origin_machine"],
    columns: ["id", "session_id", "parent_run_id", "agent", "role", "name", "status", "phase", "model", "task", "thinking", "started_at", "ended_at", "step_count", "token_count", "result", "child_mode", "origin_machine"],
  },
  run_events: {
    scope: "worktree", table: "run_events", key: "uuid", sessionColumn: "session_id", immutable: ["uuid", "session_id"],
    columns: ["uuid", "run_id", "session_id", "ts", "type", "tool", "summary", "payload"],
  },
  session_homes: {
    scope: "global", table: "session_homes", key: "session_id", sessionColumn: null, immutable: ["session_id"],
    columns: ["session_id", "machine_id", "epoch", "move_id", "updated_at"],
  },
};
