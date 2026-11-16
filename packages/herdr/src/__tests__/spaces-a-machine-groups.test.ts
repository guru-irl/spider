// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import { agentMachine, groupAgentsByMachine, machineGroupCounts } from '../../assets/agents/grouping.js';
import { createMachineConnections, machineConnection, machineRebuilt } from '../../assets/agents/connections.js';
import type { NativeAgent } from '../../assets/agents/grouping.js';
import type { AgentTerminal, ChildRow } from '../../assets/agents/children.js';
import { HerdrLabelContract } from '../contracts.js';

function agent(address: string, pinned = false): NativeAgent {
  return { address, pane: `pane-${address}`, space: 's1', space_name: 'Work', tab: 'tab', title: 'Writer',
    program: { name: 'pi' }, status: 'idle', pinned, focused: false };
}
function terminal(address: string, labels: Record<string, string> = {}): AgentTerminal {
  return { address, parent: null, state: 'live', status: 'idle', labels };
}
function child(key: string, kind: ChildRow['kind'], overrides: Partial<ChildRow> = {}): ChildRow {
  return { key, kind, address: key, originalAddress: key, name: key, description: null, status: 'working',
    outcome: null, completeness: 'unknown', finishedAt: null, retained: false, depth: 0, parentKey: null,
    machine: null, terminal: terminal(key), action: null, ...overrides };
}

it('groups nonadjacent agents once per machine, including idle machines', () => {
  const box2First = agent('box-2.invalid/a');
  const localFirst = agent('local-a');
  const box1 = agent('box-1.invalid/a');
  const box2Second = agent('box-2.invalid/b');
  const discovered = agent('box-3.invalid/a');
  const agents = Object.freeze([box2First, localFirst, box1, box2Second, discovered]);
  const groups = groupAgentsByMachine(agents, [], HerdrLabelContract, [
    { name: 'box-4.invalid' }, { name: 'box-2.invalid' }, { name: null },
    { name: 'box-1.invalid' }, { name: 'box-2.invalid' },
  ]);

  expect(groups.map(group => group.label)).toEqual([
    'This computer', 'box-1.invalid', 'box-2.invalid', 'box-3.invalid', 'box-4.invalid',
  ]);
  expect(groups.map(group => group.machine)).toEqual([null, 'box-1.invalid', 'box-2.invalid', 'box-3.invalid', 'box-4.invalid']);
  expect(groups.map(group => group.id)).toEqual(['machine:', 'machine:box-1.invalid', 'machine:box-2.invalid', 'machine:box-3.invalid', 'machine:box-4.invalid']);
  expect(groups[2].members.map(member => member.address)).toEqual(['box-2.invalid/a', 'box-2.invalid/b']);
  expect(groups[4].members).toEqual([]);
  expect(groups.flatMap(group => group.members)).toHaveLength(agents.length);
  expect(agents.map(member => member.address)).toEqual(['box-2.invalid/a', 'local-a', 'box-1.invalid/a', 'box-2.invalid/b', 'box-3.invalid/a']);
});

it('attributes a local roaming proxy to its remote owner', () => {
  const proxy = agent('proxy');
  const labelled = terminal('proxy', { 'spider.kind': 'roam-proxy', 'spider.machine': 'box-1.invalid', 'spider.owner-terminal': 'box-2.invalid/owner' });
  const fallback = terminal('proxy', { 'spider.kind': 'roam-proxy', 'spider.owner-terminal': 'box-2.invalid/owner' });
  const ordinary = terminal('proxy', { 'spider.kind': 'session', 'spider.machine': 'box-1.invalid' });

  expect(agentMachine(proxy, [labelled], HerdrLabelContract)).toBe('box-1.invalid');
  expect(agentMachine(proxy, [fallback], HerdrLabelContract)).toBe('box-2.invalid');
  expect(agentMachine(proxy, [ordinary], HerdrLabelContract)).toBeNull();
  expect(agentMachine(agent('box-2.invalid/remote'), [terminal('box-2.invalid/remote', { 'spider.machine': 'box-1.invalid' })], HerdrLabelContract)).toBe('box-2.invalid');
  expect(agentMachine(proxy, [terminal('proxy', { 'spider.kind': 'roam-proxy', 'spider.owner-terminal': 'owner' })], HerdrLabelContract)).toBeNull();
});

