// SPDX-License-Identifier: MIT
import { it, expect, vi, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { appendFile, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Owner } from '../contracts.js';
import { createJobStore } from '../jobs/store.js';
import { registerHerdrJobs } from '../jobs/register.js';
import type { JobMonitor, JobNotice } from '../jobs/monitor.js';
import { bounded, deferred, monitorFixture, on, program } from './herdr-monitor-fixture.js';
import { recoverJobNotices } from '../jobs/notices.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
afterEach(() => { vi.mocked(open).mockImplementation(actual.open); vi.clearAllMocks(); });

it.each(['absent', 'saved', 'wrong-nonce', 'legacy', 'same-generation', 'quoted-id'] as const)('recovers an observed notice with %s evidence', async evidence => {
  const h = await monitorFixture();
  h.owner.sessionFile = join(h.f.root, 'session.jsonl');
  const first = h.monitor(), job = await first.start(program, h.owner, on, { background: true });
  await first.detach(job.id); h.complete(job.address);
  await vi.waitFor(() => expect(h.notices).toHaveLength(1));
  await first.consumeNotice(job.id);
  const store = createJobStore(h.f.root, h.owner.sessionId), before = (await store.read()).jobs[0];
  const entries: unknown[] = [{ type: 'session', version: 3, id: h.owner.sessionId }];
  if (['saved', 'wrong-nonce', 'legacy'].includes(evidence)) entries.push({ type: 'custom_message', customType: 'spider.job_done', details: { jobId: job.id, ...(evidence === 'legacy' ? {} : { nonce: evidence === 'saved' ? before.nonce : 'another-nonce' }) } });
  if (evidence === 'quoted-id') entries.push({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: `The completion spider.job_done mentions job ${job.id} with nonce ${before.nonce}.` }] } });
  await writeFile(h.owner.sessionFile, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  await first.shutdown('reload'); h.notices.length = 0;
  const owner = { ...h.owner, generation: evidence === 'same-generation' ? h.owner.generation : 'recovered-generation' as Owner['generation'] };
  const resumed = h.monitor(); await resumed.activate(owner);
  const resends = evidence === 'absent' || evidence === 'wrong-nonce' || evidence === 'quoted-id' ? 1 : 0;
  await vi.waitFor(async () => {
    const current = (await store.read()).jobs[0];
    expect({ notices: h.notices.length, recovered: current.noticeObservedGeneration === owner.generation || resends === 1 && current.notice === 'submitted' }).toEqual({ notices: resends, recovered: true });
  });
  if (resends) await resumed.consumeNotice(job.id);
  expect((await store.read()).jobs[0]).toMatchObject({ notice: 'observed', noticeObservedGeneration: owner.generation });
  await resumed.reconcile();
  expect(h.notices).toHaveLength(resends);
});

it.each(['saved', 'absent', 'legacy'] as const)('recovers a submitted notice after restart with %s evidence', async evidence => {
  const h = await monitorFixture(), hooks = new Map<string, Function>();
  let owner = { ...h.owner, sessionFile: join(h.f.root, 'session.jsonl') }, bound: JobMonitor | null = null;
  const branch: unknown[] = [], sent: JobNotice[] = [];
  const registration = registerHerdrJobs({
    on(name: string, handler: Function) { hooks.set(name, handler); return () => {}; },
    sendMessage(notice: JobNotice) { sent.push(notice); },
  } as never, {
    currentOwner: () => owner, monitorOptions: () => h.options, jobIdsForToolResult: () => [], bind: value => { bound = value; },
  });
  const ctx = { sessionManager: { getBranch: () => branch } };
  try {
    await hooks.get('session_start')!({}, ctx);
    const first = bound!, job = await first.start(program, owner, on, { background: true });
    await first.detach(job.id); h.complete(job.address);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const store = createJobStore(h.f.root, owner.sessionId), nonce = (await store.read()).jobs[0].nonce;
    if (evidence !== 'absent') branch.push({ type: 'custom_message', customType: 'spider.job_done', details: { jobId: job.id, ...(evidence === 'legacy' ? {} : { nonce, generation: owner.generation }) } });
    await writeFile(owner.sessionFile, [{ type: 'session', id: owner.sessionId }, ...branch].map(entry => JSON.stringify(entry)).join('\n') + '\n');
    await hooks.get('session_shutdown')!({ reason: 'reload' });
    owner = { ...owner, generation: 'restarted-generation' as Owner['generation'] }; sent.length = 0;
    await hooks.get('session_start')!({ reason: 'reload' }, ctx);
    const resumed = bound!;
    await vi.waitFor(async () => expect((await store.read()).jobs[0]).toMatchObject(evidence === 'absent'
      ? { notice: 'submitted', noticeDelivered: true }
      : { notice: 'observed', noticeSavedNonce: nonce, terminalReleased: true }));
    if (evidence === 'absent') {
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      await hooks.get('message_end')!({ message: sent[0] });
    }
    await vi.waitFor(async () => expect((await store.read()).jobs[0]).toMatchObject({ notice: 'observed', terminalReleased: true }));
    await resumed.reconcile(); await resumed.reconcile();
    expect(sent).toHaveLength(evidence === 'absent' ? 1 : 0);
  } finally { await registration.dispose(); }
});

