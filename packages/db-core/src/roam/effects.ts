import type { Db } from "../db";
import type { ReplicaEffects, StoreKey } from "./types";

type RowId = number | bigint;

// FTS identity columns are UNINDEXED, and local writers allocate independent rowids.
function lexicalRows(db: Db, table: "memory_fts" | "sessions_fts"): Map<string, RowId[]> {
  const column = table === "memory_fts" ? "uuid" : "id";
  const result = new Map<string, RowId[]>();
  const rows = db.prepare(`SELECT ${column} AS identity, rowid FROM ${table}`).safeIntegers().all() as { identity: string; rowid: bigint }[];
  for (const row of rows) {
    const ids = result.get(row.identity);
    if (ids) ids.push(row.rowid);
    else result.set(row.identity, [row.rowid]);
  }
  return result;
}

function clearMemoryVectors(db: Db, uuid: string, prepare: Db["prepare"]): void {
  const rows = prepare("SELECT rowid FROM vector_map WHERE owner_kind = 'memory' AND owner_id = ?").safeIntegers().all(uuid) as { rowid: bigint }[];
  if (rows.length && prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vectors'").get()) {
    db.loadVec();
    const remove = prepare("DELETE FROM vectors WHERE rowid = ?");
    for (const row of rows) remove.run(row.rowid);
  }
  prepare("DELETE FROM vector_map WHERE owner_kind = 'memory' AND owner_id = ?").run(uuid);
}

export function createReplicaEffects(notify: (key: StoreKey) => void): ReplicaEffects {
  return {
    begin(db) {
      let memories: Map<string, RowId[]> | undefined;
      let sessions: Map<string, RowId[]> | undefined;
      const statements = new Map<string, ReturnType<Db["prepare"]>>();
      const prepare: Db["prepare"] = sql => {
        let statement = statements.get(sql);
        if (!statement) { statement = db.prepare(sql); statements.set(sql, statement); }
        return statement;
      };
      return {
        winning(before, after, change) {
          if (change.entity === "todos") {
            if (before) prepare("INSERT INTO todos_fts(todos_fts,rowid,text) VALUES ('delete',?,?)").run(before.rowid, before.body.text);
            if (after) prepare("INSERT INTO todos_fts(rowid,text) SELECT id,text FROM todos WHERE id = ?").run(after.rowid);
          } else if (change.entity === "sessions") {
            sessions ??= lexicalRows(db, "sessions_fts");
            const ids = sessions.get(change.rowKey) ?? [];
            if (after) {
              for (const id of ids) prepare("UPDATE sessions_fts SET name = (SELECT name FROM sessions WHERE rowid = ?), summary = (SELECT summary FROM sessions WHERE rowid = ?) WHERE rowid = ?").run(after.rowid, after.rowid, id);
              if (!ids.length) {
                const inserted = prepare("INSERT INTO sessions_fts(id,name,summary,content) SELECT id,name,summary,NULL FROM sessions WHERE rowid = ?").safeIntegers().run(after.rowid);
                sessions.set(change.rowKey, [inserted.lastInsertRowid]);
              }
            } else {
              const retained: RowId[] = [];
              for (const id of ids) {
                const removed = prepare("DELETE FROM sessions_fts WHERE rowid = ? AND (content IS NULL OR content = '')").run(id);
                if (!removed.changes) {
                  prepare("UPDATE sessions_fts SET name = NULL, summary = NULL WHERE rowid = ?").run(id);
                  retained.push(id);
                }
              }
              sessions.set(change.rowKey, retained);
            }
          } else if (change.entity === "memory") {
            memories ??= lexicalRows(db, "memory_fts");
            for (const id of memories.get(change.rowKey) ?? []) prepare("DELETE FROM memory_fts WHERE rowid = ?").run(id);
            memories.delete(change.rowKey);
            clearMemoryVectors(db, change.rowKey, prepare);
            if (after) {
              const lexical = prepare("INSERT INTO memory_fts(uuid,category,content,link) SELECT uuid,category,content,link FROM memory WHERE rowid = ? AND status = 'active'").safeIntegers().run(after.rowid);
              if (lexical.changes) memories.set(change.rowKey, [lexical.lastInsertRowid]);
              // Allocate before deleting old work so an in-flight completion cannot match a reused id.
              const inserted = prepare("INSERT INTO embed_queue(owner_kind,owner_id,text,enqueued_at,tries) SELECT 'memory',uuid,content,?,0 FROM memory WHERE rowid = ? AND status IN ('active','staged')").run(Date.now(), after.rowid);
              if (inserted.changes) {
                prepare("DELETE FROM embed_queue WHERE owner_kind = 'memory' AND owner_id = ? AND id <> ?").run(change.rowKey, inserted.lastInsertRowid);
              } else prepare("DELETE FROM embed_queue WHERE owner_kind = 'memory' AND owner_id = ?").run(change.rowKey);
            } else prepare("DELETE FROM embed_queue WHERE owner_kind = 'memory' AND owner_id = ?").run(change.rowKey);
          }
        },
      };
    },
    committed: notify,
  };
}
