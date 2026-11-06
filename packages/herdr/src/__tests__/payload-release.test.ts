// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test, vi } from 'vitest';
import { releaseRemoteJob } from '../jobs/observer.js';
import type { JobId, JobRecord, Owner, RunId, TerminalAddress, TerminalSummary } from '../contracts.js';
const owner = { sessionId: 'session', generation: 'generation', terminal: { address: 'agent', coreId: 'core', terminalId: 'agent', socket: '/fixture/socket', sessionNamespace: 'fixture' }, cwd: '/fixture', name: null, sessionFile: null } as Owner;
const job: JobRecord = { version: 1, id: 'job' as JobId, kind: 'exec', owner, machine: 'remote.invalid' as JobRecord['machine'],
  phase: { kind: 'waiting-for-pane', address: 'remote.invalid/job' as TerminalAddress }, viewer: null, localDirectory: '/fixture/local', remoteDirectory: '/fixture/remote', detached: false, noticeMode: 'tool', notice: 'pending' };
const requestSha256 = 'a'.repeat(64);
const labels = { 'spider.machine': 'remote.invalid', 'spider.kind': 'exec', 'spider.job': 'job', 'spider.session': 'session', 'spider.owner-core': 'core', 'spider.owner-terminal': 'agent' };
const terminal = (extra = {}) => ({ address: 'remote.invalid/job' as TerminalAddress, state: 'live', parent: null, labels: { ...labels, ...extra }, status: null, exitCode: null, reason: null, signal: null, finishedAt: null }) as TerminalSummary;

test('a child job cannot release until hc confirms its run label too', async () => {
  let confirmed = false;
  const hc = { get: async () => terminal({ 'spider.run': confirmed ? 'child' : 'other-child' }), fileRead: vi.fn(async () => Buffer.from(requestSha256 + '\n')) };
  const released: unknown[] = [];
  const pending = releaseRemoteJob({ ...job, runId: 'child' as RunId }, { hc, nonce: 'nonce', releaseDeadlineAt: Date.now() + 10000, clock: Date.now,
    releaseFileWriter: async (_record, bytes) => { released.push(JSON.parse(bytes.toString())); } });
  await new Promise(r => setImmediate(r)); expect(released).toEqual([]); expect(hc.fileRead).not.toHaveBeenCalled();
  confirmed = true; await pending;
  expect(released).toEqual([{ version: 1, jobId: 'job', nonce: 'nonce', requestSha256, releasedAt: expect.any(Number) }]);
  expect(hc.fileRead).toHaveBeenCalledWith('remote.invalid', '/fixture/remote/request.json.sha256');
});

test('a job cannot release until hc confirms its machine label', async () => {
  let confirmed = false;
  const writer = vi.fn();
  const pending = releaseRemoteJob(job, { hc: { get: async () => terminal({ 'spider.machine': confirmed ? 'remote.invalid' : 'other' }), fileRead: async () => Buffer.from(requestSha256) }, nonce: 'nonce', releaseDeadlineAt: Date.now() + 10000, clock: Date.now, releaseFileWriter: writer });
  await new Promise(r => setImmediate(r)); expect(writer).not.toHaveBeenCalled();
  confirmed = true; await pending; expect(writer).toHaveBeenCalledOnce();
});

test('an aborted confirmation never writes a late release after hc eventually replies', async () => {
  let reply!: (value: TerminalSummary) => void;
  const hc = { get: () => new Promise<TerminalSummary>(r => { reply = r; }), fileRead: async () => Buffer.from(requestSha256) };
  const writer = vi.fn(); const abort = new AbortController();
  const pending = releaseRemoteJob(job, { hc, nonce: 'nonce', releaseDeadlineAt: Date.now() + 10000, clock: Date.now, signal: abort.signal, releaseFileWriter: writer });
  abort.abort(); await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  reply(terminal()); await new Promise(r => setImmediate(r)); expect(writer).not.toHaveBeenCalled();
});

