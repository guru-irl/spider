// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createClientFixture } from './testutil.js';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readPlacementRepairs } from '../jobs/placement-repairs.js';
import { expect, test } from 'vitest';
import { startSessionEndpoint } from '../feed/ipc-server.js';
import { createSessionIpcClient } from '../feed/ipc-client.js';
import { paneTree, paneOrder, splitPane, removePane, paneBounds, navigatePane, type PaneTree } from '../../e2e/harness/pane-geometry.js';
import { createAuxiliaryPanes, type AuxiliaryPaneOptions } from '../jobs/placement.js';
import { HerdrError } from '../client/parse.js';
import type { AppClient, AppPaneInspection, HcClient, Owner, OwnerPlacement, RunId, TerminalAddress } from '../contracts.js';

type Direction = 'right' | 'down';
type Pane = { id: string; terminal: string | null; tab: string; space: string };
function fixture(cols = 320, rows = 80) {
  const owner = { sessionId: 'owner-session', generation: 'generation', terminal: { coreId: 'core', terminalId: 'owner', address: 'owner', socket: '/fixture/core.sock', sessionNamespace: 'fixture' }, cwd: '/fixture', sessionFile: null, name: null } as Owner;
  const panes = new Map<string, Pane>([
    ['owner-pane', { id: 'owner-pane', terminal: 'owner', tab: 'owner-tab', space: 'space' }],
    ['other-pane', { id: 'other-pane', terminal: 'other', tab: 'owner-tab', space: 'space' }],
    ['foreign-pane', { id: 'foreign-pane', terminal: 'foreign', tab: 'foreign-tab', space: 'space' }],
  ]);
  const tabs = ['owner-tab', 'foreign-tab'];
  const trees = new Map<string, PaneTree>([['owner-tab', paneTree(['owner-pane', 'other-pane'])], ['foreign-tab', paneTree(['foreign-pane'])]]);
  const history: Record<string, number> = {}; let tick = 0;
  const tree = (tab: string) => {
    let root = trees.get(tab) ?? paneTree([...panes.values()].filter(p => p.tab === tab).map(p => p.id));
    for (const id of paneOrder(root)) if (!panes.has(id)) root = removePane(root, id) ?? paneTree([]);
    trees.set(tab, root); return root;
  };
  const ordered = (tab: string) => paneOrder(tree(tab)).flatMap(id => panes.has(id) ? [panes.get(id)!] : []);
  const neighbor = (pane: string, direction: Direction) => { const p = panes.get(pane); if (!p) return undefined; const next = navigatePane(tree(p.tab), pane, direction, history); return next === pane ? undefined : next; };
  const bounds = (pane: string) => paneBounds(tree(panes.get(pane)!.tab)).find(row => row.id === pane)!;
  const sizes = new Map<string, { cols: number; rows: number }>([['owner', { cols, rows }], ['other', { cols: 200, rows: 60 }], ['foreign', { cols: 200, rows: 60 }]]);
  const labels = new Map<string, Record<string, string>>([
    ['owner', { 'spider.kind': 'session' }], ['other', { 'spider.kind': 'session' }], ['foreign', { 'spider.kind': 'session' }],
  ]);
  const operations: { name: string; args: Readonly<Record<string, unknown>> }[] = [];
  let parkFailures = 0, failMove = false, insertBeforeOwner = false;
  let focused = 'foreign-pane', next = 0, mismatch: 'post-check' | 'after' | 'same-tab' | null = null;
  const placement = (terminal: string): OwnerPlacement => {
    const pane = [...panes.values()].find(p => p.terminal === terminal);
    if (!pane) throw new HerdrError('owner-unplaced', 'Terminal is parked');
    return { pane: pane.id, tab: pane.tab, space: pane.space } as OwnerPlacement;
  };
  const remove = (terminal: string) => {
    const pane = [...panes.values()].find(p => p.terminal === terminal);
    if (!pane) return;
    trees.set(pane.tab, removePane(tree(pane.tab), pane.id) ?? paneTree([]));
    panes.delete(pane.id);
  };
  const app = {
    tabTerminals: async (target: OwnerPlacement) => ordered(target.tab).filter(p => p.space === target.space && p.terminal).map(p => p.terminal as TerminalAddress),
    tabPanes: async (target: OwnerPlacement) => ordered(target.tab).filter(p => p.space === target.space && p.terminal).map(p => ({ pane: p.id, terminal: p.terminal })),
    tabIndex: async (target: OwnerPlacement) => tabs.indexOf(target.tab) + 1,
    focusedPane: async () => {
      if (mismatch === 'post-check') { mismatch = null; focused = 'foreign-pane'; }
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
        focused = p.id; history[p.id] = ++tick; return {};
      }
      if (name === 'pane.go') {
        const nextPane = neighbor(focused, args.direction as Direction);
        if (nextPane) { focused = nextPane; history[focused] = ++tick; }
        return {};
      }
      if (name === 'terminal.park' && parkFailures-- > 0) return { error: { code: 'app-error', message: 'park refused' } };
      if (name === 'terminal.park') { remove(String(args.terminal)); return { pending: true }; }
      if (name === 'terminal.keep') {
        if (mismatch === 'after' || mismatch === 'same-tab') { focused = mismatch === 'after' ? 'foreign-pane' : 'other-pane'; mismatch = null; }
        const anchor = panes.get(focused)!, terminal = String(args.terminal), id = `pane-${terminal}`;
        if (args.place === 'right' || args.place === 'down') {
          const direction = args.place as Direction;
          const p = { id, terminal, tab: anchor.tab, space: anchor.space };
          const lone = paneOrder(tree(anchor.tab)).length === 1;
          trees.set(anchor.tab, splitPane(tree(anchor.tab), anchor.id, id, direction)); panes.set(id, p);
          const size = sizes.get(anchor.terminal!)!;
          const nextSize = { ...size };
          if (direction === 'down') {
            if (lone) {
              const paneHeight = (size.rows * 17 - 6) / 2;
              nextSize.rows = Math.floor((paneHeight - 30 - 2) / 17);
              nextSize.cols = Math.floor((size.cols * 8 - 2) / 8);
            } else {
              const outerHeight = size.rows * 17 + 30 + 2;
              const paneHeight = (outerHeight - 6) / 2;
              nextSize.rows = Math.floor((paneHeight - 30 - 2) / 17);
            }
          }
          else {
            const outerWidth = size.cols * 8 + 2;
            const paneWidth = (outerWidth - 6) / 2;
            nextSize.cols = Math.floor((paneWidth - 2) / 8);
          }
          sizes.set(anchor.terminal!, nextSize); sizes.set(terminal, { ...nextSize });
        } else {
          const tab = `tab-${++next}`; tabs.push(tab); panes.set(id, { id, terminal, tab, space: anchor.space });
        }
        focused = id; return { pending: true, pane: id, tab: panes.get(id)!.tab };
      }
      if (name === 'tab.new') {
        const tab = `tab-${++next}`, id = `placeholder-${next}`;
        if (insertBeforeOwner) tabs.unshift(tab); else tabs.push(tab); panes.set(id, { id, terminal: null, tab, space: String(args.space) }); focused = id;
        return { tab, pane: id, space: args.space };
      }
      if (name === 'tab.move') {
        if (failMove) return { error: { code: 'app-error', message: 'move refused' } };
        const at = tabs.indexOf(String(args.id)); if (at < 0) return { error: { code: 'app-error', message: 'No tab' } };
        tabs.splice(at, 1); tabs.splice(Number(args.index) - 1, 0, String(args.id)); return {};
      }
      if (name === 'pane.close') { panes.delete(String(args.pane)); return {}; }
      if (name === 'tab.rename') return {};
      return { error: { code: 'app-error', message: `Unknown command ${name}` } };
    },
  } as unknown as AppClient & AppPaneInspection;
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
  const actorOptions: AuxiliaryPaneOptions = { hc, app, clock: Date.now, subagentViewer: async (run, o) => {
    const address = `viewer-${run}` as TerminalAddress;
    labels.set(address, { 'spider.kind': 'subagent-viewer', 'spider.session': o.sessionId, 'spider.owner-core': o.terminal.coreId, 'spider.owner-terminal': o.terminal.terminalId, 'spider.run': run });
    return address;
  }, discardSubagentViewer: async () => {} };
  const actor = createAuxiliaryPanes(actorOptions);
  const grid = () => {
    sizes.set('other', { cols, rows });
    for (const [pane, terminal] of [['lower-left', 'left-session'], ['lower-right', 'right-session']]) {
      panes.set(pane, { id: pane, terminal, tab: 'owner-tab', space: 'space' });
      sizes.set(terminal, { cols, rows });
      labels.set(terminal, { 'spider.kind': 'session' });
    }
    let root = splitPane(tree('owner-tab'), 'owner-pane', 'lower-left', 'down');
    root = splitPane(root, 'other-pane', 'lower-right', 'down');
    trees.set('owner-tab', root);
  };
  return { owner, panes, app, hc, neighbor, bounds, tree, remove, grid, actorOptions, parkFails(count: number) { parkFailures = count; }, failMove() { failMove = true; }, insertBeforeOwner() { insertBeforeOwner = true; }, tabs, sizes, operations, actor, placement, get focused() { return focused; }, focusOther() { focused = 'foreign-pane'; }, mismatch(value: 'post-check' | 'after' | 'same-tab') { mismatch = value; }, open: (id: string) => actor.acquire('subagent', id as RunId, owner, { timeoutMs: 1000, ownerRelative: true }) };
}

