// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { chmod, mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withRemoteCopy } from '../herdr/copy.js';
import { pruneSettledPrograms } from '../../../herdr/src/remote/runtime.js';
import type { RemoteExecutionPort } from '../../../herdr/src/contracts.js';
import { monitorFixture, on } from '../../../herdr/src/__tests__/herdr-monitor-fixture.js';

const require = createRequire(import.meta.url);

test.each(['to', 'from'] as const)('a verified copy %s remains successful if the cleanup launch fails', async direction => {
  const h = await monitorFixture(), root = join(h.f.root, 'runtime');
  await mkdir(root, { mode: 0o700 });
  const source = join(h.f.root, 'source'), destination = join(h.f.root, 'destination');
  await writeFile(source, Buffer.from([0, 255, 13, 10, 0])); await chmod(source, 0o751);
  let cleanups = 0;
  const remote: RemoteExecutionPort = { execute: async request => {
    if (request.source.kind !== 'code') throw new Error('Expected code');
    const code = request.source.code;
    if (code.startsWith("require('node:fs').rmSync")) {
      cleanups++;
      throw new Error('Cleanup launch release timed out');
    }
    let stdout = '';
    runInNewContext(code, { require, Buffer, console: { log: (text: string) => { stdout += text + '\n'; } } });
    return { stdout, stderr: '', outcome: 'exited', exitCode: 0, timedOut: false, remote: { jobId: 'copy-step' as never, machine: on, address: null } };
  } };
  h.hc.fileWrite = async (_on, path, bytes) => { await writeFile(path, bytes); };
  h.hc.fileRead = async (_on, path) => readFile(path);
  const copy = withRemoteCopy(remote, h.hc, () => [{ name: on, aliases: [], runtime: { cwd: null, directory: root, commands: {}, environment: {} } }], () => join(h.f.root, 'pending-copy-cleanup'));
  const result = await copy.copy!({ owner: h.owner, on, direction, local: direction === 'to' ? source : destination, remote: direction === 'to' ? destination : source });
  expect(result).toMatchObject({ direction, destination, bytes: 5, mode: 0o751, note: expect.stringMatching(/staging cleanup deferred/i) });
  expect(await readFile(destination)).toEqual(Buffer.from([0, 255, 13, 10, 0]));
  expect((await stat(destination)).mode & 0o777).toBe(0o751);
  expect(cleanups).toBe(1);
  const stages = (await readdir(root)).filter(name => /^\.copy-[a-f0-9]{32}$/.test(name));
  expect(stages).toHaveLength(1);
  const stage = join(root, stages[0]);
  expect(await readFile(`${stage}.spider-settled`, 'utf8')).toBe('settled');
  expect(await pruneSettledPrograms(root)).toEqual([]);
  const old = new Date(Date.now() - 120000);
  await utimes(`${stage}.spider-settled`, old, old); await utimes(stage, old, old);
  expect(await pruneSettledPrograms(root)).toEqual([stage]);
  expect((await readdir(root)).filter(name => name.startsWith('.copy-'))).toEqual([]);
});

