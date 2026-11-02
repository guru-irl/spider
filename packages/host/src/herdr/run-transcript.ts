// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { bus, getBinding, openGlobalReadOnly, type Db } from '@spider/db-core';
import { RunStore, type RunRow } from '../../../subagents/src/run-store.js';
import { getChild } from '../../../subagents/src/coordinators.js';
import { openSessionRunDb, resolveSessionRunProject } from '../session-run-db.js';
import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, fstatSync, realpathSync, readdirSync, constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { Owner, RunId, Disposable, RunSummary } from '../../../herdr/src/contracts.js';
import type { RunCursor, RunViewFrame, RunViewEvent } from '../../../herdr/src/contracts.js';
export interface RunTranscriptSourceOptions {
  owner(): Owner | null;
  /** Returns a fresh, caller-owned handle. The source closes it on cancellation or rejection. */
  resolveDb?(owner: Owner): { db: Db; dbPath: string };
  /** Optional fresh read-only binding handle; also owned and closed by this source. */
  openBindingDb?(): Db | undefined;
  transcriptRoots(owner: Owner): readonly string[]; pageBytes?: number; pollMs?: number;
  /** Raw records are capped at 100 MiB; an oversized tail is reported as a gap. */
  recordBytes?: number;
}
export interface RunTranscriptSource extends Disposable { subscribe(runId: RunId, cursor: RunCursor | null, emit: (frame: RunViewFrame) => void): () => void }
interface Position { version: 1; session: string; generation: string; run: string; binding: string; event: number; offset: number; textOffset: number; suppressProse?: boolean; pendingMessage?: { id: number; offset: number }; file: string | null; anchor: { offset: number; length: number; digest: string } | null }
function error(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const bytes = (text: string | Buffer, max: number): string => {
  const buffer = typeof text === 'string' ? Buffer.from(text) : text; let end = Math.min(buffer.length, max);
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
};
function runSummary(row: RunRow, owner: Owner): RunSummary {
  return { id: row.id as RunId, ownerSessionId: owner.sessionId, name: row.name, status: row.status, childMode: row.child_mode ?? 'print',
    canSteer: row.status === 'running' && row.child_mode === 'rpc' && Boolean(getChild(owner.sessionId, row.id)?.steer),
    startedAt: row.started_at, finishedAt: row.ended_at, viewer: null, result: row.result ? bytes(row.result, 8192) : null };
}
/** Only complete pi conversation records from the selected run's exact directory produce text. */
interface ProjectedRecord { text: string; messageKey: string | null; proseRanges?: readonly [number, number][] }
function recordText(raw: string): ProjectedRecord {
  const record: unknown = JSON.parse(raw);
  if (!record || typeof record !== 'object' || !('type' in record) || record.type !== 'message' || !('message' in record)) return { text: '', messageKey: null };
  const message = record.message;
  if (!message || typeof message !== 'object' || !('content' in message)) return { text: '', messageKey: null };
  const prose = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.flatMap((part: unknown) =>
    part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string' ? [part.text] : []).join('') : '';
  const messageKey = 'role' in message && message.role === 'assistant' ? hash(prose.trim()) : null;
  if (typeof message.content === 'string') return { text: message.content, messageKey, proseRanges: [[0, Buffer.byteLength(message.content)]] };
  if (!Array.isArray(message.content)) return { text: '', messageKey };
  let text = ''; let offset = 0; const proseRanges: [number, number][] = [];
  for (const part of message.content as unknown[]) {
    if (!part || typeof part !== 'object') continue;
    if ('type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string') {
      const end = offset + Buffer.byteLength(part.text); proseRanges.push([offset, end]); text += part.text; offset = end;
    } else if ('type' in part && part.type === 'toolCall' && 'name' in part && typeof part.name === 'string') {
      const marker = `\n[tool] ${part.name}\n`; text += marker; offset += Buffer.byteLength(marker);
    }
  }
  return { text, messageKey, proseRanges };
}
/** The reporter persists the full trimmed prose separately from the displayed summary. */
function completionText(record: { payload: string | null; summary: string | null }): string {
  let text = record.summary ?? '';
  try {
    const payload: unknown = JSON.parse(record.payload ?? 'null');
    if (payload && typeof payload === 'object' && 'text' in payload && typeof payload.text === 'string') text = payload.text;
  } catch { /* Legacy events may carry no structured payload. */ }
  return text;
}
function completionKey(record: { payload: string | null; summary: string | null }): string { return hash(completionText(record).trim()); }
function occurrence(counts: Map<string, number>, key: string): string {
  const count = (counts.get(key) ?? 0) + 1; counts.set(key, count); return `${key}:${count}`;
}
interface TranscriptFile { fd: number; identity: string; size: number; stamp: string }
type RecordCache = { offset: number; file: string; length: number; digest: string; messageKey?: string | null; messageOccurrence?: string; proseRanges?: readonly [number, number][] } & (
  | { content: Buffer; problem: null }
  | { content: null; problem: 'invalid-transcript-record' | 'transcript-record-too-large' }
);
function rangeHash(fd: number, offset: number, length: number): string | null {
  const digest = createHash('sha256'); const chunk = Buffer.alloc(65536); let read = 0;
  while (read < length) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, length - read), offset + read);
    if (!count) return null; digest.update(chunk.subarray(0, count)); read += count;
  }
  return digest.digest('hex');
}
function completeRecord(file: TranscriptFile, offset: number, maxBytes: number): RecordCache | null {
  const chunks: Buffer[] = []; let length = 0; const digest = createHash('sha256');
  while (offset + length < file.size) {
    if (length >= maxBytes) return { offset, file: file.identity, length: file.size - offset, digest: '', content: null, problem: 'transcript-record-too-large' };
    const chunk = Buffer.alloc(Math.min(65536, file.size - offset - length, maxBytes - length));
    const count = readSync(file.fd, chunk, 0, chunk.length, offset + length); if (!count) return null;
    const newline = chunk.subarray(0, count).indexOf(10); const used = newline < 0 ? count : newline + 1;
    const bytes = chunk.subarray(0, used); chunks.push(bytes); digest.update(bytes); length += used;
    if (newline < 0) continue;
    const raw = Buffer.concat(chunks, length); let content: Buffer | null = null; let projected: ProjectedRecord | undefined;
    try {
      projected = recordText(new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, -1)));
      content = Buffer.from(projected.text);
    } catch { /* Invalid complete records become visible gaps. */ }
    const base = { offset, file: file.identity, length, digest: digest.digest('hex'), messageKey: projected?.messageKey, proseRanges: projected?.proseRanges };
    return content === null ? { ...base, content, problem: 'invalid-transcript-record' } : { ...base, content, problem: null };
  }
  return null; // The writer has not committed this record's LF yet.
}
function transcriptFile(roots: readonly string[], runId: RunId): TranscriptFile | null {
  let found: TranscriptFile | null = null;
  try {
    for (const root of roots) {
      const canonicalRoot = realpathSync(root);
      const directory = join(resolve(root), 'subagent-sessions', runId);
      let names: string[];
      try {
        if (!realpathSync(directory).startsWith(canonicalRoot + sep) || realpathSync(directory) !== directory) throw error('unsafe-transcript-path');
        names = readdirSync(directory).filter(name => name.endsWith('.jsonl'));
      } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue; throw cause; }
      if (names.length > 1) throw error('ambiguous-child-transcript');
      if (!names.length) continue;
      const path = join(directory, names[0]);
      if (realpathSync(path) !== path) throw error('unsafe-transcript-path');
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) { closeSync(fd); throw error('unsafe-transcript-path'); }
      if (found) { closeSync(fd); throw error('ambiguous-child-transcript'); }
      found = { fd, identity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`, size: stat.size, stamp: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` };
    }
    return found;
  } catch (cause) { if (found) closeSync(found.fd); throw cause; }
}
function recordedTranscriptRoots(db: Db, sessionId: string, runId: RunId): readonly string[] | null {
  const row = db.prepare("SELECT payload FROM run_events WHERE run_id=? AND session_id=? AND type='child_transcript' ORDER BY id DESC LIMIT 1").get(runId, sessionId) as { payload: string | null } | undefined;
  if (!row) return null;
  let location: unknown;
  try { location = JSON.parse(row.payload ?? 'null'); } catch { throw error('unsafe-transcript-path'); }
  if (!location || typeof location !== 'object' || !('version' in location) || location.version !== 1
    || !('directory' in location) || typeof location.directory !== 'string' || location.directory.includes('\0')
    || !isAbsolute(location.directory) || resolve(location.directory) !== location.directory
    || basename(location.directory) !== runId || basename(dirname(location.directory)) !== 'subagent-sessions') throw error('unsafe-transcript-path');
  return [dirname(dirname(location.directory))];
}
export function createRunTranscriptSource(options: RunTranscriptSourceOptions): RunTranscriptSource {
  const subscriptions = new Set<() => void>(); let disposed = false;
  const recordLimit = Math.max(65536, Math.min(options.recordBytes ?? 100 * 1024 * 1024, 100 * 1024 * 1024));
  const encode = (position: Position): RunCursor => {
    const data = Buffer.from(JSON.stringify(position)).toString('base64url');
    return `${data}.${hash(data)}` as RunCursor;
  };
  function decode(cursor: RunCursor): Position | null {
    try {
      if (typeof cursor !== 'string' || Buffer.byteLength(cursor, 'utf8') > 1024) return null;
      const [data, signature, extra] = cursor.split('.'); if (!data || !signature || extra) return null;
      if (signature !== hash(data)) return null;
      const p = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as Position;
      if (p.version !== 1 || !['session', 'generation', 'run', 'binding'].every(key => typeof p[key as keyof Position] === 'string')
        || p.pendingMessage !== undefined && (!p.pendingMessage || !Number.isSafeInteger(p.pendingMessage.id) || p.pendingMessage.id < 0
          || !Number.isSafeInteger(p.pendingMessage.offset) || p.pendingMessage.offset < 0)
        || p.suppressProse !== undefined && typeof p.suppressProse !== 'boolean'
        || p.file !== null && typeof p.file !== 'string'
        || !['event', 'offset', 'textOffset'].every(key => Number.isSafeInteger(p[key as keyof Position]) && Number(p[key as keyof Position]) >= 0)
        || p.anchor !== null && (!p.anchor || !Number.isSafeInteger(p.anchor.offset) || p.anchor.offset < 0 || !Number.isSafeInteger(p.anchor.length) || p.anchor.length < 0 || typeof p.anchor.digest !== 'string')) return null;
      return p;
    } catch { return null; }
  }
  return {
    subscribe(runId, cursor, emit) {
      if (disposed) throw error('transcript-source-closed');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) throw error('run-not-owned');
      const liveOwner = options.owner(); if (!liveOwner) throw error('owner-unavailable');
      const owner = { ...liveOwner }; // Freeze the activation identity, not its mutable caller object.
      const opened = options.resolveDb?.(owner) ?? openSessionRunDb(owner.cwd, owner.sessionId);
      const { db, dbPath } = opened;
      let roots: readonly string[]; let bindingDb: Db | undefined; let boundRoot: string | undefined;
      const store = new RunStore(db);
      try {
        if (db.raw.inTransaction) throw error('uncommitted-run-db');
        const row = store.get(runId);
        if (!row || row.session_id !== owner.sessionId) throw error('run-not-owned');
        roots = options.transcriptRoots(owner);
        // The default resolver uses session bindings. Read their raw value, not git,
        // on pumps. Custom resolvers are reconciled at most once per 30 seconds.
        bindingDb = options.openBindingDb ? options.openBindingDb() : !options.resolveDb ? openGlobalReadOnly() : undefined;
        boundRoot = bindingDb && getBinding(bindingDb, owner.sessionId);
      } catch (cause) { bindingDb?.close(); db.close(); throw cause; }
      let recordedRoots: readonly string[] | null = null;
      let checkedAt = Date.now();
      const binding = hash(resolve(dbPath));
      const initial = (): Position => ({ version: 1, session: owner.sessionId, generation: owner.generation, run: runId, binding,
        event: 0, offset: 0, textOffset: 0, file: null, anchor: null });
      let position = cursor ? decode(cursor) : initial();
      let invalid = !position || position.session !== owner.sessionId || position.run !== runId || position.binding !== binding;
      if (invalid) position = initial();
      else position!.generation = owner.generation; // Authentication belongs to the endpoint; a same-session reload can resume its own cursor.
      const transcriptCounts = new Map<string, number>(); const messageCounts = new Map<string, number>();
      const streamedMessages = new Set<string>(); const fallbackMessages = new Set<string>(); const completedMessages = new Set<string>();
      let indexedOffset = 0; let historyIndexed = false;
      let resumeShown = Boolean(cursor && !invalid);
      let active = true; let pumping = false; let timer: ReturnType<typeof setInterval> | undefined; let unsubscribe: (() => void) | undefined;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      let lastState = ''; let first = true; let recordCache: RecordCache | null = null; let validatedStamp: string | null = null; let lastProblem: string | null = null;
      const cancel = () => { if (!active) return; active = false; recordCache = null; clearInterval(timer); clearTimeout(drainTimer); unsubscribe?.(); subscriptions.delete(cancel); bindingDb?.close(); db.close(); };
      const send = (frame: RunViewFrame) => { if (active) emit(frame); };
      const problem = (reason: string) => { if (reason !== lastProblem) { lastProblem = reason; send({ runId, cursor: encode(position!), kind: 'gap', data: { reason } }); } };
      function pump(): void {
        if (!active || pumping) return; pumping = true; clearTimeout(drainTimer); let drainMore = false;
        let file: ReturnType<typeof transcriptFile> = null;
        try {
          const current = options.owner();
          let changedBinding = false;
          if (bindingDb) changedBinding = getBinding(bindingDb, owner.sessionId) !== boundRoot;
          else if (Date.now() - checkedAt >= 30000) {
            checkedAt = Date.now();
            if (options.resolveDb) {
              const refreshed = options.resolveDb(owner);
              try { changedBinding = hash(resolve(refreshed.dbPath)) !== binding; }
              finally { if (refreshed.db !== db) refreshed.db.close(); }
            } else changedBinding = hash(resolve(resolveSessionRunProject(owner.cwd, owner.sessionId).dbPath)) !== binding;
          }
          if (!current || current.sessionId !== owner.sessionId || current.generation !== owner.generation || changedBinding) {
            send({ runId, cursor: encode(position!), kind: 'end', data: { reason: 'wrong-generation' } }); cancel(); return;
          }
          if (db.raw.inTransaction) return;
          const row = store.get(runId);
          if (!row || row.session_id !== owner.sessionId) { send({ runId, cursor: encode(position!), kind: 'end', data: { reason: 'run-not-owned' } }); cancel(); return; }
          recordedRoots ??= recordedTranscriptRoots(db, owner.sessionId, runId);
          file = transcriptFile(recordedRoots ?? roots, runId);
          const p = position!;
          if (p.file && (!file || file.identity !== p.file || file.size < p.offset)) invalid = true;
          if (file && p.anchor && validatedStamp !== file.stamp) {
            if (!Number.isSafeInteger(p.anchor.offset + p.anchor.length) || p.anchor.offset + p.anchor.length > file.size
              || rangeHash(file.fd, p.anchor.offset, p.anchor.length) !== p.anchor.digest) invalid = true;
          }
          validatedStamp = file?.stamp ?? null;
          if (!file && row.status === 'running' && !invalid) problem('transcript-missing');
          else if (file) lastProblem = null;
          if (invalid) {
            // A gap never silently replays the transcript from byte zero.
            recordCache = null; transcriptCounts.clear(); messageCounts.clear(); streamedMessages.clear(); fallbackMessages.clear(); completedMessages.clear();
            indexedOffset = 0; historyIndexed = false; resumeShown = false;
            p.offset = file?.size ?? 0; p.textOffset = 0; delete p.suppressProse; delete p.pendingMessage; p.file = file?.identity ?? null; p.anchor = null;
            p.event = (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM run_events WHERE run_id=? AND session_id=?').get(runId, owner.sessionId) as { id: number }).id;
            send({ runId, cursor: encode(p), kind: 'gap', data: { reason: 'cursor-invalidated' } }); invalid = false;
          }
          if (!historyIndexed) {
            const previous = db.prepare("SELECT summary,payload FROM run_events WHERE run_id=? AND session_id=? AND type='message' AND id<=? ORDER BY id").all(runId, owner.sessionId, p.event) as { summary: string | null; payload: string | null }[];
            for (const event of previous) completedMessages.add(occurrence(messageCounts, completionKey(event)));
            if (p.pendingMessage) {
              const pending = db.prepare("SELECT summary,payload FROM run_events WHERE run_id=? AND session_id=? AND type='message' AND id=?").get(runId, owner.sessionId, p.pendingMessage.id) as { summary: string | null; payload: string | null } | undefined;
              if (pending) { const key = completionKey(pending); completedMessages.add(`${key}:${(messageCounts.get(key) ?? 0) + 1}`); }
            }
            // A resumed byte cursor proves the prefix was supplied. Index it once
            // so identical prose in later messages remains a separate occurrence.
            while (file && indexedOffset < p.offset) {
              const record = completeRecord(file, indexedOffset, recordLimit); if (!record) break;
              if (record.messageKey) {
                const identity = occurrence(transcriptCounts, record.messageKey);
                if (resumeShown && record.content?.length) streamedMessages.add(identity);
              }
              indexedOffset += record.length;
            }
            historyIndexed = true;
          }
          const summary = runSummary(row, owner); const state = JSON.stringify(summary);
          if (first || state !== lastState) { send({ runId, cursor: encode(p), kind: 'snapshot', data: { run: summary } }); lastState = state; first = false; }
          const max = Math.max(4, Math.min(options.pageBytes ?? 65536, 65536));
          let text = ''; let readBudget = 1024 * 1024; const beforeText = `${p.offset}:${p.textOffset}`;
          if (file) {
            p.file = file.identity;
            while (readBudget > 0 && Buffer.byteLength(text) < max && p.offset < file.size) {
              if (!recordCache || recordCache.offset !== p.offset || recordCache.file !== file.identity) {
                recordCache = completeRecord(file, p.offset, recordLimit); readBudget -= recordCache?.length ?? 0;
                if (recordCache) {
                  if (recordCache.messageKey) {
                    recordCache.messageOccurrence = occurrence(transcriptCounts, recordCache.messageKey);
                    if (resumeShown && p.textOffset > 0 && !p.suppressProse) streamedMessages.add(recordCache.messageOccurrence);
                    p.suppressProse = completedMessages.has(recordCache.messageOccurrence) && !streamedMessages.has(recordCache.messageOccurrence);
                  }
                  indexedOffset = p.offset + recordCache.length;
                }
              }
              if (!recordCache) {
                // A live writer can still complete this JSON/UTF-8 record. A terminal
                // writer cannot, so expose the gap and advance only that partial tail.
                if (['done', 'failed', 'cancelled'].includes(row.status)) {
                  p.offset = file.size; p.textOffset = 0; delete p.suppressProse; p.anchor = null;
                  send({ runId, cursor: encode(p), kind: 'gap', data: { reason: 'invalid-transcript-record' } });
                }
                break;
              }
              const record = recordCache;
              p.anchor = record.digest ? { offset: p.offset, length: record.length, digest: record.digest } : null;
              if (!record.content) {
                p.offset += record.length; p.textOffset = 0; delete p.suppressProse; recordCache = null;
                send({ runId, cursor: encode(p), kind: 'gap', data: { reason: record.problem } }); continue;
              }
              const remaining = record.content.subarray(p.textOffset);
              let part = bytes(remaining, max - Buffer.byteLength(text));
              while (part && Buffer.byteLength(JSON.stringify({ text: text + part, events: [] })) > 65536) part = bytes(part, Math.floor(Buffer.byteLength(part) * 0.8));
              if (!part && remaining.length) break;
              if (part && record.messageOccurrence && !p.suppressProse) streamedMessages.add(record.messageOccurrence);
              if (p.suppressProse) {
                const end = p.textOffset + Buffer.byteLength(part); let at = p.textOffset;
                for (const [start, stop] of record.proseRanges ?? []) {
                  if (stop <= at || start >= end) continue;
                  if (start > at) text += record.content.subarray(at, start).toString('utf8');
                  at = Math.min(end, stop);
                }
                text += record.content.subarray(at, end).toString('utf8');
              } else text += part;
              p.textOffset += Buffer.byteLength(part);
              if (p.textOffset >= record.content.length) { p.offset += record.length; p.textOffset = 0; delete p.suppressProse; recordCache = null; }
              else break;
            }
          }
          const textAdvanced = beforeText !== `${p.offset}:${p.textOffset}`;
          if (text || textAdvanced) send({ runId, cursor: encode(p), kind: 'event', data: { text, events: [] } });
          const events: RunViewEvent[] = [];
          const records = db.prepare('SELECT id,type,tool,summary,payload FROM run_events WHERE run_id=? AND session_id=? AND id>? ORDER BY id LIMIT 128').all(runId, owner.sessionId, p.event) as { id: number; type: string; tool: string | null; summary: string | null; payload: string | null }[];
          let eventBytes = 0; let fallbackAdvanced = false;
          for (const record of records) {
            const key = record.type === 'message' ? completionKey(record) : null;
            const identity = key === null ? null : `${key}:${(messageCounts.get(key) ?? 0) + 1}`;
            if (identity && (!streamedMessages.has(identity) && !fallbackMessages.has(identity) || p.pendingMessage?.id === record.id)) {
              const full = Buffer.from(completionText(record));
              // Small unstreamed messages retain the ordinary summary rendering.
              // Larger ones use bounded text pages instead of losing their tail.
              if (full.length > 4096) {
                if (!p.pendingMessage && file && p.offset < file.size && textAdvanced) break;
                p.pendingMessage ??= { id: record.id, offset: 0 }; completedMessages.add(identity);
                if (events.length) {
                  send({ runId, cursor: encode(p), kind: 'event', data: { text: '', events: events.splice(0) } }); eventBytes = 0;
                }
                let part = bytes(full.subarray(p.pendingMessage.offset), max);
                while (part && Buffer.byteLength(JSON.stringify({ text: part, events: [] })) > 65536) part = bytes(part, Math.floor(Buffer.byteLength(part) * 0.8));
                if (part) {
                  p.pendingMessage.offset += Buffer.byteLength(part); fallbackAdvanced = true;
                  send({ runId, cursor: encode(p), kind: 'event', data: { text: part, events: [] } });
                }
                if (p.pendingMessage.offset < full.length) break;
                fallbackMessages.add(identity);
              }
            }
            const event: RunViewEvent = { runId, id: record.id, type: record.type, ...(record.summary ? { summary: bytes(record.summary, 4096) } : {}), ...(record.tool ? { tool: bytes(record.tool, 256) } : {}),
              ...(identity ? { messageId: `${runId}:${record.id}`, streamed: streamedMessages.has(identity) || fallbackMessages.has(identity) } : {}) };
            const size = Buffer.byteLength(JSON.stringify(event)); if (eventBytes + size > 48 * 1024) break;
            if (key !== null) completedMessages.add(occurrence(messageCounts, key));
            if (p.pendingMessage?.id === record.id) delete p.pendingMessage;
            eventBytes += size; events.push(event); p.event = record.id;
          }
          if (events.length) send({ runId, cursor: encode(p), kind: 'event', data: { text: '', events } });
          const unreadText = file && p.offset < file.size;
          const unreadEvents = Boolean(db.prepare('SELECT id FROM run_events WHERE run_id=? AND session_id=? AND id>? LIMIT 1').get(runId, owner.sessionId, p.event));
          drainMore = Boolean((textAdvanced || fallbackAdvanced || events.length) && (unreadText || unreadEvents));
          if (['done', 'failed', 'cancelled'].includes(row.status) && !unreadText && !unreadEvents) {
            send({ runId, cursor: encode(p), kind: 'end', data: { reason: 'finished' } }); cancel();
          }
        } catch (cause) { problem(cause instanceof Error && 'code' in cause ? String(cause.code) : 'transcript-unavailable'); }
        finally {
          if (file) closeSync(file.fd); pumping = false;
          if (active && drainMore) { drainTimer = setTimeout(pump, 0); drainTimer.unref?.(); }
        }
      }
      subscriptions.add(cancel);
      try { pump(); } catch (cause) { cancel(); throw cause; }
      if (active) {
        unsubscribe = bus.on(event => { if (event.runId === runId && event.sessionId === owner.sessionId) pump(); });
        timer = setInterval(pump, options.pollMs ?? 2000); timer.unref?.();
      }
      return cancel;
    },
    dispose() { disposed = true; for (const cancel of [...subscriptions]) cancel(); },
  };
}
