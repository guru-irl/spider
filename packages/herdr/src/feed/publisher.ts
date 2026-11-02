// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import type { SessionFeed } from '../contracts.js';
import { parseFeed } from '../../assets/shared/feed.js';
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
  await chmod(path, 0o700);
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
export async function publishSessionFeed(root: string, feed: SessionFeed): Promise<void> {
  const bounded: SessionFeed = { ...feed, runs: { ...feed.runs, rows: [...feed.runs.rows] }, todos: { ...feed.todos, rows: [...feed.todos.rows] } };
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
  await withFeedWriterLock(root, feed.sessionId, async () => {
    await ensureFeedWriter(root, feed);
    await atomicPrivateWrite(join(root, 'sessions', feed.sessionId, 'session.json'), text);
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
        const feed = parseFeed(await readPrivateText(file, MAX_FEED_BYTES));
        if (!feed || options.now - feed.updatedAt < Math.max(1, options.completedHours) * 3600000) return;
        if (feed.lifecycle === 'live' && ((await feedWriterLiveness(root, sessionId)).kind !== 'dead' || feed.ipc && await socketPresence(feed.ipc.address) !== 'absent')) return;
        const current = await lstat(file);
        if (current.ino !== before.ino || current.dev !== before.dev) return;
        await rm(file); removed++;
        await removeDeadFeedWriter(root, sessionId);
        await rmdir(join(root, 'sessions', sessionId)).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; });
      });
    } catch { /* Keep malformed or unverified state; continue the bounded retention pass. */ }
  }
  return { examined: names.length, removed };
}
