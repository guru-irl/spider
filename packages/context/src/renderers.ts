// packages/context/src/renderers.ts
// TUI Component renderers for the `search` and `import` spider actions. These mirror
// @spider/memory's renderers.ts: they take a handler's structured `details` and return
// an @spider/ui Component (Panel). The host renderResult dispatcher wraps them to add
// pi's required invalidate(). REAL ANSI is emitted by @spider/ui.
import { Panel, type Component } from "@spider/ui";
import type { SearchResultRow } from "./search.js";
import type { ImportSummary } from "./import.js";

const GLYPH = "🕸";

/** Panel of unified-search hits: one row per hit as `[kind] title — snippet`. */
export function renderSearchResult(rows: SearchResultRow[]): Component {
  const list = Array.isArray(rows) ? rows : [];
  const body = list.length
    ? list.map((r, i) => {
        const title = r.title ? `${r.title} — ` : "";
        return `${i + 1}. [${r.kind}] ${title}${r.snippet ?? ""}`.trim();
      })
    : ["(no results)"];
  return Panel({ title: `${GLYPH} search (${list.length})`, body });
}

/** Panel summarizing an import/migrate run's imported/skipped/staged/committed counts. */
export function renderImportResult(s: ImportSummary): Component {
  const sum = s ?? ({} as ImportSummary);
  const body = [
    `imported: ${sum.imported ?? 0}`,
    `skipped: ${sum.skipped ?? 0}`,
    `staged: ${sum.staged ?? 0}`,
    `committed: ${sum.committed ?? 0}`,
  ];
  const sessions = Array.isArray(sum.perSession) ? sum.perSession : [];
  for (const p of sessions) {
    body.push(`  · ${p.sessionId}: ${p.status} (${p.candidates} cand, ${p.chunks} chunks)`);
  }
  return Panel({ title: `${GLYPH} import`, body });
}
