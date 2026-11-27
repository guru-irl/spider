import { icon as uiIcon } from "../icons.js";
import { fitResultLines, statusIcon, type RenderCtx } from "./types.js";

export interface MigrateDetails {
  dryRun: boolean;
  applied: boolean;
  backupDir?: string;
  moved?: Record<string, number>;
  wouldMove?: Record<string, number>;
  ambiguous?: Array<{ table: string; uuid: string; reason: string }>;
  message?: string;
}

export function renderMigrateResult(details: MigrateDetails, { theme, width, expanded = false }: RenderCtx): string[] {
  const out: string[] = [];
  const gutter = ` ${theme.fg("dim", uiIcon(theme.iconStyle, "gutter"))} `;
  if (details.dryRun) out.push(` ${statusIcon(theme, "on")} ${theme.fg("info", "Dry-run preview (no changes made)")}`);
  else if (details.applied) out.push(` ${statusIcon(theme, "ok")} ${theme.fg("success", "Migration applied")}`);
  if (details.backupDir) out.push(gutter + theme.fg("muted", `backup: ${details.backupDir}`));
  const counts = Object.entries(details.moved ?? details.wouldMove ?? {}).filter(([, count]) => count > 0);
  if (counts.length) {
    out.push(` ${theme.fg("dim", `${details.dryRun ? "would move" : "moved"}:`)}`);
    for (const [table, count] of counts) out.push(gutter + `${theme.bold(table)}: ${theme.fg("info", String(count))}`);
  }
  if (details.ambiguous?.length) {
    out.push(` ${statusIcon(theme, "warn")} ${theme.fg("warning", "Ambiguous rows (kept, needs review)")}`);
    for (const { table, reason } of details.ambiguous) out.push(gutter + `${theme.bold(table)}: ${theme.fg("muted", reason)}`);
  }
  if (details.message) out.push(` ${theme.fg("muted", details.message)}`);
  return fitResultLines(out.length ? out : [" (no changes made)"], width, expanded, 3);
}
