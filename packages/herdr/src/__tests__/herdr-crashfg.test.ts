// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { createJobStore } from '../jobs/store.js';
import { finish, monitorFixture, on, program } from './herdr-monitor-fixture.js';
import type { JobMonitorOptions } from '../jobs/monitor.js';
import type { TerminalFinish } from '../contracts.js';

async function fixture() {
  const h = await monitorFixture();
  const collector: JobMonitorOptions['outputCollector'] = {
    prepare: h.options.outputCollector.prepare,
    collect: async job => {
      const terminal = 'address' in job.phase ? h.terminals.get(job.phase.address) : undefined;
      const done = terminal?.state === 'finished';
      return { complete: Boolean(done), summary: done ? 'destination logs' : '', receipt: done ? {
        jobId: job.id, nonce: 'nonce', finish: { exitCode: terminal.exitCode, reason: terminal.reason!, signal: terminal.signal, finishedAt: terminal.finishedAt! },
      } : null };
    },
  };
  h.options.outputCollector = collector;
  h.options.closeAgentConsoles = async () => {};
  h.hc.kill = async address => {
    h.kills.push(address);
    const result: TerminalFinish = { exitCode: null, signal: 1, reason: 'killed', finishedAt: 1000 };
    Object.assign(h.terminals.get(address)!, { state: 'finished', ...result });
    h.emit({ type: 'finished', terminal: address, seq: 3, data: result });
  };
  return h;
}

it('child crash cancels foreground with its cause and adopts background only once', async () => {
  const h = await fixture();
  const child = h.monitor({ child: { id: 'crashed-child' as never, pid: process.pid, startIdentity: 'previous-process' } });
  const foreground = await child.start(program, h.owner, on, {});
  const background = await child.start(program, h.owner, on, { background: true });
  await child.shutdown('reload');
  const parent = h.monitor(); await parent.activate(h.owner); await parent.reconcile();
  const store = createJobStore(h.f.root, h.owner.sessionId, 'crashed-child' as never);
  const cancelled = (await store.read()).jobs.find(job => job.id === foreground.id)!;
  expect(h.kills).toEqual([foreground.address]);
  expect(cancelled.phase).toMatchObject({ kind: 'finished', result: { reason: 'cancelled' } });
  expect(cancelled.output?.summary).toContain('caller crashed');
  expect(cancelled.settledMarked).toBe(true);
  h.complete(background.address); await parent.reconcile(); await parent.reconcile();
  expect(h.notices.filter(notice => notice.details.jobId === background.id)).toHaveLength(1);
  expect(h.notices.filter(notice => notice.details.jobId === foreground.id).length).toBeLessThanOrEqual(1);
  await parent.shutdown('reload'); const reloaded = h.monitor(); await reloaded.activate(h.owner);
  expect(h.kills).toEqual([foreground.address]);
  expect(h.errors).toEqual([]);
});

it('session crash cancels its foreground but adopts background before detach', async () => {
  const h = await fixture(), previous = h.monitor();
  const foreground = await previous.start(program, h.owner, on, {});
  const background = await previous.start(program, h.owner, on, { background: true });
  await previous.shutdown('reload');
  const store = createJobStore(h.f.root, h.owner.sessionId);
  // Model the durable journal of an activation that never ran shutdown.
  const raw = JSON.parse(await readFile(store.path, 'utf8'));
  raw.writer = { pid: process.pid, startIdentity: 'previous-process', shutdown: null };
  await writeFile(store.path, JSON.stringify(raw));
  const resumed = h.monitor(); await resumed.activate({ ...h.owner, generation: 'resumed' as never });
  expect(h.kills).toEqual([foreground.address]);
  expect((await store.read()).jobs.find(job => job.id === foreground.id)?.phase).toMatchObject({ kind: 'finished', result: { reason: 'cancelled' } });
  await resumed.shutdown('quit');
  expect(h.kills).toEqual([foreground.address]);
  const next = h.monitor(); await next.activate(h.owner);
  h.complete(background.address); await next.reconcile(); await next.reconcile();
  expect(h.notices.filter(notice => notice.details.jobId === background.id)).toHaveLength(1);
  expect(h.errors).toEqual([]);
});