it('counts only live reachable children in folded pills', () => {
  const runningRun = child('run', 'subagent');
  const unreachableRun = child('unreachable', 'subagent', { status: 'unreachable' });
  const retainedRun = child('retained', 'subagent', { retained: true, status: 'done' });
  const consoleRow = child('console', 'console');
  const command = child('job', 'remote', { parentKey: 'console' });
  const unavailableConsole = child('unavailable-console', 'console', { status: 'unreachable' });
  const finishedConsole = child('finished-console', 'console', { terminal: { ...terminal('finished-console'), state: 'finished' } });

  expect(machineGroupCounts([runningRun, unreachableRun, retainedRun, consoleRow, command, unavailableConsole, finishedConsole]))
    .toEqual({ subagents: 1, consoles: 1 });
  expect(machineGroupCounts([])).toEqual({ subagents: 0, consoles: 0 });
  expect(machineGroupCounts([child('native-child', 'native'), child('unattached-job', 'remote')]))
    .toEqual({ subagents: 2, consoles: 0 });
});

it.each([
  ['connected', 'connected'],
  ['disconnected', 'disconnected'],
  ['unreachable', 'disconnected'],
  ['stopped', 'disconnected'],
  ['needs_login', 'needs-login'],
  ['needs-login', 'needs-login'],
  ['connecting', 'unknown'],
] as const)('reports machine state %s as %s', (state, expected) => {
  expect(machineConnection('box-1.invalid', [{ name: 'box-1.invalid', state }])).toBe(expected);
});

it('recognizes a replaced remote core without treating ordinary outages as rebuilds', () => {
  expect(machineRebuilt({ name: 'box-1.invalid', state: 'unreachable', why: 'a different core answers there ("new-core")' })).toBe(true);
  expect(machineRebuilt({ name: 'box-1.invalid', state: 'unreachable', why: 'network unavailable' })).toBe(false);
  expect(machineRebuilt({ name: 'box-1.invalid', state: 'connected', why: 'a different core answers there ("new-core")' })).toBe(false);
  expect(machineRebuilt(null)).toBe(false);
});

it('uses core availability for the local heading and dims a failed refresh', () => {
  const snapshot = [{ name: null, state: 'connected' }, { name: 'box-1.invalid', state: 'connected' }];
  expect(machineConnection(null, snapshot)).toBe('connected');
  expect(machineConnection(null, [{ name: null, state: 'disconnected' }])).toBe('disconnected');
  expect(machineConnection(null, [{ name: 'box-1.invalid', state: 'connected' }])).toBe('unknown');
  expect(machineConnection('box-1.invalid', snapshot)).toBe('connected');
  expect(machineConnection('box-1.invalid', null)).toBe('unknown');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function journal(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
const ok = (value: unknown = {}) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });

it('pins an agent once inside its machine group', () => {
  const local = agent('local');
  const remote = agent('box-1.invalid/a');
  const pinned = agent('box-1.invalid/pinned', true);
  const otherPinned = agent('box-1.invalid/pinned-next', true);
  const groups = groupAgentsByMachine([remote, local, pinned, otherPinned], [], HerdrLabelContract, []);
  const members = groups.find(group => group.machine === 'box-1.invalid')!.members;

  expect(members.map(member => member.address)).toEqual(['box-1.invalid/pinned', 'box-1.invalid/pinned-next', 'box-1.invalid/a']);
  expect(groups.flatMap(group => group.members).filter(member => member.address === pinned.address)).toHaveLength(1);
});

it('discovers idle and temporary machines and dims remote dots after a failed refresh', async () => {
  const inventory = [
    { name: 'box-1.invalid', id: 'remote-1', state: 'connected', target: 'ssh-one.invalid' },
    { name: 'box-2.invalid', id: 'remote-2', state: 'disconnected', target: 'ssh-two.invalid', temporary: true },
    { name: 'box-3.invalid', id: 'remote-3', state: 'needs_login', target: 'ssh-three.invalid' },
  ];
  const calls: string[][] = [], store = journal();
  let failed = false;
  const manager = createMachineConnections({ storage: store, notify() {}, hc: async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'server') return ok({ core: { id: 'local-core' } });
    return failed ? { code: 1, stdout: '', stderr: 'offline' } : ok({ machines: inventory });
  } });
  await manager.refresh();
  expect(manager.machines.map(machine => machine.name)).toEqual(['box-1.invalid', 'box-2.invalid', 'box-3.invalid']);
  expect(manager.coreId).toBe('local-core');
  expect([null, 'box-1.invalid', 'box-2.invalid', 'box-3.invalid'].map(name => machineConnection(name, manager.snapshot)))
    .toEqual(['connected', 'connected', 'disconnected', 'needs-login']);
  failed = true;
  await manager.refresh();
  expect(manager.machines.map(machine => machine.name)).toEqual(['box-1.invalid', 'box-2.invalid', 'box-3.invalid']);
  expect(machineConnection('box-1.invalid', manager.snapshot)).toBe('unknown');
  expect(machineConnection(null, manager.snapshot)).toBe('connected');
  expect(calls.filter(args => args[1] === 'rm' || args[1] === 'add')).toEqual([]);
});

