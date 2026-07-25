// packages/db-core/src/bindings.ts
import type { Db } from "./db";

export function bindSession(db: Db, sessionId: string, worktreeRoot: string): void {
  db.withRetry(() => {
    db.prepare(
      `INSERT INTO session_bindings (session_id, worktree_root, bound_at)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         worktree_root = excluded.worktree_root,
         bound_at = excluded.bound_at`
    ).run(sessionId, worktreeRoot, Date.now());
  });
}

export function unbindSession(db: Db, sessionId: string): void {
  db.withRetry(() => {
    db.prepare("DELETE FROM session_bindings WHERE session_id = ?").run(sessionId);
  });
}

export function getBinding(db: Db, sessionId: string): string | undefined {
  const row = db.prepare("SELECT worktree_root FROM session_bindings WHERE session_id = ?")
    .get(sessionId) as { worktree_root: string } | undefined;
  return row?.worktree_root;
}
