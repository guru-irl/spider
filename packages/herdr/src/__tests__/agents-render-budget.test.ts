// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import * as children from '../../assets/agents/children.js';
import * as grouping from '../../assets/agents/grouping.js';
import * as connections from '../../assets/agents/connections.js';
import * as consoleGroups from '../../assets/agents/console-groups.js';
import * as look from '../../assets/shared/look.js';
import * as feed from '../../assets/shared/feed.js';
import * as navigation from '../../assets/shared/navigation.js';
import * as paneServiceState from '../../assets/shared/pane-service-state.js';
import { beginPresentationDrag } from '../../assets/agents/move.js';
import { describeOpenFailure } from '../../assets/shared/open-failure.js';
import { HerdrLabelContract } from '../contracts.js';
import { createUiModules } from './strict-mod-api.mjs';
import { loadPublishedSpacesARecipe, loadSpacesAFiles, replaySpacesARecipe, type SpacesAVersion } from './spaces-a-fixture.js';
import { replaySpacesBRecipe } from './spaces-b-fixture.js';

afterEach(() => vi.restoreAllMocks());

const agentsFactories = new Map<string, (host: Record<string, any>) => any>();
function agentsFactory(version: SpacesAVersion, presented: boolean, host: Record<string, any>) {
  const names = Object.keys(host), key = JSON.stringify([version, presented, names]);
  let factory = agentsFactories.get(key);
  if (!factory) {
    const recipe = loadPublishedSpacesARecipe(version);
    const files = presented
      ? replaySpacesBRecipe(version, loadSpacesAFiles(version), JSON.parse(readFileSync(new URL('../../assets/look/cross-machine-patches.json', import.meta.url), 'utf8')).versions[version])
      : replaySpacesARecipe(version, loadSpacesAFiles(version), recipe.aFragments, recipe);
    let source = files.agents!['main.js']!;
    source = source.replace(/^(?:\/\* spider-look:[a-z0-9-]+ \*\/)*import .*;\s*$/gm, '').replace('export default class ', 'class ');
    const name = /class (\w+) extends View/.exec(source)![1];
    factory = new Function('host', `const { ${names.join(', ')} } = host; ${source}; return ${name};`) as (host: Record<string, any>) => any;
    agentsFactories.set(key, factory);
  }
  return factory(host);
}

function fixture(version: SpacesAVersion, count: number, finished: number, presented = false) {
  const now = Date.now(), contract = HerdrLabelContract;
  const state: any = { agents: [], terminals: [], panes: [], spaces: [{ id: 'space', name: 'Work', tabs: [] }], feeds: [], errors: [],
    focus: { space: 'space', tab: 'tab0', pane: 'pane0', agent: 't0' }, machines: [{ name: null, layout: 'ready' }], inventory: [] };
  let rendering = false, historyReads = 0, allHistoryReads = 0, notifications = 0, agentReads = 0, projections = 0, projectedFinished = 0, navigationProjections = 0;
  for (let i = 0; i < count; i++) {
    const address = `t${i}`, sessionId = `s${i}`, tab = `tab${i}`, pane = `pane${i}`, live = `live${i}`;
    const program = { key: 'agent', name: 'Agent', icon: null, agent: true };
    state.agents.push({ address, pane, tab, space: 'space', space_name: 'Work', status: 'working', seq: i, focused: false, title: `Task ${i}`, program });
    state.terminals.push({ address, parent: null, state: 'live', status: 'working', program, labels: { 'spider.session': sessionId } });
    state.terminals.push({ address: `v${i}`, parent: address, state: 'live', status: 'working', labels: { 'spider.kind': 'subagent-viewer', 'spider.session': sessionId, 'spider.run': live } });
    state.panes.push({ pane, tab, terminal: address, title: `Task ${i}`, program, focused: false });
    state.spaces[0].tabs.push({ id: tab, name: `Task ${i}`, named: true });
    const runs: any[] = [{ id: live, ownerSessionId: sessionId, name: `Active ${i}`, status: 'running', childMode: 'rpc', canSteer: true, startedAt: now - 10000, finishedAt: null, viewer: `v${i}`, result: null }];
    for (let j = 0; j < finished; j++) runs.push({ id: `run${i}-${j}`, ownerSessionId: sessionId, name: `Finished ${i}-${j}`, status: 'done', childMode: 'print', canSteer: false, startedAt: now - 60000, finishedAt: now - 5000 - j * 1000, viewer: null, result: null });
    const rows = new Proxy(runs, { get(target, key, receiver) {
      if (key === Symbol.iterator || typeof key === 'string' && /^\d+$/.test(key)) { allHistoryReads++; if (rendering) historyReads++; }
      return Reflect.get(target, key, receiver);
    } });
    const owner = { sessionId, generation: 'gen', terminal: { coreId: 'core', terminalId: address, address, socket: 'socket', sessionNamespace: 'fixture' }, cwd: 'fixture', sessionFile: null, name: `Owner ${i}` };
    state.feeds.push({ version: 1, sessionId, generation: 'gen', revision: 1, updatedAt: now, owner, placement: null, lifecycle: 'live', status: { native: 'working', effective: 'working', message: null }, runs: { rows, total: rows.length, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [], pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'fixture' }, approvals: [], notifications: [], ipc: { address: 'ipc', capabilityFile: 'capability' }, errors: [] });
  }
  const watches: { fire: () => void }[] = [], after: { callback: (cx: any) => unknown; cancelled: boolean }[] = [];
  const timers: { ms: number; callback: (cx: any) => unknown }[] = [];
  const cx: any = {
    notify() { notifications++; }, stop_propagation() {},
    timer: {
      every(ms: number, callback: (cx: any) => unknown) { timers.push({ ms, callback }); return { cancel() {} }; },
      after(_ms: number, callback: (cx: any) => unknown) { const task = { callback, cancelled: false }; after.push(task); return { cancel() { task.cancelled = true; } }; },
    },
    spawn(fn: (cx: any) => unknown) { const task = Promise.resolve().then(() => fn(cx)); task.catch(() => {}); return task; },
    sleep: async () => {},
  };
  const commands: ((command: string) => void)[] = [], sharedState = new Map<string, unknown>(), execCalls: unknown[][] = [], runCalls: unknown[][] = [];
  const nextCommand = () => new Promise<string>(resolve => commands.push(resolve));
  const modules = createUiModules(), kit = modules['gpui-kit'], base = modules['gpui-base'];
  const palette = new Proxy({}, { get: () => '#808080' });
  const config = { modId: 'spider-agents', feedRoot: 'feeds', nodePath: 'node', cliPath: 'cli', labelContract: contract, ...(presented ? { paneServiceConfigured: true } : {}), retention: { completedRows: 50, completedHours: 24 } };
  const storage = new Map<string, string>(), storageWrites: [string, string][] = [];
  const host: Record<string, any> = {
    ...children, ...grouping, ...connections, ...consoleGroups, ...look, ...feed, ...navigation, ...paneServiceState, ...kit, ...base, beginPresentationDrag,
    projectAgentChildren: (...args: Parameters<typeof children.projectAgentChildren>) => { const rows = children.projectAgentChildren(...args); projections++; projectedFinished += rows.filter(row => row.retained).length; return rows; },
    projectNavigation: (snapshot: Parameters<typeof navigation.projectNavigation>[0]) => { navigationProjections++; if (state.throwNavigation) { state.throwNavigation = false; throw new Error('projection failed'); } return navigation.projectNavigation(snapshot); }, describeOpenFailure,
    requestPaneService: async (_config: unknown, _exec: unknown, request: any) => {
      if (request.op === 'snapshot') return state.paneSnapshot ?? null;
      (state.paneRequests ??= []).push(request); return { status: 'complete' };
    },
    createFeedReader: () => ({ read: async () => { if (state.throwFeed) throw new Error('read failed'); return { feeds: state.feeds, errors: state.errors }; }, stamps: () => new Map(state.feeds.map((item: any) => [item.sessionId, String(item.stamp ?? item.revision)])), close: async () => {} }),
    initMoveMenu() {}, renderMoveMenu() {}, herdr: { checking: () => false }, props: () => config,
    agents: () => { agentReads++; return structuredClone(state.agents); }, terminals: () => structuredClone(state.terminals), panes: () => structuredClone(state.panes), spaces: () => structuredClone(state.spaces), machines: () => structuredClone(state.machines),
    focused: () => structuredClone(state.focus), theme: () => palette, shared: (key: string) => sharedState.get(key) ?? null, setShared: (key: string, value: unknown) => sharedState.set(key, value), setAgentOrder() {},
    layout: () => ({ id: 'sidebar', size: { px: 268 } }), window: () => ({ platform: 'macos' }),
    run: (...args: unknown[]) => { runCalls.push(args); }, openOverlay() {}, closeOverlay() {}, nextCommand,
    watchFolder: () => {
      let fire!: () => void;
      const promise = new Promise<void>(resolve => { fire = resolve; });
      watches.push({ fire }); return Object.assign(promise, { cancel() {} });
    },
    exec: async (...args: unknown[]) => { execCalls.push(args); return { code: 0, stdout: '{}' }; }, hc: async (args: string[]) => ({ code: 0, stdout: JSON.stringify(args[0] === 'server' ? { core: { id: 'core' } } : { machines: state.inventory }) }),
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storageWrites.push([key, value]); storage.set(key, value); }, removeItem: (key: string) => storage.delete(key) },
  };
  const Agents = agentsFactory(version, presented, host);
  const view = new Agents(); view.init({}, cx);
  const flush = async () => {
    for (let i = 0; i < 80; i++) {
      await Promise.resolve();
      for (const task of after.splice(0)) if (!task.cancelled) await task.callback(cx);
    }
  };
  const step = async () => { await Promise.resolve(); const task = after.shift(); if (task && !task.cancelled) await task.callback(cx); };
  const render = () => { rendering = true; try { return view.render(cx); } finally { rendering = false; } };
  const text = (node: any): string[] => typeof node === 'string' ? [node] : node && typeof node === 'object' ? (node.items ?? []).flatMap(text) : [];
  return {
    state, config, view, cx, watches, timers, flush, step, render, text, storage, storageWrites, sharedState, execCalls, runCalls,
    get historyReads() { return historyReads; },
    get allHistoryReads() { return allHistoryReads; },
    get notifications() { return notifications; },
    get agentReads() { return agentReads; },
    get projections() { return projections; },
    get projectedFinished() { return projectedFinished; },
    get navigationProjections() { return navigationProjections; },
    async send(command: string) { const resolve = commands.shift(); if (!resolve) throw new Error('No command waiter'); resolve(command); await flush(); },
    async ready() { await flush(); await view.spiderConnections.refresh(); view.spiderRequestRefresh(); await flush(); },
  };
}

