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
