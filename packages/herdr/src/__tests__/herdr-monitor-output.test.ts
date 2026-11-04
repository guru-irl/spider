// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { createJobStore } from '../jobs/store.js';
import { HerdrError } from '../client/parse.js';
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
  let calls = 0, collecting = false, observable = false;
  const events = h.hc.events, get = h.hc.get;
  h.hc.events = () => {
    const stream = events();
    return { ...stream, lookup: async address => !collecting || observable ? stream.lookup(address) : null };
  };
  h.hc.get = async address => { if (collecting && !observable) throw new HerdrError('core-unavailable', 'Fixture terminal lookup is unavailable'); return get(address); };
  const collect = h.options.outputCollector.collect;
  h.options.outputCollector.collect = async job => { calls++; collecting = true; await release.promise; return collect(job); };
  const timeout = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => timeout(callback, ms === 60000 ? 20 : ms, ...args)) as typeof setTimeout); cleanup(() => spy.mockRestore());
  const jobs = h.monitor(), handle = await jobs.start(program, h.owner, on, {});
  try {
    await expect.poll(() => h.errors.length).toBe(1);
    expect(h.errors[0]).toMatchObject({ code: 'output-unavailable' });
    observable = true; h.complete(handle.address);
    await expect(bounded(handle.finished)).resolves.toMatchObject({ reason: 'unknown' });
    expect(calls).toBe(1); expect(h.errors).toHaveLength(1);
  } finally { observable = true; release.resolve(); await jobs.reconcile(); }
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


it.each([0, 60])('complete output does not wait for a stalled liveness lookup after %i ms', async waitMs => {
  const h = await monitorFixture(), release = deferred(), delivered = deferred();
  const timeout = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => timeout(callback, ms === 60000 ? 20 : ms, ...args)) as typeof setTimeout);
  cleanup(() => spy.mockRestore());
  let collecting = false;
  const events = h.hc.events;
  h.hc.events = () => {
    const stream = events();
    return { ...stream, lookup: async address => { if (collecting) await release.promise; return stream.lookup(address); } };
  };
  h.options.outputCollector.collect = async job => {
    collecting = true;
    if ('address' in job.phase) { const address = job.phase.address; setImmediate(() => { h.complete(address); delivered.resolve(); }); }
    await delivered.promise;
    if (waitMs) await delay(waitMs);
    return { complete: true, summary: 'job output', receipt: { jobId: job.id, nonce: 'nonce', finish } };
  };
  const jobs = h.monitor();
  try {
    const handle = await jobs.start(program, h.owner, on, {});
    await expect(bounded(handle.finished)).resolves.toEqual(finish);
    expect(h.errors).toEqual([]);
  } finally { release.resolve(); }
});


it('a later live snapshot renews a collection that began without one', async () => {
  const h = await monitorFixture(), release = deferred();
  let collecting = false, lookup = 0;
  const events = h.hc.events, collect = h.options.outputCollector.collect;
  h.hc.events = () => {
    const stream = events();
    return { ...stream, lookup: async address => collecting && lookup++ === 0 ? null : stream.lookup(address) };
  };
  h.options.outputCollector.collect = async job => { collecting = true; await release.promise; return collect(job); };
  const timeout = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => timeout(callback, ms === 60000 ? 20 : ms, ...args)) as typeof setTimeout);
  cleanup(() => spy.mockRestore());
  const jobs = h.monitor(), handle = await jobs.start(program, h.owner, on, {});
  try {
    expect(await Promise.race([handle.finished, delay(80).then(() => null)])).toBeNull();
    expect(h.errors).toEqual([]);
    h.complete(handle.address); release.resolve();
    await expect(bounded(handle.finished)).resolves.toEqual(finish);
  } finally { release.resolve(); }
});


it('a rejected output read settles once even while its terminal remains live', async () => {
  const h = await monitorFixture(), events = h.hc.events;
  let lookups = 0;
  h.hc.events = () => {
    const stream = events();
    return { ...stream, lookup: async address => { lookups++; await delay(1); return stream.lookup(address); } };
  };
  h.options.outputCollector.collect = async () => { throw new HerdrError('output-unavailable', 'Fixture output read was rejected'); };
  const jobs = h.monitor(), handle = await jobs.start(program, h.owner, on, {});
  try {
    await expect(bounded(handle.finished)).resolves.toMatchObject({ reason: 'unknown' });
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toMatchObject({ code: 'output-unavailable' });
    const settled = lookups; await delay(30);
    expect(lookups).toBe(settled);
  } finally { await jobs.shutdown('reload'); }
});
