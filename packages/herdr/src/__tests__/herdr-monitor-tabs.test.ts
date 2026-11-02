// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import { createAuxiliaryPanes } from '../jobs/placement.js';
import { openRemoteObserver, observerMarker } from '../jobs/observer.js';
import type { JobRecord } from '../contracts.js';
import { HERDR_KINDS, HERDR_LABELS, type AppClient, type OwnerPlacement, type TerminalAddress } from '../contracts.js';
import { cleanup, monitorFixture } from './herdr-monitor-fixture.js';

async function fixture() {
  const h = await monitorFixture(), ownerPlacement = { space: 'space', tab: 'main-tab', pane: 'main-pane' } as OwnerPlacement;
  const placements = new Map<TerminalAddress, OwnerPlacement>([[h.owner.terminal.address, ownerPlacement]]);
  const commands: { name: string; args: Readonly<Record<string, unknown>> }[] = [], tabNames = new Map<string, string>();
  const kill = h.hc.kill; h.hc.kill = async address => { await kill(address); placements.delete(address); };
  let tab = 0, next = 0, observer: (() => Promise<TerminalAddress>) | undefined;
  h.hc.run = async request => { const address = `aux-${++next}` as TerminalAddress; h.terminals.set(address, { address, parent: null, labels: request.labels, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null }); return { address, coreId: h.owner.terminal.coreId }; };
  const app: AppClient = {
    tabTerminals: async target => [...placements].filter(([, p]) => p.space === target.space && p.tab === target.tab).map(([address]) => address), ownerPlacement: async address => { const p = placements.get(address); if (!p) throw Object.assign(new Error('unplaced'), { code: 'owner-unplaced' }); return p; },
    awaitPane: async (address, p) => { placements.set(address, { ...p, pane: `pane-${address}` as never }); return `pane-${address}` as never; },
    command: async (name, args) => {
      commands.push({ name, args }); const address = args.terminal as TerminalAddress;
      if (name === 'terminal.keep') {
        expect(args.place).toBe('tab'); expect(h.terminals.get(address)?.state).toBe('live');
        const p = { ...ownerPlacement, tab: `extra-${++tab}` as never, pane: `pane-${address}` as never }; placements.set(address, p);
        return { tab: p.tab, pane: p.pane, terminal: address, pending: true };
      }
      if (name === 'tab.rename') { if (!Array.from(placements.values()).some(p => p.tab === args.id) || typeof args.name !== 'string') throw new Error('No tab to rename'); tabNames.set(String(args.id), args.name.trim()); return {}; }
      if (name === 'pane.focus') { if (!placements.has(address)) throw new Error('Cannot focus an absent pane'); return {}; }
      if (name === 'terminal.park') { placements.delete(address); return {}; }
      throw new Error(`Unsupported app command ${name}`);
    },
  };
  const launch = async (kind: string) => (await h.hc.run({ argv: [], cwd: null, labels: { [HERDR_LABELS.kind]: kind, [HERDR_LABELS.session]: h.owner.sessionId, [HERDR_LABELS.ownerCore]: h.owner.terminal.coreId, [HERDR_LABELS.ownerTerminal]: h.owner.terminal.terminalId, 'spider.display-name': `Readable ${kind}` }, background: true, outliveParent: true, noNotify: true })).address;
  const panes = createAuxiliaryPanes({ automaticSubagentPanes: true, hc: h.hc, discardSubagentViewer: async (_id, _owner, viewer) => { await h.hc.kill(viewer); await h.hc.rm(viewer); }, app, limit: 1, clock: Date.now, subagentViewer: () => launch(HERDR_KINDS.subagentViewer), remoteObserver: async () => { if (!observer) throw new Error('No observer configured'); return observer(); } }); cleanup(() => panes.dispose());
  return { ...h, app, panes, placements, ownerPlacement, commands, tabNames, launch, observer: (open: () => Promise<TerminalAddress>) => { observer = open; } };
}

it('an observer new-tab fallback is acknowledged and remains live', async () => {
  const h = await fixture();
  const first = await h.panes.acquire('subagent', 'first' as never, h.owner, { timeoutMs: 1000, automatic: true });
  expect(first).not.toBeNull();
  const original = await h.launch(HERDR_KINDS.exec);
  const job: JobRecord = { version: 1, id: 'job-one' as never, owner: h.owner, machine: 'remote.invalid' as never, kind: 'exec', phase: { kind: 'waiting-for-pane', address: original }, viewer: null, localDirectory: h.f.root, remoteDirectory: '/runtime', detached: false, notice: 'pending', noticeMode: 'tool' };
  h.hc.read = async () => observerMarker('nonce');
  h.observer(async () => (await openRemoteObserver(job, { hc: h.hc, app: h.app, panes: h.panes, viewerExecutable: ['viewer.mjs'], hcBinary: 'hc', nonce: 'nonce', deadlineAt: Date.now() + 1000, clock: Date.now })).viewer);
  const opened = await h.panes.acquire('remote', job.id, h.owner, { timeoutMs: 1000 });
  expect(h.placements.get(opened!.viewer)?.tab).toBe('extra-1');
  expect(h.tabNames.get('extra-1')).toBe('remote.invalid · exec');
  expect(h.terminals.get(opened!.viewer)?.state).toBe('live'); expect(h.kills).toEqual([]);
});

