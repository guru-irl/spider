import { join } from "node:path";
import { storeScope } from "@spider/db-core/roam/codec";
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
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('freeze_journal','freeze_store_rosters')").all() as { name: string }[]).map(row => row.name));
      if (tables.has("freeze_journal") !== tables.has("freeze_store_rosters")) throw new Error("Incomplete freeze journal");
      if (tables.has("freeze_journal")) {
        const freezes = db.prepare("SELECT session_id,move_id,epoch,state FROM freeze_journal").all() as Array<{ session_id: unknown; move_id: unknown; epoch: unknown; state: unknown }>;
        const rosters = db.prepare("SELECT session_id,move_id,stores_json FROM freeze_store_rosters").all() as Array<{ session_id: unknown; move_id: unknown; stores_json: unknown }>;
        for (const roster of rosters) {
          if (!freezes.some(row => row.session_id === roster.session_id && row.move_id === roster.move_id) || typeof roster.stores_json !== "string") throw new Error("Orphan freeze roster");
          const stores: unknown = JSON.parse(roster.stores_json);
          if (!Array.isArray(stores) || !stores.length || new Set(stores).size !== stores.length) throw new Error("Invalid freeze roster");
          stores.forEach(storeScope);
        }
        for (const row of freezes) {
          if (typeof row.session_id !== "string" || !row.session_id || /[\u0000-\u001f\u007f]/.test(row.session_id) ||
              typeof row.move_id !== "string" || !row.move_id || /[\u0000-\u001f\u007f]/.test(row.move_id) ||
              !Number.isSafeInteger(row.epoch) || Number(row.epoch) < 1 || !["freezing", "frozen", "aborting", "aborted", "complete"].includes(String(row.state))) throw new Error("Invalid freeze record");
          if (row.state === "complete" || row.state === "aborted") continue;
          if (row.state !== "freezing" && !rosters.some(roster => roster.session_id === row.session_id && roster.move_id === row.move_id)) throw new Error("Missing freeze roster");
          findings.push(`freeze session ${row.session_id.replace(/[^A-Za-z0-9._:-]/g, "?").slice(0, 128)} operation ${row.move_id.replace(/[^A-Za-z0-9._:-]/g, "?").slice(0, 128)}`);
        }
      }
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