it('activates and launches new work while a saved-notice read is blocked', async () => {
  const h = await monitorFixture(); h.owner.sessionFile = join(h.f.root, 'session.jsonl');
  const first = h.monitor(), job = await first.start(program, h.owner, on, { background: true });
  await first.detach(job.id); h.complete(job.address);
  await vi.waitFor(() => expect(h.notices).toHaveLength(1)); await first.consumeNotice(job.id);
  await writeFile(h.owner.sessionFile, JSON.stringify({ type: 'session', id: h.owner.sessionId }) + '\n');
  await first.shutdown('reload'); h.notices.length = 0;
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(open).mockImplementation(async (path, flags, mode) => { if (path === h.owner.sessionFile) await blocked; return actual.open(path, flags, mode); });
  const owner = { ...h.owner, generation: 'recovery-generation' as Owner['generation'] }, resumed = h.monitor();
  let activated = false; const activation = resumed.activate(owner).then(() => { activated = true; });
  try {
    await vi.waitFor(() => expect(activated).toBe(true), { timeout: 500 });
    await vi.waitFor(() => expect(vi.mocked(open).mock.calls.filter(([path]) => path === h.owner.sessionFile)).toHaveLength(1));
    await expect(resumed.start(program, owner, on, { background: true })).resolves.toHaveProperty('id');
  } finally { release(); await activation; }
  await vi.waitFor(() => expect(h.notices).toHaveLength(1));
});

it('retries a failed recovery read rather than caching its rejection', async () => {
  const h = await monitorFixture(); h.owner.sessionFile = join(h.f.root, 'session.jsonl');
  const first = h.monitor(), job = await first.start(program, h.owner, on, { background: true });
  await first.detach(job.id); h.complete(job.address);
  await vi.waitFor(() => expect(h.notices).toHaveLength(1)); await first.consumeNotice(job.id); await first.shutdown('reload'); h.notices.length = 0;
  await writeFile(h.owner.sessionFile, JSON.stringify({ type: 'session', id: h.owner.sessionId }) + '\n');
  let reads = 0, now = 1000; const failures: unknown[] = [];
  vi.mocked(open).mockImplementation((path, flags, mode) => {
    if (path === h.owner.sessionFile && ++reads === 1) return Promise.reject(Object.assign(new Error('Read failed'), { code: 'EACCES' }));
    return actual.open(path, flags, mode);
  });
  const resumed = h.monitor({ clock: () => now, recordCleanupError: error => { failures.push(error); } });
  await resumed.activate({ ...h.owner, generation: 'retry-generation' as Owner['generation'] });
  await vi.waitFor(() => expect(failures).toHaveLength(1));
  now += 60000; await resumed.reconcile();
  await vi.waitFor(() => expect(h.notices).toHaveLength(1));
  await resumed.consumeNotice(job.id);
  await vi.waitFor(async () => expect((await createJobStore(h.f.root, h.owner.sessionId).read()).jobs[0].terminalReleased).toBe(true));
  expect(reads).toBe(2);
});

