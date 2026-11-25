import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDbReadOnly, validateRoamLayout, type Db } from "@spider/db-core";
import { isRoamUuid, storeScope } from "@spider/db-core/roam/codec";
import { catalogPath, openRoamPathReadOnly, roamStorePath, type ReadStoreOptions, type RoamCatalogSource } from "@spider/db-core/roam/reads";
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
export interface UngatheredStore {
  key: StoreKey | null; scope: "repo" | "worktree" | "replica"; path: string;
  code: "missing" | "unreadable" | "corrupt" | "unsafe" | "uninspectable"; check: string;
}
/** Parse optional metadata from older or current participants at the RPC boundary. */
export function parseUngathered(value: unknown): UngatheredStore[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid ungathered stores");
  return value.map(row => {
    if (!row || typeof row !== "object" || !["repo", "worktree", "replica"].includes(row.scope) ||
        !["missing", "unreadable", "corrupt", "unsafe", "uninspectable"].includes(row.code) ||
        typeof row.path !== "string" || !row.path || row.path.length > 4096 ||
        typeof row.check !== "string" || !/^[a-z][a-z0-9-]{0,80}$/.test(row.check) ||
        row.key !== null && (typeof row.key !== "string" || storeScope(row.key) !== row.scope)) throw new Error("Invalid ungathered store");
    return { key: row.key, scope: row.scope, path: row.path, code: row.code, check: row.check };
  });
}
interface InventoryOptions extends ReadStoreOptions {
  onUngathered?(store: UngatheredStore): void;
  onProblem?(entry: string, error?: unknown): void;
  /** A known store or an owned replica could not be observed completely. */
  onIncomplete?(entry: string, error?: unknown): void;
}
export class StoreInventoryError extends Error {
  readonly code: "store-missing" | "store-uninspectable";
  readonly check: string;
  readonly path: string;
  readonly scope: "repo" | "worktree" | "replica";
  readonly machineId?: string;
  constructor(path: string, scope: "repo" | "worktree" | "replica", error?: unknown, machineId?: string) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "inspect-failed";
    super("Store inventory problem", { cause: error });
    this.path = path; this.scope = scope;
    this.machineId = isRoamUuid(machineId) ? machineId : undefined;
    this.code = code === "ENOENT" ? "store-missing" : "store-uninspectable";
    this.check = /^[A-Z_]{1,64}$/.test(code) ? code.toLowerCase().replaceAll("_", "-")
      : /^diagnostic-snapshot-(?:changing|wal-unpublished|wal-index-missing|wal-invalid)$/.test(code) ? code : "inspect-failed";
  }
}
export function storeInventoryDiagnostic(entry: string, error?: unknown, severity: Diagnostic["severity"] = "warning"): Diagnostic {
  const problem = error instanceof StoreInventoryError ? error : new StoreInventoryError(entry, "replica", error);
  const path = problem.path.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 512);
  return { severity: problem.code === "store-missing" ? "warning" : severity,
    reason: `${problem.code}:${problem.scope}:${problem.check}: ${problem.code === "store-uninspectable" ? "Cannot inspect store " : ""}${path}${problem.code === "store-missing" ? ". Ungathered: restore or mount the path. Planned stores stay registered until created; prune only a confirmed deletion."
      : problem.check === "store-machine-mismatch" ? `. Use the matching catalog, or run ${problem.machineId ? `spider roam stores retire ${problem.machineId}` : "the repair command"} on the hub to preview retirement. Only identities with durable destruction proof can retire. Add --confirm after inspecting the preview. Live or unknown owners remain refused.` : ""}`,
    repairCommand: problem.code === "store-missing" ? "Restore or mount the path; use spider roam stores prune for a confirmed deletion. Planned stores must be created before capture."
      : problem.check.startsWith("diagnostic-snapshot-") ? "Open the store with its writer to publish or recover its WAL, then rerun spider roam doctor."
      : problem.check === "store-machine-mismatch" && problem.machineId ? `spider roam stores retire ${problem.machineId}`
      : problem.check === "store-machine-mismatch" ? "This store belongs to another machine identity. Use a matching machine catalog, then rerun spider roam doctor."
      : "Restore the store or repair its permissions or database, then rerun spider roam doctor." };
}
function ungathered(issue: StoreInventoryError, key: StoreKey | null, options: InventoryOptions): void {
  const code = issue.code === "store-missing" ? "missing" : (issue.check.startsWith("store-path-") || issue.check === "store-layout-unsafe") ? "unsafe"
    : /^(?:sqlite-(?:corrupt|notadb))/.test(issue.check) ? "corrupt" : /^(?:eacces|eperm)$/.test(issue.check) ? "unreadable" : "uninspectable";
  options.onUngathered?.({ key, scope: issue.scope, path: issue.path, code, check: issue.check });
}
function foreignMachine(recorded: unknown, local: unknown): boolean {
  return isRoamUuid(recorded) && isRoamUuid(local) && recorded !== local;
}
function keyAt(file: string, machine: string, open: (file: string) => Db | undefined, options: InventoryOptions, replica = false, scope: "repo" | "worktree" | "replica" = "replica"): StoreKey | null {
  let db: Db | undefined;
  const problem = (error?: unknown, incomplete = true) => {
    const issue = new StoreInventoryError(file, scope, error, machine);
    options.onProblem?.(file, issue);
    ungathered(issue, null, options);
    if (incomplete) options.onIncomplete?.(file, issue);
  };
  try {
    // An untrusted symlink is not a replica. A registered path is a known store.
    assertOwned(dirname(file), true); assertOwned(file, false);
    db = open(file);
    if (!db) {
      try { lstatSync(file); problem(); } catch (error) { problem(error); }
      return null;
    }
    if (Number(db.pragma("user_version")) !== 14) { if (replica) problem(); return null; }
    const row = db.prepare("SELECT machine_id, store_key FROM roam_meta WHERE id = 1").get() as { machine_id: string; store_key: StoreKey | null };
    if (row.machine_id !== machine || row.store_key === null) {
      if (row.machine_id !== machine || replica) problem(!replica && foreignMachine(row.machine_id, machine) ? { code: "STORE_MACHINE_MISMATCH" } : undefined, !replica || row.store_key === null);
      return null;
    }
    storeScope(row.store_key);
    return row.store_key;
  } catch (error) { problem(error, (error as NodeJS.ErrnoException).code !== "STORE_PATH_SYMLINK"); return null; }
  finally { db?.close(); }
}

