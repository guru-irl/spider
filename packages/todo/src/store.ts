import type { Db } from "@spider/db-core";
import type { SessionGroup, SessionSummary, Todo } from "./types.js";

interface TodoRow {
  id: number;
  seq: number;
  text: string;
  done: number;
}

function toTodo(row: TodoRow): Todo {
  return { seq: row.seq, text: row.text, done: !!row.done };
}

export function listTodos(db: Db, sessionId: string): Todo[] {
  const rows = db
    .prepare("SELECT id, seq, text, done FROM todos WHERE session_id = ? ORDER BY seq")
    .all(sessionId) as TodoRow[];
  return rows.map(toTodo);
}

export function addTodo(db: Db, sessionId: string, text: string): Todo {
  const run = db.transaction(() => {
    const row = db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM todos WHERE session_id = ?")
      .get(sessionId) as { maxSeq: number };
    const seq = Number(row.maxSeq) + 1;
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
  return run();
}

export function toggleTodo(db: Db, sessionId: string, seq: number): Todo | null {
  const cur = db
    .prepare("SELECT id, seq, text, done FROM todos WHERE session_id = ? AND seq = ?")
    .get(sessionId, seq) as TodoRow | undefined;
  if (!cur) return null;
  const done = cur.done ? 0 : 1;
  const now = Date.now();
  db.prepare("UPDATE todos SET done = ?, updated_at = ? WHERE id = ?").run(done, now, cur.id);
  return { seq: cur.seq, text: cur.text, done: !!done };
}

export function clearTodos(db: Db, sessionId: string): void {
  const run = db.transaction(() => {
    const rows = db
      .prepare("SELECT id, text FROM todos WHERE session_id = ?")
      .all(sessionId) as Array<{ id: number; text: string }>;
    for (const row of rows) {
      db.prepare("INSERT INTO todos_fts(todos_fts, rowid, text) VALUES ('delete', ?, ?)").run(row.id, row.text);
    }
    db.prepare("DELETE FROM todos WHERE session_id = ?").run(sessionId);
  });
  run();
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
  const rows = db
    .prepare(
      `SELECT DISTINCT t.session_id AS session, s.name AS name
       FROM todos t
       LEFT JOIN sessions s ON s.id = t.session_id`
    )
    .all() as Array<{ session: string; name: string | null }>;

  const exact = rows.find((r) => r.session === selector);
  if (exact) return exact.session;

  const nameMatches = rows.filter(
    (r) => r.name != null && r.name.toLowerCase() === selector.toLowerCase()
  );
  if (nameMatches.length === 1) return nameMatches[0].session;
  if (nameMatches.length > 1) return null;

  const prefixMatches = rows.filter((r) => r.session.startsWith(selector));
  if (prefixMatches.length === 1) return prefixMatches[0].session;

  return null;
}

export function viewSession(db: Db, selector: string, currentSessionId: string): SessionGroup[] {
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
