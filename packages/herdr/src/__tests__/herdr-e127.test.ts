// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import type { TerminalFinish } from '../contracts.js';
import { createJobStore } from '../jobs/store.js';
import { bounded, monitorFixture, on, program } from './herdr-monitor-fixture.js';

it.each(['event', 'snapshot'] as const)('resolves wrapper exit 127 and a verified spawn-error receipt through %s', async source => {
  // Comparing the wrapper code directly to the absent payload exit invents a conflict.
  const f = await monitorFixture();
  const payload: TerminalFinish = { exitCode: null, reason: 'spawn-error', signal: null, finishedAt: 1000 };
  const jobs = f.monitor({ outputCollector: { ...f.options.outputCollector,
    collect: async job => ({ complete: true, summary: 'Runtime preparation failed; rerun spider herdr setup', receipt: { jobId: job.id, nonce: 'nonce', finish: payload } }),
  } });
  const handle = await jobs.start(program, f.owner, on, {});
  const native: TerminalFinish = { exitCode: 127, reason: 'exited', signal: null, finishedAt: 1000 };
  Object.assign(f.terminals.get(handle.address)!, { state: 'finished', ...native });
  if (source === 'event') f.emit({ type: 'finished', terminal: handle.address, seq: 2, data: native });
  await jobs.reconcile();
  expect(await bounded(handle.finished)).toEqual(payload);
  await jobs.reconcile();
  const journal = await createJobStore(f.f.root, f.owner.sessionId).read();
  expect(journal.jobs[0]).toMatchObject({ evidenceConflict: false, originalFinish: native, phase: { kind: 'finished', result: payload } });
  expect(f.errors).toEqual([]);
});
