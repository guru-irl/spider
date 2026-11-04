// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { createRemoteExecutor } from '../remote/execute.js';
import { runExec } from '../../../context/src/actions/exec.js';
import { access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { sha256 } from '../remote/runtime.js';
import { bounded, cleanup, deferred, monitorFixture, on, program } from './herdr-monitor-fixture.js';
import type { CollectedLogs } from '../remote/transfer.js';

it.each([true, false])('a stalled collector respects liveness and cancellation with native finish %s', async nativeFinishes => {
  // Awaiting reader.collect unconditionally makes the monitor's 60-second bound ineffective.
  const f = await monitorFixture();
  const bytes = Buffer.from('runtime'), reading = deferred(), stalled = deferred<CollectedLogs>();
  f.hc.fileRead = async () => bytes;
  const timeout = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => timeout(callback, ms === 60000 ? 200 : ms, ...args)) as typeof setTimeout);
  cleanup(() => spy.mockRestore());
  const jobs = f.monitor({ outputCollector: { ...f.options.outputCollector, collect: () => new Promise(() => {}) } });
  let executing: ReturnType<typeof runExec> | undefined;
  const stop = new AbortController();
  try {
    const remote = createRemoteExecutor({
      hc: f.hc, jobs, prepare: async () => program, target: async () => ({ on, cwd: null, directory: f.f.root, commands: {}, environment: {}, nodePath: process.execPath, runtimePath: 'runtime', runtimeSha256: sha256(bytes) }),
      environmentPolicy: env => env, clock: Date.now,
      logSink: async () => ({ collect: () => { reading.resolve(); return stalled.promise; }, dispose() {} }),
    });
    executing = runExec({ on, language: 'shell', code: 'unused' }, { cwd: f.f.root, owner: f.owner, remote, signal: stop.signal });
    await reading.promise; if (nativeFinishes) f.complete([...f.terminals.keys()][0]);
    if (!nativeFinishes) {
      expect(await Promise.race([executing, delay(300).then(() => null)])).toBeNull();
      stop.abort();
      const aborted = await bounded(executing, 1500);
      expect(aborted.details).toMatchObject({ outcome: 'aborted', exitCode: 137 });
      expect(aborted.details.remoteAbortInfo).toContain('state unknown; it may still be running');
      expect(f.notices).toEqual([]);
      expect([...f.terminals.values()][0].state).toBe('live');
      return;
    }
    const result = await bounded(executing, 1000);
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


it.each([{ background: false, nativeFinishes: false }, { background: false, nativeFinishes: true }, { background: true, nativeFinishes: false }])('a stalled log read does not hide a deadline with background $background and native finish $nativeFinishes', async ({ background, nativeFinishes }) => {
  const f = await monitorFixture(), bytes = Buffer.from('runtime');
  const reading = deferred(), stalled = deferred<CollectedLogs>(), stop = new AbortController();
  f.hc.fileRead = async () => bytes;
  const jobs = f.monitor({ outputCollector: { ...f.options.outputCollector, collect: () => new Promise(() => {}) } });
  const remote = createRemoteExecutor({
    hc: f.hc, jobs, prepare: async () => program, target: async () => ({ on, cwd: null, directory: f.f.root, commands: {}, environment: {}, nodePath: process.execPath, runtimePath: 'runtime', runtimeSha256: sha256(bytes) }),
    environmentPolicy: env => env, clock: Date.now,
    logSink: async () => ({ collect: () => { reading.resolve(); return stalled.promise; }, dispose() {} }),
  });
  const executing = runExec({ on, language: 'shell', code: 'unused', timeout: 100, background }, { cwd: f.f.root, owner: f.owner, remote, signal: stop.signal });
  try {
    await reading.promise;
    if (nativeFinishes) f.complete([...f.terminals.keys()][0]);
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
