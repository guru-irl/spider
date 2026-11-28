import { icon } from "../icons.js";
import { fitResultLines, sectionRule } from "./types.js";
import type { RenderCtx, TodoChecklistDetails, TodoItemView } from "./types.js";

/** Render the rows below the spider todo title. */
export function renderTodoChecklist(details: TodoChecklistDetails, { theme, width, expanded = false }: RenderCtx): string[] {
  const glyph = (done: boolean) => theme.fg(done ? "success" : "muted", icon(theme.iconStyle, done ? "todoDone" : "todoPending"));
  const itemRow = (item: TodoItemView) =>
    ` ${glyph(item.done)} ${theme.fg("accent", `#${item.id}`)} ${theme.fg(item.done ? "dim" : "text", item.text)}`;
  const fit = (lines: string[]) => fitResultLines(lines, width, expanded, 3);
  switch (details.kind) {
    case "item": return fit([itemRow(details.item)]);
    case "removed": {
      const { item, sessionName } = details;
      return fit([` Removed #${item.id} ${item.text}${sessionName ? ` from ${sessionName}` : ""}`]);
    }
    case "cleared":
      return fit([` Removed ${details.removed} todos${details.kept === undefined ? "" : `; kept ${details.kept} open todos`}`]);
    case "sessions":
      return fit(details.sessions.length ? details.sessions.map(session =>
        ` ${glyph(session.total > 0 && session.done >= session.total)} ${session.label}${session.current ? " (current)" : ""} · ${session.done}/${session.total} completed`,
      ) : [" (no sessions)"]);
    case "list": {
      const manyGroups = details.groups.length > 1;
      const rows: string[] = [];
      let done = 0;
      let total = 0;
      for (const [i, group] of details.groups.entries()) {
        if (manyGroups) {
          if (i > 0) rows.push("");
          rows.push(` ${sectionRule(theme, group.label ?? "Session", Math.max(1, width - 1))}`);
        }
        for (const item of group.items) {
          rows.push(itemRow(item));
          if (item.done) done++;
          total++;
        }
      }
      if (!total) rows.push(theme.fg("dim", " (no todos)"));
      const singleOther = details.groups.length === 1 && details.groups[0].current === false ? details.groups[0].label : undefined;
      rows.push(theme.fg("muted", ` ${done}/${total} completed${singleOther ? ` · ${singleOther}` : ""}`));
      return fit(rows);
    }
  }
}
