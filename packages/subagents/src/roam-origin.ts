import type { Db } from "@spider/db-core";

const owned = new WeakMap<Db, Map<string, string>>();
const evidence = new WeakMap<object, { id: string; origin: string; session: string }>();
type OriginRow = { id: string; session_id: string; origin_machine?: string };

/** Record ownership only after creation or a verified local adoption. */
export function rememberOwnedRun(db: Db, runId: string): void {
  const row = db.prepare(`SELECT r.origin_machine FROM runs r JOIN roam_meta m ON m.id=1
    WHERE r.id=? AND r.origin_machine=m.machine_id AND r.origin_machine!=''`).get(runId) as { origin_machine: string } | undefined;
  if (!row) return;
  let runs = owned.get(db);
  if (!runs) { runs = new Map(); owned.set(db, runs); }
  runs.set(runId, row.origin_machine);
}

export function attachOwnership<T extends OriginRow | undefined>(db: Db, row: T): T {
  if (row && row.origin_machine && owned.get(db)?.get(row.id) === row.origin_machine) {
    evidence.set(row, { id: row.id, origin: row.origin_machine, session: row.session_id });
  }
  return row;
}

export function hasOwnership(row: OriginRow): boolean {
  const proof = evidence.get(row);
  return !!proof && proof.id === row.id && proof.origin === row.origin_machine && proof.session === row.session_id;
}

/** Historical runs may be read anywhere, but only their execution machine owns them. */
export function isLocalRun(db: Db, runId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM runs r JOIN roam_meta m ON m.id=1
    WHERE r.id=? AND r.origin_machine=m.machine_id AND r.origin_machine!=''`).get(runId));
}
