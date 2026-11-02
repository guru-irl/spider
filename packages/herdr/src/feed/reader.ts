// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { SessionFeed } from '../contracts.js';
import { FEED_DISCONNECT_MS, applyFeedHeartbeat, parseFeed } from '../../assets/shared/feed.js';

const MAX_FILE = 1024 * 1024, MAX_REPLY = 6 * 1024 * 1024, MAX_SESSIONS = 4096;
interface CachedFeed { stamp: string; feed: SessionFeed; size: number }
interface Entry { source: string; stamp: string; updatedAt: number }
interface Snapshot { version: 1; entries: Entry[]; changes: { source: string; stamp: string; feed: SessionFeed }[]; errors: { source: string; message: string }[] }
export interface FeedReaderConnection { version: 1; port: number; token: string; pid: number }
const signature = (s: Awaited<ReturnType<typeof lstat>>) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const unsafe = () => Object.assign(new Error('unsafe-feed-path'), { code: 'unsafe-feed-path' });
async function safe(path: string): Promise<void> { if (await realpath(path) !== resolve(path)) throw unsafe(); }
async function safeAncestors(path: string): Promise<void> {
  try { await safe(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const parent = dirname(path); if (parent !== path) await safeAncestors(parent); }
}
async function privateReaderDirectory(path: string): Promise<void> {
  await safeAncestors(path); await mkdir(path, { recursive: true, mode: 0o700 }); await safe(path);
  const info = await lstat(path);
  if (!info.isDirectory() || process.getuid && info.uid !== process.getuid()) throw unsafe();
  await chmod(path, 0o700);
}
async function readBounded(path: string, limit: number, privateFile = false): Promise<{ text: string; stamp: string; size: number; mtime: number }> {
  await safe(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw unsafe();
    if (privateFile && (info.nlink !== 1 || process.platform !== 'win32' && (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid())) throw unsafe();
    if (info.size > limit) throw Object.assign(new Error('feed-too-large'), { code: 'feed-too-large' });
    const buffer = Buffer.alloc(limit + 1); let offset = 0;
    for (;;) { const read = await handle.read(buffer, offset, buffer.length - offset, null); offset += read.bytesRead; if (!read.bytesRead || offset === buffer.length) break; }
    if (offset > limit) throw Object.assign(new Error('feed-too-large'), { code: 'feed-too-large' });
    await safe(path);
    if (privateFile) {
      const after = await handle.stat();
      if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) throw unsafe();
    }
    const bytes = buffer.subarray(0, offset);
    const text = privateFile ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes.toString('utf8');
    return { text, stamp: signature(info), size: offset, mtime: info.mtimeMs };
  } finally { await handle.close(); }
}
async function heartbeat(root: string, feed: SessionFeed): Promise<number> {
  if (feed.lifecycle !== 'live') return feed.updatedAt;
  try {
    const { text } = await readBounded(join(root, 'sessions', feed.sessionId, 'heartbeat.json'), 1024, true);
    return applyFeedHeartbeat(feed, text).updatedAt;
  } catch { /* Missing sidecars are normal for sessions using the older writer. */ }
  return feed.updatedAt;
}
/** The cache belongs to one reader, and retains no more than the reply byte budget. */
function createSnapshots(root: string) {
  let cache = new Map<string, CachedFeed>();
  return async (known: Record<string, unknown>): Promise<Snapshot> => {
    const errors: Snapshot['errors'] = [], candidates: { source: string; file: string; stamp: string; mtime: number }[] = [];
    let truncated = false;
    const fail = (source: string, error: unknown) => {
      const e = error as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return;
      if (errors.length < 255) errors.push({ source, message: e.code === 'invalid-feed' ? 'Unavailable: invalid feed' : ['ELOOP', 'unsafe-feed-path'].includes(e.code ?? '') ? 'unsafe-feed-path' : e.code || e.message });
      else truncated = true;
    };
    try {
      await safe(root); const directory = join(root, 'sessions'); await safe(directory);
      const directories = await readdir(directory, { withFileTypes: true });
      if (directories.length > MAX_SESSIONS) truncated = true;
      for (const entry of directories.slice(0, MAX_SESSIONS)) {
        if (entry.isSymbolicLink()) { fail(entry.name, unsafe()); continue; }
        if (!entry.isDirectory()) continue;
        if (!/^[A-Za-z0-9_-]{1,160}$/.test(entry.name)) { fail(entry.name, unsafe()); continue; }
        const file = join(directory, entry.name, 'session.json');
        try {
          await safe(file); const info = await lstat(file);
          if (!info.isFile()) throw unsafe();
          if (info.size > MAX_FILE) throw Object.assign(new Error('feed-too-large'), { code: 'feed-too-large' });
          candidates.push({ source: entry.name, file, stamp: signature(info), mtime: info.mtimeMs });
        } catch (error) { fail(entry.name, error); }
      }
    } catch (error) { fail('sessions', error); }
    candidates.sort((a, b) => b.mtime - a.mtime || a.source.localeCompare(b.source));
    const selected: { source: string; value: CachedFeed; updatedAt: number; rank: number; mtime: number }[] = [];
    let bytes = 0; const now = Date.now();
    for (const candidate of candidates) {
      try {
        let value = cache.get(candidate.source);
        if (!value || value.stamp !== candidate.stamp) {
          const read = await readBounded(candidate.file, MAX_FILE), feed = parseFeed(read.text);
          if (!feed || feed.sessionId !== candidate.source) throw Object.assign(new Error('invalid-feed'), { code: 'invalid-feed' });
          // Older sessions still publish retired notices. They are never shown.
          value = { stamp: read.stamp, size: read.size, feed: { ...feed, notifications: feed.notifications.filter(n => n.kind === 'job-result') } };
        }
        const updatedAt = await heartbeat(root, value.feed);
        const rank = value.feed.lifecycle === 'live' && now - updatedAt <= FEED_DISCONNECT_MS ? 0 : now - candidate.mtime <= 7 * 86400000 ? 1 : 2;
        selected.push({ source: candidate.source, value, updatedAt, rank, mtime: candidate.mtime }); bytes += value.size;
        selected.sort((a, b) => a.rank - b.rank || b.mtime - a.mtime || a.source.localeCompare(b.source));
        while (bytes > MAX_REPLY || selected.length > MAX_SESSIONS) { bytes -= selected.pop()!.value.size; truncated = true; }
      } catch (error) { fail(candidate.source, error); }
    }
    cache = new Map(selected.map(row => [row.source, row.value]));
    if (truncated) errors.push({ source: 'sessions', message: 'Snapshot truncated: feed total exceeds reply limit' });
    return { version: 1, entries: selected.map(row => ({ source: row.source, stamp: row.value.stamp, updatedAt: row.updatedAt })),
      changes: selected.filter(row => known[row.source] !== row.value.stamp).map(row => ({ source: row.source, stamp: row.value.stamp, feed: row.value.feed })), errors };
  };
}
function reply(response: ServerResponse, code: number, value: unknown): void { response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); }
async function serve(root: string): Promise<void> {
  await privateReaderDirectory(root); const registrations = join(root, 'readers'); await privateReaderDirectory(registrations);
  const token = randomBytes(32).toString('hex'), secret = Buffer.from(`Bearer ${token}`), registration = join(registrations, `${randomUUID()}.json`);
  const snapshot = createSnapshots(root);
  let timer: ReturnType<typeof setTimeout>, stopping = false;
  let finished!: () => void; const closed = new Promise<void>(resolveClosed => { finished = resolveClosed; });
  const stop = async () => {
    if (stopping) return; stopping = true; clearTimeout(timer);
    await rm(registration, { force: true });
    server.closeAllConnections(); server.close(() => finished());
  };
  const renew = () => { clearTimeout(timer); timer = setTimeout(() => { void stop(); }, 30000); timer.unref(); };
  const server = createServer((request, response) => {
    void (async () => {
      const auth = Buffer.from(request.headers.authorization ?? '');
      if (request.method !== 'POST' || auth.length !== secret.length || !timingSafeEqual(auth, secret)) { reply(response, 401, { error: 'unauthorized' }); return; }
      renew();
      if (request.url === '/close') {
        await rm(registration, { force: true });
        response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}', () => { void stop(); }); return;
      }
      if (request.url !== '/snapshot') { reply(response, 404, { error: 'unknown-operation' }); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { const data = Buffer.from(chunk); bytes += data.length; if (bytes > MAX_FILE) { reply(response, 413, { error: 'too-large' }); return; } chunks.push(data); }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reply(response, 400, { error: 'invalid-request' }); return; }
      const known = (body as { known?: unknown })?.known;
      if (!known || typeof known !== 'object' || Array.isArray(known) || Object.keys(known).length > MAX_SESSIONS) { reply(response, 400, { error: 'invalid-request' }); return; }
      reply(response, 200, await snapshot(known as Record<string, unknown>));
    })().catch(() => { if (!response.headersSent) reply(response, 500, { error: 'reader-unavailable' }); else response.destroy(); });
  });
  await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Reader did not get a loopback port');
  const connection: FeedReaderConnection = { version: 1, port: address.port, token, pid: process.pid };
  try {
    const file = await open(registration, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify(connection)); } finally { await file.close(); }
    renew(); process.stdout.write(JSON.stringify(connection) + '\n');
    process.once('SIGTERM', () => { void stop(); }); process.once('SIGINT', () => { void stop(); });
    await closed;
  } finally { await rm(registration, { force: true }); server.closeAllConnections(); server.close(); }
}
/** The launcher exits after one bounded ready line. The child expires if its mod stops asking. */
async function launch(root: string): Promise<void> {
  const child = spawn(process.execPath, [process.argv[1], '--serve', '--root', root], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
  try {
    const ready = await new Promise<string>((resolveReady, reject) => {
      let text = '', errors = '';
      const timer = setTimeout(() => reject(new Error('Feed reader did not start')), 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(errors || 'Feed reader exited before ready')); });
      child.stderr!.on('data', data => { errors = (errors + String(data)).slice(-4096); });
      child.stdout!.on('data', data => {
        text += String(data);
        if (text.length > 4096) { clearTimeout(timer); reject(new Error('Invalid reader acknowledgement')); }
        else if (text.includes('\n')) { clearTimeout(timer); resolveReady(text.slice(0, text.indexOf('\n'))); }
      });
    });
    const parsed = JSON.parse(ready) as FeedReaderConnection & { error?: string };
    if (parsed.error) throw Object.assign(new Error(parsed.error), { code: parsed.error });
    if (parsed.version !== 1 || parsed.pid !== child.pid || !Number.isSafeInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535 || !/^[a-f0-9]{64}$/.test(parsed.token)) throw new Error('Invalid reader acknowledgement');
    process.stdout.write(ready + '\n'); child.stdout!.destroy(); child.stderr!.destroy(); child.unref();
  } catch (error) { child.kill('SIGTERM'); throw error; }
}
export async function runFeedReaderCli(argv: readonly string[]): Promise<number> {
  const serving = argv[0] === '--serve', args = serving ? argv.slice(1) : argv;
  if (args.length !== 2 || args[0] !== '--root' || !isAbsolute(args[1])) { process.stderr.write('Feed reader requires an absolute root.\n'); return 1; }
  try { await safeAncestors(resolve(args[1])); if (serving) await serve(resolve(args[1])); else await launch(resolve(args[1])); return 0; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    process.stdout.write(JSON.stringify({ version: 1, error: code === 'symlink-refused' || code === 'unsafe-feed-path' ? 'unsafe-feed-path' : 'reader-unavailable' }) + '\n');
    process.stderr.write(`Feed reader unavailable: ${(error as Error).message}\n`); return 1;
  }
}
