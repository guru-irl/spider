import { truncateToWidth } from "@earendil-works/pi-tui";
import { statusIcon } from "./types.js";
import type { IndexDetails, RenderCtx } from "./types.js";

/** RESULT body (no header — the spider call line already shows `🕸 spider · <kind>`).
 *  Leading blank + 1-space indent + `⎿` gutter, consistent with renderRun. */
export function renderIndexResult(details: IndexDetails, ctx: RenderCtx): string[] {
  const { theme, width, expanded } = ctx;
  const out = ["", truncateToWidth(` ${statusIcon(theme, "ok")} ${theme.bold(details.source)}`, width, "")];
  const counts = [`${details.chunks} chunks`, `${details.embedded} embedded`];
  if (details.skipped) counts.push(`${details.skipped} skipped`);
  out.push(truncateToWidth(` ${theme.fg("dim", "⎿ ")}${theme.fg("muted", counts.join(" · "))}`, width, ""));
  const items = (details.urls && details.urls.length ? details.urls : details.targets) ?? [];
  const shown = expanded ? items : items.slice(0, 1);
  for (const t of shown) out.push(truncateToWidth(` ${theme.fg("dim", "⎿ ")}${theme.fg("toolOutput", t)}`, width, ""));
  const rest = items.length - shown.length;
  if (rest > 0) out.push(truncateToWidth(` ${theme.fg("muted", `⎿ … ${rest} more`)}`, width, ""));
  return out;
}
