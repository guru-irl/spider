import { join } from "node:path";
import type { Diagnostic } from "./contracts";
import { openDiagnosticSnapshot } from "./diagnostic-snapshot";

export type LegacyUpgradeInventory =
  | { status: "legacy-upgrade-ready"; findings: readonly [] }
  | { status: "legacy-upgrade-blocked"; findings: readonly string[] }
  | { status: "legacy-upgrade-unverified"; findings: readonly string[] };

/** Inspect local evidence without opening the source journal for writing. */
export async function inspectLegacyUpgrade(root: string): Promise<LegacyUpgradeInventory> {
  try {
    const db = openDiagnosticSnapshot(join(root, "roam", "journal.db"));
    if (!db) return { status: "legacy-upgrade-ready", findings: [] };
    try {
      const moves = db.prepare("SELECT operation_id FROM roam_operations WHERE kind='move' AND result_json IS NULL ORDER BY operation_id")
        .all() as { operation_id: unknown }[];
      const findings = moves.map(({ operation_id }) => {
        if (typeof operation_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operation_id)) throw new Error("Invalid move ID");
        return `move ${operation_id}`;
      });
      return findings.length ? { status: "legacy-upgrade-blocked", findings } : { status: "legacy-upgrade-ready", findings: [] };
    } finally { db.close(); }
  } catch {
    return { status: "legacy-upgrade-unverified", findings: ["local evidence unavailable"] };
  }
}

export function legacyUpgradeDiagnostic(inventory: LegacyUpgradeInventory): Diagnostic {
  const detail = inventory.findings.length ? ` ${inventory.findings.join(", ")}.` : " No unfinished legacy work was found.";
  return { severity: inventory.status === "legacy-upgrade-ready" ? "info" : "block",
    reason: `${inventory.status}:${detail} See docs/guide/roaming-upgrade.md.`, repairCommand: null };
}
