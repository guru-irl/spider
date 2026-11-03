// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createJobStore, type JournalJob } from '../../../herdr/src/jobs/store.js';
import { mountedFixture } from './herdr-wiring-fixture.js';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it('opens a released job from another terminal of the same session and core', async () => {
  const f = await mountedFixture('fake', 'tui', true, false, true, true);
  try {
    const store = createJobStore(join(f.config.globalRoot, 'herdr/jobs'), f.owner!.sessionId), journal = await store.read();
    const localDirectory = join(store.directory, 'logs', 'saved-job'); await mkdir(localDirectory, { recursive: true });
    await writeFile(join(localDirectory, 'stdout.log'), 'retained output\n');
    await writeFile(join(localDirectory, 'stderr.log'), '');
    await writeFile(join(localDirectory, 'receipt.json'), JSON.stringify({ exitCode: 0 }));
    const job = { version: 1, id: 'saved-job', owner: { ...f.owner!, terminal: { ...f.owner!.terminal, terminalId: 't-original', address: 't-original', socket: '/fixture/original.sock', sessionNamespace: 'former' } }, machine: 'remote.invalid', kind: 'exec', phase: { kind: 'finished', address: 'remote.invalid/t-gone', result: { exitCode: 0, reason: 'exited', signal: null, finishedAt: 1000 } }, viewer: null, localDirectory, remoteDirectory: '/fixture/old-job', detached: true, callerOwned: true, noticeMode: 'async', notice: 'observed', nonce: 'nonce', releaseDeadlineAt: 0, originalFinish: null, output: { complete: true, summary: 'retained output' }, noticeDelivered: true, settledMarked: true, terminalReleased: true, terminalExpired: true, uncertain: false, evidenceConflict: false, updatedAt: Date.now() } as JournalJob;
    journal.jobs.push(job); await store.write(journal);
    const opened = await f.ipc!.openJob(job.id);
    expect(opened).toMatchObject({ ok: true, op: 'openJob' });
    if (!opened.ok || opened.op !== 'openJob') throw new Error('Saved view did not open');
    expect((await f.h.hc.get(opened.viewer)).labels).toMatchObject({ 'spider.session': f.owner!.sessionId, 'spider.job': 'saved-job' });
  } finally { await f.close(); }
}, 45000);