test.each([[104, 25], [75, 23]])('opens below an owner in a four-pane tab at %i by %i', async (cols, rows) => {
  const f = fixture(cols, rows); f.grid();
  const others = ['other', 'left-session', 'right-session'];
  const placements = others.map(terminal => f.placement(terminal));
  const view = await f.open('one');
  expect(f.placement(view!.viewer).tab).toBe('owner-tab');
  expect(f.neighbor('owner-pane', 'down')).toBe(view!.pane);
  for (const terminal of ['owner', view!.viewer, ...others]) {
    expect(f.sizes.get(terminal)!.cols).toBeGreaterThanOrEqual(60);
    expect(f.sizes.get(terminal)!.rows).toBeGreaterThanOrEqual(8);
  }
  expect(others.map(terminal => f.placement(terminal))).toEqual(placements);
  const tooShort = fixture(75, 18); tooShort.grid();
  const before = structuredClone(tooShort.tree('owner-tab'));
  const fallback = await tooShort.open('one');
  expect(tooShort.tabs).toEqual(['owner-tab', tooShort.placement(fallback!.viewer).tab, 'foreign-tab']);
  expect(tooShort.placement(fallback!.viewer).tab).not.toBe('owner-tab');
  expect(tooShort.tree('owner-tab')).toEqual(before);
});

