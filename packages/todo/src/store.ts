import { openGlobalReadOnly, type Db } from "@spider/db-core";
import { assertTodoHome, readSessionState } from "@spider/db-core/roam/state";
import type { Home } from "@spider/db-core/roam/types";
import type { SessionGroup, SessionSummary, Todo } from "./types";

interface TodoRow {
  id: number;
  uuid: string;
  seq: number;
  text: string;
  done: number;
}

function toTodo(row: TodoRow): Todo {
  return { seq: row.seq, text: row.text, done: !!row.done };
}

const warnedSessions = new Set<string>();
const knownParticipants = new Set<string>();

function warnUnknown(sessionId: string): void {
  if (warnedSessions.has(sessionId)) return;
  warnedSessions.add(sessionId);
  console.warn("Cannot verify todo session participation");
}

function admitWrite(db: Db, sessionId: string): void {
  let state: ReturnType<typeof readSessionState> | undefined;
  try {
    state = readSessionState(db, sessionId);
    if (state) knownParticipants.add(sessionId);
  } catch { /* The global home can still establish participation. */ }
  let global: Db | undefined;
  let home: Home | null;
  try {
    global = openGlobalReadOnly();
    if (!global) throw new Error("Global store is unavailable");
    const homeDb = global;
    const row = homeDb.withRetry(() => homeDb.prepare("SELECT session_id, machine_id, epoch, move_id, updated_at FROM session_homes WHERE session_id = ?")
      .get(sessionId)) as { session_id: string; machine_id: string; epoch: number; move_id: string | null; updated_at: number } | undefined;
    home = row ? { sessionId: row.session_id, machineId: row.machine_id, epoch: row.epoch, moveId: row.move_id, updatedAt: row.updated_at } : null;
    if (home) knownParticipants.add(sessionId);
  } catch {
    if (knownParticipants.has(sessionId)) throw new Error("Cannot verify the session home");
    warnUnknown(sessionId);
    return;
  } finally { global?.close(); }
  if (state === undefined) {
    if (knownParticipants.has(sessionId)) throw new Error("Cannot verify the session home");
    warnUnknown(sessionId);
    return;
  }
  if (!state && !home) return;
  const meta = db.prepare("SELECT machine_id FROM roam_meta WHERE id = 1").get() as { machine_id: string };
  assertTodoHome(db, sessionId, meta.machine_id, home);
}

export function listTodos(db: Db, sessionId: string): Todo[] {
  const rows = db
    .prepare("SELECT id, uuid, seq, text, done FROM todos WHERE session_id = ? ORDER BY seq")
    .all(sessionId) as TodoRow[];
  return rows.map(toTodo);
}

export function addTodo(db: Db, sessionId: string, text: string): Todo {
  const run = db.raw.transaction(() => {
    admitWrite(db, sessionId);
    const row = db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM todos WHERE session_id = ?")
      .get(sessionId) as { maxSeq: number };
    const seq = Number(row.maxSeq) + 1;
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("Todo sequence out of range");
    const now = Date.now();
    const info = db
      .prepare(
        "INSERT INTO todos (session_id, seq, text, done, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)"
      )
      .run(sessionId, seq, text, now, now);
    const id = Number(info.lastInsertRowid);
    db.prepare("INSERT INTO todos_fts(rowid, text) VALUES (?, ?)").run(id, text);
    return { seq, text, done: false } satisfies Todo;
  });
  return run.immediate();
}

export function toggleTodo(db: Db, sessionId: string, seq: number): Todo | null {
  return db.raw.transaction(() => {
    admitWrite(db, sessionId);
    const cur = db
      .prepare("SELECT id, uuid, seq, text, done FROM todos WHERE session_id = ? AND seq = ?")
      .get(sessionId, seq) as TodoRow | undefined;
    if (!cur) return null;
    const done = cur.done ? 0 : 1;
    db.prepare("UPDATE todos SET done = ?, updated_at = ? WHERE uuid = ?").run(done, Date.now(), cur.uuid);
    return { seq: cur.seq, text: cur.text, done: !!done };
  }).immediate();
}

