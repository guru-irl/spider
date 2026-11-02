// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runExec } from '../../../context/src/actions/exec.js';
import { installFixtureRuntime, mountedFixture } from './herdr-wiring-fixture.js';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('copies a binary file larger than 10 MiB to a machine and back, preserving mode and paths', async () => {
  const f = await mountedFixture('fake', 'tui', true, false, true, true);
  try {
    await installFixtureRuntime(f);
    const source = join(f.h.directories.local, "source 'with spaces'.bin");
    const destination = join(f.h.directories.remote, "destination 'with spaces'.bin");
    const roundtrip = join(f.h.directories.local, "returned 'with spaces'.bin");
    const bytes = Buffer.alloc(10 * 1024 * 1024 + 19);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 193 + 17) & 255;
    await writeFile(source, bytes); await chmod(source, 0o751);
    const ctx = { cwd: f.ctx.cwd, ...f.mount.execution() };
    await expect(runExec({ action: 'exec', on: 'MANAGED.EXAMPLE.INVALID', copy: { direction: 'to', local: source, remote: destination } }, ctx)).resolves.toMatchObject({ isError: false, details: { destination } });
    const download = await runExec({ action: 'exec', on: 'remote.invalid', copy: { direction: 'from', local: roundtrip, remote: destination } }, ctx);
    expect(download).toMatchObject({ isError: false, details: { destination: roundtrip } });
    const actual = await readFile(roundtrip);
    expect(createHash('sha256').update(actual).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect((await stat(roundtrip)).mode & 0o777).toBe(0o751);
    expect((await stat(destination)).mode & 0o777).toBe(0o751);
  } finally { await f.close(); }
}, 180000);

it('refuses existing destination files in both directions without changing either file', async () => {
  const f = await mountedFixture('fake', 'tui', true, false, true, true);
  try {
    await installFixtureRuntime(f);
    const local = join(f.h.directories.local, 'existing-local');
    const remote = join(f.h.directories.remote, 'existing-remote');
    await writeFile(local, 'local-original'); await writeFile(remote, 'remote-original');
    const ctx = { cwd: f.ctx.cwd, ...f.mount.execution() };
    await expect(runExec({ on: 'remote.invalid', copy: { direction: 'to', local, remote } }, ctx)).rejects.toThrow();
    await expect(runExec({ on: 'remote.invalid', copy: { direction: 'from', local, remote } }, ctx)).rejects.toThrow();
    expect(await readFile(local, 'utf8')).toBe('local-original');
    expect(await readFile(remote, 'utf8')).toBe('remote-original');
    expect((await readdir(join(f.h.directories.remote, 'programs'))).filter(name => name.startsWith('.copy-'))).toEqual([]);
  } finally { await f.close(); }
}, 90000);

it('requires a remote destination for copy and never falls back to local execution', async () => {
  await expect(runExec({ action: 'exec', copy: { direction: 'to', local: '/source', remote: '/destination' } }, { cwd: process.cwd() })).rejects.toThrow(/on|destination/i);
});
