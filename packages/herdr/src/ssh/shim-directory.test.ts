// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { join, resolve } from 'node:path';
import * as shim from './shim.js';
import { createMachineCache } from './cache.js';

test('sessions on different cores use distinct shim directories keyed like their caches', async () => {
  const directory = resolve('.spider/scratch/shim-api/cache');
  const identities = [
    { coreId: 'first-core' as never, sessionNamespace: 'first', socket: join(directory, 'first.sock') },
    { coreId: 'second-core' as never, sessionNamespace: 'second', socket: join(directory, 'second.sock') },
  ];
  // No disk writes: this test needs the authoritative cache key, not a live inventory.
  const caches = identities.map(identity => createMachineCache({ directory, identity, hc: {
    identity: async () => { throw new Error('No test core'); }, machines: async () => [],
  } }));
  try {
    await Promise.all(caches.map(cache => cache.ready));
    const paths = caches.map(cache => shim.sshShimDirectory(cache.descriptor));
    expect(paths[0]).not.toBe(paths[1]);
    paths.forEach((path, i) => {
      expect(path.startsWith(join(directory, 'bin') + '/')).toBe(true);
      expect(caches[i].descriptor.path).toBe(join(directory, path.split('/').at(-1)! + '.json'));
    });
  } finally { await Promise.all(caches.map(cache => cache.dispose())); }
});
