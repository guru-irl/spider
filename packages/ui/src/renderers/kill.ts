import { truncateToWidth } from "@earendil-works/pi-tui";
import { statusIcon } from "./types.js";
import type { RenderCtx } from "./types.js";

export interface KillResultLine {
  runId: string;
  name: string;
  outcome: "killed" | "already-finished" | "no-process";
  via: "handle" | "pid" | "none";
  lastActivity?: string;
}
export interface KillDetails { killed: KillResultLine[]; requested: string; error?: string }

/** RESULT body (no header — the spider call line already shows `🕸 spider · kill`). */
export function renderKillResult(details: KillDetails, ctx: RenderCtx): string[] {
  const { theme, width } = ctx;
  const rows = details.killed ?? [];
  // Error branch first
  if (details.error) {
    return [
      "",
      truncateToWidth(` ${statusIcon(theme, "fail")} ${theme.fg("error", details.error)}`, width, ""),
    ];
  }
  // Empty-state branch
  if (rows.length === 0) {
    const target = details.requested && details.requested !== "all" ? ` matching '${details.requested}'` : "";
    return ["", truncateToWidth(` ${theme.fg("muted", `no active subagents${target} to kill`)}`, width, "")];
  }
  const out: string[] = [""];
  for (const r of rows) {
    // killed -> ok (green), already-finished/no-process -> warn (yellow)
    const isKilled = r.outcome === "killed";
    const isBenign = r.outcome === "already-finished" || r.outcome === "no-process";
    const icon = statusIcon(theme, isKilled ? "ok" : isBenign ? "warn" : "fail");
    const textColor = isKilled ? "success" : isBenign ? "warning" : "muted";
    const via = r.via !== "none" ? ` ${theme.fg("dim", "·")} ${theme.fg("muted", `via ${r.via}`)}` : "";
    out.push(truncateToWidth(
      ` ${icon} ${theme.bold(r.name)} ${theme.fg("dim", "·")} ${theme.fg(textColor, r.outcome)}${via}`,
      width, "",
    ));
    if (r.lastActivity) {
      out.push(truncateToWidth(` ${theme.fg("dim", "⎿ ")}${theme.fg("toolOutput", `was: ${r.lastActivity}`)}`, width, ""));
    }
  }
  return out;
}
