// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { pickerRows } from '../../assets/picker/model.js';
import { presentExistingPane } from '../spaces/move.js';
import type { PaneOpenPorts } from '../panes/open.js';
import { expect, test, vi } from 'vitest';
import { parsePaneAgentRow, parsePaneTarget, parsePanePresentation, parsePaneSlot } from '../panes/codec.js';
import { HerdrLabelContract } from '../contracts.js';
import { projectNavigation, navigationAgents, type NavigationSnapshot } from '../../assets/shared/navigation.js';
import { moveTarget, beginPresentationDrag, dropPresentation, menuItems } from '../../assets/agents/move.js';
import { requestPaneService } from '../../assets/shared/feed.js';
import { parkFocusedTerminal } from '../../assets/pane/park.js';
import type { PaneAgentRow, PanePresentation, PaneServiceSnapshot, PaneTarget } from '../panes/types.js';

const execution = parsePaneTarget({ coreId: 'core-box', terminalId: 't2', address: 'core-box/t2', createdMs: 42, identityLabels: {}, alias: 'box-1.invalid', machineId: 'machine-1', kind: 'session', sessionId: 'writer', generation: 'gen-1', homeEpoch: 1, runId: null, consoleId: null, name: 'Writer', cwd: '/project' });
const presentation = parsePanePresentation({ id: 'pres-1', revision: 3, mode: 'proxy', role: 'agent', target: execution, proxy: 'proxy', slot: { space: 's1', tab: 'tb1', pane: 'p1' }, visibility: 'visible', launch: 'acknowledged', closeOperationId: null, conversion: null });
const row = parsePaneAgentRow({ sessionId: 'writer', generation: 'gen-1', owner: { sessionId: 'writer', generation: 'gen-1', terminal: { coreId: 'core-box', terminalId: 't2', address: 'core-box/t2', socket: '/fixture/source.sock', sessionNamespace: 'fixture' }, cwd: '/project', sessionFile: null, name: 'Writer' }, name: 'Writer', status: 'working', updatedAt: 100, machineKey: 'box-1.invalid', target: execution, unavailableReason: null, children: [{ runId: 'run-1', name: 'Child', status: 'done' }], consoles: [{ consoleId: 'console-' + 'a'.repeat(64), machineKey: 'box-1.invalid', name: 'Console', target: null }] });
function snapshot(presentations: PanePresentation[] = [presentation], rows: PaneAgentRow[] = [row]): NavigationSnapshot {
  return { coreId: 'core-local', destination: parsePaneSlot({ space: 's1', tab: 'tb1', pane: null }), agents: [{ address: 'box-1.invalid/t2', pane: 'box-1.invalid/p2', space: 'remote', tab: 'remote-tab', title: 'Duplicate', space_name: 'Remote', status: 'working', pinned: false, focused: false, program: { name: 'pi' } }],
    terminals: [], panes: [{ pane: 'p1', terminal: 'proxy', tab: 'tb1', cwd: null }], spaces: [{ id: 's1', index: 1, name: 'Work', machine: null, active: true, tabs: [{ id: 'tb1', name: 'One', active: true, status: null }, { id: 'tb2', name: 'Two', active: false, status: null }] }, { id: 'remote', index: 2, name: 'Remote', machine: 'box-1.invalid', active: false, tabs: [{ id: 'remote-tab', name: 'Remote', active: true, status: null }] }],
    feeds: [], machines: [], contract: HerdrLabelContract, now: 100, completedHours: 24, completedRows: 50,
    paneSnapshot: { version: 1, kind: 'snapshot', complete: true, omittedRows: 0, revision: 1, rows, presentations, machines: [], targetFacts: {} } } as NavigationSnapshot;
}
const complete = (p = presentation) => ({ status: 'complete' as const, reason: 'presented', presentation: p });

