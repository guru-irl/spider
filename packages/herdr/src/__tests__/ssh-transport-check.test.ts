// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { createSshPolicyReader } from '../ssh/policy.js';
import { createTransportPolicy } from '../ssh/admin.js';

const policy = () => createSshPolicyReader(async () => ({
  version: 1,
  identity: { coreId: 'isolated' as never, socket: '/isolated.invalid/socket', sessionNamespace: 'test' },
  fetchedAt: Date.now(), machines: [{ id: 'box', name: 'Box.invalid' as never, targets: ['Box.invalid', 'MyBox.invalid'] }],
}));

test.each([
  'ssh MYBOX.INVALID uname', 'scp file MYBOX.INVALID:/x', 'sftp mybox.invalid',
  'rsync -a file MyBox.invalid:/x', 'git clone git@MYBOX.INVALID:repo.git',
  'sh -c "scp file MyBox.invalid:/x"',
])('one shared transport policy refuses mixed-case child snapshot targets: %s', async code => {
  expect(await createTransportPolicy(policy(), () => ({})).checkShell(code)).toMatchObject({ kind: 'refuse', machine: 'Box.invalid' });
});

test.each(['ssh', 'ssh -i /key.invalid', 'ssh -p 2222 -o IdentityAgent=/agent.invalid'])('plain inherited GIT_SSH_COMMAND=%s leaves unknown destinations to the runtime shim', async override => {
  const routing = createTransportPolicy(policy(), () => ({ GIT_SSH_COMMAND: override }));
  for (const code of ['git fetch', 'git push origin', 'git ls-remote origin', 'git clone https://public.invalid/r']) {
    expect(await routing.checkShell(code)).toEqual({ kind: 'allow' });
  }
});
test('an absolute SSH override cannot bypass the shim when Git has no explicit endpoint', async () => {
  expect(await createTransportPolicy(policy(), () => ({ GIT_SSH_COMMAND: '/usr/bin/ssh' })).checkShell('git fetch'))
    .toMatchObject({ kind: 'refuse' });
});
