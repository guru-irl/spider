// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { createHerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import * as transport from '../../../herdr/src/client/cli-transport.js';
import type { MachineName, TerminalAddress } from '../../../herdr/src/contracts.js';
import { installFastCoreTransport } from './herdr-setup-fast-core.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});

test('the fast core transport matches the CLI for replies, remote files and errors', async () => {
  const h = await createHerdrHarness('fake');
  let restore = () => {};
  try {
    await h.start();
    const machine = 'remote.invalid' as MachineName, path = join(h.directories.remote, 'transport-test');
    await h.hc.fileWrite(machine, path, Buffer.from('remote bytes\n'));
    const missing = () => h.hc.get('t-missing' as TerminalAddress).then(() => null, error => ({ code: error.code, message: error.message }));
    const limited = () => transport.invokeCli(h.hcBinary, ['machine', 'ls', '--json'], h.localEnv, 16).then(() => null, error => ({ code: error.code, message: error.message }));
    const expected = { identity: await h.hc.identity(), machines: await h.hc.machines(), bytes: await h.hc.fileRead(machine, path), error: await missing(), limit: await limited() };
    expect(expected.machines).toEqual([expect.objectContaining({ name: 'remote.invalid' })]);
    expect(expected.bytes).toEqual(Buffer.from('remote bytes\n'));
    expect(expected.error).toMatchObject({ code: 'not_found' });
    expect(expected.limit).toMatchObject({ code: 'reply-too-large' });
    const before = (await h.calls()).length;
    restore = installFastCoreTransport(h);
    expect(await h.hc.identity()).toEqual(expected.identity);
    expect(await h.hc.machines()).toEqual(expected.machines);
    expect(await h.hc.fileRead(machine, path)).toEqual(expected.bytes);
    expect(await missing()).toEqual(expected.error);
    expect(await limited()).toEqual(expected.limit);
    await h.hc.fileWrite(machine, path, Buffer.from('new remote bytes\n'));
    expect(await h.hc.fileRead(machine, path)).toEqual(Buffer.from('new remote bytes\n'));
    const observed: number[] = [];
    await transport.invokeCli(h.hcBinary, ['machine', 'ls', '--json'], h.localEnv, undefined, undefined,
      { processObserver: { started: pid => observed.push(pid), exited: pid => observed.push(pid) } });
    expect(observed).toHaveLength(2);
    expect(observed[0]).toBe(observed[1]);
    expect(observed[0]).not.toBe(process.pid);
    const calls = (await h.calls()).slice(before);
    expect(calls.some(call => 'pid' in call && call.pid === process.pid && call.argv[0] === 'machine')).toBe(true);
    expect(calls.some(call => 'pid' in call && call.pid === observed[0] && call.argv[0] === 'machine')).toBe(true);
  } finally {
    try { restore(); } finally { await h.close(); }
  }
  expect(await h.remainingOwnedResources()).toEqual([]);
});

test('the fast core transport can be installed before the isolated cores start', async () => {
  const h = await createHerdrHarness('fake');
  let restore = () => {};
  try {
    restore = installFastCoreTransport(h);
    await h.start();
    expect((await h.hc.machines()).map(machine => machine.name)).toContain('remote.invalid');
  } finally {
    try { await h.close(); } finally { restore(); }
  }
  expect(await h.remainingOwnedResources()).toEqual([]);
});
