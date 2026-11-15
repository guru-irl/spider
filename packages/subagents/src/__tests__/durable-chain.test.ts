// SPDX-License-Identifier: MIT
import { afterEach, expect, test, vi } from 'vitest';
import { freshDb, testScratchPath } from './helpers/testutil';
import { Runner } from '../runner';
import { RunStore } from '../run-store';
import { RunEventTailer } from '../event-tailer';
import { runChain } from '../chain';
import { detachForReload, teardownAllAsync } from '../coordinators';
import { adoptReloadedChildren, makeRunHandler } from '../actions/run';
import { appendRunEvent } from '@spider/db-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

afterEach(() => teardownAllAsync());
test('handing over a durable chain stage stops its old continuation but delivers the real stage result', async () => {
  const db = freshDb(), store = new RunStore(db), tailer = new RunEventTailer(db);
  let finish!: (value: { exitCode: number; result: string }) => void;
  const exited = new Promise<{ exitCode: number; result: string }>(r => { finish = r; });
  let launches = 0;
  const runner = new Runner(db, 'planner', process.cwd(), { store, tailer, dbPath: db.raw.name, scratchRoot: testScratchPath('chain'),
    spawn: () => { launches++; return { durable: true, wait: () => exited, kill() {}, detach() {}, unbindEvents() {}, bindEvents() {} }; } });
  const chain = runChain(runner, [{ agent: 'worker', name: 'compile', task: 'first' }, { agent: 'worker', name: 'check', task: 'must not start' }, { agent: 'worker', name: 'summarize', task: 'must not start either' }], { task: '', context: 'fresh' }).catch(error => error);
  const first = store.listActive('planner')[0]!;
  await detachForReload('planner');
  const notices: any[] = [];
  adoptReloadedChildren({ db, sessionId: 'planner', cwd: process.cwd(), runDbPath: db.raw.name, pi: { sendMessage: (m: any) => notices.push(m) } });
  finish({ exitCode: 0, result: 'First stage finished' });
  await vi.waitFor(() => expect(notices).toHaveLength(1), { timeout: 10000 });
  expect(launches).toBe(1);
  expect(await chain).toBeInstanceOf(Error);
  expect(store.get(first.id)).toMatchObject({ status: 'done', result: 'First stage finished' });
  expect(notices).toHaveLength(1);
  expect(notices[0].content).toContain('/reload');
  expect(notices[0].content).toContain('did not start');
  expect(notices[0].content).toContain('"check"');
  expect(notices[0].content).toContain('"summarize"');
  expect(notices[0].details.output).toContain('First stage finished');
  expect(notices[0].details.chain).toMatchObject({ outcome: 'stopped', step: 1, total: 3, notStarted: ['check', 'summarize'] });
  await teardownAllAsync(); db.close();
});

// Break: completed step notices are delivered again on resume.
test('a completed chain delivers each step once and does not repeat on resume', async () => {
  const db = freshDb(), notices: any[] = [];
  const ctx = { db, sessionId: 'planner', cwd: process.cwd(), runDbPath: db.raw.name, pi: { sendMessage: (message: any) => notices.push(message) } };
  try {
    const run = makeRunHandler({ supervise: true, spawner: spec => {
      const launch = spec.supervisor!; mkdirSync(launch.directory, { recursive: true });
      appendRunEvent(db, { runId: launch.runId, sessionId: 'planner', ts: Date.now(), type: 'child_supervisor', payload: { version: 1, directory: launch.directory } });
      const exit = { exitCode: 0, result: 'Stage finished' };
      writeFileSync(join(launch.directory, 'exit.json'), JSON.stringify(exit));
      return { durable: true, wait: () => Promise.resolve(exit), kill() {}, detach() {} };
    } });
    await run({ chain: [{ agent: 'worker', task: 'first' }, { agent: 'worker', task: 'second' }] }, ctx);
    await vi.waitFor(() => expect(notices).toHaveLength(2), { timeout: 10000 });
    expect(notices.map(message => message.customType)).toEqual(['spider.subagent_done', 'spider.subagent_done']);
    expect(notices[0].details.runId).not.toBe(notices[1].details.runId);
    expect(notices[1].details.chain).toMatchObject({ outcome: 'complete', step: 2, total: 2, notStarted: [] });
    expect(notices[1].content).not.toContain('did not start');
    await adoptReloadedChildren(ctx); await new Promise(r => setTimeout(r, 50));
    expect(notices).toHaveLength(2);
  } finally { await teardownAllAsync(); db.close(); }
});
