import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimMachineIdentity } from "@spider/db-core/roam/machine";
import { parseConfig } from "../../config";
import type { RoamConfig } from "../../contracts";

export const HUB_ID = "00000000-0000-4000-8000-000000000001";

export function writeEnabledConfig(root: string, changes: Partial<RoamConfig> = {}): void {
  const config = parseConfig({ enabled: true, role: "hub", machineId: HUB_ID, hubMachineId: HUB_ID,
    peers: [], discoveryRoots: [], coreUnit: "fixture", ...changes });
  claimMachineIdentity(root, config.machineId);
  writeFileSync(join(root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
}
