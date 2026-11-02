// SPDX-License-Identifier: MIT
import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { openDbAt } from '@spider/db-core';
import { RunStore } from '../../../subagents/src/run-store.js';
import { runViewer, type ViewerOptions } from '../viewers/program.js';
import type { RunId, RunSummary, RunViewFrame, SessionFeed } from '../contracts.js';

afterEach(() => vi.useRealTimers());

test('a viewer whose owner closes exits after its still-running run finishes', async () => {
  await mkdir(resolve('.spider/scratch/vo'), { recursive: true });
  const root = await mkdtemp(resolve('.spider/scratch/vo/test-'));
  const dbPath = join(root, 'runs.db'), db = openDbAt(dbPath, 'worktree'), store = new RunStore(db);
  const sessionId = 'owner' as SessionFeed['sessionId'];
  const runId = store.create({ sessionId, agent: 'worker' }).id as RunId; store.start(runId);
  const run: RunSummary = { id: runId, ownerSessionId: sessionId, name: null, status: 'running', childMode: 'rpc', canSteer: true, startedAt: 1, finishedAt: null, viewer: null, result: null };
  let feed: SessionFeed = { version: 1, sessionId, generation: 'activation' as SessionFeed['generation'], revision: 1, updatedAt: 1,
    owner: { sessionId, generation: 'activation', terminal: { coreId: 'core', terminalId: 'owner', address: 'owner', socket: '/fixture/core.sock', sessionNamespace: 'fixture' }, cwd: root, sessionFile: null, name: null } as SessionFeed['owner'],
    lifecycle: 'live', placement: null, status: { native: 'working', effective: 'working', message: null }, runs: { rows: [run], total: 1, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [], approvals: [], notifications: [], errors: [],
    pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' },
    ipc: { address: '/fixture/ipc', capabilityFile: '/fixture/cap' } };
  let changed = () => {}, emit!: (frame: RunViewFrame) => void, exited = false;
  const abort = new AbortController();
  vi.useFakeTimers();
  const opts = { runId, sessionId, feedRoot: root, runDbPath: dbPath, initialStatus: 'running', intent: 'automatic', stdin: new PassThrough(), stdout: new PassThrough(), signal: abort.signal,
    wait: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    feedSource: { read: async () => feed, subscribe: (listener: () => void) => { changed = listener; return () => {}; } },
    createClient: () => ({ subscribeRun: async (_id: RunId, _cursor: unknown, listener: (frame: RunViewFrame) => void) => {
      emit = listener; return { closed: new Promise<void>(() => {}), dispose() {} };
    } }),
  } as ViewerOptions;
  const running = runViewer(opts).then(() => { exited = true; });
  try {
    await vi.advanceTimersByTimeAsync(1);
    emit({ kind: 'snapshot', runId, cursor: 'one' as never, data: { run } });
    feed = { ...feed, revision: 2, lifecycle: 'closed', ipc: null }; changed();
    await vi.advanceTimersByTimeAsync(1000);
    expect(exited).toBe(false);
    expect(store.finish(runId, { status: 'done' })).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(exited).toBe(false);
    await vi.advanceTimersByTimeAsync(1600);
    expect(exited).toBe(true);
  } finally { abort.abort(); await running; db.close(); vi.useRealTimers(); await rm(root, { recursive: true, force: true }); }
});

test.each(['saved', 'other-session'] as const)('a final row does not close a %s viewer', async scenario => {
  await mkdir(resolve('.spider/scratch/vo'), { recursive: true });
  const root = await mkdtemp(resolve('.spider/scratch/vo/test-'));
  const dbPath = join(root, 'runs.db'), db = openDbAt(dbPath, 'worktree'), store = new RunStore(db);
  const runId = store.create({ sessionId: 'owner', agent: 'worker' }).id as RunId;
  store.start(runId); store.finish(runId, { status: 'done' });
  const abort = new AbortController(); let exited = false;
  vi.useFakeTimers();
  const running = runViewer({ runId, sessionId: (scenario === 'saved' ? 'owner' : 'other') as SessionFeed['sessionId'], feedRoot: root, runDbPath: dbPath,
    intent: scenario === 'saved' ? 'explicit' : 'automatic', initialStatus: scenario === 'saved' ? 'done' : 'running', stdin: new PassThrough(), stdout: new PassThrough(), signal: abort.signal,
    wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
    feedSource: { read: async () => null, subscribe: () => () => {} },
    createClient: () => ({ subscribeRun: async () => { throw new Error('No owner'); } }),
  }).then(() => { exited = true; });
  try { await vi.advanceTimersByTimeAsync(5000); expect(exited).toBe(false); }
  finally { abort.abort(); await running; db.close(); vi.useRealTimers(); await rm(root, { recursive: true, force: true }); }
});
