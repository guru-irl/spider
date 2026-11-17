import type { Db } from "@spider/db-core";
import { readTranscript } from "@spider/context";
import type { DigestMsg } from "@spider/memory";
import type { Todo } from "@spider/todo";
import { existsSync } from "node:fs";
import type { DigestBundle, DrainReason, RunActivity, RunEventRow, TrackEventRow } from "./types.js";

export interface DrainOpts {
  transcriptPath?: string;
  /** Captured at the lifecycle boundary; also supports in-memory pi sessions. */
  transcript?: readonly DigestMsg[];
}

// Background review consumes recent summaries, never raw tool payloads. Apply
// limits in SQLite: trimming after .all() still allocates the entire history.
const RUN_LIMIT = 100;
const RUN_EVENT_LIMIT = 200;
const TRACKED_EVENT_LIMIT = 40;
const TODO_LIMIT = 100;
const TEXT_CHARS = 2000;

interface RunEventDbRow {
  id: number;
  run_id: string | null;
  ts: number;
  type: string;
  tool: string | null;
  summary: string | null;
}

interface TrackEventDbRow {
  id: number;
  ts: number;
  phase: string;
  tool: string;
  description: string | null;
}

interface TodoDbRow {
  seq: number;
  text: string;
  done: number;
}

/**
 * Non-destructively read recent activity for background review. Persisted
 * history is untouched; model inputs cannot grow with the lifetime event log.
 */
export function drainSession(db: Db, sessionId: string, reason: DrainReason, opts?: DrainOpts): DigestBundle {
  const runs = (db.prepare(`SELECT id, agent, role, status, step_count, token_count
    FROM runs WHERE session_id = ?
    ORDER BY COALESCE(ended_at, started_at, 0) DESC, id DESC LIMIT ?`).all(sessionId, RUN_LIMIT) as RunActivity[]).reverse();

  const runEvents = (
    db.prepare(`SELECT id, run_id, ts, type, tool, substr(summary, 1, ?) AS summary
      FROM run_events WHERE session_id = ?
      AND (type != 'log' OR summary IS NULL OR summary NOT GLOB 'organism *')
      ORDER BY id DESC LIMIT ?`).all(TEXT_CHARS, sessionId, RUN_EVENT_LIMIT) as RunEventDbRow[]
  ).reverse().map<RunEventRow>((r) => ({
    id: r.id,
    runId: r.run_id ?? undefined,
    ts: r.ts,
    type: r.type,
    tool: r.tool ?? undefined,
    summary: r.summary ?? undefined,
  }));

  const events = (
    db.prepare(`SELECT id, ts, phase, tool, substr(description, 1, ?) AS description
      FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?`).all(TEXT_CHARS, sessionId, TRACKED_EVENT_LIMIT) as TrackEventDbRow[]
  ).reverse().map<TrackEventRow>((r) => ({
    id: r.id,
    ts: r.ts,
    phase: r.phase === "before" ? "before" : "after",
    tool: r.tool,
    description: r.description ?? undefined,
  }));

  const todos = (
    db.prepare(`SELECT seq, substr(text, 1, ?) AS text, done FROM todos
      WHERE session_id = ? ORDER BY seq DESC LIMIT ?`).all(TEXT_CHARS, sessionId, TODO_LIMIT) as TodoDbRow[]
  ).reverse().map<Todo>((r) => ({ seq: r.seq, text: r.text, done: !!r.done }));

  const sessionRow = db.prepare(`SELECT substr(name, 1, ?) AS name FROM sessions WHERE id = ?`).get(TEXT_CHARS, sessionId) as
    | { name: string | null }
    | undefined;
  const sessionName = sessionRow?.name ?? undefined;

  let transcript: DigestMsg[] = [];
  if (opts?.transcript !== undefined) {
    transcript = opts.transcript.map(m => ({ role: m.role, content: m.content }));
  } else if (opts?.transcriptPath && existsSync(opts.transcriptPath)) {
    const normalized = readTranscript(opts.transcriptPath, { roles: ["user", "assistant"] });
    // Tool output is evidence, not a user instruction. Routing's event log
    // supplies tool activity separately; the learning transcript is conversation prose.
    transcript = normalized.messages.flatMap((m): DigestMsg[] =>
      m.role === "assistant" || m.role === "user" ? [{ role: m.role, content: m.text }] : [],
    );
  }

  return { sessionId, reason, runs, runEvents, events, todos, transcript, sessionName };
}
