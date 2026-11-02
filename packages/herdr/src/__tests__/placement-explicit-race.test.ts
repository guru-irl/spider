// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHerdrHarness } from './testutil.js';
import { createViewerLauncher } from '../viewers/register.js';
import { createAuxiliaryPanes } from '../jobs/placement.js';
import { HerdrError } from '../client/parse.js';
import type { AppClient, HcClient, OwnerPlacement, RunId, TerminalAddress } from '../contracts.js';

// A user open must not inherit the automatic opener's "parked" result.
test('an explicit open racing automatic parking opens the same live viewer in a new tab', async () => {
  const h = await createHerdrHarness('fake'); await h.start(); const owner = h.owner!;
  const executable = join(h.root, 'viewer.mjs'); await writeFile(executable, 'setInterval(() => {}, 1000);');
  const placement = { space: 'space', tab: 'owner-tab', pane: 'owner-pane' } as OwnerPlacement;
  const layout = new Map<TerminalAddress, OwnerPlacement>([[owner.terminal.address, placement]]);
  const barrier = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
  const parking = barrier(), finishPark = barrier(), explicitReading = barrier();
  let parkedAddress: TerminalAddress | undefined, reads = 0;
  const hc: HcClient = { ...h.hc, get: async address => {
    const terminal = await h.hc.get(address);
    // Gate on both the launcher's reuse lookup and placement's terminal lookup.
    if (address === parkedAddress && ++reads === 2) explicitReading.resolve();
    return terminal;
  } };
  const app: AppClient = {
    ownerPlacement: async address => { const p = layout.get(address); if (!p) throw new HerdrError('owner-unplaced', 'Pane absent'); return p; },
    awaitPane: async (address, p) => { const pane = `pane-${address}` as OwnerPlacement['pane']; layout.set(address, { ...p, pane }); return pane; },
    command: async (name, args) => {
      const address = args.terminal as TerminalAddress;
      if (name === 'terminal.park') { parkedAddress = address; parking.resolve(); await finishPark.promise; layout.delete(address); return { pending: true, terminal: address }; }
      if (name === 'terminal.keep') { const p = { ...placement, tab: 'saved-tab' as OwnerPlacement['tab'], pane: 'saved-pane' as OwnerPlacement['pane'] }; layout.set(address, p); return { pending: true, terminal: address, tab: p.tab, pane: p.pane }; }
      return {};
    },
  };
  const launcher = createViewerLauncher({ hc, owner: () => owner, viewerExecutable: executable, feedRoot: h.root,
    ipcDescriptor: () => ({ version: 1, sessionId: owner.sessionId, generation: owner.generation, address: join(h.root, 'ipc.sock'), capabilityFile: join(h.root, 'ipc.cap') }) });
  const panes = createAuxiliaryPanes({ hc, app, subagentViewer: launcher, discardSubagentViewer: launcher.discard, limit: 1, clock: Date.now });
  const firstId = '10000000-0000-4000-8000-000000000001' as RunId, nextId = '10000000-0000-4000-8000-000000000002' as RunId;
  try {
    const first = (await panes.acquire('subagent', firstId, owner, { timeoutMs: 1000 }))!;
    const automatic = panes.acquire('subagent', nextId, owner, { timeoutMs: 1000, automatic: true });
    await parking.promise;
    const explicit = panes.acquire('subagent', nextId, owner, { timeoutMs: 1000 });
    await explicitReading.promise; await new Promise<void>(resolve => setImmediate(resolve)); finishPark.resolve();
    expect(await automatic).toBeNull();
    const opened = await explicit;
    expect(opened).not.toBeNull();
    expect(opened?.viewer).toBe(parkedAddress);
    expect(layout.get(opened!.viewer)?.tab).toBe('saved-tab');
    expect((await h.hc.get(opened!.viewer)).state).toBe('live');
    expect(layout.get(first.viewer)?.tab).toBe('owner-tab');
    expect((await h.hc.get(first.viewer)).state).toBe('live');
  } finally { finishPark.resolve(); await panes.dispose(); await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); }
}, 15000);