it('stops recovery while session open is hung and closes the late file handle', async () => {
  const h = await monitorFixture(); h.owner.sessionFile = join(h.f.root, 'session.jsonl');
  const first = h.monitor(), job = await first.start(program, h.owner, on, { background: true });
  await first.detach(job.id); h.complete(job.address);
  await vi.waitFor(() => expect(h.notices).toHaveLength(1)); await first.consumeNotice(job.id); await first.shutdown('reload');
  await writeFile(h.owner.sessionFile, JSON.stringify({ type: 'session', id: h.owner.sessionId }) + '\n');
  const file = await actual.open(h.owner.sessionFile, 'r'), close = vi.spyOn(file, 'close'), blocked = deferred<void>(); let opening = false;
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    if (path !== h.owner.sessionFile) return actual.open(path, flags, mode);
    opening = true; await blocked.promise; return file;
  });
  const resumed = h.monitor(); await resumed.activate({ ...h.owner, generation: 'stop-generation' as Owner['generation'] });
  try {
    await vi.waitFor(() => expect(opening).toBe(true));
    await expect(bounded(resumed.shutdown('reload'))).resolves.toBeUndefined();
  } finally { blocked.resolve(); await resumed.shutdown('reload'); }
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
});

it('bounds session open even without shutdown and closes a handle returned after the deadline', async () => {
  const h = await monitorFixture(); h.owner.sessionFile = join(h.f.root, 'session.jsonl'); await writeFile(h.owner.sessionFile, '');
  const file = await actual.open(h.owner.sessionFile, 'r'), close = vi.spyOn(file, 'close'), blocked = deferred<void>();
  vi.mocked(open).mockImplementation(async () => { await blocked.promise; return file; });
  vi.useFakeTimers(); let failure: unknown;
  const recovery = recoverJobNotices([], h.owner).catch(error => { failure = error; });
  try { await vi.advanceTimersByTimeAsync(1000); expect(failure).toMatchObject({ code: 'session-read-timeout' }); }
  finally { blocked.resolve(); await recovery; vi.useRealTimers(); }
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
});

it('indexes a large session once for 129 jobs and skips confirmed notices in later generations', async () => {
  const h = await monitorFixture(); h.owner.sessionFile = join(h.f.root, 'session.jsonl');
  const first = h.monitor(), job = await first.start(program, h.owner, on, { background: true });
  await first.detach(job.id); h.complete(job.address);
  await vi.waitFor(() => expect(h.notices).toHaveLength(1)); await first.consumeNotice(job.id);
  await first.shutdown('reload'); h.notices.length = 0;
  const store = createJobStore(h.f.root, h.owner.sessionId), journal = await store.read(), original = journal.jobs[0];
  journal.jobs = Array.from({ length: 129 }, (_, index) => ({ ...original, id: `recovery-${index}` as typeof original.id, nonce: `nonce-${index}`, terminalReleased: true }));
  await store.write(journal);
  const entries = [{ type: 'session', id: h.owner.sessionId }, ...journal.jobs.map((record, index) => ({ type: 'custom_message', customType: 'spider.job_done', details: { jobId: record.id, ...(index % 2 ? {} : { nonce: record.nonce }) } }))];
  await writeFile(h.owner.sessionFile, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const padding = JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(256 * 1024) }] } });
  await appendFile(h.owner.sessionFile, (padding + '\n').repeat(128));
  const owner = { ...h.owner, generation: 'indexed-generation' as Owner['generation'] }, resumed = h.monitor();
  await resumed.activate(owner);
  await vi.waitFor(async () => expect((await store.read()).jobs.filter(record => record.noticeSavedNonce === record.nonce)).toHaveLength(129), { timeout: 5000 });
  expect(vi.mocked(open).mock.calls.filter(([path]) => path === h.owner.sessionFile)).toHaveLength(1);
  await resumed.shutdown('reload');
  const later = h.monitor(); await later.activate({ ...owner, generation: 'later-generation' as Owner['generation'] }); await later.reconcile();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(vi.mocked(open).mock.calls.filter(([path]) => path === h.owner.sessionFile)).toHaveLength(1);
  expect(h.notices).toHaveLength(0);
});

const header = (id: string) => JSON.stringify({ type: 'session', id }) + '\n';
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise(resolve => child.once('exit', resolve));
  return child.pid!;
}

