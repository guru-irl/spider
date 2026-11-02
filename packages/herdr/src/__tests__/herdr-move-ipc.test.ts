// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createSessionIpcClient } from '../feed/ipc-client.js';
import { startSessionEndpoint, type SessionEndpointPorts } from '../feed/ipc-server.js';
import { panelIpcArgv, parsePanelIpcArgv } from '../../assets/shared/feed.js';
import type { Owner, TerminalAddress } from '../contracts.js';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
it('moves only a run owned by the authenticated session', async () => {
  const base = resolve('.spider/scratch/h'); await mkdir(base, { recursive: true }); root = await mkdtemp(join(base, 'mi-'));
  const owner = { sessionId: 'owner', generation: 'gen', terminal: { coreId: 'core', terminalId: 't1', address: 't1', socket: join(root, 'core.sock'), sessionNamespace: 'fixture' }, cwd: root, sessionFile: null, name: null } as Owner;
  const tabs = new Map([['owned', 'source'], ['foreign', 'source']]);
  const ports: SessionEndpointPorts = {
    currentOwner: () => owner, liveCapabilities: () => ({ native: 'working', effective: 'working' }),
    ownsRun: id => id === 'owned', subscribeRun: () => ({ dispose() {} }),
    steerRun: () => ({ accepted: false, delivered: false, queued: false, delivery: 'refused' }),
    openView() {}, openRun: () => null, ownsJob: () => false, openJob: () => null,
    moveRun: async (id, destination) => { if (destination.kind === 'tab') tabs.set(id, destination.tab); return 'viewer' as TerminalAddress; },
  };
  const endpoint = await startSessionEndpoint(owner, ports, join(root, 'herdr'));
  const client = createSessionIpcClient(endpoint.descriptor);
  try {
    const request = { op: 'moveRun', runId: 'owned', generation: owner.generation, destination: { kind: 'tab', tab: 'target' } } as const;
    expect(parsePanelIpcArgv(panelIpcArgv('node', 'cli', endpoint.descriptor, request as never))?.request).toEqual(request);
    expect(await client.request(request as never)).toEqual({ ok: true, op: 'moveRun', viewer: 'viewer' });
    expect(tabs.get('owned')).toBe('target');
    expect(await client.request({ ...request, runId: 'foreign' } as never)).toMatchObject({ ok: false, code: 'not-found' });
    expect(tabs.get('foreign')).toBe('source');
    expect(parsePanelIpcArgv(panelIpcArgv('node', 'cli', endpoint.descriptor, { ...request, destination: { kind: 'tab' } } as never))).toBeNull();
  } finally { client.dispose(); await endpoint.dispose(); }
});

it('moves the authenticated owner session and rejects an old generation', async () => {
  const base = resolve('.spider/scratch/h'); await mkdir(base, { recursive: true }); root = await mkdtemp(join(base, 'ms-'));
  const owner = { sessionId: 'owner', generation: 'gen', terminal: { coreId: 'core', terminalId: 't1', address: 't1', socket: join(root, 'core.sock'), sessionNamespace: 'fixture' }, cwd: root, sessionFile: null, name: null } as Owner;
  let tab = 'source';
  const ports: SessionEndpointPorts & { moveSession(destination: any): Promise<void> } = {
    currentOwner: () => owner, liveCapabilities: () => ({ native: 'working', effective: 'working' }), ownsRun: () => false,
    subscribeRun: () => ({ dispose() {} }), steerRun: () => ({ accepted: false, delivered: false, queued: false, delivery: 'refused' }),
    openView() {}, openRun: () => null, ownsJob: () => false, openJob: () => null,
    moveSession: async destination => { tab = destination.tab; },
  };
  const endpoint = await startSessionEndpoint(owner, ports, join(root, 'herdr')), client = createSessionIpcClient(endpoint.descriptor);
  try {
    const request = { op: 'moveSession', generation: owner.generation, destination: { kind: 'tab', tab: 'target' } } as const;
    expect(parsePanelIpcArgv(panelIpcArgv('node', 'cli', endpoint.descriptor, request as never))?.request).toEqual(request);
    expect(await client.request(request as never)).toEqual({ ok: true, op: 'moveSession' });
    expect(tab).toBe('target');
    expect(await client.request({ ...request, generation: 'old' } as never)).toMatchObject({ ok: false, code: 'wrong-generation' });
    expect(parsePanelIpcArgv(panelIpcArgv('node', 'cli', endpoint.descriptor, { ...request, destination: { kind: 'hide' } } as never))).toBeNull();
  } finally { client.dispose(); await endpoint.dispose(); }
});

it('kills only a command owned by the authenticated session', async () => {
  const base = resolve('.spider/scratch/h'); await mkdir(base, { recursive: true }); root = await mkdtemp(join(base, 'mj-'));
  const owner = { sessionId: 'owner', generation: 'gen', terminal: { coreId: 'core', terminalId: 't1', address: 't1', socket: join(root, 'core.sock'), sessionNamespace: 'fixture' }, cwd: root, sessionFile: null, name: null } as Owner;
  const jobs = new Set(['owned', 'foreign']), moved: string[] = [];
  const ports: SessionEndpointPorts = {
    currentOwner: () => owner, liveCapabilities: () => ({ native: 'working', effective: 'working' }),
    ownsRun: () => false, subscribeRun: () => ({ dispose() {} }),
    steerRun: () => ({ accepted: false, delivered: false, queued: false, delivery: 'refused' }),
    openView() {}, openRun: () => null, ownsJob: id => id === 'owned', openJob: () => null,
    killJob: async id => { jobs.delete(id); },
    moveJob: async (id, viewer) => { moved.push(`${id}:${viewer}`); return viewer; },
  };
  const endpoint = await startSessionEndpoint(owner, ports, join(root, 'herdr'));
  const client = createSessionIpcClient(endpoint.descriptor);
  try {
    const move = { op: 'moveJob', jobId: 'owned', viewer: 'observer', destination: { kind: 'tab', tab: 'target' }, generation: owner.generation } as const;
    expect(parsePanelIpcArgv(panelIpcArgv('node', 'cli', endpoint.descriptor, move as never))?.request).toEqual(move);
    expect(await client.request(move as never)).toEqual({ ok: true, op: 'moveJob', viewer: 'observer' });
    expect(moved).toEqual(['owned:observer']);
    expect(await client.request({ ...move, jobId: 'foreign' } as never)).toMatchObject({ ok: false, code: 'not-found' });
    const request = { op: 'killJob', jobId: 'owned', generation: owner.generation } as const;
    expect(parsePanelIpcArgv(panelIpcArgv('node', 'cli', endpoint.descriptor, request as never))?.request).toEqual(request);
    expect(await client.request(request as never)).toEqual({ ok: true, op: 'killJob', jobId: 'owned' });
    expect(jobs.has('owned')).toBe(false);
    expect(await client.request({ ...request, jobId: 'foreign' } as never)).toMatchObject({ ok: false, code: 'not-found' });
    expect(jobs.has('foreign')).toBe(true);
  } finally { client.dispose(); await endpoint.dispose(); }
});
