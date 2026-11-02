// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { writeFile, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createAppClient } from '../client/app.js';
import { parseFeed } from '../../assets/shared/feed.js';
import type { SpaceId, TabId, PaneId } from '../contracts.js';
import { afterEach, test, expect, vi } from 'vitest';
import { createHcClient } from '../client/hc.js';
import { createClientFixture, terminal, type ClientFixture } from './testutil.js';
import type { HcEvent, HcEventStream } from '../contracts.js';
const fixtures: ClientFixture[] = []; const streams: HcEventStream[] = [];
const clients: ReturnType<typeof createHcClient>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) await client.dispose();
  for (const stream of streams.splice(0)) await stream.dispose();
  for (const h of fixtures.splice(0)) await h.close();
});
async function fixture(): Promise<{ h: ClientFixture; client: ReturnType<typeof createHcClient>; stream: HcEventStream }> {
  const h = await createClientFixture(); fixtures.push(h);
  const client = createHcClient({ binary: h.hcBinary, env: h.localEnv }); clients.push(client); const stream = client.events(); streams.push(stream); await stream.ready;
  return { h, client, stream };
}
test('a subscriber before initialization receives the real snapshot exactly once', async () => {
  const h = await createClientFixture(); fixtures.push(h);
  const client = createHcClient({ binary: h.hcBinary, env: h.localEnv }); clients.push(client);
  const stream = client.events(); streams.push(stream); const seen: HcEvent[] = [];
  stream.subscribe(event => seen.push(event));
  expect(seen).toEqual([]);
  await stream.ready; await Promise.resolve();
  expect(seen).toMatchObject([{ type: 'snapshot', seq: 0, terminals: [{ address: 't1' }] }]);
  expect(seen).toHaveLength(1);
});

test('a late subscriber replays current terminals on the next microtask', async () => {
  const { h, stream } = await fixture();
  await h.emitCore({ type: 'created', seq: 1, terminal: 't2', data: terminal('t2') });
  await h.emitCore({ type: 'removed', seq: 2, terminal: 't1' });
  await expect.poll(() => stream.lookup(h.address('t2'))).toMatchObject({ address: 't2' });
  await expect.poll(() => stream.lookup(h.address('t1'))).toBeNull();
  const seen: HcEvent[] = [];
  stream.subscribe(event => seen.push(event));
  expect(seen).toEqual([]);
  await Promise.resolve();
  expect(seen).toEqual([{ type: 'snapshot', seq: 2, terminals: [{ address: 't2', parent: null, labels: {}, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null }] }]);
});

test('a replay precedes live events arriving in the same transport batch without duplicates', async () => {
  const { h, stream } = await fixture(); const seen: HcEvent[] = [];
  stream.subscribe(event => { if (event.type === 'created') stream.subscribe(event => seen.push(event)); });
  await h.emitCore([
    { type: 'created', seq: 1, terminal: 't2', data: terminal('t2') },
    { type: 'status', seq: 2, terminal: 't2', data: { status: { state: 'working' } } },
    { type: 'removed', seq: 3, terminal: 't1' },
    { type: 'removed', seq: 3, terminal: 't1' },
  ].map(event => JSON.stringify(event)).join('\n') + '\n');
  await expect.poll(() => stream.lookup(h.address('t1'))).toBeNull();
  expect(seen.map(event => [event.type, event.seq])).toEqual([['snapshot', 1], ['status', 2], ['removed', 3]]);
  expect(seen[0]).toMatchObject({ terminals: [{ address: 't1' }, { address: 't2', status: null }] });
});

test('disposing one view removes only its listeners and leaves another receiving events', async () => {
  const { h, client, stream: first } = await fixture(); const second = client.events(); streams.push(second);
  const firstSeen: HcEvent[] = [], secondSeen: HcEvent[] = [];
  first.subscribe(event => firstSeen.push(event)); second.subscribe(event => secondSeen.push(event));
  await Promise.resolve(); const before = firstSeen.slice();
  await first.dispose();
  await h.emitCore({ type: 'status', seq: 1, terminal: 't1', data: { status: { state: 'working' } } });
  await expect.poll(() => secondSeen.some(event => event.type === 'status')).toBe(true);
  expect(firstSeen).toEqual(before);
  expect(await second.lookup(h.address('t1'))).toMatchObject({ status: { state: 'working' } });
});

