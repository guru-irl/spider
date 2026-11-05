// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { HcClient, Owner, PaneReservation, RunId, TerminalAddress } from '../contracts.js';
import { registerHerdrViewers } from '../viewers/register.js';

afterEach(() => { vi.unstubAllEnvs(); });

it.each(['quit', 'reload', 'new', 'resume', 'fork', 'dispose'] as const)('registration alone keeps a held viewer reservation on %s', async reason => {
  vi.stubEnv('PI_SUBAGENT_CHILD', '0');
  const owner = { sessionId: 'viewer-session', generation: 'viewer-generation', cwd: '/fixture', sessionFile: null, name: null,
    terminal: { coreId: 'fixture-core', terminalId: 'owner', address: 'owner', socket: '/fixture/core.sock', sessionNamespace: 'fixture' } } as Owner;
  const run = 'viewer-run' as RunId, viewer = 'viewer' as TerminalAddress;
  const reservation = { id: run, kind: 'subagent', owner, viewer, pane: 'viewer-pane' } as PaneReservation;
  const displayed = new Map<RunId, PaneReservation>(), released: PaneReservation[] = [];
  const hooks = new Map<string, (event: { reason: string }) => Promise<void>>();
  const pi = { on: (name: string, hook: (event: { reason: string }) => Promise<void>) => { hooks.set(name, hook); } } as unknown as ExtensionAPI;
  let subscribed = false;
  const registration = registerHerdrViewers(pi, {
    owner: () => owner, hc: {} as HcClient, viewerExecutable: '/fixture/viewer.mjs', feedRoot: '/fixture/feed', ipcDescriptor: () => null,
    viewerLauncher: async () => viewer,
    ownedRunEvents: { list: async () => [run], subscribe: () => { subscribed = true; return () => { subscribed = false; }; } },
    panes: {
      reconcile: async () => {},
      acquire: async () => { displayed.set(run, reservation); return reservation; },
      release: async held => { released.push(held); displayed.delete(held.id as RunId); },
      park: async id => { displayed.delete(id as RunId); },
      dispose: () => { throw new Error('Registration must not dispose the pane actor'); },
    },
  });
  try {
    await hooks.get('session_start')!({ reason: 'reload' });
    expect(await registration.peek(run)).toEqual({ address: viewer, coreId: owner.terminal.coreId });
    expect(displayed.get(run)).toBe(reservation);
    if (reason === 'dispose') await registration.dispose();
    else await hooks.get('session_shutdown')!({ reason });
    expect(displayed.get(run)).toBe(reservation);
    expect(released).toEqual([]);
    expect(subscribed).toBe(false);
    await registration.dispose();
    expect(displayed.get(run)).toBe(reservation);
    expect(released).toEqual([]);
  } finally { await registration.dispose(); }
});
