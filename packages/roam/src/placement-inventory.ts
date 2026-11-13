import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { openDbReadOnly, type Db } from "@spider/db-core";
import { openRoamStoreReadOnly } from "@spider/db-core/roam/reads";
import { listStoreKeys } from "./store-inventory";

function openOwned(file: string): Db | undefined {
  if (!isAbsolute(file)) throw new Error("Unsafe placement inventory path");
  const path = resolve(file), parent = lstatSync(dirname(path)), stat = lstatSync(path);
  if (!parent.isDirectory() || parent.isSymbolicLink() || realpathSync(dirname(path)) !== dirname(path) ||
      !stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path ||
      typeof process.getuid === "function" && (parent.uid !== process.getuid() || stat.uid !== process.getuid())) {
    throw new Error("Unsafe placement inventory path");
  }
  return openDbReadOnly(path, { busyTimeoutMs: 100 });
}

/** A missing, stale, or incomplete inventory never proves that a session was removed. */
export function removedPlacementSessions(globalDb: Db, sessions: readonly string[]): ReadonlySet<string> {
  const removed = new Set<string>();
  try {
    const location = globalDb.prepare("SELECT stores_json FROM roam_locations WHERE session_id=?");
    const home = globalDb.prepare("SELECT 1 FROM session_homes WHERE session_id=?");
    for (const session of sessions) {
      const row = location.get(session) as { stores_json?: unknown } | undefined;
      if (!row || typeof row.stores_json !== "string" || home.get(session)) continue;
      const stores: unknown = JSON.parse(row.stores_json);
      if (Array.isArray(stores) && stores.length === 0) removed.add(session);
    }
    if (!removed.size) return removed;
    let incomplete = false;
    const keys = listStoreKeys(globalDb, { open: openOwned, onIncomplete: () => { incomplete = true; } });
    if (incomplete) return new Set();
    const seenPaths = new Set<string>(), seenKeys = new Set<string>();
    const inspect = (db: Db): void => {
      const path = resolve(db.raw.name);
      if (seenPaths.has(path)) return;
      seenPaths.add(path);
      const present = db.prepare("SELECT 1 FROM sessions WHERE id=? LIMIT 1");
      for (const session of removed) if (present.get(session)) removed.delete(session);
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='roam_meta'").get()) {
        const meta = db.prepare("SELECT store_key FROM roam_meta WHERE id=1").get() as { store_key?: unknown } | undefined;
        if (typeof meta?.store_key === "string") seenKeys.add(meta.store_key);
      }
    };
    const projects = globalDb.prepare("SELECT db_path FROM projects").all() as { db_path: string }[];
    for (const project of projects) {
      const db = openOwned(project.db_path);
      if (!db) return new Set();
      try { inspect(db); } finally { db.close(); }
    }
    for (const key of keys) {
      if (!key.startsWith("worktree:") || seenKeys.has(key)) continue;
      const db = openRoamStoreReadOnly(globalDb, key, { open: openOwned });
      if (!db) return new Set();
      try { inspect(db); } finally { db.close(); }
    }
    return seenPaths.size ? removed : new Set();
  } catch { return new Set(); }
}
