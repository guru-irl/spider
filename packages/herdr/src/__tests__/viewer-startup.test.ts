// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Owner, RunId, TerminalAddress } from '../contracts.js';
import { registerHerdrViewers } from '../viewers/register.js';

const owner = { sessionId: 'owner', generation: 'generation', cwd: '/fixture', terminal: { coreId: 'core', terminalId: 'agent', address: 'agent' } } as Owner;
const ids = Array.from({ length: 8 }, (_, i) => `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}` as RunId);
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('startup opens at most four viewers concurrently and an individual failure does not block the rest', async () => {
  const hooks = new Map<string, () => Promise<void>>(); const opened: RunId[] = [], errors: unknown[] = [];
  const gates: (() => void)[] = []; let active = 0, maximum = 0, started = false;
  const registration = registerHerdrViewers({ on: (name: string, handler: () => Promise<void>) => hooks.set(name, handler) } as unknown as ExtensionAPI, {
    owner: () => owner, hc: {} as never, viewerExecutable: '/fixture/viewer', feedRoot: '/fixture', ipcDescriptor: () => null,
    ownedRunEvents: { list: async () => ids, subscribe: () => () => {} }, reportError: error => errors.push(error),
    viewerLauncher: async id => { opened.push(id); return `viewer-${id}` as TerminalAddress; },
    panes: {
      acquire: async (_kind, id) => {
        maximum = Math.max(maximum, ++active);
        await new Promise<void>(resolve => gates.push(resolve)); active--;
        if (id === ids[0]) throw new Error('first placement failed');
        return null;
      },
      release: async () => {}, park: async () => {}, dispose: async () => {},
    },
  });
  const start = hooks.get('session_start')!().then(() => { started = true; });
  try {
    await flush(); expect(started).toBe(true); expect(active).toBe(4);
    while (gates.length) { gates.splice(0).forEach(resolve => resolve()); await flush(); }
    await start; expect(maximum).toBe(4); expect(errors).toHaveLength(1); expect(opened).toEqual(ids.slice(1));
  } finally { gates.splice(0).forEach(resolve => resolve()); await registration.dispose(); await start.catch(() => {}); }
});

test('later run events do not repeat the open sequence or reopen a user-dismissed viewer', async () => {
  const hooks = new Map<string, () => Promise<void>>(); let emit!: (id: RunId) => void; let acquisitions = 0; let launches = 0;
  const registration = registerHerdrViewers({ on: (name: string, handler: () => Promise<void>) => hooks.set(name, handler) } as unknown as ExtensionAPI, {
    owner: () => owner, hc: {} as never, viewerExecutable: '/fixture/viewer', feedRoot: '/fixture', ipcDescriptor: () => null,
    ownedRunEvents: { list: async () => [ids[0]], subscribe: (_owner, listener) => { emit = listener; return () => {}; } },
    viewerLauncher: async () => `viewer-${++launches}` as TerminalAddress,
    panes: { acquire: async () => { acquisitions++; return null; }, release: async () => {}, park: async () => {}, dispose: async () => {} },
  });
  try {
    await hooks.get('session_start')!(); await flush();
    for (let i = 0; i < 20; i++) emit(ids[0]); await flush();
    expect(acquisitions).toBe(1); expect(launches).toBe(1);
    // Only an explicit user open may launch a replacement after dismissal.
    expect(await registration.peek(ids[0])).toMatchObject({ address: 'viewer-2' });
    for (let i = 0; i < 20; i++) emit(ids[0]); await flush();
    expect(acquisitions).toBe(2); expect(launches).toBe(2);
  } finally { await registration.dispose(); }
});
