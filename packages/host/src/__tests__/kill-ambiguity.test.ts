// SPDX-License-Identifier: MIT
import { afterEach, expect, test } from 'vitest';
import { openDbAt } from '@spider/db-core';
import { RunStore, makeKillHandler, registerChild, teardownAllAsync } from '@spider/subagents';
import { randomUUID } from 'node:crypto';
import { testScratchPath } from './testutil.js';
import { routeKillAction } from '../herdr/kill-job.js';
import { HerdrError } from '@spider/herdr/client/parse';

const close: Array<() => void> = [];
afterEach(async () => { await teardownAllAsync(); for (const fn of close.splice(0)) fn(); });
function fixture(names: string[], jobs: string[]) {
  const db = openDbAt(testScratchPath(`kill-${randomUUID()}.db`), 'project'); close.push(() => db.close());
  const store = new RunStore(db);
  const runs = names.map(name => { const { id } = store.create({ sessionId: 'planner', agent: 'worker', name, task: 'work' }); store.start(id); return id; });
  for (const id of runs) registerChild('planner', id, { wait: () => new Promise(() => {}), kill() {}, detach() {} });
  const stopped: string[] = [];
  const mount = { enabled: () => true,
    findKillJobs: async (prefix: string) => jobs.filter(id => id.startsWith(prefix)).map(id => ({ id })),
    killJob: async (id: string) => {
      const matches = jobs.filter(job => job.startsWith(id));
      if (!matches.length) throw new HerdrError('job-not-owned', 'No active job owned by this session');
      if (matches.length > 1) throw new HerdrError('job-ambiguous', 'Job ID prefix matches more than one owned job');
      stopped.push(matches[0]);
      return { jobId: matches[0], machine: 'alpha.invalid', address: 'alpha.invalid/job', state: 'cancellation-requested' as const };
    },
  };
  const action = routeKillAction(() => mount as never, makeKillHandler());
  return { db, store, runs, stopped, kill: (id: string) => action({ action: 'kill', id }, { db, sessionId: 'planner' } as never) as Promise<any> };
}

test.each([
  { names: ['alpha-build', 'alpha-check'], jobs: [], matches: ['alpha-build', 'alpha-check'] },
  { names: [], jobs: ['alpha-one', 'alpha-two'], matches: ['alpha-one', 'alpha-two'] },
  { names: ['alpha-build'], jobs: ['alpha-job'], matches: ['alpha-build', 'alpha-job'] },
])('an ambiguous prefix lists all matches and stops none ($matches)', async ({ names, jobs, matches }) => {
  const f = fixture(names, jobs), result = await f.kill('alpha');
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/ambiguous/i);
  for (const match of matches) expect(result.content).toContain(match);
  expect(f.stopped).toEqual([]);
  expect(f.store.listActive('planner')).toHaveLength(names.length);
});

test('an exact run name wins over a job prefix', async () => {
  const f = fixture(['alpha'], ['alpha-job']);
  await f.kill('alpha');
  expect(f.stopped).toEqual([]);
  expect(f.store.get(f.runs[0])!.status).toBe('cancelled');
});

test('an exact job id wins over a run-name prefix', async () => {
  const f = fixture(['alpha-build'], ['alpha']);
  expect(await f.kill('alpha')).toMatchObject({ details: { job: { jobId: 'alpha' } } });
  expect(f.stopped).toEqual(['alpha']);
  expect(f.store.get(f.runs[0])!.status).toBe('running');
});

test('duplicate exact run names are ambiguous', async () => {
  const f = fixture(['alpha', 'alpha'], []);
  expect(await f.kill('alpha')).toMatchObject({ isError: true, content: expect.stringMatching(/ambiguous/i) });
  expect(f.store.listActive('planner')).toHaveLength(2);
});
