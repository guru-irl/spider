import { statSync } from "node:fs";
import type { Discovery } from "./discovery.js";
import type { UsageLedger } from "./ledger.js";
import { forgetSessionMetadata, readSessionMetadata } from "./session-metadata.js";
export const METADATA_BACKFILL_BYTES_PER_PASS: number = 32 * 1024 * 1024;

export async function backfillSessionMetadata(ledger: UsageLedger, discovery: Discovery, at: number, signal: AbortSignal, guard: () => boolean, maxBytes: number): Promise<{ complete: boolean; sourcesRead: number; bytesRead: number }> {
  let complete = true, sourcesRead = 0, bytesRead = 0;
  const sessions = new Map(ledger.getSessions().map(session => [session.id, session]));
  const sources = discovery.sources.map(source => {
    let mtime = -Infinity;
    try { mtime = statSync(source.path).mtimeMs; } catch { /* the reader records missing sources */ }
    return { source, mtime };
  }).sort((a, b) => b.mtime - a.mtime || (a.source.path < b.source.path ? -1 : a.source.path > b.source.path ? 1 : 0));
  for (const { source } of sources) {
    if (signal.aborted || !guard()) return { complete: false, sourcesRead, bytesRead };
    if (bytesRead >= maxBytes) { complete = false; continue; }
    const stored = ledger.getMetadataCheckpoint(source.path);
    const generation = ledger.getImportState(source.path)?.generation ?? stored?.generation ?? 0;
    const stale = !!stored && generation !== stored.generation;
    if (stale) forgetSessionMetadata(source.path);
    const checkpoint = stale || !stored ? { path: source.path, generation, offset: 0, size: 0, complete: false } : stored;
    const header = ledger.getSourceContext(source.path, [])?.header ?? null;
    const id = typeof header?.id === "string" ? header.id : undefined;
    const session = id ? sessions.get(id) ?? null : null;
    const result = await readSessionMetadata(source, checkpoint, signal, maxBytes - bytesRead, { session, header, sessions });
    bytesRead += result.bytesRead; if (result.bytesRead > 0) sourcesRead++;
    if (signal.aborted || !guard()) { forgetSessionMetadata(source.path); return { complete: false, sourcesRead, bytesRead }; }
    const replaced = stale || result.checkpoint.generation !== checkpoint.generation;
    const oldId = ledger.getSourceContext(source.path, [])?.header?.id;
    const committed = ledger.apply({ calls: [], runs: [], states: [], resetSources: [], detailedRunIds: [], restoreAggregateRunIds: [], at,
      sessions: result.session ? [result.session] : [], metadataCheckpoints: result.errors.some(e => e.code !== "metadata-parse-error") ? [] : [result.checkpoint],
      resetSessionMetadata: replaced ? [{ path: source.path, sessionId: typeof oldId === "string" ? oldId : result.session?.id ?? null }] : [],
      sourceErrors: result.errors.filter(error => error.code !== "metadata-parse-error"), commitGuard: () => !signal.aborted && guard() });
    if (!committed) { forgetSessionMetadata(source.path); return { complete: false, sourcesRead, bytesRead }; }
    if (!result.caughtUp || result.errors.some(e => e.code !== "metadata-parse-error")) complete = false;
  }
  return { complete, sourcesRead, bytesRead };
}
