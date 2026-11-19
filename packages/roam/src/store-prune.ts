import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "@spider/db-core";
import { writeLocal } from "@spider/db-core/roam/local-state";

function absent(path: string): boolean {
  try { lstatSync(path); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

/** No store files or session locations are deleted. The audit and edits commit together. */
export function pruneMissingStores(db: Db): number {
  return db.raw.transaction(() => {
    const removed: string[] = [];
    for (const row of db.prepare("SELECT project_key,db_path,git_common_dir FROM projects").all() as { project_key: string; db_path: string; git_common_dir: string | null }[]) {
      if (absent(row.db_path)) {
        db.prepare("DELETE FROM projects WHERE project_key=?").run(row.project_key);
        removed.push(`project:${row.project_key}`);
      } else if (row.git_common_dir && absent(join(row.git_common_dir, "spider", "repo.db"))) {
        db.prepare("UPDATE projects SET git_common_dir=NULL WHERE project_key=?").run(row.project_key);
        removed.push(`repository:${row.project_key}`);
      }
    }
    for (const row of db.prepare("SELECT repo_key,path FROM roam_repo_maps").all() as { repo_key: string; path: string }[]) {
      if (!absent(row.path)) continue;
      db.prepare("DELETE FROM roam_repo_maps WHERE repo_key=?").run(row.repo_key);
      const key = `repo:${row.repo_key}`;
      writeLocal(db, "mapping-redirect", key, undefined); removed.push(key);
    }
    for (const row of db.prepare("SELECT repo_key,workspace_id,path FROM roam_workspace_maps").all() as { repo_key: string; workspace_id: string; path: string }[]) {
      // An existing directory without a DB is a valid mapping awaiting capture.
      if (!absent(row.path)) continue;
      db.prepare("DELETE FROM roam_workspace_maps WHERE repo_key=? AND workspace_id=?").run(row.repo_key, row.workspace_id);
      const key = `worktree:${row.repo_key}:${row.workspace_id}`;
      writeLocal(db, "mapping-redirect", key, undefined); removed.push(key);
    }
    if (removed.length) writeLocal(db, "store-prune", randomUUID(), { removed });
    return removed.length;
  }).immediate();
}
