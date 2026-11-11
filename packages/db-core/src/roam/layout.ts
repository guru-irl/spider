import type { Db } from "../db";
import { DESCRIPTORS } from "./descriptors";
import type { Scope } from "./types";

const COMMON_COLUMNS: Record<string, readonly string[]> = {
  roam_meta: ["id", "machine_id", "stream_id", "store_key", "hlc_ms", "hlc_count", "capture_enabled", "importing", "roamable", "problem"],
  roam_changes: ["seq", "change_id", "entity", "row_key", "op", "hlc_ms", "hlc_count", "origin_machine", "origin_stream", "writer_session", "writer_epoch", "schema_version", "body_json", "wire_json"],
  roam_versions: ["entity", "row_key", "change_id", "hlc_ms", "hlc_count", "origin_machine", "origin_stream", "deleted"],
  roam_cursors: ["peer_machine", "peer_stream", "last_seq"],
  roam_receipts: ["peer_machine", "batch_id", "peer_stream", "after_seq", "through_seq", "sha256", "applied_at"],
};

const LOCAL_COLUMNS: Record<Scope, Record<string, readonly string[]>> = {
  global: {
    global_memory: ["id"],
    roam_repo_maps: ["repo_key", "path", "origin_fingerprint", "root_fingerprint", "worktree_command_json"],
    roam_workspace_maps: ["repo_key", "workspace_id", "path", "snapshot_json"],
    roam_locations: ["session_id", "stores_json", "home_json", "file", "cwd"],
    roam_home_actions: ["move_id", "session_id", "expected_epoch", "args_digest", "cancelled", "committed_home_json"],
  },
  repo: { memory: ["id"] },
  worktree: {
    sessions: ["imported_from"],
    todos: ["id"],
    runs: ["pid", "host_pid", "intercom_session", "pid_start_time"],
    run_events: ["id"],
    roam_sessions: ["session_id", "epoch", "state", "move_id", "freeze_seq"],
    roam_seed_progress: ["session_id", "entity", "last_key", "complete"],
  },
};

const PRIMARY_KEYS: Record<string, readonly string[]> = {
  roam_meta: ["id"], roam_changes: ["seq"], roam_versions: ["entity", "row_key"],
  roam_cursors: ["peer_machine", "peer_stream"], roam_receipts: ["peer_machine", "batch_id"],
  global_memory: ["id"], session_homes: ["session_id"], roam_repo_maps: ["repo_key"],
  roam_workspace_maps: ["repo_key", "workspace_id"], roam_locations: ["session_id"],
  roam_home_actions: ["move_id"], memory: ["id"], sessions: ["id"], todos: ["id"],
  runs: ["id"], run_events: ["id"], roam_sessions: ["session_id"],
  roam_seed_progress: ["session_id", "entity"],
};

const COMMON_UNIQUE: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["roam_meta", ["stream_id"]], ["roam_changes", ["change_id"]],
];
const LOCAL_UNIQUE: Record<Scope, ReadonlyArray<readonly [string, readonly string[]]>> = {
  global: [["global_memory", ["uuid"]], ["roam_repo_maps", ["path"]], ["roam_workspace_maps", ["path"]]],
  repo: [["memory", ["uuid"]]],
  worktree: [],
};

const DUPLICATE = "Duplicate todo sequence for row IDs ";
const TRIGGER_DRIFT = "Roaming trigger layout drift";

interface Meta {
  id: number; machine_id: string; stream_id: string; store_key: string | null;
  hlc_ms: number; hlc_count: number; capture_enabled: number; importing: number;
  roamable: number; problem: string | null;
}
interface Index { name: string; unique: number; partial: number }
interface IndexColumn { name: string | null; coll: string; desc: number }

function columns(db: Db, table: string, required: readonly string[]): void {
  const actual = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>;
  const names = new Set(actual.map(column => column.name));
  for (const column of required) {
    if (!names.has(column)) throw new Error(`Missing core data column ${table}.${column}`);
  }
  const expectedKey = PRIMARY_KEYS[table];
  if (expectedKey) {
    const key = actual.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name);
    if (key.length !== expectedKey.length || key.some((name, i) => name !== expectedKey[i])) {
      throw new Error(`Invalid core primary key ${table}`);
    }
  }
}

function indexColumnsMatch(db: Db, name: string, expected: readonly string[]): boolean {
  const actual = db.prepare('SELECT name, coll, "desc" FROM pragma_index_xinfo(?) WHERE "key" = 1 ORDER BY seqno').all(name) as IndexColumn[];
  return actual.length === expected.length && actual.every((column, i) =>
    column.name === expected[i] && column.coll === "BINARY" && column.desc === 0);
}

function indexesFor(db: Db, table: string): Index[] {
  return db.prepare("SELECT name, \"unique\", partial FROM pragma_index_list(?)").all(table) as Index[];
}

