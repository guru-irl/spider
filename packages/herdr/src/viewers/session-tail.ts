// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

export interface SessionTailRead {
  /** Parsed records in file order. Partial final lines wait for their LF. */
  entries: unknown[];
  /** The session header's cwd, when the header was ever readable. */
  cwd: string | null;
  /** The first read skipped the start of a large file. */
  truncatedHead: boolean;
  /** The file was replaced or shrank, so these entries restart the transcript. */
  reset: boolean;
  /** The file does not exist yet, or is not a plain file. */
  missing: boolean;
  invalid: number;
}
export interface SessionTailOptions {
  /** The first read starts at most this many bytes from the end. */
  initialBytes?: number;
  /** Each read consumes at most this many bytes, so a burst cannot stall the viewer. */
  readBytes?: number;
  /** Oversized records are skipped, including across reads. */
  recordBytes?: number;
}
/** Reads a pi session JSONL file incrementally. Memory stays bounded by the read window. */
export class SessionTail {
  private offset = 0; private identity: string | null = null; private pending = Buffer.alloc(0);
  private cwd: string | null = null; private started = false; private discarding = false;
  private readonly initialBytes: number; private readonly readBytes: number; private readonly recordBytes: number;
  constructor(private readonly path: string, options: SessionTailOptions = {}) {
    this.initialBytes = Math.max(4096, options.initialBytes ?? 2 * 1024 * 1024);
    this.readBytes = Math.max(65536, options.readBytes ?? 2 * 1024 * 1024);
    this.recordBytes = Math.max(4096, options.recordBytes ?? 1024 * 1024);
  }
  read(): SessionTailRead {
    const result: SessionTailRead = { entries: [], cwd: this.cwd, truncatedHead: false, reset: false, missing: false, invalid: 0 };
    let fd: number;
    try { fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { result.missing = true; return result; }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) { result.missing = true; return result; }
      const identity = `${stat.dev}:${stat.ino}`;
      if (this.started && (identity !== this.identity || stat.size < this.offset)) {
        this.offset = 0; this.pending = Buffer.alloc(0); this.started = false; this.discarding = false; result.reset = true;
      }
      this.identity = identity;
      let skipPartial = false;
      if (!this.started) {
        this.started = true;
        this.cwd = headerCwd(fd) ?? this.cwd; result.cwd = this.cwd;
        if (stat.size > this.initialBytes) { this.offset = stat.size - this.initialBytes; skipPartial = true; result.truncatedHead = true; }
      }
      const length = Math.min(stat.size - this.offset, this.readBytes);
      if (length <= 0) return result;
      const chunk = Buffer.alloc(length); let read = 0;
      while (read < length) { const count = readSync(fd, chunk, read, length - read, this.offset + read); if (!count) break; read += count; }
      this.offset += read;
      let data = this.pending.length ? Buffer.concat([this.pending, chunk.subarray(0, read)]) : chunk.subarray(0, read);
      if (skipPartial) this.discarding = true;
      let start = 0, lf: number;
      while ((lf = data.indexOf(10, start)) >= 0) {
        if (this.discarding || lf - start > this.recordBytes) {
          if (!skipPartial) result.invalid++;
          this.discarding = false; skipPartial = false; start = lf + 1; continue;
        }
        const line = data.subarray(start, lf).toString('utf8').replace(/\r$/, ''); start = lf + 1;
        if (!line.trim()) continue;
        try { result.entries.push(JSON.parse(line)); } catch { result.invalid++; }
      }
      const remaining = data.subarray(start);
      if (remaining.length > this.recordBytes) this.discarding = true;
      this.pending = this.discarding ? Buffer.alloc(0) : Buffer.from(remaining);
      return result;
    } finally { closeSync(fd); }
  }
}
function headerCwd(fd: number): string | null {
  const buffer = Buffer.alloc(65536); const count = readSync(fd, buffer, 0, buffer.length, 0);
  const lf = buffer.subarray(0, count).indexOf(10); if (lf < 0) return null;
  try {
    const header: unknown = JSON.parse(buffer.subarray(0, lf).toString('utf8'));
    return header && typeof header === 'object' && 'type' in header && header.type === 'session' && 'cwd' in header && typeof header.cwd === 'string' ? header.cwd : null;
  } catch { return null; }
}
