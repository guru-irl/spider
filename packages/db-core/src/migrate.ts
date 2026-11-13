import { backupBeforeMigration, type Db } from "./db";
import { paths } from "./paths";
import { GLOBAL_SCHEMA, REPO_SCHEMA, WORKTREE_SCHEMA } from "./schema";
import { loadMachineIdentity } from "./roam/machine";
import { indexPresent, validateRoamLayout } from "./roam/layout";
import { GENERATED_TRIGGERS } from "./roam/generated";
import { addRoamSchema } from "./roam/schema";
import type { MachineId } from "./roam/types";

export const SCHEMA_VERSION = 14;

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
  // v11: conditional ALTERs run in ensureMemoryProvenance (SQLite lacks ADD COLUMN IF NOT EXISTS).
  11: [],
  12: [], // Repo-only skill review deployment.
  13: ["CREATE TABLE IF NOT EXISTS run_routes (run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, db_path TEXT NOT NULL)"],
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
  // v11: conditional ALTERs run in ensureMemoryProvenance (SQLite lacks ADD COLUMN IF NOT EXISTS).
  11: [],
  // v12: queue tables plus a conditional skills review_reason ALTER.
  12: [`CREATE TABLE IF NOT EXISTS skill_review_queue (
  name TEXT PRIMARY KEY,
  category TEXT, body TEXT NOT NULL, origin TEXT NOT NULL,
  related TEXT, created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT
);
CREATE TABLE IF NOT EXISTS skill_review_results (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, verdict TEXT NOT NULL,
  reason TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_review_lock (
  id INTEGER PRIMARY KEY CHECK (id=1), token TEXT NOT NULL, lease_until INTEGER NOT NULL
);
`],
};
// Pre-rebase branch builds stamped repo DBs v12 without these tables. Replay
// the deployed, idempotent DDL at v13; healthy main v12 DBs remain unchanged.
REPO_MIGRATIONS[13] = REPO_MIGRATIONS[12];

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
  12: [], // Repo-only skill review deployment.
  13: [], // Conditional ALTERs in ensureChildColumns below.
};

function ensureChildColumns(db: Db): void {
  const columns = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  for (const [name, definition] of [
    ["child_mode", "TEXT NOT NULL DEFAULT 'print'"],
    ["intercom_session", "TEXT"],
    ["pid_start_time", "TEXT"],
  ]) {
    if (!columns.some(column => column.name === name)) db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${definition}`);
  }
}

function ensureMemoryProvenance(db: Db, scope: "global" | "repo"): void {
  const table = scope === "global" ? "global_memory" : "memory";
  let columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.length === 0) {
    db.exec(scope === "global" ? GLOBAL_SCHEMA : REPO_SCHEMA);
    columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  }
  for (const field of ["justification", "evidence"]) {
    if (!columns.some(column => column.name === field)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${field} TEXT`);
    }
  }
}

function ensureSkillReviewReason(db: Db): void {
  const columns = db.prepare("PRAGMA table_info(skills)").all() as Array<{ name: string }>;
  if (columns.length && !columns.some(column => column.name === "review_reason")) {
    db.exec("ALTER TABLE skills ADD COLUMN review_reason TEXT");
  }
}

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

function ensureQueryIndexes(db: Db, scope: "global" | "repo" | "worktree"): void {
  if (scope !== "worktree") return;
  try {
    const create = () => db.exec("CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id, id)");
    if (db.raw.inTransaction) {
      db.raw.transaction(create)();
    } else {
      const timeout = Number(db.raw.pragma("busy_timeout", { simple: true }));
      try {
        db.raw.pragma("busy_timeout = 100");
        create();
      } finally {
        db.raw.pragma(`busy_timeout = ${timeout}`);
      }
    }
  } catch (error) {
    try { console.error(`Could not create run events index: ${String(error).replace(/[\r\n]+/g, " ")}`); } catch { /* diagnostic is best effort */ }
  }
}

export function migrate(
  db: Db,
  scope: "global" | "repo" | "worktree" | "project",
  options?: { machineId: MachineId; globalRoot: string },
): void {
  // "project" is a deprecated alias for "worktree"
  const actualScope = scope === "project" ? "worktree" : scope;

  const observed = Number(db.pragma("user_version"));
  if (observed > SCHEMA_VERSION) throw new Error(`Cannot open future core schema ${observed}`);
  if (observed === SCHEMA_VERSION) {
    const inspection = db.withRetry(() => db.raw.transaction(() => {
      const current = Number(db.raw.pragma("user_version", { simple: true }));
      if (current > SCHEMA_VERSION) throw new Error(`Cannot open future core schema ${current}`);
      if (current !== SCHEMA_VERSION) throw new Error("Core schema changed before its backup");
      const layout = validateRoamLayout(db, actualScope, "inspect");
      return {
        needsWrite: layout.needsWrite,
        missingIndex: actualScope === "worktree" && !indexPresent(db, "run_events", "idx_run_events_run_id"),
      };
    }).deferred());
    if (!inspection.needsWrite) {
      if (inspection.missingIndex) ensureQueryIndexes(db, actualScope);
      return;
    }
  }
  const globalRoot = options?.globalRoot ?? paths.globalRoot;
  const machineId = observed < SCHEMA_VERSION ? options?.machineId ?? loadMachineIdentity(globalRoot) : undefined;
  if (observed < SCHEMA_VERSION) {
    const existing = observed > 0 || !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
    if (existing) backupBeforeMigration(db, actualScope, globalRoot, observed);
  }
  db.withRetry(() => {
    const run = db.raw.transaction(() => {
      const current = Number(db.raw.pragma("user_version", { simple: true }));
      if (current > SCHEMA_VERSION) throw new Error(`Cannot open future core schema ${current}`);
      if (current === SCHEMA_VERSION) {
        validateRoamLayout(db, actualScope);
        ensureQueryIndexes(db, actualScope);
        return;
      }
      if (current !== observed || machineId === undefined) throw new Error("Core schema changed before its backup");
      const hadRoamSchema = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'roam_meta'").get();
      if (current === 0) {
        if (actualScope === "global") {
          db.exec(GLOBAL_SCHEMA);
          // GLOBAL_SCHEMA cannot replace a malformed table created by an older
          // postinstall because its CREATE TABLE is intentionally idempotent.
          repairGlobalProjectsRepoKey(db);
          ensureMemoryProvenance(db, "global");
        } else if (actualScope === "repo") {
          db.exec(REPO_SCHEMA);
          ensureMemoryProvenance(db, "repo");
          ensureSkillReviewReason(db);
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

          if (actualScope === "worktree" && v === 13) ensureChildColumns(db);
          if (actualScope === "global" && v === 10) {
            repairGlobalProjectsRepoKey(db);
          }
          if (v === 11 && actualScope !== "worktree") {
            ensureMemoryProvenance(db, actualScope);
          }
          
          if (v === 12 && actualScope === "repo") ensureSkillReviewReason(db);
          if (v === 13 && actualScope === "repo") ensureSkillReviewReason(db);
          if (v === 14) addRoamSchema(db, actualScope, machineId);

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
      if (current === 0) addRoamSchema(db, actualScope, machineId);
      if (!hadRoamSchema) {
        const existingTrigger = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ? COLLATE NOCASE");
        for (const trigger of GENERATED_TRIGGERS[actualScope]) {
          if (!existingTrigger.get(trigger.name)) db.exec(trigger.sql);
        }
      }
      validateRoamLayout(db, actualScope);
      ensureQueryIndexes(db, actualScope);
      db.raw.pragma(`user_version = ${SCHEMA_VERSION}`);
    });
    run.immediate();
  });
}
