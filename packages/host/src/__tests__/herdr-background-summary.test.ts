// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installFixtureRuntime, mountedFixture } from './herdr-wiring-fixture.js';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('delivers the last scrubbed output from a detached remote job with its real exit and log paths', async () => {
  const f = await mountedFixture('fake', 'tui', true, false, true, true);
  try {
    await installFixtureRuntime(f);
    const execution = f.mount.execution();
    const token = 'ghp_' + 'A'.repeat(36);
    const code = `setTimeout(() => { for (let i=0;i<20;i++) console.log('line-'+i); console.log('token ${token}'); console.error('last-error'); process.exitCode=23; }, 1200)`;
    const detached = await execution.remote!.execute({ owner: execution.owner!, on: 'remote.invalid' as never,
      source: { kind: 'code', language: 'javascript', code }, background: true, timeout: 50 });
    expect(detached).toMatchObject({ outcome: 'timeout', exitCode: null });
    let notice: { content: string; details: { exitCode: number; localDirectory: string } } | undefined;
    await vi.waitFor(() => {
      notice = f.notices.find(value => typeof value === 'object' && value !== null && 'customType' in value && value.customType === 'spider.job_done') as typeof notice;
      expect(notice).toBeDefined();
    }, { timeout: 60000, interval: 100 });
    expect(notice!.details.exitCode).toBe(23);
    expect(notice!.content).toContain('line-19');
    expect(notice!.content).toContain('last-error');
    expect(notice!.content).not.toContain('line-0\n');
    expect(notice!.content).not.toContain(token);
    expect(Buffer.byteLength(notice!.content)).toBeLessThan(3500);
    expect(notice!.content).toContain(notice!.details.localDirectory);
    expect(await readFile(join(notice!.details.localDirectory, 'stdout.log'), 'utf8')).toContain(token);
    expect(await readFile(join(notice!.details.localDirectory, 'stderr.log'), 'utf8')).toContain('last-error');
  } finally { await f.close(); }
}, 120000);

it('reconstructs the output summary after reload when a long-lived job dies by signal', async () => {
  const f = await mountedFixture('fake', 'tui', true, false, true, true);
  try {
    await installFixtureRuntime(f);
    const execution = f.mount.execution(), release = join(f.h.directories.remote, 'release-job');
    const code = `const fs=require('node:fs'); console.log('before-reload'); const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t);console.log('after-reload');console.error('signal-error');process.kill(process.pid,'SIGTERM')}},100)`;
    const detached = await execution.remote!.execute({ owner: execution.owner!, on: 'remote.invalid' as never,
      source: { kind: 'code', language: 'javascript', code }, background: true, timeout: 50 });
    expect(detached.outcome).toBe('timeout');
    await f.emit('session_shutdown', { reason: 'reload' });
    await f.emit('session_start', { reason: 'reload' });
    await f.h.hc.fileWrite('remote.invalid' as never, release, Buffer.from('release'));
    let notice: { content: string; details: { exitCode: number | null; reason: string } } | undefined;
    await vi.waitFor(() => {
      notice = f.notices.find(value => typeof value === 'object' && value !== null && 'customType' in value && value.customType === 'spider.job_done') as typeof notice;
      expect(notice).toBeDefined();
    }, { timeout: 60000, interval: 100 });
    expect(notice!.details).toMatchObject({ exitCode: null, reason: 'signal' });
    expect(notice!.content).toContain('before-reload');
    expect(notice!.content).toContain('after-reload');
    expect(notice!.content).toContain('signal-error');
  } finally { await f.close(); }
}, 120000);