test('opens the first viewer below the owning session without changing another session', async () => {
  const f = fixture();
  const view = await f.open('one');
  expect(f.neighbor('owner-pane', 'down')).toBe(view?.pane);
  expect(f.placement('other')).toEqual({ space: 'space', tab: 'owner-tab', pane: 'other-pane' });
  expect(f.placement('foreign')).toEqual({ space: 'space', tab: 'foreign-tab', pane: 'foreign-pane' });
  expect(f.focused).toBe(view?.pane);
  expect(f.bounds(view!.pane)).toMatchObject({ x: 0, y: 0.5, width: 0.5, height: 0.5 });
  expect(f.bounds('owner-pane')).toMatchObject({ x: 0, y: 0, width: 0.5, height: 0.5 });
});

test('opens the second viewer to the right of the first', async () => {
  const f = fixture(); const first = await f.open('one'); const second = await f.open('two');
  expect(f.bounds('owner-pane')).toMatchObject({ x: 0, y: 0, width: 0.5, height: 0.5 });
  expect(f.neighbor(first!.pane, 'right')).toBe(second?.pane);
  expect(f.placement('other').pane).toBe('other-pane');
  expect(f.bounds(first!.pane)).toMatchObject({ x: 0, y: 0.5, width: 0.25, height: 0.5 });
  expect(f.bounds(second!.pane)).toMatchObject({ x: 0.25, y: 0.5, width: 0.25, height: 0.5 });
});

test.each([[59, 80], [60, 15], [60, 16], [60, 17], [60, 18]])('falls back after the owner tab when a downward split is too small (%i by %i)', async (cols, rows) => {
  const f = fixture(cols, rows); const view = await f.open('one');
  expect(f.placement(view!.viewer).tab).toBe(f.tabs[1]);
  expect(f.tabs).toEqual(['owner-tab', f.placement(view!.viewer).tab, 'foreign-tab']);
  expect(f.neighbor('owner-pane', 'down')).toBeUndefined();
  expect(f.operations.filter(call => call.name === 'terminal.keep')).toEqual([]);
});

test('accepts a downward split at 60 columns and 19 rows including pane chrome', async () => {
  const f = fixture(60, 19); const view = await f.open('one');
  expect(f.neighbor('owner-pane', 'down')).toBe(view?.pane);
  expect(f.sizes.get('owner')).toEqual({ cols: 60, rows: 8 });
  expect(f.sizes.get(view!.viewer)).toEqual({ cols: 60, rows: 8 });
});

test.each([[119, 8], [120, 7], [120, 8]])('falls back when a sideways split is too small (%i by %i)', async (cols, rows) => {
  const f = fixture(); const first = await f.open('one'); f.sizes.set(first!.viewer, { cols, rows }); const before = structuredClone(f.tree('owner-tab')); const second = await f.open('two');
  expect(f.placement(second!.viewer).tab).toBe(f.tabs[1]);
  expect(f.tree('owner-tab')).toEqual(before);
  expect(f.tabs).toEqual(['owner-tab', f.placement(second!.viewer).tab, 'foreign-tab']);
});

test('accepts a sideways split at 121 columns and 8 rows including the divider', async () => {
  const f = fixture(); const first = await f.open('one'); f.sizes.set(first!.viewer, { cols: 121, rows: 8 }); const second = await f.open('two');
  expect(f.neighbor(first!.pane, 'right')).toBe(second?.pane);
  expect(f.sizes.get(first!.viewer)).toEqual({ cols: 60, rows: 8 });
  expect(f.sizes.get(second!.viewer)).toEqual({ cols: 60, rows: 8 });
});

test('does not split a viewer when the owner is already below the minimum', async () => {
  const f = fixture(); const first = await f.open('one');
  f.sizes.set('owner', { cols: 320, rows: 7 }); const before = structuredClone(f.tree('owner-tab'));
  const second = await f.open('two');
  expect(f.placement(second!.viewer).tab).not.toBe('owner-tab');
  expect(f.tree('owner-tab')).toEqual(before);
});

test('does not split when another viewer would remain below the minimum', async () => {
  const f = fixture(); const first = await f.open('one'); const second = await f.open('two');
  f.sizes.set(first!.viewer, { cols: 59, rows: 40 }); const before = structuredClone(f.tree('owner-tab'));
  const third = await f.open('three');
  expect(f.placement(third!.viewer).tab).not.toBe('owner-tab');
  expect(f.tree('owner-tab')).toEqual(before);
});

test('focuses an already open viewer instead of splitting it again', async () => {
  const f = fixture(); const first = await f.open('one');
  expect(f.bounds('owner-pane')).toMatchObject({ x: 0, y: 0, width: 0.5, height: 0.5 });
  f.focusOther();
  const again = await f.open('one');
  expect(again?.pane).toBe(first?.pane); expect(f.focused).toBe(first?.pane);
  expect([...f.panes.values()].filter(p => p.terminal === first?.viewer)).toHaveLength(1);
});

