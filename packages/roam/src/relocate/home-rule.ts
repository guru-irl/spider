import type { MachineId } from "@spider/db-core/roam/types";
import type { RelocateHome } from "./types";

export function canRunHome(home: RelocateHome | null, machineId: MachineId): boolean {
  return home !== null && home.machineId === machineId && home.state === "running";
}