it('reconnects only on request, preserving target, via, session and temporary flags', async () => {
  const target = { name: 'box-1.invalid', id: 'remote', state: 'unreachable', target: 'host.invalid', via: true, session: 'work', temporary: true };
  const calls: string[][] = [], store = journal(), removing = deferred<ReturnType<typeof ok>>(), adding = deferred<ReturnType<typeof ok>>(), addStarted = deferred<void>();
  const manager = createMachineConnections({ storage: store, notify() {}, hc: async (args: string[]) => {
    calls.push(args);
    if (args[1] === 'rm') return removing.promise;
    if (args[1] === 'add') { addStarted.resolve(undefined); return adding.promise; }
    return args[0] === 'server' ? ok({ core: { id: 'local-core' } }) : ok({ machines: [target] });
  } });
  await manager.refresh();
  const first = manager.reconnect(target.name), second = manager.reconnect(target.name);
  expect(manager.repair(target.name)?.busy).toBe(true);
  expect(calls.filter(args => args[1] === 'rm')).toEqual([['machine', 'rm', 'box-1.invalid', '--json']]);
  removing.resolve(ok());
  await addStarted.promise;
  expect(JSON.parse(store.values.get('machines.reconnecting')!)['box-1.invalid'].removed).toBe(true);
  expect(calls.filter(args => args[1] === 'add')).toEqual([['machine', 'add', '--via', 'host.invalid', '--name', 'box-1.invalid', '--session', 'work', '--temp', '--json']]);
  adding.resolve(ok());
  await Promise.all([first, second]);
  expect(manager.repair(target.name)).toBeNull();
  expect(JSON.parse(store.values.get('machines.reconnecting')!)).toEqual({});
});

it('resumes a journaled partial reconnect without removing the machine twice', async () => {
  const machine = { name: 'box-1.invalid', state: 'unreachable', target: 'ssh-target', session: 'work' };
  const store = journal({ 'machines.reconnecting': { 'box-1.invalid': { machine, removed: true, busy: true, error: 'old error' } } });
  const calls: string[][] = [];
  const manager = createMachineConnections({ storage: store, notify() {}, hc: async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'server') return ok({ core: { id: 'local-core' } });
    if (args[1] === 'ls') return ok({ machines: [] });
    return ok();
  } });
  await manager.refresh();
  expect(manager.machines.map(item => item.name)).toContain('box-1.invalid');
  expect(manager.repair('box-1.invalid')?.busy).toBe(false);
  await manager.reconnect('box-1.invalid');
  expect(calls.filter(args => args[1] === 'rm')).toEqual([]);
  expect(calls.filter(args => args[1] === 'add')).toEqual([['machine', 'add', 'ssh-target', '--name', 'box-1.invalid', '--session', 'work', '--json']]);
  expect(manager.repair('box-1.invalid')).toBeNull();
});

