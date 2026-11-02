// SPDX-License-Identifier: MIT
import { expect, test, vi } from 'vitest';
import type { HcClient, HerdrConfig, MachineName } from '@spider/herdr';
import { createRemoteFileResolver } from '../herdr/remote-file.js';

const on = 'remote.invalid' as MachineName;
const machines = [{ name: on, aliases: [], nodePath: 'node', runtime: { cwd: null, directory: '/programs', commands: {} } }] as HerdrConfig['machines'];

test('a failed home probe is retried across reload and concurrent callers share the retry', async () => {
  let finish!: () => void;
  const ready = new Promise<void>(resolve => { finish = resolve; });
  const run = vi.fn().mockRejectedValueOnce(new Error('machine disconnected')).mockImplementation(async () => {
    await ready;
    return { address: 'probe@remote.invalid' };
  });
  const hc = { run, get: async () => ({ state: 'finished', exitCode: 0 }), read: async () => '"/home/agent"', kill: async () => {}, rm: async () => {} } as unknown as HcClient;
  const session = { manager: {}, id: 'home-session' };
  const first = createRemoteFileResolver(hc, machines, session);
  await expect(first.resolve('script.sh', on)).rejects.toThrow('machine disconnected');
  const reloaded = createRemoteFileResolver(hc, machines, session);
  const paths = [reloaded.resolve('script.sh', on), reloaded.resolve('other.sh', on)];
  finish();
  await expect(Promise.all(paths)).resolves.toEqual(['/home/agent/script.sh', '/home/agent/other.sh']);
  expect(run).toHaveBeenCalledTimes(2);
  await expect(reloaded.resolve('cached.sh', on)).resolves.toBe('/home/agent/cached.sh');
  expect(run).toHaveBeenCalledTimes(2);
});

test('concurrent first callers share one pending home probe', async () => {
  let finish!: () => void;
  const ready = new Promise<void>(resolve => { finish = resolve; });
  const run = vi.fn(async () => { await ready; return { address: 'probe@remote.invalid' }; });
  const hc = { run, get: async () => ({ state: 'finished', exitCode: 0 }), read: async () => '"/home/agent"', kill: async () => {}, rm: async () => {} } as unknown as HcClient;
  const resolver = createRemoteFileResolver(hc, machines, { manager: {}, id: 'concurrent-session' });
  const paths = [resolver.resolve('one.sh', on), resolver.resolve('two.sh', on)];
  expect(run).toHaveBeenCalledTimes(1);
  finish();
  await expect(Promise.all(paths)).resolves.toEqual(['/home/agent/one.sh', '/home/agent/two.sh']);
});
