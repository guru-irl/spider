// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { applyFeedHeartbeat, FEED_DISCONNECT_MS } from '../../assets/shared/feed.js';
import type { SessionFeed } from '../contracts.js';

/** Legacy content remains valid; only a private, matching sidecar can renew it. */
export async function sessionFeedIsFresh(feedRoot: string, feed: SessionFeed, now: number): Promise<boolean> {
  if (feed.lifecycle !== 'live') return false;
  if (now - feed.updatedAt <= FEED_DISCONNECT_MS) return true;
  if (!feed.sessionId || /[/\\\0]/.test(feed.sessionId) || feed.sessionId === '.' || feed.sessionId === '..') return false;
  const root = resolve(feedRoot), directory = join(root, 'sessions', feed.sessionId), file = join(directory, 'heartbeat.json');
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const canonicalRoot = await realpath(root);
    if (await realpath(directory) !== directory || !directory.startsWith(canonicalRoot + sep) || await realpath(file) !== file) return false;
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 1024 || process.platform !== 'win32' && (before.mode & 0o077) !== 0 || process.getuid && before.uid !== process.getuid()) return false;
    const buffer = Buffer.alloc(1025); let length = 0;
    while (length < buffer.length) {
      const chunk = await handle.read(buffer, length, buffer.length - length, length);
      if (!chunk.bytesRead) break; length += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (length > 1024 || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return false;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    return now - applyFeedHeartbeat(feed, text).updatedAt <= FEED_DISCONNECT_MS;
  } catch { return false; } finally { await handle?.close(); }
}
