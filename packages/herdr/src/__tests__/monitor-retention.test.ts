// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { createJobStore } from '../jobs/store.js';
import { deferred, finish, monitorFixture, on, program } from './herdr-monitor-fixture.js';

it('forgets original-terminal evidence when completed jobs expire', async () => {
  const h = await monitorFixture(); h.early();
  let now = 1000;
  const monitor = h.monitor({ clock: () => now });
  const store = createJobStore(h.f.root, h.owner.sessionId);
  const sets: Set<unknown>[] = [], add = Set.prototype.add;
  // Observe retained keys at the collection boundary without adding test APIs.
  const spy = vi.spyOn(Set.prototype, 'add').mockImplementation(function (this: Set<unknown>, value: unknown) {
    if (typeof value === 'string' && value.startsWith('remote.invalid/t') && !sets.includes(this)) sets.push(this);
    return add.call(this, value);
  });
  const retained: number[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      const handle = await monitor.start(program, h.owner, on, {});
      await handle.finished; await monitor.consumeNotice(handle.id); await monitor.toolReturned(handle.id); await monitor.finishCleanup();
      h.emit({ type: 'lost', terminal: handle.address, data: finish, seq: 3 }); await monitor.reconcile();
      expect(sets.filter(set => set.has(handle.address))).toHaveLength(2);
      now += 8 * 86400000;
      await monitor.reconcile();
      await expect.poll(async () => (await store.read()).jobs.length).toBe(0);
      retained.push(sets.reduce((sum, set) => sum + set.size, 0));
    }
    expect(retained).toEqual([0, 0, 0]);
    expect(h.errors).toEqual([]);
  } finally { await monitor.shutdown('reload'); spy.mockRestore(); }
});

it('does not remove a lost terminal when its release outlives the job', async () => {
  const h = await monitorFixture(); h.early();
  let now = 1000;
  const monitor = h.monitor({ clock: () => now });
  const store = createJobStore(h.f.root, h.owner.sessionId);
  const blocked = deferred(), entered = deferred();
  try {
    const job = await monitor.start(program, h.owner, on, {});
    await job.finished; await monitor.consumeNotice(job.id); await monitor.toolReturned(job.id);
    const get = h.hc.get;
    h.hc.get = async (...args) => { entered.resolve(); await blocked.promise; return get(...args); };
    const remove = vi.spyOn(h.hc, 'rm');
    const cleanup = monitor.finishCleanup();
    await entered.promise;
    h.emit({ type: 'lost', terminal: job.address, data: finish, seq: 5 });
    now += 8 * 86400000;
    await monitor.consumeNotice(job.id);
    await expect.poll(async () => (await store.read()).jobs.length).toBe(0);
    blocked.resolve(); await cleanup;
    expect(remove).not.toHaveBeenCalled();
    expect(h.terminals.has(job.address)).toBe(true);
    expect(h.errors).toEqual([]);
  } finally { blocked.resolve(); await monitor.shutdown('reload'); }
});

it('finishes a valid release after its job is pruned', async () => {
  const h = await monitorFixture(); h.early();
  let now = 1000;
  const monitor = h.monitor({ clock: () => now });
  const store = createJobStore(h.f.root, h.owner.sessionId);
  const blocked = deferred(), entered = deferred();
  try {
    const job = await monitor.start(program, h.owner, on, {});
    await job.finished; await monitor.consumeNotice(job.id); await monitor.toolReturned(job.id);
    const get = h.hc.get;
    h.hc.get = async (...args) => { entered.resolve(); await blocked.promise; return get(...args); };
    const cleanup = monitor.finishCleanup();
    await entered.promise;
    now += 8 * 86400000;
    await monitor.consumeNotice(job.id);
    await expect.poll(async () => (await store.read()).jobs.length).toBe(0);
    blocked.resolve(); await cleanup;
    expect(h.terminals.has(job.address)).toBe(false);
    expect(h.errors).toEqual([]);
  } finally { blocked.resolve(); await monitor.shutdown('reload'); }
});

it('keeps lost-terminal evidence while another job uses the pruned address', async () => {
  const h = await monitorFixture(); h.early();
  let now = 1000;
  const monitor = h.monitor({ clock: () => now });
  const store = createJobStore(h.f.root, h.owner.sessionId);
  try {
    const first = await monitor.start(program, h.owner, on, {});
    await first.finished; await monitor.consumeNotice(first.id); await monitor.toolReturned(first.id); await monitor.finishCleanup();
    h.hc.run = async request => {
      const terminal = { address: first.address, parent: h.owner.terminal.address, labels: request.labels, state: 'live' as const,
        status: null, exitCode: null, reason: null, signal: null, finishedAt: null };
      h.terminals.set(first.address, terminal);
      h.emit({ type: 'created', terminal: first.address, data: terminal, seq: 4 });
      return { address: first.address, coreId: 'remote-core' as never };
    };
    const second = await monitor.start(program, h.owner, on, {});
    expect(second.address).toBe(first.address);
    h.emit({ type: 'lost', terminal: first.address, data: finish, seq: 5 });
    await expect(second.cancel()).rejects.toMatchObject({ code: 'job-outcome-unknown' });
    now += 8 * 86400000;
    await monitor.toolReturned(second.id);
    await expect.poll(async () => (await store.read()).jobs.map(job => job.id)).toEqual([second.id]);
    await expect(second.cancel()).rejects.toMatchObject({ code: 'job-outcome-unknown' });
    expect(h.kills).toEqual([]);
    expect(h.errors).toEqual([]);
  } finally { await monitor.shutdown('reload'); }
});
