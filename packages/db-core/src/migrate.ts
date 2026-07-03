import type { Db } from "./db";
import { GLOBAL_SCHEMA, PROJECT_SCHEMA } from "./schema";

export const SCHEMA_VERSION = 1;

export function migrate(db: Db, scope: "global" | "project"): void {
  const current = Number(db.pragma("user_version"));
  if (current >= SCHEMA_VERSION) return;
  db.withRetry(() => {
    const run = db.transaction(() => {
      db.exec(scope === "global" ? GLOBAL_SCHEMA : PROJECT_SCHEMA);
      db.raw.pragma(`user_version = ${SCHEMA_VERSION}`);
    });
    run();
  });
}
