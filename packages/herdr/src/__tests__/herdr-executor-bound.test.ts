// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { createRemoteExecutor } from '../remote/execute.js';
import { runExec } from '../../../context/src/actions/exec.js';
import { access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { sha256 } from '../remote/runtime.js';
import { bounded, cleanup, deferred, monitorFixture, on, program } from './herdr-monitor-fixture.js';
import type { CollectedLogs } from '../remote/transfer.js';

it('returns an uncertain release with job paths and preserves a later completion notice', async () => {
  const f = await monitorFixture(), bytes = Buffer.from('runtime');
  f.hc.fileRead = async () => bytes;
  f.hc.fileWrite = async (_on, path) => { if (path.endsWith('/release.json')) throw Object.assign(new Error('Acknowledgement lost'), { code: 'cli-timeout' }); };
  const jobs = f.monitor();
  const remote = createRemoteExecutor({ hc: f.hc, jobs, prepare: program,
    target: async () => ({ on, cwd: null, directory: f.f.root, commands: {}, environment: {}, nodePath: process.execPath, runtimePath: 'runtime', runtimeSha256: sha256(bytes) }),
    environmentPolicy: env => env, clock: Date.now,
    logSink: async () => ({ collect: async () => ({ stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, complete: false, capped: false, receipt: null }), dispose() {} }),
  });
  const actual = await bounded(remote.execute({ source: { kind: 'code', language: 'shell', code: 'printf ok' }, on, owner: f.owner }).then(result => ({ result }), error => ({ error })), 1000);
  expect(f.kills).toEqual([]);
  expect(actual).toHaveProperty('result');
  if (!('result' in actual)) return;
  expect(actual.result).toMatchObject({ outcome: 'unknown', exitCode: null, backgroundJob: { id: actual.result.remote.jobId } });
  expect(actual.result.stderr).toMatch(/release.*may.*running/i);
  f.complete(actual.result.remote.address!); await jobs.reconcile();
  await expect.poll(() => f.notices.length, { timeout: 500 }).toBe(1);
  expect(f.notices[0].details.jobId).toBe(actual.result.remote.jobId);
});

it('the safety bound rejects a stalled wait while execution timers are paused', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    await expect(Promise.race([bounded(new Promise<never>(() => {}), 20), delay(50).then(() => 'still waiting')])).rejects.toThrow('wait did not settle');
  } finally { vi.useRealTimers(); }
});

