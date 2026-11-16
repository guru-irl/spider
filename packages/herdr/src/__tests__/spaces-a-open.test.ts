// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '@spider/db-core';
import { HerdrError } from '../client/parse.js';
import { createAppClient } from '../client/app.js';
import { createHcClient } from '../client/hc.js';
import { createClientFixture, terminal as fakeTerminal } from './testutil.js';
import { HERDR_KINDS, HERDR_LABELS, type AppClient, type AppPaneInspection, type AppSpaceInfo, type CoreId, type Destination, type HcClient, type MachineSummary, type Owner, type OwnerPlacement, type PaneId, type SpaceId, type TabId, type TerminalAddress, type TerminalSummary } from '../contracts.js';
import { withProcessLock } from '../sessions/registry.js';
import { openOwnedSession } from '../spaces/open.js';

const root = join(paths.scratch('worktree', process.cwd()), 'a2-open');
let placementRoot: string;
beforeEach(async () => { await mkdir(root, { recursive: true }); placementRoot = await mkdtemp(join(root, 'case-')); });
afterEach(async () => { await rm(placementRoot, { recursive: true, force: true }); });

async function open(owner: Owner, destination: Destination, ports: ReturnType<typeof fixture>['ports']) {
  return openOwnedSession(owner, destination, ports);
}