test('parks a viewer split beside another session in the same tab before falling back', async () => {
  const f = fixture(); f.mismatch('same-tab'); const view = await f.open('one');
  expect(f.placement(view!.viewer).tab).not.toBe('owner-tab');
  expect(f.neighbor('other-pane', 'down')).toBeUndefined();
  expect(f.placement('other').pane).toBe('other-pane');
  expect(f.operations.filter(call => call.name === 'terminal.park').map(call => call.args.terminal)).toEqual([view!.viewer]);
});

test.each([{ race: 'post-check', when: 'the post-split focus check' }, { race: 'after', when: 'the focus-to-split gap' }] as const)('uses the owner tab fallback when focus changes during $when', async ({ race }) => {
  const f = fixture(); f.mismatch(race); const view = await f.open('one');
  expect(f.placement(view!.viewer).space).toBe('space');
  expect(f.tabs).toEqual(['owner-tab', f.placement(view!.viewer).tab, 'foreign-tab']);
  expect(f.placement(view!.viewer).tab).not.toBe('foreign-tab');
  expect(f.neighbor('foreign-pane', 'down')).toBeUndefined();
  expect(f.placement('foreign').pane).toBe('foreign-pane');
});


test('does not visit a neighbor or inspect focus before issuing the split', async () => {
  const f = fixture();
  await f.open('one');
  const keep = f.operations.findIndex(call => call.name === 'terminal.keep');
  expect(f.operations.slice(0, keep).filter(call => call.name === 'pane.go')).toEqual([]);
  expect(f.operations[keep - 1]).toEqual({ name: 'pane.focus', args: { pane: 'owner-pane' } });
});

test('retries parking a misplaced viewer before opening the fallback tab', async () => {
  const f = fixture(); f.mismatch('same-tab'); f.parkFails(2);
  const view = await f.open('one');
  expect(f.placement(view!.viewer).tab).not.toBe('owner-tab');
  expect(f.neighbor('other-pane', 'down')).toBeUndefined();
  expect(f.operations.filter(call => call.name === 'terminal.park')).toHaveLength(3);
});

test('closes a fallback placeholder only once when tab positioning fails', async () => {
  const f = fixture(59, 80); f.failMove();
  await expect(f.open('one')).rejects.toMatchObject({ code: 'app-error' });
  expect(f.operations.filter(call => call.name === 'pane.close')).toHaveLength(1);
});

test('an aborted open cannot focus or create a viewer after its blocked lookup resolves', async () => {
  const f = fixture(); const abort = new AbortController();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const original = f.app.ownerPlacement;
  f.app.ownerPlacement = async address => { if (address === 'owner') { entered(); await blocked; } return original(address); };
  const opening = f.actor.acquire('subagent', 'one' as RunId, f.owner, { timeoutMs: 1000, signal: abort.signal, ownerRelative: true });
  await started; abort.abort(); release();
  await expect(opening).rejects.toMatchObject({ code: 'aborted' });
  expect(f.operations.filter(call => ['pane.focus', 'terminal.keep', 'tab.new'].includes(call.name))).toEqual([]);
});


test('gives viewer launch and every retry one canceling overall deadline', async () => {
  const f = fixture();
  const actor = createAuxiliaryPanes({ hc: f.hc, app: f.app, clock: Date.now,
    subagentViewer: async (_id, _owner, signal) => {
      if (!signal) throw new HerdrError('missing-operation-signal', 'No deadline reached the launcher');
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new HerdrError('aborted', 'Deadline reached')), { once: true }));
      return 'never' as TerminalAddress;
    }, discardSubagentViewer: async () => {} });
  try { await expect(actor.acquire('subagent', 'one' as RunId, f.owner, { timeoutMs: 20, ownerRelative: true })).rejects.toMatchObject({ code: 'aborted' }); }
  finally { await actor.dispose(); }
  expect(f.operations).toEqual([]);
});


test('serializes different owner tabs through the same app and core lock', async () => {
  const f = fixture(), filesystem = await createClientFixture(), root = filesystem.root;
  const first = createAuxiliaryPanes({ ...f.actorOptions, placementRoot: root, appIdentity: 'fixture' });
  const second = createAuxiliaryPanes({ ...f.actorOptions, placementRoot: root, appIdentity: 'fixture' });
  const other = { ...f.owner, sessionId: 'other-owner', terminal: { ...f.owner.terminal, address: 'foreign', terminalId: 'foreign' } } as Owner;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { entered = resolve; });
  const original = f.app.command;
  f.app.command = async (name, args) => { if (name === 'terminal.keep' && args.terminal === 'viewer-one') { entered(); await gate; } return original(name, args); };
  const a = first.acquire('subagent', 'one' as RunId, f.owner, { timeoutMs: 3000, ownerRelative: true });
  try {
    await held;
    const b = second.acquire('subagent', 'two' as RunId, other, { timeoutMs: 3000, ownerRelative: true });
    const countTickets = async () => (await Promise.all((await readdir(join(root, 'locks'))).map(async directory => (await readdir(join(root, 'locks', directory))).filter(name => name.endsWith('.json')).length))).reduce((a, b) => a + b, 0);
    await expect.poll(countTickets).toBe(2);
    expect(await readdir(join(root, 'locks'))).toHaveLength(1);
    expect(f.operations.filter(call => call.name === 'pane.focus' && call.args.pane === 'foreign-pane')).toEqual([]);
    release();
    const [one, two] = await Promise.all([a, b]);
    expect(f.placement(one!.viewer).tab).toBe('owner-tab'); expect(f.placement(two!.viewer).tab).toBe('foreign-tab');
  } finally { release(); await a.catch(() => {}); await first.dispose(); await second.dispose(); await filesystem.close(); }
});

