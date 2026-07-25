import { truncateToWidth } from "@earendil-works/pi-tui";
import type { RenderCtx } from "./types.js";
import { statusIcon } from "./types.js";

export interface EscalationDetails {
  runId: string;
  severity: "blocked" | "question" | "warning";
  summary: string;
  agent: string;
  name: string;
  payload?: unknown;
}

/** Map escalation severity to statusIcon type */
function severityToStatus(severity: "blocked" | "question" | "warning"): "fail" | "warn" {
  // blocked is the most severe, map to fail (red X)
  // question and warning map to warn (yellow !)
  return severity === "blocked" ? "fail" : "warn";
}

/** Render an escalation notification card. */
export function renderEscalation(details: EscalationDetails, ctx: RenderCtx): string[] {
  const { theme, width } = ctx;
  const icon = statusIcon(theme, severityToStatus(details.severity));
  
  const lines: string[] = [];
  
  // Header: icon + severity + run name
  const header = `${icon} ${theme.bold(details.severity)} • ${theme.fg("accent", details.name)} (${theme.fg("muted", details.agent)})`;
  lines.push(truncateToWidth(header, width, ""));
  
  // Empty line for spacing
  lines.push("");
  
  // Summary (potentially multi-line, each line truncated)
  const summaryLines = details.summary.split("\n");
  for (const line of summaryLines) {
    lines.push(truncateToWidth(theme.fg("text", line), width, ""));
  }
  
  // Empty line for spacing
  lines.push("");
  
  // Footer: run ID
  const footer = theme.fg("dim", `run ${details.runId.slice(0, 8)}`);
  lines.push(truncateToWidth(footer, width, ""));
  
  return lines;
}
