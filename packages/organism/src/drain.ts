import type { Db } from "@spider/db-core";
import { readTranscript } from "@spider/context";
import type { DigestMsg } from "@spider/memory";
import type { RunRow } from "@spider/subagents";
import type { Todo } from "@spider/todo";
import { existsSync } from "node:fs";
import type { DigestBundle, DrainReason, RunEventRow, TrackEventRow } from "./types.js";

export interface DrainOpts {
  transcriptPath?: string;
}

interface RunEventDbRow {
  id: number;
  run_id: string | null;
  ts: number;
  type: string;
  tool: string | null;
  summary: string | null;
  payload: string | null;
}

interface TrackEventDbRow {
  id: number;
  ts: number;
  phase: string;
  tool: string;
  description: string | null;
  flagged: string | null;
  payload: string | null;
}

interface TodoDbRow {
  seq: number;
  text: string;
  done: number;
}

function parsePayload(payload: string | null): unknown {
  if (payload == null) return undefined;
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

/**
 * Non-destructively drain a session's activity from the project DB into a
 * `DigestBundle`. Reads only; the event log persists untouched.
 */
export function drainSession(db: Db, sessionId: string, reason: DrainReason, opts?: DrainOpts): DigestBundle {
  const runs = db.prepare(`SELECT * FROM runs WHERE session_id = ? ORDER BY id ASC`).all(sessionId) as RunRow[];

  const runEvents = (
    db.prepare(`SELECT * FROM run_events WHERE session_id = ? ORDER BY id ASC`).all(sessionId) as RunEventDbRow[]
  ).map<RunEventRow>((r) => ({
    id: r.id,
    runId: r.run_id ?? undefined,
    ts: r.ts,
    type: r.type,
    tool: r.tool ?? undefined,
    summary: r.summary ?? undefined,
    payload: parsePayload(r.payload),
  }));

  const events = (
    db.prepare(`SELECT * FROM events WHERE session_id = ? ORDER BY id ASC`).all(sessionId) as TrackEventDbRow[]
  ).map<TrackEventRow>((r) => ({
    id: r.id,
    ts: r.ts,
    phase: r.phase === "before" ? "before" : "after",
    tool: r.tool,
    description: r.description ?? undefined,
    flagged: r.flagged ?? undefined,
    payload: parsePayload(r.payload),
  }));

  const todos = (
    db.prepare(`SELECT seq, text, done FROM todos WHERE session_id = ? ORDER BY seq ASC`).all(sessionId) as TodoDbRow[]
  ).map<Todo>((r) => ({ seq: r.seq, text: r.text, done: !!r.done }));

  const sessionRow = db.prepare(`SELECT name FROM sessions WHERE id = ?`).get(sessionId) as
    | { name: string | null }
    | undefined;
  const sessionName = sessionRow?.name ?? undefined;

  let transcript: DigestMsg[] = [];
  if (opts?.transcriptPath && existsSync(opts.transcriptPath)) {
    const normalized = readTranscript(opts.transcriptPath);
    transcript = normalized.messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.text,
    }));
  }

  return { sessionId, reason, runs, runEvents, events, todos, transcript, sessionName };
}
