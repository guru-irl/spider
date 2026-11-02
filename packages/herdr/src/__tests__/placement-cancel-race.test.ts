// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHerdrHarness } from './testutil.js';
import { createViewerLauncher } from '../viewers/register.js';
import { createAuxiliaryPanes } from '../jobs/placement.js';
import { HerdrError } from '../client/parse.js';
import type { AppClient, HcClient, OwnerPlacement, PaneReservation, RunId, TerminalAddress } from '../contracts.js';

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

// An explicit display must tolerate lifecycle cleanup before or after enqueue.
test.each(['before-enqueue', 'queued'] as const)('explicit open survives cancellation cleanup %s', async stage => {
  const h = await createHerdrHarness('fake'); await h.start(); const owner = h.owner!;
  const executable = join(h.root, 'viewer.mjs'); await writeFile(executable, 'setInterval(() => {}, 1000);');
  const placement = { space: 'space', tab: 'owner-tab', pane: 'owner-pane' } as OwnerPlacement;
  const layout = new Map<TerminalAddress, OwnerPlacement>([[owner.terminal.address, placement]]);
  const blocked = barrier(), unblock = barrier(), explicitReading = barrier(), allowRead = barrier(), retired = barrier();
  const commands: { name: string; args: Readonly<Record<string, unknown>> }[] = [];
  let first: PaneReservation | undefined, reading = false, reads = 0, blockNext = false;
  const hc: HcClient = { ...h.hc, get: async address => {
    const terminal = await h.hc.get(address);
    // The launcher validates reuse first; show's identity read is second.
    if (reading && address === first?.viewer && ++reads === 2) { explicitReading.resolve(); await allowRead.promise; }
    return terminal;
  }, rm: async address => { await h.hc.rm(address); if (address === first?.viewer) retired.resolve(); } };
  const app: AppClient = {
    ownerPlacement: async address => {
      if (blockNext && address !== owner.terminal.address) { blockNext = false; blocked.resolve(); await unblock.promise; }
      const p = layout.get(address); if (!p) throw new HerdrError('owner-unplaced', 'Pane absent'); return p;
    },
    awaitPane: async (address, p) => {
      const pane = `pane-${address}` as OwnerPlacement['pane']; layout.set(address, { ...p, pane }); return pane;
    },
    command: async (name, args) => {
      commands.push({ name, args });
      const address = args.terminal as TerminalAddress;
      if (name === 'terminal.park') layout.delete(address);
      if (name === 'terminal.keep') {
        const p = { ...placement, tab: 'saved-tab' as OwnerPlacement['tab'], pane: 'saved-pane' as OwnerPlacement['pane'] };
        layout.set(address, p); return { pending: true, terminal: address, tab: p.tab, pane: p.pane };
      }
      return {};
    },
  };
  const launcher = createViewerLauncher({ hc, owner: () => owner, viewerExecutable: executable, feedRoot: h.root,
    runInfo: () => ({ name: 'cancelled-item' }),
    ipcDescriptor: () => ({ version: 1, sessionId: owner.sessionId, generation: owner.generation, address: join(h.root, 'ipc.sock'), capabilityFile: join(h.root, 'ipc.cap') }) });
  const panes = createAuxiliaryPanes({ hc, app, subagentViewer: launcher, discardSubagentViewer: launcher.discard, limit: 1, clock: Date.now });
  let opening: Promise<PaneReservation | null> | undefined, blocking: Promise<PaneReservation | null> | undefined;
  try {
    const id = '10000000-0000-4000-8000-000000000001' as RunId;
    first = (await panes.acquire('subagent', id, owner, { timeoutMs: 1000 }))!;
    // Closing a tab only removes its layout, not the viewer or the run.
    layout.delete(first.viewer);
    blockNext = true;
    blocking = panes.acquire('subagent', '10000000-0000-4000-8000-000000000002' as RunId, owner, { timeoutMs: 1000 });
    await blocked.promise;
    reading = true;
    opening = panes.acquire('subagent', id, owner, { timeoutMs: 1000 });
    void opening.catch(() => {});
    await explicitReading.promise;
    if (stage === 'queued') { allowRead.resolve(); await turn(); }
    // Real core finish events drive removeSlot, exactly as a cancelled viewer exits.
    await h.hc.kill(first.viewer);
    await retired.promise; await turn();
    allowRead.resolve(); unblock.resolve();
    const other = (await blocking)!;
    const opened = await opening;
    expect(opened).not.toBeNull();
    expect(opened!.viewer).not.toBe(first.viewer);
    expect((await h.hc.get(opened!.viewer)).state).toBe('live');
    expect(layout.get(opened!.viewer)?.tab).toBe('saved-tab');
    expect(layout.get(other.viewer)?.tab).toBe('owner-tab');
    expect((await h.hc.get(other.viewer)).state).toBe('live');
    expect(layout.get(owner.terminal.address)).toEqual(placement);
    expect(commands.filter(c => c.name === 'terminal.park')).toEqual([]);
    expect(commands.filter(c => c.name === 'tab.rename')).toEqual([{ name: 'tab.rename', args: { id: 'saved-tab', name: 'cancelled-item' } }]);
    expect(commands.at(-1)).toEqual({ name: 'pane.focus', args: { terminal: opened!.viewer } });
  } finally {
    allowRead.resolve(); unblock.resolve(); await Promise.allSettled([opening, blocking]);
    await panes.dispose(); await h.close(); expect(await h.remainingOwnedResources()).toEqual([]);
  }
}, 15000);