test('an uncertain transfer never removes or marks a possibly active stage', async () => {
  const h = await monitorFixture(), root = join(h.f.root, 'runtime'), source = join(h.f.root, 'source');
  await mkdir(root, { mode: 0o700 }); await writeFile(source, 'payload');
  let cleanups = 0;
  const remote: RemoteExecutionPort = { execute: async request => {
    if (request.source.kind !== 'code') throw new Error('Expected code');
    const code = request.source.code;
    if (code.startsWith("require('node:fs').rmSync")) cleanups++;
    else if (code.includes('fs.openSync(dest')) return { stdout: '', stderr: '', outcome: 'unknown', exitCode: null, timedOut: false, remote: { jobId: 'uncertain' as never, machine: on, address: null } };
    runInNewContext(code, { require, Buffer, console });
    return { stdout: '', stderr: '', outcome: 'exited', exitCode: 0, timedOut: false, remote: { jobId: 'step' as never, machine: on, address: null } };
  } };
  h.hc.fileWrite = async (_on, path, bytes) => { await writeFile(path, bytes); };
  const copy = withRemoteCopy(remote, h.hc, () => [{ name: on, aliases: [], runtime: { cwd: null, directory: root, commands: {}, environment: {} } }], () => join(h.f.root, 'pending-copy-cleanup'));
  const pending = copy.copy!({ owner: h.owner, on, direction: 'to', local: source, remote: join(h.f.root, 'destination') });
  await expect(pending).rejects.toMatchObject({ code: 'remote-copy-uncertain' });
  await expect(pending).rejects.toThrow(/may still be running.*do not retry/i);
  expect(cleanups).toBe(0);
  const stages = (await readdir(root)).filter(name => /^\.copy-[a-f0-9]{32}$/.test(name)); expect(stages).toHaveLength(1);
  await expect(readFile(join(root, `${stages[0]}.spider-settled`))).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each(['execute', 'upload', 'download'] as const)('a lost %s reply retains staging and warns against retry', async step => {
  const h = await monitorFixture(), root = join(h.f.root, 'runtime'), source = join(h.f.root, 'source'), destination = join(h.f.root, 'destination');
  await mkdir(root, { mode: 0o700 }); await writeFile(source, 'payload');
  let cleanups = 0;
  const remote: RemoteExecutionPort = { execute: async request => {
    if (request.source.kind !== 'code') throw new Error('Expected code');
    const code = request.source.code;
    if (code.startsWith("require('node:fs').rmSync")) cleanups++;
    if (step === 'execute' && code.includes('fs.openSync(dest')) throw new Error('Execution acknowledgement lost');
    let stdout = '';
    runInNewContext(code, { require, Buffer, console: { log: (text: string) => { stdout += text + '\n'; } } });
    return { stdout, stderr: '', outcome: 'exited', exitCode: 0, timedOut: false, remote: { jobId: 'step' as never, machine: on, address: null } };
  } };
  h.hc.fileWrite = async (_on, path, bytes) => { if (step === 'upload' && path.includes('chunk-')) throw new Error('Upload acknowledgement lost'); await writeFile(path, bytes); };
  h.hc.fileRead = async (_on, path) => { if (step === 'download') throw new Error('Download acknowledgement lost'); return readFile(path); };
  const copy = withRemoteCopy(remote, h.hc, () => [{ name: on, aliases: [], runtime: { cwd: null, directory: root, commands: {}, environment: {} } }], () => join(h.f.root, 'pending-copy-cleanup'));
  const pending = copy.copy!({ owner: h.owner, on, direction: step === 'download' ? 'from' : 'to', local: step === 'download' ? destination : source, remote: step === 'download' ? source : destination });
  await expect(pending).rejects.toMatchObject({ code: 'remote-copy-uncertain' });
  await expect(pending).rejects.toThrow(/may still be running.*do not retry.*staging retained/i);
  expect(cleanups).toBe(0);
  const stages = (await readdir(root)).filter(name => /^\.copy-[a-f0-9]{32}$/.test(name)); expect(stages).toHaveLength(1);
  await expect(readFile(join(root, `${stages[0]}.spider-settled`))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('retries a failed staging marker after a fresh copy-port instance', async () => {
  const h = await monitorFixture(), root = join(h.f.root, 'runtime'), pending = join(h.f.root, 'pending-copy-cleanup');
  const source = join(h.f.root, 'source'), first = join(h.f.root, 'first'), second = join(h.f.root, 'second');
  await mkdir(root, { mode: 0o700 }); await writeFile(source, 'payload');
  let failCleanup = true, failMarker = true;
  const remote: RemoteExecutionPort = { execute: async request => {
    if (request.source.kind !== 'code') throw new Error('Expected code');
    const code = request.source.code;
    if (failCleanup && code.startsWith("require('node:fs').rmSync")) throw new Error('Cleanup transport failed');
    let stdout = '';
    runInNewContext(code, { require, Buffer, console: { log: (text: string) => { stdout += text + '\n'; } } });
    return { stdout, stderr: '', outcome: 'exited', exitCode: 0, timedOut: false, remote: { jobId: 'step' as never, machine: on, address: null } };
  } };
  h.hc.fileWrite = async (_on, path, bytes) => { if (path.endsWith('.spider-settled') && failMarker) { failMarker = false; throw new Error('Marker transport failed'); } await writeFile(path, bytes); };
  const machines = () => [{ name: on, aliases: [], runtime: { cwd: null, directory: root, commands: {}, environment: {} } }];
  const makeCopy = () => withRemoteCopy(remote, h.hc, machines, () => pending);
  const initial = await makeCopy().copy!({ owner: h.owner, on, direction: 'to', local: source, remote: first });
  expect(initial).toMatchObject({ note: expect.stringMatching(/staging cleanup deferred/i) });
  const stage = join(root, (await readdir(root)).find(name => /^\.copy-[a-f0-9]{32}$/.test(name))!);
  await expect(readFile(`${stage}.spider-settled`)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readdir(pending)).filter(name => name.endsWith('.json'))).toHaveLength(1);
  failCleanup = false;
  const next = await makeCopy().copy!({ owner: h.owner, on, direction: 'to', local: source, remote: second });
  expect(next).not.toHaveProperty('note');
  expect(await readFile(`${stage}.spider-settled`, 'utf8')).toBe('settled');
  expect((await readdir(pending)).filter(name => name.endsWith('.json'))).toEqual([]);
});
