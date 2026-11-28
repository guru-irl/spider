import { cardDetailIndent, fitResultLines, statusIcon, type RenderCtx } from "./types.js";

export interface BindDetails {
  ok: boolean;
  message?: string;
  path?: string;
}

/** Render the bind or unbind result below the tool title. */
export function renderBindResult(details: BindDetails, { theme, width, expanded = false }: RenderCtx): string[] {
  const status = details.ok ? details.path ? "Session bound" : "Session unbound" : "Failed";
  const rows = [` ${statusIcon(theme, details.ok ? "ok" : "fail")} ${theme.fg(details.ok ? "success" : "error", status)}`];
  const indent = cardDetailIndent(theme.iconStyle);
  if (details.path) rows.push(indent + theme.fg("muted", `path: ${details.path}`));
  for (const line of details.message?.split("\n") ?? []) {
    if (line.trim()) rows.push(indent + theme.fg("muted", line.trim()));
  }
  return fitResultLines(rows, width, expanded, 3);
}