test('box layout agent appears once and never focuses a remote pane', () => {
  const targets = projectNavigation(snapshot());
  expect(targets.filter(target => target.ownerId === null)).toHaveLength(1);
  expect(targets[0]).toMatchObject({ id: 'session:writer', name: 'Writer', machine: 'box-1.invalid', action: { kind: 'focus', pane: 'p1' } });
  expect(targets.some(target => target.action?.kind === 'focus' && target.action.pane.includes('/'))).toBe(false);
});
test('parked proxy reopens via service not target terminal keep', () => {
  const targets = projectNavigation(snapshot([{ ...presentation, visibility: 'parked', proxy: null, launch: 'none' }]));
  expect(targets[0]).toMatchObject({ pane: null, action: { kind: 'pane', request: { op: 'open-existing', sessionId: 'writer', generation: 'gen-1' } } });
  expect(targets[0].terminal).toBe('core-box/t2');
});
test('parked shell uses presentation revision and exact target incarnation', () => {
  const shell = { ...presentation, role: 'shell', visibility: 'parked', target: { ...execution, kind: 'terminal', sessionId: null, generation: null } } as PanePresentation;
  expect(projectNavigation(snapshot([shell], []))[0]).toMatchObject({ action: { kind: 'pane', request: { op: 'open-existing', presentationId: 'pres-1', expectedRevision: 3, targetIncarnation: { coreId: 'core-box', terminalId: 't2', createdMs: 42 } } } });
});
test('retained auxiliary opens use source-owned keys and not target addresses', () => {
  const targets = projectNavigation(snapshot());
  expect(targets.find(target => target.kind === 'subagent')).toMatchObject({ action: { kind: 'pane', request: { op: 'open-auxiliary', sessionId: 'writer', generation: 'gen-1', view: { kind: 'subagent', runId: 'run-1' } } } });
  expect(targets.find(target => target.kind === 'console')).toMatchObject({ action: { kind: 'pane', request: { op: 'open-auxiliary', sessionId: 'writer', generation: 'gen-1', view: { kind: 'console', consoleId: 'console-' + 'a'.repeat(64), machineKey: 'box-1.invalid' } } } });
});
test('not-in-hc rows disable every placement action', () => {
  const unavailable = { ...row, owner: null, target: null, unavailableReason: 'not-in-hc', children: [], consoles: [] } as PaneAgentRow;
  const target = projectNavigation(snapshot([], [unavailable]))[0];
  expect(target).toMatchObject({ action: null, disabledReason: 'Not in an hc terminal' });
  expect(menuItems({ kind: 'session', navigation: target, pane: false }, snapshot().spaces, null, null).filter(item => item.kind === 'action' || item.kind === 'tabs').every(item => item.disabled)).toBe(true);
});
test('unplaced box agent Move to tab places proxy and remembers choice', async () => {
  const target = projectNavigation(snapshot([]))[0], pane = vi.fn(async () => complete()), movePlain = vi.fn(), ipc = vi.fn();
  await moveTarget({ kind: 'session', navigation: target, pane: false }, { kind: 'tab', tab: 'tb2' }, { pane, spaces: snapshot().spaces, movePlain, ipc });
  expect(pane).toHaveBeenCalledWith(expect.objectContaining({ op: 'open-existing', sessionId: 'writer', generation: 'gen-1', slot: { space: 's1', tab: 'tb2', pane: null } }));
  expect(movePlain).not.toHaveBeenCalled(); expect(ipc).not.toHaveBeenCalled();
});
test('Move to new tab chooses a Mac tab', async () => {
  const target = projectNavigation(snapshot())[0], pane = vi.fn(async () => complete()), createTab = vi.fn(async () => ({ space: 's1', tab: 'new-tab', pane: 'waiting' })), removePlaceholder = vi.fn();
  await moveTarget({ kind: 'session', navigation: target, pane: true }, { kind: 'new' }, { pane, spaces: snapshot().spaces, createTab, removePlaceholder, ipc: vi.fn(), movePlain: vi.fn() });
  expect(createTab).toHaveBeenCalledWith('s1');
  expect(pane).toHaveBeenCalledWith(expect.objectContaining({ op: 'move', presentationId: 'pres-1', expectedRevision: 3, slot: { space: 's1', tab: 'new-tab', pane: null } }));
  expect(removePlaceholder).toHaveBeenCalledWith({ space: 's1', tab: 'new-tab', pane: 'waiting' });
});
test('drag of proxied agent moves presentation not target', async () => {
  const values = new Map(), store = { shared: (key: string) => values.get(key), setShared: (key: string, value: unknown) => values.set(key, value), now: () => 100 };
  const target = projectNavigation(snapshot())[0], pane = vi.fn(async () => complete());
  beginPresentationDrag(target, store);
  expect(JSON.stringify([...values.values()])).not.toContain('/project');
  await dropPresentation({ space: 's1', tab: 'tb2' }, { ...store, pane });
  await dropPresentation({ space: 's1', tab: 'tb2' }, { ...store, pane });
  expect(pane).toHaveBeenCalledTimes(1);
  expect(pane).toHaveBeenCalledWith(expect.objectContaining({ op: 'move', presentationId: 'pres-1', expectedRevision: 3, slot: { space: 's1', tab: 'tb2', pane: null } }));
});
test('A park records proxy intent before ending attach', async () => {
  const run = vi.fn(), request = vi.fn(async () => complete());
  await parkFocusedTerminal({ pane: 'p1', terminal: 'proxy' }, [{ address: 'proxy', state: 'live', parent: null, status: null, labels: { 'spider.kind': 'pane-proxy', 'spider.pane-id': 'pres-1' } }], HerdrLabelContract, run, vi.fn(), { snapshot: snapshot().paneSnapshot!, request });
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ op: 'park', presentationId: 'pres-1', expectedRevision: 3 }));
  expect(run).not.toHaveBeenCalled();
});
test('pane transport refuses pending acknowledgement rather than reporting success', async () => {
  const exec = vi.fn(async () => ({ code: 0, stdout: JSON.stringify({ version: 1, kind: 'outcome', outcome: { status: 'pending', reason: 'proxy-launch-uncertain', presentation: null } }) }));
  await expect(requestPaneService({ nodePath: '/fixture/node', cliPath: '/fixture/cli.mjs' }, exec, { op: 'move', presentationId: 'pres-1', expectedRevision: 3, slot: presentation.slot! })).rejects.toThrow('proxy-launch-uncertain');
});

