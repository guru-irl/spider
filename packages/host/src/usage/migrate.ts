import type { Db } from "@spider/db-core";
import { USAGE_SCHEMA, USAGE_SCHEMA_VERSION, USAGE_SCHEMA_LAYOUT, USAGE_LEASE_SCHEMA, USAGE_LEASE_COLUMNS } from "./schema.js";

// Append future versions here. Phase 3 can add (project, ts) and (role, ts)
// indexes in v2 without restructuring or changing the Phase 1 schema.
export const USAGE_MIGRATIONS: readonly { version: number; sql: string }[] = [{ version: 1, sql: USAGE_SCHEMA }];

export function assertUsageSchemaVersion(db: Db): void {
  const version = db.pragma("user_version") as number;
  if (version > USAGE_SCHEMA_VERSION) {
    throw new Error(`Unsupported future usage schema ${version}; supported version is ${USAGE_SCHEMA_VERSION}`);
  }
  if (version === USAGE_SCHEMA_VERSION) {
    const metadata = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ledger_metadata'").get();
    const layout = metadata ? db.prepare("SELECT value FROM ledger_metadata WHERE key='schema-layout'").get() as { value: string } | undefined : undefined;
    if (layout?.value !== USAGE_SCHEMA_LAYOUT) {
      throw new Error("Obsolete unreleased usage schema 1 layout; rebuild the dev ledger before ingesting");
    }
  }
}

export function migrateUsageLedger(db: Db): void {
  // IMMEDIATE serializes concurrent openers before either reads user_version.
  // No afterCommit effects are used by this isolated store.
  db.raw.transaction(() => {
    assertUsageSchemaVersion(db);
    const version = db.pragma("user_version") as number;
    for (const migration of USAGE_MIGRATIONS) {
      if (migration.version <= version) continue;
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    }
    const columns = db.prepare("PRAGMA table_info(leases)").all() as { name: string; type: string; notnull: number; pk: number; dflt_value: unknown }[];
    const indexes = db.prepare("PRAGMA index_list(leases)").all() as { name: string; unique: number; origin: string; partial: number }[];
    const keys = indexes.filter(index => index.unique || index.origin === "pk");
    const keyColumns = keys.length === 1
      ? db.prepare(`PRAGMA index_info("${keys[0].name.replaceAll('"', '""')}")`).all() as { name: string }[] : [];
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='leases'").get() as { sql: string } | undefined;
    const normalized = (sql: string) => sql.replace(/\bIF\s+NOT\s+EXISTS\b/gi, "").replace(/\s+/g, "").replace(/;$/, "").toLowerCase();
    const compatible = ddl !== undefined && normalized(ddl.sql) === normalized(USAGE_LEASE_SCHEMA) && columns.length === USAGE_LEASE_COLUMNS.length && columns.every((column, index) =>
      column.name === USAGE_LEASE_COLUMNS[index] &&
      column.type.toUpperCase() === (["acquired_at", "expires_at", "next_due_at", "notice_at"].includes(column.name) ? "INTEGER" : "TEXT") &&
      column.notnull === (index === 0 ? 1 : 0) && column.pk === (index === 0 ? 1 : 0) && column.dflt_value === null) &&
      keys.length === 1 && keys[0].origin === "pk" && keys[0].unique === 1 && keys[0].partial === 0 &&
      keyColumns.length === 1 && keyColumns[0].name === "name";
    if (columns.length && !compatible) {
      db.exec("DROP TABLE leases");
    }
    db.exec(USAGE_LEASE_SCHEMA);
  }).immediate();
}