/** Only local registrations and verified replica identities supply paths. */
export function listStoreKeys(source: RoamCatalogSource, options: InventoryOptions = {}): StoreKey[] {
  const unavailable: UngatheredStore[] = [], notify = options.onUngathered;
  options = { ...options, onUngathered: store => unavailable.push(store) };
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
      const issue = new StoreInventoryError(file, key.startsWith("worktree:") ? "worktree" : "repo", error, machine);
      options.onProblem?.(file, issue);
      ungathered(issue, key, options);
      options.onIncomplete?.(file, issue);
    };
    try {
      file = roamStorePath(source, key, options);
      db = openRoamPathReadOnly(file, open);
      if (!db) {
        // Recheck the filesystem: only an actual ENOENT is a missing store.
        try { lstatSync(file); problem(); } catch (error) { problem(error); }
        continue;
      }
      const row = db?.prepare("SELECT store_key,machine_id FROM roam_meta WHERE id=1").get() as { store_key: string | null; machine_id: string } | undefined;
      if (row?.store_key === null) {
        let safe = false;
        try { safe = validateRoamLayout(db, storeScope(key), "inspect").captureSafe; }
        catch (error) { if (error && typeof error === "object" && "code" in error) throw error; }
        if (!safe) { problem({ code: "STORE_LAYOUT_UNSAFE" }); continue; }
      }
      if (row && (row.store_key === key || row.store_key === null)) {
        if (row.machine_id === machine) keys.add(key);
        else problem(foreignMachine(row.machine_id, machine) ? { code: "STORE_MACHINE_MISMATCH" } : undefined);
      } else problem();
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
      options.onProblem?.(directory, issue); options.onIncomplete?.(directory, issue); ungathered(issue, null, options);
    }
  }
  const byPath = new Map<string, UngatheredStore>();
  for (const store of unavailable) if (!byPath.has(store.path) || store.key !== null) byPath.set(store.path, store);
  for (const store of byPath.values()) notify?.(store);
  return [...keys].sort();
}