test('only acknowledged Mac placement saves the session-ID preference and retains the execution target', async () => {
  let state = { version: 2, revision: 1, presentations: [presentation], slots: [], attempts: [], choices: [], launches: [] } as import('../panes/types.js').PlacementState;
  let placed: import('../contracts.js').OwnerPlacement | null = presentation.slot as import('../contracts.js').OwnerPlacement;
  const commands: { name: string; args: Record<string, unknown> }[] = [];
  const selected = { space: 's1', tab: 'tb2', pane: 'waiting' } as import('../contracts.js').OwnerPlacement;
  let ack = false;
  const app = {
    listSpaces: async () => [{ id: 's1', machine: null, tabs: [{ id: 'tb1' }, { id: 'tb2' }] }],
    ownerPlacement: async () => placed,
    focusedPane: async () => selected,
    command: async (name: string, args: Record<string, unknown>) => { commands.push({ name, args }); if (name === 'terminal.park') placed = null; if (name === 'terminal.keep') placed = { ...selected, pane: 'proxy-pane' as never }; return {}; },
  };
  const ports = { app, store: { read: async () => state, update: async (change: (s: typeof state) => typeof state) => state = change(state) }, hc: { identity: async () => ({ coreId: 'core-local' }), get: async () => ({ address: 'proxy', state: 'live', labels: { 'spider.kind': 'pane-proxy', 'spider.pane-id': 'pres-1', 'spider.target-core': 'core-box', 'spider.target-terminal': 't2' } }), setLabels: vi.fn() },
    verifyPlaceholder: async () => true, awaitPresented: async () => { if (!ack) throw new Error('not acknowledged'); return placed; },
  } as unknown as PaneOpenPorts;
  const reserve = vi.fn(async () => selected);
  await expect(presentExistingPane(presentation, { ...selected, pane: null }, 'move-1', ports, reserve)).rejects.toThrow('not acknowledged');
  expect(state.choices).toEqual([]);
  ack = true;
  const current = state.presentations[0];
  await presentExistingPane(current, { ...selected, pane: null }, 'move-2', ports, reserve);
  expect(state.choices).toEqual([{ session: 'writer', space: 's1', tab: 'tb2', revision: 2 }]);
  expect(state.presentations[0].target).toEqual(execution);
  expect(commands.filter(c => c.name === 'terminal.park' || c.name === 'terminal.keep').every(c => c.args.terminal === 'proxy')).toBe(true);
  expect(ports.hc.setLabels).not.toHaveBeenCalledWith(execution.address, expect.anything());
});

