// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { installFixtureRuntime, mountedFixture } from './herdr-wiring-fixture.js';
import { processStartIdentity } from '../../../herdr/src/jobs/handoff.js';
import { killOwnedJob } from '../herdr/kill-job.js';
import { HerdrError } from '../../../herdr/src/client/parse.js';
import { parseRuntimeReceipt } from '../../../herdr/src/remote/transfer.js';
import { freshDb } from '../../../subagents/src/__tests__/helpers/testutil.js';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('kills a session-owned detached job by prefix, including descendants, and sends a cancelled notice', async () => {
  const f = await mountedFixture('fake', 'tui', true, false, true, true);
  try {
    await installFixtureRuntime(f);
    const execution = f.mount.execution();
    const code = `process.on('SIGTERM',()=>{});const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('child-ready '+process.pid);setInterval(()=>{},1000)"],{stdio:['ignore','pipe','inherit']});child.stdout.on('data',b=>process.stdout.write(b));console.log('parent-ready '+process.pid);setInterval(()=>{},1000)`;
    const job = await execution.remote!.execute({ owner: execution.owner!, on: 'remote.invalid' as never,
      source: { kind: 'code', language: 'javascript', code }, background: true, timeout: 100 });
    expect(job.outcome).toBe('timeout');
    let output = '';
    await vi.waitFor(async () => { output = await readFile(job.backgroundLogs!.stdout, 'utf8'); expect(output).toContain('child-ready'); }, { timeout: 30000, interval: 100 });
    const childPid = Number(/child-ready (\d+)/.exec(output)![1]);
    const outsider = { ...execution.owner!, sessionId: 'foreign-session' as never };
    await expect(killOwnedJob(job.remote.jobId, outsider, f.h.hc, f.config.machines as never, join(f.config.globalRoot, 'herdr/jobs'))).rejects.toThrow(/no.*owned/i);
    expect((await f.h.hc.get(job.remote.address!)).state).toBe('live');
    const killJob = (f.mount as typeof f.mount & { killJob?: (id: string) => Promise<{ jobId: string }> }).killJob;
    expect(killJob).toBeTypeOf('function');
    expect(await killJob!(job.remote.jobId.slice(0, 8))).toMatchObject({ jobId: job.remote.jobId });
    let notice: { content: string; details: { reason: string } } | undefined;
    await vi.waitFor(() => {
      notice = f.notices.find(value => typeof value === 'object' && value !== null && 'customType' in value && value.customType === 'spider.job_done') as typeof notice;
      expect(notice).toBeDefined();
    }, { timeout: 60000, interval: 100 });
    expect(notice!.details.reason).toBe('cancelled');
    expect(notice!.content.toLowerCase()).toContain('cancelled');
    await vi.waitFor(() => expect(processStartIdentity(childPid)).toBeNull(), { timeout: 10000, interval: 100 });
    expect((await f.h.hc.get(job.remote.address!)).state).toBe('finished');
    await expect(killJob!('not-owned')).rejects.toThrow(/no.*owned|not owned/i);
  } finally { await f.close(); }
}, 120000);

it('still kills an ignoring descendant after its group leader exits on TERM', async () => {
  const f = await mountedFixture('fake', 'tui', true, false, true, true);
  try {
    await installFixtureRuntime(f);
    const execution = f.mount.execution();
    const code = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('child-ready '+process.pid);setInterval(()=>{},1000)"],{stdio:['ignore','pipe','inherit']});child.stdout.on('data',b=>process.stdout.write(b));setInterval(()=>{},1000)`;
    const job = await execution.remote!.execute({ owner: execution.owner!, on: 'remote.invalid' as never,
      source: { kind: 'code', language: 'javascript', code }, background: true, timeout: 100 });
    let output = '';
    await vi.waitFor(async () => { output = await readFile(job.backgroundLogs!.stdout, 'utf8'); expect(output).toContain('child-ready'); }, { timeout: 30000, interval: 100 });
    const childPid = Number(/child-ready (\d+)/.exec(output)![1]);
    await f.mount.killJob(job.remote.jobId);
    await vi.waitFor(() => expect(processStartIdentity(childPid)).toBeNull(), { timeout: 10000, interval: 100 });
    await vi.waitFor(() => expect(f.notices.some(value => typeof value === 'object' && value !== null && 'customType' in value && value.customType === 'spider.job_done')).toBe(true), { timeout: 60000, interval: 100 });
  } finally { await f.close(); }
}, 90000);

