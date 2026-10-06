import type { Db } from "@spider/db-core";
import { USAGE_SCHEMA, USAGE_SCHEMA_V2, USAGE_SCHEMA_VERSION, USAGE_SCHEMA_LAYOUT, USAGE_LEASE_SCHEMA, USAGE_LEASE_COLUMNS } from "./schema.js";

import { USAGE_SCHEMA_V3 } from "./schema-v3.js";

// Never rewrite shipped migration SQL. Append additive versions here.
export const USAGE_MIGRATIONS: readonly { version: number; sql: string }[] = [
  { version: 1, sql: USAGE_SCHEMA },
  { version: 2, sql: USAGE_SCHEMA_V2 },
  { version: 3, sql: USAGE_SCHEMA_V3 },
];

const normalizedDdl = (sql: string) => sql
  .replace(/'[^']*(?:''[^']*)*'|\s+/g, token => token.startsWith("'") ? token : "")
  .replace(/;$/, "");
type SchemaObject = { type: string; name: string; tbl_name: string; sql: string | null };
const durableSql = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name != 'leases' AND name NOT LIKE 'sqlite_stat%' ORDER BY type,name";
const normalizedObjects = (rows: SchemaObject[]) => rows.map(row => ({ ...row, sql: row.sql === null ? null : normalizedDdl(row.sql) }));
const shippedObjects = new Map<number, SchemaObject[]>();
function expectedObjects(db: Db, version: number): SchemaObject[] {
  let objects = shippedObjects.get(version);
  if (!objects) {
    // Use the same SQLite engine to expand views, triggers and implicit indexes.
    // This connection is strictly in-memory, never a user file or configuration.
    const Database = db.raw.constructor as new (file: string) => Db["raw"];
    const reference = new Database(":memory:");
    try {
      for (const migration of USAGE_MIGRATIONS) {
        if (migration.version <= version) reference.exec(migration.sql);
      }
      objects = normalizedObjects(reference.prepare(durableSql).all() as SchemaObject[]);
      shippedObjects.set(version, objects);
    } finally { reference.close(); }
  }
  return objects;
}

export function assertUsageSchemaVersion(db: Db): void {
  const version = db.pragma("user_version") as number;
  if (version > USAGE_SCHEMA_VERSION) {
    throw new Error(`Unsupported future usage schema ${version}; supported version is ${USAGE_SCHEMA_VERSION}`);
  }
  if (version > 0) {
    const metadata = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ledger_metadata'").get();
    const layout = metadata ? db.prepare("SELECT value FROM ledger_metadata WHERE key='schema-layout'").get() as { value: string } | undefined : undefined;
    if (layout?.value !== USAGE_SCHEMA_LAYOUT) {
      throw new Error(`Unsupported usage schema ${version} layout marker`);
    }
    // ALL durable objects must match, including added objects and SQL-less
    // implicit indexes. SQLite-managed statistics are excluded; only leases
    // retain Phase 1's transient repair exception.
    const objects = normalizedObjects(db.prepare(durableSql).all() as SchemaObject[]);
    if (JSON.stringify(objects) !== JSON.stringify(expectedObjects(db, version))) {
      throw new Error(`Unsupported usage schema ${version} durable layout`);
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
    let columns = db.prepare("PRAGMA table_info(leases)").all() as { name: string; type: string; notnull: number; pk: number; dflt_value: unknown }[];
    const indexes = db.prepare("PRAGMA index_list(leases)").all() as { name: string; unique: number; origin: string; partial: number }[];
    const keys = indexes.filter(index => index.unique || index.origin === "pk");
    const keyColumns = keys.length === 1
      ? db.prepare(`PRAGMA index_info("${keys[0].name.replaceAll('"', '""')}")`).all() as { name: string }[] : [];
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='leases'").get() as { sql: string } | undefined;
    const normalized = (sql: string) => sql.replace(/\bIF\s+NOT\s+EXISTS\b/gi, "").replace(/\s+/g, "").replace(/;$/, "").toLowerCase();
    // Upgrade the previous exact layout additively. A live owner's row must not
    // be deleted just because a newer worker learns PID/host recovery.
    const legacySql = USAGE_LEASE_SCHEMA.replace(",\n  owner_pid INTEGER, owner_host TEXT", "");
    if (ddl && normalized(ddl.sql) === normalized(legacySql) && columns.length === USAGE_LEASE_COLUMNS.length - 2) {
      db.exec("ALTER TABLE leases ADD COLUMN owner_pid INTEGER; ALTER TABLE leases ADD COLUMN owner_host TEXT");
      ddl.sql = USAGE_LEASE_SCHEMA;
      columns = db.prepare("PRAGMA table_info(leases)").all() as typeof columns;
    }
    const compatible = ddl !== undefined && normalized(ddl.sql) === normalized(USAGE_LEASE_SCHEMA) && columns.length === USAGE_LEASE_COLUMNS.length && columns.every((column, index) =>
      column.name === USAGE_LEASE_COLUMNS[index] &&
      column.type.toUpperCase() === (["acquired_at", "expires_at", "next_due_at", "notice_at", "owner_pid"].includes(column.name) ? "INTEGER" : "TEXT") &&
      column.notnull === (index === 0 ? 1 : 0) && column.pk === (index === 0 ? 1 : 0) && column.dflt_value === null) &&
      keys.length === 1 && keys[0].origin === "pk" && keys[0].unique === 1 && keys[0].partial === 0 &&
      keyColumns.length === 1 && keyColumns[0].name === "name";
    if (columns.length && !compatible) {
      db.exec("DROP TABLE leases");
    }
    db.exec(USAGE_LEASE_SCHEMA);
  }).immediate();
}
