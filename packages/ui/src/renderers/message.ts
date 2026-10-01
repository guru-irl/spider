import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { fitResultLines, resultTrimmer, statusIcon } from "./types.js";
import type { MessageDetails, RenderCtx } from "./types.js";

const ARROW: Record<MessageDetails["verb"], string> = { send: "→", ask: "→?", reply: "↩", broadcast: "⇉" };

/** RESULT body (no header — the spider call line already shows `🕸 spider · message`).
 *  Leading blank + 1-space indent + `⎿` gutter, consistent with renderRun. */
export function renderMessageResult(details: MessageDetails, ctx: RenderCtx): string[] {
  const { theme, width } = ctx;
  const expanded = ctx.expanded === true;
  const trim = resultTrimmer(expanded);
  const pending = details.delivery === "child-accepted" || details.delivery === "accepted but not confirmed" || details.delivery === "no reply yet, delivery unknown" || details.delivery === "queued" || (details.delivery === "broker-accepted" && details.recipientAcknowledged !== true);
  const icon = statusIcon(theme, pending ? "warn" : details.delivered ? "ok" : "fail");
  const target = details.to ?? details.from ?? "—";
  const status = details.delivery === "delivered" ? `delivered${details.transformed ? ", transformed" : ""}`
    : details.delivery === "child-accepted" ? "accepted but not confirmed"
    : details.delivery === "accepted but not confirmed" || details.delivery === "no reply yet, delivery unknown" || details.delivery === "refused" ? details.delivery
    : details.delivery === "broker-accepted"
    ? `broker accepted · acknowledgement ${details.recipientAcknowledged ? "confirmed" : "unconfirmed"}`
    : details.delivery === "queued" ? "queued · not delivered"
    : details.delivery === "unavailable" ? "recipient unavailable"
    : details.delivered ? "delivered" : "not delivered";
  const head = ` ${icon} ${theme.fg("muted", `${ARROW[details.verb]} ${target}`)} ${theme.fg("dim", "·")} ${theme.fg("muted", status)}`;
  const out = ["", trim(head, width, "")];
  const body = expanded ? details.body ?? "" : (details.body ?? "").replace(/\s+/g, " ").trim();
  if (body) out.push(trim(` ${theme.fg("dim", "⎿ ")}${theme.fg("toolOutput", body)}`, width, ""));
  if (details.error) {
    if (details.delivery === "unavailable" || details.delivery === "refused") {
      const lines = details.error.split("\n");
      const shown = expanded ? lines : lines.slice(0, 1);
      const rows = fitResultLines(shown.map((line, i) =>
        ` ${theme.fg("dim", "│ ")}${theme.fg(i === 0 ? "error" : "toolOutput", line)}`), width, true);
      out.push(...(expanded ? rows : rows.slice(0, 4)));
    }
    else {
      const lines = expanded ? details.error.split("\n") : wrapTextWithAnsi(details.error.replace(/\s+/g, " ").trim(), Math.max(1, width - 3)).slice(0, 4);
      for (const line of lines) out.push(trim(` ${theme.fg("dim", "│ ")}${theme.fg("toolOutput", line)}`, width, ""));
    }
  }
  return fitResultLines(out, width, expanded);
}