for (const nativeFinishes of [true, false]) {
it(`a stalled collector respects liveness and cancellation with native finish ${nativeFinishes}`, async () => {
  // Awaiting reader.collect unconditionally makes the monitor's 60-second bound ineffective.
  const f = await monitorFixture();
  const bytes = Buffer.from('runtime'), reading = deferred(), settling = deferred(), stalled = deferred<CollectedLogs>();
  let reads = 0, settled = false;
  f.hc.fileRead = async () => bytes;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  cleanup(() => vi.useRealTimers());
  const jobs = f.monitor({ outputCollector: { ...f.options.outputCollector, collect: () => new Promise(() => {}) } });
  let executing: ReturnType<typeof runExec> | undefined;
  const stop = new AbortController();
  try {
    const remote = createRemoteExecutor({
      hc: f.hc, jobs, prepare: program, target: async () => ({ on, cwd: null, directory: f.f.root, commands: {}, environment: {}, nodePath: process.execPath, runtimePath: 'runtime', runtimeSha256: sha256(bytes) }),
      environmentPolicy: env => env, clock: Date.now,
      logSink: async () => ({ collect: () => { (++reads === 1 ? reading : settling).resolve(); return stalled.promise; }, dispose() {} }),
    });
    executing = runExec({ on, language: 'shell', code: 'unused' }, { cwd: f.f.root, owner: f.owner, remote, signal: stop.signal });
    void executing.then(() => { settled = true; }, () => { settled = true; });
    await reading.promise; if (nativeFinishes) f.complete([...f.terminals.keys()][0]);
    // The initial live snapshot may renew the collection once after native finish.
    await vi.advanceTimersByTimeAsync(60000);
    await vi.advanceTimersByTimeAsync(60000);
    if (!nativeFinishes) {
      expect(settled).toBe(false);
      stop.abort();
      await bounded(settling.promise);
      await vi.advanceTimersByTimeAsync(5000);
      const aborted = await bounded(executing, 1500);
      expect(aborted.details).toMatchObject({ outcome: 'aborted', aborted: true, timedOut: false });
      expect(aborted.details.remoteAbortInfo).toContain('state unknown; it may still be running');
      expect(f.notices).toEqual([]);
      expect([...f.terminals.values()][0].state).toBe('live');
      return;
    }
    const result = await bounded(executing, 500);
    expect(result.details).toMatchObject({ outcome: 'unknown', exitCode: null });
    expect(result.text).toContain('the supervisor process is gone and no exit receipt was ever written');
    await expect(access(result.details.backgroundJob.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.notices).toEqual([]);
    expect([...f.terminals.values()][0].state).toBe(nativeFinishes ? 'finished' : 'live');
  } finally {
    stop.abort(); stalled.resolve({ stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, complete: false, capped: false, receipt: null });
    await jobs.shutdown('reload');
    if (executing) await bounded(executing.catch(() => {}), 3000);
  }
});
}


it('a timeout bounds repeated incomplete reads with one settlement deadline', async () => {
  const f = await monitorFixture(), bytes = Buffer.from('runtime');
  f.hc.fileRead = async () => bytes;
  let now = Date.now();
  const jobs = f.monitor({ outputCollector: { ...f.options.outputCollector, collect: () => new Promise(() => {}) } });
  const stop = new AbortController();
  const remote = createRemoteExecutor({
    hc: f.hc, jobs, prepare: program, target: async () => ({ on, cwd: null, directory: f.f.root, commands: {}, environment: {}, nodePath: process.execPath, runtimePath: 'runtime', runtimeSha256: sha256(bytes) }),
    environmentPolicy: env => env, clock: () => now,
    logSink: async () => ({ collect: async () => { now += 1000; return { stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, complete: false, capped: false, receipt: null }; }, dispose() {} }),
  });
  const executing = runExec({ on, language: 'shell', code: 'unused', timeout: 100 }, { cwd: f.f.root, owner: f.owner, remote, signal: stop.signal });
  try {
    const result = await bounded(executing, 700);
    expect(result.details).toMatchObject({ outcome: 'unknown', exitCode: null, timedOut: true });
    expect(f.kills).toHaveLength(1);
    expect([...f.terminals.values()][0].state).toBe('live');
    expect(f.notices).toEqual([]);
  } finally { stop.abort(); await executing.catch(() => {}); await jobs.shutdown('reload'); }
});

it.each([{ background: false, nativeFinishes: false }, { background: false, nativeFinishes: true }, { background: true, nativeFinishes: false }])('a stalled log read does not hide a deadline with background $background and native finish $nativeFinishes', async ({ background, nativeFinishes }) => {
  const f = await monitorFixture(), bytes = Buffer.from('runtime');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  cleanup(() => vi.useRealTimers());
  const reading = deferred(), settling = deferred(), stalled = deferred<CollectedLogs>(), stop = new AbortController();
  // Clock reads also move time forward between arming and reading the settlement deadline.
  let clockReads = 0, reads = 0;
  f.hc.fileRead = async () => bytes;
  const jobs = f.monitor({ outputCollector: { ...f.options.outputCollector, collect: () => new Promise(() => {}) } });
  const remote = createRemoteExecutor({
    hc: f.hc, jobs, prepare: program, target: async () => ({ on, cwd: null, directory: f.f.root, commands: {}, environment: {}, nodePath: process.execPath, runtimePath: 'runtime', runtimeSha256: sha256(bytes) }),
    environmentPolicy: env => env, clock: nativeFinishes ? () => Date.now() + clockReads++ : Date.now,
    logSink: async () => ({ collect: () => { (++reads === 1 ? reading : settling).resolve(); return stalled.promise; }, dispose() {} }),
  });
  const executing = runExec({ on, language: 'shell', code: 'unused', timeout: 100, background }, { cwd: f.f.root, owner: f.owner, remote, signal: stop.signal });
  try {
    await reading.promise;
    if (nativeFinishes) f.complete([...f.terminals.keys()][0]);
    await vi.advanceTimersByTimeAsync(100);
    if (!background) {
      await bounded(settling.promise);
      await vi.advanceTimersByTimeAsync(5000);
    }
    const result = await bounded(executing, 2500);
    expect(result.details).toMatchObject({ outcome: background ? 'timeout' : 'unknown', exitCode: null, timedOut: true });
    expect(f.kills).toHaveLength(background || nativeFinishes ? 0 : 1);
    if (background) expect(result.details.backgrounded).toBe(true);
    expect(f.notices).toEqual([]);
  } finally {
    stop.abort(); stalled.resolve({ stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, complete: false, capped: false, receipt: null });
    await jobs.shutdown('reload'); await bounded(executing.catch(() => {}), 3000);
  }
});
