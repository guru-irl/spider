import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";
import type { SourceInfo } from "./discovery.js";
import type { MetadataCheckpoint, SessionMeta } from "./ledger.js";
import { UsageJsonLine } from "./jsonl-projection.js";
import { dashboardLabel } from "./dashboard-identities.js";
import { parseTranscript } from "./parse.js";
import { shortSessionName } from "./session-name.js";
const execute = promisify(execFile);
const projects = new Map<string, Promise<string>>();
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown): string | null => typeof v === "string" && v.trim() ? v : null;
const folder = (v: string): string => basename(v.replace(/\\/g, "/").replace(/\/+$/, ""));

export function redactSessionName(text: string): string {
  // Strip terminal escape sequences before the existing encoded-path redactor.
  let clean = text.slice(0, 4096).replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  for (let i = 0; i < 3; i++) clean = clean.replace(/(?:%[0-9a-f]{2})+/gi, encoded => {
    try { return decodeURIComponent(encoded); }
    catch { return encoded.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16))); }
  });
  clean = clean.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home)\/|\\\\)[^\s,;)]*/gi, "…");
  return [...(dashboardLabel("runName", clean) ?? "").trim()].slice(0, 80).join("");
}
export function resolveSessionProject(cwd: string, registeredRepo: string | null): Promise<string> {
  const key = JSON.stringify([cwd, registeredRepo]);
  let cached = projects.get(key);
  if (!cached) {
    cached = (async () => {
      try {
        if (!cwd.trim()) throw new Error("unknown cwd");
        const { stdout } = await execute("git", ["-C", cwd, "worktree", "list", "--porcelain"], { timeout: 1000, maxBuffer: 64 * 1024 });
        const main = stdout.split("\n").find(line => line.startsWith("worktree "))?.slice(9);
        if (main) return redactSessionName(folder(main));
      } catch { /* Deleted cwd and non-repositories use registered evidence. */ }
      const repo = registeredRepo?.replace(/\\/g, "/").replace(/\/+$/, "");
      return redactSessionName(folder(repo ? folder(repo) === ".git" ? dirname(repo) : repo : cwd));
    })();
    if (projects.size >= 4096) projects.delete(projects.keys().next().value!);
    projects.set(key, cached);
  }
  return cached;
}

/** Only redacted labels and a compact header survive a source slice. */
export class SessionMetadataCapture {
  session: SessionMeta | null;
  header: Record<string, unknown> | null;
  private firstUserSeen: boolean;
  private changed = false;
  constructor(private source: SourceInfo, previous: SessionMeta | null = null, header: Record<string, unknown> | null = null, private options: { firstUserSeen?: boolean } = {}) {
    this.session = previous ? { ...previous } : null;
    this.header = header;
    this.firstUserSeen = options.firstUserSeen === true || (previous?.nameOrder ?? 0) > 0;
    if (header) this.consume(header, 0);
    this.changed = false;
  }
  updateSource(source: SourceInfo): void {
    this.source = source;
    if (this.session && source.run?.sessionId && this.session.ownerSessionId !== source.run.sessionId) {
      this.session.ownerSessionId = source.run.sessionId; this.changed = true;
    }
  }
  consume(value: unknown, offset: number): void {
    const before = JSON.stringify(this.session);
    this.consumeEntry(value, offset);
    if (before !== JSON.stringify(this.session)) this.changed = true;
  }
  private consumeEntry(value: unknown, offset: number): void {
    const entry = object(value), message = object(entry.message);
    if (entry.type === "session" && text(entry.id)) {
      this.header = { type: "session", id: entry.id, cwd: entry.cwd, timestamp: entry.timestamp, parentSession: entry.parentSession };
      if (this.session?.id !== entry.id) {
        this.session = { id: String(entry.id), ownerSessionId: this.source.run?.sessionId ?? null,
          name: redactSessionName(shortSessionName(String(entry.id))), nameSource: "id", project: null,
          firstActivity: null, lastActivity: null, nameOrder: 0 };
        this.firstUserSeen = this.options.firstUserSeen === true;
      } else if (this.session && this.source.run?.sessionId) this.session.ownerSessionId = this.source.run.sessionId;
      return;
    }
    if (!this.session) return;
    const boundary = Date.parse(String(this.header?.timestamp ?? ""));
    const ts = Date.parse(String(entry.timestamp ?? message.timestamp ?? ""));
    const inherited = !!this.header?.parentSession && (!Number.isFinite(boundary) || !Number.isFinite(ts) || ts < boundary);
    if (entry.type === "session_info" && typeof entry.name === "string" && !inherited) {
      const name = redactSessionName(entry.name);
      if (name && offset + 2 >= this.session.nameOrder) { this.session.name = name; this.session.nameSource = "name"; this.session.nameOrder = offset + 2; }
    }
    if (entry.type === "message" && message.role === "user" && !inherited && !this.firstUserSeen) {
      this.firstUserSeen = true;
      const content = message.content;
      const line = typeof content === "string" ? content : Array.isArray(content)
        ? content.map(object).find(block => block.type === "text" && typeof block.text === "string")?.text : null;
      const name = typeof line === "string" ? redactSessionName(line.split(/\r?\n/, 1)[0].trim()) : "";
      if (this.session.nameSource !== "name") {
        if (name) { this.session.name = name; this.session.nameSource = "first-user"; }
        this.session.nameOrder = 1;
      }
    }
  }
  activity(timestamps: readonly number[]): void {
    const boundary = Date.parse(String(this.header?.timestamp ?? ""));
    for (const ts of timestamps) if (this.session && Number.isFinite(ts) && (!this.header?.parentSession || Number.isFinite(boundary) && ts >= boundary)) {
      if (this.session.firstActivity === null || ts < this.session.firstActivity || this.session.lastActivity === null || ts > this.session.lastActivity) this.changed = true;
      this.session.firstActivity = Math.min(this.session.firstActivity ?? ts, ts);
      this.session.lastActivity = Math.max(this.session.lastActivity ?? ts, ts);
    }
  }
  async finish(): Promise<SessionMeta | null> {
    // Null ownership means a human in the query contract. Unknown child owners
    // must not create that evidence. Keep the bounded capture for later proof.
    if (this.source.run && !text(this.source.run.sessionId)) return null;
    if (this.session && this.changed && this.session.project === null) {
      const cwd = text(this.header?.cwd) ?? this.source.project;
      if (cwd || this.source.repo) this.session.project = await resolveSessionProject(cwd ?? "", this.source.repo);
    }
    this.changed = false;
    return this.session;
  }
}

