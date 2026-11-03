// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { createJobStore } from '../jobs/store.js';
import { finish, monitorFixture, on, program } from './herdr-monitor-fixture.js';
import type { JobMonitorOptions } from '../jobs/monitor.js';

async function fixture() {
  const h = await monitorFixture();
  h.options.outputCollector = {
    prepare: h.options.outputCollector.prepare,
    collect: async job => {
      const terminal = 'address' in job.phase ? h.terminals.get(job.phase.address) : undefined;
      const done = terminal?.state === 'finished';
      return { complete: Boolean(done), summary: done ? 'logs' : '', receipt: done ? { jobId: job.id, nonce: 'nonce', finish } : null };
    },
  } satisfies JobMonitorOptions['outputCollector'];
  return h;
}

it('keeps a crashed child console open through failed cancellation and an unconfirmed kill reply', async () => {
  const h = await fixture();
  const child = h.monitor({ child: { id: 'crashed-order' as never, pid: process.pid, startIdentity: 'gone-writer' } });
  const foreground = await child.start(program, h.owner, on, {});
  const background = await child.start(program, h.owner, on, { background: true });
  await child.shutdown('reload');
  let attempts = 0;
  h.hc.kill = async address => { h.kills.push(address); if (++attempts === 1) throw new Error('kill failed'); };
  const closed: string[] = [];
  h.options.closeAgentConsoles = async owner => { closed.push(owner.runId); };
  h.options.observedJobMessages = async () => h.notices.map(notice => notice.details.jobId);
  const parent = h.monitor(); await parent.activate(h.owner);
  expect(closed).toEqual([]);
  await parent.reconcile();
  // A successful signal acknowledgement is not proof the process has stopped.
  await vi.waitFor(() => expect(attempts).toBe(2), { timeout: 5000 });
  expect(closed).toEqual([]);
  expect(h.terminals.get(foreground.address)?.state).toBe('live');
  h.complete(foreground.address); await parent.reconcile(); await parent.reconcile();
  await vi.waitFor(() => expect(closed).toEqual(['crashed-order']), { timeout: 5000 });
  expect(h.terminals.get(background.address)?.state).toBe('live');
  h.complete(background.address); await parent.reconcile(); await parent.reconcile();
  await vi.waitFor(() => expect(h.notices.filter(notice => notice.details.jobId === background.id)).toHaveLength(1), { timeout: 5000 });
  await vi.waitFor(async () => expect((await createJobStore(h.f.root, h.owner.sessionId, 'crashed-order' as never).read()).child?.settled).toBe(true), { timeout: 7000 });
});

it('an undiscovered foreground launch holds console cleanup until its labelled terminal is recovered', async () => {
  const h = await fixture();
  const child = h.monitor({ child: { id: 'lost-order' as never, pid: process.pid, startIdentity: 'gone-writer' } });
  const foreground = await child.start(program, h.owner, on, {}); await child.shutdown('reload');
  const terminal = h.terminals.get(foreground.address)!; h.terminals.delete(foreground.address);
  const store = createJobStore(h.f.root, h.owner.sessionId, 'lost-order' as never), journal = await store.read();
  journal.jobs[0].phase = { kind: 'preparing' }; await store.write(journal);
  const closed: string[] = []; h.options.closeAgentConsoles = async owner => { closed.push(owner.runId); };
  h.hc.kill = async address => { h.kills.push(address); h.complete(address); };
  const parent = h.monitor(); await parent.activate(h.owner); await parent.reconcile();
  expect(closed).toEqual([]);
  await vi.waitFor(async () => expect((await store.read()).writer?.crashJobs).toContain(foreground.id), { timeout: 5000 });
  h.terminals.set(foreground.address, terminal); h.emit({ type: 'created', terminal: foreground.address, seq: 3, data: terminal });
  await parent.reconcile();
  await vi.waitFor(() => expect(h.kills).toEqual([foreground.address]), { timeout: 5000 });
  await vi.waitFor(() => expect(closed).toEqual(['lost-order']), { timeout: 5000 });
});
