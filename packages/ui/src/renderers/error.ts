import { fitResultLines, statusIcon, type RenderCtx } from "./types.js";

/** Body-only error receipt shared by action renderers. Collapsed shows the headline. */
export function renderErrorResult(message: string, ctx: RenderCtx): string[] {
  const { theme, width } = ctx;
  const expanded = ctx.expanded === true;
  const lines = (message.trim() || "Call failed (no error message)").split("\n");
  const shown = expanded ? lines : lines.slice(0, 1);
  const rows = fitResultLines(shown.map((line, i) => i === 0
    ? ` ${statusIcon(theme, "fail")} ${theme.fg("error", line)}`
    : `   ${theme.fg("toolOutput", line)}`), width, true);
  return ["", ...(expanded ? rows : rows.slice(0, 4))];
}
