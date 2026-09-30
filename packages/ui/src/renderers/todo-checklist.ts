import { fitResultLines, resultTrimmer, sectionRule } from "./types.js";
import type { RenderCtx, TodoChecklistDetails } from "./types.js";

/** A todo checklist body (NO 🕸 header — the spider tool shell already shows `🕸 spider · todo`;
 *  see docs/output-ui-guidelines.md): a glyph-free `scope ───` rule, `✓/○ #id text` per item,
 *  then an `N/total completed` footer. Done items render `dim`, open items `text`. */
export function renderTodoChecklist(details: TodoChecklistDetails, ctx: RenderCtx): string[] {
  const { theme, width } = ctx;
  const expanded = ctx.expanded === true;
  const trim = resultTrimmer(expanded);
  const out: string[] = [sectionRule(theme, details.scope, width)];
  if (!details.items.length) {
    out.push(trim(theme.fg("dim", "(no todos)"), width, ""));
  }
  for (const t of details.items) {
    const glyph = t.done ? theme.fg("success", "✓") : theme.fg("muted", "○");
    const idTok = theme.fg("accent", `#${t.id}`);
    const text = t.done ? theme.fg("dim", t.text) : theme.fg("text", t.text);
    out.push(trim(`${glyph} ${idTok} ${text}`, width, ""));
  }
  out.push(trim(theme.fg("muted", `${details.done}/${details.total} completed`), width, ""));
  return fitResultLines(out, width, expanded);
}
