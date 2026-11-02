// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { executeRemote, createRemoteExecutor } from '../remote/execute.js';
import { runExec, runBatch, isExecError } from '../../../context/src/actions/exec.js';
import { processToolContent } from '../../../host/src/routing/safety.js';
import { createHerdrHarness, type HerdrHarness } from './testutil.js';
import { acceptanceC, createRemoteTestFixture } from './acceptance/c.js';
import { createExpiredRemoteFixture } from './herdr-expired-fixture.js';
import type { RemoteExecuteRequest, MachineName, JobHandle } from '../contracts.js';
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
