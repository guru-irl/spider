// packages/subagents/src/message-store.ts
import type { Db } from "@spider/db-core";

export interface MessageRow {
  id: number;
  fromSession: string | null;
  toSession: string | null;
  kind: string | null;
  body: string | null;
  createdAt: number;
  deliveredAt: number | null;
  readAt: number | null;
}

export class MessageStore {
  constructor(private db: Db) {}

  enqueue(m: {
    fromSession?: string;
    toSession: string;
    kind?: string;
    body: string;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO message_mirror (from_session, to_session, kind, body, created_at)
         VALUES (@fromSession, @toSession, @kind, @body, @createdAt)`
      )
      .run({
        fromSession: m.fromSession ?? null,
        toSession: m.toSession,
        kind: m.kind ?? null,
        body: m.body,
        createdAt: Date.now(),
      });
    return result.lastInsertRowid as number;
  }

  /** Undelivered messages addressed to `sessionId`, oldest first. */
  pending(sessionId: string, limit?: number): MessageRow[] {
    const sql = limit
      ? `SELECT * FROM message_mirror 
         WHERE to_session = ? AND delivered_at IS NULL 
         ORDER BY created_at 
         LIMIT ?`
      : `SELECT * FROM message_mirror 
         WHERE to_session = ? AND delivered_at IS NULL 
         ORDER BY created_at`;

    const rows = limit
      ? this.db.prepare(sql).all(sessionId, limit)
      : this.db.prepare(sql).all(sessionId);

    return (rows as any[]).map((r) => ({
      id: r.id,
      fromSession: r.from_session,
      toSession: r.to_session,
      kind: r.kind,
      body: r.body,
      createdAt: r.created_at,
      deliveredAt: r.delivered_at,
      readAt: r.read_at,
    }));
  }

  /** Mark a message as delivered. Returns true if the state was changed, false if already delivered. */
  markDelivered(id: number, now?: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE message_mirror 
         SET delivered_at = @now 
         WHERE id = @id AND delivered_at IS NULL`
      )
      .run({ id, now: now ?? Date.now() });
    return result.changes > 0;
  }

  /** Mark a message as read. Returns true if the state was changed, false if already read. */
  markRead(id: number, now?: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE message_mirror 
         SET read_at = @now 
         WHERE id = @id AND read_at IS NULL`
      )
      .run({ id, now: now ?? Date.now() });
    return result.changes > 0;
  }
}
