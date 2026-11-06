// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createJobStore, parseJobJournal } from '../jobs/store.js';
import { createJobMonitor } from '../jobs/monitor.js';
import { createCleanupSweep } from '../jobs/cleanup.js';
import type { RunId } from '../contracts.js';
import { bounded, cleanup, deferred, monitorFixture, on, program } from './herdr-monitor-fixture.js';

async function failedLaunchFixture() {
  const h = await monitorFixture(), get = h.hc.get, run = h.hc.run;
  const directory = join(h.f.root, 'remote-job');
  await mkdir(directory);
  let first = true, launches = 0, now = 1000;
  h.hc.get = async address => {
    if (first) { first = false; throw Object.assign(new Error('Confirmation failed'), { code: 'hc-error' }); }
    return get(address);
  };
  h.hc.run = async request => { launches++; return run(request); };
  h.hc.fileWrite = async (_machine, path, bytes) => { if (path.endsWith('/.spider-settled')) await writeFile(path, bytes); };
  h.options.clock = () => now;
  const prepare = async () => ({ ...await program(), directory });
  const store = createJobStore(h.f.root, h.owner.sessionId);
  return { ...h, directory, prepare, store, launches: () => launches, setNow: (value: number) => { now = value; } };
}

test('removes and prunes a failed launch after its first kill exceeds the inline bound', async () => {
  const h = await failedLaunchFixture(), kill = h.hc.kill;
  let completedKills = 0;
  h.hc.kill = async (address, options) => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await kill(address, options); completedKills++;
  };
  const jobs = h.monitor();
  await expect(jobs.start(h.prepare, h.owner, on, {})).rejects.toMatchObject({ code: 'hc-error', message: expect.stringMatching(/removal was not confirmed/i) });
  expect(completedKills).toBe(0);
  expect(h.launches()).toBe(1);
  await expect.poll(async () => {
    const [job] = (await h.store.read()).jobs;
    return { released: job?.terminalReleased, marked: job?.settledMarked, remaining: h.terminals.size };
  }, { timeout: 3000, interval: 20 }).toEqual({ released: true, marked: true, remaining: 0 });
  await expect(access(join(h.directory, '.spider-settled'))).resolves.toBeUndefined();
  expect(h.launches()).toBe(1);
  h.setNow(1000 + 8 * 86400000);
  await jobs.reconcile();
  await expect.poll(async () => (await h.store.read()).jobs.length, { timeout: 1000, interval: 20 }).toBe(0);
}, 4900);

