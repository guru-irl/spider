// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHerdrHarness } from './testutil.js';
import { createViewerLauncher } from '../viewers/register.js';
import { createAuxiliaryPanes } from '../jobs/placement.js';
import { HerdrError } from '../client/parse.js';
import type { AppClient, AppReply, OwnerPlacement, PaneId, RunId, TerminalAddress } from '../contracts.js';

const ids = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003'] as RunId[];
const modes: ('fake' | 'hc')[] = ['fake'];
if (process.env.SPIDER_HERDR_E2E === '1') modes.push('hc');
else console.info('Viewer lifecycle real-core checks disabled. Set SPIDER_HERDR_E2E=1; no app window is used.');
async function fixture(limit = 2, mode: 'fake' | 'hc' = 'fake') {
  const h = await createHerdrHarness(mode); await h.start(); const owner = h.owner!;
  const executable = join(h.root, 'viewer.mjs'); writeFileSync(executable, 'setInterval(() => {}, 1000);');
  const placement = { space: 'space', tab: 'tab', pane: 'owner-pane' } as OwnerPlacement;
  const layout = new Map<TerminalAddress, OwnerPlacement>([[owner.terminal.address, placement]]); const errors: unknown[] = [];
  let failDisplay = false, failRemoval = false, kept = 0; let focused = placement;
  const tabNames = new Map<string, string>();
  const app: AppClient = {
    tabTerminals: async target => [...layout].filter(([, p]) => p.space === target.space && p.tab === target.tab).map(([address]) => address), ownerPlacement: async address => {
      if (failRemoval && address !== owner.terminal.address) { failRemoval = false; throw new HerdrError('app-disconnected', 'Transient app failure'); }
      const p = layout.get(address); if (!p) throw new HerdrError('owner-unplaced', 'Pane absent'); return p;
    },
    awaitPane: async (address, p) => {
      if (failDisplay) { failDisplay = false; throw new HerdrError('pane-timeout', 'Transient display failure'); }
      const pane = `pane-${address}` as PaneId; layout.set(address, { ...p, pane }); return pane;
    },
    command: async (name, args) => {
      const address = args.terminal as TerminalAddress, ok: AppReply & { ok: true } = { ok: true };
      const error = (message: string): AppReply => ({ error: { code: 'app-error', message } });
      if (name === 'pane.focus') {
        const p = typeof args.pane === 'string' ? Array.from(layout.values()).find(p => p.pane === args.pane) : layout.get(address);
        if (!p) return error('no such pane'); focused = p; return ok;
      }
      if (name === 'terminal.park') { layout.delete(address); return { pending: true, terminal: address }; }
      if (name === 'terminal.keep') {
        const existing = layout.get(address); if (existing) { focused = existing; return { pane: existing.pane }; }
        if (!address || (await h.hc.get(address)).state !== 'live') return error(`no running terminal ${JSON.stringify(address ?? '')}`);
        if (address.includes('/')) return error("A terminal's pane must stay on its own machine.");
        if (args.place !== undefined && args.place !== 'tab') return error('terminal.keep needs place tab');
        const p = { ...focused, tab: `kept-${++kept}` as OwnerPlacement['tab'], pane: `pane-${address}` as PaneId };
        layout.set(address, p); focused = p; return { pending: true, terminal: address, pane: p.pane, tab: p.tab };
      }
      if (name === 'tab.rename') {
        const id = typeof args.id === 'string' ? args.id : focused.tab;
        if (typeof args.name !== 'string') return error('tab.rename needs name (empty: its number)');
        if (!Array.from(layout.values()).some(p => p.tab === id)) return error(`no tab ${JSON.stringify(id)}`);
        tabNames.set(id, args.name.trim()); return ok;
      }
      return error(`unknown command ${JSON.stringify(name)}: see \`herdr-app commands\`; a mod's are <mod>.<command> and need the mod loaded`);
    },
  };
  const launcher = createViewerLauncher({ hc: h.hc, owner: () => owner, viewerExecutable: executable, feedRoot: h.root,
    ipcDescriptor: () => ({ version: 1, sessionId: owner.sessionId, generation: owner.generation, address: join(h.root, 'ipc.sock'), capabilityFile: join(h.root, 'ipc.cap') }) });
  const panes = createAuxiliaryPanes({ automaticSubagentPanes: true, hc: h.hc, app, subagentViewer: launcher, discardSubagentViewer: launcher.discard, limit, clock: Date.now, reportError: error => errors.push(error) });
  return { h, owner, layout, panes, launcher, errors, failDisplay: () => { failDisplay = true; }, failRemoval: () => { failRemoval = true; },
    async close() { await panes.dispose(); await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); },
  };
}

