// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { createAuxiliaryPanes, type AuxiliaryPaneOptions } from '../jobs/placement.js';
import { HerdrError } from '../client/parse.js';
import type { AppClient, AppPaneInspection, ConsoleId, CoreId, HcClient, HcEvent, HcRunRequest, Owner, OwnerPlacement, RunId, TerminalAddress, TerminalSummary } from '../contracts.js';

const run = '10000000-0000-4000-8000-000000000001' as RunId;
const consoleId = '10000000-0000-4000-8000-000000000002' as ConsoleId;
const otherRun = '10000000-0000-4000-8000-000000000003' as RunId;
const display = 't1' as TerminalAddress;
const macCore = 'mac-core' as CoreId;
function fixture(cols = 200, rows = 60, limit = 2) {
  const owner = { sessionId: 'session', generation: 'generation', name: 'Writer', cwd: '/home/example/work', sessionFile: null,
    terminal: { coreId: 'box-core', terminalId: 't7', address: 'box-1.invalid/t7', socket: '/home/example/core.sock', sessionNamespace: 'default' } } as Owner;
  const placement = { space: 'mac-space', tab: 'mac-tab', pane: 'owner-pane' } as OwnerPlacement;
  const layout = new Map<TerminalAddress, OwnerPlacement>([[display, placement]]);
  const terminal = (address: TerminalAddress, labels: Record<string, string> = {}): TerminalSummary => ({ address, parent: null, labels, state: 'live', status: null,
    exitCode: null, reason: null, signal: null, finishedAt: null, cols, rows });
  const terminals = new Map<TerminalAddress, TerminalSummary>([[display, terminal(display, { 'spider.kind': 'pane-proxy' })]]);
  const created: HcRunRequest[] = [], killed: TerminalAddress[] = [], lookups: TerminalAddress[] = [], sourceLaunches: RunId[] = [];
  const events = new Set<(event: HcEvent) => void>();
  let sequence = 1, focused = placement, ownerDisplay: TerminalAddress | null = display;
  const app: AppClient & AppPaneInspection = {
    ownerPlacement: async address => { lookups.push(address); if (address === owner.terminal.address) throw new Error('Box app placement must not be queried');
      const p = layout.get(address); if (!p) throw new HerdrError('owner-unplaced', 'No local pane'); return p; },
    tabTerminals: async target => [...layout].filter(([, p]) => p.space === target.space && p.tab === target.tab).map(([address]) => address),
    tabPanes: async target => [...layout].filter(([, p]) => p.tab === target.tab).map(([terminal, p]) => ({ terminal, pane: p.pane })),
    tabIndex: async target => target.tab === placement.tab ? 0 : 1,
    focusedPane: async () => focused,
    awaitPane: async (address, target) => { const p = { ...target, pane: `pane-${address}` as OwnerPlacement['pane'] }; layout.set(address, p); return p.pane; },
    command: async (name, args) => {
      const address = args.terminal as TerminalAddress;
      if (name === 'pane.focus') focused = args.pane ? [...layout.values()].find(p => p.pane === args.pane)! : layout.get(address)!;
      if (name === 'pane.go') { const panes = [...layout.values()].filter(p => p.tab === focused.tab); const next = panes[panes.indexOf(focused) + 1]; if (next) focused = next; }
      if (name === 'terminal.park') layout.delete(address);
      if (name === 'terminal.keep') { focused = { ...placement, pane: `pane-${address}` as OwnerPlacement['pane'] }; layout.set(address, focused); return { pane: focused.pane }; }
      if (name === 'tab.new') return { space: placement.space, tab: 'adjacent-tab' as OwnerPlacement['tab'], pane: 'empty-pane' as OwnerPlacement['pane'] };
      return {};
    },
  };
  const hc: HcClient = {
    identity: async () => ({ coreId: macCore, socket: '/fixture/mac.sock', sessionNamespace: 'fixture' }),
    caller: async () => { throw new Error('No caller lookup'); }, machines: async () => [],
    run: async request => { created.push(request); const address = `t${++sequence}` as TerminalAddress; terminals.set(address, terminal(address, { ...request.labels })); return { address, coreId: macCore }; },
    get: async address => { const t = terminals.get(address); if (!t) throw new HerdrError('not_found', 'No terminal'); return t; },
    read: async () => 'Waiting for view',
    kill: async address => { killed.push(address); terminals.delete(address); }, rm: async address => { terminals.delete(address); },
    setLabels: async (address, labels) => { const t = terminals.get(address)!; terminals.set(address, { ...t, labels: { ...t.labels, ...Object.fromEntries(Object.entries(labels).filter((entry): entry is [string, string] => entry[1] !== null)) } }); },
    fileRead: async () => { throw new Error('No source file reads'); }, fileWrite: async () => { throw new Error('No source file writes'); },
    events: () => ({ ready: Promise.resolve(), lookup: async address => terminals.get(address) ?? null,
      subscribe: listener => { events.add(listener); return () => { events.delete(listener); }; }, dispose: async () => {} }),
  };
  const options: AuxiliaryPaneOptions = {
    hc, app, limit, clock: Date.now,
    subagentViewer: async id => { sourceLaunches.push(id); throw new Error('Source launch before reservation'); }, discardSubagentViewer: async () => {},
    ownerPresentation: async actualOwner => { expect(actualOwner).toBe(owner); return ownerDisplay; },
    waitingPresentation: async (kind, id, actualOwner) => hc.run({ argv: ['waiting-display'], cwd: null, parent: null, background: true, noNotify: true, outliveParent: true,
      labels: { 'spider.kind': 'pane-proxy', 'spider.session': actualOwner.sessionId, 'spider.owner-core': actualOwner.terminal.coreId,
        'spider.owner-terminal': actualOwner.terminal.terminalId, 'spider.pane-role': kind, 'spider.reservation': id } }),
  };
  const panes = createAuxiliaryPanes(options);
  return { owner, placement, layout, terminals, created, killed, lookups, sourceLaunches, options, panes, hc,
    setOwnerDisplay: (value: TerminalAddress | null) => { ownerDisplay = value; },
    finish: (address: TerminalAddress) => {
      const ended = { ...terminals.get(address)!, state: 'finished' as const, finishedAt: Date.now(), exitCode: 0 };
      terminals.set(address, ended); layout.delete(address);
      for (const listener of events) listener({ type: 'finished', seq: 1, terminal: address,
        data: { exitCode: 0, signal: null, reason: 'exited', finishedAt: ended.finishedAt } });
    },
  };
}

