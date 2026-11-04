// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, it } from 'vitest';
import type { MachineName, Owner, RunId } from '../contracts.js';
import { monitorFixture, on, program } from './herdr-monitor-fixture.js';

it('reports idle only for the owning agent and machine after its job finishes', async () => {
  const h = await monitorFixture(); const jobs = h.monitor();
  const check = (jobs as typeof jobs & { consoleIdle?: (owner: Owner, machine: MachineName, run?: RunId) => Promise<boolean> }).consoleIdle;
  expect(typeof check).toBe('function');
  await jobs.activate(h.owner);
  expect(await check!(h.owner, on)).toBe(true);
  const handle = await jobs.start(program, h.owner, on, {});
  expect(await check!(h.owner, on)).toBe(false);
  expect(await check!(h.owner, 'other.invalid' as MachineName)).toBe(true);
  expect(await check!({ ...h.owner, sessionId: 'foreign' as Owner['sessionId'] }, on)).toBe(false);
  expect(await check!(h.owner, on, 'foreign-run' as RunId)).toBe(false);
  h.complete(handle.address); await jobs.reconcile();
  expect(await check!(h.owner, on)).toBe(true);
}, 15000);
