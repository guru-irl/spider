// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, it } from 'vitest';
import * as move from '../../assets/agents/move.js';
import { HerdrLabelContract } from '../contracts.js';
import { FEED_DISCONNECT_MS } from '../../assets/shared/feed.js';

const spaces = [
  { id: 's2', name: 'Other space', tabs: [{ id: 't3', name: 'Review' }] },
  { id: 's1', name: 'Current space', tabs: [{ id: 't1', name: 'Current' }, { id: 't2', name: 'Work' }] },
];
const labels = (items: any[]) => items.map(item => item.label ?? item.kind);

it('offers move or open actions for subagent rows and places kill last', () => {
  expect((move as any).menuItems).toBeTypeOf('function');
  const menu = (move as any).menuItems;
  expect(labels(menu({ kind: 'subagent', pane: true, active: true }, spaces, 's1', 't1'))).toEqual(['Move to new tab', 'Move to tab', 'Hide', 'separator', 'Kill subagent']);
  expect(labels(menu({ kind: 'subagent', pane: false, active: true }, spaces, 's1', null))).toEqual(['Open in new tab', 'Open in tab', 'separator', 'Kill subagent']);
  const saved = menu({ kind: 'subagent', pane: false, active: false }, spaces, 's1', null);
  expect(labels(saved)).toEqual(['Open in new tab', 'Open in tab', 'separator', 'Kill subagent']);
  expect(saved.at(-1).disabled).toBe(true);
});

it('keeps the Move verb for a pane header with unspecified pane presence', () => {
  const items = move.menuItems({ kind: 'command', descriptor: { generation: 'gen' } }, spaces, 's1', 't1');
  expect(labels(items).slice(0, 2)).toEqual(['Move to new tab', 'Move to tab']);
});

it('offers the right kill action for each terminal pane and none for a mod pane', () => {
  expect((move as any).menuItems).toBeTypeOf('function');
  const menu = (move as any).menuItems;
  for (const [kind, kill] of [['subagent', 'Kill subagent'], ['command', 'Kill command'], ['session', 'Kill session…'], ['terminal', 'Kill terminal']]) {
    const items = menu({ kind, pane: true, active: true }, spaces, 's1', 't1');
    expect(labels(items).slice(0, 2)).toEqual(['Move to new tab', 'Move to tab']);
    expect(labels(items).slice(-2)).toEqual(['separator', kill]);
  }
  expect(menu({ kind: 'mod' }, spaces, 's1', 't1')).toEqual([]);
});

it('groups other tabs by space with the current space first', () => {
  expect((move as any).menuItems).toBeTypeOf('function');
  const items = (move as any).menuItems({ kind: 'terminal', pane: true }, spaces, 's1', 't1');
  expect(items[1].groups).toEqual([
    { id: 's1', name: 'Current space', tabs: [{ id: 't2', name: 'Work' }] },
    { id: 's2', name: 'Other space', tabs: [{ id: 't3', name: 'Review' }] },
  ]);
});

it('omits tabs on machines other than the terminal\'s machine', () => {
  const mixed = [...spaces, { id: 'remote.invalid/s3', name: 'Remote', machine: 'remote.invalid', tabs: [{ id: 'remote.invalid/t4', name: 'Remote tab' }] }];
  const items = (move as any).menuItems({ kind: 'terminal', pane: true, machine: null }, mixed, 's1', 't1');
  expect(items[1].groups.map((group: { id: string }) => group.id)).toEqual(['s1', 's2']);
});

