// SPDX-License-Identifier: MIT
import { expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createJobStore, parseJobJournal } from '../jobs/store.js';
import type { TerminalAddress, TerminalSummary } from '../contracts.js';
import { cleanup, deferred, monitorFixture, on, program } from './herdr-monitor-fixture.js';

async function retryFixture() {
  const h = await monitorFixture();
  const timeout = globalThis.setTimeout;
  const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => timeout(callback, ms === 10000 ? 20 : ms, ...args)) as typeof setTimeout);
  cleanup(() => timer.mockRestore());
  const launches: string[] = [], published: string[] = [];
  const run = h.hc.run;
  h.hc.run = async request => { launches.push(request.labels['spider.job']); return run(request); };
  h.hc.fileWrite = async (_machine, path, bytes) => { if (path.endsWith('/release.json')) published.push(JSON.parse(bytes.toString()).jobId); };
  return { ...h, launches, published };
}

test('prepares a different program directory for each release attempt', async () => {
  const h = await retryFixture(), directories: string[] = [];
  const prepare = h.options.outputCollector.prepare, get = h.hc.get;
  let first = true;
  h.options.outputCollector.prepare = async (p, job) => { directories.push(p.directory); return prepare(p, job); };
  h.hc.get = async address => { if (first) { first = false; throw Object.assign(new Error('Read failed'), { code: 'hc-error' }); } return get(address); };
  const handle = await h.monitor().start(program, h.owner, on, {});
  expect(h.launches).toHaveLength(2);
  expect(directories).toHaveLength(2);
  expect(directories[0]).not.toBe(directories[1]);
  expect(handle.remoteDirectory).toBe(directories[1]);
});

test('does not launch a retry if preparation returns the original directory', async () => {
  const h = await retryFixture(), fixed = await program(), get = h.hc.get;
  let first = true;
  h.hc.get = async address => { if (first) { first = false; throw Object.assign(new Error('Read failed'), { code: 'hc-error' }); } return get(address); };
  await expect(h.monitor().start(async () => fixed, h.owner, on, {})).rejects.toMatchObject({ code: 'program-directory-reused' });
  expect(h.launches).toHaveLength(1);
  expect(h.published).toEqual([]);
});

test('retries marking a removed attempt when its first cleanup write fails', async () => {
  const h = await retryFixture(), directories: string[] = [], marked: string[] = [];
  const prepare = h.options.outputCollector.prepare, get = h.hc.get;
  let first = true, markerAttempts = 0;
  h.options.outputCollector.prepare = async (p, job) => { directories.push(p.directory); return prepare(p, job); };
  h.hc.get = async address => { if (first) { first = false; throw Object.assign(new Error('Read failed'), { code: 'hc-error' }); } return get(address); };
  h.hc.fileWrite = async (_machine, path, bytes) => {
    if (path.endsWith('/.spider-settled')) { if (++markerAttempts === 1) throw new Error('Cleanup unavailable'); marked.push(path); }
    else if (path.endsWith('/release.json')) h.published.push(JSON.parse(bytes.toString()).jobId);
  };
  const jobs = h.monitor(), handle = await jobs.start(program, h.owner, on, {});
  await jobs.reconcile();
  await expect.poll(() => markerAttempts, { timeout: 500, interval: 10 }).toBeGreaterThanOrEqual(2);
  expect(marked).toEqual([join(directories[0], '.spider-settled')]);
  expect(h.published).toEqual([handle.id]);
});

test.each(['hc get', 'fileRead'] as const)('retries once after removal and cannot publish on a late %s reply', async step => {
  const h = await retryFixture();
  let reply!: () => void, first: TerminalSummary | undefined;
  const get = h.hc.get;
  h.hc.get = async address => {
    if (!first && h.terminals.has(address)) {
      first = h.terminals.get(address)!;
      if (step === 'hc get') return new Promise<TerminalSummary>(resolve => { reply = () => resolve(first!); });
    }
    return get(address);
  };
  if (step === 'fileRead') h.hc.fileRead = () => h.launches.length === 1 ? new Promise<Buffer>(resolve => { reply = () => resolve(Buffer.from('a'.repeat(64))); }) : Promise.resolve(Buffer.from('a'.repeat(64)));
  const run = h.hc.run;
  h.hc.run = async request => {
    if (h.launches.length) expect(h.terminals.has(first!.address)).toBe(false);
    return run(request);
  };
  const jobs = h.monitor(), handle = await jobs.start(program, h.owner, on, {});
  reply(); await new Promise(resolve => setImmediate(resolve));
  expect(h.launches).toHaveLength(2);
  expect(h.launches[0]).not.toBe(handle.id);
  expect(h.published).toEqual([handle.id]);
  expect(h.terminals.has(first!.address)).toBe(false);
});

