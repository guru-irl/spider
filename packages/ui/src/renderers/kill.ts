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
export interface KillDetails { killed: KillResultLine[]; requested: string }

/** RESULT body (no header — the spider call line already shows `🕸 spider · kill`). */
export function renderKillResult(details: KillDetails, ctx: RenderCtx): string[] {
  const { theme, width } = ctx;
  const rows = details.killed ?? [];
  if (rows.length === 0) {
    return ["", truncateToWidth(` ${theme.fg("muted", "no active subagents to kill")}`, width, "")];
  }
  const out: string[] = [""];
  for (const r of rows) {
    const ok = r.outcome === "killed";
    const icon = statusIcon(theme, ok ? "ok" : "fail");
    const via = r.via !== "none" ? ` ${theme.fg("dim", "·")} ${theme.fg("muted", `via ${r.via}`)}` : "";
    out.push(truncateToWidth(
      ` ${icon} ${theme.bold(r.name)} ${theme.fg("dim", "·")} ${theme.fg(ok ? "warning" : "muted", r.outcome)}${via}`,
      width, "",
    ));
    if (r.lastActivity) {
      out.push(truncateToWidth(` ${theme.fg("dim", "⎿ ")}${theme.fg("toolOutput", `was: ${r.lastActivity}`)}`, width, ""));
    }
  }
  return out;
}
