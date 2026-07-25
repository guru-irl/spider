import { openDbAt, paths, type Db } from "@spider/db-core";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";

export function makeContentDb(): { db: Db; repoDb: Db; cleanup(): void } {
  const dbPath = join(paths.scratch("worktree", process.cwd()), `cs-wt-${randomUUID()}.db`);
  const repoPath = join(paths.scratch("repo", process.cwd()), `cs-repo-${randomUUID()}.db`);
  const db = openDbAt(dbPath, "worktree");
  const repoDb = openDbAt(repoPath, "repo");

  return {
    db,
    repoDb,
    cleanup() {
      db.close();
      repoDb.close();
      for (const s of ["", "-wal", "-shm"]) {
        rmSync(`${dbPath}${s}`, { force: true });
        rmSync(`${repoPath}${s}`, { force: true });
      }
    },
  };
}
