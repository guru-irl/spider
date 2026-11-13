import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDbReadOnly, type Db } from "@spider/db-core";
import { storeScope } from "@spider/db-core/roam/codec";
import { catalogPath, openRoamStoreReadOnly, type ReadStoreOptions, type RoamCatalogSource } from "@spider/db-core/roam/reads";
import type { StoreKey } from "@spider/db-core/roam/types";

function owned(file: string, directory: boolean): boolean {
  const stat = lstatSync(file);
  return !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()) &&
    realpathSync(file) === file && (typeof process.getuid !== "function" || stat.uid === process.getuid());
}
interface InventoryOptions extends ReadStoreOptions {
  onProblem?(entry: string, error?: unknown): void;
  /** A known store or an owned replica could not be observed completely. */
  onIncomplete?(entry: string, error?: unknown): void;
}
function keyAt(file: string, machine: string, open: (file: string) => Db | undefined, options: InventoryOptions, replica = false): StoreKey | null {
  let db: Db | undefined;
  const problem = (error?: unknown, incomplete = true) => {
    options.onProblem?.(file, error);
    if (incomplete) options.onIncomplete?.(file, error);
  };
  try {
    // An untrusted symlink is not a replica. A registered path is a known store.
    if (!owned(dirname(file), true) || !owned(file, false)) { problem(undefined, false); return null; }
    db = open(file);
    if (!db) { problem(); return null; }
    if (Number(db.pragma("user_version")) !== 14) { if (replica) problem(); return null; }
    const row = db.prepare("SELECT machine_id, store_key FROM roam_meta WHERE id = 1").get() as { machine_id: string; store_key: StoreKey | null };
    if (row.machine_id !== machine || row.store_key === null) {
      if (row.machine_id !== machine || replica) problem(undefined, !replica || row.store_key === null);
      return null;
    }
    storeScope(row.store_key);
    return row.store_key;
  } catch (error) { problem(error, replica); return null; }
  finally { db?.close(); }
}

/** Only local registrations and verified replica identities supply paths. */
export function listStoreKeys(source: RoamCatalogSource, options: InventoryOptions = {}): StoreKey[] {
  const open = options.open ?? openDbReadOnly;
  const machine = "raw" in source
    ? (source.prepare("SELECT machine_id FROM roam_meta WHERE id = 1").get() as { machine_id: string }).machine_id
    : source.machine;
  const keys = new Set<StoreKey>(["global"]);
  const registered = "raw" in source
    ? source.prepare("SELECT db_path, git_common_dir FROM projects").all() as { db_path: string; git_common_dir: string | null }[]
    : source.projects;
  for (const row of registered) {
    for (const file of [row.db_path, ...(row.git_common_dir ? [join(row.git_common_dir, "spider", "repo.db")] : [])]) {
      const key = keyAt(file, machine, open, options);
      if (key) keys.add(key);
    }
  }
  const repos = "raw" in source ? source.prepare("SELECT repo_key FROM roam_repo_maps").all() as { repo_key: string }[] : source.repos;
  const worktrees = "raw" in source ? source.prepare("SELECT repo_key,workspace_id FROM roam_workspace_maps").all() as { repo_key: string; workspace_id: string }[] : source.worktrees;
  const mapped = [
    ...repos.map(row => `repo:${row.repo_key}` as StoreKey),
    ...worktrees.map(row => `worktree:${row.repo_key}:${row.workspace_id}` as StoreKey),
  ];
  for (const key of mapped) {
    let db: Db | undefined;
    try {
      db = openRoamStoreReadOnly(source, key, options);
      const row = db?.prepare("SELECT store_key,machine_id FROM roam_meta WHERE id=1").get() as { store_key: string; machine_id: string } | undefined;
      if (row?.store_key === key && row.machine_id === machine) keys.add(key);
      else { options.onProblem?.(key); options.onIncomplete?.(key); }
    } catch (error) { options.onProblem?.(key, error); options.onIncomplete?.(key, error); /* An unavailable mapping is not a present store. */ }
    finally { db?.close(); }
  }
  const directory = join(dirname(options.globalPath ?? catalogPath(source)), "roam", "stores");
  try {
    if (!owned(directory, true)) { options.onProblem?.(directory); options.onIncomplete?.(directory); }
    else for (const name of readdirSync(directory)) {
      if (!/^[a-f0-9]{64}\.db$/.test(name)) continue;
      const key = keyAt(join(directory, name), machine, open, options, true);
      if (key && name === `${createHash("sha256").update(key).digest("hex")}.db`) keys.add(key);
      else if (key) options.onProblem?.(join(directory, name));
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return [...keys].sort();
}