test.each(['remove failed', 'still present', 'absence unknown'] as const)('does not retry when first terminal removal is %s', async mode => {
  const h = await retryFixture();
  let confirming = true;
  const get = h.hc.get, rm = h.hc.rm;
  h.hc.get = async address => {
    if (confirming) { confirming = false; return new Promise<never>(() => {}); }
    if (mode === 'absence unknown') throw new Error('Remote unavailable');
    return get(address);
  };
  h.hc.rm = async address => { if (mode === 'remove failed') throw new Error('Removal refused'); if (mode !== 'still present') await rm(address); };
  const jobs = h.monitor(); let failure: unknown;
  await jobs.start(program, h.owner, on, {}).catch(error => { failure = error; });
  expect(h.launches).toHaveLength(1);
  expect(h.published).toEqual([]);
  expect(String(failure)).toMatch(/not retried.*removal.*not confirmed/i);
  const saved = await createJobStore(h.f.root, h.owner.sessionId).read();
  expect(saved?.jobs[0].phase).toMatchObject({ kind: 'launch-failed', releaseFailure: { step: 'hc get', elapsedMs: 0, beforeReleaseMs: 0, timerDriftMs: 0 } });
});

test.each(['address', 'labels'] as const)('does not kill or retry when the observed terminal %s does not match', async mismatch => {
  const h = await retryFixture(), get = h.hc.get;
  let now = 1000;
  h.options.clock = () => now;
  h.hc.get = async address => {
    const terminal = await get(address); now += 10000;
    return mismatch === 'address' ? { ...terminal, address: 'remote.invalid/reused' as typeof address } : { ...terminal, labels: { ...terminal.labels, 'spider.job': 'foreign-job' } };
  };
  const pending = h.monitor().start(program, h.owner, on, {});
  const error = await pending.catch(error => error);
  expect(h.kills).toEqual([]);
  expect(h.launches).toHaveLength(1);
  expect(h.published).toEqual([]);
  expect(h.terminals.size).toBe(1);
  expect(String(error)).toMatch(/payload did not start.*not retried automatically.*identity/i);
});

test('does not signal a terminal that changes identity after the release label check', async () => {
  const h = await retryFixture(), get = h.hc.get;
  let reads = 0, now = 1000;
  h.options.clock = () => now;
  h.hc.get = async address => {
    const terminal = await get(address);
    if (++reads === 1) return terminal;
    now += 10000;
    return { ...terminal, labels: { ...terminal.labels, 'spider.job': 'foreign-job' } };
  };
  h.hc.fileRead = async () => { throw Object.assign(new Error('Checksum unavailable'), { code: 'hc-error' }); };
  const error = await h.monitor().start(program, h.owner, on, {}).catch(error => error);
  expect(h.kills).toEqual([]);
  expect(h.launches).toHaveLength(1);
  expect(h.published).toEqual([]);
  expect(String(error)).toMatch(/payload did not start.*not retried automatically.*identity/i);
});

test('aborting during label polling reports cancellation and never retries', async () => {
  const h = await retryFixture(), entered = deferred(), controller = new AbortController(), get = h.hc.get;
  let first = true;
  h.hc.get = async address => { if (first) { first = false; entered.resolve(); throw Object.assign(new Error('Not found'), { code: 'not_found' }); } return get(address); };
  const pending = h.monitor().start(program, h.owner, on, { signal: controller.signal });
  await entered.promise; await new Promise<void>(resolve => setImmediate(resolve)); controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  expect(h.launches).toHaveLength(1); expect(h.published).toEqual([]);
});

test('cancelling while preparing the retry never launches the second attempt', async () => {
  const h = await retryFixture(), entered = deferred(), unblock = deferred(), controller = new AbortController(), get = h.hc.get;
  let first = true, preparations = 0;
  h.hc.get = async address => { if (first) { first = false; throw Object.assign(new Error('Read failed'), { code: 'hc-error' }); } return get(address); };
  const prepare = async () => { if (++preparations === 2) { entered.resolve(); await unblock.promise; } return program(); };
  const pending = h.monitor().start(prepare, h.owner, on, { signal: controller.signal });
  await entered.promise; controller.abort(); unblock.resolve();
  await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  expect(preparations).toBe(2); expect(h.launches).toHaveLength(1); expect(h.published).toEqual([]); expect(h.terminals.size).toBe(0);
});