it('a failed crash cancellation is retried rather than marked cancelled while still live', async () => {
  const h = await fixture();
  const child = h.monitor({ child: { id: 'retry-child' as never, pid: process.pid, startIdentity: 'previous-process' } });
  const foreground = await child.start(program, h.owner, on, {}); await child.shutdown('reload');
  const kill = h.hc.kill; let attempts = 0;
  h.hc.kill = async address => { if (++attempts === 1) throw new Error('transient kill failure'); await kill(address); };
  const parent = h.monitor(); await parent.activate(h.owner); await parent.reconcile();
  expect(h.terminals.has(foreground.address)).toBe(false);
  expect((await createJobStore(h.f.root, h.owner.sessionId, 'retry-child' as never).read()).jobs[0]).toMatchObject({ phase: { kind: 'finished', result: { reason: 'cancelled' } }, terminalReleased: true });
  expect(attempts).toBe(2);
  expect(h.errors).toHaveLength(1);
});

it('a lost kill reply still records caller-crash cancellation after retry', async () => {
  const h = await fixture();
  const child = h.monitor({ child: { id: 'lost-kill-child' as never, pid: process.pid, startIdentity: 'previous-process' } });
  const foreground = await child.start(program, h.owner, on, {}); await child.shutdown('reload');
  const kill = h.hc.kill;
  h.hc.kill = async address => { await kill(address); throw new Error('lost kill reply'); };
  const parent = h.monitor(); await parent.activate(h.owner); await parent.reconcile();
  const journal = await createJobStore(h.f.root, h.owner.sessionId, 'lost-kill-child' as never).read();
  expect(journal.jobs[0].phase).toMatchObject({ kind: 'finished', result: { reason: 'cancelled' } });
  expect(h.kills).toEqual([foreground.address]);
});

it('legacy owner journals without writer metadata never cancel foreground on activation', async () => {
  const h = await fixture(), previous = h.monitor();
  const foreground = await previous.start(program, h.owner, on, {}); await previous.shutdown('reload');
  const store = createJobStore(h.f.root, h.owner.sessionId), raw = JSON.parse(await readFile(store.path, 'utf8'));
  delete raw.writer; await writeFile(store.path, JSON.stringify(raw));
  expect((await store.read()).writer).toBeUndefined();
  const resumed = h.monitor(); await resumed.activate({ ...h.owner, generation: 'legacy-resume' as never });
  expect(h.kills).toEqual([]); expect(h.terminals.get(foreground.address)?.state).toBe('live');
});

it('a clean child end keeps its original signal result rather than crash cancellation', async () => {
  const h = await fixture();
  const child = h.monitor({ child: { id: 'clean-child' as never, pid: process.pid, startIdentity: 'previous-process' } });
  await child.start(program, h.owner, on, {}); await child.shutdown('quit');
  const parent = h.monitor(); await parent.activate(h.owner); await parent.reconcile();
  const journal = await createJobStore(h.f.root, h.owner.sessionId, 'clean-child' as never).read();
  expect(journal.jobs[0].phase).toMatchObject({ kind: 'finished', result: { reason: 'killed' } });
});

it('reload preserves foreground work', async () => {
  const h = await fixture(), previous = h.monitor();
  const foreground = await previous.start(program, h.owner, on, {}); await previous.shutdown('reload');
  const reloaded = h.monitor(); await reloaded.activate({ ...h.owner, generation: 'reload' as never });
  expect(h.kills).toEqual([]); expect(h.terminals.get(foreground.address)?.state).toBe('live');
  h.complete(foreground.address); await reloaded.reconcile();
  expect((await createJobStore(h.f.root, h.owner.sessionId).read()).jobs[0].phase).toMatchObject({ kind: 'finished', result: finish });
});