it.each([
  ['remote terminal', {}],
  ['remote console', { [HerdrLabelContract.labels.kind]: HerdrLabelContract.kinds.remoteConsole }],
])('offers same-machine moves and terminal kill for a %s pane', (_name, terminalLabels) => {
  const address = 'remote.invalid/t5';
  const pane = { pane: 'remote.invalid/p5', terminal: address, tab: 'remote.invalid/t1', program: { key: 'shell' } };
  const target = move.classifyPane(pane, { address, labels: terminalLabels }, [], HerdrLabelContract, 0);
  const choices = [
    { id: 'remote.invalid/s1', name: 'Remote', machine: 'remote.invalid', tabs: [{ id: 'remote.invalid/t1', name: 'Current' }, { id: 'remote.invalid/t2', name: 'Work' }] },
    { id: 's1', name: 'Local', machine: null, tabs: [{ id: 't2', name: 'Local tab' }] },
  ];
  const items = move.menuItems(target, choices, 'remote.invalid/s1', pane.tab);
  expect(target).toMatchObject({ kind: 'terminal', machine: 'remote.invalid' });
  expect(labels(items)).toEqual(['Move to new tab', 'Move to tab', 'separator', 'Kill terminal']);
  expect(items[1]).toMatchObject({ kind: 'tabs', groups: [{ id: 'remote.invalid/s1', name: 'Remote', tabs: [{ id: 'remote.invalid/t2', name: 'Work' }] }] });
  expect(items.slice(0, 2).every((item: any) => !item.disabled)).toBe(true);
});

it('identifies session, subagent, command and plain terminal panes from their live identities', () => {
  expect((move as any).classifyPane).toBeTypeOf('function');
  const classify = (pane: unknown, terminal: unknown, feeds: unknown[], contract: unknown) => move.classifyPane(pane, terminal, feeds, contract, Date.now() - FEED_DISCONNECT_MS);
  const feed = { sessionId: 'owner', generation: 'gen', lifecycle: 'live', updatedAt: Date.now(), ipc: { address: 'socket', capabilityFile: 'cap' }, owner: { terminal: { address: 'parent' } }, runs: { rows: [{ id: 'run', status: 'running' }] } };
  const pane = (terminal: string, program = 'shell') => ({ pane: `pane-${terminal}`, terminal, program: { key: program }, tab: 't1' });
  const t = (address: string, kind: string | null, extra: Record<string, string> = {}) => ({ address, labels: { ...(kind ? { 'spider.kind': kind } : {}), ...extra } });
  expect(classify(pane('parent', 'pi'), t('parent', null), [feed], HerdrLabelContract)).toMatchObject({ kind: 'session' });
  expect(classify(pane('other-pi', 'pi'), t('other-pi', null), [], HerdrLabelContract)).toMatchObject({ kind: 'session' });
  expect(classify(pane('view'), t('view', 'subagent-viewer', { 'spider.session': 'owner', 'spider.run': 'run' }), [feed], HerdrLabelContract)).toMatchObject({ kind: 'subagent', key: 'run', active: true, descriptor: { sessionId: 'owner', generation: 'gen' } });
  expect(classify(pane('observer'), t('observer', 'remote-observer', { 'spider.session': 'owner', 'spider.job': 'job' }), [feed], HerdrLabelContract)).toMatchObject({ kind: 'command', key: 'job', descriptor: { sessionId: 'owner' } });
  expect(classify(pane('shell'), t('shell', null), [], HerdrLabelContract)).toMatchObject({ kind: 'terminal' });
  expect(classify({ pane: 'p-mod', terminal: null, mod: 'board' }, null, [], HerdrLabelContract)).toMatchObject({ kind: 'mod' });
});

it('sends subagent and command kills to their owners, and confirms a session kill', async () => {
  expect((move as any).killTarget).toBeTypeOf('function');
  const actions: any[] = [], descriptor = { version: 1, sessionId: 'owner', generation: 'gen', address: 'socket', capabilityFile: 'cap' };
  const ports = { ipc: async (target: unknown, request: unknown) => { actions.push(['ipc', target, request]); },
    run: (name: string, args: unknown) => { actions.push(['run', name, args]); },
    confirm: (spec: unknown) => { actions.push(['confirm', spec]); } };
  await (move as any).killTarget({ kind: 'subagent', key: 'run', terminal: 'viewer', descriptor }, ports);
  await (move as any).killTarget({ kind: 'command', key: 'job', terminal: 'observer', descriptor }, ports);
  const session = { kind: 'session', terminal: 'parent', ownsSession: true, descriptor };
  await (move as any).killTarget(session, ports);
  await (move as any).killTarget({ kind: 'terminal', terminal: 'shell' }, ports);
  expect(actions).toEqual([
    ['ipc', descriptor, { op: 'killRun', runId: 'run', generation: 'gen' }],
    ['ipc', descriptor, { op: 'killJob', jobId: 'job', generation: 'gen' }],
    ['confirm', { title: 'Kill session?', detail: 'This stops the session and its subagents.', target: session }],
    ['run', 'terminal.kill', { terminal: 'shell' }],
  ]);
  await expect((move as any).killTarget({ kind: 'subagent', key: 'run', terminal: 'viewer', descriptor: null }, ports)).rejects.toThrow();
  expect(actions).toHaveLength(4);
});

