import type { Db } from "../db";

type RunAlias = "r" | "runs";
type RunLayout = { schemaVersion: number; hasOrigin: boolean; hasMachine: boolean };
const layouts = new WeakMap<Db, RunLayout>();

/** A store without both roaming fields predates run origins, so all of its runs are local. */
export function localRunPredicate(db: Db, alias: RunAlias = "r"): string {
  let layout = layouts.get(db);
  // Reuse a known layout inside a transaction to avoid upgrading a read snapshot
  // before the caller's first write. Outside a transaction, refresh on schema change.
  const schemaVersion = layout && db.raw.inTransaction ? layout.schemaVersion : Number(db.pragma("schema_version"));
  if (!layout || layout.schemaVersion !== schemaVersion) {
    const hasMachine = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='roam_meta'").get());
    const hasOrigin = hasMachine && (db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>)
      .some(column => column.name === "origin_machine");
    layout = { schemaVersion, hasMachine, hasOrigin };
    layouts.set(db, layout);
  }
  if (!layout.hasMachine || !layout.hasOrigin) return "1";
  return `(${alias}.origin_machine IS NULL OR ${alias}.origin_machine = '' OR ${alias}.origin_machine = (SELECT machine_id FROM roam_meta WHERE id=1))`;
}

/** A missing run is never local. Empty origins retain their pre-roaming meaning. */
export function isLocalRun(db: Db, runId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM runs r WHERE r.id=? AND ${localRunPredicate(db)}`).get(runId));
}
