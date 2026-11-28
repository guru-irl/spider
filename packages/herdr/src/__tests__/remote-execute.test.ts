// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { executeRemote } from '../remote/execute.js';
import { runExec, runBatch, isExecError, type ExecCtx } from '../../../context/src/actions/exec.js';
import type { RemoteResult, Owner, MachineName, JobId } from '../contracts.js';
import { fixture } from './remote-execute-fixture.js';

function adapterFixture(result: Omit<RemoteResult, 'remote'>, code: string, kind: 'exec' | 'batch' = 'exec', background = false): ExecCtx {
  const owner = { sessionId: 'adapter-owner', generation: 'adapter-generation', cwd: '/fixture', sessionFile: null, name: null,
    terminal: { coreId: 'core', terminalId: 'owner', address: 'owner', socket: '/fixture/core.sock', sessionNamespace: 'fixture' } } as Owner;
  return { cwd: owner.cwd, owner, remote: { execute: async request => {
    expect(request).toMatchObject({ on: 'remote.invalid', owner, source: { kind: 'code', language: 'javascript', code }, kind, timeout: 1000 });
    expect(request.background === true).toBe(background);
    return { ...result, remote: { jobId: 'test-job' as JobId, machine: 'remote.invalid' as MachineName, address: null } };
  } } };
}

