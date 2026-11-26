import type { Db } from "@spider/db-core";
import { openRoamPathReadOnly, openRoamStoreReadOnly } from "@spider/db-core/roam/reads";
import { listStoreKeys } from "../store-inventory";

/** Registration supplies fresh project paths; roaming supplies previously moved sessions. */
export function v0SessionCatalog(globalDb: Db): { id: string; name: string | null }[] {
  const catalog = new Map<string, { id: string; name: string | null }>();
  for (const row of globalDb.prepare("SELECT session_id FROM roam_locations").all() as { session_id: string }[]) {
    catalog.set(row.session_id, { id: row.session_id, name: null });
  }
  const read = (db: Db | undefined) => {
    if (!db) throw new Error("session-catalog-unavailable");
    try {
      for (const row of db.prepare("SELECT id,name FROM sessions").all() as { id: string; name: string | null }[]) {
        catalog.set(row.id, row);
      }
    } finally { db.close(); }
  };
  // resolveProject/registerProject records this path even before capture assigns a store key.
  for (const row of globalDb.prepare("SELECT DISTINCT db_path FROM projects").all() as { db_path: string }[]) {
    read(openRoamPathReadOnly(row.db_path));
  }
  for (const key of listStoreKeys(globalDb).filter(key => key.startsWith("worktree:"))) {
    read(openRoamStoreReadOnly(globalDb, key));
  }
  return [...catalog.values()];
}
