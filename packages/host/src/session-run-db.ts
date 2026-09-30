import { resolveProject, openProject, type Db, type ProjectInfo } from "@spider/db-core";
import * as path from "node:path";

/** Resolve a session-owned project without treating a child's cwd as an explicit override. */
export function resolveSessionRunProject(sessionCwd: string, sessionId: string): ProjectInfo {
  return resolveProject(sessionCwd, { sessionId, explicitCwd: false });
}

/** Open the session-owned runs DB, honoring session bindings rather than a child's explicit cwd. */
export function openSessionRunDb(sessionCwd: string, sessionId: string): { db: Db; dbPath: string } {
  let dbPath = path.join(path.resolve(sessionCwd), ".spider", "project.db");
  try {
    const project = resolveSessionRunProject(sessionCwd, sessionId);
    dbPath = project.dbPath;
    return { db: openProject(project.projectKey), dbPath };
  } catch (cause) {
    throw new Error(`cannot open session run DB (${dbPath}): ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}
