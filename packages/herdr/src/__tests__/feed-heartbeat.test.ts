// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, chmod, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import * as publisher from '../feed/publisher.js';
import * as codec from '../../assets/shared/feed.js';
import type { Owner, SessionFeed } from '../contracts.js';
let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });
async function fixture(): Promise<SessionFeed> {
  const scratch = resolve('.spider/scratch'); await mkdir(scratch, { recursive: true }); root = await mkdtemp(join(scratch, 'feed-heartbeat-'));
  const owner: Owner = { sessionId: 'planner' as Owner['sessionId'], generation: 'g' as Owner['generation'], terminal: { coreId: 'fixture' as Owner['terminal']['coreId'], terminalId: 't1' as Owner['terminal']['terminalId'], address: 't1' as Owner['terminal']['address'], socket: join(root, 'core.sock'), sessionNamespace: 'fixture' }, cwd: root, sessionFile: null, name: null };
  return { version: 1, sessionId: owner.sessionId, generation: owner.generation, revision: 1, updatedAt: 1000, owner, placement: null, lifecycle: 'live', status: { native: null, effective: null, message: null }, runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [], pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' }, approvals: [], notifications: [], ipc: null, errors: [] };
}
const file = (name = 'session.json') => join(root!, 'sessions', 'planner', name);
it('does not churn directory metadata when the directory is already private', async () => {
  await fixture(); await publisher.privateDirectory(root!); const before = await stat(root!);
  await publisher.privateDirectory(root!);
  expect((await stat(root!)).ctimeMs).toBe(before.ctimeMs);
});
it('keeps content and its revision unchanged when only heartbeat time and snapshot revision advance', async () => {
  const feed = await fixture(); await publisher.publishSessionFeed(root!, feed);
  const before = await stat(file()), text = await readFile(file(), 'utf8');
  await publisher.publishSessionFeed(root!, { ...feed, revision: 2, updatedAt: 2000 });
  const after = await stat(file());
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(await readFile(file(), 'utf8')).toBe(text);
  expect(JSON.parse(await readFile(file('heartbeat.json'), 'utf8'))).toEqual({ version: 1, sessionId: 'planner', generation: 'g', updatedAt: 2000 });
  expect((await stat(file('heartbeat.json'))).mode & 0o777).toBe(0o600);
  expect(codec.parseFeed(text)?.revision).toBe(1);
});
it('still publishes a changed status and a terminal closed snapshot', async () => {
  const feed = await fixture(); await publisher.publishSessionFeed(root!, feed);
  await publisher.publishSessionFeed(root!, { ...feed, revision: 2, updatedAt: 2000, status: { ...feed.status, effective: 'working' } });
  expect(codec.parseFeed(await readFile(file(), 'utf8'))).toMatchObject({ revision: 2, updatedAt: 2000, status: { effective: 'working' } });
  await publisher.publishSessionFeed(root!, { ...feed, revision: 3, updatedAt: 3000, lifecycle: 'closed' });
  expect(codec.parseFeed(await readFile(file(), 'utf8'))).toMatchObject({ revision: 3, lifecycle: 'closed' });
  expect(await readdir(join(root!, 'sessions', 'planner'))).toEqual(['session.json']);
});
it('repairs removed, replaced or public content instead of trusting an old cached publication', async () => {
  const feed = await fixture(); await publisher.publishSessionFeed(root!, feed);
  for (const change of [() => rm(file()), () => writeFile(file(), '{broken'), () => chmod(file(), 0o644)]) {
    await change(); await publisher.publishSessionFeed(root!, { ...feed, revision: 2, updatedAt: 2000 });
    expect(codec.parseFeed(await readFile(file(), 'utf8'))?.sessionId).toBe('planner');
    expect((await stat(file())).mode & 0o777).toBe(0o600);
  }
});
it('does not churn control-file metadata for an already renewed unchanged snapshot', async () => {
  const feed = await fixture(); await publisher.publishSessionFeed(root!, feed);
  await publisher.publishSessionHeartbeat(root!, feed.owner, 2000);
  const [name] = await readdir(join(root!, 'locks')), directory = join(root!, 'locks', name!);
  const before = await stat(directory);
  await publisher.publishSessionFeed(root!, { ...feed, revision: 2, updatedAt: 2000 });
  expect((await stat(directory)).ctimeMs).toBe(before.ctimeMs);
  expect(JSON.parse(await readFile(file(), 'utf8')).revision).toBe(1);
});
it('does not claim a missing writer record for a rejected heartbeat generation', async () => {
  const feed = await fixture(); await publisher.publishSessionFeed(root!, feed);
  const writer = join(root!, 'feed-writers/planner.json'); await rm(writer);
  await expect(publisher.publishSessionHeartbeat(root!, { ...feed.owner, generation: 'other' as Owner['generation'] }, 6000)).rejects.toMatchObject({ code: 'feed-writer-occupied' });
  await expect(stat(writer)).rejects.toMatchObject({ code: 'ENOENT' });
  await publisher.publishSessionHeartbeat(root!, feed.owner, 6000);
  expect(JSON.parse(await readFile(writer, 'utf8')).generation).toBe('g');
});
it('refreshes liveness independently without touching session content', async () => {
  const feed = await fixture(); await publisher.publishSessionFeed(root!, feed);
  const before = await stat(file());
  await publisher.publishSessionHeartbeat(root!, feed.owner, 3000);
  expect((await stat(file())).ino).toBe(before.ino);
  expect(JSON.parse(await readFile(file('heartbeat.json'), 'utf8')).updatedAt).toBe(3000);
  await expect(publisher.publishSessionHeartbeat(root!, { ...feed.owner, generation: 'other' as Owner['generation'] }, 4000)).rejects.toMatchObject({ code: 'feed-writer-occupied' });
  expect(JSON.parse(await readFile(file('heartbeat.json'), 'utf8')).generation).toBe('g');
});
it('does not renew the timestamp of a closed feed', async () => {
  const feed = await fixture(); await publisher.publishSessionFeed(root!, { ...feed, lifecycle: 'closed' });
  await publisher.publishSessionHeartbeat(root!, feed.owner, 3000);
  expect(await readdir(join(root!, 'sessions', 'planner'))).toEqual(['session.json']);
});
it('retains a recently renewed dead writer and removes its expired sidecar with the feed', async () => {
  const feed = await fixture(); await publisher.publishSessionFeed(root!, feed);
  await publisher.publishSessionHeartbeat(root!, feed.owner, 3601000);
  const deadPid = await new Promise<number>((resolvePid, reject) => execFile(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { env: { ...process.env, TMPDIR: root } }, (error, stdout) => error ? reject(error) : resolvePid(Number(stdout))));
  await writeFile(join(root!, 'feed-writers', 'planner.json'), JSON.stringify({ pid: deadPid, startIdentity: 'exited-fixture', generation: 'g' }));
  expect(await publisher.sweepSessionFeeds(root!, { now: 3602000, completedHours: 1 })).toMatchObject({ removed: 0 });
  expect(await publisher.sweepSessionFeeds(root!, { now: 7202000, completedHours: 1 })).toMatchObject({ removed: 1 });
  expect(await readdir(join(root!, 'sessions'))).toEqual([]);
});
it('uses a matching heartbeat while old, malformed and different-generation sidecars fall back to the feed', async () => {
  const feed = await fixture(); await publisher.publishSessionFeed(root!, feed);
  const read = async () => codec.applyFeedHeartbeat(feed, await readFile(file('heartbeat.json'), 'utf8').catch(() => null));
  const fresh = await read();
  expect(fresh.updatedAt).toBe(1000);
  await writeFile(file('heartbeat.json'), JSON.stringify({ version: 1, sessionId: 'planner', generation: 'g', updatedAt: 9000 }));
  expect((await read()).updatedAt).toBe(9000);
  expect(feed.updatedAt).toBe(1000);
  for (const value of ['{broken', JSON.stringify({ version: 1, sessionId: 'planner', generation: 'other', updatedAt: 9000 }), JSON.stringify({ version: 1, sessionId: 'foreign', generation: 'g', updatedAt: 9000 }), JSON.stringify({ version: 1, sessionId: 'planner', generation: 'g', updatedAt: -1 }), JSON.stringify({ version: 1, sessionId: 'planner', generation: 'g', updatedAt: 9000, padding: 'x'.repeat(1024) }), JSON.stringify({ version: 1, sessionId: 'planner', generation: 'g', updatedAt: 9000, padding: '🙂'.repeat(250) }), 'x'.repeat(2048)]) {
    await writeFile(file('heartbeat.json'), value);
    expect((await read()).updatedAt).toBe(1000);
  }
  await rm(file('heartbeat.json'));
  expect((await read()).updatedAt).toBe(1000);
  expect(codec.applyFeedHeartbeat({ ...feed, lifecycle: 'closed' }, JSON.stringify({ version: 1, sessionId: 'planner', generation: 'g', updatedAt: 9000 })).updatedAt).toBe(1000);
});
