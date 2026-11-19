import { randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Db } from "@spider/db-core";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";

export interface PruneEntry { key: string; path: string }
export interface PruneResult { candidates: PruneEntry[]; unavailable: Array<PruneEntry & { check: string; repair: string }>; removed: PruneEntry[] }
export class StorePruneError extends Error {
  readonly check: string;
  constructor(readonly path: string, error: unknown) {
    super("Cannot inspect store registration", { cause: error });
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "INSPECT_FAILED";
    this.check = /^[A-Z_]{1,64}$/.test(code) ? code.toLowerCase().replaceAll("_", "-") : "inspect-failed";
  }
}

/** A missing ancestor or a crossed symlink is not evidence of deletion. */
function availability(path: string): "present" | "candidate" | "unavailable" {
  try { return lstatSync(path).isSymbolicLink() ? "unavailable" : "present"; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new StorePruneError(path, error);
  }
  try {
    const parent = dirname(path), stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(parent) !== parent) return "unavailable";
    accessSync(parent, constants.R_OK | constants.X_OK);
    return "candidate";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "unavailable";
    throw new StorePruneError(path, error);
  }
}

type Row = Record<string, string | number | null>;
/** No files or session locations are deleted. The full local audit and edits commit together. */
export function pruneMissingStores(db: Db, confirm = false): PruneResult {
  return db.raw.transaction(() => {
    const result: PruneResult = { candidates: [], unavailable: [], removed: [] };
    const audit: Array<PruneEntry & { table: string; row: Row; redirect: unknown }> = [];
    const candidate = (entry: PruneEntry): boolean => {
      const state = availability(entry.path);
      if (state === "unavailable") result.unavailable.push({ ...entry, check: "path-unavailable", repair: "Mount or restore the path, then inspect again. Nothing was pruned." });
      if (state === "candidate") result.candidates.push(entry);
      return state === "candidate";
    };
    const remember = (entry: PruneEntry, table: string, row: Row, redirect: unknown = null) => {
      result.removed.push(entry); audit.push({ ...entry, table, row, redirect });
    };
    for (const row of db.prepare("SELECT * FROM projects ORDER BY rowid").all() as Row[]) {
      const project = { key: `project:${row.project_key}`, path: String(row.db_path) };
      if (candidate(project)) {
        if (!confirm) continue;
        db.prepare("DELETE FROM projects WHERE project_key=?").run(row.project_key);
        remember(project, "projects", row);
      } else if (row.git_common_dir) {
        const repository = { key: `repository:${row.project_key}`, path: join(String(row.git_common_dir), "spider", "repo.db") };
        if (candidate(repository) && confirm) {
          db.prepare("UPDATE projects SET git_common_dir=NULL WHERE project_key=?").run(row.project_key);
          remember(repository, "projects", row);
        }
      }
    }
    for (const row of db.prepare("SELECT * FROM roam_repo_maps ORDER BY repo_key").all() as Row[]) {
      const entry = { key: `repo:${row.repo_key}`, path: String(row.path) };
      if (!candidate(entry) || !confirm) continue;
      const redirect = readLocal(db, "mapping-redirect", entry.key) ?? null;
      db.prepare("DELETE FROM roam_repo_maps WHERE repo_key=?").run(row.repo_key);
      writeLocal(db, "mapping-redirect", entry.key, undefined);
      remember(entry, "roam_repo_maps", row, redirect);
    }
    for (const row of db.prepare("SELECT * FROM roam_workspace_maps ORDER BY repo_key,workspace_id").all() as Row[]) {
      const entry = { key: `worktree:${row.repo_key}:${row.workspace_id}`, path: String(row.path) };
      const active = db.prepare(`SELECT 1 FROM roam_locations AS location WHERE EXISTS
        (SELECT 1 FROM json_each(location.stores_json) WHERE value=?) AND
        (EXISTS (SELECT 1 FROM session_homes WHERE session_id=location.session_id AND machine_id!='') OR
         EXISTS (SELECT 1 FROM roam_home_actions WHERE session_id=location.session_id AND cancelled=0 AND committed_home_json IS NULL)) LIMIT 1`).get(entry.key);
      if (active) {
        if (availability(entry.path) !== "present") result.unavailable.push({ ...entry, check: "session-in-use", repair: "Recover or finish the session action before pruning its workspace." });
        continue;
      }
      // An existing directory without a DB is a valid mapping awaiting capture.
      if (!candidate(entry) || !confirm) continue;
      const redirect = readLocal(db, "mapping-redirect", entry.key) ?? null;
      db.prepare("DELETE FROM roam_workspace_maps WHERE repo_key=? AND workspace_id=?").run(row.repo_key, row.workspace_id);
      writeLocal(db, "mapping-redirect", entry.key, undefined);
      remember(entry, "roam_workspace_maps", row, redirect);
    }
    if (audit.length) writeLocal(db, "store-prune", randomUUID(), { removed: audit });
    return result;
  }).immediate();
}
