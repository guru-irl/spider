// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import type { HcClient, RemoteCopyRequest, RemoteExecutionPort } from '@spider/herdr';
import { withRemoteCopy } from '../herdr/copy.js';

let root: string, privateFile: string;
beforeEach(async () => {
  await mkdir(resolve('.spider/scratch/h'), { recursive: true });
  root = await mkdtemp(resolve('.spider/scratch/h/lcopy-'));
  const directory = join(root, 'agent', 'spider', 'herdr', 'launch-environments');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  privateFile = join(directory, 'terminal.json');
  await writeFile(privateFile, JSON.stringify({ API_TOKEN: 'ghp' + '_' + 'synthetic'.padEnd(39, '0') }), { mode: 0o600 });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function copy() {
  const hc = { machines: async () => [] } as unknown as HcClient;
  return withRemoteCopy({} as RemoteExecutionPort, hc, () => [], () => join(root, 'cleanup')).copy!;
}
function request(direction: 'to' | 'from', source: string): RemoteCopyRequest {
  return { direction, local: direction === 'to' ? source : join(root, 'download.json'), remote: direction === 'from' ? source : '/destination.json', on: 'remote.invalid' } as RemoteCopyRequest;
}
it('refuses uploading a private launch record before contacting a machine', async () => {
  await expect(copy()(request('to', privateFile))).rejects.toMatchObject({ code: 'private-launch-copy' });
});
it('refuses a private launch record reached through a symlinked parent', async () => {
  const alias = join(root, 'alias'); await symlink(join(root, 'agent', 'spider'), alias);
  await expect(copy()(request('to', join(alias, 'herdr', 'launch-environments', 'terminal.json')))).rejects.toMatchObject({ code: 'private-launch-copy' });
});
it('refuses downloading a private launch record by its remote path', async () => {
  await expect(copy()(request('from', '/agent/spider/herdr/launch-environments/terminal.json'))).rejects.toMatchObject({ code: 'private-launch-copy' });
});
it('the remote reader refuses an aliased private record before staging its bytes', async () => {
  const alias = join(root, 'remote-alias'); await symlink(join(root, 'agent', 'spider'), alias);
  const source = join(alias, 'herdr', 'launch-environments', 'terminal.json');
  const stagedRoot = join(root, 'remote-stage'); await mkdir(stagedRoot);
  const remote = { execute: async (value: { source: { code: string } }) => {
    const output: string[] = [];
    try {
      runInNewContext(value.source.code, { require: createRequire(import.meta.url), Buffer, console: { log: (message: string) => output.push(message) } });
      return { outcome: 'exited', exitCode: 0, stdout: output.join('\n'), stderr: '', remote: { jobId: 'fixture' } };
    } catch (error) { return { outcome: 'exited', exitCode: 1, stdout: '', stderr: String(error), remote: { jobId: 'fixture' } }; }
  } } as unknown as RemoteExecutionPort;
  const hc = { machines: async () => [], fileRead: async (_on: string, path: string) => readFile(path) } as unknown as HcClient;
  const configured = [{ name: 'remote.invalid', aliases: [], runtime: { directory: stagedRoot } }] as unknown as import('@spider/herdr').HerdrConfig['machines'];
  const runtime = withRemoteCopy(remote, hc, () => configured, () => join(root, 'cleanup'));
  await expect(runtime.copy!(request('from', source))).rejects.toThrow('Private launch records never leave their machine');
  await expect(readFile(join(root, 'download.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not classify ordinary source files as private launch data', async () => {
  const ordinary = join(root, 'ordinary.json'); await writeFile(ordinary, '{}');
  await expect(copy()(request('to', ordinary))).rejects.toMatchObject({ code: 'machine-unconfigured' });
});
