// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import { HerdrError } from '../client/parse.js';
import { isCleanupConnectivityFailure } from '../jobs/cleanup.js';

it.each([
  new HerdrError('unavailable', 'Destination unavailable'),
  new HerdrError('unreachable', 'Destination unreachable'),
  new HerdrError('cli-timeout', 'Transport timed out'),
  new HerdrError('cleanup-timeout', 'Cleanup call timed out'),
  new HerdrError('core-unavailable', 'Local core is down'),
  new HerdrError('cli-exit', 'CLI exited', { stderr: 'connection reset' }),
  new HerdrError('cli-exit', 'CLI exited', { stderr: 'ssh: no route to host' }),
  new HerdrError('cli-exit', 'CLI exited', { stderr: 'remote host connection timed out' }),
  new HerdrError('machine-unavailable', 'Destination disconnected', { reason: 'disconnected' }),
])('preserves the budget for a connectivity failure: $code', error => {
  expect(isCleanupConnectivityFailure(error)).toBe(true);
});

it.each([
  new HerdrError('machine-unavailable', 'Unqualified address', { reason: 'invalid-address' }),
  new HerdrError('machine-unavailable', 'Wrong destination', { reason: 'unverified' }),
  new HerdrError('caller-mismatch', 'Wrong identity while offline'),
  new HerdrError('unavailable', 'Authentication failed while offline'),
  new HerdrError('unavailable', 'Destination unavailable', { hint: 'Authentication failed' }),
  new HerdrError('unreachable', 'Permission denied during connection'),
  new HerdrError('cli-timeout', 'Identity mismatch while offline'),
  new HerdrError('invalid-reply', 'Malformed reply while offline'),
  new HerdrError('missing-hc', 'Client binary is missing'),
  new HerdrError('cli-exit', 'CLI exited', { stderr: 'authentication failed' }),
  new HerdrError('cli-exit', 'CLI exited', { stderr: 'invalid argument' }),
  new HerdrError('cli-exit', 'CLI exited', { stderr: 'permission_denied while connection reset' }),
  new HerdrError('cli-exit', 'CLI exited', { stderr: 'HTTP 403 forbidden' }),
  new HerdrError('cli-exit', 'CLI exited', { stderr: 'invalid credentials while offline' }),
  new HerdrError('cli-exit', 'CLI exited', { stderr: 'journal checksum mismatch' }),
  new HerdrError('cli-exit', 'CLI exited', { stderr: '' }),
])('keeps the normal budget for a non-connectivity failure: $code', error => {
  expect(isCleanupConnectivityFailure(error)).toBe(false);
});
