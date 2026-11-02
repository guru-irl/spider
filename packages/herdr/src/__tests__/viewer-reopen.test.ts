// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHerdrHarness } from './testutil.js';
import { createViewerLauncher } from '../viewers/register.js';
import { createAuxiliaryPanes } from '../jobs/placement.js';
import { HerdrError } from '../client/parse.js';
import type { AppClient, IpcDescriptor, OwnerPlacement, RunId, TerminalAddress } from '../contracts.js';

const runId = '10000000-0000-4000-8000-000000000001' as RunId;
const modes: ('fake' | 'hc')[] = ['fake'];
if (process.env.SPIDER_HERDR_E2E === '1') modes.push('hc');
else console.info('Finished-viewer real-core checks disabled. Set SPIDER_HERDR_E2E=1; no app window is used.');

for (const mode of modes) test.each([
  { limit: 1, finishedEvent: true }, { limit: 2, finishedEvent: true },
  { limit: 1, finishedEvent: false }, { limit: 2, finishedEvent: false },
])(`${mode}: reopens with $limit slots and finishedEvent=$finishedEvent without waiting for the old pane`, async ({ limit, finishedEvent }) => {
  const h = await createHerdrHarness(mode); await h.start(); const owner = h.owner!;
  const executable = join(h.root, 'viewer.mjs'); await writeFile(executable, 'setInterval(() => {}, 1000);');
  const placement = { space: 'space', tab: 'owner-tab', pane: 'owner-pane' } as OwnerPlacement;
  const layout = new Map<TerminalAddress, OwnerPlacement>([[owner.terminal.address, placement]]);
  const parked: TerminalAddress[] = [], errors: unknown[] = [];
  let focused: TerminalAddress | undefined;
  const app: AppClient = {
    tabTerminals: async target => [...layout].filter(([, p]) => p.space === target.space && p.tab === target.tab).map(([address]) => address), ownerPlacement: async address => {
      const p = layout.get(address); if (!p) throw new HerdrError('owner-unplaced', 'Pane absent'); return p;
    },
    awaitPane: async (address, p) => {
      const pane = `pane-${address}` as OwnerPlacement['pane']; layout.set(address, { ...p, pane }); return pane;
    },
    command: async (name, args) => {
      const address = args.terminal as TerminalAddress;
      if (name === 'pane.focus') { focused = address; return {}; }
      if (name === 'terminal.park') {
        parked.push(address);
        // hc 0.1.16 rejects keep --off on finished terminals. Native pending
        // is not proof that the app removed a finished pane from its layout.
        if ((await h.hc.get(address)).state === 'live') layout.delete(address);
        return { pending: true, terminal: address };
      }
      if (name === 'terminal.keep') {
        const p = { ...placement, tab: `tab-${address}` as OwnerPlacement['tab'], pane: `pane-${address}` as OwnerPlacement['pane'] };
        layout.set(address, p); return { pending: true, terminal: address, tab: p.tab, pane: p.pane };
      }
      return {};
    },
  };
  let descriptor: IpcDescriptor | null = { version: 1, sessionId: owner.sessionId, generation: owner.generation, address: join(h.root, 'ipc.sock'), capabilityFile: join(h.root, 'ipc.cap') };
  const launcher = createViewerLauncher({ hc: h.hc, owner: () => owner, viewerExecutable: executable, feedRoot: h.root, ipcDescriptor: () => descriptor });
  const panes = createAuxiliaryPanes({ hc: { ...h.hc, events: () => {
    const stream = h.hc.events();
    return { ...stream, subscribe: listener => stream.subscribe(event => { if (finishedEvent || event.type !== 'finished') listener(event); }) };
  } }, app, subagentViewer: launcher, discardSubagentViewer: launcher.discard, limit, clock: Date.now, paneRemovalTimeoutMs: 200, reportError: error => errors.push(error) });
  try {
    const first = (await panes.acquire('subagent', runId, owner, { timeoutMs: 1000 }))!;
    await h.hc.kill(first.viewer);
    expect((await h.hc.get(first.viewer)).state).toBe('finished');
    const reopened = (await panes.acquire('subagent', runId, owner, { timeoutMs: 1000 }))!;
    expect(reopened.viewer).not.toBe(first.viewer);
    expect((await h.hc.get(reopened.viewer)).state).toBe('live');
    expect(layout.has(first.viewer)).toBe(true);
    expect(parked).not.toContain(first.viewer);
    expect(layout.get(reopened.viewer)?.tab).toBe(limit === 1 ? `tab-${reopened.viewer}` : 'owner-tab');
    expect(focused).toBe(reopened.viewer);
    expect((await panes.acquire('subagent', runId, owner, { timeoutMs: 1000 }))?.viewer).toBe(reopened.viewer);
    const other = (await panes.acquire('subagent', '10000000-0000-4000-8000-000000000002' as RunId, owner, { timeoutMs: 1000 }))!;
    expect((await h.hc.get(other.viewer)).state).toBe('live');
    expect(layout.get(other.viewer)?.tab).toBe(`tab-${other.viewer}`);
    expect(layout.has(first.viewer)).toBe(true);
    expect(errors).toEqual([]);
    await panes.park(runId);
    expect(parked).toEqual([reopened.viewer]);
    expect(layout.has(first.viewer)).toBe(true);
    expect(layout.has(reopened.viewer)).toBe(false);
    // Owner replacement remains a typed lifecycle failure, not a generic Error.
    descriptor = null;
    await expect(launcher(runId, owner)).rejects.toMatchObject({ code: 'wrong-generation' });
  } finally {
    layout.clear(); await panes.dispose();
    await h.close(); expect(await h.remainingOwnedResources()).toEqual([]);
  }
}, 15000);
