// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { access, mkdir, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createJobMonitor, type JobMonitor } from '../jobs/monitor.js';
import { registerHerdrJobs } from '../jobs/register.js';
import { jobPruneCandidates } from '../jobs/prune.js';
import { createJobStore, parseJobJournal, type JournalJob } from '../jobs/store.js';
import * as jobStores from '../jobs/store.js';
import { createCleanupSweep } from '../jobs/cleanup.js';
import * as cleanupSweeps from '../jobs/cleanup.js';
import { processStartIdentity } from '../jobs/handoff.js';
import { HERDR_LABELS } from '../contracts.js';
import type { RunId, TerminalAddress } from '../contracts.js';
import { cleanup, deferred, monitorFixture, on, program } from './herdr-monitor-fixture.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

it.skipIf(process.env.SPIDER_HERDR_PRUNE_SLOW !== '1')('compacts 600 foreground jobs in a session journal and starts the next job', async () => {
  const f = await monitorFixture(); f.early();
  const collect = f.options.outputCollector.collect;
  f.options.outputCollector.collect = async job => ({ ...await collect(job), summary: 'synthetic output '.repeat(60) });
  let now = 1000;
  const prepare = f.options.outputCollector.prepare;
  f.options.outputCollector.prepare = async (p, job) => ({ ...await prepare(p, job), releaseDeadlineAt: now + 10000 });
  let rejectFailure!: (error: unknown) => void;
  const failed = new Promise<never>((_, reject) => { rejectFailure = reject; }); void failed.catch(() => {});
  const jobs = f.monitor({ clock: () => now, reportError: error => { f.errors.push(error); rejectFailure(error); } });
  const ids: JournalJob['id'][] = [];
  for (let index = 0; index < 600; index++) {
    now = 1000 + index * 10000;
    const handle = await jobs.start(program, f.owner, on, {});
    await Promise.race([handle.finished, failed]); await jobs.consumeNotice(handle.id); await jobs.toolReturned(handle.id);
    await jobs.finishCleanup(); ids.push(handle.id);
  }
  const store = createJobStore(f.f.root, f.owner.sessionId);
  await vi.waitFor(async () => expect((await store.read()).jobs.map(job => job.id)).toEqual(ids.slice(-64)));
  const next = await jobs.start(program, f.owner, on, {}); await Promise.race([next.finished, failed]);
  expect(next.id).not.toBe(ids[599]);
  expect((await store.read()).jobs.map(job => job.id)).toEqual([...ids.slice(-64), next.id]);
  expect((await readFile(store.path)).length).toBeLessThan(1024 * 1024);
  expect(f.errors).toEqual([]);
}, 180000);

async function seeded(count = 70, scope: 'session' | 'child' = 'session') {
  const f = await monitorFixture(); f.early();
  const child = scope === 'child' ? { id: 'busy-child' as RunId, pid: process.pid, startIdentity: processStartIdentity(process.pid)! } : undefined;
  const first = f.monitor({ child }), handle = await first.start(program, f.owner, on, {});
  await handle.finished; await first.consumeNotice(handle.id); await first.finishCleanup(); await first.shutdown('reload');
  const store = createJobStore(f.f.root, f.owner.sessionId, child?.id), journal = await store.read(), original = journal.jobs[0];
  journal.jobs = Array.from({ length: count }, (_, index): JournalJob => {
    const id = `saved-${index}` as JournalJob['id'];
    return { ...structuredClone(original), id, localDirectory: join(store.directory, 'logs', id), updatedAt: 1000 + index };
  });
  for (const job of journal.jobs) { await mkdir(job.localDirectory); await writeFile(join(job.localDirectory, 'stdout.log'), job.id); }
  await store.write(journal);
  let now = 602000;
  const prepare = f.options.outputCollector.prepare;
  f.options.outputCollector.prepare = async (p, job) => ({ ...await prepare(p, job), releaseDeadlineAt: now + 10000 });
  const sweep = createCleanupSweep(() => now, error => { f.errors.push(error); }); cleanup(() => sweep.dispose());
  const jobs = createJobMonitor({ ...f.options, child, clock: () => now }, sweep); cleanup(() => jobs.shutdown('reload'));
  const pruneKeys = journal.jobs.map(job => `${f.owner.sessionId}/${child?.id ?? ''}/${job.id}/prune`);
  return { ...f, store, journal, sweep, jobs, pruneKeys, setNow: (value: number) => { now = value; } };
}

