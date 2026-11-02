// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { createSshPolicyReader } from '../ssh/policy.js';

const policy = createSshPolicyReader(async () => ({ version: 1,
  identity: { coreId: 'isolated' as never, sessionNamespace: 'isolated', socket: '/isolated.invalid.sock' },
  fetchedAt: Date.now(), machines: [{ id: 'managed-core', name: 'managed.invalid', targets: ['managed.invalid'] }],
}));

test.each([
  ['-W', 'MANAGED.invalid:22', 'unmanaged.invalid'],
  ['-WMANAGED.invalid:22', 'unmanaged.invalid'],
  ['-o', 'ProxyCommand=ssh -W managed.invalid:22 gateway.invalid', 'unmanaged.invalid'],
])('routes forwarding destinations through the managed-machine policy: %j', async (...argv) => {
  expect(await policy.checkArgv(argv)).toMatchObject({ kind: 'refuse', machine: 'managed.invalid' });
  expect(await policy.checkArgv(argv.map(arg => arg.replace(/managed\.invalid/gi, 'other.invalid')))).toEqual({ kind: 'allow' });
});

test('absolute-path SSH cannot hide a managed stream destination', async () => {
  expect(await policy.checkShell('/usr/bin/ssh -W managed.invalid:22 unmanaged.invalid')).toMatchObject({ kind: 'refuse', machine: 'managed.invalid' });
  expect(await policy.checkShell('/usr/bin/ssh -W other.invalid:22 unmanaged.invalid')).toEqual({ kind: 'allow' });
});

test('an unclassifiable forward target refuses without masking a known managed destination', async () => {
  expect(await policy.checkArgv(['-W', '%h:%p', 'unmanaged.invalid'])).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('cannot be classified') });
  expect(await policy.checkArgv(['-W', '%h:%p', 'managed.invalid'])).toMatchObject({ kind: 'refuse', machine: 'managed.invalid' });
});