test('drag of an unplaced agent captures session identity and no target launch', async () => {
  const values = new Map(), store = { shared: (key: string) => values.get(key), setShared: (key: string, value: unknown) => values.set(key, value), now: () => 100 };
  const target = projectNavigation(snapshot([]))[0], pane = vi.fn(async () => complete());
  expect(beginPresentationDrag(target, store)).toBe(true);
  await dropPresentation({ space: 's1', tab: 'tb2' }, { ...store, pane });
  expect(pane).toHaveBeenCalledWith({ op: 'open-existing', sessionId: 'writer', generation: 'gen-1', slot: { space: 's1', tab: 'tb2', pane: null } });
});
test('an expired or remote drop consumes intent without any placement effect', async () => {
  const values = new Map(), store = { shared: (key: string) => values.get(key), setShared: (key: string, value: unknown) => values.set(key, value), now: () => 100 };
  const pane = vi.fn(); beginPresentationDrag(projectNavigation(snapshot())[0], store);
  expect(await dropPresentation({ space: 'box-1.invalid/s1', tab: 'remote-tab' }, { ...store, pane })).toBe(false);
  beginPresentationDrag(projectNavigation(snapshot())[0], store);
  expect(await dropPresentation({ space: 's1', tab: 'tb2' }, { ...store, now: () => 40000, pane })).toBe(false);
  expect(pane).not.toHaveBeenCalled();
});


test('retained auxiliary Move opens its source-owned view then moves the acknowledged presentation', async () => {
  const target = projectNavigation(snapshot()).find(target => target.kind === 'subagent')!;
  const auxiliary = { ...presentation, id: 'aux-view', revision: 7, role: 'subagent' as const };
  const pane = vi.fn(async (_request: unknown) => complete(auxiliary));
  await moveTarget({ kind: 'subagent', navigation: target, pane: false }, { kind: 'tab', tab: 'tb2' }, { pane, spaces: snapshot().spaces, ipc: vi.fn(), movePlain: vi.fn() });
  expect(pane.mock.calls.map(call => call[0])).toEqual([
    expect.objectContaining({ op: 'open-auxiliary', sessionId: 'writer', generation: 'gen-1', view: { kind: 'subagent', runId: 'run-1' } }),
    { op: 'move', presentationId: 'aux-view', expectedRevision: 7, slot: { space: 's1', tab: 'tb2', pane: null } },
  ]);
});
test('drag never reports a pending placement as complete', async () => {
  const values = new Map(), store = { shared: (key: string) => values.get(key), setShared: (key: string, value: unknown) => values.set(key, value), now: () => 100 };
  beginPresentationDrag(projectNavigation(snapshot())[0], store);
  await expect(dropPresentation({ space: 's1', tab: 'tb2' }, { ...store, pane: async () => ({ status: 'pending', reason: 'unplaced-target', presentation: null }) })).rejects.toThrow('unplaced-target');
  expect(values.get('spider.presentation-drag')).toBeNull();
});


