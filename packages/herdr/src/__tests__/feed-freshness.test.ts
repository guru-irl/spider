// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, beforeEach, expect, it } from 'vitest';
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sessionFeedIsFresh } from '../feed/freshness.js';
import type { SessionFeed } from '../contracts.js';
let root: string, file: string;
const feed = (): SessionFeed => ({ version: 1, sessionId: 'planner' as never, generation: 'g' as never, revision: 1, updatedAt: 1000,
  owner: { sessionId: 'planner' as never, generation: 'g' as never, terminal: { coreId: 'fixture' as never, terminalId: 't1' as never, address: 't1' as never, socket: '/fixture/core.sock', sessionNamespace: 'fixture' }, cwd: '/fixture', sessionFile: null, name: 'Planner' },
  placement: null, lifecycle: 'live', status: { native: 'working', effective: 'working', message: null },
  runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [], approvals: [], notifications: [], errors: [], ipc: null,
  pace: { scope: 'session', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: null } });
const beat = (changes = {}) => JSON.stringify({ version: 1, sessionId: 'planner', generation: 'g', updatedAt: 60000, ...changes });
beforeEach(async () => { const parent = resolve('.spider/scratch/h'); await mkdir(parent, { recursive: true }); root = await mkdtemp(join(parent, 'fresh-')); await mkdir(join(root, 'sessions/planner'), { recursive: true }); file = join(root, 'sessions/planner/heartbeat.json'); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it('keeps legacy content fresh through exactly twenty seconds', async () => {
  expect(await sessionFeedIsFresh(root, feed(), 21000)).toBe(true);
  expect(await sessionFeedIsFresh(root, feed(), 21001)).toBe(false);
});
it('uses a matching heartbeat without mutating content or reviving closed owners', async () => {
  const content = feed(); await writeFile(file, beat(), { mode: 0o600 });
  expect(await sessionFeedIsFresh(root, content, 80000)).toBe(true);
  expect(await sessionFeedIsFresh(root, content, 80001)).toBe(false);
  expect(await sessionFeedIsFresh(root, { ...content, lifecycle: 'closed' }, 60000)).toBe(false);
  expect(content.updatedAt).toBe(1000);
});
it.each([beat({ generation: 'other' }), beat({ sessionId: 'other' }), beat({ version: 2 }), beat({ updatedAt: -1 }), '{', beat({ padding: 'é'.repeat(600) })])('cannot renew an owner from invalid sidecar %s', async text => {
  await writeFile(file, text, { mode: 0o600 }); expect(await sessionFeedIsFresh(root, feed(), 60000)).toBe(false);
});
it.each(['symlink', 'hardlink', 'public', 'directory'])('ignores a %s sidecar without trusting its contents', async kind => {
  const target = join(root, 'elsewhere'); await writeFile(target, beat(), { mode: 0o600 });
  if (kind === 'symlink') await symlink(target, file);
  if (kind === 'hardlink') await link(target, file);
  if (kind === 'directory') await mkdir(file);
  if (kind === 'public') { await writeFile(file, beat()); await chmod(file, 0o644); }
  expect(await sessionFeedIsFresh(root, feed(), 60000)).toBe(false);
});
