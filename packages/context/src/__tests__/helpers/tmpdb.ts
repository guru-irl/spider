import { openDbAt, paths, type Db } from "@spider/db-core";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";

export function makeContentDb(): { db: Db; cleanup(): void } {
  const dbPath = join(paths.scratch("project", process.cwd()), `cs-${randomUUID()}.db`);
  const db = openDbAt(dbPath, "project");

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
    },
  };
}