type Space = { id: SpaceId; name: string; machine: string | null; tabs: { id: TabId; name: string }[] };
type Call = { name: string; args: Readonly<Record<string, unknown>> };
const address = (value: string) => value as TerminalAddress;
const spaceId = (value: string) => value as SpaceId;
const tabId = (value: string) => value as TabId;
function fixture(remote = false) {
  const machine = 'box-1.invalid';
  const identity = { coreId: 'core-local' as CoreId, socket: '/fixture/core.sock', sessionNamespace: 'fixture' };
  const owner: Owner = { sessionId: 'session' as Owner['sessionId'], generation: 'generation' as Owner['generation'],
    terminal: { ...(remote ? { ...identity, coreId: 'core-remote' as CoreId } : identity), terminalId: 't1' as Owner['terminal']['terminalId'], address: address(remote ? `${machine}/t1` : 't1') },
    cwd: '/fixture', sessionFile: null, name: 'Owner' };
  const spaces: Space[] = [];
  const terminals = new Map<TerminalAddress, TerminalSummary>();
  const placements = new Map<TerminalAddress, OwnerPlacement>();
  const calls: Call[] = [];
  let focused: OwnerPlacement | null = null, active: SpaceId | null = null, nextTab = 1;
  let localIdentity = identity;
  let machines: MachineSummary[] = [{ id: 'core-remote' as CoreId, name: machine as MachineSummary['name'], aliases: [], state: 'connected', sessionNamespace: 'fixture', runtime: null }];
  const launched = vi.fn();
  const terminal = (id: string, cols = 180, rows = 30, kind?: string) => {
    const value = address(id);
    terminals.set(value, { address: value, parent: null, labels: kind ? { [HERDR_LABELS.kind]: kind } : {}, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null, cols, rows });
    return value;
  };
  terminal(owner.terminal.address);
  const addSpace = (id: string, ownerMachine: string | null, tabs: string[] = []) => {
    const value: Space = { id: spaceId(id), name: id, machine: ownerMachine, tabs: tabs.map(tab => ({ id: tabId(tab), name: tab })) };
    spaces.push(value); return value;
  };
  const addPane = (space: string, tab: string, id: string, cols = 180, rows = 30, kind?: string) => {
    const value = terminal(id, cols, rows, kind);
    const place = { space: spaceId(space), tab: tabId(tab), pane: `pane-${id}` as PaneId };
    placements.set(value, place); return place;
  };
  const focus = (place: OwnerPlacement) => { focused = place; active = place.space; };
  const app = {
    listSpaces: async (): Promise<readonly AppSpaceInfo[]> => spaces.map(space => ({ ...space, active: space.id === active, tabs: [...space.tabs] })),
    tabPanes: async (target: Pick<OwnerPlacement, 'space' | 'tab'>) => [...placements].filter(([, place]) => place.space === target.space && place.tab === target.tab).map(([terminal, place]) => ({ terminal, pane: place.pane })),
    tabTerminals: async (target: Pick<OwnerPlacement, 'space' | 'tab'>) => [...placements].filter(([, place]) => place.space === target.space && place.tab === target.tab).map(([terminal]) => terminal),
    tabIndex: async (target: Pick<OwnerPlacement, 'space' | 'tab'>) => (spaces.find(space => space.id === target.space)?.tabs.findIndex(tab => tab.id === target.tab) ?? -1) + 1,
    focusedPane: async () => focused,
    ownerPlacement: async (id: TerminalAddress) => { const place = placements.get(id); if (!place) throw new HerdrError('owner-unplaced', 'No pane'); return place; },
    awaitPane: async (id: TerminalAddress) => { const place = placements.get(id); if (!place) throw new HerdrError('owner-unplaced', 'No pane'); return place.pane; },
    command: async (name: string, args: Readonly<Record<string, unknown>>) => {
      calls.push({ name, args });
      if (name === 'terminal.park') { placements.delete(args.terminal as TerminalAddress); return { pending: true }; }
      if (name === 'space.select') {
        const selected = spaces.find(space => space.id === args.id);
        if (!selected) return { error: { code: 'app-error', message: 'No space' } };
        active = selected.id; focused = [...placements.values()].find(place => place.space === selected.id) ?? null; return {};
      }
      if (name === 'pane.focus') {
        const place = args.terminal ? placements.get(args.terminal as TerminalAddress) : [...placements.values()].find(value => value.pane === args.pane);
        if (!place) return { error: { code: 'app-error', message: 'No pane' } };
        focus(place); return {};
      }
      if (name === 'terminal.keep') {
        const id = args.terminal as TerminalAddress, selected = spaces.find(space => space.id === active);
        const on = id.includes('/') ? id.split('/')[0] : null;
        if (!selected || selected.machine !== on) return { error: { code: 'app-error', message: "A terminal's pane must stay on its own machine." } };
        let tab = focused?.space === selected.id && args.place !== 'tab' ? focused.tab : null;
        if (!tab) { tab = tabId(`new-${nextTab++}`); selected.tabs.push({ id: tab, name: tab }); }
        if (focused && args.place !== 'tab') {
          const anchor = [...placements].find(([, place]) => place.pane === focused!.pane)?.[0];
          const old = anchor && terminals.get(anchor);
          if (old) {
            if (args.place === 'right') { old.cols = Math.floor(((old.cols ?? 0) - 1) / 2); terminals.get(id)!.cols = old.cols; terminals.get(id)!.rows = old.rows; }
            else { old.rows = Math.floor(((old.rows ?? 0) - 5) / 2); terminals.get(id)!.rows = old.rows; terminals.get(id)!.cols = old.cols; }
          }
        } else { terminals.get(id)!.cols = 180; terminals.get(id)!.rows = 30; }
        const place = { space: selected.id, tab, pane: `pane-${id}` as PaneId };
        placements.set(id, place); focus(place); return { pending: true, ...place, terminal: id };
      }
      throw new Error(`Unexpected app command ${name}`);
    },
  } as AppClient & AppPaneInspection;
  const hc = {
    identity: async () => localIdentity,
    machines: async () => machines,
    get: async (id: TerminalAddress) => { const value = terminals.get(id); if (!value) throw new HerdrError('not_found', 'No terminal'); return { ...value }; },
    run: launched,
  } as unknown as HcClient;
  const ports = { hc, app, placementRoot, appIdentity: 'fixture-app', limit: 2, clock: Date.now };
  return { owner, spaces, terminals, placements, calls, ports, launched, addSpace, addPane, focus,
    setActive: (id: string) => { active = spaceId(id); focused = null; },
    setIdentity: (value: typeof identity) => { localIdentity = value; }, setMachines: (value: MachineSummary[]) => { machines = value; } };
}

it('focuses an existing primary pane before allocating anything', async () => {
  const f = fixture(); f.addSpace('local', null, ['work']); const pane = f.addPane('local', 'work', 't1'); f.focus(pane);
  expect(await open(f.owner, null, f.ports)).toBe('t1');
  expect(f.calls).toEqual([{ name: 'pane.focus', args: { terminal: 't1' } }]);
  expect(f.launched).not.toHaveBeenCalled();
});

it('reopens the parked primary in the active local tab without restarting its process', async () => {
  const f = fixture(); f.addSpace('local', null, ['work']); const anchor = f.addPane('local', 'work', 'anchor', 180, 30); f.focus(anchor);
  f.addPane('local', 'work', 't1');
  await f.ports.app.command('terminal.park', { terminal: 't1' });
  expect((await f.ports.hc.get(address('t1'))).state).toBe('live');
  await expect(f.ports.app.ownerPlacement(address('t1'))).rejects.toMatchObject({ code: 'owner-unplaced' });
  expect(await open(f.owner, null, f.ports)).toBe('t1');
  expect(await f.ports.app.ownerPlacement(address('t1'))).toMatchObject({ space: 'local', tab: 'work' });
  expect(f.launched).not.toHaveBeenCalled();
});

