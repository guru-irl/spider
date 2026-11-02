// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { constants, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm, rmdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import type { Owner, SessionFeed } from '../contracts.js';
import { applyFeedHeartbeat, parseFeed } from '../../assets/shared/feed.js';
import { ensureFeedWriter, releaseFeedWriter, withFeedWriterLock, feedWriterLiveness, removeDeadFeedWriter } from './writer.js';
import { boundedEntries, socketPresence } from './cleanup.js';
import { HerdrError } from '../client/parse.js';
export const MAX_FEED_BYTES: number = 1024 * 1024;
/** Share the drain promise; notifications during a write request only the latest snapshot. */
export function coalesceFeedWrites(write: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  let dirty = false;
  return () => {
    dirty = true;
    if (!pending) pending = Promise.resolve().then(async () => {
      do { dirty = false; await write(); } while (dirty);
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
export function feedError(code: string, message: string = code): HerdrError { return new HerdrError(code, message); }
export function assertPrivatePath(path: string): void {
  if (!isAbsolute(path)) throw feedError('absolute-path-required');
  const checkout = process.env.SPIDER_TEST_FIXTURE_CHECKOUT;
  if (checkout && !resolve(path).startsWith(join(resolve(checkout), '.spider', 'scratch') + '/')) throw feedError('test-path-outside-root');
}
/** Reject symlinks in every ancestor; never chmod an ancestor outside the integration directory. */
export async function rejectSymlinks(path: string): Promise<void> {
  assertPrivatePath(path);
  let current = parse(path).root;
  for (const part of resolve(path).slice(current.length).split('/')) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw feedError('symlink-refused'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
}
export async function privateDirectory(path: string): Promise<void> {
  await rejectSymlinks(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await rejectSymlinks(path);
  const info = await lstat(path);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) throw feedError('directory-owner-mismatch');
  if ((info.mode & 0o777) !== 0o700) await chmod(path, 0o700);
}
export async function readPrivateText(path: string, maxBytes: number): Promise<string> {
  await rejectSymlinks(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) throw feedError('unsafe-private-file');
    // Bound actual reads too: a growing file cannot bypass the stat size check.
    const bytes = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxBytes) throw feedError('private-file-too-large');
    return bytes.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
}
export async function atomicPrivateWrite(path: string, text: string): Promise<void> {
  await privateDirectory(dirname(path));
  await rejectSymlinks(path);
  const temporary = join(dirname(path), `.${randomUUID()}.part`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(text, 'utf8'); await file.sync(); await file.close();
    await rejectSymlinks(path); await rename(temporary, path);
  } finally { await file.close(); await rm(temporary, { force: true }); }
}
interface Published {
  stamp: string; generation: string; lifecycle: SessionFeed['lifecycle']; contentHash?: string;
  heartbeat?: { at: number; stamp: string };
}
const published = new Map<string, Published>();
const heartbeats = new Map<string, Promise<void>>();
const cacheKey = (root: string, sessionId: string) => `${resolve(root)}\0${sessionId}`;
const stamp = (info: Stats) => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode, info.uid, info.nlink].join(':');
async function privateMetadata(file: string, maxBytes: number): Promise<Stats> {
  await rejectSymlinks(file); const info = await lstat(file);
  if (!info.isFile() || info.size > maxBytes || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) throw feedError('unsafe-private-file');
  return info;
}
async function unchanged(file: string, expected: string, maxBytes: number): Promise<boolean> {
  try { return stamp(await privateMetadata(file, maxBytes)) === expected; } catch { return false; }
}
function remember(key: string, value: Published): void {
  published.delete(key); published.set(key, value);
  if (published.size > 32) published.delete(published.keys().next().value!);
}
async function currentPublication(root: string, owner: Pick<Owner, 'sessionId' | 'generation'>): Promise<Published | null> {
  const key = cacheKey(root, owner.sessionId), file = join(root, 'sessions', owner.sessionId, 'session.json');
  try {
    const info = await privateMetadata(file, MAX_FEED_BYTES), known = published.get(key);
    if (known?.stamp === stamp(info)) return known;
    const feed = parseFeed(await readPrivateText(file, MAX_FEED_BYTES));
    if (!feed || feed.sessionId !== owner.sessionId) throw feedError('invalid-feed');
    const value: Published = { stamp: stamp(info), generation: feed.generation, lifecycle: feed.lifecycle };
    remember(key, value); return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { published.delete(key); return null; } throw error; }
}
async function writeHeartbeat(root: string, owner: Pick<Owner, 'sessionId' | 'generation'>, updatedAt: number, value: Published): Promise<void> {
  const file = join(root, 'sessions', owner.sessionId, 'heartbeat.json');
  if (value.heartbeat && updatedAt - value.heartbeat.at < 1000 && await unchanged(file, value.heartbeat.stamp, 1024)) return;
  const text = JSON.stringify({ version: 1, sessionId: owner.sessionId, generation: owner.generation, updatedAt });
  if (Buffer.byteLength(text) > 1024) throw feedError('heartbeat-too-large');
  await atomicPrivateWrite(file, text);
  value.heartbeat = { at: updatedAt, stamp: stamp(await privateMetadata(file, 1024)) };
}
/** Independent of snapshot reads; concurrent renewals share one private writer lock. */
export function publishSessionHeartbeat(root: string, owner: Pick<Owner, 'sessionId' | 'generation'>, updatedAt: number): Promise<void> {
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) return Promise.reject(feedError('invalid-heartbeat'));
  const key = cacheKey(root, owner.sessionId), taskKey = `${key}\0${owner.generation}`;
  const pending = heartbeats.get(taskKey); if (pending) return pending;
  const work = (async () => {
    const known = published.get(key), file = join(root, 'sessions', owner.sessionId, 'session.json');
    if (known?.generation === owner.generation && known.heartbeat && updatedAt - known.heartbeat.at < 1000
      && await unchanged(file, known.stamp, MAX_FEED_BYTES) && await unchanged(join(dirname(file), 'heartbeat.json'), known.heartbeat.stamp, 1024)) return;
    await withFeedWriterLock(root, owner.sessionId, async () => {
      const value = await currentPublication(root, owner);
      if (!value || value.lifecycle === 'closed') return;
      if (value.generation !== owner.generation) throw feedError('feed-writer-occupied');
      await ensureFeedWriter(root, owner);
      await writeHeartbeat(root, owner, updatedAt, value);
    });
  })().finally(() => { heartbeats.delete(taskKey); });
  heartbeats.set(taskKey, work); return work;
}
const MAX_ROWS = 512;
const MAX_NOTICES = 64;
const MAX_NOTICE_BYTES = 64 * 1024;
const MAX_ERRORS = 32;
function boundedNotifications(notices: SessionFeed['notifications']): SessionFeed['notifications'] {
  const result: SessionFeed['notifications'] = [];
  let bytes = 2; // JSON array brackets.
  const recent = notices.filter(notice => notice.kind === 'job-result').sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  for (const notice of recent) {
    const size = Buffer.byteLength(JSON.stringify(notice)) + (result.length ? 1 : 0);
    if (bytes + size > MAX_NOTICE_BYTES) continue;
    result.push(notice); bytes += size;
    if (result.length === MAX_NOTICES) break;
  }
  return result;
}
export async function publishSessionFeed(root: string, feed: SessionFeed): Promise<void> {
  const truncated: SessionFeed['errors'] = [];
  if (feed.approvals.length > MAX_ROWS) truncated.push({ source: 'approvals', message: 'Memory review list truncated.' });
  if (feed.triggers.length > MAX_ROWS) truncated.push({ source: 'triggers', message: 'Trigger list truncated.' });
  if (feed.errors.length + truncated.length > MAX_ERRORS) truncated.push({ source: 'errors', message: 'Error list truncated.' });
  const bounded: SessionFeed = { ...feed,
    runs: { ...feed.runs, rows: feed.runs.rows.slice(0, MAX_ROWS), truncated: feed.runs.truncated || feed.runs.rows.length > MAX_ROWS },
    todos: { ...feed.todos, rows: feed.todos.rows.slice(0, MAX_ROWS), truncated: feed.todos.truncated || feed.todos.rows.length > MAX_ROWS },
    approvals: feed.approvals.slice(0, MAX_ROWS), triggers: feed.triggers.slice(0, MAX_ROWS),
    notifications: boundedNotifications(feed.notifications), errors: [...feed.errors.slice(0, MAX_ERRORS - truncated.length), ...truncated] };
  let size = Buffer.byteLength(JSON.stringify(bounded));
  const runSizes = bounded.runs.rows.map(row => Buffer.byteLength(JSON.stringify(row)));
  const todoSizes = bounded.todos.rows.map(row => Buffer.byteLength(JSON.stringify(row)));
  let runBytes = runSizes.reduce((a, b) => a + b + 1, 0);
  let todoBytes = todoSizes.reduce((a, b) => a + b + 1, 0);
  while (size > MAX_FEED_BYTES && (runSizes.length || todoSizes.length)) {
    if (runBytes > todoBytes) {
      const bytes = runSizes.pop()! + (runSizes.length ? 1 : 0); runBytes -= bytes; size -= bytes;
      bounded.runs.rows.pop(); bounded.runs.truncated = true;
    } else {
      const bytes = todoSizes.pop()! + (todoSizes.length ? 1 : 0); todoBytes -= bytes; size -= bytes;
      bounded.todos.rows.pop(); bounded.todos.truncated = true;
    }
  }
  const text = JSON.stringify(bounded);
  if (Buffer.byteLength(text) > MAX_FEED_BYTES) throw feedError('feed-too-large');
  if (!parseFeed(text)) throw feedError('invalid-feed');
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(feed.sessionId)) throw feedError('invalid-session-id');
  await privateDirectory(root); await privateDirectory(join(root, 'sessions'));
  const key = cacheKey(root, feed.sessionId), file = join(root, 'sessions', feed.sessionId, 'session.json');
  const contentHash = createHash('sha256').update(JSON.stringify({ ...bounded, revision: 0, updatedAt: 0 })).digest('hex');
  const known = published.get(key);
  if (feed.lifecycle === 'live' && known?.generation === feed.generation && known.lifecycle === 'live' && known.contentHash === contentHash && await unchanged(file, known.stamp, MAX_FEED_BYTES)) {
    await publishSessionHeartbeat(root, feed, feed.updatedAt); return;
  }
  await withFeedWriterLock(root, feed.sessionId, async () => {
    await ensureFeedWriter(root, feed);
    await atomicPrivateWrite(file, text);
    const previous = published.get(key);
    const value: Published = { stamp: stamp(await privateMetadata(file, MAX_FEED_BYTES)), contentHash, generation: feed.generation, lifecycle: feed.lifecycle,
      ...(previous?.generation === feed.generation && previous.heartbeat ? { heartbeat: previous.heartbeat } : {}) };
    remember(key, value);
    if (feed.lifecycle === 'live') await writeHeartbeat(root, feed, feed.updatedAt, value);
    else { await rejectSymlinks(join(dirname(file), 'heartbeat.json')); await rm(join(dirname(file), 'heartbeat.json'), { force: true }); }
  });
  if (feed.lifecycle === 'closed') await releaseFeedWriter(root, feed);
}
export interface FeedRetentionOptions { now: number; completedHours: number; maxEntries?: number; excludeSessionId?: string }
export async function sweepSessionFeeds(root: string, options: FeedRetentionOptions): Promise<{ examined: number; removed: number }> {
  const names = await boundedEntries(join(root, 'sessions'), options.maxEntries ?? 32);
  let removed = 0;
  for (const sessionId of names) {
    if (sessionId === options.excludeSessionId || !/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) continue;
    try {
      await withFeedWriterLock(root, sessionId, async () => {
        const file = join(root, 'sessions', sessionId, 'session.json');
        const before = await lstat(file);
        const content = parseFeed(await readPrivateText(file, MAX_FEED_BYTES));
        if (!content) return;
        const heartbeatFile = join(dirname(file), 'heartbeat.json');
        let heartbeat: string | null = null;
        try { await privateMetadata(heartbeatFile, 1024); heartbeat = await readPrivateText(heartbeatFile, 1024); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const feed = applyFeedHeartbeat(content, heartbeat);
        if (options.now - feed.updatedAt < Math.max(1, options.completedHours) * 3600000) return;
        if (feed.lifecycle === 'live' && ((await feedWriterLiveness(root, sessionId)).kind !== 'dead' || feed.ipc && await socketPresence(feed.ipc.address) !== 'absent')) return;
        const current = await lstat(file);
        if (current.ino !== before.ino || current.dev !== before.dev) return;
        await rejectSymlinks(heartbeatFile); await rm(file); await rm(heartbeatFile, { force: true }); removed++;
        published.delete(cacheKey(root, sessionId));
        await removeDeadFeedWriter(root, sessionId);
        await rmdir(join(root, 'sessions', sessionId)).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; });
      });
    } catch { /* Keep malformed or unverified state; continue the bounded retention pass. */ }
  }
  return { examined: names.length, removed };
}
