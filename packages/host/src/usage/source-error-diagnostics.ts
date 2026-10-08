import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { Db } from "@spider/db-core";
import type { SourceErrorRow } from "./dashboard-contract.js";
import { validatePage } from "./dashboard-selection.js";

/** Labels are presentation only and must never be used as filesystem inputs. */
export function sourceErrorLabel(value: string | null, fallback: string): string {
  if (!value) return fallback;
  let decoded = value;
  try {
    for (let i = 0; i < 4; i++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch { return fallback; }
  if (/%[0-9a-f]{2}/i.test(decoded)) return fallback;
  const name = stripTerminalSequences(decoded).split(/[\\/]/).filter(Boolean).at(-1)?.split("#")[0]?.replace(/[\u0000-\u001f\u007f]/g, "");
  return name && name !== "." && name !== ".." ? [...name].slice(0, 160).join("") : fallback;
}
export function sourceErrorCode(value: string): string {
  if (value === "unknown-aux-purpose" || value.startsWith("unknown-aux-purpose:")) return "unknown-aux-purpose";
  return ["parse-errors", "missing-source", "missing-db", "not-file", "source-changed", "invalid-project", "invalid-run-id",
    "invalid-run-event", "legacy-run-events", "runs-db-recreated:facts-retained", "ENOENT", "EACCES", "EPERM", "EIO",
    "SQLITE_BUSY", "SQLITE_CORRUPT", "discovery-failed", "ingest-failed"].includes(value) ? value : "source-error";
}
/** Keep the legacy diagnostic order and lookahead without importing a retired route. */
export function readSourceErrorDiagnostics(db: Db, limit: number): { rows: readonly SourceErrorRow[]; truncated: boolean } {
  validatePage({ limit });
  const sources = db.prepare(`SELECT path,parse_errors AS parseErrors,source_error_code AS sourceError,last_ingest_at AS lastCheckedAt,
    (SELECT project FROM calls INDEXED BY calls_source_run WHERE source_file=import_state.path AND project IS NOT NULL LIMIT 1) AS project
    FROM import_state WHERE parse_errors>0 OR source_error_code IS NOT NULL ORDER BY rowid LIMIT ?`).all(limit + 2) as
    { path: string; project: string | null; parseErrors: number; sourceError: string | null; lastCheckedAt: number }[];
  const rows: SourceErrorRow[] = [];
  for (const source of sources) {
    const publicRow = (code: string, count: number): SourceErrorRow => ({ sourceLabel: sourceErrorLabel(source.path, "Unknown source"),
      projectLabel: sourceErrorLabel(source.project, "Unknown project"), code: sourceErrorCode(code), count, lastCheckedAt: source.lastCheckedAt });
    if (source.parseErrors > 0) rows.push(publicRow("parse-errors", source.parseErrors));
    if (source.sourceError !== null) rows.push(publicRow(source.sourceError, 1));
    if (rows.length > limit) break;
  }
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}