it('does not treat an inherited session label as ownership of a terminal', async () => {
  const feed = { sessionId: 'owner', generation: 'gen', lifecycle: 'live', updatedAt: Date.now(), ipc: { address: 'socket', capabilityFile: 'cap' }, owner: { terminal: { address: 'parent' } } };
  const target = move.classifyPane({ terminal: 'other', program: { key: 'pi' } }, { labels: { 'spider.session': 'owner' } }, [feed], HerdrLabelContract, Date.now() - FEED_DISCONNECT_MS);
  expect(target.ownsSession).toBe(false);
  await expect(move.stopSessionTarget(target, { ipc: async () => { throw new Error('Wrong owner must not be called'); } })).rejects.toThrow('This session is unavailable');
  const exact = move.classifyPane({ terminal: 'parent' }, { labels: { 'spider.session': 'stale' } }, [{ ...feed, sessionId: 'stale', owner: { terminal: { address: 'different' } } }, feed], HerdrLabelContract, Date.now() - FEED_DISCONNECT_MS);
  expect(exact).toMatchObject({ kind: 'session', ownsSession: true, descriptor: { sessionId: 'owner' } });
});

it('routes viewer, command and session moves through their owners', async () => {
  expect((move as any).moveTarget).toBeTypeOf('function');
  const actions: any[] = [], descriptor = { version: 1, sessionId: 'owner', generation: 'gen', address: 'socket', capabilityFile: 'cap' };
  const ports = { ipc: async (target: unknown, request: unknown) => { actions.push(['ipc', target, request]); },
    movePlain: async (terminal: string, destination: unknown) => { actions.push(['plain', terminal, destination]); } };
  const destination = { kind: 'tab', tab: 'target' };
  await (move as any).moveTarget({ kind: 'subagent', key: 'run', descriptor }, destination, ports);
  await (move as any).moveTarget({ kind: 'command', key: 'job', terminal: 'observer', descriptor }, destination, ports);
  await (move as any).moveTarget({ kind: 'session', terminal: 'parent', descriptor }, destination, ports);
  await (move as any).moveTarget({ kind: 'terminal', terminal: 'shell' }, destination, ports);
  expect(actions).toEqual([
    ['ipc', descriptor, { op: 'moveRun', runId: 'run', destination, generation: 'gen' }],
    ['ipc', descriptor, { op: 'moveJob', jobId: 'job', viewer: 'observer', destination, generation: 'gen' }],
    ['ipc', descriptor, { op: 'moveSession', destination, generation: 'gen' }],
    ['plain', 'shell', destination],
  ]);
  await expect((move as any).moveTarget({ kind: 'session', terminal: 'parent', descriptor: null }, destination, ports)).rejects.toThrow();
  expect(actions).toHaveLength(4);
  await (move as any).moveTarget({ kind: 'session', terminal: 'unmanaged', descriptor: null, unmanaged: true }, destination, ports);
  expect(actions.at(-1)).toEqual(['plain', 'unmanaged', destination]);
});

it('checks both supported setup journal formats before treating a session as unmanaged', () => {
  expect((move as any).journalOwnsTerminal).toBeTypeOf('function');
  const owns = (move as any).journalOwnsTerminal;
  expect(owns(null, 't1')).toBe(false);
  expect(owns(JSON.stringify({ version: 1, tabs: [{ placement: { terminal: 't1' } }] }), 't1')).toBe(true);
  expect(owns(JSON.stringify({ version: 2, tabs: [{ sessions: [{ terminal: 't1' }] }] }), 't1')).toBe(true);
  expect(owns(JSON.stringify({ version: 2, tabs: [{ sessions: [{ terminal: 't2' }] }] }), 't1')).toBe(false);
  expect(() => owns('invalid', 't1')).toThrow();
});
