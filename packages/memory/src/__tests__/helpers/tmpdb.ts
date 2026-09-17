import { openDbAt, paths, type Db } from "@spider/db-core";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";

export function makeMemDb(): { db: Db; cleanup(): void } {
  const dbPath = join(paths.scratch("repo", process.cwd()), `mem-${randomUUID()}.db`);
  const db = openDbAt(dbPath, "repo");
  
  return {
    db,
    cleanup() {
      db.close();
      try {
        rmSync(dbPath, { force: true });
        rmSync(`${dbPath}-wal`, { force: true });
        rmSync(`${dbPath}-shm`, { force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  };
}

// Global-scope sibling of makeMemDb: migrates GLOBAL_SCHEMA (global_memory, no FTS)
// instead of REPO_SCHEMA (memory + memory_fts), so tests can exercise forgetMemory
// et al against the global tier without a repo-schema DB throwing "no such table".
export function makeGlobalMemDb(): { db: Db; cleanup(): void } {
  const dbPath = join(paths.scratch("repo", process.cwd()), `mem-global-${randomUUID()}.db`);
  const db = openDbAt(dbPath, "global");

  return {
    db,
    cleanup() {
      db.close();
      try {
        rmSync(dbPath, { force: true });
        rmSync(`${dbPath}-wal`, { force: true });
        rmSync(`${dbPath}-shm`, { force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  };
}