test('two independent views start exactly one lazy hc events process', async () => {
  const h = await createClientFixture(); fixtures.push(h);
  const client = createHcClient({ binary: h.hcBinary, env: h.localEnv }); clients.push(client);
  expect(await h.calls()).toEqual([]);
  const first = client.events(), second = client.events(); streams.push(first, second);
  await Promise.all([first.ready, second.ready]);
  expect((await h.calls()).map(call => call.argv)).toEqual([['events', '--json']]);
  expect(first).not.toBe(second);
});

test('disposing the client stops its events process even after every view is disposed', async () => {
  const { h, client, stream } = await fixture();
  const call = JSON.parse((await readFile(h.root + '/calls.jsonl', 'utf8')).trim()) as { pid: number };
  await stream.dispose();
  expect(() => process.kill(call.pid, 0)).not.toThrow();
  await client.dispose();
  expect(() => process.kill(call.pid, 0)).toThrow();
});

test('client disposal awaits the exit of a running events process', async () => {
  const { h, client } = await fixture();
  const call = JSON.parse((await readFile(h.root + '/calls.jsonl', 'utf8')).trim()) as { pid: number };
  expect(() => process.kill(call.pid, 0)).not.toThrow();
  await client.dispose();
  expect(() => process.kill(call.pid, 0)).toThrow();
});

test('missed replaces the materialized list for all views and subsequent subscribers', async () => {
  const { h, client, stream } = await fixture(); const second = client.events(); streams.push(second);
  const firstSeen: HcEvent[] = [], secondSeen: HcEvent[] = [];
  stream.subscribe(event => firstSeen.push(event)); second.subscribe(event => secondSeen.push(event));
  await h.emitCore({ type: 'missed', seq: 9, terminals: [h.finishedTerminal('t2', 23)] });
  await expect.poll(() => second.lookup(h.address('t2'))).toMatchObject({ state: 'finished', exitCode: 23 });
  expect(firstSeen.map(event => [event.type, event.seq])).toEqual([['snapshot', 0], ['missed', 9]]);
  expect(secondSeen).toEqual(firstSeen);
  const late: HcEvent[] = []; second.subscribe(event => late.push(event)); await Promise.resolve();
  expect(late).toMatchObject([{ type: 'snapshot', seq: 9, terminals: [{ address: 't2', state: 'finished', exitCode: 23 }] }]);
  expect(await second.lookup(h.address('t1'))).toBeNull();
});

test('a lost terminal retains loss metadata without inventing a completed command', async () => {
  const { h, stream } = await fixture();
  await h.emitCore({ type: 'lost', seq: 1, terminal: 't1', data: { exit_code: null, reason: 'signaled', signal: 9, finished_ms: null } });
  await expect.poll(() => stream.lookup(h.address('t1'))).toMatchObject({ state: 'live', reason: 'signaled', signal: 9, exitCode: null, finishedAt: null });
});

test('recovers a missed finish without launching again', async () => {
  const { h, stream } = await fixture();
  const received: string[] = []; stream.subscribe(event => received.push(event.type));
  await h.emitCore({ type: 'missed', seq: 9, terminals: [h.finishedTerminal('remote.invalid/t2', 23)] });
  await expect.poll(() => stream.lookup(h.address('remote.invalid/t2')), { timeout: 600 }).toMatchObject({ state: 'finished', exitCode: 23 });
  expect(received).toEqual(['snapshot', 'missed']);
  expect(await h.remoteLaunches()).toHaveLength(0);
});

