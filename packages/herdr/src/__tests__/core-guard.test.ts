// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHcClient, invokeCli } from '../client/hc.js';
import { runRemoteObserver } from '../jobs/observer.js';
import type { HcClient, MachineName } from '../contracts.js';
import { createClientFixture, type ClientFixture } from './testutil.js';

const fixtures: ClientFixture[] = [];
const clients: ReturnType<typeof createHcClient>[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.dispose();
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
const remote = 'remote.invalid' as MachineName;
const operations: [string, (client: HcClient, h: ClientFixture) => Promise<unknown>][] = [
  ['identity', client => client.identity()],
  ['caller', (client, h) => client.caller(h.localEnv)],
  ['get', (client, h) => client.get(h.address('t1'))],
  ['read', (client, h) => client.read(h.address('t1'), { lines: 10 })],
  ['machines', client => client.machines()],
  ['run', client => client.run({ argv: ['echo', 'no'], cwd: null, labels: {}, parent: null, outliveParent: false, background: true, noNotify: true })],
  ['remote run', client => client.run({ argv: ['echo', 'no'], cwd: null, labels: {}, on: remote, outliveParent: false, background: true, noNotify: true })],
  ['kill', (client, h) => client.kill(h.address('t1'))],
  ['rm', (client, h) => client.rm(h.address('t1'))],
  ['setLabels', (client, h) => client.setLabels(h.address('t1'), { 'herdr.space': 'work' })],
  ['fileRead', client => client.fileRead(remote, '/data')],
  ['fileWrite', client => client.fileWrite(remote, '/data', Buffer.from('no'))],
];
test.each(operations)('a missing socket prevents %s from spawning hc', async (_name, operation) => {
  const h = await createClientFixture(); fixtures.push(h);
  const env = { ...h.localEnv, HC_TERMINAL_SOCKET: h.foreignSocket, HC_SOCKET: h.foreignSocket };
  const client = createHcClient({ binary: h.hcBinary, env }); clients.push(client);
  await expect(operation(client, h)).rejects.toMatchObject({ code: 'core-unavailable', name: 'HerdrError' });
  expect(await h.calls()).toEqual([]);
});
test('the raw hc CLI entry also refuses a non-listening socket before spawning', async () => {
  const h = await createClientFixture(); fixtures.push(h);
  await writeFile(h.foreignSocket, 'not a listener');
  await expect(invokeCli(h.hcBinary, ['server', 'status', '--json'], { ...h.localEnv, HC_TERMINAL_SOCKET: h.foreignSocket, HC_SOCKET: h.foreignSocket })).rejects.toMatchObject({ code: 'core-unavailable' });
  expect(await h.calls()).toEqual([]);
});
test('an observer refuses a dead local core before spawning attach', async () => {
  const h = await createClientFixture(); fixtures.push(h);
  const exitFile = join(h.root, 'exit.json'); await writeFile(exitFile, JSON.stringify({ version: 1, nonce: 'gate' }));
  await expect(runRemoteObserver({ hcBinary: h.hcBinary, address: h.address('remote.invalid/t1'), nonce: 'gate', exitFile, env: { ...h.localEnv, HC_TERMINAL_SOCKET: h.foreignSocket, HC_SOCKET: h.foreignSocket } })).rejects.toMatchObject({ code: 'core-unavailable' });
  expect(await h.calls()).toEqual([]);
});
test('events with no core remain unspawned through reconnect polls and disposal', async () => {
  const h = await createClientFixture(); fixtures.push(h);
  const client = createHcClient({ binary: h.hcBinary, env: { ...h.localEnv, HC_TERMINAL_SOCKET: join(h.root, 'absent.sock'), HC_SOCKET: join(h.root, 'absent.sock') } }); clients.push(client);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let scheduled!: () => void;
  const nextReconnect = () => new Promise<void>(resolve => { scheduled = resolve; });
  const original = globalThis.setTimeout;
  const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    const timer = original(callback, ms, ...args);
    if (ms === 2000) scheduled();
    return timer;
  }) as typeof setTimeout);
  try {
    const first = nextReconnect();
    const stream = client.events();
    await expect(stream.ready).rejects.toMatchObject({ code: 'core-unavailable' });
    await first;
    for (let i = 0; i < 2; i++) {
      const next = nextReconnect();
      await vi.advanceTimersByTimeAsync(2000);
      await next;
    }
    expect(await h.calls()).toEqual([]);
    await client.dispose();
    await vi.advanceTimersByTimeAsync(2100);
    expect(await h.calls()).toEqual([]);
  } finally { timers.mockRestore(); vi.useRealTimers(); }
}, 10000);
