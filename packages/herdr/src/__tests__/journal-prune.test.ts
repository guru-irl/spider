// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createJobMonitor } from '../jobs/monitor.js';
import { jobPruneCandidates } from '../jobs/prune.js';
import { createJobStore, type JournalJob } from '../jobs/store.js';
import * as jobStores from '../jobs/store.js';
import { createCleanupSweep } from '../jobs/cleanup.js';
import { processStartIdentity } from '../jobs/handoff.js';
import type { RunId, TerminalAddress } from '../contracts.js';
import { cleanup, deferred, monitorFixture, on, program } from './herdr-monitor-fixture.js';

it.each(['session', 'child'] as const)('compacts 600 foreground jobs in a %s journal and starts the next job', async scope => {
  const f = await monitorFixture(); f.early();
  const collect = f.options.outputCollector.collect;
  f.options.outputCollector.collect = async job => ({ ...await collect(job), summary: 'synthetic output '.repeat(60) });
  const runId = scope === 'child' ? 'busy-child' as RunId : undefined;
  let rejectFailure!: (error: unknown) => void;
  const failed = new Promise<never>((_, reject) => { rejectFailure = reject; }); void failed.catch(() => {});
  const jobs = f.monitor({ ...(runId ? { child: { id: runId, pid: process.pid, startIdentity: processStartIdentity(process.pid)! } } : {}), reportError: error => { f.errors.push(error); rejectFailure(error); } });
  const ids: JournalJob['id'][] = [];
  for (let index = 0; index < 600; index++) {
    const handle = await jobs.start(program, f.owner, on, {});
    await Promise.race([handle.finished, failed]); await jobs.consumeNotice(handle.id); await jobs.toolReturned(handle.id);
    await jobs.finishCleanup(); ids.push(handle.id);
  }
  const store = createJobStore(f.f.root, f.owner.sessionId, runId);
  await vi.waitFor(async () => expect((await store.read()).jobs.map(job => job.id)).toEqual(ids.slice(-64)));
  const next = await jobs.start(program, f.owner, on, {}); await Promise.race([next.finished, failed]);
  expect(next.id).not.toBe(ids[599]);
  expect((await store.read()).jobs.map(job => job.id)).toEqual([...ids.slice(-64), next.id]);
  expect((await readFile(store.path)).length).toBeLessThan(1024 * 1024);
  expect(f.errors).toEqual([]);
}, 180000);

async function seeded(count = 70) {
  const f = await monitorFixture(); f.early();
  const first = f.monitor(), handle = await first.start(program, f.owner, on, {});
  await handle.finished; await first.consumeNotice(handle.id); await first.finishCleanup(); await first.shutdown('reload');
  const store = createJobStore(f.f.root, f.owner.sessionId), journal = await store.read(), original = journal.jobs[0];
  journal.jobs = Array.from({ length: count }, (_, index): JournalJob => {
    const id = `saved-${index}` as JournalJob['id'];
    return { ...structuredClone(original), id, localDirectory: join(store.directory, 'logs', id), updatedAt: 1000 + index };
  });
  for (const job of journal.jobs) { await mkdir(job.localDirectory); await writeFile(join(job.localDirectory, 'stdout.log'), job.id); }
  await store.write(journal);
  const sweep = createCleanupSweep(() => 2000, error => { f.errors.push(error); }); cleanup(() => sweep.dispose());
  const jobs = createJobMonitor({ ...f.options, clock: () => 2000 }, sweep); cleanup(() => jobs.shutdown('reload'));
  const pruneKeys = journal.jobs.map(job => `${f.owner.sessionId}//${job.id}/prune`);
  return { ...f, store, journal, sweep, jobs, pruneKeys };
}

