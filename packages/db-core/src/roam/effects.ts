import type { Db } from "../db";
import type { ReplicaEffects, StoreKey } from "./types";

function clearMemoryVectors(db: Db, uuid: string): void {
  const rows = db.prepare("SELECT rowid FROM vector_map WHERE owner_kind = 'memory' AND owner_id = ?").safeIntegers().all(uuid) as { rowid: bigint }[];
  if (rows.length && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vectors'").get()) {
    db.loadVec();
    const remove = db.prepare("DELETE FROM vectors WHERE rowid = ?");
    for (const row of rows) remove.run(row.rowid);
  }
  db.prepare("DELETE FROM vector_map WHERE owner_kind = 'memory' AND owner_id = ?").run(uuid);
}

export function createReplicaEffects(notify: (key: StoreKey) => void): ReplicaEffects {
  return {
    winning(db, before, after, change) {
      if (change.entity === "todos") {
        if (before) db.prepare("INSERT INTO todos_fts(todos_fts,rowid,text) VALUES ('delete',?,?)").run(before.rowid, before.body.text);
        if (after) db.prepare("INSERT INTO todos_fts(rowid,text) SELECT id,text FROM todos WHERE id = ?").run(after.rowid);
      } else if (change.entity === "sessions") {
        if (after) {
          const updated = db.prepare("UPDATE sessions_fts SET name = (SELECT name FROM sessions WHERE rowid = ?), summary = (SELECT summary FROM sessions WHERE rowid = ?) WHERE id = ?").run(after.rowid, after.rowid, change.rowKey);
          if (!updated.changes) db.prepare("INSERT INTO sessions_fts(id,name,summary,content) SELECT id,name,summary,NULL FROM sessions WHERE rowid = ?").run(after.rowid);
        } else {
          db.prepare("DELETE FROM sessions_fts WHERE id = ? AND (content IS NULL OR content = '')").run(change.rowKey);
          db.prepare("UPDATE sessions_fts SET name = NULL, summary = NULL WHERE id = ?").run(change.rowKey);
        }
      } else if (change.entity === "memory") {
        db.prepare("DELETE FROM memory_fts WHERE uuid = ?").run(change.rowKey);
        clearMemoryVectors(db, change.rowKey);
        if (after) {
          db.prepare("INSERT INTO memory_fts(uuid,category,content,link) SELECT uuid,category,content,link FROM memory WHERE rowid = ? AND status = 'active'").run(after.rowid);
          // Allocate before deleting old work so an in-flight completion cannot match a reused id.
          const inserted = db.prepare("INSERT INTO embed_queue(owner_kind,owner_id,text,enqueued_at,tries) SELECT 'memory',uuid,content,?,0 FROM memory WHERE rowid = ? AND status IN ('active','staged')").run(Date.now(), after.rowid);
          if (inserted.changes) {
            db.prepare("DELETE FROM embed_queue WHERE owner_kind = 'memory' AND owner_id = ? AND id <> ?").run(change.rowKey, inserted.lastInsertRowid);
          } else db.prepare("DELETE FROM embed_queue WHERE owner_kind = 'memory' AND owner_id = ?").run(change.rowKey);
        } else db.prepare("DELETE FROM embed_queue WHERE owner_kind = 'memory' AND owner_id = ?").run(change.rowKey);
      }
    },
    committed: notify,
  };
}
