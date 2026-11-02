// SPDX-License-Identifier: MIT
import { afterEach, expect, test } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AppClient, HcClient, Owner, OwnerPlacement, PaneId, RunId, TerminalAddress } from '../contracts.js';
import { HERDR_KINDS, HERDR_LABELS } from '../contracts.js';
import { HerdrError } from '../client/parse.js';
import { createAuxiliaryPanes } from '../jobs/placement.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(limit = 2, automaticSubagentPanes = false) {
  await mkdir(resolve('.spider/scratch/h'), { recursive: true });
  const root = await mkdtemp(resolve('.spider/scratch/h/shared-')); cleanup.push(() => rm(root, { force: true, recursive: true }));
  const owners = ['planner', 'reviewer'].map(id => ({ sessionId: id, generation: 'generation', name: id, cwd: root, sessionFile: null, terminal: { coreId: 'core', terminalId: id, address: id, socket: 'socket', sessionNamespace: 'fixture' } }) as Owner);
  const placement = { space: 'space', tab: 'shared', pane: 'main' } as OwnerPlacement;
  const layout = new Map(owners.map(owner => [owner.terminal.address, { ...placement, pane: owner.sessionId as unknown as PaneId }]));
  const labels = new Map<TerminalAddress, Record<string, string>>(owners.map(owner => [owner.terminal.address, { [HERDR_LABELS.kind]: HERDR_KINDS.session }]));
  const parked: TerminalAddress[] = [], focused: TerminalAddress[] = [], discarded: TerminalAddress[] = [], errors: unknown[] = [];
  let tabs = 0;
  const app = {
    tabTerminals: async (target: OwnerPlacement) => [...layout].filter(([, p]) => p.space === target.space && p.tab === target.tab).map(([address]) => address),
    ownerPlacement: async (address: TerminalAddress) => { const p = layout.get(address); if (!p) throw new HerdrError('owner-unplaced', 'No pane'); return p; },
    awaitPane: async (address: TerminalAddress, p: OwnerPlacement) => { await delay(15); const pane = `pane-${address}` as PaneId; layout.set(address, { ...p, pane }); return pane; },
    command: async (name: string, args: Readonly<Record<string, unknown>>) => {
      const address = args.terminal as TerminalAddress;
      if (name === 'terminal.park') { parked.push(address); layout.delete(address); }
      else if (name === 'terminal.keep') { layout.set(address, { ...placement, tab: `extra-${++tabs}` as never, pane: `pane-${address}` as PaneId }); }
      else if (name === 'pane.focus') focused.push(address);
      else throw new Error('Unexpected app command ' + name);
      return {};
    },
  } satisfies AppClient & { tabTerminals(target: OwnerPlacement): Promise<TerminalAddress[]> };
  const hc = {
    get: async (address: TerminalAddress) => ({ address, labels: labels.get(address) ?? {}, parent: null, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null }),
    setLabels: async (address: TerminalAddress, values: Record<string, string>) => { labels.set(address, { ...labels.get(address), ...values }); },
    events: () => ({ ready: Promise.resolve(), subscribe: () => () => {}, lookup: async () => null, dispose: async () => {} }),
  } as unknown as HcClient;
  const actors = owners.map(owner => createAuxiliaryPanes({
    hc, app, limit, automaticSubagentPanes, placementRoot: root, clock: Date.now,
    subagentViewer: async id => { const address = `${owner.sessionId}-${id}` as TerminalAddress; labels.set(address, { [HERDR_LABELS.kind]: HERDR_KINDS.subagentViewer }); return address; },
    discardSubagentViewer: async (_runId, _owner, viewer) => { discarded.push(viewer); }, reportError: error => errors.push(error),
  }));
  cleanup.push(async () => { for (const actor of actors) await actor.dispose(); });
  const open = (actor: number, run: string, explicit = false) => actors[actor].acquire('subagent', run as RunId, owners[actor], { timeoutMs: 2000, automatic: !explicit, userInitiated: explicit });
  return { owners, actors, open, layout, parked, focused, discarded, errors, placement, hc, app };
}

test('two session actors share one tab limit, and explicit opens use another tab without disturbing main panes', async () => {
  const f = await fixture(2, true);
  await f.open(0, 'one'); await f.open(0, 'two');
  expect(await f.open(1, 'three')).toBeNull();
  expect(f.parked).toEqual(['reviewer-three']);
  const explicit = await f.open(1, 'three', true);
  expect(f.layout.get(explicit!.viewer)?.tab).toBe('extra-1');
  expect(f.focused).toEqual(['reviewer-three']);
  await f.open(0, 'one', true);
  expect(f.focused).toEqual(['reviewer-three', 'planner-one']);
  expect(f.owners.map(owner => f.layout.get(owner.terminal.address))).toEqual([
    { space: 'space', tab: 'shared', pane: 'planner' }, { space: 'space', tab: 'shared', pane: 'reviewer' },
  ]);
  await f.actors[0].release((await f.open(0, 'two', true))!);
  const free = await f.open(1, 'four');
  expect(f.layout.get(free!.viewer)?.tab).toBe('shared');
});

test('concurrent actors cannot both take the last free slot in a shared tab', async () => {
  const f = await fixture(1, true);
  const opened = await Promise.all([f.open(0, 'one'), f.open(1, 'two')]);
  expect(opened.filter(Boolean)).toHaveLength(1);
  expect([...f.layout.values()].filter(p => p.tab === 'shared')).toHaveLength(3);
  expect(f.parked).toHaveLength(1);
});

