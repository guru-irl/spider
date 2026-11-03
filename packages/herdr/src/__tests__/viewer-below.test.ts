// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { createAuxiliaryPanes } from '../jobs/placement.js';
import { HerdrError } from '../client/parse.js';
import type { AppClient, HcClient, Owner, OwnerPlacement, RunId, TerminalAddress } from '../contracts.js';

type Direction = 'right' | 'down';
type Pane = { id: string; terminal: string | null; tab: string; space: string; right?: string; down?: string };
function fixture(cols = 320, rows = 80) {
  const owner = { sessionId: 'owner-session', generation: 'generation', terminal: { coreId: 'core', terminalId: 'owner', address: 'owner', socket: '/fixture/core.sock', sessionNamespace: 'fixture' }, cwd: '/fixture', sessionFile: null, name: null } as Owner;
  const panes = new Map<string, Pane>([
    ['owner-pane', { id: 'owner-pane', terminal: 'owner', tab: 'owner-tab', space: 'space', right: 'other-pane' }],
    ['other-pane', { id: 'other-pane', terminal: 'other', tab: 'owner-tab', space: 'space' }],
    ['foreign-pane', { id: 'foreign-pane', terminal: 'foreign', tab: 'foreign-tab', space: 'space' }],
  ]);
  const tabs = ['owner-tab', 'foreign-tab'];
  const sizes = new Map<string, { cols: number; rows: number }>([['owner', { cols, rows }], ['other', { cols: 200, rows: 60 }], ['foreign', { cols: 200, rows: 60 }]]);
  const labels = new Map<string, Record<string, string>>([
    ['owner', { 'spider.kind': 'session' }], ['other', { 'spider.kind': 'session' }], ['foreign', { 'spider.kind': 'session' }],
  ]);
  const operations: { name: string; args: Readonly<Record<string, unknown>> }[] = [];
  let focused = 'foreign-pane', next = 0, mismatch: 'before' | 'after' | 'same-tab' | null = null;
  const placement = (terminal: string): OwnerPlacement => {
    const pane = [...panes.values()].find(p => p.terminal === terminal);
    if (!pane) throw new HerdrError('owner-unplaced', 'Terminal is parked');
    return { pane: pane.id, tab: pane.tab, space: pane.space } as OwnerPlacement;
  };
  const remove = (terminal: string) => {
    const pane = [...panes.values()].find(p => p.terminal === terminal);
    if (!pane) return;
    for (const p of panes.values()) { if (p.right === pane.id) delete p.right; if (p.down === pane.id) delete p.down; }
    panes.delete(pane.id);
  };
  const app = {
    tabTerminals: async (target: OwnerPlacement) => [...panes.values()].filter(p => p.space === target.space && p.tab === target.tab && p.terminal).map(p => p.terminal as TerminalAddress),
    tabPanes: async (target: OwnerPlacement) => [...panes.values()].filter(p => p.space === target.space && p.tab === target.tab && p.terminal).map(p => ({ pane: p.id, terminal: p.terminal })),
    tabIndex: async (target: OwnerPlacement) => tabs.indexOf(target.tab) + 1,
    focusedPane: async () => {
      if (mismatch === 'before') { mismatch = null; focused = 'foreign-pane'; }
      const p = panes.get(focused)!; return { space: p.space, tab: p.tab, pane: p.id };
    },
    ownerPlacement: async (terminal: TerminalAddress) => placement(terminal),
    awaitPane: async (terminal: TerminalAddress, target: OwnerPlacement) => {
      let p = [...panes.values()].find(p => p.terminal === terminal);
      if (!p) { p = { id: `pane-${terminal}`, terminal, tab: target.tab, space: target.space }; panes.set(p.id, p); }
      if (p.tab !== target.tab || p.space !== target.space) throw new HerdrError('pane-timeout', 'Wrong tab');
      return p.id as OwnerPlacement['pane'];
    },
    command: async (name: string, args: Readonly<Record<string, unknown>>) => {
      operations.push({ name, args });
      if (name === 'pane.focus') {
        const p = typeof args.pane === 'string' ? panes.get(args.pane) : [...panes.values()].find(p => p.terminal === args.terminal);
        if (!p) return { error: { code: 'app-error', message: 'No pane' } };
        focused = p.id; return {};
      }
      if (name === 'pane.go') {
        const nextPane = panes.get(focused)?.[args.direction as Direction];
        if (nextPane) focused = nextPane;
        return {};
      }
      if (name === 'terminal.park') { remove(String(args.terminal)); return { pending: true }; }
      if (name === 'terminal.keep') {
        if (mismatch === 'after' || mismatch === 'same-tab') { focused = mismatch === 'after' ? 'foreign-pane' : 'other-pane'; mismatch = null; }
        const anchor = panes.get(focused)!, terminal = String(args.terminal), id = `pane-${terminal}`;
        if (args.place === 'right' || args.place === 'down') {
          const direction = args.place as Direction;
          const p = { id, terminal, tab: anchor.tab, space: anchor.space };
          panes.set(id, p); anchor[direction] = id;
          const size = sizes.get(anchor.terminal!)!;
          const nextSize = { ...size };
          if (direction === 'down') nextSize.rows = Math.floor(size.rows / 2);
          else nextSize.cols = Math.floor(size.cols / 2);
          sizes.set(anchor.terminal!, nextSize); sizes.set(terminal, { ...nextSize });
        } else {
          const tab = `tab-${++next}`; tabs.push(tab); panes.set(id, { id, terminal, tab, space: anchor.space });
        }
        focused = id; return { pending: true, pane: id, tab: panes.get(id)!.tab };
      }
      if (name === 'tab.new') {
        const tab = `tab-${++next}`, id = `placeholder-${next}`;
        tabs.push(tab); panes.set(id, { id, terminal: null, tab, space: String(args.space) }); focused = id;
        return { tab, pane: id, space: args.space };
      }
      if (name === 'tab.move') {
        const at = tabs.indexOf(String(args.id)); if (at < 0) return { error: { code: 'app-error', message: 'No tab' } };
        tabs.splice(at, 1); tabs.splice(Number(args.index) - 1, 0, String(args.id)); return {};
      }
      if (name === 'pane.close') { panes.delete(String(args.pane)); return {}; }
      if (name === 'tab.rename') return {};
      return { error: { code: 'app-error', message: `Unknown command ${name}` } };
    },
  } as unknown as AppClient;
  const hc = {
    get: async (address: TerminalAddress) => ({ address, parent: null, labels: labels.get(address) ?? {}, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null, ...sizes.get(address) }),
    setLabels: async (address: TerminalAddress, patch: Record<string, string>) => {
      labels.set(address, { ...labels.get(address), ...patch });
      if (patch['herdr.tab']) {
        const target = [...panes.values()].find(p => p.tab === patch['herdr.tab']);
        if (target && ![...panes.values()].some(p => p.terminal === address)) panes.set(`pane-${address}`, { id: `pane-${address}`, terminal: address, tab: target.tab, space: target.space });
      }
    },
    events: () => ({ ready: Promise.resolve(), subscribe: () => () => {}, lookup: async () => null, dispose: async () => {} }),
  } as unknown as HcClient;
  const actor = createAuxiliaryPanes({ hc, app, clock: Date.now, subagentViewer: async (run, o) => {
    const address = `viewer-${run}` as TerminalAddress;
    labels.set(address, { 'spider.kind': 'subagent-viewer', 'spider.session': o.sessionId, 'spider.owner-core': o.terminal.coreId, 'spider.owner-terminal': o.terminal.terminalId, 'spider.run': run });
    return address;
  }, discardSubagentViewer: async () => {} });
  return { owner, panes, tabs, sizes, operations, actor, placement, get focused() { return focused; }, focusOther() { focused = 'foreign-pane'; }, mismatch(value: 'before' | 'after' | 'same-tab') { mismatch = value; }, open: (id: string) => actor.acquire('subagent', id as RunId, owner, { timeoutMs: 1000, ownerRelative: true }) };
}