it('exposes stable content stamps while heartbeats change and new content replaces a feed', async () => {
  const snapshots = [
    { version: 1, entries: [{ source: 's', stamp: 'first', updatedAt: 100 }], changes: [{ source: 's', stamp: 'first', feed: { version: 1, sessionId: 's', revision: 1, runs: { rows: [] } } }], errors: [] },
    { version: 1, entries: [{ source: 's', stamp: 'first', updatedAt: 200 }], changes: [], errors: [] },
    { version: 1, entries: [{ source: 's', stamp: 'second', updatedAt: 300 }], changes: [{ source: 's', stamp: 'second', feed: { version: 1, sessionId: 's', revision: 1, runs: { rows: [{ id: 'new' }] } } }], errors: [] },
  ];
  const reader = feed.createFeedReader({ nodePath: 'node', cliPath: 'cli', feedRoot: 'feeds' }, {
    timer: { every: () => ({ cancel() {} }) },
    exec: async () => ({ code: 0, stdout: JSON.stringify({ version: 1, port: 1234, pid: 1, token: 'a'.repeat(64) }), stderr: '' }),
    fetch: async url => ({ ok: true, json: async () => url.endsWith('/close') ? {} : snapshots.shift() }),
  });
  try {
    const first = await reader.read();
    expect(first.feeds[0].updatedAt).toBe(100);
    expect(reader.stamps().get('s')).toBe('first');
    const heartbeat = await reader.read();
    expect(heartbeat.feeds[0].updatedAt).toBe(200);
    expect(reader.stamps().get('s')).toBe('first');
    const changed = await reader.read();
    expect(changed.feeds[0].runs.rows).toHaveLength(1);
    expect(reader.stamps().get('s')).toBe('second');
  } finally { await reader.close(); }
});

it('projects a large owner history without repeatedly traversing the history', () => {
  const h = fixture('0.1.13', 1, 400);
  let reads = 0;
  const source = h.state.feeds[0];
  const rows = new Proxy(source.runs.rows, { get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
    return Reflect.get(target, key, receiver);
  } });
  const input = { ...source, runs: { ...source.runs, rows } };
  const result = children.projectAgentChildren([], [input], 't0', HerdrLabelContract, { now: Date.now(), completedRows: 50 });
  expect(result).toHaveLength(51);
  expect(result[0]).toMatchObject({ key: 'live0', status: 'working' });
  expect(reads).toBeLessThan(10000);
  void h.view.close();
});

it('counts collapsed finished runs without projecting their rows', () => {
  const h = fixture('0.1.13', 1, 400);
  const summary: { hiddenFinished?: number } = {};
  const rows = children.projectAgentChildren(h.state.terminals, h.state.feeds, 't0', HerdrLabelContract,
    { now: Date.now(), completedRows: 50, finishedSummary: summary });
  expect(rows.map(row => row.key)).toContain('live0');
  expect(rows.filter(row => row.retained)).toHaveLength(0);
  expect(summary.hiddenFinished).toBe(50);
  void h.view.close();
});

it.each([['run0-0', 2, true], ['run0-3', 2, false], ['run0-3', 4, true]] as const)(
  'retains a finished run %s only when its live child and retention require it', (runId, limit, retained) => {
    const h = fixture('0.1.13', 1, 4), now = Date.now();
    h.state.terminals.push({ address: 'remote/job', parent: 't0', state: 'live', status: 'working',
      labels: { 'spider.kind': 'exec', 'spider.session': 's0', 'spider.job': 'job', 'spider.run': runId, 'spider.machine': 'box-1.invalid' } });
    const options = { now, completedRows: limit }, summary: { hiddenFinished?: number } = {};
    const full = children.projectAgentChildren(h.state.terminals, h.state.feeds, 't0', HerdrLabelContract, options);
    const visible = children.projectAgentChildren(h.state.terminals, h.state.feeds, 't0', HerdrLabelContract, { ...options, finishedSummary: summary });
    expect(visible.find(row => row.key === 'job')?.parentKey).toBe(full.find(row => row.key === 'job')?.parentKey);
    expect(visible.some(row => row.key === runId)).toBe(retained);
    expect(summary.hiddenFinished).toBe(limit - Number(retained));
    void h.view.close();
  },
);

it('counts deduplicated finished runs and respects equal-time retention ties', () => {
  const h = fixture('0.1.13', 1, 4), now = Date.now(), runs = h.state.feeds[0].runs.rows;
  for (const run of runs.slice(1)) run.finishedAt = now - 1000;
  runs.push({ ...runs[1], name: 'duplicate' });
  h.state.terminals.push({ address: 'remote/job', parent: 't0', state: 'live', status: 'working',
    labels: { 'spider.kind': 'exec', 'spider.session': 's0', 'spider.job': 'job', 'spider.run': 'run0-3', 'spider.machine': 'box-1.invalid' } });
  const options = { now, completedRows: 2 }, summary: { hiddenFinished?: number } = {};
  const full = children.projectAgentChildren(h.state.terminals, h.state.feeds, 't0', HerdrLabelContract, options);
  const visible = children.projectAgentChildren(h.state.terminals, h.state.feeds, 't0', HerdrLabelContract, { ...options, finishedSummary: summary });
  expect(full.filter(row => row.retained).map(row => row.key)).toEqual(['run0-0', 'run0-1']);
  expect(visible.find(row => row.key === 'job')?.parentKey).toBeNull();
  expect(summary.hiddenFinished).toBe(2);
  void h.view.close();
});

it('preserves visible row order when a finished duplicate becomes active', () => {
  const h = fixture('0.1.13', 1, 0), now = Date.now(), active = h.state.feeds[0].runs.rows[0];
  h.state.feeds[0].runs.rows = [{ ...active, status: 'done', finishedAt: now - 1000 }, active];
  h.state.terminals.push({ address: 'remote/job', parent: 't0', state: 'live', status: 'working',
    labels: { 'spider.kind': 'exec', 'spider.session': 's0', 'spider.job': 'job', 'spider.machine': 'box-1.invalid' } });
  const options = { now, completedRows: 50 }, summary: { hiddenFinished?: number } = {};
  const full = children.projectAgentChildren(h.state.terminals, h.state.feeds, 't0', HerdrLabelContract, options);
  const compact = children.projectAgentChildren(h.state.terminals, h.state.feeds, 't0', HerdrLabelContract, { ...options, finishedSummary: summary });
  expect(full.map(row => row.key)).toEqual(['live0', 'job']);
  expect(compact.map(row => row.key)).toEqual(full.map(row => row.key));
  void h.view.close();
});

it('does not count a retained terminal hidden under a folded finished run', () => {
  const h = fixture('0.1.13', 1, 4), now = Date.now();
  h.state.terminals.push({ address: 'remote/old-console', parent: 't0', state: 'finished', status: 'idle', finishedAt: now - 2000,
    labels: { 'spider.kind': 'remote-console', 'spider.session': 's0', 'spider.run': 'run0-0', 'spider.machine': 'box-1.invalid' } });
  const summary: { hiddenFinished?: number } = {};
  const rows = children.projectAgentChildren(h.state.terminals, h.state.feeds, 't0', HerdrLabelContract,
    { now, completedRows: 50, finishedSummary: summary, folded: new Set(['run0-0']), expandedConsoles: new Set() });
  expect(rows.filter(row => row.retained)).toHaveLength(0);
  expect(summary.hiddenFinished).toBe(4);
  void h.view.close();
});

it('counts deferred history only through expanded subagent ancestors', () => {
  const h = fixture('0.1.13', 1, 0), first = h.state.feeds[0].runs.rows[0], now = Date.now();
  for (const [id, parent] of [['done-parent', 'v0'], ['done-child', 'done-parent-viewer']] as const) {
    h.state.feeds[0].runs.rows.push({ ...first, id, status: 'done', finishedAt: now - 1000, viewer: `${id}-viewer` });
    h.state.terminals.push({ address: `${id}-viewer`, parent, state: 'finished', status: 'idle', finishedAt: now - 1000, exitCode: 0, reason: 'exited',
      labels: { 'spider.kind': 'subagent-viewer', 'spider.session': 's0', 'spider.run': id } });
  }
  const count = (expandedSubagents: string[]) => {
    const summary: { hiddenFinished?: number } = {};
    children.projectAgentChildren(h.state.terminals, h.state.feeds, 't0', HerdrLabelContract,
      { now, finishedSummary: summary, expandedSubagents: new Set(expandedSubagents) });
    return summary.hiddenFinished;
  };
  expect(count([])).toBe(0);
  expect(count(['done-parent'])).toBe(0);
  expect(count(['live0'])).toBe(1);
  expect(count(['live0', 'done-parent'])).toBe(2);
  void h.view.close();
});

it('can resolve parked owners without projecting their children', () => {
  const h = fixture('0.1.13', 1, 48);
  h.state.agents[0].pane = null;
  h.state.panes = [];
  const snapshot = { ...h.state, coreId: 'core', destination: null, contract: HerdrLabelContract,
    machines: [{ name: null, layout: 'ready' }], now: Date.now(), completedRows: 50, completedHours: 24 };
  const owners = navigation.projectNavigation({ ...snapshot, includeChildren: false });
  expect(owners).toHaveLength(1);
  expect(owners[0]).toMatchObject({ kind: 'agent', sessionId: 's0', pane: null, name: 'Owner 0' });
  void h.view.close();
});

it('0.1.18 sidebar draws the Agents separator and a child branch line', async () => {
  const h = fixture('0.1.18', 1, 0);
  const nodes = (node: any): any[] => node && typeof node === 'object' ? [node, ...(node.items ?? []).flatMap(nodes)] : [];
  try {
    await h.ready();
    const root = h.render();
    expect(root.styles.border_t).toEqual([1]);
    expect(root.styles.border_color).toEqual(['#2f2f32']);
    const child = nodes(root).find(node => node.styles.id?.[0] === 'sub-live0');
    expect(child).toBeDefined();
    expect(nodes(child).some(node => node.styles.border_l?.[0] === 1 && node.styles.border_b?.[0] === 1
      && node.styles.border_color?.[0] === '#3a3a3d')).toBe(true);
  } finally { await h.view.close(); }
});