function unplacedProxyPorts() {
  let state = { version: 2, revision: 1, presentations: [{ ...presentation, proxy: null, launch: 'none' }], slots: [], attempts: [], choices: [], launches: [] } as import('../panes/types.js').PlacementState;
  let placed: import('../contracts.js').OwnerPlacement | null = null;
  const events: string[] = [], selected = { space: 's1', tab: 'tb2', pane: 'waiting' } as import('../contracts.js').OwnerPlacement;
  const ports = { app: {
    listSpaces: async () => [{ id: 's1', machine: null, tabs: [{ id: 'tb2' }] }], ownerPlacement: async () => placed, focusedPane: async () => selected,
    command: async (name: string) => { events.push(name); if (name === 'terminal.keep') placed = { ...selected, pane: 'shown' as never }; return {}; },
  }, store: { read: async () => state, update: async (change: (s: typeof state) => typeof state) => state = change(state) },
  hc: { identity: async () => ({ coreId: 'core-local' }), get: async () => ({ address: 'new-proxy', state: 'live', labels: { 'spider.kind': 'pane-proxy', 'spider.pane-id': 'pres-1', 'spider.target-core': 'core-box', 'spider.target-terminal': 't2' } }), setLabels: vi.fn() },
  verifyPlaceholder: async () => { events.push('prove'); return true; }, findProxy: async () => null,
  launchProxy: vi.fn(async () => { events.push('launch'); expect(state.presentations[0]).toMatchObject({ launch: 'claimed', proxy: null }); return 'new-proxy'; }),
  awaitPresented: async () => placed,
  } as unknown as PaneOpenPorts;
  return { ports, events, selected, state: () => state, reserve: async () => { events.push('reserve'); return selected; } };
}
test('first proxy placement proves the Mac placeholder before a durable display launch claim', async () => {
  const h = unplacedProxyPorts();
  const result = await presentExistingPane(h.state().presentations[0], { ...h.selected, pane: null }, 'first-move', h.ports, h.reserve);
  expect(h.events.indexOf('prove')).toBeLessThan(h.events.indexOf('launch'));
  expect(h.ports.launchProxy).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ proxy: 'new-proxy', launch: 'acknowledged', slot: { space: 's1', tab: 'tb2', pane: 'shown' } });
  expect(result.target).toEqual(execution);
  expect(h.state().choices).toMatchObject([{ session: 'writer', space: 's1', tab: 'tb2' }]);
});
test('an uncertain first proxy launch recovers its live display without a duplicate', async () => {
  const h = unplacedProxyPorts(); let launched = false;
  vi.mocked(h.ports.launchProxy).mockImplementation(async () => { launched = true; throw new Error('lost acknowledgement'); });
  h.ports.findProxy = async () => launched ? 'new-proxy' as never : null;
  await expect(presentExistingPane(h.state().presentations[0], h.selected, 'lost-launch', h.ports, h.reserve)).rejects.toMatchObject({ code: 'proxy-launch-uncertain' });
  expect(h.state().presentations[0]).toMatchObject({ launch: 'uncertain', proxy: null });
  expect(await presentExistingPane(h.state().presentations[0], h.selected, 'retry-launch', h.ports, h.reserve)).toMatchObject({ proxy: 'new-proxy', launch: 'acknowledged' });
  expect(h.ports.launchProxy).toHaveBeenCalledTimes(1);
});
test('a proved absent uncertain proxy launch can be retried', async () => {
  const h = unplacedProxyPorts(), launch = vi.mocked(h.ports.launchProxy).getMockImplementation()!;
  vi.mocked(h.ports.launchProxy).mockRejectedValueOnce(new Error('launch failed'));
  await expect(presentExistingPane(h.state().presentations[0], h.selected, 'failed-launch', h.ports, h.reserve)).rejects.toMatchObject({ code: 'proxy-launch-uncertain' });
  vi.mocked(h.ports.launchProxy).mockImplementation(launch);
  expect(await presentExistingPane(h.state().presentations[0], h.selected, 'retry-launch', h.ports, h.reserve)).toMatchObject({ proxy: 'new-proxy', launch: 'acknowledged' });
  expect(h.ports.launchProxy).toHaveBeenCalledTimes(2);
});
test.each(['closing', 'ended'] as const)('a refused %s reopen allocates no placeholder', async visibility => {
  const h = unplacedProxyPorts();
  await h.ports.store.update(state => ({ ...state, presentations: state.presentations.map(p => ({ ...p, visibility, closeOperationId: visibility === 'closing' ? 'close-1' : null })) }));
  await expect(presentExistingPane(h.state().presentations[0], h.selected, 'refused-reopen', h.ports, h.reserve)).rejects.toMatchObject({ code: 'stale-presentation' });
  expect(h.events).not.toContain('reserve'); expect(h.ports.launchProxy).not.toHaveBeenCalled();
});
test('an unproved Mac placeholder creates no proxy and saves no preference', async () => {
  const h = unplacedProxyPorts(); h.ports.verifyPlaceholder = async () => false;
  await expect(presentExistingPane(h.state().presentations[0], h.selected, 'bad-placeholder', h.ports, h.reserve)).rejects.toMatchObject({ code: 'placeholder-unavailable' });
  expect(h.ports.launchProxy).not.toHaveBeenCalled(); expect(h.state().choices).toEqual([]);
});