it('exposes reconnect errors and retries a failed add without another remove', async () => {
  const machine = { name: 'box-1.invalid', state: 'unreachable', target: 'ssh-target' };
  const calls: string[][] = [], store = journal();
  let addFails = true;
  const manager = createMachineConnections({ storage: store, notify() {}, hc: async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'server') return ok({ core: { id: 'local-core' } });
    if (args[1] === 'ls') return ok({ machines: [machine] });
    if (args[1] === 'add' && addFails) return { code: 1, stdout: JSON.stringify({ error: { message: 'login required' } }), stderr: '' };
    return ok();
  } });
  await manager.refresh();
  await manager.reconnect(machine.name);
  expect(manager.repair(machine.name)).toMatchObject({ removed: true, busy: false, error: 'login required' });
  addFails = false;
  await manager.reconnect(machine.name);
  expect(calls.filter(args => args[1] === 'rm')).toHaveLength(1);
  expect(calls.filter(args => args[1] === 'add')).toHaveLength(2);
  expect(manager.repair(machine.name)).toBeNull();
  await manager.reconnect('not-known');
  expect(calls.filter(args => args[1] === 'rm')).toHaveLength(1);
});

it('reconciles a removed machine after a lost remove reply', async () => {
  const machine = { name: 'box-1.invalid', state: 'unreachable', target: 'ssh-target' };
  const store = journal(), calls: string[][] = [];
  let removed = false;
  const manager = createMachineConnections({ storage: store, notify() {}, hc: async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'server') return ok({ core: { id: 'local-core' } });
    if (args[1] === 'ls') return ok({ machines: removed ? [] : [machine] });
    if (args[1] === 'rm') { removed = true; throw new Error('reply lost'); }
    return ok();
  } });
  await manager.refresh();
  await manager.reconnect(machine.name);
  expect(calls.filter(args => args[1] === 'rm')).toHaveLength(1);
  expect(calls.filter(args => args[1] === 'add')).toEqual([['machine', 'add', 'ssh-target', '--name', 'box-1.invalid', '--json']]);
  expect(manager.repair(machine.name)).toBeNull();
});

it('keeps recovery safe when the machine inventory is malformed', async () => {
  const machine = { name: 'box-1.invalid', state: 'unreachable', target: 'ssh-target' };
  const calls: string[][] = [];
  let malformed = false;
  const manager = createMachineConnections({ storage: journal(), notify() {}, hc: async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'server') return ok({ core: { id: 'local-core' } });
    if (args[1] === 'ls') return ok({ machines: malformed ? [{}] : [machine] });
    if (args[1] === 'rm') { malformed = true; throw new Error('reply lost'); }
    return ok();
  } });
  await manager.refresh();
  await manager.reconnect(machine.name);
  expect(calls.filter(args => args[1] === 'add')).toEqual([]);
  expect(manager.repair(machine.name)).toMatchObject({ removed: false, error: 'reply lost' });
  expect(manager.machines.map(item => item.name)).toContain(machine.name);
  expect(machineConnection(machine.name, manager.snapshot)).toBe('unknown');
});

it('does not let an older refresh overwrite a newer connection snapshot', async () => {
  const old = deferred<ReturnType<typeof ok>>(), fresh = deferred<ReturnType<typeof ok>>();
  let listing = 0;
  const manager = createMachineConnections({ storage: journal(), notify() {}, hc: async (args: string[]) => {
    if (args[0] === 'server') return ok({ core: { id: 'local-core' } });
    return ++listing === 1 ? old.promise : fresh.promise;
  } });
  const first = manager.refresh(), second = manager.refresh();
  fresh.resolve(ok({ machines: [{ name: 'fresh.invalid', state: 'connected', target: 'new' }] }));
  await second;
  old.resolve(ok({ machines: [{ name: 'old.invalid', state: 'disconnected', target: 'old' }] }));
  await first;
  expect(manager.machines.map(machine => machine.name)).toEqual(['fresh.invalid']);
  expect(machineConnection('fresh.invalid', manager.snapshot)).toBe('connected');
});
