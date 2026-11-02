// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SessionFeed, Owner } from '../contracts.js';
let root: string;
let connection: { port: number; token: string; pid: number } | undefined;
let feed: SessionFeed;
const invoke = (args: string[]) => new Promise<{ code: number; stdout: string }>(resolveResult => execFile(process.execPath, [resolve('dist/herdr/feed-reader.mjs'), ...args], { env: { ...process.env, TMPDIR: root } }, (error, stdout) => resolveResult({ code: error ? Number(error.code) || 1 : 0, stdout })));
const file = (name = 'session.json') => join(root, 'sessions', 'planner', name);
async function request(path: string, value: unknown, token = connection!.token) {
  const reply = await fetch(`http://127.0.0.1:${connection!.port}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { status: reply.status, data: await reply.json() as any };
}
async function start() {
  const launched = await invoke(['--root', root]);
  expect(launched.code).toBe(0);
  connection = JSON.parse(launched.stdout);
}
beforeEach(async () => {
  const scratch = resolve('.spider/scratch'); await mkdir(scratch, { recursive: true }); root = await mkdtemp(join(scratch, 'reader-server-'));
  const owner: Owner = { sessionId: 'planner' as Owner['sessionId'], generation: 'g' as Owner['generation'], terminal: { coreId: 'fixture' as Owner['terminal']['coreId'], terminalId: 't1' as Owner['terminal']['terminalId'], address: 't1' as Owner['terminal']['address'], socket: join(root, 'core.sock'), sessionNamespace: 'fixture' }, cwd: root, sessionFile: null, name: null };
  feed = { version: 1, sessionId: owner.sessionId, generation: owner.generation, revision: 1, updatedAt: 1000, owner, placement: null, lifecycle: 'live', status: { native: null, effective: null, message: null }, runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [], pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' }, approvals: [], notifications: [], ipc: null, errors: [] };
  await mkdir(join(root, 'sessions', 'planner'), { recursive: true }); await writeFile(file(), JSON.stringify(feed), { mode: 0o600 });
});
afterEach(async () => {
  if (connection) {
    await request('close', {}).catch(() => {});
    for (let i = 0; i < 50; i++) { try { process.kill(connection.pid, 0); } catch { break; } await new Promise(resolve => setTimeout(resolve, 20)); }
    try { process.kill(connection.pid, 0); process.kill(connection.pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
  connection = undefined;
  await rm(root, { recursive: true, force: true });
});
it('returns only changed feeds, keeps the same reader process, and evicts deleted sessions', async () => {
  await start();
  const first = await request('snapshot', { known: {} });
  expect(first.status).toBe(200);
  expect(first.data.changes.map((entry: any) => entry.feed.sessionId)).toEqual(['planner']);
  const known = Object.fromEntries(first.data.entries.map((entry: any) => [entry.source, entry.stamp]));
  const second = await request('snapshot', { known });
  expect(second.data.changes).toEqual([]);
  expect(second.data.entries.map((entry: any) => entry.source)).toEqual(['planner']);
  await writeFile(file('new.part'), JSON.stringify({ ...feed, revision: 2, status: { ...feed.status, effective: 'working' } }), { mode: 0o600 }); await rename(file('new.part'), file());
  expect((await request('snapshot', { known })).data.changes[0].feed.status.effective).toBe('working');
  await rm(file());
  expect((await request('snapshot', { known })).data.entries).toEqual([]);
  expect((await readdir(join(root, 'readers'))).length).toBe(1);
});
it('rejects unauthenticated requests before returning any feed', async () => {
  await start();
  const denied = await request('snapshot', { known: {} }, '0'.repeat(64));
  expect(denied.status).toBe(401);
  expect(JSON.stringify(denied.data)).not.toContain('planner');
  expect((await request('snapshot', { known: {} })).data.entries).toHaveLength(1);
});
it('reports unsafe or oversized feeds while keeping valid ones', async () => {
  const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'session.json'), JSON.stringify(feed));
  await symlink(outside, join(root, 'sessions', 'linked'));
  await mkdir(join(root, 'sessions', 'oversized')); await writeFile(join(root, 'sessions', 'oversized', 'session.json'), 'x'.repeat(1024 * 1024 + 1));
  await mkdir(join(root, 'sessions', 'special', 'session.json'), { recursive: true });
  await start();
  const snapshot = (await request('snapshot', { known: {} })).data;
  expect(snapshot.entries.map((entry: any) => entry.source)).toEqual(['planner']);
  expect(snapshot.errors).toEqual(expect.arrayContaining([
    { source: 'linked', message: 'unsafe-feed-path' }, { source: 'oversized', message: 'feed-too-large' }, { source: 'special', message: 'unsafe-feed-path' },
  ]));
});
it('accepts old feeds and only uses a bounded heartbeat for the matching generation', async () => {
  await start();
  expect((await request('snapshot', { known: {} })).data.entries[0].updatedAt).toBe(1000);
  for (const [heartbeat, at] of [
    [{ version: 1, sessionId: 'planner', generation: 'g', updatedAt: 9000 }, 9000],
    [{ version: 1, sessionId: 'planner', generation: 'old', updatedAt: 9000 }, 1000],
    [{ version: 1, sessionId: 'foreign', generation: 'g', updatedAt: 9000 }, 1000],
    [{ version: 1, sessionId: 'planner', generation: 'g', updatedAt: -1 }, 1000],
    ['x'.repeat(2048), 1000],
  ] as const) {
    await writeFile(file('heartbeat.json'), typeof heartbeat === 'string' ? heartbeat : JSON.stringify(heartbeat), { mode: 0o600 });
    expect((await request('snapshot', { known: {} })).data.entries[0].updatedAt).toBe(at);
  }
  expect(feed.updatedAt).toBe(1000);
});
it.each(['public-mode', 'hard-link', 'malformed-utf8'] as const)('does not renew an old feed from a %s sidecar', async kind => {
  const sidecar = file('heartbeat.json');
  await writeFile(sidecar, JSON.stringify({ version: 1, sessionId: 'planner', generation: 'g', updatedAt: 9000 }), { mode: 0o600 });
  await start();
  expect((await request('snapshot', { known: {} })).data.entries[0].updatedAt).toBe(9000);
  if (kind === 'public-mode') await chmod(sidecar, 0o644);
  else if (kind === 'hard-link') await link(sidecar, file('heartbeat-copy.json'));
  else await writeFile(sidecar, Buffer.concat([
    Buffer.from('{"version":1,"sessionId":"planner","generation":"g","updatedAt":9000,"ignored":"'),
    Buffer.from([0xff]), Buffer.from('"}'),
  ]));
  const snapshot = (await request('snapshot', { known: {} })).data;
  expect(snapshot.entries.map((entry: any) => entry.source)).toEqual(['planner']);
  expect(snapshot.entries[0].updatedAt).toBe(feed.updatedAt);
});

it('removes its private registration on authenticated close', async () => {
  await start();
  const records = await readdir(join(root, 'readers'));
  expect(JSON.parse(await readFile(join(root, 'readers', records[0]), 'utf8')).pid).toBe(connection!.pid);
  expect((await request('close', {})).status).toBe(200);
  expect(await readdir(join(root, 'readers'))).toEqual([]);
});
