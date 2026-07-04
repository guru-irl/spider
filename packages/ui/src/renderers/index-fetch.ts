import { truncateToWidth } from "@earendil-works/pi-tui";
import { statusIcon } from "./types.js";
import type { IndexDetails, RenderCtx } from "./types.js";

export function renderIndexResult(details: IndexDetails, ctx: RenderCtx): string[] {
  const { theme, width, expanded } = ctx;
  const head = truncateToWidth(
    theme.fg("accent", "🕸 ") + theme.fg("toolTitle", theme.bold(`spider ${details.kind} `)) +
    statusIcon(theme, "ok") + " " + theme.fg("text", details.source),
    width, "",
  );
  const counts = [`${details.chunks} chunks`, `${details.embedded} embedded`];
  if (details.skipped) counts.push(`${details.skipped} skipped`);
  const out = [head, truncateToWidth(theme.fg("dim", "⎿ ") + theme.fg("muted", counts.join(" · ")), width, "")];
  const items = (details.urls && details.urls.length ? details.urls : details.targets) ?? [];
  const shown = expanded ? items : items.slice(0, 1);
  for (const t of shown) out.push(truncateToWidth(theme.fg("dim", "⎿ ") + theme.fg("toolOutput", t), width, ""));
  const rest = items.length - shown.length;
  if (rest > 0) out.push(truncateToWidth(theme.fg("muted", `⎿ … ${rest} more`), width, ""));
  return out;
}
