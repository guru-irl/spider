import { openDbAt, paths } from "@spider/db-core";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "@spider/db-core";

export function makeOrgDb(): { db: Db; cleanup(): void } {
  const dbPath = join(paths.scratch("project", process.cwd()), `org-${crypto.randomUUID()}.db`);
  const db = openDbAt(dbPath, "project");
  return {
    db,
    cleanup() {
      db.close();
      for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath}${s}`, { force: true });
    },
  };
}