it('keeps 300 failed launch attempts below the journal cap and can launch afterward', async () => {
  const f = await monitorFixture(), factory = jobStores.createJobStore, run = f.hc.run;
  let now = 1000, failing = true, launches = 0;
  const stores = vi.spyOn(jobStores, 'createJobStore').mockImplementation((...args) => {
    const store = factory(...args);
    // Keep this stress test fast while still writing and reading the actual bounded JSON artifact.
    return { ...store, write: async journal => {
      const bytes = Buffer.from(JSON.stringify(journal));
      if (bytes.length > jobStores.MAX_BYTES) throw Object.assign(new Error('Journal too large'), { code: 'journal-too-large' });
      await mkdir(store.directory, { recursive: true, mode: 0o700 }); await writeFile(store.path, bytes);
    } };
  });
  f.hc.run = async request => { launches++; return run(request); };
  f.hc.fileRead = async () => { if (failing) throw Object.assign(new Error('Checksum unavailable'), { code: 'hc-error' }); return Buffer.from('a'.repeat(64)); };
  const jobs = f.monitor({ clock: () => now }), failures: unknown[] = [];
  try {
    for (let i = 0; i < 150; i++) {
      now += 10000;
      try { await jobs.start(program, f.owner, on, {}); failures.push('unexpected success'); }
      catch (error) { failures.push((error as { code?: string }).code); }
    }
    expect(launches).toBe(300); expect(failures).toEqual(Array(150).fill('hc-error'));
    await new Promise<void>(resolve => setImmediate(resolve));
    const store = factory(f.f.root, f.owner.sessionId);
    await expect.poll(async () => (await store.read()).jobs.length, { timeout: 3000 }).toBeLessThanOrEqual(64);
    expect((await readFile(store.path)).length).toBeLessThan(jobStores.MAX_BYTES);
    failing = false;
    const next = await jobs.start(program, f.owner, on, {});
    expect(launches).toBe(301); expect(next.id).toBeTruthy();
  } finally { await jobs.shutdown('reload'); stores.mockRestore(); }
}, 15000);

it('keeps the newest 64 settled failed launches and removes older local logs', async () => {
  const f = await seeded(70), ids = f.journal.jobs.map(job => job.id);
  for (const job of f.journal.jobs) {
    job.phase = { kind: 'launch-failed', error: 'Payload did not start' }; job.output = null; job.notice = 'pending';
    job.callerOwned = false; job.detached = false; job.uncertain = false; job.evidenceConflict = false; job.terminalReleased = true; job.settledMarked = true;
  }
  await f.store.write(f.journal); await f.jobs.activate(f.owner); await f.sweep.flush(f.pruneKeys);
  expect((await f.store.read()).jobs.map(job => job.id)).toEqual(ids.slice(-64));
  for (const job of f.journal.jobs.slice(0, 6)) await expect(access(job.localDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(f.journal.jobs[6].localDirectory, 'stdout.log'), 'utf8')).toBe(ids[6]);
});