test('a hung hc confirmation expires in ten seconds and never releases on a late reply', async () => {
  vi.useFakeTimers();
  try {
    let reply!: (value: TerminalSummary) => void;
    const hc = { get: () => new Promise<TerminalSummary>(r => { reply = r; }), fileRead: async () => Buffer.from(requestSha256) };
    const writer = vi.fn();
    const pending = releaseRemoteJob(job, { hc, nonce: 'nonce', releaseDeadlineAt: Date.now() + 10000, clock: Date.now, releaseFileWriter: writer });
    const expired = expect(pending).rejects.toMatchObject({ code: 'release-timeout' });
    await vi.advanceTimersByTimeAsync(9999); expect(writer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await expired;
    reply(terminal()); await vi.advanceTimersByTimeAsync(1); expect(writer).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

test('abort during checksum read rejects before the late read reply and never publishes', async () => {
  let reply!: (bytes: Buffer) => void, seen: { code?: string } | undefined;
  const hc = { get: async () => terminal(), fileRead: () => new Promise<Buffer>(resolve => { reply = resolve; }) };
  const writer = vi.fn(), abort = new AbortController();
  const pending = releaseRemoteJob(job, { hc, nonce: 'nonce', releaseDeadlineAt: Date.now() + 10000, clock: Date.now, signal: abort.signal, releaseFileWriter: writer }).catch(error => { seen = error; });
  try {
    await new Promise(resolve => setImmediate(resolve)); abort.abort(); await new Promise(resolve => setImmediate(resolve));
    expect(seen?.code).toBe('aborted'); expect(writer).not.toHaveBeenCalled();
  } finally { reply(Buffer.from(requestSha256)); await pending; }
  expect(writer).not.toHaveBeenCalled();
});

test('a hung checksum read expires within the release deadline and cannot publish after a late reply', async () => {
  vi.useFakeTimers();
  let reply!: (bytes: Buffer) => void, seen: { code?: string } | undefined;
  const hc = { get: async () => terminal(), fileRead: () => new Promise<Buffer>(resolve => { reply = resolve; }) };
  const writer = vi.fn();
  const pending = releaseRemoteJob(job, { hc, nonce: 'nonce', releaseDeadlineAt: Date.now() + 10000, clock: Date.now, releaseFileWriter: writer }).catch(error => { seen = error; });
  try {
    await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(10000);
    expect(seen?.code).toBe('release-timeout'); expect(writer).not.toHaveBeenCalled();
  } finally { reply(Buffer.from(requestSha256)); await pending; vi.useRealTimers(); }
  expect(writer).not.toHaveBeenCalled();
});


test.each(['hc get', 'fileRead', 'release write'] as const)('reports a hung %s with elapsed time and time spent before release', async step => {
  vi.useFakeTimers();
  const started = Date.now();
  const never = () => new Promise<never>(() => {});
  const hc = { get: step === 'hc get' ? never : async () => terminal(), fileRead: step === 'fileRead' ? never : async () => Buffer.from(requestSha256) };
  let failure: unknown;
  const pending = releaseRemoteJob(job, { hc, nonce: 'nonce', releaseDeadlineAt: started + 10000, requestedAt: started - 4200, clock: Date.now,
    releaseFileWriter: step === 'release write' ? never : async () => {} }).catch(error => { failure = error; });
  try {
    await vi.advanceTimersByTimeAsync(10000);
    expect(failure).toMatchObject({ code: 'release-timeout', releaseFailure: { step, elapsedMs: 10000, beforeReleaseMs: 4200, timerDriftMs: 0 } });
    expect(String(failure)).toContain('remote.invalid');
  } finally { vi.useRealTimers(); }
  void pending;
});

test('reports the overall cap without making a remote request', async () => {
  const get = vi.fn(async () => terminal());
  let failure: unknown;
  await releaseRemoteJob(job, { hc: { get, fileRead: async () => Buffer.from(requestSha256) }, nonce: 'nonce', releaseDeadlineAt: 1000, clock: () => 1100,
    releaseFileWriter: async () => {} }).catch(error => { failure = error; });
  expect(failure).toMatchObject({ code: 'release-timeout', releaseFailure: { step: 'overall check', elapsedMs: 0, beforeReleaseMs: 0, timerDriftMs: 0 } });
  expect(get).not.toHaveBeenCalled();
});

test('a late timer lets an already arriving remote failure win', async () => {
  let now = 1000, fire!: () => void, reject!: (error: Error) => void;
  const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { fire = callback; return 123; }) as typeof setTimeout);
  const pending = releaseRemoteJob(job, { hc: { get: () => new Promise<TerminalSummary>((_resolve, fail) => { reject = fail; }), fileRead: async () => Buffer.from(requestSha256) }, nonce: 'nonce', releaseDeadlineAt: 11000, clock: () => now, releaseFileWriter: async () => {} });
  const result = expect(pending).rejects.toMatchObject({ code: 'hc-error', releaseFailure: { step: 'hc get', timerDriftMs: 2500 } });
  try {
    now = 13500;
    setImmediate(() => reject(Object.assign(new Error('Transport refused the request'), { code: 'hc-error' })));
    fire();
    await result;
  } finally { timer.mockRestore(); }
});


test('release errors keep long transport failures short', async () => {
  let failure: unknown;
  await releaseRemoteJob(job, { hc: { get: async () => { throw new Error('Failure '.repeat(2000)); }, fileRead: async () => Buffer.from(requestSha256) }, nonce: 'nonce', releaseDeadlineAt: Date.now() + 10000, clock: Date.now,
    releaseFileWriter: async () => {} }).catch(error => { failure = error; });
  expect(String(failure).length).toBeLessThan(500);
  expect(String(failure)).toContain('remote.invalid');
});


test('a release write already completing when a late timer fires returns success', async () => {
  let now = 1000, fire!: () => void, finish!: () => void, entered!: () => void;
  const writing = new Promise<void>(resolve => { entered = resolve; });
  const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { fire = callback; return 123; }) as typeof setTimeout);
  const pending = releaseRemoteJob(job, { hc: { get: async () => terminal(), fileRead: async () => Buffer.from(requestSha256) }, nonce: 'nonce', releaseDeadlineAt: 11000, clock: () => now,
    releaseFileWriter: () => new Promise<void>(resolve => { finish = resolve; entered(); }) });
  try {
    await writing; now = 13500;
    setImmediate(finish); fire();
    await expect(pending).resolves.toBeUndefined();
  } finally { timer.mockRestore(); }
});


