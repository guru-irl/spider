// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test, vi } from 'vitest';
import { PANE_ENDPOINT_BOOTSTRAP } from '../herdr/pane-installation.js';
import { HerdrError } from '../../../herdr/src/client/parse.js';
import { createPaneRemoteRequest } from '../herdr/pane-transport.js';
const machine = { key: 'box-1.invalid', alias: 'box-1.invalid', label: 'box-1.invalid', coreId: 'core-1.invalid' as never, machineId: null, state: 'connected' as const };
const route = { on: 'core-1.invalid', coreId: 'core-1.invalid' as never, nodePath: '/usr/bin/node' };
const digest = 'a'.repeat(64);
test('remote pane effects use configured Node and endpoint with digest handshake', async () => {
  const exec = vi.fn(async (_on: string, argv: readonly string[]) => {
    const request = JSON.parse(argv.at(-1)!); return Buffer.from(JSON.stringify(request.op === 'handshake' ? { version: 1, op: 'handshake', protocol: 1, buildDigest: digest } : { version: 1, op: 'stop-viewer', outcome: { status: 'complete', reason: 'stopped', presentation: null } }));
  });
  const request = createPaneRemoteRequest({ buildDigest: digest, resolveMachine: async () => route, exec });
  expect(await request(machine, { version: 1, op: 'stop-viewer', leaseId: 'lease-1' })).toMatchObject({ op: 'stop-viewer' });
  expect(exec).toHaveBeenCalledTimes(2);
  expect(exec.mock.calls[0]).toEqual(['core-1.invalid', ['/usr/bin/node', '-e', PANE_ENDPOINT_BOOTSTRAP, digest, '1', JSON.stringify({ version: 1, op: 'handshake', protocol: 1, buildDigest: digest })], expect.objectContaining({ timeoutMs: expect.any(Number), maxBytes: 1048576 })]);
});
test('changed routes and incompatible endpoints have no remote mutation', async () => {
  const resolveMachine = vi.fn().mockResolvedValueOnce(route).mockResolvedValue({ ...route, coreId: 'replacement' });
  const exec = vi.fn(async () => Buffer.from(JSON.stringify({ version: 1, op: 'handshake', protocol: 1, buildDigest: digest })));
  const request = createPaneRemoteRequest({ buildDigest: digest, resolveMachine, exec });
  await expect(request(machine, { version: 1, op: 'stop-viewer', leaseId: 'lease-1' })).rejects.toMatchObject({ code: 'machine-changed' });
  expect(exec).toHaveBeenCalledTimes(1);
  exec.mockClear(); exec.mockResolvedValue(Buffer.from(JSON.stringify({ version: 1, op: 'handshake', protocol: 1, buildDigest: 'b'.repeat(64) })));
  const incompatible = createPaneRemoteRequest({ buildDigest: digest, resolveMachine: async () => route, exec });
  await expect(incompatible(machine, { version: 1, op: 'stop-viewer', leaseId: 'lease-1' })).rejects.toMatchObject({ code: 'pane-build-mismatch' });
  expect(exec).toHaveBeenCalledTimes(1);
});

test.each(['pane-installation-missing', 'pane-installation-unsafe', 'pane-endpoint-build-mismatch', 'pane-endpoint-protocol-mismatch'])('source refusal %s stays named and never falls back', async code => {
  const exec = vi.fn(async () => { throw new HerdrError('cli-exit', 'Failed', { stderr: JSON.stringify({ code }) }); });
  const request = createPaneRemoteRequest({ buildDigest: digest, resolveMachine: async () => route, exec });
  await expect(request(machine, { version: 1, op: 'stop-viewer', leaseId: 'lease-1' })).rejects.toMatchObject({ code });
  expect(exec).toHaveBeenCalledTimes(1);
});
