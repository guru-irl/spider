import type { Db } from "./db";
import { GLOBAL_SCHEMA, PROJECT_SCHEMA } from "./schema";

export const SCHEMA_VERSION = 2;

/** Incremental steps applied to an EXISTING db (user_version>0) to reach SCHEMA_VERSION.
 *  Keyed by the version they bring the db TO. Fresh dbs (user_version 0) get the full schema
 *  instead, which already includes every column. */
const PROJECT_MIGRATIONS: Record<number, readonly string[]> = {
  2: ["ALTER TABLE runs ADD COLUMN thinking TEXT"],
};

export function migrate(db: Db, scope: "global" | "project"): void {
  const current = Number(db.pragma("user_version"));
  if (current >= SCHEMA_VERSION) return;
  db.withRetry(() => {
    const run = db.transaction(() => {
      if (current === 0) {
        db.exec(scope === "global" ? GLOBAL_SCHEMA : PROJECT_SCHEMA);
      } else {
        for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
          const steps = scope === "project" ? PROJECT_MIGRATIONS[v] ?? [] : [];
          for (const s of steps) db.exec(s);
        }
      }
      db.raw.pragma(`user_version = ${SCHEMA_VERSION}`);
    });
    run();
  });
}
