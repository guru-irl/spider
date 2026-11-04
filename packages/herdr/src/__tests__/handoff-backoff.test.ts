// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { createJobStore } from '../jobs/store.js';
import { HerdrError } from '../client/parse.js';
import { monitorFixture, on, program } from './herdr-monitor-fixture.js';

const scans = vi.hoisted(() => ({ directory: '', count: 0 }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, readdir: (...args: Parameters<typeof fs.readdir>) => {
    if (args[0] === scans.directory) scans.count++;
    return fs.readdir(...args);
  } };
});

it('bounds handoff scans while an unavailable terminal release backs off', async () => {
  const h = await monitorFixture(), runId = 'backoff-child' as never;
  const child = h.monitor({ child: { id: runId, pid: process.pid, startIdentity: 'ended' } });
  const handle = await child.start(program, h.owner, on, { background: true });
  await child.detach(handle.id); h.complete(handle.address);
  await vi.waitFor(() => expect(h.notices).toHaveLength(1));
  await child.shutdown('reload');
  const store = createJobStore(h.f.root, h.owner.sessionId, runId), journal = await store.read();
  journal.child = { ...journal.child!, ended: true, settled: true };
  Object.assign(journal.jobs[0], { settledMarked: true, notice: 'observed', noticeDelivered: true, terminalReleased: false });
  await store.write(journal);
  scans.directory = store.directory.slice(0, store.directory.lastIndexOf('/')); scans.count = 0;
  h.hc.get = async () => { throw new HerdrError('unavailable', 'Machine is unavailable'); };
  const parent = h.monitor(); await parent.activate(h.owner);
  await vi.waitFor(async () => expect((await store.read()).jobs[0].cleanupFailure?.code).toBe('unavailable'));
  await vi.waitFor(() => expect(scans.count).toBeGreaterThanOrEqual(2), { timeout: 3000 });
  const initialScans = scans.count;
  await vi.waitFor(() => expect(scans.count).toBeGreaterThan(initialScans), { timeout: 3000 });
  scans.count = 0;
  await new Promise(resolve => setTimeout(resolve, 1000));
  expect(scans.count).toBeLessThanOrEqual(1);
  await vi.waitFor(() => expect(scans.count).toBeGreaterThanOrEqual(1), { timeout: 3000 });
});