// Generation hints below are synthetic future-schema coverage, not hc 0.1.16 output.
test('drops duplicate sequences and foreign generations', async () => {
  const { h, stream } = await fixture(); const received: number[] = []; stream.subscribe(e => received.push(e.seq));
  const event = (seq: number, state: string, generation?: string) => ({ jsonrpc: '2.0', method: 'event', params: { type: 'status', seq, generation, terminal: 't1', data: { status: { state } } } });
  await h.emitCore({ type: 'snapshot', seq: 1, generation: 'g1', terminals: [terminal('t1')] });
  await h.emitCore(event(2, 'working', 'g1'));
  await expect.poll(() => stream.lookup(h.address('t1'))).toMatchObject({ status: { state: 'working' } });
  await h.emitCore(event(2, 'done', 'g1')); await h.emitCore(event(3, 'error', 'foreign')); await h.emitCore(event(4, 'blocked', 'g1'));
  await expect.poll(() => stream.lookup(h.address('t1'))).toMatchObject({ status: { state: 'blocked' } });
  expect(received).toEqual([0, 1, 2, 4]);
});
test('a fast finished notification is retained before the launch reply', async () => {
  const { h, stream } = await fixture();
  await h.emitCore({ jsonrpc: '2.0', method: 'event', params: { type: 'created', seq: 1, terminal: 'remote.invalid/t2', data: terminal('remote.invalid/t2') } });
  await h.emitCore({ jsonrpc: '2.0', method: 'event', params: { type: 'finished', seq: 2, terminal: 'remote.invalid/t2', data: { exit_code: 23, reason: 'exited', signal: null, finished_ms: 4567 } } });
  await expect.poll(() => stream.lookup(h.address('remote.invalid/t2')), { timeout: 500 }).toMatchObject({ state: 'finished', exitCode: 23, finishedAt: 4567 });
});
test('lost, restarted, status and removal do not invent completion', async () => {
  const { h, stream } = await fixture(); const received: string[] = []; stream.subscribe(e => received.push(e.type));
  await h.emitCore({ jsonrpc: '2.0', method: 'event', params: { type: 'lost', seq: 1, terminal: 't1', data: { exit_code: null, reason: 'signaled', signal: 9, finished_ms: null } } });
  await h.emitCore({ jsonrpc: '2.0', method: 'event', params: { type: 'restarted', seq: 2, terminal: 't1', data: terminal('t1') } });
  await h.emitCore({ jsonrpc: '2.0', method: 'event', params: { type: 'status', seq: 3, terminal: 't1', data: { status: { state: 'done' } } } });
  await expect.poll(() => stream.lookup(h.address('t1'))).toMatchObject({ state: 'live', exitCode: null });
  await expect.poll(() => received).toEqual(['snapshot', 'lost', 'restarted', 'status']);
  await h.emitCore({ jsonrpc: '2.0', method: 'event', params: { type: 'removed', seq: 4, terminal: 't1', data: {} } });
  await expect.poll(() => stream.lookup(h.address('t1'))).toBeNull();
});
test('buffers partial event records until LF', async () => {
  const { h, stream } = await fixture();
  const line = JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'status', seq: 1, terminal: 't1', data: { status: { state: 'working', msg: 'α' } } } });
  await h.emitCore(line.slice(0, 12)); expect((await stream.lookup(h.address('t1')))?.status).toBeNull();
  await h.emitCore(line.slice(12) + '\n');
  await expect.poll(() => stream.lookup(h.address('t1'))).toMatchObject({ status: { msg: 'α' } });
});
test('steady fifteen-second heartbeats tolerate one second of delivery lag without respawning', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  const { h, stream } = await fixture(); const seen: HcEvent[] = [];
  stream.subscribe(event => seen.push(event)); await Promise.resolve();
  for (let heartbeat = 1; heartbeat <= 3; heartbeat++) {
    await vi.advanceTimersByTimeAsync(16000);
    // Give real child close/backoff I/O time to expose an erroneous respawn.
    await delay(400);
    expect((await h.calls()).filter(call => call.argv[0] === 'events')).toHaveLength(1);
    await h.emitCore({ jsonrpc: '2.0', method: 'heartbeat', params: { seq: 0 } });
    await expect.poll(() => seen.filter(event => event.type === 'heartbeat').length).toBe(heartbeat);
    expect(await stream.lookup(h.address('t1'))).toMatchObject({ state: 'live' });
  }
  expect(seen.filter(event => event.type === 'snapshot')).toHaveLength(1);
});

