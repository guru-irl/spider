// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { HerdrError } from '../client/parse.js';
import { createJobStore } from '../jobs/store.js';
import { bounded, monitorFixture, on, program } from './herdr-monitor-fixture.js';

it('shutdown attempts every kill, disposes events, and succeeds again after core loss', async () => {
  const h = await monitorFixture(), jobs = h.monitor();
  const first = await jobs.start(program, h.owner, on, {}), second = await jobs.start(program, h.owner, on, {});
  h.hc.kill = async address => { h.kills.push(address); throw new HerdrError('core-unavailable', 'Herdr core is not running'); };
  await expect(bounded(jobs.shutdown('quit'))).resolves.toBeUndefined();
  await expect(bounded(Promise.resolve(jobs.dispose()))).resolves.toBeUndefined();
  expect(h.kills).toEqual([first.address, second.address]);
  expect(h.liveViews()).toBe(0);
  expect(h.errors).toEqual([]);
});

it('periodic monitoring does not report core loss again before host cleanup', async () => {
  const h = await monitorFixture();
  let ready = Promise.resolve(); const events = h.hc.events;
  h.hc.events = () => ({ ...events(), get ready() { return ready; } });
  const jobs = h.monitor(); await jobs.activate(h.owner);
  ready = Promise.reject(new HerdrError('core-unavailable', 'Herdr core is not running')); void ready.catch(() => {});
  await delay(2200); await jobs.shutdown('reload');
  expect(h.errors).toEqual([]);
});

it('shutdown persists child completion even when one original cannot be killed', async () => {
  const h = await monitorFixture(), jobs = h.monitor({ child: { id: 'ended-run' as never, pid: process.pid, startIdentity: 'test-child' } });
  await jobs.start(program, h.owner, on, {});
  h.hc.kill = async () => { throw new Error('kill failed'); };
  await expect(jobs.shutdown('quit')).resolves.toBeUndefined();
  const journal = await createJobStore(h.f.root, h.owner.sessionId, 'ended-run' as never).read();
  expect(journal.child?.ended).toBe(true);
  expect(h.liveViews()).toBe(0);
  expect(h.errors).toHaveLength(1);
});
