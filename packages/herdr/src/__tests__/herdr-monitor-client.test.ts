// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHcClient } from '../client/hc.js';
import { createClientFixture } from './testutil.js';
import { bounded, cleanup, deferred } from './herdr-monitor-fixture.js';

it('sequential remote file reads reuse validated machine discovery', async () => {
  const f = await createClientFixture(); cleanup(f.close);
  await f.configure({ machines: [{ id: 'remote-core', name: 'remote.invalid', host: 'remote.invalid', target: 'fixture.invalid', via: true, state: 'connected', session: 'r' }] });
  const client = createHcClient({ binary: f.hcBinary, env: f.localEnv }); cleanup(() => client.dispose());
  const on = 'remote.invalid' as never;
  await client.fileWrite(on, '/fixture/output', Buffer.from('output'));
  expect((await client.fileRead(on, '/fixture/output')).toString()).toBe('output');
  expect((await client.fileRead(on, '/fixture/output')).toString()).toBe('output');
  expect((await f.calls()).filter(call => call.argv[0] === 'machine')).toHaveLength(1);
});

it('a newly added machine is discoverable even while another machine validation is cached', async () => {
  const f = await createClientFixture(); cleanup(f.close);
  const first = { id: 'first-core', name: 'first.invalid', host: 'first.invalid', target: 'fixture.invalid', via: true, state: 'connected', session: 'r' };
  await f.configure({ machines: [first] });
  const client = createHcClient({ binary: f.hcBinary, env: f.localEnv }); cleanup(() => client.dispose());
  await client.fileWrite('first.invalid' as never, '/fixture/output', Buffer.from('first'));
  await f.configure({ machines: [first, { ...first, id: 'second-core', name: 'second.invalid', host: 'second.invalid' }] });
  await client.fileWrite('second.invalid' as never, '/fixture/output', Buffer.from('second'));
  expect((await client.fileRead('second.invalid' as never, '/fixture/output')).toString()).toBe('second');
  expect((await f.calls()).filter(call => call.argv[0] === 'machine')).toHaveLength(2);
});

it('a brief events reconnect stays pending until the replacement snapshot instead of showing an error', async () => {
  const f = await createClientFixture(); cleanup(f.close);
  const reconnect = deferred(); const timeout = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const timer = timeout(callback, ms, ...args);
    if (String(callback).includes('launch')) reconnect.resolve();
    return timer;
  }) as typeof setTimeout); cleanup(() => spy.mockRestore());
  const client = createHcClient({ binary: f.hcBinary, env: f.localEnv }); cleanup(() => client.dispose());
  const events = client.events(); await events.ready;
  const calls = (await readFile(join(f.root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { argv: string[]; pid: number });
  process.kill(calls.find(call => call.argv[0] === 'events')!.pid, 'SIGTERM');
  await bounded(reconnect.promise);
  await expect(bounded(events.ready, 1500)).resolves.toBeUndefined();
});

it('events watchdog and reconnect timers do not retain the process', async () => {
  const f = await createClientFixture(); cleanup(f.close);
  const reconnect = deferred(), watchdogs: ReturnType<typeof setInterval>[] = [], retries: ReturnType<typeof setTimeout>[] = [];
  const interval = globalThis.setInterval, timeout = globalThis.setTimeout;
  const intervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => { const timer = interval(callback, ms, ...args); if (ms === 1000) watchdogs.push(timer); return timer; }) as typeof setInterval);
  const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => { const timer = timeout(callback, ms, ...args); if (String(callback).includes('launch')) { retries.push(timer); reconnect.resolve(); } return timer; }) as typeof setTimeout);
  cleanup(() => { intervalSpy.mockRestore(); timeoutSpy.mockRestore(); });
  const client = createHcClient({ binary: f.hcBinary, env: f.localEnv }); cleanup(() => client.dispose());
  const events = client.events(); await events.ready;
  expect(watchdogs.length).toBeGreaterThan(0); expect(watchdogs.every(timer => !timer.hasRef())).toBe(true);
  const calls = (await readFile(join(f.root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { argv: string[]; pid: number });
  process.kill(calls.find(call => call.argv[0] === 'events')!.pid, 'SIGTERM'); await bounded(reconnect.promise);
  expect(retries.length).toBeGreaterThan(0); expect(retries.every(timer => !timer.hasRef())).toBe(true);
});
