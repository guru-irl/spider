// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { feedError } from '../feed/publisher.js';
import { HerdrError } from '../client/parse.js';
import { createSessionIpcClient, ipcFailureReply } from '../feed/ipc-client.js';
import { startSessionEndpoint, type SessionEndpointPorts } from '../feed/ipc-server.js';
import { createViewerLauncher } from '../viewers/register.js';
import type { HcClient, Owner, RunId } from '../contracts.js';

const owner = { sessionId: 'owner-session', generation: 'activation', terminal: { coreId: 'core', terminalId: 'owner', address: 'owner', socket: '/fixture/core.sock', sessionNamespace: 'fixture' }, cwd: '/fixture', sessionFile: null, name: null } as Owner;
const runId = '10000000-0000-4000-8000-000000000001' as RunId;

test('an IPC acknowledgement timeout keeps its typed unavailable code', () => {
  expect(ipcFailureReply(feedError('unavailable', 'IPC acknowledgement timed out.'))).toEqual({ ok: false, code: 'unavailable', message: 'unavailable' });
});

test('a stale viewer owner rejects with a typed lifecycle code', async () => {
  const launcher = createViewerLauncher({ hc: {} as HcClient, owner: () => owner, ipcDescriptor: () => null, viewerExecutable: '/fixture/viewer.mjs', feedRoot: '/fixture' });
  await expect(launcher(runId, owner)).rejects.toMatchObject({ code: 'wrong-generation' });
});

test('a Mac-only refusal exposes only the fixed placement message', async () => {
  const root = resolve(tmpdir(), 'h', `ip8-${randomBytes(3).toString('hex')}`);
  const reported: unknown[] = [];
  const ports: SessionEndpointPorts = {
    currentOwner: () => owner, liveCapabilities: () => null, ownsRun: () => false,
    subscribeRun: () => ({ dispose() {} }), steerRun: () => ({ delivery: 'refused', accepted: false, delivered: false, queued: false }),
    openView() { throw new HerdrError('view-on-mac', '/fixture/private/output'); }, openRun: () => null, ownsJob: () => false, openJob: () => null,
    reportError: error => { reported.push(error); },
  };
  const endpoint = await startSessionEndpoint(owner, ports, root), client = createSessionIpcClient(endpoint.descriptor);
  try {
    expect(await client.openView('agents')).toEqual({ ok: false, code: 'refused', message: 'This view is available on the Mac.' });
    expect(reported).toEqual([]);
  } finally { client.dispose(); await endpoint.dispose(); await rm(root, { recursive: true, force: true }); }
}, 5000);

test('openRun reports the original server error but returns only a safe action code', async () => {
  const root = resolve('.spider/scratch/h', `ip7-${randomBytes(3).toString('hex')}`);
  const original = new Error('Failure at /fixture/private/output'); const reported: unknown[] = [];
  const ports: SessionEndpointPorts & { reportError(error: unknown): void } = {
    currentOwner: () => owner, liveCapabilities: () => null, ownsRun: () => true,
    subscribeRun: () => ({ dispose() {} }), steerRun: () => ({ delivery: 'refused', accepted: false, delivered: false, queued: false }),
    openView() {}, openRun() { throw original; }, ownsJob: () => false, openJob: () => null,
    reportError: error => { reported.push(error); },
  };
  const endpoint = await startSessionEndpoint(owner, ports, root); const client = createSessionIpcClient(endpoint.descriptor);
  try {
    expect(await client.openRun(runId)).toEqual({ ok: false, code: 'unavailable', message: 'run-open-failed' });
    expect(reported).toEqual([original]);
  } finally { client.dispose(); await endpoint.dispose(); await rm(root, { recursive: true, force: true }); }
});
