// packages/context/src/renderers.ts
// TUI Component renderers for the `search` and `import` spider actions. These mirror
// @spider/memory's renderers.ts: they take a handler's structured `details` and return
// an @spider/ui Component (Panel). The host renderResult dispatcher wraps them to add
// pi's required invalidate(). REAL ANSI is emitted by @spider/ui.
import { Panel, cardDetailIndent, fitResultLines, icon, type Component, type IconStyle } from "@spider/ui";
import type { SearchResultRow } from "./search";
import type { ImportSummary } from "./import";

/** Panel of unified-search hits: one row per hit as `[kind] title — snippet`. */
export function renderSearchResult(rows: SearchResultRow[], iconStyle?: IconStyle): Component {
  const list = Array.isArray(rows) ? rows : [];
  const body = list.length
    ? list.map((r, i) => {
        const title = r.title ? `${r.title} — ` : "";
        return `${i + 1}. [${r.kind}] ${title}${r.snippet ?? ""}`.trim();
      })
    : ["(no results)"];
  return Panel({ title: `${icon(iconStyle, "spider")} search (${list.length})`, body, iconStyle });
}

/** Render the import counts and session outcomes under the tool title. */
export function renderImportResult(s: ImportSummary, expanded = false, iconStyle?: IconStyle): Component {
  const summary = s ?? ({} as ImportSummary);
  const rows = [
    ` imported: ${summary.imported ?? 0}`,
    ` skipped: ${summary.skipped ?? 0}`,
    ` staged: ${summary.staged ?? 0}`,
    ` committed: ${summary.committed ?? 0}`,
  ];
  for (const [i, session] of (summary.perSession ?? []).entries()) {
    const name = "name" in session && typeof session.name === "string" && session.name ? session.name : `Session ${i + 1}`;
    rows.push(`${cardDetailIndent(iconStyle)}${name}: ${session.status} (${session.candidates} candidates, ${session.chunks} chunks)`);
  }
  return { render: width => fitResultLines(rows, width, expanded, 3) };
}