test('records an unrepaired split durably after three park failures', async () => {
  const f = fixture(), filesystem = await createClientFixture(), root = filesystem.root;
  const actor = createAuxiliaryPanes({ ...f.actorOptions, placementRoot: root }); f.mismatch('same-tab'); f.parkFails(100);
  try {
    await expect(actor.acquire('subagent', 'one' as RunId, f.owner, { timeoutMs: 1000, ownerRelative: true })).rejects.toMatchObject({ code: 'pane-repair-pending' });
    expect(f.operations.filter(call => call.name === 'terminal.park')).toHaveLength(3);
    expect(await readPlacementRepairs(root)).toMatchObject([{ viewer: 'viewer-one', placed: { tab: 'owner-tab', pane: 'pane-viewer-one' } }]);
  } finally { await actor.dispose(); await filesystem.close(); }
});


test('uses the smaller size when the terminal shrinks between size observations', async () => {
  const f = fixture(320, 80), original = f.hc.get; let reads = 0;
  f.hc.get = async (...args) => { const terminal = await original(...args); return args[0] === 'owner' && ++reads >= 4 ? { ...terminal, rows: 18 } : terminal; };
  const view = await f.open('one');
  expect(f.placement(view!.viewer).tab).not.toBe('owner-tab');
  expect(f.operations.filter(call => call.name === 'terminal.keep')).toEqual([]);
});


test('repairs and falls back when the acknowledged split reports an undersized terminal', async () => {
  const f = fixture(), original = f.hc.get;
  f.hc.get = async (...args) => { const terminal = await original(...args); return args[0] === 'viewer-one' && f.panes.has('pane-viewer-one') ? { ...terminal, cols: 59, rows: 7 } : terminal; };
  const view = await f.open('one');
  expect(f.placement(view!.viewer).tab).not.toBe('owner-tab');
  expect(f.neighbor('owner-pane', 'down')).toBeUndefined();
});


test('cancels while queued without waiting for the earlier open to finish', async () => {
  const f = fixture(); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const original = f.app.command;
  f.app.command = async (name, args) => { if (name === 'terminal.keep' && args.terminal === 'viewer-one') { entered(); await gate; } return original(name, args); };
  const first = f.open('one');
  try {
    await started;
    await expect(f.actor.acquire('subagent', 'two' as RunId, f.owner, { timeoutMs: 20, ownerRelative: true })).rejects.toMatchObject({ code: 'aborted' });
    expect(f.operations.filter(call => call.name === 'terminal.keep' && call.args.terminal === 'viewer-two')).toEqual([]);
  } finally { release(); await first; }
});

test('cancellation removes the fallback placeholder and its adopted viewer before returning', async () => {
  const f = fixture(59, 80), abort = new AbortController(); let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.app.awaitPane = async () => { entered(); await new Promise<void>(() => {}); return 'never' as OwnerPlacement['pane']; };
  const opening = f.actor.acquire('subagent', 'one' as RunId, f.owner, { timeoutMs: 1000, signal: abort.signal, ownerRelative: true });
  await started; abort.abort();
  await expect(opening).rejects.toMatchObject({ code: 'aborted' });
  expect([...f.panes.values()].filter(pane => pane.terminal === 'viewer-one' || pane.terminal === null)).toEqual([]);
  expect(f.operations.filter(call => call.name === 'pane.focus')).toEqual([]);
});


test('places the fallback after the owner even when the app inserts it before the owner', async () => {
  const f = fixture(59, 80); f.insertBeforeOwner();
  const view = await f.open('one');
  expect(f.tabs).toEqual(['owner-tab', f.placement(view!.viewer).tab, 'foreign-tab']);
});


test('a placement deadline parks an automatic viewer without discarding its live process', async () => {
  const f = fixture(); let discarded = 0;
  f.app.awaitPane = async () => new Promise(() => {});
  const actor = createAuxiliaryPanes({ ...f.actorOptions, automaticSubagentPanes: true, discardSubagentViewer: async () => { discarded++; } });
  try {
    await expect(actor.acquire('subagent', 'one' as RunId, f.owner, { timeoutMs: 20, automatic: true })).rejects.toMatchObject({ code: 'aborted' });
    expect(discarded).toBe(0);
    expect([...f.panes.values()].some(pane => pane.terminal === 'viewer-one')).toBe(false);
  } finally { await actor.dispose(); }
});

test('an aborted joined open does not undo another live open of the same viewer', async () => {
  const f = fixture(), abort = new AbortController(); let entered!: () => void, release!: () => void, joined!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const command = f.app.command;
  f.app.command = async (name, args) => { if (name === 'terminal.keep') { entered(); await gate; } return command(name, args); };
  const first = f.open('one'); await started;
  const joinedRead = new Promise<void>(resolve => { joined = resolve; }), get = f.hc.get;
  f.hc.get = async (...args) => { if (args[0] === 'viewer-one') joined(); return get(...args); };
  const second = f.actor.acquire('subagent', 'one' as RunId, f.owner, { timeoutMs: 1000, signal: abort.signal, ownerRelative: true }); void second.catch(() => {});
  try {
    await joinedRead; await new Promise<void>(resolve => setImmediate(resolve)); abort.abort(); release();
    const view = await first;
    await expect(second).rejects.toMatchObject({ code: 'aborted' });
    expect(f.placement(view!.viewer).tab).toBe('owner-tab');
  } finally { release(); await Promise.allSettled([first, second]); }
});


