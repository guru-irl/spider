import type { Db } from "@spider/db-core";
import { openRoamPathReadOnly, roamStorePath } from "@spider/db-core/roam/reads";
import { listStoreKeys } from "../store-inventory";

/** A stale registration can outlive its checkout. Unsafe paths still throw. */
export function readAvailableProjectDb<T>(file: string, read: (db: Db) => T): T | undefined {
  let db: Db | undefined;
  try {
    db = openRoamPathReadOnly(file);
    return db ? read(db) : undefined;
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException;
    if (code && /^(?:ENOENT|EACCES|EPERM|EIO|SQLITE_(?:CANTOPEN|PERM|READONLY|IOERR|CORRUPT|NOTADB|BUSY|LOCKED)(?:_.*)?)$/.test(code)) return undefined;
    if (code === "SQLITE_ERROR" && /^no such (?:table|column): /.test(message)) return undefined;
    throw error;
  } finally { db?.close(); }
}

export function skippedProjectDbNotice(count: number): string {
  return `Skipped ${count} project ${count === 1 ? "database" : "databases"} that could not be read.`;
}

type CatalogSession = { id: string; name: string | null };

/** Registration supplies fresh project paths; roaming supplies previously moved sessions. */
export function v0SessionCatalog(globalDb: Db): { sessions: CatalogSession[]; skippedProjectDbs: number } {
  const catalog = new Map<string, CatalogSession>();
  const skipped = new Set<string>();
  for (const row of globalDb.prepare("SELECT session_id FROM roam_locations").all() as { session_id: string }[]) {
    catalog.set(row.session_id, { id: row.session_id, name: null });
  }
  const read = (file: string) => {
    const rows = readAvailableProjectDb(file, db => db.prepare("SELECT id,name FROM sessions").all() as CatalogSession[]);
    if (!rows) skipped.add(file);
    else for (const row of rows) catalog.set(row.id, row);
  };
  // resolveProject/registerProject records this path even before capture assigns a store key.
  for (const row of globalDb.prepare("SELECT DISTINCT db_path FROM projects").all() as { db_path: string }[]) {
    read(row.db_path);
  }
  for (const key of listStoreKeys(globalDb).filter(key => key.startsWith("worktree:"))) {
    read(roamStorePath(globalDb, key));
  }
  return { sessions: [...catalog.values()], skippedProjectDbs: skipped.size };
}
