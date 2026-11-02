// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createSessionIpcClient } from '../feed/ipc-client.js';
import { startSessionEndpoint, type SessionEndpointPorts } from '../feed/ipc-server.js';
import { panelIpcArgv, parsePanelIpcArgv } from '../../assets/shared/feed.js';
import type { Owner, RunId } from '../contracts.js';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it('routes a subagent kill through its authenticated owner and refuses other runs', async () => {
  const base = resolve('.spider/scratch/h');
  await mkdir(base, { recursive: true });
  root = await mkdtemp(join(base, 'ki-'));
  const owner: Owner = { sessionId: 'owner' as Owner['sessionId'], generation: 'gen' as Owner['generation'], terminal: { coreId: 'core' as Owner['terminal']['coreId'], terminalId: 't1' as Owner['terminal']['terminalId'], address: 't1' as Owner['terminal']['address'], socket: join(root, 'core.sock'), sessionNamespace: 'fixture' }, cwd: root, sessionFile: null, name: null };
  const active = new Set(['owned', 'foreign']);
  const ports: SessionEndpointPorts = {
    currentOwner: () => owner, liveCapabilities: () => ({ native: 'working', effective: 'working' }),
    ownsRun: id => id === 'owned', subscribeRun: () => ({ dispose() {} }),
    steerRun: () => ({ accepted: false, delivered: false, queued: false, delivery: 'refused' }),
    openView() {}, openRun: () => null, ownsJob: () => false, openJob: () => null,
    killRun: async id => { active.delete(id); },
  };
  const endpoint = await startSessionEndpoint(owner, ports, join(root, 'herdr'));
  const client = createSessionIpcClient(endpoint.descriptor);
  try {
    const request = { op: 'killRun' as const, runId: 'owned' as RunId, generation: owner.generation };
    const argv = panelIpcArgv('node', 'cli', endpoint.descriptor, request);
    expect(parsePanelIpcArgv(argv)?.request).toEqual(request);
    expect(await client.request(request)).toEqual({ ok: true, op: 'killRun' });
    expect(active.has('owned')).toBe(false);
    expect(await client.request({ ...request, runId: 'foreign' as RunId })).toMatchObject({ ok: false, code: 'not-found' });
    expect(active.has('foreign')).toBe(true);
    expect(await client.request({ ...request, generation: 'old' as Owner['generation'] })).toMatchObject({ ok: false, code: 'wrong-generation' });
  } finally { client.dispose(); await endpoint.dispose(); }
});
