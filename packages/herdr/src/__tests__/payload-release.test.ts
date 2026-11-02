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
