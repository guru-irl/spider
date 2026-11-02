// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHerdrHarness } from './testutil.js';
import { isCoreAvailable } from '../client/liveness.js';

it('waits for a listening fake core rather than the presence of its socket inode', async () => {
  const h = await createHerdrHarness('fake');
  // Model the bind-before-listen window with a real, non-listening Unix socket.
  await mkdir(dirname(h.remoteSocket), { recursive: true });
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(h.remoteSocket, resolve); });
  const parked = h.remoteSocket + '.bound';
  await rename(h.remoteSocket, parked);
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rename(parked, h.remoteSocket);
  expect(existsSync(h.remoteSocket)).toBe(true);
  expect(await isCoreAvailable(h.remoteEnv)).toBe(false);
  let release: ReturnType<typeof setTimeout> | undefined;
  try {
    const starting = h.start().then(() => undefined, error => error);
    // Observe the actual start command, then release the simulated bind window.
    await expect.poll(async () => (await h.calls('remote')).some(call => call.argv[0] === 'server' && call.argv[1] === 'start')).toBe(true);
    release = setTimeout(() => { void unlink(h.remoteSocket); }, 200);
    expect(await starting).toBeUndefined();
    expect(await isCoreAvailable(h.remoteEnv)).toBe(true);
    expect(await h.remoteHc.identity()).toMatchObject({ coreId: h.remoteCoreId });
  } finally {
    clearTimeout(release);
    if (!await isCoreAvailable(h.remoteEnv)) await unlink(h.remoteSocket).catch(() => {});
    await h.close();
    expect(await h.remainingOwnedResources()).toEqual([]);
  }
}, 15000);