test('child action authority follows the projected session generation, not an older duplicate row', () => {
  const older = { ...row, generation: 'old-gen', updatedAt: 50, target: { ...execution, generation: 'old-gen' } } as PaneAgentRow;
  const targets = projectNavigation(snapshot([], [older, row]));
  expect(targets.find(target => target.kind === 'subagent')).toMatchObject({ action: { kind: 'pane', request: { sessionId: 'writer', generation: 'gen-1', view: { kind: 'subagent', runId: 'run-1' } } } });
});
test('the sidebar includes only agents while Go to retains parked shell navigation', () => {
  const shell = { ...presentation, role: 'shell', visibility: 'parked', target: { ...execution, kind: 'terminal', sessionId: null, generation: null } } as PanePresentation;
  const input = snapshot([shell], []);
  expect(projectNavigation(input).map(target => target.kind)).toEqual(['terminal']);
  expect(navigationAgents(input)).toEqual([]);
});


test.each(['pane-proxy', 'roam-proxy'])('fallback navigation never mistakes a box %s for a Mac display', kind => {
  const input = snapshot([], []); input.paneSnapshot = null;
  input.terminals = [{ address: 'box-1.invalid/t2', parent: null, labels: { 'spider.kind': kind }, state: 'live', status: 'working' }];
  input.panes = [{ pane: 'remote-pane', terminal: 'box-1.invalid/t2', tab: 'remote-tab', cwd: null }];
  expect(projectNavigation(input).map(target => target.action)).toEqual([null]);
});


test('native Mac spaces with an omitted machine field retain local grouping and Move destinations', async () => {
  const input = snapshot([], []);
  input.spaces = input.spaces.filter(space => space.machine === null).map(space => { const { machine, ...native } = space; return native; });
  input.agents = [{ ...input.agents[0], address: 'native-local', pane: 'local-pane', space: 's1', tab: 'tb1' }];
  input.panes = [{ pane: 'local-pane', terminal: 'native-local', tab: 'tb1', cwd: null }];
  expect(pickerRows(input.spaces, projectNavigation(input), '').some(row => row.kind === 'space' && row.label === 'Work')).toBe(true);
  expect(navigationAgents(input)[0]).toMatchObject({ space: 's1', tab: 'tb1', navigation: { action: { kind: 'focus', pane: 'local-pane' } } });
  const pane = vi.fn(async () => complete());
  await moveTarget({ kind: 'session', navigation: projectNavigation(snapshot())[0] }, { kind: 'tab', tab: 'tb2' }, { pane, spaces: input.spaces, ipc: vi.fn(), movePlain: vi.fn() });
  expect(pane).toHaveBeenCalledWith(expect.objectContaining({ slot: { space: 's1', tab: 'tb2', pane: null } }));
});