it('retains the newest 64 completed ids and their logs and cancels pruned cleanup keys', async () => {
  const f = await seeded(), cancel = vi.spyOn(f.sweep, 'cancel');
  f.journal.jobs.reverse(); await f.store.write(f.journal);
  await f.jobs.activate(f.owner); await f.sweep.flush(f.pruneKeys);
  expect((await f.store.read()).jobs.map(job => job.id).sort()).toEqual(f.journal.jobs.filter(job => job.updatedAt >= 1006).map(job => job.id).sort());
  for (const job of f.journal.jobs) {
    if (job.updatedAt < 1006) {
      await expect(access(job.localDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(cancel).toHaveBeenCalledWith(`${f.owner.sessionId}//${job.id}`);
    } else expect(await readFile(join(job.localDirectory, 'stdout.log'), 'utf8')).toBe(job.id);
  }
  expect(f.errors).toEqual([]);
});

it('persists concurrent terminal releases even when an earlier write finishes late', async () => {
  const f = await seeded(2);
  for (const job of f.journal.jobs) job.terminalReleased = false;
  await f.store.write(f.journal);
  const firstSaved = deferred<void>(), secondReleased = deferred<void>();
  const factory = jobStores.createJobStore;
  let blockNext = false, gets = 0, missing = 0;
  const stores = vi.spyOn(jobStores, 'createJobStore').mockImplementation((...args) => {
    const store = factory(...args);
    return { ...store, write: async journal => {
      await store.write(journal);
      if (blockNext) { blockNext = false; firstSaved.resolve(); await secondReleased.promise; }
    } };
  });
  f.hc.get = async () => { if (++gets === 2) await firstSaved.promise; throw Object.assign(new Error('missing'), { code: 'not_found' }); };
  const machines = f.hc.machines;
  f.hc.machines = async (...args) => {
    const result = await machines(...args);
    if (++missing === 2) setImmediate(() => secondReleased.resolve());
    return result;
  };
  try {
    await f.jobs.activate(f.owner); blockNext = true;
    await f.sweep.flush(f.journal.jobs.map(job => `${f.owner.sessionId}//${job.id}`));
    expect((await f.store.read()).jobs.map(job => job.terminalReleased)).toEqual([true, true]);
  } finally { firstSaved.resolve(); secondReleased.resolve(); stores.mockRestore(); }
});

it('counts observed detached results toward the same recent window', async () => {
  const f = await seeded();
  for (const job of f.journal.jobs) { job.callerOwned = true; job.detached = true; job.noticeMode = 'async'; }
  await f.store.write(f.journal); await f.jobs.activate(f.owner); await f.sweep.flush(f.pruneKeys);
  expect((await f.store.read()).jobs.map(job => job.id)).toEqual(f.journal.jobs.slice(6).map(job => job.id));
  await expect(access(f.journal.jobs[0].localDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('reclaims eligible records before an oversized write even inside the recent window', async () => {
  const f = await seeded(2);
  f.journal.jobs[0].output!.summary = 'a'.repeat(700000);
  f.journal.jobs[1].output!.summary = 'b'.repeat(300000);
  f.journal.jobs[1].notice = 'submitted'; f.journal.jobs[1].noticeMode = 'async';
  await f.store.write(f.journal); await f.jobs.activate(f.owner);
  const prepare = f.options.outputCollector.prepare;
  f.options.outputCollector.prepare = async (p, job) => {
    const launch = await prepare(p, job);
    return { ...launch, program: { ...launch.program, directory: '/' + 'x'.repeat(100000) } };
  };
  const next = await f.jobs.start(program, f.owner, on, {}); await next.finished; await f.jobs.reconcile();
  const saved = await f.store.read();
  expect(saved.jobs.map(job => job.id)).toEqual(['saved-1', next.id]);
  expect(saved.jobs[0].notice).toBe('submitted');
  await expect(access(f.journal.jobs[0].localDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readFile(f.store.path)).length).toBeLessThan(1024 * 1024);
});

it.each(['caller owned', 'detached', 'exactly seven days'] as const)('preserves the age-based exclusion for %s', async condition => {
  const f = await seeded(2), job = f.journal.jobs[0], now = 8 * 86400000;
  if (condition === 'caller owned') job.callerOwned = true;
  if (condition === 'detached') job.detached = true;
  if (condition === 'exactly seven days') job.updatedAt = now - 7 * 86400000;
  const candidates = jobPruneCandidates(f.journal, { directory: f.store.directory, now, holds: new Map(), recoveringNotices: new Set() });
  expect(candidates.map(record => record.id)).toEqual(['saved-1']);
});

it.each(['release hold', 'crash recovery', 'notice recovery'] as const)('excludes a record held for %s before selecting the recent window', async condition => {
  const f = await seeded(66), job = f.journal.jobs[0];
  const holds = new Map(), recoveringNotices = new Set<typeof job.id>();
  if (condition === 'release hold') holds.set(job.id, true);
  if (condition === 'crash recovery') f.journal.writer!.crashJobs = [job.id];
  if (condition === 'notice recovery') recoveringNotices.add(job.id);
  const candidates = jobPruneCandidates(f.journal, { directory: f.store.directory, now: 2000, holds, recoveringNotices });
  expect(candidates.map(record => record.id)).toEqual(['saved-1']);
});

const protectedCases = ['running', 'launch-failed', 'pending', 'submitted', 'incomplete', 'unreleased', 'uncertain', 'conflict', 'handoff', 'unmarked', 'foreign-logs'] as const;
it.each(protectedCases)('keeps a recent %s record while compacting older eligible results', async condition => {
  const f = await seeded(66), job = f.journal.jobs[0];
  if (condition === 'running') {
    const address = 'remote.invalid/live' as TerminalAddress;
    job.phase = { kind: 'running', address, releasedAt: 1000 }; job.settledMarked = false; job.originalFinish = null;
    f.terminals.set(address, { address, parent: null, labels: {}, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null });
  }
  if (condition === 'launch-failed') job.phase = { kind: 'launch-failed', error: 'not started' };
  if (condition === 'pending' || condition === 'submitted') { job.notice = condition; job.noticeMode = 'async'; }
  if (condition === 'incomplete') job.output!.complete = false;
  if (condition === 'unreleased') { job.terminalReleased = false; f.hc.get = () => deferred<never>().promise; }
  if (condition === 'uncertain') job.uncertain = true;
  if (condition === 'conflict') job.evidenceConflict = true;
  if (condition === 'handoff') job.handoffCancelled = true;
  if (condition === 'unmarked') job.settledMarked = false;
  if (condition === 'foreign-logs') job.localDirectory = join(f.f.root, 'outside-logs');
  await f.store.write(f.journal); await f.jobs.activate(f.owner); await f.sweep.flush(f.pruneKeys);
  const saved = await f.store.read();
  expect(saved.jobs.map(record => record.id)).toEqual([job.id, ...f.journal.jobs.slice(2).map(record => record.id)]);
  expect(await readFile(join(f.store.directory, 'logs', job.id, 'stdout.log'), 'utf8')).toBe(job.id);
  await expect(access(f.journal.jobs[1].localDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
});
