// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registerHerdrJobs } from '../jobs/register.js';
import { createJobStore } from '../jobs/store.js';
import { HerdrError } from '../client/parse.js';
import type { TerminalAddress } from '../contracts.js';
import { bounded, deferred, monitorFixture, on, program } from './herdr-monitor-fixture.js';

async function backlog(count = 1) {
  const f = await monitorFixture(), jobs = f.monitor();
  const handles = [];
  for (let i = 0; i < count; i++) {
    const handle = await jobs.start(program, f.owner, on, {});
    f.complete(handle.address); await jobs.reconcile(); handles.push(handle);
  }
  await jobs.shutdown('reload');
  const store = createJobStore(f.f.root, f.owner.sessionId), journal = await store.read();
  for (const job of journal.jobs) { job.notice = 'observed'; job.noticeDelivered = true; job.settledMarked = true; delete job.terminalReleased; }
  await store.write(journal);
  return { ...f, handles, store };
}

it('activates and reconciles a large backlog without waiting for unreachable cleanup', async () => {
  const f = await backlog(24), stuck = deferred<never>(), get = vi.spyOn(f.hc, 'get').mockImplementation(() => stuck.promise);
  const jobs = f.monitor();
  await expect(bounded(jobs.activate(f.owner))).resolves.toBeUndefined();
  await expect(bounded(jobs.reconcile())).resolves.toBeUndefined();
  await vi.waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(0));
  expect(get.mock.calls.length).toBeLessThanOrEqual(4);
  await expect(bounded(jobs.shutdown('reload'))).resolves.toBeUndefined();
  const calls = get.mock.calls.length;
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(get).toHaveBeenCalledTimes(calls);
});

it('a timed out get does not block later jobs and failed jobs back off without repeated reports', async () => {
  const f = await backlog(6), original = f.hc.get, stuck = deferred<never>();
  let now = 1000;
  const get = vi.spyOn(f.hc, 'get').mockImplementation(address => address === f.handles[0].address ? stuck.promise : original(address));
  const jobs = f.monitor({ clock: () => now });
  await expect(bounded(jobs.activate(f.owner))).resolves.toBeUndefined();
  await vi.waitFor(() => expect(f.terminals.has(f.handles[5].address)).toBe(false));
  await vi.waitFor(() => expect(f.errors).toHaveLength(1), { timeout: 6500 });
  for (let i = 0; i < 3; i++) await jobs.reconcile();
  expect(get.mock.calls.filter(([address]) => address === f.handles[0].address)).toHaveLength(1);
  expect(f.errors).toHaveLength(1);
  now += 60000; await jobs.reconcile();
  await vi.waitFor(() => expect(get.mock.calls.filter(([address]) => address === f.handles[0].address)).toHaveLength(2));
});

it('notice consumption preserves the command result while removal is stuck or fails', async () => {
  const f = await monitorFixture(), jobs = f.monitor(), stuck = deferred<void>();
  const handle = await jobs.start(program, f.owner, on, {});
  f.complete(handle.address); await jobs.reconcile();
  vi.spyOn(f.hc, 'rm').mockImplementation(() => stuck.promise);
  await expect(bounded(jobs.consumeNotice(handle.id))).resolves.toBeUndefined();
  expect(await handle.finished).toMatchObject({ exitCode: 23, reason: 'exited' });
  await vi.waitFor(() => expect(f.errors).toHaveLength(1), { timeout: 9500 });
  expect((await createJobStore(f.f.root, f.owner.sessionId).read()).jobs[0].terminalReleased).not.toBe(true);
});