test('opens the first viewer below the owning session without changing another session', async () => {
  const f = fixture();
  const view = await f.open('one');
  expect(f.panes.get('owner-pane')?.down).toBe(view?.pane);
  expect(f.placement('other')).toEqual({ space: 'space', tab: 'owner-tab', pane: 'other-pane' });
  expect(f.placement('foreign')).toEqual({ space: 'space', tab: 'foreign-tab', pane: 'foreign-pane' });
  expect(f.focused).toBe(view?.pane);
});

test('opens the second viewer to the right of the first', async () => {
  const f = fixture(); const first = await f.open('one'); const second = await f.open('two');
  expect(f.panes.get('owner-pane')?.down).toBe(first?.pane);
  expect(f.panes.get(first!.pane)?.right).toBe(second?.pane);
  expect(f.placement('other').pane).toBe('other-pane');
});

test.each([[79, 80], [80, 39]])('falls back after the owner tab when a downward split is too small (%i by %i)', async (cols, rows) => {
  const f = fixture(cols, rows); const view = await f.open('one');
  expect(f.placement(view!.viewer).tab).toBe(f.tabs[1]);
  expect(f.tabs).toEqual(['owner-tab', f.placement(view!.viewer).tab, 'foreign-tab']);
  expect(f.panes.get('owner-pane')?.down).toBeUndefined();
});

