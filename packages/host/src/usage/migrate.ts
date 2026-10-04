import type { Db } from "@spider/db-core";
import { USAGE_SCHEMA, USAGE_SCHEMA_VERSION } from "./schema.js";

// Append future versions here. Phase 3 can add (project, ts) and (role, ts)
// indexes in v2 without restructuring or changing the Phase 1 schema.
export const USAGE_MIGRATIONS: readonly { version: number; sql: string }[] = [{ version: 1, sql: USAGE_SCHEMA }];

export function assertUsageSchemaVersion(db: Db): void {
  const version = db.pragma("user_version") as number;
  if (version > USAGE_SCHEMA_VERSION) {
    throw new Error(`Unsupported future usage schema ${version}; supported version is ${USAGE_SCHEMA_VERSION}`);
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
  }).immediate();
}