test('falls back if the viewer anchor vanishes while its size is being observed', async () => {
  const f = fixture(); await f.open('one'); const get = f.hc.get; let reads = 0;
  f.hc.get = async (...args) => { if (args[0] === 'viewer-one' && ++reads >= 3) throw new HerdrError('not_found', 'Viewer exited'); return get(...args); };
  const second = await f.open('two');
  expect(f.placement(second!.viewer).tab).not.toBe('owner-tab');
  expect(f.placement('owner').pane).toBe('owner-pane');
});


test('bounds repair even when the app cannot answer a placement read', async () => {
  const f = fixture(), filesystem = await createClientFixture(), placement = f.app.ownerPlacement, abort = new AbortController(), command = f.app.command; let created = false;
  f.app.command = async (name, args) => { const result = await command(name, args); if (name === 'terminal.keep') { created = true; abort.abort(); } return result; };
  f.app.ownerPlacement = async address => address === 'viewer-one' && created ? new Promise(() => {}) : placement(address);
  const actor = createAuxiliaryPanes({ ...f.actorOptions, placementRoot: filesystem.root, paneRemovalTimeoutMs: 20 });
  try {
    await expect(actor.acquire('subagent', 'one' as RunId, f.owner, { timeoutMs: 1000, signal: abort.signal, ownerRelative: true })).rejects.toMatchObject({ code: 'aborted' });
    expect(await readPlacementRepairs(filesystem.root)).toHaveLength(1);
    expect(f.operations.filter(call => call.name === 'terminal.park')).toHaveLength(3);
  } finally { await actor.dispose(); await filesystem.close(); }
}, 1000);


test('repairs its own canceled display when an earlier open ends during its identity read', async () => {
  const f = fixture(), abort = new AbortController(); let entered!: () => void, releaseFirst!: () => void, read!: () => void, releaseRead!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const reading = new Promise<void>(resolve => { read = resolve; }), readGate = new Promise<void>(resolve => { releaseRead = resolve; });
  const command = f.app.command; let keeps = 0;
  f.app.command = async (name, args) => {
    if (name !== 'terminal.keep') return command(name, args);
    if (++keeps === 1) { entered(); await firstGate; return command(name, args); }
    const reply = await command(name, args); abort.abort(); return reply;
  };
  const first = f.open('one'); await started;
  const get = f.hc.get; let holdRead = true;
  f.hc.get = async (...args) => { if (args[0] === 'viewer-one' && holdRead) { holdRead = false; read(); await readGate; } return get(...args); };
  const second = f.actor.acquire('subagent', 'one' as RunId, f.owner, { timeoutMs: 1000, signal: abort.signal, ownerRelative: true }); void second.catch(() => {});
  try {
    await reading; releaseFirst(); const view = await first;
    f.panes.delete(view!.pane); f.sizes.set('owner', { cols: 320, rows: 80 }); releaseRead();
    await expect(second).rejects.toMatchObject({ code: 'aborted' });
    expect([...f.panes.values()].some(pane => pane.terminal === 'viewer-one')).toBe(false);
    expect(f.placement('owner').pane).toBe('owner-pane');
  } finally { releaseFirst(); releaseRead(); await Promise.allSettled([first, second]); }
});


test.each([18, 19, 20])('does not split a lone owner with only %i rows', async rows => {
  const f = fixture(61, rows); f.remove('other');
  const view = await f.open('one');
  expect(f.placement(view!.viewer).tab).not.toBe('owner-tab');
  expect(f.operations.filter(call => call.name === 'terminal.keep')).toEqual([]);
});

test('a lone owner and its new viewer retain 60 columns and 8 rows at the boundary', async () => {
  const f = fixture(61, 21); f.remove('other');
  const view = await f.open('one');
  expect(f.placement(view!.viewer).tab).toBe('owner-tab');
  expect(f.sizes.get('owner')).toEqual({ cols: 60, rows: 8 });
  expect(f.sizes.get(view!.viewer)).toEqual({ cols: 60, rows: 8 });
});

test.each([80, 100])('finds the displayed viewer after actor reload with a %i-row owner', async rows => {
  const f = fixture(320, rows), first = await f.open('one');
  await f.actor.dispose();
  const reloaded = createAuxiliaryPanes(f.actorOptions);
  try {
    const second = await reloaded.acquire('subagent', 'two' as RunId, f.owner, { timeoutMs: 1000, ownerRelative: true });
    expect(f.placement(second!.viewer).tab).toBe('owner-tab');
    expect(f.bounds('owner-pane')).toMatchObject({ x: 0, y: 0, width: 0.5, height: 0.5 });
    expect(f.neighbor(first!.pane, 'right')).toBe(second!.pane);
    expect(f.bounds(second!.pane)).toMatchObject({ x: 0.25, y: 0.5, width: 0.25, height: 0.5 });
  } finally { await reloaded.dispose(); }
});

