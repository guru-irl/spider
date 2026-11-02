// SPDX-License-Identifier: MIT
import { expect, test, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendRunEvent } from '@spider/db-core';
import { freshDb, testScratchPath } from './helpers/testutil';
import { RunStore } from '../run-store';
import { diagnoseDurableChildren } from '../durable-adoption';
import { adoptReloadedChildren } from '../actions/run';
import { registerShared, resetSharedRegistryForTests, killSharedEntry } from '../child-registry';
import { recordRunUsage } from '../usage';
import { teardownAllAsync } from '../coordinators';

test('doctor reads the open current database even when its logical path is not a physical file', () => {
  const db = freshDb(), store = new RunStore(db);
  try {
    const { id } = store.create({ sessionId: 'planner', agent: 'worker', task: 'still running' });
    store.start(id);
    const directory = testScratchPath(`missing-supervisor-${id}`);
    appendRunEvent(db, { runId: id, sessionId: 'planner', ts: Date.now(), type: 'child_supervisor', payload: { version: 1, directory } });
    const notes = diagnoseDurableChildren({ db, sessionId: 'planner', runDbPath: testScratchPath(`logical-${id}.db`) });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ runId: id, supervisor: 'unreadable', child: 'unknown' });
  } finally { db.close(); }
});

test('a failed durable adoption says the run keeps running, not that a reload timer will stop it', async () => {
  const db = freshDb(), store = new RunStore(db), notify = vi.fn();
  let finish!: (exit: { exitCode: number }) => void;
  const exit = new Promise<{ exitCode: number }>(resolve => { finish = resolve; });
  try {
    const { id } = store.create({ sessionId: 'planner', agent: 'worker', task: 'still running' }); store.start(id);
    const entry = registerShared({ sessionId: 'planner', runId: id, dbPath: db.raw.name, mode: 'rpc', survivable: true,
      handle: { durable: true, wait: () => exit, kill: () => finish({ exitCode: 130 }), killAsync: async () => finish({ exitCode: 130 }),
        bindEvents: () => { throw new Error('fixture event binding failed'); }, unbindEvents() {} } });
    entry.state = 'independent';
    adoptReloadedChildren({ db, sessionId: 'planner', cwd: process.cwd(), runDbPath: db.raw.name, ui: { notify } });
    expect(notify.mock.calls[0][0]).toContain('keeps running independently');
    expect(entry.state).toBe('independent');
    expect(entry.timer).toBeUndefined();
  } finally { await teardownAllAsync(); resetSharedRegistryForTests(); db.close(); }
});

test('disposing a released supervisor does not persist its already-saved usage twice', async () => {
  const db = freshDb(), store = new RunStore(db);
  let finish!: (exit: { exitCode: number }) => void;
  const exit = new Promise<{ exitCode: number }>(resolve => { finish = resolve; });
  try {
    const { id } = store.create({ sessionId: 'planner', agent: 'worker', task: 'still running' }); store.start(id);
    const usage = { provider: 'fixture', model: 'scripted', usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    recordRunUsage(db, id, usage);
    const entry = registerShared({ sessionId: 'planner', runId: id, dbPath: db.raw.name, mode: 'rpc', survivable: true,
      handle: { durable: true, wait: () => exit, kill: () => finish({ exitCode: 130 }), killAsync: async () => finish({ exitCode: 130 }),
        bindEvents: sink => sink({ type: 'spider_usage', ...usage, spiderDurablePersisted: true }), unbindEvents() {} } });
    entry.state = 'independent';
    await killSharedEntry(entry, 'Session explicitly stopped.');
    expect((db.prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id=? AND type='spider_usage'").get(id) as { n: number }).n).toBe(1);
    expect(store.get(id)?.token_count).toBe(5);
  } finally { resetSharedRegistryForTests(); db.close(); }
});

// Break caught: historical pids reused by an unrelated process looked like supervisor leaks.
test('doctor does not mistake reused pids for a surviving completed run', () => {
  const db = freshDb(), store = new RunStore(db);
  try {
    const { id } = store.create({ sessionId: 'planner', agent: 'worker', task: 'already finished' });
    store.start(id); store.finish(id, { status: 'done', result: 'Finished' });
    const directory = testScratchPath(`diagnostic-${id}`); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'state.json'), JSON.stringify({ version: 1, directory, runId: id, dbPath: db.raw.name, sessionId: 'planner', token: 'fixture-only', socket: join(directory, 's'),
      supervisorPid: process.pid, supervisorStartTime: 'a different process identity', childPid: process.pid, childStartTime: 'a different process identity' }));
    appendRunEvent(db, { runId: id, sessionId: 'planner', ts: Date.now(), type: 'child_supervisor', payload: { version: 1, directory } });
    expect(diagnoseDurableChildren({ db, sessionId: 'planner' })).toEqual([]);
  } finally { db.close(); }
});