test('does not signal a different terminal during failed-launch cleanup', async () => {
  const h = await failedLaunchFixture();
  let kills = 0, removals = 0;
  h.hc.kill = async address => {
    kills++;
    if (kills === 1) {
      const terminal = h.terminals.get(address)!;
      h.terminals.set(address, { ...terminal, labels: { ...terminal.labels, 'spider.job': 'foreign-job' } });
      throw Object.assign(new Error('Kill reply lost'), { code: 'cli-timeout' });
    }
  };
  h.hc.rm = async () => { removals++; };
  const jobs = h.monitor();
  await expect(jobs.start(h.prepare, h.owner, on, {})).rejects.toMatchObject({ code: 'hc-error' });
  await expect.poll(async () => (await h.store.read()).jobs[0].uncertain, { timeout: 1000, interval: 20 }).toBe(true);
  expect(kills).toBe(1);
  expect(removals).toBe(0);
  expect([...h.terminals.values()][0].labels['spider.job']).toBe('foreign-job');
  await expect(access(join(h.directory, '.spider-settled'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('does not remove a terminal whose identity changes after the follow-up signal', async () => {
  const h = await failedLaunchFixture(), kill = h.hc.kill;
  let kills = 0, removals = 0;
  h.hc.kill = async (address, options) => {
    if (++kills === 1) throw Object.assign(new Error('Kill reply lost'), { code: 'cli-timeout' });
    await kill(address, options);
    const terminal = h.terminals.get(address)!;
    h.terminals.set(address, { ...terminal, labels: { ...terminal.labels, 'spider.job': 'foreign-job' } });
  };
  h.hc.rm = async () => { removals++; };
  const jobs = h.monitor();
  await expect(jobs.start(h.prepare, h.owner, on, {})).rejects.toMatchObject({ code: 'hc-error' });
  await expect.poll(async () => (await h.store.read()).jobs[0].uncertain || removals > 0, { timeout: 1000, interval: 20 }).toBe(true);
  expect(kills).toBe(2);
  expect(removals).toBe(0);
  expect((await h.store.read()).jobs[0].uncertain).toBe(true);
  expect([...h.terminals.values()][0].labels['spider.job']).toBe('foreign-job');
  await expect(access(join(h.directory, '.spider-settled'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a lost removal reply is not confirmation and is recovered after restart', async () => {
  const h = await failedLaunchFixture(), remove = h.hc.rm;
  const errors: string[] = [];
  let removals = 0;
  h.options.recordCleanupError = error => { errors.push(String(error)); };
  h.hc.rm = async (address, options) => {
    if (++removals === 1) throw Object.assign(new Error('First removal reply lost'), { code: 'cli-timeout' });
    await remove(address, options);
    throw Object.assign(new Error('Second removal reply lost'), { code: 'cli-timeout' });
  };
  const jobs = h.monitor();
  await expect(jobs.start(h.prepare, h.owner, on, {})).rejects.toMatchObject({ code: 'hc-error' });
  await expect.poll(async () => errors.some(error => error.includes('Second removal reply lost')) || Boolean((await h.store.read()).jobs[0].terminalReleased), { timeout: 1000, interval: 20 }).toBe(true);
  expect(h.terminals.size).toBe(0);
  expect((await h.store.read()).jobs[0].terminalReleased).not.toBe(true);
  expect(errors.some(error => error.includes('Second removal reply lost'))).toBe(true);
  await expect(access(join(h.directory, '.spider-settled'))).rejects.toMatchObject({ code: 'ENOENT' });
  await jobs.shutdown('reload');
  const resumed = h.monitor();
  await resumed.activate({ ...h.owner, generation: 'g2' as typeof h.owner.generation });
  await resumed.reconcile();
  expect((await h.store.read()).jobs[0].terminalReleased).not.toBe(true);
  expect(removals).toBe(2);
  h.setNow(1000 + 3600000);
  await resumed.reconcile();
  await expect.poll(async () => {
    const [job] = (await h.store.read()).jobs;
    return { released: job.terminalReleased, marked: job.settledMarked };
  }, { timeout: 1000, interval: 20 }).toEqual({ released: true, marked: true });
  await expect(access(join(h.directory, '.spider-settled'))).resolves.toBeUndefined();
  expect(h.launches()).toBe(1);
});

test('a failed cleanup stops after bounded attempts even across a restart', async () => {
  const h = await failedLaunchFixture(), errors: string[] = [];
  let kills = 0;
  h.options.recordCleanupError = error => { errors.push(String(error)); };
  h.hc.kill = async () => { kills++; throw Object.assign(new Error('Core unavailable'), { code: 'cli-timeout' }); };
  const jobs = h.monitor();
  await expect(jobs.start(h.prepare, h.owner, on, {})).rejects.toMatchObject({ code: 'hc-error' });
  await expect.poll(() => errors.length, { timeout: 1000, interval: 20 }).toBe(2);
  for (let attempt = 2; attempt <= 3; attempt++) {
    await jobs.finishCleanup();
    h.setNow(1000 + attempt * 3600000);
    await jobs.reconcile();
    await expect.poll(() => errors.length, { timeout: 1000, interval: 20 }).toBe(attempt + 1);
  }
  await jobs.finishCleanup();
  await jobs.shutdown('reload');
  h.setNow(1000 + 10 * 3600000);
  const resumed = h.monitor();
  await resumed.activate({ ...h.owner, generation: 'g2' as typeof h.owner.generation });
  await resumed.reconcile();
  await resumed.finishCleanup();
  expect(kills).toBe(4);
  expect(h.terminals.size).toBe(1);
  expect((await h.store.read()).jobs[0].terminalReleased).not.toBe(true);
  await expect(access(join(h.directory, '.spider-settled'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a slow follow-up does not block a different launch', async () => {
  const h = await failedLaunchFixture(), kill = h.hc.kill, blocked = deferred();
  let kills = 0;
  h.hc.kill = async (address, options) => {
    if (++kills === 1) throw Object.assign(new Error('Kill reply lost'), { code: 'cli-timeout' });
    await blocked.promise;
    await kill(address, options);
  };
  const jobs = h.monitor();
  try {
    await expect(jobs.start(h.prepare, h.owner, on, {})).rejects.toMatchObject({ code: 'hc-error' });
    await expect.poll(() => kills, { timeout: 1000, interval: 20 }).toBe(2);
    const handle = await jobs.start(h.prepare, h.owner, on, {});
    expect(handle.address).toBe('remote.invalid/t2');
    expect(h.terminals.size).toBe(2);
    expect(h.launches()).toBe(2);
  } finally { blocked.resolve(); await jobs.finishCleanup(); }
});

test('shutdown interrupts a hung follow-up and the next activation resumes it', async () => {
  const h = await failedLaunchFixture(), kill = h.hc.kill;
  let kills = 0;
  h.hc.kill = async (_address, options) => {
    if (++kills === 1) throw Object.assign(new Error('Kill reply lost'), { code: 'cli-timeout' });
    return new Promise<void>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('Call interrupted')), { once: true });
    });
  };
  const jobs = h.monitor();
  await expect(jobs.start(h.prepare, h.owner, on, {})).rejects.toMatchObject({ code: 'hc-error' });
  await expect.poll(() => kills, { timeout: 1000, interval: 20 }).toBe(2);
  await expect(bounded(jobs.shutdown('reload'), 800)).resolves.toBeUndefined();
  expect((await h.store.read()).jobs[0].terminalReleased).not.toBe(true);
  h.hc.kill = kill;
  h.setNow(1000 + 3600000);
  const resumed = h.monitor();
  await resumed.activate({ ...h.owner, generation: 'g2' as typeof h.owner.generation });
  await expect.poll(async () => {
    const [job] = (await h.store.read()).jobs;
    return { released: job.terminalReleased, marked: job.settledMarked, remaining: h.terminals.size };
  }, { timeout: 1000, interval: 20 }).toEqual({ released: true, marked: true, remaining: 0 });
});

test('interrupted cleanup attempts count toward the limit across restarts', async () => {
  const h = await failedLaunchFixture();
  let kills = 0;
  h.hc.kill = async (_address, options) => {
    if (++kills === 1) throw Object.assign(new Error('Kill reply lost'), { code: 'cli-timeout' });
    if (kills > 4) throw Object.assign(new Error('Unexpected extra cleanup'), { code: 'cli-timeout' });
    return new Promise<void>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('Call interrupted')), { once: true });
    });
  };
  let jobs = h.monitor();
  await expect(jobs.start(h.prepare, h.owner, on, {})).rejects.toMatchObject({ code: 'hc-error' });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await expect.poll(() => kills, { timeout: 1000, interval: 20 }).toBe(attempt + 1);
    await expect(bounded(jobs.shutdown('reload'), 800)).resolves.toBeUndefined();
    h.setNow(1000 + attempt * 3600000);
    jobs = h.monitor();
    await jobs.activate({ ...h.owner, generation: `g${attempt + 1}` as typeof h.owner.generation });
  }
  await jobs.reconcile(); await jobs.finishCleanup();
  expect(kills).toBe(4);
  expect(h.terminals.size).toBe(1);
  expect((await h.store.read()).jobs[0].terminalReleased).not.toBe(true);
});

test('confirms a removal interrupted during the last attempt after restart', async () => {
  const h = await failedLaunchFixture(), kill = h.hc.kill, remove = h.hc.rm, errors: string[] = [];
  let kills = 0;
  h.options.recordCleanupError = error => { errors.push(String(error)); };
  h.hc.kill = async (address, options) => {
    if (++kills <= 3) throw Object.assign(new Error('Kill reply lost'), { code: 'cli-timeout' });
    await kill(address, options);
  };
  h.hc.rm = async (address, options) => {
    await remove(address, options);
    return new Promise<void>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('Removal interrupted')), { once: true });
    });
  };
  const jobs = h.monitor();
  await expect(jobs.start(h.prepare, h.owner, on, {})).rejects.toMatchObject({ code: 'hc-error' });
  await expect.poll(() => errors.length, { timeout: 1000, interval: 20 }).toBe(2);
  await jobs.finishCleanup(); h.setNow(1000 + 3600000); await jobs.reconcile();
  await expect.poll(() => errors.length, { timeout: 1000, interval: 20 }).toBe(3);
  await jobs.finishCleanup(); h.setNow(1000 + 2 * 3600000); await jobs.reconcile();
  await expect.poll(() => h.terminals.size, { timeout: 1000, interval: 20 }).toBe(0);
  await expect(bounded(jobs.shutdown('reload'), 800)).resolves.toBeUndefined();
  expect((await h.store.read()).jobs[0].failedTerminalCleanup?.attempts).toBe(3);
  h.setNow(1000 + 3 * 3600000);
  const resumed = h.monitor();
  await resumed.activate({ ...h.owner, generation: 'g2' as typeof h.owner.generation });
  await expect.poll(async () => {
    const [job] = (await h.store.read()).jobs;
    return { released: job.terminalReleased, marked: job.settledMarked };
  }, { timeout: 1000, interval: 20 }).toEqual({ released: true, marked: true });
  expect(kills).toBe(4);
  expect(h.launches()).toBe(1);
});

