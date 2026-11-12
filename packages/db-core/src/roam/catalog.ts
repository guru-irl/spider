import type { Db } from "../db";
import { openRoamStoreReadOnly, roamReplicaPath } from "./reads";
import type { Home, StoreKey } from "./types";

interface LocationRow { session_id: string; stores_json: string; home_json: string | null; file: string | null; cwd: string | null }

export const replicaPath: typeof roamReplicaPath = roamReplicaPath;

function stores(row: LocationRow): StoreKey[] {
  const parsed: unknown = JSON.parse(row.stores_json);
  if (!Array.isArray(parsed) || parsed.some(value => typeof value !== "string")) throw new Error("Invalid roaming location");
  return parsed as StoreKey[];
}

export function recordLocation(globalDb: Db, input: { sessionId: string; stores: readonly StoreKey[]; home: Home | null; file?: string; cwd?: string }): void {
  globalDb.prepare(`INSERT INTO roam_locations(session_id, stores_json, home_json, file, cwd) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET stores_json = excluded.stores_json, home_json = excluded.home_json,
      file = coalesce(excluded.file, roam_locations.file), cwd = coalesce(excluded.cwd, roam_locations.cwd)
    WHERE roam_locations.stores_json IS NOT excluded.stores_json OR roam_locations.home_json IS NOT excluded.home_json
      OR (excluded.file IS NOT NULL AND roam_locations.file IS NOT excluded.file)
      OR (excluded.cwd IS NOT NULL AND roam_locations.cwd IS NOT excluded.cwd)`)
    .run(input.sessionId, JSON.stringify([...new Set(input.stores)]), input.home ? JSON.stringify(input.home) : null, input.file ?? null, input.cwd ?? null);
}

function homeFor(globalDb: Db, sessionId: string): Home | null {
  const row = globalDb.prepare("SELECT machine_id, epoch, move_id, updated_at FROM session_homes WHERE session_id = ?")
    .get(sessionId) as { machine_id: string; epoch: number; move_id: string | null; updated_at: number } | undefined;
  return row?.machine_id ? { sessionId, machineId: row.machine_id, epoch: row.epoch, moveId: row.move_id, updatedAt: row.updated_at } : null;
}

export function catalogReplica(globalDb: Db, key: StoreKey, replicaDb: Db): void {
  if (!key.startsWith("worktree:")) return;
  const ids = new Set((replicaDb.prepare(`SELECT id AS session_id FROM sessions UNION SELECT session_id FROM todos
    UNION SELECT session_id FROM runs UNION SELECT session_id FROM run_events`).all() as { session_id: string }[]).map(row => row.session_id));
  globalDb.raw.transaction(() => {
    const locations = globalDb.prepare("SELECT * FROM roam_locations").all() as LocationRow[];
    for (const row of locations) {
      const existing = stores(row);
      if (!existing.includes(key)) continue;
      const stillPresent = ids.delete(row.session_id);
      recordLocation(globalDb, { sessionId: row.session_id, stores: stillPresent ? existing : existing.filter(value => value !== key), home: homeFor(globalDb, row.session_id) });
    }
    for (const sessionId of ids) {
      const row = globalDb.prepare("SELECT * FROM roam_locations WHERE session_id = ?").get(sessionId) as LocationRow | undefined;
      recordLocation(globalDb, { sessionId, stores: [...(row ? stores(row) : []), key], home: homeFor(globalDb, sessionId) });
    }
  }).immediate();
}

export function resolveSessionReplica(globalDb: Db, sessionId: string): { storeKey: StoreKey; db: Db; home: Home | null } | null {
  const location = globalDb.prepare("SELECT * FROM roam_locations WHERE session_id = ?").get(sessionId) as LocationRow | undefined;
  if (!location) return null;
  const key = stores(location).find(value => value.startsWith("worktree:"));
  if (!key) return null;
  const db = openRoamStoreReadOnly(globalDb, key);
  return db ? { storeKey: key, db, home: homeFor(globalDb, sessionId) } : null;
}