export function removeTodo(db: Db, sessionId: string, seq: number): Todo | null {
  return db.raw.transaction(() => {
    admitWrite(db, sessionId);
    const row = db
      .prepare("SELECT id, uuid, seq, text, done FROM todos WHERE session_id = ? AND seq = ?")
      .get(sessionId, seq) as TodoRow | undefined;
    if (!row) return null;
    db.prepare("INSERT INTO todos_fts(todos_fts, rowid, text) VALUES ('delete', ?, ?)").run(row.id, row.text);
    db.prepare("DELETE FROM todos WHERE uuid = ?").run(row.uuid);
    return toTodo(row);
  }).immediate();
}

export function clearTodos(db: Db, sessionId: string, force = false): { removed: number; kept: number } {
  const run = db.raw.transaction(() => {
    admitWrite(db, sessionId);
    const rows = db
      .prepare("SELECT id, uuid, text FROM todos WHERE session_id = ? AND (? OR done = 1)")
      .all(sessionId, force ? 1 : 0) as Array<{ id: number; uuid: string; text: string }>;
    for (const row of rows) {
      db.prepare("INSERT INTO todos_fts(todos_fts, rowid, text) VALUES ('delete', ?, ?)").run(row.id, row.text);
    }
    const remove = db.prepare("DELETE FROM todos WHERE uuid = ?");
    for (const row of rows) remove.run(row.uuid);
    const kept = db.prepare("SELECT COUNT(*) AS count FROM todos WHERE session_id = ? AND done = 0").get(sessionId) as { count: number };
    return { removed: rows.length, kept: Number(kept.count) };
  });
  return run.immediate();
}

interface SummaryRow {
  session: string;
  name: string | null;
  total: number;
  done: number;
}

export function sessionSummaries(db: Db, currentSessionId: string): SessionSummary[] {
  const rows = db
    .prepare(
      `SELECT t.session_id AS session, s.name AS name, COUNT(*) AS total, SUM(t.done) AS done
       FROM todos t
       LEFT JOIN sessions s ON s.id = t.session_id
       GROUP BY t.session_id`
    )
    .all() as SummaryRow[];
  return rows.map((r) => ({
    session: r.session,
    name: r.name ?? undefined,
    total: Number(r.total),
    done: Number(r.done),
    current: r.session === currentSessionId,
  }));
}

export function resolveSession(db: Db, selector: string): string | null {
  selector = selector.trim();
  if (!selector) return null;
  const rows = db
    .prepare(
      `SELECT DISTINCT t.session_id AS session, s.name AS name
       FROM todos t
       LEFT JOIN sessions s ON s.id = t.session_id
       UNION
       SELECT id AS session, name FROM sessions`
    )
    .all() as Array<{ session: string; name: string | null }>;

  const exact = rows.find((r) => r.session === selector);
  const matches = rows.filter(
    (r) => (exact ? r.session === selector : r.session.startsWith(selector)) ||
      (r.name != null && r.name.toLowerCase() === selector.toLowerCase())
  );
  if (matches.length === 1) return matches[0].session;

  return null;
}

export function viewSession(db: Db, selector: string, currentSessionId: string): SessionGroup[] {
  selector = selector.trim();
  if (selector === "all") {
    const summaries = sessionSummaries(db, currentSessionId);
    return summaries.map((s) => ({
      session: s.session,
      name: s.name,
      current: s.current,
      todos: listTodos(db, s.session),
    }));
  }

  const target = resolveSession(db, selector);
  if (!target) return [];

  const row = db.prepare("SELECT name FROM sessions WHERE id = ?").get(target) as { name: string | null } | undefined;
  return [
    {
      session: target,
      name: row?.name ?? undefined,
      current: target === currentSessionId,
      todos: listTodos(db, target),
    },
  ];
}
