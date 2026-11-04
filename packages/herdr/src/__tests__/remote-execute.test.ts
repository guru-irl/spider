// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { executeRemote, createRemoteExecutor } from '../remote/execute.js';
import { runExec, runBatch, isExecError } from '../../../context/src/actions/exec.js';
import { processToolContent } from '../../../host/src/routing/safety.js';
import { createHerdrHarness, type HerdrHarness } from './testutil.js';
import { acceptanceC, createRemoteTestFixture } from './acceptance/c.js';
import { createExpiredRemoteFixture } from './herdr-expired-fixture.js';
import type { RemoteExecuteRequest, MachineName, JobHandle, JobId } from '../contracts.js';
const harnesses: HerdrHarness[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const h of harnesses.splice(0)) {
    await h.close(); expect(await h.remainingOwnedResources()).toEqual([]);
    await mkdir(resolve('.spider/scratch/h/logs'), { recursive: true });
    await writeFile(resolve(`.spider/scratch/h/logs/c3-${h.mode}-cleanup.json`), JSON.stringify(h.cleanupProof, null, 2));
  }
});
async function fixture(mode: 'fake' | 'hc' = 'fake') {
  const h = await createHerdrHarness(mode); harnesses.push(h); await h.start();
  const f = await createRemoteTestFixture(h);
  const request = (code: string, options: Partial<RemoteExecuteRequest> = {}): RemoteExecuteRequest => ({ source: { kind: 'code', language: 'javascript', code }, on: 'remote.invalid' as MachineName, owner: h.owner!, ...options });
  const ctx = { cwd: h.owner!.cwd, owner: h.owner!, remote: createRemoteExecutor(f.ports) };
  return { h, f, request, ctx };
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
    const { ctx } = await fixture();
    const result = await runExec({ on: 'remote.invalid', language: 'javascript', code: 'setInterval(() => {}, 1000)', timeout: 1000 }, ctx);
    expect(result.text.startsWith('[timed out after 1 s. Spider sent a stop, and the command ended by signal SIGHUP.]')).toBe(true);
    expect(result.isError).toBe(true);
  }, 20000);
  it.each(['timeout', 'abort'] as const)('retains a trapped exit when each post-%s read takes 1200 ms', async reason => {
    const { f, ctx } = await fixture(), stop = new AbortController();
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
    const { ctx } = await fixture();
    const result = await runExec({ on: 'remote.invalid', language: 'javascript', code: "process.on('SIGHUP', () => process.exit(0)); setInterval(() => {}, 1000)", timeout: 1000 }, ctx);
    expect(result.text.startsWith("[timed out after 1 s. Spider sent a stop, and the command's exit status was 0.]")).toBe(true);
    expect(result.isError).toBe(true);
  }, 20000);
  it('labels a timed out batch item and names its timeout', async () => {
    const { ctx } = await fixture();
    const result = await runBatch({ on: 'remote.invalid', commands: [{ language: 'javascript', code: 'setInterval(() => {}, 1000)', timeout: 1000 }] }, ctx);
    expect(result.text).toContain('── [1] javascript · timed out · signal SIGHUP ──');
    expect(result.text).toContain('[timed out after 1 s. Spider sent a stop, and the command ended by signal SIGHUP.]');
    expect(result.isError).toBe(true);
  }, 20000);
  it('labels a timed out batch item that exits zero', async () => {
    const { ctx } = await fixture();
    const result = await runBatch({ on: 'remote.invalid', commands: [{ language: 'javascript', code: "process.on('SIGHUP', () => process.exit(0)); setInterval(() => {}, 1000)", timeout: 1000 }] }, ctx);
    expect(result.text).toContain('── [1] javascript · timed out · exit 0 ──');
    expect(result.text).toContain("[timed out after 1 s. Spider sent a stop, and the command's exit status was 0.]");
    expect(result.isError).toBe(true);
  }, 20000);
  it('reports an indeterminate timeout without claiming the command stopped', async () => {
    const { ctx } = await fixture();
    ctx.remote.execute = async () => ({ stdout: '', stderr: '', exitCode: null, timedOut: true, outcome: 'unknown', remote: { jobId: 'test-job' as JobId, machine: 'remote.invalid' as MachineName, address: null } });
    const result = await runExec({ on: 'remote.invalid', language: 'javascript', code: '0', timeout: 1000 }, ctx);
    expect(result.text.startsWith('[timed out after 1 s. Spider tried to stop the command, but its outcome is unknown.]')).toBe(true);
    expect(result.isError).toBe(false);
  }, 20000);
  it('lets abort win when it races a timeout cancellation', async () => {
    const { f, ctx } = await fixture(); const abort = new AbortController();
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
    const { ctx } = await fixture();
    ctx.remote.execute = async () => ({ stdout: '', stderr: '', exitCode: null, timedOut: true, outcome: 'spawn-error', remote: { jobId: 'test-job' as JobId, machine: 'remote.invalid' as MachineName, address: null } });
    const result = await runExec({ on: 'remote.invalid', language: 'javascript', code: '0', timeout: 1000 }, ctx);
    expect(result.text.startsWith('[timed out after 1 s. Spider tried to stop the command, but it never started (spawn error).]')).toBe(true);
    expect(result.isError).toBe(true);
  }, 20000);
  it('keeps the existing detached wording for a background timeout', async () => {
    const { ctx } = await fixture();
    const result = await runExec({ on: 'remote.invalid', language: 'javascript', code: 'setInterval(() => {}, 1000)', timeout: 1000, background: true }, ctx);
    expect(result.text).toContain('[detached. The command has not finished, so its exit status is unknown.');
    expect(result.text).toContain('Wait for the spider.job_done notice in this session. Do not poll or schedule checks.');
    expect(result.text).not.toContain('Spider stopped the command');
    expect(result.isError).toBe(false);
  }, 20000);
  it('a child uses the same executor and receives its own output and exit code', async () => {
    const { f, request } = await fixture(); vi.stubEnv('PI_SUBAGENT_CHILD', '1');
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
  it('Escape mid-batch cancels the current job and starts no later entry', async () => {
    const { f, ctx } = await fixture(); const abort = new AbortController();
    const result = await runBatch({ on: 'remote.invalid', commands: [{ language: 'javascript', code: "console.log('started'); setInterval(()=>console.log('still running'),100)" }, { language: 'javascript', code: "console.log('must not run')" }] }, { ...ctx, signal: abort.signal, onPartial: text => { if (text.includes('started')) abort.abort(); } });
    expect(result.details).toHaveLength(1); expect(result.details[0]).toMatchObject({ outcome: 'aborted', exitCode: 137, aborted: true, timedOut: false });
    expect(result.isError).toBe(true); expect(f.started).toHaveLength(1); expect(f.cancellations[0].reason).toBe('abort');
    expect(f.consumed).toEqual([f.started[0].id]);
  }, 20000);
  it('foreground capture-cap cancels, while background capture-cap retains exact durable bytes', async () => {
    const { h, f, request } = await fixture(); f.ports.hardCapBytes = 1024;
    await expect(executeRemote(request("process.stdout.write('x'.repeat(8192));setInterval(()=>{},1000)"), f.ports)).rejects.toMatchObject({ code: 'output-cap-exceeded' });
    expect(f.cancellations).toHaveLength(1);
    const result = await executeRemote(request("process.stdout.write('y'.repeat(8192));process.exitCode=23", { background: true }), f.ports);
    expect(result).toMatchObject({ exitCode: 23, outcome: 'exited', timedOut: false }); expect(result.stdout).toHaveLength(1024);
    expect(f.cancellations).toHaveLength(1);
    expect(await readFile(join(f.started[1].localDirectory, 'stdout.log'), 'utf8')).toBe('y'.repeat(8192));
    expect(result.backgroundJob?.dir).toBe(f.started[1].localDirectory);
  }, 20000);
  it('transport loss remains neutral with durable locations and cannot trigger a local fallback', async () => {
    const base = await createExpiredRemoteFixture(process.env.SPIDER_HERDR_E2E === '1' ? 'hc' : 'fake');
    const f = { ...base, started: [] as JobHandle[], cancellations: [] as { id: JobHandle['id']; reason: string }[] };
    const start = f.ports.jobs.start;
    f.ports.jobs.start = async (...args) => { const job = await start(...args), cancel = job.cancel; f.started.push(job); job.cancel = async reason => { f.cancellations.push({ id: job.id, reason }); await cancel(reason); }; loseTransport(); return job; };
    const request = (code: string, options: Partial<RemoteExecuteRequest> = {}): RemoteExecuteRequest => ({ ...f.request(code), ...options });
    const runtimePath = (await f.ports.target('remote.invalid' as MachineName, f.h.owner!)).runtimePath, read = f.ports.hc.fileRead;
    const loseTransport = () => { f.ports.hc.fileRead = async (on, path) => { if (path !== runtimePath) throw new Error('Transport unavailable'); return read(on, path); }; };
    try {
    const result = await executeRemote(request('setInterval(()=>{},1000)', { background: true }), f.ports);
    expect(result).toMatchObject({ outcome: 'unknown', exitCode: null, timedOut: false }); expect(isExecError(result)).toBe(false);
    expect(result.backgroundJob?.receipt).toBe(join(f.started[0].localDirectory, 'receipt.json')); expect(f.cancellations).toEqual([]);
    const count = f.started.length;
    await expect(executeRemote({ ...request('console.log("wrong")'), on: 'missing.invalid' as MachineName }, f.ports)).rejects.toMatchObject({ code: 'machine-not-found' }); expect(f.started).toHaveLength(count);
    } finally { await f.close(); expect(await f.h.remainingOwnedResources()).toEqual([]); }
  }, 20000);
  it('valid receipt-only completion settles without a retained original finished event', async () => {
    const f = await createExpiredRemoteFixture(process.env.SPIDER_HERDR_E2E === '1' ? 'hc' : 'fake');
    try {
      const result = await executeRemote(f.request("console.log('receipt only');process.exitCode=23"), f.ports);
      expect(result).toMatchObject({ stdout: 'receipt only\n', exitCode: 23, outcome: 'exited' });
      await expect(f.h.hc.get(result.remote.address!)).rejects.toMatchObject({ code: 'not_found' });
      expect((await f.journal()).jobs[0]).toMatchObject({ originalFinish: null, terminalExpired: true, phase: { kind: 'finished', result: { exitCode: 23 } } });
    } finally { await f.close(); expect(await f.h.remainingOwnedResources()).toEqual([]); }
  }, 20000);
  it('remote previews contain only payload streams and retain the existing host scrub and text cap', async () => {
    const { f, ctx } = await fixture(); const token = 'ghp_' + 'A'.repeat(36); const previews: { text: string; at: number }[] = [];
    const result = await runExec({ on: 'remote.invalid', language: 'javascript', code: `console.log(${JSON.stringify(token)});let n=0;const t=setInterval(()=>{console.log('visible '+n+' '+ 'x'.repeat(3000));if(++n===8)clearInterval(t)},120)` }, { ...ctx, onPartial: text => previews.push({ text: processToolContent(text, { secretScrub: true, injectionScan: false }).content, at: Date.now() }) });
    expect(previews.length).toBeGreaterThan(1);
    for (const preview of previews) { expect(Buffer.byteLength(preview.text)).toBeLessThanOrEqual(10000); expect(preview.text).not.toContain(token); expect(preview.text).not.toContain('SPIDER_HERDR_READY'); }
    for (let i = 1; i < previews.length - 1; i++) expect(previews[i].at - previews[i - 1].at).toBeGreaterThanOrEqual(95);
    const safeText = processToolContent(result.text, { secretScrub: true, injectionScan: false }).content;
    expect(safeText).not.toContain(token); expect(safeText).toContain('visible'); expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(10000); expect(f.consumed).toHaveLength(1);
  }, 20000);
  it('exports the same injected-port registered exec, exec_file and batch acceptance scenario', async () => {
    const h = await createHerdrHarness('fake'); harnesses.push(h); await h.start(); await acceptanceC(h);
  }, 30000);
});
