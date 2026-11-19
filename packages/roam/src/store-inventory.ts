import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDbReadOnly, type Db } from "@spider/db-core";
import { storeScope } from "@spider/db-core/roam/codec";
import { catalogPath, openRoamStoreReadOnly, roamStorePath, type ReadStoreOptions, type RoamCatalogSource } from "@spider/db-core/roam/reads";
import type { StoreKey } from "@spider/db-core/roam/types";
import type { Diagnostic } from "./contracts";

function assertOwned(file: string, directory: boolean): void {
  const stat = lstatSync(file);
  const code = stat.isSymbolicLink() ? "STORE_PATH_SYMLINK"
    : !(directory ? stat.isDirectory() : stat.isFile()) ? "STORE_PATH_TYPE"
    : realpathSync(file) !== file ? "STORE_PATH_NONCANONICAL"
    : typeof process.getuid === "function" && stat.uid !== process.getuid() ? "STORE_PATH_OWNER" : null;
  if (code) throw Object.assign(new Error("Unsafe store path"), { code });
}
interface InventoryOptions extends ReadStoreOptions {
  onProblem?(entry: string, error?: unknown): void;
  /** A known store or an owned replica could not be observed completely. */
  onIncomplete?(entry: string, error?: unknown): void;
}
export class StoreInventoryError extends Error {
  readonly code: "store-missing" | "store-uninspectable";
  readonly check: string;
  readonly path: string;
  readonly scope: "repo" | "worktree" | "replica";
  constructor(path: string, scope: "repo" | "worktree" | "replica", error?: unknown) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "inspect-failed";
    super("Store inventory problem", { cause: error });
    this.path = path; this.scope = scope;
    this.code = code === "ENOENT" ? "store-missing" : "store-uninspectable";
    this.check = /^[A-Z_]{1,64}$/.test(code) ? code.toLowerCase().replaceAll("_", "-")
      : /^diagnostic-snapshot-(?:changing|wal-unpublished|wal-index-missing|wal-invalid)$/.test(code) ? code : "inspect-failed";
  }
}
export function storeInventoryDiagnostic(entry: string, error?: unknown): Diagnostic {
  const problem = error instanceof StoreInventoryError ? error : new StoreInventoryError(entry, "replica", error);
  const path = problem.path.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 512);
  return { severity: problem.code === "store-missing" ? "warning" as const : "block" as const,
    reason: `${problem.code}:${problem.scope}:${problem.check}: ${problem.code === "store-uninspectable" ? "Cannot inspect store " : ""}${path}`,
    repairCommand: problem.code === "store-missing" ? "spider roam stores prune" : "spider roam doctor" };
}
function keyAt(file: string, machine: string, open: (file: string) => Db | undefined, options: InventoryOptions, replica = false, scope: "repo" | "worktree" | "replica" = "replica"): StoreKey | null {
  let db: Db | undefined;
  const problem = (error?: unknown, incomplete = true) => {
    const issue = new StoreInventoryError(file, scope, error);
    options.onProblem?.(file, issue);
    if (incomplete && issue.code !== "store-missing") options.onIncomplete?.(file, issue);
  };
  try {
    // An untrusted symlink is not a replica. A registered path is a known store.
    assertOwned(dirname(file), true); assertOwned(file, false);
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
  } catch (error) { problem(error, (error as NodeJS.ErrnoException).code !== "STORE_PATH_SYMLINK"); return null; }
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
      const key = keyAt(file, machine, open, options, false, file === row.db_path ? "worktree" : "repo");
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
    let db: Db | undefined, file = key as string;
    const problem = (error?: unknown) => {
      const issue = new StoreInventoryError(file, key.startsWith("worktree:") ? "worktree" : "repo", error);
      options.onProblem?.(file, issue);
      if (issue.code !== "store-missing") options.onIncomplete?.(file, issue);
    };
    try {
      file = roamStorePath(source, key, options);
      db = openRoamStoreReadOnly(source, key, options);
      if (!db) {
        // Recheck the filesystem: only an actual ENOENT is a missing store.
        try { lstatSync(file); problem(); } catch (error) { problem(error); }
        continue;
      }
      const row = db?.prepare("SELECT store_key,machine_id FROM roam_meta WHERE id=1").get() as { store_key: string; machine_id: string } | undefined;
      if (row?.store_key === key && row.machine_id === machine) keys.add(key);
      else problem();
    } catch (error) { problem(error); }
    finally { db?.close(); }
  }
  const directory = join(dirname(options.globalPath ?? catalogPath(source)), "roam", "stores");
  try {
    assertOwned(directory, true);
    for (const name of readdirSync(directory)) {
      if (!/^[a-f0-9]{64}\.db$/.test(name)) continue;
      const key = keyAt(join(directory, name), machine, open, options, true);
      if (key && name === `${createHash("sha256").update(key).digest("hex")}.db`) keys.add(key);
      else if (key) options.onProblem?.(join(directory, name));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const issue = new StoreInventoryError(directory, "replica", error);
      options.onProblem?.(directory, issue); options.onIncomplete?.(directory, issue);
    }
  }
  return [...keys].sort();
}
