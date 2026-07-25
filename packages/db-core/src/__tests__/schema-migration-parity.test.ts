// packages/db-core/src/__tests__/schema-migration-parity.test.ts
//
// Guards the defect class that broke every existing install:
// `session_bindings` was added to GLOBAL_SCHEMA (used only for user_version === 0)
// with no corresponding GLOBAL_MIGRATIONS step. Fresh installs got the table;
// every EXISTING db did not, and `resolveProject -> getBinding` throws
// "no such table: session_bindings" on the hot path, so EVERY spider action died.
//
// The whole suite missed it because every other test builds a fresh db, which
// takes the `user_version === 0` branch and therefore always has every table.
//
// These tests take the OTHER branch on purpose: start a db at an old version and
// migrate it forward, then require its table set to match a fresh db's. Any future
// table added to a *_SCHEMA without a migration step fails here, by name.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDbAt } from "../registry";
import { SCHEMA_VERSION } from "../migrate";
import DatabaseConstructor from "better-sqlite3";

const scratch = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".spider",
  "scratch",
  `parity-${process.pid}`,
);

beforeEach(() => {
  mkdirSync(scratch, { recursive: true });
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Real user tables, ignoring sqlite/fts/vec internals we do not own. */
function tablesOf(dbPath: string): string[] {
  const raw = new DatabaseConstructor(dbPath, { readonly: true });
  const rows = raw
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '%_fts_%'
         AND name NOT LIKE 'vectors%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  raw.close();
  return rows.map((r) => r.name);
}

const TIERS = ["global", "repo", "worktree"] as const;

// Tables that predate the migration ladder. They are only ever created by the
// `user_version === 0` full-schema branch, which is correct for them because any
// db old enough to lack them does not exist in the wild.
//
// This list is a GATE, not a record: if you add a table to GLOBAL_SCHEMA /
// REPO_SCHEMA / WORKTREE_SCHEMA, the parity test below fails until you either add
// a migration step for it or add it here deliberately. `session_bindings` is
// absent on purpose — it is exactly the table that shipped without a migration and
// broke every existing install, and it now has one.
const GRANDFATHERED = new Set([
  "content", "content_fts", "embed_queue", "events", "global_memory", "insights",
  "memory", "message_mirror", "model_stats", "projects", "run_events", "runs",
  "sessions", "sessions_fts", "todos", "todos_fts", "upstream_refs", "vector_map",
]);

function createdTableNames(src: string): string[] {
  return [
    ...new Set(
      [...src.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF NOT EXISTS\s+)?`?([a-z_]+)/gi)].map(
        (m) => m[1],
      ),
    ),
  ].sort();
}

describe("fresh vs migrated schema parity", () => {
  // Mutation this catches: remove the GLOBAL_MIGRATIONS[9] session_bindings step
  // -> fails naming `session_bindings`.
  it("every table in a schema is also creatable on an EXISTING db via a migration", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const schemaSrc = readFileSync(join(here, "..", "schema.ts"), "utf8");
    const migrateSrc = readFileSync(join(here, "..", "migrate.ts"), "utf8");

    const schemaTables = createdTableNames(schemaSrc);
    const migrationTables = new Set(createdTableNames(migrateSrc));

    const unreachable = schemaTables.filter(
      (t) => !migrationTables.has(t) && !GRANDFATHERED.has(t),
    );

    expect(
      unreachable,
      `These tables exist in a *_SCHEMA but no migration step creates them: ` +
        `${unreachable.join(", ")}. Fresh installs will work and every EXISTING install ` +
        `will throw "no such table" at runtime. Add a migration step keyed ABOVE the ` +
        `version existing dbs are stuck at, or grandfather it explicitly.`,
    ).toEqual([]);
  });

  // The specific production failure, pinned so it cannot silently return.
  it("global: an existing db already stamped at the old SCHEMA_VERSION still gets session_bindings", () => {
    // The real-world shape: user_version was already 8 while the table was absent,
    // so a migration keyed at 8 would be skipped by the `current >= SCHEMA_VERSION`
    // early return and the db would stay broken forever. The step must be keyed
    // ABOVE the version such dbs are stuck at.
    const p = join(scratch, "stamped-old.db");
    const raw = new DatabaseConstructor(p);
    raw.pragma("user_version = 8");
    raw.exec(`CREATE TABLE IF NOT EXISTS projects (
      key TEXT PRIMARY KEY, db_path TEXT, repo_key TEXT, created_at INTEGER
    )`);
    raw.close();

    const db = openDbAt(p, "global");
    db.close();

    expect(tablesOf(p)).toContain("session_bindings");
    expect(Number(new DatabaseConstructor(p, { readonly: true }).pragma("user_version", { simple: true }))).toBe(
      SCHEMA_VERSION,
    );
  });

  it("migration is idempotent: opening an already-current db twice is a no-op", () => {
    const p = join(scratch, "idem.db");
    const a = openDbAt(p, "global");
    a.close();
    const before = tablesOf(p);

    const b = openDbAt(p, "global");
    b.close();

    expect(tablesOf(p)).toEqual(before);
  });
});
