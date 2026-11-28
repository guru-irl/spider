import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Db } from "@spider/db-core";
import type { StartupSessionStats } from "@spider/ui";

type Session = ExtensionContext["sessionManager"];

export function readIntroStats(session: Session, now: number, db?: Db): StartupSessionStats {
  let compactions = 0, turns = 0;
  for (const entry of session.getBranch()) {
    if (entry.type === "compaction") compactions++;
    if (entry.type === "message" && entry.message.role === "user") turns++;
  }
  const timestamp = Date.parse(session.getHeader()?.timestamp ?? "");
  const ageMs = Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : undefined;
  return { compactions, turns, ageMs, ...readSpiderStats(session.getSessionId(), compactions === 0 && turns === 0, db) };
}

export function readSpiderStats(sessionId: string, fresh: boolean, db?: Db): Pick<StartupSessionStats, "runs" | "todos"> {
  if (!db) return fresh ? { runs: { total: 0, active: 0 }, todos: 0 } : { runs: undefined, todos: undefined };
  const row = db.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(status IN ('queued', 'running', 'paused')), 0) AS active,
    (SELECT COUNT(*) FROM todos WHERE session_id = @id AND done = 0) AS todos
    FROM runs WHERE session_id = @id`).get({ id: sessionId }) as { total: number; active: number; todos: number };
  return { runs: { total: row.total, active: row.active }, todos: row.todos };
}

export function countVisitCompactions(session: Session, since: number): number {
  return session.getBranch().filter(entry => entry.type === "compaction" && Date.parse(entry.timestamp) >= since).length;
}