it('retains failed diagnostics for ten minutes and eventually expires even the newest ones', async () => {
  const f = await seeded(70), ids = f.journal.jobs.map(job => job.id);
  for (const job of f.journal.jobs) {
    job.phase = { kind: 'launch-failed', error: 'Payload did not start' }; job.output = null; job.notice = 'pending';
    job.callerOwned = false; job.detached = false; job.uncertain = false; job.evidenceConflict = false; job.terminalReleased = true; job.settledMarked = true; job.updatedAt = 602000;
  }
  await f.store.write(f.journal); await f.jobs.activate(f.owner); await f.sweep.flush(f.pruneKeys);
  expect((await f.store.read()).jobs).toHaveLength(70);
  f.setNow(1201999); await f.jobs.reconcile(); await f.sweep.flush(f.pruneKeys);
  expect((await f.store.read()).jobs).toHaveLength(70);
  f.setNow(1202000); await f.jobs.reconcile(); await f.sweep.flush(f.pruneKeys);
  expect((await f.store.read()).jobs.map(job => job.id)).toEqual(ids.slice(-64));
  f.setNow(602000 + 7 * 86400000 + 1); await f.jobs.reconcile(); await f.sweep.flush(f.pruneKeys);
  expect((await f.store.read()).jobs).toHaveLength(0);
});

it('shares the newest-64 retention window between settled failures and finished jobs', async () => {
  const f = await seeded(70), ids = f.journal.jobs.map(job => job.id);
  for (const job of f.journal.jobs.slice(0, 35)) {
    job.phase = { kind: 'launch-failed', error: 'Payload did not start' }; job.output = null; job.notice = 'pending';
    job.callerOwned = false; job.detached = false; job.uncertain = false; job.evidenceConflict = false; job.terminalReleased = true; job.settledMarked = true;
  }
  await f.store.write(f.journal); await f.jobs.activate(f.owner); await f.sweep.flush(f.pruneKeys);
  expect((await f.store.read()).jobs.map(job => job.id)).toEqual(ids.slice(-64));
});

it('persists bounded failed-launch evidence and still reads legacy observations', async () => {
  const f = await seeded(1), job = f.journal.jobs[0], noisy = `"\\\u0001😃`.repeat(100).slice(0, 256);
  const labels = [HERDR_LABELS.job, HERDR_LABELS.session, HERDR_LABELS.kind, HERDR_LABELS.machine, HERDR_LABELS.ownerCore, HERDR_LABELS.ownerTerminal, HERDR_LABELS.run];
  const observation = { kind: 'labels' as const, differences: labels.map(label => ({ label, expected: noisy, actual: noisy })) };
  job.phase = { kind: 'launch-failed', error: noisy.repeat(60), releaseFailure: { step: 'hc get', elapsedMs: 10000, beforeReleaseMs: 300, queueWaitMs: 200, timerDriftMs: 5,
    confirmation: { checks: 20, notFound: 2, first: observation, last: observation } } };
  const legacy = parseJobJournal(f.journal, f.owner.sessionId).jobs[0].phase;
  expect(legacy.kind === 'launch-failed' && legacy.releaseFailure?.confirmation?.last.kind === 'labels' && legacy.releaseFailure.confirmation.last.differences).toHaveLength(7);
  await f.store.write(f.journal);
  const phase = JSON.parse(await readFile(f.store.path, 'utf8')).jobs[0].phase;
  expect(Buffer.byteLength(JSON.stringify({ error: phase.error, releaseFailure: phase.releaseFailure }))).toBeLessThan(2000);
  expect(phase.releaseFailure.confirmation.last.differences).toHaveLength(3);
  expect(phase.releaseFailure.confirmation.last.omitted).toBe(4);
  expect(Buffer.byteLength(phase.error)).toBeLessThanOrEqual(512);
  const reread = await f.store.read(); expect(reread.jobs[0].phase).toMatchObject({ kind: 'launch-failed', releaseFailure: { confirmation: { last: { kind: 'labels', omitted: 4 } } } });
});

