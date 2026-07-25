import { truncateToWidth } from "@earendil-works/pi-tui";
import { statusIcon } from "./types.js";
import type { RenderCtx } from "./types.js";

export interface MigrateDetails {
  dryRun: boolean;
  applied: boolean;
  backupDir?: string;
  moved?: Record<string, number>;
  wouldMove?: Record<string, number>;
  ambiguous?: Array<{ table: string; uuid: string; reason: string }>;
  message?: string;
}

/** Render the migrate result as a themed card. */
export function renderMigrateResult(details: MigrateDetails, ctx: RenderCtx): string[] {
  const { theme, width } = ctx;
  const out: string[] = [""];
  
  // Dry-run vs applied header
  if (details.dryRun) {
    out.push(truncateToWidth(
      ` ${statusIcon(theme, "on")} ${theme.fg("info", "Dry-run preview (no changes made)")}`,
      width, ""
    ));
  } else if (details.applied) {
    out.push(truncateToWidth(
      ` ${statusIcon(theme, "ok")} ${theme.fg("success", "Migration applied")}`,
      width, ""
    ));
  }
  
  // Backup location
  if (details.backupDir) {
    out.push("");
    out.push(truncateToWidth(
      ` ${theme.fg("dim", "backup:")} ${theme.fg("muted", details.backupDir)}`,
      width, "…"
    ));
  }
  
  // Show moved/would-move counts
  const counts = details.moved ?? details.wouldMove;
  if (counts && Object.keys(counts).length > 0) {
    out.push("");
    const verb = details.dryRun ? "would move" : "moved";
    out.push(truncateToWidth(` ${theme.fg("dim", `${verb}:`)}`, width, ""));
    
    for (const [table, count] of Object.entries(counts)) {
      if (count > 0) {
        out.push(truncateToWidth(
          `   ${theme.fg("muted", "·")} ${theme.bold(table)}: ${theme.fg("info", String(count))}`,
          width, ""
        ));
      }
    }
  }
  
  // Report ambiguous rows
  if (details.ambiguous && details.ambiguous.length > 0) {
    out.push("");
    out.push(truncateToWidth(
      ` ${statusIcon(theme, "warn")} ${theme.fg("warning", "Ambiguous rows (kept, needs review)")}`,
      width, ""
    ));
    
    for (const amb of details.ambiguous) {
      out.push(truncateToWidth(
        `   ${theme.fg("muted", "·")} ${theme.bold(amb.table)}: ${theme.fg("muted", amb.uuid)}`,
        width, "…"
      ));
      out.push(truncateToWidth(
        `     ${theme.fg("dim", amb.reason)}`,
        width, "…"
      ));
    }
  }
  
  // Generic message
  if (details.message) {
    out.push("");
    out.push(truncateToWidth(` ${theme.fg("muted", details.message)}`, width, "…"));
  }
  
  return out;
}
