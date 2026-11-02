// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, open, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { installSshShim } from './shim.js';

test.each(['darwin', 'win32'] as const)('reinstall leaves an already-open %s shim intact', async platform => {
  const root = await mkdtemp(resolve('.spider/scratch/shim-atomic-'));
  const ssh = join(root, 'real-ssh');
  await writeFile(ssh, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const options = { platform, platformCheck: () => ({ ok: true }), shimDirectory: join(root, 'bin'), realSshBinary: ssh,
    shimProgram: join(root, 'first.mjs'), cacheDescriptor: { path: join(root, 'cache.json'), identity: { coreId: 'isolated' as never, sessionNamespace: 'isolated', socket: join(root, 'core.sock') } } };
  let reader;
  try {
    await mkdir(options.shimDirectory);
    await installSshShim(options);
    reader = await open(join(options.shimDirectory, platform === 'win32' ? 'ssh.cmd' : 'ssh'));
    const before = await reader.readFile('utf8');
    await installSshShim({ ...options, shimProgram: join(root, 'second.mjs') });
    const buffer = Buffer.alloc(Buffer.byteLength(before));
    await reader.read(buffer, 0, buffer.length, 0);
    expect(buffer.toString()).toBe(before);
  } finally { await reader?.close(); await rm(root, { recursive: true, force: true }); }
});
