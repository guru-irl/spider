// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import type { JournalJob } from '../jobs/store.js';
import { bounded, cleanup, deferred, monitorFixture, on, program } from './herdr-monitor-fixture.js';

it('retries fast missing-receipt reads after native finish and settles unknown only at the collection bound', async () => {
  // Resolving unknown on the first incomplete read skips the receipt collection budget.
  const f = await monitorFixture(), nativeRead = deferred(); let reads = 0;
  const timeout = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => timeout(callback, ms === 60000 ? 200 : ms, ...args)) as typeof setTimeout);
  cleanup(() => spy.mockRestore());
  const jobs = f.monitor({ outputCollector: { ...f.options.outputCollector,
    collect: async job => { if ((job as JournalJob).originalFinish) { reads++; nativeRead.resolve(); } return { complete: false, receipt: null, summary: '' }; },
  } });
  const handle = await jobs.start(program, f.owner, on, {}); f.complete(handle.address);
  const resolving = jobs.reconcile();
  await nativeRead.promise;
  await expect(bounded(resolving, 80)).resolves.toBeUndefined();
  expect(await Promise.race([handle.finished, delay(30).then(() => null)])).toBeNull();
  expect(await bounded(handle.finished, 1000)).toMatchObject({ reason: 'unknown', exitCode: null });
  await resolving;
  expect(reads).toBeGreaterThan(1);
});