it('stops an identifiable older-runtime job by its unique program path', async () => {
  const f = await mountedFixture('fake', 'tui', true, false, true, true);
  try {
    await installFixtureRuntime(f);
    const execution = f.mount.execution();
    const job = await execution.remote!.execute({ owner: execution.owner!, on: 'remote.invalid' as never,
      source: { kind: 'code', language: 'shell', code: 'printf legacy-ready; sleep 30' }, background: true, timeout: 100 });
    await vi.waitFor(async () => expect(await readFile(job.backgroundLogs!.stdout, 'utf8')).toContain('legacy-ready'), { timeout: 30000, interval: 100 });
    // Absence of the capability is how an already-running pre-upgrade runtime is identified.
    const manifest = JSON.parse(await readFile(job.backgroundJob!.manifest, 'utf8'));
    await expect(readFile(join(manifest.remoteDirectory, 'capabilities.json'), 'utf8')).resolves.toContain('cancelAfterRelease');
    await unlink(join(manifest.remoteDirectory, 'capabilities.json'));
    const unidentifiable = { ...execution.remote!, execute: async () => ({ outcome: 'exited', exitCode: 0, stdout: '{"state":"unidentifiable"}', stderr: '' }) };
    await expect(killOwnedJob(job.remote.jobId, execution.owner!, f.h.hc, f.config.machines as never, join(f.config.globalRoot, 'herdr/jobs'), unidentifiable as never)).rejects.toThrow(/older spider.*Runtime path:.*Stop it by hand/i);
    expect((await f.h.hc.get(job.remote.address!)).state).toBe('live');
    expect(await f.mount.killJob(job.remote.jobId)).toMatchObject({ jobId: job.remote.jobId });
    let notice: { details: { reason: string } } | undefined;
    await vi.waitFor(() => {
      notice = f.notices.find(value => typeof value === 'object' && value !== null && 'customType' in value && value.customType === 'spider.job_done') as typeof notice;
      expect(notice).toBeDefined();
    }, { timeout: 60000, interval: 100 });
    expect(notice!.details.reason).toBe('cancelled');
  } finally { await f.close(); }
}, 90000);

it('routes a unique job match without falling back to subagent runs', async () => {
  const module = await import('../herdr/kill-job.js') as Record<string, unknown>;
  expect(module.routeKillAction).toBeTypeOf('function');
  const requested: string[] = [];
  const mount = { enabled: () => true, findKillJobs: async () => [{ id: 'job-123' }], killJob: async (id: string) => { requested.push(id); return { jobId: 'job-123', machine: 'alpha.invalid', address: 'alpha.invalid/t1', state: 'cancellation-requested' }; } };
  const route = module.routeKillAction as (getMount: () => typeof mount, fallback: (args: unknown, ctx: unknown) => Promise<unknown>) => (args: { id: string }, ctx: unknown) => Promise<{ content: string }>;
  const action = route(() => mount, async () => { throw new Error('unexpected run fallback'); });
  const db = freshDb();
  let reply: { content: string };
  try { reply = await action({ id: 'job-1' }, { db, sessionId: 'planner' }); } finally { db.close(); }
  expect(requested).toEqual(['job-123']);
  expect(reply.content).toContain('job-123');
  expect(reply.content).toContain('spider.job_done');
});

