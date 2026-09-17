import type { Db } from "./db";
import { GLOBAL_SCHEMA, REPO_SCHEMA, WORKTREE_SCHEMA } from "./schema";

export const SCHEMA_VERSION = 10;

/** Incremental steps applied to an EXISTING db (user_version>0) to reach SCHEMA_VERSION.
 *  Keyed by the version they bring the db TO. Fresh dbs (user_version 0) get the full schema
 *  instead, which already includes every column. */
const GLOBAL_MIGRATIONS: Record<number, readonly string[]> = {
  5: [
    "ALTER TABLE message_mirror ADD COLUMN delivered_at INTEGER",
    "ALTER TABLE message_mirror ADD COLUMN read_at INTEGER",
    "CREATE INDEX IF NOT EXISTS idx_mm_to_undelivered ON message_mirror(to_session, delivered_at)",
  ],
  6: [
    "ALTER TABLE projects ADD COLUMN repo_key TEXT",
  ],
  // v9: session_bindings was added to GLOBAL_SCHEMA (fresh installs) without a
  // migration step, so every EXISTING global db threw "no such table:
  // session_bindings" on any action that resolves a project (getBinding is on the
  // hot path via resolveProject). Tests never caught it because they all build
  // fresh DBs, where GLOBAL_SCHEMA already contains the table.
  //
  // This is keyed at 9 rather than 8 deliberately: a db that already reached 8
  // would be skipped by the `current >= SCHEMA_VERSION` early return and stay
  // broken forever.
  9: [
    `CREATE TABLE IF NOT EXISTS session_bindings (
  session_id TEXT PRIMARY KEY,
  worktree_root TEXT NOT NULL,
  bound_at INTEGER NOT NULL
)`,
  ],
  // v10: postinstall used to create a partial projects table without repo_key
  // while leaving user_version at 0. The fresh GLOBAL_SCHEMA CREATE TABLE then
  // became a silent no-op and migrate stamped the malformed database v9, so the
  // v6 ALTER could never run. This repair is deliberately keyed ABOVE the stuck
  // version, just like the v8 repo.db and v9 session_bindings repairs.
  // The ALTER itself is conditionally applied below because healthy databases
  // already have repo_key and SQLite has no ADD COLUMN IF NOT EXISTS.
  10: [],
};

const REPO_MIGRATIONS: Record<number, readonly string[]> = {
  // v7: split from PROJECT_SCHEMA; repo tier gets memory, skills, curator_state
  7: [],
  // v8: IMPORTANT 5 - repair poisoned repo.db files from pre-fix builds
  // (had worktree schema + no memory_fts, stamped v7)
  8: [
    // Create memory_fts if it doesn't exist (idempotent)
    `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(uuid UNINDEXED, category, content, link)`,
  ],
};

const WORKTREE_MIGRATIONS: Record<number, readonly string[]> = {
  2: ["ALTER TABLE runs ADD COLUMN thinking TEXT"],
  3: [],  // skills moved to repo tier
  4: [
    "ALTER TABLE runs ADD COLUMN pid INTEGER",
    "ALTER TABLE runs ADD COLUMN host_pid INTEGER",
  ],
  5: [], // Version bump only
  6: [], // Version bump only
  7: [], // split from PROJECT_SCHEMA; worktree tier gets sessions, content, todos, runs, events
};

function repairGlobalProjectsRepoKey(db: Db): void {
  const columns = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  if (columns.length > 0 && !columns.some((column) => column.name === "repo_key")) {
    db.exec("ALTER TABLE projects ADD COLUMN repo_key TEXT");
  }
}

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
  5: [], // Version bump only for project scope
  6: [], // Version bump only for project scope
};

export function migrate(db: Db, scope: "global" | "repo" | "worktree" | "project"): void {
  // "project" is a deprecated alias for "worktree"
  const actualScope = scope === "project" ? "worktree" : scope;
  
  const current = Number(db.pragma("user_version"));
  if (current >= SCHEMA_VERSION) return;
  db.withRetry(() => {
    const run = db.transaction(() => {
      if (current === 0) {
        if (actualScope === "global") {
          db.exec(GLOBAL_SCHEMA);
          // GLOBAL_SCHEMA cannot replace a malformed table created by an older
          // postinstall because its CREATE TABLE is intentionally idempotent.
          repairGlobalProjectsRepoKey(db);
        } else if (actualScope === "repo") {
          db.exec(REPO_SCHEMA);
        } else {
          db.exec(WORKTREE_SCHEMA);
        }
      } else {
        for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
          let steps: readonly string[];
          if (actualScope === "global") {
            steps = GLOBAL_MIGRATIONS[v] ?? [];
          } else if (actualScope === "repo") {
            steps = REPO_MIGRATIONS[v] ?? [];
          } else {
            steps = WORKTREE_MIGRATIONS[v] ?? [];
          }
          for (const s of steps) db.exec(s);

          if (actualScope === "global" && v === 10) {
            repairGlobalProjectsRepoKey(db);
          }
          
          // IMPORTANT 5: After creating memory_fts (v8), populate it from memory
          if (actualScope === "repo" && v === 8) {
            // Populate FTS (idempotent - DELETE first if somehow already populated)
            db.exec("DELETE FROM memory_fts");
            const memoryRows = db.prepare("SELECT uuid, category, content, link FROM memory").all();
            const insertStmt = db.prepare("INSERT INTO memory_fts (uuid, category, content, link) VALUES (?, ?, ?, ?)");
            for (const row of memoryRows) {
              const r = row as { uuid: string; category: string; content: string; link: string | null };
              insertStmt.run(r.uuid, r.category, r.content, r.link);
            }
          }
        }
      }
      db.raw.pragma(`user_version = ${SCHEMA_VERSION}`);
    });
    run();
  });
}
