import { truncateToWidth } from "@earendil-works/pi-tui";
import { sectionRule } from "./types.js";
import type { RenderCtx, TodoChecklistDetails } from "./types.js";

/** A todo checklist body (NO 🕸 header — the spider tool shell already shows `🕸 spider · todo`;
 *  see docs/output-ui-guidelines.md): a glyph-free `scope ───` rule, `✓/○ #id text` per item,
 *  then an `N/total completed` footer. Done items render `dim`, open items `text`. */
export function renderTodoChecklist(details: TodoChecklistDetails, ctx: RenderCtx): string[] {
  const { theme, width } = ctx;
  const out: string[] = [sectionRule(theme, details.scope, width)];
  if (!details.items.length) {
    out.push(truncateToWidth(theme.fg("dim", "(no todos)"), width, ""));
  }
  for (const t of details.items) {
    const glyph = t.done ? theme.fg("success", "✓") : theme.fg("muted", "○");
    const idTok = theme.fg("accent", `#${t.id}`);
    const text = t.done ? theme.fg("dim", t.text) : theme.fg("text", t.text);
    out.push(truncateToWidth(`${glyph} ${idTok} ${text}`, width, ""));
  }
  out.push(truncateToWidth(theme.fg("muted", `${details.done}/${details.total} completed`), width, ""));
  return out;
}