async function hupTimeout(mode: 'fake' | 'hc'): Promise<void> {
  const { h, f, ctx } = await fixture(mode);
  const result = await runExec({ on: 'remote.invalid', language: 'javascript', code: "process.on('SIGHUP',()=>{console.log('trapped HUP');process.exit(0)}); console.log('ready'); setInterval(()=>{},1000)", timeout: 1000 }, ctx);
  expect(result.details).toMatchObject({ exitCode: 0, outcome: 'exited', timedOut: true });
  expect(result.details.stdout).toContain('trapped HUP'); expect(result.isError).toBe(true);
  expect(isExecError(result.details)).toBe(true);
  expect(await h.hc.get(f.started[0].address)).toMatchObject({ state: 'finished', exitCode: 0 });
  expect(f.cancellations).toEqual([{ id: f.started[0].id, reason: 'timeout' }]);
}
describe('remote result adapter', () => {
  it('reports a foreground timeout and the SIGHUP receipt to the caller', async () => {
    const code = 'setInterval(() => {}, 1000)';
    const ctx = adapterFixture({ stdout: '', stderr: '', exitCode: null, timedOut: true, outcome: 'signal', signal: 'SIGHUP' }, code);
    const result = await runExec({ on: 'remote.invalid', language: 'javascript', code, timeout: 1000 }, ctx);
    expect(result.text.startsWith('[timed out after 1 s. Spider sent a stop, and the command ended by signal SIGHUP.]')).toBe(true);
    expect(result.isError).toBe(true);
  }, 20000);
  it.each(['timeout', 'abort'] as const)('retains a trapped exit when each post-%s read takes 1200 ms', async reason => {
    const { f, ctx } = await fixture('fake', 'socket'), stop = new AbortController();
    const sink = f.ports.logSink;
    f.ports.logSink = async (job, options) => {
      const reader = await sink(job, options);
      return { collect: async () => { await delay(1200); return reader.collect(); }, dispose: () => reader.dispose() };
    };
    const result = await runExec({ on: 'remote.invalid', language: 'javascript', code: "process.on('SIGHUP',()=>{console.log('trapped HUP');process.exit(0)}); console.log('ready'); setInterval(()=>{},1000)", ...(reason === 'timeout' ? { timeout: 1000 } : {}) },
      { ...ctx, signal: stop.signal, onPartial: text => { if (reason === 'abort' && text.includes('ready')) stop.abort(); } });
    expect(result.details).toMatchObject(reason === 'timeout' ? { outcome: 'exited', exitCode: 0, timedOut: true } : { outcome: 'aborted', aborted: true, timedOut: false });
    expect(result.details.stdout).toContain('trapped HUP');
    expect(result.isError).toBe(true);
    expect(f.detached).toEqual([]);
    if (reason === 'abort') expect(result.details.remoteAbortInfo).toContain('exited with code 0');
  }, 20000);
  it('reports a trapped timeout with the actual exit zero', async () => {
    const code = "process.on('SIGHUP', () => process.exit(0)); setInterval(() => {}, 1000)";
    const ctx = adapterFixture({ stdout: '', stderr: '', exitCode: 0, timedOut: true, outcome: 'exited' }, code);
    const result = await runExec({ on: 'remote.invalid', language: 'javascript', code, timeout: 1000 }, ctx);
    expect(result.text.startsWith("[timed out after 1 s. Spider sent a stop, and the command's exit status was 0.]")).toBe(true);
    expect(result.isError).toBe(true);
  }, 20000);
  it('labels a timed out batch item and names its timeout', async () => {
    const code = 'setInterval(() => {}, 1000)';
    const ctx = adapterFixture({ stdout: '', stderr: '', exitCode: null, timedOut: true, outcome: 'signal', signal: 'SIGHUP' }, code, 'batch');
    const result = await runBatch({ on: 'remote.invalid', commands: [{ language: 'javascript', code, timeout: 1000 }] }, ctx);
    expect(result.text).toContain('── [1] javascript · timed out · signal SIGHUP ──');
    expect(result.text).toContain('[timed out after 1 s. Spider sent a stop, and the command ended by signal SIGHUP.]');
    expect(result.isError).toBe(true);
  }, 20000);
  it('labels a timed out batch item that exits zero', async () => {
    const code = "process.on('SIGHUP', () => process.exit(0)); setInterval(() => {}, 1000)";
    const ctx = adapterFixture({ stdout: '', stderr: '', exitCode: 0, timedOut: true, outcome: 'exited' }, code, 'batch');
    const result = await runBatch({ on: 'remote.invalid', commands: [{ language: 'javascript', code, timeout: 1000 }] }, ctx);
    expect(result.text).toContain('── [1] javascript · timed out · exit 0 ──');
    expect(result.text).toContain("[timed out after 1 s. Spider sent a stop, and the command's exit status was 0.]");
    expect(result.isError).toBe(true);
  }, 20000);
  it('reports an indeterminate timeout without claiming the command stopped', async () => {
    const ctx = adapterFixture({ stdout: '', stderr: '', exitCode: null, timedOut: true, outcome: 'unknown' }, '0');
    const result = await runExec({ on: 'remote.invalid', language: 'javascript', code: '0', timeout: 1000 }, ctx);
    expect(result.text.startsWith('[timed out after 1 s. Spider tried to stop the command, but its outcome is unknown.]')).toBe(true);
    expect(result.isError).toBe(false);
  }, 20000);
  it('lets abort win when it races a timeout cancellation', async () => {
    const { f, ctx } = await fixture('fake', 'socket'); const abort = new AbortController();
    const start = f.ports.jobs.start;
    f.ports.jobs.start = async (...args) => {
      const job = await start(...args); const cancel = job.cancel;
      job.cancel = async reason => { if (reason === 'timeout') abort.abort(); await cancel(reason); };
      return job;
    };
    const result = await runExec({ on: 'remote.invalid', language: 'javascript', code: 'setInterval(() => {}, 1000)', timeout: 1000 }, { ...ctx, signal: abort.signal });
    expect(result.details).toMatchObject({ outcome: 'aborted', aborted: true, timedOut: false });
    expect(result.text).not.toContain('timed out');
    expect(result.isError).toBe(true);
  }, 20000);
  it('returns an unknown timeout with job paths when cancellation throws', async () => {
    const { f, ctx } = await fixture(); const start = f.ports.jobs.start;
    f.ports.jobs.start = async (...args) => {
      const job = await start(...args);
      job.cancel = async () => { throw new Error('Transport unavailable'); };
      return job;
    };
    const result = await runExec({ on: 'remote.invalid', language: 'javascript', code: 'setInterval(() => {}, 1000)', timeout: 1000 }, ctx);
    expect(result.details).toMatchObject({ outcome: 'unknown', exitCode: null, timedOut: true });
    expect(result.details.backgroundJob.receipt).toBe(join(f.started[0].localDirectory, 'receipt.json'));
    expect(result.details.backgroundLogs).toEqual({ stdout: join(f.started[0].localDirectory, 'stdout.log'), stderr: join(f.started[0].localDirectory, 'stderr.log') });
    expect(result.text.startsWith('[timed out after 1 s. Spider tried to stop the command, but its outcome is unknown.]')).toBe(true);
    expect(result.text).toContain(result.details.backgroundJob.receipt);
    expect(result.text).toContain(result.details.backgroundLogs.stdout);
    expect(result.text).toContain(result.details.backgroundLogs.stderr);
    expect(result.isError).toBe(false);
  }, 20000);
  it('reports a timeout whose command never started', async () => {
    const ctx = adapterFixture({ stdout: '', stderr: '', exitCode: null, timedOut: true, outcome: 'spawn-error' }, '0');
    const result = await runExec({ on: 'remote.invalid', language: 'javascript', code: '0', timeout: 1000 }, ctx);
    expect(result.text.startsWith('[timed out after 1 s. Spider tried to stop the command, but it never started (spawn error).]')).toBe(true);
    expect(result.isError).toBe(true);
  }, 20000);
  it('keeps the existing detached wording for a background timeout', async () => {
    const code = 'setInterval(() => {}, 1000)', logs = { stdout: '/fixture/stdout.log', stderr: '/fixture/stderr.log' };
    const ctx = adapterFixture({ stdout: '', stderr: '', exitCode: null, timedOut: true, outcome: 'timeout', backgrounded: true,
      backgroundJob: { id: 'test-job', dir: '/fixture', manifest: '/fixture/job.json', receipt: '/fixture/receipt.json', logs }, backgroundLogs: logs }, code, 'exec', true);
    const result = await runExec({ on: 'remote.invalid', language: 'javascript', code, timeout: 1000, background: true }, ctx);
    expect(result.text).toContain('[detached. The command has not finished, so its exit status is unknown.');
    expect(result.text).toContain('Wait for the spider.job_done notice in this session. Do not poll or schedule checks.');
    expect(result.text).not.toContain('Spider stopped the command');
    expect(result.isError).toBe(false);
  }, 20000);
  it('a child uses the same executor and receives its own output and exit code', async () => {
    const { f, request } = await fixture('fake', 'socket'); vi.stubEnv('PI_SUBAGENT_CHILD', '1');
    const result = await executeRemote(request("console.log('child output');process.exitCode=23"), f.ports);
    expect(result).toMatchObject({ stdout: 'child output\n', exitCode: 23, outcome: 'exited' });
  }, 20000);
  it('detaches only at a supplied timeout and keeps the true exit unknown', async () => {
    const { h, f, request } = await fixture();
    const detached = await executeRemote(request("setTimeout(()=>{console.log('done');process.exitCode=23},2000)", { timeout: 25, background: true }), f.ports);
    expect(detached).toMatchObject({ exitCode: null, outcome: 'timeout', timedOut: true, backgrounded: true });
    expect(await h.hc.get(detached.remote.address!)).toMatchObject({ state: 'live' });
    expect(f.detached).toEqual([detached.remote.jobId]); expect(f.consumed).toEqual([]);
    expect(detached.backgroundJob?.receipt).toBe(join(f.started[0].localDirectory, 'receipt.json'));
    const waited = await executeRemote(request("setTimeout(()=>{console.log('done');process.exitCode=23},100)", { background: true }), f.ports);
    expect(waited).toMatchObject({ stdout: 'done\n', exitCode: 23, outcome: 'exited', timedOut: false });
    expect(f.consumed).toEqual([waited.remote.jobId]); expect(waited.backgrounded).not.toBe(true);
  }, 20000);
  it('a remote HUP-trapping exit-zero timeout remains an error', async () => { await hupTimeout('fake'); }, 20000);
  it.skipIf(process.env.SPIDER_HERDR_E2E !== '1')('real isolated hc HUP-trapping exit-zero timeout without an app window (requires SPIDER_HERDR_E2E=1)', async () => { await hupTimeout('hc'); }, 20000);
  it('preserves the actual signal and spawn-error instead of inventing an exit code', async () => {
    const { f, request } = await fixture();
    const signalled = await executeRemote(request("process.kill(process.pid,'SIGTERM')"), f.ports);
    expect(signalled).toMatchObject({ outcome: 'signal', exitCode: null, signal: 'SIGTERM' }); expect(isExecError(signalled)).toBe(true);
    const target = f.ports.target; f.ports.target = async (on, owner) => ({ ...await target(on, owner), commands: { javascript: ['/nonexistent-spider-fixture-interpreter'] } });
    const missing = await executeRemote(request('console.log("wrong")'), f.ports);
    expect(missing).toMatchObject({ outcome: 'spawn-error', exitCode: null }); expect(isExecError(missing)).toBe(true);
  }, 20000);
});
