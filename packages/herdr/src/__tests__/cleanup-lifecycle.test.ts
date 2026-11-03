// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { createJobMonitor } from '../jobs/monitor.js';
import { createJobStore } from '../jobs/store.js';
import { createCleanupSweep } from '../jobs/cleanup.js';
import { processStartIdentity } from '../jobs/handoff.js';
import type { RunId } from '../contracts.js';
import { cleanup, deferred, finish, monitorFixture, on, program } from './herdr-monitor-fixture.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
afterEach(() => { vi.mocked(rm).mockImplementation(actual.rm); });

it('late output during adopted shutdown cannot block a replacement release', async () => {
  const f = await monitorFixture(), runId = 'late-output' as RunId;
  const child = f.monitor({ child: { id: runId, pid: process.pid, startIdentity: processStartIdentity(process.pid)! } });
  const handle = await child.start(program, f.owner, on, {});
  await child.shutdown('reload'); f.complete(handle.address);
  const store = createJobStore(f.f.root, f.owner.sessionId, runId), journal = await store.read();
  journal.jobs[0].notice = 'observed'; journal.jobs[0].noticeDelivered = true; await store.write(journal);
  const entered = deferred<void>(), output = deferred<Awaited<ReturnType<typeof f.options.outputCollector.collect>>>();
  const sweep = createCleanupSweep(() => 1000, () => {}); cleanup(() => sweep.dispose());
  const stopped = createJobMonitor({ ...f.options, adoptedRunId: runId, outputCollector: { ...f.options.outputCollector, collect: async () => { entered.resolve(); return output.promise; } } }, sweep);
  cleanup(() => stopped.shutdown('reload'));
  const activation = stopped.activate(f.owner);
  await entered.promise;
  const shutdown = stopped.shutdown('reload');
  output.resolve({ complete: true, summary: 'complete', receipt: { jobId: handle.id, nonce: 'nonce', finish } });
  await activation; await shutdown;
  const replacement = createJobMonitor({ ...f.options, adoptedRunId: runId }, sweep); cleanup(() => replacement.shutdown('reload'));
  await replacement.activate(f.owner); sweep.start();
  await vi.waitFor(async () => expect((await store.read()).jobs[0].terminalReleased).toBe(true));
  expect(f.terminals.has(handle.address)).toBe(false);
});

it('a stopped adopted prune cannot overwrite a replacement journal or cancel its release', async () => {
  const f = await monitorFixture(), runId = 'late-prune' as RunId;
  const child = f.monitor({ child: { id: runId, pid: process.pid, startIdentity: processStartIdentity(process.pid)! } });
  const handle = await child.start(program, f.owner, on, {}); await child.shutdown('reload'); f.complete(handle.address);
  const store = createJobStore(f.f.root, f.owner.sessionId, runId), journal = await store.read(), job = journal.jobs[0];
  Object.assign(job, { phase: { kind: 'finished', address: handle.address, result: finish }, originalFinish: finish, output: { complete: true, summary: 'complete' }, notice: 'observed', noticeDelivered: true, settledMarked: true, terminalReleased: true, updatedAt: 0 });
  await store.write(journal);
  const entered = deferred<void>(), removed = deferred<void>();
  vi.mocked(rm).mockImplementation(async (path, options) => { if (path === job.localDirectory) { entered.resolve(); await removed.promise; } await actual.rm(path, options); });
  const sweep = createCleanupSweep(() => 8 * 86400000, () => {}); cleanup(() => sweep.dispose());
  const stopped = createJobMonitor({ ...f.options, adoptedRunId: runId, clock: () => 8 * 86400000 }, sweep); cleanup(() => stopped.shutdown('reload'));
  try {
    await stopped.activate(f.owner); sweep.start(); await entered.promise;
    await stopped.shutdown('reload');
    const latest = await store.read(); latest.revision += 50; await store.write(latest);
    const before = await readFile(store.path, 'utf8');
    const key = `${f.owner.sessionId}/${runId}/${handle.id}`;
    let replacementReleased = false;
    sweep.enqueue(key, async () => { replacementReleased = true; });
    removed.resolve(); await sweep.flush([`${key}/prune`, key]);
    expect(await readFile(store.path, 'utf8')).toBe(before);
    expect(replacementReleased).toBe(true);
  } finally { removed.resolve(); }
});
