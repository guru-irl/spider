// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdir, lstat, open } from 'node:fs/promises';
import { constants as fileFlags } from 'node:fs';
import { join, posix } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { HcClient, MachineName } from '../contracts.js';
import { RAW_CHUNK_BYTES, sha256, RemoteRuntimeError, readBoundedFile, atomicRuntimeFile, type PayloadStream, type RuntimeReceipt, type RemoteChunkIndex, type RemoteChunk, type RemoteChunkPageRef } from './runtime.js';
export interface RemoteLogLocation { on: MachineName; directory: string; jobId: string; nonce: string; requestSha256: string }
export interface LogSink {
  position(stream: PayloadStream): number;
  write(stream: PayloadStream, offset: number, bytes: Buffer): Promise<void>;
  read(stream: PayloadStream, maxBytes: number): Promise<Buffer>;
  maxCaptureBytes: number;
  finish(receipt?: RuntimeReceipt): void | Promise<void>;
}
export interface CollectedLogs { stdout: string; stderr: string; stdoutBytes: number; stderrBytes: number; complete: boolean; capped: boolean; receipt: RuntimeReceipt | null }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RemoteRuntimeError('remote-log-invalid', 'Expected a log object');
  return value as Record<string, unknown>;
}
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function parsePageRef(value: unknown): RemoteChunkPageRef | null {
  if (value === null) return null;
  const ref = object(value);
  if (typeof ref.file !== 'string' || !/^page-[0-9]{8}\.json$/.test(ref.file) || !digest(ref.sha256) || !integer(ref.stdoutBytes) || !integer(ref.stderrBytes)) throw new RemoteRuntimeError('remote-page-invalid', 'Invalid chunk page reference');
  return { file: ref.file, sha256: ref.sha256, stdoutBytes: ref.stdoutBytes, stderrBytes: ref.stderrBytes };
}
function parseChunks(value: unknown, start: RemoteChunkPageRef | null): RemoteChunk[] {
  if (!Array.isArray(value) || value.length > 64) throw new RemoteRuntimeError('remote-chunk-invalid', 'Invalid bounded chunk list');
  const offsets = { stdout: start?.stdoutBytes ?? 0, stderr: start?.stderrBytes ?? 0 }; const names = new Set<string>();
  return value.map(value => {
    const c = object(value);
    if (typeof c.file !== 'string' || !/^chunk-[0-9]{8}\.json$/.test(c.file) || names.has(c.file) || (c.stream !== 'stdout' && c.stream !== 'stderr') || !integer(c.offset) || !integer(c.bytes) || c.bytes === 0 || c.bytes > RAW_CHUNK_BYTES || !digest(c.sha256) || c.offset !== offsets[c.stream]) throw new RemoteRuntimeError('remote-chunk-invalid', 'Invalid chunk offset, digest, or size');
    names.add(c.file); offsets[c.stream] += c.bytes;
    return { file: c.file, stream: c.stream as PayloadStream, offset: c.offset, bytes: c.bytes, sha256: c.sha256 };
  });
}
function parseIndex(bytes: Buffer, location: RemoteLogLocation): RemoteChunkIndex {
  if (bytes.length > 64 * 1024) throw new RemoteRuntimeError('remote-index-too-large', 'Chunk index exceeds 64 KiB');
  const v = object(JSON.parse(bytes.toString()));
  if (v.version !== 1 || v.jobId !== location.jobId || v.nonce !== location.nonce) throw new RemoteRuntimeError('remote-log-mismatch', 'Index identity does not match');
  const head = parsePageRef(v.head);
  return { version: 1, jobId: location.jobId, nonce: location.nonce, head, chunks: parseChunks(v.chunks, head) };
}
function parsePage(bytes: Buffer, expected: RemoteChunkPageRef, location: RemoteLogLocation): { previous: RemoteChunkPageRef | null; chunks: RemoteChunk[] } {
  if (bytes.length > 64 * 1024 || sha256(bytes) !== expected.sha256) throw new RemoteRuntimeError('remote-page-digest-mismatch', 'Chunk page digest does not match');
  const v = object(JSON.parse(bytes.toString()));
  if (v.version !== 1 || v.jobId !== location.jobId || v.nonce !== location.nonce) throw new RemoteRuntimeError('remote-log-mismatch', 'Chunk page identity does not match');
  const previous = parsePageRef(v.previous), chunks = parseChunks(v.chunks, previous);
  const stdoutBytes = (previous?.stdoutBytes ?? 0) + chunks.filter(c => c.stream === 'stdout').reduce((n, c) => n + c.bytes, 0);
  const stderrBytes = (previous?.stderrBytes ?? 0) + chunks.filter(c => c.stream === 'stderr').reduce((n, c) => n + c.bytes, 0);
  if (stdoutBytes !== expected.stdoutBytes || stderrBytes !== expected.stderrBytes || chunks.length !== 64) throw new RemoteRuntimeError('remote-page-invalid', 'Chunk page byte counts do not match');
  return { previous, chunks };
}
export function parseRuntimeReceipt(bytes: Buffer, location: RemoteLogLocation): RuntimeReceipt {
  if (bytes.length > 64 * 1024) throw new RemoteRuntimeError('remote-receipt-invalid', 'Receipt exceeds its bound');
  const v = object(JSON.parse(bytes.toString()));
  if (v.version !== 1 || v.jobId !== location.jobId || v.nonce !== location.nonce || v.requestSha256 !== location.requestSha256 || !digest(v.indexSha256) || !integer(v.finishedAt) || !integer(v.stdoutBytes) || !integer(v.stderrBytes)) throw new RemoteRuntimeError('remote-receipt-mismatch', 'Receipt identity or digest does not match');
  const outcome = v.outcome;
  if (outcome !== 'exited' && outcome !== 'signal' && outcome !== 'spawn-error' && outcome !== 'release-timeout' && outcome !== 'cancelled') throw new RemoteRuntimeError('remote-receipt-invalid', 'Unknown receipt outcome');
  if ((outcome === 'exited' && (!integer(v.exitCode) || v.signal !== null)) || (outcome === 'signal' && (v.exitCode !== null || typeof v.signal !== 'string' || !/^SIG[A-Z0-9]+$/.test(v.signal))) || ((outcome === 'spawn-error' || outcome === 'release-timeout') && (v.exitCode !== null || v.signal !== null)) || (outcome === 'cancelled' && (v.exitCode !== 137 || v.signal !== null)) || (v.error !== undefined && typeof v.error !== 'string')) throw new RemoteRuntimeError('remote-receipt-invalid', 'Invalid receipt outcome fields');
  return { version: 1, jobId: location.jobId, nonce: location.nonce, requestSha256: location.requestSha256, indexSha256: v.indexSha256, outcome, exitCode: v.exitCode as number | null, signal: v.signal as string | null, finishedAt: v.finishedAt, stdoutBytes: v.stdoutBytes, stderrBytes: v.stderrBytes, ...(typeof v.error === 'string' ? { error: v.error } : {}) };
}
function missing(error: unknown): boolean {
  const e = error as { code?: string; kind?: string; message?: string };
  return e.code === 'not_found' || e.code === 'ENOENT' || e.code === 'file-not-found' || e.kind === 'not_found' || (e.code === 'hc-error' && /not found|No such file/i.test(e.message ?? ''));
}
export async function collectRemoteChunks(client: HcClient, location: RemoteLogLocation, sink: LogSink): Promise<CollectedLogs> {
  const read = (name: string) => client.fileRead(location.on, posix.join(location.directory, name));
  let complete = true; let receipt: RuntimeReceipt | null = null;
  let indexBytes: Buffer | null = null;
  try { indexBytes = await read('index.json'); } catch (error) { if (!missing(error)) throw error; complete = false; }
  if (indexBytes) {
    const index = parseIndex(indexBytes, location);
    const pages: RemoteChunk[][] = []; const seenPages = new Set<string>(); let head = index.head;
    while (head && (sink.position('stdout') < head.stdoutBytes || sink.position('stderr') < head.stderrBytes)) {
      if (seenPages.has(head.file)) throw new RemoteRuntimeError('remote-page-invalid', 'Chunk page chain is cyclic');
      seenPages.add(head.file);
      let bytes: Buffer;
      try { bytes = await read(head.file); } catch (error) { if (!missing(error)) throw error; complete = false; break; }
      const page = parsePage(bytes, head, location); pages.push(page.chunks); head = page.previous;
    }
    const chunks = complete ? [...pages.reverse().flat(), ...index.chunks] : [];
    for (const chunk of chunks) {
      const position = sink.position(chunk.stream);
      if (position >= chunk.offset + chunk.bytes) continue;
      if (position !== chunk.offset) throw new RemoteRuntimeError('local-log-gap', 'Local log offset is not a complete chunk boundary');
      let bytes: Buffer;
      try { bytes = await read(chunk.file); } catch (error) { if (!missing(error)) throw error; complete = false; break; }
      if (bytes.length > RAW_CHUNK_BYTES * 2) throw new RemoteRuntimeError('remote-chunk-too-large', 'Encoded chunk exceeds its bound');
      const value = object(JSON.parse(bytes.toString()));
      if (value.stream !== chunk.stream || value.offset !== chunk.offset || typeof value.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) throw new RemoteRuntimeError('remote-chunk-invalid', 'Chunk data or offset does not match');
      const raw = Buffer.from(value.data, 'base64');
      if (raw.length !== chunk.bytes || sha256(raw) !== chunk.sha256) throw new RemoteRuntimeError('remote-chunk-digest-mismatch', 'Chunk bytes do not match the published digest');
      await sink.write(chunk.stream, chunk.offset, raw);
    }
    if (complete) {
      try {
        const bytes = await read('receipt.json'); const receiptDigest = (await read('receipt.json.sha256')).toString().trim();
        if (sha256(bytes) !== receiptDigest) throw new RemoteRuntimeError('remote-receipt-digest-mismatch', 'Receipt digest does not match');
        const parsed = parseRuntimeReceipt(bytes, location);
        if (parsed.indexSha256 === sha256(indexBytes) && parsed.stdoutBytes === sink.position('stdout') && parsed.stderrBytes === sink.position('stderr')) receipt = parsed;
        else complete = false; // A final index may have advanced while the first snapshot was being read.
      } catch (error) { if (!missing(error)) throw error; complete = false; }
    }
  }
  if (complete && receipt) await sink.finish(receipt);
  const stdoutBytes = sink.position('stdout'), stderrBytes = sink.position('stderr');
  const stdout = await sink.read('stdout', sink.maxCaptureBytes);
  const stderr = await sink.read('stderr', Math.max(0, sink.maxCaptureBytes - stdout.length));
  const decode = (bytes: Buffer) => { const decoder = new StringDecoder('utf8'); const text = decoder.write(bytes); return complete && stdoutBytes + stderrBytes <= sink.maxCaptureBytes ? text + decoder.end() : text; };
  return { stdout: decode(stdout), stderr: decode(stderr), stdoutBytes, stderrBytes, complete: complete && receipt !== null, capped: stdoutBytes + stderrBytes > sink.maxCaptureBytes, receipt };
}
/**
 * The job monitor owns one write sink per job. Reactivation restores published offsets and removes only an unpublished crash tail.
 * Raw files remain caller-owned; this sink never deletes them.
 */