test('reservation acknowledges Mac placeholder before view launch', async () => {
  const f = fixture();
  try {
    const result = await f.panes.reservePresented('subagent', run, f.owner, { timeoutMs: 1000, ownerRelative: true });
    expect(result).toMatchObject({ id: run, kind: 'subagent', owner: f.owner, viewer: 't2', pane: 'pane-t2' });
    expect(f.layout.get(result!.viewer)).toEqual({ ...f.placement, pane: 'pane-t2' });
    expect(f.sourceLaunches).toEqual([]);
    expect(f.created).toHaveLength(1);
    expect(f.created[0]).not.toHaveProperty('on');
    expect(f.created[0].parent).toBeNull();
  } finally { await f.panes.dispose(); }
});

test('remote owner never needs box app placement', async () => {
  const f = fixture();
  try {
    const reservation = await f.panes.reservePresented('console', consoleId, f.owner, { timeoutMs: 1000 });
    expect(reservation?.owner).toBe(f.owner);
    expect(reservation?.kind).toBe('console');
    expect(f.layout.get(reservation!.viewer)?.tab).toBe('mac-tab');
    expect(f.lookups).not.toContain('box-1.invalid/t7');
    expect(f.sourceLaunches).toEqual([]);
  } finally { await f.panes.dispose(); }
});

test.each([[59, 8], [60, 7]])('reservation refuses undersized owner %i by %i before launch', async (cols, rows) => {
  const f = fixture(cols, rows);
  try {
    expect(await f.panes.reservePresented('subagent', run, f.owner, { timeoutMs: 1000 })).toBeNull();
    expect(f.created).toEqual([]);
    expect(f.layout.size).toBe(1);
  } finally { await f.panes.dispose(); }
});

test('reservation retains 60 by 8 minimum and viewer priority', async () => {
  const f = fixture(60, 8, 2);
  try {
    const low = await f.panes.reservePresented('console', consoleId, f.owner, { timeoutMs: 1000, userInitiated: false });
    const first = await f.panes.reservePresented('subagent', run, f.owner, { timeoutMs: 1000, userInitiated: false });
    const next = await f.panes.reservePresented('subagent', otherRun, f.owner, { timeoutMs: 1000, userInitiated: false });
    expect(f.layout.has(low!.viewer)).toBe(false);
    expect(f.layout.has(first!.viewer)).toBe(true);
    expect(f.layout.has(next!.viewer)).toBe(true);
    expect(await f.hc.get(next!.viewer)).toMatchObject({ cols: 60, rows: 8 });
    expect(f.killed).toContain(low!.viewer);
    expect(f.killed).not.toContain(first!.viewer);
    expect(f.sourceLaunches).toEqual([]);
  } finally { await f.panes.dispose(); }
});