it('falls back to a new tab when the target tab has the full auxiliary limit', async () => {
  const f = fixture(); f.addSpace('local', null, ['work']); f.focus(f.addPane('local', 'work', 'anchor', 180, 30));
  f.addPane('local', 'work', 'viewer-a', 180, 30, HERDR_KINDS.subagentViewer);
  f.addPane('local', 'work', 'viewer-b', 180, 30, HERDR_KINDS.remoteObserver);
  expect(await open(f.owner, { space: spaceId('local'), tab: tabId('work') }, f.ports)).toBe('t1');
  expect((await f.ports.app.ownerPlacement(address('t1'))).tab).not.toBe('work');
  expect(f.calls).toContainEqual({ name: 'terminal.keep', args: { terminal: 't1', place: 'tab' } });
  expect(f.launched).not.toHaveBeenCalled();
});

it.each([{ cols: 59, rows: 30 }, { cols: 180, rows: 7 }, { cols: 119, rows: 15 }])('opens a new tab rather than making an unsafe $cols by $rows split', async size => {
  const f = fixture(); f.addSpace('local', null, ['work']); f.focus(f.addPane('local', 'work', 'anchor', size.cols, size.rows));
  expect(await open(f.owner, null, f.ports)).toBe('t1');
  expect((await f.ports.app.ownerPlacement(address('t1'))).tab).not.toBe('work');
  expect(await f.ports.hc.get(address('anchor'))).toMatchObject(size);
});

it.each([false, true])('rejects an undersized new tab and keeps the primary alive (remote=%s)', async remote => {
  const f = fixture(remote); f.addSpace('local', null, ['work']); f.focus(f.addPane('local', 'work', 'anchor', 59, 7));
  if (remote) f.addSpace('box-1.invalid/remote', 'box-1.invalid', ['r']);
  const original = f.ports.app.command;
  f.ports.app.command = async (name, args) => {
    const reply = await original(name, args);
    if (name === 'terminal.keep') { const value = f.terminals.get(f.owner.terminal.address)!; value.cols = 59; value.rows = 7; }
    return reply;
  };
  await expect(open(f.owner, null, f.ports)).rejects.toMatchObject({ code: 'geometry-too-small' });
  await expect(f.ports.app.ownerPlacement(f.owner.terminal.address)).rejects.toMatchObject({ code: 'owner-unplaced' });
  expect((await f.ports.hc.get(f.owner.terminal.address)).state).toBe('live');
  expect(f.calls.filter(call => call.name === 'terminal.park')).toHaveLength(1);
  expect(f.launched).not.toHaveBeenCalled();
});

it('uses the active local destination when the requested tab was removed', async () => {
  const f = fixture(); f.addSpace('local', null, ['work']); f.focus(f.addPane('local', 'work', 'anchor'));
  expect(await open(f.owner, { space: spaceId('local'), tab: tabId('removed') }, f.ports)).toBe('t1');
  expect((await f.ports.app.ownerPlacement(address('t1'))).space).toBe('local');
});

it('refuses a replaced local core without opening or focusing a terminal', async () => {
  const f = fixture(); f.addSpace('local', null, ['work']); f.focus(f.addPane('local', 'work', 'anchor'));
  f.setIdentity({ ...f.owner.terminal, coreId: 'replacement' as CoreId });
  await expect(open(f.owner, null, f.ports)).rejects.toMatchObject({ code: 'core-mismatch' });
  expect(f.calls).toEqual([]); expect(f.launched).not.toHaveBeenCalled();
});

it('refuses a primary that exited instead of recreating it', async () => {
  const f = fixture(); f.addSpace('local', null, ['work']); f.focus(f.addPane('local', 'work', 'anchor'));
  f.terminals.get(f.owner.terminal.address)!.state = 'finished';
  await expect(open(f.owner, null, f.ports)).rejects.toMatchObject({ code: 'not-found' });
  expect(f.calls).toEqual([]); expect(f.launched).not.toHaveBeenCalled();
});

it('serializes double activation and never attaches the primary twice', async () => {
  const f = fixture(); f.addSpace('local', null, ['work']); f.focus(f.addPane('local', 'work', 'anchor'));
  expect(await Promise.all([open(f.owner, null, f.ports), open(f.owner, null, f.ports)])).toEqual(['t1', 't1']);
  expect(f.calls.filter(call => call.name === 'terminal.keep')).toHaveLength(1);
  expect(f.placements.size).toBe(2); expect(f.launched).not.toHaveBeenCalled();
});

