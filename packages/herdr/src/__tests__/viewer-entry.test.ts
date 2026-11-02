// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startSessionEndpoint } from '../feed/ipc-server.js';
import { openDbAt } from '@spider/db-core';
import { RunStore } from '../../../subagents/src/run-store.js';
import { publishSessionFeed } from '../feed/publisher.js';
import type { Owner, RunCursor, RunId, RunSummary, SessionFeed } from '../contracts.js';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const plain = (text: string) => text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
async function fixture() {
  const root = resolve('.spider/scratch/ve', randomBytes(3).toString('hex')); await mkdir(root, { recursive: true });
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const owner = { sessionId: 'owner', generation: 'activation', name: 'planner', cwd: root, sessionFile: null,
    terminal: { coreId: 'core', terminalId: 'terminal', address: 'terminal', socket: join(root, 'core.sock'), sessionNamespace: 'fixture' } } as Owner;
  const id = '10000000-0000-4000-8000-000000000001' as RunId;
  const run: RunSummary = { id, ownerSessionId: owner.sessionId, name: 'repair retry', status: 'running', childMode: 'rpc', canSteer: true, startedAt: 1, finishedAt: null, viewer: null, result: null };
  const sessionFile = join(root, 'child.jsonl');
  await writeFile(sessionFile, [
    { type: 'session', version: 3, id, cwd: root },
    { type: 'message', id: 'u1', parentId: null, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'REPLAY_TASK', timestamp: 1 } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'REPLAY_**MARKDOWN**' }], api: 'example', provider: 'example', model: 'model-one', thinkingLevel: 'high', stopReason: 'stop', timestamp: 2,
      usage: { input: 1234, output: 22, cacheRead: 0, cacheWrite: 0, totalTokens: 1256, cost: { total: 0 } } } },
  ].map(entry => JSON.stringify(entry) + '\n').join(''));
  const endpoint = await startSessionEndpoint(owner, {
    currentOwner: () => owner, liveCapabilities: () => null, ownsRun: () => true,
    subscribeRun: (_id, _cursor, emit, options) => {
      emit({ runId: id, cursor: 'one' as RunCursor, kind: 'snapshot', data: { run, ...(options?.view ? { view: { protocol: 2, sessionFile } } : {}) } });
      return { dispose() {} };
    }, steerRun: () => ({ accepted: true, delivered: false, queued: true, delivery: 'accepted but not confirmed' }),
    ownsJob: () => false, openJob: () => null, openView() {}, openRun: () => null,
  }, root);
  cleanups.push(() => endpoint.dispose());
  const feed: SessionFeed = { version: 1, sessionId: owner.sessionId, generation: owner.generation, revision: 1, updatedAt: Date.now(), owner, lifecycle: 'live', placement: null,
    status: { native: null, effective: null, message: null }, runs: { rows: [run], total: 1, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [], approvals: [], notifications: [], errors: [],
    pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' },
    ipc: { address: endpoint.descriptor.address, capabilityFile: endpoint.descriptor.capabilityFile } };
  await publishSessionFeed(root, feed);
  const launch = (env: Record<string, string> = {}, args: string[] = []) => {
    const child = spawn(process.execPath, [resolve('dist/herdr/viewer.mjs'), '--feed-root', root, '--session', owner.sessionId, '--run', id, ...args], {
      env: { ...process.env, ...env, COLUMNS: '120', LINES: '40', PI_PROGRAM_STATUS: '0' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', error = ''; child.stdout.on('data', data => { output += data.toString(); }); child.stderr.on('data', data => { error += data.toString(); });
    cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); } });
    return { child, output: () => plain(output), error: () => error };
  };
  return { launch, root, owner, id, endpoint, feed };
}

test('the actual viewer entry renders the saved task and markdown with a pi footer', async () => {
  const f = await fixture(); const viewer = f.launch();
  await vi.waitFor(() => expect(viewer.output()).toContain('REPLAY_TASK'), { timeout: 5000 });
  expect(viewer.output()).toContain('REPLAY_MARKDOWN');
  expect(viewer.output()).not.toContain('**MARKDOWN**');
  expect(viewer.output()).toContain('repair retry'); expect(viewer.output()).toContain('planner');
  expect(viewer.output()).toContain('↑1.2k'); expect(viewer.output()).toContain('model-one');
  expect(viewer.error()).toBe('');
});

test('the built viewer exits when its owner closes before the run finishes', async () => {
  const f = await fixture(), dbPath = join(f.root, 'runs.db'), db = openDbAt(dbPath, 'worktree'), store = new RunStore(db);
  const created = store.create({ sessionId: f.owner.sessionId, agent: 'worker' }).id;
  db.prepare('UPDATE runs SET id=? WHERE id=?').run(f.id, created); store.start(f.id);
  const viewer = f.launch({ SPIDER_VIEWER_PI_ROOT: '/missing/pi' }, ['--run-db', dbPath, '--intent', 'automatic', '--initial-status', 'running']);
  try {
    await vi.waitFor(() => expect(viewer.output()).toContain('[running · rpc]'), { timeout: 5000 });
    await f.endpoint.dispose();
    await publishSessionFeed(f.root, { ...f.feed, revision: 2, lifecycle: 'closed', ipc: null });
    await vi.waitFor(() => expect(viewer.output()).toContain('Owning session closed.'), { timeout: 5000 });
    expect(viewer.child.exitCode).toBeNull();
    expect(store.finish(f.id, { status: 'done' })).toBe(true);
    await vi.waitFor(() => expect(viewer.child.exitCode).toBe(0), { timeout: 7000 });
  } finally { db.close(); }
}, 15000);

test('a missing host pi falls back to text once instead of crashing on a static peer import', async () => {
  const f = await fixture(); const viewer = f.launch({ SPIDER_VIEWER_PI_ROOT: '/missing/pi' });
  await vi.waitFor(() => expect(viewer.output()).toContain('Pi view unavailable.'), { timeout: 5000 });
  expect(viewer.output().match(/Pi view unavailable\./g)).toHaveLength(1);
  await vi.waitFor(() => expect(viewer.output()).toContain('[running · rpc]'), { timeout: 5000 });
  expect(viewer.child.exitCode).toBeNull();
});