test('does not retry when terminal absence is reported by a disconnected machine', async () => {
  const h = await retryFixture(), get = h.hc.get, machines = h.hc.machines;
  let first = true;
  h.hc.get = async address => { if (first) { first = false; throw Object.assign(new Error('Read failed'), { code: 'hc-error' }); } return get(address); };
  h.hc.machines = async () => (await machines()).map(machine => ({ ...machine, state: 'disconnected' as const }));
  const error = await h.monitor().start(program, h.owner, on, {}).catch(error => error);
  expect(h.launches).toHaveLength(1); expect(h.published).toEqual([]);
  expect(String(error)).toMatch(/payload did not start.*not retried automatically.*removal.*not confirmed/i);
  const saved = await createJobStore(h.f.root, h.owner.sessionId).read();
  expect(saved.jobs[0].terminalReleased).not.toBe(true);
});

test.each(['connected', 'disconnected'] as const)('does not retry an unqualified missing address when the destination is %s', async state => {
  const h = await retryFixture(), run = h.hc.run, machines = h.hc.machines;
  let now = 1000;
  h.options.clock = () => now;
  h.hc.run = async request => { const terminal = await run(request); return { ...terminal, address: 'unqualified' as typeof terminal.address }; };
  h.hc.get = async () => { now += 10000; throw Object.assign(new Error('Not found'), { code: 'not_found' }); };
  h.hc.machines = async () => (await machines()).map(machine => ({ ...machine, state }));
  const error = await h.monitor().start(program, h.owner, on, {}).catch(error => error);
  expect(h.kills).toEqual([]); expect(h.launches).toHaveLength(1); expect(h.published).toEqual([]);
  expect(String(error)).toMatch(/payload did not start.*not retried automatically.*removal.*not confirmed/i);
});

test('a second release failure stops without a third launch', async () => {
  const h = await retryFixture(), get = h.hc.get, attempted = new Set<string>();
  h.hc.get = async address => {
    if (h.terminals.has(address) && !attempted.has(address)) {
      attempted.add(address);
      return new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Bounded confirmation failure')), 250));
    }
    return get(address);
  };
  await expect(h.monitor().start(program, h.owner, on, {})).rejects.toMatchObject({ code: 'release-timeout' });
  expect(h.launches).toHaveLength(2);
  expect(h.published).toEqual([]);
  const saved = JSON.parse(await readFile(join(h.f.root, 'sessions/monitor-session/jobs.json'), 'utf8'));
  expect(saved.jobs.map((job: { phase: { kind: string } }) => job.phase.kind)).toEqual(['launch-failed', 'launch-failed']);
});

test.each(['cancel', 'shutdown'] as const)('%s does not signal a terminal that no longer has the job identity', async action => {
  const h = await monitorFixture(), jobs = h.monitor(), handle = await jobs.start(program, h.owner, on, {});
  const terminal = h.terminals.get(handle.address)!;
  h.terminals.set(handle.address, { ...terminal, labels: { ...terminal.labels, 'spider.job': 'foreign-job' } });
  if (action === 'cancel') await expect(handle.cancel('abort')).rejects.toMatchObject({ code: 'job-outcome-unknown' });
  else await jobs.shutdown('quit');
  expect(h.kills).toEqual([]);
});

test('cancellation does not signal a terminal replaced after the first identity check', async () => {
  const h = await monitorFixture(), jobs = h.monitor(), handle = await jobs.start(program, h.owner, on, {}), get = h.hc.get;
  let replaced = false;
  h.hc.get = async address => {
    const terminal = await get(address);
    if (!replaced && address === handle.address) {
      const snapshot = { ...terminal, labels: { ...terminal.labels } };
      queueMicrotask(() => { replaced = true; h.terminals.set(address, { ...snapshot, labels: { ...snapshot.labels, 'spider.job': 'foreign' } }); });
      return snapshot;
    }
    return terminal;
  };
  await expect(handle.cancel('abort')).rejects.toMatchObject({ code: 'job-outcome-unknown' });
  expect(replaced).toBe(true); expect(h.kills).toEqual([]);
  expect(h.terminals.get(handle.address)?.labels['spider.job']).toBe('foreign');
});