test.each(['session stop', 'budget'] as const)('a queued re-open preserves its displayed viewer on %s', async reason => {
  const f = fixture(640, 200), first = await f.open('one'), abort = new AbortController();
  let release!: () => void, entered!: () => void, queued!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { entered = resolve; });
  const ready = new Promise<void>(resolve => { queued = resolve; });
  const command = f.app.command;
  f.app.command = async (name, args) => { if (name === 'terminal.keep' && args.terminal === 'viewer-two') { entered(); await gate; } return command(name, args); };
  const second = f.actor.acquire('subagent', 'two' as RunId, f.owner, { timeoutMs: 3000, ownerRelative: true });
  try {
    await held;
    const get = f.hc.get;
    f.hc.get = async (...args) => { const result = await get(...args); if (args[0] === first!.viewer) queued(); return result; };
    const again = f.actor.acquire('subagent', 'one' as RunId, f.owner, { timeoutMs: reason === 'budget' ? 100 : 3000, signal: abort.signal, ownerRelative: true });
    const failed = expect(again).rejects.toMatchObject({ code: 'aborted' });
    await ready; await new Promise<void>(resolve => setImmediate(resolve));
    if (reason === 'session stop') { abort.abort(); await f.actor.dispose(); }
    await failed;
    expect(f.placement(first!.viewer).pane).toBe(first!.pane);
    expect(f.operations.filter(call => call.name === 'terminal.park' && call.args.terminal === first!.viewer)).toEqual([]);
  } finally { release(); await second.catch(() => {}); await f.actor.dispose(); }
});


test('a socket close while a re-open is queued leaves its displayed viewer in place', async () => {
  const f = fixture(640, 200), filesystem = await createClientFixture(), first = await f.open('one');
  let release!: () => void, entered!: () => void, queued!: () => void, settled!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { entered = resolve; });
  const ready = new Promise<void>(resolve => { queued = resolve; }), done = new Promise<void>(resolve => { settled = resolve; });
  const command = f.app.command;
  f.app.command = async (name, args) => { if (name === 'terminal.keep' && args.terminal === 'viewer-two') { entered(); await gate; } return command(name, args); };
  const second = f.actor.acquire('subagent', 'two' as RunId, f.owner, { timeoutMs: 3000, ownerRelative: true });
  const endpoint = await startSessionEndpoint(f.owner, {
    currentOwner: () => f.owner, liveCapabilities: () => null, ownsRun: () => true,
    subscribeRun: () => ({ dispose() {} }), steerRun: () => { throw new Error('No steering'); }, openView() {},
    ownsJob: () => false, openJob: () => null,
    openRun: async (id, signal) => { try { return (await f.actor.acquire('subagent', id, f.owner, { signal, timeoutMs: 3000, ownerRelative: true }))?.viewer ?? null; } finally { settled(); } },
  }, filesystem.root);
  const client = createSessionIpcClient(endpoint.descriptor);
  try {
    await held;
    const get = f.hc.get;
    f.hc.get = async (...args) => { const result = await get(...args); if (args[0] === first!.viewer) queued(); return result; };
    const opening = client.openRun('one' as RunId), failed = expect(opening).rejects.toMatchObject({ code: 'unavailable' });
    await ready; client.dispose(); await failed; await done;
    expect(f.placement(first!.viewer).pane).toBe(first!.pane);
    expect(f.operations.filter(call => call.name === 'terminal.park' && call.args.terminal === first!.viewer)).toEqual([]);
  } finally { release(); client.dispose(); await endpoint.dispose(); await second.catch(() => {}); await f.actor.dispose(); await filesystem.close(); }
});

test('clears a failed repair after a late park before opening the viewer again', async () => {
  const f = fixture(), filesystem = await createClientFixture();
  const actor = createAuxiliaryPanes({ ...f.actorOptions, placementRoot: filesystem.root });
  f.mismatch('same-tab'); f.parkFails(3);
  try {
    await expect(actor.acquire('subagent', 'one' as RunId, f.owner, { timeoutMs: 1000, ownerRelative: true })).rejects.toMatchObject({ code: 'pane-repair-pending' });
    expect(await readPlacementRepairs(filesystem.root)).toHaveLength(1);
    await f.app.command('terminal.park', { terminal: 'viewer-one' });
    const later = await actor.acquire('subagent', 'one' as RunId, f.owner, { timeoutMs: 1000, ownerRelative: true });
    expect(f.placement(later!.viewer).tab).toBe('owner-tab');
    expect(await readPlacementRepairs(filesystem.root)).toEqual([]);
  } finally { await actor.dispose(); await filesystem.close(); }
});

test('allows a slow park the same app deadline without overlapping retries or a repair record', async () => {
  const f = fixture(), filesystem = await createClientFixture(), command = f.app.command;
  const actor = createAuxiliaryPanes({ ...f.actorOptions, placementRoot: filesystem.root });
  f.mismatch('same-tab');
  f.app.command = async (name, args) => { if (name === 'terminal.park') await new Promise(resolve => setTimeout(resolve, 1700)); return command(name, args); };
  try {
    const opening = actor.acquire('subagent', 'one' as RunId, f.owner, { timeoutMs: 10000, ownerRelative: true });
    const outcome = opening.then(value => ({ value }), error => ({ error }));
    expect(await outcome).toHaveProperty('value');
    expect(f.operations.filter(call => call.name === 'terminal.park')).toHaveLength(1);
    expect(await readPlacementRepairs(filesystem.root)).toEqual([]);
  } finally { await actor.dispose(); await filesystem.close(); }
}, 10000);


