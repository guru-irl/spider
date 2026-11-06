// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createJobStore, parseJobJournal } from '../jobs/store.js';
import type { TerminalSummary } from '../contracts.js';
import { monitorFixture, on, program } from './herdr-monitor-fixture.js';

async function retryFixture() {
  const h = await monitorFixture();
  const prepare = h.options.outputCollector.prepare;
  h.options.outputCollector.prepare = async (p, job) => ({ ...await prepare(p, job), releaseDeadlineAt: 1020 });
  const launches: string[] = [], published: string[] = [];
  const run = h.hc.run;
  h.hc.run = async request => { launches.push(request.labels['spider.job']); return run(request); };
  h.hc.fileWrite = async (_machine, _path, bytes) => { published.push(JSON.parse(bytes.toString()).jobId); };
  return { ...h, launches, published };
}

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

test('a second release failure stops without a third launch', async () => {
  const h = await retryFixture(), get = h.hc.get;
  h.hc.get = async address => h.terminals.has(address) ? new Promise<never>(() => {}) : get(address);
  await expect(h.monitor().start(program, h.owner, on, {})).rejects.toMatchObject({ code: 'release-timeout' });
  expect(h.launches).toHaveLength(2);
  expect(h.published).toEqual([]);
  const saved = JSON.parse(await readFile(join(h.f.root, 'sessions/monitor-session/jobs.json'), 'utf8'));
  expect(saved.jobs.map((job: { phase: { kind: string } }) => job.phase.kind)).toEqual(['launch-failed', 'launch-failed']);
});

test('a failed publication is never retried even when its terminal can be removed', async () => {
  const h = await retryFixture();
  h.hc.fileWrite = async (_machine, _path, bytes) => { h.published.push(JSON.parse(bytes.toString()).jobId); throw Object.assign(new Error('Write acknowledgement lost'), { code: 'release-timeout' }); };
  const pending = h.monitor().start(program, h.owner, on, {});
  await expect(pending).rejects.toMatchObject({ code: 'release-timeout' });
  await expect(pending).rejects.toThrow(/not retried.*write may have reached/i);
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
  const prepare = h.options.outputCollector.prepare;
  h.options.outputCollector.prepare = async (p, job) => ({ ...await prepare(p, job), releaseDeadlineAt: now + 10000 });
  if (fail) h.hc.fileRead = async () => { throw Object.assign(new Error('Read refused'), { code: 'hc-error' }); };
  const jobs = h.monitor(), activating = jobs.activate(h.owner);
  await began;
  const pending = jobs.start(program, h.owner, on, {});
  now = 16000; unblock(); await activating;
  if (fail) {
    await expect(pending).rejects.toMatchObject({ releaseFailure: { step: 'fileRead', beforeReleaseMs: 15000, queueWaitMs: 15000 } });
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

test('a slow launch reply keeps the hard cap and retries without releasing the expired attempt', async () => {
  const h = await retryFixture();
  let now = 1000;
  h.options.clock = () => now;
  const prepare = h.options.outputCollector.prepare;
  h.options.outputCollector.prepare = async (p, job) => ({ ...await prepare(p, job), releaseDeadlineAt: now + 10000 });
  const run = h.hc.run;
  h.hc.run = async request => { const result = await run(request); if (h.launches.length === 1) now = 11000; return result; };
  const handle = await h.monitor().start(program, h.owner, on, {});
  expect(h.published).toEqual([handle.id]);
  expect(h.launches).toHaveLength(2);
  const saved = await createJobStore(h.f.root, h.owner.sessionId).read();
  expect(saved.jobs[0].phase).toMatchObject({ kind: 'launch-failed', releaseFailure: { step: 'overall check', beforeReleaseMs: 10000, queueWaitMs: 0 } });
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
