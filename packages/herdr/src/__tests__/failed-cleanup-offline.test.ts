// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobMonitor, type JobMonitorOptions } from '../jobs/monitor.js';
import { createJobStore, type JournalJob } from '../jobs/store.js';
import { createHcClient, type HcAvailabilitySource } from '../client/hc.js';
import { HerdrError } from '../client/parse.js';
import type { HcClient, JobId, MachineName, Owner, TerminalAddress, TerminalSummary } from '../contracts.js';

const recoveryTransport = vi.hoisted(() => ({ mode: 'success' as 'success' | 'invalid' }));
vi.mock('../client/liveness.js', () => ({ requireCoreAvailable: async () => {} }));
vi.mock('../client/cli-transport.js', () => ({ invokeCli: async (_binary: string, args: string[]) => {
  if (args[0] === 'machine') return { machines: [{ id: 'remote-core', name: 'box-1.invalid', host: 'box-1.invalid', target: 'box-1.invalid', state: 'connected', session: 'fixture' }] };
  if (args[0] === 'file' && args[1] === 'read') return { text: recoveryTransport.mode === 'invalid' ? 42 : 'fresh content' };
  throw new Error('Unexpected request');
} }));

const roots: string[] = [], monitors: ReturnType<typeof createJobMonitor>[] = [];
afterEach(async () => {
  recoveryTransport.mode = 'success';
  for (const monitor of monitors.splice(0)) await monitor.shutdown('reload');
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(initial: 'offline' | 'invalid' | 'foreign' | 'auth', recoverySource?: HcAvailabilitySource) {
  const root = await mkdtemp(join(tmpdir(), 'failed-cleanup-')); roots.push(root);
  const owner = { sessionId: 'session-one', generation: 'generation-one', terminal: { coreId: 'local-core', terminalId: 'owner', address: 'owner', socket: join(root, 'fixture.sock'), sessionNamespace: 'fixture' }, cwd: root, sessionFile: null, name: null } as Owner;
  const machine = 'box-1.invalid' as MachineName, address = 'box-1.invalid/t1' as TerminalAddress, id = 'job-one' as JobId;
  let terminal: TerminalSummary | null = { address, parent: null, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null,
    labels: { 'spider.job': id, 'spider.session': owner.sessionId, 'spider.kind': 'exec', 'spider.machine': machine, 'spider.owner-core': owner.terminal.coreId, 'spider.owner-terminal': owner.terminal.terminalId } };
  let mode: 'offline' | 'invalid' | 'foreign' | 'auth' | 'online' = initial, removals = 0, kills = 0, markerWrites = 0, lookups = 0, probeOnline = false;
  const failures: unknown[] = [], available = new Set<(machine: MachineName) => void>();
  const hc: HcClient = {
    identity: async () => owner.terminal, caller: async () => owner.terminal,
    // A cached inventory can claim the machine is connected during an outage.
    machines: async () => [{ id: 'remote-core' as never, name: machine, aliases: [], state: 'connected', sessionNamespace: 'fixture', runtime: null }],
    events: () => ({ ready: Promise.resolve(), lookup: async () => terminal, subscribe: () => () => {}, dispose: () => {} }),
    get: async () => {
      lookups++;
      if (mode === 'offline') throw new HerdrError('unavailable', 'Destination unavailable');
      if (mode === 'auth') throw new HerdrError('unavailable', 'Authentication failed while offline');
      if (mode === 'invalid') throw new HerdrError('invalid-reply', 'Malformed terminal reply while offline');
      if (!terminal) throw new HerdrError('not_found', 'Terminal absent');
      if (mode === 'foreign') return { ...terminal, labels: { ...terminal.labels, 'spider.job': 'foreign-job' } };
      return { ...terminal, labels: { ...terminal.labels } };
    },
    kill: async () => { kills++; if (terminal) terminal.state = 'finished'; },
    rm: async () => { removals++; terminal = null; },
    fileWrite: async () => { markerWrites++; }, fileRead: async () => { if (mode === 'offline' && !probeOnline) throw new HerdrError('unavailable', 'Destination unavailable'); for (const listener of available) listener(machine); return Buffer.from('fresh content'); },
    run: async () => { throw new Error('No launches in this test'); }, read: async () => '', setLabels: async () => {},
  };
  const job: JournalJob = { version: 1, id, owner, machine, kind: 'exec', phase: { kind: 'launch-failed', error: 'Launch failed' }, viewer: null,
    remoteDirectory: '/home/fixture/job', localDirectory: root, detached: false, noticeMode: 'async', notice: 'observed', nonce: 'fixture-nonce',
    releaseDeadlineAt: 0, originalFinish: null, output: null, callerOwned: false, uncertain: false, evidenceConflict: false,
    noticeDelivered: true, settledMarked: false, terminalExpired: false, failedTerminalCleanup: { address, attempts: 0, nextAt: Date.now() }, updatedAt: Date.now() };
  const store = createJobStore(root, owner.sessionId);
  await store.write({ version: 1, sessionId: owner.sessionId, revision: 0, updatedAt: Date.now(), jobs: [job] });
  const options: JobMonitorOptions = { hc, journalRoot: root, clock: Date.now, observedJobMessages: async () => [], notifier: () => {}, recordCleanupError: error => { failures.push(error); },
    onMachineAvailable: listener => {
      if (recoverySource) return recoverySource.onMachineAvailable(listener);
      available.add(listener); return () => { available.delete(listener); };
    },
    outputCollector: { prepare: async program => ({ program, nonce: 'fixture-nonce' }), collect: async () => ({ complete: false, summary: '', receipt: null }) } };
  let monitor = createJobMonitor(options); monitors.push(monitor);
  await monitor.activate(owner); await monitor.finishCleanup();
  return { get monitor() { return monitor; }, store, failures, setMode(value: typeof mode) { mode = value; }, remaining: () => terminal !== null, removals: () => removals, kills: () => kills, markerWrites: () => markerWrites, lookups: () => lookups,
    metadata: () => hc.machines(), probe: () => hc.fileRead(machine, '/home/fixture/input'), allowProbe: () => { probeOnline = true; },
    async restart() { await monitor.shutdown('reload'); monitor = createJobMonitor(options); monitors.push(monitor); await monitor.activate(owner); } };
}
async function retry(f: Awaited<ReturnType<typeof fixture>>) {
  await f.monitor.reconcile(); await f.monitor.finishCleanup();
}
function fakeClock() { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); vi.setSystemTime(1000); }

it('retains the failed-launch budget through repeated outages and removes the terminal after recovery', async () => {
  fakeClock(); const f = await fixture('offline');
  for (let attempt = 0; attempt < 12; attempt++) {
    const pending = (await f.store.read()).jobs[0].failedTerminalCleanup!;
    expect(pending.attempts).toBe(0);
    expect(pending.exhausted).not.toBe(true);
    expect(pending.nextAt - Date.now()).toBe(Math.min(3_600_000, 30_000 * 2 ** attempt));
    expect(f.remaining()).toBe(true);
    const lookups = f.lookups(); await retry(f); expect(f.lookups()).toBe(lookups);
    if (attempt < 11) { vi.setSystemTime(pending.nextAt); await retry(f); }
  }
  expect(f.failures).toHaveLength(1);
  const pending = (await f.store.read()).jobs[0].failedTerminalCleanup!;
  f.setMode('online'); vi.setSystemTime(pending.nextAt); await retry(f); await f.monitor.finishCleanup();
  expect(f.remaining()).toBe(false); expect(f.removals()).toBe(1); expect(f.kills()).toBe(1);
  expect((await f.store.read()).jobs[0]).toMatchObject({ terminalReleased: true, settledMarked: true });
  expect(f.markerWrites()).toBe(1);
});

it('wakes delayed cleanup after a verified remote read, not cached inventory', async () => {
  fakeClock(); const f = await fixture('offline');
  for (let i = 0; i < 4; i++) {
    const pending = (await f.store.read()).jobs[0].failedTerminalCleanup!;
    vi.setSystemTime(pending.nextAt); await retry(f);
  }
  const due = (await f.store.read()).jobs[0].failedTerminalCleanup!.nextAt, now = Date.now();
  expect(due - now).toBeGreaterThan(30_000);
  expect((await f.metadata())[0].state).toBe('connected'); await retry(f);
  expect(f.remaining()).toBe(true);
  expect((await f.store.read()).jobs[0].failedTerminalCleanup!.nextAt).toBe(due);
  f.setMode('online'); expect((await f.probe()).toString()).toBe('fresh content');
  await retry(f); await f.monitor.finishCleanup();
  expect(Date.now()).toBe(now);
  expect(f.remaining()).toBe(false); expect(f.removals()).toBe(1);
});

it('wakes delayed failed-launch cleanup from a real hc client after a validated remote read', async () => {
  fakeClock();
  const client = createHcClient({ binary: 'fixture', env: { HC_SOCKET: join(tmpdir(), 'failed-cleanup-client.sock'), HC_SESSION: 'fixture' } });
  try {
    const f = await fixture('offline', client);
    for (let i = 0; i < 4; i++) {
      const pending = (await f.store.read()).jobs[0].failedTerminalCleanup!;
      vi.setSystemTime(pending.nextAt); await retry(f);
    }
    const due = (await f.store.read()).jobs[0].failedTerminalCleanup!.nextAt, now = Date.now();
    expect(due - now).toBeGreaterThan(30_000);
    const lookups = f.lookups();
    await client.machines(); await retry(f);
    expect(f.remaining()).toBe(true); expect(f.lookups()).toBe(lookups);
    expect((await f.store.read()).jobs[0].failedTerminalCleanup!.nextAt).toBe(due);
    recoveryTransport.mode = 'invalid';
    await expect(client.fileRead('box-1.invalid' as MachineName, '/home/fixture/input')).rejects.toMatchObject({ code: 'invalid-reply' });
    await retry(f); expect(f.remaining()).toBe(true); expect(f.lookups()).toBe(lookups);
    recoveryTransport.mode = 'success'; f.setMode('online');
    expect((await client.fileRead('box-1.invalid' as MachineName, '/home/fixture/input')).toString()).toBe('fresh content');
    await retry(f); await f.monitor.finishCleanup();
    expect(Date.now()).toBe(now);
    expect(f.remaining()).toBe(false); expect(f.removals()).toBe(1);
  } finally { await client.dispose(); }
});

it('bounds recovery wakeups but allows a later verified recovery to retry again', async () => {
  fakeClock(); const f = await fixture('offline');
  for (let i = 0; i < 4; i++) {
    const pending = (await f.store.read()).jobs[0].failedTerminalCleanup!;
    vi.setSystemTime(pending.nextAt); await retry(f);
  }
  f.allowProbe(); const now = Date.now(), initial = f.lookups();
  await f.probe(); await retry(f); expect(f.lookups()).toBe(initial + 1);
  await f.probe(); await retry(f); expect(f.lookups()).toBe(initial + 1);
  vi.setSystemTime(now + 30_000); await f.probe(); await retry(f);
  expect(f.lookups()).toBe(initial + 2);
});

it('retains the outage deadline and attempt budget across a monitor restart', async () => {
  fakeClock(); const f = await fixture('offline');
  const before = (await f.store.read()).jobs[0].failedTerminalCleanup!;
  await f.restart();
  expect((await f.store.read()).jobs[0].failedTerminalCleanup).toEqual(before);
  f.setMode('online'); vi.setSystemTime(before.nextAt); await retry(f); await f.monitor.finishCleanup();
  expect(f.remaining()).toBe(false); expect(f.removals()).toBe(1);
});

it('still exhausts the three-attempt budget for a malformed terminal reply', async () => {
  fakeClock(); const f = await fixture('invalid');
  for (let attempt = 1; attempt < 3; attempt++) {
    const pending = (await f.store.read()).jobs[0].failedTerminalCleanup!;
    expect(pending.attempts).toBe(attempt);
    vi.setSystemTime(pending.nextAt); await retry(f);
  }
  expect((await f.store.read()).jobs[0].failedTerminalCleanup).toMatchObject({ attempts: 3, exhausted: true });
  f.setMode('online'); vi.setSystemTime(Date.now() + 3_600_000); await retry(f);
  expect(f.remaining()).toBe(true); expect(f.removals()).toBe(0);
});

it('still exhausts the three-attempt budget for an authentication failure', async () => {
  fakeClock(); const f = await fixture('auth');
  for (let attempt = 1; attempt < 3; attempt++) {
    const pending = (await f.store.read()).jobs[0].failedTerminalCleanup!;
    expect(pending.attempts).toBe(attempt);
    vi.setSystemTime(pending.nextAt); await retry(f);
  }
  expect((await f.store.read()).jobs[0].failedTerminalCleanup).toMatchObject({ attempts: 3, exhausted: true });
  expect(f.remaining()).toBe(true); expect(f.removals()).toBe(0);
});

it('never removes a terminal whose identity changed', async () => {
  fakeClock(); const f = await fixture('foreign');
  expect((await f.store.read()).jobs[0].uncertain).toBe(true);
  f.setMode('online'); vi.setSystemTime(Date.now() + 3_600_000); await retry(f);
  expect(f.remaining()).toBe(true); expect(f.kills()).toBe(0); expect(f.removals()).toBe(0);
});