it('preserves subagent kill and names an unowned job on a miss', async () => {
  const { routeKillAction } = await import('../herdr/kill-job.js');
  const mount = { enabled: () => true, findKillJobs: async () => [], killJob: async () => { throw new HerdrError('job-not-owned', 'No active job owned by this session'); } };
  const action = routeKillAction(() => mount, async args => args.id === 'all'
    ? { content: 'subagents handled' }
    : { content: 'kill: no active run matches', isError: true });
  expect(await action({ action: 'kill', id: 'all' }, {} as never)).toMatchObject({ content: 'subagents handled' });
  const db = freshDb();
  try { expect(await action({ action: 'kill', id: 'not-owned' }, { db, sessionId: 'planner' } as never)).toMatchObject({ isError: true, content: expect.stringMatching(/job owned by this session/i) }); }
  finally { db.close(); }
});

it('lets the owning session IPC cancel a detached job but refuses an unowned ID', async () => {
  const f = await mountedFixture('fake', 'tui', true, false, true, true);
  try {
    await installFixtureRuntime(f);
    const execution = f.mount.execution();
    const job = await execution.remote!.execute({ owner: execution.owner!, on: 'remote.invalid' as never,
      source: { kind: 'code', language: 'shell', code: 'printf ipc-ready; sleep 30' }, background: true, timeout: 100 });
    const ipc = f.ipc as typeof f.ipc & { killJob?: (id: string) => Promise<{ ok: boolean; op?: string; code?: string }> };
    expect(ipc?.killJob).toBeTypeOf('function');
    expect(await ipc!.killJob!(job.remote.jobId)).toMatchObject({ ok: true, op: 'killJob' });
    expect(await ipc!.killJob!('not-owned')).toMatchObject({ ok: false, code: 'not-found' });
    await vi.waitFor(() => expect(f.notices.some(value => typeof value === 'object' && value !== null && 'customType' in value && value.customType === 'spider.job_done')).toBe(true), { timeout: 60000, interval: 100 });
  } finally { await f.close(); }
}, 90000);

it('adds a conservative SIGTERM hint to an older 143 receipt', () => {
  const location = { on: 'alpha.invalid' as never, directory: '/owned/job', jobId: 'job', nonce: 'nonce', requestSha256: 'a'.repeat(64) };
  const bytes = Buffer.from(JSON.stringify({ version: 1, jobId: 'job', nonce: 'nonce', requestSha256: 'a'.repeat(64), indexSha256: 'b'.repeat(64), outcome: 'exited', exitCode: 143, signal: null, finishedAt: 1, stdoutBytes: 0, stderrBytes: 0 }));
  expect(parseRuntimeReceipt(bytes, location)).toMatchObject({ exitCode: 143, signal: null, signalHint: 'SIGTERM' });
});

it('reports a conventional signal exit in both the receipt and completion notice', async () => {
  const f = await mountedFixture('fake', 'tui', true, false, true, true);
  try {
    await installFixtureRuntime(f);
    const execution = f.mount.execution();
    const job = await execution.remote!.execute({ owner: execution.owner!, on: 'remote.invalid' as never,
      source: { kind: 'code', language: 'shell', code: 'sleep 1; exit 143' }, background: true, timeout: 50 });
    let notice: { content: string; details: { exitCode: number } } | undefined;
    await vi.waitFor(() => {
      notice = f.notices.find(value => typeof value === 'object' && value !== null && 'customType' in value && value.customType === 'spider.job_done') as typeof notice;
      expect(notice).toBeDefined();
    }, { timeout: 60000, interval: 100 });
    expect(notice!.details.exitCode).toBe(143);
    expect(notice!.content).toMatch(/143.*SIGTERM/i);
    const receipt = JSON.parse(await readFile(join(job.backgroundJob!.dir, 'receipt.json'), 'utf8'));
    expect(receipt).toMatchObject({ exitCode: 143, signalHint: 'SIGTERM' });
  } finally { await f.close(); }
}, 90000);