test.each(modes)('%s: two finished viewers release their slots so a third automatic viewer is displayed', async mode => {
  const f = await fixture(2, mode);
  try {
    const first = (await f.panes.acquire('subagent', ids[0], f.owner, { timeoutMs: 1000, automatic: true }))!;
    const second = (await f.panes.acquire('subagent', ids[1], f.owner, { timeoutMs: 1000, automatic: true }))!;
    for (const view of [first.viewer, second.viewer]) { f.layout.delete(view); await f.h.hc.kill(view); }
    await expect.poll(async () => Promise.all([first.viewer, second.viewer].map(view => f.h.hc.get(view).then(() => 'present', error => error.code)))).toEqual(['not_found', 'not_found']);
    const third = await f.panes.acquire('subagent', ids[2], f.owner, { timeoutMs: 1000, automatic: true });
    expect(third).not.toBeNull(); expect(f.layout.has(third!.viewer)).toBe(true); expect(f.layout.size).toBe(2);
  } finally { await f.close(); }
}, 15000);

test.each(modes)('%s: a user-closed viewer can be explicitly reopened without conflicting with its old reservation', async mode => {
  const f = await fixture(1, mode);
  try {
    const first = (await f.panes.acquire('subagent', ids[0], f.owner, { timeoutMs: 1000 }))!;
    f.layout.delete(first.viewer); await f.h.hc.kill(first.viewer);
    await expect.poll(async () => f.h.hc.get(first.viewer).then(() => 'present', error => error.code)).toBe('not_found');
    const next = (await f.panes.acquire('subagent', ids[0], f.owner, { timeoutMs: 1000 }))!;
    expect(next.viewer).not.toBe(first.viewer); expect(await f.launcher(ids[0], f.owner)).toBe(next.viewer);
    expect((await f.h.hc.get(next.viewer)).state).toBe('live'); expect(f.layout.has(next.viewer)).toBe(true);
  } finally { await f.close(); }
}, 15000);

test.each(modes)('%s: a failed viewer display may be retried with a live replacement', async mode => {
  const f = await fixture(1, mode);
  try {
    f.failDisplay(); await expect(f.panes.acquire('subagent', ids[0], f.owner, { timeoutMs: 1000 })).rejects.toMatchObject({ code: 'pane-timeout' });
    const next = (await f.panes.acquire('subagent', ids[0], f.owner, { timeoutMs: 1000 }))!;
    expect((await f.h.hc.get(next.viewer)).state).toBe('live'); expect(await f.launcher(ids[0], f.owner)).toBe(next.viewer);
    expect(f.layout.has(next.viewer)).toBe(true);
  } finally { await f.close(); }
}, 15000);

test.each(modes)('%s: a transient app error on native removal is retried by the next display instead of wedging the slot', async mode => {
  const f = await fixture(1, mode);
  try {
    const first = (await f.panes.acquire('subagent', ids[0], f.owner, { timeoutMs: 1000 }))!;
    f.layout.delete(first.viewer); f.failRemoval(); await f.h.hc.kill(first.viewer); await f.h.hc.rm(first.viewer);
    await expect.poll(() => f.errors.length).toBe(1);
    const next = await f.panes.acquire('subagent', ids[1], f.owner, { timeoutMs: 1000 });
    expect(next).not.toBeNull(); expect(f.layout.has(next!.viewer)).toBe(true); expect(f.layout.size).toBe(2);
  } finally { await f.close(); }
}, 15000);
