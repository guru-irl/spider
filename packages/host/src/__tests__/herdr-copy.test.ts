// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterAll, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExec } from '../../../context/src/actions/exec.js';
import { withRemoteCopy } from '../herdr/copy.js';
import { installFixtureRuntime, mountedFixture } from './herdr-wiring-fixture.js';

let realFixture: Promise<Awaited<ReturnType<typeof mountedFixture>>> | undefined;
function installedFixture() {
  return realFixture ??= (async () => {
    const fixture = await mountedFixture('fake', 'tui', true, false, true, true);
    try { await installFixtureRuntime(fixture); return fixture; }
    catch (error) { await fixture.close(); throw error; }
  })();
}
afterAll(async () => {
  try { if (realFixture) await (await realFixture).close(); }
  finally { vi.unstubAllEnvs(); vi.restoreAllMocks(); }
});

it('copies a binary file larger than 10 MiB through an in-process transport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-copy-'));
  try {
    const remoteRoot = join(root, 'remote'); await mkdir(remoteRoot);
    const source = join(root, "source 'with spaces'.bin");
    const destination = join(remoteRoot, "destination 'with spaces'.bin");
    const roundtrip = join(root, "returned 'with spaces'.bin");
    const bytes = Buffer.alloc(10 * 1024 * 1024 + 19);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 193 + 17) & 255;
    await writeFile(source, bytes); await chmod(source, 0o751);
    const machine = { name: 'remote.invalid', aliases: ['managed.example.invalid'], runtime: { directory: remoteRoot, cwd: null, commands: {} } };
    const hc = {
      machines: async () => [{ name: machine.name, aliases: [], state: 'connected' }],
      fileRead: async (_on: string, path: string) => readFile(path),
      fileWrite: async (_on: string, path: string, data: Buffer) => writeFile(path, data),
    };
    const nodeRequire = createRequire(import.meta.url);
    const remote = { execute: async ({ source: program }: { source: { code: string } }) => {
      const output: string[] = [];
      new Function('require', 'console', program.code)(nodeRequire, { log: (value: string) => output.push(value) });
      return { outcome: 'exited', exitCode: 0, stdout: output.join('\n'), stderr: '', timedOut: false, remote: { jobId: 'copy-step' } };
    } };
    const copy = withRemoteCopy(remote as never, hc as never, () => [machine] as never, () => join(root, 'cleanup'));
    const ctx = { cwd: root, remote: copy, owner: {} as never };
    await expect(runExec({ on: 'MANAGED.EXAMPLE.INVALID', copy: { direction: 'to', local: source, remote: destination } }, ctx)).resolves.toMatchObject({ isError: false, details: { destination } });
    await expect(runExec({ on: 'remote.invalid', copy: { direction: 'from', local: roundtrip, remote: destination } }, ctx)).resolves.toMatchObject({ isError: false, details: { destination: roundtrip } });
    expect(createHash('sha256').update(await readFile(roundtrip)).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect((await stat(roundtrip)).mode & 0o777).toBe(0o751);
    expect((await stat(destination)).mode & 0o777).toBe(0o751);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('copies multiple chunks to a machine and back, preserving mode and paths', async () => {
  const f = await installedFixture();
  const source = join(f.h.directories.local, "source 'with spaces'.bin");
  const destination = join(f.h.directories.remote, "destination 'with spaces'.bin");
  const roundtrip = join(f.h.directories.local, "returned 'with spaces'.bin");
  try {
    const bytes = Buffer.alloc(384 * 1024 + 19);
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
  } finally { await Promise.all([source, destination, roundtrip].map(path => rm(path, { force: true }))); }
}, 180000);

it('refuses existing destination files in both directions without changing either file', async () => {
  const f = await installedFixture();
  const local = join(f.h.directories.local, 'existing-local');
  const remote = join(f.h.directories.remote, 'existing-remote');
  try {
    await writeFile(local, 'local-original'); await writeFile(remote, 'remote-original');
    const ctx = { cwd: f.ctx.cwd, ...f.mount.execution() };
    await expect(runExec({ on: 'remote.invalid', copy: { direction: 'to', local, remote } }, ctx)).rejects.toThrow();
    await expect(runExec({ on: 'remote.invalid', copy: { direction: 'from', local, remote } }, ctx)).rejects.toThrow();
    expect(await readFile(local, 'utf8')).toBe('local-original');
    expect(await readFile(remote, 'utf8')).toBe('remote-original');
    expect((await readdir(join(f.h.directories.remote, 'programs'))).filter(name => name.startsWith('.copy-'))).toEqual([]);
  } finally { await Promise.all([local, remote].map(path => rm(path, { force: true }))); }
}, 90000);

it('requires a remote destination for copy and never falls back to local execution', async () => {
  await expect(runExec({ action: 'exec', copy: { direction: 'to', local: '/source', remote: '/destination' } }, { cwd: process.cwd() })).rejects.toThrow(/on|destination/i);
});
