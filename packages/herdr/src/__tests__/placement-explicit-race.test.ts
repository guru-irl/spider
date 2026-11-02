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

// A stale automatic lookup must not park a viewer opened by the user.
test('an explicit open racing an unplaced lookup keeps the same viewer in its new tab', async () => {
  const h = await createHerdrHarness('fake'); await h.start(); const owner = h.owner!;
  const executable = join(h.root, 'viewer.mjs'); await writeFile(executable, 'setInterval(() => {}, 1000);');
  const placement = { space: 'space', tab: 'owner-tab', pane: 'owner-pane' } as OwnerPlacement;
  const layout = new Map<TerminalAddress, OwnerPlacement>([[owner.terminal.address, placement]]);
  const barrier = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
  const lookupStarted = barrier(), finishLookup = barrier();
  let openingAddress: TerminalAddress | undefined, firstAddress: TerminalAddress | undefined, blockLookup = false;
  const parked: TerminalAddress[] = [];
  const hc: HcClient = h.hc;
  const app: AppClient = {
    tabTerminals: async target => [...layout].filter(([, p]) => p.space === target.space && p.tab === target.tab).map(([address]) => address), ownerPlacement: async address => {
      const p = layout.get(address);
      if (blockLookup && address !== owner.terminal.address && address !== firstAddress) {
        blockLookup = false; openingAddress = address; lookupStarted.resolve(); await finishLookup.promise;
      }
      if (!p) throw new HerdrError('owner-unplaced', 'Pane absent'); return p;
    },
    awaitPane: async (address, p) => { const pane = `pane-${address}` as OwnerPlacement['pane']; layout.set(address, { ...p, pane }); return pane; },
    command: async (name, args) => {
      const address = args.terminal as TerminalAddress;
      if (name === 'terminal.park') { parked.push(address); layout.delete(address); return { pending: true, terminal: address }; }
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
    firstAddress = first.viewer; blockLookup = true;
    const automatic = panes.acquire('subagent', nextId, owner, { timeoutMs: 1000, automatic: true });
    await lookupStarted.promise;
    const opened = await panes.acquire('subagent', nextId, owner, { timeoutMs: 1000 });
    finishLookup.resolve();
    expect(await automatic).toBeNull();
    expect(opened).not.toBeNull();
    expect(opened?.viewer).toBe(openingAddress);
    expect(parked).toEqual([]);
    expect(layout.get(opened!.viewer)?.tab).toBe('saved-tab');
    expect((await h.hc.get(opened!.viewer)).state).toBe('live');
    expect(layout.get(first.viewer)?.tab).toBe('owner-tab');
    expect((await h.hc.get(first.viewer)).state).toBe('live');
  } finally { finishLookup.resolve(); await panes.dispose(); await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); }
}, 15000);
