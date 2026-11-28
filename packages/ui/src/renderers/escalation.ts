import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { icon } from "../icons.js";
import type { RenderCtx } from "./types.js";

export interface EscalationDetails {
  severity: "blocked" | "question" | "warning";
  summary: string;
}

/** The notification shell owns the title. Never collapse the escalation summary. */
export function renderEscalation({ severity, summary }: EscalationDetails, { theme, width }: RenderCtx): string[] {
  const marker = severity === "blocked" ? icon(theme.iconStyle, "failure")
    : icon(theme.iconStyle, severity === "question" ? "question" : "warning");
  const prefix = ` ${theme.fg(severity === "blocked" ? "error" : "warning", marker)} `;
  const hang = " ".repeat(visibleWidth(prefix));
  const [first, ...rest] = summary.split(/\r?\n/u);
  const status = theme.bold(severity) + (summary ? ` ·${first ? ` ${theme.fg("text", first)}` : ""}` : "");
  const [head, ...wrapped] = wrapTextWithAnsi(status, Math.max(1, width - visibleWidth(prefix)));
  const continuation = rest.flatMap(line => wrapTextWithAnsi(theme.fg("text", line), Math.max(1, width - hang.length)));
  return [prefix + head, ...[...wrapped, ...continuation].map(line => hang + line)]
    .map(line => truncateToWidth(line, width, ""));
}
