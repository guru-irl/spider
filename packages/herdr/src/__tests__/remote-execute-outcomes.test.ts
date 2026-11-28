// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { executeRemote } from '../remote/execute.js';
import { runExec, runBatch, isExecError } from '../../../context/src/actions/exec.js';
import { processToolContent } from '../../../host/src/routing/safety.js';
import { acceptanceC } from './acceptance/c.js';
import { createExpiredRemoteFixture } from './herdr-expired-fixture.js';
import { fixture, createOwnedRemoteHarness } from './remote-execute-fixture.js';
import type { RemoteExecuteRequest, MachineName, JobHandle } from '../contracts.js';

describe('remote result adapter', () => {
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
    // Stamp each preview when it arrives, before the scrub. On a loaded runner one scrub can take several
    // milliseconds longer than the next, and a stamp taken after it shrinks the gap the throttle left.
    const result = await runExec({ on: 'remote.invalid', language: 'javascript', code: `console.log(${JSON.stringify(token)});let n=0;const t=setInterval(()=>{console.log('visible '+n+' '+ 'x'.repeat(3000));if(++n===8)clearInterval(t)},120)` }, { ...ctx, onPartial: text => { const at = Date.now(); previews.push({ text: processToolContent(text, { secretScrub: true, injectionScan: false }).content, at }); } });
    expect(previews.length).toBeGreaterThan(1);
    for (const preview of previews) { expect(Buffer.byteLength(preview.text)).toBeLessThanOrEqual(10000); expect(preview.text).not.toContain(token); expect(preview.text).not.toContain('SPIDER_HERDR_READY'); }
    for (let i = 1; i < previews.length - 1; i++) expect(previews[i].at - previews[i - 1].at).toBeGreaterThanOrEqual(95);
    const safeText = processToolContent(result.text, { secretScrub: true, injectionScan: false }).content;
    expect(safeText).not.toContain(token); expect(safeText).toContain('visible'); expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(10000); expect(f.consumed).toHaveLength(1);
  }, 20000);
  it('exports the same injected-port registered exec, exec_file and batch acceptance scenario', async () => {
    const h = await createOwnedRemoteHarness(); await acceptanceC(h);
  }, 30000);
});
