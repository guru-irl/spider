import type { Db } from "@spider/db-core";
import { isRoamUuid } from "@spider/db-core/roam/codec";
import type { MachineId } from "@spider/db-core/roam/types";

export function tagMemory(db: Db, uuid: string, machineId: MachineId | null): void {
  if (machineId !== null && !isRoamUuid(machineId)) throw new Error("Invalid machine identity");
  const global = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'global_memory'").get();
  const table = global ? "global_memory" : "memory";
  if (db.prepare(`UPDATE ${table} SET machine_id = ? WHERE uuid = ?`).run(machineId, uuid).changes !== 1) {
    throw new Error("Memory entry not found");
  }
}
