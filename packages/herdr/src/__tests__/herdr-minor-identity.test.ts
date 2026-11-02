// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import { createJobStore } from '../jobs/store.js';
import { prepareJobRecovery, reconcileJobRecovery } from '../jobs/handoff.js';
import { monitorFixture, on, program } from './herdr-monitor-fixture.js';

it('unknown live-writer identity preserves foreground jobs and retries on reconciliation', async () => {
  const h = await monitorFixture(), previous = h.monitor();
  const foreground = await previous.start(program, h.owner, on, {});
  await previous.shutdown('reload');
  const store = createJobStore(h.f.root, h.owner.sessionId), journal = await store.read();
  journal.writer = { pid: process.pid, startIdentity: 'previous-writer', shutdown: null };
  let identity: string | null = null;
  let reads = 0;
  const readIdentity = async () => { reads++; return identity; };
  await prepareJobRecovery(journal, false, false, readIdentity);
  const options = { hc: h.hc, discovered: new Map(), clock: () => 1000, persist: async () => { await store.write(journal); }, reportError: (error: unknown) => { throw error; } };
  await reconcileJobRecovery(journal, options);
  expect(h.kills).toEqual([]);
  expect(journal.writer?.crashJobs).toBeUndefined();
  expect(journal.jobs[0].phase.kind).toBe('running');
  identity = 'replacement-writer';
  await reconcileJobRecovery(journal, options);
  expect(h.kills).toEqual([foreground.address]);
  expect(journal.jobs[0].phase).toMatchObject({ kind: 'finished', result: { reason: 'cancelled' } });
  expect(reads).toBe(3);
  await reconcileJobRecovery(journal, options);
  expect(h.kills).toEqual([foreground.address]);
  expect(reads).toBe(3);
});