test('a slow identity check still cancels the matching running job', async () => {
  const h = await monitorFixture(), jobs = h.monitor(), handle = await jobs.start(program, h.owner, on, {}), get = h.hc.get;
  h.hc.get = async address => { await new Promise(resolve => setTimeout(resolve, 1100)); return get(address); };
  await expect(handle.cancel('abort')).resolves.toBeUndefined();
  expect(h.kills).toEqual([handle.address]);
}, 4000);

test('a failed preparation marks its never-launched program for later cleanup', async () => {
  const h = await retryFixture(), markers: string[] = [];
  h.options.outputCollector.prepare = async () => { throw Object.assign(new Error('Upload failed'), { code: 'hc-error' }); };
  h.hc.fileWrite = async (_on, path) => { if (path.endsWith('/.spider-settled')) markers.push(path); };
  const jobs = h.monitor();
  await expect(jobs.start(program, h.owner, on, {})).rejects.toMatchObject({ code: 'hc-error' });
  expect(h.launches).toEqual([]); expect(markers).toHaveLength(1);
  const saved = await createJobStore(h.f.root, h.owner.sessionId).read();
  expect(saved.jobs[0]).toMatchObject({ phase: { kind: 'launch-failed' }, terminalReleased: true, settledMarked: true });
  expect(markers[0]).toBe(join(saved.jobs[0].remoteDirectory, '.spider-settled'));
});

test('a lost hc run reply is not treated as a never-launched program', async () => {
  const h = await retryFixture(), markers: string[] = [];
  h.hc.run = async () => { throw new Error('Run acknowledgement lost'); };
  h.hc.fileWrite = async (_on, path) => { if (path.endsWith('/.spider-settled')) markers.push(path); };
  await expect(h.monitor().start(program, h.owner, on, {})).rejects.toMatchObject({ code: 'launch-uncertain' });
  const saved = await createJobStore(h.f.root, h.owner.sessionId).read();
  expect(saved.jobs[0]).toMatchObject({ phase: { kind: 'preparing' }, settledMarked: false });
  expect(saved.jobs[0].terminalReleased).not.toBe(true); expect(markers).toEqual([]);
});

test('one failed call retains one diagnostic record after its two attempts return', async () => {
  const h = await retryFixture(), store = createJobStore(h.f.root, h.owner.sessionId), run = h.hc.run;
  let firstStillRecorded = false;
  h.hc.run = async request => {
    if (h.launches.length === 1) firstStillRecorded = (await store.read()).jobs.some(job => job.id === h.launches[0]);
    return run(request);
  };
  h.hc.fileRead = async () => { throw Object.assign(new Error('Checksum unavailable'), { code: 'hc-error' }); };
  const jobs = h.monitor();
  await expect(jobs.start(program, h.owner, on, {})).rejects.toMatchObject({ code: 'hc-error' });
  expect(h.launches).toHaveLength(2); expect(firstStillRecorded).toBe(true);
  await expect.poll(async () => (await store.read()).jobs.map(job => job.id), { timeout: 1000 }).toEqual([h.launches[1]]);
});

test('a release write that finishes after the host deadline keeps the job running', async () => {
  const h = await retryFixture(), writing = deferred(), finish = deferred();
  let now = 1000;
  h.options.clock = () => now;
  h.hc.fileWrite = async (_machine, path, bytes) => {
    if (!path.endsWith('/release.json')) return;
    writing.resolve(); await finish.promise; h.published.push(JSON.parse(bytes.toString()).jobId);
  };
  const pending = h.monitor().start(program, h.owner, on, {}).then(handle => ({ handle }), error => ({ error }));
  await writing.promise; now = 11000;
  await new Promise(resolve => setTimeout(resolve, 60)); finish.resolve();
  const outcome = await pending;
  expect(h.kills).toEqual([]);
  expect(outcome).toHaveProperty('handle');
  expect(h.launches).toHaveLength(1);
  expect(h.published).toEqual(h.launches);
});

