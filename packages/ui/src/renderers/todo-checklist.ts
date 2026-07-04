import { truncateToWidth } from "@earendil-works/pi-tui";
import { card } from "./types.js";
import type { RenderCtx, TodoChecklistDetails } from "./types.js";

/** A framed todo checklist: `✓/○ #id text` per item + `N/total completed` footer.
 *  Done items render in `dim`, open items in `text`; the card title carries the scope. */
export function renderTodoChecklist(details: TodoChecklistDetails, ctx: RenderCtx): string[] {
  const { theme, width } = ctx;
  const body = details.items.map((t) => {
    const glyph = t.done ? theme.fg("success", "✓") : theme.fg("muted", "○");
    const idTok = theme.fg("accent", `#${t.id}`);
    const text = t.done ? theme.fg("dim", t.text) : theme.fg("text", t.text);
    return truncateToWidth(`${glyph} ${idTok} ${text}`, width, "");
  });
  body.push(truncateToWidth(theme.fg("muted", `${details.done}/${details.total} completed`), width, ""));
  return card(theme, `todo · ${details.scope}`, body, width);
}
