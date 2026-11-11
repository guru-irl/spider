// Historical migration captured from 2c49867dea8d195a9cb2b6313533f02240a464c2.
// The TypeScript printer omitted comments and redirected imports to the captured schema.

import type { Db } from "../../db";
import { V13 } from "./historical-schemas";
const { global: GLOBAL_SCHEMA, repo: REPO_SCHEMA, worktree: WORKTREE_SCHEMA } = V13;
export const SCHEMA_VERSION = 13;
const GLOBAL_MIGRATIONS: Record<number, readonly string[]> = {
    5: [
        "ALTER TABLE message_mirror ADD COLUMN delivered_at INTEGER",
        "ALTER TABLE message_mirror ADD COLUMN read_at INTEGER",
        "CREATE INDEX IF NOT EXISTS idx_mm_to_undelivered ON message_mirror(to_session, delivered_at)",
    ],
    6: [
        "ALTER TABLE projects ADD COLUMN repo_key TEXT",
    ],
    9: [
        `CREATE TABLE IF NOT EXISTS session_bindings (
  session_id TEXT PRIMARY KEY,
  worktree_root TEXT NOT NULL,
  bound_at INTEGER NOT NULL
)`,
    ],
    10: [],
    11: [],
    12: [],
    13: ["CREATE TABLE IF NOT EXISTS run_routes (run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, db_path TEXT NOT NULL)"],
};
const REPO_MIGRATIONS: Record<number, readonly string[]> = {
    7: [],
    8: [
        `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(uuid UNINDEXED, category, content, link)`,
    ],
    11: [],
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
REPO_MIGRATIONS[13] = REPO_MIGRATIONS[12];
const WORKTREE_MIGRATIONS: Record<number, readonly string[]> = {
    2: ["ALTER TABLE runs ADD COLUMN thinking TEXT"],
    3: [],
    4: [
        "ALTER TABLE runs ADD COLUMN pid INTEGER",
        "ALTER TABLE runs ADD COLUMN host_pid INTEGER",
    ],
    5: [],
    6: [],
    7: [],
    12: [],
    13: [],
};
function ensureChildColumns(db: Db): void {
    const columns = db.prepare("PRAGMA table_info(runs)").all() as Array<{
        name: string;
    }>;
    for (const [name, definition] of [
        ["child_mode", "TEXT NOT NULL DEFAULT 'print'"],
        ["intercom_session", "TEXT"],
        ["pid_start_time", "TEXT"],
    ]) {
        if (!columns.some(column => column.name === name))
            db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${definition}`);
    }
}
function ensureMemoryProvenance(db: Db, scope: "global" | "repo"): void {
    const table = scope === "global" ? "global_memory" : "memory";
    let columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
    }>;
    if (columns.length === 0) {
        db.exec(scope === "global" ? GLOBAL_SCHEMA : REPO_SCHEMA);
        columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
            name: string;
        }>;
    }
    for (const field of ["justification", "evidence"]) {
        if (!columns.some(column => column.name === field)) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${field} TEXT`);
        }
    }
}
function ensureSkillReviewReason(db: Db): void {
    const columns = db.prepare("PRAGMA table_info(skills)").all() as Array<{
        name: string;
    }>;
    if (columns.length && !columns.some(column => column.name === "review_reason")) {
        db.exec("ALTER TABLE skills ADD COLUMN review_reason TEXT");
    }
}
function repairGlobalProjectsRepoKey(db: Db): void {
    const columns = db.prepare("PRAGMA table_info(projects)").all() as Array<{
        name: string;
    }>;
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
    5: [],
    6: [],
};
export function migrate(db: Db, scope: "global" | "repo" | "worktree" | "project"): void {
    const actualScope = scope === "project" ? "worktree" : scope;
    const current = Number(db.pragma("user_version"));
    if (current >= SCHEMA_VERSION)
        return;
    db.withRetry(() => {
        const run = db.transaction(() => {
            if (current === 0) {
                if (actualScope === "global") {
                    db.exec(GLOBAL_SCHEMA);
                    repairGlobalProjectsRepoKey(db);
                    ensureMemoryProvenance(db, "global");
                }
                else if (actualScope === "repo") {
                    db.exec(REPO_SCHEMA);
                    ensureMemoryProvenance(db, "repo");
                    ensureSkillReviewReason(db);
                }
                else {
                    db.exec(WORKTREE_SCHEMA);
                }
            }
            else {
                for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
                    let steps: readonly string[];
                    if (actualScope === "global") {
                        steps = GLOBAL_MIGRATIONS[v] ?? [];
                    }
                    else if (actualScope === "repo") {
                        steps = REPO_MIGRATIONS[v] ?? [];
                    }
                    else {
                        steps = WORKTREE_MIGRATIONS[v] ?? [];
                    }
                    for (const s of steps)
                        db.exec(s);
                    if (actualScope === "worktree" && v === 13)
                        ensureChildColumns(db);
                    if (actualScope === "global" && v === 10) {
                        repairGlobalProjectsRepoKey(db);
                    }
                    if (v === 11 && actualScope !== "worktree") {
                        ensureMemoryProvenance(db, actualScope);
                    }
                    if (v === 12 && actualScope === "repo")
                        ensureSkillReviewReason(db);
                    if (v === 13 && actualScope === "repo")
                        ensureSkillReviewReason(db);
                    if (actualScope === "repo" && v === 8) {
                        db.exec("DELETE FROM memory_fts");
                        const memoryRows = db.prepare("SELECT uuid, category, content, link FROM memory").all();
                        const insertStmt = db.prepare("INSERT INTO memory_fts (uuid, category, content, link) VALUES (?, ?, ?, ?)");
                        for (const row of memoryRows) {
                            const r = row as {
                                uuid: string;
                                category: string;
                                content: string;
                                link: string | null;
                            };
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