test('a release write with a lost acknowledgement stays uncertain and can recover its receipt', async () => {
  const h = await retryFixture();
  h.hc.fileWrite = async (_machine, path, bytes) => {
    if (path.endsWith('/release.json')) { h.published.push(JSON.parse(bytes.toString()).jobId); throw Object.assign(new Error('Write acknowledgement lost'), { code: 'cli-timeout' }); }
  };
  const jobs = h.monitor();
  const result = await jobs.start(program, h.owner, on, {}).then(handle => ({ handle }), error => ({ error }));
  expect(h.kills).toEqual([]);
  expect(result).toHaveProperty('handle');
  if (!('handle' in result)) return;
  expect(h.launches).toHaveLength(1);
  expect(h.published).toEqual([result.handle.id]);
  expect(await result.handle.finished).toMatchObject({ exitCode: null, reason: 'release-uncertain' });
  const store = createJobStore(h.f.root, h.owner.sessionId);
  expect((await store.read()).jobs[0]).toMatchObject({ detached: true, noticeMode: 'async', phase: { kind: 'disconnected', address: result.handle.address } });
  h.complete(result.handle.address); await jobs.reconcile();
  await expect.poll(async () => (await store.read()).jobs[0].phase.kind, { timeout: 500 }).toBe('finished');
  expect((await store.read()).jobs[0].phase).toMatchObject({ result: { exitCode: 23, reason: 'exited' } });
});

test('a failed publication is uncertain and is never retried or killed', async () => {
  const h = await retryFixture();
  h.hc.fileWrite = async (_machine, _path, bytes) => { h.published.push(JSON.parse(bytes.toString()).jobId); throw Object.assign(new Error('Write acknowledgement lost'), { code: 'release-timeout' }); };
  const handle = await h.monitor().start(program, h.owner, on, {});
  expect(await handle.finished).toMatchObject({ reason: 'release-uncertain', exitCode: null });
  expect(h.kills).toEqual([]);
  expect(h.launches).toHaveLength(1);
  expect(h.published).toEqual([h.launches[0]]);
});


test('reads old launch failures and rejects invalid release diagnostics', async () => {
  const h = await retryFixture();
  await h.monitor().start(program, h.owner, on, {});
  const saved = await createJobStore(h.f.root, h.owner.sessionId).read();
  saved!.jobs[0].phase = { kind: 'launch-failed', error: 'Old failure' };
  expect(parseJobJournal(saved, h.owner.sessionId).jobs[0].phase).toEqual({ kind: 'launch-failed', error: 'Old failure' });
  for (const bad of [{ step: 'unknown', elapsedMs: 1, beforeReleaseMs: 0, timerDriftMs: 0 }, { step: 'hc get', elapsedMs: -1, beforeReleaseMs: 0, timerDriftMs: 0 }]) {
    Object.assign(saved!.jobs[0].phase, { releaseFailure: bad });
    expect(() => parseJobJournal(saved, h.owner.sessionId)).toThrow();
  }
});


test.each([false, true])('queue time stays outside the release budget and is reported on failure %s', async fail => {
  const h = await monitorFixture();
  let now = 1000, entered!: () => void, unblock!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { unblock = resolve; });
  const identity = h.hc.identity;
  h.hc.identity = async () => { entered(); await gate; return identity(); };
  h.options.clock = () => now;
  let firstFailure: unknown, runCount = 0;
  if (fail) {
    h.hc.fileRead = async () => { throw Object.assign(new Error('Read refused'), { code: 'hc-error' }); };
    const run = h.hc.run;
    h.hc.run = async request => {
      if (++runCount === 2) { const saved = await createJobStore(h.f.root, h.owner.sessionId).read(); const first = saved.jobs.find(job => job.phase.kind === 'launch-failed'); firstFailure = first?.phase.kind === 'launch-failed' ? first.phase.releaseFailure : undefined; }
      return run(request);
    };
  }
  const jobs = h.monitor(), activating = jobs.activate(h.owner);
  await began;
  const pending = jobs.start(program, h.owner, on, {});
  now = 16000; unblock(); await activating;
  if (fail) {
    await expect(pending).rejects.toMatchObject({ releaseFailure: { step: 'fileRead', beforeReleaseMs: 0, queueWaitMs: 0 } });
    expect(firstFailure).toMatchObject({ step: 'fileRead', beforeReleaseMs: 15000, queueWaitMs: 15000 });
  } else {
    const handle = await pending;
    expect(handle.address).toBe('remote.invalid/t1');
  }
});


test('a failed checksum read retries once with a new identity', async () => {
  const h = await retryFixture();
  let reads = 0;
  h.hc.fileRead = async () => { if (++reads === 1) throw Object.assign(new Error('Read failed'), { code: 'hc-error' }); return Buffer.from('a'.repeat(64)); };
  const handle = await h.monitor().start(program, h.owner, on, {});
  expect(h.launches).toHaveLength(2);
  expect(h.published).toEqual([handle.id]);
});