test('rejects invalid failed-terminal retry states in the journal', async () => {
  const h = await failedLaunchFixture();
  h.hc.kill = async () => { throw Object.assign(new Error('Kill reply lost'), { code: 'cli-timeout' }); };
  const jobs = h.monitor();
  await expect(jobs.start(h.prepare, h.owner, on, {})).rejects.toMatchObject({ code: 'hc-error' });
  await jobs.shutdown('reload');
  const saved = await h.store.read();
  for (const state of [{ attempts: -1 }, { attempts: 4 }, { attempts: 1, exhausted: true }]) {
    Object.assign(saved.jobs[0], { failedTerminalCleanup: { address: 'remote.invalid/t1', nextAt: 1000, ...state } });
    expect(() => parseJobJournal(saved, h.owner.sessionId)).toThrow();
  }
});

test('a parent resumes a failed child launch cleanup after its writer exits', async () => {
  const h = await failedLaunchFixture(), kill = h.hc.kill;
  let kills = 0;
  h.hc.kill = async (address, options) => {
    if (++kills === 1) throw Object.assign(new Error('Kill reply lost'), { code: 'cli-timeout' });
    await kill(address, options);
  };
  const child = { id: 'run-one' as RunId, pid: process.pid, startIdentity: 'fixture' };
  const sweep = createCleanupSweep(h.options.clock, error => { throw error; });
  cleanup(() => sweep.dispose());
  const first = createJobMonitor({ ...h.options, child }, sweep);
  cleanup(() => first.shutdown('reload'));
  await expect(first.start(h.prepare, h.owner, on, {})).rejects.toMatchObject({ code: 'hc-error' });
  await first.shutdown('quit');
  const childStore = createJobStore(h.f.root, h.owner.sessionId, child.id);
  const parent = h.monitor({ closeAgentConsoles: async () => {} });
  await parent.activate(h.owner);
  await expect.poll(async () => {
    const [job] = (await childStore.read()).jobs;
    return { released: job.terminalReleased, marked: job.settledMarked, remaining: h.terminals.size };
  }, { timeout: 1500, interval: 20 }).toEqual({ released: true, marked: true, remaining: 0 });
  await expect(access(join(h.directory, '.spider-settled'))).resolves.toBeUndefined();
  expect(h.launches()).toBe(1);
});