for (const version of ['0.1.13', '0.1.16'] as const) {
  it(`${version}: bounds saved expansions and prunes only after a complete feed load`, async () => {
    const h = fixture(version, 1, 0), first = h.state.feeds[0].runs.rows[0];
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    for (let i = 0; i < 250; i++) {
      const id = `saved-${i}`, viewer = `viewer-${i}`;
      h.state.feeds[0].runs.rows.push({ ...first, id, viewer });
      h.state.terminals.push({ address: viewer, parent: 't0', state: 'live', status: 'working',
        labels: { 'spider.kind': 'subagent-viewer', 'spider.session': 's0', 'spider.run': id } },
      { address: `native-${i}`, parent: viewer, state: 'live', status: 'idle', labels: {} });
    }
    h.state.feeds[0].runs.total = h.state.feeds[0].runs.rows.length;
    try {
      await h.ready();
      for (let i = 0; i < 250; i++) find(h.render(), `child-fold-saved-${i}`).events.on_click({}, h.cx);
      const saved = () => JSON.parse(h.storage.get('spider.subagents.expanded')!);
      expect(saved()).toEqual(Array.from({ length: 200 }, (_, i) => `saved-${i + 50}`));
      // Finished runs remain in the feed and still preserve their expansion.
      for (const run of h.state.feeds[0].runs.rows.slice(1)) { run.status = 'done'; run.finishedAt = Date.now(); }
      h.state.feeds[0].revision++; h.view.spiderReloadAt = -Infinity;
      await h.view.reloadSpiderFeeds(); h.view.spiderRequestRefresh(); await h.flush();
      expect(saved()).toHaveLength(200);
      // One incomplete run list must not remove keys from the other feeds either.
      h.state.feeds[0].runs.rows = [first]; h.state.feeds[0].runs.total = 1; h.state.feeds[0].runs.truncated = true;
      h.state.feeds[0].revision++; h.view.spiderReloadAt = -Infinity;
      await h.view.reloadSpiderFeeds(); h.view.spiderRequestRefresh(); await h.flush();
      expect(saved()).toHaveLength(200);
      h.state.feeds[0].runs.truncated = false; h.state.feeds[0].revision++;
      h.view.spiderReloadAt = -Infinity; await h.view.reloadSpiderFeeds(); h.view.spiderRequestRefresh(); await h.flush();
      expect(saved()).toEqual([]);
    } finally { await h.view.close(); }
  });

  it(`${version}: limits an oversized saved list when the view loads`, async () => {
    const h = fixture(version, 1, 0), keys = Array.from({ length: 250 }, (_, i) => `key-${i}`);
    let loaded: any, again: any;
    try {
      await h.ready(); h.storage.set('spider.subagents.expanded', JSON.stringify(keys));
      loaded = new h.view.constructor(); loaded.init({}, h.cx);
      expect(JSON.parse(h.storage.get('spider.subagents.expanded')!)).toEqual(keys.slice(-200));
      const writes = h.storageWrites.filter(([key]) => key === 'spider.subagents.expanded').length;
      again = new h.view.constructor(); again.init({}, h.cx);
      expect(h.storageWrites.filter(([key]) => key === 'spider.subagents.expanded')).toHaveLength(writes);
    } finally { await again?.close(); await loaded?.close(); await h.view.close(); }
  });

  it(`${version}: one truncated feed protects keys across every feed`, async () => {
    const h = fixture(version, 2, 0);
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    for (let i = 0; i < 2; i++) h.state.terminals.push({ address: `native-${i}`, parent: `v${i}`, state: 'live', status: 'idle', labels: {} });
    const refresh = async () => {
      h.state.feeds[0].revision++; h.state.feeds[1].revision++; h.view.spiderReloadAt = -Infinity;
      await h.view.reloadSpiderFeeds(); h.view.spiderRequestRefresh(); await h.flush();
    };
    try {
      await h.ready();
      for (let i = 0; i < 2; i++) find(h.render(), `child-fold-live${i}`).events.on_click({}, h.cx);
      expect(JSON.parse(h.storage.get('spider.subagents.expanded')!)).toEqual(['live0', 'live1']);
      h.state.feeds[0].runs.rows = []; h.state.feeds[0].runs.total = 0; h.state.feeds[1].runs.truncated = true;
      await refresh();
      expect(JSON.parse(h.storage.get('spider.subagents.expanded')!)).toEqual(['live0', 'live1']);
      h.state.feeds[1].runs.truncated = false; h.state.feeds[1].runs.total = 2; await refresh();
      expect(JSON.parse(h.storage.get('spider.subagents.expanded')!)).toEqual(['live0', 'live1']);
      h.state.feeds[1].runs.total = 1; await refresh();
      expect(JSON.parse(h.storage.get('spider.subagents.expanded')!)).toEqual(['live1']);
    } finally { await h.view.close(); }
  });

  it(`${version}: retains saved keys through feed errors and prunes them after recovery`, async () => {
    const h = fixture(version, 1, 0), first = h.state.feeds[0].runs.rows[0];
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    h.state.terminals.push({ address: 'child', parent: 'v0', state: 'live', status: 'idle', labels: {} });
    const refresh = async () => {
      h.state.feeds[0].revision++; h.view.spiderReloadAt = -Infinity;
      await h.view.reloadSpiderFeeds(); h.view.spiderRequestRefresh(); await h.flush();
    };
    try {
      await h.ready(); find(h.render(), 'child-fold-live0').events.on_click({}, h.cx);
      const writes = () => h.storageWrites.filter(([key]) => key === 'spider.subagents.expanded').length;
      expect(writes()).toBe(1);
      await refresh(); expect(writes()).toBe(1);
      h.state.feeds[0].runs.rows = []; h.state.feeds[0].runs.total = 0; h.state.errors = [{ source: 's0', message: 'read failed' }];
      await refresh(); expect(h.storage.get('spider.subagents.expanded')).toBe('["live0"]');
      expect(writes()).toBe(1);
      h.state.errors = []; h.state.feeds[0].runs.rows = [first]; h.state.feeds[0].runs.total = 1; await refresh();
      h.state.feeds[0].runs.rows = []; h.state.feeds[0].runs.total = 0; h.state.throwFeed = true; await refresh();
      h.view.spiderFeedError = null; h.view.spiderModel.inputKey = null;
      h.view.spiderRequestRefresh(); await h.flush();
      expect(h.storage.get('spider.subagents.expanded')).toBe('["live0"]');
      h.state.throwFeed = false; await refresh();
      expect(h.storage.get('spider.subagents.expanded')).toBe('[]');
      expect(writes()).toBe(2);
    } finally { await h.view.close(); }
  });

  it(`${version}: defers saved-key pruning until after the first render`, async () => {
    const h = fixture(version, 1, 0);
    let reloaded: any;
    try {
      await h.ready();
      h.storage.set('spider.subagents.expanded', '["gone"]');
      reloaded = new h.view.constructor(); reloaded.init({}, h.cx);
      reloaded.spiderFeeds = h.state.feeds; reloaded.spiderFeedsLoaded = true; reloaded.spiderFeedComplete = true;
      reloaded.render(h.cx);
      expect(h.storage.get('spider.subagents.expanded')).toBe('["gone"]');
      await h.flush();
      expect(h.storage.get('spider.subagents.expanded')).toBe('[]');
    } finally { await reloaded?.close(); await h.view.close(); }
  });

  it(`${version}: finished count follows subagent expansion`, async () => {
    const h = fixture(version, 1, 0), first = h.state.feeds[0].runs.rows[0], now = Date.now();
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    h.state.feeds[0].runs.rows.push({ ...first, id: 'nested-done', name: 'Nested done', status: 'done', finishedAt: now - 1000, viewer: 'nested-viewer' },
      { ...first, id: 'root-done', name: 'Root done', status: 'done', finishedAt: now - 1000, viewer: null });
    h.state.terminals.push({ address: 'nested-viewer', parent: 'v0', state: 'finished', status: 'idle', finishedAt: now - 1000, exitCode: 0, reason: 'exited',
      labels: { 'spider.kind': 'subagent-viewer', 'spider.session': 's0', 'spider.run': 'nested-done' } });
    try {
      await h.ready(); let root = h.render();
      expect(h.text(root)).toContain('1 finished');
      find(root, 'child-fold-live0').events.on_click({}, h.cx); await h.flush(); root = h.render();
      expect(h.text(root)).toContain('2 finished');
      find(root, 'finished-toggle-t0').events.on_click({}, h.cx); root = h.render();
      expect(find(root, 'sub-root-done')).toBeDefined();
      expect(find(root, 'sub-nested-done')).toBeDefined();
      find(root, 'finished-toggle-t0').events.on_click({}, h.cx); await h.flush(); root = h.render();
      find(root, 'child-fold-live0').events.on_click({}, h.cx); await h.flush(); root = h.render();
      expect(h.text(root)).toContain('1 finished');
    } finally { await h.view.close(); }
  });

  it(`${version}: a leaf has no chevron, stays aligned, and gains and loses one with a child`, async () => {
    const h = fixture(version, 1, 0), first = h.state.feeds[0].runs.rows[0];
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    h.state.feeds[0].runs.rows.push({ ...first, id: 'peer', name: 'Peer', viewer: 'peer-viewer' });
    h.state.terminals.push({ address: 'peer-viewer', parent: 't0', state: 'live', status: 'working',
      labels: { 'spider.kind': 'subagent-viewer', 'spider.session': 's0', 'spider.run': 'peer' } },
    { address: 'peer-child', parent: 'peer-viewer', state: 'live', status: 'idle', labels: {} });
    const child = { address: 'new-child', parent: 'v0', state: 'live', status: 'idle', labels: {} };
    try {
      await h.ready(); let root = h.render();
      expect(find(root, 'child-fold-live0')).toBeUndefined();
      expect(find(root, 'child-fold-peer')).toBeDefined();
      expect(find(root, 'sub-live0').styles.pl?.[0]).toEqual(expect.any(Number));
      expect(find(root, 'sub-live0').styles.pl).toEqual(find(root, 'sub-peer').styles.pl);
      h.state.terminals.push(child); h.render(); await h.flush(); root = h.render();
      expect(find(root, 'child-fold-live0')?.styles.tooltip?.[0]).toBe('Show children');
      find(root, 'child-fold-live0').events.on_click({}, h.cx); root = h.render();
      expect(find(root, 'sub-new-child')).toBeDefined();
      find(root, 'child-fold-live0').events.on_click({}, h.cx); await h.flush();
      h.state.terminals = h.state.terminals.filter((terminal: any) => terminal !== child);
      h.render(); await h.flush(); root = h.render();
      expect(find(root, 'child-fold-live0')).toBeUndefined();
    } finally { await h.view.close(); }
  });

  it.each(['run', 'console'] as const)(`${version}: a projected %s can be revealed from its parent`, async kind => {
    const h = fixture(version, 1, 0), first = h.state.feeds[0].runs.rows[0];
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    try {
      await h.ready(); expect(find(h.render(), 'child-fold-live0')).toBeUndefined();
      if (kind === 'run') {
        h.state.feeds[0].runs.rows.push({ ...first, id: 'nested-live', name: 'Nested live', viewer: 'nested-live-viewer' });
        h.state.terminals.push({ address: 'nested-live-viewer', parent: 'v0', state: 'live', status: 'working',
          labels: { 'spider.kind': 'subagent-viewer', 'spider.session': 's0', 'spider.run': 'nested-live' } });
        h.state.feeds[0].revision++; h.view.spiderReloadAt = -Infinity;
        await h.view.reloadSpiderFeeds(); h.view.spiderRequestRefresh(); await h.flush();
      } else {
        h.state.terminals.push({ address: 'local-console', parent: 't0', state: 'live', status: 'idle',
          labels: { 'spider.kind': 'remote-console', 'spider.session': 's0', 'spider.run': 'live0' } });
        h.render(); await h.flush();
      }
      let root = h.render();
      expect(find(root, 'child-fold-live0')).toBeDefined();
      find(root, 'child-fold-live0').events.on_click({}, h.cx); await h.flush(); root = h.render();
      if (kind === 'run') expect(find(root, 'sub-nested-live')).toBeDefined();
      else {
        const group = `console-group:${encodeURIComponent(`console-group:${JSON.stringify(['t0', 'live0'])}`)}`;
        expect(find(root, group)).toBeDefined();
        find(root, group).events.on_click({}, h.cx); root = h.render();
        expect(find(root, 'sub-console:local-console')).toBeDefined();
      }
    } finally { await h.view.close(); }
  });

  it(`${version}: an unavailable hidden console alone does not make a subagent expandable`, async () => {
    const h = fixture(version, 1, 0);
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    try {
      await h.ready();
      h.state.terminals.push({ address: 'box-1.invalid/console', parent: 't0', state: 'live', status: 'idle',
        labels: { 'spider.kind': 'remote-console', 'spider.session': 's0', 'spider.run': 'live0', 'spider.machine': 'box-1.invalid' } });
      h.render(); await h.flush();
      expect(find(h.render(), 'child-fold-live0')).toBeUndefined();
      const available = { address: 'local-console', parent: 't0', state: 'live', status: 'idle',
        labels: { 'spider.kind': 'remote-console', 'spider.session': 's0', 'spider.run': 'live0' } };
      h.state.terminals.push(available); h.render(); await h.flush(); let root = h.render();
      find(root, 'child-fold-live0').events.on_click({}, h.cx); await h.flush(); root = h.render();
      const group = `console-group:${encodeURIComponent(`console-group:${JSON.stringify(['t0', 'live0'])}`)}`;
      expect(find(root, group)).toBeDefined();
      find(root, group).events.on_click({}, h.cx); root = h.render();
      expect(find(root, 'sub-console:local-console')).toBeDefined();
      expect(find(root, 'sub-console:box-1.invalid/console')).toBeDefined();
      find(root, 'child-fold-live0').events.on_click({}, h.cx); await h.flush();
      h.state.terminals = h.state.terminals.filter((terminal: any) => terminal !== available);
      h.render(); await h.flush();
      expect(find(h.render(), 'child-fold-live0')).toBeUndefined();
    } finally { await h.view.close(); }
  });

  it(`${version}: a retained console makes its parent expandable through finished history`, async () => {
    const h = fixture(version, 1, 0), now = Date.now();
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    h.state.terminals.push({ address: 'old-console', parent: 't0', state: 'finished', status: 'idle', finishedAt: now - 1000, exitCode: 0, reason: 'exited',
      labels: { 'spider.kind': 'remote-console', 'spider.session': 's0', 'spider.run': 'live0' } });
    try {
      await h.ready(); let root = h.render();
      expect(find(root, 'child-fold-live0')).toBeDefined();
      find(root, 'child-fold-live0').events.on_click({}, h.cx); await h.flush(); root = h.render();
      expect(h.text(root)).toContain('1 finished');
      find(root, 'finished-toggle-t0').events.on_click({}, h.cx); await h.flush(); root = h.render();
      const group = `console-group:${encodeURIComponent(`console-group:${JSON.stringify(['t0', 'live0'])}`)}`;
      expect(find(root, group)).toBeDefined();
      find(root, group).events.on_click({}, h.cx); root = h.render();
      expect(find(root, 'sub-console:old-console')).toBeDefined();
    } finally { await h.view.close(); }
  });

  it(`${version}: showing finished history exposes an otherwise hidden console group`, async () => {
    const h = fixture(version, 1, 0), first = h.state.feeds[0].runs.rows[0];
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    h.state.feeds[0].runs.rows.push({ ...first, id: 'root-done', status: 'done', finishedAt: Date.now() - 1000, viewer: null });
    h.state.terminals.push({ address: 'box-1.invalid/console', parent: 't0', state: 'live', status: 'idle',
      labels: { 'spider.kind': 'remote-console', 'spider.session': 's0', 'spider.run': 'live0', 'spider.machine': 'box-1.invalid' } });
    try {
      await h.ready(); let root = h.render();
      expect(find(root, 'child-fold-live0')).toBeUndefined();
      find(root, 'finished-toggle-t0').events.on_click({}, h.cx); await h.flush(); root = h.render();
      expect(find(root, 'child-fold-live0')).toBeDefined();
      find(root, 'child-fold-live0').events.on_click({}, h.cx); await h.flush(); root = h.render();
      const group = `console-group:${encodeURIComponent(`console-group:${JSON.stringify(['t0', 'live0'])}`)}`;
      expect(find(root, group)).toBeDefined();
    } finally { await h.view.close(); }
  });

  it(`${version}: the chevron follows which finished run retention selects`, async () => {
    const h = fixture(version, 1, 0), first = h.state.feeds[0].runs.rows[0], now = Date.now();
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    const rootDone = { ...first, id: 'root-done', status: 'done', finishedAt: now - 1000, viewer: null };
    const nestedDone = { ...first, id: 'nested-done', status: 'done', finishedAt: now - 2000, viewer: 'nested-viewer' };
    const nestedViewer = { address: 'nested-viewer', parent: 'v0', state: 'finished', status: 'idle', finishedAt: now - 2000, exitCode: 0, reason: 'exited',
      labels: { 'spider.kind': 'subagent-viewer', 'spider.session': 's0', 'spider.run': 'nested-done' } };
    h.config.retention.completedRows = 1;
    h.state.feeds[0].runs.rows.push(rootDone, nestedDone); h.state.terminals.push(nestedViewer);
    const refresh = async () => {
      h.state.feeds[0].revision++; h.view.spiderReloadAt = -Infinity;
      await h.view.reloadSpiderFeeds(); h.view.spiderRequestRefresh(); await h.flush();
    };
    try {
      await h.ready(); expect(find(h.render(), 'child-fold-live0')).toBeUndefined();
      nestedDone.finishedAt = now - 500; nestedViewer.finishedAt = nestedDone.finishedAt;
      await refresh(); expect(find(h.render(), 'child-fold-live0')).toBeDefined();
      rootDone.finishedAt = now - 100; await refresh();
      expect(find(h.render(), 'child-fold-live0')).toBeUndefined();
    } finally { await h.view.close(); }
  });

  it(`${version}: the last summarized child's chevron expires with retention`, async () => {
    const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const h = fixture(version, 1, 0), first = h.state.feeds[0].runs.rows[0];
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    h.config.retention.completedHours = 0.001;
    h.state.feeds[0].runs.rows.push({ ...first, id: 'nested-done', status: 'done', finishedAt: now - 1000, viewer: 'nested-viewer' });
    h.state.terminals.push({ address: 'nested-viewer', parent: 'v0', state: 'finished', status: 'idle', finishedAt: now - 1000, exitCode: 0, reason: 'exited',
      labels: { 'spider.kind': 'subagent-viewer', 'spider.session': 's0', 'spider.run': 'nested-done' } });
    try {
      await h.ready(); expect(find(h.render(), 'child-fold-live0')).toBeDefined();
      clock.mockReturnValue(now + 3000); h.render(); await h.flush();
      expect(find(h.render(), 'child-fold-live0')).toBeUndefined();
    } finally { await h.view.close(); }
  });

  it(`${version}: a summarized descendant makes its parent expandable until it is removed`, async () => {
    const h = fixture(version, 1, 0), first = h.state.feeds[0].runs.rows[0];
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    const refresh = async () => {
      h.state.feeds[0].revision++; h.view.spiderReloadAt = -Infinity;
      await h.view.reloadSpiderFeeds(); h.view.spiderRequestRefresh(); await h.flush();
    };
    try {
      await h.ready(); expect(find(h.render(), 'child-fold-live0')).toBeUndefined();
      h.state.feeds[0].runs.rows.push({ ...first, id: 'nested-done', name: 'Nested done', status: 'done', finishedAt: Date.now() - 1000, viewer: 'nested-viewer' });
      h.state.terminals.push({ address: 'nested-viewer', parent: 'v0', state: 'finished', status: 'idle', finishedAt: Date.now() - 1000, exitCode: 0, reason: 'exited',
        labels: { 'spider.kind': 'subagent-viewer', 'spider.session': 's0', 'spider.run': 'nested-done' } });
      await refresh(); let root = h.render();
      expect(find(root, 'child-fold-live0')).toBeDefined();
      find(root, 'child-fold-live0').events.on_click({}, h.cx); await h.flush(); root = h.render();
      expect(h.text(root)).toContain('1 finished');
      find(root, 'finished-toggle-t0').events.on_click({}, h.cx); root = h.render();
      expect(find(root, 'sub-nested-done')).toBeDefined();
      find(root, 'finished-toggle-t0').events.on_click({}, h.cx); await h.flush(); root = h.render();
      find(root, 'child-fold-live0').events.on_click({}, h.cx); await h.flush();
      h.state.feeds[0].runs.rows = [first];
      h.state.terminals = h.state.terminals.filter((terminal: any) => terminal.address !== 'nested-viewer');
      await refresh(); root = h.render();
      expect(find(root, 'child-fold-live0')).toBeUndefined();
    } finally { await h.view.close(); }
  });

  it(`${version}: a folded native descendant can reveal summarized runs`, async () => {
    const h = fixture(version, 1, 0), first = h.state.feeds[0].runs.rows[0], now = Date.now();
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    h.state.feeds[0].runs.rows.push({ ...first, id: 'nested-done', status: 'done', finishedAt: now - 1000, viewer: 'nested-viewer' });
    h.state.terminals.push({ address: 'native', parent: 'v0', state: 'live', status: 'idle', labels: {} },
      { address: 'nested-viewer', parent: 'native', state: 'finished', status: 'idle', finishedAt: now - 1000, exitCode: 0, reason: 'exited',
        labels: { 'spider.kind': 'subagent-viewer', 'spider.session': 's0', 'spider.run': 'nested-done' } });
    h.view.folded.add('native');
    try {
      await h.ready(); let root = h.render();
      find(root, 'child-fold-live0').events.on_click({}, h.cx); await h.flush(); root = h.render();
      expect(find(root, 'child-fold-native')).toBeDefined();
      find(root, 'child-fold-native').events.on_click({}, h.cx); await h.flush(); root = h.render();
      expect(h.text(root)).toContain('1 finished');
      find(root, 'finished-toggle-t0').events.on_click({}, h.cx); root = h.render();
      expect(find(root, 'sub-nested-done')).toBeDefined();
    } finally { await h.view.close(); }
  });

  it(`${version}: subagent folding survives command activity and a reload`, async () => {
    const h = fixture(version, 1, 0);
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    const ids = (node: any): string[] => node && typeof node === 'object'
      ? [...(node.styles?.id?.[0] ? [node.styles.id[0]] : []), ...(node.items ?? []).flatMap(ids)] : [];
    const command = { address: 'job-terminal', parent: 't0', state: 'live', status: 'working',
      labels: { 'spider.kind': 'exec', 'spider.session': 's0', 'spider.job': 'job', 'spider.run': 'live0' } };
    let reloaded: any;
    try {
      await h.ready();
      let root = h.render(); await h.flush();
      expect(find(root, 'ag-t0')).toBeDefined();
      expect(find(root, 'sub-live0')).toBeDefined();
      const before = ids(root).filter(id => id.startsWith('sub-')).length;
      const rowSnapshot = () => JSON.stringify(find(root, 'sub-live0'), (_key, value) => typeof value === 'function' ? undefined : value);
      const beforeCommand = rowSnapshot();
      h.state.terminals.push(command);
      h.render(); await h.flush(); root = h.render();
      expect(ids(root).filter(id => id.startsWith('sub-'))).toHaveLength(before);
      expect(find(root, 'sub-job')).toBeUndefined();
      expect(find(root, 'child-busy-live0')).toBeUndefined();
      expect(rowSnapshot()).not.toBe(beforeCommand);
      expect(find(root, 'child-fold-live0')?.styles.tooltip?.[0]).toBe('Show children');
      const withCommand = rowSnapshot();
      const second = { ...command, address: 'job-terminal-2', labels: { ...command.labels, 'spider.job': 'job-2' } };
      h.state.terminals.push(second); h.render(); await h.flush(); root = h.render();
      expect(rowSnapshot()).toBe(withCommand);
      h.state.terminals = h.state.terminals.filter((terminal: any) => terminal !== second);
      h.render(); await h.flush(); root = h.render();
      expect(rowSnapshot()).toBe(withCommand);
      command.state = 'finished';
      h.render(); await h.flush(); root = h.render();
      expect(find(root, 'sub-job')).toBeUndefined();
      expect(find(root, 'child-busy-live0')).toBeUndefined();
      expect(rowSnapshot()).toBe(beforeCommand);
      command.state = 'live';
      h.render(); await h.flush(); root = h.render();
      expect(find(root, 'child-fold-live0')?.styles.tooltip?.[0]).toBe('Show children');
      find(root, 'child-fold-live0').events.on_click({}, h.cx);
      root = h.render();
      expect(find(root, 'sub-job')).toBeDefined();
      expect(find(root, 'child-fold-live0')?.styles.tooltip?.[0]).toBe('Hide children');
      expect(find(h.render(), 'sub-job')).toBeDefined();
      command.state = 'finished';
      h.render(); await h.flush(); root = h.render();
      expect(find(root, 'sub-job')).toBeUndefined();
      command.state = 'live';
      h.render(); await h.flush(); root = h.render();
      expect(find(root, 'sub-job')).toBeDefined();
      reloaded = new h.view.constructor(); reloaded.init({}, h.cx); reloaded.spiderFeeds = h.state.feeds;
      const afterReload = reloaded.render(h.cx);
      expect(find(afterReload, 'sub-job')).toBeDefined();
      find(afterReload, 'child-fold-live0').events.on_click({}, h.cx);
      expect(find(reloaded.render(h.cx), 'sub-job')).toBeUndefined();
      const again = new h.view.constructor(); again.init({}, h.cx); again.spiderFeeds = h.state.feeds;
      expect(find(again.render(h.cx), 'sub-job')).toBeUndefined();
      await again.close();
      find(reloaded.render(h.cx), 'fold-left-t0').events.on_click({}, h.cx);
      expect(find(reloaded.render(h.cx), 'sub-live0')).toBeUndefined();
      find(reloaded.render(h.cx), 'fold-left-t0').events.on_click({}, h.cx);
      expect(find(reloaded.render(h.cx), 'sub-live0')).toBeDefined();
      expect(find(reloaded.render(h.cx), 'sub-job')).toBeUndefined();
    } finally { await reloaded?.close(); await h.view.close(); }
  });

  it.each(['blocked', 'error'])(`${version}: collapsed subagents signal a live %s descendant`, async status => {
    const h = fixture(version, 1, 0);
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    h.state.terminals.push({ address: 'native', parent: 'v0', state: 'live', status, labels: {} },
      { address: 'command', parent: 't0', state: 'live', status: 'working',
        labels: { 'spider.kind': 'exec', 'spider.session': 's0', 'spider.job': 'job', 'spider.run': 'live0' } });
    try {
      await h.ready(); let root = h.render();
      const attention = find(root, 'child-busy-live0');
      expect(attention?.styles.tooltip?.[0]).toBe('Needs attention');
      expect(attention?.styles.accessibility_label?.[0]).toBe('Needs attention');
      expect(h.text(attention)).toContain('!');
      expect(find(root, 'sub-native')).toBeUndefined();
      find(root, 'child-fold-live0').events.on_click({}, h.cx); root = h.render();
      expect(find(root, 'sub-native')).toBeDefined();
      expect(find(root, 'child-busy-live0')).toBeUndefined();
    } finally { await h.view.close(); }
  });

  it(`${version}: hidden attention follows a native agent's listed status`, async () => {
    const h = fixture(version, 1, 0);
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    h.state.terminals.push({ address: 'native', parent: 'v0', state: 'live', status: 'working', labels: {} });
    h.state.agents.push({ ...h.state.agents[0], address: 'native', status: 'blocked', seq: 2 });
    try {
      await h.ready(); let root = h.render();
      expect(find(root, 'child-busy-live0')?.styles.tooltip?.[0]).toBe('Needs attention');
      h.state.agents[1].status = 'working';
      h.render(); await h.flush(); root = h.render();
      expect(find(root, 'child-busy-live0')).toBeUndefined();
    } finally { await h.view.close(); }
  });

  it(`${version}: real nested viewers require each ancestor to be expanded`, async () => {
    const h = fixture(version, 1, 0), first = h.state.feeds[0].runs.rows[0];
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    h.state.feeds[0].runs.rows.push({ ...first, id: 'nested', viewer: 'nested-viewer', name: 'Nested' });
    h.state.terminals.push({ address: 'nested-viewer', parent: 'v0', state: 'live', status: 'working',
      labels: { 'spider.kind': 'subagent-viewer', 'spider.session': 's0', 'spider.run': 'nested' } },
    { address: 'job-terminal', parent: 't0', state: 'live', status: 'working',
      labels: { 'spider.kind': 'exec', 'spider.session': 's0', 'spider.job': 'job', 'spider.run': 'nested' } });
    try {
      await h.ready(); let root = h.render();
      expect(find(root, 'sub-live0')).toBeDefined();
      expect(find(root, 'sub-nested')).toBeUndefined();
      expect(find(root, 'sub-job')).toBeUndefined();
      find(root, 'child-fold-live0').events.on_click({}, h.cx); root = h.render();
      expect(find(root, 'sub-nested')).toBeDefined();
      expect(find(root, 'sub-job')).toBeUndefined();
      find(root, 'child-fold-nested').events.on_click({}, h.cx);
      expect(find(h.render(), 'sub-job')).toBeDefined();
    } finally { await h.view.close(); }
  });

  it(`${version}: a retained subagent with a live command stays collapsed and shows activity`, async () => {
    const h = fixture(version, 1, 0), now = Date.now();
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    h.state.feeds[0].runs.rows[0].status = 'done'; h.state.feeds[0].runs.rows[0].finishedAt = now - 1000;
    h.state.terminals[1].state = 'finished'; h.state.terminals[1].finishedAt = now - 1000;
    h.state.terminals.push({ address: 'job-terminal', parent: 't0', state: 'live', status: 'working',
      labels: { 'spider.kind': 'exec', 'spider.session': 's0', 'spider.job': 'job', 'spider.run': 'live0' } });
    h.storage.set('folded', JSON.stringify(['live0']));
    const reloaded = new h.view.constructor(); reloaded.init({}, h.cx); reloaded.spiderFeeds = h.state.feeds;
    try {
      const root = reloaded.render(h.cx);
      expect(find(root, 'sub-live0')).toBeDefined();
      expect(find(root, 'sub-job')).toBeUndefined();
      expect(find(root, 'child-busy-live0')?.styles.tooltip?.[0]).toBe('Active work');
      expect(find(root, 'child-fold-live0')?.styles.tooltip?.[0]).toBe('Show children');
      expect(h.storage.get('folded')).toBe(JSON.stringify(['live0']));
    } finally { await reloaded.close(); await h.view.close(); }
  });

  it(`${version}: collapsed subagents keep console groups and their commands out of rendered rows`, async () => {
    const h = fixture(version, 1, 0);
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    for (let i = 0; i < 80; i++) h.state.terminals.push({ address: `console${i}`, parent: 't0', state: 'live', status: 'idle',
      labels: { 'spider.kind': 'remote-console', 'spider.session': 's0', 'spider.run': 'live0' } });
    let drawing = false, reads = 0;
    const project = h.view.projectChildren.bind(h.view), wrapped = new WeakMap<object, any>();
    h.view.projectChildren = (all: unknown, owner: string) => {
      const rows = project(all, owner); let proxy = wrapped.get(rows);
      if (!proxy) {
        proxy = new Proxy(rows, { get(target, key, receiver) {
          if (drawing && (key === Symbol.iterator || typeof key === 'string' && /^\d+$/.test(key))) reads++;
          return Reflect.get(target, key, receiver);
        } });
        wrapped.set(rows, proxy); wrapped.set(proxy, proxy);
        if (h.view.spiderRenderRows?.get(owner) === rows) h.view.spiderRenderRows.set(owner, proxy);
      }
      return proxy;
    };
    try {
      await h.ready(); h.render(); await h.flush();
      reads = 0; drawing = true; const root = h.render(); drawing = false;
      expect(find(root, 'sub-live0')).toBeDefined();
      expect(find(root, 'console-group:' + encodeURIComponent(`console-group:${JSON.stringify(['t0', 'live0'])}`))).toBeUndefined();
      expect(reads).toBeLessThan(10);
      find(root, 'child-fold-live0').events.on_click({}, h.cx);
      const expanded = h.render();
      expect(find(expanded, 'console-group:' + encodeURIComponent(`console-group:${JSON.stringify(['t0', 'live0'])}`))).toBeDefined();
    } finally { drawing = false; await h.view.close(); }
  });

  it(`${version}: rendering does not scan saved expansions for hidden subagents`, async () => {
    const h = fixture(version, 1, 0);
    let drawing = false, reads = 0;
    class TrackedSet extends Set<string> {
      *[Symbol.iterator](): SetIterator<string> {
        for (const key of super[Symbol.iterator]()) { if (drawing) reads++; yield key; }
      }
    }
    try {
      await h.ready(); h.render(); await h.flush();
      h.view.expandedSubagents = new TrackedSet(Array.from({ length: 400 }, (_, i) => `old-${i}`));
      expect(h.view.expandedSubagents.size).toBe(400);
      drawing = true; h.render(); drawing = false;
      expect(reads).toBe(0);
    } finally { drawing = false; await h.view.close(); }
  });

  it(`${version}: rendering does not serialize hidden subagent expansion keys`, async () => {
    const h = fixture(version, 1, 0), first = h.state.feeds[0].runs.rows[0], now = Date.now();
    for (let i = 0; i < 400; i++) {
      const id = `nested-${i}`;
      h.state.feeds[0].runs.rows.push({ ...first, id, viewer: `viewer-${i}`, status: 'done', finishedAt: now - 1000 });
      h.state.terminals.push({ address: `viewer-${i}`, parent: 'v0', state: 'finished', status: 'idle', finishedAt: now - 1000, exitCode: 0, reason: 'exited',
        labels: { 'spider.kind': 'subagent-viewer', 'spider.session': 's0', 'spider.run': id } });
    }
    h.state.feeds[0].runs.total = h.state.feeds[0].runs.rows.length;
    let drawing = false, bytes = 0;
    const stringify = JSON.stringify;
    vi.spyOn(JSON, 'stringify').mockImplementation(((...args: any[]) => {
      const value = Reflect.apply(stringify, JSON, args);
      if (drawing && typeof value === 'string') bytes += value.length;
      return value;
    }) as typeof JSON.stringify);
    const measure = () => { bytes = 0; drawing = true; try { h.render(); return bytes; } finally { drawing = false; } };
    try {
      await h.ready(); h.render(); await h.flush();
      const empty = measure();
      // Inject an oversized historical set to stress the render path beyond the load cap.
      for (let i = 0; i < 400; i++) h.view.expandedSubagents.add(`nested-${i}`);
      h.storage.set('spider.subagents.expanded', JSON.stringify([...h.view.expandedSubagents]));
      h.view.spiderModel.inputKey = null; h.view.spiderRequestRefresh(); await h.flush();
      h.render(); await h.flush();
      expect(measure()).toBe(empty);
    } finally { drawing = false; await h.view.close(); }
  });

  it(`${version}: B navigation keeps finished history out of render and opens console rows`, async () => {
    const start = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    const h = fixture(version, 100, 48, true);
    let drawing = false, historyReads = 0, finishedNameReads = 0;
    const rows = h.state.feeds.map((item: any, i: number) => {
      const address = `t${i}`, sessionId = `s${i}`;
      const target = { coreId: 'core', terminalId: address, address, createdMs: i + 1, identityLabels: {}, alias: null,
        machineId: null, kind: 'session', sessionId, generation: 'gen', homeEpoch: null, runId: null, consoleId: null, name: `Owner ${i}`, cwd: '/fixture' };
      const runs = [{ runId: `live${i}`, name: `Active ${i}`, status: 'running' },
        ...Array.from({ length: 48 }, (_, j) => ({ runId: `run${i}-${j}`, get name() { finishedNameReads++; return `Finished ${i}-${j}`; }, status: j === 0 ? 'failed' : 'done' }))];
      const tracked = new Proxy(runs, { get(value, key, receiver) {
        if (drawing && (key === Symbol.iterator || typeof key === 'string' && /^\d+$/.test(key))) historyReads++;
        return Reflect.get(value, key, receiver);
      } });
      const consoleTarget = { ...target, coreId: 'remote-core', terminalId: `c${i}`, address: `box-1.invalid/c${i}`,
        alias: 'box-1.invalid', kind: 'console', consoleId: `console-live-${i}`, name: `Remote console ${i}` };
      return { sessionId, generation: 'gen', owner: item.owner, target, name: `Owner ${i}`, status: 'working', updatedAt: 1,
        machineKey: 'core', unavailableReason: null, children: tracked, consoles: [
          { consoleId: `console-live-${i}`, machineKey: 'box-1.invalid', name: `Remote console ${i}`, target: consoleTarget },
          { consoleId: `console-saved-${i}`, machineKey: 'box-1.invalid', name: `Saved console ${i}`, target: null },
        ] };
    });
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    const hasStyle = (node: any, name: string, value: unknown): boolean => node?.styles?.[name]?.[0] === value || Boolean(node?.items?.some((item: any) => hasStyle(item, name, value)));
    const hasMoon = (node: any): boolean => node?.styles?.frames?.[1] === 1000 / 14 || Boolean(node?.items?.some(hasMoon));
    const render = () => { drawing = true; try { return h.render(); } finally { drawing = false; } };
    try {
      const first = h.text(render());
      expect(first).toContain('Task 0');
      expect(first).not.toContain('Loading agent status…');
      await h.ready();
      h.state.paneSnapshot = { version: 1, kind: 'snapshot', complete: true, omittedRows: 0, revision: 1,
        machines: [], presentations: [], rows, targetFacts: {} };
      clock.mockReturnValue(start + 5000); h.view.spiderReloadAt = -Infinity;
      await h.view.reloadSpiderFeeds(); await h.flush();
      finishedNameReads = 0;
      h.view.spiderRequestRefresh(); await h.flush();
      expect(finishedNameReads).toBe(0);
      historyReads = 0;
      const navigationBeforeRender = h.navigationProjections;
      const root = render();
      expect(h.text(root)).toContain('Owner 0');
      expect(h.text(root)).toContain('Owner 99');
      expect(h.text(root)).toContain('Active 0');
      expect(hasMoon(find(root, 'sub-run:s0:live0'))).toBe(true);
      expect(h.text(root).filter(value => value === '49 finished')).toHaveLength(100);
      expect(h.text(root)).not.toContain('Finished 0-0');
      expect(h.view.spiderModel.rows.get('t0').filter((row: any) => row.retained)).toHaveLength(0);
      render(); await h.flush(); render();
      expect(historyReads).toBe(0);
      expect(finishedNameReads).toBe(0);
      expect(h.navigationProjections).toBe(navigationBeforeRender);
      const lastGroup = `console-group:${JSON.stringify(['t99', null])}`;
      const beforeToggle = h.navigationProjections;
      find(root, `console-group:${encodeURIComponent(lastGroup)}`).events.on_click({}, h.cx);
      expect(h.navigationProjections - beforeToggle).toBeLessThan(3);
      find(root, 'finished-toggle-t0').events.on_click({}, h.cx);
      const withHistory = render();
      expect(h.text(withHistory)).toContain('Finished 0-0');
      expect(hasStyle(find(withHistory, 'sub-run:s0:run0-0'), 'tooltip', 'Failed')).toBe(true);
      const key = `console-group:${JSON.stringify(['t0', null])}`;
      find(render(), `console-group:${encodeURIComponent(key)}`).events.on_click({}, h.cx);
      const expanded = render();
      expect(find(expanded, 'sub-console:s0:console-live-0')).toBeDefined();
      expect(find(expanded, 'sub-console:s0:console-saved-0')).toBeDefined();
      find(expanded, 'sub-console:s0:console-live-0').events.on_click({}, h.cx);
      await Promise.resolve();
      expect(h.state.paneRequests).toContainEqual({ op: 'open-auxiliary', sessionId: 's0', generation: 'gen',
        view: { kind: 'console', consoleId: 'console-live-0', machineKey: 'box-1.invalid' } });
      find(expanded, 'finished-toggle-t0').events.on_click({}, h.cx);
      expect(h.text(render())).toContain('49 finished');
      expect(h.view.spiderModel.rows.get('t0').filter((row: any) => row.retained)).toHaveLength(0);
      const staleOwner = find(expanded, 'ag-t0'), validSnapshot = h.state.paneSnapshot;
      h.state.paneSnapshot = { ...validSnapshot, rows: [{ ...rows[0], children: null }] };
      clock.mockReturnValue(start + 10000); h.view.spiderReloadAt = -Infinity;
      await h.view.reloadSpiderFeeds(); await h.flush();
      const beforeInvalid = h.runCalls.length;
      staleOwner.events.on_click({}, h.cx); await Promise.resolve();
      expect(h.runCalls).toHaveLength(beforeInvalid + 1);
      expect(h.view.spiderFeedError).toBeNull();
      h.state.paneSnapshot = validSnapshot;
      clock.mockReturnValue(start + 15000); h.view.spiderReloadAt = -Infinity;
      await h.view.reloadSpiderFeeds(); h.view.spiderRequestRefresh(); await h.flush();
      h.state.paneSnapshot = { ...h.state.paneSnapshot, rows: rows.map((row: any, i: number) => i ? row :
        { ...row, name: 'Unavailable owner', owner: null, target: null, generation: null, unavailableReason: 'not-in-hc', children: [], consoles: [] }) };
      clock.mockReturnValue(start + 20000); h.view.spiderReloadAt = -Infinity;
      await h.view.reloadSpiderFeeds(); for (let i = 0; i < 30; i++) await Promise.resolve(); h.view.spiderRequestRefresh();
      expect(h.text(render())).toContain('Owner 0');
      const runsBefore = h.runCalls.length, requestsBefore = h.state.paneRequests.length;
      staleOwner.events.on_click({}, h.cx); await Promise.resolve();
      expect(h.runCalls).toHaveLength(runsBefore);
      expect(h.state.paneRequests).toHaveLength(requestsBefore);
      await h.flush();
      expect(h.text(render())).toContain('Unavailable owner');
    } finally { await h.view.close(); }
  });

  it(`${version}: B first frame uses indexed visible rows without reading hidden history`, async () => {
    const h = fixture(version, 1, 40, true), source = h.state.feeds[0];
    let drawing = false, reads = 0, keyReads = 0;
    const target = { coreId: 'core', terminalId: 't0', address: 't0', createdMs: 1, identityLabels: {}, alias: null,
      machineId: null, kind: 'session', sessionId: 's0', generation: 'gen', homeEpoch: null, runId: null, consoleId: null, name: 'Owner 0', cwd: '/fixture' };
    const children = new Proxy([{ runId: 'live0', name: 'Active 0', status: 'running' },
      ...Array.from({ length: 40 }, (_, i) => ({ runId: `done-${i}`, name: `Saved ${i}`, status: 'done' }))], {
      get(value, key, receiver) {
        if (drawing && (key === Symbol.iterator || typeof key === 'string' && /^\d+$/.test(key))) reads++;
        return Reflect.get(value, key, receiver);
      },
    });
    h.state.paneSnapshot = { version: 1, kind: 'snapshot', complete: true, omittedRows: 0, revision: 1, machines: [], presentations: [], targetFacts: {},
      rows: [{ sessionId: 's0', generation: 'gen', owner: source.owner, target, name: 'Owner 0', status: 'working', updatedAt: 1,
        machineKey: 'core', unavailableReason: null, children, consoles: [] }] };
    try {
      await h.view.reloadSpiderFeeds();
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(h.view.spiderModel).toBeUndefined();
      const index = h.view.spiderPaneIndex, key = index.key;
      Object.defineProperty(index, 'key', { get() { if (drawing) keyReads++; return key; } });
      drawing = true;
      const first = h.text(h.render());
      drawing = false;
      expect(first).toContain('Owner 0');
      expect(first).toContain('Active 0');
      expect(first).toContain('40 finished');
      expect(first).not.toContain('Loading agent status…');
      expect(reads).toBe(0);
      expect(keyReads).toBe(0);
    } finally { drawing = false; await h.view.close(); }
  });

  it(`${version}: B refreshes drag authority when only a presentation revision changes`, async () => {
    const start = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    const h = fixture(version, 1, 0, true), source = h.state.feeds[0];
    const target = { coreId: 'core', terminalId: 't0', address: 't0', createdMs: 1, identityLabels: {}, alias: null,
      machineId: null, kind: 'session', sessionId: 's0', generation: 'gen', homeEpoch: null, runId: null, consoleId: null, name: 'Owner 0', cwd: '/fixture' };
    const presentation = { id: 'pres-0', revision: 1, mode: 'proxy', role: 'agent', target, proxy: 't0',
      slot: { space: 'space', tab: 'tab0', pane: 'pane0' }, visibility: 'visible', launch: 'acknowledged', closeOperationId: null, conversion: null };
    const row = { sessionId: 's0', generation: 'gen', owner: source.owner, target, name: 'Owner 0', status: 'working', updatedAt: 1,
      machineKey: 'core', unavailableReason: null, children: [{ runId: 'live0', name: 'Active 0', status: 'working' }], consoles: [] };
    const service = { version: 1, kind: 'snapshot', complete: true, omittedRows: 0, revision: 1,
      machines: [], presentations: [presentation], rows: [row], targetFacts: {} };
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    try {
      h.state.paneSnapshot = service; await h.ready();
      h.view.spiderReloadAt = -Infinity;
      await h.view.reloadSpiderFeeds(); h.view.spiderRequestRefresh(); await h.flush();
      h.render(); await h.flush();
      const before = h.notifications, beforeProjection = h.navigationProjections;
      h.state.paneSnapshot = { ...service, rows: [{ ...row, updatedAt: 2 }] };
      clock.mockReturnValue(start + 5000); h.view.spiderReloadAt = -Infinity;
      await h.view.reloadSpiderFeeds(); h.view.spiderRequestRefresh(); await h.flush();
      expect(h.navigationProjections).toBe(beforeProjection);
      expect(h.notifications).toBe(before);
      h.state.paneSnapshot = { ...service, presentations: [{ ...presentation, revision: 2 }] };
      clock.mockReturnValue(start + 10000); h.view.spiderReloadAt = -Infinity;
      await h.view.reloadSpiderFeeds(); h.view.spiderRequestRefresh(); await h.flush();
      expect(h.notifications).toBe(before + 1);
      find(h.render(), 'ag-t0').mouseEvents['on_mouse_down:left']({}, h.cx);
      expect(h.sharedState.get('spider.presentation-drag')).toMatchObject({ presentationId: 'pres-0', expectedRevision: 2 });
    } finally { await h.view.close(); }
  });

  it(`${version}: renders actual rows in the first frame`, async () => {
    const h = fixture(version, 2, 4);
    h.view.spiderFeeds = h.state.feeds;
    try {
      const first = h.text(h.render());
      expect(first).toContain('Owner 0');
      expect(first).toContain('Active 0');
      expect(first).toContain('4 finished');
      expect(first).not.toContain('Loading agent status…');
    } finally { await h.view.close(); }
  });

  it(`${version}: builds finished rows only when their history is expanded`, async () => {
    const h = fixture(version, 20, 48);
    h.view.spiderFeeds = h.state.feeds;
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    try {
      const first = h.render();
      expect(h.text(first).filter(value => value === '48 finished')).toHaveLength(20);
      expect(h.projectedFinished).toBe(0);
      const button = find(first, 'finished-toggle-t0');
      button.events.on_click({}, h.cx);
      const expanded = h.text(h.render());
      expect(expanded).toContain('Finished 0-0');
      expect(expanded.filter(value => value === '48 finished')).toHaveLength(19);
      expect(h.projectedFinished).toBe(48);
      await h.flush();
      const before = h.projections;
      h.render(); await h.flush(); h.render(); await h.flush();
      expect(h.projections).toBe(before);
    } finally { await h.view.close(); }
  });

  it(`${version}: does not read hidden run names again to build row objects`, async () => {
    const h = fixture(version, 1, 48); let nameReads = 0;
    const runs = h.state.feeds[0].runs.rows;
    for (let i = 1; i < runs.length; i++) runs[i] = new Proxy(runs[i], { get(target, key, receiver) {
      if (key === 'name') nameReads++;
      return Reflect.get(target, key, receiver);
    } });
    h.view.spiderFeeds = h.state.feeds;
    h.view.spiderFeedStamps = new Map([['s0', 'content']]);
    try {
      expect(h.text(h.render())).toContain('48 finished');
      expect(nameReads).toBe(48);
    } finally { await h.view.close(); }
  });

  it(`${version}: revalidates a visible child without building collapsed history`, async () => {
    const h = fixture(version, 1, 48); h.view.spiderFeeds = h.state.feeds;
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    try {
      const row = find(h.render(), 'sub-live0');
      expect(h.projectedFinished).toBe(0);
      row.events.on_click({}, h.cx); await Promise.resolve();
      expect(h.projectedFinished).toBe(0);
      expect(h.execCalls).toHaveLength(1);
    } finally { await h.view.close(); }
  });

  it(`${version}: renders a large unchanged snapshot without traversing finished history`, async () => {
    const h = fixture(version, 100, 48);
    try {
      await h.ready();
      const first = h.text(h.render());
      await h.flush();
      const before = h.historyReads;
      const next = h.text(h.render());
      expect(first).toContain('Owner 99');
      expect(next).toContain('Active 99');
      expect(next.filter(value => value === '48 finished')).toHaveLength(100);
      expect(h.historyReads - before).toBeLessThan(500);
      await h.flush();
      const historyBeforeInvalidations = h.allHistoryReads;
      for (let i = 0; i < 3; i++) { h.render(); await h.flush(); }
      expect(h.allHistoryReads - historyBeforeInvalidations).toBeLessThan(500);
    } finally { await h.view.close(); }
  });

  it(`${version}: keeps hidden history out of render and prepares expanded rows on demand`, async () => {
    const h = fixture(version, 100, 48);
    let rendering = false, reads = 0;
    const wrapped = new WeakMap<object, any>(), project = h.view.projectChildren.bind(h.view);
    h.view.projectChildren = (all: unknown, owner: string) => {
      const rows = project(all, owner);
      let proxy = wrapped.get(rows);
      if (!proxy) {
        proxy = new Proxy(rows, { get(target, key, receiver) {
          if (rendering && (key === Symbol.iterator || typeof key === 'string' && /^\d+$/.test(key))) reads++;
          return Reflect.get(target, key, receiver);
        } });
        wrapped.set(rows, proxy); wrapped.set(proxy, proxy);
        if (h.view.spiderRenderRows?.get(owner) === rows) h.view.spiderRenderRows.set(owner, proxy);
      }
      return proxy;
    };
    const render = () => { rendering = true; try { return h.render(); } finally { rendering = false; } };
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    try {
      await h.ready();
      const first = render();
      expect(h.text(first)).toContain('48 finished');
      expect(reads).toBeLessThan(500);
      find(first, 'finished-toggle-t0').events.on_click({}, h.cx);
      reads = 0;
      const expanded = render();
      expect(h.text(expanded)).toContain('Finished 0-0');
      expect(h.text(expanded)).toContain('Hide finished');
      expect(reads).toBeLessThan(500);
    } finally { await h.view.close(); }
  });

  it(`${version}: coalesces host invalidations and no-op commands`, async () => {
    const h = fixture(version, 4, 2);
    try {
      await h.ready(); h.render(); await h.flush();
      const notices = h.notifications, reads = h.agentReads;
      for (let i = 0; i < 5; i++) h.render();
      await h.flush();
      expect(h.agentReads - reads).toBe(1);
      expect(h.notifications).toBe(notices);
      await h.send('sort-priority');
      expect(h.sharedState.get('agents.sort')).toBe('priority');
      await h.send('activate-session:missing');
      await h.send('console-group-toggle:%E0%A4%A');
      await h.send('unrecognized');
      await h.send('toString');
      expect(h.notifications).toBe(notices);
      await h.send('sort-machine');
      expect(h.notifications).toBe(notices + 1);
    } finally { await h.view.close(); }
  });

  it(`${version}: does not notify for an unrelated native terminal label`, async () => {
    const h = fixture(version, 1, 0);
    try {
      await h.ready(); h.render(); await h.flush();
      const before = h.notifications;
      h.state.terminals[0].labels['unrelated.label'] = 'updated';
      h.render(); await h.flush();
      expect(h.notifications).toBe(before);
    } finally { await h.view.close(); }
  });

  it(`${version}: can retry after a projection task fails`, async () => {
    const h = fixture(version, 1, 0);
    try {
      await h.ready(); h.render(); await h.flush();
      h.state.agents[0].status = 'idle'; h.state.throwNavigation = true;
      h.render();
      await expect(h.step()).rejects.toThrow('projection failed');
      expect(h.view.spiderRefreshing).toBe(false);
      h.render(); await h.flush();
      expect(h.view.spiderModel.list[0].status).toBe('idle');
    } finally { await h.view.close(); }
  });

  it(`${version}: displays native rows before asynchronous feeds are available`, async () => {
    const h = fixture(version, 1, 4);
    try {
      const first = h.text(h.render());
      expect(first).toContain('Task 0');
      expect(first).not.toContain('Loading agent status…');
      await h.flush();
      expect(h.text(h.render())).toContain('Owner 0');
    } finally { await h.view.close(); }
  });

  it(`${version}: keeps the previous visible model while an update is built`, async () => {
    const h = fixture(version, 20, 8);
    try {
      await h.ready(); const before = h.text(h.render()); await h.flush();
      const feed = h.state.feeds[0];
      h.state.feeds[0] = { ...feed, revision: 2, owner: { ...feed.owner, name: 'Updated owner' } };
      h.view.spiderReloadAt = -Infinity; h.watches.at(-1)!.fire();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await h.step();
      expect(h.text(h.render())).toEqual(before);
      await h.flush();
      expect(h.text(h.render())).toContain('Updated owner');
    } finally { await h.view.close(); }
  });

  it(`${version}: preserves an expansion made while an update is in flight`, async () => {
    const h = fixture(version, 20, 8);
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    try {
      await h.ready(); const first = h.render(); await h.flush();
      h.state.agents[0].status = 'blocked'; h.render(); await h.step();
      find(first, 'finished-toggle-t0').events.on_click({}, h.cx);
      expect(h.text(h.render())).toContain('Finished 0-0');
      await h.flush();
      expect(h.text(h.render())).toContain('Finished 0-0');
      expect(h.view.spiderModel.list[0].status).toBe('blocked');
    } finally { await h.view.close(); }
  });

  it(`${version}: catches changes arriving while a projection is in progress`, async () => {
    const h = fixture(version, 20, 8);
    try {
      await h.ready(); h.render(); await h.flush();
      h.state.agents[0].status = 'idle';
      h.render(); await h.step();
      h.state.agents[1].status = 'blocked';
      h.render(); await h.flush();
      expect(h.view.spiderModel.list[0].status).toBe('idle');
      expect(h.view.spiderModel.list[1].status).toBe('blocked');
    } finally { await h.view.close(); }
  });

  it(`${version}: notifies only when a pin hover changes the visible state`, async () => {
    const h = fixture(version, 1, 0);
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    try {
      await h.ready(); const pin = find(h.render(), 'agent-pin-t0'); await h.flush();
      const before = h.notifications;
      pin.events.on_hover(true, h.cx); pin.events.on_hover(true, h.cx);
      pin.events.on_hover(false, h.cx); pin.events.on_hover(false, h.cx);
      expect(h.notifications).toBe(before + 2);
    } finally { await h.view.close(); }
  });

  it(`${version}: updates changed native and feed rows while reusing unaffected owners`, async () => {
    let now = 1000000000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const h = fixture(version, 2, 2);
    try {
      await h.ready(); h.render(); await h.flush();
      const unaffected = h.view.spiderModel.rows.get('t1'), before = h.notifications;
      h.state.agents[0].status = 'blocked'; h.state.agents[0].focused = true;
      h.state.terminals[0].status = 'blocked';
      h.render(); await h.flush();
      const changed = h.render(); await h.flush();
      expect(h.view.spiderModel.list[0]).toMatchObject({ status: 'blocked', focused: true });
      expect(h.text(changed)).toContain('!');
      expect(h.view.spiderModel.rows.get('t1')).toBe(unaffected);
      expect(h.notifications).toBe(before + 1);
      now += 5000;
      const first = h.state.feeds[0];
      h.state.feeds[0] = { ...first, stamp: 'changed-content', updatedAt: now,
        runs: { ...first.runs, rows: first.runs.rows.map((row: any, i: number) => i ? row : { ...row, name: 'Updated child' }) } };
      h.watches.at(-1)!.fire(); await h.flush();
      expect(h.text(h.render())).toContain('Updated child');
      expect(h.view.spiderModel.rows.get('t1')).toBe(unaffected);
      expect(h.notifications).toBe(before + 2);
    } finally { await h.view.close(); }
  });

  it(`${version}: revalidates child actions against newer snapshots before dispatch`, async () => {
    let now = 1000000000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const h = fixture(version, 1, 0);
    const find = (node: any, id: string): any => node?.styles?.id?.[0] === id ? node : node?.items?.map((item: any) => find(item, id)).find(Boolean);
    try {
      await h.ready(); const row = find(h.render(), 'sub-live0'); await h.flush();
      expect(row.events.on_click).toBeTypeOf('function');
      now += 5000;
      h.state.feeds[0] = { ...h.state.feeds[0], revision: 2, updatedAt: now, lifecycle: 'closed', ipc: null };
      h.state.terminals[1].state = 'finished';
      h.watches.at(-1)!.fire();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(h.view.spiderFeeds[0].lifecycle).toBe('closed');
      row.events.on_click({}, h.cx); await Promise.resolve();
      expect(h.execCalls).toEqual([]);
      expect(h.runCalls).toEqual([]);
    } finally { await h.view.close(); }
  });

  it(`${version}: expires retained history and updates disconnected feeds at the correct time`, async () => {
    let now = 1000000000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const h = fixture(version, 1, 2);
    h.state.feeds[0].runs.rows[1].finishedAt = now - 24 * 3600000 + 999;
    try {
      await h.ready(); expect(h.text(h.render())).toContain('2 finished'); await h.flush();
      const before = h.notifications;
      now += 1000; h.state.feeds[0].updatedAt = now;
      h.timers.find(timer => timer.ms === 30000)!.callback(h.cx); await h.flush();
      expect(h.text(h.render())).toContain('1 finished'); await h.flush();
      expect(h.notifications).toBe(before + 1);
      now += 20001;
      h.timers.find(timer => timer.ms === 30000)!.callback(h.cx); await h.flush();
      expect(h.text(h.render())).toContain('Disconnected'); await h.flush();
      expect(h.notifications).toBe(before + 2);
      h.state.feeds[0] = { ...h.state.feeds[0], updatedAt: now };
      h.watches.at(-1)!.fire(); await h.flush();
      expect(h.text(h.render())).not.toContain('Disconnected');
      expect(h.notifications).toBe(before + 3);
    } finally { await h.view.close(); }
  });

  it(`${version}: refreshes elapsed labels and machines only when their visible value changes`, async () => {
    let now = 1000000000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const h = fixture(version, 1, 0);
    try {
      await h.ready(); h.render(); await h.flush();
      const before = h.notifications;
      now += 30000; h.state.feeds[0].updatedAt = now;
      h.timers.find(timer => timer.ms === 30000)!.callback(h.cx); await h.flush();
      await h.timers.find(timer => timer.ms === 15000)!.callback(h.cx); await h.flush();
      expect(h.notifications).toBe(before);
      now += 30000; h.state.feeds[0].updatedAt = now;
      h.timers.find(timer => timer.ms === 30000)!.callback(h.cx); await h.flush();
      expect(h.notifications).toBe(before + 1);
      expect(h.text(h.render())).toContain('1m');
    } finally { await h.view.close(); }
  });

  it(`${version}: notifies for machine changes but not repeated identical polls`, async () => {
    const h = fixture(version, 1, 0);
    try {
      await h.ready(); h.render(); await h.flush();
      const before = h.notifications;
      h.state.inventory = [{ name: 'remote.invalid', id: 'remote-core', state: 'needs_login', target: 'ssh-remote.invalid' }];
      await h.timers.find(timer => timer.ms === 15000)!.callback(h.cx); await h.flush();
      expect(h.notifications).toBe(before + 1);
      await h.timers.find(timer => timer.ms === 15000)!.callback(h.cx); await h.flush();
      expect(h.notifications).toBe(before + 1);
      await h.send('sort-machine');
      expect(h.text(h.render())).toContain('remote.invalid');
      expect(h.text(h.render())).toContain('needs a login: run');
    } finally { await h.view.close(); }
  });

  it(`${version}: updates parked status when its feed changes`, async () => {
    let now = 1000000000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const h = fixture(version, 1, 0);
    h.state.agents[0].pane = null; h.state.panes = [];
    try {
      await h.ready(); expect(h.text(h.render())).toContain('Parked'); await h.flush();
      const before = h.notifications;
      now += 5000;
      h.state.feeds[0] = { ...h.state.feeds[0], revision: 2, updatedAt: now,
        status: { ...h.state.feeds[0].status, effective: 'blocked' } };
      h.watches.at(-1)!.fire(); await h.flush();
      expect(h.view.spiderModel.parked[0].status).toBe('blocked');
      expect(h.notifications).toBe(before + 1);
    } finally { await h.view.close(); }
  });

  it(`${version}: cancels queued projection work when the view closes`, async () => {
    const h = fixture(version, 10, 4);
    await h.ready(); h.render();
    const before = h.notifications;
    await h.view.close(); await h.flush();
    expect(h.notifications).toBe(before);
  });

  it(`${version}: does not request renders for unchanged feed-watch bursts`, async () => {
    let now = 1000000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const h = fixture(version, 1, 2);
    try {
      await h.ready(); h.render(); await h.flush();
      const before = h.notifications;
      for (let i = 0; i < 5; i++) { h.watches.at(-1)!.fire(); await h.flush(); }
      expect(h.notifications).toBe(before);
      const rows = h.view.spiderModel.rows.get('t0');
      now += 5000;
      h.state.feeds = [{ ...h.state.feeds[0], updatedAt: now }];
      h.watches.at(-1)!.fire(); await h.flush();
      expect(h.notifications).toBe(before);
      expect(h.view.spiderModel.rows.get('t0')).toBe(rows);
      now += 5000;
      h.state.feeds = [{ ...h.state.feeds[0], revision: 2, updatedAt: now, status: { ...h.state.feeds[0].status, message: 'not shown' } }];
      h.watches.at(-1)!.fire(); await h.flush();
      expect(h.notifications).toBe(before);
      now += 5000;
      h.state.feeds = [{ ...h.state.feeds[0], revision: 3, updatedAt: now, owner: { ...h.state.feeds[0].owner, name: 'Renamed' } }];
      h.watches.at(-1)!.fire(); await h.flush();
      expect(h.notifications).toBe(before + 1);
      expect(h.text(h.render())).toContain('Renamed');
    } finally { await h.view.close(); }
  });
}
