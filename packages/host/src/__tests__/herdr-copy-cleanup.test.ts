// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withRemoteCopy } from '../herdr/copy.js';
import type { RemoteExecutionPort } from '../../../herdr/src/contracts.js';
import { monitorFixture, on } from '../../../herdr/src/__tests__/herdr-monitor-fixture.js';

const require = createRequire(import.meta.url);

test.each(['to', 'from'] as const)('a verified copy %s remains successful if the cleanup launch fails', async direction => {
  const h = await monitorFixture(), root = join(h.f.root, 'runtime');
  await mkdir(root);
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
  const copy = withRemoteCopy(remote, h.hc, () => [{ name: on, aliases: [], runtime: { cwd: null, directory: root, commands: {}, environment: {} } }]);
  const result = await copy.copy!({ owner: h.owner, on, direction, local: direction === 'to' ? source : destination, remote: direction === 'to' ? destination : source });
  expect(result).toMatchObject({ direction, destination, bytes: 5, mode: 0o751 });
  expect(await readFile(destination)).toEqual(Buffer.from([0, 255, 13, 10, 0]));
  expect((await stat(destination)).mode & 0o777).toBe(0o751);
  expect(cleanups).toBe(1);
  expect((await readdir(root)).filter(name => name.startsWith('.copy-'))).toHaveLength(1);
});