it.each(['uncertain', 'foreign', 'unmarked'])('prunes seven day logs independently of %s terminal release', async mode => {
  const f = await backlog(), journal = await f.store.read(), job = journal.jobs[0];
  job.updatedAt = 0;
  if (mode === 'uncertain') { job.uncertain = true; job.originalFinish = null; job.settledMarked = false; job.terminalExpired = true; }
  if (mode === 'unmarked') { job.settledMarked = false; vi.spyOn(f.hc, 'fileWrite').mockRejectedValue(new Error('machine removed')); }
  if (mode === 'foreign') f.terminals.get(f.handles[0].address)!.labels = {};
  await writeFile(join(job.localDirectory, 'stdout.log'), 'old output'); await f.store.write(journal);
  const jobs = f.monitor({ clock: () => 8 * 86400000 }); await jobs.activate(f.owner); await jobs.reconcile();
  await vi.waitFor(async () => expect((await f.store.read()).jobs).toEqual([]));
  await expect(readFile(join(job.localDirectory, 'stdout.log'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not recheck a relabelled terminal on every reconcile', async () => {
  const f = await backlog(), get = vi.spyOn(f.hc, 'get'), removed = vi.spyOn(f.hc, 'rm');
  f.terminals.get(f.handles[0].address)!.labels = {};
  const jobs = f.monitor(); await jobs.activate(f.owner);
  await vi.waitFor(() => expect(get).toHaveBeenCalled());
  for (let i = 0; i < 4; i++) await jobs.reconcile();
  expect(get).toHaveBeenCalledTimes(1);
  expect(removed).not.toHaveBeenCalled();
});

it('does not release a parent job terminal carrying a child run label', async () => {
  const f = await backlog(), removed = vi.spyOn(f.hc, 'rm');
  f.terminals.get(f.handles[0].address)!.labels = { ...f.terminals.get(f.handles[0].address)!.labels, 'spider.run': 'another-run' };
  const jobs = f.monitor(); await jobs.activate(f.owner); await jobs.reconcile();
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(removed).not.toHaveBeenCalled();
  expect(f.terminals.has(f.handles[0].address)).toBe(true);
});

it('does not mistake a disconnected machine not_found reply for a released terminal', async () => {
  const f = await backlog();
  vi.spyOn(f.hc, 'get').mockRejectedValue(new HerdrError('not_found', 'No such terminal'));
  vi.spyOn(f.hc, 'machines').mockResolvedValue([{ id: 'remote-core' as never, name: on, aliases: [], state: 'disconnected', sessionNamespace: 'r', runtime: null }]);
  const jobs = f.monitor(); await jobs.activate(f.owner); await jobs.reconcile();
  await new Promise(resolve => setTimeout(resolve, 30));
  expect((await f.store.read()).jobs[0].terminalReleased).not.toBe(true);
  expect(f.terminals.has(f.handles[0].address as TerminalAddress)).toBe(true);
});

it('keeps final output visible for two seconds after foreground consumption', async () => {
  const f = await monitorFixture(), removed = vi.spyOn(f.hc, 'rm'), jobs = f.monitor();
  const handle = await jobs.start(program, f.owner, on, {});
  f.complete(handle.address); await jobs.reconcile();
  const finishedAt = Date.now(); await jobs.consumeNotice(handle.id);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(removed).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(removed.mock.calls.map(([address]) => [address])).toEqual([[handle.address]]), { timeout: 3500 });
  expect(Date.now() - finishedAt).toBeGreaterThanOrEqual(1800);
});

it('settled legacy child journals release terminals without resending stale tool notices', async () => {
  const f = await backlog(), source = await f.store.read(), childStore = createJobStore(f.f.root, f.owner.sessionId, 'legacy-child' as never);
  source.child = { id: 'legacy-child' as never, pid: process.pid, startIdentity: 'ended', ended: true, settled: true };
  const job = source.jobs[0]; job.runId = source.child.id; job.notice = 'pending'; job.noticeMode = 'tool'; job.terminalExpired = true;
  f.terminals.get(f.handles[0].address)!.labels = { ...f.terminals.get(f.handles[0].address)!.labels, 'spider.run': job.runId };
  await childStore.write(source); const empty = await f.store.read(); empty.jobs = []; await f.store.write(empty);
  const removed = vi.spyOn(f.hc, 'rm'), jobs = f.monitor({ closeAgentConsoles: async () => {} });
  await jobs.activate(f.owner);
  await vi.waitFor(() => expect(removed.mock.calls.map(([address]) => [address])).toEqual([[f.handles[0].address]]));
  expect(f.notices).toEqual([]);
  await vi.waitFor(async () => expect((await childStore.read()).jobs[0].terminalReleased).toBe(true));
});

it('binds remote execution before any backlog cleanup starts', async () => {
  const f = await backlog(12), get = vi.spyOn(f.hc, 'get').mockRejectedValue(new Error('unreachable'));
  const hooks = new Map<string, Function>(); let bound = false;
  const registration = registerHerdrJobs({ on(name: string, handler: Function) { hooks.set(name, handler); return () => {}; }, sendMessage() {} } as never, {
    currentOwner: () => f.owner, monitorOptions: () => f.options, jobIdsForToolResult: () => [],
    bind(value) { if (value) { expect(get).not.toHaveBeenCalled(); bound = true; } },
  });
  try {
    await bounded(hooks.get('session_start')!({}, {}));
    expect(bound).toBe(true);
    await vi.waitFor(() => expect(get).toHaveBeenCalled());
  } finally { await registration.dispose(); }
});