test('accepts a downward split at exactly 80 columns and 40 rows', async () => {
  const f = fixture(80, 40); const view = await f.open('one');
  expect(f.panes.get('owner-pane')?.down).toBe(view?.pane);
});

test.each([[159, 20], [160, 19]])('falls back when a sideways split is too small (%i by %i)', async (cols, rows) => {
  const f = fixture(); const first = await f.open('one'); f.sizes.set(first!.viewer, { cols, rows }); const second = await f.open('two');
  expect(f.placement(second!.viewer).tab).toBe(f.tabs[1]);
  expect(f.panes.get(first!.pane)?.right).toBeUndefined();
  expect(f.tabs).toEqual(['owner-tab', f.placement(second!.viewer).tab, 'foreign-tab']);
});

test('accepts a sideways split at exactly 160 columns and 20 rows', async () => {
  const f = fixture(); const first = await f.open('one'); f.sizes.set(first!.viewer, { cols: 160, rows: 20 }); const second = await f.open('two');
  expect(f.panes.get(first!.pane)?.right).toBe(second?.pane);
});

test('does not split a viewer when the owner is already below the minimum', async () => {
  const f = fixture(); const first = await f.open('one');
  f.sizes.set('owner', { cols: 320, rows: 19 });
  const second = await f.open('two');
  expect(f.placement(second!.viewer).tab).not.toBe('owner-tab');
  expect(f.panes.get(first!.pane)?.right).toBeUndefined();
});

test('does not split when another viewer would remain below the minimum', async () => {
  const f = fixture(); const first = await f.open('one'); const second = await f.open('two');
  f.sizes.set(first!.viewer, { cols: 79, rows: 40 });
  const third = await f.open('three');
  expect(f.placement(third!.viewer).tab).not.toBe('owner-tab');
  expect(f.panes.get(second!.pane)?.right).toBeUndefined();
});

test('focuses an already open viewer instead of splitting it again', async () => {
  const f = fixture(); const first = await f.open('one');
  expect(f.panes.get('owner-pane')?.down).toBe(first?.pane);
  f.focusOther();
  const again = await f.open('one');
  expect(again?.pane).toBe(first?.pane); expect(f.focused).toBe(first?.pane);
  expect([...f.panes.values()].filter(p => p.terminal === first?.viewer)).toHaveLength(1);
});

test('parks a viewer split beside another session in the same tab before falling back', async () => {
  const f = fixture(); f.mismatch('same-tab'); const view = await f.open('one');
  expect(f.placement(view!.viewer).tab).not.toBe('owner-tab');
  expect(f.panes.get('other-pane')?.down).toBeUndefined();
  expect(f.placement('other').pane).toBe('other-pane');
  expect(f.operations.filter(call => call.name === 'terminal.park').map(call => call.args.terminal)).toEqual([view!.viewer]);
});

test.each(['before', 'after'] as const)('uses the owner tab fallback when focus changes %s the split', async when => {
  const f = fixture(); f.mismatch(when); const view = await f.open('one');
  expect(f.placement(view!.viewer).space).toBe('space');
  expect(f.tabs).toEqual(['owner-tab', f.placement(view!.viewer).tab, 'foreign-tab']);
  expect(f.placement(view!.viewer).tab).not.toBe('foreign-tab');
  expect(f.panes.get('foreign-pane')?.down).toBeUndefined();
  expect(f.placement('foreign').pane).toBe('foreign-pane');
});
