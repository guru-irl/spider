import type { Db } from "./db.js";

export type RunEvent = {
  runId?: string;
  sessionId: string;
  ts: number;
  type: string;
  tool?: string;
  summary?: string;
  payload?: unknown;
};

type Listener = (e: RunEvent) => void;
const listeners = new Set<Listener>();

export const bus = {
  on(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  emit(e: RunEvent): void {
    for (const fn of listeners) {
      try { fn(e); } catch { /* a bad listener must not break the stream */ }
    }
  },
};

export function appendRunEvent(db: Db, e: RunEvent): void {
  db.withRetry(() => {
    db.prepare(
      `INSERT INTO run_events (run_id, session_id, ts, type, tool, summary, payload)
       VALUES (@runId, @sessionId, @ts, @type, @tool, @summary, @payload)`
    ).run({
      runId: e.runId ?? null,
      sessionId: e.sessionId,
      ts: e.ts,
      type: e.type,
      tool: e.tool ?? null,
      summary: e.summary ?? null,
      payload: e.payload === undefined ? null : JSON.stringify(e.payload),
    });
  });
  bus.emit(e);
}

// Routing/tracking event log (Phase 3 producer + tracking consumer)
export interface EventRow {
  sessionId: string;
  ts: number;
  phase: "before" | "after";
  tool: string;
  description?: string | null;
  added?: number | null;
  removed?: number | null;
  flagged?: string[] | null;
  payload?: unknown;
}

interface EventDbRow {
  id: number;
  session_id: string;
  ts: number;
  phase: string;
  tool: string;
  description: string | null;
  added: number | null;
  removed: number | null;
  flagged: string | null;
  payload: string | null;
}

function hydrateEventRow(row: EventDbRow): EventRow {
  return {
    sessionId: row.session_id,
    ts: row.ts,
    phase: row.phase as "before" | "after",
    tool: row.tool,
    description: row.description,
    added: row.added,
    removed: row.removed,
    flagged: row.flagged ? (JSON.parse(row.flagged) as string[]) : null,
    payload: row.payload === null ? undefined : JSON.parse(row.payload),
  };
}

export function appendEvent(db: Db, e: EventRow): void {
  db.withRetry(() =>
    db
      .prepare(
        `INSERT INTO events (session_id, ts, phase, tool, description, added, removed, flagged, payload)
         VALUES (@sessionId, @ts, @phase, @tool, @description, @added, @removed, @flagged, @payload)`
      )
      .run({
        sessionId: e.sessionId,
        ts: e.ts,
        phase: e.phase,
        tool: e.tool,
        description: e.description ?? null,
        added: e.added ?? null,
        removed: e.removed ?? null,
        flagged: e.flagged && e.flagged.length ? JSON.stringify(e.flagged) : null,
        payload: e.payload === undefined ? null : JSON.stringify(e.payload),
      })
  );
  bus.emit({
    sessionId: e.sessionId,
    ts: e.ts,
    type: e.phase === "before" ? "tool_intent" : "tool_result",
    tool: e.tool,
    summary: e.description ?? undefined,
    payload: e.payload,
  });
}

export function listEvents(
  db: Db,
  opts?: { tool?: string; phase?: "before" | "after"; limit?: number }
): EventRow[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts?.tool !== undefined) {
    clauses.push("tool = @tool");
    params.tool = opts.tool;
  }
  if (opts?.phase !== undefined) {
    clauses.push("phase = @phase");
    params.phase = opts.phase;
  }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = opts?.limit !== undefined ? ` LIMIT @limit` : "";
  if (opts?.limit !== undefined) params.limit = opts.limit;
  const rows = db
    .prepare(`SELECT * FROM events${where} ORDER BY id ASC${limit}`)
    .all(params) as EventDbRow[];
  return rows.map(hydrateEventRow);
}

export function eventCountsByTool(db: Db): Array<{ tool: string; count: number }> {
  return db
    .prepare(`SELECT tool, COUNT(*) as count FROM events GROUP BY tool`)
    .all() as Array<{ tool: string; count: number }>;
}
