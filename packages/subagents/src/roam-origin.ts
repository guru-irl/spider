import type { Db } from "@spider/db-core";
import { isLocalRun, localRunPredicate } from "@spider/db-core/roam/run-origin";

export { isLocalRun };
const owned = new WeakMap<Db, Map<string, string | null | undefined>>();
const evidence = new WeakMap<object, { id: string; origin: string | null | undefined; session: string }>();
type OriginRow = { id: string; session_id: string; origin_machine?: string | null };

/** Record ownership only after creation or a verified local adoption. */
export function rememberOwnedRun(db: Db, runId: string): void {
  const row = db.prepare(`SELECT r.* FROM runs r WHERE r.id=? AND ${localRunPredicate(db)}`).get(runId) as OriginRow | undefined;
  if (!row) return;
  let runs = owned.get(db);
  if (!runs) { runs = new Map(); owned.set(db, runs); }
  runs.set(runId, row.origin_machine);
}

export function attachOwnership<T extends OriginRow | undefined>(db: Db, row: T): T {
  const runs = owned.get(db);
  if (row && runs?.has(row.id) && runs.get(row.id) === row.origin_machine) {
    evidence.set(row, { id: row.id, origin: row.origin_machine, session: row.session_id });
  }
  return row;
}

export function hasOwnership(row: OriginRow): boolean {
  const proof = evidence.get(row);
  return !!proof && proof.id === row.id && proof.origin === row.origin_machine && proof.session === row.session_id;
}
