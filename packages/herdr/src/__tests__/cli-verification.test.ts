// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { HerdrError } from '../client/parse.js';
import { runHerdrCli } from '../setup/cli.js';
import { invokeCli } from '../client/cli-transport.js';

async function fail(command: string, error: unknown) {
  let stdout = '', stderr = '';
  const code = await runHerdrCli([command], {
    request: async () => { throw error; },
    setupParts: async () => { throw new Error('Unreachable setup composition'); },
    doctorParts: async () => { throw new Error('Unreachable doctor composition'); },
    stdout: text => { stdout += text; },
    stderr: text => { stderr += text; },
  });
  return { code, stdout, stderr };
}

test.each(['setup', 'rollback'])('%s prints native transport stderr rather than only its exit status', async command => {
  const native = await invokeCli(process.execPath, ['-e', 'process.stdout.write("not diagnostics"); process.stderr.write("Cannot connect to app socket: no window is running\\n"); process.exit(2);'], process.env).catch(error => error);
  expect(native).toBeInstanceOf(HerdrError);
  expect(await fail(command, native)).toEqual({ code: 1, stdout: '', stderr: 'cli-exit: CLI exited with 2\nCannot connect to app socket: no window is running\n' });
});

test.each([null, {}, { stderr: null }, { stderr: 2 }, { stderr: '  \n' }])('malformed or empty native details preserve the original error: %j', async details => {
  expect(await fail('setup', new HerdrError('cli-exit', 'CLI exited with 2', details)))
    .toEqual({ code: 1, stdout: '', stderr: 'cli-exit: CLI exited with 2\n' });
});

// Omitting the structured failures hides the failed check and its repair from the user.
test.each(['setup', 'rollback'])('%s prints every verification failure and retains the rollback command', async command => {
  const result = await fail(command, new HerdrError('setup-verification-failed',
    'Setup failed verification\nRollback: node cli.mjs rollback', { failures: [
      { item: 'feed-freshness', code: 'feed-stale', message: 'Owner feed is stale', repair: 'Reload the live owner.' },
      { item: 'roles', code: 'role-unresolved', message: 'Worker model is unavailable', repair: 'Choose an available worker model.' },
    ] }));
  expect(result).toEqual({ code: 1, stdout: '', stderr:
    'setup-verification-failed: Setup failed verification\nRollback: node cli.mjs rollback\n' +
    '[feed-freshness] feed-stale: Owner feed is stale\nRepair: Reload the live owner.\n' +
    '[roles] role-unresolved: Worker model is unavailable\nRepair: Choose an available worker model.\n' });
});

test.each(['setup', 'rollback'])('%s keeps ordinary errors and their exit code unchanged', async command => {
  expect(await fail(command, new HerdrError('setup-composition-unavailable', 'Installer unavailable')))
    .toEqual({ code: 2, stdout: '', stderr: 'setup-composition-unavailable: Installer unavailable\n' });
});

test.each([null, { failures: 'unavailable' }, { failures: [null, { code: 'incomplete' }] }])(
  'malformed verification details do not hide the original error: %j', async details => {
    expect(await fail('setup', new HerdrError('setup-verification-failed', 'Verification failed', details)))
      .toEqual({ code: 1, stdout: '', stderr: 'setup-verification-failed: Verification failed\n' });
  });

test('valid failures remain visible when another detail is malformed', async () => {
  const result = await fail('rollback', new HerdrError('setup-verification-failed', 'Verification failed', {
    failures: [null, { item: 'ipc-authentication', code: 'ipc-unavailable', message: 'No endpoint', repair: 'Reload the owner.' }, { item: 'incomplete' }],
  }));
  expect(result).toEqual({ code: 1, stdout: '', stderr: 'setup-verification-failed: Verification failed\n' +
    '[ipc-authentication] ipc-unavailable: No endpoint\nRepair: Reload the owner.\n' });
});
