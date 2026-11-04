// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, it } from 'vitest';
import type { MachineName, Owner, RunId, TerminalAddress, TerminalSummary } from '../contracts.js';
import { createJobStore, type JournalJob } from '../jobs/store.js';
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

it.each([
  { state: 'preparing', uncertain: false, evidenceConflict: false },
  { state: 'waiting-for-pane', uncertain: false, evidenceConflict: false },
  { state: 'finished', uncertain: true, evidenceConflict: false },
  { state: 'finished', uncertain: false, evidenceConflict: true },
] as const)('keeps $state jobs busy when uncertainty is $uncertain and conflict is $evidenceConflict', async ({ state, uncertain, evidenceConflict }) => {
  const h = await monitorFixture(); const address = 'remote.invalid/original' as TerminalAddress;
  const phase: JournalJob['phase'] = state === 'preparing' ? { kind: 'preparing' } : state === 'waiting-for-pane' ? { kind: 'waiting-for-pane', address } : { kind: 'finished', address, result: { exitCode: 0, reason: 'exited', signal: null, finishedAt: 1000 } };
  const job: JournalJob = { version: 1, id: 'job-one' as JournalJob['id'], owner: h.owner, machine: on, kind: 'exec', phase,
    viewer: null, remoteDirectory: '/fixture/remote', localDirectory: h.f.root, detached: false, noticeMode: 'tool', notice: 'observed',
    nonce: '', releaseDeadlineAt: 0, originalFinish: null, output: state === 'finished' ? { complete: true, summary: '' } : null,
    callerOwned: false, uncertain, evidenceConflict, noticeDelivered: true, settledMarked: state === 'finished', terminalExpired: false, updatedAt: 1000 };
  h.terminals.set(address, { address, parent: null, labels: { 'spider.job': job.id, 'spider.session': h.owner.sessionId }, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null } as TerminalSummary);
  await createJobStore(h.f.root, h.owner.sessionId).write({ version: 1, sessionId: h.owner.sessionId, revision: 1, updatedAt: 1000, jobs: [job] });
  const jobs = h.monitor(); await jobs.activate(h.owner);
  expect(await jobs.consoleIdle(h.owner, on)).toBe(false);
}, 15000);
