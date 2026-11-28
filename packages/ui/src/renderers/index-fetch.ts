import { cardDetailIndent, fitResultLines, resultTrimmer, statusIcon } from "./types.js";
import type { IndexDetails, RenderCtx } from "./types.js";

/** RESULT body. The call line supplies the title; the status starts directly beneath it. */
export function renderIndexResult(details: IndexDetails, ctx: RenderCtx): string[] {
  const { theme, width } = ctx;
  const expanded = ctx.expanded === true;
  const trim = resultTrimmer(expanded);
  const out = [trim(` ${statusIcon(theme, "ok")} ${theme.bold(details.source)}`, width, "")];
  const counts = [`${details.chunks} chunks`, `${details.embedded} embedded`];
  if (details.skipped) counts.push(`${details.skipped} skipped`);
  out.push(trim(`${cardDetailIndent(theme.iconStyle)}${theme.fg("muted", counts.join(" · "))}`, width, ""));
  const items = (details.urls && details.urls.length ? details.urls : details.targets) ?? [];
  const shown = expanded ? items : items.slice(0, 1);
  for (const t of shown) out.push(trim(`${cardDetailIndent(theme.iconStyle)}${theme.fg("toolOutput", t)}`, width, ""));
  const rest = items.length - shown.length;
  if (rest > 0) out.push(trim(`${cardDetailIndent(theme.iconStyle)}${theme.fg("muted", `… ${rest} more`)}`, width, ""));
  return fitResultLines(out, width, expanded, 3);
}
