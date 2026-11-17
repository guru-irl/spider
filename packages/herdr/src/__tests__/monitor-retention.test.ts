// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { createJobStore } from '../jobs/store.js';
import { finish, monitorFixture, on, program } from './herdr-monitor-fixture.js';

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
