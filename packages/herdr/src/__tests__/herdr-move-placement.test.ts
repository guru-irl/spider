// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, it } from 'vitest';
import { createAuxiliaryPanes } from '../jobs/placement.js';
import type { AppClient, HcClient, HcEvent, JobId, Owner, OwnerPlacement, RunId, TerminalAddress } from '../contracts.js';

it('counts moved and hidden viewers in their actual tabs without moving them back', async () => {
  const owner = { sessionId: 'owner', generation: 'gen', terminal: { coreId: 'core', terminalId: 'parent', address: 'parent', socket: '/fixture/core.sock', sessionNamespace: 'fixture' }, cwd: '/fixture', sessionFile: null, name: null } as Owner;
  const places = new Map<string, OwnerPlacement>([
    ['parent', { space: 's1', tab: 'source', pane: 'parent-pane' } as OwnerPlacement],
    ['anchor', { space: 's1', tab: 'target', pane: 'target-pane' } as OwnerPlacement],
  ]);
  let focused = 'parent-pane';
  const app: AppClient = {
    tabTerminals: async placement => [...places.entries()].filter(([, p]) => p.space === placement.space && p.tab === placement.tab).map(([address]) => address as TerminalAddress),
    ownerPlacement: async address => { const p = places.get(address); if (!p) throw Object.assign(new Error('unplaced'), { code: 'owner-unplaced' }); return p; },
    awaitPane: async (address, placement) => { const p = { ...placement, pane: `pane-${address}` as never }; places.set(address, p); return p.pane; },
    command: async (name, args) => {
      if (name === 'pane.focus') {
        focused = args.pane as string ?? places.get(args.terminal as string)?.pane ?? '';
        if (!focused) return { error: { code: 'no-pane', message: 'No pane' } };
      } else if (name === 'terminal.park') places.delete(args.terminal as string);
      else if (name === 'terminal.keep') {
        const anchor = [...places.values()].find(p => p.pane === focused)!;
        places.set(args.terminal as string, { ...anchor, pane: `pane-${args.terminal}` as never });
      }
      return {};
    },
  };
  app.tabSpace = async tab => [...places.values()].find(p => p.tab === tab)?.space ?? null;
  let emit: ((event: HcEvent) => void) | undefined;
  const hc = {
    get: async (address: TerminalAddress) => ({ address, labels: address === 'observer-job' ? { 'spider.kind': 'remote-observer', 'spider.job': 'job', 'spider.session': 'owner', 'spider.owner-core': 'core', 'spider.owner-terminal': 'parent' } : address.startsWith('viewer-') ? { 'spider.kind': 'subagent-viewer', 'spider.run': address.slice('viewer-'.length), 'spider.session': 'owner', 'spider.owner-core': 'core', 'spider.owner-terminal': 'parent' } : {}, state: 'live', parent: address.startsWith('viewer-') ? owner.terminal.address : null, status: null, exitCode: null, reason: null, signal: null, finishedAt: null }),
    kill: async () => {}, rm: async () => {},
    setLabels: async (address: string, labels: Record<string, string>) => {
      places.set(address, { space: labels['herdr.space'], tab: labels['herdr.tab'], pane: `pane-${address}` } as OwnerPlacement);
    },
    events: () => ({ ready: Promise.resolve(), subscribe: (listener: (event: HcEvent) => void) => { emit = listener; return () => {}; }, lookup: async () => null, dispose: async () => {} }),
  } as unknown as HcClient;
  const panes = createAuxiliaryPanes({ hc, app, limit: 1, automaticSubagentPanes: true, clock: Date.now, subagentViewer: async id => `viewer-${id}` as TerminalAddress, remoteObserver: async id => `observer-${id}` as TerminalAddress, discardSubagentViewer: async () => {} });
  try {
    const first = await panes.acquire('subagent', 'a' as RunId, owner, { timeoutMs: 2000 });
    expect(first?.viewer).toBe('viewer-a');
    expect((panes as any).moveRun).toBeTypeOf('function');
    places.set('remote-anchor', { space: 'alpha/space', tab: 'alpha/tab', pane: 'alpha/pane' } as OwnerPlacement);
    await expect((panes as any).moveRun('a' as RunId, owner, { kind: 'tab', tab: 'alpha/tab' }, { timeoutMs: 2000 })).rejects.toMatchObject({ code: 'unavailable' });
    expect(places.get('viewer-a')?.tab).toBe('source');
    await (panes as any).moveRun('a' as RunId, owner, { kind: 'tab', tab: 'target' }, { timeoutMs: 2000 });
    expect(places.get('viewer-a')).toMatchObject({ tab: 'target', pane: 'pane-viewer-a' });
    const second = await panes.acquire('subagent', 'b' as RunId, owner, { timeoutMs: 2000, automatic: true });
    expect(second?.viewer).toBe('viewer-b');
    expect(places.get('viewer-b')?.tab).toBe('source');
    await panes.acquire('subagent', 'a' as RunId, owner, { timeoutMs: 2000 });
    expect(places.get('viewer-a')?.tab).toBe('target');
    await (panes as any).moveRun('a' as RunId, owner, { kind: 'hide' }, { timeoutMs: 2000 });
    expect(places.has('viewer-a')).toBe(false);
    await panes.park('b' as RunId);
    const reopened = await panes.acquire('subagent', 'a' as RunId, owner, { timeoutMs: 2000 });
    expect(reopened?.viewer).toBe('viewer-a');
    expect(places.get('viewer-a')?.tab).toBe('source');
    await panes.park('a' as RunId);
    const observer = await panes.acquire('remote', 'job' as JobId, owner, { timeoutMs: 2000 });
    expect(observer?.viewer).toBe('observer-job');
    expect((panes as any).moveJob).toBeTypeOf('function');
    await (panes as any).moveJob('job' as JobId, owner, observer!.viewer, { kind: 'tab', tab: 'target' }, { timeoutMs: 2000 });
    expect(places.get('observer-job')?.tab).toBe('target');
    await expect((panes as any).moveJob('job' as JobId, owner, 'foreign' as TerminalAddress, { kind: 'tab', tab: 'source' }, { timeoutMs: 2000 })).rejects.toMatchObject({ code: 'pane-not-owned' });
    places.set('viewer-c', { space: 's1', tab: 'source', pane: 'pane-viewer-c' } as OwnerPlacement);
    emit?.({ type: 'created', seq: 1, terminal: 'viewer-c' as TerminalAddress, data: await hc.get('viewer-c' as TerminalAddress) });
    await panes.moveRun('c' as RunId, owner, { kind: 'hide' }, { timeoutMs: 2000 });
    expect(places.has('viewer-c')).toBe(false);
  } finally { await panes.dispose(); }
});