test('a label deadline reports missing replies and the exact labels that did not match', async () => {
  let now = 1000, gets = 0;
  const pending = releaseRemoteJob({ ...job, runId: 'child' as RunId }, { hc: {
    get: async () => { now += 25; if (++gets === 1) throw Object.assign(new Error('Missing'), { code: 'not_found' }); return terminal({ 'spider.machine': 'other.invalid', 'spider.run': 'different-child' }); },
    fileRead: async () => Buffer.from(requestSha256),
  }, nonce: 'nonce', releaseDeadlineAt: 1075, clock: () => now, releaseFileWriter: async () => { throw new Error('Must not publish'); } });
  await expect(pending).rejects.toMatchObject({ releaseFailure: { step: 'overall check', confirmation: {
    checks: 3, notFound: 1, first: { kind: 'not_found' }, last: { kind: 'labels', differences: [
      { label: 'spider.machine', expected: 'remote.invalid', actual: 'other.invalid' },
      { label: 'spider.run', expected: 'child', actual: 'different-child' },
    ] },
  } } });
  await expect(pending).rejects.toThrow(/spider.machine.*other.invalid/);
});

test('a missing label is recorded as absent rather than as an empty value', async () => {
  let now = 1000;
  const pending = releaseRemoteJob(job, { hc: { get: async () => { now = 1100; return terminal({ 'spider.job': undefined }); }, fileRead: async () => Buffer.from(requestSha256) },
    nonce: 'nonce', releaseDeadlineAt: 1100, clock: () => now, releaseFileWriter: async () => {} });
  await expect(pending).rejects.toMatchObject({ releaseFailure: { confirmation: { checks: 1, last: { kind: 'labels', differences: [{ label: 'spider.job', expected: 'job', actual: null }] } } } });
});

test('a deadline made entirely of missing replies says not_found', async () => {
  let now = 1000;
  const pending = releaseRemoteJob(job, { hc: { get: async () => { now = 1100; throw Object.assign(new Error('Missing'), { code: 'not_found' }); }, fileRead: async () => Buffer.from(requestSha256) },
    nonce: 'nonce', releaseDeadlineAt: 1100, clock: () => now, releaseFileWriter: async () => {} });
  await expect(pending).rejects.toMatchObject({ releaseFailure: { confirmation: { checks: 1, notFound: 1, first: { kind: 'not_found' }, last: { kind: 'not_found' } } } });
  await expect(pending).rejects.toThrow(/not_found/);
});

test('an address rejected by the client remains visible in release diagnostics', async () => {
  const pending = releaseRemoteJob(job, { hc: { get: async () => { throw Object.assign(new Error('Wrong address'), { code: 'caller-mismatch', details: { expectedAddress: 'remote.invalid/job', actualAddress: 'other.invalid/job' } }); }, fileRead: async () => Buffer.from(requestSha256) },
    nonce: 'nonce', releaseDeadlineAt: Date.now() + 10000, clock: Date.now, releaseFileWriter: async () => {} });
  await expect(pending).rejects.toMatchObject({ code: 'caller-mismatch', releaseFailure: { confirmation: { checks: 1, last: { kind: 'address', expected: 'remote.invalid/job', actual: 'other.invalid/job' } } } });
  await expect(pending).rejects.toThrow(/other.invalid\/job/);
});