function indexPresent(db: Db, table: string, name: string, expected: readonly string[]): boolean {
  const index = indexesFor(db, table).find(item => item.name === name);
  if (!index) return false;
  if (index.unique !== 1 || index.partial !== 0 || !indexColumnsMatch(db, name, expected)) {
    throw new Error(`Invalid core index ${name}`);
  }
  return true;
}

function requireUnique(db: Db, table: string, expected: readonly string[]): void {
  if (!indexesFor(db, table).some(index => index.unique === 1 && index.partial === 0 && indexColumnsMatch(db, index.name, expected))) {
    throw new Error(`Missing core unique index ${table}(${expected.join(", ")})`);
  }
}

function requireIndex(db: Db, table: string, name: string, expected: readonly string[]): void {
  if (!indexPresent(db, table, name, expected)) throw new Error(`Missing core index ${name}`);
}

/** Validate replicated data on open without repairing indexes or triggers. */
export function validateRoamLayout(db: Db, scope: Scope): { captureSafe: boolean; diagnostic: string | null } {
  for (const [table, required] of Object.entries(COMMON_COLUMNS)) columns(db, table, required);
  for (const [table, required] of Object.entries(LOCAL_COLUMNS[scope])) columns(db, table, required);
  for (const descriptor of Object.values(DESCRIPTORS)) {
    if (descriptor.scope === scope) columns(db, descriptor.table, descriptor.columns);
  }
  for (const [table, key] of [...COMMON_UNIQUE, ...LOCAL_UNIQUE[scope]]) requireUnique(db, table, key);
  const rows = db.prepare("SELECT id, machine_id, stream_id, store_key, hlc_ms, hlc_count, capture_enabled, importing, roamable, problem FROM roam_meta").all() as Meta[];
  if (rows.length === 0) throw new Error("Missing core roaming metadata row");
  const meta = rows[0];
  if (rows.length !== 1 || meta.id !== 1 || typeof meta.machine_id !== "string" || !meta.machine_id ||
      typeof meta.stream_id !== "string" || !meta.stream_id ||
      (meta.store_key !== null && typeof meta.store_key !== "string") ||
      (meta.problem !== null && typeof meta.problem !== "string") ||
      ![meta.capture_enabled, meta.importing, meta.roamable].every(value => value === 0 || value === 1) ||
      ![meta.hlc_ms, meta.hlc_count].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("Invalid core roaming metadata");
  }
  if (scope === "worktree") {
    requireIndex(db, "todos", "idx_todos_uuid", ["uuid"]);
    requireIndex(db, "run_events", "idx_run_events_uuid", ["uuid"]);
    if (!indexPresent(db, "todos", "idx_todos_session_seq", ["session_id", "seq"]) &&
        !(meta.roamable === 0 && meta.problem?.startsWith(DUPLICATE))) {
      throw new Error("Missing core index idx_todos_session_seq");
    }
  }

  // Schema 14 capture triggers are introduced by the next migration task.
  const unexpected = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND substr(name, 1, 5) = 'roam_' ORDER BY name").all() as Array<{ name: string }>;
  let diagnostic = meta.problem;
  if (unexpected.length) {
    const problem = `${TRIGGER_DRIFT}: ${unexpected.map(trigger => trigger.name).join(", ")}`;
    if (!diagnostic?.includes(TRIGGER_DRIFT)) diagnostic = diagnostic ? `${diagnostic}; ${problem}` : problem;
    if (meta.capture_enabled !== 0 || diagnostic !== meta.problem) {
      db.prepare("UPDATE roam_meta SET capture_enabled = 0, problem = ? WHERE id = 1").run(diagnostic);
    }
  }
  return { captureSafe: meta.roamable === 1 && !diagnostic, diagnostic };
}

/** Called explicitly after duplicate todo sequences have been repaired. */
export function repairTodoSequenceIndex(db: Db): void {
  db.raw.transaction(() => {
    const meta = db.prepare("SELECT capture_enabled, roamable, problem FROM roam_meta WHERE id = 1").get() as Pick<Meta, "capture_enabled" | "roamable" | "problem"> | undefined;
    if (!meta) throw new Error("Missing core roaming metadata row");
    const exists = indexPresent(db, "todos", "idx_todos_session_seq", ["session_id", "seq"]);
    if (!exists) {
      if (meta.roamable !== 0 || !meta.problem?.startsWith(DUPLICATE)) {
        throw new Error("Missing core index idx_todos_session_seq without a duplicate diagnosis");
      }
      db.exec("CREATE UNIQUE INDEX idx_todos_session_seq ON todos(session_id, seq)");
    }
    if (meta.problem?.startsWith(DUPLICATE)) {
      const separator = meta.problem.indexOf("; ");
      const remaining = separator === -1 ? null : meta.problem.slice(separator + 2);
      db.prepare("UPDATE roam_meta SET roamable = 1, problem = ? WHERE id = 1").run(remaining);
    }
  }).immediate();
}
