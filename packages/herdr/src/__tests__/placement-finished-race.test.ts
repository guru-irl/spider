// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHerdrHarness } from './testutil.js';
import { createViewerLauncher } from '../viewers/register.js';
import { createAuxiliaryPanes } from '../jobs/placement.js';
import { HerdrError } from '../client/parse.js';
import type { AppClient, OwnerPlacement, RunId, TerminalAddress } from '../contracts.js';

test('an explicit viewer that finishes during placement is replaced without evicting another pane', async () => {
  const h = await createHerdrHarness('fake'); await h.start(); const owner = h.owner!;
  const executable = join(h.root, 'viewer.mjs'); await writeFile(executable, 'setInterval(() => {}, 1000);');
  const placement = { space: 'space', tab: 'owner-tab', pane: 'owner-pane' } as OwnerPlacement;
  const layout = new Map<TerminalAddress, OwnerPlacement>([[owner.terminal.address, placement]]);
  let ended: TerminalAddress | undefined;
  const app: AppClient = {
    tabTerminals: async target => [...layout].filter(([, p]) => p.space === target.space && p.tab === target.tab).map(([address]) => address), ownerPlacement: async address => { const p = layout.get(address); if (!p) throw new HerdrError('owner-unplaced', 'Pane absent'); return p; },
    awaitPane: async (address, p) => { const pane = `pane-${address}` as OwnerPlacement['pane']; layout.set(address, { ...p, pane }); return pane; },
    command: async (name, args) => {
      const address = args.terminal as TerminalAddress;
      if (name === 'terminal.park') { layout.delete(address); return {}; }
      if (name === 'terminal.keep') {
        if (!ended) { ended = address; await h.hc.kill(address); await h.hc.rm(address); return { error: { code: 'app-error', message: 'No such terminal' } }; }
        const p = { ...placement, tab: 'saved-tab' as OwnerPlacement['tab'], pane: 'saved-pane' as OwnerPlacement['pane'] };
        layout.set(address, p); return { pending: true, terminal: address, tab: p.tab, pane: p.pane };
      }
      return {};
    },
  };
  const launcher = createViewerLauncher({ hc: h.hc, owner: () => owner, viewerExecutable: executable, feedRoot: h.root,
    ipcDescriptor: () => ({ version: 1, sessionId: owner.sessionId, generation: owner.generation, address: join(h.root, 'ipc.sock'), capabilityFile: join(h.root, 'ipc.cap') }) });
  const panes = createAuxiliaryPanes({ hc: h.hc, app, subagentViewer: launcher, discardSubagentViewer: launcher.discard, limit: 1, clock: Date.now });
  try {
    const first = (await panes.acquire('subagent', '10000000-0000-4000-8000-000000000001' as RunId, owner, { timeoutMs: 10000 }))!;
    const opened = (await panes.acquire('subagent', '10000000-0000-4000-8000-000000000002' as RunId, owner, { timeoutMs: 10000 }))!;
    expect(opened.viewer).not.toBe(ended);
    expect((await h.hc.get(opened.viewer)).state).toBe('live');
    expect(layout.get(opened.viewer)?.tab).toBe('saved-tab');
    expect(layout.get(first.viewer)?.tab).toBe('owner-tab');
    expect((await h.hc.get(first.viewer)).state).toBe('live');
  } finally { await panes.dispose(); await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); }
}, 15000);