test('a move holds the target tab lock until another owner can count its viewer', async () => {
  const f = await fixture(1, true);
  f.layout.set(f.owners[1].terminal.address, { ...f.placement, tab: 'target' as never, pane: 'reviewer' as PaneId });
  (f.app as AppClient).tabSpace = async tab => [...f.layout.values()].find(value => value.tab === tab)?.space ?? null;
  const first = await f.open(0, 'one', true); expect(first?.viewer).toBe('planner-one');
  let release!: () => void, entered!: () => void;
  const pendingLabels = new Promise<void>(resolve => { release = resolve; }), begun = new Promise<void>(resolve => { entered = resolve; });
  const setLabels = f.hc.setLabels;
  f.hc.setLabels = async (address, labels) => {
    if (address === first!.viewer && labels[HERDR_LABELS.tab] === 'target') {
      entered(); await pendingLabels; await setLabels(address, labels);
      f.layout.set(address, { space: 'space' as never, tab: 'target' as never, pane: `pane-${address}` as PaneId });
    } else await setLabels(address, labels);
  };
  const moving = f.actors[0].moveRun('one' as RunId, f.owners[0], { kind: 'tab', tab: 'target' }, { timeoutMs: 2000 });
  await begun;
  let settled = false;
  const opening = f.open(1, 'two').then(result => { settled = true; return result; });
  try { await delay(100); expect(settled).toBe(false); }
  finally { release(); await Promise.allSettled([moving, opening]); }
  expect(f.layout.get(first!.viewer)?.tab).toBe('target');
  expect(await opening).toBeNull();
});

test('slow concurrent automatic viewers need no park or shared tab lock', async () => {
  const f = await fixture();
  const lookup = f.app.ownerPlacement;
  let pending = 0, peak = 0;
  f.app.ownerPlacement = async address => {
    if (f.owners.some(owner => owner.terminal.address === address)) return lookup(address);
    pending++; peak = Math.max(peak, pending);
    try { await delay(50); return await lookup(address); } finally { pending--; }
  };
  const result = await Promise.all([f.open(0, 'one'), f.open(1, 'two')]);
  expect(result).toEqual([null, null]);
  expect(peak).toBe(2);
  expect(f.parked).toEqual([]);
  expect([...f.layout.keys()]).toEqual(f.owners.map(owner => owner.terminal.address));
});

test('an automatic lookup failure leaves the viewer alone and reports no warning', async () => {
  const f = await fixture();
  const lookup = f.app.ownerPlacement;
  f.app.ownerPlacement = async address => {
    if (address === 'planner-one') throw new HerdrError('app-disconnected', 'Slow app');
    return lookup(address);
  };
  await expect(f.open(0, 'one')).rejects.toMatchObject({ code: 'app-disconnected' });
  expect(f.parked).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('cancelling an automatic lookup discards its unclaimed viewer without parking', async () => {
  const f = await fixture();
  const lookup = f.app.ownerPlacement, abort = new AbortController();
  let entered!: () => void, resume!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { resume = resolve; });
  f.app.ownerPlacement = async address => {
    if (address === 'planner-one') { entered(); await waiting; }
    return lookup(address);
  };
  const opening = f.actors[0].acquire('subagent', 'one' as RunId, f.owners[0], { timeoutMs: 2000, automatic: true, signal: abort.signal });
  await started; abort.abort(); resume();
  await expect(opening).rejects.toMatchObject({ code: 'aborted' });
  expect(f.discarded).toEqual(['planner-one']);
  expect(f.parked).toEqual([]);
});

test('an already placed automatic viewer is adopted without parking or focusing it', async () => {
  const f = await fixture();
  f.layout.set('planner-one' as TerminalAddress, { ...f.placement, pane: 'existing' as PaneId });
  const adopted = await f.open(0, 'one');
  expect(adopted).toMatchObject({ viewer: 'planner-one', pane: 'existing' });
  expect(f.parked).toEqual([]);
  expect(f.focused).toEqual([]);
  await f.actors[0].release(adopted!);
  expect(f.parked).toEqual(['planner-one']);
});

test('an already placed automatic viewer can be adopted while its owner pane is absent', async () => {
  const f = await fixture();
  f.layout.delete(f.owners[0].terminal.address);
  f.layout.set('planner-one' as TerminalAddress, { ...f.placement, pane: 'existing' as PaneId });
  const adopted = await f.open(0, 'one');
  expect(adopted).toMatchObject({ viewer: 'planner-one', pane: 'existing' });
  expect(f.parked).toEqual([]);
});

test('automatic viewers stay parked by default and only user opens consume shared slots', async () => {
  const f = await fixture();
  expect(await f.open(0, 'one')).toBeNull();
  expect(await f.open(1, 'two')).toBeNull();
  expect([...f.layout.keys()]).toEqual(f.owners.map(owner => owner.terminal.address));
  expect(f.parked).toEqual([]);
  const first = await f.open(0, 'one', true), second = await f.open(1, 'two', true);
  expect(f.layout.get(first!.viewer)?.tab).toBe('shared');
  expect(f.layout.get(second!.viewer)?.tab).toBe('shared');
  const overflow = await f.open(1, 'three', true);
  expect(f.layout.get(overflow!.viewer)?.tab).toBe('extra-1');
  expect((await f.open(0, 'one', true))!.viewer).toBe(first!.viewer);
  expect(f.focused.at(-1)).toBe(first!.viewer);
  expect(f.owners.every(owner => f.layout.get(owner.terminal.address)?.tab === 'shared')).toBe(true);
});
