// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { createHerdrHarness } from './isolated.js';
import type { MachineName } from '../contracts.js';

const attachOptions = [
  ['--observe', '--history', '100'],
  ['--history', '100', '--observe'],
  ['--observe', '--history=100'],
  [],
];

test.each(attachOptions.map(options => ({ options })))('the shared fake resolves a remote attach after flags $options', async ({ options }) => {
  const h = await createHerdrHarness('fake');
  try {
    await h.start();
    const remote = await h.hc.run({ argv: [h.nodeBinary, '-e', 'console.log("remote output")'], on: 'remote.invalid' as MachineName, cwd: h.root, labels: {}, outliveParent: true, background: true, noNotify: true });
    expect(remote.address).toBe('remote.invalid/t1');
    await expect.poll(() => h.hc.get(remote.address)).toMatchObject({ state: 'finished' });
    const result = spawnSync(h.hcBinary, ['attach', ...options, 'remote.invalid/t1'], { env: h.localEnv, encoding: 'utf8', timeout: 5000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('remote output\n');
    expect(result.stderr).toBe('');
  } finally { await h.close(); }
  expect(await h.remainingOwnedResources()).toEqual([]);
});

test('the shared fake refuses an unknown remote attach with not_found', async () => {
  const h = await createHerdrHarness('fake');
  try {
    await h.start();
    const result = spawnSync(h.hcBinary, ['attach', '--observe', '--history', '100', 'remote.invalid/missing'], { env: h.localEnv, encoding: 'utf8', timeout: 5000 });
    expect(result.error).toBeUndefined();
    // The fake's streaming transport returns its structured refusal on the stream.
    expect(JSON.parse(result.stdout)).toMatchObject({ stderr: { error: { kind: 'not_found' } }, exitCode: 3 });
    expect(result.stdout).not.toContain('remote output');
  } finally { await h.close(); }
  expect(await h.remainingOwnedResources()).toEqual([]);
});