test('heartbeat timeout resubscribes once and reconciles the replacement snapshot', async () => {
  vi.useFakeTimers(); const { h, client, stream } = await fixture();
  const second = client.events(); streams.push(second);
  const firstSeen: HcEvent[] = [], secondSeen: HcEvent[] = [];
  stream.subscribe(event => firstSeen.push(event)); second.subscribe(event => secondSeen.push(event));
  await h.configure({ terminals: [h.finishedTerminal('t1', 17)] });
  await vi.advanceTimersByTimeAsync(31000); vi.useRealTimers();
  await expect.poll(async () => (await h.calls()).filter(c => c.argv[0] === 'events').length, { timeout: 1000 }).toBe(2);
  await expect.poll(() => stream.lookup(h.address('t1'))).toMatchObject({ state: 'finished', exitCode: 17 });
  expect(firstSeen.map(event => [event.type, event.seq])).toEqual([['snapshot', 0], ['snapshot', 0]]);
  expect(secondSeen).toEqual(firstSeen);
  const late: HcEvent[] = []; second.subscribe(event => late.push(event)); await Promise.resolve();
  expect(late).toMatchObject([{ type: 'snapshot', seq: 0, terminals: [{ address: 't1', state: 'finished', exitCode: 17 }] }]);
});
test('targets the owner IDs rather than the unrelated selected tab', async () => {
  const h = await createClientFixture(); fixtures.push(h);
  await writeFile(h.root + '/app.json', JSON.stringify({ spaces: [{ id: 's1', tabs: [{ id: 'other', active: true, terminals: [{ terminal: 't9', pane: 'p9' }] }, { id: 'owner', active: false, terminals: [{ terminal: 't1', pane: 'p1' }, { terminal: 't2', pane: 'p2' }] }] }] }));
  const app = createAppClient({ binary: h.appBinary, env: h.localEnv });
  expect(await app.ownerPlacement(h.address('t1'))).toEqual({ space: 's1', tab: 'owner', pane: 'p1' });
  expect(await app.awaitPane(h.address('t2'), { space: 's1' as SpaceId, tab: 'owner' as TabId, pane: 'p1' as PaneId }, { timeoutMs: 100 })).toBe('p2');
  await expect(app.awaitPane(h.address('t9'), { space: 's1' as SpaceId, tab: 'owner' as TabId, pane: 'p1' as PaneId }, { timeoutMs: 20 })).rejects.toMatchObject({ code: 'pane-timeout' });
});
test('disconnected or ambiguous layouts refuse placement and typed app errors survive', async () => {
  const h = await createClientFixture(); fixtures.push(h); const app = createAppClient({ binary: h.appBinary, env: h.localEnv });
  await expect(app.ownerPlacement(h.address('t1'))).rejects.toMatchObject({ code: 'owner-unplaced' });
  await writeFile(h.root + '/app.json', JSON.stringify({ error: 'Window unavailable' }));
  expect(await app.command('pane.focus', { terminal: 't1' })).toMatchObject({ error: { code: 'app-error', message: 'Window unavailable' } });
});
test('feed parser accepts closed nullable owners and rejects versions, statuses and oversized UTF-8', () => {
  expect(parseFeed(JSON.stringify(feed))).toMatchObject({ version: 1, lifecycle: 'closed', owner: { sessionFile: null }, status: { native: null } });
  expect(parseFeed(JSON.stringify({ ...feed, version: 2 }))).toBeNull();
  expect(parseFeed(JSON.stringify({ ...feed, status: { native: 'complete', effective: null, message: null } }))).toBeNull();
  expect(parseFeed(' '.repeat(1024 * 1024) + JSON.stringify(feed))).toBeNull();
  expect(parseFeed(JSON.stringify({ ...feed, owner: { ...feed.owner, sessionId: 'foreign' } }))).toBeNull();
});
const feed = {
  version: 1, sessionId: 'session', generation: 'g1', revision: 1, updatedAt: 100,
  owner: { sessionId: 'session', generation: 'g1', terminal: { coreId: 'core', terminalId: 't1', address: 't1', socket: '/isolated.sock', sessionNamespace: 'test' }, cwd: '/work', sessionFile: null, name: null },
  placement: { spaceId: 's1', spaceName: null, spaceOrder: null, tabId: null }, lifecycle: 'closed', status: { native: null, effective: null, message: null },
  runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [], approvals: [], notifications: [], ipc: null, errors: [],
  pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'No data' },
};

test('app command arguments use separate CLI flags with JSON only for structured values', async () => {
  const h = await createClientFixture(); fixtures.push(h);
  const app = createAppClient({ binary: h.appBinary, env: h.localEnv });
  await app.command('space.new', { name: 'a quoted name', argv: ['node', "a 'quoted' value"] });
  expect(JSON.parse((await readFile(h.root + '/app-calls.jsonl', 'utf8')).trim())).toEqual(['do', 'space.new', '--name', 'a quoted name', '--argv', '["node","a \'quoted\' value"]']);
});

test('a nonzero app command keeps its structured stdout refusal', async () => {
  const h = await createClientFixture(); fixtures.push(h);
  await writeFile(h.root + '/scenario.json', JSON.stringify({ appSteps: [{ argvPrefix: ['do'], reply: { error: 'Layout unavailable' }, exitCode: 1 }] }));
  expect(await createAppClient({ binary: h.appBinary, env: h.localEnv }).command('space.new', { name: 'Fixture' })).toMatchObject({ error: { code: 'app-error', message: 'Layout unavailable' } });
});
