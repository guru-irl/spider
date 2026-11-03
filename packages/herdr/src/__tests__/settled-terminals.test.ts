// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createJobStore } from '../jobs/store.js';
import type { JobId, RunId, TerminalAddress } from '../contracts.js';
import { processStartIdentity } from '../jobs/handoff.js';
import { monitorFixture, on, program } from './herdr-monitor-fixture.js';

it('removes a finished background terminal only after observation and retains logs and receipt', async () => {
  const f = await monitorFixture(), removed = vi.spyOn(f.hc, 'rm');
  const jobs = f.monitor();
  const handle = await jobs.start(program, f.owner, on, { background: true });
  await writeFile(join(handle.localDirectory, 'stdout.log'), 'saved output');
  await writeFile(join(handle.localDirectory, 'receipt.json'), '{"exitCode":23}');
  await jobs.detach(handle.id); await jobs.toolReturned(handle.id);
  f.complete(handle.address); await jobs.reconcile();
  expect(f.notices).toHaveLength(1);
  expect(f.notices[0].details).toMatchObject({ jobId: handle.id, exitCode: 23, complete: true });
  expect(removed).not.toHaveBeenCalled();
  await jobs.consumeNotice(handle.id);
  expect(removed.mock.calls).toEqual([[handle.address]]);
  expect(await readFile(join(handle.localDirectory, 'stdout.log'), 'utf8')).toBe('saved output');
  expect(await readFile(join(handle.localDirectory, 'receipt.json'), 'utf8')).toBe('{"exitCode":23}');
  await jobs.reconcile();
  expect(removed).toHaveBeenCalledTimes(1);
});

it('removes a finished terminal consumed by its foreground tool call', async () => {
  const f = await monitorFixture(), removed = vi.spyOn(f.hc, 'rm'), jobs = f.monitor();
  const handle = await jobs.start(program, f.owner, on, {});
  f.complete(handle.address); await jobs.reconcile();
  await jobs.consumeNotice(handle.id);
  expect(removed.mock.calls).toEqual([[handle.address]]);
  expect(f.notices).toEqual([]);
});

it.each(['t-old', 'remote.invalid/t-old'])('activation removes owned settled terminal %s without pruning artifacts', async address => {
  const f = await monitorFixture(), removed = vi.spyOn(f.hc, 'rm');
  const jobs = f.monitor(), handle = await jobs.start(program, f.owner, on, { background: true });
  f.complete(handle.address); await jobs.detach(handle.id); await jobs.shutdown('reload');
  const store = createJobStore(f.f.root, f.owner.sessionId), journal = await store.read(), job = journal.jobs[0];
  const terminal = f.terminals.get(handle.address)!; f.terminals.delete(handle.address);
  f.terminals.set(address as TerminalAddress, { ...terminal, address: address as TerminalAddress });
  job.phase = { kind: 'finished', address: address as TerminalAddress, result: { exitCode: 23, reason: 'exited', signal: null, finishedAt: 1000 } };
  job.notice = 'observed'; job.noticeDelivered = true; job.settledMarked = true;
  await store.write(journal); await writeFile(join(handle.localDirectory, 'receipt.json'), 'retained receipt');
  const resumed = f.monitor(); await resumed.activate({ ...f.owner, generation: 'g2' as never });
  expect(removed.mock.calls).toEqual([[address]]);
  expect(await readFile(join(handle.localDirectory, 'receipt.json'), 'utf8')).toBe('retained receipt');
  expect((await store.read()).jobs).toHaveLength(1);
});

it.each(['spider.session', 'spider.owner-core', 'spider.owner-terminal', 'spider.kind', 'spider.job'])('never removes a terminal with foreign %s', async label => {
  const f = await monitorFixture(), removed = vi.spyOn(f.hc, 'rm'), jobs = f.monitor();
  const handle = await jobs.start(program, f.owner, on, {});
  f.complete(handle.address); await jobs.reconcile();
  await jobs.consumeNotice(handle.id);
  expect(removed.mock.calls).toEqual([[handle.address]]);
  removed.mockClear();
  const foreign = await jobs.start(program, f.owner, on, {});
  f.complete(foreign.address); await jobs.reconcile();
  f.terminals.get(foreign.address)!.labels = { ...f.terminals.get(foreign.address)!.labels, [label]: 'foreign' };
  await jobs.consumeNotice(foreign.id); await jobs.reconcile();
  expect(removed).not.toHaveBeenCalled();
  expect(f.terminals.has(foreign.address)).toBe(true);
});

it('an ended child stays owned until its submitted notice is observed and its terminal is removed', async () => {
  const f = await monitorFixture(), removed = vi.spyOn(f.hc, 'rm'), observed: JobId[] = [];
  const runId = 'ended-child' as RunId;
  const child = f.monitor({ child: { id: runId, pid: process.pid, startIdentity: processStartIdentity(process.pid)! } });
  const handle = await child.start(program, f.owner, on, { background: true });
  f.complete(handle.address); await child.detach(handle.id); await child.shutdown('quit');
  const parent = f.monitor({ observedJobMessages: async () => observed, closeAgentConsoles: async () => {} });
  await parent.activate(f.owner);
  const store = createJobStore(f.f.root, f.owner.sessionId, runId);
  expect((await store.read()).child?.settled).not.toBe(true);
  expect(removed).not.toHaveBeenCalled();
  observed.push(handle.id); await parent.reconcile();
  expect(removed.mock.calls).toEqual([[handle.address]]);
  expect((await store.read()).child?.settled).toBe(true);
});

it('reconciliation retries a failed removal after the notice was observed', async () => {
  const f = await monitorFixture(), removed = vi.spyOn(f.hc, 'rm'), jobs = f.monitor();
  const handle = await jobs.start(program, f.owner, on, {});
  f.complete(handle.address); await jobs.reconcile();
  removed.mockRejectedValueOnce(new Error('temporary removal failure'));
  await expect(jobs.consumeNotice(handle.id)).rejects.toThrow('temporary removal failure');
  await jobs.reconcile();
  expect(removed.mock.calls).toEqual([[handle.address], [handle.address]]);
  expect(f.terminals.has(handle.address)).toBe(false);
});
