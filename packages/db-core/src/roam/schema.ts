import { randomUUID } from "node:crypto";
import type { Db } from "../db";
import type { MachineId, Scope } from "./types";

const COMMON = `
CREATE TABLE roam_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  machine_id TEXT NOT NULL,
  stream_id TEXT NOT NULL UNIQUE,
  store_key TEXT,
  hlc_ms INTEGER NOT NULL DEFAULT 0,
  hlc_count INTEGER NOT NULL DEFAULT 0,
  capture_enabled INTEGER NOT NULL DEFAULT 0,
  importing INTEGER NOT NULL DEFAULT 0,
  roamable INTEGER NOT NULL DEFAULT 1,
  problem TEXT
);
CREATE TABLE roam_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id TEXT NOT NULL UNIQUE,
  entity TEXT NOT NULL,
  row_key TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('put', 'delete')),
  hlc_ms INTEGER NOT NULL,
  hlc_count INTEGER NOT NULL,
  origin_machine TEXT NOT NULL,
  origin_stream TEXT NOT NULL,
  writer_session TEXT,
  writer_epoch INTEGER,
  schema_version INTEGER NOT NULL,
  body_json TEXT,
  wire_json TEXT,
  CHECK ((op = 'delete') = (body_json IS NULL))
);
CREATE TABLE roam_versions (
  entity TEXT NOT NULL,
  row_key TEXT NOT NULL,
  change_id TEXT NOT NULL,
  hlc_ms INTEGER NOT NULL,
  hlc_count INTEGER NOT NULL,
  origin_machine TEXT NOT NULL,
  origin_stream TEXT NOT NULL,
  deleted INTEGER NOT NULL,
  PRIMARY KEY (entity, row_key)
);
CREATE TABLE roam_cursors (
  peer_machine TEXT NOT NULL,
  peer_stream TEXT NOT NULL,
  last_seq INTEGER NOT NULL,
  PRIMARY KEY (peer_machine, peer_stream)
);
CREATE TABLE roam_receipts (
  peer_machine TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  peer_stream TEXT NOT NULL,
  after_seq INTEGER NOT NULL,
  through_seq INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (peer_machine, batch_id)
);`;

const GLOBAL = `
CREATE TABLE session_homes (
  session_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch > 0), move_id TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE roam_repo_maps (
  repo_key TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, origin_fingerprint TEXT,
  root_fingerprint TEXT, worktree_command_json TEXT
);
CREATE TABLE roam_workspace_maps (
  repo_key TEXT NOT NULL, workspace_id TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
  snapshot_json TEXT, PRIMARY KEY(repo_key, workspace_id)
);
CREATE TABLE roam_locations (
  session_id TEXT PRIMARY KEY, stores_json TEXT NOT NULL, home_json TEXT, file TEXT, cwd TEXT
);
CREATE TABLE roam_home_actions (
  move_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, expected_epoch INTEGER NOT NULL,
  args_digest TEXT NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0, committed_home_json TEXT
);`;

const WORKTREE = `
CREATE TABLE roam_sessions (
  session_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL CHECK(epoch > 0),
  state TEXT NOT NULL CHECK(state IN ('active','frozen','retired')),
  move_id TEXT, freeze_seq INTEGER
);
CREATE TABLE roam_seed_progress (
  session_id TEXT NOT NULL, entity TEXT NOT NULL, last_key TEXT,
  complete INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session_id, entity)
);`;

function addColumn(db: Db, table: string, name: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

/** Apply the same additions to the fresh v13 base and existing stores. */
export function addRoamSchema(db: Db, scope: Scope, machineId: MachineId): void {
  let duplicateIds: string | null = null;
  if (scope === "global") {
    addColumn(db, "global_memory", "machine_id", "TEXT");
  } else if (scope === "repo") {
    addColumn(db, "memory", "machine_id", "TEXT");
  } else {
    addColumn(db, "sessions", "origin_machine", "TEXT NOT NULL DEFAULT ''");
    addColumn(db, "runs", "origin_machine", "TEXT NOT NULL DEFAULT ''");
    addColumn(db, "todos", "uuid", "TEXT");
    addColumn(db, "run_events", "uuid", "TEXT");
    db.prepare("UPDATE sessions SET origin_machine = ? WHERE origin_machine = ''").run(machineId);
    db.prepare("UPDATE runs SET origin_machine = ? WHERE origin_machine = ''").run(machineId);
    db.exec("UPDATE todos SET uuid = lower(hex(randomblob(16))) WHERE uuid IS NULL OR uuid = ''");
    db.exec("UPDATE run_events SET uuid = lower(hex(randomblob(16))) WHERE uuid IS NULL OR uuid = ''");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_uuid ON todos(uuid)");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_run_events_uuid ON run_events(uuid)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_runs_session_id ON runs(session_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_run_events_session_id ON run_events(session_id)");
    const duplicate = db.prepare(`SELECT group_concat(id, ',') AS ids FROM todos
      WHERE (session_id, seq) IN (
        SELECT session_id, seq FROM todos GROUP BY session_id, seq HAVING count(*) > 1
      ) HAVING count(*) > 0`).get() as { ids: string } | undefined;
    if (duplicate) duplicateIds = duplicate.ids;
    else db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_session_seq ON todos(session_id, seq)");
  }
  const existing = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'roam_meta'").get();
  if (!existing) {
    db.exec(COMMON);
    if (scope === "global") db.exec(GLOBAL);
    if (scope === "worktree") db.exec(WORKTREE);
    db.prepare("INSERT INTO roam_meta (id, machine_id, stream_id) VALUES (1, ?, ?)").run(machineId, randomUUID());
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_roam_changes_entity_row_key ON roam_changes(entity, row_key)");
  if (duplicateIds !== null) {
    db.prepare("UPDATE roam_meta SET roamable = 0, problem = ? WHERE id = 1")
      .run(`Duplicate todo sequence for row IDs ${duplicateIds}`);
  }
}
