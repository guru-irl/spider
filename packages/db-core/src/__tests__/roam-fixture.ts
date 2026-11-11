import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDb, type Db } from "../db";
import { migrate } from "../migrate";
import { scratchDbPath } from "../testutil";
import type { MachineId, Scope, StoreKey } from "../roam/types";

export interface ReplicaFixture {
  root: string;
  db: Db;
  storeKey: StoreKey;
  machineId: MachineId;
  close(): void;
}

/** Each replica owns its files but uses the same deterministic logical keys. */
export function createReplica(scope: Scope, machineId: MachineId): ReplicaFixture {
  const parent = dirname(scratchDbPath("replica"));
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "replica-"));
  const storeKey: StoreKey = scope === "global" ? "global"
    : scope === "repo" ? "repo:fixture-repo" : "worktree:fixture-repo:fixture-workspace";
  let db: Db | undefined;
  try {
    db = openDb(join(root, "store.db"));
    migrate(db, scope, { machineId, globalRoot: root });
    db.prepare("UPDATE roam_meta SET store_key = ? WHERE id = 1").run(storeKey);
  } catch (error) {
    db?.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const store = db;
  let closed = false;
  return {
    root, db: store, storeKey, machineId,
    close() {
      if (closed) return;
      closed = true;
      try { store.close(); }
      finally { rmSync(root, { recursive: true, force: true }); }
    },
  };
}
