// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import type { TerminalFinish } from '../contracts.js';
import { bounded, monitorFixture, on, program } from './herdr-monitor-fixture.js';

it.each([['spawn-error', 127], ['release-timeout', 124]] as const)('reports a verified %s receipt rather than a wrapper-exit conflict', async (reason, wrapperCode) => {
  const f = await monitorFixture();
  const receipt: TerminalFinish = { reason, exitCode: null, signal: null, finishedAt: 1000 };
  const jobs = f.monitor({ outputCollector: { ...f.options.outputCollector, collect: async job => ({ complete: true, summary: 'Preparation failed',
    receipt: { jobId: job.id, nonce: 'nonce', finish: receipt } }) } });
  const handle = await jobs.start(program, f.owner, on, {});
  Object.assign(f.terminals.get(handle.address)!, { state: 'finished', exitCode: wrapperCode, reason: 'exited', signal: null, finishedAt: 1000 });
  await jobs.reconcile();
  expect(await bounded(handle.finished)).toEqual(receipt);
});

it('still reports conflicting evidence when the preparation receipt disagrees with the wrapper code', async () => {
  const f = await monitorFixture();
  const jobs = f.monitor({ outputCollector: { ...f.options.outputCollector, collect: async job => ({ complete: true, summary: '',
    receipt: { jobId: job.id, nonce: 'nonce', finish: { reason: 'spawn-error', exitCode: null, signal: null, finishedAt: 1000 } } }) } });
  const handle = await jobs.start(program, f.owner, on, {});
  Object.assign(f.terminals.get(handle.address)!, { state: 'finished', exitCode: 0, reason: 'exited', signal: null, finishedAt: 1000 });
  await jobs.reconcile();
  expect(await bounded(handle.finished)).toMatchObject({ reason: 'unknown', exitCode: null, evidenceConflict: true });
});