test('retry diagnostics measure only the second attempt before release', async () => {
  const h = await retryFixture(), get = h.hc.get, run = h.hc.run, seen = new Set<string>();
  let now = 1000;
  h.options.clock = () => now;
  h.hc.run = async request => { if (h.launches.length === 1) now += 500; return run(request); };
  h.hc.get = async address => {
    if (h.terminals.has(address) && !seen.has(address)) { seen.add(address); if (h.launches.length === 1) now = 5000; throw Object.assign(new Error('Read failed'), { code: 'hc-error' }); }
    return get(address);
  };
  await expect(h.monitor().start(program, h.owner, on, {})).rejects.toMatchObject({ releaseFailure: { beforeReleaseMs: 500, queueWaitMs: 0 } });
  expect(h.launches).toHaveLength(2); expect(h.published).toEqual([]);
});

test('a slow launch reply keeps the hard cap and retries without releasing the expired attempt', async () => {
  const h = await retryFixture();
  let now = 1000;
  h.options.clock = () => now;
  const run = h.hc.run;
  h.hc.run = async request => { const result = await run(request); if (h.launches.length === 1) now = 11000; return result; };
  const handle = await h.monitor().start(program, h.owner, on, {});
  expect(h.published).toEqual([handle.id]);
  expect(h.launches).toHaveLength(2);
  const saved = await createJobStore(h.f.root, h.owner.sessionId).read();
  expect(saved.jobs[0].phase).toMatchObject({ kind: 'launch-failed', releaseFailure: { step: 'overall check', beforeReleaseMs: 10000, queueWaitMs: 0 } });
});


test.each(['kill', 'remove'] as const)('does not retry when %s reports not-found but the terminal remains', async step => {
  const h = await retryFixture(), get = h.hc.get;
  let first = true;
  h.hc.get = async address => { if (first) { first = false; return new Promise<never>(() => {}); } return get(address); };
  const stale = async () => { throw Object.assign(new Error('Stale not found'), { code: 'not_found' }); };
  if (step === 'kill') h.hc.kill = stale; else h.hc.rm = stale;
  const error = await h.monitor().start(program, h.owner, on, {}).catch(error => error);
  expect(String(error)).toMatch(/payload did not start.*not retried automatically.*removal.*not confirmed/i);
  expect(h.launches).toHaveLength(1); expect(h.published).toEqual([]);
  expect(h.terminals.has('remote.invalid/t1' as TerminalAddress)).toBe(true);
});

test.each(['kill', 'remove'] as const)('a terminal already absent during %s can be retried after an absence check', async step => {
  const h = await retryFixture(), get = h.hc.get;
  let first = true;
  h.hc.get = async address => { if (first) { first = false; return new Promise<never>(() => {}); } return get(address); };
  const missing = (address: Parameters<typeof get>[0]) => { h.terminals.delete(address); throw Object.assign(new Error('Already absent'), { code: 'not_found' }); };
  if (step === 'kill') h.hc.kill = async address => missing(address);
  else h.hc.rm = async address => missing(address);
  const handle = await h.monitor().start(program, h.owner, on, {});
  expect(h.launches).toHaveLength(2);
  expect(h.published).toEqual([handle.id]);
});


test('journal recovery preserves confirmation evidence and rejects malformed observations', async () => {
  const h = await retryFixture(); await h.monitor().start(program, h.owner, on, {});
  const saved = await createJobStore(h.f.root, h.owner.sessionId).read();
  const releaseFailure = { step: 'overall check', elapsedMs: 10000, beforeReleaseMs: 50, queueWaitMs: 0, timerDriftMs: 0,
    confirmation: { checks: 20, notFound: 2, first: { kind: 'not_found' }, last: { kind: 'labels', differences: [{ label: 'spider.machine', expected: 'remote.invalid', actual: 'other.invalid' }] } } };
  Object.assign(saved.jobs[0], { phase: { kind: 'launch-failed', error: 'Labels unconfirmed', releaseFailure } });
  expect(parseJobJournal(saved, h.owner.sessionId).jobs[0].phase).toEqual({ kind: 'launch-failed', error: 'Labels unconfirmed', releaseFailure });
  for (const bad of [{ kind: 'unknown' }, { kind: 'labels', differences: [{ label: 'spider.job', expected: 'job', actual: 42 }] }]) {
    Object.assign(releaseFailure.confirmation, { last: bad });
    expect(() => parseJobJournal(saved, h.owner.sessionId)).toThrow();
  }
});