it('an in-grid observer landing in an unexpected tab still fails without killing the original', async () => {
  const h = await fixture(), original = await h.launch(HERDR_KINDS.exec);
  const awaitPane = h.app.awaitPane;
  h.app.awaitPane = async (viewer, placement, options) => { const pane = await awaitPane(viewer, placement, options); h.placements.set(viewer, { ...placement, tab: 'wrong-tab' as never, pane }); return pane; };
  const job: JobRecord = { version: 1, id: 'job-one' as never, owner: h.owner, machine: 'remote.invalid' as never, kind: 'exec', phase: { kind: 'waiting-for-pane', address: original }, viewer: null, localDirectory: h.f.root, remoteDirectory: '/runtime', detached: false, notice: 'pending', noticeMode: 'tool' };
  h.hc.read = async () => observerMarker('nonce');
  await expect(openRemoteObserver(job, { hc: h.hc, app: h.app, panes: h.panes, viewerExecutable: ['viewer.mjs'], hcBinary: 'hc', nonce: 'nonce', deadlineAt: Date.now() + 1000, clock: Date.now })).rejects.toMatchObject({ code: 'observer-unplaced' });
  expect(h.terminals.get(original)?.state).toBe('live'); expect(h.kills).not.toContain(original);
});

it('an explicit open focuses an existing pane in any tab without moving it', async () => {
  const h = await fixture(), viewer = await h.launch(HERDR_KINDS.remoteObserver);
  const existing = { ...h.ownerPlacement, tab: 'another-tab' as never, pane: 'existing-pane' as never }; h.placements.set(viewer, existing);
  const slot = await h.panes.reserveRemote('job' as never, h.owner, { timeoutMs: 1000 });
  await h.panes.display(slot, viewer, { timeoutMs: 1000, userInitiated: true });
  expect(h.placements.get(viewer)).toEqual(existing);
  expect(h.commands).toEqual([{ name: 'pane.focus', args: { terminal: viewer } }]);
});

it('an explicit open uses a free aux slot and focuses it without making a tab', async () => {
  const h = await fixture(), viewer = await h.launch(HERDR_KINDS.remoteObserver);
  const slot = await h.panes.reserveRemote('job' as never, h.owner, { timeoutMs: 1000 });
  await h.panes.display(slot, viewer, { timeoutMs: 1000, userInitiated: true });
  expect(h.placements.get(viewer)?.tab).toBe('main-tab');
  expect(h.commands).toEqual([{ name: 'pane.focus', args: { terminal: viewer } }]);
});

it.each([HERDR_KINDS.remoteObserver, HERDR_KINDS.remoteConsole, HERDR_KINDS.subagentViewer])('an explicit %s open uses its own tab when full; closing it never kills the original', async kind => {
  const h = await fixture(), mainViewer = await h.launch(HERDR_KINDS.subagentViewer), original = await h.launch(HERDR_KINDS.exec);
  const first = await h.panes.reserveRemote('first' as never, h.owner, { timeoutMs: 1000 }); await h.panes.display(first, mainViewer, { timeoutMs: 1000 });
  const extra = await h.launch(kind), slot = await h.panes.reserveRemote('extra' as never, h.owner, { timeoutMs: 1000 });
  await h.panes.display(slot, extra, { timeoutMs: 1000, userInitiated: true });
  expect(h.placements.get(extra)?.tab).toBe('extra-1');
  expect(h.placements.get(mainViewer)?.tab).toBe('main-tab');
  expect(h.placements.get(h.owner.terminal.address)).toEqual(h.ownerPlacement);
  expect(h.commands.map(command => command.name)).toEqual(['terminal.keep', 'tab.rename', 'pane.focus']);
  expect(h.commands[1]).toEqual({ name: 'tab.rename', args: { id: 'extra-1', name: `Readable ${kind}` } });
  expect(h.tabNames.get('extra-1')).toBe(`Readable ${kind}`);
  h.placements.delete(extra); h.complete(extra);
  expect(h.terminals.get(extra)?.state ?? 'finished').toBe('finished');
  expect(h.terminals.get(original)?.state).toBe('live'); expect(h.kills).toEqual([]);
});