test.each(['missing owner', 'no capacity'])('reservation refuses %s before waiting display launch', async reason => {
  const f = fixture(200, 60, reason === 'no capacity' ? 0 : 2);
  if (reason === 'missing owner') f.setOwnerDisplay(null);
  try {
    expect(await f.panes.reservePresented('console', consoleId, f.owner, { timeoutMs: 1000 })).toBeNull();
    expect(f.created).toEqual([]);
    expect(f.sourceLaunches).toEqual([]);
  } finally { await f.panes.dispose(); }
});

test('an owner display absent from the core refuses before launch', async () => {
  const f = fixture(); f.terminals.delete(display);
  try {
    expect(await f.panes.reservePresented('subagent', run, f.owner, { timeoutMs: 1000 })).toBeNull();
    expect(f.created).toEqual([]);
    expect(f.sourceLaunches).toEqual([]);
  } finally { await f.panes.dispose(); }
});

test('concurrent reservation requests acknowledge one local display', async () => {
  const f = fixture();
  try {
    const [first, second] = await Promise.all([1, 2].map(() => f.panes.reservePresented('subagent', run, f.owner, { timeoutMs: 1000 })));
    expect(second).toBe(first);
    expect(f.created).toHaveLength(1);
    expect(f.layout.size).toBe(2);
  } finally { await f.panes.dispose(); }
});

test.each(['ownerPresentation', 'waitingPresentation'] as const)('missing %s port never launches a source view', async port => {
  const f = fixture(); delete f.options[port];
  try {
    expect(await f.panes.reservePresented('subagent', run, f.owner, { timeoutMs: 1000 })).toBeNull();
    expect(f.created).toEqual([]);
    expect(f.sourceLaunches).toEqual([]);
  } finally { await f.panes.dispose(); }
});

test('lost waiting-display reply stays uncertain without another launch', async () => {
  const f = fixture(), launch = f.options.waitingPresentation!;
  f.options.waitingPresentation = async (...args) => { await launch(...args); throw new HerdrError('lost-reply', 'Waiting display reply was lost'); };
  try {
    await expect(f.panes.reservePresented('subagent', run, f.owner, { timeoutMs: 1000 })).rejects.toMatchObject({ code: 'lost-reply' });
    await expect(f.panes.reservePresented('subagent', run, f.owner, { timeoutMs: 1000 })).rejects.toMatchObject({ code: 'presentation-uncertain' });
    expect(f.created).toHaveLength(1);
    expect(f.sourceLaunches).toEqual([]);
  } finally { await f.panes.dispose(); }
});

test('a nonlocal waiting handle cannot acknowledge a Mac reservation', async () => {
  const f = fixture();
  f.options.waitingPresentation = async () => ({ address: 'box-1.invalid/t8' as TerminalAddress, coreId: 'box-core' as CoreId });
  try {
    await expect(f.panes.reservePresented('console', consoleId, f.owner, { timeoutMs: 1000 })).rejects.toMatchObject({ code: 'pane-not-owned' });
    expect(f.layout.size).toBe(1);
    expect(f.killed).toEqual([]);
  } finally { await f.panes.dispose(); }
});

test('an ended waiting display is removed after native pane removal', async () => {
  const f = fixture();
  try {
    const reservation = await f.panes.reservePresented('subagent', run, f.owner, { timeoutMs: 1000 });
    f.finish(reservation!.viewer);
    await expect.poll(() => f.terminals.has(reservation!.viewer)).toBe(false);
    expect(f.killed).not.toContain(display);
    expect(f.sourceLaunches).toEqual([]);
  } finally { await f.panes.dispose(); }
});

test('release retires only the reserved display and keeps its source owner', async () => {
  const f = fixture();
  try {
    const reservation = await f.panes.reservePresented('subagent', run, f.owner, { timeoutMs: 1000 });
    await f.panes.release(reservation!);
    expect(f.killed).toEqual(['t2']);
    expect(f.layout.has(display)).toBe(true);
    expect(f.lookups).not.toContain(f.owner.terminal.address);
    expect(f.sourceLaunches).toEqual([]);
  } finally { await f.panes.dispose(); }
});
