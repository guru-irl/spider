import { openDbAt, paths } from "@spider/db-core";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "@spider/db-core";

export function makeOrgDb(): { db: Db; repoDb: Db; cleanup(): void } {
  const worktreeDbPath = join(paths.scratch("worktree", process.cwd()), `org-wt-${crypto.randomUUID()}.db`);
  const repoDbPath = join(paths.scratch("repo", process.cwd()), `org-repo-${crypto.randomUUID()}.db`);
  const db = openDbAt(worktreeDbPath, "worktree");
  const repoDb = openDbAt(repoDbPath, "repo");
  return {
    db,
    repoDb,
    cleanup() {
      db.close();
      repoDb.close();
      for (const s of ["", "-wal", "-shm"]) {
        rmSync(`${worktreeDbPath}${s}`, { force: true });
        rmSync(`${repoDbPath}${s}`, { force: true });
      }
    },
  };
}
