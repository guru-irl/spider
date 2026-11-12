import { getBinding, openDbReadOnlyAt, openRoamingCatalogReadOnly, paths, resolveProject, openProject, type Db, type ProjectInfo } from "@spider/db-core";
import { resolveSessionReplica } from "@spider/db-core/roam/catalog";
import * as path from "node:path";

export function openSessionHistoryDb(sessionCwd: string, sessionId: string): { db: Db; dbPath: string } {
  const global = openRoamingCatalogReadOnly();
  try {
    if (global && global.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'roam_locations'").get()) {
      const known = global.prepare("SELECT 1 FROM roam_locations WHERE session_id = ?").get(sessionId);
      if (known) {
        const replica = resolveSessionReplica(global, sessionId);
        if (!replica) throw new Error("Session history replica is unavailable");
        return { db: replica.db, dbPath: replica.db.raw.name };
      }
    }
    const cwd = global ? getBinding(global, sessionId) ?? sessionCwd : sessionCwd;
    const dbPath = path.join(paths.projectRoot(cwd), "project.db");
    const db = openDbReadOnlyAt(dbPath);
    if (!db) throw new Error("Session history database is unavailable");
    return { db, dbPath };
  } finally { global?.close(); }
}

/** Resolve a session-owned project without treating a child's cwd as an explicit override. */
export function resolveSessionRunProject(sessionCwd: string, sessionId: string): ProjectInfo {
  return resolveProject(sessionCwd, { sessionId, explicitCwd: false });
}

/** Open the session-owned runs DB, honoring session bindings rather than a child's explicit cwd. */
export function openSessionRunDb(sessionCwd: string, sessionId: string, resolvedProject?: ProjectInfo | (() => ProjectInfo)): { db: Db; dbPath: string } {
  let dbPath = path.join(path.resolve(sessionCwd), ".spider", "project.db");
  try {
    const project = typeof resolvedProject === "function" ? resolvedProject()
      : resolvedProject ?? resolveSessionRunProject(sessionCwd, sessionId);
    dbPath = project.dbPath;
    return { db: openProject(project.projectKey), dbPath };
  } catch (cause) {
    throw new Error(`cannot open session run DB (${dbPath}): ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}