it('shares the app focus lock with auxiliary placement', async () => {
  const f = fixture(); f.addSpace('local', null, ['work']); f.focus(f.addPane('local', 'work', 'anchor'));
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const acquired = new Promise<void>(resolve => { entered = resolve; });
  const hold = withProcessLock(placementRoot, 'fixture-app:core-local:focus', async () => { entered(); await waiting; });
  await acquired;
  try {
    const opening = open(f.owner, null, f.ports);
    await Promise.resolve();
    expect(f.calls).toEqual([]);
    release(); await hold;
    expect(await opening).toBe('t1');
  } finally { release(); await hold; }
});

it('focuses an already displayed native remote pane', async () => {
  const f = fixture(true); f.addSpace('remote', 'box-1.invalid', ['work']); const pane = f.addPane('remote', 'work', 'box-1.invalid/t1'); f.focus(pane);
  expect(await open(f.owner, null, f.ports)).toBe('box-1.invalid/t1');
  expect(f.calls).toContainEqual({ name: 'pane.focus', args: { terminal: 'box-1.invalid/t1' } });
  expect(f.calls.some(call => call.name === 'terminal.keep')).toBe(false);
});

it('reopens on the first own-machine space when a local space is focused', async () => {
  const f = fixture(true); f.addSpace('local', null, ['work']); f.focus(f.addPane('local', 'work', 'anchor'));
  f.addSpace('box-1.invalid/first', 'box-1.invalid', ['remote-a']); f.addSpace('box-1.invalid/second', 'box-1.invalid', ['remote-b']);
  expect(await open(f.owner, null, f.ports)).toBe('box-1.invalid/t1');
  expect((await f.ports.app.ownerPlacement(f.owner.terminal.address)).space).toBe('box-1.invalid/first');
  const select = f.calls.findIndex(call => call.name === 'space.select' && call.args.id === 'box-1.invalid/first');
  const keep = f.calls.findIndex(call => call.name === 'terminal.keep' && call.args.terminal === 'box-1.invalid/t1' && call.args.place === 'tab');
  expect(select).toBeGreaterThanOrEqual(0); expect(keep).toBeGreaterThan(select);
  expect(f.calls).toContainEqual({ name: 'pane.focus', args: { terminal: 'box-1.invalid/t1' } });
  expect(f.launched).not.toHaveBeenCalled();
});

it('reopens on the currently focused own-machine space rather than the first', async () => {
  const f = fixture(true); f.addSpace('box-1.invalid/first', 'box-1.invalid', ['a']); f.addSpace('box-1.invalid/second', 'box-1.invalid', ['b']);
  f.focus(f.addPane('box-1.invalid/second', 'b', 'box-1.invalid/anchor'));
  expect(await open(f.owner, null, f.ports)).toBe('box-1.invalid/t1');
  expect((await f.ports.app.ownerPlacement(f.owner.terminal.address)).space).toBe('box-1.invalid/second');
});

it('uses the focused own-machine space even when it has no focused pane', async () => {
  const f = fixture(true); f.addSpace('box-1.invalid/first', 'box-1.invalid', ['a']); f.addSpace('box-1.invalid/second', 'box-1.invalid', ['b']);
  f.setActive('box-1.invalid/second');
  expect(await open(f.owner, null, f.ports)).toBe('box-1.invalid/t1');
  expect((await f.ports.app.ownerPlacement(f.owner.terminal.address)).space).toBe('box-1.invalid/second');
});

it('fake app selects spaces by id or one-based index and rejects missing spaces', async () => {
  const h = await createClientFixture();
  try {
    await writeFile(join(h.root, 'app.json'), JSON.stringify({ focusedPane: 'local-pane', spaces: [
      { id: 'local', name: 'Local', active: true, machine: null, tabs: [{ id: 'work', name: 'Work', active: true, terminals: [{ terminal: 't1', pane: 'local-pane' }] }] },
      { id: 'box-1.invalid/remote', name: 'Remote', active: false, machine: 'box-1.invalid', tabs: [{ id: 'box-1.invalid/r', name: 'R', active: true, terminals: [{ terminal: 'box-1.invalid/anchor', pane: 'remote-pane' }] }] },
    ] }));
    const app = createAppClient({ binary: h.appBinary, env: h.localEnv });
    expect(await app.command('space.select', { id: 'box-1.invalid/remote' })).toEqual({});
    expect(await app.focusedPane()).toEqual({ space: 'box-1.invalid/remote', tab: 'box-1.invalid/r', pane: 'remote-pane' });
    expect(await app.command('space.select', { index: 1 })).toEqual({});
    expect(await app.focusedPane()).toEqual({ space: 'local', tab: 'work', pane: 'local-pane' });
    expect(await app.command('space.select', { id: 'missing' })).toMatchObject({ error: { code: 'app-error', message: 'no such space' } });
    expect(await app.command('space.select', { index: 0 })).toMatchObject({ error: { code: 'app-error', message: 'no such space' } });
    expect(await app.focusedPane()).toEqual({ space: 'local', tab: 'work', pane: 'local-pane' });
  } finally { await h.close(); }
});