it('prunes a settled failed background launch after its retention period', async () => {
  const f = await monitorFixture();
  let now = 1000;
  f.options.outputCollector.prepare = async () => { throw Object.assign(new Error('Upload failed'), { code: 'hc-error' }); };
  const jobs = f.monitor({ clock: () => now }), store = createJobStore(f.f.root, f.owner.sessionId);
  await expect(jobs.start(program, f.owner, on, { background: true })).rejects.toMatchObject({ code: 'hc-error' });
  const [failed] = (await store.read()).jobs;
  expect(failed).toMatchObject({ phase: { kind: 'launch-failed' }, callerOwned: true, terminalReleased: true, settledMarked: true });
  now += 8 * 86400000;
  await expect.poll(async () => { await jobs.reconcile(); return (await store.read()).jobs.length; }, { timeout: 1000, interval: 20 }).toBe(0);
  await expect(access(failed.localDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('selects settled caller-owned failures but protects live and recovering records under pressure', async () => {
  const f = await seeded(0), original = (await seeded(1)).journal.jobs[0], safe: JournalJob[] = [];
  const make = (name: string): JournalJob => ({ ...structuredClone(original), id: name as JournalJob['id'], phase: { kind: 'launch-failed', error: 'Payload did not start' }, output: null, notice: 'pending', callerOwned: false, detached: false, uncertain: false, evidenceConflict: false, terminalReleased: true, settledMarked: true, localDirectory: join(f.store.directory, 'logs', name), updatedAt: 1000 });
  for (let i = 0; i < 70; i++) safe.push(make(`safe-${i}`));
  const protectedJobs = ['caller', 'uncertain', 'conflict', 'terminal', 'marker', 'recovering', 'held', 'unreturned', 'crash', 'foreign-path', 'live'].map(make);
  for (const job of protectedJobs) job.callerOwned = true;
  protectedJobs[1].uncertain = true; protectedJobs[2].evidenceConflict = true;
  protectedJobs[3].terminalReleased = false; protectedJobs[4].settledMarked = false;
  protectedJobs[9].localDirectory = join(f.f.root, 'outside');
  protectedJobs[10].phase = { kind: 'running', address: 'remote.invalid/live' as TerminalAddress, releasedAt: 1000 };
  const finished = { ...structuredClone(original), id: 'finished-uncertain' as JournalJob['id'], callerOwned: true, detached: false, uncertain: true,
    terminalReleased: false, settledMarked: false, localDirectory: join(f.store.directory, 'logs', 'finished-uncertain'), updatedAt: 1000 };
  f.journal.jobs = [...safe, ...protectedJobs, finished];
  f.journal.writer = { pid: process.pid, startIdentity: processStartIdentity(process.pid)!, shutdown: null, crashJobs: [protectedJobs[8].id] };
  const candidates = jobPruneCandidates(f.journal, { directory: f.store.directory, now: 602000,
    recoveringNotices: new Set([protectedJobs[5].id]), holds: new Map([[protectedJobs[6].id, true]]), unreturned: new Set([protectedJobs[7].id]) }, true);
  expect(candidates.map(job => job.id)).toEqual([...safe.map(job => job.id), protectedJobs[0].id]);
});

it.each(['pending', 'submitted', 'recovering'] as const)('keeps an uncertain %s notice before settlement even under pressure', async state => {
  const f = await seeded(2), [unsettled, settled] = f.journal.jobs;
  unsettled.uncertain = true;
  unsettled.notice = state === 'recovering' ? 'observed' : state;
  const recoveringNotices = new Set<JournalJob['id']>();
  if (state === 'recovering') recoveringNotices.add(unsettled.id);
  const context = { directory: f.store.directory, now: 8 * 86400000, recoveringNotices, holds: new Map(), unreturned: new Set<JournalJob['id']>() };
  for (const pressure of [false, true]) {
    expect(jobPruneCandidates(f.journal, context, pressure).map(job => job.id)).toEqual([settled.id]);
  }
});

it.each(['session', 'child'] as const)('compacts a seeded %s window as new jobs settle', async scope => {
  const f = await seeded(64, scope), ids = f.journal.jobs.map(job => job.id);
  await f.jobs.activate(f.owner);
  for (let index = 0; index < 3; index++) {
    const handle = await f.jobs.start(program, f.owner, on, {});
    await handle.finished; await f.jobs.consumeNotice(handle.id); await f.jobs.toolReturned(handle.id);
    await f.jobs.finishCleanup(); ids.push(handle.id);
    await f.sweep.flush(f.pruneKeys);
    expect((await f.store.read()).jobs.map(job => job.id)).toEqual(ids.slice(-64));
    await expect(access(join(handle.localDirectory))).resolves.toBeUndefined();
  }
  expect(f.errors).toEqual([]);
});

it('starts a job with 540 settled records just below the journal cap', async () => {
  const f = await seeded(540);
  for (const job of f.journal.jobs) {
    job.updatedAt = 602000;
    job.output!.summary = 'x'.repeat(100);
  }
  const size = () => Buffer.byteLength(JSON.stringify(f.journal));
  const padding = 1048576 - 800 - size();
  for (const [index, job] of f.journal.jobs.entries()) job.output!.summary += 'x'.repeat(Math.floor(padding / 540) + (index < padding % 540 ? 1 : 0));
  await f.store.write(f.journal);
  expect((await readFile(f.store.path)).length).toBe(1048576 - 800);
  await f.jobs.activate(f.owner);
  const handle = await f.jobs.start(program, f.owner, on, {}); await handle.finished;
  expect((await f.store.read()).jobs.some(job => job.id === handle.id)).toBe(true);
  expect((await readFile(f.store.path)).length).toBeLessThan(1048576);
  expect(f.errors).toEqual([]);
});

it.each(['notice', 'terminal release', 'new generation'] as const)('keeps a late %s result readable for ten minutes', async point => {
  const f = await seeded(66), job = f.journal.jobs[0];
  job.callerOwned = true; job.detached = true; job.noticeMode = 'async';
  for (const newer of f.journal.jobs.slice(1)) newer.updatedAt = 602100;
  if (point === 'notice') job.notice = 'submitted';
  if (point === 'terminal release') job.terminalReleased = false;
  const owner = point === 'new generation' ? { ...f.owner, generation: 'read-again' as typeof f.owner.generation } : f.owner;
  await f.store.write(f.journal); await f.jobs.activate(owner);
  if (point !== 'terminal release') await f.jobs.consumeNotice(job.id);
  await f.jobs.finishCleanup(); await f.sweep.flush(f.pruneKeys);
  expect((await f.store.read()).jobs.map(record => record.id)).toContain(job.id);
  expect(await readFile(join(job.localDirectory, 'stdout.log'), 'utf8')).toBe(job.id);
  f.setNow(1201999); await f.jobs.reconcile(); await f.sweep.flush(f.pruneKeys);
  expect((await f.store.read()).jobs.map(record => record.id)).toContain(job.id);
  await f.jobs.consumeNotice(job.id);
  f.setNow(1202000); await f.jobs.reconcile(); await f.sweep.flush(f.pruneKeys);
  expect((await f.store.read()).jobs.map(record => record.id)).not.toContain(job.id);
  await expect(access(job.localDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps all 70 batch entry logs readable until the tool result returns', async () => {
  const f = await seeded(0), entries: { id: JournalJob['id']; localDirectory: string }[] = [];
  const factory = jobStores.createJobStore;
  const stores = vi.spyOn(jobStores, 'createJobStore').mockImplementation((...args) => {
    const store = factory(...args);
    return { ...store, write: async journal => { await writeFile(store.path, JSON.stringify(journal)); } };
  });
  const sweepFactory = vi.spyOn(cleanupSweeps, 'createCleanupSweep').mockReturnValue(f.sweep);
  const flush = () => f.sweep.flush(entries.map(job => `${f.owner.sessionId}//${job.id}/prune`));
  let now = 602000, jobs: JobMonitor | null = null;
  const hooks = new Map<string, (event: unknown, ctx?: unknown) => Promise<void>>();
  const registration = registerHerdrJobs({
    on(name: string, handler: (event: unknown, ctx?: unknown) => Promise<void>) { hooks.set(name, handler); return () => {}; }, sendMessage() {},
  } as never, {
    currentOwner: () => f.owner, monitorOptions: () => ({ ...f.options, clock: () => now }), bind: value => { jobs = value; },
    jobIdsForToolResult: result => result as JournalJob['id'][],
  });
  try {
    await hooks.get('session_start')!({}, { sessionManager: { getBranch: () => [] } });
    const current = jobs!;
    for (let index = 0; index < 70; index++) {
      now = 602000 + index * 10000; f.setNow(now);
      const handle = await current.start(program, f.owner, on, { kind: 'batch' });
      await handle.finished; await writeFile(join(handle.localDirectory, 'stdout.log'), handle.id);
      await current.consumeNotice(handle.id); await current.finishCleanup(); entries.push(handle);
    }
    for (const entry of entries) expect(await readFile(join(entry.localDirectory, 'stdout.log'), 'utf8')).toBe(entry.id);
    const result = entries.map(entry => entry.id);
    await expect(hooks.get('tool_execution_end')!({ result })).resolves.toBeUndefined(); await flush();
    for (const entry of entries) expect(await readFile(join(entry.localDirectory, 'stdout.log'), 'utf8')).toBe(entry.id);
    now = 1891999;
    await expect(hooks.get('tool_execution_end')!({ result })).resolves.toBeUndefined();
    now = 1892000; await current.reconcile(); await flush();
    expect((await f.store.read()).jobs.map(job => job.id)).toEqual(entries.slice(6).map(job => job.id));
    await expect(access(entries[0].localDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(hooks.get('tool_execution_end')!({ result })).resolves.toBeUndefined();
    expect(f.errors).toEqual([]);
  } finally { await registration.dispose(); stores.mockRestore(); sweepFactory.mockRestore(); }
});

it('keeps a late background notice log for ten minutes while 65 newer jobs finish', async () => {
  const f = await seeded(0), ids: JournalJob['id'][] = [];
  const factory = jobStores.createJobStore;
  const stores = vi.spyOn(jobStores, 'createJobStore').mockImplementation((...args) => {
    const store = factory(...args);
    return { ...store, write: async journal => { await writeFile(store.path, JSON.stringify(journal)); } };
  });
  const flush = () => f.sweep.flush(ids.map(id => `${f.owner.sessionId}//${id}/prune`));
  const finishOthers = async () => {
    for (let index = 0; index < 65; index++) {
      const handle = await f.jobs.start(program, f.owner, on, {}); await handle.finished;
      await f.jobs.consumeNotice(handle.id); await f.jobs.toolReturned(handle.id); await f.jobs.finishCleanup();
      ids.push(handle.id);
    }
  };
  try {
    f.setNow(1000); await f.jobs.activate(f.owner);
    const background = await f.jobs.start(program, f.owner, on, { background: true }); await background.finished;
    await writeFile(join(background.localDirectory, 'stdout.log'), 'background output');
    await f.jobs.detach(background.id); await f.jobs.toolReturned(background.id); ids.push(background.id);
    f.setNow(2000); await finishOthers();
    f.setNow(602000); await f.jobs.consumeNotice(background.id); await f.jobs.finishCleanup(); await flush();
    expect(await readFile(join(background.localDirectory, 'stdout.log'), 'utf8')).toBe('background output');
    f.setNow(602100); await finishOthers(); await flush();
    f.setNow(1201999); await f.jobs.reconcile(); await flush();
    expect((await f.store.read()).jobs.map(job => job.id)).toContain(background.id);
    expect(await readFile(join(background.localDirectory, 'stdout.log'), 'utf8')).toBe('background output');
    f.setNow(1202000); await f.jobs.reconcile(); await flush();
    expect((await f.store.read()).jobs.map(job => job.id)).not.toContain(background.id);
    await expect(access(background.localDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.errors).toEqual([]);
  } finally { await f.jobs.shutdown('reload'); stores.mockRestore(); }
});

it('ignores a tool-result id whose record is no longer tracked', async () => {
  const f = await seeded(0); await f.jobs.activate(f.owner);
  const id = 'removed-result' as JournalJob['id'];
  await expect(f.jobs.toolReturned(id)).resolves.toBeUndefined();
  await expect(f.jobs.consumeNotice(id)).resolves.toBeUndefined();
  expect(f.errors).toEqual([]);
});

it('protects an unreturned result even under write pressure', async () => {
  const f = await seeded(0); await f.jobs.activate(f.owner);
  const collect = f.options.outputCollector.collect;
  f.options.outputCollector.collect = async job => ({ ...await collect(job), summary: 'x'.repeat(700000) });
  const handle = await f.jobs.start(program, f.owner, on, {}); await handle.finished;
  await writeFile(join(handle.localDirectory, 'stdout.log'), 'first output');
  await f.jobs.consumeNotice(handle.id); await f.jobs.finishCleanup();
  const prepare = f.options.outputCollector.prepare;
  f.options.outputCollector.prepare = async (p, job) => {
    const launch = await prepare(p, job);
    return { ...launch, program: { ...launch.program, directory: '/' + 'x'.repeat(400000) } };
  };
  await expect(f.jobs.start(program, f.owner, on, {})).rejects.toMatchObject({ code: 'journal-too-large' });
  expect((await f.store.read()).jobs.map(job => job.id)).toContain(handle.id);
  expect(await readFile(join(handle.localDirectory, 'stdout.log'), 'utf8')).toBe('first output');
});

it('skips a stuck log removal under pressure and reports it once', async () => {
  const f = await seeded(3), [stuck, removable] = f.journal.jobs;
  stuck.output!.summary = 'a'.repeat(600000); removable.output!.summary = 'b'.repeat(350000);
  await f.store.write(f.journal);
  await rm(stuck.localDirectory, { recursive: true }); await symlink(f.f.root, stuck.localDirectory);
  await f.jobs.activate(f.owner);
  const prepare = f.options.outputCollector.prepare;
  f.options.outputCollector.prepare = async (p, job) => {
    const launch = await prepare(p, job);
    return { ...launch, program: { ...launch.program, directory: '/' + 'x'.repeat(400000) } };
  };
  const handle = await f.jobs.start(program, f.owner, on, {}); await handle.finished;
  expect((await f.store.read()).jobs.map(job => job.id)).toEqual([stuck.id, 'saved-2', handle.id]);
  await expect(access(removable.localDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.errors).toHaveLength(1);
  await expect(f.jobs.start(program, f.owner, on, {})).rejects.toMatchObject({ code: 'journal-too-large' });
  expect(f.errors).toHaveLength(1);
});

it('leaves child-journal scans to maintenance rather than each save', async () => {
  const f = await seeded(1, 'child'), child = f.journal.child!;
  child.ended = false;
  await f.store.write(f.journal);
  const factory = jobStores.createJobStore; let childReads = 0;
  const stores = vi.spyOn(jobStores, 'createJobStore').mockImplementation((...args) => {
    const store = factory(...args);
    return { ...store, read: async options => { if (args[2] === child.id) childReads++; return store.read(options); } };
  });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const jobs = f.monitor();
  try {
    f.options.outputCollector.collect = async () => ({ complete: false, summary: '', receipt: null });
    await jobs.activate(f.owner);
    await vi.waitFor(() => expect(childReads).toBeGreaterThan(0)); childReads = 0;
    for (let index = 0; index < 3; index++) await jobs.start(program, f.owner, on, {});
    expect(childReads).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(childReads).toBeGreaterThan(0));
  } finally { await jobs.shutdown('reload'); vi.useRealTimers(); stores.mockRestore(); }
});

it('recovers an unsaved notice after reload while older results are compacted', async () => {
  const f = await seeded(66), job = f.journal.jobs[0];
  job.noticeMode = 'async'; job.callerOwned = true; job.detached = true;
  await f.store.write(f.journal);
  const owner = { ...f.owner, generation: 'reloaded' as typeof f.owner.generation, sessionFile: join(f.f.root, 'session.jsonl') };
  await writeFile(owner.sessionFile, JSON.stringify({ type: 'session', id: owner.sessionId }) + '\n');
  const reading = deferred<void>(), resume = deferred<void>();
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    if (path === owner.sessionFile) { reading.resolve(); await resume.promise; }
    return actualFs.open(path, flags, mode);
  });
  try {
    await f.jobs.activate(owner); await f.sweep.flush(f.pruneKeys); await reading.promise;
    expect((await f.store.read()).jobs.map(record => record.id)).toContain(job.id);
    expect(await readFile(join(job.localDirectory, 'stdout.log'), 'utf8')).toBe(job.id);
    await expect(access(f.journal.jobs[1].localDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    resume.resolve(); await f.sweep.flush([`${owner.sessionId}/notices`]);
    expect(f.notices.map(notice => notice.details.jobId)).toEqual([job.id]);
    await f.jobs.consumeNotice(job.id); await f.jobs.finishCleanup(); await f.sweep.flush(f.pruneKeys);
    expect((await f.store.read()).jobs.find(record => record.id === job.id)).toMatchObject({ notice: 'observed', noticeObservedGeneration: owner.generation });
    f.setNow(1202000); await f.jobs.reconcile(); await f.sweep.flush(f.pruneKeys);
    expect(await readFile(join(job.localDirectory, 'stdout.log'), 'utf8')).toBe(job.id);
    expect(f.notices).toHaveLength(1);
  } finally { resume.resolve(); vi.mocked(open).mockImplementation(actualFs.open); }
});

it('persists the terminal-release time when a parent settles child logs', async () => {
  const f = await seeded(1, 'child');
  f.journal.child!.ended = true; f.journal.child!.settled = true;
  f.journal.jobs[0].terminalReleased = false;
  await f.store.write(f.journal);
  const parent = f.monitor({ clock: () => 602000 }); await parent.activate(f.owner);
  await vi.waitFor(async () => expect((await f.store.read()).jobs[0]).toMatchObject({ terminalReleased: true, updatedAt: 602000 }));
});

it('compacts its own active journal after a save without waiting for the timer', async () => {
  const f = await seeded(64), jobs = f.monitor({ clock: () => 602000 });
  await jobs.activate(f.owner);
  const handle = await jobs.start(program, f.owner, on, {}); await handle.finished;
  await jobs.consumeNotice(handle.id); await jobs.toolReturned(handle.id); await jobs.finishCleanup();
  await vi.waitFor(async () => expect((await f.store.read()).jobs.map(job => job.id)).toEqual([...f.journal.jobs.slice(1).map(job => job.id), handle.id]));
  await expect(access(f.journal.jobs[0].localDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
});

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
  const candidates = jobPruneCandidates(f.journal, { directory: f.store.directory, now, holds: new Map(), recoveringNotices: new Set(), unreturned: new Set() });
  expect(candidates.map(record => record.id)).toEqual(['saved-1']);
});

it.each(['release hold', 'crash recovery', 'notice recovery'] as const)('excludes a record held for %s before selecting the recent window', async condition => {
  const f = await seeded(66), job = f.journal.jobs[0];
  const holds = new Map(), recoveringNotices = new Set<typeof job.id>();
  if (condition === 'release hold') holds.set(job.id, true);
  if (condition === 'crash recovery') f.journal.writer!.crashJobs = [job.id];
  if (condition === 'notice recovery') recoveringNotices.add(job.id);
  const candidates = jobPruneCandidates(f.journal, { directory: f.store.directory, now: 602000, holds, recoveringNotices, unreturned: new Set() });
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
