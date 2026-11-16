// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { publishSessionFeed } from '../feed/publisher.js';
import { parseFeed } from '../../assets/shared/feed.js';
import type { Owner, SessionFeed, PanelNotification } from '../contracts.js';
let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });
async function fixture(): Promise<SessionFeed> {
  const scratch = resolve('.spider/scratch'); await mkdir(scratch, { recursive: true }); root = await mkdtemp(join(scratch, 'feed-bounds-'));
  const owner: Owner = { sessionId: 'planner' as Owner['sessionId'], generation: 'g' as Owner['generation'], terminal: { coreId: 'fixture' as Owner['terminal']['coreId'], terminalId: 't1' as Owner['terminal']['terminalId'], address: 't1' as Owner['terminal']['address'], socket: join(root, 'core.sock'), sessionNamespace: 'fixture' }, cwd: root, sessionFile: null, name: null };
  return { version: 1, sessionId: owner.sessionId, generation: owner.generation, revision: 1, updatedAt: 1000, owner, placement: null, lifecycle: 'live', status: { native: null, effective: null, message: null }, runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [], pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' }, approvals: [], notifications: [], ipc: null, errors: [] };
}
const notice = (feed: SessionFeed, i: number): Extract<PanelNotification, { kind: 'subagent-result' | 'escalation' | 'job-result' }> => ({ id: `job-result:job-${i}`, kind: 'job-result', createdAt: i, scope: 'session', sessionId: feed.sessionId, ownerAddress: feed.owner.terminal.address, title: `Job ${i}`, body: 'Synthetic output', action: { kind: 'focus-owner', sessionId: feed.sessionId, address: feed.owner.terminal.address } });
const intentional = (feed: SessionFeed, i: number): Extract<PanelNotification, { kind: 'intentional' }> => ({
  id: `notice-${i}`, kind: 'intentional', createdAt: i, scope: 'session', sessionId: feed.sessionId, ownerAddress: feed.owner.terminal.address,
  title: 'Owner', body: 'Choose a fix', urgency: 'attention', runId: null,
  action: { kind: 'focus-owner', sessionId: feed.sessionId, address: feed.owner.terminal.address },
});
async function published(feed: SessionFeed): Promise<SessionFeed> {
  await publishSessionFeed(root!, feed);
  const parsed = parseFeed(await readFile(join(root!, 'sessions', feed.sessionId, 'session.json'), 'utf8'));
  expect(parsed).not.toBeNull(); return parsed!;
}
it('publishes intentional occurrences within the shared row and byte caps', async () => {
  const feed = await fixture();
  feed.notifications = Array.from({ length: 65 }, (_, i) => ({ ...intentional(feed, i), body: '界'.repeat(500) }));
  const result = await published(feed);
  expect(result.notifications[0]).toMatchObject({ kind: 'intentional', id: 'notice-64', urgency: 'attention' });
  expect(result.notifications.length).toBeLessThanOrEqual(64);
  expect(result.notifications.length).toBeLessThan(64);
  expect(Buffer.byteLength(JSON.stringify(result.notifications))).toBeLessThanOrEqual(64 * 1024);
  expect(feed.notifications).toHaveLength(65);
});

it('accepts matching parent and run actions but rejects foreign or mismatched intentional actions', async () => {
  const feed = await fixture(), parent = intentional(feed, 1);
  const run = { ...parent, id: 'run-note', runId: 'run-1', action: { kind: 'open-run', sessionId: feed.sessionId, runId: 'run-1' } };
  feed.notifications = [parent, run as PanelNotification];
  expect(parseFeed(JSON.stringify(feed))?.notifications).toHaveLength(2);
  const invalid = [
    { ...parent, sessionId: 'other', action: { kind: 'focus-owner', sessionId: 'other', address: parent.ownerAddress } },
    { ...parent, ownerAddress: 'other', action: { kind: 'focus-owner', sessionId: feed.sessionId, address: 'other' } },
    { ...parent, action: { kind: 'open-run', sessionId: feed.sessionId, runId: 'run-1' } },
    { ...run, action: { kind: 'open-run', sessionId: feed.sessionId, runId: 'other' } },
    { ...parent, urgency: 'loud' },
  ];
  for (const notice of invalid) expect(parseFeed(JSON.stringify({ ...feed, notifications: [notice] }))).toBeNull();
});

it('publishes the latest 64 job notices, not retired notices, without changing its input', async () => {
  const feed = await fixture();
  feed.notifications = Array.from({ length: 200 }, (_, i) => notice(feed, i));
  feed.notifications.push({ ...notice(feed, 999), id: 'subagent-result:old', kind: 'subagent-result' });
  feed.notifications.push({ ...notice(feed, 1000), id: 'escalation:old', kind: 'escalation' });
  const result = await published(feed);
  expect(result.notifications).toHaveLength(64);
  expect(result.notifications[0].id).toBe('job-result:job-199');
  expect(result.notifications.at(-1)?.id).toBe('job-result:job-136');
  expect(result.notifications.every(n => n.kind === 'job-result')).toBe(true);
  expect(feed.notifications).toHaveLength(202);
});
it('bounds notice bytes including multibyte text and keeps smaller recent notices', async () => {
  const feed = await fixture();
  feed.notifications = Array.from({ length: 20 }, (_, i) => ({ ...notice(feed, i), body: '界'.repeat(2000) }));
  feed.notifications.push({ ...notice(feed, 30), body: '界'.repeat(30000) });
  feed.notifications.push(notice(feed, 31));
  const result = await published(feed);
  expect(Buffer.byteLength(JSON.stringify(result.notifications))).toBeLessThanOrEqual(64 * 1024);
  expect(result.notifications[0].id).toBe('job-result:job-31');
  expect(result.notifications.some(n => n.id === 'job-result:job-30')).toBe(false);
  expect(result.notifications.some(n => n.id === 'job-result:job-19')).toBe(true);
  expect(feed.notifications[20].body.length).toBe(30000);
});
it('bounds every row list and reports truncation instead of inventing smaller totals', async () => {
  const feed = await fixture();
  feed.todos = { rows: Array.from({ length: 600 }, (_, i) => ({ seq: i + 1, sessionId: feed.sessionId, text: `Todo ${i}`, done: false })), total: 600, truncated: false };
  feed.runs = { rows: Array.from({ length: 600 }, (_, i) => ({ id: `run-${i}` as SessionFeed['runs']['rows'][number]['id'], ownerSessionId: feed.sessionId, name: null, status: 'running', childMode: 'print', canSteer: false, startedAt: null, finishedAt: null, viewer: null, result: null })), total: 600, truncated: false };
  feed.approvals = Array.from({ length: 600 }, (_, i) => ({ uuid: `memory-${i}`, scope: 'global', repoKey: null, ownerSessionId: null, category: 'convention', preview: `Note ${i}` }));
  feed.triggers = Array.from({ length: 600 }, (_, i) => ({ name: `wake-${i}`, kind: 'loop', nextAt: null, tz: null, state: 'idle', prompt: 'Check the result' }));
  feed.errors = Array.from({ length: 600 }, (_, i) => ({ source: `source-${i}`, message: 'Unavailable' }));
  const result = await published(feed);
  expect(result.runs).toMatchObject({ total: 600, truncated: true });
  expect(result.runs.rows).toHaveLength(512);
  expect(result.todos).toMatchObject({ total: 600, truncated: true });
  expect(result.todos.rows).toHaveLength(512);
  expect(result.approvals).toHaveLength(512);
  expect(result.triggers).toHaveLength(512);
  expect(result.errors.length).toBeLessThanOrEqual(32);
  expect(result.errors.map(e => e.source)).toEqual(expect.arrayContaining(['approvals', 'triggers', 'errors']));
  expect(feed.runs.rows).toHaveLength(600);
  expect(feed.errors).toHaveLength(600);
});
