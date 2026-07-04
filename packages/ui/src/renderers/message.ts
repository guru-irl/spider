import { truncateToWidth } from "@earendil-works/pi-tui";
import { statusIcon } from "./types.js";
import type { MessageDetails, RenderCtx } from "./types.js";

const ARROW: Record<MessageDetails["verb"], string> = { send: "→", ask: "→?", reply: "↩", broadcast: "⇉" };

export function renderMessageResult(details: MessageDetails, ctx: RenderCtx): string[] {
  const { theme, width } = ctx;
  const icon = statusIcon(theme, details.delivered ? "ok" : "fail");
  const target = details.to ?? details.from ?? "—";
  const head = truncateToWidth(
    theme.fg("accent", "🕸 ") + theme.fg("toolTitle", theme.bold(`spider ${details.verb} `)) +
    icon + " " + theme.fg("muted", `${ARROW[details.verb]} ${target}`),
    width, "",
  );
  const out = [head];
  const body = (details.body ?? "").trim();
  if (body) out.push(truncateToWidth(theme.fg("dim", "⎿ ") + theme.fg("toolOutput", body), width, ""));
  return out;
}
