// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { processStartTime } from '../../../subagents/src/process-identity.js';
import { withProcessLock } from '../sessions/registry.js';
import type { Disposable, Owner } from '../contracts.js';
import { atomicPrivateWrite, feedError, MAX_FEED_BYTES, privateDirectory, readPrivateText } from './publisher.js';
import { parseFeed } from '../../assets/shared/feed.js';
interface Writer { pid: number; startIdentity: string; generation: string }
let identity: { pid: number; startIdentity: string } | undefined;
function ownIdentity() {
  identity ??= { pid: process.pid, startIdentity: processStartTime(process.pid) ?? '' };
  if (!identity.startIdentity) throw feedError('process-identity-unavailable');
  return identity;
}
const probe = async (pid: number) => {
  const own = ownIdentity();
  const startIdentity = pid === own.pid ? own.startIdentity : processStartTime(pid);
  if (startIdentity) return { kind: 'live' as const, startIdentity };
  try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return { kind: 'absent' as const }; }
  return { kind: 'unknown' as const };
};
const path = (root: string, sessionId: string) => join(root, 'feed-writers', `${sessionId}.json`);
export function withFeedWriterLock<T>(root: string, sessionId: string, operation: () => Promise<T>): Promise<T> {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) throw feedError('invalid-session-id');
  return withProcessLock(root, `feed:${sessionId}`, operation, { identity: ownIdentity() });
}
async function readWriter(root: string, sessionId: string): Promise<Writer | null> {
  try {
    const value = JSON.parse(await readPrivateText(path(root, sessionId), 4096)) as Writer;
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.startIdentity !== 'string' || !value.startIdentity || typeof value.generation !== 'string') throw feedError('invalid-feed-writer');
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export type FeedWriterLiveness = { kind: 'alive' } | { kind: 'dead' } | { kind: 'unknown' };
/** Missing, unreadable or uncertain provenance cannot prove that a writer ended. */
export async function feedWriterLiveness(root: string, sessionId: string): Promise<FeedWriterLiveness> {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) return { kind: 'unknown' };
  try {
    const previous = await readWriter(root, sessionId);
    if (!previous) return { kind: 'unknown' };
    const observed = await probe(previous.pid);
    if (observed.kind === 'absent') return { kind: 'dead' };
    if (observed.kind === 'live' && observed.startIdentity === previous.startIdentity) return { kind: 'alive' };
    return { kind: 'unknown' };
  } catch { return { kind: 'unknown' }; }
}
export async function removeDeadFeedWriter(root: string, sessionId: string): Promise<void> {
  if ((await feedWriterLiveness(root, sessionId)).kind === 'dead') await rm(path(root, sessionId), { force: true });
}
async function hasClosedFeed(root: string, sessionId: string, generation: string): Promise<boolean> {
  try {
    const feed = parseFeed(await readPrivateText(join(root, 'sessions', sessionId, 'session.json'), MAX_FEED_BYTES));
    return feed?.sessionId === sessionId && feed.generation === generation && feed.lifecycle === 'closed';
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export async function ensureFeedWriter(root: string, owner: Pick<Owner, 'sessionId' | 'generation'>): Promise<void> {
  const own = ownIdentity(); const previous = await readWriter(root, owner.sessionId);
  if (previous) {
    const sameProcess = previous.pid === own.pid && previous.startIdentity === own.startIdentity;
    if (sameProcess && previous.generation === owner.generation) return;
    const closedHere = sameProcess && await hasClosedFeed(root, owner.sessionId, previous.generation);
    if (!closedHere && (await probe(previous.pid)).kind !== 'absent') throw feedError('feed-writer-occupied', 'Another live or unverified process owns this session feed.');
  }
  await privateDirectory(join(root, 'feed-writers'));
  await atomicPrivateWrite(path(root, owner.sessionId), JSON.stringify({ ...own, generation: owner.generation }));
}
export async function releaseFeedWriter(root: string, owner: Pick<Owner, 'sessionId' | 'generation'>): Promise<void> {
  await withFeedWriterLock(root, owner.sessionId, async () => {
    const previous = await readWriter(root, owner.sessionId); const own = ownIdentity();
    if (previous?.pid !== own.pid || previous.startIdentity !== own.startIdentity || previous.generation !== owner.generation) return;
    // A closed feed outlives its writer. Retain the identity until feed retention
    // removes it, so readers can prove process death rather than infer it.
    if (await hasClosedFeed(root, owner.sessionId, owner.generation)) return;
    await rm(path(root, owner.sessionId), { force: true });
  });
}
export async function claimFeedWriter(root: string, owner: Owner): Promise<Disposable> {
  await privateDirectory(root);
  await withFeedWriterLock(root, owner.sessionId, () => ensureFeedWriter(root, owner));
  return { dispose: () => releaseFeedWriter(root, owner) };
}
