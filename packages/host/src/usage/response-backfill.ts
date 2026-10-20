import { open, stat } from "node:fs/promises";
import type { Discovery } from "./discovery.js";
import type { ResponseMetadata, ResponseMetadataCheckpoint, UsageLedger } from "./ledger.js";
import { UsageJsonLine } from "./jsonl-projection.js";
import { parseTranscript } from "./parse.js";

export const RESPONSE_METADATA_BYTES_PER_PASS: number = 32 * 1024 * 1024;
type Reader = { generation: number; inode: string; mtimeMs: number; size: number;
  offset: number; committed: number; line: UsageJsonLine };
// Only a bounded projection of an unfinished line survives a pass. A restart
// replays that line from the durable checkpoint, never the billing cursor.
const readers = new Map<string, Reader>();
export function forgetResponseMetadata(path: string): void { readers.delete(path); }

export async function backfillResponseMetadata(ledger: UsageLedger, discovery: Discovery, at: number,
  signal: AbortSignal, guard: () => boolean, maxBytes: number): Promise<{
    complete: boolean; sourcesCompleted: number; sourcesUnavailable: number; bytesRead: number;
  }> {
  let sourcesCompleted = 0, sourcesUnavailable = 0, bytesRead = 0;
  const result = () => ({ complete: sourcesCompleted + sourcesUnavailable === discovery.sources.length,
    sourcesCompleted, sourcesUnavailable, bytesRead });
  const sources = await Promise.all(discovery.sources.map(async source => {
    try { return { source, info: await stat(source.path) }; }
    catch { return { source, info: undefined }; }
  }));
  sources.sort((a, b) => (b.info?.mtimeMs ?? -Infinity) - (a.info?.mtimeMs ?? -Infinity)
    || (a.source.path < b.source.path ? -1 : a.source.path > b.source.path ? 1 : 0));
  for (const { source } of sources) {
    if (signal.aborted || !guard()) return { ...result(), complete: false };
    const stored = ledger.getResponseMetadataCheckpoint(source.path);
    const generation = ledger.getImportState(source.path)?.generation ?? stored?.generation ?? 0;
    let checkpoint: ResponseMetadataCheckpoint = stored ?? { path: source.path, generation, inode: "", mtimeMs: 0,
      offset: 0, size: 0, complete: false, errorCode: null };
    let updates: ResponseMetadata[] = [];
    try {
      const info = await stat(source.path);
      if (!info.isFile()) throw new Error("not a file");
      const inode = `${info.dev}:${info.ino}`;
      const replaced = checkpoint.generation !== generation || checkpoint.inode !== inode || info.size < checkpoint.size
        || info.size === checkpoint.size && info.mtimeMs !== checkpoint.mtimeMs;
      if (replaced) readers.delete(source.path);
      if (!replaced && checkpoint.complete && checkpoint.size === info.size && checkpoint.errorCode === null) {
        sourcesCompleted++; continue;
      }
      if (bytesRead >= maxBytes) continue;
      let reader = readers.get(source.path);
      if (!reader || replaced || reader.generation !== generation || reader.committed !== checkpoint.offset) {
        const offset = replaced ? 0 : checkpoint.offset;
        reader = { generation, inode, mtimeMs: info.mtimeMs, size: info.size, offset, committed: offset, line: new UsageJsonLine() };
        if (readers.size >= 16) readers.delete(readers.keys().next().value!);
        readers.set(source.path, reader);
      }
      const file = await open(source.path, "r");
      try {
        const buffer = Buffer.alloc(64 * 1024);
        while (reader.offset < info.size && bytesRead < maxBytes && !signal.aborted) {
          const length = Math.min(buffer.length, info.size - reader.offset, Math.floor(maxBytes - bytesRead));
          if (length <= 0) break;
          const read = await file.read(buffer, 0, length, reader.offset);
          if (!read.bytesRead) throw Object.assign(new Error("short read"), { code: "source-changed" });
          bytesRead += read.bytesRead;
          const data = buffer.subarray(0, read.bytesRead); let start = 0, end: number;
          while ((end = data.indexOf(10, start)) !== -1) {
            reader.line.write(data.subarray(start, end + 1));
            const json = reader.line.finish();
            if (json !== undefined) {
              const parsed = parseTranscript([{ byteOffset: reader.committed, json }], {
                ...source, run: null,
              });
              for (const call of parsed.calls) updates.push({ sourceFile: source.path, entryId: call.entryId, sourceGeneration: generation,
                latencyMs: call.latencyMs, thinkingLevel: call.thinkingLevel, providerThinkingLevel: call.providerThinkingLevel,
                toolCallId: call.toolCallId, toolDurationMs: call.toolDurationMs });
            }
            reader.committed = reader.offset + end + 1;
            reader.line = new UsageJsonLine(); start = end + 1;
          }
          reader.line.write(data.subarray(start)); reader.offset += read.bytesRead;
        }
        const after = await file.stat(), named = await stat(source.path);
        if (after.size < info.size || named.ino !== info.ino || named.dev !== info.dev
          || after.size === info.size && after.mtimeMs !== info.mtimeMs)
          throw Object.assign(new Error("source changed"), { code: "source-changed" });
      } finally { await file.close(); }
      checkpoint = { path: source.path, generation, inode, mtimeMs: info.mtimeMs,
        offset: reader.committed, size: info.size, complete: reader.committed === info.size, errorCode: null };
      reader.size = info.size; reader.mtimeMs = info.mtimeMs;
      if (checkpoint.complete) readers.delete(source.path);
      // An unterminated tail must be replayed after an append, not glued twice.
      else if (reader.offset === info.size) { reader.offset = reader.committed; reader.line = new UsageJsonLine(); }
    } catch (error) {
      readers.delete(source.path); updates = [];
      const code = (error as NodeJS.ErrnoException)?.code;
      checkpoint = { ...checkpoint, complete: false,
        errorCode: code === "ENOENT" ? "missing-source" : code === "source-changed" ? "source-changed" : "read-error" };
    }
    if (signal.aborted || !guard()) { readers.delete(source.path); return { ...result(), complete: false }; }
    if (!ledger.apply({ calls: [], runs: [], states: [], resetSources: [], sourceErrors: [], detailedRunIds: [], restoreAggregateRunIds: [], at,
      responseMetadata: updates, responseMetadataCheckpoints: [checkpoint], commitGuard: () => !signal.aborted && guard() })) {
      readers.delete(source.path); return { ...result(), complete: false };
    }
    if (checkpoint.errorCode) sourcesUnavailable++;
    else if (checkpoint.complete) sourcesCompleted++;
  }
  return result();
}
