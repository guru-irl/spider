import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { migrate, openDb, type Db } from "@spider/db-core";
import { scratchDbPath, type ReplicaFixture } from "@spider/db-core/testutil";
import { V13 } from "../../../db-core/src/__tests__/fixtures/historical-schemas.js";

export function createLegacyReplica(machineId: string, seed: (db: Db) => void): ReplicaFixture {
  const parent = dirname(scratchDbPath("legacy-replica"));
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "legacy-replica-"));
  const storeKey = "worktree:fixture-repo:fixture-workspace";
  const db = openDb(join(root, "store.db"));
  try {
    db.exec(V13.worktree);
    db.raw.pragma("user_version = 13");
    seed(db);
    migrate(db, "worktree", { machineId, globalRoot: root });
    db.prepare("UPDATE roam_meta SET store_key = ? WHERE id = 1").run(storeKey);
  } catch (error) {
    db.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return { root, db, storeKey, machineId, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}