test('cancellation during the final focus repairs only the viewer created by that open', async () => {
  const f = fixture(), abort = new AbortController(), command = f.app.command;
  f.app.command = async (name, args) => {
    const result = await command(name, args);
    if (name === 'pane.focus' && args.terminal === 'viewer-one') abort.abort();
    return result;
  };
  await expect(f.actor.acquire('subagent', 'one' as RunId, f.owner, { timeoutMs: 1000, signal: abort.signal, ownerRelative: true })).rejects.toMatchObject({ code: 'aborted' });
  expect([...f.panes.values()].some(pane => pane.terminal === 'viewer-one')).toBe(false);
  expect(f.placement('owner').pane).toBe('owner-pane');
});


test('does not split a lone 60-column owner that would lose a column to its new frame', async () => {
  const f = fixture(60, 21); f.remove('other');
  const view = await f.open('one');
  expect(f.placement(view!.viewer).tab).not.toBe('owner-tab');
  expect(f.operations.filter(call => call.name === 'terminal.keep')).toEqual([]);
});

test('an abort during tab creation never adopts or parks the untouched viewer', async () => {
  const f = fixture(59, 80), abort = new AbortController(), command = f.app.command, adopted: TerminalAddress[] = [], labels = f.hc.setLabels;
  f.hc.setLabels = async (viewer, patch) => { adopted.push(viewer); await labels(viewer, patch); };
  f.app.command = async (name, args) => { const result = await command(name, args); if (name === 'tab.new') abort.abort(); return result; };
  await expect(f.actor.acquire('subagent', 'one' as RunId, f.owner, { timeoutMs: 1000, signal: abort.signal, ownerRelative: true })).rejects.toMatchObject({ code: 'aborted' });
  expect(adopted).toEqual([]);
  expect(f.operations.filter(call => call.name === 'terminal.park')).toEqual([]);
  expect([...f.panes.values()].filter(pane => pane.terminal === null)).toEqual([]);
});

test('an aborted joined open returns while the original display is still blocked', async () => {
  const f = fixture(), abort = new AbortController(); let entered!: () => void, release!: () => void, read!: () => void;
  const held = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }), reading = new Promise<void>(resolve => { read = resolve; });
  const command = f.app.command;
  f.app.command = async (name, args) => { if (name === 'terminal.keep') { entered(); await gate; } return command(name, args); };
  const first = f.open('one'); await held;
  const get = f.hc.get;
  f.hc.get = async (...args) => { const result = await get(...args); if (args[0] === 'viewer-one') read(); return result; };
  const second = f.actor.acquire('subagent', 'one' as RunId, f.owner, { timeoutMs: 1000, signal: abort.signal, ownerRelative: true });
  const outcome = second.then(() => 'opened', error => error.code);
  try {
    await reading; await new Promise<void>(resolve => setImmediate(resolve)); abort.abort();
    expect(await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve('still queued'), 300))])).toBe('aborted');
    expect(f.operations.filter(call => call.name === 'terminal.park')).toEqual([]);
  } finally { release(); await Promise.allSettled([first, second]); }
});


test('holds the app focus lock until its canceled split has been parked', async () => {
  const f = fixture(), filesystem = await createClientFixture(), abort = new AbortController();
  const first = createAuxiliaryPanes({ ...f.actorOptions, placementRoot: filesystem.root, appIdentity: 'fixture' });
  const second = createAuxiliaryPanes({ ...f.actorOptions, placementRoot: filesystem.root, appIdentity: 'fixture' });
  const other = { ...f.owner, sessionId: 'other-owner', terminal: { ...f.owner.terminal, address: 'foreign', terminalId: 'foreign' } } as Owner;
  let entered!: () => void, release!: () => void;
  const repairing = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const command = f.app.command;
  f.app.command = async (name, args) => {
    if (name === 'terminal.park' && args.terminal === 'viewer-one') { entered(); await gate; }
    const result = await command(name, args);
    if (name === 'pane.focus' && args.terminal === 'viewer-one') abort.abort();
    return result;
  };
  const opening = first.acquire('subagent', 'one' as RunId, f.owner, { timeoutMs: 3000, signal: abort.signal, ownerRelative: true });
  const failed = expect(opening).rejects.toMatchObject({ code: 'aborted' });
  let following: Promise<unknown> | undefined;
  try {
    await repairing;
    following = second.acquire('subagent', 'two' as RunId, other, { timeoutMs: 3000, ownerRelative: true });
    const tickets = async () => (await Promise.all((await readdir(join(filesystem.root, 'locks'))).map(async directory => (await readdir(join(filesystem.root, 'locks', directory))).filter(name => name.endsWith('.json')).length))).reduce((a, b) => a + b, 0);
    await expect.poll(tickets).toBe(2);
    expect(f.operations.filter(call => call.name === 'pane.focus' && call.args.pane === 'foreign-pane')).toEqual([]);
    release(); await failed; await following;
    expect(f.placement('viewer-two').tab).toBe('foreign-tab');
    expect([...f.panes.values()].some(pane => pane.terminal === 'viewer-one')).toBe(false);
  } finally { release(); await Promise.allSettled([opening, following]); await first.dispose(); await second.dispose(); await filesystem.close(); }
});