it('fake hc reopens a remote terminal only after selecting its own-machine space', async () => {
  const h = await createClientFixture();
  try {
    await h.configure({ machines: [{ id: 'remote-core', name: 'box-1.invalid', host: 'box-1.invalid', target: 'box-1.invalid', state: 'connected', session: 'remote' }],
      terminals: [fakeTerminal('t1'), fakeTerminal('box-1.invalid/t2'), fakeTerminal('box-1.invalid/anchor')] });
    await writeFile(join(h.root, 'app.json'), JSON.stringify({ focusedPane: 'local-pane', spaces: [
      { id: 'local', name: 'Local', active: true, machine: null, tabs: [{ id: 'work', name: 'Work', active: true, terminals: [{ terminal: 't1', pane: 'local-pane' }] }] },
      { id: 'box-1.invalid/remote', name: 'Remote', active: false, machine: 'box-1.invalid', tabs: [{ id: 'box-1.invalid/r', name: 'R', active: true, terminals: [{ terminal: 'box-1.invalid/anchor', pane: 'remote-pane' }] }] },
    ] }));
    const hc = createHcClient({ binary: h.hcBinary, env: h.localEnv }), app = createAppClient({ binary: h.appBinary, env: h.localEnv });
    const owner: Owner = { sessionId: 'session' as Owner['sessionId'], generation: 'generation' as Owner['generation'], cwd: '/fixture', sessionFile: null, name: null,
      terminal: { coreId: 'remote-core' as CoreId, socket: '/remote/socket', sessionNamespace: 'remote', terminalId: 't2' as Owner['terminal']['terminalId'], address: address('box-1.invalid/t2') } };
    expect(await openOwnedSession(owner, null, { hc, app, placementRoot, appIdentity: 'fixture-app', limit: 2, clock: Date.now })).toBe('box-1.invalid/t2');
    expect(await app.ownerPlacement(owner.terminal.address)).toMatchObject({ space: 'box-1.invalid/remote' });
    expect((await hc.get(owner.terminal.address)).state).toBe('live');
    const calls = (await readFile(join(h.root, 'app-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    const select = calls.findIndex(argv => argv[1] === 'space.select' && argv.includes('box-1.invalid/remote'));
    const keep = calls.findIndex(argv => argv[1] === 'terminal.keep' && argv.includes('box-1.invalid/t2') && argv.includes('tab'));
    expect(select).toBeGreaterThanOrEqual(0); expect(keep).toBeGreaterThan(select);
    expect((await h.calls()).filter(call => ['run', 'kill', 'rm'].includes(call.argv[0]))).toEqual([]);
    await hc.dispose();
  } finally { await h.close(); }
}, 30000);

it('refuses a parked remote session when its machine has no space', async () => {
  const f = fixture(true); f.addSpace('local', null, ['work']); f.focus(f.addPane('local', 'work', 'anchor'));
  await expect(open(f.owner, null, f.ports)).rejects.toMatchObject({ code: 'no-space-on-machine', message: 'No space on box-1.invalid to reopen it in' });
  expect(f.calls).toEqual([]); expect(f.launched).not.toHaveBeenCalled();
});

it.each(['disconnected', 'replaced'] as const)('refuses a parked remote session on a %s machine', async reason => {
  const f = fixture(true); f.addSpace('local', null, ['work']); f.focus(f.addPane('local', 'work', 'anchor'));
  f.addSpace('box-1.invalid/first', 'box-1.invalid', ['a']);
  f.setMachines([{ id: (reason === 'replaced' ? 'other-core' : 'core-remote') as CoreId, name: 'box-1.invalid' as MachineSummary['name'], aliases: [], state: reason === 'replaced' ? 'connected' : 'disconnected', sessionNamespace: 'fixture', runtime: null }]);
  await expect(open(f.owner, null, f.ports)).rejects.toMatchObject({ code: 'machine-unreachable', message: 'box-1.invalid is unreachable' });
  expect(f.calls).toEqual([]); expect(f.launched).not.toHaveBeenCalled();
});
