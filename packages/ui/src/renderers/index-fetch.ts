import { icon as uiIcon } from "../icons.js";
import { fitResultLines, resultTrimmer, statusIcon } from "./types.js";
import type { IndexDetails, RenderCtx } from "./types.js";

/** RESULT body (no header — the spider call line already shows `🕸 spider · <kind>`).
 *  The status starts directly under the title. */
export function renderIndexResult(details: IndexDetails, ctx: RenderCtx): string[] {
  const { theme, width } = ctx;
  const expanded = ctx.expanded === true;
  const trim = resultTrimmer(expanded);
  const out = [trim(` ${statusIcon(theme, "ok")} ${theme.bold(details.source)}`, width, "")];
  const counts = [`${details.chunks} chunks`, `${details.embedded} embedded`];
  if (details.skipped) counts.push(`${details.skipped} skipped`);
  out.push(trim(` ${theme.fg("dim", `${uiIcon(theme.iconStyle, "gutter")} `)}${theme.fg("muted", counts.join(" · "))}`, width, ""));
  const items = (details.urls && details.urls.length ? details.urls : details.targets) ?? [];
  const shown = expanded ? items : items.slice(0, 1);
  for (const t of shown) out.push(trim(` ${theme.fg("dim", `${uiIcon(theme.iconStyle, "gutter")} `)}${theme.fg("toolOutput", t)}`, width, ""));
  const rest = items.length - shown.length;
  if (rest > 0) out.push(trim(` ${theme.fg("muted", `${uiIcon(theme.iconStyle, "gutter")} … ${rest} more`)}`, width, ""));
  return fitResultLines(out, width, expanded, 3);
}
