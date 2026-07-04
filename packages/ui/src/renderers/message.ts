import { truncateToWidth } from "@earendil-works/pi-tui";
import { statusIcon } from "./types.js";
import type { MessageDetails, RenderCtx } from "./types.js";

const ARROW: Record<MessageDetails["verb"], string> = { send: "→", ask: "→?", reply: "↩", broadcast: "⇉" };

/** RESULT body (no header — the spider call line already shows `🕸 spider · message`).
 *  Leading blank + 1-space indent + `⎿` gutter, consistent with renderRun. */
export function renderMessageResult(details: MessageDetails, ctx: RenderCtx): string[] {
  const { theme, width } = ctx;
  const icon = statusIcon(theme, details.delivered ? "ok" : "fail");
  const target = details.to ?? details.from ?? "—";
  const status = details.delivered ? "delivered" : "not delivered";
  const head = ` ${icon} ${theme.fg("muted", `${ARROW[details.verb]} ${target}`)} ${theme.fg("dim", "·")} ${theme.fg("muted", status)}`;
  const out = ["", truncateToWidth(head, width, "")];
  const body = (details.body ?? "").replace(/\s+/g, " ").trim();
  if (body) out.push(truncateToWidth(` ${theme.fg("dim", "⎿ ")}${theme.fg("toolOutput", body)}`, width, ""));
  return out;
}
