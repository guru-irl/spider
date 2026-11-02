// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { runExec } from '../../../context/src/actions/exec.js';
import { toToolResult } from '../result.js';
import { installFixtureRuntime, mountedFixture } from './herdr-wiring-fixture.js';
import { createHerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import { createRemoteTestFixture } from '../../../herdr/src/__tests__/acceptance/c.js';
import { executeRemote } from '../../../herdr/src/remote/execute.js';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('keeps already gathered output instead of claiming there was none', () => {
  const result = toToolResult({ text: '', isError: true, details: { outcome: 'aborted', exitCode: 137, stdout: 'partial-out\n', stderr: 'partial-error\n' } });
  expect(result.content[0].text).toContain('partial-out');
  expect(result.content[0].text).toContain('partial-error');
  expect(result.content[0].text).not.toContain('no output');
});

it('bounds recovered output when a blank result contains a large exec payload', () => {
  const result = toToolResult({ text: '', isError: true, details: { outcome: 'aborted', exitCode: 137, stdout: 'x'.repeat(20000), stderr: '' } });
  expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(10000);
  expect(result.content[0].text).toMatch(/truncat/i);
});

it('retains stdout and stderr on a local abort', async () => {
  const controller = new AbortController(); let seen = '';
  const result = await runExec({ language: 'shell', code: 'printf local-out; printf local-err >&2; sleep 20' }, {
    cwd: process.cwd(), signal: controller.signal,
    onPartial: text => { seen = text; if (seen.includes('local-out') && seen.includes('local-err')) controller.abort(); },
  });
  expect(result.details).toMatchObject({ outcome: 'aborted', stdout: 'local-out' });
  expect(result.text).toContain('local-out');
  expect(result.text).toContain('local-err');
}, 30000);

it('retains output and reports an unknown process state if cancellation transport fails', async () => {
  const h = await createHerdrHarness('fake');
  const controller = new AbortController();
  try {
    await h.start();
    const fixture = await createRemoteTestFixture(h);
    const start = fixture.ports.jobs.start;
    fixture.ports.jobs.start = async (...args) => {
      const handle = await start(...args);
      handle.cancel = async () => { throw new Error('transport unavailable'); };
      return handle;
    };
    const result = await executeRemote({ owner: h.owner!, on: 'remote.invalid' as never, signal: controller.signal,
      source: { kind: 'code', language: 'javascript', code: "console.log('before-loss');setInterval(()=>{},1000)" },
      onData: text => { if (text.includes('before-loss')) controller.abort(); },
    }, fixture.ports);
    expect(result.stdout).toContain('before-loss');
    expect(result.remoteAbortInfo).toMatch(/state unknown.*may still be running/i);
    expect(result.remoteAbortInfo).toContain(result.remote.address);
    expect(fixture.detached).toContain(result.remote.jobId);
    await fixture.ports.jobs.dispose();
  } finally { controller.abort(); await h.close(); }
}, 60000);

it('returns gathered remote output and the cancellation state after an abort', async () => {
  const f = await mountedFixture('fake', 'tui', true, false, true, true);
  const controller = new AbortController(); let seen = ''; let abortedFromOutput = false;
  const guard = setTimeout(() => controller.abort(), 25000);
  try {
    await installFixtureRuntime(f);
    const execution = f.mount.execution();
    const result = await runExec({ on: 'remote.invalid', language: 'javascript', code: "process.stdout.write('remote-out\\n');process.stderr.write('remote-err\\n');setInterval(()=>{},1000)" }, {
      cwd: f.ctx.cwd, ...execution, signal: controller.signal,
      onPartial: text => { seen = text; if (seen.includes('remote-out') && seen.includes('remote-err')) { abortedFromOutput = true; controller.abort(); } },
    });
    expect(abortedFromOutput).toBe(true);
    expect(result.details).toMatchObject({ outcome: 'aborted', stdout: 'remote-out\n' });
    expect(result.text).toContain('remote-out');
    expect(result.text).toContain('remote-err');
    expect(result.text).toMatch(/remote process.*(killed|running|unknown)/i);
    expect(result.text).toContain(result.details.remote.address);
  } finally { clearTimeout(guard); controller.abort(); await f.close(); }
}, 90000);