it('a retried recovery task does not resend a notice it already resent', async () => {
  const h = await monitorFixture(); h.owner.sessionFile = join(h.f.root, 'session.jsonl');
  const first = h.monitor();
  const a = await first.start(program, h.owner, on, { background: true }); await first.detach(a.id); h.complete(a.address);
  const b = await first.start(program, h.owner, on, { background: true }); await first.detach(b.id); h.complete(b.address);
  await vi.waitFor(() => expect(h.notices).toHaveLength(2));
  await writeFile(h.owner.sessionFile, header(h.owner.sessionId));
  await first.shutdown('reload'); h.notices.length = 0;
  let now = 1000, failB = true; const failures: unknown[] = [];
  const resumed = h.monitor({ clock: () => now, recordCleanupError: error => { failures.push(error); }, notifier: notice => {
    if (notice.details.jobId === b.id && failB) { failB = false; throw new Error('one failed submit (stands in for a failed journal write)'); }
    h.notices.push(notice);
  } });
  await resumed.activate({ ...h.owner, generation: 'g2' as Owner['generation'] });
  await vi.waitFor(() => expect(failures).toHaveLength(1));
  expect(h.notices.map(n => n.details.jobId)).toEqual([a.id]);
  now += 60000; await resumed.reconcile();
  await vi.waitFor(async () => expect((await createJobStore(h.f.root, h.owner.sessionId).read()).jobs.every(job => job.notice === 'submitted')).toBe(true));
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(h.notices.filter(n => n.details.jobId === a.id)).toHaveLength(1);
});

it('a second live activation does not resend another live activation\'s in-flight notice', async () => {
  const h = await monitorFixture(); h.owner.sessionFile = join(h.f.root, 'session.jsonl');
  await writeFile(h.owner.sessionFile, header(h.owner.sessionId));
  const live = h.monitor(), job = await live.start(program, h.owner, on, { background: true });
  await live.detach(job.id); h.complete(job.address);
  await vi.waitFor(() => expect(h.notices).toHaveLength(1));
  // The first process's agent is streaming, so pi has queued the steer and not saved it yet.
  const other = h.monitor(); await other.activate({ ...h.owner, generation: 'g-other' as Owner['generation'] });
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(h.notices).toHaveLength(1);
});

it('a crash-cancelled foreground job gets no notice after a later reload', async () => {
  const h = await monitorFixture(); h.owner.sessionFile = join(h.f.root, 'session.jsonl');
  await writeFile(h.owner.sessionFile, header(h.owner.sessionId));
  const first = h.monitor(), job = await first.start(program, h.owner, on, {});
  await first.shutdown('reload');
  const store = createJobStore(h.f.root, h.owner.sessionId), journal = await store.read();
  journal.writer = { pid: await deadPid(), startIdentity: 'posix:gone', shutdown: null }; await store.write(journal);
  const second = h.monitor(); await second.activate({ ...h.owner, generation: 'g2' as Owner['generation'] });
  await vi.waitFor(() => expect(h.kills).toEqual([job.address]));
  h.complete(job.address);
  for (let i = 0; i < 3; i++) await second.reconcile();
  await vi.waitFor(async () => expect((await store.read()).jobs[0]).toMatchObject({ handoffCancelled: true, notice: 'observed', noticeMode: 'async', output: { complete: true } }));
  expect(h.notices).toHaveLength(0);
  await second.shutdown('reload');
  const third = h.monitor(); await third.activate({ ...h.owner, generation: 'g3' as Owner['generation'] });
  await new Promise(resolve => setTimeout(resolve, 300)); await third.reconcile();
  expect(h.notices.map(n => n.content.split('\n')[0])).toEqual([]);
});

it('a saved notice whose submit call failed is acknowledged and its terminal released after restart', async () => {
  const h = await monitorFixture(); h.owner.sessionFile = join(h.f.root, 'session.jsonl');
  let fail = true;
  const first = h.monitor({ notifier: notice => { if (fail) { fail = false; throw new Error('uncertain submit'); } h.notices.push(notice); } });
  const job = await first.start(program, h.owner, on, { background: true }); await first.detach(job.id); h.complete(job.address);
  const store = createJobStore(h.f.root, h.owner.sessionId);
  await vi.waitFor(async () => expect((await store.read()).jobs[0]).toMatchObject({ notice: 'submitted', noticeDelivered: false }));
  const nonce = (await store.read()).jobs[0].nonce;
  // pi saved the entry although the call reported failure.
  await writeFile(h.owner.sessionFile, header(h.owner.sessionId) + JSON.stringify({ type: 'custom_message', customType: 'spider.job_done', details: { jobId: job.id, nonce } }) + '\n');
  await first.shutdown('reload');
  const resumed = h.monitor(); await resumed.activate({ ...h.owner, generation: 'g2' as Owner['generation'] });
  await vi.waitFor(async () => expect((await store.read()).jobs[0]).toMatchObject({ notice: 'observed', noticeSavedNonce: nonce, terminalReleased: true }));
  expect(h.notices).toHaveLength(0);
});
