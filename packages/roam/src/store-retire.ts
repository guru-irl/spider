import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Db } from "@spider/db-core";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { openRoamPathReadOnly, roamStorePath } from "@spider/db-core/roam/reads";
import { storeScope } from "@spider/db-core/roam/codec";
import type { StoreKey } from "@spider/db-core/roam/types";
import { isMachineId } from "./machine-id";
import type { PruneEntry, PruneResult } from "./store-prune";

type Row = Record<string, string | number | null>;
interface Reference { entry: PruneEntry; table: "projects" | "roam_repo_maps" | "roam_workspace_maps"; row: Row; storeKey?: StoreKey; repository?: boolean }

/** The caller obtains retiredMachines from the private hub journal, or an authenticated hub instruction.
 * Absence from enrollment, a changed identity, or --confirm alone is never destruction proof. */
export function retireForeignStores(db: Db, localMachine: string, retiredMachines: readonly string[], confirm = false): PruneResult {
  if (!isMachineId(localMachine) || retiredMachines.some(id => !isMachineId(id) || id === localMachine)) throw new Error("Invalid retirement proof");
  const retired = new Set(retiredMachines);
  return db.raw.transaction(() => {
    const identity = db.prepare("SELECT machine_id FROM roam_meta WHERE id=1").get() as { machine_id: string };
    if (identity.machine_id !== localMachine) throw new Error("Catalog machine identity mismatch");
    const result: PruneResult = { candidates: [], removed: [], unavailable: [] }, references: Reference[] = [];
    for (const row of db.prepare("SELECT * FROM projects ORDER BY rowid").all() as Row[]) {
      references.push({ entry: { key: `project:${row.project_key}`, path: String(row.db_path) }, table: "projects", row });
      if (row.git_common_dir) references.push({ entry: { key: `repository:${row.project_key}`, path: join(String(row.git_common_dir), "spider", "repo.db") }, table: "projects", row, repository: true });
    }
    for (const table of ["roam_repo_maps", "roam_workspace_maps"] as const) {
      for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[]) {
        const key = (table === "roam_repo_maps" ? `repo:${row.repo_key}` : `worktree:${row.repo_key}:${row.workspace_id}`) as StoreKey;
        references.push({ entry: { key, path: roamStorePath(db, key) }, table, row, storeKey: key });
      }
    }
    const candidates: Array<Reference & { machineId: string; redirect: unknown }> = [];
    const protectedProjects = new Map<string, string>();
    for (const reference of references) {
      const { entry } = reference;
      let store: Db | undefined;
      const unavailable = (check: string) => {
        if (reference.repository) protectedProjects.set(String(reference.row.project_key), check);
        result.unavailable.push({ ...entry, check,
          repair: check === "machine-not-retired" ? "The hub must first prove this owner destroyed with spider roam forget. A live or unknown owner cannot be retired."
            : check === "session-in-use" ? "Recover or finish the session action before retiring its store."
            : "Restore the store or repair its permissions before inspecting retirement again." });
      };
      try {
        store = openRoamPathReadOnly(entry.path);
        if (!store) { unavailable("path-unavailable"); continue; }
        if (Number(store.pragma("user_version")) !== 14) { unavailable("identity-unavailable"); continue; }
        const meta = store.prepare("SELECT machine_id,store_key FROM roam_meta WHERE id=1").get() as { machine_id: string; store_key: StoreKey | null } | undefined;
        if (!meta || !isMachineId(meta.machine_id)) { unavailable("identity-unavailable"); continue; }
        if (meta.store_key !== null) storeScope(meta.store_key);
        const key = reference.storeKey ?? meta.store_key;
        const usedKey = key && db.prepare(`SELECT 1 FROM roam_locations AS location WHERE EXISTS
          (SELECT 1 FROM json_each(location.stores_json) WHERE value=?) AND
          (EXISTS (SELECT 1 FROM session_homes WHERE session_id=location.session_id AND machine_id!='') OR
           EXISTS (SELECT 1 FROM roam_home_actions WHERE session_id=location.session_id AND cancelled=0 AND committed_home_json IS NULL)) LIMIT 1`).get(key);
        if (meta.machine_id === localMachine) {
          if (reference.repository && usedKey) protectedProjects.set(String(reference.row.project_key), "session-in-use");
          continue;
        }
        if (!retired.has(meta.machine_id)) { unavailable("machine-not-retired"); continue; }
        const usedSession = (store.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get()
          ? store.prepare("SELECT id FROM sessions").all() : []) as { id: string }[];
        if (usedKey || usedSession.some(session => db.prepare(`SELECT 1 FROM session_homes WHERE session_id=? AND machine_id!=''
          UNION ALL SELECT 1 FROM roam_home_actions WHERE session_id=? AND cancelled=0 AND committed_home_json IS NULL LIMIT 1`).get(session.id, session.id))) {
          unavailable("session-in-use"); continue;
        }
        result.candidates.push(entry);
        candidates.push({ ...reference, machineId: meta.machine_id, redirect: reference.storeKey ? readLocal(db, "mapping-redirect", reference.storeKey) ?? null : null });
      } catch { unavailable("identity-unavailable"); }
      finally { store?.close(); }
    }
    // Deleting a project also drops its repository reference, which may not be safe to retire.
    const eligible = candidates.filter(candidate => {
      const check = candidate.table === "projects" && !candidate.repository ? protectedProjects.get(String(candidate.row.project_key)) : undefined;
      if (!check) return true;
      result.candidates = result.candidates.filter(entry => entry !== candidate.entry);
      result.unavailable.push({ ...candidate.entry, check, repair: "Keep the project's required repository reference. Recover its home action or repair its identity before retiring the project." });
      return false;
    });
    // Like pruning, an unavailable reference is retained; it cannot authorize its own retirement.
    if (!confirm) return result;
    const audit: unknown[] = [];
    for (const candidate of eligible) {
      const { table, row, entry, repository, storeKey, machineId, redirect } = candidate;
      if (table === "projects") {
        if (repository) db.prepare("UPDATE projects SET git_common_dir=NULL WHERE project_key=?").run(row.project_key);
        else db.prepare("DELETE FROM projects WHERE project_key=?").run(row.project_key);
      } else if (table === "roam_repo_maps") db.prepare("DELETE FROM roam_repo_maps WHERE repo_key=?").run(row.repo_key);
      else db.prepare("DELETE FROM roam_workspace_maps WHERE repo_key=? AND workspace_id=?").run(row.repo_key, row.workspace_id);
      if (storeKey) writeLocal(db, "mapping-redirect", storeKey, undefined);
      result.removed.push(entry); audit.push({ ...entry, table, row, machineId, redirect });
    }
    if (audit.length) writeLocal(db, "store-retire", randomUUID(), { removed: audit });
    return result;
  }).immediate();
}