export async function createFileLogSink(directory: string, options: { maxCaptureBytes?: number; onData?: (text: string) => void } = {}): Promise<LogSink> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new RemoteRuntimeError('local-log-invalid', 'Local log directory must not be a symlink');
  const positions = { stdout: 0, stderr: 0 }; const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  for (const stream of ['stdout', 'stderr'] as const) {
    const path = join(directory, stream + '.log'), cursorPath = join(directory, stream + '.offset');
    let size = 0;
    try { const stat = await lstat(path); if (!stat.isFile()) throw new RemoteRuntimeError('local-log-invalid', 'Local log is not a regular file'); size = stat.size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const file = await open(path, 'wx', 0o600); await file.close(); }
    try {
      const cursor = object(JSON.parse((await readBoundedFile(cursorPath, 128)).toString()));
      if (cursor.version !== 1 || !integer(cursor.offset) || cursor.offset > size) throw new RemoteRuntimeError('local-log-cursor-invalid', 'Local log cursor does not match saved bytes');
      positions[stream] = cursor.offset;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (size !== 0) throw new RemoteRuntimeError('local-log-cursor-missing', 'A nonempty log has no owned collection cursor');
      await atomicRuntimeFile(cursorPath, JSON.stringify({ version: 1, offset: 0 }));
    }
    const file = await open(path, fileFlags.O_RDWR | (fileFlags.O_NOFOLLOW ?? 0));
    try {
      if (size > positions[stream]) { await file.truncate(positions[stream]); await file.sync(); }
      const tail = Buffer.alloc(Math.min(positions[stream], 4));
      if (tail.length) { await file.read(tail, 0, tail.length, positions[stream] - tail.length); decoders[stream].write(tail); }
    } finally { await file.close(); }
  }
  let ended = false;
  return {
    maxCaptureBytes: options.maxCaptureBytes ?? 100 * 1024 * 1024,
    position: stream => positions[stream],
    write: async (stream, offset, bytes) => {
      if (offset !== positions[stream]) throw new RemoteRuntimeError('local-log-gap', 'Log append offset does not match');
      const file = await open(join(directory, stream + '.log'), fileFlags.O_WRONLY | fileFlags.O_APPEND | (fileFlags.O_NOFOLLOW ?? 0));
      try {
        const stat = await file.stat();
        if (stat.size < positions[stream]) throw new RemoteRuntimeError('local-log-cursor-invalid', 'Published log bytes disappeared');
        if (stat.size > positions[stream]) await file.truncate(positions[stream]);
        await file.writeFile(bytes); await file.sync();
      } finally { await file.close(); }
      await atomicRuntimeFile(join(directory, stream + '.offset'), JSON.stringify({ version: 1, offset: positions[stream] + bytes.length }));
      positions[stream] += bytes.length;
      const text = decoders[stream].write(bytes); if (text) options.onData?.(text);
    },
    read: async (stream, maxBytes) => {
      const bytes = Buffer.alloc(Math.min(positions[stream], maxBytes)); const file = await open(join(directory, stream + '.log'), fileFlags.O_RDONLY | (fileFlags.O_NOFOLLOW ?? 0));
      try { const { bytesRead } = await file.read(bytes, 0, bytes.length, 0); return bytes.subarray(0, bytesRead); } finally { await file.close(); }
    },
    finish: async receipt => {
      if (receipt) await atomicRuntimeFile(join(directory, 'receipt.json'), JSON.stringify(receipt));
      if (!ended) { ended = true; for (const decoder of Object.values(decoders)) { const text = decoder.end(); if (text) options.onData?.(text); } }
    },
  };
}
/** Setup reuses an already verified versioned install, never uploads the runtime per job. */
export async function ensureRemoteRuntime(client: HcClient, on: MachineName, path: string, bytes: Buffer, expectedSha256: string): Promise<void> {
  if (!posix.isAbsolute(path) || sha256(bytes) !== expectedSha256) throw new RemoteRuntimeError('runtime-install-invalid', 'Expected an absolute path and matching runtime digest');
  try { if (sha256(await client.fileRead(on, path)) === expectedSha256) return; } catch (error) { if (!missing(error)) throw error; }
  await client.fileWrite(on, path, bytes);
  if (sha256(await client.fileRead(on, path)) !== expectedSha256) throw new RemoteRuntimeError('runtime-install-digest-mismatch', 'Installed runtime digest does not match');
}
