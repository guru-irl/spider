// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { createJobStore } from '../jobs/store.js';
import { setTimeout as delay } from 'node:timers/promises';
import { bounded, cleanup, deferred, finish, monitorFixture, on, program } from './herdr-monitor-fixture.js';

it('collects output slower than event readiness without a warning or a stuck finished job', async () => {
  const h = await monitorFixture(); h.early();
  const collect = h.options.outputCollector.collect;
  h.options.outputCollector.collect = async job => { await delay(2500); return collect(job); };
  const jobs = h.monitor();
  const handle = await jobs.start(program, h.owner, on, {});
  await expect(bounded(handle.finished, 4000)).resolves.toEqual(finish);
  expect(h.errors).toEqual([]);
}, 12000);

it('a remote collection cannot hold the writer or launch another collection for the same job', async () => {
  const h = await monitorFixture(), entered = deferred(), release = deferred();
  const collect = h.options.outputCollector.collect;
  let first: string | undefined, calls = 0;
  h.options.outputCollector.collect = async job => {
    first ??= job.id;
    if (job.id === first) { calls++; entered.resolve(); await release.promise; }
    return collect(job);
  };
  const jobs = h.monitor();
  const starting = jobs.start(program, h.owner, on, {});
  await entered.promise;
  try {
    const firstHandle = await bounded(starting);
    const second = await bounded(jobs.start(program, h.owner, on, {}));
    expect(second.id).not.toBe(firstHandle.id);
    const reconcile = jobs.reconcile();
    await delay(50);
    expect(calls).toBe(1);
    release.resolve(); await reconcile;
  } finally { release.resolve(); await starting; }
});

it('an unavailable finished job releases its foreground waiter and warns at most once', async () => {
  const h = await monitorFixture(); h.early();
  h.options.outputCollector.collect = async () => { throw new Error('unavailable output'); };
  const jobs = h.monitor(), handle = await jobs.start(program, h.owner, on, {});
  await jobs.reconcile(); await jobs.reconcile();
  await expect(bounded(handle.finished)).resolves.toMatchObject({ reason: 'unknown' });
  expect(h.errors).toHaveLength(1);
});

it('a job finishing after an expired in-flight read still releases its waiter and accepts the late receipt', async () => {
  const h = await monitorFixture(), release = deferred();
  let calls = 0;
  const collect = h.options.outputCollector.collect;
  h.options.outputCollector.collect = async job => { calls++; await release.promise; return collect(job); };
  const timeout = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => timeout(callback, ms === 60000 ? 20 : ms, ...args)) as typeof setTimeout); cleanup(() => spy.mockRestore());
  const jobs = h.monitor(), handle = await jobs.start(program, h.owner, on, {});
  await expect.poll(() => h.errors.length).toBe(1);
  h.complete(handle.address);
  try {
    await expect(bounded(handle.finished)).resolves.toMatchObject({ reason: 'unknown' });
    expect(calls).toBe(1); expect(h.errors).toHaveLength(1);
  } finally { release.resolve(); await jobs.reconcile(); }
  await expect.poll(async () => (await createJobStore(h.f.root, h.owner.sessionId).read()).jobs[0].phase.kind).toBe('finished');
});

it('overlapping reconciliation requests coalesce instead of queuing extra passes', async () => {
  const h = await monitorFixture();
  const entered = deferred(), release = deferred(); let calls = 0, block = false;
  h.options.observedJobMessages = async () => { if (block) { calls++; entered.resolve(); await release.promise; } return []; };
  const jobs = h.monitor(); await jobs.activate(h.owner); block = true;
  const first = jobs.reconcile(); await entered.promise;
  const second = jobs.reconcile(), third = jobs.reconcile();
  release.resolve(); await Promise.all([first, second, third]);
  expect(calls).toBe(1);
});
