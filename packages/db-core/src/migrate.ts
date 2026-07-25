import type { Db } from "./db";
import { GLOBAL_SCHEMA, PROJECT_SCHEMA } from "./schema";

export const SCHEMA_VERSION = 4;

/** Incremental steps applied to an EXISTING db (user_version>0) to reach SCHEMA_VERSION.
 *  Keyed by the version they bring the db TO. Fresh dbs (user_version 0) get the full schema
 *  instead, which already includes every column. */
const PROJECT_MIGRATIONS: Record<number, readonly string[]> = {
  2: ["ALTER TABLE runs ADD COLUMN thinking TEXT"],
  3: [
    `CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL DEFAULT 'project',
  category TEXT, path TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'user',
  pinned INTEGER NOT NULL DEFAULT 0, protected INTEGER NOT NULL DEFAULT 0,
  use_count INTEGER NOT NULL DEFAULT 0, view_count INTEGER NOT NULL DEFAULT 0, patch_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER, last_viewed_at INTEGER, last_patched_at INTEGER,
  candidate_body TEXT,
  related TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER
)`,
    `CREATE INDEX IF NOT EXISTS idx_skills_state ON skills(state, status)`,
    `CREATE TABLE IF NOT EXISTS curator_state (
  scope TEXT PRIMARY KEY,
  last_run_at INTEGER, paused INTEGER NOT NULL DEFAULT 0
)`,
  ],
  4: [
    "ALTER TABLE runs ADD COLUMN pid INTEGER",
    "ALTER TABLE runs ADD COLUMN host_pid INTEGER",
  ],
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
