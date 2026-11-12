import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDbReadOnly, type Db } from "@spider/db-core";
import { storeScope } from "@spider/db-core/roam/codec";
import { openRoamStoreReadOnly } from "@spider/db-core/roam/reads";
import type { StoreKey } from "@spider/db-core/roam/types";

function owned(file: string, directory: boolean): boolean {
  const stat = lstatSync(file);
  return !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()) &&
    realpathSync(file) === file && (typeof process.getuid !== "function" || stat.uid === process.getuid());
}
function keyAt(file: string, machine: string): StoreKey | null {
  let db: Db | undefined;
  try {
    if (!owned(dirname(file), true) || !owned(file, false)) return null;
    db = openDbReadOnly(file);
    if (!db || Number(db.pragma("user_version")) !== 14) return null;
    const row = db.prepare("SELECT machine_id, store_key FROM roam_meta WHERE id = 1").get() as { machine_id: string; store_key: StoreKey | null };
    if (row.machine_id !== machine || row.store_key === null) return null;
    storeScope(row.store_key);
    return row.store_key;
  } catch { return null; }
  finally { db?.close(); }
}

/** Only local registrations and verified replica identities supply paths. */
export function listStoreKeys(globalDb: Db): StoreKey[] {
  const machine = (globalDb.prepare("SELECT machine_id FROM roam_meta WHERE id = 1").get() as { machine_id: string }).machine_id;
  const keys = new Set<StoreKey>(["global"]);
  const registered = globalDb.prepare("SELECT db_path, git_common_dir FROM projects").all() as { db_path: string; git_common_dir: string | null }[];
  for (const row of registered) {
    for (const file of [row.db_path, ...(row.git_common_dir ? [join(row.git_common_dir, "spider", "repo.db")] : [])]) {
      const key = keyAt(file, machine);
      if (key) keys.add(key);
    }
  }
  const mapped = [
    ...(globalDb.prepare("SELECT repo_key FROM roam_repo_maps").all() as { repo_key: string }[]).map(row => `repo:${row.repo_key}` as StoreKey),
    ...(globalDb.prepare("SELECT repo_key,workspace_id FROM roam_workspace_maps").all() as { repo_key: string; workspace_id: string }[])
      .map(row => `worktree:${row.repo_key}:${row.workspace_id}` as StoreKey),
  ];
  for (const key of mapped) {
    let db: Db | undefined;
    try {
      db = openRoamStoreReadOnly(globalDb, key);
      const row = db?.prepare("SELECT store_key,machine_id FROM roam_meta WHERE id=1").get() as { store_key: string; machine_id: string } | undefined;
      if (row?.store_key === key && row.machine_id === machine) keys.add(key);
    } catch { /* An unavailable mapping is not a present store. */ }
    finally { db?.close(); }
  }
  const directory = join(dirname(globalDb.raw.name), "roam", "stores");
  try {
    if (owned(directory, true)) for (const name of readdirSync(directory)) {
      if (!/^[a-f0-9]{64}\.db$/.test(name)) continue;
      const key = keyAt(join(directory, name), machine);
      if (key && name === `${createHash("sha256").update(key).digest("hex")}.db`) keys.add(key);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return [...keys].sort();
}