type Reader = { generation: number; inode: string; mtimeMs: number; size: number; offset: number; committed: number;
  line: UsageJsonLine; capture: SessionMetadataCapture; checkpointOffset: number; headerOffset?: number; headerLine?: UsageJsonLine };
// Incomplete huge lines keep only the bounded projection, never their raw bytes.
// At most 16 projections (each capped at 1 MiB) survive a pass. A restart or
// eviction replays from the last complete line, without moving the billing cursor.
const readers = new Map<string, Reader>();
export function forgetSessionMetadata(path: string): void { readers.delete(path); }
export async function readSessionMetadata(source: SourceInfo, checkpoint: MetadataCheckpoint | undefined, signal: AbortSignal, maxBytes: number,
  seed?: { session: SessionMeta | null; header: Record<string, unknown> | null; sessions?: ReadonlyMap<string, SessionMeta> }): Promise<{
  session: SessionMeta | null; checkpoint: MetadataCheckpoint; errors: readonly { path: string; code: string }[]; bytesRead: number; caughtUp: boolean;
}> {
  const errors: { path: string; code: string }[] = [];
  let bytesRead = 0;
  let cursor = checkpoint ?? { path: source.path, generation: 0, offset: 0, size: 0, complete: false };
  if (signal.aborted || maxBytes <= 0) return { session: null, checkpoint: cursor, errors, bytesRead, caughtUp: false };
  try {
    const info = await stat(source.path);
    if (!info.isFile()) throw Object.assign(new Error("not a file"), { code: "not-file" });
    const inode = `${info.dev}:${info.ino}`;
    let reader = readers.get(source.path);
    const replaced = !!checkpoint && (info.size < checkpoint.size || !!reader &&
      (reader.inode !== inode || reader.size === info.size && reader.mtimeMs !== info.mtimeMs));
    if (replaced) cursor = { path: source.path, generation: checkpoint!.generation + 1, offset: 0, size: info.size, complete: false };
    if (cursor.complete && cursor.size === info.size && !replaced) {
      if (source.run?.sessionId && !reader && !seed?.session) {
        // Ownership arrived after a restart. Rebuild the missing child span once,
        // within the same budget, rather than inventing a null-activity row.
        cursor = { ...cursor, offset: 0, complete: false };
      } else {
        const capture = reader?.capture ?? (seed?.header ? new SessionMetadataCapture(source, seed.session, seed.header) : null);
        capture?.updateSource(source);
        return { session: await capture?.finish() ?? null, checkpoint: cursor, errors, bytesRead, caughtUp: true };
      }
    }
    reader?.capture.updateSource(source);
    if (!reader || reader.generation !== cursor.generation || reader.checkpointOffset !== cursor.offset || replaced) {
      reader = { generation: cursor.generation, inode, mtimeMs: info.mtimeMs, size: info.size, offset: cursor.offset, committed: cursor.offset,
        line: new UsageJsonLine(true), capture: new SessionMetadataCapture(source, replaced ? null : seed?.session, replaced ? null : seed?.header), checkpointOffset: cursor.offset };
      // A migrated ledger already has a compact header. Direct/restarted reads
      // recover it incrementally, counting even these historical bytes.
      if (cursor.offset > 0 && !seed?.header) { reader.headerOffset = 0; reader.headerLine = new UsageJsonLine(true); }
      if (readers.size >= 16) readers.delete(readers.keys().next().value!);
      readers.set(source.path, reader);
    }
    const file = await open(source.path, "r");
    try {
      const buffer = Buffer.alloc(64 * 1024);
      while (reader.headerOffset !== undefined && bytesRead < maxBytes && !signal.aborted) {
        const length = Math.min(buffer.length, cursor.offset - reader.headerOffset, Math.floor(maxBytes - bytesRead));
        const read = await file.read(buffer, 0, length, reader.headerOffset);
        if (!read.bytesRead) throw Object.assign(new Error("short header"), { code: "source-changed" });
        bytesRead += read.bytesRead;
        const end = buffer.subarray(0, read.bytesRead).indexOf(10);
        reader.headerLine!.write(buffer.subarray(0, end < 0 ? read.bytesRead : end + 1));
        reader.headerOffset += read.bytesRead;
        if (end >= 0 || reader.headerOffset === cursor.offset) {
          const value = reader.headerLine!.finish(), header = object(value);
          const saved = typeof header.id === "string" ? seed?.sessions?.get(header.id) : undefined;
          if (saved) reader.capture = new SessionMetadataCapture(source, saved, header);
          else reader.capture.consume(value, 0);
          reader.headerOffset = undefined; reader.headerLine = undefined;
        }
      }
      while (reader.headerOffset === undefined && reader.offset < info.size && bytesRead < maxBytes && !signal.aborted) {
        const length = Math.min(buffer.length, info.size - reader.offset, Math.floor(maxBytes - bytesRead));
        const read = await file.read(buffer, 0, length, reader.offset);
        if (!read.bytesRead) throw Object.assign(new Error("short read"), { code: "source-changed" });
        bytesRead += read.bytesRead;
        const data = buffer.subarray(0, read.bytesRead); let start = 0, end: number;
        while ((end = data.indexOf(10, start)) !== -1) {
          reader.line.write(data.subarray(start, end + 1));
          const value = reader.line.finish();
          if (value === undefined) errors.push({ path: source.path, code: "metadata-parse-error" });
          else {
            reader.capture.consume(value, reader.committed);
            const parsed = parseTranscript([...(reader.capture.header ? [{ byteOffset: -1, json: reader.capture.header }] : []), { byteOffset: reader.committed, json: value }], {
              ...source, run: source.run ? { ...source.run, sessionId: source.run.sessionId ?? "", agent: source.run.agent ?? "" } : null
            });
            reader.capture.activity(parsed.calls.map(call => call.ts));
          }
          reader.committed = reader.offset + end + 1;
          reader.line = new UsageJsonLine(true); start = end + 1;
        }
        reader.line.write(data.subarray(start)); reader.offset += read.bytesRead;
      }
      const after = await file.stat(), named = await stat(source.path);
      if (after.size < info.size || named.ino !== info.ino || named.dev !== info.dev || after.size === info.size && after.mtimeMs !== info.mtimeMs) {
        readers.delete(source.path); throw Object.assign(new Error("source changed"), { code: "source-changed" });
      }
    } finally { await file.close(); }
    cursor = { path: source.path, generation: reader.generation, offset: reader.committed, size: info.size, complete: reader.headerOffset === undefined && reader.committed === info.size };
    reader.checkpointOffset = cursor.offset; reader.size = info.size; reader.mtimeMs = info.mtimeMs;
    const caughtUp = reader.headerOffset === undefined && reader.offset === info.size;
    // Uncommitted trailing bytes are replayed next pass, not treated as backlog.
    if (caughtUp && reader.committed < info.size) { reader.offset = reader.committed; reader.line = new UsageJsonLine(true); }
    return { session: signal.aborted ? null : await reader.capture.finish(), checkpoint: cursor, errors, bytesRead, caughtUp };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    errors.push({ path: source.path, code: code === "ENOENT" ? "metadata-missing-source" : code === "source-changed" ? "metadata-source-changed" : "metadata-read-error" });
    return { session: null, checkpoint: cursor, errors, bytesRead, caughtUp: false };
  }
}
