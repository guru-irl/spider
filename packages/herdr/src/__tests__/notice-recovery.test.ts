// SPDX-License-Identifier: MIT
import { it, expect, vi, afterEach } from 'vitest';
import { appendFile, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Owner } from '../contracts.js';
import { createJobStore } from '../jobs/store.js';
import { registerHerdrJobs } from '../jobs/register.js';
import type { JobMonitor, JobNotice } from '../jobs/monitor.js';
import { monitorFixture, on, program } from './herdr-monitor-fixture.js';

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
