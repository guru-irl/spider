// Test-only adapter for the frozen pre-redesign Overview oracle.
import type { Db } from "@spider/db-core";
import type { DashboardQueryContext, Page, SourceErrorRow } from "../../dashboard-contract.js";
import { decodeCursor, encodeCursor, invalidQuery, validatePage } from "../../dashboard-selection.js";
import { sourceErrorLabel, sourceErrorCode } from "../../source-error-diagnostics.js";
type ErrorRecord = { key: number; kind: number; path: string; project: string | null; code: string; count: number; lastCheckedAt: number };
function readErrors(db: Db, limit: number, after: readonly [number, number]): ErrorRecord[] {
  const sources = db.prepare(`SELECT rowid AS key, path, parse_errors AS parseErrors, source_error_code AS sourceError,
    last_ingest_at AS lastCheckedAt,
    (SELECT project FROM calls INDEXED BY calls_source_run WHERE source_file=import_state.path AND project IS NOT NULL LIMIT 1) AS project
    FROM import_state WHERE rowid >= ? AND (parse_errors > 0 OR source_error_code IS NOT NULL)
    ORDER BY rowid LIMIT ?`).all(after[0], limit + 2) as
    { key: number; path: string; project: string | null; parseErrors: number; sourceError: string | null; lastCheckedAt: number }[];
  const rows: ErrorRecord[] = [];
  for (const source of sources) {
    // Include the cursor's source so a page can continue from parse errors to its current source error.
    for (const kind of [0, 1]) {
      if (source.key === after[0] && kind <= after[1]) continue;
      if (kind === 0 ? source.parseErrors <= 0 : source.sourceError === null) continue;
      rows.push({ key: source.key, kind, path: source.path, project: source.project,
        code: kind === 0 ? "parse-errors" : source.sourceError!, count: kind === 0 ? source.parseErrors : 1,
        lastCheckedAt: source.lastCheckedAt });
    }
  }
  // Two lookahead sources cover a skipped cursor source plus one record beyond the public page.
  return rows.slice(0, limit + 1);
}
function publicRow(row: ErrorRecord): SourceErrorRow {
  return { sourceLabel: sourceErrorLabel(row.path, "Unknown source"), projectLabel: sourceErrorLabel(row.project, "Unknown project"),
    code: sourceErrorCode(row.code), count: row.count, lastCheckedAt: row.lastCheckedAt };
}
export function querySourceErrors(ctx: DashboardQueryContext, page: { limit: number; cursor?: string }): Page<SourceErrorRow> {
  validatePage(page);
  let after: readonly [number, number] = [0, -1];
  const query = { limit: page.limit };
  if (page.cursor) {
    const key = decodeCursor(page.cursor, "source-errors", `${ctx.instanceId}:source-errors`, query);
    if (key.length !== 2 || !Number.isSafeInteger(key[0]) || (key[0] as number) < 1 || (key[1] !== 0 && key[1] !== 1)) invalidQuery();
    after = key as [number, number];
  }
  const rows = readErrors(ctx.db, page.limit, after);
  const selected = rows.slice(0, page.limit);
  const last = selected.at(-1);
  return { rows: selected.map(publicRow), nextCursor: rows.length > page.limit && last
    ? encodeCursor("source-errors", `${ctx.instanceId}:source-errors`, query, [last.key, last.kind]) : null };
}
